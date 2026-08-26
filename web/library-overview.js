/**
 * The Library overview — a room, composed of shelves (Phase L3).
 *
 * Not a folder tree, and now not a card grid either. Library's premise is that
 * a resource exists once and is pointed at from everywhere else; a hierarchy
 * would immediately ask which single place a thing belongs to, which is the
 * question Library exists to avoid. What replaced the grid is a set of labelled
 * shelves, because a grid answers "what do I have" and a shelf also answers
 * "where is it" — you remember a position on a shelf in a way you never
 * remember a cell in a reflowing grid.
 *
 * ── The composition rule ─────────────────────────────────────────────────
 *
 * ONLY SHELVES THAT HAVE SOMETHING ON THEM ARE DRAWN (§11). Four empty
 * category headings is a filing cabinet showing you its dividers. The room
 * adapts to what actually exists: one Book gets a centred shelf, forty get a
 * scrolling one, and nothing gets a calm empty state rather than a rack of
 * labelled nothing.
 */

import { lib, ACCENT_FALLBACK } from './library-api.js';
import { isPhone } from './mobile.js';
import {
  shelfHtml, objectHtml, diaryObjectHtml, recencyLabel, TYPE_LABEL,
  fileSize, duration, domainOf, esc,
} from './library-shelf.js';

/** Only the types F1 gave a complete endpoint. §15: absent, not disabled. */
export const CREATABLE = [
  { type: 'book', label: 'New Book', hint: 'Sections and pages you write in' },
  { type: 'document', label: 'New Document', hint: 'Written information, no book needed' },
  { type: 'link', label: 'Save Link', hint: 'A URL worth keeping' },
];

export const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'book', label: 'Books' },
  { id: 'document', label: 'Documents' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'link', label: 'Links' },
  { id: 'file', label: 'Files' },
];

/**
 * The shelves, in reading order, and what each one collects.
 *
 * Media and Clippings deliberately group two types each. Six shelves for six
 * types would be a taxonomy; four is a room. Images and videos are both "things
 * you look at", links and files are both "things you kept from elsewhere", and
 * grouping them means a Library with two videos does not get a shelf of its own
 * with two videos on it.
 */
export const SHELVES = [
  /* Project Books first, and grouped by the state of the PROJECT.
   *
   * §16: a Book is never moved because its Project changed state. `item.project.shelf`
   * is computed by the server at read time from the Project's lifecycle, so
   * completing a Project — and reopening it — moves its Book between these
   * shelves with no write to the Book at all. Nothing can drift, because there
   * is nothing stored to drift from.
   *
   * Archived Projects are last and collapsed by default: they are the shelf you
   * want to exist and not to look at. */
  { id: 'projects_active', title: 'Active projects', types: ['book'], kind: 'book', shelf: 'projects_active' },
  { id: 'projects_completed', title: 'Completed projects', types: ['book'], kind: 'book', shelf: 'projects_completed' },
  { id: 'projects_archived', title: 'Archived projects', types: ['book'], kind: 'book', shelf: 'projects_archived', collapsed: true },
  { id: 'books', title: 'Books', types: ['book'], kind: 'book' },
  { id: 'documents', title: 'Documents', types: ['document'], kind: 'res' },
  { id: 'media', title: 'Media', types: ['image', 'video'], kind: 'res' },
  { id: 'clippings', title: 'Links & Files', types: ['link', 'file'], kind: 'res' },
];

/**
 * Whether an item belongs on a shelf.
 *
 * A Project Book belongs to its Project shelf and NOT to Books, so it appears
 * exactly once — the same rule the Projects overview applies to a project with
 * a health signal. A Book with no Project is an ordinary Book (§18).
 */
export const belongsOn = (item, shelf) => (shelf.shelf
  ? item.project?.shelf === shelf.shelf
  : shelf.types.includes(item.type) && !item.project);

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
  if (item.type === 'link' && item.sourceUrl) return domainOf(item.sourceUrl) || 'Link';
  if (item.type === 'video' && Number.isFinite(item.metadata?.durationSeconds)) {
    return duration(item.metadata.durationSeconds);
  }
  if (item.sizeBytes) return fileSize(item.sizeBytes);
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
      ${isPhone() ? `<div class="lib-view" role="group" aria-label="Library view">
        <button type="button" class="lib-view-b ${libView() === 'browse' ? 'on' : ''}"
          data-lib-view="browse" aria-pressed="${libView() === 'browse'}">Browse</button>
        <button type="button" class="lib-view-b ${libView() === 'shelf' ? 'on' : ''}"
          data-lib-view="shelf" aria-pressed="${libView() === 'shelf'}">Shelf</button>
      </div>` : ''}
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

/**
 * Recently opened (§12).
 *
 * Ordered by `lastOpenedAt` where it exists and `updatedAt` where it does not,
 * which is a fallback for ORDERING only — each object still says which of the
 * two it is showing, so nothing here claims an opening that did not happen.
 *
 * Capped at six and hidden below a Library of eight, because a "recent" shelf
 * that lists most of what you own is a second copy of the room.
 */
export function recentItems(items) {
  if (items.length < 8) return [];
  return [...items]
    .sort((a, b) => new Date(b.lastOpenedAt ?? b.updatedAt) - new Date(a.lastOpenedAt ?? a.updatedAt))
    .slice(0, 6);
}

export function bodyHtml() {
  if (lib.loading && !lib.itemsLoaded) return shelfSkeletonHtml();
  if (lib.error && !lib.itemsLoaded) {
    return `<div class="state"><b>Library did not load</b>${esc(lib.error)}
      <div style="margin-top:16px"><button class="btn" id="lib-retry">Try again</button></div></div>`;
  }

  const items = visibleItems();
  const searching = !!lib.query.trim();

  /* Search replaces the shelves with a focused result surface (§13). Making
   * somebody scroll four shelves to find what they just searched for is the
   * one thing a search must never do. */
  if (searching) return `${filtersHtml()}${resultsHtml(items)}${pageHitsHtml(lib.pageHits)}`;

  if (!items.length) return `${filtersHtml()}${emptyHtml()}`;

  /* ── Browse first on a phone (§29) ────────────────────────────────────
   *
   * The shelf is the best thing in Library and it is not what a phone is for.
   * Standing up, one-handed, the question is "where is that thing I saved",
   * and the answer to that is search and a list — not four horizontally
   * scrolling shelves of covers, each of which takes a screenful to show
   * eight items.
   *
   * The shelf is one tap away and the choice is remembered, so somebody who
   * wants the room can have it. Nothing is missing from either view: they
   * are the same items, arranged for different questions. */
  if (isPhone() && libView() === 'browse') return browseHtml(items);

  const recent = recentItems(items);
  const shelves = SHELVES.map((s) => {
    const own = items.filter((i) => belongsOn(i, s));
    /* The Diary ledge rides above the Books shelf and is drawn even when there
     * are no Books — it is not a Library item and its presence does not depend
     * on owning any (§19). */
    if (!own.length && s.id !== 'books') return '';
    if (!own.length && s.id === 'books' && lib.filter !== 'all') return '';
    return shelfHtml({
      id: s.id, title: s.title, items: own, kind: s.kind, collapsed: s.collapsed,
    });
  }).filter(Boolean).join('');

  return `${filtersHtml()}
    <div class="lib-shelves">
      ${recent.length ? shelfHtml({
    id: 'recent', title: 'Recently opened', items: recent, kind: 'res',
    note: recent.every((i) => !i.lastOpenedAt) ? 'by last edit' : '',
  }) : ''}
      ${lib.filter === 'all' || lib.filter === 'book' ? personalShelfHtml() : ''}
      ${shelves}
    </div>
    ${pageHitsHtml(lib.pageHits)}`;
}

/* Which arrangement the phone is showing. Remembered, because it is a
 * preference about how somebody reads rather than a state of the page. */
export const libView = () => {
  try { return localStorage.getItem('los2_lib_view') === 'shelf' ? 'shelf' : 'browse'; }
  catch { return 'browse'; }
};
export const setLibView = (v) => {
  try { localStorage.setItem('los2_lib_view', v); } catch { /* private mode */ }
};

/**
 * Library, arranged for finding rather than for browsing.
 *
 * The same items the shelf holds, in the same groups, as a vertical list of
 * cards. Search is at the top because on a phone it is the most likely first
 * action, and Recent is directly beneath it because the second most likely
 * thing you want is the thing you had open last.
 */
export function browseHtml(items) {
  const recent = recentItems(items);
  const groups = SHELVES
    .map((sh) => ({ title: sh.title, own: items.filter((i) => belongsOn(i, sh)) }))
    .filter((g) => g.own.length);

  const sec = (title, list, note = '') => `<section class="lib-sec">
    <h2 class="lib-sec-h">${esc(title)}${note ? ` <span class="lib-sec-n">${esc(note)}</span>` : ''}</h2>
    <div class="lib-grid">${list.map(cardHtml).join('')}</div>
  </section>`;

  return `${filtersHtml()}
    <div class="lib-browse">
      ${recent.length ? sec('Recent', recent,
    recent.every((i) => !i.lastOpenedAt) ? 'by last edit' : '') : ''}
      ${lib.filter === 'all' || lib.filter === 'book' ? personalRowHtml() : ''}
      ${groups.map((g) => sec(g.title, g.own)).join('')}
    </div>
    ${pageHitsHtml(lib.pageHits)}`;
}

/**
 * The Diary, in Browse (§32).
 *
 * On a shelf it is a lavender volume standing among the books, and that is
 * right — it is one of your books. In a LIST it was a single cover stranded
 * in an otherwise empty shelf rail, which reads as a rendering accident
 * rather than as a section with one thing in it.
 *
 * So in Browse it is a row like every other row, and it keeps its identity
 * where identity belongs: on the cover, when you open it.
 */
export function personalRowHtml() {
  return `<section class="lib-sec">
    <h2 class="lib-sec-h">Personal</h2>
    <button type="button" class="lib-row-card" data-system="diary">
      <span class="lib-row-ico" data-accent="lavender">${typeIcon('book', 20)}</span>
      <span class="lib-row-t">
        <span class="lib-row-title">My Diary</span>
        <span class="lib-row-meta">Life OS Journal · part of Life OS</span>
      </span>
      <span class="lib-row-go" aria-hidden="true">&rsaquo;</span>
    </button>
  </section>`;
}

/**
 * The personal ledge (§19/§30, treatment B).
 *
 * Its own small shelf above the Books, so a system-owned Book never has to
 * pretend to be one of yours. Nothing on this ledge has a `library_items` row,
 * an overflow menu, an archive action or a place in Library search.
 */
export function personalShelfHtml() {
  return `<section class="lib-shelf lib-shelf-personal" data-shelf="personal"
    role="group" aria-labelledby="lib-sh-personal">
    <div class="lib-shelf-head">
      <h2 class="lib-shelf-h" id="lib-sh-personal">Personal</h2>
      <span class="lib-shelf-note">Part of Life OS, not a Library item</span>
    </div>
    <div class="lib-rail" data-rail="personal">
      <ul class="lib-row" role="list"><li class="lib-slot">${diaryObjectHtml()}</li></ul>
    </div>
  </section>`;
}

/**
 * The search result surface (§13).
 *
 * One wrapped set rather than four rails: results are a temporary answer to a
 * question, and a question deserves everything visible at once rather than four
 * more places to look. Each result keeps its own type's visual, so a Book still
 * arrives as a cover and a link still arrives as a clipping.
 */
export function resultsHtml(items) {
  if (!items.length) {
    return lib.pageHits?.length ? '' : `<div class="state lib-empty">
      <b>Nothing matched “${esc(lib.query)}”</b>
      Try a shorter word, or clear the search.
      <div style="margin-top:16px"><button class="btn btn-sm" id="lib-clear-q">Clear search</button></div></div>`;
  }
  return `<section class="lib-results" aria-label="Search results">
    <h2 class="lib-shelf-h">${items.length} match${items.length === 1 ? '' : 'es'}</h2>
    <div class="lib-found">${items.map((it, i) => objectHtml(it, i, items.length)).join('')}</div>
  </section>`;
}

/**
 * Pages inside books that match the shelf search (§13).
 *
 * The item filter above is instant and local; this is the half that reaches
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

/**
 * Waiting (§32).
 *
 * A shelf shape on a ledge, not a grey slab, and four objects rather than
 * twelve: a placeholder that promises more than arrives is its own small
 * dishonesty, and four already reads as "a shelf".
 */
export function shelfSkeletonHtml() {
  return `<div data-loading="shelf">
    <div class="lib-skel-bar" aria-hidden="true">
      ${'<span class="skeleton lib-skel-pill"></span>'.repeat(4)}
    </div>
    <div class="lib-shelves">
      <section class="lib-shelf"><div class="lib-shelf-head">
        <span class="skeleton lib-skel-pill" style="width:64px;height:14px"></span></div>
        <div class="lib-rail"><div class="lib-skel-shelf" aria-hidden="true">
          ${'<span class="skeleton lib-skel-book"></span>'.repeat(4)}
        </div></div></section>
      <section class="lib-shelf"><div class="lib-shelf-head">
        <span class="skeleton lib-skel-pill" style="width:88px;height:14px"></span></div>
        <div class="lib-rail"><div class="lib-skel-shelf" aria-hidden="true">
          ${'<span class="skeleton lib-skel-res"></span>'.repeat(4)}
        </div></div></section>
    </div>
    <p class="sr-only" role="status">Loading your Library</p>
  </div>`;
}

/**
 * An empty Library (§25).
 *
 * No rack of empty shelves stretching across the page — a Library you have not
 * filled should not show you the size of the gap. One faint ledge with nothing
 * on it, so the room is still legible as a room, and the three things you can
 * actually do.
 */
function emptyHtml() {
  if (lib.filter !== 'all') {
    return `<div class="state lib-empty"><b>No ${
      esc((FILTERS.find((f) => f.id === lib.filter)?.label ?? '').toLowerCase())} yet</b>
      They will appear here once you add one.</div>`;
  }
  if (lib.showArchived) {
    return '<div class="state lib-empty"><b>Nothing archived</b>Archived items are kept, not deleted.</div>';
  }
  return `<div class="lib-shelves">
    ${personalShelfHtml()}
    <section class="lib-shelf lib-shelf-blank" aria-label="Your Library">
      <div class="lib-rail"><div class="lib-blank" aria-hidden="true"></div></div>
      <div class="state lib-empty lib-empty-first">
        <b>Your Library is empty</b>
        Library is where a resource lives once — a book you write, a document, a link
        worth keeping — so everything else in Life OS can point at it.
        <div class="lib-empty-acts">
          <button class="btn btn-primary" data-new="book">Create your first Book</button>
          <button class="btn" data-new="document">New Document</button>
          <button class="btn" data-new="link">Save a Link</button>
        </div>
      </div>
    </section>
  </div>`;
}

/* ── Add menu (§15) ──────────────────────────────────────────────────── */

export function addMenuHtml() {
  return `<div class="lib-menu" role="menu" aria-label="Add to Library">
    ${CREATABLE.map((c) => `<button type="button" role="menuitem" data-new="${c.type}">
      <span class="lib-menu-i">${typeIcon(c.type, 16)}</span>
      <span><b>${c.label}</b><small>${c.hint}</small></span>
    </button>`).join('')}
  </div>`;
}

/* ── Item actions (§29) ──────────────────────────────────────────────── */

export const itemMenuHtml = (item) => `<div class="lib-menu lib-menu-sm" role="menu"
  aria-label="Actions for ${esc(item.title)}">
  ${item.type === 'book' ? '<button type="button" role="menuitem" data-act="open">Open book</button>' : ''}
  ${item.type === 'link' && item.sourceUrl
    ? '<button type="button" role="menuitem" data-act="visit">Open link</button>' : ''}
  <button type="button" role="menuitem" data-act="rename">Rename…</button>
  ${item.archivedAt
    ? '<button type="button" role="menuitem" data-act="restore">Restore</button>'
    : '<button type="button" role="menuitem" data-act="archive">Archive</button>'}
  <button type="button" role="menuitem" class="lib-menu-del" data-act="delete">Delete…</button>
</div>`;

/**
 * Still exported for the item view, which is a page rather than a shelf.
 *
 * The overview no longer renders cards — an item opened on its own still needs
 * a card-shaped summary, and that is the only thing left using this.
 */
export function cardHtml(item) {
  const archived = !!item.archivedAt;
  return `<article class="lib-card ${archived ? 'is-archived' : ''}" data-item="${item.id}"
    data-type="${esc(item.type)}" tabindex="0" role="button"
    aria-label="${esc(item.title)}, ${TYPE_LABEL[item.type] ?? 'item'}">
    <span class="lib-spine-flat" aria-hidden="true"></span>
    <div class="lib-card-top">
      <span class="lib-card-icon">${typeIcon(item.type)}</span>
      <span class="lib-card-type">${TYPE_LABEL[item.type] ?? 'Item'}</span>
      ${archived ? '<span class="lib-card-arch">Archived</span>' : ''}
      <!-- The same overflow the shelf object carries. Browse is not a
           reduced Library: rename, archive and the rest are here too. -->
      <button type="button" class="util-btn lib-card-more" data-more="${esc(item.id)}"
        aria-haspopup="menu" aria-expanded="false"
        aria-label="Actions for ${esc(item.title)}">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/>
          <circle cx="15.5" cy="10" r="1.5"/></svg>
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

export { esc, TYPE_LABEL, typeIcon, metaLine, when, recencyLabel, ACCENT_FALLBACK };
