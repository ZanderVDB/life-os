/**
 * Changing month, week or mode shows the wait — it does not show the last answer.
 *
 * ── The bug ────────────────────────────────────────────────────────────
 *
 * `cal.loading = !cal.data`. There was ALWAYS data once the calendar had been
 * opened once, so moving to another month left the flag false: the previous
 * month's grid stayed on screen under the new month's heading, looking
 * finished and being wrong, until the fetch landed and the real days popped
 * in. The pause was the network; the surprise was showing stale content as
 * though it were the answer.
 *
 * Loading is not "we have nothing". It is "what is on screen is not what you
 * just asked for", and that is a comparison against a fact the payload has to
 * carry — which mode and which range it was fetched for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const app = read('app.js');
const calendar = read('calendar.js');
const html = read('index.html');

/** Just the skeleton block, not everything after it. */
function skeletonCss() {
  const from = html.indexOf('/* ── Calendar skeleton');
  const end = html.indexOf('/*', html.indexOf('prefers-reduced-motion:reduce', from));
  return html.slice(from, end === -1 ? undefined : end);
}

test('a payload records which mode and range it is for', () => {
  /* Without this nothing can tell current from stale, and the flag is back to
   * guessing from whether any data exists at all. */
  const load = app.slice(app.indexOf('async function loadCalendar()'),
    app.indexOf('async function refreshCalendar()'));
  assert.match(load, /range\.mode = cal\.mode/, 'the payload does not record its mode');
  assert.match(load, /range\.from = r\.from/, 'the payload does not record its range');
  assert.match(load, /range\.to = r\.to/);
});

test('loading means the view on screen is not the view being asked for', () => {
  const load = app.slice(app.indexOf('async function loadCalendar()'),
    app.indexOf('async function refreshCalendar()'));
  assert.ok(!/cal\.loading = !cal\.data;/.test(app),
    'loading is still "we have nothing", so a month change shows the last month');
  assert.match(load, /cal\.data\.mode !== cal\.mode/, 'a mode change does not count as loading');
  assert.match(load, /cal\.data\.from !== want\.from/, 'a range change does not count as loading');
  assert.match(load, /cal\.data\.to !== want\.to/);
  // The comparison has to happen BEFORE the first paint, or it paints stale.
  assert.ok(load.indexOf('cal.loading =') < load.indexOf('scroll.innerHTML = calendarBodyHtml()'),
    'the calendar is painted before it decides whether it is loading');
});

test('a refresh in place is not a navigation, and shows nothing', () => {
  /* A manual sync, a background poll and a Google reconnect all reload the
   * same range. Flashing a skeleton at someone who did not move would be a new
   * annoyance in place of the old one. */
  const load = app.slice(app.indexOf('async function loadCalendar()'),
    app.indexOf('async function refreshCalendar()'));
  assert.match(load, /const want = currentRange\(\)/);
  // refreshCalendar — the poll — must never touch the flag.
  const refresh = app.slice(app.indexOf('async function refreshCalendar()'),
    app.indexOf('async function syncCalendarQuietly()'));
  assert.ok(!/cal\.loading/.test(refresh), 'the background poll can trigger a skeleton');
});

test('the wait is drawn in the shape of what is coming', () => {
  /* A bare "Loading…" would blank the calendar and bring it back, which is a
   * bigger movement than the pop-in it replaces. */
  assert.ok(!/Loading your calendar…/.test(calendar),
    'the calendar still blanks itself to a text line while it waits');
  assert.match(calendar, /export function calendarSkeletonHtml\(\)/);

  const sk = calendar.slice(calendar.indexOf('export function calendarSkeletonHtml()'),
    calendar.indexOf('function calendarCanvasHtml()'));
  // Each mode gets its own geometry, reusing the real containers.
  assert.match(sk, /cal-month is-skeleton/, 'month has no skeleton');
  assert.match(sk, /cal-plan is-skeleton/, 'plan week has no skeleton');
  assert.match(sk, /cal-agenda is-skeleton/, 'agenda has no skeleton');
  assert.match(sk, /length: 42/, 'the month skeleton is not a full grid');
  assert.match(sk, /length: 7 /, 'the plan skeleton is not a full week');
  // The plan column borrows the REAL canvas class, so the height matches.
  assert.match(sk, /class="pl-canvas sk-col"/,
    'the plan skeleton column will not be the height of the real one');
  assert.match(sk, /aria-hidden="true"/, 'the skeleton is read out to screen readers');
});

test('a fast answer never flashes the skeleton', () => {
  /* It resolves in tens of milliseconds on a warm connection. A skeleton seen
   * for 25ms is a worse flicker than the pop-in it was built to remove, so it
   * holds the layout immediately and only becomes visible if the wait lasts. */
  const rule = html.slice(html.indexOf('.is-skeleton{'), html.indexOf('@keyframes sk-appear'));
  assert.match(rule, /opacity:0/, 'the skeleton is visible the instant it renders');
  assert.match(rule, /animation:sk-appear [\d.]+m?s [\w-]+ (\d+)ms forwards/);
  const delay = Number(/animation:sk-appear [\d.]+m?s [\w-]+ (\d+)ms/.exec(rule)?.[1] ?? 0);
  assert.ok(delay >= 100 && delay <= 400, `a ${delay}ms delay is not a sensible threshold`);
});

test('the skeleton styles outrank the real view they sit inside', () => {
  /* The first version declared these ABOVE the calendar's own rules, so
   * `.cm-cell`'s descendants beat `.sk-line` on source order at equal
   * specificity: the placeholders were the right size and completely
   * invisible. Every selector is scoped, and the block comes last. */
  assert.ok(html.indexOf('.is-skeleton .sk-line') > html.indexOf('.cm-grid{'),
    'the skeleton rules are declared before the month grid they must beat');
  for (const sel of ['.sk-cell', '.sk-col', '.sk-item', '.sk-num']) {
    assert.ok(!new RegExp(`\\n\\${sel}\\{`).test(html),
      `${sel} is styled unscoped, so a view rule can silently win`);
  }
});

test('the skeleton uses tokens that exist', () => {
  /* `--text-1` was never defined — the token is `--text`. An undefined custom
   * property makes the whole `color-mix()` invalid, which makes the whole
   * `linear-gradient()` invalid, which makes `background-image` resolve to
   * `none`: correctly sized, animated, and entirely transparent. */
  assert.ok(!/var\(--text-1\)/.test(html), 'a non-existent colour token is still referenced');
  const defined = new Set([...html.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const skeleton = skeletonCss();
  for (const [, name] of skeleton.matchAll(/var\((--[a-z0-9-]+)\)/gi)) {
    assert.ok(defined.has(name!), `the skeleton uses ${name}, which is never defined`);
  }
});

test('motion is optional; the shapes are not', () => {
  const reduced = skeletonCss();
  const block = reduced.slice(reduced.indexOf('@media (prefers-reduced-motion:reduce)'));
  assert.match(block, /animation:none/, 'the sweep keeps running for reduced motion');
  assert.match(block, /background-color:color-mix/, 'the placeholders vanish for reduced motion');
  // The DELAY survives — that is what stops the flash, not the fade.
  assert.match(block, /\.is-skeleton\{animation-duration:1ms\}/,
    'reduced motion loses the delay and gets the flash back');
});
