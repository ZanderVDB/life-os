/**
 * The page save coordinator.
 *
 * One writer per page, ever. Everything else queues behind it.
 *
 * This exists because Legacy's autosave was `setTimeout(() => svAll(), 1200)` —
 * a debounce onto a function that wrote the entire application state, with no
 * ordering, no failure path and no status. Two saves could overlap and the
 * slower one won; a failure was invisible; and there was no way to know whether
 * what you had typed was safe.
 *
 * ── The states ───────────────────────────────────────────────────────────
 *
 *   saved     the server has this exact content
 *   unsaved   there are local edits not yet sent
 *   saving    a write is in flight
 *   failed    the write failed; local content is intact and can be retried
 *   conflict  the server has newer content; the user must choose
 *
 * ── The ordering rule ────────────────────────────────────────────────────
 *
 * Every write carries `expectedUpdatedAt` from the LAST SUCCESSFUL response.
 * A response that arrives for a version we have already moved past cannot mark
 * anything Saved — it is applied to the version token and nothing else. That is
 * what stops a slow save from declaring newer text safe.
 */

import { savePage } from './library-api.js';
import { sameDoc } from './library-doc.js';

const DEBOUNCE = 900;

/** Per-page save state, keyed by page id. One entry, one writer. */
const entries = new Map();

/** Listeners for status changes, so the UI never polls. */
const listeners = new Set();
export const onSaveStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (pageId) => {
  const e = entries.get(pageId);
  for (const fn of listeners) fn(pageId, e?.status ?? 'saved', e ?? {});
};

function entryFor(pageId, page) {
  let e = entries.get(pageId);
  if (!e) {
    e = {
      pageId,
      status: 'saved',
      /** The token for the version the server last confirmed. */
      version: page?.updatedAt ?? null,
      /** What the server is known to hold. */
      committed: page?.content ?? { type: 'doc', content: [] },
      /** What the user has typed and we have not sent yet. */
      pending: null,
      pendingTitle: undefined,
      timer: 0,
      inFlight: false,
      error: null,
      conflict: null,
    };
    entries.set(pageId, e);
  }
  return e;
}

/**
 * Registers a page BEFORE anything is typed into it.
 *
 * This is not a convenience. The entry records `committed` — what the server is
 * known to hold — and it has to be captured while that is still true. Creating
 * the entry lazily on the first keystroke captured it from a page object the
 * editor had already updated, so `committed` equalled what had just been typed,
 * `sameDoc` said nothing had changed, and the save was never queued: the status
 * sat on "Saved" while the words went nowhere.
 *
 * An existing entry is left alone. Coming back to a page must not reset its
 * baseline to whatever is in the local copy by then.
 */
export function trackPage(page) {
  entryFor(page.id, page);
}

/** Forget a page's state — on book close, so a reopened book starts clean. */
export function forgetPage(pageId) {
  const e = entries.get(pageId);
  if (e?.timer) clearTimeout(e.timer);
  entries.delete(pageId);
}
export function forgetAll() {
  for (const id of [...entries.keys()]) forgetPage(id);
}

export const statusOf = (pageId) => entries.get(pageId)?.status ?? 'saved';
export const entryOf = (pageId) => entries.get(pageId) ?? null;

/** Anything typed and not yet confirmed, anywhere. */
export const hasUnsaved = () =>
  [...entries.values()].some((e) => e.status === 'unsaved' || e.status === 'saving'
    || e.status === 'failed' || e.status === 'conflict');

/**
 * The user typed. Debounce, then write.
 *
 * Called on every keystroke, so it must be cheap and must not re-render
 * anything — the editor node has to survive typing untouched.
 */
export function queueSave(page, content, title) {
  const e = entryFor(page.id, page);
  if (e.status === 'conflict') return;      // nothing more is sent until resolved

  if (sameDoc(content, e.committed) && title === undefined) {
    // Back to what the server already has — an undo all the way home.
    if (!e.inFlight) { e.pending = null; setStatus(e, 'saved'); }
    return;
  }
  e.pending = content;
  if (title !== undefined) e.pendingTitle = title;
  setStatus(e, 'unsaved');

  clearTimeout(e.timer);
  e.timer = setTimeout(() => { void flush(page.id); }, DEBOUNCE);
}

function setStatus(e, status, extra = {}) {
  e.status = status;
  Object.assign(e, extra);
  emit(e.pageId);
}

/**
 * Writes now, and waits for it.
 *
 * Called by the debounce, and directly before anything that would make the
 * current editor go away: a page turn, a section change, closing the book,
 * leaving the route. §16.
 */
export async function flush(pageId) {
  const e = entries.get(pageId);
  if (!e) return true;
  clearTimeout(e.timer);
  if (e.status === 'conflict') return false;
  if (e.pending == null && e.pendingTitle === undefined) return true;

  // One writer. A second call waits for the first, then sends whatever is
  // pending by then — which coalesces a burst of typing into one more write.
  if (e.inFlight) {
    await e.inFlight;
    return flush(pageId);
  }

  const content = e.pending;
  const title = e.pendingTitle;
  const sentVersion = e.version;
  e.pending = null;
  e.pendingTitle = undefined;
  setStatus(e, 'saving');

  const run = (async () => {
    try {
      const r = await savePage(pageId, {
        content: content ?? undefined,
        title,
        expectedUpdatedAt: sentVersion ?? undefined,
      });
      /* A response for a version we have already moved past updates the token
       * and NOTHING else. It must not declare the newer text saved. */
      if (e.version !== sentVersion) {
        e.version = r.page.updatedAt;
        return;
      }
      e.version = r.page.updatedAt;
      e.committed = r.page.content;
      // More was typed while this was in flight — still unsaved, not saved.
      setStatus(e, e.pending == null && e.pendingTitle === undefined ? 'saved' : 'unsaved');
      if (e.pending != null) { e.timer = setTimeout(() => { void flush(pageId); }, 0); }
    } catch (err) {
      // The typed content goes BACK into pending. Nothing is ever discarded
      // because a request failed.
      if (content != null) e.pending = content;
      if (title !== undefined) e.pendingTitle = title;
      if (err.conflict) setStatus(e, 'conflict', { conflict: err.message, error: null });
      else setStatus(e, 'failed', { error: err.message });
    } finally {
      e.inFlight = false;
    }
  })();
  e.inFlight = run;
  await run;
  return e.status === 'saved';
}

/** Flush every page that has anything outstanding. */
export async function flushAll() {
  const results = await Promise.all([...entries.keys()].map((id) => flush(id)));
  return results.every(Boolean);
}

/** Try again after a failure. The content is still here. */
export async function retry(pageId) {
  const e = entries.get(pageId);
  if (!e || e.status !== 'failed') return false;
  setStatus(e, 'unsaved');
  return flush(pageId);
}

/* ── Conflict resolution (§17) ───────────────────────────────────────── */

/**
 * Keep what I wrote: adopt the server's version token, then write over it.
 *
 * Deliberately a re-read followed by a forced write rather than a blind
 * overwrite — the token has to come from the server or the next save conflicts
 * again for the same reason.
 */
export async function resolveKeepMine(pageId, serverPage) {
  const e = entries.get(pageId);
  if (!e) return false;
  e.version = serverPage.updatedAt;
  e.committed = serverPage.content;
  setStatus(e, 'unsaved', { conflict: null });
  return flush(pageId);
}

/** Take the server's version. The local text is handed back to the caller. */
export function resolveTakeTheirs(pageId, serverPage) {
  const e = entries.get(pageId);
  if (!e) return null;
  const mine = e.pending;
  e.pending = null;
  e.pendingTitle = undefined;
  e.version = serverPage.updatedAt;
  e.committed = serverPage.content;
  setStatus(e, 'saved', { conflict: null });
  return mine;
}

/** Human wording for each state. Used by the status line and by tests. */
export const STATUS_LABEL = {
  saved: 'Saved',
  unsaved: 'Unsaved',
  saving: 'Saving…',
  failed: 'Save failed',
  conflict: 'Changed elsewhere',
};
