/**
 * THE COMPONENT LAB (L3.5).
 *
 * L3.3 compared six whole Libraries and produced a direction. L3.4 refined that
 * direction into C2 and produced a second, narrower question: the resting shelf
 * is right, several specific things on it are not. Comparing whole Libraries
 * again would answer that badly, because every full concept changes eight things
 * at once and you cannot tell which one you are reacting to.
 *
 * So this compares ONE THING AT A TIME. Each category holds four to six
 * genuinely different treatments of a single decision, rendered over identical
 * data in an identical surrounding. Switching a variant changes nothing else:
 * not the Books, not their order, not their sizes, not the scroll position, not
 * the selected Book.
 *
 * The output is a set of choices — one per category — which a later phase
 * combines. Nothing here is a recommendation, and nothing here is integrated:
 * the real Library is untouched by this phase.
 */

import { navToken } from '../../nav.js';
import { BOOKS, DIARY, DOCUMENTS, IMAGES, VIDEOS, LINKS, FILES, esc } from './lab-data.js';
import { sampleRow, ROW_SIZES, bookThickness } from './book-physics.js';
import { bay, SHELVES } from './lab-furniture.js';
import { RESTING, PULLED, bookRow, slotWidth } from './lab-books.js';
import {
  DOCS, MEDIA, LINKVARS, FILEVARS, MIXED,
  documentEl, mediaEl, linkEl, fileEl,
} from './lab-resources.js';

/* ── The pages ───────────────────────────────────────────────────────────── */

const CATEGORIES = [
  { id: 'resting', name: 'Resting Books', variants: RESTING, axis: 'resting',
    blurb: 'Spine-first, compact, physical, modern. What changes is the level of detail.' },
  { id: 'pulled', name: 'Pulled Book', variants: PULLED, axis: 'pulled',
    blurb: 'The same resting Book in all five. Select one to see the treatment.' },
  { id: 'shelf', name: 'Shelf', variants: SHELVES, axis: 'shelf',
    blurb: 'Identical Books in identical positions. Only the furniture changes.' },
  { id: 'documents', name: 'Documents', variants: DOCS, axis: 'doc',
    blurb: 'Front-facing archive objects, on dark surfaces. Never a bright card.' },
  { id: 'media', name: 'Media', variants: MEDIA, axis: 'media',
    blurb: 'Images and video. Video always carries a play mark and a duration.' },
  { id: 'links', name: 'Links', variants: LINKVARS, axis: 'link',
    blurb: 'Title, domain, source mark. Compact, and never a browser tab.' },
  { id: 'files', name: 'Files', variants: FILEVARS, axis: 'file',
    blurb: 'Name, type, size — understandable without a legend.' },
  { id: 'mixed', name: 'One room or five?', variants: null, axis: null,
    blurb: 'The same resources under one architecture, then under five. §27.' },
];

/**
 * Everything the lab remembers. Held in a module-level object rather than in the
 * DOM so that a re-render restores the view instead of resetting it (§31).
 */
const state = {
  page: 'resting',
  pick: { resting: 'a', pulled: 'a', shelf: 'a', doc: 'a', media: 'a', link: 'a', file: 'a' },
  rowSize: 9,
  compare: false,
  compareWith: 'b',
  selected: null,          // the turned Book's id, preserved across variant switches
  scroll: {},              // per-rail scrollLeft, keyed by rail name
};

/* ── Rendering ───────────────────────────────────────────────────────────── */

const media = () => [...IMAGES, ...VIDEOS];

/** The Books row used by every Book-related page. */
function booksBay(shelf, restingV, pulledV, key = 'books') {
  const books = sampleRow(state.rowSize, DIARY, BOOKS);
  return `<div class="cb-frame" data-rail="${key}" data-resting="${esc(restingV)}"
    data-pulled="${esc(pulledV)}">${bay('', bookRow(books), { shelf })}</div>`;
}

function resourceBay(kind, variant, shelf, key) {
  const [items, render, flat] = {
    doc: [DOCUMENTS, documentEl, true],
    media: [media(), mediaEl, true],
    link: [LINKS, linkEl, true],
    file: [FILES, fileEl, true],
  }[kind];
  const inner = items.map((it) => render(it, variant)).join('');
  return `<div class="cb-frame cb-${kind}s" data-rail="${key}">${bay('', inner, { shelf, flat })}</div>`;
}

/** One comparison panel: the label, then the thing. */
const panel = (title, note, body) => `<section class="cb-panel">
  <header class="cb-panel-h"><b>${esc(title)}</b><span>${esc(note)}</span></header>
  ${body}</section>`;

function pageBody(cat, variantId, key) {
  const shelf = state.pick.shelf;
  switch (cat.id) {
    case 'resting': return booksBay(shelf, variantId, state.pick.pulled, key);
    case 'pulled': return booksBay(shelf, state.pick.resting, variantId, key);
    case 'shelf': return booksBay(variantId, state.pick.resting, state.pick.pulled, key);
    case 'documents': return resourceBay('doc', variantId, shelf, key);
    case 'media': return resourceBay('media', variantId, shelf, key);
    case 'links': return resourceBay('link', variantId, shelf, key);
    case 'files': return resourceBay('file', variantId, shelf, key);
    default: return '';
  }
}

/** §27 — the two arrangements, stacked, so the question can be looked at. */
function mixedPage() {
  const shelf = state.pick.shelf;
  const one = `<div class="cb-frame" data-rail="one-books">${bay('Books', bookRow(sampleRow(9, DIARY, BOOKS)), { shelf })}</div>
    ${['doc', 'media', 'link', 'file'].map((k, i) => `<div class="cb-frame" data-rail="one-${k}">
      ${bay(['Documents', 'Media', 'Links', 'Files'][i], resourceInner(k), { shelf, flat: true })}</div>`).join('')}`;
  const five = `<div class="cb-frame cb-fx cb-fx-shelf" data-rail="fv-books">${bay('Books', bookRow(sampleRow(9, DIARY, BOOKS)), { shelf })}</div>
    ${MIXED.slice(1).map((m, i) => {
    const k = ['doc', 'media', 'link', 'file'][i];
    return `<div class="cb-frame cb-fx cb-fx-${m.furniture}" data-rail="fv-${k}">
      ${bay(m.kind, resourceInner(k), { shelf, flat: true })}</div>`;
  }).join('')}`;
  return panel('One architecture', 'Every kind in the same bay.', one)
    + panel('Five structures', MIXED.map((m) => `${m.kind} → ${m.furniture}`).join(' · '), five);
}

function resourceInner(kind) {
  const [items, render] = {
    doc: [DOCUMENTS, documentEl], media: [media(), mediaEl],
    link: [LINKS, linkEl], file: [FILES, fileEl],
  }[kind];
  return items.map((it) => render(it, state.pick[kind])).join('');
}

function stageHtml() {
  const cat = CATEGORIES.find((c) => c.id === state.page) ?? CATEGORIES[0];
  if (cat.id === 'mixed') return mixedPage();
  const cur = cat.variants.find((v) => v.id === state.pick[cat.axis]) ?? cat.variants[0];
  if (!state.compare) return panel(`${cur.label} — ${cur.name}`, cur.note, pageBody(cat, cur.id, 'main'));
  const other = cat.variants.find((v) => v.id === state.compareWith) ?? cat.variants[1] ?? cat.variants[0];
  return `<div class="cb-side">
    ${panel(`${cur.label} — ${cur.name}`, cur.note, pageBody(cat, cur.id, 'main'))}
    ${panel(`${other.label} — ${other.name}`, other.note, pageBody(cat, other.id, 'other'))}
  </div>`;
}

function controlsHtml() {
  const cat = CATEGORIES.find((c) => c.id === state.page) ?? CATEGORIES[0];
  const vs = cat.variants;
  const pick = vs ? state.pick[cat.axis] : null;
  return `<div class="cb-controls">
    <p class="cb-blurb">${esc(cat.blurb)}</p>
    ${vs ? `<div class="cb-tabs" role="group" aria-label="${esc(cat.name)} variants">
      ${vs.map((v) => `<button type="button" class="cb-tab${v.id === pick ? ' on' : ''}"
        data-variant="${esc(v.id)}" aria-pressed="${v.id === pick}"
        title="${esc(v.name)}">${esc(v.label)}</button>`).join('')}
    </div>` : ''}
    ${['resting', 'pulled', 'shelf'].includes(cat.id) ? `<label class="cb-rows">Row
      <select data-rows>${ROW_SIZES.map((n) => `<option value="${n}"${n === state.rowSize ? ' selected' : ''}>${n} Books</option>`).join('')}</select>
    </label>` : ''}
    ${vs && vs.length > 1 ? `<label class="cb-cmp"><input type="checkbox" data-compare${state.compare ? ' checked' : ''}>
      Side by side</label>
    ${state.compare ? `<select data-with aria-label="Compare against">
      ${vs.map((v) => `<option value="${esc(v.id)}"${v.id === state.compareWith ? ' selected' : ''}>${esc(v.label)} — ${esc(v.name)}</option>`).join('')}
    </select>` : ''}` : ''}
  </div>`;
}

export const notes = [
  'One decision per page. Everything else is held identical.',
  'Resting Books: four levels of physical detail, all spine-first.',
  'Pulled Book: five treatments, none of them flat at the end.',
  'Shelf: five architectures over identical Books in identical positions.',
  'Nothing here is integrated. The real Library is untouched.',
];

/* ── Behaviour ───────────────────────────────────────────────────────────── */

export function render(root) {
  root.innerHTML = `<div class="cb">
    <nav class="cb-nav" aria-label="Component categories">
      ${CATEGORIES.map((c) => `<button type="button" class="cb-cat" data-page="${esc(c.id)}"
        aria-pressed="false">${esc(c.name)}</button>`).join('')}
    </nav>
    <div id="cb-controls"></div>
    <div class="cb-stage" id="cb-stage"></div>
  </div>`;

  const stage = root.querySelector('#cb-stage');
  const controls = root.querySelector('#cb-controls');

  /** Remember where every rail is looking, so a re-render can put it back. */
  const saveScroll = () => {
    stage.querySelectorAll('.cb-frame').forEach((f) => {
      const r = f.querySelector('.cb-scroll');
      if (r) state.scroll[f.dataset.rail] = r.scrollLeft;
    });
  };
  const restoreScroll = () => {
    stage.querySelectorAll('.cb-frame').forEach((f) => {
      const r = f.querySelector('.cb-scroll');
      if (r && state.scroll[f.dataset.rail]) r.scrollLeft = state.scroll[f.dataset.rail];
    });
  };

  /**
   * Re-apply the turned Book after a re-render.
   *
   * The selection is held as an id rather than as an element, so switching from
   * pulled-A to pulled-C shows you the SAME Book in the new treatment instead of
   * closing it and making you find it again (§31).
   */
  const restoreSelection = () => {
    if (!state.selected) return;
    stage.querySelectorAll(`.cb-vol[data-obj="${CSS.escape(state.selected)}"]`)
      .forEach((v) => applyTurn(v, true));
  };

  function applyTurn(vol, on) {
    const slot = vol.parentElement;
    vol.classList.toggle('is-out', on);
    vol.setAttribute('aria-expanded', String(on));
    const t = Number(slot.dataset.t) || 26;
    const frame = vol.closest('.cb-frame');
    const variant = frame?.dataset.pulled ?? state.pick.pulled;
    /* The slot is widened to the projected width of the turned Book, which is
     * what keeps its hit area equal to the space it occupies (§14). */
    slot.style.width = on ? `${slotWidth(variant, t, true)}px` : '';
    const title = vol.getAttribute('title') ?? '';
    if (on) {
      if (!vol.dataset.label) vol.dataset.label = vol.getAttribute('aria-label') ?? '';
      vol.setAttribute('aria-label', `${title}, Book, pulled out. Press again to open.`);
    } else {
      vol.setAttribute('aria-label', vol.dataset.label || `${title}, Book, spine view`);
    }
  }

  /** Exactly one Book is out, in every rail, at any time. */
  function select(id, { focus = false } = {}) {
    const was = state.selected;
    stage.querySelectorAll('.cb-vol.is-out').forEach((v) => applyTurn(v, false));
    state.selected = (was === id) ? null : id;
    if (!state.selected) return;
    stage.querySelectorAll(`.cb-vol[data-obj="${CSS.escape(state.selected)}"]`)
      .forEach((v, i) => { applyTurn(v, true); if (focus && i === 0) v.focus({ preventScroll: true }); });
  }

  function paint() {
    saveScroll();
    controls.innerHTML = controlsHtml();
    stage.innerHTML = stageHtml();
    root.querySelectorAll('[data-page]').forEach((b) => {
      const on = b.dataset.page === state.page;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    restoreScroll();
    restoreSelection();
  }

  const onClick = (e) => {
    const page = e.target.closest('[data-page]');
    if (page) { state.page = page.dataset.page; paint(); return; }

    const tab = e.target.closest('[data-variant]');
    if (tab) {
      const cat = CATEGORIES.find((c) => c.id === state.page);
      state.pick[cat.axis] = tab.dataset.variant;
      paint();
      return;
    }

    const obj = e.target.closest('[data-obj]');
    if (!obj) {
      /* Clicking the shelf itself puts the Book back. Clicking the LAB's own
       * controls must not — switching a variant or turning on side-by-side is
       * a question about the Book you are looking at, so closing it there
       * answers by taking the subject away (§31). */
      if (state.selected && e.target.closest('#cb-stage')) select(state.selected);
      return;
    }
    if (!obj.classList.contains('cb-vol')) {
      root.dispatchEvent(new CustomEvent('lab-open', { bubbles: true, detail: { id: obj.dataset.obj } }));
      return;
    }
    /* A second activation of the SAME Book opens it. Activating a different one
     * selects that one — including an immediate neighbour, which is the whole
     * point of §14. There is no close-first step. */
    if (obj.dataset.obj === state.selected || e.target.closest('[data-open]')) {
      root.dispatchEvent(new CustomEvent('lab-open', { bubbles: true, detail: { id: obj.dataset.obj } }));
      return;
    }
    select(obj.dataset.obj);
  };

  const onChange = (e) => {
    if (e.target.matches('[data-rows]')) { state.rowSize = Number(e.target.value); paint(); }
    else if (e.target.matches('[data-compare]')) { state.compare = e.target.checked; paint(); }
    else if (e.target.matches('[data-with]')) { state.compareWith = e.target.value; paint(); }
  };

  const onKey = (e) => {
    if (e.key === 'Escape' && state.selected) { e.preventDefault(); select(state.selected); return; }
    const obj = e.target.closest('[data-obj]');
    if (!obj || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    if (!obj.classList.contains('cb-vol') || obj.dataset.obj === state.selected) {
      root.dispatchEvent(new CustomEvent('lab-open', { bubbles: true, detail: { id: obj.dataset.obj } }));
      return;
    }
    select(obj.dataset.obj, { focus: true });
  };

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onKey);
  paint();

  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    root.removeEventListener('keydown', onKey);
  };
}

export { CATEGORIES, state as __state, bookThickness };
