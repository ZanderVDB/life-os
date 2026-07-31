/**
 * Task dragging with a live insertion preview.
 *
 * WHY THIS IS NOT HTML5 DRAG-AND-DROP
 * The previous implementation used native `draggable`, which gave a destination
 * outline and nothing else. Native DnD cannot show an insertion gap honestly:
 * the browser paints its own drag image, the source element stays in the layout,
 * and `dragover` fires on a coarse cadence. It also does not fire at all on
 * touch, so there was no mobile path. Pointer events give one code path for
 * mouse, pen and touch, and full control over what the board does while the
 * pointer is down.
 *
 * HOW THE PREVIEW WORKS
 * On lift, the card is taken out of the flow into `position:fixed` at its exact
 * on-screen size, and a PLACEHOLDER of identical height takes its slot. From
 * then on the placeholder IS the proposed position — everything the user sees
 * is the real future layout, not an approximation. Moving the placeholder is
 * done inside a FLIP so the neighbours slide apart rather than jumping.
 *
 * WHY THE OLD FLIP WAS INVISIBLE
 * It only ran inside `moveTask`, after `rebuildBucket()` had already replaced
 * the bucket's innerHTML. Replacing markup destroys node identity, so FLIP's
 * "first" map keyed on data-id matched nothing and every card took the
 * new-to-the-view fade path instead of the move path. Here, no bucket markup is
 * ever replaced during a drag; the same nodes are moved.
 *
 * PERSISTENCE
 * Nothing is written while dragging. One save happens after the drop, from the
 * placeholder's final neighbours.
 */
import { reducedMotion } from './motion.js';

const LIFT_THRESHOLD = 5;      // px of movement before a drag begins
const TOUCH_HOLD = 180;        // ms of stillness before a touch becomes a drag
const EDGE = 72;               // px from the viewport edge that auto-scrolls
const EDGE_SPEED = 14;         // px per frame at the very edge

let session = null;

/**
 * @param {object} hooks
 *   getScrollRoot() -> the scrolling element
 *   onDrop(id, bucket, anchor) -> persist; anchor is {beforeTaskId} or {}
 */
export function initDrag(hooks) {
  document.addEventListener('pointerdown', (e) => onPointerDown(e, hooks), true);
}

function onPointerDown(e, hooks) {
  if (e.button != null && e.button !== 0) return;         // left button / touch only
  const card = e.target.closest?.('.task');
  if (!card || session) return;
  // Never hijack a control, a link, or a text selection inside the card.
  if (e.target.closest('button,a,input,textarea,select,[contenteditable]')) return;

  const start = { x: e.clientX, y: e.clientY };
  const isTouch = e.pointerType === 'touch';
  let armed = !isTouch;
  let holdTimer = null;

  if (isTouch) {
    // A touch must sit still briefly before it becomes a drag, or the board
    // cannot be scrolled with a finger.
    holdTimer = setTimeout(() => { armed = true; }, TOUCH_HOLD);
  }

  const move = (ev) => {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (!session) {
      if (!armed) {
        // Moved before the hold elapsed: this is a scroll, not a drag.
        if (Math.hypot(dx, dy) > LIFT_THRESHOLD) cleanup();
        return;
      }
      if (Math.hypot(dx, dy) < LIFT_THRESHOLD) return;
      begin(card, ev, hooks);
    }
    if (session) { ev.preventDefault(); drag(ev); }
  };

  const up = (ev) => {
    const had = !!session;
    if (had) { ev.preventDefault(); finish(hooks); }
    cleanup();
  };

  const cancel = () => { if (session) abort(); cleanup(); };

  function cleanup() {
    clearTimeout(holdTimer);
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('pointercancel', cancel, true);
  }

  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', cancel, true);
}

/* ── Lift ──────────────────────────────────────────────────────────────── */

function begin(card, e, hooks) {
  const rect = card.getBoundingClientRect();
  const from = card.closest('.drop');

  // The placeholder is the proposed position, made of real layout.
  const ph = document.createElement('div');
  ph.className = 'task-placeholder';
  ph.style.height = `${rect.height}px`;
  ph.dataset.placeholder = '1';

  session = {
    card,
    id: card.dataset.id,
    ph,
    fromBucket: from?.dataset.bucket ?? null,
    // Where the pointer sits inside the card, so it does not jump on lift.
    grabX: e.clientX - rect.left,
    grabY: e.clientY - rect.top,
    width: rect.width,
    height: rect.height,
    raf: 0,
    scrollRoot: hooks.getScrollRoot?.() ?? document.scrollingElement,
    lastY: e.clientY,
    lastX: e.clientX,
  };

  card.parentNode.insertBefore(ph, card);
  card.classList.add('is-dragging');
  card.style.width = `${rect.width}px`;
  card.style.height = `${rect.height}px`;
  card.style.position = 'fixed';
  card.style.left = '0';
  card.style.top = '0';
  card.style.zIndex = '400';
  card.style.pointerEvents = 'none';
  card.style.margin = '0';
  document.body.appendChild(card);
  document.body.classList.add('is-dragging-task');

  position(e.clientX, e.clientY);
  session.raf = requestAnimationFrame(tick);
}

function position(x, y) {
  const { card, grabX, grabY } = session;
  card.style.transform = `translate3d(${x - grabX}px, ${y - grabY}px, 0)`;
}

/* ── Move ──────────────────────────────────────────────────────────────── */

function drag(e) {
  session.lastX = e.clientX;
  session.lastY = e.clientY;
  position(e.clientX, e.clientY);
  updateInsertion(e.clientX, e.clientY);
}

/**
 * Chooses the drop zone under the pointer and the index within it, then moves
 * the placeholder there — inside a FLIP so the neighbours slide.
 *
 * Only cards actually in the DOM are considered. That is what keeps an active
 * Area filter honest: a hidden task is not in the list, so it can never be
 * chosen as an insertion anchor.
 */
function updateInsertion(x, y) {
  const zone = zoneAt(x, y);
  if (!zone) return;

  const cards = [...zone.querySelectorAll('.task')].filter((c) => c !== session.card);
  // The first card whose midpoint the pointer is above.
  const before = cards.find((c) => {
    const r = c.getBoundingClientRect();
    return y < r.top + r.height / 2;
  }) ?? null;

  const parentChanged = session.ph.parentNode !== zone;
  const nextSibling = session.ph.nextElementSibling;
  if (!parentChanged && nextSibling === before) return;   // nothing to do

  flipSiblings(() => {
    if (before) zone.insertBefore(session.ph, before);
    else zone.appendChild(session.ph);
    // An emptied bucket must not collapse its drop area away mid-drag.
    document.querySelectorAll('.drop').forEach((d) => {
      d.classList.toggle('is-empty', !d.querySelector('.task,.task-placeholder'));
    });

    // Buckets are not all the same width — Future spans the full row while the
    // other three share it. A card carried between them must take on the
    // destination's width, or it hangs over the edges and reads as not
    // belonging to the list it is about to join.
    //
    // Measured HERE, after the placeholder has landed and `.is-empty` has been
    // cleared: an empty drop zone carries a 1.5px dashed border, so measuring
    // it first reported a width 3px short. The resulting placeholder height
    // change is part of this same FLIP, so the cards below it slide rather
    // than jump.
    if (parentChanged) adoptWidth(zone);
  });
}

/**
 * Resizes the lifted card to the destination bucket's width, and the
 * placeholder to whatever height the card becomes at that width — a long title
 * wraps to two lines in a narrow bucket and one in a wide one, so the gap has
 * to follow the card, not the other way round.
 *
 * The grab point is kept proportional, so a card that shrinks does not jump out
 * from under the pointer.
 */
function adoptWidth(zone) {
  const width = zone.clientWidth;
  if (!width || Math.abs(width - session.width) < 1) return;

  const ratio = session.width ? session.grabX / session.width : 0.5;
  session.width = width;
  session.grabX = Math.min(width - 8, ratio * width);

  const card = session.card;
  card.style.width = `${width}px`;
  // Let the card reflow at its new width before measuring the height it needs.
  card.style.height = 'auto';
  const h = card.getBoundingClientRect().height;
  card.style.height = `${h}px`;
  session.height = h;
  session.ph.style.height = `${h}px`;

  position(session.lastX, session.lastY);
}

/** Finds the .drop under the pointer, tolerating small gaps between buckets. */
function zoneAt(x, y) {
  const zones = [...document.querySelectorAll('.drop')];
  let best = null;
  let bestDist = Infinity;
  for (const z of zones) {
    const r = z.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return z;
    // Nearest by vertical distance, so the gap between two buckets still
    // resolves to one of them rather than dropping the preview entirely.
    if (x >= r.left - 40 && x <= r.right + 40) {
      const d = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
      if (d < bestDist) { bestDist = d; best = z; }
    }
  }
  return bestDist < 120 ? best : null;
}

/**
 * FLIP over every card on the board — measure, mutate, invert, play.
 * The dragged card is excluded: it is following the pointer, not the layout.
 */
function flipSiblings(mutate) {
  const nodes = [...document.querySelectorAll('.task')].filter((c) => c !== session.card);
  if (reducedMotion()) { mutate(); return; }

  const first = new Map();
  for (const el of nodes) first.set(el, el.getBoundingClientRect());

  mutate();

  for (const el of nodes) {
    const prev = first.get(el);
    const now = el.getBoundingClientRect();
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    // Cancel any in-flight move so a fast drag does not queue animations.
    el.getAnimations().forEach((a) => { if (a.id === 'flip') a.cancel(); });
    const anim = el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' },
    );
    anim.id = 'flip';
  }
}

/* ── Auto-scroll ───────────────────────────────────────────────────────── */

function tick() {
  if (!session) return;
  const y = session.lastY;
  const root = session.scrollRoot;
  if (root) {
    const r = root === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight }
      : root.getBoundingClientRect();
    let dy = 0;
    if (y < r.top + EDGE) dy = -EDGE_SPEED * (1 - (y - r.top) / EDGE);
    else if (y > r.bottom - EDGE) dy = EDGE_SPEED * (1 - (r.bottom - y) / EDGE);
    if (dy) {
      root.scrollTop += dy;
      updateInsertion(session.lastX, y);
    }
  }
  session.raf = requestAnimationFrame(tick);
}

/* ── Drop ──────────────────────────────────────────────────────────────── */

function finish(hooks) {
  const s = session;
  cancelAnimationFrame(s.raf);

  const zone = s.ph.closest('.drop');
  const bucket = zone?.dataset.bucket ?? s.fromBucket;
  const nextCard = nextTaskAfter(s.ph);
  const anchor = nextCard ? { beforeTaskId: nextCard.dataset.id } : {};

  // Land the card exactly where the placeholder is. Because the placeholder
  // already holds that slot, there is no second reorganisation on release.
  const target = s.ph.getBoundingClientRect();
  const cur = s.card.getBoundingClientRect();

  restoreCard(s);
  s.ph.replaceWith(s.card);

  if (!reducedMotion()) {
    const dx = cur.left - target.left;
    const dy = cur.top - target.top;
    s.card.animate(
      [{ transform: `translate(${dx}px, ${dy}px)`, boxShadow: 'var(--e3)' },
        { transform: 'none', boxShadow: 'none' }],
      { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' },
    );
  }

  document.body.classList.remove('is-dragging-task');
  session = null;

  // One write, after the drop. Never during.
  hooks.onDrop(s.id, bucket, anchor);
}

/** The next real task after the placeholder — never a hidden or dragged one. */
function nextTaskAfter(ph) {
  let n = ph.nextElementSibling;
  while (n && !n.classList.contains('task')) n = n.nextElementSibling;
  return n && n !== session?.card ? n : null;
}

function restoreCard(s) {
  const c = s.card;
  c.classList.remove('is-dragging');
  for (const p of ['width', 'height', 'position', 'left', 'top', 'zIndex',
    'pointerEvents', 'margin', 'transform']) c.style[p] = '';
}

/** Pointer cancelled (a system gesture, a context menu): put everything back. */
function abort() {
  const s = session;
  cancelAnimationFrame(s.raf);
  restoreCard(s);
  s.ph.replaceWith(s.card);
  document.body.classList.remove('is-dragging-task');
  document.querySelectorAll('.drop').forEach((d) => {
    d.classList.toggle('is-empty', !d.querySelector('.task'));
  });
  session = null;
}

/** True while a drag is in flight — callers must not rebuild the board. */
export const isDragging = () => !!session;
