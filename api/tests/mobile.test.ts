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
  /* The travelling rings are gone — they read as sonar — and the listening
     animation is a waveform around the orb. The RULE is unchanged and is what
     is asserted: the voice must visibly change the picture, and near-silence
     must not stop it dead. */
  const wave = orb.slice(orb.indexOf('drawWaveform('));
  // Amplitude reaches the shape, the brightness and the weight.
  assert.match(wave, /swing = R \* \([\d.]+ \+ a \* [\d.]+\)/,
    'the voice does not change the waveform’s reach');
  assert.match(wave, /alpha = lead[\s\S]{0,60}a \* [\d.]+/,
    'the voice does not change how bright it is');
  assert.match(wave, /lineWidth = Math\.max\([\s\S]{0,60}a \* [\d.]+/,
    'the voice does not change how heavy it is');
  // Near-silence still moves: an orb that goes completely still reads as one
  // that has stopped listening (§9). The constant term is what guarantees it.
  assert.match(wave, /swing = R \* \(0\.0[1-9]/,
    'the resting state stops moving entirely');
  assert.match(wave, /phase = this\.t \//, 'the waveform does not advance over time');
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

test('the canvas gradient is a layer, not a fixed background attachment', () => {
  /* `body { background: var(--app-bg); background-attachment: fixed }` is what
   * this was. iOS Safari has a long-standing quirk here: it does not honour
   * `fixed` on the scrolling root and falls back to `scroll`, which sizes the
   * ramp to the body box and then TILES it.
   *
   * Simulated by forcing `background-attachment: scroll` on a 390x844 phone:
   * at the foot of Diary the left column read #191622 - #100f19 - #171320 —
   * darkening and then jumping back light, a seam across the page. Under
   * `fixed` the same column is #191622 - #11101c - #100f18 at both ends of
   * the page. With the layer, forcing `scroll` changes nothing at all.
   *
   * The layer is inert everywhere that already worked: desktop and phone mean
   * luminance were identical to five decimals before and after. */
  const appCss = read('app.css');
  assert.match(appCss, /body::before\{content:'';position:fixed;inset:0;z-index:-2;\s*background:var\(--app-bg\);pointer-events:none\}/,
    'the canvas ramp is not painted by a fixed layer');
  assert.ok(!/background-attachment:fixed/.test(appCss),
    'a fixed background attachment is back, and iOS does not honour it');
  // Behind the star field, which is -1, and body must stay context-free or
  // both would be trapped behind the page instead of behind the content.
  assert.match(appCss, /#los-stars\{position:fixed;inset:0;width:100vw;height:100vh;z-index:-1/,
    'the star layer moved, so -2 may no longer be below it');
  // The flat colour under the layer is what the overscroll bounce and the
  // status bar show, so it has to match <meta name="theme-color">.
  assert.match(appCss, /--app-bg-flat:#141220;/, 'the flat canvas colour is gone');
  assert.match(read('index.html'), /<meta name="theme-color" content="#141220">/,
    'theme-color and the flat canvas colour have drifted apart');
});

test('a phone renders the desktop palette, unchanged', () => {
  /* There is no phone palette, and the whole detour that produced one was a
   * bad install: the app had been added to the home screen from a browser
   * other than Chrome, and that WebAPK rendered it wrongly. On a correct
   * install #282431 on #141220 reads exactly as it does on a desktop.
   *
   * What survives is this test. A phone is not a different palette — it is
   * the same one on a display that renders black differently — so anything
   * that wants to fork it has to argue with this first. */
  const at = mobileCss.indexOf('THE PHONE PALETTE');
  assert.ok(at > 0, 'the phone palette note is gone');
  const rule = mobileCss.slice(at, mobileCss.indexOf('PHONE SHELL', at));
  for (const token of ['--app-bg', '--surface', '--surface-2', '--surface-3',
    '--paper', '--paper-2', '--border', '--border-strong', '--hairline',
    '--task', '--task-hover']) {
    assert.ok(!new RegExp(`${token}:`).test(rule),
      `${token} is overridden for phones — the palette is one palette`);
  }
  // Nowhere else either: the exception used to be written as rules.
  assert.ok(!/\.task\{background:#/.test(mobileCss), 'a phone task card has its own fill again');

  /* The bar stays OPAQUE, and that is not a palette change — it is what
     stops the ring the centre button cuts in it from showing. A 92% ring
     over a 92% bar of the same colour composites to 99.4%. */
  assert.match(rule, /--m-bar:#191622;/, 'the bar is not the shared opaque value');
  assert.ok(!/--m-bar:rgba/.test(mobileCss),
    'the bar is translucent again, so the button ring will not match it');
});
test('Appearance offers no control that does nothing', () => {
  /* Theme was System / Always dark and nothing read the value — there is no
   * light palette and no prefers-color-scheme rule anywhere — so both
   * settings rendered the same screen. It is where you go looking when the
   * app seems too dark, and it answered by doing nothing. */
  const settings = read('settings.js');
  const panel = settings.slice(settings.indexOf('function appearancePanel'),
    settings.indexOf('function areasPanel') >= 0
      ? settings.indexOf('function areasPanel') : undefined);
  assert.ok(!/segment\('appearance'/.test(panel), 'the inert Theme control is back');
  // The markup, not the prose: the note explaining why it went names it.
  assert.ok(!/row\('Theme'/.test(settings), 'the Theme row is back');
  // Motion and Sounds ARE wired up, and stay.
  assert.match(panel, /segment\('reducedMotion'/, 'Motion left with it');
  assert.match(panel, /segment\('sounds'/, 'Sounds left with it');
  assert.match(app, /document\.documentElement\.dataset\.motion =/,
    'nothing applies the motion preference, so that one is inert too');
  // Still accepted and stored, so a real light theme needs no migration.
  const prefs = readFileSync(join('src', 'routes', 'preferences.ts'), 'utf8');
  assert.match(prefs, /appearance: \{ values: \['system', 'dark'\]/,
    'the stored preference was dropped along with the control');
});

test('the centre button glows from a shadow, not from a layer over its face', () => {
  /* The bloom was `::before { z-index:-1 }` with a comment claiming it sat
   * BEHIND the button. It did not: `transform` makes .mnav-ai a stacking
   * context, and inside one the element's own background paints BEFORE
   * negative-z-index children — so the bloom was laid over the face. Measured,
   * it only cost 1/255 because the veil is nearly the same violet as the
   * button under it, which is luck rather than design and is exactly what
   * renders differently on another engine.
   *
   * A box-shadow is drawn outside the border-box by definition. */
  assert.ok(!/\.mnav-ai::before/.test(mobileCss),
    'the bloom is a pseudo-element again, and it paints over the face');
  const from = mobileCss.indexOf('.mnav-ai{', mobileCss.indexOf('lit rather than glowing'));
  // Comments stripped: the notes inside the rule name the values they replaced.
  const btn = mobileCss.slice(from, mobileCss.indexOf('.mnav-ai:active', from))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(btn, /0 0 18px 2px rgba\(138,93,255,\.34\)/, 'the bloom is gone rather than moved');
  // The ramp's dark end was #4E27B4 — 6.37% of white, navy once a display
  // adds saturation, and it was reported as "a dark disc with a light ring".
  // On the rule, not the file: the note above it names the colour it replaced.
  assert.ok(!/#4E27B4/i.test(btn), 'the navy end of the button ramp is back');
  assert.match(btn, /#6438D8 100%/, 'the button ramp does not end on the raised value');
});

test('nothing on the centre button can draw a ring', () => {
  /* Reported three times as a light ring around the button, never once
   * reproducible here. Three declarations could draw one: a `0 0 0 5px`
   * cut-out meant to punch the bar away from it, and two dark contact
   * shadows under it. All three are hard-edged annuli, and an annulus is
   * only invisible while it happens to match whatever is behind it — which
   * is a bet on somebody else's display.
   *
   * A spread step on a non-inset shadow is what makes an edge. So: none. */
  const from = mobileCss.indexOf('.mnav-ai{', mobileCss.indexOf('lit rather than glowing'));
  const btn = mobileCss.slice(from, mobileCss.indexOf('.mnav-ai:active', from))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/0 0 0 5px|0 0 0 7px/.test(btn), 'the cut-out ring is back');
  assert.ok(!/rgba\(0,0,0,\.35\)/.test(btn),
    'the black contact shadow is back, and the bar is light enough to show it');
  assert.match(btn, /0 0 18px 2px rgba\(138,93,255,\.34\)/, 'the glow is gone');
});

test('the habits row is a row you scroll, not a grid with a "more" button', () => {
  /* Six tiles and "3 more · See all" underneath. The button was a second way
   * to reach a page the header chevron already reaches, and it cost a line to
   * say so. A row you push sideways shows every habit due today.
   *
   * `display:flex` does NOT reset an inherited `flex-direction:column`, and
   * the list layout above this one sets exactly that — which stacked the
   * tiles vertically and showed one habit. */
  assert.match(mobileCss, /\.m-habits-row\{display:flex;flex-direction:row;/,
    'the row can inherit a column direction again');
  assert.match(mobileCss, /\.m-habits-row\{[^}]*overflow-x:auto/, 'the row does not scroll');
  assert.match(mobileCss, /\.m-hb\{flex:0 0 92px;scroll-snap-align:start;/,
    'the tiles have no fixed width, so they squeeze instead of scrolling');
  assert.ok(!/m-habits-more/.test(mobileCss + app), 'the "see all" button is back');
  assert.ok(!/const PREVIEW/.test(app), 'the habits list is capped again');
  // The mark is what tells you it worked; it was drawn for a 13px rail row.
  assert.match(mobileCss, /\.m-hb \.hr-mark\{width:20px;height:20px\}/, 'the check is small again');
  assert.match(mobileCss, /\.m-hb \.hb-ring\{width:40px;height:40px/, 'the ring is small again');
});

test('a settle that has not landed is cancelled when the habit is undone', () => {
  /* Unchecking within the 320ms left the drop pending, and it fired on a ring
   * that was no longer complete — writing `stroke-dasharray:none` and
   * `stroke-dashoffset:0`, which is a FULL ring. `.is-empty` hid it at
   * opacity 0, so it read as a faint green ghost rather than an obvious bug,
   * and the next check had nothing left to animate from. */
  assert.match(app, /function cancelSettle\(fill\)/, 'a pending settle cannot be stopped');
  assert.match(app, /fill\.removeEventListener\('transitionend', fill\._drop\)/,
    'the transitionend listener outlives the settle');
  const paint = app.slice(app.indexOf('function paintHabitRing'));
  assert.match(paint.slice(0, 1400), /\} else \{\s*cancelSettle\(fill\);/,
    'undoing a habit does not cancel the settle that is still pending');
});

test('an update that was already waiting is taken at boot, not asked about', () => {
  /* The worker never calls skipWaiting itself, and the page asked before
   * switching over. The reason was good — never change the app under somebody
   * mid-sentence — but at BOOT there is no sentence: nothing is typed, nothing
   * is half-finished, and the reload is indistinguishable from the load
   * already happening.
   *
   * What it cost: an installed app whose owner tapped "Later" once, or looked
   * past the toast, stays on that build forever, and every later deploy
   * installs another worker that waits behind the same prompt. Three rounds of
   * "the phone looks exactly the same" were this, while the same build
   * rendered correctly in a narrow desktop window that had no worker in the
   * way. */
  const pwa = read('pwa.js');
  assert.match(pwa, /if \(reg\.waiting && navigator\.serviceWorker\.controller\) \{/,
    'a worker waiting at boot is still only offered, never taken');
  assert.match(pwa, /postMessage\(\{ type: 'SKIP_WAITING' \}\)/, 'nothing takes it');
  /* It waits for a moment when nothing is being interrupted. An installed
     app resumed from the background is booting and being USED at the same
     instant — which is how a reload arrived while somebody was mid-sentence
     to the assistant, taking the microphone with it. */
  assert.match(pwa, /const take = \(\) => \{\s*if \(isBusy\(\)\)/,
    'the boot hand-over can interrupt a sentence');

  // The prompt survives for updates that arrive DURING a session, which is
  // the only case where the question means anything.
  assert.match(pwa, /if \(next\.state === 'installed' && navigator\.serviceWorker\.controller\) noteWaiting\(next\)/,
    'a mid-session update no longer announces itself');

  // And Settings can apply one directly rather than pointing at a prompt.
  assert.match(pwa, /window\.__applyUpdate = \(\) => \{/, 'there is no way to apply an update on demand');
  assert.match(app, /window\.__applyUpdate\?\.\(\)/, 'Check now still only reports');

  /* The prompt had NO phone rules, so it used the desktop geometry: pinned
     above `--composer-h`, a bar a phone does not have. Measured at 360px it
     was a 253px box floating mid-screen. */
  assert.match(mobileCss, /\.updater\{left:12px;right:12px;transform:none;max-width:none;/,
    'the update prompt is back to desktop geometry on a phone');
  assert.match(mobileCss, /\.updater\{[^}]*bottom:calc\(var\(--m-nav-h\) \+ var\(--m-safe-b\) \+ 12px\)/,
    'the prompt is not placed against the bottom navigation');
});
