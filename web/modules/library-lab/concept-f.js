/**
 * CONCEPT F — Personal archive.
 *
 * The most distinctive of the six, and the one that commits hardest to the idea
 * that different kinds of thing are STORED differently. Books get a shelf;
 * everything else gets the piece of archival furniture it would actually live
 * in:
 *
 *   Books        an open shelf, spine-on
 *   Documents    a folio rack with pull tabs
 *   Media        a contact-sheet board, prints clipped in a row
 *   Links        a clipping board, cards pinned under a rail
 *   Files        a drawer front, labelled, that slides open
 *
 * The risk this concept carries, and the reason it is one of six rather than
 * the proposal: five metaphors is five things to learn. It is included because
 * it is the only way to find out whether that variety reads as a rich personal
 * archive or as an inconsistent one — and that is a question only looking at it
 * can answer.
 *
 * Nothing here is skeuomorphism for decoration (§10): every piece of furniture
 * exists because a different kind of object goes in it.
 */

import {
  BOOKS, DIARY, DOCUMENTS, IMAGES, VIDEOS, LINKS, FILES, esc, spineTitle, coverFace,
} from './lab-data.js';

const volume = (b) => `<article class="cF-vol${b.system ? ' is-system' : ''}"
  data-obj="${b.id}" data-accent="${b.accent}" role="button" tabindex="0"
  aria-label="${esc(b.title)}, Book">
  <span class="cF-spine"><span class="cF-spine-t">${esc(spineTitle(b.title, 18))}</span></span>
  <span class="cF-peek">${coverFace(b, 'is-peek')}</span>
  <span class="cF-cap"><span class="cF-cap-t">${esc(b.title)}</span>
    <span class="cF-open" data-open>Open →</span></span>
</article>`;

/** A folio in a rack, with a pull tab you can see. */
const folio = (d) => `<article class="cF-folio" data-obj="${d.id}" data-accent="${d.accent}"
  role="button" tabindex="0" aria-label="${esc(d.title)}, Document">
  <span class="cF-folio-pull"></span>
  <span class="cF-folio-face">
    <span class="cF-folio-kind">Document</span>
    <span class="cF-folio-t">${esc(d.title)}</span>
  </span>
  <span class="cF-cap"><span class="cF-open" data-open>Open →</span></span>
</article>`;

/** A print clipped to the contact board. */
const print = (m) => `<article class="cF-print" data-obj="${m.id}" data-accent="${m.accent}"
  role="button" tabindex="0" aria-label="${esc(m.title)}, ${m.kind}">
  <span class="cF-clip"></span>
  <span class="cF-print-face">
    ${m.kind === 'Video' ? '<span class="cF-play">▶</span>' : ''}
    <span class="cF-print-meta">${esc(m.meta)}</span>
  </span>
  <span class="cF-print-t">${esc(m.title)}</span>
</article>`;

/** A clipping pinned under the rail. */
const clipping = (l) => `<article class="cF-clipping" data-obj="${l.id}" data-accent="${l.accent}"
  role="button" tabindex="0" aria-label="${esc(l.title)}, Link">
  <span class="cF-pin"></span>
  <span class="cF-clipping-t">${esc(l.title)}</span>
  <span class="cF-clipping-m">${esc(l.meta)}</span>
</article>`;

/** A labelled drawer front. */
const drawer = (f) => `<article class="cF-drawer" data-obj="${f.id}" data-accent="${f.accent}"
  role="button" tabindex="0" aria-label="${esc(f.title)}, File">
  <span class="cF-drawer-face">
    <span class="cF-drawer-plate">
      <span class="cF-drawer-t">${esc(f.title)}</span>
      <span class="cF-drawer-m">${esc(f.kind)} · ${esc(f.meta)}</span>
    </span>
    <span class="cF-handle"></span>
  </span>
</article>`;

const unit = (title, inner, cls) => `<section class="cF-unit ${cls}">
  <h3 class="lab-shelf-h">${esc(title)}</h3>
  <div class="cF-unit-in">${inner}</div>
</section>`;

export const notes = [
  'Resting: Books on a shelf; everything else in its own archival furniture.',
  'First press: the object comes out of whatever holds it — slot, rack, drawer.',
  'Second press: opens it.',
  'Documents: a folio rack with visible pull tabs.',
  'Feeling: a personal archive — one room, several kinds of storage.',
];

export function render(root) {
  root.innerHTML = `<div class="cF">
    ${unit('Personal', volume(DIARY), 'cF-shelf')}
    ${unit('Books', BOOKS.map(volume).join(''), 'cF-shelf')}
    ${unit('Documents', DOCUMENTS.map(folio).join(''), 'cF-rack')}
    ${unit('Media', [...IMAGES, ...VIDEOS].map(print).join(''), 'cF-board')}
    ${unit('Links', LINKS.map(clipping).join(''), 'cF-clipboard')}
    ${unit('Files', FILES.map(drawer).join(''), 'cF-cabinet')}
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
