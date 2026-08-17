/**
 * Today eligibility, and the Books a new account starts with.
 *
 * ── What "held back" means ─────────────────────────────────────────────
 *
 * A project you are not working on should stop sending work to Today. Putting
 * one on hold, filing it as someday or archiving it are explicit statements
 * that it is not now, and leaving its tasks on the board contradicts the
 * statement the moment it is made.
 *
 * Two rules keep that from being a trap, and both are asserted here:
 *
 *   NOTHING IS WRITTEN. The bucket, the date and the position are untouched.
 *   The product model's promise — a project change never moves a task — is not
 *   bent, because this is a read-time view and un-holding restores it exactly.
 *
 *   A COMMITMENT OUTRANKS THE PROJECT. A due date, a schedule, or being the
 *   project's next action all keep a task on the board. "A task that is due
 *   appears because it is due, whatever its project says" survives verbatim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { STARTER_BOOKS } from '../src/lib/starter-library.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const TOKEN = 'test-token';
const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused',
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
  const base = `/api/v1/workspaces/${me.workspace.id}`;
  return {
    me,
    post: (u: string, p?: any) => app.inject({ method: 'POST', url: base + u, headers: auth(), payload: p ?? {} }),
    patch: (u: string, p: any) => app.inject({ method: 'PATCH', url: base + u, headers: auth(), payload: p }),
    get: (u: string) => app.inject({ method: 'GET', url: base + u, headers: auth() }),
  };
}

async function aProject(h: any, over: any = {}) {
  const r = await h.post('/projects', {
    title: 'Garden', outcome: 'Done.', areaId: h.me.areas[0].id, focus: 'now', ...over,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().project;
}

async function aTaskOn(h: any, projectId: string, over: any = {}) {
  const made = await h.post('/tasks', { title: 'Buy gravel', bucket: 'today', ...over });
  assert.equal(made.statusCode, 201, made.body);
  const task = made.json().task ?? made.json();
  await h.post(`/projects/${projectId}/tasks`, { taskId: task.id });
  return task;
}

/* ── The board payload carries what the rule needs ────────────────────── */

test('the board is told each project state, so it can decide at read time', async () => {
  const h = await setup();
  const p = await aProject(h);
  await aTaskOn(h, p.id);
  await h.patch(`/projects/${p.id}`, { status: 'on_hold' });

  const board = (await h.get('/tasks?includeCompleted=false')).json();
  const shown = board.projects[p.id];
  assert.ok(shown, 'the board payload does not carry the project');
  assert.equal(shown.status, 'on_hold');
  assert.equal(shown.archived, false);
  assert.ok('focus' in shown && 'nextActionId' in shown);
});

test('holding a project does not move, redate or reposition its tasks', async () => {
  /* The line this whole feature must not cross. Suppression is a VIEW; if it
   * were a write, un-holding could not restore the board and the product
   * model's promise would be broken rather than honoured. */
  const h = await setup();
  const p = await aProject(h);
  const t = await aTaskOn(h, p.id, { dueDate: '2026-09-01' });

  const before = (await h.get('/tasks?includeCompleted=false')).json()
    .tasks.find((x: any) => x.id === t.id);

  for (const change of [{ status: 'on_hold' }, { focus: 'someday' }]) {
    await h.patch(`/projects/${p.id}`, change);
  }
  await h.post(`/projects/${p.id}/archive`, {});

  const after = (await h.get('/tasks?includeCompleted=false')).json()
    .tasks.find((x: any) => x.id === t.id);
  assert.equal(after.bucket, before.bucket);
  assert.equal(after.dueDate, before.dueDate);
  assert.equal(after.position, before.position);
  assert.equal(after.status, 'open');
  // Still on the board's task list — the CLIENT decides what to show.
  assert.ok(after, 'the task left the payload entirely');
});

test('an archived project is reported as archived', async () => {
  const h = await setup();
  const p = await aProject(h);
  await aTaskOn(h, p.id);
  await h.post(`/projects/${p.id}/archive`, {});
  const board = (await h.get('/tasks?includeCompleted=false')).json();
  assert.equal(board.projects[p.id].archived, true);
});

/* ── The rule itself ──────────────────────────────────────────────────── */

test('the rule holds back paused work and never a commitment', () => {
  /* Asserted against the source, because the rule lives in the client where
   * the board is drawn. What matters is that all three paused states are
   * covered and all three commitments override them. */
  const app = readFileSync(join(WEB, 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('export function heldBackBy('),
    app.indexOf('export const heldBackTasks'));

  for (const paused of ['p.archived', "p.status === 'on_hold'", "p.focus === 'someday'"]) {
    assert.ok(fn.includes(paused), `${paused} is not held back`);
  }
  assert.match(fn, /task\.dueDate \|\| task\.scheduledAt \|\| p\.nextActionId === task\.id/,
    'a commitment does not outrank the project');
  /* Completed is deliberately absent: completing a project asks explicitly
   * whether to leave its open tasks open, and hiding them seconds later would
   * answer the user's question for them. */
  assert.ok(!fn.includes("'completed'"), 'completed projects are being held back');
});

test('nothing disappears silently — the board says what it held back', () => {
  const app = readFileSync(join(WEB, 'app.js'), 'utf8');
  assert.match(app, /function heldNoticeHtml\(\)/);
  assert.match(app, /held back —/, 'the notice does not say what happened');
  assert.match(app, /id="held-toggle"/, 'there is no way to show them');
  // And the notice is rendered on the board, not tucked somewhere.
  assert.match(app, /\$\{heldNoticeHtml\(\)\}\s*\n\s*<div class="buckets">/);
});

/* ── Starter Books ────────────────────────────────────────────────────── */

test('a new account arrives with a Library that is not empty', async () => {
  const h = await setup();
  const items = (await h.get('/library/items')).json().items;
  const books = items.filter((i: any) => i.type === 'book');
  assert.equal(books.length, STARTER_BOOKS.length);
  assert.deepEqual(books.map((b: any) => b.title).sort(),
    STARTER_BOOKS.map((s) => s.title).sort());
});

test('every starter Book opens on a page that says what it is for', async () => {
  const h = await setup();
  const items = (await h.get('/library/items')).json().items;
  for (const item of items.filter((i: any) => i.type === 'book')) {
    const full = (await h.get(`/library/books/${item.book.id}`)).json();
    assert.equal(full.sections.length, 1, `${item.title} has no section`);
    assert.equal(full.sections[0].pages.length, 2, `${item.title} does not open on a spread`);
    const first = full.sections[0].pages[0];
    assert.ok(first.contentText.length > 40, `${item.title} opens on an empty page`);
    // The second page is blank — read on the left, write on the right.
    assert.equal(full.sections[0].pages[1].contentText, '');
    assert.equal(full.book.subtitle?.length > 0, true, `${item.title} has no subtitle`);
  }
});

test('starter Books are ordinary Books — nothing marks them as system', async () => {
  /* A preset you cannot rename, archive or delete is clutter with permission.
   * The Diary ledge is the app's ONLY system object and it is not a Book. */
  const h = await setup();
  const items = (await h.get('/library/items')).json().items;
  const book = items.find((i: any) => i.type === 'book');
  assert.equal(book.legacyId, null, 'a starter Book is tagged, so cleanup could sweep it');
  assert.equal(book.archivedAt, null);

  const archived = await h.post(`/library/items/${book.id}/archive`, {});
  assert.equal(archived.statusCode, 200, 'a starter Book cannot be archived');

  const renamed = await h.patch(`/library/books/${book.book.id}`, { title: 'Mine now' });
  assert.equal(renamed.statusCode, 200, 'a starter Book cannot be renamed');
});

test('the starter set is deliberately small', () => {
  /* Seven untouched covers on day one reads as the app promising what it has
   * not earned. If this grows, it should be because a Book earned its place. */
  assert.ok(STARTER_BOOKS.length <= 4, `${STARTER_BOOKS.length} starter Books is too many`);
  for (const s of STARTER_BOOKS) {
    assert.ok(s.opening.length > 60, `${s.title} does not explain itself`);
    assert.ok(!/^Nothing here/i.test(s.opening));
  }
});
