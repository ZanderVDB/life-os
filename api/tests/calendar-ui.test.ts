/**
 * Calendar UI contract (Phase D3/D4).
 *
 * Source assertions, same caveat as the other web tests: they prove a rule is
 * written down, not that a browser honours it. The runtime behaviour was driven
 * with synthetic pointer events in a real browser and the numbers are in the
 * phase report.
 *
 * What these catch cheaply: someone reintroducing Day/Week, flattening the item
 * types into event bars, putting a native date input in the editor, or letting
 * the Plan drag write on every pointer move.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
/* index.html + app.css: the stylesheet moved out of the page so the home
 * page is 5KB instead of 350KB. These assertions are about the app's CSS,
 * which is still the app's CSS — it just has its own file now. */
const html = read('index.html') + read('app.css');
const app = read('app.js');
const calendar = read('calendar.js');
const eventModal = read('event-modal.js');
const planDrag = read('plan-drag.js');
const routes = read('routes.js');
const calRoute = readFileSync(join('src', 'routes', 'calendar.ts'), 'utf8');
const product = readFileSync(join('..', 'docs', 'calendar-v2-product-model.md'), 'utf8');

const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const calCode = code(calendar);
const appCode = code(app);
const evCode = code(eventModal);
const dragCode = code(planDrag);

function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `${decl} not found`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:async )?(?:export )?function /);
  return end === -1 ? rest : rest.slice(0, end);
}

/* ── Product structure ───────────────────────────────────────────────── */

test('calendar: exactly three modes, and Month is the default', () => {
  assert.match(calCode, /id: 'month'/, 'Month is missing');
  assert.match(calCode, /id: 'agenda'/, 'Agenda is missing');
  assert.match(calCode, /id: 'plan'/, 'Plan is missing');
  // Scoped to the MODES array: LAYERS has the same literal shape, so an
  // unscoped match counts seven.
  const modeList = calCode.slice(calCode.indexOf('const MODES'), calCode.indexOf('const LAYERS'));
  const modes = modeList.match(/\{ id: '(\w+)', label: '[^']+' \}/g) ?? [];
  assert.equal(modes.length, 3, `expected 3 modes, found ${modes.length}`);
  assert.match(calCode, /mode: 'month'/, 'Month is not the default mode');
});

test('calendar: Day, 3 Day and Week are gone as modes', () => {
  // A selected date still opens a focused day view — that is a selection
  // state, not a mode, and must not reappear in the mode list.
  const modeBlock = calCode.slice(calCode.indexOf('const MODES'), calCode.indexOf('const LAYERS'));
  for (const gone of ['day', 'week', '3day', 'threeDay']) {
    assert.ok(!new RegExp(`id: '${gone}'`, 'i').test(modeBlock), `${gone} is back as a mode`);
  }
  // Anchored on mode ids, not the words themselves: the phrase "event bars"
  // appears in a comment explaining why items are NOT all rendered as one.
  for (const gone of ['bars', 'expanded']) {
    assert.ok(!new RegExp(`id: '${gone}'`, 'i').test(modeBlock), `the ${gone} mode is back`);
  }
});

test('calendar: layers are secondary controls, not item-type tabs', () => {
  for (const l of ['events', 'reminders', 'tasks', 'habits']) {
    assert.match(calCode, new RegExp(`id: '${l}'`), `layer ${l} is missing`);
  }
  // All on by default: the first view must make sense without touching them.
  assert.match(calCode, /layers: \{ events: true, reminders: true, tasks: true, habits: true \}/,
    'a layer is off by default, so the default view is incomplete');
  assert.match(html, /\.cal-layer\{/, 'layers have no compact styling');
  // They must not be rendered with the mode tablist.
  assert.ok(!/role="tablist"[\s\S]{0,200}data-layer/.test(calendar),
    'layers are presented as mode tabs');
});

test('calendar: is a real route, not a placeholder', () => {
  assert.ok(!/id: 'calendar'[^}]*placeholder: true/.test(routes),
    'Calendar is still marked as a placeholder');
  assert.match(appCode, /state\.route === 'calendar'/, 'no calendar route branch');
});

/* ── Item types stay distinct ────────────────────────────────────────── */

test('items: events, reminders, deadlines and blocks are never merged', () => {
  // itemsForDay returns them GROUPED. Flattening into one array is how
  // everything ends up rendered as an event bar.
  const fn = body(calCode, 'function itemsForDay(dayIso)');
  for (const key of ['events:', 'reminders:', 'deadlines:', 'blocks:', 'habit:']) {
    assert.ok(fn.includes(key), `itemsForDay does not return ${key}`);
  }
  // Each type has its own class in Agenda.
  for (const cls of ['ag-event', 'ag-reminder', 'ag-deadline', 'ag-block']) {
    assert.ok(calCode.includes(cls), `${cls} has no distinct rendering`);
  }
  // `ag-event` is the baseline `.ag-item` look; the other three must each
  // visibly depart from it, which is what stops them reading as event bars.
  assert.match(html, /\.ag-reminder\{background:transparent;border:1px dashed/,
    'reminders look like event bars');
  assert.match(html, /\.ag-deadline\{background:transparent;border-left:2px solid/,
    'deadlines look like event bars');
  assert.match(html, /\.ag-block\{background:rgba\(78,143,196,\.07\)/,
    'planned work looks like an event bar');
});

test('items: a habit never becomes an event', () => {
  // Calendar reads completion COUNTS to summarise rhythm; it does not copy
  // habit entries onto the canvas as items.
  assert.match(calRoute, /habitDays/, 'habit summary is missing');
  assert.match(calRoute, /count\(\*\)/, 'habits are returned as rows, not counts');
  assert.ok(!/habitEntries[\s\S]{0,200}calendarEvents/.test(calRoute),
    'habit entries are being written as events');
  assert.match(product, /A Habit does \*\*not\*\* become a calendar event/,
    'the rule is not recorded');
});

test('items: due date and scheduled time stay separate', () => {
  // Deadlines and blocks are queried independently and rendered differently.
  assert.match(calRoute, /const deadlines = await db/, 'deadlines are not their own query');
  assert.match(calRoute, /const blocks = await db/, 'schedule blocks are not their own query');
  // Creating a block must not touch the task.
  const create = calRoute.slice(calRoute.indexOf('calendar/blocks'), calRoute.indexOf('app.patch'));
  assert.ok(!/db\.update\(tasks\)/.test(create), 'scheduling a task mutates the task');
});

/* ── Month ───────────────────────────────────────────────────────────── */

test('month: cell content is prioritised, with an honest overflow count', () => {
  const fn = body(calCode, 'function monthCellHtml(d, month, todayIso)');
  assert.match(fn, /const SHOWN = 3/, 'no cap on visible labels');
  assert.match(fn, /cm-more/, 'no overflow count — items just disappear');
  // D4.4 renamed `shown` to `shownEv` when reminders joined the fill order,
  // so the cell fills events -> deadlines -> reminders by priority.
  assert.match(fn, /ordered\.length - shownEv\.length/, 'the count does not include hidden events');
  // All-day events sort above timed ones.
  assert.match(fn, /a\.isAllDay !== b\.isAllDay/, 'all-day events are not ordered first');
});

test('month: workload is committed time, not item count', () => {
  const fn = body(calCode, 'function workload(dayIso)');
  assert.match(fn, /new Date\(e\.endsAt\) - new Date\(e\.startsAt\)/,
    'workload counts items rather than time');
  for (const s of ['open', 'moderate', 'busy', 'overloaded']) {
    assert.ok(fn.includes(`'${s}'`), `workload state ${s} is missing`);
  }
  // Restrained: a 2px edge, never a heatmap fill.
  assert.match(html, /\.cm-cell\.load-busy::before\{background/, 'no workload indicator');
  assert.ok(!/\.cm-cell\.load-\w+\{background:(?!transparent)/.test(html),
    'workload fills the whole cell — that is a heatmap');
});

test('month: conflicts are real overlaps, not urgent tasks', () => {
  const fn = body(calCode, 'function conflictsOn(dayIso)');
  assert.match(fn, /new Date\(timed\[i\]\.startsAt\) < new Date\(timed\[i - 1\]\.endsAt\)/,
    'conflict detection does not compare times');
  assert.ok(!/priority/.test(fn), 'task priority leaks into calendar conflicts');
});

test('month: labels degrade to dots on small screens, never to fragments', () => {
  const mq = html.slice(html.indexOf('@media (max-width:900px)'));
  assert.match(mq, /\.cm-items \.cm-ev-t,\.cm-ev b,\.cm-due\{display:none\}/,
    'labels are not hidden on small screens');
  assert.match(mq, /\.cm-ev\{width:6px;height:6px;border-radius:50%/,
    'events do not become dots on small screens');
});

test('month: selecting a day patches the cell and rail, not the page', () => {
  const fn = body(appCode, 'function selectDay(day)');
  assert.ok(!/loadRoute|loadCalendar/.test(fn), 'selecting a day reloads the route');
  assert.ok(!/main-scroll'\)\.innerHTML/.test(fn), 'selecting a day rebuilds the canvas');
  assert.match(fn, /renderCalendarRail\(\)/, 'the rail does not follow the selection');
});

/* ── Rail ────────────────────────────────────────────────────────────── */

test('rail: changes by mode, and never shows daily habits', () => {
  // D4.3 replaced the three independent rails with one shell whose middle band
  // changes. The branch moved into railModeHtml; the per-mode builders remain
  // as the content of that band.
  assert.match(calCode, /function railModeHtml/, 'no per-mode rail content');
  assert.match(calCode, /if \(cal\.mode === 'plan'\) return planRailHtml/,
    'the mode band does not branch');
  assert.match(calCode, /function planRailHtml/, 'Plan has no rail content');
  assert.match(calCode, /function agendaRailHtml/, 'Agenda has no rail content');
  // Habits belong to Today. Calendar may summarise them inside a selected day,
  // but must not carry the daily habit list.
  assert.ok(!/Habits today/.test(calendar), 'the Today habit rail leaked into Calendar');
  assert.match(appCode, /if \(state\.route === 'calendar'\) return renderCalendarRail/,
    'the Today rail can clobber the Calendar rail');
});

/* ── Event editor ────────────────────────────────────────────────────── */

test('editor: no native browser chrome anywhere', () => {
  // The brief named these specifically.
  assert.ok(!/type="date"|type="time"|type="datetime-local"/.test(eventModal),
    'a native date/time input is back — that is the three-part date box');
  assert.ok(!/type="checkbox"/.test(eventModal), 'a native checkbox square is back');
  assert.match(html, /\.ev-select select\{appearance:none/, 'the native select arrow shows');
  assert.match(html, /\.sw-track\{/, 'the all-day toggle is not a custom switch');
  // D4.1 moved both pickers into pickers.js so the Event and Reminder editors
  // share one implementation rather than each growing their own.
  assert.match(evCode, /from '\.\/pickers\.js'/, 'the editor has no custom pickers');
  const pickers = read('pickers.js');
  assert.match(pickers, /export function datePickerPopover/, 'no custom date picker');
  assert.match(pickers, /export function timePickerPopover/, 'no custom time picker');
  // One shell, one height.
  assert.match(html, /\.ev-ctl\{height:38px/, 'controls do not share one height');
  assert.match(html, /:focus-visible\{outline:none;border-color:var\(--accent\)/,
    'the browser-blue focus ring is not replaced');
});

test('editor: only Google-compatible fields are offered', () => {
  // Every field here must round-trip. If it cannot, it does not belong in
  // the Google event editor.
  for (const f of ['ev-title', 'ev-cal', 'ev-loc', 'ev-desc', 'ev-rec',
    'ev-vis', 'ev-guest', 'ev-notify']) {
    assert.ok(eventModal.includes(f), `${f} is missing from the editor`);
  }
  assert.match(evCode, /transparency/, 'busy/free is missing');
  assert.match(evCode, /providerColorId/, 'Google colour is missing');
  // And the API must accept exactly those.
  for (const f of ['transparency', 'visibility', 'providerColorId', 'recurrence']) {
    assert.ok(calRoute.includes(f), `the API cannot persist ${f}`);
  }
});

test('editor: Life OS-only relationships are visually separated and labelled', () => {
  assert.match(evCode, /ev-los/, 'no Life OS-only section');
  assert.match(eventModal, /will not see these/i,
    'the editor does not say Google users cannot see Life OS links');
  assert.match(html, /\.ev-los\{[^}]*border:1px dashed/,
    'the Life OS section is not visually distinct from Google fields');
});

test('editor: progressive disclosure, not every field at once', () => {
  assert.match(evCode, /ev-adv/, 'no advanced section');
  assert.match(eventModal, /hidden>/, 'the advanced section starts open');
  assert.match(evCode, /aria-expanded/, 'the disclosure has no state');
});

test('editor: read-only calendars cannot be edited, in UI and API', () => {
  assert.match(evCode, /const readOnly = !!ev\?\.isReadOnly/, 'the editor ignores read-only');
  assert.match(eventModal, /read-only calendar/i, 'the user is not told why they cannot edit');
  // The server must refuse regardless of what the UI offered.
  assert.match(calRoute, /if \(cal\.isReadOnly\) throw badRequest/,
    'the API accepts writes to a read-only calendar');
});

test('editor: guards unsaved work and traps focus', () => {
  assert.match(evCode, /isDirty\(\)/, 'no unsaved-change guard');
  assert.match(evCode, /role', 'dialog'/, 'not a dialog');
  assert.match(evCode, /aria-modal/, 'not modal to assistive tech');
  assert.match(evCode, /e\.key !== 'Tab'/, 'no focus trap');
  assert.match(evCode, /opener\?\.isConnected/, 'focus is not returned to the opener');
  // Closing before the save result is known would lose the user's typing.
  assert.match(evCode, /await ctx\.onSave\(body\);\s*\n\s*close\(true\)/,
    'the modal closes before the save is confirmed');
});

test('editor: keyframes never touch transform, so the sheet still works', () => {
  const kf = evCode.slice(evCode.indexOf('const RISE_IN'), evCode.indexOf('const FOCUSABLE'));
  assert.ok(!kf.includes('transform:'), 'the entrance animation overrides positioning');
  assert.ok(kf.includes('translate:') && kf.includes('scale:'),
    'the independent transform properties are not used');
  assert.match(html, /\.modal-event\{left:0;right:0;bottom:0;top:auto;transform:none/,
    'the mobile sheet keeps the desktop centring');
});

/* ── Plan drag ───────────────────────────────────────────────────────── */

test('plan: drag writes once on drop and never during', () => {
  assert.ok(!/\bapi\(|fetch\(/.test(dragCode), 'the drag module writes directly');
  assert.match(dragCode, /hooks\.onCreate/, 'dropping a task does not create a block');
  assert.match(dragCode, /hooks\.onMove/, 'moving a block does not persist');
  // Both only from finish().
  const fin = body(dragCode, 'function finish(hooks)');
  assert.match(fin, /hooks\.onCreate|hooks\.onMove/, 'the drop does not persist');
  const dragFn = body(dragCode, 'function drag(e, hooks)');
  assert.ok(!/onCreate|onMove/.test(dragFn), 'the drag writes on every pointer move');
});

test('plan: conflicts are shown before release', () => {
  assert.match(dragCode, /hooks\.conflictsAt\(day, s\.startMin, endMin/,
    'conflicts are not computed during the drag');
  assert.match(dragCode, /classList\.toggle\('has-clash'/, 'a clash is not shown on the ghost');
  assert.match(html, /\.pl-ghost\.has-clash\{[^}]*border-color:var\(--danger\)/,
    'a clash is not visually distinct');
});

test('plan: the ghost is the proposed block at final dimensions', () => {
  assert.match(dragCode, /s\.ghost\.style\.top/, 'the ghost does not follow the pointer');
  assert.match(dragCode, /s\.ghost\.style\.height/, 'the ghost is not sized like the block');
  assert.match(dragCode, /fmt\(s\.startMin\)/, 'the ghost does not show the proposed time');
});

test('plan: snapping, minimums and the three gestures', () => {
  assert.match(dragCode, /const SNAP = 15/, 'no time snapping');
  assert.match(dragCode, /MIN_MINUTES/, 'a block can be resized to nothing');
  for (const kind of ["'create'", "'move'", "'resize'"]) {
    assert.ok(dragCode.includes(kind), `the ${kind} gesture is missing`);
  }
  assert.match(dragCode, /pointercancel/, 'a cancelled pointer strands the drag');
});

test('plan: scheduling rolls back and never touches the due date', () => {
  const fn = body(appCode, 'async function scheduleTask(taskId, startsAt, endsAt)');
  assert.match(fn, /cal\.data\.blocks\.push\(optimistic\)/, 'scheduling is not optimistic');
  assert.match(fn, /filter\(\(b\) => b\.id !== optimistic\.id\)/, 'a failed schedule does not roll back');
  assert.ok(!/dueDate:/.test(fn.replace(/dueDate: task\?\.dueDate \?\? null/, '')),
    'scheduling writes a due date');
  const mv = body(appCode, 'async function moveBlock(blockId, startsAt, endsAt)');
  assert.match(mv, /Object\.assign\(b, before\)/, 'a failed move does not roll back');
});

test('plan: only relevant hours are shown by default', () => {
  // An empty 24-hour grid with no planning purpose was Day view.
  assert.match(calCode, /const PLAN_START = 7/, 'Plan starts at midnight');
  assert.match(calCode, /const PLAN_END = 21/, 'Plan runs to midnight');
});

/* ── Add menu ────────────────────────────────────────────────────────── */

test('add menu: three types, and nothing that silently fails', () => {
  assert.match(evCode, /export function openAddMenu/, 'no Add menu');
  // Entries are filtered by whether a handler exists, so a missing flow is
  // simply not offered rather than offered and broken.
  assert.match(evCode, /\.filter\(\(\[k\]\) => handlers\[k\]\)/,
    'the menu can show an entry with no handler');
  // D4.2 removed Habit: it is a Calendar LAYER, not a Calendar creation flow.
  // Habits are managed on Today and in Settings.
  const wired = body(appCode, 'function calendarAddMenu(anchor, day = null)');
  for (const k of ['event:', 'reminder:', 'task:']) {
    assert.ok(wired.includes(k), `the Add menu has no ${k} handler`);
  }
  assert.ok(!wired.includes('habit:'), 'Habit creation returned to the Calendar Add menu');
});

/* ── Synthetic data boundary ─────────────────────────────────────────── */

test('data: everything created in this phase is flagged synthetic', () => {
  const seeds = calRoute.match(/isSynthetic: true/g) ?? [];
  assert.ok(seeds.length >= 5, 'synthetic rows are not consistently flagged');
  assert.match(calRoute, /async function clearSynthetic/, 'synthetic data cannot be removed');
  assert.match(calRoute, /eq\(calendars\.isSynthetic, true\)/,
    'the cleanup is not scoped to synthetic rows');
});

test('data: no Google code exists anywhere yet', () => {
  for (const [name, src] of [['route', calRoute], ['calendar.js', calendar],
    ['event-modal.js', eventModal]] as const) {
    assert.ok(!/googleapis\.com\/calendar\/v3|oauth2|access_token|client_secret/i.test(src),
      `${name} contains Google API code`);
  }
  assert.match(calRoute, /There is NO Google code here/,
    'the synthetic-only boundary is not recorded');
});

test('data: the seed covers the shapes that actually cause trouble', () => {
  for (const shape of ['isAllDay: true', 'recurrence:', 'hangoutLink', 'birthday',
    'isReadOnly: true', 'needsAction']) {
    assert.ok(calRoute.includes(shape), `the synthetic set has no ${shape} case`);
  }
  // An overdue reminder and an overlapping pair are the attention cases.
  assert.match(calRoute, /isoDay\(-3\)/, 'no overdue reminder in the synthetic set');
  assert.match(calRoute, /at\(2, 14, 30\)/, 'no overlapping events in the synthetic set');
});

/* ── D4.2: no orphaned floating UI ───────────────────────────────────── */

test('layout: every hidden-toggled element actually hides', () => {
  // An author `display:` rule beats the UA's `[hidden]{display:none}`, so any
  // element toggled via the hidden ATTRIBUTE and given a display value needs an
  // explicit `[hidden]` rule. Without it .hov rendered as an unlabelled 264px
  // bar floating over every Calendar mode, and the event editor's "More
  // options" was permanently expanded.
  const toggled = ['hov', 'ev-adv'];
  for (const cls of toggled) {
    const rule = new RegExp(`\\.${cls}\\{[^}]*display:`);
    if (!rule.test(html)) continue;         // no display set, UA rule applies
    assert.match(html, new RegExp(`\\.${cls}\\[hidden\\]\\{display:none\\}`),
      `.${cls} sets display but has no [hidden] rule — it can never hide`);
  }
});

test('layout: the hover shell starts hidden and empties on close', () => {
  const hov = read('hover-preview.js');
  assert.match(hov, /el\.hidden = true/, 'the preview shell starts visible');
  assert.match(hov, /el\.innerHTML = ''/, 'closing leaves stale content behind');
  assert.match(hov, /export function closeHoverPreview/, 'no way to force-close');
  // Repainting the canvas must close it, or it anchors to a removed node.
  assert.match(code(app), /closeHoverPreview\(\);/, 'a repaint can strand the preview');
});
