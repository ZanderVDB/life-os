/**
 * Phase D4.4 — reminder consistency across Calendar modes.
 *
 * The recurrence tests are regressions for a bug that shipped: the API's Zod
 * schema never listed `recurrence`, Zod strips unknown keys, and every Repeat
 * setting was discarded without an error. The control looked like it worked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextOccurrence } from '../src/routes/calendar.js';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const html = read('index.html');
const app = read('app.js');
const calendar = read('calendar.js');
const reminderModal = read('reminder-modal.js');
const detail = read('detail-sheet.js');
const calRoute = readFileSync(join('src', 'routes', 'calendar.ts'), 'utf8');

const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const calCode = code(calendar);
const appCode = code(app);

function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `${decl} not found`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:async )?(?:export )?function /);
  return end === -1 ? rest : rest.slice(0, end);
}

/* ── §6 Recurrence: the regression that shipped ──────────────────────── */

test('recurrence: the API accepts it — this is the bug that shipped', () => {
  // Zod strips unknown keys silently, so an unlisted field arrives, vanishes,
  // and the reminder saves as a one-off with no error anywhere.
  assert.match(calRoute, /const RecurrenceBody = z\.object/, 'no recurrence schema');
  assert.match(calRoute, /recurrence: RecurrenceBody\.nullish\(\)/,
    'ReminderBody does not accept recurrence — it will be silently discarded');
  assert.match(calRoute, /db\.insert\(reminderRecurrenceRules\)/, 'the rule is never stored');
  // And it must come back out again.
  assert.match(calRoute, /recurrence: ruleFor\.get\(r\.id\) \?\? null/,
    'the rule is stored but never returned');
});

test('recurrence: a real reminder is not flagged as demonstration data', () => {
  // It was `isSynthetic: true`, which made every user reminder eligible for the
  // staging cleanup. Scoping a destructive op correctly is not enough if the
  // flag it scopes on is applied to the wrong rows.
  const fn = calRoute.slice(calRoute.indexOf("app.post('/api/v1/workspaces/:workspaceId/reminders'"));
  assert.match(fn.slice(0, 1400), /isSynthetic: false/,
    'user-created reminders are flagged synthetic and would be deleted by cleanup');
});

test('recurrence: weekly advances to the same weekday', () => {
  // 2026-08-05 is a Wednesday; byWeekday [3] is Wednesday.
  assert.equal(nextOccurrence('2026-08-05', {
    frequency: 'WEEKLY', interval: 1, byWeekday: [3],
  }), '2026-08-12');
  // Multiple days in a week step to the next listed day first.
  assert.equal(nextOccurrence('2026-08-03', {
    frequency: 'WEEKLY', interval: 1, byWeekday: [1, 4],
  }), '2026-08-06', 'a mid-week day is skipped');
});

test('recurrence: monthly holds the day of the month', () => {
  assert.equal(nextOccurrence('2026-08-25', {
    frequency: 'MONTHLY', interval: 1, byMonthDay: [25],
  }), '2026-09-25');
  assert.equal(nextOccurrence('2026-08-28', {
    frequency: 'MONTHLY', interval: 1, byMonthDay: [28],
  }), '2026-09-28');
});

test('recurrence: a short month clamps instead of overflowing', () => {
  // Naive date maths turns "31 January + 1 month" into 3 March. A reminder for
  // the 31st must land on the last day of a shorter month, not skip it.
  assert.equal(nextOccurrence('2026-01-31', {
    frequency: 'MONTHLY', interval: 1, byMonthDay: [31],
  }), '2026-02-28', 'the 31st overflowed past February');
  assert.equal(nextOccurrence('2026-03-31', {
    frequency: 'MONTHLY', interval: 1, byMonthDay: [31],
  }), '2026-04-30', 'the 31st overflowed past a 30-day month');
});

test('recurrence: dates are calendar-local, never UTC instants', () => {
  // Converting through UTC shifts the day for anyone east or west of
  // Greenwich at a month boundary.
  const fn = body(calRoute, 'export function nextOccurrence(fromIso: string, rule: {');
  assert.ok(!/toISOString|Date\.UTC|getUTC/.test(fn),
    'the recurrence maths goes through UTC and will shift by a day');
});

test('recurrence: completing a recurring reminder advances it, not closes it', () => {
  const fn = calRoute.slice(calRoute.indexOf("reminders/:id/complete"));
  assert.match(fn.slice(0, 1600), /nextOccurrence\(existing\.dueDate, rule\)/,
    'completion does not advance a recurring reminder');
  assert.match(fn.slice(0, 1600), /status: 'open', completedAt: null/,
    'a recurring reminder is closed permanently on completion');
  // Unless the series has genuinely ended.
  assert.match(fn.slice(0, 1600), /rule\.until && next > rule\.until/,
    'a series with an end date never finishes');
});

test('recurrence: editing an unrelated field does not drop the rule', () => {
  const fn = calRoute.slice(calRoute.indexOf("app.patch('/api/v1/workspaces/:workspaceId/reminders/:id'"));
  assert.match(fn.slice(0, 1600), /if \(recurrence !== undefined\)/,
    'an absent recurrence is treated as "remove it", so editing a title unsets repeat');
});

/* ── §3 Month reminder rows ──────────────────────────────────────────── */

test('month: reminders are labelled rows, not just a count chip', () => {
  assert.match(calCode, /function reminderChipHtml/, 'no reminder row');
  assert.match(calCode, /shownRem\.map\(\(r\) => reminderChipHtml/, 'the row is never rendered');
  assert.ok(!/cm-chip cm-rem/.test(calCode), 'the bare count chip is back');
  assert.match(html, /\.cm-rem-row\{/, 'the reminder row has no styling');
});

test('month: the cell fills by priority, not by type quota', () => {
  const fn = body(calCode, 'function monthCellHtml(d, month, todayIso)');
  // Events, then deadlines, then reminders — each taking what the last left.
  assert.match(fn, /shownDue = deadlines\.slice\(0, Math\.max\(0, SHOWN - shownEv\.length\)\)/,
    'deadlines do not use the space events left');
  assert.match(fn, /shownRem = openRem\.slice\(0, Math\.max\(0, SHOWN - shownEv\.length - shownDue\.length\)\)/,
    'reminders do not use the space events and deadlines left');
  // Overflow counts everything hidden, of every type.
  assert.match(fn, /openRem\.length - shownRem\.length/, 'hidden reminders are not counted');
});

test('month: a reminder looks unlike an event and unlike a deadline', () => {
  assert.match(html, /\.cm-rem-row\{[^}]*border:1px dotted/,
    'reminders are not visually distinct from events');
  assert.match(html, /\.cm-rem-dot\{[^}]*background:var\(--warn\)/, 'no reminder cue');
  assert.match(calCode, /cm-rem-rep/, 'recurrence is not indicated in the cell');
  assert.match(html, /\.cm-rem-row\.is-overdue\{/, 'overdue reminders look the same as due ones');
});

test('month: a reminder opens Reminder detail, never Event detail', () => {
  assert.match(appCode, /function openReminderDetail/, 'no reminder detail');
  assert.match(appCode, /\[data-reminder\]:not\(\.ag-check\)/,
    'the reminder row is not wired to detail');
  // Ticking and opening are different acts.
  assert.match(appCode, /\.ag-check\[data-reminder\]/,
    'the checkbox and the row share one handler, so opening would tick it off');
});

test('month: hover explains a reminder without a native tooltip', () => {
  assert.match(calCode, /reminder\(id\) \{/, 'no reminder hover preview');
  assert.match(calCode, /recurrenceWords\(r\.recurrence\)/,
    'the preview does not explain the recurrence');
  assert.match(calCode, /export function recurrenceWords/, 'recurrence has no plain wording');
});

/* ── §4 Plan week reminders ──────────────────────────────────────────── */

test('plan: date-only reminders sit above the axis, not on it', () => {
  assert.match(calCode, /function planReminderHtml/, 'Plan has no reminder rendering');
  assert.match(calCode, /dayReminders\.filter\(\(r\) => !r\.dueTime\)\.map\(\(r\) => planReminderHtml/,
    'date-only reminders are not in the all-day strip');
  assert.match(html, /\.pl-rem-ad\{/, 'the strip reminder has no styling');
});

test('plan: reminders never consume planning capacity', () => {
  // freeWindows considers events and blocks. If reminders entered that
  // calculation, a date-only reminder would eat a genuinely free morning.
  const fn = body(calCode, 'function freeWindows(dayIso)');
  assert.ok(!/reminders/.test(fn), 'reminders are subtracted from free time');
  const load = body(calCode, 'function workload(dayIso)');
  assert.ok(!/reminders/.test(load), 'reminders inflate the workload state');
});

test('plan: timed reminders are markers, not duration blocks', () => {
  assert.match(calCode, /dayReminders\.filter\(\(r\) => r\.dueTime\)/, 'timed reminders are ignored');
  assert.match(html, /\.pl-rem\{position:absolute/, 'the timed marker has no styling');
  // A marker has no height driven by a duration.
  assert.ok(!/\.pl-rem\{[^}]*height:/.test(html), 'the timed marker is sized like a block');
  assert.match(calCode, /top:\$\{pctOf\(h \* 60 \+ m, hours\)/,
    'the marker is not positioned at its time');
});

test('plan: conflicts ignore reminders entirely', () => {
  const fn = body(calCode, 'function conflictsOn(dayIso)');
  assert.ok(!/reminder/i.test(fn), 'reminders are reported as calendar conflicts');
});

/* ── §5 Detail and edit ──────────────────────────────────────────────── */

test('detail: a reminder gets a Life OS surface with real actions', () => {
  const fn = body(appCode, 'function openReminderDetail(id)');
  assert.match(fn, /actions:/, 'the reminder detail offers no actions');
  assert.match(fn, /Mark done|Mark not done/, 'completion is not available from detail');
  assert.match(fn, /label: 'Edit'/, 'editing is not available from detail');
  assert.match(appCode, /function editReminder/, 'no edit path');
  assert.match(appCode, /openReminderModal\(\{\s*reminder: r/,
    'reminder editing does not use the Reminder modal');
  // And never the event editor. Checked at the call site rather than by
  // proximity — the two modals sit on adjacent import lines, which a loose
  // distance match reads as a violation.
  const editFn = body(appCode, 'function editReminder(id)');
  assert.ok(!/openEventModal/.test(editFn), 'the Event editor is used to edit a reminder');
  const detailFn = body(appCode, 'function openReminderDetail(id)');
  assert.ok(!/openEventModal/.test(detailFn), 'reminder detail opens the Event editor');
});

test('detail: Google events still get no actions at all', () => {
  // The same sheet serves both. Only records Life OS can change pass actions.
  const fn = body(appCode, 'function openEventDetail(ev)');
  assert.ok(!/actions:/.test(fn), 'a Google event detail offers actions');
  assert.match(detail, /\(ctx\.actions \?\? \[\]\)/, 'actions are not optional');
});

test('detail: no browser prompt or alert anywhere in the reminder flow', () => {
  assert.ok(!/window\.prompt|[^.]\bprompt\(|alert\(/.test(appCode),
    'a browser prompt or alert is used');
  assert.match(reminderModal, /role', 'dialog'/, 'the reminder modal is not a dialog');
});

/* ── §7 Completion motion ────────────────────────────────────────────── */

test('completion: collapses every rendering, then repaints once', () => {
  // A reminder can be on screen three times at once — Month cell, Agenda row,
  // Plan strip — so completion must collapse all of them together.
  assert.match(appCode, /function collapseReminder/, 'completion does not animate');
  const fn = body(appCode, 'function collapseReminder(id, done)');
  assert.match(fn, /querySelectorAll\(`\[data-reminder="\$\{id\}"\]`\)/,
    'only one rendering is collapsed');
  assert.match(fn, /if \(--pending <= 0\) done\(\)/, 'the repaint fires before all rows finish');
  assert.match(fn, /reducedMotion\(\)/, 'the collapse ignores reduced motion');
});

test('completion: optimistic, with rollback and no full rerender', () => {
  const fn = body(appCode, 'async function toggleReminder(id)');
  assert.match(fn, /patchReminderRow\(id\)/, 'completion is not optimistic');
  assert.match(fn, /Object\.assign\(r, before\)/, 'a failed completion does not roll back');
  assert.ok(!/loadCalendar\(\)/.test(fn), 'completion reloads the whole calendar');
  assert.match(fn, /r\._busy/, 'a double click can fire two writes');
});

test('completion: an advanced recurrence tells the user where it went', () => {
  const fn = body(appCode, 'async function toggleReminder(id)');
  assert.match(fn, /res\.advancedTo/, 'the advance is ignored by the client');
  assert.match(fn, /next on \$\{prettyDay\(res\.advancedTo\)\}/,
    'the user is not told the reminder rolled forward');
});
