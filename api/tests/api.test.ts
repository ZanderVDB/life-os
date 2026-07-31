/**
 * End-to-end API tests through Fastify's inject() — real routes, real
 * validation, real database (PGlite). Auth uses DEV_AUTH_BYPASS, which
 * loadEnv() refuses to accept in staging/production.
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
  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(email) });
  const body = me.json();
  return { app, db, ws: body.workspace.id, areas: body.areas, me: body };
}
const json = (r: any) => r.json();

test('health and readiness', async () => {
  const { app } = await setup();
  const h = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(h.statusCode, 200);
  assert.equal(json(h).status, 'ok');

  const r = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(r.statusCode, 200);
  assert.equal(json(r).checks.database, 'ok');

  const v = await app.inject({ method: 'GET', url: '/health/version' });
  assert.ok(json(v).version);
});

test('unauthenticated requests are rejected', async () => {
  const { app, ws } = await setup();
  for (const url of ['/api/v1/me', `/api/v1/workspaces/${ws}/tasks`]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, url);
    assert.equal(json(res).error.code, 'UNAUTHORIZED');
  }
  const bad = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.statusCode, 401, 'a wrong token is not accepted');
});

test('GET /api/v1/me returns one workspace and the two default Areas', async () => {
  const { me } = await setup();
  assert.ok(me.user.id && me.user.email);
  assert.equal(me.workspace.kind, 'primary');
  assert.equal(me.workspace.role, 'owner');
  assert.deepEqual(me.areas.map((a: any) => a.name).sort(), ['Personal', 'Work']);
  assert.ok(!('workspaces' in me), 'no workspace LIST — there is no switcher');
});

test('workspace isolation — another user cannot touch my workspace', async () => {
  const { app, ws } = await setup('owner@example.com');
  const res = await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth('intruder@example.com'),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(json(res).error.code, 'FORBIDDEN');
});

test('task CRUD', async () => {
  const { app, ws, areas } = await setup();
  const work = areas.find((a: any) => a.name === 'Work');

  const created = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth(),
    payload: { title: 'Write the plan', bucket: 'today', priority: 'high', areaId: work.id, dueDate: '2026-08-15' },
  });
  assert.equal(created.statusCode, 201);
  const t = json(created).task;
  assert.equal(t.title, 'Write the plan');
  assert.equal(t.bucket, 'today');
  assert.equal(t.priority, 'high');
  assert.equal(t.dueDate, '2026-08-15', 'due dates actually save (the legacy bug)');
  assert.equal(t.areaId, work.id);
  assert.equal(t.projectId, null);

  const patched = await app.inject({
    method: 'PATCH', url: `/api/v1/workspaces/${ws}/tasks/${t.id}`, headers: auth(),
    payload: { title: 'Write the plan (v2)', notes: 'Some notes', dueDate: '2026-09-01' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(json(patched).task.title, 'Write the plan (v2)');
  assert.equal(json(patched).task.dueDate, '2026-09-01', 'due date survives an edit');

  const got = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${ws}/tasks/${t.id}`, headers: auth() });
  assert.equal(json(got).task.notes, 'Some notes');

  const del = await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${ws}/tasks/${t.id}`, headers: auth() });
  assert.equal(del.statusCode, 204);
  const after = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${ws}/tasks/${t.id}`, headers: auth() });
  assert.equal(after.statusCode, 404);
});

test('validation rejects bad input with field detail', async () => {
  const { app, ws } = await setup();
  const empty = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth(), payload: { title: '   ' },
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(json(empty).error.code, 'VALIDATION_FAILED');
  assert.ok(json(empty).error.details.length > 0);

  const badBucket = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth(),
    payload: { title: 'x', bucket: 'nope' },
  });
  assert.equal(badBucket.statusCode, 400);

  const badDate = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth(),
    payload: { title: 'x', dueDate: '15/08/2026' },
  });
  assert.equal(badDate.statusCode, 400);
});

test('completion round-trips', async () => {
  const { app, ws } = await setup();
  const t = json(await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth(), payload: { title: 'Finish me' },
  })).task;

  const done = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${t.id}/complete`, headers: auth(),
  });
  assert.equal(json(done).task.status, 'done');
  assert.ok(json(done).task.completedAt, 'completedAt is stamped');

  const undone = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${t.id}/uncomplete`, headers: auth(),
  });
  assert.equal(json(undone).task.status, 'open');
  assert.equal(json(undone).task.completedAt, null);

  // Completed tasks are RETAINED, not deleted (the legacy app dropped them).
  const list = json(await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth(),
  })).tasks;
  assert.equal(list.length, 1);
});

test('archive keeps the task but hides it from the default list', async () => {
  const { app, ws } = await setup();
  const t = json(await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth(), payload: { title: 'Archive me' },
  })).task;
  await app.inject({ method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${t.id}/archive`, headers: auth() });

  const def = json(await app.inject({ method: 'GET', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth() })).tasks;
  assert.equal(def.length, 0, 'hidden by default');
  const all = json(await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks?includeArchived=true`, headers: auth(),
  })).tasks;
  assert.equal(all.length, 1, 'but still there');
});

test('bucket movement and ordering — one endpoint for drag, menu, keyboard, touch', async () => {
  const { app, ws } = await setup();
  const mk = async (title: string, bucket = 'today') => json(await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth(), payload: { title, bucket },
  })).task;
  const a = await mk('A'), b = await mk('B'), c = await mk('C');

  const order = async (bucket: string) => {
    const rows = json(await app.inject({
      method: 'GET', url: `/api/v1/workspaces/${ws}/tasks?bucket=${bucket}`, headers: auth(),
    })).tasks;
    return rows.map((r: any) => r.title);
  };
  assert.deepEqual(await order('today'), ['A', 'B', 'C'], 'created in order');

  // Move C before A (what a keyboard "move to top" or a drag both send).
  const moved = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${c.id}/move`, headers: auth(),
    payload: { bucket: 'today', beforeTaskId: a.id },
  });
  assert.equal(moved.statusCode, 200);
  assert.deepEqual(await order('today'), ['C', 'A', 'B']);

  // Move A to the end of This Week (a bucket change).
  await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${a.id}/move`, headers: auth(),
    payload: { bucket: 'week' },
  });
  assert.deepEqual(await order('today'), ['C', 'B']);
  assert.deepEqual(await order('week'), ['A']);

  // afterTaskId works too.
  await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${b.id}/move`, headers: auth(),
    payload: { bucket: 'today', afterTaskId: c.id },
  });
  assert.deepEqual(await order('today'), ['C', 'B']);

  // Guard rails.
  const both = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${b.id}/move`, headers: auth(),
    payload: { bucket: 'today', beforeTaskId: c.id, afterTaskId: c.id },
  });
  assert.equal(both.statusCode, 400, 'before AND after is ambiguous');

  const wrongBucket = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${b.id}/move`, headers: auth(),
    payload: { bucket: 'month', beforeTaskId: c.id },
  });
  assert.equal(wrongBucket.statusCode, 400, 'anchor must be in the target bucket');
});

test('repeated moves to the top stay correctly ordered (fractional positions)', async () => {
  const { app, ws } = await setup();
  const mk = async (title: string) => json(await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth(), payload: { title },
  })).task;
  const first = await mk('1');
  const made = [first];
  for (let i = 2; i <= 6; i++) made.push(await mk(String(i)));

  // Move each new task to the very top, repeatedly — the classic way a naive
  // integer ordering scheme collapses.
  for (const t of made.slice(1)) {
    const head = json(await app.inject({
      method: 'GET', url: `/api/v1/workspaces/${ws}/tasks?bucket=today`, headers: auth(),
    })).tasks[0];
    await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${t.id}/move`, headers: auth(),
      payload: { bucket: 'today', beforeTaskId: head.id },
    });
  }
  const titles = json(await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks?bucket=today`, headers: auth(),
  })).tasks.map((t: any) => t.title);
  assert.deepEqual(titles, ['6', '5', '4', '3', '2', '1'], 'order never collapses');
});

test('task steps: add, rename, complete, delete', async () => {
  const { app, ws } = await setup();
  const t = json(await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth(), payload: { title: 'Parent' },
  })).task;

  const s1 = json(await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${t.id}/steps`, headers: auth(),
    payload: { title: 'Step one' },
  })).step;
  await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks/${t.id}/steps`, headers: auth(),
    payload: { title: 'Step two' },
  });

  // RENAME — the legacy model could only add and delete.
  const renamed = await app.inject({
    method: 'PATCH', url: `/api/v1/workspaces/${ws}/tasks/${t.id}/steps/${s1.id}`, headers: auth(),
    payload: { title: 'Step one (renamed)', completed: true },
  });
  assert.equal(json(renamed).step.title, 'Step one (renamed)');
  assert.equal(json(renamed).step.completed, true);

  const withSteps = json(await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks/${t.id}`, headers: auth(),
  })).task;
  assert.equal(withSteps.steps.length, 2);
  assert.deepEqual(withSteps.steps.map((s: any) => s.position), [0, 1]);

  const del = await app.inject({
    method: 'DELETE', url: `/api/v1/workspaces/${ws}/tasks/${t.id}/steps/${s1.id}`, headers: auth(),
  });
  assert.equal(del.statusCode, 204);
});

test('areas: create, duplicate rejection, and non-destructive removal', async () => {
  const { app, ws, areas } = await setup();
  const created = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/areas`, headers: auth(), payload: { name: 'Church' },
  });
  assert.equal(created.statusCode, 201);
  const church = json(created).area;

  for (const dupe of ['church', '  CHURCH  ', 'Church']) {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${ws}/areas`, headers: auth(), payload: { name: dupe },
    });
    assert.equal(res.statusCode, 409, `"${dupe}" must be rejected`);
  }

  const t = json(await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth(),
    payload: { title: 'Church task', areaId: church.id },
  })).task;

  const personal = areas.find((a: any) => a.name === 'Personal');
  const removed = await app.inject({
    method: 'DELETE', url: `/api/v1/workspaces/${ws}/areas/${church.id}?reassignToAreaId=${personal.id}`,
    headers: auth(),
  });
  assert.equal(json(removed).reassignedTasks, 1);

  const after = json(await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${ws}/tasks/${t.id}`, headers: auth(),
  })).task;
  assert.equal(after.areaId, personal.id, 'the task survived and was reassigned');
});

test('a task cannot be created in an Area from another workspace', async () => {
  const { app, ws } = await setup('owner@example.com');
  const other = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth('other@example.com') });
  const foreignArea = json(other).areas[0].id;
  const res = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks`, headers: auth('owner@example.com'),
    payload: { title: 'x', areaId: foreignArea },
  });
  assert.equal(res.statusCode, 400);
});

test('unknown endpoints return the standard error shape', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(json(res).error.code, 'NOT_FOUND');
  assert.ok(json(res).error.requestId, 'every error carries a request id');
});
