/**
 * Phase D4.6 — state model, reminder simplification, contextual layout.
 *
 * The state-machine assertions are the point. The previous implementation
 * expressed "reminders are open" through the same variable as "which time view
 * am I in", so Month stayed selected behind the workspace and its still-wired
 * period controls kept mutating calendar state nobody could see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextAfter } from '../src/lib/recurrence.js';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
/* index.html + app.css: the stylesheet moved out of the page so the home
 * page is 5KB instead of 350KB. These assertions are about the app's CSS,
 * which is still the app's CSS — it just has its own file now. */
const html = read('index.html') + read('app.css');
const app = read('app.js');
const calendar = read('calendar.js');
const view = read('reminders-view.js');
const calRoute = readFileSync(join('src', 'routes', 'calendar.ts'), 'utf8');

const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
const appCode = code(app);
const calCode = code(calendar);

function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `${decl} not found`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:async )?(?:export )?function /);
  return end === -1 ? rest : rest.slice(0, end);
}

/* ── §1/§2 The state model ───────────────────────────────────────────── */

test('state: mode and utility are separate concepts', () => {
  // One variable for both is what let Month stay selected behind Reminders.
  assert.match(calCode, /utility: 'none'/, 'there is no utility state');
  assert.ok(!/view: 'calendar'/.test(calCode), 'the old conflated view state survives');
  // Reminders is never a mode.
  const modes = calCode.slice(calCode.indexOf('const MODES'), calCode.indexOf('const LAYERS'));
  assert.ok(!/reminder/i.test(modes), 'Reminders is still a Calendar mode');
});

test('state: a utility replaces the header rather than filtering it', () => {
  // Hiding controls individually left them in the DOM and still wired, which
  // is how Today kept changing the month behind the workspace.
  assert.match(calCode, /if \(cal\.utility === 'reminders'\) return remindersHeaderHtml\(\)/,
    'the utility does not get its own header');
  const remHead = body(calCode, 'function remindersHeaderHtml()');
  for (const gone of ['data-mode', 'data-cal', 'data-layer', 'cal-period', 'cal-add']) {
    assert.ok(!remHead.includes(gone),
      `the Reminders header still renders ${gone}, so it can mutate calendar state`);
  }
  assert.match(remHead, /rv-back/, 'there is no way back to Calendar');
});

test('state: no Calendar rail inside a utility', () => {
  const fn = body(calCode, 'export function calendarRailHtml()');
  assert.match(fn, /if \(cal\.utility !== 'none'\) return ''/,
    'the Month rail leaks into the Reminders workspace');
});

/* ── §3 Routing ──────────────────────────────────────────────────────── */

test('routing: reminders is a real destination', () => {
  assert.match(appCode, /const utilityFromHash/, 'the utility is not in the URL');
  assert.match(appCode, /sub === 'reminders' \? 'reminders' : 'none'/,
    'the reminders subroute is not parsed');
  assert.match(appCode, /history\.pushState\(null, '', '#calendar\/reminders'\)/,
    'entering reminders does not change the URL, so Back cannot leave it');
  // Refresh must land on reminders, not Month.
  assert.match(appCode, /cal\.utility = utilityFromHash\(\)/,
    'a refresh on the reminders URL opens Month');
});

test('routing: back and forward move between calendar and utility', () => {
  const fn = appCode.slice(appCode.indexOf("window.addEventListener('hashchange'"));
  assert.match(fn.slice(0, 600), /u !== cal\.utility/,
    'browser navigation within Calendar is ignored');
  assert.match(fn.slice(0, 600), /openRemindersView\(false\)/,
    'back/forward pushes another history entry');
});

test('routing: leaving restores the exact calendar position', () => {
  // Without the snapshot, Back rebuilt Month from whatever cal.anchor happened
  // to be — often not where the user left.
  const open = body(appCode, 'async function openRemindersView(push = true)');
  assert.match(open, /cal\.resume = \{ mode: cal\.mode, anchor: new Date\(cal\.anchor\), selected: cal\.selected \}/,
    'the calendar position is not snapshotted');
  assert.match(open, /cal\.selected = null/,
    'a selected day survives into the workspace and leaks the rail');
  const close = body(appCode, 'function closeRemindersView(push = true)');
  assert.match(close, /cal\.mode = back\.mode/, 'the mode is not restored');
  assert.match(close, /cal\.anchor = back\.anchor/, 'the period is not restored');
});

/* ── §4 Entry point ──────────────────────────────────────────────────── */

test('entry: reminders sits behind one restrained utility control', () => {
  // A peer-sized button gave reminder management equal status to the three
  // core time views.
  assert.ok(!/cal-remind/.test(calendar), 'the prominent Reminders button survives');
  assert.match(calCode, /utilityTriggerHtml\('cal-util'/, 'there is no utility control');
  const menu = body(appCode, 'function openCalendarUtility(anchor)');
  for (const label of ['Manage reminders', 'Calendar sources', 'Calendar key']) {
    assert.ok(menu.includes(label), `the utility menu is missing "${label}"`);
  }
  // Plain text, not an unexplained icon-only menu.
  assert.ok(!/data-cu="\w+"><svg/.test(menu), 'the menu uses icons without labels');
});

/* ── §6/§7 Filters ───────────────────────────────────────────────────── */

test('filters: Active and Paused only', () => {
  const filters = view.slice(view.indexOf('const FILTERS'), view.indexOf('const esc'));
  assert.match(filters, /id: 'active'/, 'no Active filter');
  assert.match(filters, /id: 'paused'/, 'no Paused filter');
  for (const gone of ['upcoming', 'recurring', 'overdue', 'completed']) {
    assert.ok(!filters.includes(`id: '${gone}'`), `the ${gone} filter is back`);
  }
});

test('filters: overdue is a badge inside Active, not a tab', () => {
  assert.match(view, /rv-badge/, 'there is no overdue badge');
  assert.match(view, /r\.isOverdue \? `<span class="rv-badge">Overdue/, 'overdue is not badged');
  // And it sorts to the top, because it is the only thing needing action today.
  const fn = body(view, 'function filterReminders(list, filter)');
  assert.match(fn, /a\.isOverdue !== b\.isOverdue/, 'overdue reminders are not surfaced first');
});

test('filters: completing an occurrence keeps a recurring rule Active', () => {
  // A "Completed" tab implied an ending that had not happened.
  const fn = body(view, 'function filterReminders(list, filter)');
  assert.match(fn, /!\(r\.status === 'done' && !r\.recurrence\)/,
    'a recurring rule drops out of Active when one occurrence is ticked');
});

test('filters: every card states its own rule, including one-offs', () => {
  assert.match(view, /esc\(r\.recurrenceText \?\? 'Once'\)/,
    'a one-off reminder shows no rule at all');
});

/* ── §8 Pause and resume ─────────────────────────────────────────────── */

test('pause: stops future occurrences without losing the rule', () => {
  const q = calRoute.slice(calRoute.indexOf('const allRems'), calRoute.indexOf('const links'));
  assert.match(q, /if \(r\.status === 'paused'\) return \[\]/,
    'a paused reminder still generates occurrences');
  const pause = calRoute.slice(calRoute.indexOf("reminders/:id/pause"));
  assert.ok(!/db\.delete/.test(pause.slice(0, 700)), 'pausing deletes something');
});

test('resume: rolls a stale rule forward instead of firing in the past', () => {
  // A reminder paused in March and resumed in August must not come back due
  // in March.
  const fn = calRoute.slice(calRoute.indexOf("reminders/:id/resume"));
  assert.match(fn.slice(0, 1600), /due < today/, 'a stale date is resumed unchanged');
  assert.match(fn.slice(0, 1600), /nextAfter\(due, rule\)/, 'the rule is not rolled forward');
  assert.match(fn.slice(0, 1600), /i < 500/, 'the roll-forward loop is unbounded');

  // The maths itself, on a rule four months stale.
  let due = '2026-03-15';
  const rule = { frequency: 'MONTHLY', interval: 1, byMonthDay: [15] };
  for (let i = 0; i < 20 && due < '2026-08-01'; i++) due = nextAfter(due, rule);
  assert.equal(due, '2026-08-15', 'resume lands on the wrong occurrence');
});

/* ── §12/§13 Contextual rail ─────────────────────────────────────────── */

test('rail: Month has none until a day is selected', () => {
  const fn = body(calCode, 'export function calendarRailHtml()');
  assert.match(fn, /if \(cal\.mode === 'month' && !cal\.selected\) return ''/,
    'Month shows a rail with nothing to say');
  assert.match(fn, /if \(cal\.mode === 'agenda'\) return ''/, 'Agenda still has a permanent rail');
  assert.match(calCode, /export const railIsOpen/, 'the layout cannot tell whether the rail is open');
});

test('rail: the grid reclaims the width when the rail closes', () => {
  // D4.6 collapsed the PAGE rail column to do this. D4.7 replaced that: the
  // page column also carried the header and the canvas, both centred inside
  // it, so collapsing it slid the whole composition sideways on every
  // selection. The rail now lives inside the Calendar frame, and only the
  // canvas gives up width — from its right edge, so no day column moves.
  // The empty track and its gutter are kept at zero width on purpose: removing
  // them widened .main-col and slid the whole composition 38px right.
  assert.match(html, /body:has\(\.cal-head\) \.main-wrap\{grid-template-columns:minmax\(0,1fr\) 0\}/,
    'the column the frame centres in changed width');
  assert.match(html, /\.cal-body\{[^}]*grid-template-columns:minmax\(0,1fr\) var\(--cal-rail-col\)/,
    'the frame does not give the rail its width');
  assert.match(html, /body\.cal-rail-open\{--cal-rail-col:calc\(var\(--cal-rail-w\) \+ var\(--cal-rail-gap\)\)\}/,
    'the rail has no open width');
  assert.match(appCode, /classList\.toggle\('cal-rail-open', open\)/,
    'nothing toggles the rail open state');
});

test('rail: the duplicated date and sync cards are gone', () => {
  // The selected-day card carries its own date; a context card above it said
  // the same thing twice.
  assert.ok(!/function railContextHtml/.test(calCode), 'the duplicate date card survives');
  assert.ok(!/rail-sync/.test(calCode), 'the permanent sync card survives');
  // Sync status lives in the sources popover instead.
  assert.match(calCode, /lastSyncedWord\(conn\.lastSyncedAt\)/, 'sync status vanished entirely');
});

/* ── §15 Today history ───────────────────────────────────────────────── */

test('history: the renderer exists — this is the crash that shipped', () => {
  // `historyHtml is not defined`: an earlier refactor deleted the definition
  // and left the call site. Same failure mode as toggleReminder.
  assert.match(appCode, /function historyHtml\(\)/, 'historyHtml is still undefined');
  assert.match(appCode, /function wireHistory\(\)/, 'wireHistory is still undefined');
  assert.match(appCode, /function historyRowHtml\(t\)/, 'history rows have no renderer');
  // Every function the history route calls must exist.
  const route = appCode.slice(appCode.indexOf("state.route === 'history'"));
  for (const called of ['loadHistory', 'historyHtml', 'wireHistory']) {
    assert.match(appCode, new RegExp(`function ${called}\\(|async function ${called}\\(`),
      `the history route calls ${called}, which does not exist`);
    assert.ok(route.slice(0, 700).includes(called), `${called} is no longer called`);
  }
});

test('history: rows carry title, date and a way back', () => {
  const fn = body(appCode, 'function historyRowHtml(t)');
  assert.match(fn, /hist-title/, 'no task title');
  assert.match(fn, /hist-when/, 'no completion date');
  assert.match(fn, /data-restore/, 'no Restore action');
  assert.match(appCode, /async function restoreTask\(id\)/, 'Restore does nothing');
  assert.match(html, /\.hist-restore\{/, 'Restore has no styling');
});

test('history: the count is out of the board and behind an overflow', () => {
  assert.ok(!/today-history/.test(appCode), 'the completed count is back in the Today board');
  assert.match(appCode, /utilityTriggerHtml\('today-more'/, 'Today has no overflow control');
  assert.match(appCode, /View completed tasks/, 'the overflow does not offer history');
  // Not in Settings, not in the sidebar.
  assert.ok(!/completed/i.test(read('settings.js').slice(0, 2000)), 'Completed moved into Settings');
  const routes = read('routes.js');
  const primary = routes.slice(routes.indexOf('export const ROUTES'), routes.indexOf('SECONDARY_ROUTES'));
  assert.ok(!/history/.test(primary), 'Completed became a sidebar item');
});
