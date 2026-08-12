/**
 * CONCEPT C2 — Modern Library, refined.
 *
 * C's architecture and spine browsing, plus a real spine→cover turn, plus D's
 * front-facing objects for everything that is not a Book, on a shelf that is
 * actually built rather than implied.
 *
 * ── The three states (§4) ────────────────────────────────────────────────
 *
 *   SPINE    resting on the shelf, close to its neighbours
 *   COVER    turned ~90° to face you, its neighbours having made room
 *   OPEN     the second activation — in the product, the Book opens
 *
 * The turn is one object rotating, not two representations swapping. The spine
 * and the cover are faces of the same box, hinged at the spine's outer edge,
 * and nothing is added or removed from the DOM during the turn.
 *
 * ── How the neighbours make room (§13) ───────────────────────────────────
 *
 * By LAYOUT, not by absolute positioning. Each book lives in a slot whose width
 * is the book's thickness; a turning book's slot widens to the cover's width and
 * the row reflows, so neighbours slide rather than being pushed by transforms
 * that would have to be undone. One transition on one property, and the shelf
 * cannot end up with two books in the same place.
 *
 * ── Final state (§6) ─────────────────────────────────────────────────────
 *
 * Every state is a class. The rotation is a CSS transition to a transform the
 * stylesheet owns, so a throttled or interrupted animation still lands on the
 * committed state, and reduced motion arrives there immediately.
 */

import {
  BOOKS, DIARY, DOCUMENTS, IMAGES, VIDEOS, LINKS, FILES, esc, spineTitle,
} from './lab-data.js';
import {
  bookCoverHtml, bookHeight, bookThickness, coverDepth,
} from './shared-cover.js';

/** The Diary is the FIRST book on the Books shelf (§14) — not its own bay. */
const shelfBooks = () => [DIARY, ...BOOKS];

function volume(b, i, n) {
  const h = bookHeight(b.id);
  const t = bookThickness(b.pages);
  const d = coverDepth(t);
  return `<li class="c2-slot" style="--t:${t}px;--h:${h}px;--d:${d}px">
    <article class="c2-vol${b.system ? ' is-system' : ''}" data-obj="${esc(b.id)}"
      data-accent="${esc(b.accent)}" role="button" tabindex="0" aria-expanded="false"
      aria-label="${esc(b.title)}, Book, ${i + 1} of ${n}, spine view"
      title="${esc(b.title)}">
      <span class="c2-box">
        <span class="c2-face c2-spine">
          <span class="c2-rule"></span>
          <span class="c2-spine-t">${esc(spineTitle(b.title, 22))}</span>
          <span class="c2-imprint">${b.system ? '✦' : String(b.year).slice(2)}</span>
        </span>
        <span class="c2-face c2-front">
          ${bookCoverHtml(b)}
          <span class="c2-open" data-open>Open</span>
        </span>
        <span class="c2-face c2-edge"></span>
      </span>
    </article>
  </li>`;
}

/* ── Non-Book objects: D-inspired, front-facing, modern archive (§22–§27) ─
 *
 * Books look like Books. Everything else looks like a modern physical archive
 * object seen face-on — a portfolio, a sleeve, a card, a jacket. None of them
 * borrows a spine, and none of them borrows the Book's physics: they come
 * forward on hover and open on activation, because that is what a portfolio in
 * a tray does. A folder does not rotate. */

const portfolio = (d) => `<article class="c2-port" data-obj="${esc(d.id)}"
  data-accent="${esc(d.accent)}" role="button" tabindex="0"
  aria-label="${esc(d.title)}, Document">
  <span class="c2-port-body">
    <span class="c2-port-tab"></span>
    <span class="c2-port-kind">Document</span>
    <span class="c2-port-t">${esc(d.title)}</span>
    <span class="c2-port-x">${esc(d.excerpt ?? '')}</span>
    <span class="c2-port-flap"></span>
  </span>
</article>`;

const sleeve = (m) => `<article class="c2-media" data-obj="${esc(m.id)}"
  data-accent="${esc(m.accent)}" role="button" tabindex="0"
  aria-label="${esc(m.title)}, ${esc(m.kind)}">
  <span class="c2-media-win">
    ${m.kind === 'Video' ? `<span class="c2-play">
      <svg viewBox="0 0 20 20" width="13" height="13" fill="currentColor"><path d="m7 5 8 5-8 5z"/></svg>
    </span>` : ''}
    <span class="c2-media-meta">${esc(m.meta)}</span>
  </span>
  <span class="c2-media-t">${esc(m.title)}</span>
</article>`;

const clipping = (l) => `<article class="c2-clip" data-obj="${esc(l.id)}"
  data-accent="${esc(l.accent)}" role="button" tabindex="0"
  aria-label="${esc(l.title)}, Link">
  <span class="c2-clip-mark">${esc(l.meta.slice(0, 1).toUpperCase())}</span>
  <span class="c2-clip-body">
    <span class="c2-clip-t">${esc(l.title)}</span>
    <span class="c2-clip-m">${esc(l.meta)}</span>
  </span>
</article>`;

const jacket = (f) => `<article class="c2-file" data-obj="${esc(f.id)}"
  data-accent="${esc(f.accent)}" role="button" tabindex="0"
  aria-label="${esc(f.title)}, ${esc(f.kind)} file">
  <span class="c2-file-body">
    <span class="c2-file-kind">${esc(f.kind)}</span>
    <span class="c2-file-t">${esc(f.title)}</span>
    <span class="c2-file-m">${esc(f.meta)}</span>
  </span>
</article>`;

/** One shelf bay: back panel, ledge, front face, uprights (§19). */
const bay = (label, inner, cls = '') => `<section class="c2-bay ${cls}">
  <h3 class="c2-label">${esc(label)}</h3>
  <div class="c2-niche">
    <div class="c2-scroll"><ul class="c2-row" role="list">${inner}</ul></div>
    <span class="c2-ledge" aria-hidden="true"></span>
  </div>
</section>`;

export const notes = [
  'Resting: spines close together on a built shelf — back panel, ledge, front face.',
  'First press: the Book turns ~90° on its own hinge; neighbours make room.',
  'Second press: Open — the same cover the Book itself opens with.',
  'Non-Books: front-facing portfolios, sleeves, clippings and jackets.',
  'Feeling: a modern built-in Library, tactile but not theatrical.',
];

export function render(root) {
  const books = shelfBooks();
  root.innerHTML = `<div class="c2">
    ${bay('Books', books.map((b, i) => volume(b, i, books.length)).join(''), 'c2-bay-books')}
    ${bay('Documents', DOCUMENTS.map(portfolio).join(''), 'c2-bay-flat')}
    ${bay('Media', [...IMAGES, ...VIDEOS].map(sleeve).join(''), 'c2-bay-flat')}
    ${bay('Links & Files', [...LINKS.map(clipping), ...FILES.map(jacket)].join(''), 'c2-bay-flat')}
  </div>`;

  /** The one turned Book. Only ever one (§33). */
  let turned = null;

  const toSpine = ({ focus = false } = {}) => {
    if (!turned) return;
    const obj = turned;
    turned = null;
    obj.classList.remove('is-cover');
    obj.setAttribute('aria-expanded', 'false');
    const t = obj.getAttribute('title') ?? '';
    obj.setAttribute('aria-label', obj.dataset.label ?? `${t}, Book, spine view`);
    if (focus && obj.isConnected) obj.focus({ preventScroll: true });
  };

  const toCover = (obj) => {
    if (obj === turned) return;
    toSpine();
    turned = obj;
    /* Remembered before it is replaced, so returning to the spine restores the
     * name the shelf gave it rather than a reconstructed one. */
    if (!obj.dataset.label) obj.dataset.label = obj.getAttribute('aria-label') ?? '';
    obj.classList.add('is-cover');
    obj.setAttribute('aria-expanded', 'true');
    obj.setAttribute('aria-label',
      `${obj.getAttribute('title')}, Book, cover view. Press again to open.`);
  };

  const onClick = (e) => {
    const obj = e.target.closest('[data-obj]');
    if (!obj) { toSpine(); return; }
    if (!obj.classList.contains('c2-vol')) {          // a portfolio, sleeve, clipping…
      root.dispatchEvent(new CustomEvent('lab-open', { bubbles: true, detail: { id: obj.dataset.obj } }));
      return;
    }
    if (obj === turned || e.target.closest('[data-open]')) {
      root.dispatchEvent(new CustomEvent('lab-open', { bubbles: true, detail: { id: obj.dataset.obj } }));
      return;
    }
    toCover(obj);
  };

  const onKey = (e) => {
    const obj = e.target.closest('[data-obj]');
    if (e.key === 'Escape' && turned) { e.preventDefault(); toSpine({ focus: true }); return; }
    if (!obj) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onClick({ target: obj, closest: () => obj });
  };

  /* Scrolling a shelf away returns the turned Book, the same way the real
   * Library returns a pulled one: an object held open over a shelf that has
   * moved on is an object in the wrong place. */
  const onScroll = (e) => {
    if (!turned) return;
    const rail = e.target;
    if (!(rail instanceof Element) || !rail.contains(turned)) return;
    const from = Number(rail.dataset.turnAt ?? rail.scrollLeft);
    if (Math.abs(rail.scrollLeft - from) > 64) toSpine();
  };

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  root.querySelectorAll('.c2-scroll').forEach((r) => {
    r.addEventListener('scroll', onScroll, { passive: true });
  });

  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKey);
    root.querySelectorAll('.c2-scroll').forEach((r) => r.removeEventListener('scroll', onScroll));
    turned = null;
  };
}
