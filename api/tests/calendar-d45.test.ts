/**
 * Phase D4.5 — discoverability, recurrence visibility, account interaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expand } from '../src/lib/recurrence.js';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const html = read('index.html');
const app = read('app.js');
const calendar = read('calendar.js');
const view = read('reminders-view.js');
const settings = read('settings.js');
const calRoute = readFileSync(join('src', 'routes', 'calendar.ts'), 'utf8');
const product = readFileSync(join('..', 'docs', 'calendar-v2-product-model.md'), 'utf8');

const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
const appCode = code(app);
const calCode = code(calendar);

/* ── §1 The rules ────────────────────────────────────────────────────── */

test('discoverability and rail rules are documented', () => {
  assert.match(product, /No feature is complete unless the user has an obvious place to find it/,
    'the discoverability rule is not recorded');
  assert.match(product, /The rail is optional/, 'the rail rule is not recorded');
  assert.match(product, /Settings is for configuration/, 'the Settings boundary is not stated');
});

/* ── §2-§5 The workspace ─────────────────────────────────────────────── */

test('reminders: reachable from Calendar in one action', () => {
  // D4.6 moved it behind one restrained utility control: a peer-sized button
  // gave reminder management equal status to the three core time views.
  assert.match(calCode, /id="cal-util"/, 'no Calendar utility control');
  assert.match(appCode, /'Manage reminders'/, 'the utility menu does not offer reminders');
  assert.match(appCode, /openRemindersView/, 'the entry does not open anything');
  // Not buried in Settings.
  const tabs = settings.slice(settings.indexOf('SETTINGS_TABS'), settings.indexOf('];'));
  assert.ok(!/reminder/i.test(tabs), 'Reminders is a Settings tab');
});

test('reminders: one workspace with filters, not five pages', () => {
  assert.match(view, /const FILTERS = \[/, 'no filters');
  // D4.6 cut this to Active and Paused. Recurring repeated what every card
  // already says; Completed implied an ending that ticking one occurrence of a
  // monthly rule had not caused; Overdue is a badge, not a kind of reminder.
  for (const f of ['active', 'paused']) {
    assert.ok(view.includes(`'${f}'`), `the ${f} filter is missing`);
  }
  for (const gone of ['upcoming', 'recurring', 'completed']) {
    assert.ok(!view.includes(`id: '${gone}'`), `the ${gone} filter came back`);
  }
  assert.match(view, /function filterReminders/, 'filters are not one list viewed differently');
});

test('reminders: rows show the RULE, not just the next date', () => {
  assert.match(view, /rv-rule/, 'the recurrence rule is not shown');
  assert.match(view, /r\.recurrenceText/, 'the rule is not rendered in words');
  assert.match(view, /Next: /, 'the next occurrence is not shown');
  assert.ok(!/RRULE|FREQ=|BYDAY/.test(view), 'raw recurrence syntax reaches the user');
});

test('reminders: complete, pause and end-series are distinct actions', () => {
  // Three different intents that a single "done" button would blur together.
  for (const route of ['complete', 'pause', 'resume', 'end-series']) {
    assert.ok(calRoute.includes(`reminders/:id/${route}`), `no ${route} route`);
  }
  const end = calRoute.slice(calRoute.indexOf('end-series'));
  assert.match(end.slice(0, 1200), /db\.delete\(reminderRecurrenceRules\)/,
    'ending a series leaves the rule in place');
});

/* ── §6/§7 Future occurrence visibility ──────────────────────────────── */

test('recurrence: future months appear without completing the current one', () => {
  // The bug this phase exists for: September was invisible until August had
  // been ticked off.
  const sept = expand('2026-08-28', { frequency: 'MONTHLY', interval: 1, byMonthDay: [28] },
    '2026-09-01', '2026-09-30');
  assert.equal(sept.length, 1, 'next month is invisible');
  assert.equal(sept[0]!.date, '2026-09-28');
  assert.equal(sept[0]!.isVirtual, true, 'a derived occurrence is not marked virtual');
});

test('recurrence: the range query expands rather than filtering by due date', () => {
  // Filtering first hides exactly what this needs: a monthly reminder anchored
  // in August has no stored row anywhere near December.
  const q = calRoute.slice(calRoute.indexOf('const allRems'), calRoute.indexOf('const links'));
  assert.match(q, /expand\(r\.dueDate, rule, q\.data\.from, q\.data\.to\)/,
    'reminders are not expanded for the range');
  assert.ok(!/gte\(reminders\.dueDate/.test(q),
    'reminders are still filtered by stored due date, hiding future occurrences');
  assert.match(q, /r\.status === 'paused'/, 'a paused reminder still generates occurrences');
});

test('recurrence: one engine, shared by every view', () => {
  assert.match(calRoute, /from '\.\.\/lib\/recurrence\.js'/, 'the shared engine is not used');
  assert.match(calRoute, /nextAfter\(existing\.dueDate, rule\)/,
    'completion uses its own date maths');
});

test('recurrence: no rows are written for future occurrences', () => {
  // Materialising them means every edit must chase down an unbounded set, and
  // a missed one fires on a date its own rule no longer agrees with.
  const q = calRoute.slice(calRoute.indexOf('const allRems'), calRoute.indexOf('const links'));
  assert.ok(!/db\.insert\(reminders\)/.test(q), 'expansion writes rows to the database');
  assert.match(q, /isVirtual: o\.isVirtual/, 'virtual occurrences are indistinguishable');
});

/* ── §13-§16 Account interaction ─────────────────────────────────────── */

test('account: the identity button goes straight to Settings', () => {
  assert.match(appCode, /id="account-btn" data-route="settings"/,
    'the identity button is not a direct link');
  assert.match(appCode, /getElementById\('account-btn'\)\?\.addEventListener\('click', \(\) => go\('settings'\)\)/,
    'clicking the identity does not open Settings');
});

test('account: the popover is gone entirely', () => {
  for (const gone of ['openAccountMenu', 'closeAccountMenu', 'onOutsideAccount',
    'account-menu', 'data-am=']) {
    assert.ok(!app.includes(gone), `the account popover survives as ${gone}`);
  }
});

test('account: Sign out and version in Settings, Completed on Today', () => {
  assert.match(settings, /id="sign-out"/, 'Sign out is not in Settings');
  assert.match(settings, /LIFE_OS_BUILD/, 'the build is not in Settings');
  assert.ok(!/who-chev/.test(appCode), 'the popover chevron survives');
  // Completed is content, so it sits with the content.
  // D4.6 moved it out of the board flow: a running total of finished work was
  // competing with what still needs doing.
  assert.match(appCode, /id="today-more"/, 'Today has no overflow control');
  assert.match(appCode, /View completed tasks/, 'the overflow does not offer history');
  assert.ok(!/today-history/.test(appCode), 'the count is back in the board');
  // It must be REACHABLE but not in the primary list — scoped to ROUTES, since
  // SECONDARY_ROUTES legitimately carries it so the route resolves at all.
  const routes = read('routes.js');
  const primary = routes.slice(routes.indexOf('export const ROUTES'),
    routes.indexOf('SECONDARY_ROUTES'));
  assert.ok(!/id: 'history'/.test(primary), 'Completed became a sidebar item');
  assert.match(routes, /SECONDARY_ROUTES[\s\S]{0,200}id: 'history'/,
    'Completed is not reachable as a route');
});

/* ── §19 Header alignment ────────────────────────────────────────────── */

test('header: three zones, with a centre that is genuinely centred', () => {
  // A bare `1fr` will not shrink below its content, so the wider side column
  // steals from the middle — measured 40px off-centre before minmax(0,1fr).
  assert.match(html, /\.cal-head-row\{display:grid;grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/,
    'the header columns can be pushed off-centre by their own content');
  for (const zone of ['cal-head-main', 'cal-head-mid', 'cal-head-side']) {
    assert.ok(calendar.includes(zone), `the ${zone} zone is missing`);
  }
  assert.match(html, /\.cal-head-mid\{justify-self:center\}/, 'the centre zone is not centred');
});

/* ── §21/§22 Rail ────────────────────────────────────────────────────── */

test('rail: raw statistics are gone', () => {
  // The offenders: 58 events, 10 reminders, 0 deadlines, 90 hours free.
  const agenda = calCode.slice(calCode.indexOf('function agendaRailHtml'),
    calCode.indexOf('export function sourcesPopoverHtml'));
  assert.ok(!/rl-t">Events</.test(agenda), 'the Agenda rail still lists an event total');
  assert.ok(!/rl-t">Reminders</.test(agenda), 'the Agenda rail still lists a reminder total');
  const plan = calCode.slice(calCode.indexOf('function planRailHtml'));
  assert.ok(!/Free time in planning hours/.test(plan), 'the Plan rail still totals free hours');
  assert.ok(!/rl-t">Planned blocks</.test(plan), 'the Plan rail still counts blocks');
});

test('rail: every insight names a day and can be clicked', () => {
  const plan = calCode.slice(calCode.indexOf('function planRailHtml'));
  assert.match(plan, /h free from/, 'the free-window insight does not name a day and a time');
  assert.match(appCode, /data-insight/, 'insights are not clickable');
  const agenda = calCode.slice(calCode.indexOf('function agendaRailHtml'),
    calCode.indexOf('export function sourcesPopoverHtml'));
  assert.match(agenda, /if \(!insights\.length\) return ''/,
    'the Agenda rail renders even with nothing to say');
});

test('rail: Month with no selection surfaces unusual dates, not totals', () => {
  const fn = calCode.slice(calCode.indexOf('function monthOverviewHtml'),
    calCode.indexOf('function agendaRailHtml'));
  assert.ok(!/rl-t">Events</.test(fn), 'the month overview still counts events');
  assert.match(fn, /Birthdays ahead|Heavily booked/, 'nothing worth knowing is surfaced');
});
