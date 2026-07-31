/**
 * Web contract tests.
 *
 * The Today shell in /web reads specific fields off specific endpoints. Those
 * reads are invisible to the TypeScript compiler — the web app is plain JS and
 * never imports a type from here. This file is the seam: if someone renames a
 * column or reshapes a response, these fail instead of the UI silently rendering
 * "undefined" in production.
 *
 * Every assertion below corresponds to a real line in web/app.js or web/import.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv, corsOrigins } from '../src/env.js';
import { EXPORT_FORMAT } from '../src/lib/legacy-import.js';

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
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as any, url, headers: auth(), payload: payload as any });
    return { status: r.statusCode, body: r.json() };
  };
  const post = async (url: string, payload?: unknown) => (await call('POST', url, payload)).body;
  const get = async (url: string) => (await call('GET', url)).body;
  return { app, me, ws: me.workspace.id, areas: me.areas, call, post, get };
}

test('web contract: /me exposes the fields the sidebar and greeting read', async () => {
  const { me } = await setup();
  // app.js: state.me.user.displayName / .email
  assert.ok('displayName' in me.user, 'user.displayName missing');
  assert.equal(typeof me.user.email, 'string');
  // app.js: ws() → state.me.workspace.id, used to build every task URL
  assert.equal(typeof me.workspace.id, 'string');
  // app.js: area filter chips + the Area <select> in the detail panel
  assert.ok(Array.isArray(me.areas) && me.areas.length > 0);
  for (const a of me.areas) {
    assert.equal(typeof a.id, 'string');
    assert.equal(typeof a.name, 'string');
  }
  // The shell renders no workspace switcher, so the payload must not offer a list.
  assert.equal(me.workspaces, undefined, 'v2 must not expose a workspace list');
});

test('web contract: /tasks returns every field the card and detail panel read', async () => {
  const { ws, areas, post, get } = await setup();
  const areaId = areas[0].id;
  const created = await post(`/api/v1/workspaces/${ws}/tasks`, {
    title: 'Contract task', bucket: 'week', priority: 'urgent',
    dueDate: '2026-08-14', notes: 'some notes', areaId,
  });
  await post(`/api/v1/workspaces/${ws}/tasks/${created.task.id}/steps`, { title: 'Step one' });

  const { tasks } = await get(`/api/v1/workspaces/${ws}/tasks`);
  const t = tasks.find((x: any) => x.id === created.task.id);
  assert.ok(t, 'created task not returned by the list endpoint');

  // taskHtml() reads exactly these.
  assert.equal(typeof t.id, 'string');
  assert.equal(t.title, 'Contract task');
  assert.equal(t.bucket, 'week');              // inBucket()
  assert.equal(typeof t.position, 'number');   // sort comparator
  assert.equal(t.priority, 'urgent');          // .p-${t.priority} class
  assert.equal(t.status, 'open');              // .done class + tick aria-label
  assert.equal(t.areaId, areaId);              // areaName() lookup
  assert.equal(t.notes, 'some notes');         // detail panel textarea

  // fmtDate() does `new Date(t.dueDate + 'T12:00:00')`, so this MUST be a bare
  // 'YYYY-MM-DD' string. A Date object or full ISO timestamp renders wrong.
  assert.equal(typeof t.dueDate, 'string');
  assert.match(t.dueDate, /^\d{4}-\d{2}-\d{2}$/);

  // steps[] drives the "n/m steps" badge and the detail list.
  assert.ok(Array.isArray(t.steps));
  assert.equal(t.steps.length, 1);
  assert.equal(typeof t.steps[0].id, 'string');
  assert.equal(t.steps[0].title, 'Step one');
  assert.equal(t.steps[0].completed, false);
});

test('web contract: the bucket and priority lists hard-coded in the shell are all accepted', async () => {
  const { ws, post } = await setup();
  // web/app.js declares these as literal arrays. Drift means the detail panel
  // offers an option the API answers with a 400.
  for (const bucket of ['today', 'week', 'month', 'future']) {
    const r = await post(`/api/v1/workspaces/${ws}/tasks`, { title: `b-${bucket}`, bucket });
    assert.equal(r.task.bucket, bucket, `bucket '${bucket}' was rejected`);
  }
  for (const priority of ['urgent', 'high', 'medium', 'low', 'someday']) {
    const r = await post(`/api/v1/workspaces/${ws}/tasks`, { title: `p-${priority}`, priority });
    assert.equal(r.task.priority, priority, `priority '${priority}' was rejected`);
  }
});

test('web contract: all four movement paths resolve to one endpoint', async () => {
  const { ws, post } = await setup();
  // Drag-drop, the Move menu, Alt+Arrow and shiftBucket() all call moveTask(),
  // which posts here. Confirm each anchor shape the shell actually sends.
  const a = (await post(`/api/v1/workspaces/${ws}/tasks`, { title: 'mv-a', bucket: 'today' })).task;
  const b = (await post(`/api/v1/workspaces/${ws}/tasks`, { title: 'mv-b', bucket: 'today' })).task;

  // bucket only — Move menu and Alt+Left/Right
  const r1 = await post(`/api/v1/workspaces/${ws}/tasks/${a.id}/move`, { bucket: 'month' });
  assert.equal(r1.task.bucket, 'month');
  // beforeTaskId — dropping above a card, "Move to top", Alt+Up
  const r2 = await post(`/api/v1/workspaces/${ws}/tasks/${a.id}/move`, { bucket: 'today', beforeTaskId: b.id });
  assert.ok(r2.task.position < b.position, 'beforeTaskId did not order above');
  // afterTaskId — "Move to bottom", Alt+Down
  const r3 = await post(`/api/v1/workspaces/${ws}/tasks/${a.id}/move`, { bucket: 'today', afterTaskId: b.id });
  assert.ok(r3.task.position > b.position, 'afterTaskId did not order below');
});

test('web contract: action endpoints accept an empty body with a JSON content-type', async () => {
  const { app, ws, post } = await setup();
  // Browsers hit this constantly: a fetch wrapper sets a default JSON header,
  // but /complete and /archive take no body. Fastify's stock parser answers 400
  // before routing, which silently broke completion in the shell.
  const t = (await post(`/api/v1/workspaces/${ws}/tasks`, { title: 'empty-body' })).task;

  for (const action of ['complete', 'uncomplete', 'archive']) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ws}/tasks/${t.id}/${action}`,
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: '',
    });
    assert.equal(res.statusCode, 200, `${action} rejected an empty JSON body: ${res.body}`);
  }

  // Malformed JSON must still be a clean 400, not a 500.
  const bad = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/tasks`,
    headers: { ...auth(), 'content-type': 'application/json' }, payload: '{nope',
  });
  assert.equal(bad.statusCode, 400);
});

test('web contract: the error shape the toast reads is always present', async () => {
  const { ws, call } = await setup();
  // run() surfaces e.message, built from data.error.message. A different shape
  // shows a bare "Request failed (400)" with no explanation of what went wrong.
  const res = await call('POST', `/api/v1/workspaces/${ws}/tasks`, { title: '' });
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error?.message, 'string');
  assert.ok(res.body.error.message.length > 0);
});

test('web contract: import preview returns counts only, and leaks no text to the page', async () => {
  const { ws, post } = await setup();
  const exportFile = {
    exportFormat: EXPORT_FORMAT, exportVersion: 1, appVersion: 'v242',
    createdAt: '2026-07-31T01:08:00.000Z', userId: 'uid', activeProfileId: 'main',
    // Business is listed FIRST on purpose — the chooser must pick by name, not position.
    profiles: [
      { id: 'p_biz', name: 'Business', mode: 'business' },
      { id: 'main', name: 'Personal', mode: 'personal' },
    ],
    documentCount: 2,
    documents: {
      p_biz: { data: { tasks: [{ id: 'b1', text: 'SECRET BUSINESS', done: false, bucket: 'today' }] } },
      main: {
        data: {
          workProjects: [{ id: 'health', name: 'Health', color: 'sage', order: 1 }],
          tasks: [
            { id: 'p1', text: 'Personal one', done: false, bucket: 'today', project: 'health' },
            { id: 'p2', text: 'Personal two', done: false, bucket: 'week',
              steps: [{ id: 's1', text: 'A step', done: false }] },
          ],
          reminders: [{ id: 'r1', text: 'a reminder' }],
        },
      },
    },
    verification: { ok: true },
  };
  const r = await post(`/api/v1/workspaces/${ws}/import/legacy/preview`, { export: exportFile });
  const p = r.preview;

  assert.equal(r.wouldWrite, false);
  // Every field below is read by render() in web/import.js.
  assert.equal(typeof p.ok, 'boolean');
  assert.ok(Array.isArray(p.errors) && Array.isArray(p.warnings));   // Problems table
  assert.equal(typeof p.source, 'object');                           // Source table
  for (const k of ['format', 'exportVersion', 'appVersion', 'createdAt', 'verified', 'verificationStatus']) {
    assert.ok(k in p.source, `source.${k} missing`);
  }
  // import.js renders profileChosen.name, falling back to .id — both must exist.
  assert.equal(p.profileChosen.name, 'Personal');
  assert.equal(p.profileChosen.id, 'main');
  assert.ok(Array.isArray(p.profilesIgnored));                       // "Profiles ignored" row
  assert.equal(p.profilesIgnored[0].name, 'Business');
  assert.equal(typeof p.areas.total, 'number');                      // stat tiles
  assert.equal(typeof p.areas.mappedToDefaults, 'number');
  assert.equal(typeof p.tasks.total, 'number');
  assert.equal(typeof p.tasks.completed, 'number');
  assert.equal(typeof p.tasks.withDueDate, 'number');
  assert.equal(typeof p.tasks.withUnparseableTime, 'number');
  assert.equal(typeof p.steps, 'number');                            // NOTE: a number, not an object
  assert.equal(typeof p.tasks.byBucket, 'object');                   // by-bucket table
  assert.equal(typeof p.tasks.byPriority, 'object');                 // by-priority table
  assert.ok(Array.isArray(p.tasks.skipped));                         // Skipped table: [{reason,count}]
  assert.ok(Array.isArray(p.excluded));                              // Excluded table: [{collection,count,reason}]

  // import.js renders this whole object. If task text were in it, that text
  // would be printed on screen — so assert the serialised payload is clean.
  const asText = JSON.stringify(p);
  assert.ok(!asText.includes('SECRET BUSINESS'), 'Business text leaked into the preview');
  assert.ok(!asText.includes('Personal one'), 'task text leaked into the preview');
  assert.ok(!asText.includes('Personal two'), 'task text leaked into the preview');
});

/* ── CORS: staging must answer preflight for the exact origin only ───── */

test('cors: preflight succeeds for an allowed origin and is refused for others', async () => {
  const { db } = await freshDb();
  const corsEnv = loadEnv({
    NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://unused/unused',
    FIREBASE_PROJECT_ID: 'test-project',
    CORS_ALLOWED_ORIGINS: 'https://life-os-v2-web-staging.up.railway.app,http://localhost:5173',
    DEV_AUTH_BYPASS: TOKEN,
  } as any);
  const app = buildApp(db, corsEnv);
  await app.ready();

  const allowed = 'https://life-os-v2-web-staging.up.railway.app';
  const pre = await app.inject({
    method: 'OPTIONS', url: '/api/v1/me',
    headers: { origin: allowed, 'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization' },
  });
  assert.ok(pre.statusCode < 300, `preflight failed: ${pre.statusCode}`);
  assert.equal(pre.headers['access-control-allow-origin'], allowed);

  // An origin that is not on the list must not be echoed back.
  const foreign = await app.inject({
    method: 'OPTIONS', url: '/api/v1/me',
    headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
  });
  assert.notEqual(foreign.headers['access-control-allow-origin'], 'https://evil.example.com');
  assert.notEqual(foreign.headers['access-control-allow-origin'], '*');

  // An authenticated GET from the allowed origin still carries the header.
  const real = await app.inject({ method: 'GET', url: '/api/v1/me',
    headers: { ...auth(), origin: allowed } });
  assert.equal(real.statusCode, 200);
  assert.equal(real.headers['access-control-allow-origin'], allowed);
});

test('cors: a wildcard origin is refused at boot, not silently honoured', () => {
  assert.throws(() => loadEnv({
    NODE_ENV: 'staging', PORT: '8080', LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://unused/unused',
    FIREBASE_PROJECT_ID: 'p', CORS_ALLOWED_ORIGINS: '*',
  } as any) && corsOrigins(loadEnv({
    NODE_ENV: 'staging', PORT: '8080', LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://unused/unused',
    FIREBASE_PROJECT_ID: 'p', CORS_ALLOWED_ORIGINS: '*',
  } as any)), /must not contain/);
});

test('env: DEV_AUTH_BYPASS cannot be set in staging or production', () => {
  for (const NODE_ENV of ['staging', 'production']) {
    assert.throws(() => loadEnv({
      NODE_ENV, PORT: '8080', LOG_LEVEL: 'info',
      DATABASE_URL: 'postgresql://unused/unused',
      FIREBASE_PROJECT_ID: 'p', CORS_ALLOWED_ORIGINS: 'https://x.example',
      DEV_AUTH_BYPASS: 'anything',
    } as any), /DEV_AUTH_BYPASS/, `${NODE_ENV} accepted a bypass token`);
  }
});

/* ── Database connection: Railway hands out two URLs, not one ────────── */

test('db: TLS is chosen correctly for each Railway connection URL shape', async () => {
  const { sslModeFor } = await import('../src/db/client.js');

  // Public TCP proxy — crosses the internet, so TLS is mandatory.
  assert.equal(sslModeFor('postgresql://u:p@viaduct.proxy.rlwy.net:41234/railway'), 'require');
  assert.equal(sslModeFor('postgresql://u:p@containers-us-west-1.railway.app:7432/railway'), 'require');

  // Private network — Railway's internal Postgres does not serve TLS, so
  // forcing it here would simply fail to connect.
  assert.equal(sslModeFor('postgresql://u:p@postgres.railway.internal:5432/railway'), false);

  // Local development.
  assert.equal(sslModeFor('postgresql://u:p@localhost:5432/life_os_v2'), false);
  assert.equal(sslModeFor('postgresql://u:p@127.0.0.1:5432/life_os_v2'), false);
  assert.equal(sslModeFor('postgresql://pglite/in-memory'), false);

  // An explicit sslmode in the URL always wins, so this is overridable from
  // Railway without a code change.
  assert.equal(sslModeFor('postgresql://u:p@postgres.railway.internal:5432/r?sslmode=require'), 'require');
  assert.equal(sslModeFor('postgresql://u:p@viaduct.proxy.rlwy.net:41234/r?sslmode=disable'), false);

  // An unknown host defaults to requiring TLS — the safe direction to fail.
  assert.equal(sslModeFor('postgresql://u:p@db.somewhere-else.com:5432/x'), 'require');
});

test('cors: every method the web client uses is allowed at preflight', async () => {
  // A missing verb here fails only in a real browser, at the preflight — which
  // is exactly how PUT /preferences shipped broken. Assert the whole set.
  const { db } = await freshDb();
  const app = buildApp(db, loadEnv({
    NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
    CORS_ALLOWED_ORIGINS: 'https://web.example', DEV_AUTH_BYPASS: TOKEN,
  } as any));
  await app.ready();

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await app.inject({
      method: 'OPTIONS', url: '/api/v1/preferences',
      headers: { origin: 'https://web.example', 'access-control-request-method': method },
    });
    const allowed = String(res.headers['access-control-allow-methods'] ?? '');
    assert.ok(allowed.includes(method), `${method} is not in access-control-allow-methods`);
  }
});

test('preferences: allow-listed keys only, and values are validated', async () => {
  const { call } = await setup();
  const initial = (await call('GET', '/api/v1/preferences')).body;
  assert.equal(initial.preferences.appearance, 'system');
  assert.ok(Array.isArray(initial.deviceScoped), 'device-scoped keys are declared');

  const ok = await call('PUT', '/api/v1/preferences', { reducedMotion: 'always' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.preferences.reducedMotion, 'always');
  // Persisted, not just echoed.
  assert.equal((await call('GET', '/api/v1/preferences')).body.preferences.reducedMotion, 'always');
  // Other keys keep their defaults.
  assert.equal((await call('GET', '/api/v1/preferences')).body.preferences.sounds, 'off');

  // An unknown key must be refused rather than quietly stored.
  assert.equal((await call('PUT', '/api/v1/preferences', { somethingElse: 'x' })).status, 400);
  // An invalid value for a known key must be refused too.
  assert.equal((await call('PUT', '/api/v1/preferences', { appearance: 'neon' })).status, 400);

  // Writing twice updates in place rather than creating a second row.
  await call('PUT', '/api/v1/preferences', { reducedMotion: 'system' });
  assert.equal((await call('GET', '/api/v1/preferences')).body.preferences.reducedMotion, 'system');
});
