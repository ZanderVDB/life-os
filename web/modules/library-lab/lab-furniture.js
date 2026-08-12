/**
 * SHELF ARCHITECTURE — five treatments over identical contents (L3.5 §16–§22).
 *
 * The Books, their order, their sizes and their positions are the same in every
 * option. Only the furniture changes, because a comparison where two things
 * move at once is not a comparison.
 *
 * Every option is drawn from the same materials: graphite, one highlight, one
 * shadow. No wood, no moulding, no photographic texture. What differs is
 * *construction* — how much frame there is, where the mass sits, and where the
 * light comes from.
 */

import { esc } from './shared-cover.js';

export const SHELVES = [
  { id: 'a', label: 'A', name: 'Graphite built-in',
    note: 'A recessed niche with defined side boundaries and a solid ledge. C2, better built.' },
  { id: 'b', label: 'B', name: 'Floating stone',
    note: 'A heavy slab with a thick front face and almost no frame. Architectural, not decorative.' },
  { id: 'c', label: 'C', name: 'Metal frame',
    note: 'Thin structural uprights at the ends, a slim plane, a recessed backing.' },
  { id: 'd', label: 'D', name: 'Recessed light niche',
    note: 'A deeper wall opening lit from above. The light is architectural — no visible fitting.' },
  { id: 'e', label: 'E', name: 'Monolith',
    note: 'One substantial ledge and a shadowed recess. Almost no frame; strong silhouette.' },
];

/**
 * One bay.
 *
 * The layers exist in every variant so that the stylesheet can use or ignore
 * each one; a variant that wants no uprights hides them rather than the markup
 * changing shape between options. That is what keeps the Books in identical
 * positions across all five.
 */
export function bay(label, inner, { shelf = 'a', flat = false, tall = false } = {}) {
  return `<section class="cb-bay cb-s-${esc(shelf)}${flat ? ' is-flat' : ''}${tall ? ' is-tall' : ''}">
    ${label ? `<h3 class="cb-label">${esc(label)}</h3>` : ''}
    <div class="cb-niche">
      <span class="cb-wall" aria-hidden="true"></span>
      <span class="cb-post cb-post-l" aria-hidden="true"></span>
      <span class="cb-post cb-post-r" aria-hidden="true"></span>
      <div class="cb-scroll"><ul class="cb-row" role="list">${inner}</ul></div>
      <span class="cb-ledge" aria-hidden="true"></span>
    </div>
  </section>`;
}
