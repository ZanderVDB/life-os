/**
 * Library — the API surface and the authoritative client state.
 *
 * ONE id-keyed store. Every module reads from here and nothing keeps its own
 * copy of an item, a book, a section or a page: two copies of a page is how an
 * editor and a search result start disagreeing about what was typed.
 *
 * The API functions are thin. They exist so that no rendering module ever
 * writes a URL, and so a 409 has exactly one place to be recognised.
 */

/** Injected by app.js so this module needs no knowledge of auth or workspace. */
let call = null;
export function initLibraryApi(apiFn) { call = apiFn; }

/* ── State ───────────────────────────────────────────────────────────── */

export const lib = {
  /** Library overview. */
  items: [],
  itemsLoaded: false,
  filter: 'all',
  query: '',
  showArchived: false,
  loading: false,
  error: null,
  /** Restored when returning from a book — §4. */
  resume: null,
  /** Page matches from the server for the shelf search — §22. */
  pageHits: [],

  /**
   * Where each shelf was scrolled to, keyed by shelf id (L3 §16/§18).
   *
   * Lives here rather than in the DOM because the DOM is thrown away when a
   * Book opens. Returning to the shelf you left, at the place you left it, is
   * the difference between a Library and a list that resets.
   */
  shelfScroll: {},
  /** The item the shelf should re-identify on return — id only, never a node. */
  cameFrom: null,
  /** Which shelf it was opened from, so the return lands on the right one. */
  cameFromShelf: null,

  /** The open book, by id. `null` when the overview is showing. */
  book: null,          // { item, book, sections: [{...,pages:[]}] }
  bookId: null,
  sectionIdx: 0,
  spreadIdx: 0,        // which PAIR of pages, within the section
  /**
   * Below 820px a 420:297 spread is two unreadable columns, so one half of the
   * spread is shown at a time. This is which half — a presentation choice only;
   * the spread itself is unchanged and a resize needs no reload.
   */
  half: 0,
  cover: true,         // showing the cover rather than a spread
  searchOpen: false,
  results: null,

  /**
   * The Project this Book belongs to, and its live tasks — the Project Rail.
   *
   * Kept beside the book rather than inside it because it has a DIFFERENT
   * lifetime: the rail refreshes when a task changes and the book does not, and
   * §33 requires that refresh to leave the editor and its cursor alone. Two
   * pieces of state, two paint functions, one screen.
   */
  project: null,       // the linked project row, or null for an ordinary Book
  projectTasks: [],
  railOpen: true,
};

/** The accent a section falls back to when it has none. */
export const ACCENT_FALLBACK = 'peach';

/** A page by id, from wherever it currently lives. One lookup, one object. */
export function findPage(pageId) {
  for (const s of lib.book?.sections ?? []) {
    const p = s.pages.find((x) => x.id === pageId);
    if (p) return { page: p, section: s };
  }
  return { page: null, section: null };
}

export const currentSection = () => lib.book?.sections[lib.sectionIdx] ?? null;

/**
 * The two pages of the current spread.
 *
 * `right` is null when the section has an odd number of pages and this is the
 * last spread. That blank is a RENDERING decision — §20 forbids creating a
 * database row merely to fill a layout.
 */
/**
 * A section's pages, grouped into the spreads they are actually shown in.
 *
 * Not simply pairs any more. A pinboard IS the spread — one page occupying both
 * halves — so the grouping has to be walked rather than divided. Pairing by
 * index would put an ordinary page alongside a pinboard and draw the two on top
 * of each other.
 *
 * Computed on demand rather than cached: a section gains and loses pages, and a
 * stale spread map is a spread map that opens the wrong page.
 */
export function spreadsOf(section) {
  const pages = section?.pages ?? [];
  const out = [];
  for (let i = 0; i < pages.length;) {
    const page = pages[i];
    if (page.spansSpread) { out.push({ full: page, left: null, right: null }); i += 1; continue; }
    const next = pages[i + 1];
    const right = next && !next.spansSpread ? next : null;
    out.push({ full: null, left: page, right });
    i += right ? 2 : 1;
  }
  return out.length ? out : [{ full: null, left: null, right: null }];
}

export function currentSpread() {
  const s = currentSection();
  if (!s) return { full: null, left: null, right: null };
  return spreadsOf(s)[lib.spreadIdx] ?? { full: null, left: null, right: null };
}

export const spreadCount = (section) => spreadsOf(section).length;

/** Which spread a given page falls in — how a bookmark or a backlink lands. */
export function spreadIndexOfPage(section, pageId) {
  const list = spreadsOf(section);
  return list.findIndex((s) => s.full?.id === pageId
    || s.left?.id === pageId || s.right?.id === pageId);
}

/* ── Items ───────────────────────────────────────────────────────────── */

export async function loadItems({ archived = false } = {}) {
  lib.loading = true;
  lib.error = null;
  try {
    const q = archived ? '?includeArchived=true' : '';
    const r = await call(`/library/items${q}`);
    lib.items = r.items;
    lib.itemsLoaded = true;
    lib.showArchived = archived;
  } catch (e) {
    // The known content stays on screen; §25 forbids a blank page on failure.
    lib.error = e.message;
    throw e;
  } finally {
    lib.loading = false;
  }
}

export const createItem = (body) => call('/library/items', { method: 'POST', body });
export const updateItem = (id, body) => call(`/library/items/${id}`, { method: 'PATCH', body });

export async function archiveItem(id) {
  const r = await call(`/library/items/${id}/archive`, { method: 'POST' });
  applyItem(r.item);
  return r.item;
}
/**
 * Permanent deletion. The one destructive call in Library.
 *
 * Removes the row from local state rather than marking it, because there is
 * nothing to come back to — leaving a ghost on the shelf that the next reload
 * disagrees with is worse than the shelf simply being shorter.
 */
export async function deleteItem(id) {
  const r = await call(`/library/items/${id}`, { method: 'DELETE' });
  lib.items = (lib.items ?? []).filter((i) => i.id !== id);
  return r;
}

export async function restoreItem(id) {
  const r = await call(`/library/items/${id}/restore`, { method: 'POST' });
  applyItem(r.item);
  return r.item;
}

/** Updates the one stored copy of an item, wherever it is in the list. */
function applyItem(item) {
  const at = lib.items.findIndex((i) => i.id === item.id);
  if (at > -1) Object.assign(lib.items[at], item);
}

/**
 * Records that something was opened (L3 §12).
 *
 * The local copy is written FIRST and the request is not awaited. Opening a
 * Book is a navigation; making it wait on a bookkeeping write would put a
 * network round trip between a click and a page turning, to update a list the
 * user is in the act of leaving. A rejected promise is swallowed for the same
 * reason: a lost recency mark is not worth a toast.
 */
export function markOpened(itemId) {
  const item = lib.items.find((i) => i.id === itemId);
  if (item) item.lastOpenedAt = new Date().toISOString();
  void call(`/library/items/${itemId}/opened`, { method: 'POST' }).catch(() => {});
}

/**
 * When something was last opened, or null.
 *
 * `updatedAt` is NOT a fallback here. It is a fallback for ORDERING, where any
 * stable recent-ish order beats none — but a date shown next to the word
 * "opened" has to be an opening. Callers that display it say "edited" when this
 * returns null, which is what actually happened.
 */
export const openedAt = (item) => item.lastOpenedAt ?? null;

/* ── Books ───────────────────────────────────────────────────────────── */

export const createBook = (body) => call('/library/books', { method: 'POST', body });

/**
 * Books already asked for, by id.
 *
 * Measured on the real Library: the first open of a Book costs 324ms of
 * network and every one after it costs 15ms. That 324ms is the whole of the
 * "lag" — long enough for the deferred skeleton to fire and put grey pages
 * between the shelf and the Book.
 *
 * Pulling a Book forward is an unambiguous statement of intent that happens
 * several hundred milliseconds before the second click, so the fetch starts
 * there and is usually finished by the time it is wanted. This is a cache of
 * ONE promise per id, so a prefetch and a real open share a single request
 * rather than racing.
 */
const bookCache = new Map();

/** Starts loading a Book without committing it to `lib`. Safe to call twice. */
export function prefetchBook(bookId) {
  if (!bookId || bookCache.has(bookId)) return;
  /* A prefetch that fails is not an error — the real open will ask again and
   * report it properly. Dropping it from the cache is what allows that. */
  bookCache.set(bookId, call(`/library/books/${bookId}`)
    .catch((e) => { bookCache.delete(bookId); throw e; }));
}

export async function loadBook(bookId) {
  if (!bookCache.has(bookId)) prefetchBook(bookId);
  let r;
  try {
    r = await bookCache.get(bookId);
  } catch (e) {
    bookCache.delete(bookId);
    throw e;
  }
  /* A Book is re-read after it is edited, so the cached copy cannot be kept
   * for ever — it is only ever the head start for one opening. */
  bookCache.delete(bookId);
  lib.book = r;
  lib.bookId = bookId;
  return r;
}

export const updateBook = (id, body) => call(`/library/books/${id}`, { method: 'PATCH', body });

export const createSection = (bookId, body) =>
  call(`/library/books/${bookId}/sections`, { method: 'POST', body });
export const updateSection = (id, body) =>
  call(`/library/sections/${id}`, { method: 'PATCH', body });
export const archiveSection = (id) =>
  call(`/library/sections/${id}/archive`, { method: 'POST' });

export const createPages = (sectionId, count = 2, layout = 'notes', purpose = null, title = null) =>
  call(`/library/sections/${sectionId}/pages`, {
    method: 'POST',
    body: { count, layout, ...(purpose ? { purpose } : {}), ...(title ? { title } : {}) },
  });
export const archivePage = (id) => call(`/library/pages/${id}/archive`, { method: 'POST' });
export const restorePage = (id) => call(`/library/pages/${id}/restore`, { method: 'POST' });

/** How the page is divided. Converts across shapes; never silently drops. */
export const setPageLayout = (id, layout) =>
  call(`/library/pages/${id}/layout`, { method: 'POST', body: { layout } });

/** What the page is FOR — a label and, on an empty page, its headings. */
export const setPagePurpose = (id, purpose) =>
  call(`/library/pages/${id}/purpose`, { method: 'POST', body: { purpose } });

/* ── Bookmarks ───────────────────────────────────────────────────────── */

export const addBookmark = (bookId, body) =>
  call(`/library/books/${bookId}/bookmarks`, { method: 'POST', body });
export const updateBookmark = (id, body) =>
  call(`/library/bookmarks/${id}`, { method: 'PATCH', body });
export const removeBookmark = (id) =>
  call(`/library/bookmarks/${id}`, { method: 'DELETE' });

/* ── Links ───────────────────────────────────────────────────────────── */

/** Every Book page a Task (or Project, or item) has been linked to. */
export const linksFor = (sourceType, sourceId) =>
  call(`/library/links?sourceType=${sourceType}&sourceId=${sourceId}`);

/** Removes the LINK. Never the Task — see §15. */
export const removeLink = (id) => call(`/library/links/${id}`, { method: 'DELETE' });

/**
 * Saves one page.
 *
 * `expectedUpdatedAt` travels with every write. A 409 is surfaced as a typed
 * error rather than a generic failure, because the caller has to do something
 * quite different with it — see library-save.js.
 */
export async function savePage(pageId, { content, title, expectedUpdatedAt }) {
  const body = {};
  if (content !== undefined) body.content = content;
  if (title !== undefined) body.title = title;
  if (expectedUpdatedAt) body.expectedUpdatedAt = expectedUpdatedAt;
  try {
    return await call(`/library/pages/${pageId}`, { method: 'PATCH', body });
  } catch (e) {
    if (/changed somewhere else/i.test(e.message) || e.status === 409) {
      const conflict = new Error(e.message);
      conflict.conflict = true;
      throw conflict;
    }
    throw e;
  }
}

/* ── Project context ─────────────────────────────────────────────────── */

/**
 * The Project behind a Project Book, with its live tasks.
 *
 * A second request rather than more fields on the book payload, deliberately:
 * the rail refreshes on its own whenever a task changes, and folding it into
 * the book response would mean re-reading every section and page to find out
 * that one checkbox moved.
 */
export async function loadProjectContext(projectId) {
  if (!projectId) { lib.project = null; lib.projectTasks = []; return null; }
  const r = await call(`/projects/${projectId}`);
  lib.project = r.project;
  lib.projectTasks = r.tasks ?? [];
  return r;
}

/* ── Search ──────────────────────────────────────────────────────────── */

export const search = (q, bookId = null) =>
  call(`/library/search?q=${encodeURIComponent(q)}${bookId ? `&bookId=${bookId}` : ''}`);

/* ── Sample tooling ──────────────────────────────────────────────────── */

export const sampleCheck = () => call('/library/sample');
export const sampleAdd = (size = 'full') =>
  call('/library/sample', { method: 'POST', body: { size } });
export const sampleRemove = () => call('/library/sample/remove', { method: 'POST' });
