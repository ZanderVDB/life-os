/**
 * Phase D4.2 — consolidation and clarity.
 *
 * The governing rule this phase locked: nothing persistent in Life OS should
 * make the user stop and wonder what it means. Several assertions here exist
 * to stop an unexplained indicator creeping back in.
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
const eventModal = read('event-modal.js');
const scheduleModal = read('schedule-task-modal.js');
const detail = read('detail-sheet.js');

const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const calCode = code(calendar);
const appCode = code(app);

/* ── §1 Clarity rule ─────────────────────────────────────────────────── */

test('clarity: the rule is written down where it will be read', () => {
  const product = readFileSync(join('..', 'docs', 'calendar-v2-product-model.md'), 'utf8');
  assert.match(product, /stop and wonder what it means/i,
    'the clarity rule is not recorded in the product model');
});

test('clarity: a legend exists and is a popover, not a permanent panel', () => {
  assert.match(calCode, /export function legendHtml/, 'no legend');
  // D4.7 moved position/width/border/shadow onto the shared .util-surface
  // shell, so the Key and Calendar sources stop being two differently shaped
  // boxes. The legend is still a popover — it just no longer owns the glass.
  assert.match(html, /\.util-surface\{position:fixed/, 'the shared surface is not a popover');
  assert.match(html, /\.legend\{display:flex/, 'the legend has no contents styling');
  // And it is created and removed rather than [hidden]-toggled, so it cannot
  // be left in the DOM describing a calendar you have navigated away from.
  assert.match(appCode, /toggleLegend = \(btn\) => openCalendarSurface\(btn, 'key'\)/,
    'the legend cannot be opened');
  // It must explain every repeated mark.
  for (const meaning of ['calendar it came from', 'task deadline', 'reminder',
    'planned time for', 'overlap', 'Busy', 'Heavily booked']) {
    assert.ok(calendar.includes(meaning), `the legend does not explain: ${meaning}`);
  }
});

/* ── §2 No orphaned floating UI ──────────────────────────────────────── */

test('layout: hidden-toggled elements actually hide', () => {
  // 'legend' left this list in D4.7: it is created and removed with its shared
  // shell now rather than toggled with [hidden], so there is no hidden state
  // for a display: rule to beat. The bug this guards against — an author
  // `display:` outranking the UA's [hidden]{display:none} — still applies to
  // everything that IS toggled that way.
  for (const cls of ['hov', 'ev-adv']) {
    if (!new RegExp(`\\.${cls}\\{[^}]*display:`).test(html)) continue;
    assert.match(html, new RegExp(`\\.${cls}\\[hidden\\]\\{display:none\\}`),
      `.${cls} sets display but has no [hidden] rule — it can never hide`);
  }
});

/* ── §3 Header as one system ─────────────────────────────────────────── */

test('header: mode control and Add share a height and a radius', () => {
  assert.match(html, /\.cal-modes\{[^}]*height:38px/, 'the mode control has no fixed height');
  assert.match(html, /\.cal-add\{[^}]*height:38px/, 'Add does not match the mode height');
  assert.match(html, /\.cal-modes\{[^}]*border-radius:11px/, 'mode radius drifted');
  assert.match(html, /\.cal-add\{[^}]*border-radius:11px/, 'Add radius does not match');
  // Separate controls, not merged.
  assert.match(calCode, /role="tablist"/, 'the mode control is not a tablist');
  assert.ok(!/data-add[\s\S]{0,80}role="tab"/.test(calendar), 'Add was merged into the modes');
});

test('header: the active mode is unmistakable and the pill glides', () => {
  assert.match(calCode, /cal-mode-pill/, 'no active indicator');
  assert.match(html, /\.cal-mode-pill\{[^}]*transform:translateX\(calc\(var\(--mode-i\)/,
    'the pill is positioned by something other than a transform');
  assert.match(html, /\.cal-mode-pill\{[^}]*transition:transform/, 'the pill snaps');
  assert.match(html, /\.cal-modes button\[aria-selected="true"\]\{color:#fff\}/,
    'the active mode is not visually distinct');
  // Keyboard: arrows move between modes.
  assert.match(appCode, /ArrowLeft: -1, ArrowRight: 1/, 'the tablist has no arrow support');
  assert.match(calCode, /tabindex="\$\{cal\.mode === m\.id \? 0 : -1\}"/,
    'every mode button is in the tab order');
});

test('header: Plan is labelled "Plan week"', () => {
  assert.match(calCode, /id: 'plan', label: 'Plan week'/, 'the mode was not renamed');
});

/* ── §4 Centring ─────────────────────────────────────────────────────── */

test('layout: all three modes share one outer bound', () => {
  assert.match(html, /\.cal-head,\.cal-month,\.cal-agenda,\.cal-plan\{width:100%;max-width:var\(--cal-max\);\s*margin-inline:auto\}/,
    'the modes do not share a bound, so the canvas shifts when switching');
  assert.match(html, /--cal-max:\d+px/, 'there is no intentional max width');
  // No per-mode margin patches.
  for (const sel of ['.cal-month', '.cal-agenda', '.cal-plan']) {
    assert.ok(!new RegExp(`\\${sel}\\{[^}]*margin-left:\\s*\\d`).test(html),
      `${sel} has an arbitrary left margin`);
  }
  assert.ok(!/zoom:\s*[\d.]/.test(html), 'CSS zoom is used to fake layout');
});

/* ── §6 The habit pie ────────────────────────────────────────────────── */

test('month: the unexplained habit pie is gone from the cell', () => {
  assert.ok(!calendar.includes('cm-habit-dot'), 'the habit pie is back in the month cell');
  assert.ok(!/conic-gradient/.test(html.slice(html.indexOf('.cm-cell'), html.indexOf('.hov{'))),
    'a conic-gradient indicator returned to the month grid');
  // Habits survive where they can be read in words.
  assert.match(calCode, /cs-habit/, 'habit detail was removed entirely rather than relocated');
});

/* ── §7 Workload colour ──────────────────────────────────────────────── */

test('month: workload marks only the two states worth noticing, never in purple', () => {
  assert.match(html, /\.cm-cell\.load-moderate::before\{background:transparent\}/,
    'moderate still paints an edge');
  assert.match(html, /\.cm-cell\.load-busy::before\{background:var\(--warn\)/, 'busy has no mark');
  assert.match(html, /\.cm-cell\.load-overloaded::before\{background:var\(--danger\)/,
    'overloaded has no mark');
  // Purple means selection. It must not also mean "busy".
  const loadRules = html.match(/\.cm-cell\.load-\w+::before\{[^}]*\}/g) ?? [];
  for (const r of loadRules) {
    assert.ok(!/accent|138,93,255/.test(r), `workload uses purple: ${r}`);
  }
});

/* ── §11/§12 Motion ──────────────────────────────────────────────────── */

test('motion: month navigation is directional and mode change is not', () => {
  for (const k of ['cal-in-left', 'cal-in-right', 'cal-in-fade']) {
    assert.match(html, new RegExp(`@keyframes ${k}\\{`), `${k} is missing`);
  }
  assert.match(appCode, /cal\.enter = dir === 'next' \? 'next' : dir === 'prev' \? 'prev' : 'mode'/,
    'navigation does not record its direction');
  assert.match(appCode, /function applyCanvasEnter/, 'the direction is never applied');
  // Applied to the canvas, not the scroll region, so header and rail stay put.
  const fn = appCode.slice(appCode.indexOf('function applyCanvasEnter'));
  // D4.7 wrapped the canvas and the rail in one frame, so firstElementChild is
  // now the frame — animating it would drag the rail in from the side along
  // with the month.
  assert.match(fn, /scroll\.querySelector\('\.cal-canvas'\)\?\.firstElementChild/,
    'the whole frame is animated, rail included');
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{\s*\.cal-canvas-next/,
    'the canvas animation ignores reduced motion');
});

/* ── §16/§17 Add menu and scheduling ─────────────────────────────────── */

test('add menu: Event, Reminder, Schedule a task — and no Habit', () => {
  assert.ok(!/'habit'/.test(eventModal), 'Habit is still offered in the Calendar Add menu');
  assert.match(eventModal, /'task', 'Schedule a task'/, 'the task entry was not renamed');
  for (const k of ["'event'", "'reminder'", "'task'"]) {
    assert.ok(eventModal.includes(k), `the add menu is missing ${k}`);
  }
  assert.match(appCode, /task: \(\) => openScheduleTask/, 'Schedule a task does nothing');
});

test('schedule: a real flow with a conflict check before confirming', () => {
  assert.match(scheduleModal, /export function openScheduleTaskModal/, 'no scheduling modal');
  for (const part of ['st-task', 'st-date', 'st-time', 'st-durations', 'st-check']) {
    assert.ok(scheduleModal.includes(part), `the scheduling flow has no ${part}`);
  }
  assert.match(scheduleModal, /function refreshCheck/, 'conflicts are not previewed');
  assert.match(scheduleModal, /has-clash/, 'a clash is not shown before confirming');
  // Scheduling must never touch the task's own fields.
  assert.ok(!/dueDate:|bucket:|areaId:\s*[^)]*=>/.test(
    scheduleModal.slice(scheduleModal.indexOf('onSchedule'))),
  'the scheduling flow writes task fields');
});

test('schedule: an empty queue is a real state, not a dead form', () => {
  assert.match(scheduleModal, /const empty = tasks\.length === 0/, 'the empty case is unhandled');
  assert.match(scheduleModal, /Nothing waiting to be scheduled/, 'no empty-state copy');
  assert.match(scheduleModal, /st-open-tasks/, 'the empty state offers no way forward');
});

test('schedule: free/busy transparency is respected', () => {
  // An event the user marked Free must not block a planning slot.
  assert.match(appCode, /e\.transparency === 'transparent'/,
    'events marked free are still treated as busy');
});

/* ── §19 Read-only Google events ─────────────────────────────────────── */

test('events: a Google event opens a detail sheet, and edits through a confirmation', () => {
  /* This used to assert that no edit affordance existed at all — correct while
   * the integration was read-only, wrong now. What still has to hold is that
   * the SHEET is not a form: it shows the event and offers actions, and every
   * action goes through the composer and its confirmation rather than editing
   * in place and saving. */
  assert.match(appCode, /if \(ev && ev\.syncState === 'synced'\) return openEventDetail\(ev\)/,
    'a real Google event bypasses the detail sheet');
  assert.match(detail, /export function openDetailSheet/, 'no detail surface');
  // Still no inline editing: the sheet reads, the composer writes.
  assert.ok(!/<input|<textarea|<select/.test(detail), 'the detail sheet contains form controls');
  assert.ok(!/Save|Create/.test(detail.slice(detail.indexOf('m-foot'))),
    'the detail sheet saves directly, skipping the confirmation');
  // Edit and Delete are offered only where Google would accept them.
  const fn = appCode.slice(appCode.indexOf('function openEventDetail(ev)'),
    appCode.indexOf('const prettyDay ='));
  assert.match(fn, /editable \? \[/, 'the actions are offered unconditionally');
  assert.match(fn, /openEventEditor\(ev\)/, 'there is no way to edit a Google event');
  assert.match(fn, /deleteCalendarEvent\(ev\)/, 'there is no way to delete a Google event');
  assert.match(detail, /Open in Google Calendar/, 'no way to reach the real event');
  /* The sentence changed with the capability. Life OS CAN now change an
   * ordinary Google event — so the note explains the cases where it still
   * cannot, rather than claiming a blanket limit that is no longer true. */
  assert.match(fn, /Google does not allow this kind of event to be changed/,
    'the remaining read-only cases are not explained to the user');
});

test('events: local events remain editable', () => {
  // The editor still exists for Life OS-local events, which Life OS can change.
  assert.match(appCode, /openEventModal\(\{/, 'the editor was removed entirely');
});

/* ── §26 Mode persistence ────────────────────────────────────────────── */

test('state: the last mode is restored before the first paint', () => {
  assert.match(appCode, /localStorage\.setItem\('los2_cal_mode'/, 'the mode is not remembered');
  assert.match(appCode, /if \(!cal\.restored\)/, 'the mode is restored more than once');
  // Restored inside loadCalendar BEFORE rendering, so the pill never flashes.
  const fn = appCode.slice(appCode.indexOf('async function loadCalendar'));
  const restoreAt = fn.indexOf('los2_cal_mode');
  const renderAt = fn.indexOf('calendarHeaderHtml');
  assert.ok(restoreAt > -1 && restoreAt < renderAt,
    'the mode is restored after the header renders, so it flashes');
  // Transient state must not persist.
  assert.ok(!/localStorage\.setItem\('los2_cal_(hover|popover|selected)/.test(app),
    'transient UI state is being persisted');
});

/* ── §22 Cleanup safety ──────────────────────────────────────────────── */

test('data: synthetic cleanup cannot touch real Google projections', () => {
  const calRoute = readFileSync(join('src', 'routes', 'calendar.ts'), 'utf8');
  const fn = calRoute.slice(calRoute.indexOf('async function clearSynthetic'));
  assert.match(fn, /eq\(calendars\.isSynthetic, true\)/, 'cleanup is not scoped to synthetic rows');
  assert.match(fn, /eq\(reminders\.isSynthetic, true\)/, 'cleanup could remove real reminders');
  assert.match(fn, /eq\(taskScheduleBlocks\.isSynthetic, true\)/,
    'cleanup could remove real schedule blocks');
  // Never these.
  for (const safe of ['tasks', 'habits', 'habitEntries', 'calendarConnections']) {
    assert.ok(!new RegExp(`db\\.delete\\(${safe}\\)`).test(fn), `cleanup deletes ${safe}`);
  }
});
