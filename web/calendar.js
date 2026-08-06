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
import { utilityTriggerHtml } from './utility-menu.js';

const MODES = [
  { id: 'month', label: 'Month' },
  { id: 'agenda', label: 'Agenda' },
  { id: 'plan', label: 'Plan week' },
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
  /*
   * TWO independent concepts, because collapsing them into one is what caused
   * the contradictory state:
   *
   *   mode    — how you are viewing TIME: month | agenda | plan
   *   utility — a management surface layered beside Calendar, not over it:
   *             none | reminders
   *
   * When `utility` is anything but 'none', the time-view controls are not
   * merely hidden — they are not rendered at all, so there is nothing to click
   * that could mutate calendar state behind the utility.
   */
  utility: 'none',
  reminderFilter: 'active',
  reminders: null,
  // Snapshot taken on entering a utility, restored on leaving, so returning
  // lands on exactly the month you left rather than flashing through Month.
  resume: null,
  /*
   * The selected day's habits, loaded on demand.
   *
   *   { date, habits: [...] } | { date, loading: true } | { date, error }
   *
   * Keyed by date rather than held as a bare list, so a slow response for the
   * 3rd cannot paint itself into a card that is now showing the 4th.
   */
  dayHabits: null,
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
    // { date, due, done } — `due` is what was asked of you that day, not the
    // total number of habits you have.
    habit: cal.layers.habits
      ? (d.habitDays?.find((h) => h.date === dayIso) ?? null) : null,
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
  // Only two marked states, both meaning "look at this day". Everything else
  // is unmarked. A four-colour ramp asked the user to decode a legend just to
  // read an ordinary week, and used purple — which means selection everywhere
  // else in Life OS — for "moderately busy".
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

/**
 * Calendar header.
 *
 * The mode control and + Add are one visual system: same height, same radius,
 * same baseline. They were previously unrelated shapes sitting next to each
 * other — a segmented control beside an oversized purple block.
 *
 * They stay SEPARATE controls though. Switching how you look at time and
 * creating something new are different acts, and merging them would make the
 * mode control feel like a menu.
 */
/**
 * The Calendar header, or the utility's own header.
 *
 * A utility gets an entirely different header rather than a filtered version
 * of this one. Hiding controls individually left the period label, the layer
 * chips and the mode pill all still in the DOM and still wired — which is how
 * pressing Today while managing reminders silently changed the month behind
 * the workspace.
 */
export function calendarHeaderHtml() {
  if (cal.utility === 'reminders') return remindersHeaderHtml();
  const active = MODES.findIndex((m) => m.id === cal.mode);
  return `<div class="cal-head">
    <div class="cal-head-row">
      <div class="cal-head-main">
        <h1>Calendar</h1>
        <div class="cal-period">
          <button class="cal-nav" data-cal="prev" aria-label="Previous period">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5-5 5 5 5"/></svg></button>
          <span class="cal-period-label" id="cal-period">${esc(periodLabel())}</span>
          <button class="cal-nav" data-cal="next" aria-label="Next period">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg></button>
          <button class="cal-today" data-cal="today">Today</button>
        </div>
      </div>

      <div class="cal-head-mid">
        <div class="cal-modes" role="tablist" aria-label="Calendar mode"
          style="--mode-i:${active};--mode-n:${MODES.length}">
          <span class="cal-mode-pill" aria-hidden="true"></span>
          ${MODES.map((m) => `<button role="tab" data-mode="${m.id}"
            aria-selected="${cal.mode === m.id}"
            tabindex="${cal.mode === m.id ? 0 : -1}">${m.label}</button>`).join('')}
        </div>
      </div>

      <!-- §4 Add first, then the overflow. The three-dot control sits at the
           extreme upper-right of the page on Today, so it sits there here too —
           same class, same geometry, same states. Wedged between the mode
           selector and Add it read as a third kind of thing. -->
      <div class="cal-head-side">
        <button class="cal-add" id="cal-add" aria-haspopup="menu" aria-expanded="false">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg>
          <span>Add</span>
        </button>
        ${utilityTriggerHtml('cal-util', 'Calendar options')}
      </div>
    </div>

    <div class="cal-head-row cal-head-sub">
      <div class="cal-layers" role="group" aria-label="Visible layers">
        ${LAYERS.map((l) => `<button class="cal-layer ${cal.layers[l.id] ? 'is-on' : ''}"
          data-layer="${l.id}" aria-pressed="${cal.layers[l.id]}">
          <span class="cl-dot cl-${l.id}"></span>${l.label}</button>`).join('')}
      </div>

    </div>
  </div>`;
}

/**
 * The legend.
 *
 * Locked product rule: nothing persistent in Life OS should make you stop and
 * wonder what it means. Anything repeated across the interface must be
 * self-explanatory or explained somewhere unobtrusive and findable. This is
 * that somewhere — one compact popover, not a permanent sidebar.
 */
export function legendHtml() {
  return `<div class="legend">
    <h4>What you are looking at</h4>
    <div class="lg-group"><span class="lg-lab">On a day</span>
      <div class="lg-row"><i class="lg-src"></i>
        <span>A coloured edge on an event is the calendar it came from</span></div>
      <div class="lg-row"><i class="lg-due"></i><span>A task deadline</span></div>
      <div class="lg-row"><i class="lg-rem"></i><span>A reminder</span></div>
      <div class="lg-row"><i class="lg-plan"></i><span>Work you have planned time for</span></div>
      <div class="lg-row"><i class="lg-clash"></i><span>Two events overlap</span></div>
    </div>
    <div class="lg-group"><span class="lg-lab">How full a day is</span>
      <div class="lg-row"><i class="lg-load load-busy"></i>
        <span><b>Busy</b> — more than 2½ hours committed</span></div>
      <div class="lg-row"><i class="lg-load load-overloaded"></i>
        <span><b>Heavily booked</b> — more than 5½ hours committed</span></div>
      <div class="lg-row"><i class="lg-load"></i>
        <span>No mark means the day has room</span></div>
    </div>
    <p class="lg-note">Purple always means selected or interactive — never how
      busy a day is.</p>
  </div>`;
}

/**
 * The Reminders workspace header.
 *
 * No period, no Today, no mode pill, no layer chips — not hidden, absent. You
 * are managing rules, not browsing a month, and the header says so.
 */
function remindersHeaderHtml() {
  return `<div class="cal-head rv-head-wrap">
    <div class="cal-head-row rv-head-row">
      <div class="rv-head-left">
        <button class="rv-back" id="rv-back">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5-5 5 5 5"/></svg>
          <span>Calendar</span>
        </button>
        <h1>Reminders</h1>
      </div>
      <div class="rv-head-right">
        <button class="rv-new-btn" id="rv-new">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg>
          <span>New reminder</span>
        </button>
      </div>
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
  const openRem = reminders.filter((r) => r.status !== 'done');
  const overdueRem = openRem.some((r) => r.dueDate < todayIso);

  /*
   * Cell content is filled by PRIORITY, not by type quota: events first, then
   * deadlines, then reminders, and whatever does not fit becomes "+N more".
   * A day with one event and three reminders should show the reminders rather
   * than two empty slots and a count.
   */
  const ordered = [...events].sort((a, b) => {
    if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
    return new Date(a.startsAt ?? 0) - new Date(b.startsAt ?? 0);
  });
  const SHOWN = 3;
  const shownEv = ordered.slice(0, SHOWN);
  const shownDue = deadlines.slice(0, Math.max(0, SHOWN - shownEv.length));
  const shownRem = openRem.slice(0, Math.max(0, SHOWN - shownEv.length - shownDue.length));
  const extra = (ordered.length - shownEv.length)
    + (deadlines.length - shownDue.length)
    + (openRem.length - shownRem.length);

  return `<div class="cm-cell ${outside ? 'is-outside' : ''} ${day === todayIso ? 'is-today' : ''}
      ${cal.selected === day ? 'is-selected' : ''} load-${load}"
      role="gridcell" tabindex="0" data-day="${day}"
      aria-label="${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}, ${describeDay(day)}">
    <div class="cm-num">
      <span class="cm-date">${d.getDate()}</span>
      ${hasConflict ? `<span class="cm-flag" title="Overlapping events"
        aria-label="${conflictsOn(day).length} conflict${conflictsOn(day).length > 1 ? 's' : ''}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 6v5M10 14v.1"/></svg>
        ${conflictsOn(day).length > 1 ? conflictsOn(day).length : ''}</span>` : ''}
      ${overdueRem ? '<span class="cm-flag is-warn" aria-label="Overdue reminder">!</span>' : ''}
    </div>
    <div class="cm-items">
      ${shownEv.map((e) => `<span class="cm-ev ${e.isAllDay ? 'is-allday' : ''}"
        data-event="${e.id}" data-hover="event">
        <i class="cm-src" style="background:${esc(e.calendarColor || 'var(--accent)')}"></i>
        ${e.isAllDay ? '' : `<b>${esc(shortTime(new Date(e.startsAt)))}</b>`}
        <span class="cm-ev-t">${esc(e.title)}</span></span>`).join('')}
      ${shownDue.map((t) => `<span class="cm-due" data-hover="due">
        <i></i><span class="cm-ev-t">${esc(t.title)}</span></span>`).join('')}
      ${shownRem.map((r) => reminderChipHtml(r, todayIso)).join('')}
      ${extra > 0 ? `<span class="cm-more">+${extra} more</span>` : ''}
    </div>
    <div class="cm-foot">
      ${blocks.length ? `<span class="cm-chip cm-plan"
        aria-label="${blocks.length} planned work block${blocks.length > 1 ? 's' : ''}">${blocks.length}</span>` : ''}
      ${habitSummaryHtml(habit, day, todayIso)}
    </div>
  </div>`;
}

/**
 * `3/5 habits` in a Month cell.
 *
 * A SUMMARY, never a list. Habits repeat daily by definition, so listing them
 * per cell would fill every square in the month with the same five names and
 * bury the things that actually differ between days.
 *
 * Nothing is drawn when nothing was due — an empty square is the honest answer
 * for a day that asked nothing of you, and "0/0 habits" is not.
 *
 * Future days are also blank. A day that has not happened has not been missed,
 * and drawing "0/5" across the rest of the month turns a history into a wall of
 * failure for days nobody could have completed yet.
 */
function habitSummaryHtml(habit, day, todayIso) {
  if (!habit || !habit.due || day > todayIso) return '';
  const all = habit.done >= habit.due;
  return `<span class="cm-chip cm-habit ${all ? 'is-all' : ''} ${habit.done ? '' : 'is-none'}"
    aria-label="${habit.done} of ${habit.due} habits done">${habit.done}/${habit.due}</span>`;
}

/**
 * A reminder in a Month cell.
 *
 * Dotted, never solid: a reminder asks for attention on a date, it does not
 * occupy the day the way an event does, and the border carries that difference
 * without needing a legend. Quieter than an event, louder than nothing.
 */
function reminderChipHtml(r, todayIso) {
  const overdue = r.status !== 'done' && r.dueDate < todayIso;
  return `<button class="cm-rem-row ${overdue ? 'is-overdue' : ''}"
    data-reminder="${r.id}" data-hover="reminder"
    aria-label="Reminder: ${esc(r.title)}${overdue ? ', overdue' : ''}">
    <i class="cm-rem-dot" aria-hidden="true"></i>
    ${r.dueTime ? `<b>${esc(r.dueTime)}</b>` : ''}
    <span class="cm-ev-t">${esc(r.title)}</span>
    ${r.recurrence ? '<i class="cm-rem-rep" aria-hidden="true" title="Repeats">\u21bb</i>' : ''}
  </button>`;
}

/** Human wording for a stored recurrence rule. */
export function recurrenceWords(rule) {
  if (!rule) return null;
  const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const every = rule.interval > 1 ? `every ${rule.interval} ` : 'every ';
  if (rule.frequency === 'DAILY') return `${every}day`.replace('every 1 ', 'every ');
  if (rule.frequency === 'WEEKLY') {
    const d = rule.byWeekday?.length ? ` on ${rule.byWeekday.map((n) => DAY[n]).join(', ')}` : '';
    return `${every}week${d}`;
  }
  if (rule.frequency === 'MONTHLY') {
    const d = rule.byMonthDay?.length ? ` on day ${rule.byMonthDay.join(', ')}` : '';
    return `${every}month${d}`;
  }
  return `${every}year`;
}

/** Screen-reader summary — the same facts the hover preview shows visually. */
function describeDay(day) {
  const { events, reminders, deadlines, blocks } = itemsForDay(day);
  const bits = [];
  if (events.length) bits.push(`${events.length} event${events.length > 1 ? 's' : ''}`);
  if (deadlines.length) bits.push(`${deadlines.length} deadline${deadlines.length > 1 ? 's' : ''}`);
  if (reminders.length) bits.push(`${reminders.length} reminder${reminders.length > 1 ? 's' : ''}`);
  if (blocks.length) bits.push(`${blocks.length} planned block${blocks.length > 1 ? 's' : ''}`);
  if (conflictsOn(day).length) bits.push('has a clash');
  return bits.length ? bits.join(', ') : 'nothing scheduled';
}

/** 09:00 rather than 09:00 AM — month cells have no room for a meridiem. */
function shortTime(d) {
  const h = d.getHours(); const m = d.getMinutes();
  return m ? `${h}:${String(m).padStart(2, '0')}` : `${h}`;
}

/* ── Hover preview content ────────────────────────────────────────────
 * Same facts on hover and on focus. Compact by design: this is a glance, not
 * the selected-day rail. */
export const hoverRender = {
  day(dayIso) {
    const { events, reminders, deadlines, blocks } = itemsForDay(dayIso);
    if (!events.length && !reminders.length && !deadlines.length && !blocks.length) return null;
    const d = parseIso(dayIso);
    const timed = events.filter((e) => !e.isAllDay && e.startsAt)
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
    const next = timed[0] ?? events[0];
    const clash = conflictsOn(dayIso).length;
    return `<div class="hov-head">
        <b>${esc(d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}</b>
        <span class="hov-load load-${workload(dayIso)}">${workload(dayIso)}</span>
      </div>
      ${next ? `<div class="hov-next">
        <i style="background:${esc(next.calendarColor || 'var(--accent)')}"></i>
        <span>${next.isAllDay ? 'All day' : esc(hhmm(new Date(next.startsAt)))}</span>
        <b>${esc(next.title)}</b></div>` : ''}
      <div class="hov-counts">
        ${events.length > 1 ? `<span>${events.length - 1} more event${events.length > 2 ? 's' : ''}</span>` : ''}
        ${deadlines.length ? `<span class="is-due">${deadlines.length} deadline${deadlines.length > 1 ? 's' : ''}</span>` : ''}
        ${reminders.length ? `<span class="is-rem">${reminders.length} reminder${reminders.length > 1 ? 's' : ''}</span>` : ''}
        ${blocks.length ? `<span class="is-plan">${blocks.length} planned</span>` : ''}
        ${clash ? `<span class="is-clash">${clash} clash${clash > 1 ? 'es' : ''}</span>` : ''}
      </div>`;
  },

  reminder(id) {
    const r = (cal.data?.reminders ?? []).find((x) => x.id === id);
    if (!r) return null;
    const overdue = r.status !== 'done' && r.dueDate < iso(new Date());
    const words = recurrenceWords(r.recurrence);
    return `<div class="hov-head"><b>${esc(r.title)}</b></div>
      <div class="hov-when">${esc(prettyShort(r.dueDate))}${r.dueTime ? ` · ${esc(r.dueTime)}` : ''}</div>
      <div class="hov-meta">
        <span>Reminder</span>
        ${words ? `<span>${esc(words)}</span>` : ''}
        ${r.leadDays ? `<span>${r.leadDays}d notice</span>` : ''}
        ${overdue ? '<span class="is-clash">Overdue</span>' : ''}
        ${r.status === 'done' ? '<span>Done</span>' : ''}
      </div>`;
  },

  event(id) {
    const e = cal.data?.events.find((x) => x.id === id);
    if (!e) return null;
    const when = e.isAllDay
      ? (e.endDate && e.endDate !== e.startDate
        ? `All day · ${esc(prettyShort(e.startDate))} – ${esc(prettyShort(e.endDate))}`
        : 'All day')
      : `${esc(hhmm(new Date(e.startsAt)))} – ${esc(hhmm(new Date(e.endsAt)))}`;
    const going = (e.attendees ?? []).filter((a) => a.responseStatus === 'accepted').length;
    return `<div class="hov-head"><b>${esc(e.title)}</b></div>
      <div class="hov-when">${when}</div>
      <div class="hov-meta">
        <span class="hov-cal"><i style="background:${esc(e.calendarColor || 'var(--accent)')}"></i>
          ${esc(e.calendarName ?? 'Calendar')}</span>
        ${e.location ? `<span>${esc(e.location)}</span>` : ''}
        ${e.recurrence ? '<span>Repeats</span>' : ''}
        ${e.attendees?.length ? `<span>${going}/${e.attendees.length} going</span>` : ''}
        ${e.hangoutLink ? '<span class="hov-meet">Google Meet</span>' : ''}
        ${e.isReadOnly ? '<span class="hov-ro">Read-only</span>' : ''}
      </div>`;
  },
};

const prettyShort = (s) => parseIso(s).toLocaleDateString(undefined,
  { day: 'numeric', month: 'short' });

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

/**
 * A date-only reminder in Plan week's attention strip.
 *
 * It sits ABOVE the time axis deliberately. A reminder with no time does not
 * occupy a slot, so putting it on the axis would make the day look busier than
 * it is and would eat a free window that is genuinely still free.
 */
function planReminderHtml(r, todayIso) {
  const overdue = r.dueDate < todayIso;
  return `<button class="pl-rem-ad ${overdue ? 'is-overdue' : ''}" data-reminder="${r.id}"
    aria-label="Reminder: ${esc(r.title)}${overdue ? ', overdue' : ''}">
    <i aria-hidden="true"></i><span>${esc(r.title)}</span></button>`;
}

/** Minutes-from-midnight as a percentage of the visible planning window. */
function pctOf(min, hours) {
  return ((min - hours[0] * 60) / (hours.length * 60)) * 100;
}

/** The current-time marker, or null when now is outside planning hours. */
function nowPct(hours) {
  const n = new Date();
  const mins = n.getHours() * 60 + n.getMinutes();
  const p = pctOf(mins, hours);
  return p >= 0 && p <= 100 ? p : null;
}

/**
 * One day column in Plan week.
 *
 * WEEKDAY EMPHASIS, decided against real data: seven equal columns at 1440px
 * gave each day about 110px, which is too narrow to read an event title. Work
 * is overwhelmingly planned Monday to Friday, so weekdays take the space and
 * weekends keep a narrower column. Nothing is hidden — a weekend with events
 * brightens back to full weight, because a hidden commitment is worse than a
 * cramped one.
 */
function planDayHtml(d, todayIso, hours) {
  const day = iso(d);
  const { events, blocks } = itemsForDay(day);
  const isWeekend = d.getDay() === 0 || d.getDay() === 6;
  const load = workload(day);

  const top = (dt) => {
    const t = new Date(dt);
    return ((t.getHours() + t.getMinutes() / 60) - hours[0]) / hours.length * 100;
  };
  const height = (a, b) => (new Date(b) - new Date(a)) / 3600000 / hours.length * 100;
  const timed = events.filter((e) => !e.isAllDay && e.startsAt);
  const allDay = events.filter((e) => e.isAllDay);
  const free = freeWindows(day);
  // Reminders share the day but not its capacity — see planReminderHtml.
  const dayReminders = itemsForDay(day).reminders.filter((r) => r.status !== 'done');

  return `<div class="pl-day ${day === todayIso ? 'is-today' : ''}
      ${isWeekend ? 'is-weekend' : ''} ${events.length || blocks.length ? 'has-events' : ''}"
      data-day="${day}">
    <div class="pl-day-head">
      <span class="pl-dow">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
      <span class="pl-num">${d.getDate()}</span>
      ${load === 'busy' || load === 'overloaded'
        ? `<span class="pl-load load-${load}">${load === 'busy' ? 'busy' : 'full'}</span>` : ''}
    </div>
    ${allDay.length || dayReminders.length ? `<div class="pl-allday">
      ${allDay.map((e) => `<span class="pl-ad" data-event="${e.id}">${esc(e.title)}</span>`).join('')}
      ${dayReminders.filter((r) => !r.dueTime).map((r) => planReminderHtml(r, todayIso)).join('')}
    </div>` : ''}
    <div class="pl-canvas" data-drop-day="${day}">
      ${hours.map(() => '<span class="pl-line"></span>').join('')}
      ${free.map(([a, b]) => `<div class="pl-free"
        style="top:${pctOf(a, hours).toFixed(2)}%;height:${(pctOf(b, hours) - pctOf(a, hours)).toFixed(2)}%"
        title="Free ${fmtMin(a)}–${fmtMin(b)}">
        <span class="pl-free-label">Free ${fmtMin(a)}–${fmtMin(b)}</span></div>`).join('')}
      ${day === todayIso && nowPct(hours) !== null
        ? `<div class="pl-now" style="top:${nowPct(hours).toFixed(2)}%" aria-label="Now"></div>` : ''}
      ${timed.map((e) => `<div class="pl-ev" data-event="${e.id}"
        style="top:${top(e.startsAt).toFixed(2)}%;height:${Math.max(3, height(e.startsAt, e.endsAt)).toFixed(2)}%;
          --src:${esc(e.calendarColor || 'var(--accent)')}">
        <b>${esc(hhmm(new Date(e.startsAt)))}</b> ${esc(e.title)}</div>`).join('')}
      ${dayReminders.filter((r) => r.dueTime).map((r) => {
        const [h, m] = r.dueTime.split(':').map(Number);
        return `<button class="pl-rem" data-reminder="${r.id}"
          style="top:${pctOf(h * 60 + m, hours).toFixed(2)}%"
          aria-label="Reminder at ${esc(r.dueTime)}: ${esc(r.title)}">
          <i></i><span>${esc(r.title)}</span></button>`;
      }).join('')}
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

const fmtMin = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/* ── Rail, per mode ────────────────────────────────────────────────────
 * The rail changes with the mode and shows nothing when it has nothing
 * useful. Daily Habits deliberately do NOT appear here — they are strongest on
 * Today, and repeating them in every Calendar mode devalues both surfaces. */
/**
 * The Calendar rail - ONE shell, three contexts.
 *
 * Calendar is a single section, so its rail keeps a stable structure and only
 * the middle band changes with the mode. Previously each mode built its own
 * rail from scratch, which made switching feel like moving between three
 * different applications.
 *
 *   A. Context    - the period or selected date, and the connection state
 *   B. Mode       - selected day / upcoming summary / planning queue
 *   C. Attention  - conflicts, overdue reminders, unplanned deadlines
 *
 * A and C are identical everywhere. Only B is replaced, and it crossfades.
 */
export function calendarRailHtml() {
  // §11 No Calendar rail inside a utility. Reusing Month's rail there was what
  // put a selected date and "Add to this day" beside a list of reminder rules.
  if (cal.utility !== 'none') return '';

  // §12 Contextual, not permanent. A rail kept for symmetry is empty space
  // with a border, and Month with nothing selected has nothing to say.
  if (cal.mode === 'month' && !cal.selected) return '';
  if (cal.mode === 'agenda') return '';

  return `<div class="rail-ctx" data-rail-ctx="${cal.mode}">${railModeHtml()}</div>
    ${railAttentionHtml()}`;
}

/** True when the rail should occupy space at all. */
export const railIsOpen = () => cal.utility === 'none'
  && ((cal.mode === 'month' && !!cal.selected) || cal.mode === 'plan');

/** B - the only part that changes with the mode. */
function railModeHtml() {
  if (cal.mode === 'month') return selectedRailHtml();
  if (cal.mode === 'plan') return planRailHtml();
  return agendaRailHtml();
}

/** C - always present; renders nothing when there is nothing wrong. */
function railAttentionHtml() {
  const d = cal.data;
  if (!d) return '';
  const todayIso = iso(new Date());
  const scope = cal.mode === 'plan' ? weekOf(cal.anchor).map(iso)
    : monthGrid(cal.anchor).filter((x) => x.getMonth() === cal.anchor.getMonth()).map(iso);

  const clashes = scope.flatMap((day) => conflictsOn(day).map((c) => ({ day, c })));
  const overdue = (d.reminders ?? []).filter((r) => r.status === 'open' && r.dueDate < todayIso);
  const unplanned = (d.deadlines ?? []).filter((t) => scope.includes(t.dueDate)
    && !(d.blocks ?? []).some((b) => b.taskId === t.id));
  const syncError = d.connection?.status === 'error';

  if (!clashes.length && !overdue.length && !unplanned.length && !syncError) return '';

  return `<div class="rail-card rail-attention">
    <h3>Needs attention</h3>
    <div class="rl-list">
      ${syncError ? `<div class="rl-row is-warn">
        <span class="rl-t">Calendar sync failed</span>
        <button class="rl-s rail-link" id="cal-sync-retry">Retry</button></div>` : ''}
      ${clashes.slice(0, 3).map(({ day, c }) => `<button class="rl-row is-warn" data-day="${day}">
        <span class="rl-t">${esc(c[0].title)} overlaps ${esc(c[1].title)}</span>
        <span class="rl-s">${esc(prettyShort(day))}</span>
      </button>`).join('')}
      ${overdue.slice(0, 3).map((r) => `<div class="rl-row is-warn">
        <span class="rl-t">${esc(r.title)}</span><span class="rl-s">overdue</span></div>`).join('')}
      ${unplanned.slice(0, 3).map((t) => `<button class="rl-row" data-schedule="${t.id}">
        <span class="rl-t">${esc(t.title)}</span>
        <span class="rl-s">due, not planned</span></button>`).join('')}
    </div>
  </div>`;
}

/** Month with nothing selected: what the month holds, briefly. */
/**
 * Month with nothing selected.
 *
 * It used to list totals — Events 58, All-day 3, Busy days 4. A count is not a
 * decision, and nobody opens a calendar wondering how many events they have.
 * What is worth surfacing is the handful of dates that are unusual: birthdays
 * you would regret missing, and days already heavily booked.
 */
function monthOverviewHtml() {
  const d = cal.data;
  if (!d) return '';
  const days = monthGrid(cal.anchor)
    .filter((x) => x.getMonth() === cal.anchor.getMonth()).map(iso);
  const todayIso = iso(new Date());
  const inMonth = (e) => days.includes(e.isAllDay ? e.startDate : iso(new Date(e.startsAt)));
  const events = (d.events ?? []).filter((e) => (e.isAllDay ? e.startDate : e.startsAt) && inMonth(e));
  const birthdays = events.filter((e) => e.eventType === 'birthday' && e.startDate >= todayIso);
  const heavy = days.filter((day) => day >= todayIso && workload(day) === 'overloaded');

  if (!birthdays.length && !heavy.length) {
    return `<div class="rail-card">
      <h3>This month</h3>
      <p class="rail-quiet">Pick a day to see what is on it.</p>
    </div>`;
  }

  return `<div class="rail-card">
    <h3>Worth knowing</h3>
    ${birthdays.length ? `<div class="cs-sec"><span class="cs-lab">Birthdays ahead</span>
      ${birthdays.slice(0, 4).map((b) => `<button class="cs-row" data-day="${b.startDate}">
        <i style="background:var(--p-medium)"></i>
        <span>${esc(prettyShort(b.startDate))}</span><b>${esc(b.title)}</b></button>`).join('')}
    </div>` : ''}
    ${heavy.length ? `<div class="cs-sec"><span class="cs-lab">Heavily booked</span>
      ${heavy.slice(0, 3).map((day) => `<button class="cs-row" data-day="${day}">
        <i style="background:var(--danger)"></i>
        <span>${esc(prettyShort(day))}</span>
        <b>${esc(parseIso(day).toLocaleDateString(undefined, { weekday: 'long' }))}</b></button>`).join('')}
    </div>` : ''}
    <p class="rail-quiet cal-hint">Pick a day to see what is on it.</p>
  </div>`;
}

function selectedRailHtml() {
  const day = cal.selected;
  const { events, reminders, deadlines, blocks, habit } = itemsForDay(day);
  const d = parseIso(day);
  const clashes = conflictsOn(day);
  const empty = !events.length && !reminders.length && !deadlines.length && !blocks.length;
  const load = workload(day);

  return `<div class="rail-card cal-sel">
    <h3>${esc(d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}</h3>

    ${empty ? `<div class="cs-empty">
        <span class="cs-empty-t">Nothing planned</span>
        <span class="cs-empty-s">A clear day. Add something if you need to.</span>
      </div>`
      : `<div class="cs-load load-${load}"><i></i>${esc(loadWord(load))}</div>`}

    ${clashes.length ? `<div class="cs-alert">
      ${clashes.map(([a, b]) => `<span><b>${esc(a.title)}</b> overlaps <b>${esc(b.title)}</b></span>`).join('')}
    </div>` : ''}

    ${events.length ? `<div class="cs-sec"><span class="cs-lab">Events</span>
      ${events.map((e) => `<button class="cs-row" data-event="${e.id}">
        <i style="background:${esc(e.calendarColor || 'var(--accent)')}"></i>
        <span>${e.isAllDay ? 'All day' : esc(hhmm(new Date(e.startsAt)))}</span>
        <b>${esc(e.title)}</b></button>`).join('')}</div>` : ''}

    ${blocks.length ? `<div class="cs-sec"><span class="cs-lab">Planned work</span>
      ${blocks.map((b) => `<div class="cs-row"><i class="cs-plan"></i>
        <span>${esc(hhmm(new Date(b.startsAt)))}</span><b>${esc(b.title)}</b></div>`).join('')}</div>` : ''}

    ${reminders.length ? `<div class="cs-sec"><span class="cs-lab">Reminders</span>
      ${reminders.map((r) => `<div class="cs-row ${r.status === 'done' ? 'is-done' : ''}">
        <i class="cs-rem"></i>
        <span>${r.dueTime ? esc(r.dueTime) : 'Any time'}</span><b>${esc(r.title)}</b></div>`).join('')}</div>` : ''}

    ${deadlines.length ? `<div class="cs-sec"><span class="cs-lab">Due</span>
      ${deadlines.map((t) => `<div class="cs-row pri-${t.priority}"><i class="cs-due"></i>
        <span>${esc(t.priority)}</span><b>${esc(t.title)}</b></div>`).join('')}</div>` : ''}

    ${habitCardHtml(day)}

    <button class="btn btn-primary cs-add" data-cal-add-day="${day}">Add to this day</button>
  </div>`;
}

/**
 * The selected day's habits, tickable.
 *
 * This is the point of the whole section: Life OS could tell you that you did
 * 3 of 5 habits on a day two weeks ago, and offered no way to correct it. A
 * history you cannot fix is a history you stop trusting, and then stop reading.
 *
 * Only in Month. Agenda answers "what is coming", and habits are not coming —
 * they are a rhythm. Plan is about placing work into hours. Putting the same
 * card in all three would be filling space rather than answering a question.
 */
function habitCardHtml(day) {
  if (!cal.layers.habits) return '';
  const dh = cal.dayHabits;
  const future = day > iso(new Date());

  if (future) {
    // Nothing to tick and nothing to correct. Saying so beats an empty card.
    return `<div class="cs-sec cs-habits">
      <span class="cs-lab">Habits</span>
      <p class="cs-habit-note">Not yet — this day has not happened.</p>
    </div>`;
  }
  if (!dh || dh.date !== day) return '';
  if (dh.loading) {
    return `<div class="cs-sec cs-habits"><span class="cs-lab">Habits</span>
      <p class="cs-habit-note">Loading…</p></div>`;
  }
  if (dh.error) {
    return `<div class="cs-sec cs-habits"><span class="cs-lab">Habits</span>
      <p class="cs-habit-note is-err">${esc(dh.error)}</p></div>`;
  }

  const due = (dh.habits ?? []).filter((h) => h.dueToday);
  /* The computed `Write in Diary` habit is part of the same system (D2.2 §9),
   * so it appears here as a series like any other — but it OPENS that day's
   * diary instead of ticking, because completing it means writing something. */
  const diary = dh.diaryHabit ?? null;
  if (!due.length && !diary) {
    return `<div class="cs-sec cs-habits"><span class="cs-lab">Habits</span>
      <p class="cs-habit-note">Nothing was due.</p></div>`;
  }
  const done = due.filter((h) => h.completedToday).length + (diary?.completedToday ? 1 : 0);
  const total = due.length + (diary ? 1 : 0);

  return `<div class="cs-sec cs-habits">
    <span class="cs-lab">Habits <b class="cs-habit-count">${done}/${total}</b></span>
    ${diary ? `<button class="cs-habit-row cs-habit-diary ${
  diary.completedToday ? 'is-done' : ''}" data-diary-day="${day}"
      aria-label="${esc(diary.name)}${diary.completedToday ? ', written' : ', not written'
}. Opens this day's diary.">
      <span class="cs-habit-tick" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor"
          stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg></span>
      <b>${esc(diary.name)}</b>
      <span class="cs-habit-auto" title="Automatic — kept from your Diary">Automatic</span>
    </button>` : ''}
    ${due.map((h) => `<button class="cs-habit-row ${h.completedToday ? 'is-done' : ''}"
      data-habit="${h.id}" data-habit-day="${day}"
      aria-pressed="${h.completedToday ? 'true' : 'false'}"
      aria-label="${esc(h.name)}${h.completedToday ? ', done' : ', not done'}">
      <span class="cs-habit-tick" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor"
          stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg></span>
      <b>${esc(h.name)}</b>
      ${h.targetCount > 1 ? `<span class="cs-habit-n">${h.todayCount}/${h.targetCount}</span>` : ''}
    </button>`).join('')}
  </div>`;
}

const loadWord = (l) => ({
  open: 'Open day', moderate: 'A few commitments',
  busy: 'Busy day', overloaded: 'Heavily booked',
}[l] ?? l);

/**
 * Calendar sources — the real connection surface.
 *
 * This replaced a developer-facing card that said "Synthetic data. No Google
 * account is connected." Product UI does not talk about synthetic data; it
 * says whether a calendar is connected and what Life OS can do with it.
 */
/**
 * Agenda's mode context: what is coming, summarised. Source management moved
 * to a popover - it was dominating the rail on the one mode where the user is
 * least interested in plumbing.
 */
/**
 * Agenda's mode context.
 *
 * It used to list totals — 58 events, 10 reminders, 0 deadlines, 90 hours free.
 * None of those is a decision. A count answers "how many", and the only useful
 * question a rail can answer is "what should I do about it".
 *
 * So this renders nothing at all unless something needs attention, and the
 * shared attention card below already covers conflicts and overdue reminders.
 */
function agendaRailHtml() {
  const d = cal.data;
  if (!d) return '';
  const today = new Date();
  const week = Array.from({ length: 7 }, (_, i) => iso(addDays(today, i)));

  // Reminders landing this week, because that is a week you can prepare for.
  const dueThisWeek = week.reduce((n, day) => n + itemsForDay(day).reminders
    .filter((r) => r.status !== 'done').length, 0);
  // Tasks with a deadline in view and no time set aside for them.
  const unplanned = (d.deadlines ?? []).filter((t) =>
    !(d.blocks ?? []).some((b) => b.taskId === t.id));

  const insights = [
    dueThisWeek ? { text: `${dueThisWeek} reminder${dueThisWeek > 1 ? 's' : ''} due this week`,
      go: 'reminders' } : null,
    unplanned.length ? { text: `${unplanned.length} task${unplanned.length > 1 ? 's' : ''} due with no time set aside`,
      go: 'plan' } : null,
  ].filter(Boolean);

  if (!insights.length) return '';

  return `<div class="rail-card">
    <h3>Worth a look</h3>
    <div class="rl-list">
      ${insights.map((i) => `<button class="rl-row" data-insight="${i.go}">
        <span class="rl-t">${esc(i.text)}</span>
        <span class="rl-s">›</span></button>`).join('')}
    </div>
  </div>`;
}

/** Source management, on demand rather than permanently in the rail. */
export function sourcesPopoverHtml() {
  const d = cal.data;
  const conn = d?.connection ?? null;
  const cals = (d?.calendars ?? []).filter((c) => !c.isSynthetic);

  if (!conn) {
    return `<div class="sources">
      <h4>Calendar sources</h4>
      <p class="cs-connect-copy">Connect Google Calendar to see your real events
        in Month, Agenda and Plan week.</p>
      <ul class="cs-connect-list">
        <li>Life OS reads your calendars and events.</li>
        <li>It cannot create, change or delete anything in Google.</li>
        <li>You can disconnect at any time.</li>
      </ul>
      <button class="btn btn-primary cs-connect" id="cal-connect">
        Connect Google Calendar</button>
    </div>`;
  }

  return `<div class="sources">
    <h4>Calendar sources</h4>
    <div class="cs-account">
      <span class="cs-acct-dot ${conn.status === 'error' ? 'is-error' : 'is-ok'}"></span>
      <div class="cs-acct-body">
        <b>${esc(conn.accountEmail ?? 'Google account')}</b>
        <span>${conn.status === 'error' ? 'Needs reconnecting' : 'Connected · Read-only'}</span>
      </div>
    </div>
    <div class="cs-sources">
      ${cals.map((c) => `<label class="cs-source">
        <input type="checkbox" class="cs-vis" data-calendar="${c.id}" ${c.isVisible ? 'checked' : ''}>
        <span class="cs-box"></span>
        <i class="cs-dot" style="background:${esc(c.color || 'var(--accent)')}"></i>
        <span class="cs-name">${esc(c.name)}</span>
        ${c.isReadOnly ? '<span class="cs-ro">read-only</span>' : ''}
      </label>`).join('')}
    </div>
    <div class="cs-sync">
      <span>${esc(lastSyncedWord(conn.lastSyncedAt))}</span>
      <button class="btn btn-ghost cs-sync-now" id="cal-sync">Sync now</button>
    </div>
    <button class="rail-link cs-disconnect" id="cal-disconnect">Disconnect</button>
  </div>`;
}

function lastSyncedWord(ts) {
  if (!ts) return 'Not synced yet';
  const mins = Math.round((Date.now() - new Date(ts)) / 60000);
  if (mins < 1) return 'Synced just now';
  if (mins < 60) return `Synced ${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Synced ${hrs} hour${hrs > 1 ? 's' : ''} ago`;
  return `Synced ${new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

/**
 * Planning queue — compact cards, not narrow grey bars.
 *
 * Each carries what you need to decide WHEN to do it: area, priority, due
 * date, duration. Dragging is one way to schedule, never the only way: there
 * is a Schedule button that works with a keyboard and with a finger.
 */
function queueCardHtml(t, kind) {
  const area = areaNameFor(t.areaId);
  return `<div class="pq-card pri-${t.priority}" data-queue-task="${t.id}" tabindex="0"
      role="listitem" aria-label="${esc(t.title)}${area ? `, ${esc(area)}` : ''}">
    <div class="pq-top">
      <span class="pq-title">${esc(t.title)}</span>
      <button class="pq-sched" data-schedule="${t.id}"
        aria-label="Schedule ${esc(t.title)}">Schedule</button>
    </div>
    <div class="pq-meta">
      ${area ? `<span class="pq-area">${esc(area)}</span>` : ''}
      <span class="pq-pri pri-dot-${t.priority}">${esc(t.priority)}</span>
      ${t.dueDate ? `<span class="pq-due ${kind === 'due' ? 'is-soon' : ''}">
        due ${esc(prettyShort(t.dueDate))}</span>` : ''}
      ${t.estimateMinutes ? `<span class="pq-dur">${t.estimateMinutes}m</span>` : ''}
      ${t.steps?.length ? `<span class="pq-steps">
        ${t.steps.filter((x) => x.completed).length}/${t.steps.length} steps</span>` : ''}
    </div>
  </div>`;
}

function areaNameFor(id) {
  if (!id) return null;
  return (cal.areas ?? []).find((a) => a.id === id)?.name ?? null;
}

/**
 * Free windows inside planning hours, after events and existing blocks.
 * Deliberately not "every empty minute": anything shorter than 30 minutes is
 * not a usable work window and is not offered as one.
 */
function freeWindows(dayIso) {
  const hrs = planHours();
  const { events, blocks } = itemsForDay(dayIso);
  const busy = [];
  const mins = (d) => { const x = new Date(d); return x.getHours() * 60 + x.getMinutes(); };
  for (const e of events) {
    if (e.isAllDay || !e.startsAt || !e.endsAt) continue;
    busy.push([mins(e.startsAt), mins(e.endsAt)]);
  }
  for (const b of blocks) busy.push([mins(b.startsAt), mins(b.endsAt)]);
  busy.sort((a, b) => a[0] - b[0]);

  const out = [];
  let cursor = hrs.start * 60;
  for (const [s0, e0] of busy) {
    if (s0 > cursor) out.push([cursor, Math.min(s0, hrs.end * 60)]);
    cursor = Math.max(cursor, e0);
  }
  if (cursor < hrs.end * 60) out.push([cursor, hrs.end * 60]);
  return out.filter(([a, b]) => b - a >= 30);
}

function planRailHtml() {
  const d = cal.data;
  if (!d) return '';
  const week = weekOf(cal.anchor).map(iso);
  const scheduled = new Set(d.blocks.map((b) => b.taskId));
  const queue = (d.unscheduled ?? []).filter((t) => !scheduled.has(t.id));
  const dueSoon = (d.deadlines ?? []).filter((t) => !scheduled.has(t.id));
  /*
   * The largest usable window this week, named rather than summed.
   * "90 hours free" is arithmetic; "Tuesday has a 3-hour window" is a plan.
   */
  const windows = week.flatMap((day) => freeWindows(day)
    .map(([a, b]) => ({ day, mins: b - a, from: a })))
    .filter((w) => w.mins >= 60 && w.day >= iso(new Date()))
    .sort((x, y) => y.mins - x.mins);
  const top = windows[0];
  const bestWindow = top ? {
    day: top.day,
    label: `${parseIso(top.day).toLocaleDateString(undefined, { weekday: 'long' })} has `
      + `${Math.floor(top.mins / 60)}h free from `
      + `${String(Math.floor(top.from / 60)).padStart(2, '0')}:${String(top.from % 60).padStart(2, '0')}`,
  } : null;
  const noEstimate = queue.filter((t) => !t.estimateMinutes);

  return `<div class="rail-card">
      <h3>Planning queue</h3>
      ${dueSoon.length ? `<div class="cs-sec"><span class="cs-lab">Due soon, not planned</span>
        <div role="list" class="pq-list">${dueSoon.slice(0, 4).map((t) => queueCardHtml(t, 'due')).join('')}</div>
      </div>` : ''}
      ${queue.length ? `<div class="cs-sec"><span class="cs-lab">Unscheduled</span>
        <div role="list" class="pq-list">${queue.slice(0, 8).map((t) => queueCardHtml(t, 'open')).join('')}</div>
      </div>`
      : (!dueSoon.length ? `<div class="cs-empty">
          <span class="cs-empty-t">Nothing waiting</span>
          <span class="cs-empty-s">Every open task already has time set aside.</span>
        </div>` : '')}
    </div>
    <div class="rail-card"><h3>This week</h3>
      <div class="rl-list">
        ${bestWindow ? `<button class="rl-row" data-day="${bestWindow.day}">
          <span class="rl-t">${esc(bestWindow.label)}</span>
          <span class="rl-s">›</span></button>` : ''}
        ${noEstimate.length ? `<div class="rl-row">
          <span class="rl-t">${noEstimate.length} task${noEstimate.length > 1 ? 's' : ''} with no duration</span>
          <span class="rl-s">hard to plan</span></div>` : ''}
        ${!bestWindow && !noEstimate.length ? `<div class="rl-row">
          <span class="rl-t">Nothing needs attention this week</span></div>` : ''}
      </div>
    </div>`;
}

/* ── Body ─────────────────────────────────────────────────────────────── */
/**
 * The Calendar body: ONE frame holding the canvas and the rail.
 *
 * The rail used to be the page's rail column, which meant opening it narrowed
 * the whole content column — and the header and the canvas, both centred inside
 * that column, slid sideways every time a day was selected. Owning the rail
 * inside the frame means the frame's edges never move: only the canvas gives up
 * width, from its right edge, so every day column keeps its position.
 */
export function calendarBodyHtml() {
  return `<div class="cal-body ${railIsOpen() ? 'has-rail rail-shown' : ''}" id="cal-body">
    <div class="cal-canvas" id="cal-canvas">${calendarCanvasHtml()}</div>
    <aside class="cal-rail" id="cal-rail" aria-label="Context">
      <div class="cal-rail-in" id="cal-rail-in">${calendarRailHtml()}</div>
    </aside>
  </div>`;
}

function calendarCanvasHtml() {
  if (cal.loading) return '<div class="state"><b>Loading your calendar…</b></div>';
  if (cal.error) {
    return `<div class="state"><b>Could not load the calendar</b>${esc(cal.error)}
      <button class="btn" id="cal-retry">Try again</button></div>`;
  }
  if (cal.mode === 'month') return monthHtml();
  if (cal.mode === 'plan') return planHtml();
  return agendaHtml();
}

export const freeWindowsFor = (day) => freeWindows(day);
export const planHours = () => ({ start: PLAN_START, end: PLAN_END });

export { cal, currentRange, itemsForDay, workload, conflictsOn, monthGrid, weekOf, iso, parseIso,
  habitCardHtml, habitSummaryHtml };

/**
 * Agenda regroup — moving an item between date groups without a rebuild.
 *
 * The naive version replaces the whole Agenda, which flashes, loses scroll
 * position and destroys node identity. This collapses the item out of its old
 * group, repaints, then FLIPs everything into place — so the eye follows one
 * item moving rather than the page reloading.
 *
 * Google events are read-only in this phase, so nothing calls this yet. The
 * architecture exists now because it constrains how Agenda renders: if the
 * regroup path were added later, it would find a view that rebuilds itself and
 * cannot be animated. That is exactly how C4's FLIP ended up invisible.
 */
export function regroupAgendaItem(itemId, repaint) {
  const el = document.querySelector(`.ag-item[data-event="${itemId}"]`);
  const scroller = document.getElementById('main-scroll');
  const scrollTop = scroller?.scrollTop ?? 0;

  if (!el || reducedMotion()) {
    repaint();
    if (scroller) scroller.scrollTop = scrollTop;
    return;
  }

  // Measure every item and group heading BEFORE the change.
  const tracked = [...document.querySelectorAll('.ag-item,.ag-group,.ag-day')];
  const first = new Map();
  for (const n of tracked) {
    const key = n.dataset.event ?? n.dataset.day ?? n.textContent?.trim();
    if (key) first.set(key, n.getBoundingClientRect());
  }

  const oldGroup = el.closest('.ag-day');
  const wasLastInGroup = oldGroup?.querySelectorAll('.ag-item').length === 1;

  // Soften and collapse out of the old position.
  const out = el.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(10px)' }],
    { duration: 160, easing: 'cubic-bezier(.4,0,.9,.4)' },
  );

  settle(out, 160, () => {
    repaint();
    if (scroller) scroller.scrollTop = scrollTop;

    const after = [...document.querySelectorAll('.ag-item,.ag-group,.ag-day')];
    for (const n of after) {
      const key = n.dataset.event ?? n.dataset.day ?? n.textContent?.trim();
      const prev = key && first.get(key);
      if (!prev) {
        // New to the view — the moved item, or a group that just opened.
        n.animate(
          [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }],
          { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' },
        );
        continue;
      }
      const now = n.getBoundingClientRect();
      const dy = prev.top - now.top;
      if (Math.abs(dy) < 1) continue;
      n.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
        { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' },
      );
    }
    // An emptied group closes rather than leaving a stray heading behind.
    if (wasLastInGroup) pulse(document.querySelector('.ag-group'));
  });
}
