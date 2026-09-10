/**
 * The calendar went down in production on 10 September 2026, and nothing here
 * could have noticed.
 *
 * Every load of GET /calendar/range returned a 500. The background sync kept
 * pulling events without a single error, so the connection was healthy the
 * whole time — but the screen showed a calendar that "keeps disconnecting and
 * will not reconnect", and reconnecting could not help, because the connection
 * was never what was broken.
 *
 * The query compared a raw `sql\`coalesce(...)\`` expression against a JS Date.
 * drizzle's postgres-js driver passes dates through untouched and relies on its
 * column encoders to stringify them first; a raw expression has no column, so
 * the Date reached the driver bare and `Buffer.byteLength(Date)` threw. PGlite
 * — which every test here runs on — serialises a Date by itself, so all 1,836
 * tests passed. That is the note in memory, `pglite-vs-production-postgres`,
 * learned a second time.
 *
 * `freshDb` now refuses a raw Date the way production does. These pin that the
 * refusal is real, and that the route which fell over now stands up under it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { calendars, calendarEvents } from '../src/db/schema.js';

const TOKEN = 'dev-driver-token';

async function running() {
  const { db } = await freshDb();
  const env = loadEnv({
    /* Any positive port: `inject` never opens a socket, and loadEnv rightly
       refuses 0. */
    NODE_ENV: 'test', PORT: '8089', LOG_LEVEL: 'warn',
    DATABASE_URL: 'postgresql://unused/unused',
    FIREBASE_PROJECT_ID: 'test-project',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    DEV_AUTH_BYPASS: TOKEN,
  } as any);
  const app = buildApp(db, env);
  await app.ready();
  const auth = { authorization: `Bearer ${TOKEN}` };
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth })).json();
  return { app, db, auth, ws: me.workspace.id as string };
}

/* ══ The harness now fails the way production fails ══════════════════════ */

test('driver: a raw Date parameter is refused, as production refuses it', async () => {
  const { db } = await freshDb();
  /* The exact shape of the bug: a Date interpolated into raw SQL, with no
     column to encode it. */
  await assert.rejects(
    () => db.execute(sql`select ${new Date('2026-09-10T00:00:00Z')}::timestamptz as t`),
    /raw Date was bound/,
    'the test database still forgives what production does not',
  );
});

test('driver: a properly encoded timestamp is untouched by the guard', async () => {
  /* The guard must be exactly as strict as production and no stricter. A Date
     that goes through a column is a string by the time it reaches the driver,
     and has to keep working — or this would flag every ordinary insert. */
  const { db } = await freshDb();
  const iso = new Date('2026-09-10T08:30:00Z').toISOString();
  const rows = await db.execute(sql`select ${iso}::timestamptz as t`);
  assert.ok(rows, 'an ISO string was refused');
});

/* ══ The route that fell over ════════════════════════════════════════════ */

test('range: loads under the production rules, with a visit in progress', async () => {
  const { app, db, auth, ws } = await running();
  const [cal] = await db.insert(calendars).values({
    workspaceId: ws, providerCalendarId: 'local:driver', name: 'Life OS',
    color: '#8b7ff5', accessRole: 'owner', isPrimary: true,
    isDefaultTarget: true, isReadOnly: false, isSynthetic: true,
  }).returning();
  await db.insert(calendarEvents).values([
    {
      workspaceId: ws, calendarId: cal!.id, title: 'Sam and Jo staying', isAllDay: false,
      startsAt: new Date('2026-09-09T13:00:00Z'), endsAt: new Date('2026-09-16T08:00:00Z'),
      syncState: 'local_only', isSynthetic: true,
    },
    {
      workspaceId: ws, calendarId: cal!.id, title: 'Coast trip', isAllDay: true,
      startDate: '2026-09-11', endDate: '2026-09-14',
      syncState: 'local_only', isSynthetic: true,
    },
  ]);

  /* The MIDDLE of both — a window that contains neither the start nor the end
     of either event, which is the case the overlap query exists for. */
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${ws}/calendar/range?from=2026-09-12&to=2026-09-13`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200,
    `the calendar would not load — ${res.statusCode}: ${res.body.slice(0, 240)}`);
  const titles = res.json().events.map((e: { title: string }) => e.title);
  assert.ok(titles.includes('Sam and Jo staying'), 'a timed visit in progress is missing');
  assert.ok(titles.includes('Coast trip'), 'an all-day trip in progress is missing');
});

/* ══ And the pattern, wherever it might come back ═══════════════════════ */

test('source: no raw SQL expression is compared against a bound value', () => {
  /* The dynamic guard catches this on every path a test exercises. This
     catches it on the paths no test reaches — which is where the next one will
     be. Comparing a raw expression to a COLUMN is fine; comparing it to a
     value is the bug, and drizzle's comparison helpers make that the only
     thing this shape can mean. */
  const root = join('src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(root);
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/\b(gte|lte|gt|lt|eq|ne)\(sql`/.test(line)) offenders.push(`${f}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `a raw expression is compared to a value — put the column on the left:\n${offenders.join('\n')}`);
});
