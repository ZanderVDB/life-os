/**
 * Phase E2 — the Project API, end to end through Fastify with a real database.
 *
 * The contracts under test are the ones that protect the user's work: a project
 * never silently changes a task, an area is never silently reclassified, and a
 * failure never looks like success.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused',
  FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  DEV_AUTH_BYPASS: TOKEN,
} as any);

const auth = (email = 'zander@example.com') => ({
  authorization: `Bearer ${TOKEN}`, 'x-dev-email': email,
});

async function setup(email?: string) {
  const { db } = await freshDb();
  const app = buildApp(db, env);
  await app.ready();
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(email) })).json();
  const ws = me.workspace.id;
  const areaId = me.areas.find((a: any) => a.name === 'Work').id;
  const otherAreaId = me.areas.find((a: any) => a.name === 'Personal').id;
  const base = `/api/v1/workspaces/${ws}`;

  const post = (url: string, payload?: any, e?: string) =>
    app.inject({ method: 'POST', url: base + url, headers: auth(e ?? email), payload: payload ?? {} });
  const patch = (url: string, payload: any) =>
    app.inject({ method: 'PATCH', url: base + url, headers: auth(email), payload });
  const get = (url: string) => app.inject({ method: 'GET', url: base + url, headers: auth(email) });
  const del = (url: string) => app.inject({ method: 'DELETE', url: base + url, headers: auth(email) });

  const makeProject = async (over: any = {}) => {
    const r = await post('/projects', {
      title: 'Ship the website', outcome: 'The site is live', areaId, focus: 'now', ...over,
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().project;
  };
  const makeTask = async (over: any = {}) => {
    const r = await post('/tasks', { title: 'Do the thing', ...over });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().task;
  };

  return { app, db, ws, areaId, otherAreaId, post, patch, get, del, makeProject, makeTask };
}

/* ── Create ──────────────────────────────────────────────────────────── */

test('create: title, outcome, area and focus are all required', async () => {
  const { post, areaId } = await setup();
  const missing = [
    { outcome: 'x', areaId, focus: 'now' },
    { title: 'x', areaId, focus: 'now' },
    { title: 'x', outcome: 'y', focus: 'now' },
    { title: 'x', outcome: 'y', areaId },
  ];
  for (const payload of missing) {
    const r = await post('/projects', payload);
    assert.equal(r.statusCode, 400, `accepted ${JSON.stringify(payload)}`);
  }
  // The outcome message has to say what an outcome IS — it is the one field
  // people will not understand from its label alone.
  const r = await post('/projects', { title: 'x', areaId, focus: 'now' });
  assert.match(r.json().error?.message ?? r.body, /what is true when this is done/i);
});

test('create: a first task makes it Active; no task makes it Planning', async () => {
  const { post, areaId } = await setup();
  const withTask = await post('/projects', {
    title: 'A', outcome: 'done', areaId, focus: 'now', firstTask: { title: 'Step one' },
  });
  assert.equal(withTask.json().project.status, 'active',
    'a project created in order to do something should not need a second click');
  assert.equal(withTask.json().tasks.length, 1);
  assert.equal(withTask.json().tasks[0].projectId, withTask.json().project.id);
  assert.equal(withTask.json().tasks[0].areaId, areaId, 'the first task did not inherit the area');

  const without = await post('/projects', { title: 'B', outcome: 'done', areaId, focus: 'upcoming' });
  assert.equal(without.json().project.status, 'planning');
  assert.equal(without.json().tasks.length, 0);
});

test('create: focus is the user\'s, never derived from having a task', async () => {
  const { post, areaId } = await setup();
  const r = await post('/projects', {
    title: 'A', outcome: 'done', areaId, focus: 'someday', firstTask: { title: 'x' },
  });
  assert.equal(r.json().project.status, 'active');
  assert.equal(r.json().project.focus, 'someday', 'focus was overwritten by the presence of work');
  // …and a Someday project's first task does not land on Today.
  assert.equal(r.json().tasks[0].bucket, 'future');
});

test('create: an area from another workspace is refused', async () => {
  const a = await setup('a@example.com');
  const b = await setup('b@example.com');
  const r = await a.post('/projects', {
    title: 'X', outcome: 'y', areaId: b.areaId, focus: 'now',
  });
  assert.equal(r.statusCode, 400, 'a cross-workspace area was accepted');
});

/* ── Overview ────────────────────────────────────────────────────────── */

test('overview: a project appears exactly once, attention outranks its group', async () => {
  const { makeProject, get } = await setup();
  // Active with no tasks = no next action = needs attention. It must be lifted
  // OUT of Now, not shown in both.
  const p = await makeProject({ focus: 'now', firstTask: { title: 'x' } });
  const r = await get('/projects');
  const groups = r.json().groups;
  const ids = groups.flatMap((g: any) => g.projects.map((x: any) => x.id));
  assert.equal(new Set(ids).size, ids.length, 'a project is listed in two groups at once');
  assert.ok(ids.includes(p.id));
});

test('overview: Needs attention only exists when it has something to say', async () => {
  const { makeProject, get } = await setup();
  await makeProject({ focus: 'now', firstTask: { title: 'open work' } });
  const clean = (await get('/projects')).json();
  assert.ok(!clean.groups.some((g: any) => g.id === 'attention'),
    'an empty Needs attention group was rendered');

  await makeProject({ title: 'Empty active', focus: 'now' });
  // Planning with no tasks is normal, so still nothing. Make it active.
  const p2 = (await get('/projects')).json().groups.flatMap((g: any) => g.projects)
    .find((x: any) => x.title === 'Empty active');
  assert.equal(p2.status, 'planning');
  assert.equal(p2.health.length, 0, 'planning with no work was flagged');
});

test('overview: Someday and completed are behind filters, not on the default page', async () => {
  const { makeProject, get, post } = await setup();
  const someday = await makeProject({ title: 'Later', focus: 'someday' });
  const working = (await get('/projects')).json();
  const ids = working.groups.flatMap((g: any) => g.projects.map((x: any) => x.id));
  assert.ok(!ids.includes(someday.id), 'a someday project competed for attention');
  // …but it is one clear action away, and the page says it is there.
  assert.equal(working.available.someday, 1);
  const found = (await get('/projects?filter=someday')).json();
  assert.ok(found.groups[0].projects.some((x: any) => x.id === someday.id));
});

test('overview: archived projects are never in the default view', async () => {
  const { makeProject, get, post } = await setup();
  const p = await makeProject();
  await post(`/projects/${p.id}/archive`);
  const working = (await get('/projects')).json();
  const ids = working.groups.flatMap((g: any) => g.projects.map((x: any) => x.id));
  assert.ok(!ids.includes(p.id));
  assert.equal(working.available.archived, 1);
  assert.ok((await get('/projects?filter=archived')).json().groups[0].projects.length === 1);
});

/* ── Status and focus ────────────────────────────────────────────────── */

test('status and focus move independently', async () => {
  const { makeProject, patch, get } = await setup();
  const p = await makeProject({ focus: 'now', firstTask: { title: 'x' } });

  const held = (await patch(`/projects/${p.id}`, { status: 'on_hold' })).json().project;
  assert.equal(held.status, 'on_hold');
  assert.equal(held.focus, 'now', 'changing status silently changed focus');
  // The contradictory pair resolves by suppressing surfacing, not by editing
  // the user's answer.
  assert.equal(held.surfacesAutomatically, false);

  const refocused = (await patch(`/projects/${p.id}`, { focus: 'someday' })).json().project;
  assert.equal(refocused.status, 'on_hold', 'changing focus silently changed status');
});

test('status and focus changes never touch task dates or buckets', async () => {
  const { makeProject, patch, get, post, makeTask } = await setup();
  const p = await makeProject({ focus: 'now' });
  const t = await makeTask({ bucket: 'today', dueDate: '2026-09-01' });
  await post(`/projects/${p.id}/tasks`, { taskId: t.id });

  for (const change of [{ focus: 'someday' }, { status: 'on_hold' }, { focus: 'now' }, { status: 'active' }]) {
    await patch(`/projects/${p.id}`, change);
  }
  const after = (await get(`/projects/${p.id}`)).json().tasks[0];
  assert.equal(after.bucket, 'today', 'a focus change moved a task between buckets');
  assert.equal(after.dueDate, '2026-09-01', 'a status change cleared an explicit due date');
  assert.equal(after.status, 'open');
});

test('status: completion cannot be done through the ordinary update route', async () => {
  const { makeProject, patch } = await setup();
  const p = await makeProject();
  const r = await patch(`/projects/${p.id}`, { status: 'completed' });
  assert.equal(r.statusCode, 400, 'a project was completed without asking about open work');
});

/* ── Task assignment ─────────────────────────────────────────────────── */

test('assign: a task with no area adopts the project\'s', async () => {
  const { makeProject, makeTask, post, areaId } = await setup();
  const p = await makeProject();
  const t = await makeTask({ title: 'Unfiled' });
  assert.equal(t.areaId, null);
  const r = await post(`/projects/${p.id}/tasks`, { taskId: t.id });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().task.areaId, areaId);
  assert.equal(r.json().task.projectId, p.id);
});

test('assign: a differing area is never silently reclassified', async () => {
  const { makeProject, makeTask, post, areaId, otherAreaId } = await setup();
  const p = await makeProject();
  const t = await makeTask({ areaId: otherAreaId });

  const refused = await post(`/projects/${p.id}/tasks`, { taskId: t.id });
  assert.equal(refused.statusCode, 409, 'an explicit area was overwritten without asking');
  const detail = JSON.parse(refused.json().error.message);
  assert.equal(detail.reason, 'area_mismatch');
  assert.deepEqual(detail.choices, ['keep', 'move']);

  const kept = await post(`/projects/${p.id}/tasks`, { taskId: t.id, areaChoice: 'keep' });
  assert.equal(kept.json().task.areaId, otherAreaId, '"keep" changed the area anyway');
  assert.equal(kept.json().task.projectId, p.id);
});

test('assign: is idempotent, so a double click cannot duplicate anything', async () => {
  const { makeProject, makeTask, post, get } = await setup();
  const p = await makeProject();
  const t = await makeTask();
  await post(`/projects/${p.id}/tasks`, { taskId: t.id });
  const second = await post(`/projects/${p.id}/tasks`, { taskId: t.id });
  assert.equal(second.statusCode, 200);
  assert.equal((await get(`/projects/${p.id}`)).json().tasks.length, 1);
});

test('unassign: the task keeps everything except the relationship', async () => {
  const { makeProject, makeTask, post, del, get } = await setup();
  const p = await makeProject();
  const t = await makeTask({ bucket: 'week', dueDate: '2026-09-09', priority: 'high' });
  await post(`/projects/${p.id}/tasks`, { taskId: t.id });
  const r = await del(`/projects/${p.id}/tasks/${t.id}`);
  assert.equal(r.statusCode, 200);
  const task = r.json().task;
  assert.equal(task.projectId, null);
  assert.equal(task.bucket, 'week');
  assert.equal(task.dueDate, '2026-09-09');
  assert.equal(task.priority, 'high');
  assert.equal(task.id, t.id, 'unassigning created a different task record');
});

test('unassign: clears a next action that pointed at it', async () => {
  const { makeProject, makeTask, post, del } = await setup();
  const p = await makeProject();
  const t = await makeTask();
  await post(`/projects/${p.id}/tasks`, { taskId: t.id });
  await post(`/projects/${p.id}/next-action`, { taskId: t.id });
  const r = await del(`/projects/${p.id}/tasks/${t.id}`);
  assert.equal(r.json().project.nextTaskId, null,
    'the next action pointed at a task outside the project');
});

/* ── Next action ─────────────────────────────────────────────────────── */

test('next action: an override must be open and in this project', async () => {
  const { makeProject, makeTask, post } = await setup();
  const p = await makeProject();
  const outside = await makeTask({ title: 'Not in the project' });
  const bad = await post(`/projects/${p.id}/next-action`, { taskId: outside.id });
  assert.equal(bad.statusCode, 400);

  await post(`/projects/${p.id}/tasks`, { taskId: outside.id });
  const ok = await post(`/projects/${p.id}/next-action`, { taskId: outside.id });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().project.nextAction.explicit, true);
});

test('next action: completing the chosen task falls back cleanly', async () => {
  const { makeProject, makeTask, post, patch, get, app, ws } = await setup();
  const p = await makeProject();
  const a = await makeTask({ title: 'A' });
  const b = await makeTask({ title: 'B' });
  await post(`/projects/${p.id}/tasks`, { taskId: a.id });
  await post(`/projects/${p.id}/tasks`, { taskId: b.id });
  await post(`/projects/${p.id}/next-action`, { taskId: b.id });

  await app.inject({
    method: 'PATCH', url: `/api/v1/workspaces/${ws}/tasks/${b.id}`,
    headers: auth(), payload: { status: 'done' },
  });
  const after = (await get(`/projects/${p.id}`)).json().project;
  assert.equal(after.nextAction.id, a.id, 'the next action stayed on a completed task');
  assert.equal(after.nextAction.explicit, false);
  assert.equal(after.nextActionOverrideStale, true);
});

/* ── Area change ─────────────────────────────────────────────────────── */

test('area change: previews before it moves anything', async () => {
  const { makeProject, makeTask, post, get, areaId, otherAreaId } = await setup();
  const p = await makeProject();
  const inherited = await makeTask({ areaId });
  const explicit = await makeTask({ areaId: otherAreaId });
  await post(`/projects/${p.id}/tasks`, { taskId: inherited.id });
  await post(`/projects/${p.id}/tasks`, { taskId: explicit.id, areaChoice: 'keep' });

  const preview = (await get(`/projects/${p.id}/area-preview?areaId=${otherAreaId}`)).json();
  assert.equal(preview.total, 2);
  assert.equal(preview.inherited, 1);
  assert.equal(preview.differentlyClassified, 1);
});

test('area change: moves only what inherited, never an explicit choice', async () => {
  const { makeProject, makeTask, post, get, areaId, otherAreaId } = await setup();
  const p = await makeProject();
  const inherited = await makeTask({ areaId });
  const explicit = await makeTask({ areaId: otherAreaId });
  await post(`/projects/${p.id}/tasks`, { taskId: inherited.id });
  await post(`/projects/${p.id}/tasks`, { taskId: explicit.id, areaChoice: 'keep' });

  const r = await post(`/projects/${p.id}/area`, { areaId: otherAreaId, taskChoice: 'move_inherited' });
  assert.equal(r.json().tasksMoved, 1);
  const tasks = (await get(`/projects/${p.id}`)).json().tasks;
  assert.ok(tasks.every((t: any) => t.areaId === otherAreaId));

  // …and keep_all really keeps.
  const p2 = await makeProject({ title: 'Second' });
  const t2 = await makeTask({ areaId });
  await post(`/projects/${p2.id}/tasks`, { taskId: t2.id });
  const kept = await post(`/projects/${p2.id}/area`, { areaId: otherAreaId, taskChoice: 'keep_all' });
  assert.equal(kept.json().tasksMoved, 0);
  assert.equal((await get(`/projects/${p2.id}`)).json().tasks[0].areaId, areaId);
});

/* ── Completion ──────────────────────────────────────────────────────── */

test('completion: refuses to guess when work is still open', async () => {
  const { makeProject, makeTask, post, get } = await setup();
  const p = await makeProject();
  const t = await makeTask();
  await post(`/projects/${p.id}/tasks`, { taskId: t.id });

  const refused = await post(`/projects/${p.id}/complete`);
  assert.equal(refused.statusCode, 409);
  const detail = JSON.parse(refused.json().error.message);
  assert.equal(detail.reason, 'open_tasks');
  assert.equal(detail.openTasks, 1);
  // Nothing changed — a refused completion must not half-apply.
  const after = (await get(`/projects/${p.id}`)).json().project;
  assert.equal(after.status, p.status);
  assert.equal(after.completedAt, null);
});

test('completion: "leave" never fabricates finished work', async () => {
  const { makeProject, makeTask, post, get } = await setup();
  const p = await makeProject();
  const t = await makeTask({ dueDate: '2026-09-01' });
  await post(`/projects/${p.id}/tasks`, { taskId: t.id });

  const r = await post(`/projects/${p.id}/complete`, { openTasks: 'leave' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().tasksLeftOpen, 1);
  const after = (await get(`/projects/${p.id}`)).json();
  assert.equal(after.project.status, 'completed');
  assert.ok(after.project.completedAt);
  assert.equal(after.tasks[0].status, 'open', 'an unfinished task was marked done');
  assert.equal(after.tasks[0].dueDate, '2026-09-01');
  // A completed project no longer pushes work forward.
  assert.equal(after.project.surfacesAutomatically, false);
  assert.equal(after.project.nextTaskId, null);
});

test('completion: "cancel" uses cancellation, which is honest', async () => {
  const { makeProject, makeTask, post, get } = await setup();
  const p = await makeProject();
  for (const title of ['a', 'b']) {
    const t = await makeTask({ title });
    await post(`/projects/${p.id}/tasks`, { taskId: t.id });
  }
  const r = await post(`/projects/${p.id}/complete`, { openTasks: 'cancel' });
  assert.equal(r.json().tasksCancelled, 2);
  const after = (await get(`/projects/${p.id}`)).json();
  assert.ok(after.tasks.every((t: any) => t.status === 'cancelled'));
  // Cancelled work leaves the denominator, so the project reads as complete.
  assert.equal(after.project.progress.total, 0);
});

test('completion: with nothing open it just completes', async () => {
  const { makeProject, post } = await setup();
  const p = await makeProject();
  const r = await post(`/projects/${p.id}/complete`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().project.status, 'completed');
});

/* ── Archive ─────────────────────────────────────────────────────────── */

test('archive: keeps the lifecycle state and restores to it', async () => {
  const { makeProject, patch, post, get } = await setup();
  const p = await makeProject({ firstTask: { title: 'x' } });
  await patch(`/projects/${p.id}`, { status: 'on_hold' });

  const archived = (await post(`/projects/${p.id}/archive`)).json().project;
  assert.ok(archived.archivedAt);
  assert.equal(archived.preArchiveStatus, 'on_hold');
  assert.equal(archived.status, 'on_hold', 'archiving overwrote the lifecycle state');

  const restored = (await post(`/projects/${p.id}/restore`)).json().project;
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.status, 'on_hold', 'restore guessed instead of remembering');
  assert.equal(restored.preArchiveStatus, null);
});

test('archive: is idempotent, and an archived project refuses edits', async () => {
  const { makeProject, patch, post } = await setup();
  const p = await makeProject();
  await post(`/projects/${p.id}/archive`);
  const twice = await post(`/projects/${p.id}/archive`);
  assert.equal(twice.statusCode, 200, 'a double click on archive failed');
  assert.equal(twice.json().project.preArchiveStatus, 'planning',
    'the second archive overwrote the remembered status');

  const edit = await patch(`/projects/${p.id}`, { title: 'New name' });
  assert.equal(edit.statusCode, 409);
});

test('archive: never touches tasks', async () => {
  const { makeProject, makeTask, post, get } = await setup();
  const p = await makeProject();
  const t = await makeTask({ dueDate: '2026-09-01', bucket: 'today' });
  await post(`/projects/${p.id}/tasks`, { taskId: t.id });
  await post(`/projects/${p.id}/archive`);
  const after = (await get(`/projects/${p.id}`)).json().tasks[0];
  assert.equal(after.status, 'open');
  assert.equal(after.bucket, 'today');
  assert.equal(after.dueDate, '2026-09-01');
});

/* ── Concurrency and failure ─────────────────────────────────────────── */

test('concurrency: a stale write is rejected rather than silently winning', async () => {
  const { makeProject, patch, get } = await setup();
  const p = await makeProject();
  const stale = p.updatedAt;
  await patch(`/projects/${p.id}`, { title: 'Changed in another tab' });

  const r = await patch(`/projects/${p.id}`, { title: 'Changed here', expectedUpdatedAt: stale });
  assert.equal(r.statusCode, 409, 'the second tab silently overwrote the first');
  assert.match(r.json().error.message, /changed somewhere else/i);
  // And the first change survived.
  assert.equal((await get(`/projects/${p.id}`)).json().project.title, 'Changed in another tab');
});

test('failure: a missing or foreign project is 404, never an empty success', async () => {
  const a = await setup('a@example.com');
  const b = await setup('b@example.com');
  const mine = await b.makeProject();

  const missing = await a.get('/projects/00000000-0000-0000-0000-000000000000');
  assert.equal(missing.statusCode, 404);
  const foreign = await a.get(`/projects/${mine.id}`);
  assert.equal(foreign.statusCode, 404, 'a project leaked across workspaces');
});

test('failure: deleting a project keeps the work and reports how much', async () => {
  const { makeProject, makeTask, post, del, app, ws } = await setup();
  const p = await makeProject();
  const t = await makeTask();
  await post(`/projects/${p.id}/tasks`, { taskId: t.id });

  const r = await del(`/projects/${p.id}`);
  assert.equal(r.json().tasksKept, 1);
  const task = (await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks/${t.id}`, headers: auth(),
  })).json().task;
  assert.ok(task, 'deleting a project deleted work');
  assert.equal(task.projectId, null);
});

/* ── Safety ──────────────────────────────────────────────────────────── */

test('safety: E2 assigns no existing task to any project', async () => {
  // Nothing in the Project API runs on its own. A task acquires a project only
  // when someone assigns it.
  const { makeTask, get, app, ws } = await setup();
  await makeTask({ title: 'A' });
  await makeTask({ title: 'B' });
  const all = (await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth(),
  })).json().tasks;
  assert.equal(all.length, 2);
  assert.equal(all.filter((t: any) => t.projectId !== null).length, 0);
});

test('safety: there is no Legacy Projects migration endpoint', async () => {
  const { app, ws } = await setup();
  const r = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/import/legacy/projects/execute`,
    headers: auth(), payload: {},
  });
  assert.equal(r.statusCode, 404, 'a Projects migration shipped in E2');
});
