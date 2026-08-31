/**
 * The closure pass: every linkable thing is inspectable, and an event link
 * lands on the exact event.
 *
 * The rule these hold down is one sentence: IF AN ENTITY CAN TAKE PART IN A
 * RELATIONSHIP, A PERSON MUST BE ABLE TO DISCOVER THAT RELATIONSHIP FROM THAT
 * ENTITY. A graph that is bidirectional in the database and one-directional on
 * screen is not bidirectional to the person using it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { calendars, calendarEvents } from '../src/db/schema.js';
import { ENTITY_TYPES, isEntityType } from '../src/lib/relationships.js';

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = { authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'zander@example.com' };

async function setup() {
  const { db } = await freshDb();
  const app = buildApp(db, env);
  await app.ready();
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth })).json();
  const ws = me.workspace.id;
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({
      method: method as any, url: `/api/v1/workspaces/${ws}${url}`, headers: auth,
      payload: payload as any,
    });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  return { app, db, ws, call, areaId: me.areas[0].id };
}

/** A writable local calendar, so events can exist without Google. */
async function localCalendar(db: any, ws: string) {
  const [cal] = await db.insert(calendars).values({
    workspaceId: ws, providerCalendarId: `local:${ws}`, name: 'Life OS',
    accessRole: 'owner', isReadOnly: false, isSynthetic: true,
  }).returning();
  return cal;
}

/* ══ 1. Every linkable type is inspectable ══════════════════════════════ */

const WEB = join('..', 'web');
const webSource = ['app.js', 'related.js', 'task-modal.js', 'projects.js', 'habit-modal.js',
  'reminder-modal.js', 'area-modal.js', 'event-modal.js', 'detail-sheet.js',
  'diary-entry.js', 'library-book.js', 'library-view.js']
  .map((f) => readFileSync(join(WEB, f), 'utf8')).join('\n');

test('surfaces: every linkable type has somewhere its relationships are shown', () => {
  /* A `data-rel-host="<type>:…"` IS the contract: it is the only way a Related
   * section reaches a screen, and app.js mounts every one it finds. So the
   * presence of a host per type is exactly the claim being made, checked
   * against the source rather than against a list kept by hand.
   *
   * Adding an entity type without a surface fails here, which is the point —
   * that is the state this pass existed to get out of. */
  const missing = ENTITY_TYPES.filter(
    (t) => !webSource.includes(`data-rel-host="${t}:`),
  );
  assert.deepEqual(missing, [], `linkable with nowhere to look: ${missing.join(', ')}`);
});

test('surfaces: the block decision is recorded in the docs, not only in the code', () => {
  const doc = readFileSync(join('..', 'docs', 'relationships.md'), 'utf8');
  assert.ok(!isEntityType('block'), 'block is linkable again');
  assert.ok(/schedule block/i.test(doc), 'the block decision is undocumented');
});

test('surfaces: following an event link opens ONE dialog, not two', () => {
  /* Following a link writes the hash and calls `go('calendar')`. The resulting
   * `hashchange` lands while `go` is still awaiting, sees an event id it does
   * not recognise and starts a second render; both then resolved the same
   * event and both opened it, stacking two identical dialogs.
   *
   * The fix is an ordering: record the id BEFORE the await, so the second
   * render finds it claimed. A regression here is invisible in every unit of
   * behaviour and obvious the moment a person follows a link. */
  const app = readFileSync(join(WEB, 'app.js'), 'utf8');
  const at = app.search(/cal\.linkedEvent = \{ id: wantEvent, event: null \};/);
  assert.ok(at > -1, 'the linked event is no longer claimed before resolving');
  const resolveAt = app.search(/await resolveLinkedEvent\(wantEvent\)/);
  assert.ok(resolveAt > at, 'the claim moved after the await it exists to precede');
});

test('surfaces: a reminder sheet hands its own list to Edit', () => {
  /* The Reminders view passes its list in because a reminder due in three
   * months is not inside the calendar's loaded range. Dropping it on the way
   * to `editReminder` meant Edit silently did nothing for exactly those. */
  const app = readFileSync(join(WEB, 'app.js'), 'utf8');
  assert.match(app, /onClick: \(\) => editReminder\(id, from\)/,
    'the reminder sheet drops its list before opening the editor');
});

/* ══ 2. A reminder is a first-class end of a relationship ═══════════════ */

test('reminders: relationships work from the reminder end, both directions', async () => {
  const { call, areaId } = await setup();
  const rem = (await call('POST', '/reminders',
    { title: 'Renew the domain', dueDate: '2026-09-30' })).body.reminder;
  const task = (await call('POST', '/tasks', { title: 'Find the registrar login' })).body.task;
  const project = (await call('POST', '/projects',
    { title: 'WebAnchor handover', outcome: 'Handed over', areaId, focus: 'now' })).body.project;

  // Outgoing FROM the reminder…
  assert.equal((await call('POST', '/links', {
    sourceType: 'reminder', sourceId: rem.id,
    targetType: 'project', targetId: project.id, kind: 'deadline',
  })).status, 201);
  // …and incoming TO it, from something else entirely.
  assert.equal((await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id,
    targetType: 'reminder', targetId: rem.id, kind: 'preparation',
  })).status, 201);

  const seen = (await call('GET', `/links?type=reminder&id=${rem.id}`)).body;
  assert.equal(seen.count, 2, 'a reminder cannot see both sides of its own graph');
  assert.equal(seen.outgoing.length, 1);
  assert.equal(seen.incoming.length, 1);
  assert.equal(seen.outgoing[0].label, 'Deadline for');
  assert.equal(seen.incoming[0].label, 'Prepared by');
  // Two DIFFERENT types at the far end — what the surface has to render.
  assert.deepEqual(
    seen.links.map((l: { entity: { type: string } }) => l.entity.type).sort(),
    ['project', 'task'],
  );
  // And it can be followed: a reminder link says how to open the reminder.
  const fromTask = (await call('GET', `/links?type=task&id=${task.id}`)).body;
  assert.equal(fromTask.links[0].entity.open?.kind, 'reminder');
});

test('reminders: deleting one takes its edges and leaves the other objects', async () => {
  const { call } = await setup();
  const rem = (await call('POST', '/reminders',
    { title: 'Renew the domain', dueDate: '2026-09-30' })).body.reminder;
  const task = (await call('POST', '/tasks', { title: 'Find the registrar login' })).body.task;
  await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id,
    targetType: 'reminder', targetId: rem.id, kind: 'related',
  });
  await call('DELETE', `/reminders/${rem.id}`);
  assert.equal((await call('GET', `/links?type=task&id=${task.id}`)).body.count, 0,
    'a dangling edge survived the reminder it pointed at');
  assert.equal((await call('GET', `/tasks/${task.id}`)).status, 200);
});

/* ══ 3. An Area and a Library item can be inspected too ═════════════════ */

test('areas and library items answer for their own relationships', async () => {
  const { call, areaId } = await setup();
  const task = (await call('POST', '/tasks', { title: 'Book the venue' })).body.task;
  const item = (await call('POST', '/library/items',
    { type: 'link', title: 'Venue price list', sourceUrl: 'https://example.com/prices' })).body.item;

  await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id, targetType: 'area', targetId: areaId, kind: 'related',
  });
  await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id, targetType: 'library', targetId: item.id, kind: 'resource',
  });

  const area = (await call('GET', `/links?type=area&id=${areaId}`)).body;
  assert.equal(area.count, 1);
  assert.equal(area.incoming[0].entity.title, 'Book the venue');

  const back = (await call('GET', `/links?type=task&id=${task.id}`)).body;
  // An area has no page of its own, so it says how to be OPENED instead.
  const areaRow = back.links.find((l: { entity: { type: string } }) => l.entity.type === 'area');
  assert.equal(areaRow.entity.open?.kind, 'area');

  const lib = (await call('GET', `/links?type=library&id=${item.id}`)).body;
  assert.equal(lib.count, 1);
  assert.equal(lib.incoming[0].label, 'Used by');
  // A non-book item has its own page; the shelf is not a destination.
  const libRow = back.links.find((l: { entity: { type: string } }) => l.entity.type === 'library');
  assert.equal(libRow.entity.href, `#library/item/${item.id}`);
});

test('a Book link addresses the BOOK, not the library item id', async () => {
  /* `#library/book/<libraryItemId>` resolves to nothing — the route takes the
   * `library_books` id. Sending the wrong one is a link that opens an error. */
  const { call } = await setup();
  const made = (await call('POST', '/library/books', { title: 'Field notes' })).body;
  const itemId = made.item.id;
  const bookId = made.book.id;
  assert.notEqual(itemId, bookId, 'the fixture cannot tell the two ids apart');

  const task = (await call('POST', '/tasks', { title: 'Read the field notes' })).body.task;
  await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id, targetType: 'library', targetId: itemId, kind: 'resource',
  });
  const row = (await call('GET', `/links?type=task&id=${task.id}`)).body.links[0];
  assert.equal(row.entity.href, `#library/book/${bookId}`);
});

/* ══ 4. The exact event ═════════════════════════════════════════════════ */

test('an event link resolves to that exact event, with the day to open', async () => {
  const { call, db, ws } = await setup();
  const cal = await localCalendar(db, ws);
  const [ev] = await db.insert(calendarEvents).values({
    workspaceId: ws, calendarId: cal.id, title: 'Client call — Trifusion',
    isAllDay: false,
    startsAt: new Date('2026-09-02T10:00:00.000Z'),
    endsAt: new Date('2026-09-02T11:00:00.000Z'),
    syncState: 'local_only', isSynthetic: true,
  }).returning();

  const r = await call('GET', `/calendar/events/${ev!.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.event.id, ev!.id);
  assert.equal(r.body.event.title, 'Client call — Trifusion');
  assert.equal(r.body.day, '2026-09-02', 'no day to move the calendar to');
  // Enough to render without a second request.
  assert.equal(r.body.event.calendarName, 'Life OS');
  assert.equal(r.body.event.calendarReadOnly, false);
  assert.equal(r.body.occurrence, null, 'a one-off event claimed to be a series');
});

test('a recurring occurrence resolves to ITSELF, never to its series', async () => {
  /* Google is polled with singleEvents:true, so a series arrives already
   * expanded and each occurrence is its own row with its own provider id. Two
   * occurrences of one weekly meeting share a title and a series id and differ
   * only by start — which is exactly why identity must be the local row and
   * never a title-and-date lookup. */
  const { call, db, ws } = await setup();
  const cal = await localCalendar(db, ws);
  const series = 'abc123series';
  const rows = await db.insert(calendarEvents).values([
    {
      workspaceId: ws, calendarId: cal.id, title: 'Weekly sync',
      providerEventId: `${series}_20260902T100000Z`, recurringEventId: series,
      originalStartTime: new Date('2026-09-02T10:00:00.000Z'),
      isAllDay: false,
      startsAt: new Date('2026-09-02T10:00:00.000Z'),
      endsAt: new Date('2026-09-02T10:30:00.000Z'),
      syncState: 'synced',
    },
    {
      workspaceId: ws, calendarId: cal.id, title: 'Weekly sync',
      providerEventId: `${series}_20260909T100000Z`, recurringEventId: series,
      originalStartTime: new Date('2026-09-09T10:00:00.000Z'),
      isAllDay: false,
      startsAt: new Date('2026-09-09T10:00:00.000Z'),
      endsAt: new Date('2026-09-09T10:30:00.000Z'),
      syncState: 'synced',
    },
  ]).returning();
  const [first, second] = rows;

  const task = (await call('POST', '/tasks', { title: 'Write the update' })).body.task;
  await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id,
    targetType: 'event', targetId: second!.id, kind: 'preparation',
  });

  // The link names the SECOND occurrence and must keep naming it.
  const row = (await call('GET', `/links?type=task&id=${task.id}`)).body.links[0];
  assert.equal(row.entity.id, second!.id);
  assert.equal(row.entity.at, second!.startsAt!.toISOString(),
    'the link resolved to the wrong occurrence of the series');

  const r = await call('GET', `/calendar/events/${second!.id}`);
  assert.equal(r.body.day, '2026-09-09');
  assert.equal(r.body.occurrence.seriesId, series, 'the series is not reported');
  // Same series, different occurrence, different answer. No shared identity.
  const other = await call('GET', `/calendar/events/${first!.id}`);
  assert.equal(other.body.day, '2026-09-02');
  assert.notEqual(other.body.event.id, r.body.event.id);
});

test('a link to a deleted event fails gracefully and explains itself', async () => {
  const { call, db, ws } = await setup();
  const cal = await localCalendar(db, ws);
  const [ev] = await db.insert(calendarEvents).values({
    workspaceId: ws, calendarId: cal.id, title: 'Cancelled thing',
    isAllDay: false,
    startsAt: new Date('2026-09-02T10:00:00.000Z'),
    endsAt: new Date('2026-09-02T11:00:00.000Z'),
    syncState: 'local_only', isSynthetic: true,
  }).returning();

  await call('DELETE', `/calendar/events/${ev!.id}`);

  const gone = await call('GET', `/calendar/events/${ev!.id}`);
  assert.equal(gone.status, 404);
  assert.match(gone.body.error.message, /no longer in your calendar/i);

  // A pasted or truncated id is a 404 too — never a 500 and never a stack.
  const junk = await call('GET', '/calendar/events/not-a-uuid');
  assert.equal(junk.status, 404);
  assert.match(junk.body.error.message, /not valid/i);
});
