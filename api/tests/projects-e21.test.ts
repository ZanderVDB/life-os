/**
 * Phase E2.1 — grouping semantics and task ordering inside a project.
 *
 * Two defects from the authenticated review are pinned here: an on-hold project
 * focused Now appeared under "Now", and project tasks could not be reordered at
 * all. Both are API-level, so both are tested against a real database.
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

  const makeProject = async (over: any = {}) => {
    const r = await post('/projects', {
      title: 'A project', outcome: 'It is done', areaId, focus: 'now', ...over,
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().project;
  };
  const makeTask = async (over: any = {}) => {
    const r = await post('/tasks', { title: 'A task', ...over });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().task;
  };
  const inProject = async (projectId: string, titles: string[]) => {
    const ids: string[] = [];
    for (const title of titles) {
      const t = await makeTask({ title });
      await post(`/projects/${projectId}/tasks`, { taskId: t.id });
      ids.push(t.id);
    }
    return ids;
  };
  const titlesOf = (r: any) => r.json().tasks.map((t: any) => t.title);

  return { app, ws, areaId, post, patch, get, makeProject, makeTask, inProject, titlesOf };
}

/* ── Grouping ────────────────────────────────────────────────────────── */

test('grouping: status decides the lifecycle group, focus never overrides it', async () => {
  // The E2 defect: focus was checked before status, so an on-hold project
  // focused Now appeared under "Now" — contradicting the status just set.
  const { makeProject, patch, get } = await setup();
  const p = await makeProject({ title: 'Paused but wanted', focus: 'now', firstTask: { title: 'x' } });
  await patch(`/projects/${p.id}`, { status: 'on_hold' });

  const views = (await get('/projects')).json().views;
  const groupOf = (id: string) => views.working
    .find((g: any) => g.projects.some((x: any) => x.id === id))?.id;
  assert.equal(groupOf(p.id), 'on_hold', 'an on-hold project was listed under Now');

  // Stored exactly as chosen, and still suppressed from surfacing.
  const row = views.working.flatMap((g: any) => g.projects).find((x: any) => x.id === p.id);
  assert.equal(row.focus, 'now', 'the focus was rewritten to resolve the contradiction');
  assert.equal(row.status, 'on_hold');
  assert.equal(row.surfacesAutomatically, false);
});

test('grouping: every status and focus pair lands in exactly one group', async () => {
  const { post, patch, get, areaId } = await setup();
  const made: { id: string; status: string; focus: string }[] = [];
  for (const focus of ['now', 'upcoming', 'someday']) {
    for (const status of ['planning', 'active', 'on_hold']) {
      const r = await post('/projects', {
        title: `${status}/${focus}`, outcome: 'o', areaId, focus, firstTask: { title: 'work' },
      });
      const id = r.json().project.id;
      if (status !== 'active') await patch(`/projects/${id}`, { status });
      made.push({ id, status, focus });
    }
  }
  const views = (await get('/projects')).json().views;
  for (const [name, groups] of Object.entries(views) as [string, any[]][]) {
    const ids = groups.flatMap((g: any) => g.projects.map((x: any) => x.id));
    assert.equal(new Set(ids).size, ids.length, `a project appears twice in the ${name} view`);
  }
  const workingGroup = (id: string) => views.working
    .find((g: any) => g.projects.some((x: any) => x.id === id))?.id ?? null;
  for (const m of made) {
    const g = workingGroup(m.id);
    if (m.focus === 'someday') {
      assert.equal(g, null, `${m.status}/${m.focus} appeared in the Working view`);
    } else if (m.status === 'on_hold') {
      assert.equal(g, 'on_hold', `${m.status}/${m.focus} was not under On hold`);
    } else {
      assert.equal(g, m.focus, `${m.status}/${m.focus} was not under ${m.focus}`);
    }
  }
});

test('overview: one request carries every filter, so switching needs no round trip', async () => {
  // The filter flash was caused by awaiting a round trip before anything
  // correct could be rendered. Six views over a dozen projects costs nothing.
  const { makeProject, get } = await setup();
  await makeProject({ focus: 'someday', title: 'Later' });
  const r = (await get('/projects')).json();
  for (const f of ['working', 'planning', 'someday', 'on_hold', 'completed', 'archived']) {
    assert.ok(Array.isArray(r.views[f]), `the ${f} view is missing from the payload`);
  }
  assert.deepEqual(r.groups, r.views.working, '`groups` no longer answers for the requested filter');
});

/* ── Task ordering ───────────────────────────────────────────────────── */

test('order: tasks keep their own order inside a project', async () => {
  const { makeProject, inProject, post, get, titlesOf } = await setup();
  const p = await makeProject();
  const ids = await inProject(p.id, ['A', 'B', 'C']);
  assert.deepEqual((await get(`/projects/${p.id}`)).json().tasks.map((t: any) => t.title),
    ['A', 'B', 'C']);

  const r = await post(`/projects/${p.id}/tasks/${ids[2]}/reorder`, { to: 'top' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(titlesOf(r), ['C', 'A', 'B']);
  // Persisted, not merely returned.
  assert.deepEqual((await get(`/projects/${p.id}`)).json().tasks.map((t: any) => t.title),
    ['C', 'A', 'B']);
});

test('order: reordering never touches Today order or any task metadata', async () => {
  // project_position is a separate column from position precisely so that
  // dragging inside a project cannot reshuffle the Today board.
  const { makeProject, makeTask, post, app, ws, areaId } = await setup();
  const p = await makeProject();
  const a = await makeTask({ title: 'A', bucket: 'today', dueDate: '2026-09-01', priority: 'high', areaId });
  const b = await makeTask({ title: 'B', bucket: 'today' });
  await post(`/projects/${p.id}/tasks`, { taskId: a.id });
  await post(`/projects/${p.id}/tasks`, { taskId: b.id });
  const read = async () => (await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks/${a.id}`, headers: auth(),
  })).json().task;
  const before = await read();

  await post(`/projects/${p.id}/tasks/${b.id}/reorder`, { to: 'top' });

  const after = await read();
  assert.equal(after.position, before.position, 'a project reorder reshuffled the Today board');
  assert.equal(after.bucket, 'today');
  assert.equal(after.dueDate, '2026-09-01');
  assert.equal(after.priority, 'high');
  assert.equal(after.areaId, areaId);
  assert.equal(after.id, a.id, 'reordering created a different task record');
});

test('order: a neighbour outside the project is refused', async () => {
  // The only way a cross-project reorder could be expressed, so the only place
  // it has to be refused.
  const { makeProject, makeTask, post } = await setup();
  const p1 = await makeProject({ title: 'One' });
  const p2 = await makeProject({ title: 'Two' });
  const mine = await makeTask({ title: 'Mine' });
  const theirs = await makeTask({ title: 'Theirs' });
  await post(`/projects/${p1.id}/tasks`, { taskId: mine.id });
  await post(`/projects/${p2.id}/tasks`, { taskId: theirs.id });

  const foreignAnchor = await post(`/projects/${p1.id}/tasks/${mine.id}/reorder`,
    { beforeTaskId: theirs.id });
  assert.equal(foreignAnchor.statusCode, 400,
    'a task was ordered against a neighbour in another project');

  const wrongProject = await post(`/projects/${p2.id}/tasks/${mine.id}/reorder`, { to: 'top' });
  assert.equal(wrongProject.statusCode, 404,
    'a task was reordered inside a project it is not in');
});

test('order: up, down, top and bottom land where a person would expect', async () => {
  const { makeProject, inProject, post, titlesOf } = await setup();
  const p = await makeProject();
  const ids = await inProject(p.id, ['A', 'B', 'C', 'D']);

  let r = await post(`/projects/${p.id}/tasks/${ids[2]}/reorder`, { beforeTaskId: ids[1] });
  assert.deepEqual(titlesOf(r), ['A', 'C', 'B', 'D'], 'move up');
  r = await post(`/projects/${p.id}/tasks/${ids[0]}/reorder`, { afterTaskId: ids[2] });
  assert.deepEqual(titlesOf(r), ['C', 'A', 'B', 'D'], 'move down');
  r = await post(`/projects/${p.id}/tasks/${ids[0]}/reorder`, { to: 'bottom' });
  assert.deepEqual(titlesOf(r), ['C', 'B', 'D', 'A'], 'move to bottom');
  r = await post(`/projects/${p.id}/tasks/${ids[3]}/reorder`, { to: 'top' });
  assert.deepEqual(titlesOf(r), ['D', 'C', 'B', 'A'], 'move to top');
});

test('order: repeated moves stay distinct rather than collapsing together', async () => {
  // Sparse gaps get halved on every insertion between two neighbours. The order
  // has to survive that rather than two rows ending on the same number.
  const { makeProject, inProject, post, titlesOf } = await setup();
  const p = await makeProject();
  const ids = await inProject(p.id, ['A', 'B', 'C']);
  let last: string[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await post(`/projects/${p.id}/tasks/${ids[2]}/reorder`, { afterTaskId: ids[0] });
    last = titlesOf(r);
    assert.deepEqual(last, ['A', 'C', 'B'], `order collapsed on pass ${i}`);
    await post(`/projects/${p.id}/tasks/${ids[2]}/reorder`, { to: 'bottom' });
  }
});

test('order: position never outranks a due date or a priority for next action', async () => {
  // Moving a task to the top must not silently make it Next. The rule is due
  // date, then priority, then position — and it stays that way.
  const { makeProject, makeTask, post, get } = await setup();
  const p = await makeProject();
  const dated = await makeTask({ title: 'Dated', dueDate: '2026-08-20', priority: 'low' });
  const other = await makeTask({ title: 'Just moved up', priority: 'urgent' });
  await post(`/projects/${p.id}/tasks`, { taskId: dated.id });
  await post(`/projects/${p.id}/tasks`, { taskId: other.id });

  await post(`/projects/${p.id}/tasks/${other.id}/reorder`, { to: 'top' });
  const project = (await get(`/projects/${p.id}`)).json().project;
  assert.equal(project.nextAction.id, dated.id,
    'moving a task to the top overrode an earlier due date');
  assert.equal(project.nextAction.explicit, false);

  // …and an explicit choice still wins over both.
  await post(`/projects/${p.id}/next-action`, { taskId: other.id });
  const chosen = (await get(`/projects/${p.id}`)).json().project;
  assert.equal(chosen.nextAction.id, other.id);
  assert.equal(chosen.nextAction.explicit, true);
});

test('order: completed tasks keep their place without disturbing the open ones', async () => {
  const { makeProject, inProject, post, get, app, ws } = await setup();
  const p = await makeProject();
  const ids = await inProject(p.id, ['A', 'B', 'C']);
  await app.inject({
    method: 'PATCH', url: `/api/v1/workspaces/${ws}/tasks/${ids[1]}`,
    headers: auth(), payload: { status: 'done' },
  });
  const list = (await get(`/projects/${p.id}`)).json().tasks;
  const open = list.filter((t: any) => t.status === 'open').map((t: any) => t.title);
  assert.deepEqual(open, ['A', 'C'], 'completing a task disturbed the open order');
  assert.ok(list.some((t: any) => t.title === 'B' && t.status === 'done'));
});
