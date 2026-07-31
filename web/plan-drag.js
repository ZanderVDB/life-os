/**
 * Plan mode — dragging work into time.
 *
 * Three gestures, one pointer-based path (mouse, pen and touch alike):
 *   1. drag a task from the queue onto a day  -> creates a schedule block
 *   2. drag an existing block                 -> moves it in time or across days
 *   3. drag a block's bottom edge             -> resizes it
 *
 * The ghost is the proposed block at its FINAL dimensions, positioned on the
 * real canvas. There is no separate "preview" abstraction to drift out of sync
 * with the thing being previewed — what you see under the pointer is the block
 * that will exist when you let go.
 *
 * Nothing is written while dragging. One request on drop.
 *
 * IMPORTANT: scheduling never touches the task's due date. A task due Friday
 * that you plan for Wednesday keeps both facts. That separation is the reason
 * task_schedule_blocks exists as its own table.
 */
import { reducedMotion } from './motion.js';

const SNAP = 15;          // minutes — the grid work snaps to
const MIN_MINUTES = 15;
const DEFAULT_MINUTES = 60;

let s = null;             // active session

/**
 * @param {object} hooks
 *   hours()      -> { start, end } visible hour range
 *   onCreate(taskId, startsAt, endsAt)
 *   onMove(blockId, startsAt, endsAt)
 *   conflictsAt(dayIso, startMin, endMin) -> array of clashing titles
 */
export function initPlanDrag(hooks) {
  document.addEventListener('pointerdown', (e) => down(e, hooks), true);
}

function down(e, hooks) {
  if (s || (e.button != null && e.button !== 0)) return;
  const canvasHost = document.querySelector('.cal-plan');
  if (!canvasHost) return;

  const handle = e.target.closest('.pl-resize');
  const block = e.target.closest('.pl-block');
  const queued = e.target.closest('[data-queue-task]');
  if (!handle && !block && !queued) return;

  const start = { x: e.clientX, y: e.clientY };
  let started = false;

  const move = (ev) => {
    if (!started) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      started = true;
      begin({ handle, block, queued }, ev, hooks);
    }
    if (s) { ev.preventDefault(); drag(ev, hooks); }
  };
  const up = (ev) => {
    if (s) { ev.preventDefault(); finish(hooks); }
    cleanup();
  };
  const cancel = () => { if (s) abort(); cleanup(); };
  function cleanup() {
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('pointercancel', cancel, true);
  }
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', cancel, true);
}

/* ── Geometry ─────────────────────────────────────────────────────────── */

/** Pointer Y within a canvas -> minutes from midnight, snapped. */
function minutesAt(canvas, clientY, hours) {
  const r = canvas.getBoundingClientRect();
  const span = (hours.end - hours.start) * 60;
  const raw = hours.start * 60 + ((clientY - r.top) / r.height) * span;
  const snapped = Math.round(raw / SNAP) * SNAP;
  return Math.max(hours.start * 60, Math.min(hours.end * 60, snapped));
}

const pct = (min, hours) =>
  ((min - hours.start * 60) / ((hours.end - hours.start) * 60)) * 100;

const fmt = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function canvasUnder(x, y) {
  for (const c of document.querySelectorAll('.pl-canvas')) {
    const r = c.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top - 40 && y <= r.bottom + 40) return c;
  }
  return null;
}

/* ── Lift ─────────────────────────────────────────────────────────────── */

function begin(target, e, hooks) {
  const hours = hooks.hours();
  const ghost = document.createElement('div');
  ghost.className = 'pl-ghost';

  if (target.queued) {
    s = {
      kind: 'create',
      taskId: target.queued.dataset.queueTask,
      title: target.queued.querySelector('b')?.textContent ?? 'Task',
      minutes: DEFAULT_MINUTES,
      ghost, hours, canvas: null, startMin: 0,
    };
    target.queued.classList.add('is-dragging');
  } else if (target.handle) {
    const el = target.block;
    const b = el.dataset;
    s = {
      kind: 'resize',
      blockId: b.block,
      el,
      title: el.querySelector('b')?.nextSibling?.textContent?.trim() ?? '',
      startMin: Number(b.startMin),
      minutes: Number(b.endMin) - Number(b.startMin),
      ghost, hours,
      canvas: el.closest('.pl-canvas'),
    };
    el.classList.add('is-source');
  } else {
    const el = target.block;
    s = {
      kind: 'move',
      blockId: el.dataset.block,
      el,
      startMin: Number(el.dataset.startMin),
      minutes: Number(el.dataset.endMin) - Number(el.dataset.startMin),
      // Where inside the block the pointer grabbed, so it does not jump.
      grabOffset: minutesAt(el.closest('.pl-canvas'), e.clientY, hooks.hours())
        - Number(el.dataset.startMin),
      ghost, hours,
      canvas: el.closest('.pl-canvas'),
    };
    el.classList.add('is-source');
  }

  document.body.classList.add('is-planning');
  drag(e, hooks);
}

/* ── Move ─────────────────────────────────────────────────────────────── */

function drag(e, hooks) {
  const canvas = canvasUnder(e.clientX, e.clientY) ?? s.canvas;
  if (!canvas) return;
  if (canvas !== s.canvas) {
    s.canvas = canvas;
    canvas.appendChild(s.ghost);
  } else if (!s.ghost.isConnected) {
    canvas.appendChild(s.ghost);
  }

  const at = minutesAt(canvas, e.clientY, s.hours);

  if (s.kind === 'resize') {
    // The top edge is fixed; the bottom follows the pointer.
    s.minutes = Math.max(MIN_MINUTES, at - s.startMin);
  } else if (s.kind === 'move') {
    s.startMin = Math.max(s.hours.start * 60,
      Math.min(s.hours.end * 60 - s.minutes, at - s.grabOffset));
  } else {
    s.startMin = Math.min(s.hours.end * 60 - s.minutes, at);
  }

  const endMin = s.startMin + s.minutes;
  const day = canvas.dataset.dropDay;
  // Conflicts are shown BEFORE release, not discovered after.
  const clashes = hooks.conflictsAt(day, s.startMin, endMin, s.blockId);
  s.pending = { day, startMin: s.startMin, endMin, clashes };

  s.ghost.style.top = `${pct(s.startMin, s.hours).toFixed(2)}%`;
  s.ghost.style.height = `${Math.max(2, pct(endMin, s.hours) - pct(s.startMin, s.hours)).toFixed(2)}%`;
  s.ghost.classList.toggle('has-clash', clashes.length > 0);
  s.ghost.innerHTML = `<b>${fmt(s.startMin)}–${fmt(endMin)}</b>
    <span>${s.title ?? ''}</span>
    ${clashes.length ? `<span class="pl-clash">clashes with ${clashes[0]}</span>` : ''}`;
}

/* ── Drop ─────────────────────────────────────────────────────────────── */

function finish(hooks) {
  const p = s.pending;
  const kind = s.kind;
  const { taskId, blockId, el } = s;
  teardown();
  if (!p) return;

  const toIso = (day, min) => {
    const [y, m, d] = day.split('-').map(Number);
    const dt = new Date(y, m - 1, d, Math.floor(min / 60), min % 60, 0, 0);
    return dt.toISOString();
  };
  const startsAt = toIso(p.day, p.startMin);
  const endsAt = toIso(p.day, p.endMin);

  // One write, after the drop. Never during.
  if (kind === 'create') hooks.onCreate(taskId, startsAt, endsAt);
  else hooks.onMove(blockId, startsAt, endsAt, el);
}

function teardown() {
  s.ghost.remove();
  document.body.classList.remove('is-planning');
  document.querySelectorAll('.pl-block.is-source, [data-queue-task].is-dragging')
    .forEach((n) => n.classList.remove('is-source', 'is-dragging'));
  s = null;
}

function abort() { teardown(); }

export const isPlanning = () => !!s;
export { SNAP, MIN_MINUTES, DEFAULT_MINUTES };
