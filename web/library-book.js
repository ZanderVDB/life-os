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

import { docToHtml, htmlToDoc, docToText } from './library-doc.js';
import {
  lib, currentSection, currentSpread, spreadCount,
  createSection, updateSection, archiveSection, createPages, archivePage, search,
} from './library-api.js';
import {
  queueSave, flush, statusOf, entryOf, trackPage, STATUS_LABEL, onSaveStatus,
} from './library-save.js';
import { reducedMotion } from './motion.js';

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
  return `<div class="bk-stage bk-stage-cover">
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

export function spreadHtml() {
  const section = currentSection();
  const { left, right } = currentSpread();
  const total = spreadCount(section);
  const last = lib.spreadIdx >= total - 1;

  /* `prev` is never disabled while a spread is showing: there is always
   * somewhere back to go, and on the very first page that somewhere is the
   * cover. It used to be disabled on the first spread, which made the cover
   * unreachable by arrow and, below 820px, made the left-hand page of the
   * first spread unreachable at all once you had stepped onto the right. */
  return `${tabsHtml()}
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
  return `<div class="bk-page bk-page-${side}" data-accent="${esc(accent)}" data-page="${page.id}">
    <div class="bk-page-hdr">
      <input class="bk-page-title" data-page-title="${page.id}"
        value="${esc(page.title ?? '')}" placeholder="${esc(section?.title ?? '')}"
        aria-label="Page title">
      <button type="button" class="bk-page-more" data-page-more="${page.id}"
        aria-label="Actions for this page" aria-haspopup="menu">${dots()}</button>
    </div>
    <div class="bk-page-body">
      <div class="bk-editor" data-editor="${page.id}" contenteditable="true"
        spellcheck="true" role="textbox" aria-multiline="true"
        aria-label="Page content">${docToHtml(page.content)}</div>
    </div>
  </div>`;
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
      <option value="p">Body</option>
      <option value="h2">Heading</option>
      <option value="h3">Subheading</option>
      <option value="blockquote">Quote</option>
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
export function mountSpread(root, { onNavigate, onDirty }) {
  root.querySelectorAll('[data-editor]').forEach((el) => {
    const pageId = el.dataset.editor;
    // Registered while `page.content` is still what the server holds. See
    // trackPage — capturing it later captures the user's own typing as the
    // baseline, and then nothing ever looks unsaved.
    const mounted = pageOf(pageId).page;
    if (mounted) trackPage(mounted);

    el.addEventListener('input', () => {
      const { page } = pageOf(pageId);
      if (!page) return;
      const doc = htmlToDoc(el);
      queueSave(page, doc);
      // AFTER the queue, never before: queueSave compares against what the
      // server has, and this line is what would make that comparison lie.
      // The local record is updated so a page turn and back shows what was
      // typed even before the write lands.
      page.content = doc;
      onDirty?.();
    });

    el.addEventListener('keydown', (e) => {
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
  root.querySelector('[data-add-pages]')?.addEventListener('click', () => onNavigate('add-pages'));
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
    const v = style.value;
    exec('formatBlock', v === 'p' ? '<p>' : `<${v}>`);
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
  if (style) {
    let block = 'p';
    try { block = (document.queryCommandValue('formatBlock') || 'p').toLowerCase(); } catch { /* ignore */ }
    style.value = ['h2', 'h3', 'blockquote'].includes(block) ? block : 'p';
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
