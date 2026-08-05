/**
 * Diary's binding of the shared save coordinator.
 *
 * The rules live in `editor-save.js`. What is Diary's alone is the two things
 * below, and both are genuinely different from Library's.
 *
 * ── A day has no id until it has content ─────────────────────────────────
 *
 * Library saves a page that already exists. Diary may be writing on a date that
 * has no row at all, and must not create one until there is something worth
 * keeping. So the coordinator is keyed by the DATE, not by an entry id — the
 * date is the only stable handle a blank day has — and the first successful
 * write is what brings the row into being.
 *
 * ── An empty day is a successful save of nothing ─────────────────────────
 *
 * The server answers a meaningless payload with `entry: null`. That is not a
 * failure; there is simply still nothing there. The coordinator treats a `null`
 * write result as Saved, so a blank page does not sit forever on "Unsaved" —
 * and no row is created behind it.
 */

import { createSaveCoordinator, STATUS_LABEL } from './editor-save.js';
import { saveDay, dia, localZone } from './diary-api.js';

const co = createSaveCoordinator({
  write: async (date, { content, fields, expectedUpdatedAt }) => {
    const body = { ...(fields ?? {}) };
    if (content !== undefined) body.document = content;
    if (expectedUpdatedAt) body.expectedUpdatedAt = expectedUpdatedAt;
    // Recorded on every write; the server only stores it when creating.
    if (!dia.entry) body.timezone = localZone();

    const r = await saveDay(date, body);

    if (!r.entry) return null;        // nothing worth creating — still Saved
    /* The row may have just come into existence. Handing it back to the state
     * here is what lets the header stop saying "no entry yet" without the
     * editor being re-rendered underneath the caret. */
    dia.entry = r.entry;
    onCreated?.(r.entry, r.created);
    return { updatedAt: r.entry.updatedAt, content: r.entry.document };
  },
});

/** Told when a date first becomes a real entry, so the view can catch up. */
let onCreated = null;
export const onEntryCreated = (fn) => { onCreated = fn; };

/**
 * Registers a date before anything is typed into it.
 *
 * For a date with no entry the baseline is the empty document, which is exactly
 * right: the first real keystroke is then a change, and an untouched page never
 * queues a write.
 */
export const trackDate = (date, entry) => co.track(date, {
  updatedAt: entry?.updatedAt ?? null,
  content: entry?.document ?? { type: 'doc', content: [] },
});

/**
 * @param {string} date
 * @param {object} [content] the document, when the editor changed
 * @param {object} [fields] title / mood / energy / notes / daySummary
 */
export const queueSave = (date, content, fields) => co.queue(date, {
  content,
  fields,
  seed: {
    updatedAt: dia.entry?.updatedAt ?? null,
    content: dia.entry?.document ?? { type: 'doc', content: [] },
  },
});

export const flush = (date) => co.flush(date);
export const flushAll = () => co.flushAll();
export const retry = (date) => co.retry(date);
export const forgetDate = (date) => co.forget(date);
export const forgetAll = () => co.forgetAll();
export const statusOf = (date) => co.statusOf(date);
export const entryOf = (date) => co.entryOf(date);
export const hasUnsaved = () => co.hasUnsaved();
export const onSaveStatus = (fn) => co.onStatus(fn);
export const adopt = (date, entry) => co.adopt(date, {
  updatedAt: entry?.updatedAt ?? null, content: entry?.document,
});

/** The server's entry shape is `{document, updatedAt}`; the coordinator's is
 *  `{content, updatedAt}`. One adapter, in one place. */
const asServer = (entry) => ({ updatedAt: entry.updatedAt, content: entry.document });
export const resolveKeepMine = (date, entry) => co.resolveKeepMine(date, asServer(entry));
export const resolveTakeTheirs = (date, entry) => co.resolveTakeTheirs(date, asServer(entry));

export { STATUS_LABEL };
