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
import { datePickerPopover, timePickerPopover } from './pickers.js';

const RISE_IN = [{ opacity: 0, translate: '0 10px', scale: '0.985' },
  { opacity: 1, translate: '0 0', scale: '1' }];
const RISE_OUT = [{ opacity: 1, translate: '0 0', scale: '1' },
  { opacity: 0, translate: '0 6px', scale: '0.99' }];

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),'
  + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DURATIONS = [15, 30, 45, 60, 90, 120, 180];

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
      <div class="ev-row ev-row-top">
        <span class="ev-lab">Task</span>
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
        </div>
      </div>

      <div class="ev-row">
        <span class="ev-lab">When</span>
        <button type="button" class="ev-ctl" id="st-date" data-picker="date"
          data-target="day">${esc(prettyDate(f.day))}</button>
        <button type="button" class="ev-ctl ev-time" id="st-time" data-picker="time"
          data-target="time">${esc(f.time)}</button>
      </div>

      <div class="ev-row ev-row-top">
        <span class="ev-lab">For</span>
        <div class="st-durations" id="st-durations">
          ${DURATIONS.map((m) => `<button type="button" class="ev-pill ${m === f.minutes ? 'is-on' : ''}"
            data-minutes="${m}">${durLabel(m)}</button>`).join('')}
        </div>
      </div>

      <div class="st-check" id="st-check" role="status"></div>`}
    </div>

    <div class="m-foot">
      <span class="m-save-state" id="st-state" role="status"></span>
      <button class="btn" id="st-cancel">${empty ? 'Close' : 'Cancel'}</button>
      ${empty ? '' : '<button class="btn btn-primary" id="st-save">Schedule it</button>'}
    </div>

    <div class="ev-pop" id="st-pop" hidden></div>`;

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
    const endLabel = (() => {
      const e = start + f.minutes;
      return `${String(Math.floor(e / 60) % 24).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
    })();
    el.className = `st-check ${clashes.length ? 'has-clash' : 'is-clear'}`;
    el.innerHTML = clashes.length
      ? `<b>${esc(f.time)}–${esc(endLabel)}</b> overlaps ${esc(clashes[0])}${
        clashes.length > 1 ? ` and ${clashes.length - 1} more` : ''}. You can still schedule it.`
      : `<b>${esc(f.time)}–${esc(endLabel)}</b> is free.`;
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
      if (est) {
        f.minutes = est;
        dlg.querySelectorAll('[data-minutes]').forEach((p) =>
          p.classList.toggle('is-on', Number(p.dataset.minutes) === est));
      }
      refreshCheck();
    };
  });

  dlg.querySelectorAll('#st-durations [data-minutes]').forEach((p) => {
    p.onclick = () => {
      f.minutes = Number(p.dataset.minutes);
      dlg.querySelectorAll('#st-durations [data-minutes]').forEach((x) =>
        x.classList.toggle('is-on', x === p));
      refreshCheck();
    };
  });

  /* Shared pickers, so this modal cannot drift from Event and Reminder. */
  const pop = $('#st-pop');
  let popFor = null;
  const closePop = () => { pop.hidden = true; pop.innerHTML = ''; popFor = null; };
  dlg.querySelectorAll('[data-picker]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const target = btn.dataset.target;
      if (popFor === target) return closePop();
      popFor = target;
      if (btn.dataset.picker === 'date') {
        datePickerPopover(pop, dlg, btn, f.day, (v) => {
          f.day = v; btn.textContent = prettyDate(v); closePop(); refreshCheck();
        });
      } else {
        timePickerPopover(pop, dlg, btn, f.time, (v) => {
          f.time = v; btn.textContent = v; closePop(); refreshCheck();
        });
      }
    };
  });
  dlg.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-picker]')) closePop();
  });

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
