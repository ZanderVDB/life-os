/**
 * The Library overview — the shelf.
 *
 * Two groupings, deliberately: **Recent** (what you touched last) and **All**.
 * Not a folder tree. Library's premise is that a resource exists once and is
 * pointed at from everywhere else; a hierarchy would immediately ask the user
 * to decide which single place a thing belongs to, which is the question
 * Library exists to avoid.
 *
 * There is no right rail. Item details, backlinks and activity would fill one —
 * none of them exist yet, and an empty rail is worse than no rail.
 */

import { lib, ACCENT_FALLBACK } from './library-api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Only the types F1 gave a complete endpoint. §9: absent, not disabled. */
export const CREATABLE = [
  { type: 'book', label: 'New Book', hint: 'Sections and pages you write in' },
  { type: 'document', label: 'New Document', hint: 'Written information, no book needed' },
  { type: 'link', label: 'Save Link', hint: 'A URL worth keeping' },
];

export const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'book', label: 'Books' },
  { id: 'document', label: 'Documents' },
  { id: 'link', label: 'Links' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'file', label: 'Files' },
];

const TYPE_LABEL = {
  book: 'Book', document: 'Document', image: 'Image',
  video: 'Video', link: 'Link', file: 'File',
};

/* A distinct mark per type. A Library of identical cards is a list that has
 * given up on being scanned. */
const TYPE_ICON = {
  book: '<path d="M4 4h2.6v13H4zM8 4h2.6v13H8z"/><path d="m12.6 4.6 2.5.7-2.8 12-2.5-.7z"/>',
  document: '<path d="M5.5 3h6L15 6.5V17H5.5z"/><path d="M11.5 3v3.5H15M8 10h4M8 13h4"/>',
  link: '<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1"/>',
  image: '<rect x="3" y="4.5" width="14" height="11" rx="2"/><circle cx="7.5" cy="8.5" r="1.3"/><path d="m3.6 14 3.8-3.6 3 2.8 2.6-2.3 3.4 3.1"/>',
  video: '<rect x="3" y="5" width="10" height="10" rx="2"/><path d="m13 10 4-2.6v5.2z"/>',
  file: '<path d="M5.5 3h6L15 6.5V17H5.5z"/><path d="M11.5 3v3.5H15"/>',
};

const typeIcon = (type, size = 18) =>
  `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    >${TYPE_ICON[type] ?? TYPE_ICON.file}</svg>`;

/** "3 sections · 8 pages" for a book, something honest for everything else. */
function metaLine(item) {
  if (item.type === 'book' && item.book) {
    const s = item.book.sectionCount ?? 0;
    const p = item.book.pageCount ?? 0;
    return `${s} section${s === 1 ? '' : 's'} · ${p} page${p === 1 ? '' : 's'}`;
  }
  if (item.type === 'link' && item.sourceUrl) {
    try { return new URL(item.sourceUrl).hostname.replace(/^www\./, ''); } catch { return 'Link'; }
  }
  if (item.sizeBytes) {
    const kb = item.sizeBytes / 1024;
    return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
  }
  return TYPE_LABEL[item.type] ?? 'Item';
}

const when = (iso) => {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/* ── Header ──────────────────────────────────────────────────────────── */

export function headerHtml() {
  /* `lib-page` is the marker the shell watches to hide the right rail. Calendar
   * and Projects use the same mechanism (`.cal-head`, `.pj-head`). Library uses
   * its width for Library: an empty contextual rail is worse than no rail, and
   * a 485px-wide book is not a book. */
  return `<p class="eyebrow lib-page">Life OS</p><h1>Library</h1>
    <p class="sub">Everything worth keeping, in one place.</p>
    <div class="page-actions">
      <button class="btn btn-primary" id="lib-add" aria-haspopup="menu" aria-expanded="false">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor"
          stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>
        <span>Add</span>
      </button>
    </div>`;
}

export function filtersHtml() {
  const counts = countByType(lib.items);
  return `<div class="lib-bar">
    <div class="lib-filters" role="tablist" aria-label="Filter Library">
      ${FILTERS.filter((f) => f.id === 'all' || counts[f.id]).map((f) => `
        <button type="button" class="chip ${lib.filter === f.id ? 'on' : ''}" role="tab"
          aria-selected="${lib.filter === f.id}" data-filter="${f.id}">${f.label}${
  f.id !== 'all' ? `<span class="chip-n">${counts[f.id]}</span>` : ''}</button>`).join('')}
    </div>
    <div class="lib-bar-right">
      <label class="lib-search">
        <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor"
          stroke-width="1.7" stroke-linecap="round" aria-hidden="true"
          ><circle cx="9" cy="9" r="5"/><path d="m13 13 3.5 3.5"/></svg>
        <input type="search" id="lib-q" value="${esc(lib.query)}"
          placeholder="Search Library" aria-label="Search Library">
      </label>
      <button type="button" class="btn btn-ghost btn-sm ${lib.showArchived ? 'on' : ''}"
        id="lib-archived" aria-pressed="${lib.showArchived}">${
  lib.showArchived ? 'Hide archived' : 'Archived'}</button>
    </div>
  </div>`;
}

function countByType(items) {
  const out = {};
  for (const i of items) {
    if (i.archivedAt && !lib.showArchived) continue;
    out[i.type] = (out[i.type] ?? 0) + 1;
  }
  return out;
}

/* ── Body ────────────────────────────────────────────────────────────── */

/** The items the current filter, query and archive toggle actually show. */
export function visibleItems() {
  const q = lib.query.trim().toLowerCase();
  return lib.items.filter((i) => {
    if (i.archivedAt && !lib.showArchived) return false;
    if (lib.filter !== 'all' && i.type !== lib.filter) return false;
    if (!q) return true;
    return `${i.title} ${i.description ?? ''} ${i.sourceUrl ?? ''}`.toLowerCase().includes(q);
  });
}

export function bodyHtml() {
  if (lib.loading && !lib.itemsLoaded) {
    return `${filtersHtml()}<div class="lib-grid">${
      '<div class="skeleton lib-skel"></div>'.repeat(6)}</div>`;
  }
  if (lib.error && !lib.itemsLoaded) {
    return `<div class="state"><b>Library did not load</b>${esc(lib.error)}
      <div style="margin-top:16px"><button class="btn" id="lib-retry">Try again</button></div></div>`;
  }

  const items = visibleItems();
  if (!items.length) {
    // Not empty if the words are inside a book — §22. Saying "nothing matched"
    // over a list of matches is the worst version of this screen.
    return `${filtersHtml()}${lib.pageHits?.length ? pageHitsHtml(lib.pageHits) : emptyHtml()}`;
  }

  /* Recent is the last five touched, and they ALSO appear in All. A shortcut
   * that removes things from where you expect to find them is not a shortcut. */
  const recent = [...items]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 5);
  const showRecent = items.length > 6 && !lib.query.trim();

  return `${filtersHtml()}
    ${showRecent ? `<section class="lib-sec" aria-labelledby="lib-recent-h">
      <h2 class="lib-sec-h" id="lib-recent-h">Recent</h2>
      <div class="lib-grid lib-grid-recent">${recent.map(cardHtml).join('')}</div>
    </section>` : ''}
    <section class="lib-sec" aria-labelledby="lib-all-h">
      <h2 class="lib-sec-h" id="lib-all-h">${showRecent ? 'All' : `${items.length} item${
  items.length === 1 ? '' : 's'}`}</h2>
      <div class="lib-grid">${items.map(cardHtml).join('')}</div>
    </section>
    ${pageHitsHtml(lib.pageHits)}`;
}

/**
 * One card.
 *
 * A book shows a spine — a slim coloured edge — so the shelf reads as a shelf
 * at a glance rather than as six identical rectangles.
 */
export function cardHtml(item) {
  const archived = !!item.archivedAt;
  return `<article class="lib-card ${archived ? 'is-archived' : ''}" data-item="${item.id}"
    data-type="${esc(item.type)}" tabindex="0" role="button"
    aria-label="${esc(item.title)}, ${TYPE_LABEL[item.type] ?? 'item'}">
    <span class="lib-spine" aria-hidden="true"></span>
    <div class="lib-card-top">
      <span class="lib-card-icon">${typeIcon(item.type)}</span>
      <span class="lib-card-type">${TYPE_LABEL[item.type] ?? 'Item'}</span>
      ${archived ? '<span class="lib-card-arch">Archived</span>' : ''}
      <button type="button" class="lib-card-more" data-more="${item.id}"
        aria-label="Actions for ${esc(item.title)}" aria-haspopup="menu">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true"
          ><circle cx="5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15" cy="10" r="1.4"/></svg>
      </button>
    </div>
    <h3 class="lib-card-title">${esc(item.title)}</h3>
    ${item.description ? `<p class="lib-card-desc">${esc(item.description)}</p>` : ''}
    <div class="lib-card-foot">
      <span class="lib-card-meta">${esc(metaLine(item))}</span>
      <span class="lib-card-when">${esc(when(item.updatedAt))}</span>
    </div>
  </article>`;
}

/**
 * Pages inside books that match the shelf search (§22).
 *
 * The card filter above is instant and local; this is the half that reaches
 * into content. Both are shown, because "search my Library" means the thing you
 * are looking for might be a book, or might be a sentence on page four of one —
 * and only one of those is answerable without asking the server.
 */
export function pageHitsHtml(hits) {
  if (!hits?.length) return '';
  return `<section class="lib-sec" aria-labelledby="lib-pages-h">
    <h2 class="lib-sec-h" id="lib-pages-h">Inside your books</h2>
    <ul class="lib-hits" role="list">
      ${hits.map((h) => `<li><button type="button" class="lib-hit"
        data-hit-book="${esc(h.bookId)}" data-hit-section="${esc(h.sectionId)}"
        data-hit-page="${esc(h.pageId)}">
        <span class="lib-hit-where">${esc(h.bookTitle)} · ${esc(h.sectionTitle)}${
  h.pageTitle ? ` · ${esc(h.pageTitle)}` : ''}</span>
        <span class="lib-hit-text">${esc(h.excerpt)}</span>
      </button></li>`).join('')}
    </ul>
  </section>`;
}

function emptyHtml() {
  if (lib.query.trim()) {
    return `<div class="state lib-empty"><b>Nothing matched “${esc(lib.query)}”</b>
      Try a shorter word, or clear the search.
      <div style="margin-top:16px"><button class="btn btn-sm" id="lib-clear-q">Clear search</button></div></div>`;
  }
  if (lib.filter !== 'all') {
    return `<div class="state lib-empty"><b>No ${
      esc((FILTERS.find((f) => f.id === lib.filter)?.label ?? '').toLowerCase())} yet</b>
      They will appear here once you add one.</div>`;
  }
  if (lib.showArchived) {
    return '<div class="state lib-empty"><b>Nothing archived</b>Archived items are kept, not deleted.</div>';
  }
  return `<div class="state lib-empty lib-empty-first">
    <b>Your Library is empty</b>
    Library is where a resource lives once — a book you write, a document, a link
    worth keeping — so everything else in Life OS can point at it.
    <div class="lib-empty-acts">
      <button class="btn btn-primary" data-new="book">Create your first Book</button>
      <button class="btn" data-new="document">New Document</button>
      <button class="btn" data-new="link">Save a Link</button>
    </div>
  </div>`;
}

/* ── Add menu (§9) ───────────────────────────────────────────────────── */

export function addMenuHtml() {
  return `<div class="lib-menu" role="menu" aria-label="Add to Library">
    ${CREATABLE.map((c) => `<button type="button" role="menuitem" data-new="${c.type}">
      <span class="lib-menu-i">${typeIcon(c.type, 16)}</span>
      <span><b>${c.label}</b><small>${c.hint}</small></span>
    </button>`).join('')}
  </div>`;
}

/* ── Item actions (§24) ──────────────────────────────────────────────── */

export const itemMenuHtml = (item) => `<div class="lib-menu lib-menu-sm" role="menu"
  aria-label="Actions for ${esc(item.title)}">
  ${item.type === 'book' ? '<button type="button" role="menuitem" data-act="open">Open book</button>' : ''}
  ${item.type === 'link' && item.sourceUrl
    ? '<button type="button" role="menuitem" data-act="visit">Open link</button>' : ''}
  <button type="button" role="menuitem" data-act="rename">Rename…</button>
  ${item.archivedAt
    ? '<button type="button" role="menuitem" data-act="restore">Restore</button>'
    : '<button type="button" role="menuitem" data-act="archive">Archive</button>'}
</div>`;

export { esc, TYPE_LABEL, typeIcon, metaLine, when, ACCENT_FALLBACK };
