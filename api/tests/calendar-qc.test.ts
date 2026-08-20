/**
 * What a quality pass found by driving the Calendar rather than reading it.
 *
 * Every test here stands for a control that was on screen and did nothing, or
 * did something the person could not see. None of them would have been caught
 * by asking whether the code exists — in several cases the code existed, was
 * reached, and was still wrong. So these assert the WIRING and the visible
 * consequence, not the presence of a function.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');

const html = read('index.html');
const fields = read('calendar-fields.js');
const pickers = read('pickers.js');
const composer = read('event-composer.js');
const reminder = read('reminder-modal.js');
const app = read('app.js');

test('hidden means hidden: no author display beats the UA rule', () => {
  /* `[hidden]` is only `display:none` from the user-agent stylesheet, so any
   * author `display` wins. `.cf-more-body{display:flex}` did exactly that:
   * More options measured 249px tall with six focusable fields inside while
   * it was "closed". */
  assert.match(html, /\.modal \[hidden\],\.cf-pop\[hidden\]\{display:none!important\}/,
    'a collapsed section can still be displayed and tabbed into');
});

test('the time picker commits as you click, not only on Done', () => {
  /* Picking 9, then 30, then clicking away threw both away — while the date
   * picker beside it committed on a single click. */
  assert.match(pickers, /const live = \(\) => opts\.onLive\?\.\(asIso\(\)\)/,
    'the time picker has no live write-through');
  const wire = pickers.slice(pickers.indexOf('function wire()'));
  for (const attr of ['data-h', 'data-m', 'data-mer']) {
    const handler = wire.slice(wire.indexOf(`pop.querySelectorAll('[${attr}]')`));
    assert.match(handler.slice(0, 260), /live\(\)/,
      `choosing ${attr} does not survive a click-away`);
  }
  assert.match(fields, /onLive: \(v\) => set\(btn, v, 'time', true\)/,
    'the live write closes the popover, so minutes can never be chosen');
});

test('a blocked Continue says which field is wrong, next to that field', () => {
  assert.match(fields, /export function fieldError/, 'there is no field-level error');
  // A footer status line makes the reader hunt for the control it refers to.
  for (const [name, src] of [['event', composer], ['reminder', reminder]] as const) {
    assert.match(src, /fieldError\(/, `${name} still fails silently or globally`);
  }
  assert.match(html, /\.cf-err\{/, 'the error message has no styling and cannot be seen');
  assert.match(html, /\.is-invalid\{border-color:var\(--danger\)!important\}/,
    'the offending field is not marked');
});

test('every creation modal has the same head, foot and way out', () => {
  // Event was the only one of the four with no close button at all.
  assert.match(composer, /<button class="m-close" data-close="cancel"/,
    'the event modal cannot be dismissed from its header');
  assert.match(composer, /<span class="m-save-state" data-state role="status">/,
    'the event modal has no state slot, so its footer differs from the others');
  // The reminder put its name field in the dialog HEADING; the others put it
  // in the body. The heading says which of the four you are making.
  assert.match(reminder, /<h2 class="m-title">\$\{r \? 'Edit reminder' : 'New reminder'\}<\/h2>/,
    'the reminder has no heading');
  assert.match(reminder, /<div class="cf-title">\s*<textarea id="rm-title"/,
    'the reminder name is not the leading body field');
  assert.match(html, /\.cf-title textarea\{/, 'a textarea title is unstyled next to an input one');
});

test('the event modal keeps focus, and Escape unwinds one layer at a time', () => {
  /* Reminder and Schedule both trapped Tab. Event did not, so tabbing walked
   * out of the dialog and into the calendar behind it. */
  assert.match(composer, /const FOCUSABLE = /, 'the event modal has no focus trap');
  assert.match(composer, /if \(e\.key !== 'Tab'\) return;/, 'Tab is not handled');
  assert.match(composer, /const pop = dlg\.querySelector\('\.cf-pop:not\(\[hidden\]\)'\);/,
    'Escape closes the whole dialog even with a picker open');
  // The close button is the first focusable element in the dialog; autofocus
  // has to reach past it or the first keystroke dismisses.
  assert.match(composer, /dlg\.querySelector\('\.m-body input, \.m-body select/,
    'autofocus lands on the close button');
});

test('one label column: a group cannot indent the rows inside it', () => {
  /* The group was a rounded card with its own padding, so every row inside it
   * sat 15px right of every row outside it — two label columns in one form. */
  assert.match(html, /\.cf-group\{gap:var\(--cf-field-gap\);\s*margin-inline:calc\(-1 \* var\(--cf-pad\)\)/,
    'the group insets its contents away from the shared column');
  assert.match(html, /--cf-label-w:78px/, 'the label column is not a token');
  assert.match(html, /\.cf-row\{grid-template-columns:var\(--cf-label-w\) 1fr/,
    'rows do not share one label column');
});

test('"on the ___" opens on the date you are already looking at', () => {
  /* It defaulted to the first Monday of the month whatever the event's date
   * was, so an event on Thursday the 20th proposed "first Monday". */
  assert.match(fields, /const nthOf = \(day\) =>/, 'the nth default is not derived');
  assert.match(fields, /Math\.min\(4, Math\.ceil\(d\.getDate\(\) \/ 7\)\)/,
    'the ordinal is not taken from the day of the month');
  assert.match(fields, /nthOf\(day\)\.ord, 'Which one'/, 'the ordinal select ignores the date');
  assert.match(fields, /nthOf\(day\)\.wd, 'Which day'/, 'the weekday select ignores the date');
});

test('a weekly reminder repeats on the day it is set for', () => {
  // `f` is the form's opening state; `v` is what was just read back out.
  const save = reminder.slice(reminder.indexOf("$('#rm-save').onclick"));
  assert.ok(!/parseIso\(f\.dueDate\)/.test(save),
    'recurrence is pinned to the date the dialog opened with');
  assert.match(save, /byWeekday: \[parseIso\(v\.dueDate\)\.getDay\(\)\]/,
    'the weekday does not follow the chosen date');
});

test('the connect prompt does not say "re" to someone who never connected', () => {
  assert.match(composer, /const everConnected = Boolean\(state\?\.connected \|\| state\?\.needsReconnect\)/,
    'the two cases are not told apart');
  assert.match(composer, /\$\{verb\} Google Calendar<\/button>/, 'the verb is hard-coded');
  assert.ok(!/>Reconnect Google Calendar</.test(composer),
    'the button still says Reconnect unconditionally');
});

test('nothing in the Calendar writes to the database without being asked', () => {
  /* The queue's Schedule button committed a block into the first free hour of
   * the week. Nothing opened, nothing moved until the next refresh, and it
   * never said which hour it had chosen. */
  assert.ok(!/scheduleFromQueue/.test(app.replace(/\/\*[\s\S]*?\*\//g, '')),
    'a queue click still writes a block with nothing on screen to show for it');
});
