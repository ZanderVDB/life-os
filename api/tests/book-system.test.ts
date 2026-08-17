/**
 * The unified Book system.
 *
 * Projects own execution. Library Books own information. Project Books connect
 * the two, and a future AI reads across all of it — which is why the tests that
 * matter here are about RELATIONSHIPS and IDENTITY rather than about pixels.
 *
 * What is protected:
 *   · a Project always has exactly one Primary Book, and asking twice does not
 *     make a second one
 *   · references are stored as ids and mirrored into the one edge table, so
 *     "what points at this Task?" is a query and not a document scan
 *   · a link is not the Task: unlinking leaves the Task, deleting the Task
 *     leaves the page
 *   · block ids survive edits, because everything addressable depends on it
 *   · a layout change never silently loses content
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const TOKEN = 'test-token';
const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused',
  FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = () => ({ authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'zander@example.com' });

async function setup() {
  const { db } = await freshDb();
  const app = buildApp(db, env);
  await app.ready();
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth() })).json();
  const base = `/api/v1/workspaces/${me.workspace.id}`;
  return {
    app,
    db,
    ws: me.workspace.id,
    post: (url: string, payload?: any) =>
      app.inject({ method: 'POST', url: base + url, headers: auth(), payload: payload ?? {} }),
    patch: (url: string, payload: any) =>
      app.inject({ method: 'PATCH', url: base + url, headers: auth(), payload }),
    get: (url: string) => app.inject({ method: 'GET', url: base + url, headers: auth() }),
    delete: (url: string) => app.inject({ method: 'DELETE', url: base + url, headers: auth() }),
  };
}

/* ── §6/§7  Every Project has a Book ──────────────────────────────────── */

async function aProject(h: any, title = 'Garden Renovation') {
  const areas = (await h.get('/areas')).json().areas ?? (await h.get('/areas')).json();
  const areaId = (Array.isArray(areas) ? areas : areas.areas)[0].id;
  const r = await h.post('/projects', {
    title, outcome: 'The garden is finished.', areaId, focus: 'now',
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}

test('creating a Project creates its Primary Book', async () => {
  const h = await setup();
  const { project, book } = await aProject(h);
  assert.ok(book?.bookId, 'a new Project has no Book');
  assert.equal(book.role, 'primary');
  assert.equal(book.title, 'Garden Renovation');

  /* An ordinary Library item, on the shelf like any other. The join row is the
   * only thing that makes it a Project Book — there is no second content
   * engine, which is the whole of §6. */
  const items = (await h.get('/library/items')).json().items;
  const shelved = items.find((i: any) => i.book?.id === book.bookId);
  assert.ok(shelved, 'the Project Book is not in Library');
  assert.equal(shelved.type, 'book');
  assert.equal(shelved.project.id, project.id);

  // And it opens onto something: a section with a spread to write on.
  const full = (await h.get(`/library/books/${book.bookId}`)).json();
  assert.equal(full.sections.length, 1);
  assert.equal(full.sections[0].pages.length, 2);
  assert.equal(full.project.id, project.id);
});

test('the Project detail carries its Book ON the project, not beside it', async () => {
  /* The regression: the header renders the "Project Book" button from
   * `p.book`, and the detail route returned the Book as a SIBLING of the
   * project. So the Book existed, was linked, and drew its Project Rail — while
   * the Project screen showed no way to reach it at all. */
  const h = await setup();
  const { project } = await aProject(h);
  const detail = (await h.get(`/projects/${project.id}`)).json();
  assert.ok(detail.project.book?.bookId, 'the detail project has no book');
  assert.equal(detail.project.book.bookId, detail.book.bookId);

  // The overview shapes it the same way, so one template serves both.
  const overview = (await h.get('/projects')).json();
  const row = overview.views.working.flatMap((g: any) => g.projects)
    .find((p: any) => p.id === project.id);
  assert.ok(row?.book?.bookId, 'the overview row has no book');
});

test('backfilling a Book is idempotent — asking twice makes one', async () => {
  const h = await setup();
  const { project } = await aProject(h);

  const first = (await h.post(`/projects/${project.id}/book`, {})).json();
  const second = (await h.post(`/projects/${project.id}/book`, {})).json();
  assert.equal(first.created, false, 'the Project already had a Book');
  assert.equal(second.created, false);
  assert.equal(first.book.bookId, second.book.bookId);

  const books = (await h.get('/library/items?type=book')).json().items
    .filter((i: any) => i.project?.id === project.id);
  assert.equal(books.length, 1, `${books.length} Books for one Project`);
});

/* ── §16  Where a Project Book appears is COMPUTED ────────────────────── */

test('completing and reopening a Project moves its Book, with no write to the Book', async () => {
  const h = await setup();
  const { project, book } = await aProject(h);

  const shelfOf = async () => {
    const items = (await h.get('/library/items')).json().items;
    return items.find((i: any) => i.book?.id === book.bookId)?.project?.shelf;
  };
  const bookRowAt = async () => {
    const items = (await h.get('/library/items')).json().items;
    return items.find((i: any) => i.book?.id === book.bookId)?.updatedAt;
  };

  assert.equal(await shelfOf(), 'projects_active');
  const before = await bookRowAt();

  await h.post(`/projects/${project.id}/complete`, {});
  assert.equal(await shelfOf(), 'projects_completed');

  /* The Book itself was not touched. §16 requires the shelf to be DERIVED from
   * the Project's lifecycle rather than stored on the Book — so there is
   * nothing that can drift, and reopening needs no repair. */
  assert.equal(await bookRowAt(), before, 'completing the Project wrote to its Book');

  await h.patch(`/projects/${project.id}`, { status: 'active' });
  assert.equal(await shelfOf(), 'projects_active');
  assert.equal(await bookRowAt(), before);
});

test('an ordinary Book has no Project and no rail', async () => {
  const h = await setup();
  const item = (await h.post('/library/books', { title: 'Notes' })).json();
  const full = (await h.get(`/library/books/${item.book.id}`)).json();
  assert.equal(full.project, null, 'a plain Book claimed a Project');
  const shelved = (await h.get('/library/items')).json().items
    .find((i: any) => i.book?.id === item.book.id);
  assert.equal(shelved.project, undefined);
});

/* ── §2/§31/§32  Page layouts ─────────────────────────────────────────── */

test('pages carry a layout, and a pinboard is one page across the spread', async () => {
  const h = await setup();
  const { book } = await aProject(h);
  const section = (await h.get(`/library/books/${book.bookId}`)).json().sections[0];

  const notes = (await h.post(`/library/sections/${section.id}/pages`,
    { count: 2, layout: 'research' })).json();
  assert.equal(notes.pages.length, 2);
  assert.equal(notes.pages[0].layout, 'research');
  assert.equal(notes.pages[0].spansSpread, false);
  // A template that promises structure arrives with it.
  assert.ok(notes.pages[0].contentText.includes('Question'));

  /* A pinboard IS the spread. Asking for two would make a second board behind
   * the first, which is unreachable. */
  const board = (await h.post(`/library/sections/${section.id}/pages`,
    { count: 2, layout: 'pinboard' })).json();
  assert.equal(board.pages.length, 1, 'a pinboard was created as two pages');
  assert.equal(board.pages[0].spansSpread, true);
  assert.deepEqual(board.pages[0].content, { type: 'pinboard', items: [] });
});

test('changing layout within the flowed family keeps every block', async () => {
  const h = await setup();
  const { book } = await aProject(h);
  const page = (await h.get(`/library/books/${book.bookId}`)).json().sections[0].pages[0];

  const content = { type: 'doc', content: [
    { type: 'paragraph', attrs: { id: 'p1' }, content: [{ type: 'text', text: 'Keep me' }] },
  ] };
  await h.patch(`/library/pages/${page.id}`, { content });

  const r = await h.post(`/library/pages/${page.id}/layout`, { layout: 'checklist' });
  assert.equal(r.statusCode, 200, r.body);
  const after = r.json().page;
  assert.equal(after.layout, 'checklist');
  assert.equal(after.content.content[0].attrs.id, 'p1', 'the block did not survive');
  assert.equal(after.content.content[0].content[0].text, 'Keep me');
});

test('crossing to a pinboard converts content rather than refusing it', async () => {
  const h = await setup();
  const { project, book } = await aProject(h);
  const task = await aTaskOn(h, project.id);
  const section = (await h.get(`/library/books/${book.bookId}`)).json().sections[0];
  const page = section.pages[0];

  await h.patch(`/library/pages/${page.id}`, { content: { type: 'doc', content: [
    { type: 'heading', attrs: { id: 'h', level: 2 }, content: [{ type: 'text', text: 'Payments' }] },
    { type: 'paragraph', attrs: { id: 'a' }, content: [{ type: 'text', text: 'Deposit first' }] },
    { type: 'taskRef', attrs: { id: 't', taskId: task.id } },
    { type: 'paragraph', attrs: { id: 'e' }, content: [] },
  ] } });

  /* Nothing is dropped. Writing becomes notes, and a Task reference becomes a
   * Task PIN — the same relationship, drawn at a position instead of in a
   * line. Refusing would only have forced the user to retype it. */
  const r = await h.post(`/library/pages/${page.id}/layout`, { layout: 'pinboard' });
  assert.equal(r.statusCode, 200, r.body);
  const items = r.json().page.content.items;
  assert.deepEqual(items.map((i: any) => i.kind), ['text', 'text', 'task']);
  assert.equal(items[0].text, 'Payments');
  assert.equal(items[2].taskId, task.id);
  // The empty paragraph is not carried across as an empty pin.
  assert.equal(items.length, 3);
  // Laid out so nothing lands on top of anything else.
  assert.equal(new Set(items.map((i: any) => `${i.x},${i.y}`)).size, 3);

  /* What is genuinely lost is the arrangement, and the caller is told so —
   * that is the honest reading of §32: warn about what goes, do not block
   * what does not. */
  assert.match(r.json().note, /became pins/);

  // And the relationship followed the content into the new shape.
  const links = (await h.get(`/library/links?sourceType=task&sourceId=${task.id}`)).json().links;
  assert.equal(links.length, 1);
  assert.equal(links[0].pageId, page.id);
});

test('and back again, with the Task relationship intact', async () => {
  const h = await setup();
  const { project, book } = await aProject(h);
  const task = await aTaskOn(h, project.id);
  const section = (await h.get(`/library/books/${book.bookId}`)).json().sections[0];
  const board = (await h.post(`/library/sections/${section.id}/pages`,
    { layout: 'pinboard' })).json().pages[0];

  await h.patch(`/library/pages/${board.id}`, { content: { type: 'pinboard', items: [
    { id: 'p1', kind: 'text', x: 6, y: 8, w: 26, h: 16, text: 'Deposit before materials' },
    { id: 'p2', kind: 'link', x: 40, y: 8, w: 26, h: 16, text: 'Quote', href: 'https://example.com/q' },
    { id: 'p3', kind: 'task', x: 6, y: 40, w: 26, h: 14, taskId: task.id },
  ] } });

  const r = await h.post(`/library/pages/${board.id}/layout`, { layout: 'two_columns' });
  assert.equal(r.statusCode, 200, r.body);
  const blocks = r.json().page.content.content;
  assert.deepEqual(blocks.map((b: any) => b.type), ['paragraph', 'paragraph', 'taskRef']);
  assert.equal(blocks[2].attrs.taskId, task.id);
  // A link pin keeps its address, as a link on the words.
  assert.equal(blocks[1].content[0].marks[0].attrs.href, 'https://example.com/q');
  assert.equal(r.json().page.spansSpread, false);
  assert.match(r.json().note, /is not kept/);

  const links = (await h.get(`/library/links?sourceType=task&sourceId=${task.id}`)).json().links;
  assert.equal(links.length, 1, 'the Task link did not survive the conversion');
});

/* ── §11/§12/§15/§21  Task ↔ Page ─────────────────────────────────────── */

/** A Task, then assigned to the Project — the two-step the API actually has. */
async function aTaskOn(h: any, projectId: string, title = 'Make contractor payment') {
  const made = await h.post('/tasks', { title });
  assert.equal(made.statusCode, 201, made.body);
  const task = made.json().task ?? made.json();
  const put = await h.post(`/projects/${projectId}/tasks`, { taskId: task.id });
  assert.ok(put.statusCode < 300, put.body);
  return task;
}

test('a Task reference on a page becomes a real, queryable edge', async () => {
  const h = await setup();
  const { project, book } = await aProject(h);
  const task = await aTaskOn(h, project.id);
  const full = (await h.get(`/library/books/${book.bookId}`)).json();
  const page = full.sections[0].pages[0];

  await h.patch(`/library/pages/${page.id}`, { title: 'Contractor Deposit', content: {
    type: 'doc',
    content: [{ type: 'taskRef', attrs: { id: 'blk1', taskId: task.id } }],
  } });

  /* The relationship is not trapped inside the document — §12. It is a row,
   * with the address needed to navigate back to it. */
  const links = (await h.get(`/library/links?sourceType=task&sourceId=${task.id}`)).json().links;
  assert.equal(links.length, 1);
  assert.equal(links[0].pageId, page.id);
  assert.equal(links[0].bookId, book.bookId);
  assert.equal(links[0].blockId, 'blk1');
  assert.equal(links[0].kind, 'context');
  // A readable address, built from titles rather than from a page number.
  assert.equal(links[0].label, 'Notes → Contractor Deposit');

  // And the Project side sees it, which is what makes it two-way (§13).
  const detail = (await h.get(`/projects/${project.id}`)).json();
  const shown = detail.tasks.find((t: any) => t.id === task.id);
  assert.equal(shown.pageLinks.length, 1);
  assert.equal(shown.pageLinks[0].pageId, page.id);
});

test('the page resolves its references live, never from a stored copy', async () => {
  const h = await setup();
  const { project, book } = await aProject(h);
  const task = await aTaskOn(h, project.id);
  const page = (await h.get(`/library/books/${book.bookId}`)).json().sections[0].pages[0];
  await h.patch(`/library/pages/${page.id}`, { content: {
    type: 'doc', content: [{ type: 'taskRef', attrs: { id: 'b', taskId: task.id } }],
  } });

  await h.patch(`/tasks/${task.id}`, { title: 'Pay the deposit' });

  /* Nothing was written to the page, and the page now says the new title —
   * because it never stored the old one (§20). */
  const full = (await h.get(`/library/books/${book.bookId}`)).json();
  assert.equal(full.refs.tasks.length, 1);
  assert.equal(full.refs.tasks[0].title, 'Pay the deposit');
  const stored = full.sections[0].pages[0].content.content[0];
  assert.deepEqual(Object.keys(stored.attrs).sort(), ['id', 'taskId']);
});

test('a Task may be linked to several pages at once', async () => {
  const h = await setup();
  const { project, book } = await aProject(h);
  const task = await aTaskOn(h, project.id, 'Choose flooring');
  const section = (await h.get(`/library/books/${book.bookId}`)).json().sections[0];
  const pages = section.pages;

  for (const [i, p] of pages.entries()) {
    await h.patch(`/library/pages/${p.id}`, {
      title: `Page ${i}`,
      content: { type: 'doc', content: [{ type: 'taskRef', attrs: { id: `b${i}`, taskId: task.id } }] },
    });
  }
  const links = (await h.get(`/library/links?sourceType=task&sourceId=${task.id}`)).json().links;
  assert.equal(links.length, 2, 'a Task was restricted to one page');
});

test('removing the reference unlinks; it never deletes the Task', async () => {
  const h = await setup();
  const { project, book } = await aProject(h);
  const task = await aTaskOn(h, project.id);
  const page = (await h.get(`/library/books/${book.bookId}`)).json().sections[0].pages[0];

  await h.patch(`/library/pages/${page.id}`, { content: {
    type: 'doc', content: [{ type: 'taskRef', attrs: { id: 'b', taskId: task.id } }],
  } });
  // Saving the page WITHOUT the card is what "remove link" means in the Book.
  await h.patch(`/library/pages/${page.id}`, { content: { type: 'doc', content: [] } });

  const links = (await h.get(`/library/links?sourceType=task&sourceId=${task.id}`)).json().links;
  assert.equal(links.length, 0, 'the edge outlived the reference');
  const still = await h.get(`/tasks/${task.id}`);
  assert.equal(still.statusCode, 200, 'removing a reference deleted the Task');
});

test('deleting the Task leaves the page structurally intact', async () => {
  const h = await setup();
  const { project, book } = await aProject(h);
  const task = await aTaskOn(h, project.id);
  const page = (await h.get(`/library/books/${book.bookId}`)).json().sections[0].pages[0];

  await h.patch(`/library/pages/${page.id}`, { content: { type: 'doc', content: [
    { type: 'paragraph', attrs: { id: 'p' }, content: [{ type: 'text', text: 'The deposit' }] },
    { type: 'taskRef', attrs: { id: 'b', taskId: task.id } },
  ] } });
  await h.delete(`/tasks/${task.id}`);

  /* §15: never silently delete Book content because a Task changed. The block
   * stays; it renders as unavailable because nothing resolves it. */
  const full = (await h.get(`/library/books/${book.bookId}`)).json();
  const blocks = full.sections[0].pages[0].content.content;
  assert.equal(blocks.length, 2, 'the page lost content when the Task went');
  assert.equal(blocks[1].type, 'taskRef');
  assert.equal(full.refs.tasks.length, 0, 'a deleted Task still resolved');
});

/* ── §5  Bookmarks ────────────────────────────────────────────────────── */

test('a bookmark is a shortcut and changes no page order', async () => {
  const h = await setup();
  const { book } = await aProject(h);
  const before = (await h.get(`/library/books/${book.bookId}`)).json().sections[0];
  const page = before.pages[1];

  const made = (await h.post(`/library/books/${book.bookId}/bookmarks`,
    { pageId: page.id, label: 'Outstanding Payments' })).json();
  assert.equal(made.created, true);

  const after = (await h.get(`/library/books/${book.bookId}`)).json();
  assert.equal(after.bookmarks.length, 1);
  assert.equal(after.bookmarks[0].label, 'Outstanding Payments');
  assert.deepEqual(after.sections[0].pages.map((p: any) => p.id),
    before.pages.map((p: any) => p.id), 'bookmarking reordered the pages');

  // Bookmarking the same page twice is a duplicate, not a pair.
  const again = (await h.post(`/library/books/${book.bookId}/bookmarks`,
    { pageId: page.id, label: 'Again' })).json();
  assert.equal(again.created, false);
  assert.equal((await h.get(`/library/books/${book.bookId}`)).json().bookmarks.length, 1);
});

test('a bookmark cannot point outside its own book', async () => {
  const h = await setup();
  const a = await aProject(h, 'A');
  const b = await aProject(h, 'B');
  const foreign = (await h.get(`/library/books/${b.book.bookId}`)).json().sections[0].pages[0];
  const r = await h.post(`/library/books/${a.book.bookId}/bookmarks`,
    { pageId: foreign.id, label: 'Nope' });
  assert.equal(r.statusCode, 400);
});

/* ── §17  Deleting a Project keeps what was written ───────────────────── */

test('deleting a Project keeps its Book by default', async () => {
  const h = await setup();
  const { project, book } = await aProject(h);
  const r = await h.delete(`/projects/${project.id}`);
  assert.equal(r.json().book.disposition, 'keep');

  /* The Book survives as an ordinary Library Book. Deleting a Project is a
   * statement about the PLAN; the notes are usually the part nobody can
   * reconstruct. */
  const items = (await h.get('/library/items')).json().items;
  const survivor = items.find((i: any) => i.book?.id === book.bookId);
  assert.ok(survivor, 'the Book went with the Project');
  assert.equal(survivor.project, undefined, 'it still claims a Project that is gone');
});

/* ── §30  Pinboards ───────────────────────────────────────────────────── */

test('pinned items keep stable ids and positions, and references stay live', async () => {
  const h = await setup();
  const { project, book } = await aProject(h);
  const task = await aTaskOn(h, project.id);
  const section = (await h.get(`/library/books/${book.bookId}`)).json().sections[0];
  const board = (await h.post(`/library/sections/${section.id}/pages`,
    { layout: 'pinboard' })).json().pages[0];

  await h.patch(`/library/pages/${board.id}`, { content: { type: 'pinboard', items: [
    { id: 'pin1', kind: 'text', x: 10, y: 20, w: 25, h: 15, text: 'Deposit first' },
    { id: 'pin2', kind: 'task', x: 50, y: 30, w: 26, h: 14, taskId: task.id },
  ] } });

  const saved = (await h.get(`/library/books/${book.bookId}`)).json();
  const page = saved.sections[0].pages.find((p: any) => p.id === board.id);
  assert.deepEqual(page.content.items.map((i: any) => i.id), ['pin1', 'pin2']);
  assert.equal(page.content.items[1].taskId, task.id);
  assert.ok(!('title' in page.content.items[1]), 'a pin stored a copy of the title');
  assert.equal(page.contentText, 'Deposit first');

  /* A Task dropped on a pinboard is the same relationship as one dropped on a
   * page of notes, and must be equally findable. */
  const links = (await h.get(`/library/links?sourceType=task&sourceId=${task.id}`)).json().links;
  assert.equal(links.length, 1);
  assert.equal(links[0].pageId, board.id);
  assert.equal(links[0].blockId, 'pin2');
});

test('a pin with no target and a pin with no address are both dropped', async () => {
  const h = await setup();
  const { book } = await aProject(h);
  const section = (await h.get(`/library/books/${book.bookId}`)).json().sections[0];
  const board = (await h.post(`/library/sections/${section.id}/pages`,
    { layout: 'pinboard' })).json().pages[0];

  const r = await h.patch(`/library/pages/${board.id}`, { content: { type: 'pinboard', items: [
    { id: 'a', kind: 'task', x: 1, y: 1, w: 10, h: 10 },              // no taskId
    { id: 'b', kind: 'link', x: 1, y: 1, w: 10, h: 10 },              // no href, no text
    { id: 'c', kind: 'text', x: 1, y: 1, w: 10, h: 10, text: 'Real' },
    { id: 'd', kind: 'nonsense', x: 1, y: 1, w: 10, h: 10 },
  ] } });
  assert.equal(r.json().page.content.items.length, 1);
  assert.equal(r.json().page.content.items[0].id, 'c');
});

test('a pin carries what it IS in the DOM, not only in the stored record', () => {
  /* The bug this exists for: `commit` rebuilt each pin from its PREVIOUS stored
   * record plus its geometry. A pin that had just been dropped had no previous
   * record, so it lost its `kind` and its `taskId` — the server then correctly
   * dropped it as an item with no kind, and a task dragged onto a board
   * vanished on reload while the editor said "Saved".
   *
   * The element is the authority for what a pin is. Same rule as reference
   * blocks, which is where it should have been copied from in the first place. */
  const src = readFileSync(join(WEB, 'library-book.js'), 'utf8');
  const pin = src.slice(src.indexOf('function pinHtml('), src.indexOf('/* ══ Bookmarks'));
  assert.match(pin, /data-kind="\$\{esc\(item\.kind\)\}"/, 'a pin does not carry its kind');
  assert.match(pin, /data-ref-id="\$\{esc\(ref\)\}"/, 'a reference pin does not carry its target');

  const commit = src.slice(src.indexOf('const commit = ()'), src.indexOf('board.addEventListener(\'pointerdown\''));
  assert.match(commit, /el\.dataset\.kind \|\| prev\.kind/, 'commit still trusts the stored record for kind');
  assert.match(commit, /el\.dataset\.refId/, 'commit does not read the pin target from the DOM');
});

/* ── §22/§23  What AI will need ───────────────────────────────────────── */

test('every meaningful object has a stable id, a type and an owner', async () => {
  const h = await setup();
  const { project, book } = await aProject(h);
  const full = (await h.get(`/library/books/${book.bookId}`)).json();

  for (const s of full.sections) {
    assert.match(s.id, /^[0-9a-f-]{36}$/);
    assert.equal(s.bookId, book.bookId);
    for (const p of s.pages) {
      assert.match(p.id, /^[0-9a-f-]{36}$/);
      assert.equal(p.sectionId, s.id);
      assert.ok(typeof p.layout === 'string');
      assert.ok(p.createdAt && p.updatedAt);
    }
  }
  assert.equal(full.project.id, project.id);
});

test('page content is searchable as text, whatever the layout', async () => {
  const h = await setup();
  const { book } = await aProject(h);
  const section = (await h.get(`/library/books/${book.bookId}`)).json().sections[0];
  const page = section.pages[0];

  await h.patch(`/library/pages/${page.id}`, {
    title: 'Contractor Deposit',
    content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Pay before materials are ordered.' }] },
    ] },
  });

  const hits = (await h.get('/library/search?q=materials')).json();
  const found = (hits.pages ?? []).some((p: any) => p.pageId === page.id || p.id === page.id);
  assert.ok(found, 'page content is not reachable from search');
});
