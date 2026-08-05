/**
 * The save coordinator — one writer per document, ever.
 *
 * Extracted from `library-save.js` in D1 so Diary can reuse it rather than
 * fork it. Nothing about the rules changed; what changed is that the transport
 * is now injected, so each surface binds its own endpoint and gets its own
 * independent set of entries. Library's pages and Diary's days never share a
 * queue, a status or a version token.
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
 * Every write carries the version token from the LAST SUCCESSFUL response. A
 * response that arrives for a version we have already moved past cannot mark
 * anything Saved — it is applied to the version token and nothing else. That is
 * what stops a slow save from declaring newer text safe.
 */

/** Human wording for each state. Used by every status line and by tests. */
export const STATUS_LABEL = {
  saved: 'Saved',
  unsaved: 'Unsaved',
  saving: 'Saving…',
  failed: 'Save failed',
  conflict: 'Changed elsewhere',
};

const DEFAULT_DEBOUNCE = 900;

const sameDoc = (a, b) =>
  JSON.stringify(a ?? { type: 'doc', content: [] })
  === JSON.stringify(b ?? { type: 'doc', content: [] });

/**
 * Builds a coordinator bound to one transport.
 *
 * @param {object} opts
 * @param {(id: string, payload: {content?: object, fields?: object, expectedUpdatedAt?: string})
 *   => Promise<{updatedAt: string|null, content: object}|null>} opts.write
 *   Performs the write. Resolving with `null` means "nothing was created,
 *   because there was nothing worth creating" — Diary's empty-day rule. Throw
 *   with `.conflict = true` for a version clash.
 * @param {number} [opts.debounce]
 */
export function createSaveCoordinator({ write, debounce = DEFAULT_DEBOUNCE }) {
  /** Per-document save state, keyed by id. One entry, one writer. */
  const entries = new Map();
  const listeners = new Set();

  const emit = (id) => {
    const e = entries.get(id);
    for (const fn of listeners) fn(id, e?.status ?? 'saved', e ?? {});
  };

  function entryFor(id, seed) {
    let e = entries.get(id);
    if (!e) {
      e = {
        id,
        status: 'saved',
        /** The token for the version the server last confirmed. */
        version: seed?.updatedAt ?? null,
        /** What the server is known to hold. */
        committed: seed?.content ?? { type: 'doc', content: [] },
        /** What the user has typed and we have not sent yet. */
        pending: null,
        pendingFields: null,
        timer: 0,
        inFlight: false,
        error: null,
        conflict: null,
      };
      entries.set(id, e);
    }
    return e;
  }

  function setStatus(e, status, extra = {}) {
    e.status = status;
    Object.assign(e, extra);
    emit(e.id);
  }

  /**
   * Registers a document BEFORE anything is typed into it.
   *
   * Not a convenience. The entry records `committed` — what the server is known
   * to hold — and it has to be captured while that is still true. Creating the
   * entry lazily on the first keystroke captured it from an object the editor
   * had already updated, so `committed` equalled what had just been typed,
   * nothing ever looked unsaved, and no write was queued: the status sat on
   * "Saved" while the words went nowhere. An existing entry is left alone.
   */
  const track = (id, seed) => { entryFor(id, seed); };

  const statusOf = (id) => entries.get(id)?.status ?? 'saved';
  const entryOf = (id) => entries.get(id) ?? null;

  const hasUnsaved = () => [...entries.values()].some((e) =>
    e.status === 'unsaved' || e.status === 'saving'
    || e.status === 'failed' || e.status === 'conflict');

  function forget(id) {
    const e = entries.get(id);
    if (e?.timer) clearTimeout(e.timer);
    entries.delete(id);
  }
  const forgetAll = () => { for (const id of [...entries.keys()]) forget(id); };

  const onStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  /**
   * The user typed. Debounce, then write.
   *
   * Called on every keystroke, so it must be cheap and must not re-render
   * anything — the editor node has to survive typing untouched.
   *
   * `fields` is anything beside the document: a title, a mood, a note. It is
   * merged rather than replaced, so a title change and a mood change a moment
   * apart both survive into one write.
   */
  function queue(id, { content, fields, seed } = {}) {
    const e = entryFor(id, seed);
    if (e.status === 'conflict') return;      // nothing more is sent until resolved

    const noFields = fields === undefined || Object.keys(fields).length === 0;
    if (content !== undefined && sameDoc(content, e.committed) && noFields) {
      // Back to what the server already has — an undo all the way home.
      if (!e.inFlight && e.pendingFields == null) { e.pending = null; setStatus(e, 'saved'); }
      return;
    }
    if (content !== undefined) e.pending = content;
    if (!noFields) e.pendingFields = { ...(e.pendingFields ?? {}), ...fields };
    setStatus(e, 'unsaved');

    clearTimeout(e.timer);
    e.timer = setTimeout(() => { void flush(id); }, debounce);
  }

  /**
   * Writes now, and waits for it.
   *
   * Called by the debounce, and directly before anything that would make the
   * current editor go away: a date change, closing, leaving the route.
   */
  async function flush(id) {
    const e = entries.get(id);
    if (!e) return true;
    clearTimeout(e.timer);
    if (e.status === 'conflict') return false;
    if (e.pending == null && e.pendingFields == null) return true;

    // One writer. A second call waits for the first, then sends whatever is
    // pending by then — which coalesces a burst of typing into one more write.
    if (e.inFlight) {
      await e.inFlight;
      return flush(id);
    }

    const content = e.pending;
    const fields = e.pendingFields;
    const sentVersion = e.version;
    e.pending = null;
    e.pendingFields = null;
    setStatus(e, 'saving');

    const run = (async () => {
      try {
        const r = await write(id, {
          content: content ?? undefined,
          fields: fields ?? undefined,
          expectedUpdatedAt: sentVersion ?? undefined,
        });
        /* `null` means the server declined to create anything, because there
         * was nothing worth creating. Not a failure — there is simply still
         * nothing to be newer than. */
        if (r === null) { setStatus(e, 'saved'); return; }
        /* A response for a version we have already moved past updates the token
         * and NOTHING else. It must not declare the newer text saved. */
        if (e.version !== sentVersion) { e.version = r.updatedAt; return; }
        e.version = r.updatedAt;
        e.committed = r.content ?? e.committed;
        // More was typed while this was in flight — still unsaved, not saved.
        setStatus(e, e.pending == null && e.pendingFields == null ? 'saved' : 'unsaved');
        if (e.pending != null || e.pendingFields != null) {
          e.timer = setTimeout(() => { void flush(id); }, 0);
        }
      } catch (err) {
        // The typed content goes BACK into pending. Nothing is ever discarded
        // because a request failed.
        if (content != null) e.pending = content;
        if (fields != null) e.pendingFields = { ...fields, ...(e.pendingFields ?? {}) };
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

  async function flushAll() {
    const results = await Promise.all([...entries.keys()].map((id) => flush(id)));
    return results.every(Boolean);
  }

  /** Try again after a failure. The content is still here. */
  async function retry(id) {
    const e = entries.get(id);
    if (!e || e.status !== 'failed') return false;
    setStatus(e, 'unsaved');
    return flush(id);
  }

  /**
   * Keep what I wrote: adopt the server's version token, then write over it.
   *
   * Deliberately a re-read followed by a forced write rather than a blind
   * overwrite — the token has to come from the server or the next save
   * conflicts again for the same reason.
   */
  async function resolveKeepMine(id, server) {
    const e = entries.get(id);
    if (!e) return false;
    e.version = server.updatedAt;
    e.committed = server.content;
    setStatus(e, 'unsaved', { conflict: null });
    return flush(id);
  }

  /** Take the server's version. The local text is handed back to the caller. */
  function resolveTakeTheirs(id, server) {
    const e = entries.get(id);
    if (!e) return null;
    const mine = e.pending;
    e.pending = null;
    e.pendingFields = null;
    e.version = server.updatedAt;
    e.committed = server.content;
    setStatus(e, 'saved', { conflict: null });
    return mine;
  }

  /** Adopts a version the caller obtained some other way (a create, a reload). */
  function adopt(id, { updatedAt, content }) {
    const e = entryFor(id);
    e.version = updatedAt ?? e.version;
    if (content !== undefined) e.committed = content;
  }

  return {
    track, queue, flush, flushAll, retry, forget, forgetAll,
    statusOf, entryOf, hasUnsaved, onStatus, adopt,
    resolveKeepMine, resolveTakeTheirs,
  };
}

export { sameDoc };
