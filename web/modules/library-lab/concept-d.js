/**
 * CONCEPT D — Cover-forward collection.
 *
 * The deliberate opposite of A, so the choice is a real one: covers face out,
 * the way a reading-room displays what it wants you to pick up.
 *
 * The thing this has to prove is that a cover-forward book can still look
 * SHELVED rather than like a card. Three things do that work, and they are the
 * ones every previous cover-forward attempt was missing:
 *
 *   - visible THICKNESS: a side face along the right, so the object has a body;
 *   - a real page block at that side face, lined;
 *   - the book leaning very slightly back into the shelf, held by the ledge,
 *     rather than standing perpendicular to the floor like a poster.
 *
 * Interaction: it comes upright and forward — the lean straightens as it lifts,
 * which is what picking something off a display shelf feels like.
 */

import { BOOKS, DIARY, DOCUMENTS, esc, coverFace } from './lab-data.js';

const volume = (b) => `<article class="cD-vol${b.system ? ' is-system' : ''}"
  data-obj="${b.id}" data-accent="${b.accent}" role="button" tabindex="0"
  aria-label="${esc(b.title)}, Book">
  <span class="cD-body">
    <span class="cD-front">${coverFace(b)}</span>
    <span class="cD-side"><span class="cD-block"></span></span>
  </span>
  <span class="cD-cap">
    <span class="cD-cap-t">${esc(b.title)}</span>
    ${b.sub ? `<span class="cD-cap-s">${esc(b.sub)}</span>` : ''}
    <span class="cD-open" data-open>Open →</span>
  </span>
</article>`;

/** Documents are front-facing portfolios — same posture, flatter body. */
const portfolio = (d) => `<article class="cD-port" data-obj="${d.id}" data-accent="${d.accent}"
  role="button" tabindex="0" aria-label="${esc(d.title)}, Document">
  <span class="cD-body">
    <span class="cD-port-face">
      <span class="cD-port-kind">Document</span>
      <span class="cD-port-t">${esc(d.title)}</span>
      <span class="cD-port-x">${esc(d.excerpt ?? '')}</span>
      <span class="cD-port-flap"></span>
    </span>
    <span class="cD-side"><span class="cD-block"></span></span>
  </span>
  <span class="cD-cap"><span class="cD-open" data-open>Open →</span></span>
</article>`;

export const notes = [
  'Resting: covers facing out, leaning slightly back against the ledge.',
  'First press: the book straightens upright and comes forward.',
  'Second press: opens the Book.',
  'Documents: front-facing portfolios with a visible flap.',
  'Feeling: a reading-room display — what is here, shown properly.',
];

export function render(root) {
  root.innerHTML = `<div class="cD">
    <section class="cD-run"><h3 class="lab-shelf-h">Personal</h3>
      <div class="cD-shelf"><div class="cD-row">${volume(DIARY)}</div></div></section>
    <section class="cD-run"><h3 class="lab-shelf-h">Books</h3>
      <div class="cD-shelf"><div class="cD-row">${BOOKS.map(volume).join('')}</div></div></section>
    <section class="cD-run"><h3 class="lab-shelf-h">Documents</h3>
      <div class="cD-shelf"><div class="cD-row">${DOCUMENTS.map(portfolio).join('')}</div></div></section>
  </div>`;

  let up = null;
  const rest = () => { if (up) { up.classList.remove('is-up'); up = null; } };
  const onClick = (e) => {
    const obj = e.target.closest('[data-obj]');
    if (!obj) { rest(); return; }
    if (obj === up || e.target.closest('[data-open]')) {
      root.dispatchEvent(new CustomEvent('lab-open', { bubbles: true, detail: { id: obj.dataset.obj } }));
      return;
    }
    rest(); up = obj; obj.classList.add('is-up');
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
    up = null;
  };
}
