/**
 * Phase D4.7 — header centring, shared utility surfaces, rail motion.
 *
 * The centring assertions are the point of this file. Three phases in a row
 * reported the mode selector as perfectly centred, because it WAS perfectly
 * centred — inside a header row that had itself collapsed to max-content and
 * gone to sit on the left. A stale `align-items:start`, left behind when D4.2
 * swapped the header from grid to column flex, did it: in a column flex
 * container `align-items` governs the horizontal axis.
 *
 * So these tests assert the thing that was actually wrong (the row must be able
 * to fill the frame) rather than the thing that always passed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const html = read('index.html');
const app = read('app.js');
const calendar = read('calendar.js');
const util = read('utility-menu.js');
const motion = read('motion.js');

const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
const appCode = code(app);
const calCode = code(calendar);
const utilCode = code(util);
/* Comments are stripped before searching so a rule that only survives as prose
   cannot satisfy a test. */
const css = code(html);

function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `${decl} not found`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:async )?(?:export )?(?:function |const \w+ = )/);
  return end === -1 ? rest : rest.slice(0, end);
}

/* ── §2 The root cause ───────────────────────────────────────────────── */

test('centring: the stale align-items that collapsed every header row is gone', () => {
  // `.cal-head{display:grid;grid-template-columns:1fr auto;align-items:start}`
  // from D3. D4.2 replaced the display and left this behind.
  assert.ok(!/\.cal-head\{[^}]*align-items:start/.test(css),
    'the header still inherits align-items:start, so its rows shrink to max-content');
  assert.ok(!/\.cal-head\{display:grid/.test(css), 'the superseded grid header survives');
});

test('centring: alignment is stated where the header layout is stated', () => {
  // Not merely absent — asserted. A future `display:` change must not be able to
  // resurrect a shrink-wrapped header by accident.
  assert.match(css, /\.cal-head\{align-items:stretch\}/,
    'the header does not state its own cross-axis alignment');
  assert.match(css, /\.cal-head-row\{width:100%\}/, 'the header row cannot fill the frame');
});

test('centring: three columns with a centre that cannot be squeezed', () => {
  assert.match(css, /\.cal-head-row\{display:grid;grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/,
    'a bare 1fr lets the wider side column steal from the middle');
  assert.match(css, /\.cal-head-mid\{justify-self:center\}/, 'the centre zone is not centred');
});

/* ── §3/§11 One frame, and it does not move ──────────────────────────── */

test('frame: the header and the body share one width and one anchor', () => {
  assert.match(css, /\.cal-head,\.cal-body\{width:auto;max-width:var\(--cal-max\);\s*margin-left:var\(--cal-inset\);margin-right:0\}/,
    'the header and the body do not share a frame');
  // Reminders is a Calendar surface, so leaving it must not slide the page.
  assert.match(css, /\.rv\{width:auto;max-width:var\(--cal-max\);margin-left:var\(--cal-inset\)/,
    'the Reminders workspace is not on the Calendar frame');
});

test('frame: centred on the WINDOW, not on the column beside the sidebar', () => {
  // `margin-inline:auto` centres inside .main-col, which starts after the
  // sidebar — so the calendar sat 84px right of the middle of the screen and
  // left a visibly larger gap on the left. Every term below is a token this
  // layout already uses, so it is derived rather than nudged.
  assert.match(css, /--cal-win:calc\(100vw - var\(--sbw\)\)/, 'the window width is not defined');
  assert.match(css, /--cal-wrap-offset:max\(0px, calc\(\(var\(--cal-win\) - var\(--sidebar-w\) - var\(--content-max\)\) \/ 2\)\)/,
    'the wrap offset is not reconstructed');
  assert.match(css, /--cal-col-left:calc\(var\(--sidebar-w\) \+ var\(--cal-wrap-offset\) \+ 44px\)/,
    'the column origin is not reconstructed');
  assert.match(css, /--cal-inset:max\(0px, calc\(\(var\(--cal-win\) - var\(--cal-max\)\) \/ 2 - var\(--cal-col-left\)\)\)/,
    'the inset is not the distance to a window-centred frame');
  // max(0px, …) is what makes a narrow window fall back to filling the column
  // instead of pulling the frame off the left edge.
  assert.ok(!/--cal-inset:calc\(/.test(css), 'the inset is unclamped and can go negative');
});

test('frame: the scrollbar is reserved and subtracted, not ignored', () => {
  // Two separate errors this closes. The gutter appearing only on modes tall
  // enough to scroll made Month render 15px narrower than Agenda; and 100vw
  // INCLUDES the scrollbar, so without --sbw the frame sat half a scrollbar
  // right of centre on any page that scrolls.
  assert.match(css, /html\{scrollbar-gutter:stable\}/, 'the scrollbar gutter is not reserved');
  assert.match(css, /:root\{--sbw:0px\}/, 'the scrollbar width has no default');
  const fn = body(appCode, 'function measureScrollbar()');
  assert.match(fn, /document\.documentElement\.getBoundingClientRect\(\)\.width/,
    'clientWidth misreports once the gutter is reserved — measure the root box');
  assert.match(fn, /setProperty\('--sbw'/, 'the measurement never reaches the CSS');
  assert.match(appCode, /addEventListener\('resize', \(\) => \{ positionPill\(true\); measureScrollbar\(\); \}\)/,
    'the scrollbar is measured once and never again');
});

test('frame: Agenda starts on the same left edge as Month', () => {
  // Agenda led with a 64px date gutter, so its cards began ~80px further in
  // than every other mode's content while the canvas edges matched — the modes
  // looked like they were on different margins.
  assert.match(css, /\.cal-body \.ag-day\{grid-template-columns:minmax\(0,1fr\)/,
    'Agenda still reserves a date column beside its items');
  assert.match(css, /\.cal-body \.ag-date\{flex-direction:row/,
    'the date is still stacked as a gutter rather than labelled above');
});

test('frame: the rail belongs to the Calendar, not to the page', () => {
  // A PAGE rail column changes .main-col's width, and the header and the canvas
  // are both centred inside .main-col — so opening the rail slid both sideways.
  // Zero-width track, gutter kept: the frame must centre in exactly the column
  // width it has centred in since D4.2, or the whole composition shifts. The
  // first attempt dropped the track entirely, which widened .main-col by the
  // gutter and slid everything 38px right.
  assert.match(css, /body:has\(\.cal-head\) \.main-wrap\{grid-template-columns:minmax\(0,1fr\) 0\}/,
    'the column the frame centres in changed width');
  assert.match(css, /body:has\(\.cal-head\) \.rail\{display:none\}/,
    'the page rail still renders behind the calendar rail');
  assert.match(calCode, /<aside class="cal-rail" id="cal-rail"/,
    'the calendar does not own its rail');
});

test('frame: nothing page-level is allowed to depend on the rail', () => {
  // Everything the header contains must be positioned by the frame alone.
  for (const sel of ['cal-head-main', 'cal-head-side', 'cal-layers', 'cal-period']) {
    assert.ok(!new RegExp(`cal-rail-open[^{]*\\.${sel}`).test(css),
      `${sel} moves when the rail opens`);
  }
});

test('frame: the header does not move when the rail opens', () => {
  // The first attempt translated the selector by half the rail so it stayed
  // centred over the GRID. That meant selecting a day slid it 172px, and Plan
  // week's permanent rail left its header sitting off to one side of Month and
  // Agenda's. The rail is content; content does not move the page's controls.
  assert.match(css, /\.cal-head-mid\{translate:none\}/,
    'the selector still shifts sideways when the rail opens');
  assert.ok(!/\.cal-head-mid\{translate:calc/.test(css), 'the rail offset survives');
  assert.match(css, /body\.cal-rail-open\{--cal-rail-col:calc\(var\(--cal-rail-w\) \+ var\(--cal-rail-gap\)\)\}/,
    'the rail column is not one shared value');
  assert.match(css, /\.cal-body\{[^}]*grid-template-columns:minmax\(0,1fr\) var\(--cal-rail-col\)/,
    'the rail width is not driven by that value');
});

test('header: the sliding pill matches the button under it', () => {
  // The pill is a third of the track and moves in exact thirds, but the buttons
  // were content-width — 72 / 74 / 87px — so the highlight never lined up with
  // its own label. Measured 7.5px off on Agenda and 9.4px too narrow for
  // "Plan week".
  assert.match(css, /\.cal-modes\{display:grid;grid-template-columns:repeat\(var\(--mode-n\),1fr\)\}/,
    'the mode buttons are not equal width, so the pill cannot line up');
  assert.match(css, /\.cal-mode-pill\{[^}]*width:calc\(\(100% - 6px\) \/ var\(--mode-n\)\)/,
    'the pill is not one track column wide');
  assert.match(css, /\.cal-mode-pill\{[^}]*transform:translateX\(calc\(var\(--mode-i\) \* 100%\)\)/,
    'the pill does not travel in whole columns');
  // NOT flex:1 — a zero basis makes the columns equal but lets them fall below
  // their own labels, and "Plan week" then overflowed its padding and sat
  // 5.4px right of centre. `1fr` keeps an auto minimum.
  assert.ok(!/\.cal-modes button\{flex:1/.test(css), 'a zero flex basis can clip the widest label');
});

test('header: the period label is centred between its arrows', () => {
  // The 168px min-width stops the control twitching as the label changes
  // length, but the text was left-aligned inside it: 7px from the left arrow
  // and 70.6px from the right.
  assert.match(css, /\.cal-period-label\{text-align:center\}/,
    'the date sits against the left arrow');
  assert.match(css, /\.cal-period-label\{[^}]*min-width:168px/,
    'the label has no stable width, so the arrows move as the period changes');
});

/* ── §9/§10 Rail motion ──────────────────────────────────────────────── */

test('motion: a real layout transition, not margin arithmetic', () => {
  assert.match(css, /\.cal-body\{[^}]*transition:grid-template-columns var\(--d-slow\) var\(--e-out\)/,
    'the frame does not animate its columns');
  // The selector used to transition too, tracking the canvas centre. It does
  // not move at all now — see 'the header does not move when the rail opens'.
  assert.match(css, /\.cal-head-mid\{translate:none\}/, 'the selector moves with the rail');
  // --d-slow is 260ms: inside the 260-320ms structural band, and an existing
  // token rather than a new number.
  assert.match(css, /--d-slow:260ms/, 'the structural duration is not the shared token');
});

test('motion: the rail is clipped, not squeezed', () => {
  // Reflowing 320px of content down to nothing mid-transition is what produces
  // the text shuffle and re-wrap §10 forbids.
  assert.match(css, /\.cal-rail\{min-width:0;overflow:hidden/, 'the rail does not clip');
  assert.match(css, /\.cal-rail-in\{width:var\(--cal-rail-w\)/,
    'the rail content has no fixed width, so it re-wraps while the column moves');
});

test('motion: opening fades the content in behind the structural move', () => {
  const fn = body(appCode, 'function renderCalendarRail()');
  assert.match(fn, /body\.classList\.add\('has-rail'\)/, 'the column never opens');
  assert.match(fn, /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) =>\s*body\.classList\.add\('rail-shown'\)\)\)/,
    'the content appears in the same frame as the structural change');
  assert.match(css, /\.cal-rail-in\{[^}]*opacity:0;transition:opacity var\(--d-base\) var\(--e-out\)\}/,
    'the rail content does not fade');
});

test('motion: closing fades first, collapses, and only then clears', () => {
  const fn = body(appCode, 'function renderCalendarRail()');
  const close = fn.slice(fn.indexOf('if (!open)'), fn.indexOf('const prevMode'));
  assert.ok(close.indexOf("remove('rail-shown')") < close.indexOf("remove('has-rail')"),
    'the column collapses before the content has faded');
  assert.match(close, /afterTransition\(body, 'grid-template-columns', RAIL_MS/,
    'the rail markup is cleared without waiting for the collapse');
  // …and never clears a rail that was reopened while the collapse was running.
  assert.match(close, /body\.classList\.contains\('has-rail'\)\) return/,
    'reopening during the close animation still wipes the rail');
});

test('motion: no second snap — the frame is never rebuilt to animate it', () => {
  // A transition needs a continuous node. Replacing #cal-body is how this
  // silently becomes a jump again, which is exactly how C4 lost its FLIP.
  const fn = body(appCode, 'function renderCalendarRail()');
  assert.ok(!/cal-body'\)[^;]*innerHTML =/.test(fn), 'the frame is re-rendered on every rail change');
  assert.match(fn, /const body = document\.getElementById\('cal-body'\)/,
    'the frame is not looked up, so its identity is not preserved');
  // Selecting a day must not repaint the canvas either.
  const sel = body(appCode, 'function selectDay(day)');
  assert.ok(!/paintCalendar\(\)/.test(sel), 'selecting a day rebuilds the whole canvas');
});

test('motion: the header is outside the animated element', () => {
  // If the header lived inside .cal-body it would be dragged by the column
  // change — the shift §11 forbids.
  const frame = body(calCode, 'export function calendarBodyHtml()');
  assert.ok(!/cal-head/.test(frame), 'the header is inside the animated frame');
  assert.match(appCode, /head\.innerHTML = calendarHeaderHtml\(\)/,
    'the header is not rendered into the page header');
});

test('motion: reduced motion gets a stable layout, not a shortened sweep', () => {
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\s*\.cal-body,\.cal-head-mid,\.cal-rail-in\{transition:none\}/,
    'reduced motion still animates the rail');
  const fn = body(appCode, 'function renderCalendarRail()');
  assert.match(fn, /if \(reducedMotion\(\)\) body\.classList\.add\('rail-shown'\)/,
    'reduced motion still defers the content by two frames');
});

test('motion: the transition cleanup cannot be stranded', () => {
  // transitionend is no more reliable than onfinish — same lesson as settle().
  assert.match(motion, /export function afterTransition\(el, prop, duration, done\)/,
    'there is no guarded wait for a CSS transition');
  const fn = body(code(motion), 'export function afterTransition(el, prop, duration, done)');
  assert.match(fn, /setTimeout\(once, duration \+ 80\)/, 'the timeout guarantee is missing');
  assert.match(fn, /e\.propertyName === prop/, 'any transitionend fires the cleanup');
});

test('motion: the tablet layout stacks rather than crushing the grid', () => {
  const mq = css.slice(css.indexOf('@media (max-width:1180px)'));
  assert.match(mq.slice(0, 400), /body\.cal-rail-open\{--cal-rail-col:0px\}/,
    'a narrow screen still gives 344px to the rail');
  assert.match(mq.slice(0, 400), /\.cal-body\{grid-template-columns:minmax\(0,1fr\);transition:none\}/,
    'the grid still animates its width where there is no width to give');
});

/* ── §4/§5 One utility trigger and one menu ──────────────────────────── */

test('utility: Today and Calendar use the same trigger component', () => {
  // They were 34px bare and 38px filled, with a menu class each.
  // A shared CLASS was not enough: the two glyphs still drifted, because the
  // markup was hand-written 2000 lines apart. Today drew its three dots
  // VERTICALLY and Calendar drew them horizontally, and the shared class made
  // them the same size and shape while leaving them different controls.
  assert.match(utilCode, /export const utilityTriggerHtml = \(id, label\)/,
    'the trigger markup is not shared');
  assert.match(appCode, /utilityTriggerHtml\('today-more', 'More actions'\)/,
    'Today still hand-writes its trigger');
  assert.match(calCode, /utilityTriggerHtml\('cal-util', 'Calendar options'\)/,
    'Calendar still hand-writes its trigger');
  // Horizontal: same cy, varying cx. A vertical glyph inverts these.
  assert.match(utilCode, /cx="4\.5" cy="10"[\s\S]{0,80}cx="10" cy="10"[\s\S]{0,80}cx="15\.5" cy="10"/,
    'the shared overflow glyph is not horizontal');
  assert.ok(!/cx="10" cy="4\.5"/.test(appCode + calCode), 'a vertical dots glyph survives');
  for (const gone of ['today-more{', 'cal-util{', '.cal-util-menu', '.today-menu']) {
    assert.ok(!css.includes(gone), `the per-page control ${gone} survives`);
  }
  assert.match(css, /\.util-btn\{width:34px;height:34px/, 'the shared trigger has no geometry');
  for (const state of [':hover', ':active', '\\[aria-expanded="true"\\]', ':focus-visible']) {
    assert.ok(new RegExp(`\\.util-btn${state}`).test(css), `the shared trigger has no ${state} state`);
  }
});

test('utility: the trigger sits at the upper-right on both pages', () => {
  // Wedged between the mode selector and Add it read as a third kind of thing.
  const side = calCode.slice(calCode.indexOf('cal-head-side'), calCode.indexOf('cal-head-sub'));
  assert.ok(side.indexOf('cal-add') < side.indexOf('cal-util'),
    'the overflow is not the last control in the header');
  assert.match(appCode, /page-actions[\s\S]{0,120}utilityTriggerHtml\('today-more'/,
    'Today\'s overflow left the page actions');
});

test('utility: one menu builder, not one per page', () => {
  assert.match(utilCode, /export function openUtilityMenu\(anchor, items, onSelect\)/,
    'there is no shared menu');
  for (const fn of ['openTodayMenu', 'openCalendarUtility']) {
    const b = body(appCode, `function ${fn}(anchor)`);
    assert.match(b, /openUtilityMenu\(anchor,/, `${fn} still builds its own menu`);
    assert.ok(!/document\.createElement\('div'\)/.test(b), `${fn} still hand-rolls a surface`);
  }
});

test('utility: menu and surface are the same kind of object', () => {
  // §16 The audit found two: .menu carried its own `rise` on top of the shared
  // entrance, so the menu settled 8px below where the surface opened from the
  // same button; and the panels were 13px rounded against .menu's 12px.
  assert.match(css, /\.util-menu\{min-width:212px;padding:6px;animation:none\}/,
    'the menu runs a second entrance animation on top of the shared one');
  assert.match(css, /\.util-surface\{[^}]*border-radius:12px/,
    'the surface is a different roundness from the menu it opens from');
  assert.match(css, /\.util-surface\{[^}]*box-shadow:var\(--e3\)/, 'a bespoke shadow');
  assert.match(css, /\.menu\{[^}]*box-shadow:var\(--e3\)/, 'the menu shadow drifted');
});

test('utility: one anchoring rule, applied everywhere', () => {
  // Sources opened right-aligned and the Key left-aligned from the same header.
  const fn = body(utilCode, 'function place(anchor, el)');
  assert.match(fn, /b\.right - w/, 'the surface is not right-aligned to its trigger');
  assert.match(fn, /b\.bottom \+ GAP/, 'the surface does not open below its trigger');
  assert.match(fn, /window\.innerWidth - w - EDGE/, 'there is no viewport fallback');
  // And only one set of numbers exists.
  assert.match(utilCode, /const GAP = 6;/, 'the trigger gap is not a shared constant');
});

/* ── §6/§7 Sources and Key are one surface ───────────────────────────── */

test('surface: Sources and the Key share a shell', () => {
  assert.match(css, /\.util-surface\{position:fixed;z-index:300;width:308px/,
    'there is no shared surface shell');
  for (const gone of ['.legend{position:fixed', '.sources{position:fixed']) {
    assert.ok(!css.includes(gone), `${gone} still carries its own shell`);
  }
  // Contents only.
  assert.match(css, /\.legend\{display:flex;flex-direction:column;gap:13px\}/,
    'the key is still a positioned panel');
  assert.match(css, /\.sources\{display:flex;flex-direction:column;gap:11px\}/,
    'sources is still a positioned panel');
  const fn = body(appCode, 'function openCalendarSurface(anchor, kind)');
  assert.match(fn, /openUtilitySurface\(anchor, \{/, 'the two surfaces do not go through one door');
  assert.match(fn, /kind === 'sources' \? sourcesPopoverHtml\(\) : legendHtml\(\)/,
    'only the content should differ between them');
});

test('surface: switching replaces the content inside the shell', () => {
  const fn = body(utilCode, 'function swapSurface(el, { kind, label, html, wire })');
  assert.match(fn, /oldBody\.replaceWith\(next\)/, 'switching rebuilds the shell');
  assert.match(fn, /const from = el\.offsetHeight/, 'the shell jumps to the new height');
  assert.match(fn, /animate\(\[\{ height: `\$\{from\}px` \}, \{ height: `\$\{to\}px` \}\]/,
    'the height change is not eased');
  // The shell is never repositioned on a swap: same anchor, same top.
  assert.ok(!/place\(/.test(fn), 'switching moves the surface');
});

test('surface: exactly one utility surface exists at a time', () => {
  assert.match(utilCode, /^let open = null;/m, 'there is no single record of what is open');
  const menu = body(utilCode, 'export function openUtilityMenu(anchor, items, onSelect)');
  assert.match(menu, /closeUtility\(\);/, 'opening a menu leaves another surface up');
  const surf = body(utilCode, 'export function openUtilitySurface(anchor, { kind, label, html, wire })');
  assert.match(surf, /if \(open\?\.kind === kind\) \{ closeUtility\(\{ focus: true \}\); return; \}/,
    're-opening the same surface does not toggle it shut');
});

test('surface: escape, outside click and focus return are shared, not re-implemented', () => {
  const fn = body(utilCode, 'function attach(anchor, el, kind)');
  assert.match(fn, /e\.key === 'Escape'/, 'Escape does not close');
  assert.match(fn, /el\.contains\(e\.target\) \|\| anchor\.contains\(e\.target\)/,
    'an outside click does not close');
  assert.match(fn, /setTimeout\(\(\) => \{/, 'the opening click closes the surface immediately');
  const close = body(utilCode, 'export function closeUtility({ focus = false } = {})');
  assert.match(close, /if \(focus\) anchor\.focus\(\)/, 'focus does not return to the trigger');
  assert.match(close, /aria-expanded', 'false'/, 'the trigger is left marked as expanded');
});

test('surface: no surface outlives what it described', () => {
  // §7 no stale surface on mode change, none preserved across navigation, and
  // never open alongside the Add menu.
  const mode = appCode.slice(appCode.indexOf("if (cal.mode === b.dataset.mode) return;"));
  assert.match(mode.slice(0, 200), /closeUtility\(\)/, 'a mode switch leaves the surface open');
  const go = body(appCode, 'async function go(id)');
  assert.match(go, /closeUtility\(\)/, 'navigating away leaves the surface open');
  const add = body(appCode, 'function calendarAddMenu(anchor, day = null)');
  assert.match(add, /closeUtility\(\)/, 'Add and the utility menu can be open together');
});

/* ── Live updates ────────────────────────────────────────────────────── */

test('live: the calendar re-reads itself while you are watching it', () => {
  // A view that is only correct at the moment you opened it is not a calendar:
  // Google events land from other devices, and once this app writes events it
  // must see its own writes from a second tab.
  assert.match(appCode, /const CAL_POLL_MS = 45_000/, 'the range is never re-read');
  assert.match(appCode, /const CAL_SYNC_MS = 5 \* 60_000/, 'Google is never re-polled');
  const start = body(appCode, 'function startCalendarLive()');
  assert.match(start, /document\.visibilityState === 'visible'/,
    'a hidden tab still polls');
  assert.match(start, /visibilitychange/, 'returning to the tab does not refresh');
  // Two cadences on purpose: the range is local and cheap, a Google sync costs
  // an API round trip against a quota.
  assert.ok(start.indexOf('CAL_POLL_MS') < start.indexOf('CAL_SYNC_MS'),
    'the range and the Google pull share one cadence');
});

test('live: a refresh is invisible unless something actually changed', () => {
  // Repainting on a timer makes the page flicker every minute and throws away
  // scroll position — worse than being a minute stale.
  const fn = body(appCode, 'async function refreshCalendar()');
  assert.match(fn, /const changed = calendarSignature\(range\) !== calendarSignature\(cal\.data\)/,
    'the refresh does not compare before repainting');
  assert.match(fn, /if \(!changed\) \{ renderCalendarRail\(\); return; \}/,
    'an unchanged refresh still repaints the canvas');
  assert.match(fn, /const top = scroller\?\.scrollTop \?\? 0/, 'a refresh loses scroll position');
  assert.ok(!/cal\.loading = true/.test(fn), 'a background refresh shows a loading state');
  // And it must not paint a range the user has already navigated away from.
  assert.match(fn, /now\.from !== r\.from \|\| now\.to !== r\.to/,
    'a slow response can overwrite a period you have since left');
});

test('live: the signature ignores what changes on every sync', () => {
  // Hashing the raw payload would report a change every time, because
  // connection.lastSyncedAt moves whenever a sync runs.
  const fn = body(appCode, 'function calendarSignature(d)');
  assert.ok(!/lastSyncedAt/.test(fn), 'the fingerprint changes on every sync');
  assert.ok(!/connection/.test(fn), 'connection state is treated as canvas content');
  for (const list of ['events', 'reminders', 'deadlines', 'blocks', 'habitDays']) {
    assert.ok(fn.includes(`d.${list}`), `${list} changes would go unnoticed`);
  }
});

test('live: polling stops when the calendar is not on screen', () => {
  const route = body(appCode, 'async function loadRoute(');
  assert.match(route, /stopCalendarLive\(\)/, 'the calendar keeps polling from other routes');
  assert.match(appCode, /startCalendarLive\(\);/, 'polling never starts');
  const stop = body(appCode, 'function stopCalendarLive()');
  assert.match(stop, /typeof t === 'function' \? t\(\) : clearInterval\(t\)/,
    'the listeners are never detached, so they accumulate on every visit');
});

test('live: a quiet sync stays quiet', () => {
  // The manual "Sync now" earns a toast. A background one has no user waiting
  // on it, and a toast every five minutes is noise.
  const fn = body(appCode, 'async function syncCalendarQuietly()');
  assert.ok(!/saved\(|toast\(/.test(fn), 'the background sync reports itself');
  assert.match(fn, /Date\.now\(\) - calLastSync < CAL_SYNC_MS/,
    'nothing stops the background sync running more often than intended');
  assert.match(fn, /if \(!cal\.data\?\.connection/, 'it syncs with no account connected');
});

/* ── §14 The Reminders workspace keeps its own header ────────────────── */

test('reminders: still no mode selector, and now aligned to the same frame', () => {
  const remHead = body(calCode, 'function remindersHeaderHtml()');
  for (const gone of ['data-mode', 'cal-period', 'cal-layer', 'cal-util']) {
    assert.ok(!remHead.includes(gone), `the Reminders header renders ${gone} again`);
  }
  assert.match(css, /\.rv-head-row\{grid-template-columns:1fr auto\}/,
    'the reminders header is not a two-zone row');
  assert.match(css, /\.rv\{width:auto;max-width:var\(--cal-max\);margin-left:var\(--cal-inset\)/,
    'the reminder list is not on the Calendar frame');
});
