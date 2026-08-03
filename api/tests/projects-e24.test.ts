/**
 * Phase E2.4 — task consistency, Today surfacing, save integrity, habit history.
 *
 * Four rules, each of which had a real defect behind it:
 *
 *   1. A Task is a Task everywhere. Steps, project and next-action marker read
 *      the same in Today, in the project's list and in the next-action slot.
 *   2. Completing a task never discards what the user typed.
 *   3. Belonging to a project does not put a task on Today.
 *   4. Habit history is readable AND correctable, on the day it belongs to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { habitHistory } from '../src/lib/habit-history.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(here, '..', '..', 'web', f), 'utf8');
const strip = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
const appCode = strip(read('app.js'));
const modalCode = strip(read('task-modal.js'));
const calCode = strip(read('calendar.js'));

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
  return { app, db, ws, areaId, post, patch, get };
}

/* ── §2–§5  One Task, one shape, everywhere ──────────────────────────── */

test('steps: the project list carries them, so a row cannot read differently', async () => {
  const { post, get, patch, areaId } = await setup();
  const project = (await post('/projects', {
    title: 'Rage 2026', outcome: 'Booked', areaId, focus: 'now',
  })).json().project;
  const task = (await post('/tasks', { title: 'Pay the deposit', projectId: project.id })).json().task;
  for (const title of ['Confirm', 'Get details', 'Send', 'Proof']) {
    await post(`/tasks/${task.id}/steps`, { title });
  }
  const steps = (await get(`/tasks/${task.id}`)).json().task.steps;
  await patch(`/tasks/${task.id}/steps/${steps[0].id}`, { completed: true });
  await patch(`/tasks/${task.id}/steps/${steps[1].id}`, { completed: true });

  const detail = (await get(`/projects/${project.id}`)).json();
  const row = detail.tasks.find((t: any) => t.id === task.id);
  // The same field name and the same shape Today's list uses.
  assert.equal(row.steps.length, 4, 'the project list dropped the steps');
  assert.equal(row.steps.filter((s: any) => s.completed).length, 2);

  // And the next-action slot reports the same progress, as counts.
  assert.deepEqual(detail.project.nextAction.steps, { total: 4, done: 2 },
    'the next action does not report step progress');
});

test('steps: project progress counts TASKS, never steps', async () => {
  const { post, get, patch, areaId } = await setup();
  const project = (await post('/projects', {
    title: 'Counting', outcome: 'Right', areaId, focus: 'now',
  })).json().project;
  const a = (await post('/tasks', { title: 'A', projectId: project.id })).json().task;
  await post('/tasks', { title: 'B', projectId: project.id });
  // Ten steps on one task. If steps leaked into progress, this would swamp it.
  for (let i = 0; i < 10; i++) {
    const s = (await post(`/tasks/${a.id}/steps`, { title: `s${i}` })).json().step;
    await patch(`/tasks/${a.id}/steps/${s.id}`, { completed: true });
  }
  const p = (await get(`/projects/${project.id}`)).json().project;
  assert.deepEqual(
    { open: p.progress.open, done: p.progress.done, total: p.progress.total },
    { open: 2, done: 0, total: 2 },
    'steps are being counted as project progress',
  );
  assert.equal(p.progress.percent, 0);
});

/* ── §11–§13  Completing must not discard unsaved edits ──────────────── */

test('complete: the edits in the editor travel WITH the completion', async () => {
  const { post, get, areaId } = await setup();
  const t = (await post('/tasks', { title: 'Reconcile', areaId })).json().task;
  // Exactly what the editor sends when the tick is pressed while dirty.
  const r = (await post(`/tasks/${t.id}/complete`, {
    notes: 'Bank statement is in the shared folder.',
    priority: 'urgent',
  })).json();
  assert.equal(r.task.status, 'done');
  assert.equal(r.task.notes, 'Bank statement is in the shared folder.',
    'the note typed before the tick was thrown away');
  assert.equal(r.task.priority, 'urgent');
  assert.ok(r.task.completedAt, 'completedAt was not stamped');

  // One write, not two: the completion and the edit share an updated_at.
  const after = (await get(`/tasks/${t.id}`)).json().task;
  assert.equal(after.notes, 'Bank statement is in the shared folder.');
  assert.equal(after.status, 'done');
});

test('complete: an empty body still completes, and changes nothing else', async () => {
  const { post, areaId } = await setup();
  const t = (await post('/tasks', { title: 'Plain', notes: 'keep me', areaId })).json().task;
  const r = (await post(`/tasks/${t.id}/complete`)).json();
  assert.equal(r.task.status, 'done');
  assert.equal(r.task.notes, 'keep me', 'an empty body wiped the existing notes');
});

test('complete: uncompleting carries edits too, and clears completedAt', async () => {
  const { post } = await setup();
  const t = (await post('/tasks', { title: 'Back' })).json().task;
  await post(`/tasks/${t.id}/complete`);
  const r = (await post(`/tasks/${t.id}/uncomplete`, { notes: 'reopened for a reason' })).json();
  assert.equal(r.task.status, 'open');
  assert.equal(r.task.completedAt, null);
  assert.equal(r.task.notes, 'reopened for a reason');
});

test('complete: the bucket is NOT accepted on the way out', async () => {
  const { post } = await setup();
  const t = (await post('/tasks', { title: 'Leaving', bucket: 'week' })).json().task;
  const r = await post(`/tasks/${t.id}/complete`, { bucket: 'today' });
  // Rejected outright rather than silently ignored: a caller that thinks it is
  // moving a task deserves to be told it is not.
  assert.equal(r.statusCode, 400, 'bucket was quietly accepted while completing');
});

test('ui: the tick sends the dirty fields and no longer force-closes blindly', () => {
  const fn = body(modalCode, "dlg.querySelector('#m-toggle').onclick = async () =>");
  assert.match(fn, /ctx\.onToggle\(isDirty\(\) \? read\(\) : null\)/,
    'the completion still ignores what is in the form');
  // The old shape: onToggle() with no body, then close(true) unconditionally.
  assert.ok(!/await ctx\.onToggle\(\);/.test(modalCode),
    'the argument-less onToggle is back');
  assert.match(fn, /catch \(e\)/, 'a failed completion still closes and loses the edits');
  assert.match(fn, /if \(busy\) return;/, 'a double click can fire two completions');
});

test('ui: archiving saves first, so it cannot lose edits either', () => {
  const fn = body(modalCode, "dlg.querySelector('#m-archive').onclick = async () =>");
  assert.match(fn, /if \(isDirty\(\)\) await ctx\.onSave\(read\(\)\)/,
    'archive discards unsaved edits');
});

/* ── §14/§15  The project detail reconciles in place ─────────────────── */

test('ui: project rows are wired by the project, not by the Today board', () => {
  const fn = body(appCode, 'function wireProjectDetail()');
  // THE BUG: wireBoard() ran over every .task on the page and reassigned
  // onclick, silently replacing the project handlers with Today's — which look
  // the task up in state.tasks and do nothing when it is not on Today.
  assert.ok(!/wireBoard\(\)/.test(fn),
    'wireBoard is back, and it overwrites the project task handlers');
  assert.match(fn, /wireProjectTaskRows\(p\)/, 'the project rows are unwired');

  const rows = body(appCode, 'function wireProjectTaskRows(project)');
  assert.match(rows, /completeProjectTask\(id\)/, 'the tick does not complete');
  assert.match(rows, /openProjectTask\(id\)/, 'the row does not open');
  assert.match(rows, /openProjectTaskMenu\(b, id, project\)/, 'the menu is unwired');
  // Completed rows are wired too, or a task can be finished and never reopened.
  assert.match(rows, /\.pjd-tasks-done \.task/, 'rows in Completed are left unwired');
});

test('ui: completion goes through the endpoint that carries edits', () => {
  const fn = body(appCode, 'async function completeProjectTask(taskId, dirty = null)');
  assert.match(fn, /uncomplete' : 'complete'/, 'completion is not using the complete route');
  assert.match(fn, /body: dirty \?\? \{\}/, 'the dirty fields are not sent');
  assert.match(fn, /moveTaskNodeToSection\(row, !wasDone\)/, 'the node is not moved');

  const open = body(appCode, 'function openProjectTask(taskId)');
  assert.match(open, /onToggle: \(dirty\) => completeProjectTask\(task\.id, dirty\)/,
    'the editor and the row tick take different paths');
});

/* ── §7–§9  Today surfacing ──────────────────────────────────────────── */

test('surfacing: a task in a Now project starts in the week, not on Today', () => {
  const fn = body(appCode, 'function addProjectTask(project)');
  assert.match(fn, /project\.focus === 'now' \? 'week' : 'future'/,
    'a Now project puts every new task on Today');
});

test('surfacing: choosing a next action on a Now project brings it to Today', async () => {
  const { post, get, areaId } = await setup();
  const project = (await post('/projects', {
    title: 'Now', outcome: 'Done', areaId, focus: 'now',
  })).json().project;
  const t = (await post('/tasks', { title: 'The one thing', projectId: project.id, bucket: 'week' })).json().task;

  const r = (await post(`/projects/${project.id}/next-action`, { taskId: t.id })).json();
  assert.equal(r.surfaced, true, 'the move was not reported, so the UI cannot mention it');
  assert.equal((await get(`/tasks/${t.id}`)).json().task.bucket, 'today');
});

test('surfacing: the same choice on an Upcoming project moves nothing', async () => {
  const { post, get, areaId } = await setup();
  const project = (await post('/projects', {
    title: 'Later', outcome: 'Done', areaId, focus: 'upcoming',
  })).json().project;
  const t = (await post('/tasks', { title: 'Not yet', projectId: project.id, bucket: 'week' })).json().task;

  const r = (await post(`/projects/${project.id}/next-action`, { taskId: t.id })).json();
  assert.equal(r.surfaced, false);
  assert.equal((await get(`/tasks/${t.id}`)).json().task.bucket, 'week',
    'a project that is not Now still reached into Today');
});

test('surfacing: an INFERRED next action never moves a task', async () => {
  const { post, get, areaId } = await setup();
  const project = (await post('/projects', {
    title: 'Inferring', outcome: 'Done', areaId, focus: 'now',
  })).json().project;
  const t = (await post('/tasks', { title: 'First', projectId: project.id, bucket: 'future' })).json().task;

  // No override set — the next action is inferred. Inference changes whenever a
  // due date moves, and Today must not reshuffle itself behind the user.
  const p = (await get(`/projects/${project.id}`)).json().project;
  assert.equal(p.nextAction.id, t.id);
  assert.equal(p.nextAction.explicit, false);
  assert.equal((await get(`/tasks/${t.id}`)).json().task.bucket, 'future',
    'inference moved a task onto Today');
});

test('surfacing: membership alone puts nothing on Today', async () => {
  const { post, get, areaId } = await setup();
  const project = (await post('/projects', {
    title: 'Busy', outcome: 'Done', areaId, focus: 'now',
  })).json().project;
  for (const title of ['A', 'B', 'C', 'D', 'E']) {
    await post('/tasks', { title, projectId: project.id, bucket: 'week' });
  }
  const board = (await get('/tasks?includeCompleted=false')).json();
  assert.equal(board.tasks.filter((t: any) => t.bucket === 'today').length, 0,
    'a five-task project filled Today');
});

test('surfacing: Today marks the RESOLVED next action, chosen or inferred', async () => {
  const { post, get, areaId } = await setup();
  const project = (await post('/projects', {
    title: 'Marking', outcome: 'Done', areaId, focus: 'now',
  })).json().project;
  const soon = (await post('/tasks', {
    title: 'Due first', projectId: project.id, bucket: 'today', dueDate: '2026-01-01',
  })).json().task;
  await post('/tasks', { title: 'Later', projectId: project.id, bucket: 'today', dueDate: '2027-01-01' });

  const board = (await get('/tasks?includeCompleted=false')).json();
  // No override has been set — `nextTaskId` is null — and the badge must still
  // appear, on the task inference actually chose.
  assert.equal(board.projects[project.id].nextActionId, soon.id,
    'Today cannot mark an inferred next action');
  assert.ok(!('nextTaskId' in board.projects[project.id]),
    'the raw override is still being sent, which is what was marked before');
});

/* ── §16–§21  Habit history ──────────────────────────────────────────── */

const H = (over: any = {}) => ({
  id: 'h1', targetCount: 1, frequencyType: 'daily', frequencyConfig: null,
  createdAt: new Date('2020-01-01T00:00:00Z'), ...over,
});

test('history: a habit is only due on the days it asks for', () => {
  // Monday only. 2026-08-03 is a Monday; 2026-08-04 is not.
  const mon = H({ frequencyType: 'specific_days', frequencyConfig: { days: [1] } });
  const days = habitHistory([mon], [], '2026-08-03', '2026-08-04');
  assert.deepEqual(days.map((d) => d.due), [1, 0],
    'a Monday habit is being counted against other days');
});

test('history: a partial count is not done', () => {
  const water = H({ targetCount: 3 });
  const days = habitHistory([water],
    [{ habitId: 'h1', entryDate: '2026-08-03', completedCount: 2 }],
    '2026-08-03', '2026-08-03');
  assert.deepEqual(days[0], { date: '2026-08-03', due: 1, done: 0 },
    '2 of a target of 3 is being reported as complete');
});

test('history: days before a habit existed are not counted as missed', () => {
  const born = H({ createdAt: new Date('2026-08-03T09:00:00Z') });
  const days = habitHistory([born], [], '2026-08-01', '2026-08-03');
  assert.deepEqual(days.map((d) => d.due), [0, 0, 1],
    'a habit is being counted as missed before it was created');
});

test('history: the day is a string throughout, with no timezone round trip', () => {
  const src = readFileSync(join(here, '..', 'src', 'lib', 'habit-history.ts'), 'utf8');
  // The one permitted Date is the weekday probe, and it is built at noon so no
  // offset can push it into the day either side.
  const dates = src.match(/new Date\([^)]*\)/g) ?? [];
  for (const d of dates) {
    assert.ok(/T12:00:00Z|ms\)/.test(d), `a date is being parsed unsafely: ${d}`);
  }
  assert.match(src, /T12:00:00Z/, 'the weekday probe is not pinned to noon');
});

test('history: the range endpoint refuses a backwards or oversized span', async () => {
  const { get } = await setup();
  assert.equal((await get('/habits/history?from=2026-08-10&to=2026-08-01')).statusCode, 400);
  assert.equal((await get('/habits/history?from=2020-01-01&to=2026-01-01')).statusCode, 400);
  assert.equal((await get('/habits/history?from=2026-08-01&to=2026-08-07')).statusCode, 200);
});

test('history: a tick lands on the day it was made for, days in the past', async () => {
  const { post, get } = await setup();
  const h = (await post('/habits', { name: 'Morning walk' })).json().habit;
  await post(`/habits/${h.id}/check`, { date: '2026-07-30', count: 1 });

  const days = (await get('/habits/history?from=2026-07-29&to=2026-07-31')).json().days;
  assert.deepEqual(days.map((d: any) => [d.date, d.done]),
    [['2026-07-29', 0], ['2026-07-30', 1], ['2026-07-31', 0]],
    'the tick landed on the wrong day');

  await post(`/habits/${h.id}/uncheck`, { date: '2026-07-30' });
  const after = (await get('/habits/history?from=2026-07-30&to=2026-07-30')).json().days;
  assert.equal(after[0].done, 0, 'a historical tick cannot be undone');
});

test('history: Calendar and the habits endpoint agree, because they share one function', async () => {
  const { post, get } = await setup();
  const h = (await post('/habits', { name: 'Water', targetCount: 3 })).json().habit;
  await post(`/habits/${h.id}/check`, { date: '2026-08-02', count: 2 });

  const hist = (await get('/habits/history?from=2026-08-02&to=2026-08-02')).json().days[0];
  const range = (await get('/calendar/range?from=2026-08-02&to=2026-08-02')).json();
  const cal = range.habitDays.find((d: any) => d.date === '2026-08-02');
  assert.deepEqual({ due: cal.due, done: cal.done }, { due: hist.due, done: hist.done },
    'the Calendar grid and the habits endpoint disagree about the same day');
  assert.equal(cal.done, 0, 'Calendar is counting a partial tick as done');
});

/* ── §16–§18  What the Calendar draws ────────────────────────────────── */

test('ui: the Month cell shows a ratio, and nothing on a future or empty day', () => {
  const fn = body(calCode, 'function habitSummaryHtml(habit, day, todayIso)');
  assert.match(fn, /!habit\.due \|\| day > todayIso/,
    'empty days or days still to come are being marked');
  assert.match(fn, /\$\{habit\.done\}\/\$\{habit\.due\}/, 'the mark is not a ratio');
});

test('ui: the selected day lists its habits, each one tickable on that day', () => {
  const fn = body(calCode, 'function habitCardHtml(day)');
  assert.match(fn, /data-habit-day="\$\{day\}"/,
    'the row does not carry its day, so a tick cannot reach a past date');
  assert.match(fn, /h\.dueToday/, 'habits that were not due are being listed');
  // Month only.
  const sel = body(appCode, 'function selectDay(day)');
  assert.match(sel, /cal\.mode === 'month'/, 'the habit card is loading outside Month');
});

test('ui: ticking a past day patches the cell rather than reloading the month', () => {
  const fn = body(appCode, 'async function toggleHabitOn(habitId, day)');
  assert.match(fn, /body: \{ date: day \}/, 'the tick does not name its day');
  assert.match(fn, /patchHabitCell\(day\)/, 'the month cell is not updated');
  assert.ok(!/loadCalendar\(\)/.test(fn), 'one tick reloads the whole calendar');
  // A failure must put the row back.
  assert.match(fn, /Object\.assign\(h, before\)/, 'a failed tick leaves a false state on screen');
});

test('ui: a slow response cannot paint one day into another', () => {
  const fn = body(appCode, 'async function loadDayHabits(day)');
  assert.match(fn, /if \(cal\.selected !== day\) return;/,
    'a late response can land on the wrong day');
});

/* ── §10  The seed demonstrates the rule ─────────────────────────────── */

test('sample: only tasks with a real reason are on Today', () => {
  const src = readFileSync(join(here, '..', 'src', 'lib', 'sample-projects.ts'), 'utf8');
  const todays = [...src.matchAll(/\{ title: '([^']+)'[^}]*bucket: 'today'[^}]*\}/g)];
  for (const [line, title] of todays) {
    assert.ok(/dueDate|next: true/.test(line),
      `"${title}" is on Today with no due date and no next-action claim`);
  }
  // And the active Now project that demonstrates the opposite case.
  const review = src.slice(src.indexOf("key: 'now-early'"), src.indexOf("key: 'upcoming-planning'"));
  assert.ok(!/bucket: 'today'/.test(review),
    'the "nothing surfaces" demonstration project is back on Today');
});
