/**
 * The Book — cover, spread, sections, pages and the editor.
 *
 * The geometry is lifted from `library-v2-legacy-book-audit.md`, which was read
 * from the Legacy source rather than from screenshots. The identity of that book
 * is almost entirely proportion and surface: A4 210/297, a 420/297 spread, a 6px
 * gutter, page padding 28/32/18/58, a margin stripe at 46px, a coloured inset
 * edge mirrored on the right page, and ruled lines whose repeat cycle equals the
 * line-height. Those numbers are not approximations to be tidied up.
 *
 * What is NOT carried over is the behaviour. Legacy re-rendered the whole book
 * with `innerHTML` on every change, which destroyed the contenteditable, its
 * selection and its undo history on every keystroke-triggered repaint. Here the
 * editor node is created once per page and never replaced while it is being
 * typed into — see `mountSpread`.
 */

import {
  docToHtml, htmlToDoc, docToText, regionsToDoc, newBlockId, setRefLookup,
} from './editor-doc.js';
import {
  lib, currentSection, currentSpread, spreadCount,
  createSection, updateSection, archiveSection, createPages, archivePage, search,
} from './library-api.js';
import {
  queueSave, flush, statusOf, entryOf, trackPage, STATUS_LABEL, onSaveStatus,
} from './library-save.js';
import { reducedMotion } from './motion.js';
import {
  handleEnter, handleBackspace, applyBlockStyle, currentStyleId, BLOCK_STYLES,
} from './editor-blocks.js';

import { mountPinboard } from './pinboard.js';
import { attachPinViewport, pinViewportControlsHtml } from './pinboard-touch.js';
import { isPhone } from './mobile.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const ACCENTS = ['peach', 'sage', 'lavender', 'gold', 'blue', 'rose'];

/* ══ Cover ═══════════════════════════════════════════════════════════════
 *
 * The audited composition: small-caps pre-title, Playfair display title,
 * italic subtitle, a short rule, an uppercase author line. Legacy rendered this
 * as an EMPTY STATE — shown only when a book had no sections. Here it is a real
 * state of a real book, which is what makes "Open Book" meaningful.
 */
export function coverHtml() {
  const { item, book } = lib.book;
  const year = new Date(item.createdAt).getFullYear();
  /* The arrow slots are present but invisible, and the frame carries the OPEN
   * book's proportions. Together they make the closed cover exactly one page
   * of the open book — same height, half the width — instead of a differently
   * shaped card that happens to say the same title. */
  return `<div class="bk-stage bk-stage-cover">
    <span class="bk-arrow bk-arrow-ghost" aria-hidden="true"></span>
    <div class="bk-cover-frame">
    <div class="bk-book bk-cover-book" id="bk-book">
      <div class="bk-page bk-cover-page">
        <div class="bk-cover">
          <span class="bk-cover-mark">Life OS</span>
          <span class="bk-cover-pre">Notebook</span>
          <h1 class="bk-cover-title">${esc(item.title)}</h1>
          ${book.subtitle ? `<p class="bk-cover-sub">${esc(book.subtitle)}</p>` : ''}
          <div class="bk-cover-rule" aria-hidden="true"></div>
          <p class="bk-cover-author">${esc(book.authorLabel || 'Life OS')} · ${year}</p>
          <button type="button" class="btn btn-primary bk-open" id="bk-open">Open book</button>
        </div>
      </div>
    </div>
    </div>
    <span class="bk-arrow bk-arrow-ghost" aria-hidden="true"></span>
  </div>

  <!-- THE BOOK, not its pages.
       Three different things live near each other here and conflating them
       would make all three useless:
         · Book → Section → Page is OWNERSHIP, and structural. It is the
           contents list, not a relationship, and never appears here.
         · What THIS BOOK is about is a relationship belonging to the library
           item — it sits on the cover, which is the book as an object.
         · What one PAGE is connected to belongs to that page, and is shown on
           the spread when the page is open.
       Page links are deliberately NOT rolled up onto the cover: a book with
       forty pages would show forty relationships that are not about the book,
       and the one that IS about the book would be lost among them. -->
  <div class="bk-cover-rel">
    <div class="rel-host" data-rel-host="library:${esc(item.id)}"></div>
  </div>`;
}

/* ══ Spread ══════════════════════════════════════════════════════════════ */

/**
 * Is there anywhere forward from here?
 *
 * Below 820px a spread is read one page at a time, so the right-hand page of
 * the final spread is still somewhere to go. An arrow that is enabled but does
 * nothing is a fake control; one that is disabled while there IS a page left is
 * a dead end. Both are wrong, so this is computed rather than assumed.
 */
export function canGoNext() {
  const section = currentSection();
  if (!section) return false;
  const narrow = typeof window !== 'undefined'
    && window.matchMedia('(max-width: 820px)').matches;
  if (narrow && lib.half === 0 && currentSpread().right) return true;
  if (lib.spreadIdx < spreadCount(section) - 1) return true;
  return lib.sectionIdx < (lib.book?.sections.length ?? 0) - 1;
}

/* ══ Page layouts ════════════════════════════════════════════════════════
 *
 * Eleven templates, three rendering families, ONE page model.
 *
 *   single flow   notes, blank, ideas, research, learning, checklist, meeting
 *   regions       two_columns, quad, comparison — blocks carry `attrs.region`
 *   pinboard      free positioning, and it occupies the whole spread
 *
 * The families matter because only the last two cost anything. A page of notes
 * and a research page differ in their ruling and their starter headings and in
 * nothing else, so moving between them is free and can never lose a block.
 */
/**
 * SHAPE — how the page is divided. Six, and every one of them genuinely
 * changes the page.
 *
 * The first version had eleven, and six of those were the same page with
 * different starter headings. Once you had typed anything, Lined notes,
 * Checklist, Ideas, Research, Learning and Meeting notes were
 * indistinguishable — because they were the same thing. Those are purposes,
 * and they live below.
 */
export const LAYOUTS = [
  { id: 'notes', label: 'Lined page', hint: 'Ruled writing, the default' },
  { id: 'blank', label: 'Blank page', hint: 'No rules at all' },
  { id: 'two_columns', label: 'Two columns', hint: 'Split down the middle' },
  { id: 'quad', label: 'Four sections', hint: 'A 2×2 grid' },
  { id: 'comparison', label: 'Comparison', hint: 'Option A against option B' },
  { id: 'pinboard', label: 'Pinboard spread', hint: 'A whole spread you can pin to' },
];

/**
 * PURPOSE — what the page is for.
 *
 * A label and a set of starter headings. It changes NOTHING structural, which
 * is the point: a research page and a page of notes are the same page, and the
 * app should say so rather than pretend they are different objects.
 *
 * Independent of shape, so a research page can be two columns — a combination
 * the old single-field model could not express at all.
 */
export const PURPOSES = [
  { id: null, label: 'Just a page', hint: 'No heading, no label' },
  { id: 'checklist', label: 'Checklist', hint: 'Starts with things to tick off' },
  { id: 'ideas', label: 'Ideas', hint: 'Somewhere to put a thought' },
  { id: 'research', label: 'Research', hint: 'Question, findings, sources' },
  { id: 'learning', label: 'Learning', hint: 'What you know, what is unclear' },
  { id: 'meeting', label: 'Meeting notes', hint: 'Who, decisions, actions' },
];

export const purposeLabel = (id) => PURPOSES.find((p) => p.id === id)?.label ?? null;

/** How many editable regions a layout draws, and what each is called. */
const REGIONS_FOR = {
  two_columns: [{ region: 'a', label: '' }, { region: 'b', label: '' }],
  comparison: [{ region: 'a', label: '' }, { region: 'b', label: '' }],
  quad: [{ region: 'a' }, { region: 'b' }, { region: 'c' }, { region: 'd' }],
};
export const regionsOf = (layout) => REGIONS_FOR[layout] ?? null;
export const layoutLabel = (id) => LAYOUTS.find((l) => l.id === id)?.label ?? 'Lined notes';

export function spreadHtml() {
  const section = currentSection();
  const spread = currentSpread();
  const { left, right, full } = spread;
  const total = spreadCount(section);
  const last = lib.spreadIdx >= total - 1;

  /* A pinboard is ONE page across both halves. Rendering it as a left page and
   * leaving the right blank would be drawing a spread-wide surface at half
   * width with an empty leaf beside it. */
  if (full) {
    return `${tabsHtml()}${bookmarksHtml()}
    <div class="bk-stage">
      <button type="button" class="bk-arrow" id="bk-prev"
        aria-label="Previous page">${chev('left')}</button>
      <div class="bk-book bk-spread bk-spread-full" id="bk-book"
        data-accent="${esc(section?.accent ?? 'peach')}">
        ${pinboardPageHtml(full, section)}
      </div>
      <button type="button" class="bk-arrow" id="bk-next" ${canGoNext() ? '' : 'disabled'}
        aria-label="Next page">${chev('right')}</button>
    </div>
    <div class="bk-foot">
      <span class="bk-context" id="bk-context" role="status">${esc(section?.title ?? '')} ·
        spread ${lib.spreadIdx + 1} of ${total}</span>
      <span class="bk-save" id="bk-save" role="status"></span>
    </div>`;
  }

  /* `prev` is never disabled while a spread is showing: there is always
   * somewhere back to go, and on the very first page that somewhere is the
   * cover. It used to be disabled on the first spread, which made the cover
   * unreachable by arrow and, below 820px, made the left-hand page of the
   * first spread unreachable at all once you had stepped onto the right. */
  return `${tabsHtml()}${bookmarksHtml()}
  <div class="bk-stage">
    <button type="button" class="bk-arrow" id="bk-prev"
      aria-label="Previous page">${chev('left')}</button>

    <div class="bk-book bk-spread" id="bk-book" data-accent="${esc(section?.accent ?? 'peach')}">
      ${pageHtml(left, 'left', section)}
      ${pageHtml(right, 'right', section, last)}
    </div>

    <button type="button" class="bk-arrow" id="bk-next" ${canGoNext() ? '' : 'disabled'}
      aria-label="Next page">${chev('right')}</button>
  </div>
  <div class="bk-foot">
    <span class="bk-context" id="bk-context" role="status">${esc(section?.title ?? '')} ·
      spread ${lib.spreadIdx + 1} of ${total}</span>
    <span class="bk-save" id="bk-save" role="status"></span>
  </div>`;
}

/**
 * One page.
 *
 * `right === null` on the final spread of an odd-length section is a RENDERING
 * decision, not a missing row — §20 forbids creating a database row merely to
 * fill a layout. It renders as a deliberate end-of-section leaf carrying the
 * `Add pages` action.
 */
function pageHtml(page, side, section, isLast = false) {
  const accent = section?.accent ?? 'peach';
  if (!page) {
    return `<div class="bk-page bk-page-${side} bk-page-blank" data-accent="${esc(accent)}">
      <div class="bk-blank">
        <p>End of ${esc(section?.title ?? 'section')}</p>
        ${isLast ? '<button type="button" class="btn btn-sm" data-add-pages>Add pages</button>' : ''}
      </div>
    </div>`;
  }
  const layout = page.layout ?? 'notes';
  /* Only a page that HAS a purpose says so. `purposeLabel(null)` is the menu's
   * word for the absence — "Just a page" — and stamping that on every ordinary
   * page is the app narrating its own defaults back at you. */
  const purpose = page.purpose ? purposeLabel(page.purpose) : null;
  return `<div class="bk-page bk-page-${side} bk-l-${esc(layout)}" data-accent="${esc(accent)}"
      data-page="${page.id}" data-layout="${esc(layout)}"
      ${page.purpose ? `data-purpose="${esc(page.purpose)}"` : ''}>
    <div class="bk-page-hdr">
      <input class="bk-page-title" data-page-title="${page.id}"
        value="${esc(page.title ?? '')}" placeholder="${esc(section?.title ?? '')}"
        aria-label="Page title">
      ${/* What the page is FOR, said on the page rather than encoded in its
          structure. This is the whole visible difference between a research
          page and a page of notes, and it is the honest one. */
  purpose ? `<span class="bk-page-purpose">${esc(purpose)}</span>` : ''}
      <button type="button" class="bk-page-more" data-page-more="${page.id}"
        aria-label="Actions for this page" aria-haspopup="menu">${dots()}</button>
    </div>
    ${pageBodyHtml(page, layout)}
    <!-- What points AT this page. References the page itself contains are
         mirrored out of the document by book-links.ts and appear here as
         incoming edges from the other side; a task that names this page as a
         resource appears here too, which is the half that was previously
         invisible from the Book. -->
    <div class="rel-host bk-page-rel" data-rel-host="book_page:${esc(page.id)}"></div>
  </div>`;
}

/**
 * The body of a page, in whichever family its layout belongs to.
 *
 * A region is an ordinary editor over a SUBSET of the same document, filtered by
 * `attrs.region`. That is the whole mechanism: no second document model, no
 * per-template table, and a page keeps one save, one search index and one
 * conflict guard however many columns it happens to draw.
 */
function pageBodyHtml(page, layout) {
  const regions = regionsOf(layout);
  if (!regions) {
    return `<div class="bk-page-body">
      <div class="bk-editor" data-editor="${page.id}" contenteditable="true"
        spellcheck="true" role="textbox" aria-multiline="true"
        aria-label="Page content">${docToHtml(page.content)}</div>
    </div>`;
  }
  return `<div class="bk-page-body bk-regions bk-regions-${regions.length}">
    ${regions.map((r, i) => `<div class="bk-region" data-region="${r.region}">
      <div class="bk-editor" data-editor="${page.id}" data-region-editor="${r.region}"
        contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true"
        aria-label="Page content, area ${i + 1}">${docToHtml(page.content, r.region)}</div>
    </div>`).join('')}
  </div>`;
}

/* ══ Pinboard ════════════════════════════════════════════════════════════
 *
 * A spread you can pin things to. Positions are PERCENTAGES of the board, not
 * pixels: a board arranged on a 2560px monitor has to be the same board on a
 * laptop, and pixels would make the arrangement a property of the screen it was
 * made on.
 *
 * Reference pins store an id and read their title live, exactly like reference
 * blocks — ticking a Task in Projects changes what its pin says here, because
 * there is only ever one copy of that fact.
 */
function pinboardPageHtml(page, section) {
  const accent = section?.accent ?? 'peach';
  return `<div class="bk-page bk-page-full bk-l-pinboard" data-accent="${esc(accent)}"
      data-page="${page.id}" data-layout="pinboard">
    <div class="bk-page-hdr">
      <input class="bk-page-title" data-page-title="${page.id}"
        value="${esc(page.title ?? '')}" placeholder="Pinboard" aria-label="Page title">
      <div class="bk-pin-tools">
        <button type="button" class="btn btn-ghost btn-sm" data-pin-add="text">Add note</button>
        <button type="button" class="btn btn-ghost btn-sm" data-pin-add="link">Add link</button>
        <button type="button" class="btn btn-ghost btn-sm" data-pin-add="image">Add image</button>
        <button type="button" class="bk-page-more" data-page-more="${page.id}"
          aria-label="Actions for this page" aria-haspopup="menu">${dots()}</button>
      </div>
    </div>
    <!-- The board keeps its geometry and the SCREEN moves over it (§33).
         The viewport is inert on a desktop, where the whole spread already
         fits; on a phone it pans and pinches. Same board either way — a
         Pinboard flattened into a list would destroy the arrangement, which
         is the only place the thought was written down. -->
    <div class="pin-vp" data-pin-vp>
      <div class="bk-board" data-board="${page.id}" tabindex="0"
        aria-label="Pinboard. Double-click to write a note; paste a picture or a link."></div>
    </div>
    <!-- Outside the viewport, not over it. The whole canvas is a pan target,
         and a control floating on it is a control you hit while trying to
         move the board. Hidden entirely on a desktop, where there is no pan. -->
    ${pinViewportControlsHtml()}
  </div>`;
}

/* ══ Bookmarks ═══════════════════════════════════════════════════════════
 *
 * Shortcuts, never structure (§5). A bookmark cannot move a page — it is a row
 * of its own precisely so that saying "this matters" and deciding "this comes
 * fourth" stay separate decisions.
 */
function bookmarksHtml() {
  const marks = lib.book?.bookmarks ?? [];
  if (!marks.length) return '';
  return `<div class="bk-marks" role="navigation" aria-label="Bookmarks">
    ${marks.map((m) => `<button type="button" class="bk-mark" data-bookmark="${esc(m.id)}"
      data-page="${esc(m.pageId)}" data-accent="${esc(m.accent)}"
      title="${esc(m.label)}">${esc(m.label)}</button>`).join('')}
  </div>`;
}

/** The markup for a fresh Task reference card, before the next save. */
function refCardHtml(taskId) {
  return `<div class="bk-ref bk-ref-task" contenteditable="false" data-ref="taskRef"
    data-ref-id="${esc(taskId)}" data-block="${newBlockId()}" tabindex="0" role="link">
    <span class="bk-ref-k">Task</span>
    <span class="bk-ref-t">${esc(lookupRef('taskRef', taskId)?.title ?? 'Task')}</span>
    <button type="button" class="bk-ref-x" data-ref-remove
      aria-label="Remove this reference from the page">×</button>
  </div>`;
}

/* ── Pinboard interaction ───────────────────────────────────────────────
 *
 * The board itself lives in pinboard.js: it holds a model, renders from it and
 * owns its own undo. This is only the wiring — one mount per board on the
 * spread, torn down when the spread is replaced.
 */
let boards = [];

function mountPinboards(root, { onDirty, toast }) {
  boards.forEach((b) => b.destroy?.());
  boards = [];
  root.querySelectorAll('[data-board]').forEach((board) => {
    const { page } = pageOf(board.dataset.board);
    if (!page) return;
    boards.push(mountPinboard(board, {
      page,
      save: (content) => queueSave(page, content),
      onDirty,
      lookupRef,
      toast,
    }));
    /* Only where the board cannot be seen whole. On a desktop the spread
     * already fits, and a pan-and-zoom layer over something that fits is a
     * way to get lost inside a page you were looking at. */
    const host = board.closest('[data-pin-vp]');
    if (host && isPhone()) boards.push(attachPinViewport(host, board));
  });
}

const pct = (v, fallback) => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The live entity a reference points at.
 *
 * The Book payload resolves every referenced Task, Project and item once, so
 * this is a map lookup rather than a request. A reference that resolves to
 * nothing is one whose target was deleted; it renders as unavailable and the
 * block stays exactly where it is (§15).
 */
export function lookupRef(type, id) {
  const refs = lib.book?.refs;
  if (!refs || !id) return null;
  if (type === 'taskRef') {
    const t = (refs.tasks ?? []).find((x) => x.id === id);
    return t ? { ...t, kindLabel: 'Task' } : null;
  }
  if (type === 'projectRef') {
    const p = (refs.projects ?? []).find((x) => x.id === id);
    return p ? { ...p, kindLabel: 'Project' } : null;
  }
  const i = (refs.items ?? []).find((x) => x.id === id);
  return i ? { ...i, kindLabel: i.type === 'book' ? 'Book' : 'Resource' } : null;
}

/**
 * The Book's phone bar (§27).
 *
 * A tab strip is a desktop control: it shows every section at once because
 * there is room to. On a phone it is a horizontal scroller where the section
 * you are in may be off-screen, above a page that has already lost a third of
 * its width to arrows.
 *
 * So the sections collapse into ONE control that says where you are — the
 * section, and the page within it — and opens the contents. Everything the
 * tab strip could do is in that sheet, plus the bookmarks and the search that
 * were separate rows above it.
 *
 * Rendered at every width and shown only on a phone: the alternative is a
 * resize that has to re-render the book, and re-rendering a book is how you
 * lose a caret mid-sentence.
 */
export function bookMobileBarHtml(project = null) {
  const section = currentSection();
  const pages = section?.pages ?? [];
  const pageNo = Math.min(pages.length, lib.spreadIdx * 2 + lib.half + 1);
  const open = project ? (lib.projectTasks ?? []).filter((t) => t.status === 'open').length : null;
  return `<div class="bk-mbar">
    <button type="button" class="bk-mbar-x" id="bk-mback" aria-label="Back to Library">
      ${chev('left')}</button>
    <button type="button" class="bk-mbar-mid" id="bk-contents" aria-haspopup="dialog">
      <span class="bk-mbar-sec">${esc(section?.title ?? 'Contents')}</span>
      <span class="bk-mbar-n">${pages.length ? `${pageNo} / ${pages.length}` : '—'}</span>
    </button>
    ${project ? `<button type="button" class="bk-mbar-tasks" id="bk-tasks-btn">
      <span>Tasks</span>${open === null ? '' : `<b>${open}</b>`}</button>` : ''}
  </div>`;
}

/** The contents sheet's body: sections, bookmarks, and a way to search. */
export function bookContentsHtml() {
  const sections = lib.book?.sections ?? [];
  const marks = lib.book?.bookmarks ?? [];
  return `<div class="msheet-group">Sections</div>
    ${sections.map((sec, i) => `<button type="button" class="msheet-row"
      data-go-section="${i}" ${i === lib.sectionIdx ? 'aria-current="page"' : ''}>
      <i class="bk-mdot" style="background:var(--a-${esc(sec.accent)})"></i>
      <span><span class="msheet-label">${esc(sec.title)}</span></span>
      <span class="msheet-r">${sec.pages.length} page${sec.pages.length === 1 ? '' : 's'}</span>
    </button>`).join('')}
    <button type="button" class="msheet-row" id="bk-msec-add">
      <span class="msheet-ico">+</span>
      <span><span class="msheet-label">Add a section</span></span>
    </button>
    ${marks.length ? `<div class="msheet-sep"></div>
      <div class="msheet-group">Bookmarks</div>
      ${marks.map((m) => `<button type="button" class="msheet-row" data-bookmark="${esc(m.id)}"
        data-page="${esc(m.pageId)}">
        <i class="bk-mdot" style="background:var(--a-${esc(m.accent)})"></i>
        <span><span class="msheet-label">${esc(m.label)}</span></span>
      </button>`).join('')}` : ''}
    <div class="msheet-sep"></div>
    <button type="button" class="msheet-row" id="bk-mcover">
      <span class="msheet-ico">&#9670;</span>
      <span><span class="msheet-label">Cover</span></span>
    </button>
    <button type="button" class="msheet-row" id="bk-msearch">
      <span class="msheet-ico">&#8981;</span>
      <span><span class="msheet-label">Search this book</span></span>
    </button>`;
}

function tabsHtml() {
  const sections = lib.book?.sections ?? [];
  return `<div class="bk-tabs" role="tablist" aria-label="Sections">
    ${sections.map((s, i) => `<span class="bk-tab-wrap">
      <button type="button" class="bk-tab ${i === lib.sectionIdx ? 'on' : ''}"
        role="tab" aria-selected="${i === lib.sectionIdx}" data-section="${i}"
        data-accent="${esc(s.accent)}">
        <span class="bk-tab-t">${esc(s.title)}</span>
        <span class="bk-tab-n">${s.pages.length}</span>
      </button>${i === lib.sectionIdx ? `<button type="button" class="bk-tab-more"
        data-section-more="${s.id}" aria-label="Actions for ${esc(s.title)}"
        aria-haspopup="menu">${dots()}</button>` : ''}
    </span>`).join('')}
    <button type="button" class="bk-tab bk-tab-add" id="bk-add-section"
      aria-label="Add a section">+</button>
  </div>`;
}

const dots = () => `<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"
  aria-hidden="true"><circle cx="5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/>
  <circle cx="15" cy="10" r="1.4"/></svg>`;

const chev = (dir) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor"
  stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="${dir === 'left' ? 'm12 4-6 6 6 6' : 'm8 4 6 6-6 6'}"/></svg>`;

/* ══ Toolbar ═════════════════════════════════════════════════════════════
 *
 * Core actions visible, nothing else. A ribbon in a book is a word processor
 * wearing a book's clothes.
 */
export function toolbarHtml() {
  const b = (cmd, label, glyph, key) =>
    `<button type="button" class="bk-tb" data-cmd="${cmd}" aria-label="${label}"
      title="${label}${key ? ` (${key})` : ''}" aria-pressed="false">${glyph}</button>`;
  return `<div class="bk-toolbar" role="toolbar" aria-label="Formatting">
    <select class="bk-tb-style" data-cmd="style" aria-label="Text style">
      ${BLOCK_STYLES.map((st) => `<option value="${st.id}">${st.label}</option>`).join('')}
    </select>
    <span class="bk-tb-sep" aria-hidden="true"></span>
    ${b('bold', 'Bold', '<b>B</b>', 'Ctrl B')}
    ${b('italic', 'Italic', '<i>I</i>', 'Ctrl I')}
    ${b('underline', 'Underline', '<u>U</u>', 'Ctrl U')}
    ${b('strikeThrough', 'Strikethrough', '<s>S</s>')}
    <span class="bk-tb-sep" aria-hidden="true"></span>
    ${b('insertUnorderedList', 'Bullet list', '•—')}
    ${b('insertOrderedList', 'Numbered list', '1—')}
    ${b('link', 'Add link', '🔗', 'Ctrl K')}
    <span class="bk-tb-sep" aria-hidden="true"></span>
    ${b('undo', 'Undo', '↶', 'Ctrl Z')}
    ${b('redo', 'Redo', '↷', 'Ctrl ⇧ Z')}
    <button type="button" class="bk-tb bk-tb-search" id="bk-search-btn"
      aria-label="Search this book" title="Search this book">⌕</button>
  </div>`;
}

/* ══ Mounting ════════════════════════════════════════════════════════════ */

/**
 * Wires a rendered spread.
 *
 * The editor elements are the ones already in the DOM — this never re-creates
 * them, which is what keeps selection and undo history alive while typing.
 */
export function mountSpread(root, { onNavigate, onDirty, toast }) {
  mountPinboards(root, { onDirty, toast });

  root.querySelectorAll('[data-editor]').forEach((el) => {
    const pageId = el.dataset.editor;
    // Registered while `page.content` is still what the server holds. See
    // trackPage — capturing it later captures the user's own typing as the
    // baseline, and then nothing ever looks unsaved.
    const mounted = pageOf(pageId).page;
    if (mounted) trackPage(mounted);

    /* A page's document is whatever ALL its editors say, together. On a
     * single-flow layout that is one editor and this is the identity function;
     * on a two-column page it is what stops typing in the right column from
     * saving a document containing only the right column. */
    const readPage = () => {
      const regions = [...root.querySelectorAll(`[data-editor="${pageId}"][data-region-editor]`)];
      if (!regions.length) return htmlToDoc(el);
      return regionsToDoc(regions.map((r) => ({ region: r.dataset.regionEditor, el: r })));
    };

    el.addEventListener('input', () => {
      const { page } = pageOf(pageId);
      if (!page) return;
      const doc = readPage();
      queueSave(page, doc);
      // AFTER the queue, never before: queueSave compares against what the
      // server has, and this line is what would make that comparison lie.
      // The local record is updated so a page turn and back shows what was
      // typed even before the write lands.
      page.content = doc;
      onDirty?.();
    });

    el.addEventListener('keydown', (e) => {
      /* Enter and Backspace decide what the DOCUMENT becomes, so they are
       * handled before the browser gets them. Everything the rules do not
       * claim falls through to the browser untouched. */
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        if (handleEnter(el)) {
          e.preventDefault();
          el.dispatchEvent(new Event('input', { bubbles: true }));
          updateToolbarState();
        }
        return;
      }
      if (e.key === 'Backspace') {
        if (handleBackspace(el)) {
          e.preventDefault();
          el.dispatchEvent(new Event('input', { bubbles: true }));
          updateToolbarState();
        }
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); exec('bold'); }
      else if (k === 'i') { e.preventDefault(); exec('italic'); }
      else if (k === 'u') { e.preventDefault(); exec('underline'); }
      else if (k === 'k') { e.preventDefault(); void addLink(); }
      else if (k === 's') { e.preventDefault(); void flush(pageId); }
    });

    /* Paste arrives as whatever was copied — frequently a whole styled
     * document. Taking the plain text and letting the editor re-block it is
     * the only way to be sure nothing enters that the grammar cannot describe. */
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') ?? '';
      document.execCommand('insertText', false, text);
    });

    el.addEventListener('keyup', updateToolbarState);
    el.addEventListener('mouseup', updateToolbarState);
    el.addEventListener('focus', updateToolbarState);

    /* Ticking a box, and removing a reference. Both change the DOCUMENT, so
     * both go through the same input event the typing does — there is one save
     * path, and a second one would be a second set of conflict rules. */
    el.addEventListener('click', (e) => {
      const box = e.target.closest('[data-check]');
      if (box) {
        box.closest('.bk-check')?.classList.toggle('is-on');
        box.setAttribute('aria-checked', String(box.closest('.bk-check')?.classList.contains('is-on')));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      const x = e.target.closest('[data-ref-remove]');
      if (x) {
        /* Removing the CARD, never the Task (§15). The edge follows the
         * document on save, so this unlinks; the Task is untouched. */
        e.preventDefault();
        x.closest('[data-ref]')?.remove();
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    /* A Task dragged from the Project Rail lands as a reference card at the end
     * of the page. Dropping does not MOVE the task — it creates a relationship,
     * and the task stays exactly where it was in the project (§11). */
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('application/x-los-task')) return;
      e.preventDefault();
      el.classList.add('is-drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
    el.addEventListener('drop', (e) => {
      const taskId = e.dataTransfer?.getData('application/x-los-task');
      el.classList.remove('is-drop');
      if (!taskId) return;
      e.preventDefault();
      if (el.querySelector(`[data-ref-id="${taskId}"]`)) return;   // already here
      const card = document.createElement('div');
      card.innerHTML = refCardHtml(taskId);
      const node = card.firstElementChild;
      if (node) {
        el.appendChild(node);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  });

  root.querySelectorAll('[data-page-title]').forEach((input) => {
    input.addEventListener('input', () => {
      const { page } = pageOf(input.dataset.pageTitle);
      if (!page) return;
      queueSave(page, page.content, input.value);
      page.title = input.value;
      onDirty?.();
    });
  });

  root.querySelector('#bk-prev')?.addEventListener('click', () => onNavigate('prev'));
  root.querySelector('#bk-next')?.addEventListener('click', () => onNavigate('next'));
  root.querySelector('[data-add-pages]')?.addEventListener('click',
    (e) => onNavigate('add-pages', { anchor: e.currentTarget }));
  root.querySelectorAll('[data-section]').forEach((tab) => {
    tab.addEventListener('click', () => onNavigate('section', Number(tab.dataset.section)));
  });
  root.querySelector('#bk-add-section')?.addEventListener('click', () => onNavigate('add-section'));
  root.querySelectorAll('[data-section-more]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onNavigate('section-menu', { id: b.dataset.sectionMore, anchor: b });
    });
  });
  root.querySelectorAll('[data-page-more]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onNavigate('page-menu', { id: b.dataset.pageMore, anchor: b });
    });
  });
}

const pageOf = (id) => {
  for (const s of lib.book?.sections ?? []) {
    const page = s.pages.find((p) => p.id === id);
    if (page) return { page, section: s };
  }
  return { page: null, section: null };
};

/* ── Formatting ──────────────────────────────────────────────────────── */

/**
 * `execCommand` is deprecated, and it is still the only API that edits a
 * contenteditable while preserving the browser's own undo stack.
 *
 * Legacy's problem was not using it — it was STORING what it produced, so
 * `<font color="black">` wrappers reached the database and made text invisible
 * on a dark theme. Here nothing it emits is stored: `htmlToDoc` reads the DOM
 * back through a fixed grammar, so a stray wrapper contributes its text and
 * nothing else. The command is a means of editing, never a format.
 */
function exec(cmd, value = null) {
  document.execCommand(cmd, false, value);
  updateToolbarState();
  document.activeElement?.dispatchEvent(new Event('input', { bubbles: true }));
}

export function wireToolbar(root) {
  root.querySelectorAll('.bk-tb[data-cmd]').forEach((b) => {
    // `mousedown` + preventDefault, so pressing a toolbar button never takes
    // the selection out of the editor it is about to act on.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const cmd = b.dataset.cmd;
      if (cmd === 'link') return void addLink();
      exec(cmd);
    });
  });
  const style = root.querySelector('.bk-tb-style');
  style?.addEventListener('mousedown', (e) => e.stopPropagation());
  style?.addEventListener('change', () => {
    const ed = document.activeElement?.closest?.('.bk-editor')
      ?? document.querySelector('.bk-editor');
    if (!ed) return;
    applyBlockStyle(ed, style.value);
    updateToolbarState();
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function addLink() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const href = await promptLink();
  if (!href) return;
  exec('createLink', href);
  // `target`/`rel` are applied on render from the document, not here — the DOM
  // is a working surface, the document is the truth.
}

/** A small inline prompt. Never `window.prompt` — §24 bans native dialogs. */
function promptLink() {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'bk-linkbox';
    box.innerHTML = `<label>Link address
      <input type="url" placeholder="https://" aria-label="Link address"></label>
      <div class="bk-linkbox-acts">
        <button type="button" data-c="no" class="btn btn-sm">Cancel</button>
        <button type="button" data-c="yes" class="btn btn-sm btn-primary">Add link</button>
      </div>`;
    const input = box.querySelector('input');
    const done = (v) => { box.remove(); resolve(v); };
    box.querySelector('[data-c="no"]').onclick = () => done(null);
    box.querySelector('[data-c="yes"]').onclick = () => done(input.value.trim() || null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    document.body.appendChild(box);
    input.focus();
  });
}

/** Reflects the caret's formatting in the toolbar. */
function updateToolbarState() {
  const bar = document.querySelector('.bk-toolbar');
  if (!bar) return;
  for (const b of bar.querySelectorAll('.bk-tb[data-cmd]')) {
    const cmd = b.dataset.cmd;
    if (['bold', 'italic', 'underline', 'strikeThrough',
      'insertUnorderedList', 'insertOrderedList'].includes(cmd)) {
      let on = false;
      try { on = document.queryCommandState(cmd); } catch { on = false; }
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  const style = bar.querySelector('.bk-tb-style');
  const ed = document.activeElement?.closest?.('.bk-editor');
  if (style && ed) {
    /* Read from the DOM, not from queryCommandValue: that returns the tag the
     * browser THINKS applies and reports a paragraph inside a blockquote as
     * "p", so Quote never showed as the active style. */
    const id = currentStyleId(ed);
    style.value = id;
    style.setAttribute('aria-label', `Text style: ${
      BLOCK_STYLES.find((s2) => s2.id === id)?.label ?? 'Body'}`);
  }
}

/* ── Save status ─────────────────────────────────────────────────────── */

/**
 * Renders the save state in place.
 *
 * Text only, fixed width, no layout shift — §26 requires the status to change
 * without moving anything, because it changes while you are typing.
 */
export function wireSaveStatus(root) {
  const el = root.querySelector('#bk-save');
  if (!el) return () => {};
  const paint = () => {
    const ids = [...root.querySelectorAll('[data-editor]')].map((e) => e.dataset.editor);
    // The loudest state on the visible spread wins: a failure anywhere matters
    // more than a success next to it.
    const order = ['conflict', 'failed', 'saving', 'unsaved', 'saved'];
    const status = order.find((s) => ids.some((id) => statusOf(id) === s)) ?? 'saved';
    el.textContent = STATUS_LABEL[status];
    el.dataset.state = status;
    const failing = ids.find((id) => statusOf(id) === 'failed');
    el.innerHTML = failing
      ? `${STATUS_LABEL.failed} <button type="button" class="bk-retry" data-retry="${failing}">Retry</button>`
      : STATUS_LABEL[status];
  };
  paint();
  return onSaveStatus(paint);
}

/* ── Within-book search (§21) ────────────────────────────────────────── */

export async function searchBook(query) {
  if (!query.trim()) return { pages: [] };
  return search(query, lib.bookId);
}

export function searchPanelHtml(results, query) {
  const pages = results?.pages ?? [];
  return `<div class="bk-search" role="dialog" aria-label="Search this book">
    <div class="bk-search-top">
      <input class="bk-search-input" id="bk-search-input" type="search"
        value="${esc(query)}" placeholder="Search this book…" aria-label="Search this book">
      <button type="button" class="btn btn-sm" id="bk-search-close">Close</button>
    </div>
    ${!query.trim() ? '<p class="bk-search-hint">Type to search sections, page titles and content.</p>'
    : pages.length ? `<ul class="bk-search-list" role="list">
        ${pages.map((r) => `<li><button type="button" class="bk-search-hit"
          data-hit-section="${esc(r.sectionId)}" data-hit-page="${esc(r.pageId)}">
          <span class="bk-hit-where">${esc(r.sectionTitle)}${
  r.pageTitle ? ` · ${esc(r.pageTitle)}` : ''}</span>
          <span class="bk-hit-text">${esc(r.excerpt)}</span></button></li>`).join('')}
      </ul>`
    : '<p class="bk-search-hint">Nothing matched.</p>'}
  </div>`;
}

/** Where a search result lives, resolved against the CURRENT structure. */
export function locateHit(sectionId, pageId) {
  const si = (lib.book?.sections ?? []).findIndex((s) => s.id === sectionId);
  if (si === -1) return null;
  const pi = lib.book.sections[si].pages.findIndex((p) => p.id === pageId);
  if (pi === -1) return null;
  // Resolved from ids, never from a stored page number — §21: a result must not
  // open the wrong page because the numbering changed underneath it.
  return { sectionIdx: si, spreadIdx: Math.floor(pi / 2), pageId };
}

export { docToText, reducedMotion, createSection, updateSection, archiveSection,
  createPages, archivePage, entryOf };
