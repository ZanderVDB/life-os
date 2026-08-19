/**
 * Schedule a task.
 *
 * Deciding WHEN you will do something is not the same as saying when it is
 * due, so this never touches the task's due date, bucket, area or project. It
 * only creates a block of time.
 *
 * Three entry points, one modal:
 *   + Add          — pick a task, then a date, time and duration
 *   a Plan slot    — date and time prefilled, pick a task and a duration
 *   dragging       — handled by plan-drag.js, which needs no modal at all
 *
 * Conflicts are shown before you confirm, not discovered afterwards.
 */
import { reducedMotion, settle } from './motion.js';
import {
  row, section, dateField, timeField, wireDateTime, durationField, wireDuration,
  formatTime,
} from './calendar-fields.js';

const RISE_IN = [{ opacity: 0, translate: '0 10px', scale: '0.985' },
  { opacity: 1, translate: '0 0', scale: '1' }];
const RISE_OUT = [{ opacity: 1, translate: '0 0', scale: '1' },
  { opacity: 0, translate: '0 6px', scale: '0.99' }];

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),'
  + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  + `-${String(d.getDate()).padStart(2, '0')}`;
const parseIso = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const prettyDate = (s) => parseIso(s).toLocaleDateString(undefined,
  { weekday: 'short', day: 'numeric', month: 'short' });
const durLabel = (m) => (m < 60 ? `${m} min`
  : m % 60 === 0 ? `${m / 60} hour${m > 60 ? 's' : ''}` : `${Math.floor(m / 60)}h ${m % 60}m`);

/**
 * @param {object} ctx
 *   tasks       schedulable tasks [{id,title,areaId,priority,dueDate,estimateMinutes}]
 *   areaName(id)
 *   day, time   prefilled when launched from a Plan slot
 *   conflictsAt(dayIso, startMin, endMin) -> string[]
 *   onSchedule(taskId, startsAt, endsAt)
 *   onOpenTasks()
 */
export function openScheduleTaskModal(ctx) {
  const { tasks = [], day = null, time = null } = ctx;
  const opener = document.activeElement;
  document.querySelector('.modal-scrim')?.remove();

  const f = {
    taskId: tasks[0]?.id ?? null,
    day: day ?? iso(new Date()),
    time: time ?? '09:00',
    minutes: tasks[0]?.estimateMinutes ?? 60,
  };

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  const dlg = document.createElement('div');
  dlg.className = 'modal modal-schedule';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', 'Schedule a task');

  // Nothing to schedule is a real state, not an error. Say so and offer the
  // way forward rather than opening a form that cannot be completed.
  const empty = tasks.length === 0;

  dlg.innerHTML = `
    <div class="m-head">
      <span class="st-mark" aria-hidden="true"></span>
      <h2 class="m-title st-title">Schedule a task</h2>
      <button class="m-close" id="st-close" aria-label="Close">&times;</button>
    </div>

    <div class="m-body ev-body">
      ${empty ? `<div class="st-empty">
          <span class="st-empty-t">Nothing waiting to be scheduled</span>
          <span class="st-empty-s">Every open task already has time set aside,
            or you have no open tasks yet.</span>
          <button class="btn" id="st-open-tasks">Go to Today</button>
        </div>`
      : `
      ${row('Task', `
        <div class="st-list" role="radiogroup" aria-label="Choose a task" id="st-list">
          ${tasks.map((t, i) => `<button type="button" class="st-task pri-${t.priority}
            ${i === 0 ? 'is-sel' : ''}" role="radio" aria-checked="${i === 0}"
            data-task="${t.id}" data-minutes="${t.estimateMinutes ?? ''}">
            <span class="st-task-t">${esc(t.title)}</span>
            <span class="st-task-m">
              ${ctx.areaName?.(t.areaId) ? `<span>${esc(ctx.areaName(t.areaId))}</span>` : ''}
              <span class="st-pri">${esc(t.priority)}</span>
              ${t.dueDate ? `<span class="st-due">due ${esc(prettyDate(t.dueDate))}</span>` : ''}
            </span>
          </button>`).join('')}
        </div>`, { top: true })}

      <!-- When, how long, and whether it is free are one decision. The same
           controls as Event and Reminder, so this is not a third dialect. -->
      ${section(`
        ${row('When', `${dateField('st-date', f.day, { label: 'Date' })}
          ${timeField('st-time', f.time, { label: 'Time' })}`)}
        ${row('For', durationField(f.minutes), { top: true })}
        <div class="st-check" id="st-check" role="status"></div>`)}`}
    </div>

    <div class="m-foot">
      <span class="m-save-state" id="st-state" role="status"></span>
      <button class="btn" id="st-cancel">${empty ? 'Close' : 'Cancel'}</button>
      ${empty ? '' : '<button class="btn btn-primary" id="st-save">Schedule it</button>'}
    </div>

`;   // The popover host is created by wireDateTime, once per dialog.

  document.body.append(scrim, dlg);
  document.body.classList.add('modal-open');
  if (!reducedMotion()) {
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    dlg.animate(RISE_IN, { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  const $ = (sel) => dlg.querySelector(sel);
  const minutesFromTime = () => {
    const [h, m] = f.time.split(':').map(Number);
    return h * 60 + m;
  };

  /** Live conflict preview — shown before confirming, never after. */
  function refreshCheck() {
    const el = $('#st-check');
    if (!el) return;
    const start = minutesFromTime();
    const clashes = ctx.conflictsAt?.(f.day, start, start + f.minutes) ?? [];
    /* The SHARED format. This line used to build its own "09:00–10:00" while
     * the controls two rows above said "9:00 am", so one dialog stated the
     * same hour two different ways. */
    const e = start + f.minutes;
    const endLabel = formatTime(
      `${String(Math.floor(e / 60) % 24).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`);
    const startLabel = formatTime(f.time);
    el.className = `st-check ${clashes.length ? 'has-clash' : 'is-clear'}`;
    el.innerHTML = clashes.length
      ? `<b>${esc(startLabel)}–${esc(endLabel)}</b> overlaps ${esc(clashes[0])}${
        clashes.length > 1 ? ` and ${clashes.length - 1} more` : ''}. You can still schedule it.`
      : `<b>${esc(startLabel)}–${esc(endLabel)}</b> is free.`;
  }

  if (!empty) refreshCheck();

  dlg.querySelectorAll('[data-task]').forEach((b) => {
    b.onclick = () => {
      f.taskId = b.dataset.task;
      dlg.querySelectorAll('[data-task]').forEach((x) => {
        x.classList.toggle('is-sel', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
      // Adopt the task's own estimate when it has one.
      const est = Number(b.dataset.minutes);
      if (est) dur.set(est);
      refreshCheck();
    };
  });

  /* Shared controls: the same date field, time field and duration presets as
   * Event, so this modal cannot drift into being a third dialect. `f` is kept
   * in step because the availability check and the save both read it. */
  const dt = wireDateTime(dlg, dlg, (kind, value) => {
    if (kind === 'date') f.day = value; else f.time = value;
    dur.refresh();
    refreshCheck();
  });
  const dur = wireDuration(dlg, () => ({ day: f.day, time: f.time, allDay: false }), f.minutes);
  const syncMinutes = () => { f.minutes = dur.minutes; refreshCheck(); };
  dlg.querySelectorAll('[data-cf-dur],[data-cf-dur-custom]').forEach((b) => {
    b.addEventListener('click', () => setTimeout(syncMinutes, 0));
  });
  dur.set = (m) => {
    const btn = dlg.querySelector(`[data-cf-dur="${m}"]`);
    if (btn) btn.click(); else f.minutes = m;
  };

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('modal-open');
    const done = () => { scrim.remove(); dlg.remove(); };
    if (reducedMotion()) done();
    else {
      scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in' });
      settle(dlg.animate(RISE_OUT, { duration: 160, easing: 'cubic-bezier(.4,0,.9,.4)' }), 160, done);
    }
    if (opener?.isConnected) opener.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (!pop.hidden) return closePop();
      return close();
    }
    if (e.key !== 'Tab') return;
    const items = [...dlg.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const [first, last] = [items[0], items[items.length - 1]];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKey, true);
  scrim.onclick = close;
  $('#st-close').onclick = close;
  $('#st-cancel').onclick = close;
  $('#st-open-tasks')?.addEventListener('click', () => { close(); ctx.onOpenTasks?.(); });

  $('#st-save')?.addEventListener('click', async () => {
    if (!f.taskId) return;
    const state = $('#st-state');
    const btn = $('#st-save');
    btn.classList.add('is-busy');
    state.textContent = 'Scheduling…';
    const [h, m] = f.time.split(':').map(Number);
    const [y, mo, d] = f.day.split('-').map(Number);
    const start = new Date(y, mo - 1, d, h, m, 0, 0);
    const end = new Date(start.getTime() + f.minutes * 60000);
    try {
      await ctx.onSchedule(f.taskId, start.toISOString(), end.toISOString());
      close();
    } catch (e) {
      btn.classList.remove('is-busy');
      state.textContent = e.message;
    }
  });

  dlg.querySelector('[data-task],#st-open-tasks')?.focus();
  return { close };
}
