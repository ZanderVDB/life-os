/**
 * Library's binding of the shared save coordinator.
 *
 * The rules — one writer per page, the version token on every write, a stale
 * response that cannot declare newer text saved, a failure that keeps the
 * content — all live in `editor-save.js` now, because Diary needs the same
 * guarantees and forking them would mean fixing every future bug twice.
 *
 * What stays here is what is Library's alone: the endpoint, the shape of a
 * page, and the names the rest of Library already calls.
 */

import { savePage } from './library-api.js';
import { createSaveCoordinator, STATUS_LABEL } from './editor-save.js';

const co = createSaveCoordinator({
  write: async (pageId, { content, fields, expectedUpdatedAt }) => {
    const r = await savePage(pageId, {
      content,
      title: fields?.title,
      expectedUpdatedAt,
    });
    return { updatedAt: r.page.updatedAt, content: r.page.content };
  },
});

/**
 * Registers a page while `page.content` is still what the server holds.
 *
 * Capturing it later captures the user's own typing as the baseline, and then
 * nothing ever looks unsaved — see editor-save.js.
 */
export const trackPage = (page) =>
  co.track(page.id, { updatedAt: page.updatedAt, content: page.content });

export const queueSave = (page, content, title) => co.queue(page.id, {
  content,
  fields: title === undefined ? undefined : { title },
  seed: { updatedAt: page.updatedAt, content: page.content },
});

export const flush = (pageId) => co.flush(pageId);
export const flushAll = () => co.flushAll();
export const retry = (pageId) => co.retry(pageId);
export const forgetPage = (pageId) => co.forget(pageId);
export const forgetAll = () => co.forgetAll();
export const statusOf = (pageId) => co.statusOf(pageId);
export const entryOf = (pageId) => co.entryOf(pageId);
export const hasUnsaved = () => co.hasUnsaved();
export const onSaveStatus = (fn) => co.onStatus(fn);

/** A page's server shape is `{content, updatedAt}` — the coordinator's too. */
export const resolveKeepMine = (pageId, serverPage) =>
  co.resolveKeepMine(pageId, serverPage);
export const resolveTakeTheirs = (pageId, serverPage) =>
  co.resolveTakeTheirs(pageId, serverPage);

export { STATUS_LABEL };
