/**
 * Calendar — Month, Agenda and Plan.
 *
 * Three modes, because Calendar answers three questions and nothing else:
 *   Month  — what does my life look like?
 *   Agenda — what is coming next?
 *   Plan   — when am I actually going to do the work?
 *
 * Day, 3 Day and Week are deliberately absent. See
 * /docs/calendar-v2-product-model.md — a selected date still opens a focused
 * day panel, but that is a selection state, not a mode.
 *
 * ONE timeline with layers. Mode answers "how am I viewing time"; layers answer
 * "what is visible". The default must be understandable without ever touching
 * the layer control, so every layer starts on except the noisiest.
 *
 * All data in this phase is synthetic and flagged server-side. No Google
 * account is connected and no Google call is made.
 */
import { flip, pulse, reducedMotion, settle } from './motion.js';

const MODES = [
  { id: 'month', label: 'Month' },
  { id: 'agenda', label: 'Agenda' },
  { id: 'plan', label: 'Plan' },
];
const LAYERS = [
  { id: 'events', label: 'Events' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'habits', label: 'Habits' },
];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PLAN_START = 7;    // relevant hours only — an empty 24h grid was Day view
const PLAN_END = 21;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cal = {
  mode: 'month',
  anchor: new Date(),        // any date inside the shown period
  selected: null,            // 'YYYY-MM-DD'
  layers: { events: true, reminders: true, tasks: true, habits: true },
  data: null,
  loading: false,
  error: null,
};

/* ── Date helpers ─────────────────────────────────────────────────────── */
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  + `-${String(d.getDate()).padStart(2, '0')}`;
const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const sameDay = (a, b) => iso(a) === iso(b);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const hhmm = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Monday-first grid covering the whole month, always whole weeks. */
function monthGrid(anchor) {
  const first = startOfMonth(anchor);
  const lead = (first.getDay() + 6) % 7;          // Monday = 0
  const start = addDays(first, -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

function weekOf(anchor) {
  const lead = (anchor.getDay() + 6) % 7;
  const start = addDays(anchor, -lead);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The range the current mode needs, padded so edges are never empty. */
function currentRange() {
  if (cal.mode === 'month') {
    const g = monthGrid(cal.anchor);
    return { from: iso(g[0]), to: iso(g[41]) };
  }
  if (cal.mode === 'plan') {
    const w = weekOf(cal.anchor);
    return { from: iso(w[0]), to: iso(w[6]) };
  }
  return { from: iso(new Date()), to: iso(addDays(new Date(), 60)) };
}

/* ── Item model ────────────────────────────────────────────────────────
 * Events, reminders, deadlines and blocks stay DISTINCT — they are never
 * flattened into one "calendar item" type, because they behave differently and
 * must read differently. `itemsForDay` returns them grouped, not merged. */
function itemsForDay(dayIso) {
  const d = cal.data;
  if (!d) return { events: [], reminders: [], deadlines: [], blocks: [], habit: null };
  const inDay = (e) => {
    if (e.isAllDay) return e.startDate <= dayIso && (e.endDate ?? e.startDate) >= dayIso;
    return e.startsAt && iso(new Date(e.startsAt)) === dayIso;
  };
  return {
    events: cal.layers.events ? d.events.filter(inDay) : [],
    reminders: cal.layers.reminders ? d.reminders.filter((r) => r.dueDate === dayIso) : [],
    deadlines: cal.layers.tasks ? d.deadlines.filter((t) => t.dueDate === dayIso) : [],
    blocks: cal.layers.tasks
      ? d.blocks.filter((b) => iso(new Date(b.startsAt)) === dayIso) : [],
    habit: cal.layers.habits
      ? (d.habitDays.find((h) => h.entryDate === dayIso) ?? null) : null,
  };
}

/**
 * Workload for a day — four restrained states, never a heatmap.
 * Counts committed TIME, not item count: five 15-minute things is not a busy
 * day, and one all-day commitment is.
 */
function workload(dayIso) {
  const { events, blocks } = itemsForDay(dayIso);
  let minutes = 0;
  let allDay = false;
  for (const e of events) {
    if (e.isAllDay) { allDay = true; continue; }
    if (e.startsAt && e.endsAt) minutes += (new Date(e.endsAt) - new Date(e.startsAt)) / 60000;
  }
  for (const b of blocks) minutes += (new Date(b.endsAt) - new Date(b.startsAt)) / 60000;
  if (allDay && minutes === 0) return 'moderate';
  if (minutes === 0) return 'open';
  if (minutes < 150) return 'moderate';
  if (minutes < 330) return 'busy';
  return 'overloaded';
}

/** Overlapping timed events on a day — a genuine calendar conflict. */
function conflictsOn(dayIso) {
  const timed = itemsForDay(dayIso).events
    .filter((e) => !e.isAllDay && e.startsAt && e.endsAt)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  const out = [];
  for (let i = 1; i < timed.length; i++) {
    if (new Date(timed[i].startsAt) < new Date(timed[i - 1].endsAt)) {
      out.push([timed[i - 1], timed[i]]);
    }
  }
  return out;
}

/* ── Header ───────────────────────────────────────────────────────────── */
function periodLabel() {
  if (cal.mode === 'month') {
    return cal.anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  if (cal.mode === 'plan') {
    const w = weekOf(cal.anchor);
    const a = w[0].toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const b = w[6].toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `${a} – ${b}`;
  }
  return 'Next 60 days';
}

export function calendarHeaderHtml() {
  return `<div class="cal-head">
    <div class="cal-head-main">
      <h1>Calendar</h1>
      <div class="cal-period">
        <button class="cal-nav" data-cal="prev" aria-label="Previous period">‹</button>
        <span class="cal-period-label" id="cal-period">${esc(periodLabel())}</span>
        <button class="cal-nav" data-cal="next" aria-label="Next period">›</button>
        <button class="btn btn-ghost cal-today" data-cal="today">Today</button>
      </div>
    </div>
    <div class="cal-head-side">
      <div class="seg cal-modes" role="tablist" aria-label="Calendar mode">
        ${MODES.map((m) => `<button role="tab" data-mode="${m.id}"
          aria-selected="${cal.mode === m.id}">${m.label}</button>`).join('')}
      </div>
      <button class="btn btn-primary cal-add" id="cal-add" aria-haspopup="menu">+ Add</button>
    </div>
    <div class="cal-layers" role="group" aria-label="Visible layers">
      ${LAYERS.map((l) => `<button class="cal-layer ${cal.layers[l.id] ? 'is-on' : ''}"
        data-layer="${l.id}" aria-pressed="${cal.layers[l.id]}">
        <span class="cl-dot cl-${l.id}"></span>${l.label}</button>`).join('')}
    </div>
  </div>`;
}

/* ── Month ────────────────────────────────────────────────────────────── */
function monthHtml() {
  const grid = monthGrid(cal.anchor);
  const month = cal.anchor.getMonth();
  const todayIso = iso(new Date());
  return `<div class="cal-month" role="grid" aria-label="Month">
    <div class="cm-dow">${DOW.map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="cm-grid">
      ${grid.map((d) => monthCellHtml(d, month, todayIso)).join('')}
    </div>
  </div>`;
}

/**
 * One day cell.
 *
 * Content is PRIORITISED, not crammed: important events first, then deadlines,
 * then reminders, then a count of whatever did not fit. A truncated fragment of
 * a title is worse than an honest "+3 more".
 */
function monthCellHtml(d, month, todayIso) {
  const day = iso(d);
  const { events, reminders, deadlines, blocks, habit } = itemsForDay(day);
  const outside = d.getMonth() !== month;
  const load = workload(day);
  const hasConflict = conflictsOn(day).length > 0;
  const overdueRem = reminders.some((r) => r.status === 'open' && r.dueDate < todayIso);

  // Timed events read best in time order; all-day ones sit above them.
  const ordered = [...events].sort((a, b) => {
    if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
    return new Date(a.startsAt ?? 0) - new Date(b.startsAt ?? 0);
  });
  const SHOWN = 3;
  const shown = ordered.slice(0, SHOWN);
  const extra = (ordered.length - shown.length) + deadlines.length + reminders.length;

  return `<div class="cm-cell ${outside ? 'is-outside' : ''} ${day === todayIso ? 'is-today' : ''}
      ${cal.selected === day ? 'is-selected' : ''} load-${load}"
      role="gridcell" tabindex="0" data-day="${day}"
      aria-label="${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}, ${ordered.length} events${hasConflict ? ', has a clash' : ''}">
    <div class="cm-num">
      <span>${d.getDate()}</span>
      ${hasConflict ? '<span class="cm-flag" title="Overlapping events">!</span>' : ''}
      ${overdueRem ? '<span class="cm-flag is-warn" title="Overdue reminder">•</span>' : ''}
    </div>
    <div class="cm-items">
      ${shown.map((e) => `<span class="cm-ev ${e.isAllDay ? 'is-allday' : ''}"
        data-event="${e.id}" title="${esc(e.title)}">
        <i class="cm-src" style="background:${esc(e.calendarColor || 'var(--accent)')}"></i>
        ${e.isAllDay ? '' : `<b>${esc(hhmm(new Date(e.startsAt)))}</b>`}
        <span class="cm-ev-t">${esc(e.title)}</span></span>`).join('')}
      ${deadlines.slice(0, 1).map((t) => `<span class="cm-due" title="Due: ${esc(t.title)}">
        <i></i>${esc(t.title)}</span>`).join('')}
      ${extra > 0 ? `<span class="cm-more">+${extra} more</span>` : ''}
    </div>
    <div class="cm-foot">
      ${blocks.length ? `<span class="cm-chip cm-plan" title="${blocks.length} planned work block(s)">${blocks.length}◱</span>` : ''}
      ${habit && habit.done ? `<span class="cm-chip cm-habit" title="${habit.done} habits completed">${habit.done}</span>` : ''}
    </div>
  </div>`;
}

/* ── Agenda ───────────────────────────────────────────────────────────── */
/** Chronology is primary. Categories are filters, never the structure. */
function agendaHtml() {
  const d = cal.data;
  if (!d) return '';
  const today = new Date();
  const rows = [];

  for (let i = 0; i <= 60; i++) {
    const day = iso(addDays(today, i));
    const { events, reminders, deadlines, blocks } = itemsForDay(day);
    if (!events.length && !reminders.length && !deadlines.length && !blocks.length) continue;
    rows.push({ day, date: addDays(today, i), events, reminders, deadlines, blocks });
  }
  if (!rows.length) {
    return '<div class="state"><b>Nothing scheduled</b>Once events, reminders and '
      + 'planned work exist, they appear here in the order they happen.</div>';
  }

  // Group headings, chosen so the near future reads naturally.
  const groupFor = (date) => {
    const days = Math.round((parseIso(iso(date)) - parseIso(iso(today))) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days < 7) return 'This week';
    if (date.getMonth() === today.getMonth()) return 'Later this month';
    return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  };

  let last = null;
  const out = [];
  for (const r of rows) {
    const g = groupFor(r.date);
    if (g !== last) { out.push(`<h2 class="ag-group">${esc(g)}</h2>`); last = g; }
    out.push(agendaDayHtml(r));
  }
  return `<div class="cal-agenda">${out.join('')}</div>`;
}

function agendaDayHtml(r) {
  const items = [
    ...r.events.map((e) => ({ kind: 'event', at: e.isAllDay ? null : new Date(e.startsAt), e })),
    ...r.blocks.map((b) => ({ kind: 'block', at: new Date(b.startsAt), b })),
    ...r.reminders.map((x) => ({ kind: 'reminder', at: null, r: x })),
    ...r.deadlines.map((t) => ({ kind: 'deadline', at: null, t })),
  ].sort((a, b) => (a.at ? a.at.getTime() : -1) - (b.at ? b.at.getTime() : -1));

  return `<div class="ag-day" data-day="${r.day}">
    <div class="ag-date">
      <span class="ag-dow">${r.date.toLocaleDateString(undefined, { weekday: 'short' })}</span>
      <span class="ag-num">${r.date.getDate()}</span>
    </div>
    <div class="ag-items">${items.map(agendaItemHtml).join('')}</div>
  </div>`;
}

/** Each type gets its own visual language — never all rendered as event bars. */
function agendaItemHtml(it) {
  if (it.kind === 'event') {
    const e = it.e;
    return `<button class="ag-item ag-event" data-event="${e.id}">
      <i class="ag-src" style="background:${esc(e.calendarColor || 'var(--accent)')}"></i>
      <span class="ag-time">${e.isAllDay ? 'All day' : esc(hhmm(new Date(e.startsAt)))}</span>
      <span class="ag-title">${esc(e.title)}</span>
      <span class="ag-meta">
        ${e.location ? `<span>${esc(e.location)}</span>` : ''}
        ${e.recurrence ? '<span title="Repeats">↻</span>' : ''}
        ${e.attendees?.length ? `<span title="${e.attendees.length} guests">${e.attendees.length}👤</span>` : ''}
        ${e.hangoutLink ? '<span class="ag-meet">Meet</span>' : ''}
        ${e.isReadOnly ? '<span class="ag-ro" title="Read-only calendar">🔒</span>' : ''}
      </span></button>`;
  }
  if (it.kind === 'reminder') {
    const r = it.r;
    const overdue = r.status === 'open' && r.dueDate < iso(new Date());
    return `<div class="ag-item ag-reminder ${r.status === 'done' ? 'is-done' : ''} ${overdue ? 'is-overdue' : ''}">
      <button class="ag-check" data-reminder="${r.id}"
        aria-pressed="${r.status === 'done'}" aria-label="Complete ${esc(r.title)}"></button>
      <span class="ag-time">${r.dueTime ? esc(r.dueTime) : 'Reminder'}</span>
      <span class="ag-title">${esc(r.title)}</span>
      ${overdue ? '<span class="ag-badge is-warn">Overdue</span>' : ''}</div>`;
  }
  if (it.kind === 'deadline') {
    return `<div class="ag-item ag-deadline">
      <i class="ag-flag"></i><span class="ag-time">Due</span>
      <span class="ag-title">${esc(it.t.title)}</span>
      <span class="ag-badge">deadline</span></div>`;
  }
  const b = it.b;
  return `<div class="ag-item ag-block">
    <i class="ag-plan"></i>
    <span class="ag-time">${esc(hhmm(new Date(b.startsAt)))}</span>
    <span class="ag-title">${esc(b.title)}</span>
    <span class="ag-badge">planned work</span></div>`;
}

/* ── Plan ─────────────────────────────────────────────────────────────── */
/** Working hours only by default. An empty 24-hour grid was Day view. */
function planHtml() {
  const week = weekOf(cal.anchor);
  const todayIso = iso(new Date());
  const hours = Array.from({ length: PLAN_END - PLAN_START }, (_, i) => PLAN_START + i);
  return `<div class="cal-plan">
    <div class="pl-grid" style="--pl-hours:${hours.length}">
      <div class="pl-axis">
        ${hours.map((h) => `<span class="pl-hour">${String(h).padStart(2, '0')}:00</span>`).join('')}
      </div>
      ${week.map((d) => planDayHtml(d, todayIso, hours)).join('')}
    </div>
  </div>`;
}

function planDayHtml(d, todayIso, hours) {
  const day = iso(d);
  const { events, blocks } = itemsForDay(day);
  const top = (dt) => {
    const t = new Date(dt);
    return ((t.getHours() + t.getMinutes() / 60) - PLAN_START) / hours.length * 100;
  };
  const height = (a, b) => (new Date(b) - new Date(a)) / 3600000 / hours.length * 100;
  const timed = events.filter((e) => !e.isAllDay && e.startsAt);
  const allDay = events.filter((e) => e.isAllDay);

  return `<div class="pl-day ${day === todayIso ? 'is-today' : ''}" data-day="${day}">
    <div class="pl-day-head">
      <span class="pl-dow">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
      <span class="pl-num">${d.getDate()}</span>
    </div>
    ${allDay.length ? `<div class="pl-allday">${allDay.map((e) =>
      `<span class="pl-ad" data-event="${e.id}">${esc(e.title)}</span>`).join('')}</div>` : ''}
    <div class="pl-canvas" data-drop-day="${day}">
      ${hours.map(() => '<span class="pl-line"></span>').join('')}
      ${timed.map((e) => `<div class="pl-ev" data-event="${e.id}"
        style="top:${top(e.startsAt).toFixed(2)}%;height:${Math.max(3, height(e.startsAt, e.endsAt)).toFixed(2)}%;
          --src:${esc(e.calendarColor || 'var(--accent)')}">
        <b>${esc(hhmm(new Date(e.startsAt)))}</b> ${esc(e.title)}</div>`).join('')}
      ${blocks.map((b) => {
        const st = new Date(b.startsAt); const en = new Date(b.endsAt);
        const sm = st.getHours() * 60 + st.getMinutes();
        const em = en.getHours() * 60 + en.getMinutes();
        return `<div class="pl-block" data-block="${b.id}" data-task="${b.taskId}"
          data-start-min="${sm}" data-end-min="${em}"
          style="top:${top(b.startsAt).toFixed(2)}%;height:${Math.max(3, height(b.startsAt, b.endsAt)).toFixed(2)}%">
          <b>${esc(hhmm(st))}</b> ${esc(b.title)}
          <span class="pl-tag">planned</span>
          <span class="pl-resize" aria-hidden="true"></span></div>`;
      }).join('')}
    </div>
  </div>`;
}

/* ── Rail, per mode ────────────────────────────────────────────────────
 * The rail changes with the mode and shows nothing when it has nothing
 * useful. Daily Habits deliberately do NOT appear here — they are strongest on
 * Today, and repeating them in every Calendar mode devalues both surfaces. */
export function calendarRailHtml() {
  if (cal.mode === 'month') return monthRailHtml();
  if (cal.mode === 'plan') return planRailHtml();
  return agendaRailHtml();
}

function monthRailHtml() {
  const d = cal.data;
  if (!d) return '';
  const grid = monthGrid(cal.anchor);
  const inMonth = grid.filter((x) => x.getMonth() === cal.anchor.getMonth()).map(iso);
  const clashes = inMonth.flatMap((day) => conflictsOn(day).map((c) => ({ day, c })));
  const todayIso = iso(new Date());
  const overdue = d.reminders.filter((r) => r.status === 'open' && r.dueDate < todayIso);
  const birthdays = d.events.filter((e) => e.eventType === 'birthday'
    && inMonth.includes(e.startDate));
  const noPlan = d.deadlines.filter((t) => inMonth.includes(t.dueDate)
    && !d.blocks.some((b) => b.taskId === t.id));

  const sel = cal.selected ? selectedRailHtml() : '';
  const attention = clashes.length || overdue.length || noPlan.length;

  return `${sel}
    ${attention ? `<div class="rail-card">
      <h3>Needs attention</h3>
      <div class="rl-list">
        ${clashes.slice(0, 3).map(({ day, c }) => `<button class="rl-row is-warn" data-day="${day}">
          <span class="rl-t">${esc(c[0].title)} clashes with ${esc(c[1].title)}</span>
          <span class="rl-s">${esc(parseIso(day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</span>
        </button>`).join('')}
        ${overdue.slice(0, 3).map((r) => `<div class="rl-row is-warn">
          <span class="rl-t">${esc(r.title)}</span><span class="rl-s">overdue</span></div>`).join('')}
        ${noPlan.slice(0, 3).map((t) => `<div class="rl-row">
          <span class="rl-t">${esc(t.title)}</span>
          <span class="rl-s">due, no planned work</span></div>`).join('')}
      </div></div>` : ''}
    ${birthdays.length ? `<div class="rail-card"><h3>This month</h3>
      <div class="rl-list">${birthdays.map((b) => `<div class="rl-row">
        <span class="rl-t">${esc(b.title)}</span>
        <span class="rl-s">${esc(parseIso(b.startDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</span>
      </div>`).join('')}</div></div>` : ''}`;
}

function selectedRailHtml() {
  const day = cal.selected;
  const { events, reminders, deadlines, blocks, habit } = itemsForDay(day);
  const d = parseIso(day);
  return `<div class="rail-card cal-sel">
    <h3>${esc(d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}</h3>
    <div class="cs-load">Workload: <b>${workload(day)}</b></div>
    ${events.length ? `<div class="cs-sec"><span class="cs-lab">Events</span>
      ${events.map((e) => `<button class="cs-row" data-event="${e.id}">
        <i style="background:${esc(e.calendarColor || 'var(--accent)')}"></i>
        <span>${e.isAllDay ? 'All day' : esc(hhmm(new Date(e.startsAt)))}</span>
        <b>${esc(e.title)}</b></button>`).join('')}</div>` : ''}
    ${blocks.length ? `<div class="cs-sec"><span class="cs-lab">Planned work</span>
      ${blocks.map((b) => `<div class="cs-row"><i class="cs-plan"></i>
        <span>${esc(hhmm(new Date(b.startsAt)))}</span><b>${esc(b.title)}</b></div>`).join('')}</div>` : ''}
    ${reminders.length ? `<div class="cs-sec"><span class="cs-lab">Reminders</span>
      ${reminders.map((r) => `<div class="cs-row"><i class="cs-rem"></i>
        <span>${r.dueTime ? esc(r.dueTime) : '—'}</span><b>${esc(r.title)}</b></div>`).join('')}</div>` : ''}
    ${deadlines.length ? `<div class="cs-sec"><span class="cs-lab">Deadlines</span>
      ${deadlines.map((t) => `<div class="cs-row"><i class="cs-due"></i>
        <span>due</span><b>${esc(t.title)}</b></div>`).join('')}</div>` : ''}
    ${habit?.done ? `<div class="cs-sec"><span class="cs-lab">Habits</span>
      <div class="cs-row"><i class="cs-hab"></i><b>${habit.done} completed</b></div></div>` : ''}
    ${!events.length && !reminders.length && !deadlines.length && !blocks.length
      ? '<p class="rail-quiet">Nothing planned. A clear day.</p>' : ''}
    <button class="btn btn-primary cs-add" data-cal-add-day="${day}">Add to this day</button>
  </div>`;
}

function agendaRailHtml() {
  const d = cal.data;
  if (!d) return '';
  return `<div class="rail-card"><h3>Sources</h3>
    <div class="rl-list">${(d.calendars ?? []).map((c) => `<div class="rl-row">
      <i class="rl-dot" style="background:${esc(c.color || 'var(--accent)')}"></i>
      <span class="rl-t">${esc(c.name)}</span>
      <span class="rl-s">${c.isReadOnly ? 'read-only' : 'editable'}</span></div>`).join('')}</div>
    <p class="rail-quiet cal-note">Synthetic data. No Google account is connected.</p>
  </div>`;
}

function planRailHtml() {
  const d = cal.data;
  if (!d) return '';
  const week = weekOf(cal.anchor).map(iso);
  const scheduled = new Set(d.blocks.map((b) => b.taskId));
  const queue = (d.unscheduled ?? []).filter((t) => !scheduled.has(t.id));
  const dueSoon = d.deadlines.filter((t) => !scheduled.has(t.id));
  const openHours = week.reduce((n, day) => n + (workload(day) === 'open' ? 1 : 0), 0);

  return `<div class="rail-card"><h3>Planning queue</h3>
      ${dueSoon.length ? `<div class="cs-sec"><span class="cs-lab">Due soon, not planned</span>
        ${dueSoon.slice(0, 5).map((t) => `<div class="pq-item pri-${t.priority}" draggable="false"
          data-queue-task="${t.id}"><b>${esc(t.title)}</b>
          <span>due ${esc(parseIso(t.dueDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</span>
        </div>`).join('')}</div>` : ''}
      ${queue.length ? `<div class="cs-sec"><span class="cs-lab">Unscheduled</span>
        ${queue.slice(0, 8).map((t) => `<div class="pq-item pri-${t.priority}"
          data-queue-task="${t.id}"><b>${esc(t.title)}</b></div>`).join('')}</div>`
        : '<p class="rail-quiet">Nothing waiting to be scheduled.</p>'}
    </div>
    <div class="rail-card"><h3>This week</h3>
      <div class="rl-list">
        <div class="rl-row"><span class="rl-t">Clear days</span><span class="rl-s">${openHours}</span></div>
        <div class="rl-row"><span class="rl-t">Planned blocks</span><span class="rl-s">${d.blocks.length}</span></div>
      </div>
    </div>`;
}

/* ── Body ─────────────────────────────────────────────────────────────── */
export function calendarBodyHtml() {
  if (cal.loading) return '<div class="state"><b>Loading your calendar…</b></div>';
  if (cal.error) {
    return `<div class="state"><b>Could not load the calendar</b>${esc(cal.error)}
      <button class="btn" id="cal-retry">Try again</button></div>`;
  }
  if (cal.mode === 'month') return monthHtml();
  if (cal.mode === 'plan') return planHtml();
  return agendaHtml();
}

export const planHours = () => ({ start: PLAN_START, end: PLAN_END });

export { cal, currentRange, itemsForDay, workload, conflictsOn, monthGrid, weekOf, iso, parseIso };
