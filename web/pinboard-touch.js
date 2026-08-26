/**
 * The Pinboard, under a thumb.
 *
 * ── Why a Pinboard does not reflow ───────────────────────────────────────
 *
 * Everything else on a phone reflows, because everything else is SEMANTIC:
 * a task list means the same thing in one column as in three. A Pinboard is
 * not. Where a thing sits IS the content — the three links clustered in the
 * corner are clustered because they belong together, and nobody wrote that
 * down anywhere else. Flattening a board into a list would destroy the only
 * copy of that thought.
 *
 * So the board keeps its geometry and the SCREEN moves over it. §33.
 *
 * ── How it works with the board that already exists ──────────────────────
 *
 * pinboard.js positions everything in PERCENTAGES of the board's own box, and
 * computes drags from `board.getBoundingClientRect()`. A CSS transform scales
 * that rect, so every existing calculation stays correct under zoom with no
 * changes at all: a pin dropped at 40% of a board that is drawn at 2× is
 * still at 40%. Nothing here reaches into the board's model.
 *
 * ── The three gestures, and how they are told apart ──────────────────────
 *
 *   two fingers            -> zoom, always, whatever is under them
 *   one finger on empty    -> pan
 *   one finger on an object-> the board's own drag (this never sees it)
 *
 * The last one is the important one. §34: an object drag and a canvas pan
 * start with exactly the same event, and the only difference is what is
 * underneath. So this checks, and gets out of the way — a board where
 * dragging a note pans the canvas instead is a board nobody can arrange.
 */

const MIN = 0.35;
const MAX = 3;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * @param {HTMLElement} host   the scroll-free viewport
 * @param {HTMLElement} board  the board itself, transformed inside it
 * @returns {{ destroy: () => void, fit: () => void }}
 */
export function attachPinViewport(host, board) {
  let k = 1;
  let x = 0;
  let y = 0;
  const pointers = new Map();
  let panFrom = null;
  let pinchFrom = null;

  /* The zoom controls sit BESIDE the viewport, not inside it, so they are
     looked up from the page rather than from the host. */
  const ctl = host.closest('.bk-l-pinboard') ?? host;

  const apply = () => {
    board.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${k.toFixed(3)})`;
    const label = ctl.querySelector('[data-pin-zoom]');
    if (label) label.textContent = `${Math.round(k * 100)}%`;
  };

  /** The whole board, centred, with a little air. */
  const fit = () => {
    const h = host.getBoundingClientRect();
    const w = board.offsetWidth;
    const ht = board.offsetHeight;
    if (!w || !ht || !h.width) return;
    k = clamp(Math.min((h.width - 16) / w, (h.height - 16) / ht), MIN, 1);
    x = (h.width - w * k) / 2;
    y = (h.height - ht * k) / 2;
    apply();
  };

  /* Keeps the point under the fingers under the fingers. Zooming about the
   * centre of the screen instead moves whatever you were looking at away from
   * you, which is the single thing that makes a pinch feel wrong. */
  const zoomAbout = (cx, cy, next) => {
    const r = host.getBoundingClientRect();
    const px = cx - r.left;
    const py = cy - r.top;
    const before = clamp(next, MIN, MAX);
    x = px - ((px - x) * before) / k;
    y = py - ((py - y) * before) / k;
    k = before;
    apply();
  };

  const onDown = (e) => {
    if (e.pointerType === 'mouse') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      // A second finger turns whatever was happening into a zoom.
      panFrom = null;
      const [a, b] = [...pointers.values()];
      pinchFrom = {
        d: Math.hypot(a.x - b.x, a.y - b.y),
        k,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
      return;
    }

    /* §34, the whole of it. An object under the finger belongs to the board's
     * own drag; empty canvas belongs to the pan. Anything interactive — a
     * note being typed into, a link, the tool bar — belongs to itself. */
    if (e.target.closest('[data-pin],[data-wire],[data-pin-bar],[data-pin-sheet],'
      + '[data-group-frame],[data-pin-text],[data-pin-caption],a,button,input')) return;
    panFrom = { x: e.clientX, y: e.clientY, ox: x, oy: y };
  };

  const onMove = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinchFrom && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchFrom.d > 0) {
        zoomAbout((a.x + b.x) / 2, (a.y + b.y) / 2, (pinchFrom.k * d) / pinchFrom.d);
      }
      e.preventDefault();
      return;
    }
    if (!panFrom) return;
    x = panFrom.ox + (e.clientX - panFrom.x);
    y = panFrom.oy + (e.clientY - panFrom.y);
    apply();
    e.preventDefault();
  };

  const onUp = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchFrom = null;
    if (pointers.size === 0) panFrom = null;
  };

  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointermove', onMove, { passive: false });
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onUp);

  /* A trackpad and a mouse wheel are not gestures this is for, but a laptop
   * looking at a phone layout should still be able to move around. */
  host.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomAbout(e.clientX, e.clientY, k * (1 - e.deltaY / 400));
  }, { passive: false });

  ctl.querySelector('[data-pin-fit]')?.addEventListener('click', fit);
  ctl.querySelector('[data-pin-in]')?.addEventListener('click', () => {
    const r = host.getBoundingClientRect();
    zoomAbout(r.left + r.width / 2, r.top + r.height / 2, k * 1.25);
  });
  ctl.querySelector('[data-pin-out]')?.addEventListener('click', () => {
    const r = host.getBoundingClientRect();
    zoomAbout(r.left + r.width / 2, r.top + r.height / 2, k / 1.25);
  });

  /* Fitted from a ResizeObserver, not from requestAnimationFrame.
   *
   * The board is mounted before the page it is on has been laid out, so the
   * host has no size yet and there is nothing to fit into. A single rAF was
   * the obvious answer and it is the wrong one: rAF does not fire in a tab
   * that is not compositing — a background tab, a hidden page, a headless
   * viewport — and the board would then sit at 100% with its right-hand half
   * off the screen, permanently, until somebody resized something.
   *
   * A ResizeObserver fires on the first real layout whatever the tab is
   * doing, and it also handles rotation for free. `fitted` keeps it to the
   * first one, so a keyboard opening does not throw away a zoom somebody
   * chose. */
  let fitted = false;
  const ro = new ResizeObserver(() => {
    if (fitted || !host.clientWidth) return;
    fitted = true;
    fit();
  });
  ro.observe(host);
  fit();

  return {
    fit,
    destroy() {
      ro.disconnect();
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onUp);
    },
  };
}

/** The controls, in a row under the canvas. Buttons, because §34 is not enough. */
export const pinViewportControlsHtml = () => `<div class="pin-ctl">
  <button type="button" class="pin-ctl-b" data-pin-out aria-label="Zoom out">&minus;</button>
  <span class="pin-ctl-z" data-pin-zoom aria-live="polite">100%</span>
  <button type="button" class="pin-ctl-b" data-pin-in aria-label="Zoom in">+</button>
  <button type="button" class="pin-ctl-b pin-ctl-fit" data-pin-fit>Fit</button>
</div>`;
