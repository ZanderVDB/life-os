/**
 * CONCEPT E — Library alcoves.
 *
 * Each category lives in its own shallow recessed BAY with a framed opening.
 * The room is implied by architecture rather than drawn: a lintel, two jambs, a
 * sill, an inner shadow at the top of each opening, and a back wall a shade
 * darker than the page.
 *
 * The point of this concept is that it gives every resource type somewhere it
 * belongs, with different FURNITURE inside the same architecture:
 *
 *   Personal    a small niche, one volume
 *   Books       a bookshelf bay
 *   Documents   a document rack, folios standing in slots
 *   Media       a framed tray, contact-sheet style
 *   Clippings   a pigeonhole wall, links and files in cubbies
 *
 * That is why E and F are the two concepts that carry every type (§20): if the
 * chosen metaphor cannot hold an image and a saved link gracefully, it is the
 * wrong metaphor, and this is where that gets tested.
 */

import {
  BOOKS, DIARY, DOCUMENTS, IMAGES, VIDEOS, LINKS, FILES, esc, spineTitle, coverFace,
} from './lab-data.js';

const volume = (b) => `<article class="cE-vol${b.system ? ' is-system' : ''}"
  data-obj="${b.id}" data-accent="${b.accent}" role="button" tabindex="0"
  aria-label="${esc(b.title)}, Book">
  <span class="cE-spine"><span class="cE-spine-t">${esc(spineTitle(b.title, 18))}</span></span>
  <span class="cE-peek">${coverFace(b, 'is-peek')}</span>
  <span class="cE-cap"><span class="cE-cap-t">${esc(b.title)}</span>
    <span class="cE-open" data-open>Open →</span></span>
</article>`;

/** Documents stand in a rack, in slots, tab up. */
const racked = (d) => `<article class="cE-rack-item" data-obj="${d.id}" data-accent="${d.accent}"
  role="button" tabindex="0" aria-label="${esc(d.title)}, Document">
  <span class="cE-tab">${esc(spineTitle(d.title, 26))}</span>
  <span class="cE-sheet"></span>
  <span class="cE-cap"><span class="cE-open" data-open>Open →</span></span>
</article>`;

/** Images and video sit in a framed tray, like a contact sheet. */
const framed = (m) => `<article class="cE-frame" data-obj="${m.id}" data-accent="${m.accent}"
  role="button" tabindex="0" aria-label="${esc(m.title)}, ${m.kind}">
  <span class="cE-frame-glass">
    ${m.kind === 'Video' ? '<span class="cE-play">▶</span>' : ''}
    <span class="cE-frame-meta">${esc(m.meta)}</span>
  </span>
  <span class="cE-frame-t">${esc(m.title)}</span>
</article>`;

/** Links and files live in pigeonholes. */
const cubby = (c) => `<article class="cE-cubby" data-obj="${c.id}" data-accent="${c.accent}"
  role="button" tabindex="0" aria-label="${esc(c.title)}, ${c.kind}">
  <span class="cE-cubby-in">
    <span class="cE-cubby-kind">${esc(c.kind)}</span>
    <span class="cE-cubby-t">${esc(c.title)}</span>
    <span class="cE-cubby-meta">${esc(c.meta)}</span>
  </span>
</article>`;

const bay = (title, inner, cls = '') => `<section class="cE-bay ${cls}">
  <div class="cE-open-frame">
    <span class="cE-lintel"></span>
    <div class="cE-inner">
      <h3 class="lab-shelf-h cE-h">${esc(title)}</h3>
      <div class="cE-content">${inner}</div>
    </div>
    <span class="cE-sill"></span>
  </div>
</section>`;

export const notes = [
  'Resting: each category in its own shallow, framed alcove.',
  'First press: the object slides out of its slot within the bay.',
  'Second press: opens it.',
  'Documents: a rack of tabbed folios standing in slots.',
  'Feeling: a room made of openings — everything has somewhere it lives.',
];

export function render(root) {
  root.innerHTML = `<div class="cE">
    ${bay('Personal', volume(DIARY), 'cE-bay-sm')}
    ${bay('Books', `<div class="cE-row">${BOOKS.map(volume).join('')}</div>`)}
    ${bay('Documents', `<div class="cE-rack">${DOCUMENTS.map(racked).join('')}</div>`)}
    ${bay('Media', `<div class="cE-tray">${[...IMAGES, ...VIDEOS].map(framed).join('')}</div>`)}
    ${bay('Links & Files', `<div class="cE-wall">${[...LINKS, ...FILES].map(cubby).join('')}</div>`)}
  </div>`;

  let out = null;
  const rest = () => { if (out) { out.classList.remove('is-out'); out = null; } };
  const onClick = (e) => {
    const obj = e.target.closest('[data-obj]');
    if (!obj) { rest(); return; }
    if (obj === out || e.target.closest('[data-open]')) {
      root.dispatchEvent(new CustomEvent('lab-open', { bubbles: true, detail: { id: obj.dataset.obj } }));
      return;
    }
    rest(); out = obj; obj.classList.add('is-out');
  };
  const onKey = (e) => {
    const obj = e.target.closest('[data-obj]');
    if (!obj) return;
    if (e.key === 'Escape') { rest(); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick({ target: obj }); }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKey);
    out = null;
  };
}
