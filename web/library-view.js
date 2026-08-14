/**
 * Library — the route controller.
 *
 * Owns three views behind one route: the shelf, an item, and an open book.
 * Everything it renders is backed by an endpoint that exists — §35 forbids a
 * control that does nothing, so if a button is on screen it works.
 *
 * ── The rendering rule ───────────────────────────────────────────────────
 *
 * The overview and the item view rebuild freely. The BOOK does not: while a
 * spread is on screen its editor elements are never replaced, because replacing
 * a contenteditable destroys the selection, the caret and the browser's undo
 * history. Legacy re-rendered the whole notebook with innerHTML on every change
 * and that is exactly what it cost. A spread is rebuilt only when the spread
 * itself changes — a page turn, a section change — and never in response to
 * typing or to a save completing.
 */

import {
  lib, initLibraryApi, loadItems, createItem, updateItem, archiveItem, restoreItem,
  createBook, loadBook, createSection, updateSection, createPages,
  archivePage, restorePage, archiveSection,
  currentSection, currentSpread, spreadCount, findPage, search, markOpened,
  sampleCheck, sampleAdd, sampleRemove,
} from './library-api.js';
import {
  headerHtml, bodyHtml, cardHtml, addMenuHtml, itemMenuHtml, visibleItems,
  pageHitsHtml, TYPE_LABEL, typeIcon, metaLine, when, esc,
} from './library-overview.js';
import {
  wireRail, restoreShelfScroll, captureShelfScroll, markReturn, syncSteps,
  clearPulled, releasePulled, pulledObject, pullForward, objectHtml, fileSize, domainOf,
} from './library-shelf.js';
import {
  coverHtml, spreadHtml, toolbarHtml, mountSpread, wireToolbar, wireSaveStatus,
  searchBook, searchPanelHtml, locateHit, canGoNext, ACCENTS,
} from './library-book.js';
import {
  flush, flushAll, hasUnsaved, retry, statusOf, entryOf, onSaveStatus,
  resolveKeepMine, resolveTakeTheirs, forgetAll, forgetPage,
} from './library-save.js';
import { openLibraryForm } from './library-modal.js';
import { reducedMotion } from './motion.js';
import { navToken, navStale, setHash } from './nav.js';

/**
 * Waits for a CSS animation, with a timeout that always fires.
 *
 * `animationend` does not arrive if the element is removed, if the tab is
 * backgrounded mid-animation, or if a stylesheet has not applied yet — and a
 * page turn that never completes leaves the book frozen mid-flip. The timeout
 * is the guarantee, the event is the optimisation.
 */
function afterAnimation(el, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; el.removeEventListener('animationend', finish); resolve(); } };
    el.addEventListener('animationend', finish);
    setTimeout(finish, ms + 60);
  });
}

/**
 * Plays an entrance, then takes the class off.
 *
 * See `docs/animation-house-rules.md`. An entrance whose fill-mode is `none`
 * looks safe because the element returns to its computed style when the
 * animation ends — but an animation that never ends never returns anything.
 * The timer is what makes the stylesheet the owner of the final state.
 */
function enterOnce(el, cls, ms) {
  el.classList.add(cls);
  const off = () => el.classList.remove(cls);
  el.addEventListener('animationend', off, { once: true });
  setTimeout(off, ms + 120);
}

/** Injected once by app.js: the API caller, the toast, and the error wrapper. */
let ctx = null;
export function initLibrary(c) {
  ctx = c;
  initLibraryApi(c.api);
  installSampleHooks();
  installGlobals();
}

/* ── Routing (§4) ────────────────────────────────────────────────────────
 *
 * #library                         the shelf
 * #library/item/{id}               one non-book item
 * #library/book/{bookId}           a book, at its cover
 * #library/book/{bookId}?s=…&p=…   a book, at a section and page
 *
 * Section and page travel as IDS, never as page numbers. A saved link must not
 * open the wrong page because a page was added in front of it.
 */
export function parseLibraryHash(hash = location.hash) {
  const raw = hash.replace(/^#/, '');
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'library') return null;
  const q = new URLSearchParams(qs ?? '');
  /* The staging-only design lab (L3.3). Parsed unconditionally; whether it
   * RENDERS is decided by the server, which is the only thing that knows
   * whether this is production. In production the lab falls through to the
   * ordinary overview, so the route is inert rather than an error. */
  if (parts[1] === 'lab') return { view: 'lab' };
  if (parts[1] === 'item' && parts[2]) return { view: 'item', id: parts[2] };
  if (parts[1] === 'book' && parts[2]) {
    return {
      view: 'book',
      bookId: parts[2],
      sectionId: q.get('s') ?? null,
      pageId: q.get('p') ?? null,
    };
  }
  return { view: 'overview' };
}

/** The hash for where the book is now. Written on every turn, so Back works. */
function bookHash() {
  const s = currentSection();
  const { left } = currentSpread();
  if (lib.cover || !s) return `#library/book/${lib.bookId}`;
  return `#library/book/${lib.bookId}?s=${s.id}${left ? `&p=${left.id}` : ''}`;
}

/* `setHash` comes from nav.js now. Library used to keep its own `suppressHash`
 * flag, which the shell's hashchange handler could not see — so every hash
 * Library wrote about itself was counted as a navigation and invalidated the
 * render that had just written it. See nav.js. */

/* ── The loading lifecycle (§2) ──────────────────────────────────────────
 *
 * A loading state is a PROMISE that something is coming. If it can be left on
 * screen for ever the promise is a lie, and the D2.2 report is what that looks
 * like: `Opening…` above a large grey rectangle, permanently.
 *
 * The root cause was the navigation token (see nav.js) and it is fixed. This is
 * the guarantee that no future cause produces the same screen: whenever Library
 * puts up a loading state it arms a watchdog, and any render that terminates
 * — overview, empty, item, book, error — disarms it. If the watchdog fires, the
 * shell is replaced by a retry state that says what happened.
 *
 * The three legitimate ends are overview / empty / error. Nothing else.
 */

const LOADING_LIMIT = 8000;
let watchdog = 0;
/** What to say if the wait never ends. Set alongside the shell it guards. */
let watchdogRetry = null;

function beginLoading(what, onRetry) {
  clearTimeout(watchdog);
  watchdogRetry = onRetry;
  watchdog = setTimeout(() => {
    watchdog = 0;
    const head = document.getElementById('page-head');
    const scroll = document.getElementById('main-scroll');
    if (!scroll || !scroll.querySelector('[data-loading]')) return;
    if (head) head.innerHTML = '<p class="eyebrow lib-page">Library</p><h1>Library</h1>';
    scroll.innerHTML = `<div class="state"><b>${esc(what)} is taking too long</b>
      Nothing was lost. This is usually the connection rather than your Library.
      <div style="margin-top:16px"><button class="btn" id="lib-retry">Try again</button></div></div>`;
    scroll.querySelector('#lib-retry').onclick = () => (watchdogRetry ?? (() => {
      lib.itemsLoaded = false;
      void renderLibrary();
    }))();
  }, LOADING_LIMIT);
}

/** Called by every path that reaches a real screen — success or failure. */
function endLoading() {
  clearTimeout(watchdog);
  watchdog = 0;
  watchdogRetry = null;
}

/** Test seam and diagnostic: is a Library loading shell still on screen? */
export const isLoadingShellUp = () =>
  !!document.querySelector('#main-scroll [data-loading]');

/**
 * The shelf, waiting.
 *
 * Card-shaped, at the size the cards will actually be, so the arrival is a fill
 * rather than a reflow. Four, not six: a placeholder that promises more than
 * arrives is its own small dishonesty, and four already reads as "a shelf".
 */
const shelfLoadingHtml = () => `<div data-loading="shelf">
  <div class="lib-skel-bar" aria-hidden="true">
    ${'<span class="skeleton lib-skel-pill"></span>'.repeat(4)}
  </div>
  <div class="lib-grid">${'<div class="skeleton lib-skel"></div>'.repeat(4)}</div>
  <p class="sr-only" role="status">Loading your Library</p>
</div>`;

/**
 * A book, opening.
 *
 * Two page shapes in the spread's own proportions rather than one 60vh slab.
 * The old rectangle was the single most visible symptom of the regression, and
 * a placeholder that already looks like a book makes an overlong wait obvious
 * instead of ambiguous.
 */
const bookLoadingHtml = () => `<div class="bk" data-loading="book">
  <div class="bk-skel" aria-hidden="true">
    <span class="skeleton bk-skel-page"></span>
    <span class="skeleton bk-skel-page"></span>
  </div>
  <p class="sr-only" role="status">Opening this book</p>
</div>`;

/* ── Entry point ─────────────────────────────────────────────────────── */

export async function renderLibrary(nav = navToken()) {
  const head = document.getElementById('page-head');
  const scroll = document.getElementById('main-scroll');
  if (!head || !scroll) return;
  const route = parseLibraryHash() ?? { view: 'overview' };

  if (route.view === 'lab') return renderLabRoute(head, scroll, nav);
  if (route.view === 'book') return renderBook(route, head, scroll, nav);
  if (route.view === 'item') return renderItem(route.id, head, scroll, nav);
  return renderOverview(head, scroll, nav);
}

/**
 * The design lab (L3.3), loaded lazily and only when asked for.
 *
 * A dynamic import, so the six concept modules and their stylesheet are never
 * fetched by anybody who does not visit the route — and never at all in
 * production, where `renderLab` refuses before mounting anything.
 *
 * If it refuses, this falls through to the ordinary overview: an internal route
 * that does not exist here should look like the Library, not like a broken page.
 */
let labCss = null;
async function renderLabRoute(head, scroll, nav) {
  const mod = await import('./modules/library-lab/lab-view.js');
  if (navStale(nav)) return;
  mod.initLab(ctx);
  if (!labCss) {
    labCss = document.createElement('link');
    labCss.rel = 'stylesheet';
    labCss.href = './modules/library-lab/lab.css';
    document.head.appendChild(labCss);
  }
  const shown = await mod.renderLab(head, scroll, nav);
  if (!shown && !navStale(nav)) {
    setHash('#library');
    return renderOverview(head, scroll, nav);
  }
  return undefined;
}

/* ── Overview ────────────────────────────────────────────────────────── */

async function renderOverview(head, scroll, nav = navToken()) {
  forgetAll();               // no book is open; nothing should still be pending
  lib.book = null; lib.bookId = null;
  lib.pageHits = [];         // results belong to a query, not to the route
  head.innerHTML = headerHtml();
  head.querySelector('#lib-add').addEventListener('click', (e) => openAddMenu(e.currentTarget));

  if (!lib.itemsLoaded) {
    /* The filter bar and the card shapes, not a giant rectangle — §2. The
     * header above is already real, so the page does not lurch when the items
     * arrive; only the cards fill in. */
    scroll.innerHTML = shelfLoadingHtml();
    beginLoading('Your Library', () => { lib.itemsLoaded = false; void renderLibrary(); });
    try { await loadItems({ archived: lib.showArchived }); } catch { /* shown below */ }
  }
  if (navStale(nav)) return;
  /* `bodyHtml` renders the error-with-retry state when `lib.error` is set and
   * nothing loaded, so this terminates into overview, empty OR error — never
   * back into a loading shell. */
  endLoading();
  paintOverview(scroll);
  /* Coming back from a book opened out of a search must land back on the
   * results, not on "nothing matched". The query survives the round trip, so
   * the half of it that lives on the server has to be asked again. */
  if (lib.query.trim()) queueLibrarySearch(lib.query);
}

function paintOverview(scroll = document.getElementById('main-scroll')) {
  if (!scroll) return;
  /* Capture BEFORE the rails are destroyed. Every repaint of this page throws
   * the shelves away — a filter change, the archive toggle, a search being
   * cleared — and §14 asks that filtering preserve horizontal scroll. Doing it
   * here means every one of those paths keeps its place without each having to
   * remember to, which is the difference between a rule and a habit. */
  captureShelfScroll(scroll);
  /* The pulled object is about to be destroyed with the DOM it lives in, so the
   * module's reference to it has to go too. A stale reference would make the
   * next click on the same book open it instead of pulling it forward. */
  clearPulled();
  scroll.innerHTML = bodyHtml();
  wireOverview(scroll);
  bindPullDismiss();
  /* Position first, THEN identify. Restoring the scroll and then highlighting
   * means the highlight happens on a shelf that is already where it should be,
   * so nothing has to travel across the screen to find it (§18). */
  restoreShelfScroll(scroll);
  if (lib.cameFrom) {
    markReturn(scroll, lib.cameFrom, lib.cameFromShelf);
    lib.cameFrom = null; lib.cameFromShelf = null;
  }
}

function wireOverview(scroll) {
  scroll.querySelector('#lib-retry')?.addEventListener('click', () => {
    lib.itemsLoaded = false;
    void renderLibrary();
  });
  scroll.querySelector('#lib-clear-q')?.addEventListener('click', () => {
    lib.query = '';
    paintOverview(scroll);
  });
  scroll.querySelectorAll('[data-filter]').forEach((b) => {
    b.addEventListener('click', () => {
      lib.filter = b.dataset.filter;
      paintOverview(scroll);
      scroll.querySelector(`[data-filter="${lib.filter}"]`)?.focus();
    });
  });
  scroll.querySelectorAll('[data-new]').forEach((b) => {
    b.addEventListener('click', () => void createOfType(b.dataset.new));
  });

  const q = scroll.querySelector('#lib-q');
  if (q) {
    q.addEventListener('input', () => {
      lib.query = q.value;
      // Only the results change. Repainting the whole body would take the
      // caret out of the box the user is still typing in.
      paintResults(scroll);
      queueLibrarySearch(q.value);
    });
  }

  scroll.querySelectorAll('.lib-hit').forEach((b) => {
    b.addEventListener('click', () => {
      const { hitBook, hitSection, hitPage } = b.dataset;
      setHashAndRender(`#library/book/${hitBook}?s=${hitSection}&p=${hitPage}`);
    });
  });

  scroll.querySelector('#lib-archived')?.addEventListener('click', () => void ctx.run(async () => {
    lib.itemsLoaded = false;
    await loadItems({ archived: !lib.showArchived });
    paintOverview(scroll);
  }));

  /* Every shelf is wired the same way, including the personal ledge and the
   * search results — one behaviour, so a Book on the Books shelf and the same
   * Book in a result set cannot drift apart. */
  scroll.querySelectorAll('.lib-rail').forEach((rail) => {
    wireRail(rail, { onOpen: openShelfObject, onMenu: (anchor, id) => openItemMenu(anchor, id) });
  });
  /* The result surface is not a rail, but it uses the SAME two stages: a
   * result that behaved differently from the same object on its shelf would be
   * the kind of inconsistency this phase exists to remove. Every object here is
   * its own tab stop, because a wrapped set has no single reading order for a
   * cursor to follow. */
  scroll.querySelectorAll('.lib-found').forEach((found) => {
    found.querySelectorAll('.lib-obj').forEach((o) => { o.tabIndex = 0; });
    found.addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]');
      if (more) { e.stopPropagation(); openItemMenu(more, more.dataset.more); return; }
      const obj = e.target.closest('.lib-obj');
      if (!obj) { clearPulled(); return; }
      if (obj === pulledObject() || e.target.closest('.lib-foot-a')) openShelfObject(obj);
      else pullForward(obj);
    });
    found.addEventListener('keydown', (e) => {
      const obj = e.target.closest('.lib-obj');
      if (!obj) return;
      if (e.key === 'Escape' && pulledObject()) { e.preventDefault(); clearPulled(); return; }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (obj === pulledObject()) openShelfObject(obj);
      else pullForward(obj);
    });
  });

  /* Shelves are sized by their own width, and the arrows and the centring rule
   * both depend on whether one overflows. A sidebar collapse changes that
   * without changing the window, so this listens to the ELEMENT. */
  if (typeof ResizeObserver === 'function') {
    shelfSizer?.disconnect();
    shelfSizer = new ResizeObserver((entries) => {
      entries.forEach((en) => syncSteps(en.target));
    });
    scroll.querySelectorAll('.lib-rail').forEach((r) => shelfSizer.observe(r));
  }
}

/** Watches shelf widths. One observer for the page, replaced on every paint. */
let shelfSizer = null;

/**
 * Clicking anywhere that is not an object returns the pulled one (§6).
 *
 * Bound ONCE, on the document, rather than per paint — a listener added on
 * every repaint is a listener leaked on every repaint, and this one has to
 * outlive the shelves it is about. The rail's own handler already covers empty
 * space inside a shelf; this covers the rest of the page.
 */
let outsideBound = false;
function bindPullDismiss() {
  if (outsideBound) return;
  outsideBound = true;
  document.addEventListener('click', (e) => {
    if (!pulledObject()) return;
    if (e.target.closest('.lib-obj') || e.target.closest('.lib-menu')) return;
    clearPulled();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pulledObject()) clearPulled({ restoreFocus: true });
  });
}

/**
 * Opening something from a shelf (§17).
 *
 * The object is marked `is-opening` and the route changes on the next frame.
 * That single frame is what makes the handoff read as the shelf giving the Book
 * up rather than the page being replaced — and because the class only ever
 * lives on a node that is about to be discarded, no animation here can own a
 * final state.
 */
function openShelfObject(obj) {
  /* The Diary ledge leaves Library entirely, so the SHELL routes it. Writing
   * `#diary` from here would change the URL without telling the shell, leaving
   * the sidebar pointing at Library and any pending Library write unflushed. */
  if (obj.dataset.system === 'diary') { ctx.goRoute('diary'); return; }
  const id = obj.dataset.item;
  const item = lib.items.find((i) => i.id === id);
  if (!item) return;

  /* Where every shelf is, captured BEFORE the route changes and the page is
   * replaced. This is the snapshot §18 restores from. */
  captureShelfScroll(obj.closest('#main-scroll') ?? document);
  /* RELEASE, not clear (S1 §12). `clearPulled()` would take the Book back to
   * its spine — restoring the depth faces and re-hinging the cover — and only
   * then would `is-opening` carry it away. One activation, two transitions, the
   * second undoing the first. The node is about to be destroyed by the route
   * change, so it does not need putting back; only the module's claim on it
   * has to go. */
  releasePulled();
  lib.cameFrom = id;
  lib.cameFromShelf = obj.closest('.lib-rail')?.dataset.rail ?? null;
  markOpened(id);
  /* NO HAND-OFF ANIMATION (S2.6).
   *
   * `is-opening` flew the object up 48px and faded it to 10% over 320ms, to
   * cover a wait. There is no wait: measured, the Book view replaces the shelf
   * 18ms after this click. So the animation got about one frame — just enough
   * for the Book you had carefully turned to face you to jerk upward and start
   * vanishing before the screen swapped. One activation, two movements, the
   * second of them a stub. That is what the review saw as the Book "re-shooting"
   * itself, and it was never a reload: nothing re-fetches, and the body paints
   * exactly once.
   *
   * The Book is already committed front-facing. Going straight there is both
   * calmer and more honest — and if a Book ever IS slow to arrive, the shelf
   * simply stays on screen until it does, which is the rule everywhere else. */
  openLibraryItem(id);
}

/** Repaints only the sections, keeping the filter bar (and its caret) intact. */
function paintResults(scroll) {
  captureShelfScroll(scroll);
  const bar = scroll.querySelector('.lib-bar');
  const html = bodyHtml();
  const holder = document.createElement('div');
  holder.innerHTML = html;
  holder.querySelector('.lib-bar')?.remove();
  [...scroll.children].forEach((c) => { if (c !== bar) c.remove(); });
  while (holder.firstChild) scroll.appendChild(holder.firstChild);
  wireOverview(scroll);
  /* Deleting the last character of a search brings the shelves back, and they
   * come back where they were (§13). `lib.shelfScroll` survived the search
   * because nothing cleared it — a search is a view of the Library, not a
   * different Library. */
  restoreShelfScroll(scroll);
}

/**
 * The half of the shelf search that has to ask the server (§22).
 *
 * The card filter is instant and local. This finds the words that are INSIDE a
 * book, which nothing on the client knows. Debounced, and guarded by the query
 * it was issued for: a slow answer to an older query must never replace the
 * results for what is in the box now.
 */
let searchTimer = 0;
let searchSeq = 0;
function queueLibrarySearch(query) {
  clearTimeout(searchTimer);
  const q = query.trim();
  if (q.length < 2) {
    if (lib.pageHits.length) { lib.pageHits = []; paintResults(document.getElementById('main-scroll')); }
    return;
  }
  const seq = ++searchSeq;
  searchTimer = setTimeout(() => void (async () => {
    try {
      const r = await search(q);
      if (seq !== searchSeq || lib.query.trim() !== q) return;   // a newer query won
      lib.pageHits = r.pages ?? [];
      paintResults(document.getElementById('main-scroll'));
    } catch {
      // A failed content search must not blank the cards that already matched.
      lib.pageHits = [];
    }
  })(), 240);
}

function openLibraryItem(id) {
  const item = lib.items.find((i) => i.id === id);
  if (!item) return;
  if (item.type === 'book' && item.book) setHashAndRender(`#library/book/${item.book.id}`);
  else setHashAndRender(`#library/item/${item.id}`);
}

function setHashAndRender(next) {
  setHash(next);
  void renderLibrary();
}

function openAddMenu(anchor) {
  ctx.openSurface(anchor, {
    kind: 'library-add',
    label: 'Add to Library',
    html: addMenuHtml(),
    wire: (el) => el.querySelectorAll('[data-new]').forEach((b) => {
      b.addEventListener('click', () => { ctx.closeSurface(); void createOfType(b.dataset.new); });
    }),
  });
}

async function createOfType(type) {
  const values = await openLibraryForm(type);
  if (!values) return;
  await ctx.run(async () => {
    if (type === 'book') {
      const r = await createBook(values);
      lib.itemsLoaded = false;
      await loadItems({ archived: lib.showArchived });
      ctx.toast(`“${r.item.title}” created.`);
      setHashAndRender(`#library/book/${r.book.id}`);
      return;
    }
    await createItem({ type, ...values });
    lib.itemsLoaded = false;
    await loadItems({ archived: lib.showArchived });
    paintOverview();
    ctx.toast(`“${values.title}” saved to Library.`);
  });
}

function openItemMenu(anchor, id) {
  const item = lib.items.find((i) => i.id === id);
  if (!item) return;
  ctx.openSurface(anchor, {
    kind: 'library-item-menu',
    label: `Actions for ${item.title}`,
    html: itemMenuHtml(item),
    wire: (el) => el.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        ctx.closeSurface();
        void itemAction(b.dataset.act, item);
      });
    }),
  });
}

async function itemAction(act, item) {
  if (act === 'open') return openLibraryItem(item.id);
  if (act === 'visit') { window.open(item.sourceUrl, '_blank', 'noopener,noreferrer'); return; }

  if (act === 'rename') {
    const v = await openLibraryForm('rename',
      { title: item.title, description: item.description ?? '' });
    if (!v) return;
    return ctx.run(async () => {
      const r = await updateItem(item.id, { title: v.title, description: v.description ?? null });
      Object.assign(item, r.item);
      repaintCard(item);
      ctx.toast('Renamed.');
    });
  }

  if (act === 'archive') {
    /* Archive is reversible, so it does not need a confirmation — it needs an
     * UNDO. A dialog before a reversible action is a tax on the common case. */
    return ctx.run(async () => {
      await archiveItem(item.id);
      paintOverview();
      ctx.toast(`“${item.title}” archived.`, false, {
        label: 'Undo',
        onAction: () => void ctx.run(async () => {
          await restoreItem(item.id);
          paintOverview();
        }),
      });
    });
  }

  if (act === 'restore') {
    return ctx.run(async () => {
      await restoreItem(item.id);
      paintOverview();
      ctx.toast(`“${item.title}” restored.`);
    });
  }
}

/** Swaps one card in place, so renaming does not re-enter the whole shelf. */
function repaintCard(item) {
  const old = document.querySelector(`.lib-card[data-item="${item.id}"]`);
  if (!old) { paintOverview(); return; }
  const holder = document.createElement('div');
  holder.innerHTML = cardHtml(item);
  const next = holder.firstElementChild;
  old.replaceWith(next);
  wireOverview(document.getElementById('main-scroll'));
}

/* ── One item (§23) ──────────────────────────────────────────────────── */

async function renderItem(id, head, scroll, nav = navToken()) {
  if (!lib.itemsLoaded) {
    scroll.innerHTML = `<div data-loading="item"><div class="skeleton lib-skel"></div>
      <p class="sr-only" role="status">Loading this item</p></div>`;
    beginLoading('This item', () => { lib.itemsLoaded = false; void renderLibrary(); });
    try { await loadItems({ archived: true }); } catch { /* handled below */ }
  }
  if (navStale(nav)) return;
  endLoading();
  const item = lib.items.find((i) => i.id === id);
  if (!item) {
    head.innerHTML = '<p class="eyebrow lib-page">Library</p><h1>Not found</h1>';
    scroll.innerHTML = `<div class="state"><b>That item is not in your Library</b>
      It may have been archived, or the link may be out of date.
      <div style="margin-top:16px"><button class="btn" data-back>Back to Library</button></div></div>`;
    scroll.querySelector('[data-back]').onclick = () => setHashAndRender('#library');
    return;
  }

  head.innerHTML = `<p class="eyebrow lib-page">Library · ${esc(TYPE_LABEL[item.type] ?? 'Item')}</p>
    <h1>${esc(item.title)}</h1>
    <p class="sub">${esc(metaLine(item))} · updated ${esc(when(item.updatedAt))}</p>
    <div class="page-actions">
      <button class="btn btn-ghost" data-back>Back to Library</button>
      <button class="btn" data-act="rename">Rename</button>
      ${item.archivedAt
    ? '<button class="btn" data-act="restore">Restore</button>'
    : '<button class="btn" data-act="archive">Archive</button>'}
    </div>`;

  /* THE OPEN VIEW (L3.1 §19).
   *
   * It was a small metadata card in the corner of an empty page, and the review
   * said so. What it is now is a composed page with three parts: the object
   * itself drawn large on the left, what it says in the middle, and what is
   * known about it underneath.
   *
   * The one thing it deliberately does NOT do is fake an editor. A Document has
   * no body model yet — `library_items` stores a title, a description and some
   * metadata, and nothing else — so the page says exactly that, in a state that
   * looks intentional rather than unfinished. An empty text area with a cursor
   * in it would be a promise the schema cannot keep.
   */
  const facts = [
    ['Added', new Date(item.createdAt).toLocaleDateString(undefined,
      { day: 'numeric', month: 'long', year: 'numeric' })],
    ['Last edited', when(item.updatedAt)],
    item.lastOpenedAt ? ['Last opened', when(item.lastOpenedAt)] : null,
    item.mimeType ? ['Format', item.mimeType] : null,
    item.sizeBytes ? ['Size', fileSize(item.sizeBytes)] : null,
    item.sourceUrl ? ['Source', domainOf(item.sourceUrl) || item.sourceUrl] : null,
  ].filter(Boolean);

  scroll.innerHTML = `<div class="lib-open">
    <div class="lib-open-object">
      ${objectHtml({ ...item, archivedAt: null }, 0, 1)}
    </div>
    <div class="lib-open-body">
      <div class="lib-open-kind">
        <span class="lib-open-kind-i">${typeIcon(item.type, 16)}</span>
        <span>${esc(TYPE_LABEL[item.type] ?? 'Item')}</span>
        ${item.archivedAt ? '<span class="lib-card-arch">Archived</span>' : ''}
      </div>
      ${item.description
    ? `<p class="lib-open-desc">${esc(item.description)}</p>`
    : '<p class="lib-open-desc is-empty">No description yet.</p>'}
      ${item.sourceUrl ? `<p class="lib-open-url"><a href="${esc(item.sourceUrl)}"
        target="_blank" rel="noopener noreferrer">${esc(item.sourceUrl)}</a></p>` : ''}

      <dl class="lib-open-facts">
        ${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
      </dl>

      <div class="lib-open-note">
        ${item.type === 'document'
    ? `<b>This Document holds a title and a description.</b>
         Writing inside a Document is not built yet — Books are where long-form
         writing lives today, and a Document is a record you can point at from
         anywhere in Life OS. When a body model arrives it will open here.`
    : ['image', 'video', 'file'].includes(item.type)
      ? `<b>This is a record of the resource, not the file.</b>
         Uploads are a later Library phase. Everything known about it is above,
         and nothing here pretends the file is stored.`
      : `<b>This is a saved link.</b>
         Life OS keeps the address and what you said about it; the page itself
         stays where it is.`}
      </div>
    </div>
  </div>`;

  head.querySelector('[data-back]').onclick = () => setHashAndRender('#library');
  head.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', () => void (async () => {
      await itemAction(b.dataset.act, item);
      if (b.dataset.act !== 'rename') setHashAndRender('#library');
      else void renderLibrary();
    })());
  });
}

/* ── The Book ────────────────────────────────────────────────────────── */

async function renderBook(route, head, scroll, nav = navToken()) {
  if (lib.bookId !== route.bookId || !lib.book) {
    // Keep whatever is on screen until the replacement is ready — no blank book.
    /* The title the shelf already showed, not the word "Opening…". The shelf
     * knows what this book is called before the book itself arrives, and a
     * stable header is what makes the wait read as loading rather than as
     * having landed somewhere unnamed. */
    const known = lib.items.find((i) => i.book?.id === route.bookId);
    head.innerHTML = `<p class="eyebrow lib-page">Library · Book</p>
      <h1>${esc(known?.title ?? 'Opening…')}</h1>`;

    /* THE SKELETON WAITS (S2.5).
     *
     * A Book usually arrives in well under a tenth of a second, and painting a
     * skeleton first meant every open went shelf → grey pages → Book. Three
     * paints for one action, and the middle one on screen just long enough to
     * register as a glitch — which is exactly what the review reported.
     *
     * So the skeleton is DEFERRED. If the Book beats the timer, nothing but the
     * Book is ever drawn; if it does not, the wait is real and the skeleton is
     * honest. 180ms is about the threshold at which a delay stops feeling like
     * the same gesture. */
    let skeleton = setTimeout(() => {
      skeleton = 0;
      if (navStale(nav) || !scroll.isConnected) return;
      if (!scroll.querySelector('.bk-book')) scroll.innerHTML = bookLoadingHtml();
      head.querySelector('h1')?.insertAdjacentHTML('afterend', '<p class="sub">Opening…</p>');
      beginLoading(known?.title ?? 'This book', () => void renderLibrary());
    }, 180);
    const settled = () => { if (skeleton) { clearTimeout(skeleton); skeleton = 0; } };

    forgetAll();
    try {
      await loadBook(route.bookId);
      settled();
    } catch (e) {
      settled();
      if (navStale(nav)) return;
      endLoading();
      head.innerHTML = '<p class="eyebrow lib-page">Library</p><h1>Not found</h1>';
      scroll.innerHTML = `<div class="state"><b>That book did not open</b>${esc(e.message)}
        <div style="margin-top:16px">
          <button class="btn" data-retry>Try again</button>
          <button class="btn btn-ghost" data-back>Back to Library</button></div></div>`;
      scroll.querySelector('[data-retry]').onclick = () => void renderLibrary();
      scroll.querySelector('[data-back]').onclick = () => setHashAndRender('#library');
      return;
    }
    if (navStale(nav)) return;
    lib.sectionIdx = 0; lib.spreadIdx = 0; lib.cover = true; lib.half = 0;
  }
  /* Painting from here would replace whatever the person navigated to, and
   * `setHash` inside paintBookBody would rewrite the URL back into this Book. */
  if (navStale(nav)) return;
  endLoading();

  // A deep link lands ON its page, not on the cover.
  if (route.sectionId) {
    const hit = locateHit(route.sectionId, route.pageId ?? '');
    const si = lib.book.sections.findIndex((s) => s.id === route.sectionId);
    if (hit) { lib.sectionIdx = hit.sectionIdx; lib.spreadIdx = hit.spreadIdx; lib.cover = false; }
    else if (si > -1) { lib.sectionIdx = si; lib.spreadIdx = 0; lib.cover = false; }
  }

  paintBookHead(head);
  paintBookBody(scroll);
}

function paintBookHead(head = document.getElementById('page-head')) {
  const { item } = lib.book;
  head.innerHTML = `<p class="eyebrow lib-page">Library · Book</p>
    <h1>${esc(item.title)}</h1>
    <p class="sub">${lib.book.sections.length} section${
  lib.book.sections.length === 1 ? '' : 's'} · ${
  lib.book.sections.reduce((n, s) => n + s.pages.length, 0)} pages</p>
    <div class="page-actions">
      <button class="btn btn-ghost" id="bk-back">Back to Library</button>
      ${lib.cover ? '' : '<button class="btn" id="bk-cover-btn">Cover</button>'}
    </div>`;
  head.querySelector('#bk-back').onclick = () => void leaveBook('#library');
  head.querySelector('#bk-cover-btn')?.addEventListener('click', () => void (async () => {
    await flushAll();
    lib.cover = true;
    paintBookHead();
    paintBookBody();
    setHash(bookHash());
  })());
}

let stopSaveWatch = null;

function paintBookBody(scroll = document.getElementById('main-scroll')) {
  stopSaveWatch?.();
  if (lib.cover) {
    scroll.innerHTML = `<div class="bk">${coverHtml()}</div>`;
    scroll.querySelector('#bk-open').addEventListener('click', () => {
      lib.cover = false;
      paintBookHead();
      paintBookBody();
      setHash(bookHash());
      document.querySelector('.bk-editor')?.focus();
    });
    return;
  }

  scroll.innerHTML = `<div class="bk">
    ${toolbarHtml()}
    ${spreadHtml()}
  </div>`;
  wireBook(scroll);
  setHash(bookHash());
}

function wireBook(scroll) {
  wireToolbar(scroll);
  mountSpread(scroll, { onNavigate: (what, arg) => void navigate(what, arg) });
  stopSaveWatch = wireSaveStatus(scroll);

  scroll.querySelector('#bk-save')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-retry]');
    if (b) void ctx.run(() => retry(b.dataset.retry));
  });
  scroll.querySelector('#bk-search-btn')?.addEventListener('click', () => openBookSearch(scroll));
  applyHalf(scroll);
}

/* The one-page-at-a-time treatment below 820px. The spread stays a spread in
 * the DOM; only which half is shown changes, so a resize needs no reload. */
const isNarrow = () => window.matchMedia('(max-width: 820px)').matches;

/**
 * Which half to show after stepping BACKWARDS onto a spread.
 *
 * The right half if there is one, so back-then-forward returns you to where you
 * were. On a wide screen the whole spread is visible and the half is moot.
 * Read after `spreadIdx` and `sectionIdx` have been moved.
 */
const narrowLandingHalf = () => (isNarrow() && currentSpread().right ? 1 : 0);
function applyHalf(scroll = document) {
  const book = scroll.querySelector?.('#bk-book') ?? document.getElementById('bk-book');
  book?.classList.toggle('show-right', isNarrow() && lib.half === 1);
  /* Showing the other half is a move, so the forward arrow's availability
   * changes with it. Without this the arrow keeps whatever state the last full
   * repaint gave it and goes stale on the final spread. */
  const next = document.getElementById('bk-next');
  if (next) next.disabled = !canGoNext();
}

/* ── Navigation ──────────────────────────────────────────────────────── */

async function navigate(what, arg) {
  if (what === 'add-section') return addSection();
  if (what === 'add-pages') return addPages();
  if (what === 'section-menu') return openSectionMenu(arg.anchor, arg.id);
  if (what === 'page-menu') return openPageMenu(arg.anchor, arg.id);

  // §16: anything that takes the current editor away flushes first.
  await flushAll();

  if (what === 'section') {
    if (arg === lib.sectionIdx) return;
    const dir = arg > lib.sectionIdx ? 'next' : 'prev';
    lib.sectionIdx = arg; lib.spreadIdx = 0; lib.half = 0;
    return turn(dir);
  }

  const section = currentSection();
  const total = spreadCount(section);

  if (what === 'next') {
    if (isNarrow() && lib.half === 0 && currentSpread().right) {
      lib.half = 1; applyHalf(); return;
    }
    if (lib.spreadIdx < total - 1) { lib.spreadIdx += 1; lib.half = 0; return turn('next'); }
    if (lib.sectionIdx < lib.book.sections.length - 1) {
      lib.sectionIdx += 1; lib.spreadIdx = 0; lib.half = 0; return turn('next');
    }
    return;   // the last page of the last section: the arrow simply stops
  }

  if (what === 'prev') {
    if (isNarrow() && lib.half === 1) { lib.half = 0; applyHalf(); return; }
    if (lib.spreadIdx > 0) {
      lib.spreadIdx -= 1;
      // Narrow reads one page at a time, so going back must land on the page
      // you would have come from — the RIGHT half of the previous spread.
      // Landing on the left half skips a page, and there is then no way to
      // reach it going backwards at all.
      lib.half = narrowLandingHalf();
      return turn('prev');
    }
    if (lib.sectionIdx > 0) {
      lib.sectionIdx -= 1;
      lib.spreadIdx = spreadCount(lib.book.sections[lib.sectionIdx]) - 1;
      lib.half = narrowLandingHalf();
      return turn('prev');
    }
    // Before the first page is the cover.
    lib.cover = true;
    paintBookHead();
    paintBookBody();
  }
}

/**
 * The page turn (§18, audit §6).
 *
 * Out, swap, in — both pages moving together so it reads as one motion rather
 * than two panels sliding. With reduced motion it is an instant swap: the
 * information is identical, only the theatre is dropped.
 */
async function turn(dir) {
  const scroll = document.getElementById('main-scroll');
  const book = document.getElementById('bk-book');
  if (!book || reducedMotion()) { paintBookBody(scroll); paintBookHead(); return; }

  const cls = dir === 'next' ? 'leave-next' : 'leave-prev';
  book.classList.add(cls);
  try {
    await afterAnimation(book, 260);
  } finally {
    /* `animation-fill-mode: forwards` holds the book at the last keyframe —
     * off to one side and transparent. Normally the repaint below throws the
     * node away, but if anything between here and there fails, the class
     * coming off is what keeps a book from being stranded off-screen.
     * Animations illustrate a change; the DOM owns the final state. */
    book.classList.remove(cls);
  }
  paintBookBody(scroll);
  paintBookHead();
  const fresh = document.getElementById('bk-book');
  /* The class comes OFF on a timer. `bkEnter*` starts at opacity 0 with
   * fill-mode `none`, so it looks safe — the element returns to its computed
   * style the moment the animation finishes. An animation that never finishes
   * never returns anything, and a throttled timeline was measured holding a
   * 260ms entrance running indefinitely with the book invisible. The
   * stylesheet owns the final state; this only draws the arrival. */
  if (fresh) enterOnce(fresh, dir === 'next' ? 'enter-next' : 'enter-prev', 260);
}

/* ── Structure (§19, §20) ────────────────────────────────────────────── */

async function addSection() {
  const values = await openLibraryForm('section');
  if (!values) return;
  await ctx.run(async () => {
    await flushAll();
    // The accent cycles through the six, so a new section is distinguishable
    // from its neighbour without asking the user to pick a colour.
    const accent = ACCENTS[lib.book.sections.length % ACCENTS.length];
    const r = await createSection(lib.bookId, { title: values.title, accent });
    /* The route creates the section AND its two pages in one transaction but
     * returns only the section. Re-reading the book is how the client ends up
     * holding what the server actually made, rather than a guess at it. */
    await loadBook(lib.bookId);
    const at = lib.book.sections.findIndex((s) => s.id === r.section.id);
    lib.sectionIdx = at > -1 ? at : lib.book.sections.length - 1;
    lib.spreadIdx = 0; lib.half = 0;
    paintBookHead();
    paintBookBody();
    ctx.toast(`Section “${values.title}” added.`);
  });
}

async function addPages() {
  await ctx.run(async () => {
    await flushAll();
    const section = currentSection();
    /* The button sits on the blank facing an odd final page. Adding two there
     * would fill the blank and open a second one — the user pressed Add on a
     * blank and got another blank. One page when the count is odd, a fresh
     * spread of two when it is even. */
    const count = section.pages.length % 2 === 1 ? 1 : 2;
    const r = await createPages(section.id, count);
    section.pages.push(...r.pages);
    lib.spreadIdx = spreadCount(section) - 1;
    lib.half = 0;
    paintBookHead();
    paintBookBody();
    // Focus the page that was just made, not whichever one is leftmost.
    const fresh = r.pages[0]?.id;
    (document.querySelector(`[data-editor="${fresh}"]`)
      ?? document.querySelector('.bk-editor'))?.focus();
  });
}

/**
 * Section actions.
 *
 * The API refuses to archive the LAST section of a book — a book with no
 * section has nowhere to put a page and no way to reach its own content. That
 * refusal is a product rule, so it is stated up front rather than delivered as
 * an error after the fact.
 */
function openSectionMenu(anchor, sectionId) {
  const section = lib.book.sections.find((s) => s.id === sectionId);
  if (!section) return;
  const onlyOne = lib.book.sections.length === 1;
  ctx.openSurface(anchor, {
    kind: 'library-section-menu',
    label: `Actions for ${section.title}`,
    html: `<div class="lib-menu lib-menu-sm" role="menu">
      <button type="button" role="menuitem" data-act="rename">Rename section…</button>
      <button type="button" role="menuitem" data-act="accent">Change colour…</button>
      ${onlyOne
    ? '<p class="lib-menu-note">The only section cannot be archived. Archive the book instead.</p>'
    : '<button type="button" role="menuitem" data-act="archive">Archive section</button>'}
    </div>`,
    wire: (el) => el.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        ctx.closeSurface();
        void sectionAction(b.dataset.act, section);
      });
    }),
  });
}

async function sectionAction(act, section) {
  if (act === 'rename') {
    const v = await openLibraryForm('section', { title: section.title });
    if (!v) return;
    return ctx.run(async () => {
      const r = await updateSection(section.id, { title: v.title });
      Object.assign(section, r.section);
      paintBookHead();
      paintBookBody();
    });
  }

  if (act === 'accent') {
    const choice = await ctx.choose({
      title: 'Section colour',
      body: 'The colour marks the tab, the page edge and the margin rule.',
      choices: ACCENTS.map((a) => ({ id: a, label: a[0].toUpperCase() + a.slice(1) })),
    });
    if (!choice) return;
    return ctx.run(async () => {
      const r = await updateSection(section.id, { accent: choice });
      Object.assign(section, r.section);
      paintBookBody();
    });
  }

  if (act === 'archive') {
    return ctx.run(async () => {
      await flushAll();
      await archiveSection(section.id);
      // Re-read rather than splice: archiving a section takes its pages with
      // it, and guessing which local rows went is how a stale page id ends up
      // being saved to.
      await loadBook(lib.bookId);
      forgetAll();
      lib.sectionIdx = Math.min(lib.sectionIdx, lib.book.sections.length - 1);
      lib.spreadIdx = 0;
      lib.half = 0;
      paintBookHead();
      paintBookBody();
      ctx.toast(`“${section.title}” archived. Its pages went with it.`);
    });
  }
}

/**
 * Page actions.
 *
 * The last page of a section refuses to archive, for the same reason: a section
 * with no page cannot be opened to.
 */
function openPageMenu(anchor, pageId) {
  const { page, section } = findPage(pageId);
  if (!page) return;
  const onlyOne = section.pages.length === 1;
  ctx.openSurface(anchor, {
    kind: 'library-page-menu',
    label: 'Actions for this page',
    html: `<div class="lib-menu lib-menu-sm" role="menu">
      ${onlyOne
    ? '<p class="lib-menu-note">The only page of a section cannot be archived.</p>'
    : '<button type="button" role="menuitem" data-act="archive">Archive page</button>'}
    </div>`,
    wire: (el) => el.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        ctx.closeSurface();
        void pageAction(b.dataset.act, page, section);
      });
    }),
  });
}

async function pageAction(act, page, section) {
  if (act !== 'archive') return;
  await ctx.run(async () => {
    await flushAll();
    await archivePage(page.id);
    forgetPage(page.id);          // no pending write to a page that is now gone
    const at = section.pages.findIndex((p) => p.id === page.id);
    if (at > -1) section.pages.splice(at, 1);
    lib.spreadIdx = Math.min(lib.spreadIdx, spreadCount(section) - 1);
    lib.half = 0;
    paintBookHead();
    paintBookBody();
    ctx.toast('Page archived.', false, {
      label: 'Undo',
      onAction: () => void ctx.run(async () => {
        await restorePage(page.id);
        await loadBook(lib.bookId);
        paintBookHead();
        paintBookBody();
      }),
    });
  });
}


/* ── Search within the book (§21) ────────────────────────────────────── */

function openBookSearch(scroll) {
  const existing = scroll.querySelector('.bk-search');
  if (existing) { existing.remove(); return; }
  const holder = document.createElement('div');
  holder.innerHTML = searchPanelHtml(null, '');
  const panel = holder.firstElementChild;
  scroll.querySelector('.bk').style.position = 'relative';
  scroll.querySelector('.bk').appendChild(panel);
  const input = panel.querySelector('#bk-search-input');
  input.focus();

  let timer;
  const rerender = (results, q) => {
    const h = document.createElement('div');
    h.innerHTML = searchPanelHtml(results, q);
    const body = h.firstElementChild;
    // Only the results are replaced — the input keeps its caret.
    [...panel.children].forEach((c, i) => { if (i > 0) c.remove(); });
    [...body.children].forEach((c, i) => { if (i > 0) panel.appendChild(c); });
    wireHits(panel);
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value;
    timer = setTimeout(() => void ctx.run(async () => {
      rerender(q.trim() ? await searchBook(q) : null, q);
    }), 220);
  });
  panel.querySelector('#bk-search-close').onclick = () => panel.remove();
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') panel.remove(); });
  wireHits(panel);
}

function wireHits(panel) {
  panel.querySelectorAll('.bk-search-hit').forEach((b) => {
    b.addEventListener('click', () => void (async () => {
      const hit = locateHit(b.dataset.hitSection, b.dataset.hitPage);
      if (!hit) { ctx.toast('That page has moved. Reopen the book to see where.', true); return; }
      await flushAll();
      panel.remove();
      lib.sectionIdx = hit.sectionIdx;
      lib.spreadIdx = hit.spreadIdx;
      lib.half = 0;
      paintBookHead();
      paintBookBody();
      document.querySelector(`[data-editor="${hit.pageId}"]`)?.focus();
    })());
  });
}

/* ── Leaving (§16) ───────────────────────────────────────────────────── */

/**
 * Flush, then go. Never leaves typed text behind.
 *
 * The item id is remembered on the way out (§18) so the shelf can put itself
 * back where it was and say which book you came from. The ID, never the node —
 * the node is about to be destroyed, and holding a reference to it would keep a
 * whole discarded page alive to answer one question.
 */
export async function leaveBook(next) {
  const ok = await flushAll();
  if (!ok && hasUnsaved()) {
    ctx.toast('Some changes did not save. They are still here — try again.', true);
    return;
  }
  if (lib.book?.item?.id) lib.cameFrom = lib.book.item.id;
  forgetAll();
  lib.book = null; lib.bookId = null;
  setHashAndRender(next);
}

/** Called by app.js when the route changes away from Library. */
export async function libraryWillLeave() {
  /* The lab holds listeners and timers of its own. Tearing it down here means
   * leaving Library by any route stops it, not only switching concepts. */
  void import('./modules/library-lab/lab-view.js').then((m) => m.leaveLab()).catch(() => {});
  /* Leaving Library for another section. The shelves are captured whether or
   * not a Book is open, because coming back to Library from Today should also
   * land where you were. */
  captureShelfScroll();
  if (!lib.bookId) return true;
  await flushAll();
  forgetAll();
  lib.book = null; lib.bookId = null;
  return true;
}

/**
 * Called on hashchange while already inside Library.
 *
 * `ours` is decided by the shell, once, from nav.js's record of what it wrote.
 * A hash Library wrote about where it already is needs no second render — and
 * rendering anyway is how a page turn used to repaint itself twice.
 */
export function libraryHashChanged(ours = false) {
  if (ours) return;
  void renderLibrary();
}

/* ── Conflict surface (§17) ──────────────────────────────────────────── */

/**
 * A page changed somewhere else.
 *
 * Three ways out, and all three keep what was typed. "Copy my text" exists
 * because the only genuinely unacceptable outcome is a person losing words they
 * wrote — whichever version they choose, they can still get their own back.
 */
export async function showConflict(pageId) {
  const { page } = findPage(pageId);
  const entry = entryOf(pageId);
  if (!page || !entry) return;
  // A conflict on a book nobody is looking at is resolved when they come back.
  if (!document.querySelector('.bk-book')) return;

  const choice = await ctx.choose({
    title: 'This page changed somewhere else',
    body: 'Another tab or device saved this page while you were writing. '
      + 'Nothing you typed has been lost — choose what to keep.',
    choices: [
      { id: 'mine', label: 'Keep what I wrote', detail: 'Overwrites the other version' },
      { id: 'theirs', label: 'Load the newer version', detail: 'Your text is copied first' },
      { id: 'copy', label: 'Copy my text', detail: 'Puts it on the clipboard, changes nothing' },
    ],
  });
  if (!choice) return;

  const fresh = await loadBook(lib.bookId);
  const server = fresh.sections.flatMap((s) => s.pages).find((p) => p.id === pageId);
  if (!server) { ctx.toast('That page no longer exists.', true); return; }

  if (choice === 'copy') {
    await copyText(entry.pending ?? entry.committed);
    ctx.toast('Your text is on the clipboard.');
    return;
  }
  if (choice === 'mine') {
    await ctx.run(() => resolveKeepMine(pageId, server));
    ctx.toast('Your version was saved.');
    return;
  }
  // Taking theirs: copy first, then load. In that order, deliberately.
  await copyText(resolveTakeTheirs(pageId, server) ?? entry.committed);
  Object.assign(page, server);
  paintBookHead();
  paintBookBody();
  ctx.toast('Newer version loaded. Your text is on the clipboard.');
}

async function copyText(doc) {
  const { docToText } = await import('./editor-doc.js');
  const text = docToText(doc);
  try { await navigator.clipboard.writeText(text); } catch { /* clipboard denied */ }
  return text;
}

/* ── Sample hooks (§10) ──────────────────────────────────────────────── */

/**
 * A console hook, not a control. Test data does not belong in the product, and
 * a button that seeds fake books is a button that eventually gets pressed by
 * accident. The real guard is server-side: both endpoints refuse outright when
 * NODE_ENV is production.
 */
function installSampleHooks() {
  window.__sampleLibrary = {
    check: () => sampleCheck(),
    /* `size` is 'solo' | 'small' | 'full' (L3 §38). The shelf has to be judged
     * at one Book, at three and at many, and only the last of those can be
     * seen in a collection of many. */
    add: async (size = 'full') => {
      const r = await sampleAdd(size);
      lib.itemsLoaded = false;
      if (document.getElementById('main-scroll') && !lib.bookId) await renderLibrary();
      return r;
    },
    remove: async () => {
      const r = await sampleRemove();
      lib.itemsLoaded = false;
      if (!lib.bookId) await renderLibrary();
      return r;
    },
  };
}

/* ── Global wiring ───────────────────────────────────────────────────── */

/**
 * Attached from `initLibrary`, never at import time.
 *
 * A module that adds window listeners when it is imported cannot be loaded
 * anywhere without a DOM — which means it cannot be unit-tested, and the
 * routing and filtering rules in here are exactly the sort of thing that should
 * be. Import should define; only initialisation should act.
 */
let conflictShown = null;
function installGlobals() {
  // A conflict anywhere: offer the choice once, not once per failed retry.
  onSaveStatus((pageId, status) => {
    if (status !== 'conflict') { if (conflictShown === pageId) conflictShown = null; return; }
    if (conflictShown === pageId) return;
    conflictShown = pageId;
    void showConflict(pageId);
  });

  // Nothing typed is lost to a closed tab.
  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsaved()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // Crossing 820px changes whether a spread is read as one page or two.
  window.addEventListener('resize', () => { if (lib.bookId && !lib.cover) applyHalf(); });
}

export { lib, visibleItems, archivePage, archiveSection, search, statusOf, flush };
