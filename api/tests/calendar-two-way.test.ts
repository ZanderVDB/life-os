/**
 * Two-way Calendar: Google is authoritative, and nothing writes unconfirmed.
 *
 * ── The rule these tests exist to hold ──────────────────────────────────
 *
 * A real event lives in Google. Life OS proposes, a person confirms, and only
 * then does anything reach Google — and only what Google accepted is committed
 * locally. The tempting shortcut is to write locally, show success and sync
 * later; that produces an event which exists in the app and nowhere else,
 * which is worse than an error because the user has stopped thinking about it.
 *
 * Google is stubbed at `fetch`. That is the point: the interesting cases are
 * the ones a real account will not produce on demand — a 403 mid-write, a
 * revoked grant, a forged webhook, a retried create.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import {
  calendarConnections, calendars, calendarEvents, calendarMutations, calendarWatchChannels,
} from '../src/db/schema.js';
import { encryptToken } from '../src/lib/token-crypto.js';
import * as G from '../src/lib/google-calendar.js';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
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

function googleConfigured() {
  process.env.GOOGLE_CALENDAR_CLIENT_ID = 'test-client';
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'test-secret';
  process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'http://localhost/cb';
  process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY = KEY;
  process.env.GOOGLE_CALENDAR_WEBHOOK_URL = 'https://staging.example.com/api/v1/integrations/google-calendar/notifications';
}

type Stub = {
  insert?: { status: number; body: any };
  patch?: { status: number; body: any };
  del?: { status: number; body: any };
  freeBusy?: { status: number; body: any };
  get?: { status: number; body: any };
};

/** A scripted Google. Records every call so the test can assert what happened. */
function stubGoogle(s: Stub = {}) {
  const real = globalThis.fetch;
  const calls: { method: string; url: string; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const href = String(url);
    const method = init.method ?? 'GET';
    let body: any = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
    calls.push({ method, url: href, body });
    const reply = (r: { status: number; body: any }) => new Response(JSON.stringify(r.body), {
      status: r.status, headers: { 'Content-Type': 'application/json' },
    });

    if (href.includes('oauth2.googleapis.com/token')) {
      return reply({ status: 200, body: { access_token: 'fresh', expires_in: 3600 } });
    }
    if (href.includes('/freeBusy')) {
      return reply(s.freeBusy ?? { status: 200, body: { calendars: {} } });
    }
    if (href.includes('/events/watch')) {
      return reply({
        status: 200,
        body: { id: body?.id, resourceId: 'res-1', expiration: String(Date.now() + 7 * 864e5) },
      });
    }
    if (href.includes('/channels/stop')) return reply({ status: 204, body: {} });
    if (method === 'POST' && /\/events(\?|$)/.test(href)) {
      return reply(s.insert ?? { status: 200, body: okEvent() });
    }
    if (method === 'PATCH') return reply(s.patch ?? { status: 200, body: okEvent() });
    if (method === 'DELETE') {
      const r = s.del ?? { status: 204, body: {} };
      return new Response(null, { status: r.status });
    }
    if (href.includes('/users/me/calendarList')) return reply({ status: 200, body: { items: [] } });
    if (method === 'GET') return reply(s.get ?? { status: 200, body: okEvent() });
    return reply({ status: 404, body: {} });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const okEvent = (over: any = {}) => ({
  id: 'gev-1',
  status: 'confirmed',
  summary: 'Photography Session',
  etag: '"etag-1"',
  sequence: 0,
  start: { dateTime: '2026-09-05T10:00:00Z', timeZone: 'Africa/Johannesburg' },
  end: { dateTime: '2026-09-05T12:00:00Z', timeZone: 'Africa/Johannesburg' },
  htmlLink: 'https://calendar.google.com/event?eid=abc',
  ...over,
});

/** A workspace with a writable Google connection and one writable calendar. */
async function connected(over: { canWrite?: boolean; scopesVersion?: number; readOnly?: boolean } = {}) {
  googleConfigured();
  const { db } = await freshDb();
  const app = buildApp(db, env);
  await app.ready();
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth() })).json();
  const base = `/api/v1/workspaces/${me.workspace.id}`;

  const [conn] = await db.insert(calendarConnections).values({
    workspaceId: me.workspace.id,
    provider: 'google',
    providerAccountId: 'google-1',
    accountEmail: 'zander@example.com',
    status: 'active',
    refreshTokenRef: encryptToken('refresh-value', KEY),
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    accessTokenRef: encryptToken('access-value', KEY),
    grantedScopes: [...G.GOOGLE_SCOPES],
    canWrite: over.canWrite ?? true,
    scopesVersion: over.scopesVersion ?? G.SCOPES_VERSION,
  }).returning();

  const [cal] = await db.insert(calendars).values({
    workspaceId: me.workspace.id,
    connectionId: conn!.id,
    providerCalendarId: 'primary@example.com',
    name: 'Personal',
    accessRole: over.readOnly ? 'reader' : 'owner',
    isPrimary: true,
    isReadOnly: !!over.readOnly,
    isDefaultTarget: true,
    timeZone: 'Africa/Johannesburg',
  }).returning();

  return {
    db, app, me, conn: conn!, cal: cal!,
    post: (u: string, p?: any) => app.inject({ method: 'POST', url: base + u, headers: auth(), payload: p ?? {} }),
    get: (u: string) => app.inject({ method: 'GET', url: base + u, headers: auth() }),
    patch: (u: string, p: any) => app.inject({ method: 'PATCH', url: base + u, headers: auth(), payload: p }),
  };
}

const aDraft = (over: any = {}) => ({
  title: 'Photography Session',
  isAllDay: false,
  startsAt: '2026-09-05T10:00:00.000Z',
  endsAt: '2026-09-05T12:00:00.000Z',
  timeZone: 'Africa/Johannesburg',
  ...over,
});

/* ── Nothing is written without a confirmation ────────────────────────── */

test('proposing does not touch Google', async () => {
  /* The whole architecture rests on this. If proposing wrote, the confirmation
   * screen would be describing something that had already happened. */
  const h = await connected();
  const g = stubGoogle();
  try {
    const r = await h.post('/calendar/events/propose-create', {
      requestId: 'req-propose-1', calendarId: h.cal.id, draft: aDraft(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().proposal.status, 'proposed');
    const writes = g.calls.filter((c) => ['POST', 'PATCH', 'DELETE'].includes(c.method)
      && /\/events/.test(c.url));
    assert.equal(writes.length, 0, 'proposing wrote to Google');
  } finally { g.restore(); }

  const events = await h.db.select().from(calendarEvents);
  assert.equal(events.length, 0, 'proposing committed a local event');
});

test('confirming creates in Google, and commits what Google returned', async () => {
  const h = await connected();
  const g = stubGoogle();
  try {
    await h.post('/calendar/events/propose-create', {
      requestId: 'req-create-1', calendarId: h.cal.id, draft: aDraft(),
    });
    const r = await h.post('/calendar/mutations/req-create-1/confirm');
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().done, true);

    const insert = g.calls.find((c) => c.method === 'POST' && /\/events\?/.test(c.url));
    assert.ok(insert, 'no event was created in Google');
    assert.equal(insert!.body.summary, 'Photography Session');
    assert.equal(insert!.body.start.timeZone, 'Africa/Johannesburg',
      'the event was sent without a timezone');
    // Identity, never content — so a later reader can match without guessing.
    assert.ok(insert!.body.extendedProperties?.private?.losWorkspace,
      'the Google event carries no link back to Life OS');
  } finally { g.restore(); }

  const [event] = await h.db.select().from(calendarEvents);
  assert.ok(event, 'nothing was mirrored locally');
  assert.equal(event.providerEventId, 'gev-1', 'the mirror does not hold the Google id');
  assert.equal(event.syncState, 'synced');
  assert.equal(event.etag, '"etag-1"', 'the etag was not kept for concurrency checks');
});

test('a Google failure leaves nothing behind', async () => {
  /* The failure this whole design exists to prevent: an event that Life OS
   * believes in and Google has never heard of. */
  const h = await connected();
  const g = stubGoogle({ insert: { status: 403, body: { error: { message: 'Forbidden' } } } });
  let r;
  try {
    await h.post('/calendar/events/propose-create', {
      requestId: 'req-fail-1', calendarId: h.cal.id, draft: aDraft(),
    });
    r = await h.post('/calendar/mutations/req-fail-1/confirm');
  } finally { g.restore(); }

  assert.equal(r!.statusCode, 403, r!.body);
  const message = r!.json().error?.message ?? '';
  assert.ok(!/\{|\}|"error"/.test(message), `raw Google JSON reached the user: ${message}`);

  const events = await h.db.select().from(calendarEvents);
  assert.equal(events.length, 0, 'a failed create left a local event behind');
  const [mut] = await h.db.select().from(calendarMutations);
  assert.equal(mut.status, 'failed');
  assert.ok(mut.error, 'the failure was not recorded for diagnosis');
});

test('a retried confirmation does not create a second event', async () => {
  /* A network timeout on the way back is indistinguishable, from the client,
   * from a failure. Retrying must be safe, and safety cannot come from
   * comparing titles and times — somebody may genuinely want two. */
  const h = await connected();
  const g = stubGoogle();
  try {
    await h.post('/calendar/events/propose-create', {
      requestId: 'req-idem-1', calendarId: h.cal.id, draft: aDraft(),
    });
    const first = await h.post('/calendar/mutations/req-idem-1/confirm');
    const second = await h.post('/calendar/mutations/req-idem-1/confirm');
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().alreadyDone, true, 'the retry was not recognised');
    const inserts = g.calls.filter((c) => c.method === 'POST' && /\/events\?/.test(c.url));
    assert.equal(inserts.length, 1, `Google was asked to create ${inserts.length} events`);
  } finally { g.restore(); }
  assert.equal((await h.db.select().from(calendarEvents)).length, 1);
});

test('a cancelled proposal cannot be confirmed later', async () => {
  const h = await connected();
  const g = stubGoogle();
  try {
    await h.post('/calendar/events/propose-create', {
      requestId: 'req-cancel-1', calendarId: h.cal.id, draft: aDraft(),
    });
    await h.post('/calendar/mutations/req-cancel-1/cancel');
    const r = await h.post('/calendar/mutations/req-cancel-1/confirm');
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(g.calls.filter((c) => c.method === 'POST' && /\/events\?/.test(c.url)).length, 0);
  } finally { g.restore(); }
});

test('confirming something never proposed is refused', () => {
  /* The confirm endpoint takes a requestId and nothing else, so a caller
   * cannot smuggle a different change past the screen the user read. */
  const src = readFileSync(join('src', 'routes', 'calendar-write.ts'), 'utf8');
  const fn = src.slice(src.indexOf("app.post(`${base}/calendar/mutations/:requestId/confirm`"),
    src.indexOf("app.post(`${base}/calendar/mutations/:requestId/cancel`"));
  assert.ok(!/draft|payload|calendarId:/.test(fn),
    'the confirm endpoint accepts event data, so it can differ from what was proposed');
  assert.match(fn, /executeMutation\(db, wsId\(req\), requestId/);
});

/* ── Connection state ─────────────────────────────────────────────────── */

test('a read-only grant blocks the write and says what to do', async () => {
  /* A connection made before write support looks perfectly healthy and cannot
   * create anything. Finding that out after the form is filled in is the worst
   * possible moment, so the state is asked for first. */
  const h = await connected({ canWrite: false, scopesVersion: 1 });
  const state = (await h.get('/calendar/write-state')).json();
  assert.equal(state.canWrite, false);
  assert.equal(state.needsReconnect, true);
  assert.match(state.reason, /[Rr]econnect/);

  const g = stubGoogle();
  try {
    const r = await h.post('/calendar/events/propose-create', {
      requestId: 'req-noscope-1', calendarId: h.cal.id, draft: aDraft(),
    });
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(g.calls.length, 0, 'Google was called without write permission');
  } finally { g.restore(); }
});

test('a revoked connection blocks writes but still allows reading', async () => {
  const h = await connected();
  await h.db.update(calendarConnections).set({ status: 'revoked' })
    .where(eq(calendarConnections.id, h.conn.id));
  const state = (await h.get('/calendar/write-state')).json();
  assert.equal(state.canWrite, false);
  assert.equal(state.connected, true, 'a revoked connection reads as absent');
  // Reading the range is unaffected: whatever was synced is still true.
  assert.equal((await h.get('/calendar/range?from=2026-09-01&to=2026-09-30')).statusCode, 200);
});

test('a read-only calendar is never offered as a target', async () => {
  const h = await connected({ readOnly: true });
  const state = (await h.get('/calendar/write-state')).json();
  assert.equal(state.writable.length, 0, 'a read-only calendar was offered for creation');
  assert.equal(state.calendars.length, 1, 'the calendar vanished from the list entirely');

  const g = stubGoogle();
  try {
    const r = await h.post('/calendar/events/propose-create', {
      requestId: 'req-ro-1', calendarId: h.cal.id, draft: aDraft(),
    });
    assert.equal(r.statusCode, 403, r.body);
    assert.match(r.json().error.message, /read/i);
  } finally { g.restore(); }
});

/* ── Update, delete, recurrence ───────────────────────────────────────── */

async function anEvent(h: any, over: any = {}) {
  const [row] = await h.db.insert(calendarEvents).values({
    workspaceId: h.me.workspace.id,
    calendarId: h.cal.id,
    providerEventId: 'gev-1',
    title: 'Photography Session',
    startsAt: new Date('2026-09-05T10:00:00Z'),
    endsAt: new Date('2026-09-05T12:00:00Z'),
    timeZone: 'Africa/Johannesburg',
    etag: '"etag-1"',
    syncState: 'synced',
    ...over,
  }).returning();
  return row;
}

test('an update describes the change before it makes it', async () => {
  const h = await connected();
  const ev = await anEvent(h);
  const g = stubGoogle();
  try {
    const r = await h.post(`/calendar/events/${ev.id}/propose-update`, {
      requestId: 'req-upd-1',
      draft: { startsAt: '2026-09-05T14:00:00.000Z', endsAt: '2026-09-05T16:00:00.000Z' },
    });
    assert.equal(r.statusCode, 200, r.body);
    const p = r.json().proposal;
    const when = p.summary.changes.find((c: any) => c.field === 'When');
    assert.ok(when, 'the change is not described');
    assert.notEqual(when.from, when.to);
    assert.ok(!g.calls.some((c) => c.method === 'PATCH'), 'proposing an update wrote to Google');
  } finally { g.restore(); }
});

test('an update with nothing changed is refused', async () => {
  const h = await connected();
  const ev = await anEvent(h);
  const g = stubGoogle();
  try {
    const r = await h.post(`/calendar/events/${ev.id}/propose-update`, {
      requestId: 'req-nochange-1', draft: { title: 'Photography Session' },
    });
    assert.equal(r.statusCode, 400, r.body);
  } finally { g.restore(); }
});

test('an event changed in Google since the editor opened is not overwritten', async () => {
  /* Somebody moved it on their phone thirty seconds ago. Silently overwriting
   * that is destroying a change nobody was asked about. */
  const h = await connected();
  const ev = await anEvent(h);
  const g = stubGoogle({ get: { status: 200, body: okEvent({ etag: '"etag-NEWER"' }) } });
  let r;
  try {
    await h.post(`/calendar/events/${ev.id}/propose-update`, {
      requestId: 'req-stale-1',
      draft: { startsAt: '2026-09-05T14:00:00.000Z', endsAt: '2026-09-05T16:00:00.000Z' },
    });
    r = await h.post('/calendar/mutations/req-stale-1/confirm');
  } finally { g.restore(); }
  assert.equal(r!.statusCode, 409, r!.body);
  assert.match(r!.json().error.message, /changed in Google/i);
});

test('deleting one occurrence does not delete the series', async () => {
  /* The single most destructive thing this code can get wrong. */
  const h = await connected();
  const master = await anEvent(h, { providerEventId: 'series-1', recurrence: ['RRULE:FREQ=WEEKLY'] });
  const occurrence = await anEvent(h, {
    providerEventId: 'series-1_20260912T100000Z',
    recurringEventId: 'series-1',
    startsAt: new Date('2026-09-12T10:00:00Z'),
    endsAt: new Date('2026-09-12T12:00:00Z'),
  });

  const g = stubGoogle();
  try {
    const p = await h.post(`/calendar/events/${occurrence.id}/propose-delete`, {
      requestId: 'req-del-occ', scope: 'instance',
    });
    assert.equal(p.statusCode, 200, p.body);
    await h.post('/calendar/mutations/req-del-occ/confirm');
    const del = g.calls.find((c) => c.method === 'DELETE');
    assert.ok(del, 'nothing was deleted in Google');
    assert.ok(del!.url.includes(encodeURIComponent('series-1_20260912T100000Z')),
      `the series master was targeted instead of the occurrence: ${del!.url}`);
  } finally { g.restore(); }

  const left = await h.db.select().from(calendarEvents);
  assert.ok(left.some((e: any) => e.id === master.id), 'the whole series was removed');
  assert.ok(!left.some((e: any) => e.id === occurrence.id), 'the occurrence survived locally');
});

test('deleting the series targets the master', async () => {
  const h = await connected();
  await anEvent(h, { providerEventId: 'series-1', recurrence: ['RRULE:FREQ=WEEKLY'] });
  const occurrence = await anEvent(h, {
    providerEventId: 'series-1_20260912T100000Z', recurringEventId: 'series-1',
  });
  const g = stubGoogle();
  try {
    await h.post(`/calendar/events/${occurrence.id}/propose-delete`, {
      requestId: 'req-del-series', scope: 'series',
    });
    await h.post('/calendar/mutations/req-del-series/confirm');
    const del = g.calls.find((c) => c.method === 'DELETE');
    assert.ok(del!.url.includes('series-1'), 'the series master was not targeted');
    assert.ok(!del!.url.includes('20260912'), 'an occurrence was targeted for a series delete');
  } finally { g.restore(); }
  assert.equal((await h.db.select().from(calendarEvents)).length, 0,
    'the local mirror still holds the deleted series');
});

test('a delete proposal says which occurrences it will remove', async () => {
  const h = await connected();
  const occurrence = await anEvent(h, {
    providerEventId: 'series-1_x', recurringEventId: 'series-1',
  });
  const g = stubGoogle();
  try {
    const one = (await h.post(`/calendar/events/${occurrence.id}/propose-delete`,
      { requestId: 'req-warn-1', scope: 'instance' })).json().proposal;
    assert.match(one.summary.warnings.join(' '), /[Oo]nly this occurrence/);
    const all = (await h.post(`/calendar/events/${occurrence.id}/propose-delete`,
      { requestId: 'req-warn-2', scope: 'series' })).json().proposal;
    assert.match(all.summary.warnings.join(' '), /every event/i);
  } finally { g.restore(); }
});

/* ── Conflicts ────────────────────────────────────────────────────────── */

test('a clash is reported as a warning, not a refusal', async () => {
  const h = await connected();
  const g = stubGoogle({
    freeBusy: {
      status: 200,
      body: {
        calendars: {
          'primary@example.com': {
            busy: [{ start: '2026-09-05T10:30:00Z', end: '2026-09-05T11:30:00Z' }],
          },
        },
      },
    },
  });
  try {
    const r = await h.post('/calendar/events/propose-create', {
      requestId: 'req-clash-1', calendarId: h.cal.id, draft: aDraft(),
    });
    assert.equal(r.statusCode, 200, 'a clash blocked the proposal');
    assert.equal(r.json().proposal.conflicts.length, 1, 'the clash was not reported');
  } finally { g.restore(); }
});

test('calendars that do not block time are not asked about conflicts', async () => {
  /* A birthdays calendar that conflicts with everything makes the warning
   * constant, and a constant warning is no warning. */
  const h = await connected();
  await h.db.update(calendars).set({ countsAsBusy: false }).where(eq(calendars.id, h.cal.id));
  const g = stubGoogle();
  try {
    await h.post('/calendar/events/propose-create', {
      requestId: 'req-nobusy-1', calendarId: h.cal.id, draft: aDraft(),
    });
    assert.ok(!g.calls.some((c) => c.url.includes('/freeBusy')),
      'a calendar that does not count as busy was still queried');
  } finally { g.restore(); }
});

test('busy calendars are a setting, and the default target cannot be read-only', async () => {
  const h = await connected();
  const off = await h.patch(`/calendars/${h.cal.id}/settings`, { countsAsBusy: false });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().calendar.countsAsBusy, false);

  await h.db.update(calendars).set({ isReadOnly: true }).where(eq(calendars.id, h.cal.id));
  const bad = await h.patch(`/calendars/${h.cal.id}/settings`, { isDefaultTarget: true });
  assert.equal(bad.statusCode, 400, 'a read-only calendar became the default for new events');
});

/* ── Webhook ──────────────────────────────────────────────────────────── */

test('a webhook without a matching channel changes nothing', async () => {
  /* The security boundary. An arbitrary POST must not be able to make Life OS
   * act on behalf of a workspace it has no relationship with. */
  const h = await connected();
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/v1/integrations/google-calendar/notifications',
    headers: {
      'x-goog-channel-id': 'not-ours',
      'x-goog-resource-id': 'whatever',
      'x-goog-channel-token': 'guessed',
      'x-goog-resource-state': 'exists',
    },
  });
  // Answered blandly: an unmatched POST looks exactly like a matched one, so
  // this cannot be used to discover which channels exist.
  assert.equal(r.statusCode, 200);
});

test('a webhook with the wrong token is refused even with the right channel', async () => {
  const h = await connected();
  await h.db.insert(calendarWatchChannels).values({
    workspaceId: h.me.workspace.id,
    connectionId: h.conn.id,
    calendarId: h.cal.id,
    channelId: 'los-channel-1',
    resourceId: 'res-1',
    verificationToken: 'the-real-secret',
    status: 'active',
    expiresAt: new Date(Date.now() + 864e5),
  });
  const { resolveChannel } = await import('../src/lib/calendar-watch.js');
  assert.equal(await resolveChannel(h.db, {
    channelId: 'los-channel-1', resourceId: 'res-1', token: 'wrong',
  }), null, 'a wrong token was accepted');
  assert.equal(await resolveChannel(h.db, {
    channelId: 'los-channel-1', resourceId: 'different', token: 'the-real-secret',
  }), null, 'a mismatched resource id was accepted');
  assert.ok(await resolveChannel(h.db, {
    channelId: 'los-channel-1', resourceId: 'res-1', token: 'the-real-secret',
  }), 'the genuine notification was refused');
});

test('the channel token carries no secrets and no identity', () => {
  /* It travels back on every notification. If it encoded the workspace, an
   * intercepted notification would leak it; if it encoded a credential, worse. */
  const src = readFileSync(join('src', 'lib', 'calendar-watch.ts'), 'utf8');
  const fn = src.slice(src.indexOf('async function openWatch'), src.indexOf('export async function renewWatches'));
  // Random, and nothing else: the value handed to Google is the random one.
  assert.match(fn, /const verificationToken = randomBytes\(24\)/, 'the token is not random');
  assert.match(fn, /token: verificationToken,/, 'something other than the random token is sent');
  assert.match(fn, /const channelId = `los-\$\{randomBytes\(16\)/, 'the channel id is guessable');
  // A credential must never be what identifies a channel.
  assert.ok(!/token: (accessToken|refresh|conn\.)/.test(fn),
    'a credential or an identifier is used as the channel token');
});

test('watches open on connect and close on disconnect', async () => {
  const h = await connected();
  const g = stubGoogle();
  try {
    const r = await h.post('/integrations/google-calendar/watch');
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().opened, 1, 'no channel was opened');
    const [ch] = await h.db.select().from(calendarWatchChannels);
    assert.equal(ch.status, 'active');
    assert.ok(ch.expiresAt, 'the channel has no expiry, so it can never be renewed');

    // Opening again is idempotent — a second channel would double every event.
    const again = await h.post('/integrations/google-calendar/watch');
    assert.equal(again.json().opened, 0, 'a duplicate channel was opened');

    const off = await h.post('/integrations/google-calendar/unwatch');
    assert.equal(off.json().stopped, 1);
    assert.equal((await h.db.select().from(calendarWatchChannels)).length, 0,
      'dead channel rows accumulate');
  } finally { g.restore(); }
});

test('renewal replaces a channel before it lapses, and never leaves a gap', async () => {
  const h = await connected();
  const g = stubGoogle();
  try {
    await h.post('/integrations/google-calendar/watch');
    // Bring its expiry inside the renewal margin.
    await h.db.update(calendarWatchChannels)
      .set({ expiresAt: new Date(Date.now() + 3600_000) });

    const { renewWatches } = await import('../src/lib/calendar-watch.js');
    const r = await renewWatches(h.db, { info() {}, warn() {}, error() {} });
    assert.equal(r.renewed, 1, 'the expiring channel was not replaced');

    const rows = await h.db.select().from(calendarWatchChannels);
    const active = rows.filter((x: any) => x.status === 'active');
    assert.equal(active.length, 1, `${active.length} active channels after renewal`);
    assert.ok(active[0].expiresAt!.getTime() > Date.now() + 864e5,
      'the replacement expires as soon as the old one');
  } finally { g.restore(); }
});

test('renewal is scheduled, not hoped for', () => {
  const sched = readFileSync(join('src', 'lib', 'calendar-scheduler.ts'), 'utf8');
  assert.match(sched, /renewWatches\(db, log\)/, 'nothing ever renews a watch channel');
  assert.match(sched, /RENEW_TICK_MS/, 'renewal has no timer');
});

/* ── Task ↔ Event ─────────────────────────────────────────────────────── */

test('a task and its event are linked, and neither becomes the other', async () => {
  const h = await connected();
  const task = (await h.post('/tasks', { title: 'Meet landscaper', bucket: 'today' })).json().task;
  const g = stubGoogle();
  try {
    await h.post('/calendar/events/propose-create', {
      requestId: 'req-task-1', calendarId: h.cal.id,
      draft: aDraft({ title: 'Meet landscaper' }),
    });
    const r = await h.post('/calendar/mutations/req-task-1/confirm', { taskId: task.id });
    assert.equal(r.statusCode, 200, r.body);
  } finally { g.restore(); }

  const linked = (await h.get(`/tasks/${task.id}/calendar`)).json();
  assert.equal(linked.events.length, 1, 'the task shows no calendar context');
  assert.equal(linked.events[0].title, 'Photography Session');

  // The task is still a task: it has not been converted or dated by this.
  const back = (await h.get('/tasks?includeCompleted=false')).json()
    .tasks.find((t: any) => t.id === task.id);
  assert.ok(back, 'the task disappeared when it was scheduled');
  assert.equal(back.dueDate, null, 'scheduling silently set a due date');
});

test('unlinking removes the relationship and nothing else', async () => {
  const h = await connected();
  const task = (await h.post('/tasks', { title: 'Meet landscaper', bucket: 'today' })).json().task;
  const g = stubGoogle();
  try {
    await h.post('/calendar/events/propose-create', {
      requestId: 'req-unlink-1', calendarId: h.cal.id, draft: aDraft(),
    });
    await h.post('/calendar/mutations/req-unlink-1/confirm', { taskId: task.id });
  } finally { g.restore(); }

  const [event] = await h.db.select().from(calendarEvents);
  const r = await h.app.inject({
    method: 'DELETE', headers: auth(),
    url: `/api/v1/workspaces/${h.me.workspace.id}/tasks/${task.id}/calendar/${event.id}`,
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await h.get(`/tasks/${task.id}/calendar`)).json().events.length, 0);
  // Unlinking is not deleting: both sides survive.
  assert.equal((await h.db.select().from(calendarEvents)).length, 1,
    'unlinking deleted the Google event');
  assert.ok((await h.get('/tasks?includeCompleted=false')).json()
    .tasks.some((t: any) => t.id === task.id), 'unlinking deleted the task');
});

test('a due date is not an event time', () => {
  /* "Due Friday" and "calendar block Friday 14:00" are different statements,
   * and conflating them makes both untrustworthy. Nothing in the task routes
   * may move a linked event. */
  const tasksSrc = readFileSync(join('src', 'routes', 'tasks.ts'), 'utf8');
  for (const forbidden of ['executeMutation', 'patchEvent', 'proposeUpdateEvent', 'calendarMutations']) {
    assert.ok(!tasksSrc.includes(forbidden),
      `changing a task reaches for ${forbidden}, so a due date can move an event`);
  }
});

/* ── The client ───────────────────────────────────────────────────────── */

test('the composer proposes, and only the confirmation writes', () => {
  const src = read('event-composer.js');
  assert.match(src, /propose-create/);
  assert.match(src, /\/confirm/);
  // The form itself must never call confirm.
  const composer = src.slice(src.indexOf('export async function openEventComposer'),
    src.indexOf('function backToForm'));
  assert.ok(!composer.includes('/confirm'), 'the composer writes without a confirmation');
  assert.match(composer, /confirmProposal\(proposal/);
});

test('a failed proposal returns to the form with everything still in it', () => {
  /* Losing what somebody typed, to explain a problem they did not cause, is
   * its own bug. */
  const src = read('event-composer.js');
  const composer = src.slice(src.indexOf('export async function openEventComposer'),
    src.indexOf('function backToForm'));
  assert.match(composer, /catch \(e\) \{[\s\S]{0,120}continue;/,
    'a rejected proposal drops the draft');
  assert.match(src, /function backToForm/, 'nothing restores the form state');
});

test('creation goes to Google, never to a local events table', () => {
  /* The core rule. A real event is Google-backed; a local row that looks like
   * an event and exists nowhere else is worse than an error. */
  const app = read('app.js');
  const menu = app.slice(app.indexOf('function calendarAddMenu'), app.indexOf('/** Reminders are'));
  assert.match(menu, /openEventComposer/, 'Add still creates a local event');
  assert.ok(!/openEvent\(null/.test(menu), 'the local event modal is still the creation path');
});

test('the UI never offers to edit what Google will not let it', () => {
  const app = read('app.js');
  const fn = app.slice(app.indexOf('function openEventDetail(ev)'), app.indexOf('const prettyDay ='));
  assert.match(fn, /fromGmail/, 'Gmail events are offered an edit button');
  assert.match(fn, /birthday/);
  assert.match(fn, /calendarReadOnly/, 'a read-only calendar still offers Edit');
  assert.match(fn, /editable \? \[/, 'the actions are unconditional');
});

test('Reminders stay Life OS-only', () => {
  /* They have no duration, no calendar and no guests. Pouring one into Google
   * would imply all three, and quietly put a private note on a shared calendar. */
  const app = read('app.js');
  const from = app.indexOf('function addReminder(');
  const fn = app.slice(from, app.indexOf('\nfunction ', from + 30));
  assert.ok(fn.length > 40, 'the reminder function could not be located');
  for (const forbidden of ['openEventComposer', 'propose-create', 'insertEvent']) {
    assert.ok(!fn.includes(forbidden), `a reminder reaches for ${forbidden}`);
  }
  // And the API side never turns one into a Google event either.
  const remindersRoute = readFileSync(join('src', 'routes', 'calendar.ts'), 'utf8');
  const reminderPart = remindersRoute.slice(remindersRoute.indexOf('reminders'));
  assert.ok(!reminderPart.includes('insertEvent'), 'a reminder is written to Google');
});

test('the composer sends a body the API can actually parse', () => {
  /* `api()` stringifies the body itself. The composer's adapter stringified it
   * too, so every write went out as a QUOTED JSON STRING — which Fastify
   * parsed as a string and Zod rejected. Create, edit and delete would all
   * have failed with a validation error, and nothing in the type system or the
   * server tests could see it, because the fault was in the seam between two
   * helpers that each looked right alone. */
  const app = read('app.js');
  const adapter = app.slice(app.indexOf('_initComposer: initEventComposer('),
    app.indexOf('connectGoogle: () =>'));
  assert.ok(!adapter.includes('JSON.stringify'),
    'the composer stringifies a body that api() will stringify again');
  assert.match(adapter, /api: \(path, opts = \{\}\) => api\(/, 'the adapter no longer forwards opts');

  // And api() is still the one doing it, so the body must arrive as an object.
  const api = app.slice(app.indexOf('async function api(path, opts = {})'),
    app.indexOf('async function api(path, opts = {})') + 900);
  assert.match(api, /body: hasBody \? JSON\.stringify\(opts\.body\)/,
    'api() no longer stringifies, so the adapter must');
});

test('calendar settings are stored server-side, not per-device', () => {
  /* The assistant will need to know where to propose an event and what counts
   * as a clash. A preference in one browser's localStorage is not an answer it
   * can read. */
  const app = read('app.js');
  const fns = app.slice(app.indexOf('async function setDefaultCalendar('),
    app.indexOf('async function setCalendarVisible('));
  assert.match(fns, /calendars\/\$\{id\}\/settings/, 'the setting never reaches the server');
  assert.ok(!/localStorage/.test(fns), 'a calendar setting is kept in the browser');

  // The two checkbox families must not share a selector.
  const wire = app.slice(app.indexOf('function wireSources(el)'),
    app.indexOf('function wireRemindersView()'));
  assert.match(wire, /\.cs-vis/, 'visibility is not wired');
  assert.match(wire, /\.cs-busy/, 'counts-as-busy is not wired');
  assert.ok(!/querySelectorAll\('\[data-calendar\]'\)/.test(wire),
    'one selector catches both checkbox families, so ticking one does the other');
});

test('the webhook address is derived, so it cannot be forgotten', () => {
  /* A missing variable meant watches silently never opened — invisible until
   * somebody noticed the calendar was five minutes behind. The redirect URI
   * already names this API and is already HTTPS. */
  const src = readFileSync(join('src', 'lib', 'calendar-watch.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function webhookUrl'), src.indexOf('export const webhookConfigured'));
  assert.match(fn, /GOOGLE_CALENDAR_REDIRECT_URI/, 'the address is not derived from anything');
  assert.match(fn, /u\.protocol !== 'https:'/, 'a non-HTTPS address would be registered');
  assert.match(fn, /GOOGLE_CALENDAR_WEBHOOK_URL/, 'the explicit override was dropped');
});
