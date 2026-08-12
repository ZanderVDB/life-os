/**
 * THE BOOK — one box, four resting finishes, five pulled treatments (L3.5).
 *
 * ── The box (§12) ─────────────────────────────────────────────────────────
 *
 * A closed hardcover is a solid, and the lab now builds it as one. Four faces,
 * in the box's own local frame, with the spine facing you at rest:
 *
 *     back board    x = 0        the far board once it has turned
 *     spine         z = 0        what you see on the shelf
 *     front cover   x = t        the board that comes toward you
 *     fore-edge     z = −126     the page block, opposite the spine
 *
 * Rotating the box by −90° about its left edge brings the front cover to face
 * you at z = +t, with the back board behind it at z = 0, the spine edge-on at
 * the hinge and the page block edge-on at the far side. That is a real turned
 * book rather than a picture of one, and it is why the pulled state can keep
 * spine, boards and page block visible at the same time.
 *
 * ── The bug this construction fixes (§14) ─────────────────────────────────
 *
 * C2 placed the page block with `left: 126px`. `left` is a LAYOUT offset, and
 * the box's rotation maps layout-x into Z — so 126px of layout became 126px of
 * depth *toward the viewer*, and perspective then threw the face sideways.
 * Measured: the page block of a turned Book rendered at x 432–439 while its own
 * slot was 458–590, i.e. 26px over its left neighbour, which it then swallowed
 * for pointer input. The page block had been on the wrong side of the Book the
 * whole time; it was only ever 10px wide, so nobody saw it.
 *
 * Depth is now expressed with `translateZ`, which is what it is.
 *
 * ── The hit rule ──────────────────────────────────────────────────────────
 *
 * Faces never take pointer input. The click target is `.cb-vol`, which is
 * untransformed and exactly fills its slot, and the slot is widened to the
 * Book's projected width when it turns. So a Book's hit area is always exactly
 * the space it occupies on the shelf, in every state and at every angle — and
 * that is a property a test can check with `elementFromPoint` rather than an
 * arrangement of z-indexes that has to be re-argued each time.
 */

import { esc, spineTitle } from './lab-data.js';
import { bookCoverHtml } from './shared-cover.js';
import { bookHeight, bookThickness, turnedWidth, COVER_W } from './book-physics.js';

/* ── §3  Resting finishes ─────────────────────────────────────────────────
 *
 * All four stay spine-first, compact, physical and modern. What is being
 * chosen is the LEVEL OF PHYSICAL DETAIL, not a different kind of object.
 */
export const RESTING = [
  { id: 'a', label: 'A', name: 'Cloth hardback',
    note: 'Fine cloth grain, two subtle bands, a thin foil rule, matte throughout.' },
  { id: 'b', label: 'B', name: 'Modern matte',
    note: 'Very clean. Stronger typography, a whisper of grain, one line of detail.' },
  { id: 'c', label: 'C', name: 'Archival',
    note: 'Binding ridges, a muted label plate, slightly more tactile edges.' },
  { id: 'd', label: 'D', name: 'Premium notebook',
    note: 'Refined edges, minimal debossing, softer corners. Still bound, never a card.' },
];

/* ── §6–§11  Pulled treatments ────────────────────────────────────────────
 *
 * `deg` is the turn. None of them is 90°, because at exactly 90° the cover is
 * axis-aligned and the Book stops being a solid — which is the criticism this
 * whole component exists to answer.
 */
export const PULLED = [
  { id: 'a', label: 'A', name: 'True hinged turn', deg: 82,
    note: 'Out of the row and round on the spine. Stops short of flat: spine still attached on one side, page block on the other.' },
  { id: 'b', label: 'B', name: 'Three-quarter', deg: 62,
    note: 'Front cover, spine and page block all at once. The most obviously solid, the least readable cover.' },
  { id: 'c', label: 'C', name: 'Pull and part', deg: 72,
    note: 'Turned, then the front board lifts 12°. Enough to say bound. No interior.' },
  { id: 'd', label: 'D', name: 'Forward display', deg: 70,
    note: 'Leaves the row toward you and tips 2° from above, like a display copy.' },
  { id: 'e', label: 'E', name: 'Shelf resting turn', deg: 52,
    note: 'Pivots on its bottom corner with the base still on the ledge. Someone pulled one edge.' },
];

/**
 * The width a slot reserves for a Book in a given state.
 *
 * At rest it is the thickness. Turned, it is the cover's projected width, so
 * the visible Book still fits inside its own slot and neighbours slide clear
 * rather than being overlapped. D leaves the row, so it is given a little more.
 */
export function slotWidth(variant, thickness, turned) {
  if (!turned) return thickness;
  const v = PULLED.find((p) => p.id === variant) ?? PULLED[0];
  return turnedWidth(v.deg, thickness) + (v.id === 'd' ? 14 : 0);
}

/**
 * One volume.
 *
 * `--t` thickness, `--h` height, `--w` the cover width, `--sq` the square: the
 * few pixels a hardcover board overhangs its page block on every edge. The
 * square is small and it is the difference between boards and a wrapper.
 */
export function volume(b, i, n) {
  const h = bookHeight(b.id);
  const t = bookThickness(b.pages, b.id);
  return `<li class="cb-slot" style="--t:${t}px;--h:${h}px" data-t="${t}">
    <article class="cb-vol${b.system ? ' is-system' : ''}" data-obj="${esc(b.id)}"
      data-accent="${esc(b.accent)}" role="button" tabindex="0" aria-expanded="false"
      aria-label="${esc(b.title)}, Book, ${i + 1} of ${n}, spine view"
      title="${esc(b.title)}">
      <span class="cb-box">
        <span class="cb-face cb-board cb-back"></span>
        <span class="cb-face cb-edge"><span class="cb-pages"></span></span>
        <span class="cb-face cb-spine">
          <span class="cb-band cb-band-h"></span>
          <span class="cb-rule"></span>
          <span class="cb-spine-t">${esc(spineTitle(b.title, 22))}</span>
          <span class="cb-plate">${b.system ? '✦' : String(b.year).slice(2)}</span>
          <span class="cb-band cb-band-t"></span>
        </span>
        <span class="cb-face cb-board cb-front">
          ${bookCoverHtml(b, 'cb-cover')}
          <span class="cb-open" data-open>Open</span>
        </span>
      </span>
    </article>
  </li>`;
}

/** A row of Books, ready for `bay()`. */
export const bookRow = (books) => books.map((b, i) => volume(b, i, books.length)).join('');

export { COVER_W };
