/**
 * One interaction language across the four Calendar creation flows.
 *
 * Event, Reminder, Schedule Task and Birthday had each grown their own date
 * field, time control, duration presets and More Options disclosure. They did
 * not look like four views of one product; they looked like four products —
 * and improving one improved exactly one.
 *
 * These tests are mostly about ABSENCE: that no flow keeps its own copy of a
 * control the shared module provides. A consistency rule that only checked the
 * shared thing exists would pass happily while four private versions sat
 * beside it, which is how the drift happened in the first place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const fields = read('calendar-fields.js');
const pickers = read('pickers.js');
const composer = read('event-composer.js');
const reminder = read('reminder-modal.js');
const schedule = read('schedule-task-modal.js');
const html = read('index.html');
/** A newline, so a selector can be anchored at column 0. */
const NL = String.fromCharCode(10);

const FLOWS: [string, string][] = [
  ['Event/Birthday', composer], ['Reminder', reminder], ['Schedule Task', schedule],
];

/* ── One source of truth ──────────────────────────────────────────────── */

test('every flow composes the shared fields, and none rebuilds them', () => {
  for (const [name, src] of FLOWS) {
    assert.match(src, /from '\.\/calendar-fields\.js'/, `${name} does not use the shared fields`);
    for (const own of ['datePickerPopover(', 'timePickerPopover(', 'type="time"', 'type="date"']) {
      assert.ok(!src.includes(own), `${name} builds its own control (${own})`);
    }
  }
});

test('there is exactly one date field and one time field in the app', () => {
  assert.match(fields, /export const dateField/, 'no shared date field');
  assert.match(fields, /export const timeField/, 'no shared time field');
  assert.match(fields, /export function wireDateTime/, 'the fields have no shared wiring');
  assert.match(fields, /from '\.\/pickers\.js'/, 'the shared fields do not use the shared pickers');
});

test('one disclosure, one duration control, one reminder control', () => {
  for (const shared of ['export const moreOptions', 'export const durationField',
    'export const remindersField', 'export const recurrenceBuilder', 'export const row']) {
    assert.ok(fields.includes(shared), `${shared} is missing from the shared module`);
  }
  for (const [name, src] of FLOWS) {
    assert.ok(!/const DURATIONS = \[/.test(src), `${name} has its own duration presets`);
  }
});

/* ── The time picker that replaced a 96-row list ──────────────────────── */

test('the time picker is columns, not every timestamp in the day', () => {
  /* The old one listed every quarter hour: ninety-six rows, all identical to
   * look at, and finding 14:30 meant scrolling past ninety that were not. */
  assert.match(pickers, /const MINUTES = Array\.from\(\{ length: 12 \}/,
    'minutes are not a short list');
  assert.match(pickers, /data-col="h"/, 'there is no hour column');
  assert.match(pickers, /data-col="m"/, 'there is no minute column');
  assert.ok(!/for \(let h = 0; h < 24; h\+\+\)[\s\S]{0,200}for \(let m = 0/.test(pickers),
    'the every-timestamp list is still being built');
  assert.match(pickers, /class="tp-in"/, 'the time cannot be typed');
});

test('5-minute minutes, and 12- or 24-hour taken from the locale', () => {
  assert.match(pickers, /\(_, i\) => i \* 5/, 'minutes are not in fives');
  assert.match(pickers, /export const uses12Hour/, 'the clock format is not decided once');
  assert.match(pickers, /export function formatTime/, 'there is no single time format');
  for (const [name, src] of FLOWS) {
    assert.ok(!/toLocaleTimeString/.test(src), `${name} formats time its own way`);
  }
});

test('a time can be typed loosely and still be understood', () => {
  const fn = pickers.slice(pickers.indexOf('export function parseTime'),
    pickers.indexOf('const MINUTES'));
  for (const shape of ['digits.includes', 'pm && h < 12', 'am && h === 12']) {
    assert.ok(fn.includes(shape), `parseTime does not handle ${shape}`);
  }
  assert.match(fn, /h < 0 \|\| h > 23 \|\| m < 0 \|\| m > 59/, 'an impossible time is accepted');
});

/* ── Google reminders ─────────────────────────────────────────────────── */

test('several reminders per event, within the limits Google actually has', () => {
  /* Offering a value Google will reject means a wasted round trip and an
   * opaque error, so the UI refuses it first. */
  assert.match(fields, /export const MAX_REMINDERS = 5/, 'no limit on reminder count');
  assert.match(fields, /export const MAX_REMINDER_MINUTES = 40320/, 'no limit on how far ahead');
  const fn = fields.slice(fields.indexOf('export function wireReminders'),
    fields.indexOf('/* ══ Recurrence'));
  assert.match(fn, /have\.length >= MAX_REMINDERS/, 'more reminders than Google allows can be added');
  assert.match(fn, /m > MAX_REMINDER_MINUTES/, 'a reminder beyond four weeks can be added');
  assert.match(fn, /have\.includes\(m\)/, 'the same reminder can be added twice');
  assert.match(fields, /label: '30 minutes before'/, 'reminders are phrased as raw minutes');
  assert.match(fields, /ALL_DAY_PRESETS/, 'an all-day event is offered minute-based reminders');
});

/* ── Recurrence ───────────────────────────────────────────────────────── */

test('the recurrence builder covers the patterns people actually use', () => {
  const fn = fields.slice(fields.indexOf('export function wireRecurrence'));
  assert.match(fn, /BYDAY=\$\{days\.join\(','\)\}/, 'weekly-on-several-days is not supported');
  assert.match(fn, /BYDAY=\$\{val\('cf-rec-ord'\)\}\$\{val\('cf-rec-nthday'\)\}/,
    'nth-weekday-of-month is not supported');
  assert.match(fn, /BYMONTHDAY=/, 'monthly-on-a-date is not supported');
  assert.match(fn, /UNTIL=/, 'an end date is not supported');
  assert.match(fn, /COUNT=/, 'a count is not supported');
});

test('the rule is described in words, so nobody meets an RRULE', () => {
  const d = fields.slice(fields.indexOf('export function describeRecurrence'),
    fields.indexOf('const listWords'));
  assert.match(d, /Repeats on the \$\{ord\} \$\{day\}/, 'a monthly nth-weekday rule has no wording');
  assert.match(d, /until \$\{formatDate/, 'an end date is not described');
  assert.match(d, /\$\{count\} times/, 'a count is not described');
  assert.match(fields, /data-rec-say/, 'the description is never rendered');
});

/* ── Layout ───────────────────────────────────────────────────────────── */

test('the four modals share width, rows, controls and disclosure', () => {
  assert.match(html, /\.modal\.ev-modal,\.modal-reminder,\.modal-schedule\{width:/,
    'the modals set their own widths');
  assert.match(html, /\.cf-row\{display:grid;grid-template-columns:74px/,
    'rows do not share a label column');
  assert.match(html, /\.cf-ctl\{[^}]*height:34px/, 'controls do not share a height');
  assert.match(html,
    /\.cf-more-btn\{display:flex;width:100%;align-items:center;justify-content:space-between/,
    'the disclosure is not consistently placed');
});

test('no Calendar dropdown is drawn by the operating system', () => {
  /* A native <select> renders its option list with the OS. No CSS reaches it —
   * `color-scheme: dark` restyles the closed control and nothing else — so
   * Calendar, Repeat, Notify and Area opened as bright white sheets while the
   * time picker beside them was correctly dark. The only fix is to own the
   * control. */
  for (const [name, src] of [...FLOWS, ['shared fields', fields] as [string, string]]) {
    assert.ok(!/<select/.test(src.replace(/^.*OPERATING SYSTEM.*$/gm, '')),
      `${name} still uses a native <select>, which will open white`);
    assert.ok(!/type="time"/.test(src), `${name} still uses a native time input`);
  }
  assert.match(fields, /export function wireMenus/, 'there is no shared dropdown');
  assert.match(fields, /aria-haspopup="listbox"/, 'the trigger is not a listbox control');
});

test('every option in a dropdown is actually readable', () => {
  /* The reported symptom was text that had become nearly invisible. A muted
   * token is legible in a mock-up and not on a screen at arm's length, so the
   * ordinary option colour is stated explicitly rather than inherited. */
  const opt = html.slice(html.indexOf('.cf-menu-opt{'), html.indexOf('.cf-menu-opt:hover'));
  assert.match(opt, /color:var\(--text\)/, 'ordinary options do not set a readable colour');
  assert.ok(!/color:var\(--muted\)/.test(opt), 'ordinary options use the muted token');
  // Disabled is quieter but still visible; selected is unmistakable.
  assert.match(html, /\.cf-menu-opt\[disabled\]\{[^}]*opacity:\.75/,
    'disabled options are invisible rather than muted');
  assert.match(html, /\.cf-menu-opt\.is-on\{background:color-mix\(in srgb,var\(--accent\)/,
    'the selected option has no distinct background');
  assert.match(html, /\.cf-menu-text\{[^}]*color:var\(--text\)/,
    'the trigger value can inherit a muted colour');
});

test('a dropdown panel cannot be clipped or hidden behind the modal', () => {
  /* One floating host per dialog, appended to the DIALOG rather than to the
   * scrolling body — a panel inside `overflow:auto` gets cut off, and one
   * inside a transformed ancestor gets a stacking context of its own. */
  assert.match(fields, /export function popoverHost/, 'there is no single popover host');
  const host = fields.slice(fields.indexOf('export function popoverHost'),
    fields.indexOf('export function wireDateTime'));
  assert.match(host, /dlg\.appendChild\(pop\)/, 'the popover lives inside the scrolling body');
  assert.match(html, /\.cf-pop\{position:absolute;z-index:200\}/,
    'the popover does not sit above the modal content');
  // And the placement rule is shared, so no menu lands somewhere unrelated.
  assert.match(pickers, /export function anchor/, 'placement is not shared');
  assert.match(pickers, /below \+ pop\.offsetHeight > d\.height - 8/,
    'a panel with no room below does not flip above');
});

test('the dropdown is keyboard-operable, which a native select gave for free', () => {
  const fn = fields.slice(fields.indexOf('export function wireMenus'));
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Enter']) {
    assert.ok(fn.includes(key), `the dropdown does not handle ${key}`);
  }
  assert.match(fn, /role="listbox"/, 'the panel has no listbox role');
  assert.match(fn, /role="option"/, 'the options have no option role');
  assert.match(fn, /aria-selected/, 'selection is not exposed to assistive tech');
  assert.match(fn, /startsWith\(e\.key\.toLowerCase\(\)\)/, 'there is no type-ahead');
});

test('every colour token the Calendar CSS names actually exists', () => {
  /* Third time this has bitten: `--text-1`, then `--surface-1`, neither of
   * which was ever defined. An undefined custom property makes the whole
   * declaration invalid, so the panel simply had no background — correctly
   * sized, correctly placed, and see-through. Nothing warns; it just looks
   * subtly wrong in a way that is easy to blame on something else.
   *
   * Scoped to the Calendar block, because elsewhere in the app custom
   * properties are legitimately set inline from JS. */
  const from = html.indexOf('/* ══ Shared Calendar fields');
  const to = html.indexOf('@media (max-width:560px)', from);
  assert.ok(from > -1 && to > from, 'the shared Calendar CSS block could not be located');
  const block = html.slice(from, to);

  const defined = new Set([...html.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const used = new Set([...block.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]));
  const missing = [...used].filter((t) => !defined.has(t));
  assert.deepEqual(missing, [], `the Calendar CSS names tokens that do not exist: ${missing}`);
});

test('the dropdown panel is opaque, not merely positioned', () => {
  assert.match(html, /\.cf-menu\{[^}]*background:var\(--surface\)/,
    'the dropdown panel has no background, so the modal shows through it');
  assert.ok(!/var\(--surface-1\)/.test(html), 'the undefined surface token is back');
});

/* ── Four bugs found by driving the app, not by reading it ────────────── */

test('every floating panel carries its own background', () => {
  /* The date picker had none. It borrowed background, border and shadow from
   * the `.ev-pop` host it happened to be rendered into, so when the host
   * became the shared `.cf-pop` — which only positions — the picker kept its
   * size and lost its skin: a correctly-placed, fully-interactive, completely
   * invisible grid. A panel that needs its container to be visible is one
   * refactor away from being transparent. */
  for (const sel of [NL + '.dp{', NL + '.tp{', NL + '.cf-menu{']) {
    // Anchored at column 0, so the mobile media-query overrides (indented) are
    // not mistaken for the rule that gives the panel its surface.
    const at = html.indexOf(sel);
    assert.ok(at > -1, `${sel.trim()} has no top-level rule at all`);
    const rule = html.slice(at, html.indexOf('}', at));
    assert.match(rule, /background:var\(--/, `${sel.trim()} has no background of its own`);
  }
  // And the hosts only position; they must not decorate.
  for (const host of ['.cf-pop{', '.ev-pop{']) {
    const at = html.indexOf(host);
    const rule = html.slice(at, html.indexOf('}', at));
    assert.ok(!/background:/.test(rule), `${host} decorates, so its children can go skinless`);
  }
});

test('one popover, one owner — a picker and a dropdown cannot disagree', () => {
  /* wireDateTime and wireMenus share the host. When each kept its own idea of
   * what was open, closing a dropdown left the date picker still believing it
   * was open, so the next click on the date field read as "close the thing
   * already open" and the picker appeared dead until clicked twice. */
  assert.match(fields, /pop\.__owner = null;/, 'the popover has no single owner');
  assert.match(fields, /export function closePopover/, 'closing is not shared');
  assert.ok(!/let openFor = null|let openBtn = null/.test(fields),
    'a wiring keeps its own open-state again');
});

test('wiring a control twice is harmless', () => {
  /* The recurrence builder is rendered with the composer and wired again when
   * it appears. Two handlers on one dropdown meant the first opened the panel
   * and the second immediately closed it — the control looked completely
   * dead. Calling a wiring function twice should be a no-op, not destructive. */
  assert.match(fields, /if \(btn\.dataset\.cfWired\) return;/, 'controls can be double-wired');
  const count = (fields.match(/dataset\.cfWired = '1'/g) ?? []).length;
  assert.ok(count >= 2, 'only one control family is protected from double wiring');
});

test('a menu change is announced to everyone, not just its first wirer', () => {
  /* With wiring idempotent, `onChange` belongs to whoever wired first — so the
   * recurrence builder never heard about its own dropdowns and left its
   * sentence describing the previous choice. An event has no owner. */
  const fn = fields.slice(fields.indexOf('const choose = (btn, opt)'),
    fields.indexOf('const open = (btn)'));
  assert.match(fn, /dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/,
    'a menu change is not observable by anyone but the first listener');
  assert.match(fn, /if \(before === btn\.dataset\.value\) return;/,
    're-picking the same value still fires a change');
});

test('a floating menu escapes the modal it floats out of', () => {
  /* The reminder menu was absolutely positioned inside `.cf-rems`, a child of
   * the modal's scrolling body — so overflow:auto cut it in half and the later
   * presets could not be reached at all. */
  const from = fields.indexOf("addBtn.addEventListener('click'");
  const fn = fields.slice(from, fields.indexOf('return { get values()', from));
  assert.match(fn, /popoverHost\(dlg\)/, 'the reminder menu is not in the shared host');
  assert.match(fn, /anchor\(pop, dlg, addBtn\)/, 'it is not placed by the shared rule');
  assert.ok(!/host\.appendChild\(menu\)/.test(fn),
    'the menu is still mounted inside the scrolling body');
});

test('the Schedule Task list fills its row', () => {
  /* As a flex item that never grew, it collapsed to the width of its longest
   * title — a narrow scrolling stack of half-visible cards in a 544px modal. */
  assert.match(html, /\.st-list\{[^}]*flex:1 1 100%/, 'the task list does not fill its row');
  assert.ok(!/class="ev-row ev-row-top">\s*<span class="ev-lab">Task/.test(schedule),
    'the Task row still uses the legacy three-column grid');
});
