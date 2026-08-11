/**
 * CONCEPT B — Fantasy bookshelf.
 *
 * A deep recessed bay with a real frame: side posts, a top rail, a thick front
 * ledge, and a warm glow that falls from the top of the bay onto the books.
 * Books are cloth and leather with head and tail bands, gilt rules, and
 * noticeable height and thickness variation.
 *
 * "Fantasy" here means ATMOSPHERE, not ornament (§11). There is no wood
 * texture, no torch, no rune, no parchment. What makes it feel like a private
 * study is the recess, the fall of light, and books that look bound rather than
 * printed — all of it drawn with gradients and geometry in the Life OS palette.
 *
 * Interaction: the book leans out of the row and rises, the way you tip a
 * hardback out by its head band before taking it.
 */

import { BOOKS, DIARY, DOCUMENTS, esc, spineTitle, coverFace } from './lab-data.js';

const heightFor = (id) => {
  let n = 0;
  for (const ch of String(id)) n = (n + ch.charCodeAt(0) * 5) % 13;
  return 186 + n * 5;                       // 186–246px — a wider spread than A
};
const spineFor = (id) => {
  let n = 0;
  for (const ch of String(id)) n = (n + ch.charCodeAt(0) * 11) % 5;
  return 32 + n * 6;                        // 32–56px
};

const volume = (b) => `<article class="cB-vol${b.system ? ' is-system' : ''}"
  data-obj="${b.id}" data-accent="${b.accent}" role="button" tabindex="0"
  aria-label="${esc(b.title)}, Book" style="--h:${heightFor(b.id)}px;--sw:${spineFor(b.id)}px">
  <span class="cB-head"></span>
  <span class="cB-spine">
    <span class="cB-gilt"></span>
    <span class="cB-spine-t">${esc(spineTitle(b.title, 18))}</span>
    <span class="cB-gilt"></span>
    <span class="cB-crest">${b.system ? '✦' : '❖'}</span>
  </span>
  <span class="cB-tail"></span>
  <span class="cB-peek">${coverFace(b, 'is-peek')}</span>
  <span class="cB-foot">
    <span class="cB-foot-t">${esc(b.title)}</span>
    <span class="cB-open" data-open>Open →</span>
  </span>
</article>`;

/** Documents are cloth folios — softer, shorter, tied with a band. */
const folio = (d) => `<article class="cB-folio" data-obj="${d.id}" data-accent="${d.accent}"
  role="button" tabindex="0" aria-label="${esc(d.title)}, Document">
  <span class="cB-folio-cloth">
    <span class="cB-folio-tie"></span>
    <span class="cB-folio-plate">${esc(d.title)}</span>
    <span class="cB-folio-kind">Document</span>
  </span>
  <span class="cB-foot"><span class="cB-open" data-open>Open →</span></span>
</article>`;

export const notes = [
  'Resting: cloth and leather volumes in a deep, framed, lit bay.',
  'First press: the book leans out and rises, as if tipped by its head band.',
  'Second press: opens the Book.',
  'Documents: cloth folios tied with a band, on the bay below.',
  'Feeling: a private study — warm, deep, a little grand.',
];

export function render(root) {
  root.innerHTML = `<div class="cB">
    <section class="cB-bay">
      <div class="cB-frame"><h3 class="lab-shelf-h">Personal</h3>
        <div class="cB-row">${volume(DIARY)}</div></div>
    </section>
    <section class="cB-bay">
      <div class="cB-frame"><h3 class="lab-shelf-h">Books</h3>
        <div class="cB-row">${BOOKS.map(volume).join('')}</div></div>
    </section>
    <section class="cB-bay">
      <div class="cB-frame"><h3 class="lab-shelf-h">Documents</h3>
        <div class="cB-row cB-row-folio">${DOCUMENTS.map(folio).join('')}</div></div>
    </section>
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
