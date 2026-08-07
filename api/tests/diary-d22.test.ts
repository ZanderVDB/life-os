/**
 * Phase D2.2 — the Library regression, the Diary spread's height, and the
 * computed habit becoming part of the habit SYSTEM.
 *
 * Three defects reported from authenticated staging, and one thing joins them:
 * **something knew the right answer and something else was allowed to overrule
 * it.** A hash write overruled the navigation that made it. A viewport formula
 * overruled the content it was meant to frame. A locally-counted total overruled
 * a row that was already complete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import {
  writtenDays, diaryStreak, diaryHabitSince, addDiaryToHabitDays,
  diaryHabitEnabled, habitTotals, diaryHabitRow, DIARY_HABIT_ID,
} from '../src/lib/diary-habit.js';
import { previewOf } from '../src/routes/diary.js';
import { PREFERENCE_SCHEMA } from '../src/routes/preferences.js';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const app = code(read('app.js'));
const libView = code(read('library-view.js'));
const diaView = code(read('diary-view.js'));
const checkin = code(read('diary-checkin.js'));
const historyJs = code(read('diary-history.js'));
const calJs = code(read('calendar.js'));
const settingsJs = code(read('settings.js'));
const html = read('index.html');

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = (email = 'd22@example.com') => ({
  authorization: `Bearer ${TOKEN}`, 'x-dev-email': email,
});

async function setup(email?: string) {
  const { db } = await freshDb();
  const server = buildApp(db, env);
  await server.ready();
  const me = (await server.inject({ method: 'GET', url: '/api/v1/me', headers: auth(email) })).json();
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await server.inject({
      method: method as any, url, headers: auth(email), payload: payload as any,
    });
    return { status: r.statusCode, body: r.json() };
  };
  return { db, me, ws: me.workspace.id, call };
}

const doc = (text: string) =>
  ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph', content: [] }] };

/* ══ §1 THE LIBRARY REGRESSION ═════════════════════════════════════════
 *
 * ROOT CAUSE. Three modules wrote `location.hash` and each kept a private flag
 * saying "that one was mine". The shell's hashchange handler could only see
 * app.js's. So a hash Library wrote about where the person already was —
 * opening a Book, turning a page — was counted as a NAVIGATION, bumped the
 * token, and invalidated the render that had just written it. `loadBook`
 * returned, found itself stale, and left `Opening…` above a skeleton for ever.
 */

test('one module owns hash writes, and the answer is given once', () => {
  const nav = code(read('nav.js'));
  assert.match(nav, /export function setHash\(next\)/);
  assert.match(nav, /export function hashWasOurs\(/);
  // Consumed, so it is true exactly once per write — a second caller would be
  // told "no" and would treat our own write as a navigation.
  assert.match(nav, /pendingWrites\.splice\(at, 1\)/);
  // A hashchange that never arrives must not leave the record to mislabel a
  // LATER, genuine navigation as ours.
  assert.match(nav, /setTimeout\(\(\) => forget\(want\), 0\)/);

  // Nobody else keeps one.
  for (const [name, src] of Object.entries({ app, libView, diaView })) {
    assert.doesNotMatch(src, /suppressHash|ownHashWrite/, `${name} kept a private hash flag`);
  }
  assert.doesNotMatch(app + libView + diaView, /location\.hash = (?!next)/,
    'a raw hash write bypasses the record');
});

test('the shell asks once and passes the answer down', () => {
  assert.match(app, /const ours = hashWasOurs\(\);/);
  assert.match(app, /if \(!ours\) bumpNav\(\)/);
  assert.match(app, /libraryHashChanged\(ours\)/);
  assert.match(app, /diaryHashChanged\(ours\)/);
  assert.match(libView, /export function libraryHashChanged\(ours = false\)/);
  assert.match(diaView, /export function diaryHashChanged\(ours = false\)/);
});

test('a hash already inside the target section survives the navigation', () => {
  /* `go(id)` flattened the hash to `#id`, so `#diary/2026-08-05` arriving from
   * a Calendar habit row would silently open TODAY. A deep link is a request
   * for a place, and normalising it away answers a different question. */
  assert.match(app, /const inSection = location\.hash\.slice\(1\)[\s\S]{0,80}=== id;/);
  assert.match(app, /if \(!inSection\) setHash\(`#\$\{id\}`\)/);
});

/* ══ §2 THE LOADING LIFECYCLE ══════════════════════════════════════════ */

test('every Library loading state is watched, and every ending disarms it', () => {
  assert.match(libView, /function beginLoading\(what, onRetry\)/);
  assert.match(libView, /function endLoading\(\)/);
  // Each of the three loading shells arms the watchdog…
  const armed = libView.match(/beginLoading\(/g) ?? [];
  assert.ok(armed.length >= 4, `only ${armed.length} beginLoading call sites`);
  // …and each path that reaches a real screen disarms it.
  const ended = libView.match(/endLoading\(\)/g) ?? [];
  assert.ok(ended.length >= 4, `only ${ended.length} endLoading call sites`);
  // The watchdog produces a RETRY, not another wait.
  const fn = libView.slice(libView.indexOf('function beginLoading'));
  assert.match(fn.slice(0, 1200), /id="lib-retry"/);
  assert.match(fn.slice(0, 1200), /taking too long/);
});

test('the loading shell is Library-shaped, not a giant rectangle', () => {
  assert.doesNotMatch(libView, /height:60vh/, 'the 60vh slab is back');
  assert.match(libView, /const shelfLoadingHtml = \(\)/);
  assert.match(libView, /const bookLoadingHtml = \(\)/);
  // Card shapes at the size the cards will be, and a book in the spread's own
  // proportions — so arrival is a fill rather than a reflow.
  assert.match(html, /\.lib-skel\{height:154px/);
  assert.match(html, /\.bk-skel\{[^}]*aspect-ratio:420\/297/);
  // Every shell is findable, which is what makes the watchdog possible.
  assert.match(libView, /data-loading="shelf"/);
  assert.match(libView, /data-loading="book"/);
  assert.match(libView, /data-loading="item"/);
});

test('a book that will not open offers Retry, not only a way out', () => {
  const fn = libView.slice(libView.indexOf('async function renderBook'));
  assert.match(fn.slice(0, 2400), /data-retry/);
  assert.match(fn.slice(0, 2400), /data-back/);
  // And the header carries the book's real name while it loads, not "Opening…"
  // as an <h1> — the shelf already knew what it was called.
  assert.match(fn.slice(0, 2400), /lib\.items\.find\(\(i\) => i\.book\?\.id === route\.bookId\)/);
});

/* ══ §3, §4 THE SPREAD'S HEIGHT ════════════════════════════════════════ */

test('the base height is the Book\'s own shape, not a viewport formula', () => {
  assert.doesNotMatch(html, /\.dia-book[^}]*min-height:calc\(\(100vw/);
  assert.match(html, /\.dia-book\.bk-spread::before\{content:'';grid-row:1;grid-column:1\/-1;/);
  assert.match(html, /\.dia-book\.bk-spread::before\{[\s\S]{0,90}aspect-ratio:420\/297/);
  // Zero content, behind the pages, invisible in every way except that the row
  // cannot be shorter than it.
  assert.match(html, /\.dia-book\.bk-spread::before\{[\s\S]{0,140}pointer-events:none;z-index:-1\}/);
});

test('growth is layout, so there is no height to leave behind', () => {
  // max(base, left, right), all three terms CSS.
  assert.match(html, /\.dia-book\.bk-spread\{aspect-ratio:auto;height:auto;align-items:stretch\}/);
  assert.match(html, /\.dia-book\.bk-spread > \.dia-left\{grid-row:1;grid-column:1\}/);
  assert.match(html, /\.dia-book\.bk-spread > \.dia-right\{grid-row:1;grid-column:2\}/);
  /* Nothing writes an inline height onto the SPREAD, and nothing animates it.
   * The ghost's own box is excluded: it is measured once and deleted. */
  const spreadCode = diaView.replace(
    diaView.slice(diaView.indexOf('function beginTurn'), diaView.indexOf('function endTurn')), '');
  assert.doesNotMatch(spreadCode, /style\.height = /);
  assert.doesNotMatch(code(read('diary-entry.js')), /style="height/);
  /* D2.3 §21 introduced ONE measurement: the outgoing ghost is pinned to the
   * box it is replacing. It is written onto a node that deletes itself, so
   * there is still no final state for a stale value to be left in. */
  const turn = diaView.slice(diaView.indexOf('function beginTurn'));
  assert.match(turn.slice(0, 2000), /ghost\.style\.(left|width)/);
  assert.match(turn.slice(0, 2000), /setTimeout\(drop, TURN_MS \+ 120\)/);
  assert.match(diaView, /function endTurn\(/);
});

test('empty prompts and empty controls do not inflate the page', () => {
  /* What must be ignored is satisfied by construction: prompts past the third
   * are ABSENT from the DOM rather than hidden, and D2.3 removed the four
   * editable Moment tiles outright — the right page is tap-only, so there is
   * no collapsed text field left to account for. */
  const fn = checkin.slice(checkin.indexOf('export function promptsHtml'));
  assert.match(fn.slice(0, 1600), /const shown = showAll \? all : all\.slice\(0, PROMPTS_LEAD\)/);
  assert.match(fn.slice(0, 2000), /shown\.map/);
  assert.doesNotMatch(checkin, /function momentsHtml/, 'the Moment tiles are back');
  /* The ruled editor is a FLOOR of seven lines and no longer grows into spare
   * space — D2.3 §1. The slack sits below the prompts instead, so the writing
   * region stays the size it was asked to be. */
  assert.match(html, /\.dia-editor\{flex:0 0 auto\}/);
  assert.match(html, /\.dia-editor\{outline:0;min-height:210px/);
  assert.match(html, /\.dia-left \.dia-scroll::after\{content:'';flex:1 1 auto/);
});

/* ══ §5 PROMPT DENSITY ═════════════════════════════════════════════════ */

test('three prompts rest open, and an answered one is never hidden', () => {
  assert.match(checkin, /export const PROMPTS_LEAD = 3/);
  const fn = checkin.slice(checkin.indexOf('export function promptsHtml'));
  // Collapsing something somebody wrote out of sight is how they lose track of
  // having written it.
  assert.match(fn.slice(0, 1600), /const forced = all\.slice\(PROMPTS_LEAD\)\.some\(\(p\) => valueOf\(refl, p\)\)/);
  assert.match(fn.slice(0, 1600), /const showAll = open \|\| forced/);
  assert.match(fn.slice(0, 2000), /data-prompts-more/);
  // Opening them replaces ONLY the prompts — a sibling of the editor.
  const paint = diaView.slice(diaView.indexOf('function paintPrompts'));
  assert.match(paint.slice(0, 900), /querySelector\('\.dia-prompts'\)/);
  assert.match(paint.slice(0, 900), /old\.replaceWith\(next\)/);
  assert.doesNotMatch(paint.slice(0, 900), /paintSheet|scroll\.innerHTML/);
  assert.match(paint.slice(0, 900), /wirePrompts\(next\)/);
});

/* ══ §6 ONE TOTAL, SHARED ══════════════════════════════════════════════ */

test('habitTotals is the one sum, and the diary is inside it', () => {
  const five = Array.from({ length: 5 }, () => ({ dueToday: true, completedToday: false }));
  const diaryDone = { dueToday: true, completedToday: true };
  const diaryNot = { dueToday: true, completedToday: false };

  // §6's own example: five ordinary plus the diary is six, and writing only
  // the diary shows 1/6.
  assert.deepEqual(habitTotals(five, diaryDone), { due: 6, done: 1 });
  assert.deepEqual(habitTotals(five, diaryNot), { due: 6, done: 0 });
  // No ordinary habits at all.
  assert.deepEqual(habitTotals([], diaryNot), { due: 1, done: 0 });
  assert.deepEqual(habitTotals([], diaryDone), { due: 1, done: 1 });
  // Disabled: excluded entirely, not counted as an incomplete one.
  assert.deepEqual(habitTotals(five, null), { due: 5, done: 0 });
  // A habit not due today is not in the denominator either.
  assert.deepEqual(
    habitTotals([{ dueToday: false, completedToday: false }], diaryDone),
    { due: 1, done: 1 },
  );
});

test('Today reads the total from the server rather than counting again', () => {
  /* THE DEFECT. `0/5` with the diary row showing complete: the row was drawn
   * by renderRail and the sum was `due.length`, and the computed habit is not
   * in `due`. Counting in the client is what made two answers possible. */
  const fn = app.slice(app.indexOf('function renderRail'));
  assert.match(fn.slice(0, 2000), /state\.habitTotals \?\?/);
  assert.match(fn.slice(0, 2000), /\$\{totals\.done\}\/\$\{totals\.due\}/);
  assert.match(app, /state\.habitTotals = r\.totals \?\? null/);
  assert.match(app, /state\.diaryHabit = r\.diaryHabit \?\? null/);
});

test('GET /habits returns the row and the total together', async () => {
  const { ws, call } = await setup();
  const today = '2026-08-06';

  // No habits at all, nothing written: the diary alone is the whole system.
  let r = await call('GET', `/api/v1/workspaces/${ws}/habits?date=${today}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.diaryHabit.id, DIARY_HABIT_ID);
  assert.deepEqual(r.body.totals, { due: 1, done: 0 });
  assert.equal(r.body.habits.length, 0);

  // Two ordinary habits.
  await call('POST', `/api/v1/workspaces/${ws}/habits`, { name: 'Walk' });
  const second = await call('POST', `/api/v1/workspaces/${ws}/habits`, { name: 'Read' });
  r = await call('GET', `/api/v1/workspaces/${ws}/habits?date=${today}`);
  assert.deepEqual(r.body.totals, { due: 3, done: 0 });

  // Write the diary: the total moves, and it moves in the SUM, not only the row.
  await call('PUT', `/api/v1/workspaces/${ws}/diary/entries/${today}`,
    { document: doc('Something real.'), timezone: 'Africa/Johannesburg' });
  r = await call('GET', `/api/v1/workspaces/${ws}/habits?date=${today}`);
  assert.equal(r.body.diaryHabit.completedToday, true);
  assert.deepEqual(r.body.totals, { due: 3, done: 1 });

  // Tick an ordinary one too.
  await call('POST', `/api/v1/workspaces/${ws}/habits/${second.body.habit.id}/check`,
    { date: today });
  r = await call('GET', `/api/v1/workspaces/${ws}/habits?date=${today}`);
  assert.deepEqual(r.body.totals, { due: 3, done: 2 });
});

/* ══ §7 VISUAL PARITY ══════════════════════════════════════════════════ */

test('the Diary row is an ordinary habit row, minus the badge', () => {
  const fn = app.slice(app.indexOf('function diarySystemHabitHtml'));
  const row = fn.slice(0, 1600);
  /* THE SAME RING COMPONENT, literally — D2.3 §17 required it, and sharing the
   * function is the only way the two can never diverge again. */
  assert.match(row, /class="hb-row hb-diary/);
  assert.match(row, /class="hb-ring"/);
  assert.match(row, /\$\{ringSvg\(/);
  assert.match(app.slice(app.indexOf('function habitRowHtml')).slice(0, 900), /\$\{ringSvg\(h\)\}/);
  assert.match(row, /streakHtml\(d\)/);
  assert.match(row, /class="hb-name"/);
  // And the prominent badge is gone.
  assert.doesNotMatch(row, /hb-sys-tag/);
  assert.doesNotMatch(html, /\.hb-sys-tag\{/, 'the SYSTEM badge styles are back');
  assert.doesNotMatch(html, /\.hb-system\{/, 'the separate system-row styles are back');
  const rules = html.slice(html.indexOf('.hb-diary{'), html.indexOf('.hb-auto{'))
    .split('\n').filter((l) => !l.includes('::after') && !l.includes('background:var(--border)'))
    .join('\n');
  assert.doesNotMatch(rules, /font-size|padding:|height:|border-radius|font-weight/,
    'the Diary row restyles something the ordinary rows own');
});

test('the allowed distinctions are the ones that explain behaviour', () => {
  // A quiet divider, a small diary mark, and "Automatic" as the title.
  assert.match(html, /\.hb-diary::after\{content:'';position:absolute/);
  assert.match(html, /\.hb-auto\{/);
  const fn = app.slice(app.indexOf('function diarySystemHabitHtml'));
  assert.match(fn.slice(0, 1600), /title="Automatic — kept from what you write in your Diary"/);
  // Clicking the circle OR the row opens today's diary rather than toggling.
  assert.match(fn.slice(0, 1600), /data-diary-open/);
  assert.doesNotMatch(fn.slice(0, 1600), /data-habit-toggle/);
  assert.match(app, /\[data-diary-open\]'\)\.forEach[\s\S]{0,180}go\('diary'\)/);
});

/* ══ §8 THE SETTING ════════════════════════════════════════════════════ */

test('the preference is allow-listed, defaults on, and is migration-safe', () => {
  assert.deepEqual(PREFERENCE_SCHEMA.diaryHabit.values, ['on', 'off']);
  assert.equal(PREFERENCE_SCHEMA.diaryHabit.default, 'on');
  // Absent means on, so no row is written for a workspace that never touched it.
  assert.equal(diaryHabitEnabled(null), true);
  assert.equal(diaryHabitEnabled({}), true);
  assert.equal(diaryHabitEnabled({ diaryHabit: 'on' }), true);
  assert.equal(diaryHabitEnabled({ diaryHabit: 'off' }), false);
});

test('the toggle is in Settings, under Habits, in the phase\'s own words', () => {
  assert.match(settingsJs, /Count writing in Diary as a daily habit/);
  assert.match(settingsJs, /segment\('diaryHabit', p\.diaryHabit \?\? 'on'/);
  // It changes what the habit SYSTEM contains, so the totals come again from
  // the server rather than being toggled locally.
  assert.match(app, /if \(pref === 'diaryHabit'\) \{ await loadHabits\(\); renderRail\(\); \}/);
  // And it never creates an ordinary habit row.
  assert.doesNotMatch(settingsJs, /diaryHabit[\s\S]{0,200}POST/);
});

test('disabling removes it from every total and deletes no diary data', async () => {
  const { ws, call } = await setup();
  const today = '2026-08-06';
  await call('POST', `/api/v1/workspaces/${ws}/habits`, { name: 'Walk' });
  await call('PUT', `/api/v1/workspaces/${ws}/diary/entries/${today}`,
    { document: doc('A day worth keeping.'), timezone: 'Africa/Johannesburg' });

  let r = await call('GET', `/api/v1/workspaces/${ws}/habits?date=${today}`);
  assert.deepEqual(r.body.totals, { due: 2, done: 1 });

  await call('PUT', '/api/v1/preferences', { diaryHabit: 'off' });
  r = await call('GET', `/api/v1/workspaces/${ws}/habits?date=${today}`);
  assert.equal(r.body.diaryHabit, null);
  assert.deepEqual(r.body.totals, { due: 1, done: 0 });

  const hist = await call('GET',
    `/api/v1/workspaces/${ws}/habits/history?from=2026-08-01&to=2026-08-31`);
  assert.equal(hist.body.diarySeries, null);
  /* The diary series is gone from every day, which is the claim. The ordinary
   * habit's own `due` is NOT asserted here: it was created a moment ago, and
   * `habitHistory` correctly refuses to count days before a habit existed — so
   * pinning a number would make this test fail on a different day of the month
   * rather than on a real defect. (It did, the first time the calendar moved
   * past the date this was written on.) */
  const row = hist.body.days.find((d: any) => d.date === today);
  assert.ok(row, 'the day is missing from the history');
  assert.equal(row.done, 0, 'a completion survived the setting being turned off');

  // THE DIARY IS UNTOUCHED. The entry, and the streak derived from it, both
  // still answer — the setting hides a series, it does not delete a life.
  const entry = await call('GET', `/api/v1/workspaces/${ws}/diary/entries/${today}`);
  assert.equal(entry.status, 200);
  assert.ok(entry.body.entry, 'the diary entry was removed with the setting');
  const streak = await call('GET', `/api/v1/workspaces/${ws}/diary/streak?today=${today}`);
  assert.equal(streak.body.current, 1);
  assert.equal(streak.body.wroteToday, true);

  // Re-enabling brings the whole history back, derived, with nothing restored.
  await call('PUT', '/api/v1/preferences', { diaryHabit: 'on' });
  r = await call('GET', `/api/v1/workspaces/${ws}/habits?date=${today}`);
  assert.deepEqual(r.body.totals, { due: 2, done: 1 });
  assert.equal(r.body.diaryHabit.streak, 1);
});

test('no habit row and no habit_entries row is ever created for it', async () => {
  const { ws, call, db } = await setup();
  const today = '2026-08-06';
  await call('PUT', `/api/v1/workspaces/${ws}/diary/entries/${today}`,
    { document: doc('Written.'), timezone: 'Africa/Johannesburg' });
  await call('GET', `/api/v1/workspaces/${ws}/habits?date=${today}`);
  await call('GET', `/api/v1/workspaces/${ws}/habits/history?from=2026-08-01&to=2026-08-31`);

  const schema = await import('../src/db/schema.js');
  assert.equal((await db.select().from(schema.habits)).length, 0);
  assert.equal((await db.select().from(schema.habitEntries)).length, 0);
});

test('the computed id cannot be ticked or deleted', async () => {
  const { ws, call } = await setup();
  const check = await call('POST',
    `/api/v1/workspaces/${ws}/habits/${DIARY_HABIT_ID}/check`, { date: '2026-08-06' });
  assert.ok(check.status >= 400, 'the computed habit accepted a completion');
  const patch = await call('PATCH',
    `/api/v1/workspaces/${ws}/habits/${DIARY_HABIT_ID}`, { name: 'Renamed' });
  assert.ok(patch.status >= 400, 'the computed habit accepted a rename');
});

/* ══ §9 THE CALENDAR SERIES ════════════════════════════════════════════ */

test('the series is due from the first written day, never before', () => {
  /* The same rule habit-history.ts applies to an ordinary habit's createdAt.
   * A history screen that backfills guilt for the years before you kept a
   * diary is not worth looking at. */
  const written = new Set(['2026-08-03', '2026-08-05']);
  assert.equal(diaryHabitSince(written, '2026-08-06'), '2026-08-03');
  // Today is always due — that is the point of the row.
  assert.equal(diaryHabitSince(new Set(), '2026-08-06'), '2026-08-06');
  assert.equal(diaryHabitSince(new Set(['2026-09-01']), '2026-08-06'), '2026-08-06');

  const days = [
    { date: '2026-08-01', due: 2, done: 1 },
    { date: '2026-08-03', due: 2, done: 2 },
    { date: '2026-08-04', due: 2, done: 0 },
    { date: '2026-08-05', due: 2, done: 2 },
  ];
  const out = addDiaryToHabitDays(days, written, { enabled: true, since: '2026-08-03' });
  assert.deepEqual(out, [
    { date: '2026-08-01', due: 2, done: 1 },   // before the diary began
    { date: '2026-08-03', due: 3, done: 3 },   // written
    { date: '2026-08-04', due: 3, done: 0 },   // due, not written
    { date: '2026-08-05', due: 3, done: 3 },   // written
  ]);
  // Disabled changes nothing at all, and the input is never mutated.
  assert.deepEqual(addDiaryToHabitDays(days, written, { enabled: false, since: '2026-08-03' }), days);
  assert.deepEqual(days[1], { date: '2026-08-03', due: 2, done: 2 });
});

test('history and the Calendar range fold in the same series', async () => {
  const { ws, call } = await setup();
  await call('POST', `/api/v1/workspaces/${ws}/habits`, { name: 'Walk' });
  await call('PUT', `/api/v1/workspaces/${ws}/diary/entries/2026-08-04`,
    { document: doc('Monday.'), timezone: 'Africa/Johannesburg' });
  await call('PUT', `/api/v1/workspaces/${ws}/diary/entries/2026-08-06`,
    { document: doc('Wednesday.'), timezone: 'Africa/Johannesburg' });

  /* Asserted as a DELTA against the same range with the setting off. The
   * ordinary habit's own `due` depends on when this test runs — `habitHistory`
   * refuses to count days before a habit existed — and pinning absolute
   * numbers would make the test fail on a different day of the month rather
   * than on a real defect. The delta is the claim being made. */
  const url = `/api/v1/workspaces/${ws}/habits/history?from=2026-08-01&to=2026-08-07`;
  await call('PUT', '/api/v1/preferences', { diaryHabit: 'off' });
  const without = await call('GET', url);
  assert.equal(without.body.diarySeries, null);
  await call('PUT', '/api/v1/preferences', { diaryHabit: 'on' });
  const withIt = await call('GET', url);
  assert.equal(withIt.body.diarySeries.id, DIARY_HABIT_ID);
  assert.equal(withIt.body.diarySeries.route, '#diary');

  const base = new Map(without.body.days.map((d: any) => [d.date, d]));
  const delta = withIt.body.days.map((d: any) => ({
    date: d.date,
    due: d.due - (base.get(d.date) as any).due,
    done: d.done - (base.get(d.date) as any).done,
  }));
  const byDate = new Map(delta.map((d: any) => [d.date, d]));
  // Before the diary began: untouched. No backfilled guilt.
  assert.deepEqual(byDate.get('2026-08-01'), { date: '2026-08-01', due: 0, done: 0 });
  assert.deepEqual(byDate.get('2026-08-03'), { date: '2026-08-03', due: 0, done: 0 });
  // From the first written day onwards: one more due, and done where written.
  assert.deepEqual(byDate.get('2026-08-04'), { date: '2026-08-04', due: 1, done: 1 });
  assert.deepEqual(byDate.get('2026-08-05'), { date: '2026-08-05', due: 1, done: 0 });
  assert.deepEqual(byDate.get('2026-08-06'), { date: '2026-08-06', due: 1, done: 1 });
  assert.deepEqual(byDate.get('2026-08-07'), { date: '2026-08-07', due: 1, done: 0 });

  const range = await call('GET',
    `/api/v1/workspaces/${ws}/calendar/range?from=2026-08-01&to=2026-08-07`);
  assert.equal(range.body.habitTotal, 2, 'the Calendar total excludes the diary habit');
  assert.deepEqual(range.body.diaryDays, ['2026-08-04', '2026-08-06']);
  // The same numbers reach the month cells, from the same provider.
  const cell = range.body.habitDays.find((d: any) => d.date === '2026-08-06');
  const histCell = withIt.body.days.find((d: any) => d.date === '2026-08-06');
  assert.deepEqual(cell, histCell, 'Calendar and history disagree about a day');
});

test('the Calendar day sheet shows it, and opens that day rather than ticking', () => {
  const fn = calJs.slice(calJs.indexOf('function habitCardHtml'));
  assert.match(fn.slice(0, 2600), /const diary = dh\.diaryHabit \?\? null/);
  assert.match(fn.slice(0, 2600), /cs-habit-row cs-habit-diary/);
  assert.match(fn.slice(0, 2600), /data-diary-day="\$\{day\}"/);
  // The same sum, in one place, including the computed one.
  assert.match(fn.slice(0, 2600), /\+ \(diary\?\.completedToday \? 1 : 0\)/);
  // It is never given a `data-habit`, so `toggleHabitOn` can never find it.
  assert.doesNotMatch(fn.slice(fn.indexOf('cs-habit-diary'), fn.indexOf('due.map')),
    /data-habit="/);
  assert.match(app, /\[data-diary-day\]'\)\.forEach[\s\S]{0,220}setHash\(`#diary\/\$\{b\.dataset\.diaryDay\}`\)/);
});

test('a day is written when it is MEANINGFUL, not when a row survives', () => {
  const base = {
    title: null, mood: null, energy: null, weatherNote: null,
    locationNote: null, daySummary: null, reflection: null,
  };
  const days = writtenDays([
    { entryDate: '2026-08-01', document: doc('Real.'), ...base },
    // An emptied row. It still exists — that is what makes restore possible.
    { entryDate: '2026-08-02', document: EMPTY_DOC, ...base },
    // Only a mood: somebody who recorded "low" on a hard day HAS written.
    { entryDate: '2026-08-03', document: null, ...base, mood: 'low' },
  ]);
  assert.deepEqual([...days].sort(), ['2026-08-01', '2026-08-03']);

  // The streak ends today, or yesterday — a run is not broken at 00:01.
  assert.deepEqual(diaryStreak(new Set(['2026-08-05', '2026-08-06']), '2026-08-06'),
    { current: 2, wroteToday: true });
  assert.deepEqual(diaryStreak(new Set(['2026-08-04', '2026-08-05']), '2026-08-06'),
    { current: 2, wroteToday: false });
  assert.deepEqual(diaryStreak(new Set(['2026-08-01']), '2026-08-06'),
    { current: 0, wroteToday: false });

  const row = diaryHabitRow(new Set(['2026-08-06']), '2026-08-06');
  assert.equal(row.dueToday, true);
  assert.equal(row.completedToday, true);
  assert.equal(row.route, '#diary');
});

/* ══ §10–§12 THE RIGHT PAGE ════════════════════════════════════════════ */

test('the four groups are surfaces, and the feeling tints only its own', () => {
  assert.match(checkin, /const group = \(id, title, body, extra = ''\)/);
  /* The fourth group is `rhythm` now, not `moments`: D2.3 §3 removed the
   * editable tiles and §7 put the four passive dimensions in their place. */
  for (const id of ['feeling', 'energy', 'social', 'rhythm']) {
    assert.match(checkin, new RegExp(`group\\('${id}'`), `the ${id} group is not a surface`);
  }
  assert.doesNotMatch(checkin, /group\('moments'/, 'the Moment tiles are back');
  assert.match(html, /\.dia-ci-group\{/);
  // The tint is scoped to the check-in, never the page.
  assert.match(html, /\.dia-checkin\[data-tone="great"\]/);
  assert.match(html, /\.dia-checkin\[data-tone\] \.dia-ci-group\[data-group-id="feeling"\]/);
  assert.doesNotMatch(html, /\.dia-book\[data-tone\]|\.dia-left\[data-tone\]/);
});

test('the energy meter and the social battery respond, and both carry words', () => {
  assert.match(checkin, /export function energyMeter\(selected/);
  assert.match(checkin, /export function batteryMeter\(selected/);
  // A text reading beside each, so nothing depends on the graphic.
  assert.match(checkin, /class="dia-ci-read"/);
  assert.match(checkin, /esc\(labelOf\(ENERGIES, energy\) \?\? '—'\)/);
  assert.match(checkin, /esc\(labelOf\(SOCIAL, c\.social\) \?\? '—'\)/);
  // The meters are `aria-hidden`: they are a second telling of the label.
  assert.match(checkin, /class="dia-meter \$\{cls\}" aria-hidden="true"/);
  assert.match(checkin, /class="dia-batt [\s\S]{0,60}aria-hidden="true"/);
  assert.match(html, /\.dia-meter-seg\.on\{background:var\(--accent-c\)/);
});

test('THE RIGHT PAGE IS TAP-ONLY', () => {
  /* REVERSED by D2.3 §3, and it is the phase's central product rule:
   *
   *     LEFT PAGE  = THINGS YOU WRITE.
   *     RIGHT PAGE = THINGS YOU TAP.
   *
   * D2.2's Moment tiles were a second writing surface pretending to be a
   * control. They opened the keyboard, competed with the writing across the
   * gutter, and made a fast check-in end in an essay. Anything already written
   * into one is surfaced on the LEFT page as a guided prompt. */
  assert.doesNotMatch(checkin, /<textarea[^>]*data-note|<input[^>]*data-note/,
    'a text field is back on the right page');
  assert.doesNotMatch(checkin, /momentsHtml|data-moment-open|dia-moment/);
  const body = checkin.slice(checkin.indexOf('export function checkinHtml'),
    checkin.indexOf('export const PROMPTS'));
  assert.doesNotMatch(body, /<textarea|<input|contenteditable/,
    'the right page renders something that opens a keyboard');
  // Nothing wires one either.
  assert.doesNotMatch(diaView.slice(diaView.indexOf('function wireCheckin')).slice(0, 1600),
    /data-note|data-moment-open/);
  assert.doesNotMatch(html, /\.dia-moments\{|\.dia-moment-t\{/);
  // The four retired lines live on as LEFT-page prompts, and only when a day
  // already holds one — a fresh day is not given nine questions.
  assert.match(checkin, /export const MOMENT_PROMPTS = \[/);
  const fn = checkin.slice(checkin.indexOf('export function promptsFor'));
  assert.match(fn.slice(0, 600), /MOMENT_PROMPTS\.filter\(\(m\) => c\[m\.id\]\)/);
  // …keeping their original storage key, so nothing has to be migrated.
  assert.match(checkin, /store: 'checkin'/);
  assert.match(diaView, /function setPrompt\(id, value, store = 'prompts'\)/);
});

test('a selection patches ONE group, and never the group holding the caret', () => {
  assert.match(diaView, /function paintGroup\(id\)/);
  const fn = diaView.slice(diaView.indexOf('function paintGroup'));
  assert.match(fn.slice(0, 1400), /old\.replaceWith\(next\)/);
  assert.doesNotMatch(fn.slice(0, 1400), /scroll\.innerHTML|paintSheet/);
  assert.match(diaView, /paintGroup\('energy'\)/);
  // The four passive dimensions share one group; everything else redraws itself.
  assert.match(diaView, /paintGroup\(PASSIVE_KEYS\.includes\(group\) \? 'rhythm'/);
  // The left page is never rebuilt by a right-page interaction.
  const paint = diaView.slice(diaView.indexOf('function paintCheckin'));
  assert.match(paint.slice(0, 600), /\.dia-right \.dia-scroll/);
  assert.doesNotMatch(paint.slice(0, 600), /paintSheet|spreadHtml/);
  // And the Day Pulse is its own repaint — every selection may move one bar.
  assert.match(diaView, /function paintPulse\(\)/);
  assert.match(fn.slice(0, 1400), /paintPulse\(\)/);
});

test('a repaint rewires only what it replaced', () => {
  /* Found by measurement in D2.2: `paintGroup` re-wired every group, so a chip
   * that had not been replaced carried two listeners — it selected itself and
   * then immediately deselected itself, and nothing happened at all. */
  assert.match(diaView, /function wireCheckin\(root\)/);
  assert.match(diaView, /root\.querySelectorAll\('\.dia-chips\[data-group\]'\)/);
  const fn = diaView.slice(diaView.indexOf('function paintGroup'));
  assert.match(fn.slice(0, 1400), /wireCheckin\(next\)/);
  assert.doesNotMatch(fn.slice(0, 1400), /wireCheckin\(document\.getElementById/);
  assert.match(diaView, /function wirePrompts\(root\)/);
});

test('a selection saves, and the local copy is authoritative', () => {
  /* The Moment fields this used to guard are gone (§3). What survives is the
   * rule they were protecting: a selection updates the local reflection FIRST,
   * so the page answers immediately, and the write is queued after — no
   * interaction can produce a false "Saved". */
  assert.match(diaView, /function writeReflection\(next\)/);
  assert.match(diaView, /queueSave\(dia\.date, undefined, \{ reflection: clean \}\)/);
  const fn = diaView.slice(diaView.indexOf('function writeReflection'));
  assert.ok(fn.indexOf('dia.reflection = clean') < fn.indexOf('queueSave'),
    'the write is queued before the local copy is updated');
  // The chosen chip keeps the focus it just took, so a keyboard user is not
  // returned to the top of the page by the control they were operating.
  assert.match(diaView, /\[data-group="\$\{group\}"\] \[data-choice="\$\{id\}"\]`\)\?\.focus\(\)/);
});

/* ══ §13 HISTORY ═══════════════════════════════════════════════════════ */

test('the month is a compact six-week grid, not seven squares tall', () => {
  assert.doesNotMatch(html, /\.dia-day-cell\{[^}]*aspect-ratio:1/);
  // 72px from D2.3 §12: the cell carries three rows now — the indicator row,
  // the context line and the passive marks — and it is still stated, so the
  // grid cannot creep.
  assert.match(html, /\.dia-day-cell\{[^}]*height:72px/);
  assert.match(html, /\.dia-day-cell\{[^}]*overflow:hidden/);
  assert.match(html, /\.dia-day-prev\{[^}]*-webkit-line-clamp:2/);
});

test('a written cell shows the same indicators the right page does', () => {
  /* D2.3 §12. A month of the word `GREAT` is not a snapshot. The cell now
   * speaks the right page's visual language, using the SAME components rather
   * than re-drawing them — one vocabulary, learned once, and the two cannot
   * drift apart. */
  assert.match(historyJs, /from '\.\/diary-checkin\.js'/);
  for (const fn of ['face', 'energyMeter', 'batteryMeter', 'scaleValue', 'labelOf', 'glyph']) {
    assert.match(historyJs, new RegExp(`\\b${fn}\\b`), `history does not reuse ${fn}`);
  }
  assert.match(historyJs, /class="dia-day-n"/);
  assert.match(historyJs, /class="dia-day-ind"/);
  assert.match(historyJs, /class="dia-day-prev"/);
  assert.match(historyJs, /data-feel="\$\{esc\(feeling\.id\)\}"/);
  // §13 — the four passive dimensions as four small marks, never as text.
  assert.match(historyJs, /class="dia-day-rh"/);
  assert.match(historyJs, /glyph\(p\.icon, 11\)/);
  assert.doesNotMatch(historyJs, /dia-day-rh[\s\S]{0,200}labelOf\(p\.scale/,
    'the passive values are written into the cell as text');
  // Exact values live in the tooltip and the accessible name.
  assert.match(historyJs, /title="\$\{esc\(said\.join\(' · '\)\)\}"/);
});

test('the preview is chosen and cut on the server, once', () => {
  // Deliberateness first: a title chosen, then a Highlight named, then the day
  // summary, then the opening words. Never "Untitled" — that describes the
  // label rather than the day.
  assert.equal(previewOf({ title: 'A good day', highlight: 'Walked', excerpt: 'x' }), 'A good day');
  assert.equal(previewOf({ title: '  ', highlight: 'Walked home' }), 'Walked home');
  assert.equal(previewOf({ daySummary: 'Quiet one' }), 'Quiet one');
  assert.equal(previewOf({ excerpt: 'It rained all morning' }), 'It rained all morning');
  assert.equal(previewOf({}), null);
  assert.equal(previewOf({ title: null, excerpt: '' }), null);
  // Whitespace is collapsed, so a paragraph break cannot become a blank line.
  assert.equal(previewOf({ excerpt: 'One\n\n  two' }), 'One two');
  // Hard limit, with the ellipsis inside it.
  const long = previewOf({ excerpt: 'x'.repeat(400) })!;
  assert.equal(long.length, 90);
  assert.ok(long.endsWith('…'));
});

test('the month cell gets a feeling even from an entry that predates the check-in', async () => {
  const { ws, call } = await setup();
  await call('PUT', `/api/v1/workspaces/${ws}/diary/entries/2026-08-04`,
    { document: doc('A hard one.'), mood: 'very_low', timezone: 'Africa/Johannesburg' });
  await call('PUT', `/api/v1/workspaces/${ws}/diary/entries/2026-08-05`, {
    document: doc('Rebuilt the shelf.'),
    reflection: { checkin: { feeling: 'good', highlight: 'The long way home' } },
    timezone: 'Africa/Johannesburg',
  });

  const r = await call('GET', `/api/v1/workspaces/${ws}/diary/days?month=2026-08-01`);
  const byDate = new Map(r.body.days.map((d: any) => [d.date, d]));
  // `mood` is the older vocabulary for the same five steps.
  assert.equal((byDate.get('2026-08-04') as any).feeling, 'rough');
  assert.equal((byDate.get('2026-08-04') as any).preview, 'A hard one.');
  // The check-in wins when it exists, and the Highlight beats the body text.
  assert.equal((byDate.get('2026-08-05') as any).feeling, 'good');
  assert.equal((byDate.get('2026-08-05') as any).preview, 'The long way home');
  // The raw document text never ships — only the line the cell can show.
  assert.equal((byDate.get('2026-08-05') as any).excerpt, undefined);
  assert.equal((byDate.get('2026-08-05') as any).reflection, undefined);
});

test('a difficult day is warm, never destructive', () => {
  const tints = html.slice(html.indexOf('.dia-day-cell[data-feel="rough"]'),
    html.indexOf('.dia-cal-key{'));
  // Muted warm rose/coral for Rough and Low…
  assert.match(tints, /\[data-feel="rough"\]\{background:rgba\(214,124,110/);
  assert.match(tints, /\[data-feel="low"\]\{background:rgba\(214,142,124/);
  // …soft green and lilac for Good and Great…
  assert.match(tints, /\[data-feel="good"\]\{background:rgba\(122,190,146/);
  assert.match(tints, /\[data-feel="great"\]\{background:rgba\(160,136,240/);
  // …and Steady is the plain surface: ordinary should look ordinary.
  assert.match(tints, /\[data-feel="steady"\]\{background:var\(--surface-2\)/);
  // Never the destructive token, and never a raw red.
  assert.doesNotMatch(tints, /--danger|#FF646E|\bred\b/i);
});

test('the phone keeps the information the density can carry', () => {
  const mob = html.slice(html.indexOf('.dia-day-cell{height:auto;min-height:44px'));
  assert.match(mob.slice(0, 400), /\.dia-day-prev\{display:none\}/);
  // The dot comes back, because presence still has to be readable.
  assert.match(mob.slice(0, 600), /\.dia-day-cell\.has-entry::after\{content:''/);
});

/* ══ §14 ANIMATION CLEANUP ═════════════════════════════════════════════ */

test('a `forwards` animation never owns the final state', () => {
  /* The outgoing day is `animation-fill-mode: forwards` — translated aside and
   * transparent — so it must be REMOVED rather than merely allowed to finish.
   * D2.3 made it a detached clone, which makes the guarantee simpler: the
   * ghost deletes itself, on `animationend` and on a timer, and the live
   * spread underneath was never animated at all. */
  const turn = diaView.slice(diaView.indexOf('function beginTurn'));
  assert.match(turn.slice(0, 2200), /const drop = \(\) => ghost\.remove\(\)/);
  assert.match(turn.slice(0, 2200), /animationend', drop, \{ once: true \}/);
  assert.match(turn.slice(0, 2200), /setTimeout\(drop, TURN_MS \+ 120\)/);
  // …and every paint sweeps any ghost that somehow survived.
  assert.match(diaView, /function endTurn\(scroll = document\.getElementById\('main-scroll'\)\)/);
  assert.match(diaView, /querySelectorAll\('\.dia-ghost'\)\.forEach\(\(g\) => g\.remove\(\)\)/);
  const lib = libView.slice(libView.indexOf('async function turn(dir)'));
  assert.match(lib.slice(0, 900), /finally \{[\s\S]{0,60}book\.classList\.remove\(cls\);/);
  assert.match(diaView, /setTimeout\(finish, ms \+ 60\)/);
  assert.match(libView, /setTimeout\(finish, ms \+ 60\)/);
});

test('an entrance takes its class off, whatever the timeline does', () => {
  /* MEASURED, not theorised. `diaEnterPrev` starts at opacity 0 and its
   * fill-mode is `none`, so it looks safe: the element returns to its computed
   * style the moment the animation finishes. An animation that never finishes
   * never returns anything — sampled in a browser with a throttled timeline, a
   * 200ms entrance was still `running` at SIX SECONDS with the whole spread at
   * opacity 0. The day was there, laid out correctly, and invisible. */
  for (const [name, src] of Object.entries({ diaView, libView })) {
    assert.match(src, /function enterOnce\(el, cls, ms\)/, `${name} has no enterOnce`);
    const fn = src.slice(src.indexOf('function enterOnce'));
    assert.match(fn.slice(0, 400), /setTimeout\(off, ms \+ 120\)/,
      `${name}'s entrance has no timeout guarantee`);
    assert.match(fn.slice(0, 400), /animationend', off, \{ once: true \}/);
    // Nothing adds an enter class without going through it.
    assert.doesNotMatch(src, /classList\.add\((dir|animate)[^)]*enter-/,
      `${name} adds an entrance class directly`);
  }
  assert.match(diaView, /enterOnce\(book, animate === 'next' \? 'enter-next' : 'enter-prev', 200\)/);
  assert.match(libView, /enterOnce\(fresh, dir === 'next' \? 'enter-next' : 'enter-prev', 260\)/);
});

test('the house rule is written down', () => {
  const doc = readFileSync(join('..', 'docs', 'animation-house-rules.md'), 'utf8');
  assert.match(doc, /Animations illustrate state changes; DOM and CSS own the final state/);
  // The four defects it came from, so the rule stays attached to its evidence.
  assert.match(doc, /stranded grow/i);
  assert.match(doc, /invisible day/i);
  assert.match(doc, /frozen book/i);
  assert.match(doc, /snapping ring/i);
});

/* ══ Regression ════════════════════════════════════════════════════════ */

test('Google stays read-only, and the diary habit added no write path', () => {
  const google = readFileSync(join('src', 'routes', 'google-calendar.ts'), 'utf8');
  assert.doesNotMatch(google, /calendar\.events\.insert|calendar\.events\.update/);
  const lib = readFileSync(join('src', 'lib', 'diary-habit.ts'), 'utf8');
  assert.doesNotMatch(lib, /google|oauth/i);
});

test('nothing about Tasks, events or Habit details entered Diary', () => {
  /* The standing constraint. The ONLY connection runs the other way: Today and
   * Calendar ask Diary whether a day holds writing. */
  const surfaces = [diaView, checkin, historyJs, code(read('diary-entry.js'))].join('\n');
  assert.doesNotMatch(surfaces, /loadTasks|taskHtml|habitRowHtml|calendarEvents|scheduleTask/);
  assert.doesNotMatch(surfaces, /data-habit-toggle|hb-ring/);
});
