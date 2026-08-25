/**
 * The mobile version of Life OS, and the assistant's contract.
 *
 * Deliberately small. The evidence that matters for a mobile pass is the
 * browser — walking every route at 390px and hit-testing what is under the
 * finger — and three hundred assertions about class names would not have
 * caught the defect that made the last one worthless. These hold down the
 * rules that a future change could break silently:
 *
 *   - the parity ledger: nothing reachable on a desktop is missing here;
 *   - one breakpoint, shared by the stylesheet and the code;
 *   - the assistant proposes and never writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');

const mobileJs = read('mobile.js');
const mobileCss = read('mobile.css');
const app = read('app.js');
const calendar = read('calendar.js');
const parity = readFileSync(join('..', 'docs', 'mobile-parity.md'), 'utf8');

/* ── One breakpoint ──────────────────────────────────────────────────── */

test('the stylesheet and the code agree on what a phone is', () => {
  /* A class set from one breakpoint and a rule written against another is a
   * bug that only appears in the band of widths where they differ — the
   * bottom bar draws and nothing renders the mobile layout underneath it.
   * So the query is defined once and quoted verbatim. */
  const QUERY = '(max-width:899px),(max-height:500px) and (max-width:1099px)';
  assert.ok(mobileJs.includes(`export const PHONE_MQ = '${QUERY}'`),
    'mobile.js no longer defines the phone query');

  const blocks = mobileCss.match(/@media \(max-width:899px\)[^{]*\{/g) ?? [];
  assert.ok(blocks.length >= 8, `expected the phone query throughout, found ${blocks.length}`);
  for (const b of blocks) {
    assert.equal(b.replace(/@media |\s*\{$/g, '').trim(), QUERY,
      'a phone block was paraphrased instead of using the shared query');
  }

  // The landscape-phone clause is the point of the second half. An iPhone 14
  // Pro Max on its side is 932 wide, which is wider than an iPad in portrait.
  assert.ok(QUERY.includes('max-height:500px'),
    'a landscape phone would be treated as a tablet');
});

test('crossing the breakpoint re-renders rather than restyling', () => {
  /* Mobile Today is different MARKUP, not the same markup at another width.
   * Rotating a phone must not leave a desktop board behind a bottom bar. */
  assert.match(app, /onModeChange: \(\) => \{/, 'nothing reacts to the mode changing');
  assert.match(app, /onModeChange[\s\S]{0,400}loadRoute\(\)/,
    'a mode change does not re-render the route');
  assert.match(app, /if \(isPhone\(\)\) return mobileTodayHtml\(\)/,
    'Today does not have a phone composition');
});

/* ── Parity ──────────────────────────────────────────────────────────── */

test('every destination the sidebar has is reachable on a phone', () => {
  const routes = read('routes.js');
  const primary = routes.slice(routes.indexOf('export const ROUTES'),
    routes.indexOf('SECONDARY_ROUTES'));
  const ids = [...primary.matchAll(/id: '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['today', 'calendar', 'projects', 'diary', 'library'],
    'the sidebar changed; this test has to change with it');

  const bar = mobileJs.slice(mobileJs.indexOf('const NAV = ['),
    mobileJs.indexOf('export const MORE_ITEMS'));
  const more = mobileJs.slice(mobileJs.indexOf('export const MORE_ITEMS'),
    mobileJs.indexOf('const slotFor'));

  for (const id of ids) {
    const inBar = new RegExp(`id: '${id}'`).test(bar);
    const inMore = new RegExp(`id: '${id}'`).test(more);
    assert.ok(inBar || inMore, `${id} is reachable on a desktop and nowhere on a phone`);
  }
  // The secondary destinations too — and Habits and Reminders, which are a
  // sheet and a Calendar utility rather than routes but are still places
  // somebody goes.
  for (const id of ['history', 'settings', 'habits', 'reminders']) {
    assert.match(more, new RegExp(`id: '${id}'`), `${id} is not in More`);
  }
});

test('anything a phone does NOT have is written down, not quietly dropped', () => {
  /* Two things, and both are stated in the ledger with the reason. A third
   * that appears without a line here is a thing somebody removed and nobody
   * decided to remove. */
  assert.match(parity, /## What a phone does NOT have/);
  assert.match(parity, /Plan week/, 'the ledger does not account for Plan week');
  assert.match(parity, /composer/, 'the ledger does not account for the composer');

  // And Plan week's content really is elsewhere.
  assert.match(calendar, /id: 'day'/, 'Day does not exist, so Plan week has no phone answer');
  assert.match(calendar, /id: 'three'/, '3 day does not exist');
});

test('the drawer is gone, and nothing still tries to open it', () => {
  assert.ok(!/drawer-open/.test(app), 'something still toggles the drawer class');
  assert.ok(!/drawer-scrim/.test(read('index.html')), 'the scrim is still in the page');
  assert.match(mobileCss, /\.sidebar,\.drawer-scrim,#drawer-btn\{display:none!important\}/,
    'the sidebar is still on screen on a phone');
});

/* ── Touch ───────────────────────────────────────────────────────────── */

test('a gesture is never the only way to do anything', () => {
  /* §41. Swipe and long press are accelerators. Every one of them has a
   * visible control that does the same thing, because a gesture nobody
   * discovers is a feature nobody has. */
  assert.match(app, /rowSwipe\(el, \{/, 'task rows have no swipe');
  assert.match(app, /onRight: \(\) => toggleTask\(id\)/, 'swipe right does not complete');
  // …and the tick and the menu are still drawn on the row itself.
  assert.match(app, /data-act="toggle"/, 'the visible tick is gone');
  assert.match(app, /data-act="menu"/, 'the visible actions button is gone');

  // The centre button: tap is the assistant, hold is Quick add, and every
  // row Quick add offers exists as a button on the page it belongs to.
  assert.match(mobileJs, /handlers\.quickAdd\?\.\(\);/, 'holding the centre button does nothing');
  assert.match(mobileJs, /if \(!wasHeld && started\) handlers\.assistant/,
    'tapping the centre button does not open the assistant');
});

test('hover-only affordances have a touch equivalent', () => {
  /* §47. Each of these was revealed by :hover on a desktop, which on a
   * phone means revealed by nothing at all. */
  for (const [what, rule] of [
    ['the project overflow', /\.pj-row \.pj-more\{opacity:1/],
    ['the library overflow', /\.lib-obj-more,\.lib-card \.lib-card-more\{opacity:1\}/],
    ['the pinboard handles', /\.bk-pin \.bk-pin-grip,\.bk-pin \[data-pin-resize\]/],
    ['the step delete', /\.m-steps \.ts-row \.ts-x\{opacity:1\}/],
  ] as [string, RegExp][]) {
    assert.match(mobileCss, rule, `${what} is still hover-only on a phone`);
  }
});

test('the software keyboard is measured, not guessed', () => {
  /* window.innerHeight minus visualViewport.height is not the keyboard: iOS
   * keeps innerHeight tall while the address bar shows, and anything that
   * scales the layout viewport puts a permanent gap between them. Measuring
   * that way reports a keyboard that is not there and hides the navigation
   * on a page nobody is typing into. */
  assert.ok(!/window\.innerHeight - vv\.height/.test(mobileJs),
    'the keyboard is derived from the layout viewport again');
  assert.match(mobileJs, /if \(vv\.height > tallest\) tallest = vv\.height/,
    'nothing records the keyboard-free height');
  assert.match(mobileJs, /const covered = tallest - vv\.height/,
    'the keyboard is not measured against the tallest viewport seen');
  // And a rotation starts the record again.
  assert.match(mobileJs, /if \(Math\.round\(vv\.width\) !== width\)/,
    'rotating leaves a stale tallest height');
});

test('safe areas are honoured where something is pinned to an edge', () => {
  for (const [what, rule] of [
    ['the bottom navigation', /padding-bottom:var\(--m-safe-b\)/],
    ['a sheet', /\.msheet\{[\s\S]{0,400}padding-bottom:var\(--m-safe-b\)/],
    ["a dialog's footer", /\.m-foot\{[\s\S]{0,300}calc\(14px \+ var\(--m-safe-b\)\)/],
  ] as [string, RegExp][]) {
    assert.match(mobileCss, rule, `${what} ignores the safe area`);
  }
  assert.match(read('index.html'), /viewport-fit=cover/,
    'the page does not opt into the safe area at all');
});

/* ── Calendar ────────────────────────────────────────────────────────── */

test('the phone calendar reuses the desktop time grid', () => {
  /* One implementation of "where does a 2pm event sit". Two would drift, and
   * the phone is the one nobody would notice had drifted. */
  assert.match(calendar, /function timeGridHtml\(days, cls\)/);
  assert.match(calendar, /function planHtml\(\) \{\s*\n\s*return timeGridHtml\(weekOf/,
    'Plan week no longer shares the grid');
  // And the visible hours grow to contain what is really there, so a 6am
  // flight is not simply invisible.
  assert.match(calendar, /function hoursFor\(days\)/, 'the hour window is fixed');
  assert.match(calendar, /lo = Math\.min\(lo, a\.getHours\(\)\)/,
    'an early event would fall outside the window');
});

/* ── Settings ────────────────────────────────────────────────────────── */

test('Settings is an index and a page, and every section survives', () => {
  const settings = read('settings.js');
  const tabs = [...settings.matchAll(/\{ id: '(\w+)', label: '[^']+'/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 7, 'the settings sections changed');
  assert.match(settings, /if \(phone && !tab\)/, 'a phone has no settings index');
  assert.match(settings, /data-stab-back/, 'there is no way back to the index');
  // The index is built from the SAME list the desktop column is built from,
  // so a new section cannot appear on one and not the other.
  assert.match(settings, /if \(phone && !tab\) \{[\s\S]{0,400}SETTINGS_TABS\.map/,
    'the phone index is a hand-written copy of the section list');
  assert.match(mobileCss, /\.set-nav\{display:none\}/, 'the desktop column is still beside it');
});
