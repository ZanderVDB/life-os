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
import { settle, reducedMotion } from './motion.js';

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
  /*
   * And never start a drag from inside the steps panel.
   *
   * A step is not a task. Pressing on the empty space beside a step name and
   * moving would otherwise lift the whole parent card out from under the
   * pointer, which reads as the step being dragged — the one interpretation
   * that must never be available. The row above the panel still drags, and so
   * does the grip.
   */
  if (e.target.closest('.t-steps')) return;

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

/* ── Drag geometry ─────────────────────────────────────────────────────
 *
 * `.bucket.future` is `grid-column: 1/-1`, so a Future task rests at two or
 * three times the width of one in Today, This Week or This Month.
 *
 * Lifting it at its RESTING width made the floating card cover the neighbouring
 * buckets and hide the very thing the drag is for — you could not see where the
 * card was going, because the card was on top of it. It also hid the TASKS and
 * PROJECTS partition previews.
 *
 * So the drag visual is always the COMPACT width, whatever it was resting at.
 */

/** The narrowest drop zone on the board — the standard upper-bucket column. */
function compactZoneWidth() {
  const zones = [...document.querySelectorAll('.drop[data-bucket]')]
    .filter((z) => z.dataset.bucket !== 'project' && z.clientWidth > 0);
  if (!zones.length) return null;
  return Math.min(...zones.map((z) => z.clientWidth));
}

/**
 * The width the dragged card uses for the WHOLE gesture.
 *
 * Measured once, at lift, and never changed again. Resizing per-bucket as the
 * pointer crossed a boundary would make the card breathe, which reads as a
 * glitch rather than as feedback — and the addendum asks explicitly for one
 * stable geometry.
 *
 * On a narrow screen every bucket is the same width, so this returns the card's
 * own width and nothing changes.
 */
function dragWidth(card) {
  const own = card.getBoundingClientRect().width;
  const compact = compactZoneWidth();
  return compact ? Math.min(own, compact) : own;
}

/* ── Lift ──────────────────────────────────────────────────────────────── */

function begin(card, e, hooks) {
  /*
   * Collapse the step panel BEFORE measuring.
   *
   * A task with four steps expanded is three times the height of its
   * neighbours, so dragging it would open a placeholder gap nothing else could
   * fill and make the insertion point read as wrong. Collapsing first means the
   * card, the placeholder and every sibling are the same shape, which is what
   * makes the gap honest.
   *
   * The steps are HIDDEN, never detached: the panel is inside the article, so
   * it travels with its parent and no step row can be left behind or become an
   * insertion target of its own. Expansion is restored on drop.
   */
  const panel = card.querySelector('.t-steps');
  const wasExpanded = panel && !panel.hidden;
  if (wasExpanded) panel.hidden = true;

  const rect = card.getBoundingClientRect();
  const from = card.closest('.drop');

  /* The compact drag width, and the height the card will actually BE at that
   * width. A Future card is wide and short; the same words in a column wrap and
   * are taller, so measuring the gap from the resting rect would open a
   * placeholder too small for what is about to land in it. */
  const width = dragWidth(card);
  let height = rect.height;
  if (width < rect.width) {
    const prev = card.style.width;
    card.style.width = `${width}px`;
    height = card.getBoundingClientRect().height;
    card.style.width = prev;
  }

  // The placeholder is the proposed position, made of real layout.
  const ph = document.createElement('div');
  ph.className = 'task-placeholder';
  ph.style.height = `${height}px`;
  ph.dataset.placeholder = '1';

  session = {
    card,
    id: card.dataset.id,
    // Which half of the bucket this card belongs to. Fixed at lift, because it
    // is a property of the TASK, not of wherever the pointer currently is.
    kind: sectionOf(card),
    ph,
    fromBucket: from?.dataset.bucket ?? null,
    // Where the pointer sits inside the card, so it does not jump on lift.
    /* Clamped to the compact width, so a wide Future card does not leave the
     * pointer holding empty space where the card used to extend. */
    grabX: Math.min(e.clientX - rect.left, width - 24),
    grabY: e.clientY - rect.top,
    width,
    height,
    /** The resting width, so a cancel can put it back exactly. */
    restWidth: rect.width,
    raf: 0,
    scrollRoot: hooks.getScrollRoot?.() ?? document.scrollingElement,
    lastY: e.clientY,
    lastX: e.clientX,
    wasExpanded,
  };

  card.parentNode.insertBefore(ph, card);
  card.classList.add('is-dragging');
  card.style.width = `${width}px`;
  card.style.height = `${height}px`;
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
/**
 * Which subsection a card sits in: 'project' when it belongs to one, else
 * 'standalone'.
 *
 * Read from the card's own markup rather than by walking the DOM to the nearest
 * heading — the heading is a sibling, so "the section above me" changes as the
 * placeholder moves, and a rule that shifts mid-drag is not a rule.
 */
function sectionOf(card) {
  return card.dataset.project ? 'project' : 'standalone';
}

/**
 * Where a partition BEGINS in a zone that has none of its cards yet.
 *
 * This is the fix for the reported regression. `updateInsertion` filters
 * candidates to the dragged card's own kind, which is what stops a standalone
 * task being dropped among project rows. But when the target bucket holds only
 * project work, that filter leaves NO candidates — and the code fell through to
 * `zone.appendChild(ph)`, which put the standalone task after every project
 * row. Exactly the bucket where the boundary matters most was the one where it
 * was not applied.
 *
 * Standalone work comes first, so an empty standalone partition begins before
 * the first project row (or its heading). Project work comes last, so an empty
 * project partition begins at the end. Returning `null` means "the end", which
 * is what `insertBefore` already does with a null reference.
 */
function partitionAnchor(zone, kind) {
  if (kind !== 'standalone') return null;
  const head = zone.querySelector('.sub-head[data-sub="projects"]');
  if (head) return head;
  return [...zone.querySelectorAll('.task')].find((c) => sectionOf(c) === 'project') ?? null;
}

/**
 * Shows the headings the drop would produce, while it is still a proposal.
 *
 * The placeholder is the real future layout — that is the whole premise of this
 * drag. A standalone task landing in a project-only bucket will create a TASKS
 * heading, so the heading has to appear during the drag, above the placeholder,
 * or the preview is lying about where the card is going.
 *
 * Previews are marked and swept, so nothing survives a cancelled drag.
 */
function syncPartitionHeads() {
  document.querySelectorAll('[data-ph-head]').forEach((el) => el.remove());
  const ph = session.ph;
  const zone = ph?.parentNode;
  if (!zone || !zone.classList?.contains('drop')) return;

  const kinds = (sel) => [...zone.querySelectorAll('.task')]
    .filter((c) => c !== session.card && sectionOf(c) === sel);
  const standalone = kinds('standalone');
  const project = kinds('project');
  const withPh = {
    standalone: standalone.length + (session.kind === 'standalone' ? 1 : 0),
    project: project.length + (session.kind === 'project' ? 1 : 0),
  };
  // Same adaptive rule the rendered bucket uses: a heading that separates one
  // thing from nothing is noise.
  if (!withPh.standalone || !withPh.project) return;

  const head = (id, label) => {
    const el = document.createElement('div');
    el.className = 'sub-head';
    el.dataset.sub = id;
    el.dataset.phHead = '1';
    el.setAttribute('role', 'presentation');
    el.textContent = label;
    return el;
  };

  if (!zone.querySelector('.sub-head[data-sub="tasks"]')) {
    const first = [...zone.children].find((c) =>
      (c.classList.contains('task') && sectionOf(c) === 'standalone') || c === ph);
    if (first) zone.insertBefore(head('tasks', 'Tasks'), first);
  }
  if (!zone.querySelector('.sub-head[data-sub="projects"]')) {
    const firstProject = project[0] ?? (session.kind === 'project' ? ph : null);
    if (firstProject) zone.insertBefore(head('projects', 'Projects'), firstProject);
  }
}

function updateInsertion(x, y) {
  const zone = zoneAt(x, y);
  if (!zone) return;

  /* Only cards in the SAME subsection are candidates.
   *
   * Today splits each bucket into standalone work and project work. Dropping a
   * standalone task among the project rows would claim it had joined a project,
   * and dropping a project task among the standalone ones would claim it had
   * left — neither of which a drag is allowed to decide. Project membership is
   * changed in the task editor, deliberately, and never as a side effect of
   * where a card was released.
   *
   * Filtering the CANDIDATES rather than rejecting the drop is what produces
   * the boundary: the placeholder simply stops at the edge of the section, so
   * the gap shows the user where the task can actually go instead of appearing
   * somewhere it will not stay.
   */
  const kind = session.kind;
  const cards = [...zone.querySelectorAll('.task')]
    .filter((c) => c !== session.card && sectionOf(c) === kind);

  // The first card whose midpoint the pointer is above.
  const before = cards.find((c) => {
    const r = c.getBoundingClientRect();
    return y < r.top + r.height / 2;
  }) ?? null;

  /* No cards of this kind here yet. The placeholder still has a correct home —
   * the START of its own partition — and appending to the zone instead is what
   * put a standalone task below every project row. */
  if (!cards.length) {
    const anchor = partitionAnchor(zone, kind);
    if (session.ph.parentNode !== zone || session.ph.nextElementSibling !== anchor) {
      flipSiblings(() => {
        if (anchor) zone.insertBefore(session.ph, anchor);
        else zone.appendChild(session.ph);
        syncPartitionHeads();
        document.querySelectorAll('.drop').forEach((d) => {
          d.classList.toggle('is-empty', !d.querySelector('.task,.task-placeholder'));
        });
      });
    }
    return;
  }

  /* Past the last card of this section, the placeholder goes after it — not at
   * the end of the whole zone, which would put it inside the other section. */
  if (!before && cards.length) {
    const last = cards[cards.length - 1];
    if (last.nextElementSibling !== session.ph) {
      flipSiblings(() => { last.after(session.ph); syncPartitionHeads(); });
    }
    return;
  }

  const parentChanged = session.ph.parentNode !== zone;
  const nextSibling = session.ph.nextElementSibling;
  if (!parentChanged && nextSibling === before) return;   // nothing to do

  flipSiblings(() => {
    if (before) zone.insertBefore(session.ph, before);
    else zone.appendChild(session.ph);
    syncPartitionHeads();
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
    /* The card keeps ONE width for the whole gesture. It used to adopt each
     * destination bucket's width here, which made it breathe as the pointer
     * crossed boundaries and — when a measurement was stale — left it at the
     * wrong one. Only the placeholder follows the destination now. */
    if (parentChanged) adoptGap(zone);
  });
}

/**
 * Resizes the PLACEHOLDER to the gap this card will actually need here.
 *
 * A long title wraps to two lines in a narrow bucket and one in a wide one, so
 * the gap has to follow the destination. The dragged CARD does not: it keeps
 * the compact width it was lifted at, for the whole gesture. Resizing the card
 * per bucket made it breathe as the pointer crossed boundaries, and a Future
 * card that adopted the full-row width covered the buckets either side of the
 * one being aimed at.
 *
 * Measured on the card at the destination width and then put straight back, so
 * nothing the user sees flickers.
 */
function adoptGap(zone) {
  const width = zone.clientWidth;
  if (!width) return;
  const card = session.card;
  const prevW = card.style.width;
  const prevH = card.style.height;
  card.style.width = `${width}px`;
  card.style.height = 'auto';
  const h = card.getBoundingClientRect().height;
  card.style.width = prevW;
  card.style.height = prevH;
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

/**
 * Did the list get rebuilt underneath us?
 *
 * The dragged card lives on `document.body` while a drag is in flight, so
 * anything that replaces the list's innerHTML destroys the PLACEHOLDER but
 * leaves the card floating — and the rebuilt list renders a fresh row for the
 * same task. Two nodes, one id. `replaceWith` on a detached placeholder is a
 * silent no-op, so the ghost then survives the drop as well.
 *
 * Rather than trusting callers never to do that, the drag detects it and cleans
 * up after itself.
 */
const orphaned = (s) => !s.ph.isConnected;

/**
 * Any OTHER live node claiming this task's id.
 *
 * A rebuild mid-drag creates exactly this: the dragged card is on
 * `document.body`, so the fresh list renders a second row for the same task.
 * Checking `orphaned` alone is not enough — the very next `pointermove` moves
 * the placeholder into the NEW list, so by drop time it is connected again and
 * the dragged card lands beside its own twin.
 *
 * Whichever way the drop resolves, exactly one node may survive.
 */
function strayTwin(s) {
  return [...document.querySelectorAll(`.drop .task[data-id="${s.id}"]`)]
    .find((n) => n !== s.card) ?? null;
}

/**
 * Gets rid of the floating card without leaving a duplicate behind.
 *
 * If the rebuilt list already contains a row for this task, the dragged node is
 * simply removed — the fresh row is the real one. If it does not, the card is
 * put back so the task cannot vanish.
 */
function reclaimOrphan(s) {
  restoreCard(s);
  const live = document.querySelector(`.drop .task[data-id="${s.id}"]`);
  if (live && live !== s.card) s.card.remove();
  else document.querySelector('.drop')?.appendChild(s.card);
  s.ph.remove();
  document.querySelectorAll('[data-ph-head]').forEach((el) => el.remove());
  document.body.classList.remove('is-dragging-task');
  session = null;
}

function finish(hooks) {
  const s = session;
  cancelAnimationFrame(s.raf);
  /* Preview headings are a proposal, not layout. They go before anything is
   * committed, so a cancelled drag leaves nothing behind and the re-render
   * that follows a drop decides the real headings from the real data. */
  document.querySelectorAll('[data-ph-head]').forEach((el) => el.remove());

  // The list was replaced mid-drag. Drop the gesture rather than writing an
  // order derived from a placeholder that is no longer in the document.
  if (orphaned(s)) { reclaimOrphan(s); return; }

  const zone = s.ph.closest('.drop');
  const bucket = zone?.dataset.bucket ?? s.fromBucket;
  const nextCard = nextTaskAfter(s.ph);
  const anchor = nextCard ? { beforeTaskId: nextCard.dataset.id } : {};

  // Land the card exactly where the placeholder is. Because the placeholder
  // already holds that slot, there is no second reorganisation on release.
  const target = s.ph.getBoundingClientRect();
  const cur = s.card.getBoundingClientRect();

  // The dragged card is the one the user has been positioning, so it wins and
  // any twin the rebuild left behind goes.
  const twin = strayTwin(s);
  restoreCard(s);
  s.ph.replaceWith(s.card);
  twin?.remove();

  if (!reducedMotion()) {
    const dx = cur.left - target.left;
    const dy = cur.top - target.top;
    s.card.animate(
      [{ transform: `translate(${dx}px, ${dy}px)`, boxShadow: 'var(--e3)' },
        { transform: 'none', boxShadow: 'none' }],
      { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' },
    );
    /* Dropped into Future, which is full width.
     *
     * It SETTLES first and widens after — never while still floating over
     * Future before release, which would make the card cover the buckets
     * either side at the exact moment the person is aiming. The card is already
     * in its final slot here, so this animates a width it has genuinely
     * reached, not a guess. */
    const landed = s.card.getBoundingClientRect().width;
    if (landed > s.width + 1) {
      const grow = s.card.animate(
        [{ width: `${s.width}px` }, { width: `${landed}px` }],
        { duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)' },
      );
      /* CANCELLED on a guaranteed timer, not merely left to finish.
       *
       * A running animation overrides the computed width, so an animation that
       * never completes — a backgrounded tab, a throttled timeline — would hold
       * the card at the compact width for ever, in a bucket where it should be
       * full width. Cancelling drops the effect and returns the card to its own
       * layout whatever happened. The card's real width is never the
       * animation's to decide; the animation only paints the journey. */
      settle(grow, 260, () => grow.cancel());
    }
  }

  document.body.classList.remove('is-dragging-task');
  session = null;

  // One write, after the drop. Never during.
  hooks.onDrop(s.id, bucket, anchor);
  /* The rows have landed. Which DIVIDERS still earn their place is a separate
   * question — a bucket that just gained its first standalone task needs a
   * TASKS heading, and the one that lost its last needs its heading gone. */
  hooks.onSettled?.();
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
  /* EVERY temporary value, on every teardown path — drop, cancel and orphan
   * reclaim all come through here. A stale inline width is the one that would
   * survive invisibly: the card would look right in the bucket it landed in and
   * wrong the moment the board reflowed. */
  for (const p of ['width', 'height', 'position', 'left', 'top', 'zIndex',
    'pointerEvents', 'margin', 'transform']) c.style[p] = '';
  // The steps come back exactly as they were. A drag is a reorder, and a
  // reorder must not quietly close something the user opened.
  if (s.wasExpanded) {
    const panel = c.querySelector('.t-steps');
    if (panel) panel.hidden = false;
  }
}

/** Pointer cancelled (a system gesture, a context menu): put everything back. */
function abort() {
  const s = session;
  cancelAnimationFrame(s.raf);
  if (orphaned(s)) { reclaimOrphan(s); return; }
  const twin = strayTwin(s);
  restoreCard(s);
  s.ph.replaceWith(s.card);
  twin?.remove();
  document.body.classList.remove('is-dragging-task');
  document.querySelectorAll('.drop').forEach((d) => {
    d.classList.toggle('is-empty', !d.querySelector('.task'));
  });
  session = null;
}

/** True while a drag is in flight — callers must not rebuild the board. */
export const isDragging = () => !!session;
