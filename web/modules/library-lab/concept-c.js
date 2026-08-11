/**
 * CONCEPT C — Modern luxury library.
 *
 * The least fantasy-like and the most editorial. Books stand spine-on in a
 * generously spaced run against a plain back plane, on a thin stone-and-metal
 * shelf edge. No ornament at all: the interest is typography, spacing and one
 * precise highlight along the shelf lip.
 *
 * Spines are taller, slimmer and set in a single confident line of type. Where
 * B varies heights for character, C keeps them level on purpose — the rhythm
 * comes from spine WIDTH and from the space around the run.
 *
 * Interaction: the spine widens and the cover crossfades into it in place —
 * no rotation, no travel to speak of. It should feel like a museum label
 * turning over rather than a book being pulled.
 */

import { BOOKS, DIARY, DOCUMENTS, esc, spineTitle, coverFace } from './lab-data.js';

const spineFor = (id) => {
  let n = 0;
  for (const ch of String(id)) n = (n + ch.charCodeAt(0) * 13) % 3;
  return 38 + n * 8;                        // 38–54px
};

const volume = (b) => `<article class="cC-vol${b.system ? ' is-system' : ''}"
  data-obj="${b.id}" data-accent="${b.accent}" role="button" tabindex="0"
  aria-label="${esc(b.title)}, Book" style="--sw:${spineFor(b.id)}px">
  <span class="cC-spine">
    <span class="cC-rule"></span>
    <span class="cC-spine-t">${esc(spineTitle(b.title, 22))}</span>
    <span class="cC-mark">${b.year}</span>
  </span>
  <span class="cC-reveal">${coverFace(b, 'is-reveal')}</span>
  <span class="cC-cap">
    <span class="cC-cap-t">${esc(b.title)}</span>
    ${b.sub ? `<span class="cC-cap-s">${esc(b.sub)}</span>` : ''}
    <span class="cC-open" data-open>Open →</span>
  </span>
</article>`;

/** Documents are premium archival folders — a crisp case with a printed index. */
const folder = (d) => `<article class="cC-folder" data-obj="${d.id}" data-accent="${d.accent}"
  role="button" tabindex="0" aria-label="${esc(d.title)}, Document">
  <span class="cC-folder-case">
    <span class="cC-folder-index">${esc(d.title)}</span>
    <span class="cC-folder-line"></span>
    <span class="cC-folder-kind">Document</span>
  </span>
  <span class="cC-cap"><span class="cC-open" data-open>Open →</span></span>
</article>`;

export const notes = [
  'Resting: level spines, generously spaced, on a thin stone-and-metal lip.',
  'First press: the spine widens and the cover crossfades in place.',
  'Second press: opens the Book.',
  'Documents: crisp archival folders with a printed index.',
  'Feeling: editorial and premium — a gallery, not a study.',
];

export function render(root) {
  root.innerHTML = `<div class="cC">
    <section class="cC-run"><h3 class="lab-shelf-h">Personal</h3>
      <div class="cC-shelf"><div class="cC-row">${volume(DIARY)}</div></div></section>
    <section class="cC-run"><h3 class="lab-shelf-h">Books</h3>
      <div class="cC-shelf"><div class="cC-row">${BOOKS.map(volume).join('')}</div></div></section>
    <section class="cC-run"><h3 class="lab-shelf-h">Documents</h3>
      <div class="cC-shelf"><div class="cC-row">${DOCUMENTS.map(folder).join('')}</div></div></section>
  </div>`;

  let open = null;
  const rest = () => { if (open) { open.classList.remove('is-open'); open = null; } };
  const onClick = (e) => {
    const obj = e.target.closest('[data-obj]');
    if (!obj) { rest(); return; }
    if (obj === open || e.target.closest('[data-open]')) {
      root.dispatchEvent(new CustomEvent('lab-open', { bubbles: true, detail: { id: obj.dataset.obj } }));
      return;
    }
    rest(); open = obj; obj.classList.add('is-open');
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
    open = null;
  };
}
