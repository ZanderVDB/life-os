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

/* ══════════════════════════════════════════════════════════════════════
   THE DENSITY PASS
   The version before this was responsive and correct and still read as a
   narrowed desktop: a task carrying a title and a project name occupied
   126px, so four of them filled a phone screen. These hold the rules that
   fixed it, and the one rule that keeps it honest — nothing was removed,
   only relocated.
   ══════════════════════════════════════════════════════════════════════ */

test('the arrows left the task row and arrived in the sheet', () => {
  /* §4. Two chevrons, an overflow and a drag grip on every row, on a screen
   * where the title had already been truncated to make space for them. The
   * FOOTPRINT goes; the actions do not — and in the sheet they are labelled,
   * which a chevron never was. */
  assert.match(mobileCss, /\.t-grip\{display:none\}/,
    'the permanent arrow row is back on the task card');
  assert.match(mobileCss, /data-act="back"/, 'the move-earlier arrow is on the row again');
  assert.match(mobileCss, /data-act="fwd"/, 'the move-later arrow is on the row again');

  const sheet = app.slice(app.indexOf('function openTaskSheet('), app.indexOf('function closeMenu('));
  for (const [what, re] of [
    ['move earlier', /'back', 'Move earlier'/],
    ['move later', /'fwd', 'Move later'/],
    ['move up', /'up', 'Move up'/],
    ['move down', /'down', 'Move down'/],
    ['every bucket by name', /BUCKETS\.map/],
    ['add a step', /'steps', 'Add a step'/],
    ['add to calendar', /'calendar', 'Add to Calendar'/],
    ['open the task', /'open', 'Open task'/],
  ] as [string, RegExp][]) {
    assert.match(sheet, re, `${what} is not reachable from the task sheet`);
  }
  // And it IS a sheet on a phone, not the desktop popover placed from a
  // button near the bottom of the screen, which has nowhere to go (§47).
  assert.match(app, /if \(isPhone\(\)\) return openTaskSheet\(t\);/,
    'the task menu is still an anchored popover on a phone');
});

test('manual capture stays, at a tenth of the weight', () => {
  /* §5. A full-width purple button beside the assistant card made the home
   * screen ask two questions at once. It is a compact Add in the Today
   * heading now — same id, same handler, beside the count it adds to. */
  assert.match(app, /class="m-add" id="add"/, 'the Add control lost its id or its place');
  assert.match(app, /isPhone\(\) && b\.id === 'today'/,
    'the Add control is drawn on every bucket, or on none');
  const today = app.slice(app.indexOf('function mobileTodayHtml()'), app.indexOf('function habitsCardHtml'));
  assert.ok(!/btn-primary" id="add"/.test(today), 'the full-width primary button is back');
  // Never assumed: a route with no board has no Add button.
  assert.match(app, /const addBtn = document\.getElementById\('add'\);/,
    'wireToday assumes the button exists');
});

test('one page title, and only where it would be a repeat', () => {
  /* §17. The top bar says Calendar; a 34px "Calendar" beneath it says it
   * again and costs 60px. Today and Diary are deliberately absent — their
   * heading is the greeting and the day, which is not the section name — and
   * a detail page keeps its own title, which is the name of the thing. */
  assert.match(app, /const REPEATS_TITLE = \['calendar', 'projects', 'library', 'settings', 'history', 'ai', 'diary'\]/,
    'the list of repeated titles changed without this test changing');
  assert.ok(!/REPEATS_TITLE = \[[^\]]*'today'/.test(app), 'the greeting is being hidden');
  /* Diary's whole header goes on a phone. Its heading was literally the word
   * "Diary" under a bar saying Diary, and its sub-line was the full civil
   * date — which the diary PAGE prints as its own heading three lines below.
   * Two copies of one date, one of which is part of the book. The page keeps
   * it; the header does not repeat it. */
  assert.match(mobileCss, /body:has\(\.dia-page\) \.page-head\.m-dupe > \.sub\{display:none\}/,
    'the diary header is repeating the date the page already prints');
  assert.match(read('diary-entry.js'), /<h2 class="dia-date"/,
    'the date printed inside the diary page is gone, so nothing says the day');
  assert.match(app, /head\.classList\.toggle\('m-dupe', isPhone\(\) && REPEATS_TITLE\.includes\(state\.route\)\)/,
    'nothing marks the header as a repeat');
  // The page actions — Diary's date navigation, Calendar's controls — are
  // never hidden with it.
  const rule = mobileCss.slice(mobileCss.indexOf('.page-head.m-dupe'), mobileCss.indexOf('.page-head.m-dupe') + 240);
  assert.ok(!/page-actions/.test(rule), 'the header hid its controls too');
});

test('the project card is a row, and the Book is not a poster', () => {
  /* Both were invisible until measured. app.css turns `.pj-row` into a
   * column below 900px, and `align-items:flex-start` in a column container
   * sizes children to MAX-CONTENT — so a 362px card laid out at 446px and
   * pushed the page sideways, with the overflow menu on its own line adding
   * 48px to every project. */
  assert.match(mobileCss, /\.pj-row\{flex-direction:row;align-items:flex-start/,
    'the project card is a column again');
  /* And the Book button's icon had a viewBox and no dimensions: stretched to
   * the full width of a phone it grew to fill the button. */
  const projects = read('projects.js');
  assert.match(projects, /<svg width="18" height="18" viewBox="0 0 20 20"/,
    'the Project Book icon has no size again');
  assert.match(mobileCss, /\.pjd-book svg\{flex:0 0 18px/, 'the icon can still grow');
  // §27: below Tasks on a phone, in the header on a desktop, one handler.
  assert.match(projects, /class="pjd-book-card"/, 'there is no compact Book card');
  assert.match(app, /querySelectorAll\('#pjd-book,\.pjd-book-card'\)/,
    'the two Book triggers do not share a handler');
  assert.match(mobileCss, /#pjd-book\{display:none\}/, 'both Book controls show on a phone');
});

test('a sheet appears even when nothing is compositing', () => {
  /* requestAnimationFrame does not fire in a tab that is not painting. The
   * reveal class was added from one, so the sheet mounted, trapped focus,
   * and stayed entirely below the bottom of the screen. The same lesson the
   * pinboard's fit taught. */
  assert.match(mobileJs, /const reveal = \(\) => \{ scrim\.classList\.add\('is-in'\); sheet\.classList\.add\('is-in'\); \};/);
  assert.match(mobileJs, /requestAnimationFrame\(reveal\);\s*\n\s*setTimeout\(reveal, 24\);/,
    'the sheet reveal depends on a frame being painted');
});

test('the orb answers the room, and answers it differently when quiet', () => {
  /* §13. A fixed decorative animation that looks the same whether somebody
   * is speaking or silent fails the one thing the orb exists to say. */
  const orb = read('assistant-orb.js');
  assert.match(orb, /const speaking = amp > 0\.06;/, 'silence and speech are not told apart');
  assert.match(orb, /const gap = speaking \? 210 - amp \* 150 : 620;/,
    'the emit cadence does not change with the voice');
  assert.match(orb, /const travel = age \* \(0\.022 \+ ring\.strength \* 0\.095\);/,
    'a loud ring does not travel further than a quiet one');
  // Near-silence still emits: an orb that goes completely still reads as one
  // that has stopped listening (§9).
  assert.match(orb, /\(speaking \? amp : 0\.05 \+ breathe \* 0\.02\)/,
    'the resting state stops moving entirely');
});

test('quick capture stops pretending to be the Task row below it', () => {
  // §16. Two controls, the same name, different behaviour.
  assert.match(app, /placeholder="Quick capture…"/, 'the field still says "Add a task"');
  assert.match(app, /Lands on Today\. Pick below if it is something else\./,
    'the field does not say where it goes');
});

test('the density scale is a set of tokens, not a pile of margins', () => {
  // §1. One place to change a number, and every phone rule written in it.
  for (const t of ['--m-row:', '--m-row-lg:', '--m-card:', '--m-sec:', '--m-list:']) {
    assert.ok(mobileCss.includes(t), `the density scale is missing ${t}`);
  }
});

test('the pinboard stays a spread, and nothing floats on the pan surface', () => {
  /* The board keeps its geometry and the screen moves over it. Two things
   * follow, and both were wrong before this pass:
   *
   * The viewport has to take the SPREAD's proportions, or a landscape board
   * sits in a portrait box with a third of the screen empty. `aspect-ratio`
   * alone does not do it — the base rule sets `height:100%`, and a box with
   * both dimensions resolved never consults its ratio.
   *
   * And every control has to be somewhere other than on the canvas. The whole
   * surface is a pan target; a button floating in the middle of one is a
   * button you hit while trying to move the board. */
  const book = read('library-book.js');
  const touch = read('pinboard-touch.js');

  assert.match(mobileCss, /aspect-ratio:420\/297;height:auto/,
    'the viewport can be given a height, so the spread lands in a portrait box');
  assert.match(mobileCss, /#bk-book\.bk-spread:has\(\.bk-l-pinboard\)\{min-height:0\}/,
    'the pinboard page keeps the dvh floor, so a band of empty paper follows it');

  // The controls are a SIBLING of the viewport, not a child of it.
  const page = book.match(/function pinboardPageHtml[\s\S]*?\n\}/)?.[0] ?? '';
  const vp = page.match(/<div class="pin-vp"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.ok(vp.length > 0, 'the pinboard viewport is gone');
  assert.ok(!vp.includes('pinViewportControlsHtml'), 'the zoom controls sit on the canvas');
  assert.match(page, /<\/div>\s*(?:<!--[\s\S]*?-->\s*)?\$\{pinViewportControlsHtml\(\)\}/,
    'the zoom controls are not rendered beside the viewport');
  // ...which means they can no longer be found from the host.
  assert.match(touch, /const ctl = host\.closest\('\.bk-l-pinboard'\) \?\? host;/,
    'the controls are still looked up inside the viewport, so they are dead');
  for (const b of ['[data-pin-fit]', '[data-pin-in]', '[data-pin-out]']) {
    assert.ok(!touch.includes(`host.querySelector('${b}')`), `${b} is still bound to the host`);
  }
});

test('an inline step list is legible and reachable at arm\u2019s length', () => {
  // A dashed hairline ring on a tinted card reads as a MISSING control, not as
  // a locked one; and an 18px text link is not a tap target.
  assert.match(mobileCss, /\.step-tick\.is-locked\{border-color:var\(--border-strong\)/,
    'the locked step tick is still a hairline');
  assert.match(mobileCss, /\.ts-more,\.ts-add,\.ts-ready,\.ts-error\{margin-left:0\}/,
    'the panel footer is still indented to the desktop text column');
  assert.match(mobileCss, /\.ts-more\{min-height:34px/, '"n more steps" is not a tap target');
});

test('a touch-target floor is never applied to a drawn glyph', () => {
  /* `.set-idx-chev` is an 8x8 span with two borders and a 45-degree rotation.
   * It was swept into the "wide enough already, just short" rule, and a 42px
   * floor turned it into a 42px diagonal stroke running down the side of the
   * Settings card — the stray mark in the review. The row is the tap target;
   * the arrow is decoration, and `aria-hidden` says so. */
  const settings = read('settings.js');
  assert.match(settings, /class="set-idx-chev" aria-hidden="true"/,
    'the Settings arrow is no longer decorative');
  const floor = mobileCss.match(/^\s*[^\n]*\{min-height:42px\}$/m)?.[0] ?? '';
  assert.ok(floor.length > 0, 'the 42px floor rule is gone');
  assert.ok(!floor.includes('set-idx-chev'),
    'a drawn glyph is being stretched to a touch-target height');
  assert.match(mobileCss, /\.set-idx-chev\{flex:0 0 auto;width:8px;height:8px/,
    'the Settings arrow is no longer an 8px glyph');
});

test('a hidden heading does not leave its row behind', () => {
  /* Projects hides its <h1> on a phone — the bar above already says the word,
   * and §"one page title" is explicit about the repeat. What was left was a
   * 56px row containing one button. New project joins the lifecycle strip,
   * which then scrolls in what remains and fades against the button instead
   * of against the screen edge.
   *
   * Scoped away from `.pjd-head`: the project DETAIL header shares the class
   * and is a column of title, next action and progress. */
  assert.match(mobileCss, /\.pj-head:not\(\.pjd-head\)\{flex-direction:row/,
    'the Projects header is still two rows on a phone');
  assert.match(mobileCss, /\.pj-head:not\(\.pjd-head\) \.pj-head-row\{order:2/,
    'New project is not placed after the filters');
  assert.match(mobileCss, /\.pj-head:not\(\.pjd-head\) \.pj-filters\{order:1;flex:1 1 auto;min-width:0;\s*overflow-x:auto/,
    'the lifecycle strip cannot scroll in the space the button leaves');
  // The strip bleeds left to the screen edge and stops at the button.
  assert.match(mobileCss, /\.pj-filters\{gap:7px;margin-inline:calc\(-1 \* var\(--m-pad\)\) 0;/,
    'the filter strip still bleeds past the New project button');
});
