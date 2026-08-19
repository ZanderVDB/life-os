/**
 * Google Calendar read-only integration (Phase D4.1).
 *
 * The security-shaped assertions here are the point of the file. A write scope
 * that creeps in, a secret that reaches the frontend, or a token that lands in
 * a log line are all things that would be very hard to notice by looking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encryptToken, decryptToken, isEncrypted, redactTokens } from '../src/lib/token-crypto.js';
import { maskEmail } from '../src/routes/google-calendar.js';
import * as G from '../src/lib/google-calendar.js';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const route = readFileSync(join('src', 'routes', 'google-calendar.ts'), 'utf8');
/* The sync engine moved out of the route when it gained a second caller: the
 * background scheduler. The rules below are unchanged — only their address is. */
const engine = readFileSync(join('src', 'lib', 'calendar-sync.ts'), 'utf8');
const client = readFileSync(join('src', 'lib', 'google-calendar.ts'), 'utf8');
const crypto = readFileSync(join('src', 'lib', 'token-crypto.ts'), 'utf8');
const calendar = read('calendar.js');
const app = read('app.js');
const html = read('index.html');

/** The source of one declaration, so a rule can be asserted where it lives. */
function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `${decl} not found`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:async )?(?:export )?(?:function |const \w+ = )/);
  return end === -1 ? rest : rest.slice(0, end);
}
const reminderModal = read('reminder-modal.js');
const pickers = read('pickers.js');
const hover = read('hover-preview.js');

const KEY = 'test-key-that-is-definitely-long-enough-32';

/* ── Scope and write safety ──────────────────────────────────────────── */

test('scopes: the narrowest set that can do the job, and no wider', () => {
  /* Writing is now the product. What has to stay true is that the grant is
   * still the SMALLEST one that supports it: events on calendars the user
   * already has, the calendar list, and availability. Nothing that could
   * create a calendar, delete one, or change who it is shared with. */
  assert.deepEqual([...G.GOOGLE_SCOPES], [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.freebusy',
  ]);
  // calendar.readonly would ALSO hand over every event on every calendar, for
  // no benefit over calendar.events plus the list scope.
  assert.ok(!G.GOOGLE_SCOPE.includes('auth/calendar.readonly'),
    'the broad read scope is still requested alongside the narrow ones');

  const requested = client.slice(client.indexOf('export const GOOGLE_SCOPES'),
    client.indexOf('export const GOOGLE_SCOPE ='));
  for (const bad of [
    "auth/calendar'", 'auth/calendar"', 'calendar.app.created',
    'calendar.acls', 'calendar.calendars', 'calendar.settings',
  ]) {
    assert.ok(!requested.includes(bad), `an over-broad scope is requested: ${bad}`);
  }
  // A scope change must bump the version, or existing tokens silently cannot write.
  assert.ok(G.SCOPES_VERSION >= 2, 'the scope set changed without bumping SCOPES_VERSION');
});

test('write safety: two chokepoints, and nothing writes around them', () => {
  /* Reads go through `get`; writes go through `send`. Both are private to this
   * module, so "what can this code do to somebody's calendar" is answerable by
   * reading two functions rather than auditing every call site.
   *
   * The old version of this test asserted no write path existed at all. That
   * was the right invariant when the integration was read-only and is the
   * wrong one now — but the thing it was really protecting, that a write
   * cannot happen somewhere nobody is looking, still holds. */
  assert.match(client, /async function get\(accessToken/, 'no single GET chokepoint');
  assert.match(client, /async function send\(accessToken/, 'no single write chokepoint');

  /* Six fetches, and every one of them has a name: the two chokepoints, the
   * token exchange, revocation, the account-email lookup and channels.stop.
   * A seventh would be something reaching past get/send. */
  const owners = ['tokenRequest', 'async function get(', 'async function send(',
    'revokeToken', 'fetchAccountEmail', 'stopChannelRaw'];
  for (const owner of owners) {
    assert.ok(client.includes(owner), `${owner} is gone — the fetch budget below is stale`);
  }
  const fetches = client.match(/await fetch\(/g) ?? [];
  assert.equal(fetches.length, owners.length,
    `${fetches.length} fetch calls for ${owners.length} known owners — one bypasses get/send`);

  // The write helpers exist and are the ONLY exported way to mutate.
  for (const fn of ['insertEvent', 'patchEvent', 'deleteEvent']) {
    assert.ok(client.includes(`export const ${fn}`), `${fn} is missing`);
  }
  assert.ok(!/export const createEvent|export async function createEvent/.test(client),
    'a second creation helper exists');
});

test('write safety: only the mutation service may call Google write helpers', () => {
  /* This is the rule the whole Calendar phase rests on, and the one the
   * assistant will later be held to. If a route could call insertEvent
   * directly, then "every write is confirmed first" would be a convention
   * rather than a fact, and conventions do not survive contact with a model
   * that is trying to be helpful. */
  const callers = ['routes/google-calendar.ts', 'routes/calendar.ts',
    'routes/calendar-write.ts', 'routes/tasks.ts', 'routes/projects.ts',
    'lib/calendar-sync.ts', 'lib/calendar-scheduler.ts', 'lib/calendar-watch.ts'];
  for (const file of callers) {
    const src = readFileSync(join('src', ...file.split('/')), 'utf8');
    for (const fn of ['insertEvent', 'patchEvent', 'deleteEvent']) {
      assert.ok(!src.includes(`${fn}(`),
        `${file} calls ${fn} directly, going around the mutation service`);
    }
  }
  // And the service itself is the one place that does.
  const service = readFileSync(join('src', 'lib', 'calendar-mutations.ts'), 'utf8');
  for (const fn of ['insertEvent', 'patchEvent', 'deleteEvent']) {
    assert.ok(service.includes(`G.${fn}(`), `the mutation service never calls ${fn}`);
  }
});

test('write safety: ACLs and calendar management are never touched', () => {
  /* Events on calendars, never the calendars themselves. Life OS has no
   * business creating, deleting or re-sharing a calendar, and the absence of
   * the code path is a stronger guarantee than the absence of the scope. */
  for (const forbidden of ['/acl', 'calendars/insert', 'calendarList/insert',
    '/settings', 'calendarList/delete']) {
    assert.ok(!client.includes(forbidden), `the client touches ${forbidden}`);
  }
});

/* ── OAuth flow ──────────────────────────────────────────────────────── */

test('oauth: PKCE challenge is S256 and the verifier never leaves the server', () => {
  const { verifier, challenge } = G.createPkce();
  assert.ok(verifier.length >= 43, 'verifier is too short for PKCE');
  assert.notEqual(verifier, challenge, 'the challenge is the raw verifier');
  assert.match(client, /code_challenge_method: 'S256'/, 'PKCE is not S256');
  // The connect response hands back a URL and a scope. Nothing else.
  assert.match(route, /return \{ authorizeUrl:[^}]*scope: G\.GOOGLE_SCOPE \}/,
    'the connect response may leak more than the authorize URL');
  // Scoped to the connect handler: the callback legitimately reads
  // entry.verifier server-side in order to complete the exchange.
  const connect = route.slice(route.indexOf("/connect'"), route.indexOf('/* ── Callback'));
  assert.ok(!/verifier/.test(connect.slice(connect.indexOf('return {'))),
    'the PKCE verifier is returned to the browser');
});

test('oauth: offline access is requested so a refresh token actually arrives', () => {
  assert.match(client, /access_type: 'offline'/, 'no refresh token will be issued');
  assert.match(client, /prompt: 'consent'/, 'reconnect would arrive without a refresh token');
  assert.match(route, /if \(!set\.refreshToken\) return fail\('no_lasting_grant'\)/,
    'a connection without a refresh token is accepted');
});

test('oauth: state is single-use, expiring, and required', () => {
  assert.match(route, /pending\.delete\(q\.state\)/, 'state is not consumed');
  // Consumed BEFORE the exchange, so a replay cannot race a slow exchange.
  const cb = route.slice(route.indexOf('callback'), route.indexOf('exchangeCode'));
  assert.ok(cb.indexOf('pending.delete') < cb.length, 'state is consumed after the exchange');
  assert.match(route, /if \(!entry\) return fail\('expired_state'\)/, 'unknown state is accepted');
  assert.match(route, /if \(!q\.code \|\| !q\.state\) return fail/, 'a missing state is accepted');
  assert.match(route, /expiresAt: Date\.now\(\) \+ 10 \* 60_000/, 'state never expires');
});

test('oauth: the granted scope is verified, not assumed', () => {
  /* This test used to pin the exact line that did the checking — and so it
   * kept passing when that line stopped working. GOOGLE_SCOPE became a joined
   * string of three scopes while `set.scopes` stayed an array, making the
   * comparison false forever and rejecting every valid connection; the
   * assertion saw the line it wanted and said nothing.
   *
   * So it now asserts the BEHAVIOUR instead. A partial grant must be refused,
   * a complete one accepted, and the check must not be the string comparison
   * that silently broke. */
  assert.match(route, /G\.grantSatisfies\(set\.scopes\)/, 'the grant is not verified');
  assert.match(route, /if \(!grant\.ok\)/, 'an incomplete grant is treated as success');
  assert.ok(!/set\.scopes\.includes\(G\.GOOGLE_SCOPE\)/.test(route),
    'comparing the scope array against the joined request string is back');

  assert.equal(G.grantSatisfies([...G.GOOGLE_SCOPES]).ok, true, 'a full grant is refused');
  assert.equal(G.grantSatisfies([]).ok, false, 'an empty grant is accepted');
  assert.equal(G.grantSatisfies(['https://www.googleapis.com/auth/calendar.readonly']).ok, false,
    'a read-only grant is accepted for a product that must write');
});

test('oauth: user denial and Google errors redirect with a reason', () => {
  assert.match(route, /q\.error === 'access_denied' \? 'declined'/, 'denial is not handled');
  assert.match(route, /calendar=error&reason=/, 'errors do not reach the UI');
});

/* ── Secrets ─────────────────────────────────────────────────────────── */

test('secrets: nothing Google-related reaches the frontend', () => {
  const server = read('server.js');
  const config = read('config.js');
  for (const [name, src] of [['app.js', app], ['calendar.js', calendar],
    ['server.js', server], ['config.js', config], ['index.html', html]] as const) {
    for (const secret of ['GOOGLE_CALENDAR_CLIENT_SECRET', 'client_secret',
      'TOKEN_ENCRYPTION_KEY', 'refresh_token']) {
      assert.ok(!src.includes(secret), `${name} references ${secret}`);
    }
  }
  // The browser asks for a URL; it never builds one.
  assert.ok(!/accounts\.google\.com/.test(app), 'the frontend builds the Google URL itself');
  assert.match(app, /integrations\/google-calendar\/connect/, 'the connect call is missing');
});

test('secrets: tokens cannot be logged', () => {
  assert.match(route, /redactTokens/, 'errors are logged unredacted');
  const r = redactTokens({
    access_token: 'ya29.secret', refresh_token: '1//secret',
    nested: { client_secret: 'shh', keep: 'visible' },
  }) as any;
  assert.equal(r.access_token, '[redacted]');
  assert.equal(r.refresh_token, '[redacted]');
  assert.equal(r.nested.client_secret, '[redacted]');
  assert.equal(r.nested.keep, 'visible', 'redaction is too aggressive');
});

test('secrets: the account email is masked before it reaches the UI', () => {
  // One visible character, the rest replaced, domain left intact so the user
  // can still tell which account is connected.
  const masked = maskEmail('zander@gmail.com')!;
  assert.ok(masked.startsWith('z'), 'the mask hides the first character too');
  assert.ok(masked.endsWith('@gmail.com'), 'the domain is hidden');
  assert.ok(!masked.includes('ander'), 'the local part is still readable');
  assert.equal(maskEmail(null), null);
  assert.match(route, /accountEmail: maskEmail\(c\.accountEmail\)/,
    'the raw address is sent to the browser');
});

/* ── Token encryption ────────────────────────────────────────────────── */

test('crypto: tokens round-trip and are authenticated', () => {
  const token = '1//0abcdefghijklmnop-refresh-token';
  const enc = encryptToken(token, KEY);
  assert.notEqual(enc, token, 'the token is stored in plain text');
  assert.ok(isEncrypted(enc), 'the stored form is not recognisable');
  assert.equal(decryptToken(enc, KEY), token, 'the token does not round-trip');
  // Same input twice must differ — a fixed IV would leak equality.
  assert.notEqual(encryptToken(token, KEY), encryptToken(token, KEY), 'the IV is not random');
});

test('crypto: tampering and wrong keys fail loudly', () => {
  const enc = encryptToken('secret-token', KEY);
  const parts = enc.split('.');
  const tampered = [parts[0], parts[1], parts[2],
    Buffer.from('different-ciphertext').toString('base64')].join('.');
  assert.throws(() => decryptToken(tampered, KEY), 'a tampered ciphertext decrypts');
  assert.throws(() => decryptToken(enc, `${KEY}-wrong`), 'the wrong key decrypts');
  assert.throws(() => decryptToken('not-encrypted', KEY), 'garbage is accepted');
});

test('crypto: a weak key is refused rather than quietly used', () => {
  assert.throws(() => encryptToken('x', 'short'), /at least 32/,
    'a short encryption key is accepted');
});

test('crypto: the key-rotation limitation is documented, not hidden', () => {
  assert.match(crypto, /KEY ROTATION/, 'the rotation limitation is undocumented');
  const debt = readFileSync(join('..', 'docs', 'technical-debt.md'), 'utf8');
  assert.match(debt, /rotat/i, 'key rotation is not in technical-debt.md');
});

/* ── Sync ────────────────────────────────────────────────────────────── */

test('sync: pagination is followed for calendars and events', () => {
  assert.match(client, /do \{[\s\S]*?pageToken = page\.nextPageToken;[\s\S]*?\} while \(pageToken\)/,
    'calendar list pagination is missing');
  const ev = client.slice(client.indexOf('export async function listEvents'));
  assert.match(ev, /while \(pageToken\)/, 'event pagination is missing');
});

test('sync: recurring series are expanded but keep their identity', () => {
  assert.match(client, /singleEvents: 'true'/, 'recurring events are not expanded');
  assert.match(client, /recurringEventId/, 'the series link is lost');
  assert.match(client, /originalStartTime/, 'the instance identity is lost');
});

test('sync: an all-day end date is converted from exclusive to inclusive', () => {
  // Google's all-day end is exclusive; a one-day event would otherwise
  // render across two days.
  assert.match(client, /shiftDay\(ev\.end\.date, -1\)/, 'the exclusive end is not adjusted');
  const m = G.mapEvent({
    id: 'x', summary: 'Holiday',
    start: { date: '2026-08-05' }, end: { date: '2026-08-06' },
  })!;
  assert.equal(m.startDate, '2026-08-05');
  assert.equal(m.endDate, '2026-08-05', 'a one-day all-day event spans two days');
});

test('sync: cancelled events are removed, not left behind', () => {
  assert.match(engine, /if \(raw\.status === 'cancelled'\)/, 'cancellations are ignored');
  assert.match(engine, /db\.delete\(calendarEvents\)/, 'cancelled events are not removed');
  assert.match(client, /showDeleted: opts\.syncToken \? 'true' : undefined/,
    'incremental sync does not ask for deletions');
});

test('sync: an invalid sync token triggers a full resync without emptying anything', () => {
  assert.match(client, /export const isSyncTokenInvalid/, 'a 410 is not detected');
  assert.match(client, /e\.status === 410/, '410 is not the invalidation signal');
  const fn = engine.slice(engine.indexOf('async function syncEvents'));
  assert.match(fn, /fullResync = true/, 'no full resync path');
  // Critically: no delete-then-refill, which would blank the calendar.
  const recovery = fn.slice(fn.indexOf('isSyncTokenInvalid'), fn.indexOf('let created'));
  assert.ok(!/db\.delete/.test(recovery), 'the resync empties the calendar first');
});

test('sync: upserts are idempotent, so re-running cannot duplicate', () => {
  assert.match(engine, /onConflictDoUpdate\(\{\s*target: \[calendarEvents\.calendarId, calendarEvents\.providerEventId\]/,
    'events are not upserted on provider identity');
  assert.match(engine, /onConflictDoUpdate\(\{\s*\n?\s*target: \[calendars\.workspaceId, calendars\.providerCalendarId\]/,
    'calendars are not upserted on provider identity');
});

test('sync: one failing calendar does not abort the rest', () => {
  assert.match(engine, /result\.errors\.push\(c\.name\)/, 'a failure aborts the whole sync');
});

test('sync: read-only is derived from the access role, once', () => {
  assert.match(client, /export const roleIsReadOnly = \(role: string\) =>\s*role !== 'owner' && role !== 'writer'/,
    'read-only is not derived from the Google role');
  assert.match(engine, /isReadOnly: G\.roleIsReadOnly\(c\.accessRole\)/,
    'the stored calendar does not record read-only');
});

/* ── Disconnect ──────────────────────────────────────────────────────── */

test('disconnect: revokes, clears credentials, and keeps Life OS data', () => {
  const fn = route.slice(route.indexOf('/disconnect'));
  assert.match(fn, /G\.revokeToken/, 'the Google grant is not revoked');
  assert.match(fn, /db\.delete\(calendarConnections\)/, 'stored credentials survive disconnect');
  // Only Google's projections go. Tasks, habits, reminders and blocks stay.
  assert.match(fn, /eq\(calendars\.connectionId, conn\.id\)/,
    'disconnect removes calendars it does not own');
  for (const safe of ['tasks', 'habits', 'reminders', 'taskScheduleBlocks']) {
    assert.ok(!new RegExp(`db\\.delete\\(${safe}\\)`).test(fn),
      `disconnect deletes ${safe}`);
  }
});

/* ── UI corrections ──────────────────────────────────────────────────── */

test('ui: no browser prompt, confirm or alert for normal creation', () => {
  assert.ok(!/window\.prompt|[^.]\bprompt\(/.test(app), 'a browser prompt is still used');
  assert.match(app, /openReminderModal/, 'the reminder modal is not wired');
  assert.match(reminderModal, /role', 'dialog'/, 'the reminder modal is not a dialog');
  assert.match(reminderModal, /aria-modal/, 'the reminder modal is not modal');
  // Confirm survives only for destructive actions, which is legitimate. The
  // message is sometimes built into a variable on an earlier line, so each
  // call site is judged with a few lines of context rather than one line.
  const lines = app.split('\n');
  const DESTRUCTIVE = /Delete|Remove|Disconnect|Archive|Sign out|unsaved|cannot be undone/i;
  lines.forEach((line, i) => {
    if (!line.includes('confirm(')) return;
    const context = lines.slice(Math.max(0, i - 6), i + 1).join(' ');
    assert.ok(DESTRUCTIVE.test(context),
      `confirm() used for a non-destructive action: ${line.trim().slice(0, 60)}`);
  });
});

test('ui: the Month cell habit mark is a RATIO, never a list or a dot', () => {
  // History: D4.1 demoted a green count to a faint arc, and D4.2 removed even
  // that — an unlabelled mark repeated in every cell that nobody could read.
  //
  // E2.4 restores it as `3/5`, which is the thing the arc was not: a number
  // with a denominator, so it says what it means without a legend. The arc
  // must not come back, and the cell must never list habit names — five names
  // repeated across thirty-one squares is the noise D4.2 was right about.
  assert.ok(!calendar.includes('cm-habit-dot'), 'the unreadable habit arc is back');
  assert.match(calendar, /habitSummaryHtml/, 'the Month cell habit summary is gone');
  assert.match(calendar, /\$\{habit\.done\}\/\$\{habit\.due\}/,
    'the Month cell mark is not a done/due ratio');
  // `due`, not the total number of habits: a Monday-only habit is not owed on
  // a Thursday, and counting it there invents a miss.
  assert.ok(!/habitTotal/.test(calendar), 'the cell is counting all habits, not the ones due');
});

test('ui: an empty or future day gets NO habit mark', () => {
  const fn = body(calendar, 'function habitSummaryHtml(habit, day, todayIso)');
  // "0/0" for a day that asked nothing, and "0/5" printed across every day of
  // the rest of the month, are both worse than a blank square.
  assert.match(fn, /!habit\.due \|\| day > todayIso/,
    'days with nothing due, or days still to come, are being marked');
});

test('ui: the selected day lists habits and every one can be ticked', () => {
  // The row markup is shared now, so a habit created later ticks exactly like
  // one that existed at the time — same control, same day, same behaviour.
  const row = body(calendar, 'function habitRowHtml(h, day, later = false)');
  assert.match(row, /data-habit="\$\{h\.id\}"/, 'habit rows are not identified');
  assert.match(row, /data-habit-day="\$\{day\}"/,
    'the row does not carry the day, so a tick cannot land on a past date');
  assert.match(row, /aria-pressed/, 'the tick state is not exposed to assistive tech');

  const fn = body(calendar, 'function habitCardHtml(day)');
  assert.match(fn, /filter\(\(h\) => h\.dueToday\)/, 'the card is not filtered to what was due');
});

test('ui: a habit created after the day does not rewrite that day', () => {
  /* Creating a habit today must not retroactively turn every past day into a
   * failure. It is still SHOWN — you may have been doing it already — but it
   * sits below the line and only joins the count if you actually tick it,
   * which is why "5/4" is possible and honest. */
  const fn = body(calendar, 'function habitCardHtml(day)');
  assert.match(fn, /filter\(\(h\) => !h\.createdAfter\)/,
    'a later habit is counted in a day it did not exist for');
  assert.match(fn, /const later = dueAll\.filter\(\(h\) => h\.createdAfter\)/,
    'later habits are dropped instead of shown');
  assert.match(fn, /const total = due\.length/, 'the denominator includes later habits');
  assert.match(fn, /laterDone/, 'ticking a later habit does not count');
  assert.match(fn, /Created later/, 'later habits are not set apart');

  // From the real creation date, never inferred from a first completion.
  const habits = readFileSync(join('src', 'routes', 'habits.ts'), 'utf8');
  assert.match(habits, /const createdOn = h\.createdAt\.toISOString\(\)/,
    'creation is inferred rather than read');
  assert.match(habits, /createdAfter: createdOn > today/);
});

test('ui: the selected day is a tint and a border, not a heavy fill', () => {
  assert.match(html, /\.cm-cell\.is-selected\{border-color:var\(--accent\);background:rgba\(138,93,255,\.07\)/,
    'the selected day is not restrained');
  // The refined rule must come AFTER the original, so it is the one that wins.
  const heavy = html.indexOf('.cm-cell.is-selected{border-color:var(--accent);background:var(--accent-soft)');
  const refined = html.indexOf('.cm-cell.is-selected{border-color:var(--accent);background:rgba(138,93,255,.07)');
  assert.ok(refined > heavy, 'the heavy accent fill still wins');
});

test('ui: hover previews replace native tooltips entirely', () => {
  assert.match(hover, /initHoverPreview/, 'no hover preview system');
  assert.ok(!/title="\$\{esc\(e\.title\)\}"/.test(calendar), 'native title tooltips remain');
  // Keyboard parity is the requirement, not a nicety.
  assert.match(hover, /focusin/, 'focus does not open the preview');
  assert.match(hover, /pointerType !== 'mouse'/, 'touch triggers hover previews');
  assert.match(hover, /aria-describedby/, 'the preview is not announced');
  assert.match(hover, /OPEN_DELAY/, 'the preview opens with no delay');
});

test('ui: no developer-facing language in normal product UI', () => {
  // "Synthetic data. No Google account is connected." was shipped to the rail.
  const rail = calendar.slice(calendar.indexOf('function agendaRailHtml'),
    calendar.indexOf('function lastSyncedWord'));
  // Only text a user can READ. `isSynthetic` is a field name inside a filter,
  // not a word on screen, so match the literal strings between tags.
  const visible = (rail.match(/>[^<>{}`$]{4,}</g) ?? []).join(' ');
  for (const word of ['synthetic', 'staging', 'mock', 'seed', 'dev ']) {
    assert.ok(!new RegExp(word, 'i').test(visible),
      `the sources card says "${word}" to the user`);
  }
  assert.match(rail, /Connect Google Calendar/, 'there is no connect affordance');
  assert.match(rail, /cannot create, change or delete/i, 'read-only is not explained');
});

test('ui: the plan queue is cards with a non-drag path', () => {
  assert.match(calendar, /function queueCardHtml/, 'the queue is not card-based');
  assert.match(calendar, /data-schedule=/, 'there is no non-drag schedule action');
  assert.match(calendar, /tabindex="0"/, 'queue cards are not keyboard reachable');
  assert.match(html, /\.pq-card\{/, 'queue cards have no styling');
  assert.match(app, /function scheduleFromQueue/, 'the schedule action is not wired');
});

test('ui: free windows ignore slivers that are not usable work time', () => {
  const fn = calendar.slice(calendar.indexOf('function freeWindows'));
  assert.match(fn, /b - a >= 30/, 'a five-minute gap counts as a free window');
});

test('ui: the event editor is wider and its scrollbar is styled', () => {
  assert.match(html, /\.modal-event\{width:min\(720px/, 'the editor is still narrow');
  assert.match(html, /\.ev-body::-webkit-scrollbar-thumb\{background:var\(--border-strong\)/,
    'the bright native scrollbar remains');
  assert.match(html, /scrollbar-color:var\(--border-strong\) transparent/,
    'Firefox keeps the native scrollbar');
});

test('ui: pickers are shared, so the two editors cannot drift apart', () => {
  assert.match(pickers, /export function datePickerPopover/, 'no shared date picker');
  assert.match(pickers, /export function timePickerPopover/, 'no shared time picker');
  for (const f of ['event-modal.js', 'reminder-modal.js']) {
    assert.match(read(f), /from '\.\/pickers\.js'/, `${f} has its own picker`);
  }
  // Keyboard operation is part of the contract.
  assert.match(pickers, /ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7/,
    'the date grid is not keyboard operable');
});

test('ui: the add menu offers three types and none that do nothing', () => {
  const em = read('event-modal.js');
  for (const k of ["'event'", "'reminder'", "'task'"]) {
    assert.ok(em.includes(k), `the add menu is missing ${k}`);
  }
  assert.ok(!em.includes("'habit'"), 'Habit creation returned to the Calendar Add menu');
  assert.match(em, /\.filter\(\(\[k\]\) => handlers\[k\]\)/, 'an entry can appear with no handler');
  assert.match(em, /cm-add-ico/, 'menu entries have no icon');
  assert.match(em, /onEsc/, 'Escape does not close the add menu');
});
