/**
 * Phase E2.5 — inline Steps, completed-task restoration and Today ordering.
 *
 * The model these tests defend:
 *
 *   Projects contain Tasks. Tasks may contain Steps.
 *   A Step belongs to one Task and to nothing else — it is never a Today task,
 *   never counts toward Project progress, and never carries a project, area,
 *   date or schedule of its own.
 *   Completing every Step does NOT complete the Task. Only the user does.
 *   A Task keeps two positions — one for Today, one for its Project — without
 *   ever becoming two Tasks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const readWeb = (f: string) => readFileSync(join(here, '..', '..', 'web', f), 'utf8');
const strip = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
const appCode = strip(readWeb('app.js'));
const stepsCode = strip(readWeb('steps.js'));
const dragCode = strip(readWeb('drag.js'));
const modalCode = strip(readWeb('task-modal.js'));
const css = readWeb('index.html');

function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `${decl} not found`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:async )?(?:export )?(?:function |const \w+ = )/);
  return end === -1 ? rest : rest.slice(0, end);
}

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused',
  FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = () => ({ authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'zander@example.com' });

async function setup() {
  const { db } = await freshDb();
  const app = buildApp(db, env);
  await app.ready();
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth() })).json();
  const ws = me.workspace.id;
  const areaId = me.areas.find((a: any) => a.name === 'Work').id;
  const base = `/api/v1/workspaces/${ws}`;
  const post = (url: string, payload?: any) =>
    app.inject({ method: 'POST', url: base + url, headers: auth(), payload: payload ?? {} });
  const patch = (url: string, payload: any) =>
    app.inject({ method: 'PATCH', url: base + url, headers: auth(), payload });
  const get = (url: string) => app.inject({ method: 'GET', url: base + url, headers: auth() });
  const del = (url: string) => app.inject({ method: 'DELETE', url: base + url, headers: auth() });
  return { app, db, ws, areaId, post, patch, get, del };
}

/** A task with `n` steps, the first `done` of them completed. */
async function withSteps(h: any, title: string, names: string[], done = 0, over: any = {}) {
  const task = (await h.post('/tasks', { title, ...over })).json().task;
  for (const n of names) await h.post(`/tasks/${task.id}/steps`, { title: n });
  const steps = (await h.get(`/tasks/${task.id}`)).json().task.steps;
  for (const s of steps.slice(0, done)) {
    await h.patch(`/tasks/${task.id}/steps/${s.id}`, { completed: true });
  }
  return (await h.get(`/tasks/${task.id}`)).json().task;
}

/* ── §1  The model ───────────────────────────────────────────────────── */

test('model: a step is not a task and never appears as one', async () => {
  const h = await setup();
  await withSteps(h, 'Prepare proposal', ['Scope', 'Pricing', 'Write'], 1, { bucket: 'today' });
  const board = (await h.get('/tasks?includeCompleted=false&limit=100')).json();
  // Three steps exist; the board still holds exactly one task.
  assert.equal(board.tasks.length, 1, 'steps leaked onto the board as tasks');
  assert.equal(board.tasks[0].steps.length, 3);
});

test('model: a step carries no project, area, date or schedule', async () => {
  const h = await setup();
  const t = await withSteps(h, 'Owner', ['One'], 0);
  const step = t.steps[0];
  for (const field of ['projectId', 'areaId', 'dueDate', 'scheduledAt', 'bucket']) {
    assert.ok(!(field in step), `a step carries ${field}, which belongs to its task`);
  }
});

test('model: steps do not move project progress', async () => {
  const h = await setup();
  const project = (await h.post('/projects', {
    title: 'P', outcome: 'Done', areaId: h.areaId, focus: 'now',
  })).json().project;
  await withSteps(h, 'One task', ['a', 'b', 'c'], 3, { projectId: project.id });
  const p = (await h.get(`/projects/${project.id}`)).json().project;
  // Every step complete, the task still open: 0 of 1.
  assert.deepEqual({ done: p.progress.done, total: p.progress.total }, { done: 0, total: 1 },
    'completing steps moved project progress');
});

/* ── §3/§4  Inline steps, one component ──────────────────────────────── */

test('ui: ONE steps component, shared by Today and Project detail', () => {
  assert.match(appCode, /from '\.\/steps\.js'/, 'the steps component is not imported');
  // Both wiring paths reach the same `wireSteps`, with the same handler factory.
  const card = body(appCode, 'function wireCardSteps(el, id)');
  assert.match(card, /wireSteps\(el, t, taskStepsCtx\(t\)/, 'Today has its own steps code');
  const project = body(appCode, 'function wireProjectTaskRows(project)');
  assert.match(project, /wireSteps\(row, t, taskStepsCtx\(t\)/,
    'Project detail has a separate steps implementation');
});

test('ui: the steps panel is INSIDE the task article, never a sibling', () => {
  const fn = body(appCode, 'function taskHtml(t)');
  const article = fn.slice(fn.indexOf('<article'), fn.indexOf('</article>'));
  assert.ok(article.includes('stepsPanelHtml(t'),
    'the steps panel is rendered outside the article, where it becomes a drop target');
  // A `.t-steps` outside `.task` would sit in the drop zone and be treated as
  // a task by the drag code.
  assert.ok(!/<\/article>[\s\S]*stepsPanelHtml/.test(fn));
});

test('ui: the summary is a control, and expanding does not open the editor', () => {
  const chip = body(stepsCode, 'export function stepsChipHtml(task, expanded)');
  assert.match(chip, /<button/, 'the step summary is still an inert label');
  assert.match(chip, /aria-expanded/, 'expansion state is not exposed');
  assert.match(chip, /aria-controls="steps-\$\{task\.id\}"/);
  // The chip toggles the panel and nothing else.
  const wire = body(stepsCode, 'export function wireSteps(rowEl, task, ctx, { onChanged, onOpenTask } = {})');
  assert.ok(!/openTask|openProjectTask/.test(wire),
    'expanding a task opens its editor, which is a different intention');
});

test('ui: expansion state survives a step mutation and a re-render', () => {
  // Kept by id, outside the record: it is view state, must not be sent to the
  // server, and must survive the record being replaced by a fresh copy.
  assert.match(appCode, /const expandedSteps = new Set\(\)/);
  const repaint = body(stepsCode, 'export function repaintSteps(rowEl, task)');
  assert.match(repaint, /const expanded = !panel\.hidden/);
  assert.match(repaint, /panel\.innerHTML = stepsPanelInnerHtml\(task\)/,
    'the panel node is replaced rather than repainted, so expansion is lost');
  assert.match(repaint, /panel\.hidden = !expanded/);
});

test('ui: a task with no steps still has a way to gain its first one', () => {
  // No chip is rendered for a task with none — a chip on every card is noise —
  // so the menu is the way in, on Today and in Project detail alike.
  assert.match(appCode, /data-x="steps"><span>Add step<\/span>/, 'Today has no add-step entry');
  assert.match(appCode, /\{ id: 'steps', label: 'Add step' \}/, 'Projects has no add-step entry');
  assert.match(appCode, /function expandSteps\(id\)/);
  const fn = body(appCode, 'function expandSteps(id)');
  assert.match(fn, /\[data-step-new\]'\)\?\.focus\(\)/, 'the add field is not focused');
});

test('ui: a failed step action hands the text back and says so', () => {
  const wire = body(stepsCode, 'export function wireSteps(rowEl, task, ctx, { onChanged, onOpenTask } = {})');
  assert.match(wire, /if \(box\) box\.value = v;/, 'a failed add discards what was typed');
  assert.match(stepsCode, /function fail\(rowEl, message\)/, 'errors are swallowed');
  assert.match(stepsCode, /role', 'alert'/, 'the error is not announced');
});

/* ── §6  All steps complete ──────────────────────────────────────────── */

test('ready: every step complete does NOT complete the task', async () => {
  const h = await setup();
  const t = await withSteps(h, 'Proposal', ['a', 'b'], 2, { bucket: 'today' });
  const after = (await h.get(`/tasks/${t.id}`)).json().task;
  assert.equal(after.status, 'open', 'the task completed itself when its last step was ticked');
  assert.equal(after.completedAt, null);

  const board = (await h.get('/tasks?includeCompleted=false')).json();
  assert.ok(board.tasks.some((x: any) => x.id === t.id), 'the task left Today on its own');
});

test('ready: the state is derived, never stored', () => {
  const fn = body(stepsCode, 'export function readyToFinish(task)');
  assert.match(fn, /total > 0 && done === total/);
  // Nothing writes a `ready` flag anywhere: a stored one goes stale the moment
  // a step is unticked, which is exactly when it matters most.
  assert.ok(!/readyToFinish:\s|ready:\s*true/.test(appCode));
  assert.match(stepsCode, /All steps complete — ready to finish/);
});

test('ready: unticking a step removes the state immediately', () => {
  const repaint = body(stepsCode, 'export function repaintSteps(rowEl, task)');
  assert.match(repaint, /rowEl\.classList\.toggle\('is-ready', readyToFinish\(task\)\)/,
    'the ready state is not recomputed on every repaint');
});

/* ── §7  Parent completion ───────────────────────────────────────────── */

test('complete: a task may be completed with steps unfinished', async () => {
  const h = await setup();
  const t = await withSteps(h, 'Good enough', ['done one', 'never doing this'], 1);
  const r = (await h.post(`/tasks/${t.id}/complete`)).json();
  assert.equal(r.task.status, 'done');

  const after = (await h.get(`/tasks/${t.id}`)).json().task;
  // The unfinished step is preserved exactly as it was, in history.
  assert.deepEqual(after.steps.map((s: any) => s.completed), [true, false],
    'completing the task rewrote its step states');
});

test('complete: notes and steps both survive completion', async () => {
  const h = await setup();
  const t = await withSteps(h, 'Report', ['x', 'y'], 1, { notes: 'from the finance sheet' });
  await h.post(`/tasks/${t.id}/complete`, { notes: 'from the finance sheet, v2' });
  const after = (await h.get(`/tasks/${t.id}`)).json().task;
  assert.equal(after.notes, 'from the finance sheet, v2');
  assert.equal(after.steps.length, 2);
  assert.equal(after.steps.filter((s: any) => s.completed).length, 1);
});

/* ── §8/§9  Completed history ────────────────────────────────────────── */

test('history: the task lookup covers every mounted collection', () => {
  const fn = body(appCode, 'const findTask = (id) =>');
  // THE ROOT CAUSE. This was `state.tasks.find(...)` — the active board only.
  // A completed task lives in `state.history`, so a valid id resolved to
  // undefined and the editor's `task ? edit : create` fallback rendered a
  // blank Create Task form.
  assert.match(fn, /state\.tasks\.find/);
  assert.match(fn, /pj\.detail\?\.tasks/, 'a project task cannot be resolved');
  assert.match(fn, /state\.history\.find/, 'a completed task still cannot be resolved');
});

test('history: an unresolvable id is a bug, never a new task', () => {
  const fn = body(appCode, "function openTask(id, prefillTitle = '')");
  assert.match(fn, /if \(id && !t\) return openMissingTask\(id\)/,
    'a failed lookup can still fall through into create mode');
  // The create path is reached by calling openTask() with NO id.
  const missing = body(appCode, 'async function openMissingTask(id)');
  assert.match(missing, /\/tasks\/\$\{id\}`\)/, 'the record is not fetched by id');
  assert.match(missing, /toast\(e\.message, true\)/, 'the failure is silent');
});

test('history: the editor has a completed state distinct from edit and create', () => {
  assert.match(modalCode, /const isDone = t\?\.status === 'done'/);
  assert.match(modalCode, /!t \? 'New task' : isDone \? 'Completed task' : 'Edit task'/,
    'a completed task is announced as an ordinary edit');
  assert.match(modalCode, /m-done-bar/, 'nothing says the task is completed');
  assert.match(modalCode, /id="m-restore"/, 'there is no restore action');
  assert.match(css, /\.m-done-bar\{/, 'the completed bar is unstyled');
});

test('history: a completed task opens with everything it had', async () => {
  const h = await setup();
  const t = await withSteps(h, 'Full record', ['a', 'b', 'c'], 2, {
    notes: 'context worth keeping', priority: 'high', dueDate: '2026-09-01', areaId: h.areaId,
  });
  await h.post(`/tasks/${t.id}/complete`);
  const done = (await h.get(`/tasks/${t.id}`)).json().task;
  assert.equal(done.title, 'Full record');
  assert.equal(done.notes, 'context worth keeping');
  assert.equal(done.priority, 'high');
  assert.equal(done.dueDate, '2026-09-01');
  assert.equal(done.areaId, h.areaId);
  assert.ok(done.completedAt, 'no completion date to show');
  assert.equal(done.steps.length, 3);
  assert.equal(done.steps.filter((s: any) => s.completed).length, 2);
});

/* ── §10  Restore ────────────────────────────────────────────────────── */

test('restore: the same record, uncompleted — never a copy', async () => {
  const h = await setup();
  const project = (await h.post('/projects', {
    title: 'Home', outcome: 'Done', areaId: h.areaId, focus: 'now',
  })).json().project;
  const t = await withSteps(h, 'Restore me', ['a', 'b', 'c'], 2, {
    notes: 'keep this', priority: 'urgent', bucket: 'week',
    areaId: h.areaId, projectId: project.id,
  });
  await h.post(`/tasks/${t.id}/complete`);
  const r = (await h.post(`/tasks/${t.id}/uncomplete`)).json();

  assert.equal(r.task.id, t.id, 'restore produced a different id');
  assert.equal(r.task.status, 'open');
  assert.equal(r.task.completedAt, null);
  assert.equal(r.task.notes, 'keep this');
  assert.equal(r.task.priority, 'urgent');
  assert.equal(r.task.areaId, h.areaId);
  assert.equal(r.task.projectId, project.id);
  assert.equal(r.task.bucket, 'week', 'the original bucket was not kept');

  const after = (await h.get(`/tasks/${t.id}`)).json().task;
  assert.deepEqual(after.steps.map((s: any) => s.completed), [true, true, false],
    'restore reset the step states');

  // Exactly one record with this title.
  const all = (await h.get('/tasks?includeCompleted=true&limit=100')).json();
  assert.equal(all.tasks.filter((x: any) => x.title === 'Restore me').length, 1,
    'restore duplicated the task');
});

test('restore: project progress and next action both recalculate', async () => {
  const h = await setup();
  const project = (await h.post('/projects', {
    title: 'Recalc', outcome: 'Done', areaId: h.areaId, focus: 'now',
  })).json().project;
  const t = (await h.post('/tasks', { title: 'Only task', projectId: project.id })).json().task;

  await h.post(`/tasks/${t.id}/complete`);
  let p = (await h.get(`/projects/${project.id}`)).json().project;
  assert.deepEqual({ done: p.progress.done, open: p.progress.open }, { done: 1, open: 0 });
  assert.equal(p.nextAction, null, 'a completed task is still being offered as the next action');

  await h.post(`/tasks/${t.id}/uncomplete`);
  p = (await h.get(`/projects/${project.id}`)).json().project;
  assert.deepEqual({ done: p.progress.done, open: p.progress.open }, { done: 0, open: 1 });
  assert.equal(p.nextAction?.id, t.id, 'the next action did not come back');
});

test('restore: the client keeps the record and says where it landed', () => {
  const fn = body(appCode, 'async function restoreTask(id)');
  assert.match(fn, /const restored = \{ \.\.\.r\.task, steps: t\.steps \?\? \[\] \}/,
    'the steps are dropped on restore — /uncomplete does not return them');
  assert.match(fn, /state\.history = state\.history\.filter/);
  assert.match(fn, /if \(!state\.tasks\.some\(\(x\) => x\.id === id\)\) state\.tasks\.push/,
    'the restored task is not put back on the board');
  assert.match(fn, /pulse\(card\)/, 'the restored task arrives with no acknowledgement');
  assert.match(fn, /saved\(`Back in \$\{bucketLabel\(restored\.bucket\)\}`\)/,
    'the destination is not named');
  assert.ok(!/loadRoute|location\.reload/.test(fn), 'restore reloads the page');
});

/* ── §12/§13  Ordering ───────────────────────────────────────────────── */

test('drag: an expanded task collapses its steps before it is measured', () => {
  const fn = body(dragCode, 'function begin(card, e, hooks)');
  // Measuring first would size the placeholder to a card three times the height
  // of its neighbours, and the insertion gap would read as wrong.
  const collapseAt = fn.indexOf('panel.hidden = true');
  const measureAt = fn.indexOf('card.getBoundingClientRect()');
  assert.ok(collapseAt > -1, 'the steps panel is not collapsed for the drag');
  assert.ok(collapseAt < measureAt, 'the card is measured before its steps collapse');
  assert.match(fn, /wasExpanded,/, 'expansion is not remembered for the drop');
});

test('drag: expansion is restored after the drop', () => {
  const fn = body(dragCode, 'function restoreCard(s)');
  assert.match(fn, /if \(s\.wasExpanded\)/, 'a reorder quietly closes what the user opened');
  assert.match(fn, /panel\.hidden = false/);
});

test('drag: a drag never starts inside the steps panel', () => {
  const fn = body(dragCode, 'function onPointerDown(e, hooks)');
  assert.match(fn, /if \(e\.target\.closest\('\.t-steps'\)\) return;/,
    'pressing beside a step name lifts the parent card, which reads as dragging the step');
});

test('order: Today and Project positions are separate columns', async () => {
  const h = await setup();
  const project = (await h.post('/projects', {
    title: 'Two orders', outcome: 'Done', areaId: h.areaId, focus: 'now',
  })).json().project;
  const a = (await h.post('/tasks', { title: 'A', projectId: project.id, bucket: 'today' })).json().task;
  const b = (await h.post('/tasks', { title: 'B', projectId: project.id, bucket: 'today' })).json().task;

  const todayBefore = (await h.get('/tasks?bucket=today')).json().tasks.map((t: any) => t.title);

  // Reorder inside the project only.
  await h.post(`/projects/${project.id}/tasks/${b.id}/reorder`, { beforeTaskId: a.id });

  const proj = (await h.get(`/projects/${project.id}`)).json();
  assert.deepEqual(proj.tasks.filter((t: any) => t.status === 'open').map((t: any) => t.title),
    ['B', 'A'], 'the project order did not change');
  const todayAfter = (await h.get('/tasks?bucket=today')).json().tasks.map((t: any) => t.title);
  assert.deepEqual(todayAfter, todayBefore, 'reordering a project reordered Today');

  // And the reverse: a Today move leaves project_position alone.
  await h.post(`/tasks/${a.id}/move`, { bucket: 'today', beforeTaskId: b.id });
  const proj2 = (await h.get(`/projects/${project.id}`)).json();
  assert.deepEqual(proj2.tasks.filter((t: any) => t.status === 'open').map((t: any) => t.title),
    ['B', 'A'], 'reordering Today reordered the project');
});

test('order: reordering changes position and nothing else', async () => {
  const h = await setup();
  const t = await withSteps(h, 'Untouched', ['a', 'b'], 1, {
    bucket: 'today', priority: 'high', dueDate: '2026-09-09', areaId: h.areaId,
    notes: 'still here',
  });
  const other = (await h.post('/tasks', { title: 'Other', bucket: 'today' })).json().task;
  await h.post(`/tasks/${t.id}/move`, { bucket: 'today', afterTaskId: other.id });

  const after = (await h.get(`/tasks/${t.id}`)).json().task;
  assert.equal(after.bucket, 'today');
  assert.equal(after.priority, 'high');
  assert.equal(after.dueDate, '2026-09-09');
  assert.equal(after.areaId, h.areaId);
  assert.equal(after.notes, 'still here');
  assert.equal(after.projectId, null);
  assert.deepEqual(after.steps.map((s: any) => s.completed), [true, false],
    'a reorder disturbed the steps');
});

/* ── §14  Ordering without a drag ────────────────────────────────────── */

test('order: all four moves exist in the Today menu', () => {
  const fn = body(appCode, 'function openTaskMenu(id, anchorEl)');
  for (const label of ['Move up', 'Move down', 'Move to top', 'Move to bottom']) {
    assert.ok(fn.includes(label), `the Today menu has no "${label}"`);
  }
  assert.match(fn, /if \(b\.dataset\.n\) return nudge\(id, Number\(b\.dataset\.n\)\)/,
    'move up/down are decorative');
});

test('order: all four moves exist in the Project menu', () => {
  const fn = body(appCode, 'function openProjectTaskMenu(anchor, taskId, project)');
  for (const label of ['Move up', 'Move down', 'Move to top', 'Move to bottom']) {
    assert.ok(fn.includes(label), `the project menu has no "${label}"`);
  }
});

/* ── §16  One authoritative state ────────────────────────────────────── */

test('state: one task, redrawn wherever it is mounted', () => {
  assert.match(appCode, /function syncTaskEverywhere\(id, except = null\)/);
  const fn = body(appCode, 'function syncTaskEverywhere(id, except = null)');
  assert.match(fn, /document\.querySelectorAll\(`\.task\[data-id="\$\{id\}"\]`\)/,
    'only one mount is updated');
  assert.match(fn, /patchProjectTaskRow\(id\)/);
  assert.match(fn, /patchCard\(id\)/);
  assert.match(fn, /next\.steps = total \? \{ total, done \} : null/,
    'the next-action slot keeps a stale step count');
  // No copied step arrays: the slot reports counts, it does not hold steps.
  assert.ok(!/nextAction\.steps = \[/.test(appCode));
});

/* ── §19/§20  Scope did not creep ────────────────────────────────────── */

test('safety: no Boards UI, no Google writes, no Legacy migration', () => {
  const web = ['app.js', 'projects.js', 'steps.js', 'task-modal.js'].map(readWeb).join('\n');
  assert.ok(!/data-board|class="board|openBoard\(/.test(web), 'Board UI appeared');
  assert.ok(!/googleapis\.com\/calendar\/v3[^'"]*',\s*\{\s*method:\s*'(POST|PUT|PATCH|DELETE)/
    .test(web), 'a Google Calendar write appeared');
  assert.ok(!/legacyImport|migrateLegacyProjects/.test(web), 'legacy migration appeared');
});

test('safety: habits and calendar are untouched by this phase', async () => {
  const h = await setup();
  const habit = (await h.post('/habits', { name: 'Morning walk' })).json().habit;
  await h.post(`/habits/${habit.id}/check`, { date: '2026-08-02' });
  const hist = (await h.get('/habits/history?from=2026-08-02&to=2026-08-02')).json();
  assert.equal(hist.days[0].done, 1, 'habit history broke');
  const range = (await h.get('/calendar/range?from=2026-08-01&to=2026-08-07')).json();
  assert.ok(Array.isArray(range.habitDays), 'the calendar range shape changed');
});
