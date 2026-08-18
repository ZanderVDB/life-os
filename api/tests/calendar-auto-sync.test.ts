/**
 * The calendar keeps itself current, and stops dying of a bad minute.
 *
 * ── The two bugs this file exists to hold shut ─────────────────────────
 *
 * ONE. Every failure to refresh a token was recorded as `revoked` — a state
 * only a human clicking Reconnect can leave. A Google 503, a DNS blip, a
 * timeout or a rate limit therefore killed the calendar permanently. The tests
 * below prove that only Google actually saying the grant is gone counts.
 *
 * TWO. Nothing ever synced unless a browser had the Calendar tab open. "It
 * syncs automatically" described the tab, not the product. The scheduler tests
 * prove a connection is pulled, rescheduled, and retried on a backoff, with no
 * client involved at all.
 *
 * Google is stubbed at `fetch`. That is deliberate: the point is what THIS code
 * does with each kind of answer, and only a stub can produce a 503 on demand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { calendarConnections, calendars, calendarEvents } from '../src/db/schema.js';
import { encryptToken } from '../src/lib/token-crypto.js';
import * as G from '../src/lib/google-calendar.js';
import {
  runSyncPass, backoffMs, jitter, startCalendarScheduler,
  BACKOFF_BASE_MS, BACKOFF_MAX_MS, SYNC_INTERVAL_MS, FAILURES_BEFORE_VISIBLE,
} from '../src/lib/calendar-scheduler.js';

const KEY = 'test-key-that-is-definitely-long-enough-32';
const TOKEN = 'test-token';
const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused',
  FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = () => ({ authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'zander@example.com' });
const quiet = { info() {}, warn() {}, error() {} };

/** Google credentials, present only while a test runs. */
function withGoogleConfigured() {
  process.env.GOOGLE_CALENDAR_CLIENT_ID = 'test-client';
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'test-secret';
  process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'http://localhost/cb';
  process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY = KEY;
}

type Reply = { status: number; body: unknown };
type Stub = { token?: Reply | (() => Reply | never); calendars?: Reply; events?: Reply };

/** Replaces `fetch` with a scripted Google. Returns a restore function. */
function stubGoogle(s: Stub) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const href = String(url);
    calls.push(href);
    const reply = (r: Reply) => new Response(JSON.stringify(r.body), {
      status: r.status, headers: { 'Content-Type': 'application/json' },
    });
    if (href.includes('oauth2.googleapis.com/token')) {
      const t = typeof s.token === 'function' ? s.token() : s.token;
      if (!t) throw new TypeError('fetch failed');   // a network failure
      return reply(t);
    }
    if (href.includes('/users/me/calendarList')) {
      return reply(s.calendars ?? { status: 200, body: { items: [] } });
    }
    if (href.includes('/events')) {
      return reply(s.events ?? { status: 200, body: { items: [], nextSyncToken: 'tok-1' } });
    }
    return reply({ status: 404, body: {} });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const OK_TOKEN: Reply = {
  status: 200, body: { access_token: 'fresh-access', expires_in: 3600, scope: G.GOOGLE_SCOPE },
};
const ONE_CALENDAR: Reply = {
  status: 200,
  body: { items: [{ id: 'primary@example.com', summary: 'Zander', accessRole: 'owner', primary: true, selected: true }] },
};

/** A workspace with a Google connection whose access token has expired. */
async function connectedWorkspace(over: Partial<typeof calendarConnections.$inferInsert> = {}) {
  withGoogleConfigured();
  const { db } = await freshDb();
  const app = buildApp(db, env);
  await app.ready();
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth() })).json();
  const [conn] = await db.insert(calendarConnections).values({
    workspaceId: me.workspace.id,
    provider: 'google',
    providerAccountId: 'google-123',
    accountEmail: 'zander@example.com',
    status: 'active',
    refreshTokenRef: encryptToken('refresh-token-value', KEY),
    // Expired, so every pass must go through a refresh — the path that broke.
    tokenExpiresAt: new Date(Date.now() - 60_000),
    grantedScopes: [G.GOOGLE_SCOPE],
    ...over,
  }).returning();
  return { db, app, me, conn };
}

const reread = async (db: any, id: string) =>
  (await db.select().from(calendarConnections).where(eq(calendarConnections.id, id)))[0];

/* ── One: a bad minute is not a revoked grant ─────────────────────────── */

test('a Google 503 does not disconnect the calendar', async () => {
  /* The exact shape of the reported bug. Google has an outage, and the user
   * comes back to a calendar that has given up and wants them to reconnect. */
  const { db, conn } = await connectedWorkspace();
  const g = stubGoogle({ token: { status: 503, body: { error: 'backend_error' } } });
  try {
    const r = await runSyncPass(db, quiet);
    assert.equal(r.failed, 1, 'the pass did not record a failure');
  } finally { g.restore(); }

  const after = await reread(db, conn.id);
  assert.equal(after.status, 'active', 'a 503 disconnected the calendar');
  assert.notEqual(after.status, 'revoked');
  assert.equal(after.syncFailureCount, 1);
  assert.ok(after.nextSyncAt, 'the connection was not rescheduled — it would never retry');
});

test('a network failure does not disconnect the calendar', async () => {
  const { db, conn } = await connectedWorkspace();
  // token: undefined makes the stub throw, exactly as a DNS failure does.
  const g = stubGoogle({ token: undefined });
  try { await runSyncPass(db, quiet); } finally { g.restore(); }

  const after = await reread(db, conn.id);
  assert.equal(after.status, 'active', 'a network blip disconnected the calendar');
  assert.ok(after.nextSyncAt);
});

test('a rate limit does not disconnect the calendar', async () => {
  const { db, conn } = await connectedWorkspace();
  const g = stubGoogle({ token: { status: 429, body: { error: 'rateLimitExceeded' } } });
  try { await runSyncPass(db, quiet); } finally { g.restore(); }
  assert.equal((await reread(db, conn.id)).status, 'active');
});

test('invalid_grant — and only invalid_grant — revokes', async () => {
  /* The one case where reconnecting really is the answer: Google has told us
   * the refresh token is dead. Anything softer than this must not reach here. */
  const { db, conn } = await connectedWorkspace();
  const g = stubGoogle({ token: { status: 400, body: { error: 'invalid_grant' } } });
  try { await runSyncPass(db, quiet); } finally { g.restore(); }

  const after = await reread(db, conn.id);
  assert.equal(after.status, 'revoked');
  assert.match(after.lastError ?? '', /Reconnect/);
});

test('the error classification names the permanent cases and nothing else', () => {
  const permanent = ['invalid_grant', 'invalid_client', 'unauthorized_client'];
  for (const code of permanent) {
    assert.equal(new G.GoogleTokenError('x', 400, code).permanent, true, `${code} should be permanent`);
    assert.equal(G.isTransientTokenError(new G.GoogleTokenError('x', 400, code)), false);
  }
  for (const code of ['backend_error', 'rateLimitExceeded', 'network', 'http_500', 'http_503']) {
    assert.equal(new G.GoogleTokenError('x', 500, code).permanent, false, `${code} should be transient`);
    assert.equal(G.isTransientTokenError(new G.GoogleTokenError('x', 500, code)), true);
  }
  // An error from somewhere else entirely is transient: we do not know it is fatal.
  assert.equal(G.isTransientTokenError(new Error('boom')), true);
});

test('a revoked connection is never picked up again', async () => {
  /* Nothing to retry with. Leaving it in the queue would burn a Google call a
   * minute forever and keep rewriting a status the user has to act on. */
  const { db } = await connectedWorkspace({ status: 'revoked' });
  const g = stubGoogle({ token: OK_TOKEN, calendars: ONE_CALENDAR });
  try {
    const r = await runSyncPass(db, quiet);
    assert.equal(r.synced, 0, 'a revoked connection was synced');
    assert.equal(g.calls.length, 0, 'a revoked connection still called Google');
  } finally { g.restore(); }
});

test('recovery: a connection that failed and then succeeds is clean again', async () => {
  const { db, conn } = await connectedWorkspace();
  const bad = stubGoogle({ token: { status: 503, body: { error: 'backend_error' } } });
  try { await runSyncPass(db, quiet); } finally { bad.restore(); }
  assert.equal((await reread(db, conn.id)).syncFailureCount, 1);

  // Due again, and this time Google answers.
  await db.update(calendarConnections).set({ nextSyncAt: new Date(Date.now() - 1000) })
    .where(eq(calendarConnections.id, conn.id));
  const good = stubGoogle({ token: OK_TOKEN, calendars: ONE_CALENDAR });
  try {
    const r = await runSyncPass(db, quiet);
    assert.equal(r.synced, 1, 'the recovered connection did not sync');
  } finally { good.restore(); }

  const after = await reread(db, conn.id);
  assert.equal(after.syncFailureCount, 0, 'the failure count did not reset');
  assert.equal(after.lastError, null, 'a stale error was left on a working connection');
  assert.equal(after.status, 'active');
  assert.ok(after.lastSyncedAt);
});

/* ── Two: it runs without a browser ───────────────────────────────────── */

test('the scheduler syncs a connection with no client involved', async () => {
  const { db, conn, me } = await connectedWorkspace();
  const g = stubGoogle({
    token: OK_TOKEN,
    calendars: ONE_CALENDAR,
    events: {
      status: 200,
      body: {
        nextSyncToken: 'tok-1',
        items: [{
          id: 'evt-1', status: 'confirmed', summary: 'Dentist',
          start: { dateTime: '2026-09-01T09:00:00Z' },
          end: { dateTime: '2026-09-01T10:00:00Z' },
        }],
      },
    },
  });
  try {
    const r = await runSyncPass(db, quiet);
    assert.equal(r.synced, 1);
  } finally { g.restore(); }

  const cals = await db.select().from(calendars).where(eq(calendars.workspaceId, me.workspace.id));
  assert.equal(cals.length, 1, 'the calendar list was not stored');
  const events = await db.select().from(calendarEvents)
    .where(eq(calendarEvents.workspaceId, me.workspace.id));
  assert.equal(events.length, 1, 'the event was not stored');
  assert.equal(events[0].title, 'Dentist');

  const after = await reread(db, conn.id);
  assert.ok(after.lastSyncedAt, 'lastSyncedAt was not stamped');
  assert.ok(after.nextSyncAt!.getTime() > Date.now(), 'the next sync is not in the future');
  assert.equal(after.syncingSince, null, 'the claim was not released');
});

test('an event Google sends without a sequence still stores', () => {
  /* `sequence` is NOT NULL DEFAULT 0, and an explicit null overrides a default
   * rather than falling back to it. Mapping the missing field to null made the
   * insert fail; one failed insert aborts the calendar BEFORE its sync token
   * advances, so that calendar then failed identically on every later pass.
   * A quietly-permanent stop, from one optional field. */
  const mapped = G.mapEvent({
    id: 'evt-1', status: 'confirmed', summary: 'Dentist',
    start: { dateTime: '2026-09-01T09:00:00Z' }, end: { dateTime: '2026-09-01T10:00:00Z' },
  });
  assert.equal(mapped?.sequence, 0, 'a missing sequence still maps to null');
  assert.equal(G.mapEvent({ id: 'e', sequence: 4, start: { date: '2026-09-01' } })?.sequence, 4);
});

test('a connection that is not due yet is left alone', async () => {
  const { db } = await connectedWorkspace({ nextSyncAt: new Date(Date.now() + 60 * 60_000) });
  const g = stubGoogle({ token: OK_TOKEN, calendars: ONE_CALENDAR });
  try {
    assert.equal((await runSyncPass(db, quiet)).synced, 0);
    assert.equal(g.calls.length, 0, 'a connection that was not due called Google');
  } finally { g.restore(); }
});

test('a never-synced connection is due immediately', async () => {
  /* The migration leaves next_sync_at NULL on every existing connection, so
   * this is what makes the first tick after deploy catch everyone up. */
  const { db } = await connectedWorkspace({ nextSyncAt: null });
  const g = stubGoogle({ token: OK_TOKEN, calendars: ONE_CALENDAR });
  try { assert.equal((await runSyncPass(db, quiet)).synced, 1); } finally { g.restore(); }
});

test('a claimed connection is not synced twice at once', async () => {
  /* Two overlapping ticks, or two instances mid-deploy, must not both pull the
   * same account: duplicate work, doubled quota, and interleaved sync tokens. */
  const { db } = await connectedWorkspace({ syncingSince: new Date() });
  const g = stubGoogle({ token: OK_TOKEN, calendars: ONE_CALENDAR });
  try {
    assert.equal((await runSyncPass(db, quiet)).synced, 0, 'a held claim was ignored');
    assert.equal(g.calls.length, 0);
  } finally { g.restore(); }
});

test('a claim left by a crashed process is eventually retaken', async () => {
  /* Otherwise a single crash mid-sync strands that account forever, which is
   * the same permanent-stop failure mode in a different costume. */
  const { db } = await connectedWorkspace({ syncingSince: new Date(Date.now() - 60 * 60_000) });
  const g = stubGoogle({ token: OK_TOKEN, calendars: ONE_CALENDAR });
  try { assert.equal((await runSyncPass(db, quiet)).synced, 1); } finally { g.restore(); }
});

test('the scheduler never throws, whatever the database does', async () => {
  const exploding = {
    update: () => { throw new Error('database is on fire'); },
    select: () => { throw new Error('database is on fire'); },
  } as any;
  withGoogleConfigured();
  const errors: unknown[] = [];
  const h = startCalendarScheduler(exploding, { ...quiet, error: (o) => errors.push(o) });
  try {
    const r = await h.runOnce();          // must resolve, not reject
    assert.equal(r.failed, 1);
    assert.equal(errors.length, 1, 'the failure was not logged');
  } finally { h.stop(); }
});

test('a stopped scheduler does no further work', async () => {
  const { db } = await connectedWorkspace();
  const h = startCalendarScheduler(db, quiet);
  h.stop();
  const g = stubGoogle({ token: OK_TOKEN, calendars: ONE_CALENDAR });
  try {
    assert.equal((await h.runOnce()).synced, 0);
    assert.equal(g.calls.length, 0, 'a stopped scheduler still called Google');
  } finally { g.restore(); }
});

/* ── Backoff and spread ───────────────────────────────────────────────── */

test('backoff doubles and then stops doubling', () => {
  assert.equal(backoffMs(1), BACKOFF_BASE_MS);
  assert.equal(backoffMs(2), BACKOFF_BASE_MS * 2);
  assert.equal(backoffMs(3), BACKOFF_BASE_MS * 4);
  assert.equal(backoffMs(50), BACKOFF_MAX_MS, 'backoff grew without a ceiling');
  // A ceiling, not an abandonment: it always comes back round.
  assert.ok(BACKOFF_MAX_MS <= 60 * 60_000, 'a failing calendar waits over an hour');
  assert.ok(backoffMs(1) > 0);
});

test('the retry delay grows but the connection is never abandoned', async () => {
  const { db, conn } = await connectedWorkspace();
  let last = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await db.update(calendarConnections).set({ nextSyncAt: new Date(Date.now() - 1000) })
      .where(eq(calendarConnections.id, conn.id));
    const g = stubGoogle({ token: { status: 503, body: { error: 'backend_error' } } });
    try { await runSyncPass(db, quiet); } finally { g.restore(); }

    const after = await reread(db, conn.id);
    assert.equal(after.syncFailureCount, attempt);
    const delay = after.nextSyncAt!.getTime() - Date.now();
    assert.ok(delay > last, `attempt ${attempt} did not back off further (${delay} <= ${last})`);
    assert.ok(after.nextSyncAt, 'the connection stopped being scheduled');
    assert.notEqual(after.status, 'revoked', 'repeated transient failures revoked the grant');
    last = delay;
  }
  // And by now it is worth saying so.
  const after = await reread(db, conn.id);
  assert.equal(after.syncFailureCount, FAILURES_BEFORE_VISIBLE);
  assert.match(after.lastError ?? '', /[Ss]till trying/, 'the user is not told it is still trying');
});

test('one failure is not worth reporting', () => {
  /* Reporting every blip trains someone to ignore the message that matters. */
  assert.ok(FAILURES_BEFORE_VISIBLE >= 2, 'a single missed pull is shown to the user');
});

test('sync times are spread, so connections do not all fire together', () => {
  const results = new Set<number>();
  for (let i = 0; i < 200; i++) results.add(jitter(SYNC_INTERVAL_MS));
  assert.ok(results.size > 50, 'jitter produces almost no spread');
  for (const v of results) {
    assert.ok(v >= SYNC_INTERVAL_MS * 0.9 && v <= SYNC_INTERVAL_MS * 1.1,
      `${v} is outside the intended ±10%`);
  }
  // Deterministic ends, so the bounds are exactly what they claim.
  assert.equal(jitter(1000, () => 0), 900);
  assert.equal(jitter(1000, () => 1), 1100);
});

test('the interval keeps a calendar current without hammering Google', () => {
  assert.ok(SYNC_INTERVAL_MS >= 60_000, 'syncing more than once a minute is wasteful');
  assert.ok(SYNC_INTERVAL_MS <= 15 * 60_000, 'a calendar can be a quarter hour stale');
  // Incremental pulls are one cheap call per calendar; this is well inside quota.
  const perDay = (24 * 60 * 60_000) / SYNC_INTERVAL_MS;
  assert.ok(perDay < 2000, `${perDay} pulls a day per account is too many`);
});

/* ── Wiring: it is actually started, and it is still read-only ────────── */

test('the server starts the scheduler, and stops it on shutdown', () => {
  const index = readFileSync(join('src', 'index.ts'), 'utf8');
  assert.match(index, /startCalendarScheduler\(db, app\.log\)/, 'the scheduler is never started');
  assert.match(index, /calendarSync\?\.stop\(\)/, 'shutdown does not stop the scheduler');
  // Not in buildApp: every test builds an app and none wants a Google timer.
  const appSrc = readFileSync(join('src', 'app.ts'), 'utf8');
  assert.ok(!appSrc.includes('startCalendarScheduler'), 'the scheduler starts inside buildApp');
});

test('the background sync is read-only, like everything else here', () => {
  /* Automatic and unattended is exactly when an accidental write would be
   * worst, and least likely to be noticed. */
  const engine = readFileSync(join('src', 'lib', 'calendar-sync.ts'), 'utf8');
  const sched = readFileSync(join('src', 'lib', 'calendar-scheduler.ts'), 'utf8');
  for (const [name, src] of [['engine', engine], ['scheduler', sched]] as const) {
    assert.ok(!/insertEvent|patchEvent|deleteEvent|createEvent/.test(src),
      `${name} has a write helper`);
    assert.ok(!src.includes('auth/calendar\''), `${name} names a write scope`);
  }
});

test('the migration revives connections the old bug killed', () => {
  /* Those rows are indistinguishable from genuinely revoked ones, because the
   * old code wrote the same status for both. Trying once is the only way to
   * find out, and it costs a single refresh call. */
  const sql = readFileSync(join('drizzle', '0013_calendar_auto_sync.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS next_sync_at/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS syncing_since/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS sync_failure_count/);
  assert.match(sql, /UPDATE calendar_connections[\s\S]*SET status = 'active'[\s\S]*WHERE status = 'revoked'/);
  assert.match(sql, /refresh_token_ref IS NOT NULL/,
    'a connection with no refresh token would be revived with nothing to refresh');
});

test('the status the browser sees says whether it is syncing itself', async () => {
  const { app, me, conn } = await connectedWorkspace({
    lastSyncedAt: new Date(), nextSyncAt: new Date(Date.now() + SYNC_INTERVAL_MS),
  });
  const r = await app.inject({
    method: 'GET', headers: auth(),
    url: `/api/v1/workspaces/${me.workspace.id}/integrations/google-calendar`,
  });
  const body = r.json();
  assert.equal(body.connection.autoSync, true);
  assert.ok(body.connection.nextSyncAt, 'the browser cannot say when the next sync is');
  assert.equal(body.connection.failureCount, 0);
  // Still no secrets, ever.
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('refresh-token-value'), 'a refresh token reached the browser');
  assert.ok(!raw.includes(KEY), 'the encryption key reached the browser');
  assert.ok(!raw.includes(conn.refreshTokenRef!), 'the encrypted token reached the browser');
});

/* ── The manual button, and what it now says when Google is down ──────── */

test('Sync now on a Google outage does not tell the user to reconnect', async () => {
  /* The old path threw "Google access was revoked or expired. Reconnect to
   * continue." at a 503. That sentence is an instruction, and following it was
   * useless work for a problem the user did not have. */
  const { app, db, me, conn } = await connectedWorkspace();
  const g = stubGoogle({ token: { status: 503, body: { error: 'backend_error' } } });
  let r;
  try {
    r = await app.inject({
      method: 'POST', headers: auth(),
      url: `/api/v1/workspaces/${me.workspace.id}/integrations/google-calendar/sync`,
    });
  } finally { g.restore(); }

  assert.equal(r.statusCode, 503, 'an outage is reported as the caller being wrong');
  const message = r.json().error?.message ?? r.json().message ?? '';
  assert.ok(!/[Rr]econnect to continue/.test(message), message);
  assert.match(message, /still connected/, 'the message does not say the connection survived');
  assert.match(message, /keep trying/, 'the message does not say it retries by itself');

  const after = await reread(db, conn.id);
  assert.equal(after.status, 'active', 'a manual sync during an outage revoked the grant');
  assert.ok(after.nextSyncAt, 'the scheduler was not left holding it');
});

test('Sync now on a revoked grant does say to reconnect', async () => {
  const { app, db, me, conn } = await connectedWorkspace();
  const g = stubGoogle({ token: { status: 400, body: { error: 'invalid_grant' } } });
  let r;
  try {
    r = await app.inject({
      method: 'POST', headers: auth(),
      url: `/api/v1/workspaces/${me.workspace.id}/integrations/google-calendar/sync`,
    });
  } finally { g.restore(); }
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error?.message ?? r.json().message ?? '', /Reconnect/);
  assert.equal((await reread(db, conn.id)).status, 'revoked');
});

test('a manual sync pushes the scheduled one back', async () => {
  /* Otherwise pressing the button leaves an automatic pull due seconds later,
   * which is a wasted Google call for a calendar that is already current. */
  const { app, db, me, conn } = await connectedWorkspace({
    nextSyncAt: new Date(Date.now() - 1000),
  });
  const g = stubGoogle({ token: OK_TOKEN, calendars: ONE_CALENDAR });
  try {
    const r = await app.inject({
      method: 'POST', headers: auth(),
      url: `/api/v1/workspaces/${me.workspace.id}/integrations/google-calendar/sync`,
    });
    assert.equal(r.statusCode, 200);
  } finally { g.restore(); }
  const after = await reread(db, conn.id);
  assert.ok(after.nextSyncAt!.getTime() > Date.now() + SYNC_INTERVAL_MS * 0.85,
    'the next automatic sync was not pushed back');
});

/* ── What the Calendar tells the user ─────────────────────────────────── */

test('the Calendar separates trouble from a grant that is actually gone', () => {
  const cal = readFileSync(join('..', 'web', 'calendar.js'), 'utf8');
  assert.match(cal, /export const needsReconnect/, 'the two states are not distinguished');
  const fn = cal.slice(cal.indexOf('function connStatusWord'), cal.indexOf('function autoSyncWord'));
  assert.match(fn, /Reconnect needed/);
  assert.match(fn, /retrying/, 'a transient failure has no distinct wording');
  // Red is reserved for the state that needs the user; trouble is amber.
  const health = cal.slice(cal.indexOf('function connHealth'), cal.indexOf('function connStatusWord'));
  assert.match(health, /needsReconnect\(conn\)\) return 'is-error'/);
  assert.match(health, /is-warn/);
  const html = readFileSync(join('..', 'web', 'index.html'), 'utf8');
  assert.match(html, /\.cs-acct-dot\.is-warn\{background:var\(--warn\)\}/,
    'the amber state has no colour, so it renders as no dot at all');
});

test('the Calendar says the syncing is automatic, because now it is', () => {
  const cal = readFileSync(join('..', 'web', 'calendar.js'), 'utf8');
  const fn = cal.slice(cal.indexOf('function autoSyncWord'), cal.indexOf('function lastSyncedWord'));
  assert.match(fn, /even when Life OS is closed/, 'the promise is not made');
  assert.match(fn, /paused until you reconnect/, 'a revoked grant still claims to auto-sync');
  assert.match(fn, /keeps trying/, 'an outage does not say it recovers by itself');
  // And it is actually rendered.
  assert.match(cal, /class="cs-auto">\$\{esc\(autoSyncWord\(conn\)\)\}/);
});

test('a revoked connection offers the button that fixes it', () => {
  /* Previously the only control on a dead connection was Disconnect, so the
   * fix was to disconnect and reconnect — two steps for a one-step problem. */
  const cal = readFileSync(join('..', 'web', 'calendar.js'), 'utf8');
  assert.match(cal, /needsReconnect\(conn\) \? `<button[^`]*id="cal-connect"/,
    'there is no Reconnect button on a revoked connection');
});

test('every Google call can time out, so a pass cannot hang forever', () => {
  /* The scheduler runs one pass at a time. A single request that never settles
   * would stop EVERY calendar syncing for the life of the process — a silent
   * permanent stop, which is the failure this whole phase exists to remove. */
  const client = readFileSync(join('src', 'lib', 'google-calendar.ts'), 'utf8');
  const fetches = client.match(/await fetch\(/g) ?? [];
  const timeouts = client.match(/AbortSignal\.timeout\(/g) ?? [];
  assert.ok(fetches.length >= 2, 'no Google calls found');
  // Every call the sync path makes: the token exchange and the API GET.
  assert.ok(timeouts.length >= 2, `${timeouts.length} of ${fetches.length} calls can time out`);
  const get = client.slice(client.indexOf('async function get(accessToken'));
  assert.match(get.slice(0, get.indexOf('if (!res.ok)')), /AbortSignal\.timeout/,
    'the Calendar API GET has no timeout');
});
