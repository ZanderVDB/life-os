/**
 * Phase D4.3 — staging source safety, synthetic cleanup, Calendar consolidation.
 *
 * The cleanup assertions carry the most weight here. Deleting demonstration
 * data that sits beside 500+ real Google events is the kind of operation that
 * is only safe when it is scoped, previewed, confirmed and impossible in
 * production — and each of those is asserted separately.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isStagingCleanupAllowed } from '../src/lib/import-writer.js';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const html = read('index.html');
const app = read('app.js');
const calendar = read('calendar.js');
const calRoute = readFileSync(join('src', 'routes', 'calendar.ts'), 'utf8');
const googleRoute = readFileSync(join('src', 'routes', 'google-calendar.ts'), 'utf8');
const googleClient = readFileSync(join('src', 'lib', 'google-calendar.ts'), 'utf8');

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

/* ── §4/§5 Synthetic cleanup ─────────────────────────────────────────── */

test('cleanup: preview and execution are separate calls', () => {
  assert.match(calRoute, /calendar\/synthetic\/preview/, 'there is no preview endpoint');
  assert.match(calRoute, /calendar\/synthetic\/cleanup/, 'there is no cleanup endpoint');
  // The blunt DELETE is gone — a destructive op behind one opaque request.
  assert.ok(!/app\.delete\('[^']*calendar\/synthetic'/.test(calRoute),
    'the unguarded DELETE endpoint is back');
});

test('cleanup: requires an exact confirmation phrase', () => {
  assert.match(calRoute, /const CONFIRM_PHRASE = 'DELETE SYNTHETIC CALENDAR DATA'/,
    'no confirmation phrase');
  assert.match(calRoute, /b\.data\.confirm !== CONFIRM_PHRASE/,
    'the phrase is not actually checked');
});

test('cleanup: is impossible in production', () => {
  // Both endpoints, not just the destructive one — a preview that leaks counts
  // from production is still a production read it should not perform.
  const guards = calRoute.match(/isStagingCleanupAllowed\(process\.env\.NODE_ENV/g) ?? [];
  assert.ok(guards.length >= 2, 'preview or cleanup is missing the production guard');
  assert.equal(isStagingCleanupAllowed('production'), false, 'production is not blocked');
  assert.equal(isStagingCleanupAllowed('staging'), true, 'staging is blocked');
});

test('cleanup: the preview reports what survives, not only what goes', () => {
  const fn = body(calRoute, 'async function syntheticCounts(db: Db, workspaceId: string)');
  for (const removed of ['syntheticCalendars', 'syntheticEvents',
    'syntheticReminders', 'syntheticBlocks']) {
    assert.ok(fn.includes(removed), `the preview does not count ${removed}`);
  }
  for (const kept of ['googleCalendars', 'googleEvents', 'tasks', 'habits', 'habitEntries']) {
    assert.ok(fn.includes(kept), `the preview does not report retained ${kept}`);
  }
});

test('cleanup: deletes only synthetic rows, and never real data', () => {
  const fn = body(calRoute, 'async function clearSynthetic(db: Db, workspaceId: string)');
  assert.match(fn, /eq\(calendars\.isSynthetic, true\)/, 'calendars are not scoped to synthetic');
  assert.match(fn, /eq\(reminders\.isSynthetic, true\)/, 'reminders are not scoped to synthetic');
  assert.match(fn, /eq\(taskScheduleBlocks\.isSynthetic, true\)/,
    'schedule blocks are not scoped to synthetic');
  for (const safe of ['tasks', 'habits', 'habitEntries', 'calendarConnections',
    'calendarSyncStates', 'workspaces', 'areas']) {
    assert.ok(!new RegExp(`db\\.delete\\(${safe}\\)`).test(fn), `cleanup deletes ${safe}`);
  }
});

test('cleanup: runs in a transaction and logs counts only', () => {
  assert.match(calRoute, /db\.transaction\(async \(tx\)/, 'cleanup is not transactional');
  const log = calRoute.slice(calRoute.indexOf('app.log.info({'),
    calRoute.indexOf("'synthetic calendar cleanup'"));
  assert.ok(!/title|summary|description|email/i.test(log),
    'the audit entry could contain private content');
  assert.match(log, /removed:/, 'the audit entry has no removal counts');
  assert.match(log, /retained:/, 'the audit entry does not record what survived');
});

/* ── §7 Stable rail ──────────────────────────────────────────────────── */

test('rail: contextual, with only the mode band changing', () => {
  // D4.3 required a permanently stable rail. D4.6 revised that: a rail kept
  // for symmetry is an empty column with a border, so the context card was
  // removed (it duplicated the selected-day date) and the rail now appears
  // only when it has something to say.
  for (const fn of ['railModeHtml', 'railAttentionHtml']) {
    assert.match(calCode, new RegExp(`function ${fn}`), `the rail has no ${fn}`);
  }
  const shell = body(calCode, 'export function calendarRailHtml()');
  assert.match(shell, /data-rail-ctx="\$\{cal\.mode\}"/, 'the mode band is not identified');
  assert.match(shell, /railAttentionHtml\(\)/, 'the attention card is not always present');
  assert.match(shell, /if \(cal\.mode === 'month' && !cal\.selected\) return ''/,
    'Month renders an empty rail');
  // Per-mode rails are gone.
  assert.ok(!calCode.includes('function monthRailHtml'),
    'Month still builds its own rail from scratch');
});

test('rail: the mode band crossfades rather than the rail flashing', () => {
  const fn = body(appCode, 'function renderCalendarRail()');
  assert.match(fn, /prevMode !== cal\.mode/, 'the transition fires on every render');
  assert.match(fn, /ctx\.animate/, 'the mode band does not transition');
  assert.match(fn, /reducedMotion\(\)/, 'the rail transition ignores reduced motion');
});

test('rail: source management is a popover, not the whole Agenda rail', () => {
  assert.match(calCode, /export function sourcesPopoverHtml/, 'no sources popover');
  // D4.7: same popover, shared shell. Sources and the Calendar key answer
  // questions of the same kind, so they are one object with two contents —
  // they used to be a 296px box opening left and a 300px box opening right.
  assert.match(appCode, /toggleSources = \(btn\) => openCalendarSurface\(btn, 'sources'\)/,
    'the popover cannot be opened');
  assert.match(html, /\.util-surface\{position:fixed/, 'the shared surface is not a popover');
  assert.match(html, /\.sources\{display:flex/, 'sources has no contents styling');
  // Agenda's rail band is now a summary, not plumbing.
  const agenda = body(calCode, 'function agendaRailHtml()');
  assert.ok(!/cal-connect|cal-disconnect|data-calendar/.test(agenda),
    'source controls are still embedded in the Agenda rail');
  // D4.5 replaced the "Coming up" totals with actionable insights, and made
  // the card render nothing at all when there is nothing worth saying.
  assert.match(agenda, /if \(!insights\.length\) return ''/,
    'the Agenda rail renders even with nothing to say');
});

test('rail: attention renders nothing when nothing is wrong', () => {
  const fn = body(calCode, 'function railAttentionHtml()');
  assert.match(fn, /if \(!clashes\.length && !overdue\.length && !unplanned\.length && !syncError\) return ''/,
    'an empty attention card is rendered as filler');
});

/* ── §9 Agenda width ─────────────────────────────────────────────────── */

test('agenda: uses the available width with a sensible cap', () => {
  assert.match(html, /\.cal-agenda\{max-width:var\(--cal-max\)\}/,
    'Agenda does not share the calendar bound');
  assert.match(html, /\.ag-day\{grid-template-columns:64px 1fr/, 'the date gutter did not widen');
  // Metadata is capped so rows do not stretch edge to edge.
  assert.match(html, /@media \(min-width:1200px\)\{\s*\.ag-meta\{max-width:44%/,
    'agenda metadata has no width discipline');
});

/* ── §10 Plan week ───────────────────────────────────────────────────── */

test('plan: weekdays carry the width, weekends recede but stay visible', () => {
  assert.match(html, /\.pl-grid\{grid-template-columns:54px repeat\(5,minmax\(0,1fr\)\) repeat\(2,minmax\(0,0\.62fr\)\)\}/,
    'seven equal columns are back');
  assert.match(calCode, /isWeekend/, 'weekends are not identified');
  // A weekend with commitments must not stay dimmed — a hidden commitment is
  // worse than a cramped one.
  assert.match(html, /\.pl-day\.is-weekend\.has-events \.pl-day-head\{opacity:1\}/,
    'a busy weekend stays dimmed');
  assert.match(calCode, /has-events/, 'a weekend cannot brighten');
});

test('plan: daily capacity appears only when it matters', () => {
  const fn = body(calCode, 'function planDayHtml(d, todayIso, hours)');
  assert.match(fn, /load === 'busy' \|\| load === 'overloaded'/,
    'capacity is shown on every day, including quiet ones');
  assert.match(html, /\.pl-load\.load-overloaded\{color:var\(--danger\)\}/,
    'capacity has no visual weight');
});

test('plan: free windows are labelled with real times', () => {
  const fn = body(calCode, 'function planDayHtml(d, todayIso, hours)');
  assert.match(fn, /Free \$\{fmtMin\(a\)\}–\$\{fmtMin\(b\)\}/, 'free windows have no time label');
  assert.match(html, /\.pl-free-label\{/, 'the free label has no styling');
  // Still ignores slivers.
  const free = body(calCode, 'function freeWindows(dayIso)');
  assert.match(free, /b - a >= 30/, 'a five-minute gap counts as a free window');
});

test('plan: the current-time marker is today-only and inside planning hours', () => {
  const fn = body(calCode, 'function planDayHtml(d, todayIso, hours)');
  assert.match(fn, /day === todayIso && nowPct\(hours\) !== null/,
    'the now marker can appear on the wrong day or pinned to an edge');
  const now = body(calCode, 'function nowPct(hours)');
  assert.match(now, /p >= 0 && p <= 100 \? p : null/,
    'the marker is clamped rather than hidden outside planning hours');
});

/* ── §15/§19 Google stays read-only ──────────────────────────────────── */

test('google: still read-only, with no write path anywhere', () => {
  assert.match(googleClient, /calendar\.readonly/, 'the scope changed');
  for (const bad of ['auth/calendar\'', 'calendar.events\'', 'calendar.acls']) {
    assert.ok(!googleClient.includes(bad), `a write scope appeared: ${bad}`);
  }
  assert.ok(!/insertEvent|patchEvent|deleteEvent/.test(googleClient), 'a write helper exists');
  // And the UI never offers one for a synced event.
  assert.match(appCode, /ev\.syncState === 'synced'.*openEventDetail/s,
    'a Google event can open the editor');
  const detail = read('detail-sheet.js');
  assert.ok(!/<input|<textarea|<select/.test(detail), 'the detail sheet has form controls');
});

test('data: cleanup cannot reach Google projections or the connection', () => {
  const fn = body(calRoute, 'async function clearSynthetic(db: Db, workspaceId: string)');
  // Synthetic calendars cascade their events; real ones are never selected.
  assert.match(fn, /eq\(calendars\.isSynthetic, true\)/, 'real calendars could be selected');
  assert.ok(!/calendarConnections/.test(fn), 'cleanup touches the Google connection');
  assert.ok(!/calendarSyncStates/.test(fn), 'cleanup discards sync tokens');
  // Disconnect is the only thing allowed to remove real projections.
  assert.match(googleRoute, /eq\(calendars\.connectionId, conn\.id\)/,
    'disconnect is not scoped to its own calendars');
});
