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
  assert.match(fn, /BYDAY=\$\{q\('\[data-rec-ord\]'\)\.value\}/,
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

test('the controls we own are dark, including the ones the browser draws', () => {
  /* A native select LIST is browser-drawn; `color-scheme` is the only lever,
   * and it belongs in one place rather than per modal. */
  assert.match(html, /\.cf-select select,\.cf-select option\{color-scheme:dark/,
    'native select popups will render white');
  for (const [name, src] of FLOWS) {
    assert.ok(!/type="date"|type="time"/.test(src),
      `${name} still uses a native date or time input`);
  }
});
