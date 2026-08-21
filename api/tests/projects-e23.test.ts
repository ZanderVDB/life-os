/**
 * Phase E2.3 — one Task record shown in several places.
 *
 * The rule under test: a Project Task is ONE task record given different
 * prominence, never a second object. Steps stay steps, next action stays a
 * task, and Today shows the same record it always did with its project named.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { tasks } from '../src/db/schema.js';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const strip = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
const appCode = strip(read('app.js'));
const pjCode = strip(read('projects.js'));
const css = strip(read('index.html') + read('app.css'));

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

  const project = (await post('/projects', {
    title: 'Launch WebAnchor website', outcome: 'It is live', areaId, focus: 'now',
  })).json().project;
  const add = async (title: string, over: any = {}) => {
    const t = (await post('/tasks', { title, projectId: project.id, ...over })).json().task;
    return t;
  };
  return { app, db, ws, areaId, project, post, patch, get, add };
}

/* ── One record, several contexts ────────────────────────────────────── */

test('identity: Today, the project and the next action all name the same record', async () => {
  const { project, post, get, add, app, ws } = await setup();
  const t = await add('Purchase the domain', { bucket: 'today', dueDate: '2026-09-01' });
  await post(`/projects/${project.id}/next-action`, { taskId: t.id });

  const today = (await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks?includeCompleted=false`, headers: auth(),
  })).json();
  const detail = (await get(`/projects/${project.id}`)).json();

  const fromToday = today.tasks.find((x: any) => x.id === t.id);
  const fromProject = detail.tasks.find((x: any) => x.id === t.id);
  assert.ok(fromToday && fromProject, 'the task is missing from a context');
  assert.equal(detail.project.nextAction.id, t.id);

  // Every field that defines the task agrees, everywhere.
  for (const f of ['id', 'title', 'priority', 'dueDate', 'bucket', 'areaId',
    'projectId', 'status', 'notes', 'scheduledAt']) {
    assert.deepEqual(fromToday[f], fromProject[f], `${f} differs between Today and the project`);
  }
});

test('identity: Today names the project without copying it onto every task', async () => {
  const { project, add, app, ws } = await setup();
  const t = await add('Configure analytics', { bucket: 'today' });
  const r = (await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks?includeCompleted=false`, headers: auth(),
  })).json();

  assert.ok(r.projects, 'the task list carries no project context, so Today cannot name one');
  assert.equal(r.projects[project.id].title, 'Launch WebAnchor website');
  // A compact map — the task row is still one Task record, not a task with
  // project fields grafted onto it.
  const row = r.tasks.find((x: any) => x.id === t.id);
  assert.equal(row.projectId, project.id);
  assert.equal(row.projectTitle, undefined, 'project fields were copied onto the task');
});

test('identity: only the referenced projects are sent, not every project', async () => {
  const { project, areaId, post, add, app, ws } = await setup();
  await post('/projects', { title: 'Unrelated', outcome: 'x', areaId, focus: 'now' });
  await add('In the first project', { bucket: 'today' });
  const r = (await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks?includeCompleted=false`, headers: auth(),
  })).json();
  assert.deepEqual(Object.keys(r.projects), [project.id],
    'the task list ships projects nothing on it belongs to');
});

/* ── Tasks versus Steps ──────────────────────────────────────────────── */

test('steps: a step is never a project task, and never counts as one', async () => {
  const { project, get, add, app, ws } = await setup();
  const t = await add('Purchase the domain');
  for (const title of ['Compare registrars', 'Confirm billing', 'Buy it']) {
    await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${t.id}/steps`,
      headers: auth(), payload: { title },
    });
  }
  // Complete every step. The task is still open, so the project is still 0 done.
  const steps = (await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks/${t.id}`, headers: auth(),
  })).json().task.steps ?? [];
  for (const s of steps) {
    await app.inject({
      method: 'PATCH', url: `/api/v1/workspaces/${ws}/tasks/${t.id}/steps/${s.id}`,
      headers: auth(), payload: { completed: true },
    });
  }

  const detail = (await get(`/projects/${project.id}`)).json();
  assert.equal(detail.tasks.length, 1, 'steps became project tasks');
  assert.equal(detail.project.progress.total, 1);
  assert.equal(detail.project.progress.done, 0,
    'completed steps inflated project progress — one task with ten done steps is still one open task');
});

test('steps: survive being read through the project', async () => {
  const { project, get, add, app, ws } = await setup();
  const t = await add('Purchase the domain');
  await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${t.id}/steps`,
    headers: auth(), payload: { title: 'Compare registrars' },
  });
  const viaToday = (await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks?includeCompleted=false`, headers: auth(),
  })).json().tasks.find((x: any) => x.id === t.id);
  assert.equal(viaToday.steps.length, 1, 'steps vanish when the task is read from Today');
  assert.ok((await get(`/projects/${project.id}`)).json().tasks[0],
    'the task vanished when read through the project');
});

/* ── Next action reports which rule chose it ─────────────────────────── */

test('next action: says which rule actually applied', async () => {
  const { project, post, get, add } = await setup();
  const dated = await add('Has a date', { dueDate: '2026-09-01', priority: 'low' });
  await add('No date', { priority: 'urgent' });
  assert.equal((await get(`/projects/${project.id}`)).json().project.nextAction.reason, 'due');

  // Same (absent) date on both → priority decides.
  const { project: p2, post: post2, get: get2, add: add2 } = await setup();
  await add2('Urgent', { priority: 'urgent' });
  await add2('Low', { priority: 'low' });
  assert.equal((await get2(`/projects/${p2.id}`)).json().project.nextAction.reason, 'priority');

  // Identical on both counts → manual order is the only thing left.
  const { project: p3, get: get3, add: add3 } = await setup();
  await add3('First', { priority: 'medium' });
  await add3('Second', { priority: 'medium' });
  assert.equal((await get3(`/projects/${p3.id}`)).json().project.nextAction.reason, 'order');

  // An explicit choice says so.
  await post(`/projects/${project.id}/next-action`, { taskId: dated.id });
  assert.equal((await get(`/projects/${project.id}`)).json().project.nextAction.reason, 'chosen');
});

test('next action: carries the same facts the task row does', async () => {
  const { project, get, add } = await setup();
  await add('Do it', { bucket: 'today', dueDate: '2026-09-01', priority: 'high' });
  const next = (await get(`/projects/${project.id}`)).json().project.nextAction;
  for (const f of ['id', 'title', 'dueDate', 'priority', 'bucket', 'scheduledAt']) {
    assert.ok(f in next, `the next action omits ${f}, so it says less than the task list`);
  }
});

/* ── Project task creation ───────────────────────────────────────────── */

test('creation: a task created in a project is assigned in one write', async () => {
  const { project, areaId, post, get } = await setup();
  const r = await post('/tasks', {
    title: 'Finalise homepage design', projectId: project.id, areaId, bucket: 'today',
  });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().task.projectId, project.id,
    'the task was created loose and assigned afterwards, which can half-fail');
  assert.equal((await get(`/projects/${project.id}`)).json().tasks.length, 1);
});

test('creation: a project from another workspace is refused', async () => {
  const a = await setup();
  const b = await setup();
  const r = await a.post('/tasks', { title: 'X', projectId: b.project.id });
  assert.equal(r.statusCode, 400, 'a task was filed into another workspace\'s project');
});

/* ── Ordering isolation ──────────────────────────────────────────────── */

test('order: completing and reopening a task keeps both orderings intact', async () => {
  const { project, post, get, add, app, ws } = await setup();
  const ids: string[] = [];
  for (const t of ['A', 'B', 'C']) ids.push((await add(t, { bucket: 'today' })).id);
  await post(`/projects/${project.id}/tasks/${ids[2]}/reorder`, { to: 'top' });

  const before = (await get(`/projects/${project.id}`)).json().tasks.map((t: any) => t.title);
  assert.deepEqual(before, ['C', 'A', 'B']);
  const todayBefore = (await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks?includeCompleted=false`, headers: auth(),
  })).json().tasks.map((t: any) => t.title);

  // Complete then reopen the middle one.
  for (const status of ['done', 'open']) {
    await app.inject({
      method: 'PATCH', url: `/api/v1/workspaces/${ws}/tasks/${ids[0]}`,
      headers: auth(), payload: { status },
    });
  }

  const after = (await get(`/projects/${project.id}`)).json().tasks
    .filter((t: any) => t.status === 'open').map((t: any) => t.title);
  assert.deepEqual(after, before, 'completing and reopening corrupted the project order');
  const todayAfter = (await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks?includeCompleted=false`, headers: auth(),
  })).json().tasks.map((t: any) => t.title);
  assert.deepEqual(todayAfter, todayBefore, 'a project reorder leaked into the Today order');
});

test('order: a task removed and re-added lands somewhere sensible', async () => {
  const { app, ws, project, post, get, add } = await setup();
  const ids: string[] = [];
  for (const t of ['A', 'B', 'C']) ids.push((await add(t)).id);
  await post(`/projects/${project.id}/tasks/${ids[2]}/reorder`, { to: 'top' });
  assert.deepEqual((await get(`/projects/${project.id}`)).json().tasks.map((t: any) => t.title),
    ['C', 'A', 'B']);

  // Out and back in.
  await app.inject({
    method: 'DELETE', url: `/api/v1/workspaces/${ws}/projects/${project.id}/tasks/${ids[1]}`,
    headers: auth(),
  });
  await post(`/projects/${project.id}/tasks`, { taskId: ids[1] });

  const after = (await get(`/projects/${project.id}`)).json().tasks;
  assert.equal(after.length, 3, 'the task came back twice, or not at all');
  assert.equal(new Set(after.map((t: any) => t.id)).size, 3);
  // The others kept their order relative to each other.
  const titles = after.map((t: any) => t.title);
  assert.ok(titles.indexOf('C') < titles.indexOf('A'),
    're-adding a task reshuffled the tasks that never moved');
});

/* ── Safety ──────────────────────────────────────────────────────────── */

test('safety: nothing in E2.3 creates a second task record', async () => {
  const { db, ws, project, post, get, add, app } = await setup();
  const t = await add('Only one', { bucket: 'today' });
  await post(`/projects/${project.id}/next-action`, { taskId: t.id });
  await get(`/projects/${project.id}`);
  await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks?includeCompleted=false`, headers: auth(),
  });
  const rows = await db.select().from(tasks).where(eq(tasks.workspaceId, ws));
  assert.equal(rows.length, 1, 'reading a task in several contexts created copies of it');
});

/* ── The interface contracts ─────────────────────────────────────────── */

test('ui: Today shows the project by name, as a link, never as colour alone', () => {
  const fn = body(appCode, 'function taskHtml(t)');
  assert.match(fn, /state\.projectsById\[t\.projectId\]/, 'the card cannot name its project');
  assert.match(fn, /data-open-project="\$\{project\.id\}"/, 'the project name is not a link');
  // The RESOLVED next action, not the stored override. `nextTaskId` is null on
  // every project nobody has hand-picked a task for, so keying off it meant the
  // badge almost never appeared.
  assert.match(fn, /project\.nextActionId === t\.id/, 'the next action is unmarked on Today');
  assert.ok(!/nextTaskId/.test(fn), 'Today is back on the raw override');
  assert.match(fn, /Next action</, 'the marker is not a word');
  assert.match(css, /\.tm-project\{/, 'the project chip has no styling');
  // The chip sits in the existing meta line, so adding it cannot move the title.
  assert.match(fn, /bits\.push\(`<button class="tm-project"/,
    'the project name is added outside the meta line, so it shifts the title');
});

test('ui: opening a project from Today remembers the board', () => {
  const fn = body(appCode, 'function openProjectFromToday(projectId, fromTaskId)');
  assert.match(fn, /scrollTop: window\.scrollY/, 'the scroll position is not captured');
  assert.match(fn, /areaFilter: state\.areaFilter/, 'the area filter is not captured');
  assert.match(fn, /taskId: fromTaskId/, 'the focused task is not captured');
  const back = body(appCode, 'async function closeProjectDetail(push = true)');
  assert.match(back, /if \(pj\.cameFromToday\)/, 'Back returns to the overview instead of Today');
  const restore = body(appCode, 'function restoreTodayState()');
  assert.match(restore, /window\.scrollTo/, 'the board is not scrolled back');
  assert.match(restore, /\.focus\(\{ preventScroll: true \}\)/, 'focus is not returned');
});

test('ui: completing in project detail moves the same node, no rebuild', () => {
  // The standing known limitation from E2.1/E2.2.
  const fn = body(appCode, 'async function completeProjectTask(taskId, dirty = null)');
  assert.ok(!/reloadProjectDetail/.test(fn), 'completion still rebuilds the detail page');
  assert.match(fn, /row\.classList\.add\('is-completing'\)/, "Today's completion class is not reused");
  assert.match(fn, /moveTaskNodeToSection\(row, !wasDone\)/, 'the node is not moved');
  // Order: acknowledge, move, THEN the numbers.
  assert.ok(fn.indexOf('is-completing') < fn.indexOf('moveTaskNodeToSection'));
  assert.ok(fn.indexOf('moveTaskNodeToSection') < fn.indexOf('updateProjectDerived'),
    'the counts change during the movement, which reads as a glitch');

  const move = body(appCode, 'function moveTaskNodeToSection(row, toDone)');
  assert.match(move, /target\.appendChild\(row\)/, 'a new node is created instead of moved');
  assert.ok(!/innerHTML = /.test(move.replace(/done\.innerHTML = '<summary>/, '')),
    'the section is rebuilt rather than patched');
  assert.match(move, /flip\(/, 'the movement is not animated');
  assert.match(move, /if \(done && n === 0\) done\.remove\(\)/,
    'an empty Completed section is left behind');
  assert.match(move, /assertOneRowPerTask/, 'the identity invariant is not re-checked');
});

test('ui: the next-action slot says which rule chose it', () => {
  assert.match(pjCode, /chosen: 'Chosen explicitly'/, 'an explicit choice is not named');
  assert.match(pjCode, /due: 'From its due date'/, 'the due-date rule is not named');
  assert.match(pjCode, /priority: 'From its priority'/, 'the priority rule is not named');
  assert.match(pjCode, /order: 'From the order below'/, 'project order is not named');
  const slot = body(pjCode, 'export function nextActionSlotHtml(p)');
  assert.match(slot, /pjd-next-steps/, 'the slot hides step progress the task row shows');
  assert.match(slot, /pjd-next-sched/, 'the slot hides that the task is scheduled');
});

test('ui: opening a task uses the shared editor from every context', () => {
  // Not a reduced next-action-only editor.
  const fn = body(appCode, 'function openProjectTask(taskId)');
  assert.match(fn, /openTaskModal\(\{/, 'project detail uses its own task editor');
  assert.match(fn, /project: project \? \{ title: project\.title \} : null/,
    'the editor does not name the project it was opened from');
  // The next-action slot opens the same one.
  assert.match(appCode, /#pjd-next \[data-pjd-open-task\]/,
    'the next action does not open the shared editor');
});

test('ui: Today grouping is a badge, and the reason is recorded', () => {
  // §6 permits the smaller first version. Clusters would place non-task nodes
  // inside the drop zone, and the placeholder is inserted relative to task
  // siblings — so a header can land on the wrong side of the insertion point
  // and the visual order stops matching the stored order.
  const debt = readFileSync(join('..', 'docs', 'technical-debt.md'), 'utf8');
  assert.match(debt, /Today project grouping/i,
    'the grouping decision is not written down anywhere');
  assert.ok(!/pj-cluster|project-cluster/.test(appCode),
    'a cluster shipped without the drag consequences being worked through');
});
