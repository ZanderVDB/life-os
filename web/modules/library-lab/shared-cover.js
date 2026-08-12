/**
 * THE BOOK COVER — one renderer, one identity (L3.4 §10/§35).
 *
 * The cover a Book shows on the shelf and the cover it shows when it opens must
 * be the same object. Until now they were two implementations: `coverHtml()` in
 * `library-book.js` for the Book view, and a separate shelf cover in the
 * Library. Two implementations of one identity is two things to keep in step,
 * and they had already drifted.
 *
 * This module emits the Book view's OWN markup — the same elements, the same
 * class names, in the same order — so the design lives in one place:
 *
 *     bk-cover-mark      Life OS
 *     bk-cover-pre       NOTEBOOK
 *     bk-cover-title     the title
 *     bk-cover-sub       the subtitle, when there is one
 *     bk-cover-rule      the divider
 *     bk-cover-author    author · year
 *
 * Because the classes are the real ones, the cover inherits the real
 * typography, the real accent edge and the real paper. Only SCALE differs, and
 * scale is expressed as one variable (`--cv`) rather than as a second set of
 * font sizes — see `.c2-cover` in lab.css.
 *
 * L3.4 does not change the Book view. When C2 is adopted, the real Library
 * should import this function rather than the reverse: the Book view keeps
 * owning the design, and everything else renders it.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {{title:string, sub?:string|null, author?:string, year?:number,
 *          accent?:string, system?:boolean}} b
 * @param {string} cls extra classes for the wrapper
 */
export function bookCoverHtml(b, cls = '') {
  return `<span class="bk-cover c2-cover ${cls}" data-accent="${esc(b.accent ?? 'peach')}">
    <span class="bk-cover-mark">Life OS</span>
    <span class="bk-cover-pre">${b.system ? 'Journal' : 'Notebook'}</span>
    <span class="bk-cover-title">${esc(b.title)}</span>
    ${b.sub ? `<span class="bk-cover-sub">${esc(b.sub)}</span>` : ''}
    <span class="bk-cover-rule"></span>
    <span class="bk-cover-author">${esc(b.author || 'Life OS')} · ${esc(b.year ?? '')}</span>
  </span>`;
}

/**
 * THE PHYSICAL RULES — deterministic, from the book's own identity and content.
 *
 * Both are pure functions of the book, so the same book is the same size on
 * every render. §7 is explicit that height must not be re-randomised, and the
 * reason is that a shelf whose silhouette changes on every paint is a shelf you
 * cannot learn the shape of.
 */

/** The base volume height, before variation. */
export const BOOK_H = 190;

/**
 * Height: five stable steps, ±9.5% around the base (§7).
 *
 * Derived from the id, so it survives re-render, re-sort and re-mount. Five
 * steps rather than a continuous hash because a continuous one produces
 * near-identical neighbours that read as misalignment rather than as variation.
 */
export function bookHeight(id) {
  let n = 0;
  for (const ch of String(id)) n = (n * 31 + ch.charCodeAt(0)) % 997;
  const step = n % 5;                       // 0–4
  return Math.round(BOOK_H * (0.905 + step * 0.0475));   // 172 … 208
}

/**
 * Thickness: how much is inside, clamped (§8/§42).
 *
 *     thickness = clamp(MIN, MIN + round(sqrt(pages) * 2.2), MAX)
 *
 * The square root is the point. Pages run from 0 to several hundred, and a
 * linear mapping makes a 500-page book eight times a 60-page one — which is not
 * a shelf, it is a wardrobe next to some envelopes. A square root keeps the
 * early differences legible (a new Book against an 8-page one is 6px) while
 * flattening the tail, and the clamp stops anything running away.
 *
 *     0 pages →  26      (a new Book: the sensible minimum)
 *     8       →  32
 *     25      →  37
 *     60      →  43
 *     150     →  53
 *     500+    →  58      (clamped)
 */
export const THICK_MIN = 26;
export const THICK_MAX = 58;
export function bookThickness(pages = 0) {
  const p = Math.max(0, Number(pages) || 0);
  const t = THICK_MIN + Math.round(Math.sqrt(p) * 2.2);
  return Math.min(THICK_MAX, Math.max(THICK_MIN, t));
}

/**
 * The visible depth of the cover once a Book has turned (§9).
 *
 * A fraction of its thickness rather than a constant, so a fat Book looks fat
 * from the front too — but bounded to 4–10px, because past that the page block
 * stops being a detail and starts being a second object.
 */
export function coverDepth(thickness) {
  return Math.min(10, Math.max(4, Math.round(thickness * 0.18)));
}

export { esc };
