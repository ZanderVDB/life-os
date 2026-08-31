/**
 * The semantic relationship layer.
 *
 * Focused on the parts that are actually dangerous: a link that outlives the
 * thing it points at, a backlink that disagrees with its forward edge, an
 * unlink that takes an object with it, and the one COUPLED kind being handed
 * out to callers who have none of the machinery that makes coupling honest.
 *
 * Not a combinatorial matrix over every entity pair. The pairs are not where
 * the risk is — the rules are, and they are the same rules for every pair.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { calendars, calendarEvents } from '../src/db/schema.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import {
  ENTITY_TYPES, LINK_KINDS, isCoupled, isEntityType, isLinkKind,
} from '../src/lib/relationships.js';

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DEV_AUTH_BYPASS: TOKEN,
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
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({
      method: method as any, url: `/api/v1/workspaces/${ws}${url}`,
      headers: auth(email), payload: payload as any,
    });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  return { app, db, ws, call };
}

/** A project needs a title, an outcome, an area and a focus. */
async function newProject(call: Awaited<ReturnType<typeof setup>>['call'], title: string) {
  const areaId = (await call('GET', '/areas')).body.areas[0].id;
  const p = await call('POST', '/projects',
    { title, outcome: 'Everything handed over', areaId, focus: 'now' });
  assert.ok(p.body?.project, `project not created: ${p.status} ${JSON.stringify(p.body)}`);
  return p.body.project;
}

/** A task and a project, the cheapest pair of different types to make. */
async function pair(call: Awaited<ReturnType<typeof setup>>['call']) {
  const t = await call('POST', '/tasks', { title: 'Prepare the proposal' });
  assert.ok(t.body?.task, `task not created: ${t.status} ${JSON.stringify(t.body)}`);
  return { task: t.body.task, project: await newProject(call, 'Client handover') };
}

/* ── The vocabulary ──────────────────────────────────────────────────── */

test('links: the entity list is the active systems, and excludes what was never built', () => {
  /* `brain` and `board` were named in the original comment on `item_links` as
   * future targets. Neither system exists, and no row has ever carried either
   * value — checked across every write site before this pass. They are not
   * active types, so nothing can create one by accident. */
  assert.ok(!ENTITY_TYPES.includes('brain' as never), 'a retired type is linkable');
  assert.ok(!ENTITY_TYPES.includes('board' as never), 'a retired type is linkable');
  for (const t of ['task', 'project', 'area', 'habit', 'reminder',
    'event', 'block', 'library', 'book_page', 'diary']) {
    assert.ok(isEntityType(t), `${t} cannot take part in a relationship`);
  }
  assert.ok(!isEntityType('anything'), 'the type guard accepts nonsense');
});

test('links: every kind reads correctly from BOTH ends', () => {
  /* A backlink list showing "preparation for" on the side that was prepared
   * is simply wrong, and it is the failure a single stored row invites. */
  for (const [id, spec] of Object.entries(LINK_KINDS)) {
    assert.ok(spec.label && spec.inverse, `${id} has no phrasing for one end`);
    assert.ok(isLinkKind(id));
  }
  assert.ok(!isLinkKind('vibes'), 'the kind guard accepts nonsense');
  // Exactly ONE coupled kind. See docs/relationships.md §7.
  const coupled = Object.keys(LINK_KINDS).filter(isCoupled);
  assert.deepEqual(coupled, ['scheduled_as'], 'the set of coupled kinds changed');
});

/* ── Validation ──────────────────────────────────────────────────────── */

test('links: both ends must exist, and nothing may be related to itself', async () => {
  const { call } = await setup();
  const { task, project } = await pair(call);
  const ghost = '00000000-0000-0000-0000-000000000000';

  assert.equal((await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id, targetType: 'project', targetId: ghost, kind: 'related',
  })).status, 404, 'a link was made to something that does not exist');

  assert.equal((await call('POST', '/links', {
    sourceType: 'task', sourceId: ghost, targetType: 'project', targetId: project.id, kind: 'related',
  })).status, 404, 'a link was made from something that does not exist');

  assert.equal((await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id, targetType: 'task', targetId: task.id, kind: 'related',
  })).status, 400, 'something was related to itself');

  assert.equal((await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id, targetType: 'project', targetId: project.id, kind: 'vibes',
  })).status, 400, 'an invented relationship type was accepted');
});

test('links: the coupled kind cannot be asserted by a caller', async () => {
  /* `scheduled_as` means "these two records are the same work", and it moves a
   * task's time when its event moves. It is created by the scheduling flow,
   * which knows how to keep both sides honest. Handing it out here would let
   * anything claim coupling with none of that machinery. */
  const { call } = await setup();
  const { task, project } = await pair(call);
  const r = await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id,
    targetType: 'project', targetId: project.id, kind: 'scheduled_as',
  });
  assert.equal(r.status, 400, 'a caller created a coupled relationship');
});

test('links: the same edge twice is the same edge, not two', async () => {
  const { call } = await setup();
  const { task, project } = await pair(call);
  const body = {
    sourceType: 'task', sourceId: task.id,
    targetType: 'project', targetId: project.id, kind: 'related',
  };
  const first = await call('POST', '/links', body);
  const second = await call('POST', '/links', body);

  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);
  // 200, not 409: pressing link twice is the same intent stated twice.
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.equal(second.body.link.id, first.body.link.id, 'a duplicate row was created');
  assert.equal((await call('GET', `/links?type=task&id=${task.id}`)).body.count, 1);
});

/* ── Backlinks ───────────────────────────────────────────────────────── */

test('links: one row answers both directions, with the phrasing the right way round', async () => {
  const { call } = await setup();
  const { task, project } = await pair(call);
  await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id,
    targetType: 'project', targetId: project.id, kind: 'preparation',
  });

  const fromTask = (await call('GET', `/links?type=task&id=${task.id}`)).body;
  assert.equal(fromTask.outgoing.length, 1);
  assert.equal(fromTask.incoming.length, 0);
  assert.equal(fromTask.outgoing[0].label, 'Preparation for');
  assert.equal(fromTask.outgoing[0].entity.type, 'project');
  assert.equal(fromTask.outgoing[0].entity.title, 'Client handover');

  // The SAME row, seen from the other end. No second row exists.
  const fromProject = (await call('GET', `/links?type=project&id=${project.id}`)).body;
  assert.equal(fromProject.incoming.length, 1);
  assert.equal(fromProject.outgoing.length, 0);
  assert.equal(fromProject.incoming[0].label, 'Prepared by');
  assert.equal(fromProject.incoming[0].entity.title, 'Prepare the proposal');
  assert.equal(fromProject.incoming[0].id, fromTask.outgoing[0].id, 'these are different rows');
});

test('links: a summary is read live, never copied into the edge', async () => {
  /* A title stored on the edge is a title that goes stale the first time
   * somebody renames something, and it then disagrees with the object it
   * claims to describe on the object's own screen. */
  const { call } = await setup();
  const { task, project } = await pair(call);
  await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id,
    targetType: 'project', targetId: project.id, kind: 'related',
  });
  await call('PATCH', `/projects/${project.id}`, { title: 'Renamed entirely' });
  const after = (await call('GET', `/links?type=task&id=${task.id}`)).body;
  assert.equal(after.links[0].entity.title, 'Renamed entirely', 'the edge cached a title');
});

test('links: a timed thing carries its instant, not only a formatted string', async () => {
  /* The server cannot know what timezone the reader is in, so its formatted
   * subtitle is UTC. If that were the only thing sent, a Related row would
   * show a different hour from the Calendar row for the SAME event — the
   * same class of bug as caching a title, and harder to notice. */
  const { call, db, ws } = await setup();
  const { task } = await pair(call);
  const [cal] = await db.insert(calendars).values({
    workspaceId: ws, providerCalendarId: 'local:test', name: 'Test',
    accessRole: 'owner', isReadOnly: false, isSynthetic: true,
  }).returning();
  const startsAt = new Date('2026-09-02T10:00:00.000Z');
  const [event] = await db.insert(calendarEvents).values({
    workspaceId: ws, calendarId: cal!.id, title: 'Client call',
    isAllDay: false, startsAt, endsAt: new Date('2026-09-02T11:00:00.000Z'),
    syncState: 'local_only', isSynthetic: true,
  }).returning();

  await call('POST', '/links', {
    sourceType: 'event', sourceId: event!.id,
    targetType: 'task', targetId: task.id, kind: 'preparation',
  });
  const [row] = (await call('GET', `/links?type=task&id=${task.id}`)).body.links;
  assert.equal(row.entity.at, startsAt.toISOString(), 'the instant was not sent');
  assert.ok(row.entity.subtitle, 'no readable fallback was sent either');
});

/* ── Deletion ────────────────────────────────────────────────────────── */

test('links: unlinking removes the edge and NEITHER object', async () => {
  const { call } = await setup();
  const { task, project } = await pair(call);
  const made = (await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id,
    targetType: 'project', targetId: project.id, kind: 'resource',
  })).body;

  assert.equal((await call('DELETE', `/links/${made.link.id}`)).status, 200);
  assert.equal((await call('GET', `/links?type=task&id=${task.id}`)).body.count, 0);
  // Both still there. This is why unlink needs no confirmation.
  assert.equal((await call('GET', `/tasks/${task.id}`)).status, 200);
  assert.equal((await call('GET', `/projects/${project.id}`)).status, 200);
});

test('links: deleting an entity takes its edges with it and nothing else', async () => {
  /* `item_links` is polymorphic, so it has no foreign key to a task and
   * NOTHING in the database will tidy up after one. Without the explicit
   * cleanup this leaves rows pointing at an id that no longer resolves. */
  const { call } = await setup();
  const { task, project } = await pair(call);
  await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id,
    targetType: 'project', targetId: project.id, kind: 'related',
  });
  assert.equal((await call('GET', `/links?type=project&id=${project.id}`)).body.count, 1);

  await call('DELETE', `/tasks/${task.id}`);
  assert.equal((await call('GET', `/links?type=project&id=${project.id}`)).body.count, 0,
    'a dangling edge survived the task it pointed at');
  // The project is untouched: an edge must never cascade into an entity.
  assert.equal((await call('GET', `/projects/${project.id}`)).status, 200);
});

/* ── Search ──────────────────────────────────────────────────────────── */

test('links: search crosses types and excludes the thing doing the searching', async () => {
  const { call } = await setup();
  const { task, project } = await pair(call);
  await call('POST', '/tasks', { title: 'Client handover checklist' });

  const found = (await call('GET',
    `/links/search?q=handover&excludeType=project&excludeId=${project.id}`)).body;
  const types = new Set(found.results.map((r: { type: string }) => r.type));
  assert.ok(types.has('task'), 'a matching task was not offered');
  assert.ok(!found.results.some((r: { id: string }) => r.id === project.id),
    'the thing being linked FROM was offered as a thing to link TO');
  // Two letters is the floor; below it the answer is everything, which is no answer.
  assert.equal((await call('GET', '/links/search?q=h')).body.results.length, 0);
  void task;
});

/* ── The structural relationships this must not disturb ──────────────── */

test('links: a Project keeps its Book as a structural relationship', async () => {
  /* The primary Project Book is a row in `project_books`, not an edge. If a
   * future change expressed it as a link there would be two answers to "which
   * Book is this project's", and they would drift. */
  const { call } = await setup();
  const project = await newProject(call, 'With a book');
  const made = await call('POST', `/projects/${project.id}/book`, {});
  assert.equal(made.status < 300, true, 'a project could not be given a Book');

  const detail = (await call('GET', `/projects/${project.id}`)).body;
  assert.ok(detail.project.book?.bookId, 'the Book is not on the project');
  // …and it is NOT an item_link.
  assert.equal((await call('GET', `/links?type=project&id=${project.id}`)).body.count, 0,
    'the Project Book leaked into the semantic layer');
});
