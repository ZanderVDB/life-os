/**
 * The Pinboard as structured data, and deleting a Book.
 *
 * ── The one rule this file exists to hold ───────────────────────────────
 *
 * A group and a connection are RELATIONSHIPS, not drawings. Two pins near each
 * other is not a group; a line between two boxes is not an edge. Both are rows
 * with stable ids, and both survive a round trip through the server unchanged,
 * because a later reader — a person, or the assistant — has to be able to know
 * that the beach photo, the location link and the Task are one thought.
 *
 * Anything that would let that degrade into CSS is a bug, so the assertions
 * below are mostly about what the server REFUSES to store: an edge to a pin
 * that is not there, a membership in a group that does not exist, a duplicate
 * id that would make an edge ambiguous.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { validatePinboard, pinboardToText, NOTE_STYLES, IMAGE_FRAMES } from '../src/lib/book-doc.js';

const WEB = join('..', 'web');
const WEB_DIR = WEB;
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
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
    me,
    app,
    db,
    del: (u: string) => app.inject({ method: 'DELETE', url: base + u, headers: auth() }),
    post: (u: string, p?: any) => app.inject({ method: 'POST', url: base + u, headers: auth(), payload: p ?? {} }),
    patch: (u: string, p: any) => app.inject({ method: 'PATCH', url: base + u, headers: auth(), payload: p }),
    get: (u: string) => app.inject({ method: 'GET', url: base + u, headers: auth() }),
  };
}

/** A Book with one pinboard page, ready to save content onto. */
async function aBoard(h: any) {
  const made = await h.post('/library/books', { title: 'Shoots' });
  assert.equal(made.statusCode, 201, made.body);
  const bookId = made.json().book.id;
  const sectionId = made.json().section.id;
  const page = await h.post(`/library/sections/${sectionId}/pages`, {
    title: 'Beach', layout: 'pinboard',
  });
  assert.equal(page.statusCode, 201, page.body);
  return { bookId, sectionId, pageId: page.json().pages[0].id, itemId: made.json().item.id };
}

const saveBoard = (h: any, pageId: string, content: any) =>
  h.patch(`/library/pages/${pageId}`, { content });

/* ── Groups and connections survive the server ────────────────────────── */

test('a group and its edges come back exactly as they went in', async () => {
  const h = await setup();
  const { pageId, bookId } = await aBoard(h);

  const content = {
    type: 'pinboard',
    groups: [{ id: 'g1', title: 'Beach Shoot' }],
    items: [
      { id: 'n1', kind: 'text', x: 10, y: 10, w: 20, h: 12, text: 'Golden hour', groupId: 'g1', style: 'sun' },
      { id: 'i1', kind: 'image', x: 40, y: 10, w: 24, h: 20, href: 'https://example.com/b.jpg', groupId: 'g1', frame: 'polaroid', caption: 'Low tide' },
      { id: 'l1', kind: 'link', x: 10, y: 40, w: 22, h: 10, href: 'https://maps.example.com/x', groupId: 'g1' },
    ],
    connections: [{ id: 'c1', from: 'n1', to: 'i1', label: 'shot list' }],
  };
  const r = await saveBoard(h, pageId, content);
  assert.equal(r.statusCode, 200, r.body);

  const back = (await h.get(`/library/books/${bookId}`)).json()
    .sections[0].pages.find((p: any) => p.id === pageId);
  assert.equal(back.content.groups.length, 1);
  assert.equal(back.content.groups[0].id, 'g1');
  assert.equal(back.content.groups[0].title, 'Beach Shoot');
  assert.equal(back.content.items.filter((i: any) => i.groupId === 'g1').length, 3,
    'membership did not survive');
  assert.equal(back.content.connections.length, 1);
  assert.deepEqual(
    { from: back.content.connections[0].from, to: back.content.connections[0].to },
    { from: 'n1', to: 'i1' });
  assert.equal(back.content.connections[0].label, 'shot list');
  // The expressive bits are data too, not a class name invented on the client.
  assert.equal(back.content.items.find((i: any) => i.id === 'n1').style, 'sun');
  assert.equal(back.content.items.find((i: any) => i.id === 'i1').frame, 'polaroid');
  assert.equal(back.content.items.find((i: any) => i.id === 'i1').caption, 'Low tide');
});

test('an edge to a pin that is not there is not an edge', () => {
  /* A dangling edge would draw a line to nowhere and, worse, tell a later
   * reader that two things are related when one of them no longer exists. */
  const b = validatePinboard({
    items: [{ id: 'a', kind: 'text', x: 1, y: 1, w: 10, h: 10, text: 'x' }],
    connections: [
      { id: 'c1', from: 'a', to: 'ghost' },
      { id: 'c2', from: 'ghost', to: 'a' },
      { id: 'c3', from: 'a', to: 'a' },
    ],
  });
  assert.equal(b.connections.length, 0);
});

test('deleting a pin takes its edges with it', () => {
  const first = validatePinboard({
    items: [
      { id: 'a', kind: 'text', x: 1, y: 1, w: 10, h: 10, text: 'a' },
      { id: 'b', kind: 'text', x: 20, y: 1, w: 10, h: 10, text: 'b' },
    ],
    connections: [{ id: 'c', from: 'a', to: 'b' }],
  });
  assert.equal(first.connections.length, 1);
  const after = validatePinboard({ ...first, items: first.items.filter((i) => i.id !== 'b') });
  assert.equal(after.connections.length, 0, 'an edge outlived the pin it pointed at');
});

test('a group nobody belongs to is not kept, and membership must be real', () => {
  const b = validatePinboard({
    groups: [{ id: 'g1', title: 'Used' }, { id: 'g2', title: 'Empty' }],
    items: [
      { id: 'a', kind: 'text', x: 1, y: 1, w: 10, h: 10, text: 'a', groupId: 'g1' },
      { id: 'b', kind: 'text', x: 20, y: 1, w: 10, h: 10, text: 'b', groupId: 'nope' },
    ],
  });
  assert.deepEqual(b.groups.map((g) => g.id), ['g1']);
  assert.equal(b.items.find((i) => i.id === 'b')?.groupId, undefined,
    'a pin joined a group that does not exist');
});

test('two pins cannot share an id', () => {
  /* Ids are what edges and membership point at. A duplicate makes both
   * ambiguous, and the ambiguity would only show up much later. */
  const b = validatePinboard({
    items: [
      { id: 'same', kind: 'text', x: 1, y: 1, w: 10, h: 10, text: 'first' },
      { id: 'same', kind: 'text', x: 20, y: 1, w: 10, h: 10, text: 'second' },
    ],
  });
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].text, 'first');
});

test('the same edge is not stored twice', () => {
  const b = validatePinboard({
    items: [
      { id: 'a', kind: 'text', x: 1, y: 1, w: 10, h: 10, text: 'a' },
      { id: 'b', kind: 'text', x: 20, y: 1, w: 10, h: 10, text: 'b' },
    ],
    connections: [{ id: 'c1', from: 'a', to: 'b' }, { id: 'c2', from: 'a', to: 'b' }],
  });
  assert.equal(b.connections.length, 1);
});

test('styles and frames are a fixed vocabulary, not free text', () => {
  const b = validatePinboard({
    items: [
      { id: 'a', kind: 'text', x: 1, y: 1, w: 10, h: 10, text: 'a', style: 'sun' },
      { id: 'b', kind: 'text', x: 20, y: 1, w: 10, h: 10, text: 'b', style: '#ff0000' },
      { id: 'c', kind: 'image', x: 40, y: 1, w: 10, h: 10, href: 'https://e.com/i.png', frame: 'evil' },
    ],
  });
  assert.equal(b.items.find((i) => i.id === 'a')?.style, 'sun');
  assert.equal(b.items.find((i) => i.id === 'b')?.style, undefined, 'arbitrary CSS got in');
  assert.equal(b.items.find((i) => i.id === 'c')?.frame, undefined);
  assert.ok(NOTE_STYLES.length <= 8, 'the style list has grown into a colour picker');
  assert.deepEqual([...IMAGE_FRAMES], ['none', 'frame', 'polaroid']);
});

/* ── Pasted images ───────────────────────────────────────────────────── */

test('a pasted raster image is stored inline; an SVG is not', async () => {
  /* There is no blob storage, so a pasted screenshot is stored with the page.
   * SVG is excluded on purpose: it can carry script, and storing one hands the
   * problem to whatever renders it next. */
  const h = await setup();
  const { pageId, bookId } = await aBoard(h);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';

  await saveBoard(h, pageId, {
    type: 'pinboard',
    items: [
      { id: 'p', kind: 'image', x: 1, y: 1, w: 20, h: 20, href: png },
      { id: 's', kind: 'image', x: 30, y: 1, w: 20, h: 20, href: svg },
    ],
  });
  const back = (await h.get(`/library/books/${bookId}`)).json()
    .sections[0].pages.find((p: any) => p.id === pageId);
  assert.equal(back.content.items.find((i: any) => i.id === 'p')?.href, png);
  assert.ok(!back.content.items.some((i: any) => i.id === 's'), 'an SVG data URI was stored');
});

test('an oversized inline image is refused rather than stored', () => {
  const huge = `data:image/png;base64,${'A'.repeat(1_000_000)}`;
  const b = validatePinboard({
    items: [{ id: 'x', kind: 'image', x: 1, y: 1, w: 20, h: 20, href: huge }],
  });
  assert.equal(b.items.length, 0);
});

test('a file pin records what the file is, and claims nothing more', () => {
  const b = validatePinboard({
    items: [
      { id: 'f', kind: 'file', x: 1, y: 1, w: 20, h: 12, fileName: 'contract.pdf', fileType: 'application/pdf', fileSize: 20481 },
      { id: 'g', kind: 'file', x: 30, y: 1, w: 20, h: 12 },
    ],
  });
  assert.equal(b.items.length, 1, 'a file pin with no filename was kept');
  assert.equal(b.items[0].fileName, 'contract.pdf');
  assert.equal(b.items[0].fileSize, 20481);
  // And the board says so rather than pretending to hold the bytes.
  assert.match(read('pinboard.js'), /the file itself is not stored/);
});

test('a board is searchable by its notes, captions, groups and labels', () => {
  const text = pinboardToText({
    type: 'pinboard',
    items: [
      { id: 'a', kind: 'text', x: 0, y: 0, w: 1, h: 1, text: 'golden hour' },
      { id: 'b', kind: 'image', x: 0, y: 0, w: 1, h: 1, href: 'https://e.com/i.png', caption: 'low tide' },
      { id: 'c', kind: 'file', x: 0, y: 0, w: 1, h: 1, fileName: 'permit.pdf' },
    ],
    groups: [{ id: 'g', title: 'Beach Shoot' }],
    connections: [{ id: 'c1', from: 'a', to: 'b', label: 'shot list' }],
  });
  for (const word of ['golden hour', 'low tide', 'permit.pdf', 'Beach Shoot', 'shot list']) {
    assert.ok(text.includes(word), `"${word}" is not searchable`);
  }
});

/* ── Deleting a Book ─────────────────────────────────────────────────── */

test('a normal Book can be deleted, and takes its pages with it', async () => {
  const h = await setup();
  const { bookId, itemId, pageId } = await aBoard(h);
  await saveBoard(h, pageId, {
    type: 'pinboard', items: [{ id: 'a', kind: 'text', x: 1, y: 1, w: 10, h: 10, text: 'note' }],
  });

  const r = await h.del(`/library/items/${itemId}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().deleted, true);
  assert.ok(r.json().pages >= 1, 'no pages were reported');

  assert.equal((await h.get(`/library/books/${bookId}`)).statusCode, 404, 'the book survived');
  const items = (await h.get('/library/items?includeArchived=true')).json().items;
  assert.ok(!items.some((i: any) => i.id === itemId), 'the item is still on a shelf');
});

test('deleting a Book never touches the tasks its pages referenced', async () => {
  /* A page can point at a Task; a reference is not ownership. This is the
   * assertion that makes the delete safe to offer at all. */
  const h = await setup();
  const { itemId, sectionId } = await aBoard(h);
  const project = (await h.post('/projects', {
    title: 'Shoot', outcome: 'Done.', areaId: h.me.areas[0].id, focus: 'now',
  })).json().project;
  const task = (await h.post('/tasks', { title: 'Hire lens', bucket: 'today' })).json().task;
  await h.post(`/projects/${project.id}/tasks`, { taskId: task.id });

  const page = (await h.post(`/library/sections/${sectionId}/pages`, {
    title: 'Refs', layout: 'pinboard',
  })).json().pages[0];
  await saveBoard(h, page.id, {
    type: 'pinboard',
    items: [{ id: 't', kind: 'task', x: 1, y: 1, w: 20, h: 12, taskId: task.id }],
  });

  assert.equal((await h.del(`/library/items/${itemId}`)).statusCode, 200);

  const tasks = (await h.get('/tasks?includeCompleted=false')).json().tasks;
  assert.ok(tasks.some((t: any) => t.id === task.id), 'deleting a Book destroyed a task');
  assert.equal((await h.get(`/projects/${project.id}`)).statusCode, 200,
    'deleting a Book destroyed a project');
});

test('a Project Book refuses to be deleted, and says whose it is', async () => {
  /* Its existence belongs to the project — ensureProjectBook recreates one on
   * demand — so deleting it here would either be undone on the next visit or
   * leave the project pointing at nothing. The project is where that decision
   * lives, and it already asks. */
  const h = await setup();
  const project = (await h.post('/projects', {
    title: 'Kitchen', outcome: 'Done.', areaId: h.me.areas[0].id, focus: 'now',
  })).json().project;
  const made = await h.post(`/projects/${project.id}/book`, {});
  assert.equal(made.statusCode, 200, made.body);

  const items = (await h.get('/library/items')).json().items;
  const projectBook = items.find((i: any) => i.project?.id === project.id);
  assert.ok(projectBook, 'the project book is not on a shelf');

  const r = await h.del(`/library/items/${projectBook.id}`);
  assert.equal(r.statusCode, 409, r.body);
  const message = r.json().error?.message ?? '';
  assert.match(message, /Kitchen/, 'the refusal does not name the project');
  assert.match(message, /archive/i, 'the refusal offers no way forward');

  // And it really is still there.
  const after = (await h.get('/library/items')).json().items;
  assert.ok(after.some((i: any) => i.id === projectBook.id), 'the refusal deleted it anyway');
});

test('deleting a Book leaves no links pointing at its pages', async () => {
  const h = await setup();
  const { itemId, sectionId } = await aBoard(h);
  const task = (await h.post('/tasks', { title: 'Read this', bucket: 'today' })).json().task;
  const page = (await h.post(`/library/sections/${sectionId}/pages`, { title: 'Linked' })).json().pages[0];
  await h.patch(`/library/pages/${page.id}`, {
    content: {
      type: 'doc',
      content: [{ type: 'taskRef', attrs: { taskId: task.id, blockId: 'b1' } }],
    },
  });
  const linksFor = async () => (await h.get(
    `/library/links?sourceType=task&sourceId=${task.id}`)).json().links;
  assert.ok((await linksFor()).length >= 1, 'no link was made to remove');

  await h.del(`/library/items/${itemId}`);
  assert.equal((await linksFor()).length, 0, 'a link to a deleted page survived');
});

/* ── The client, where the interaction lives ──────────────────────────── */

test('the board takes what it is given: paste, drop, and a task', () => {
  const src = read('pinboard.js');
  assert.match(src, /addEventListener\('paste'/, 'paste is not handled');
  assert.match(src, /addEventListener\('drop'/, 'drop is not handled');
  assert.match(src, /application\/x-los-task/, 'a dragged Task is no longer understood');
  assert.match(src, /text\/uri-list/, 'a dragged link is not understood');
  // A picture becomes an image; a URL becomes a link; anything else is a note.
  const ing = src.slice(src.indexOf('async function ingest('), src.indexOf('/* ── Moving'));
  assert.match(ing, /file\.type\?\.startsWith\('image\/'\)/);
  assert.match(ing, /isUrl\(t\)/);
  assert.match(ing, /kind: 'text'/);
  assert.match(ing, /kind: 'file'/);
  // And the plain controls remain, for anyone with no clipboard and no file.
  assert.match(read('library-book.js'), /data-pin-add="text"/);
});

test('double-clicking empty board writes a note there and puts the caret in it', () => {
  const src = read('pinboard.js');
  const fn = src.slice(src.indexOf("board.addEventListener('dblclick'"), src.indexOf("board.addEventListener('click'"));
  assert.match(fn, /addItem\(\{ kind: 'text'/, 'no note is created');
  assert.match(fn, /\[data-pin-text\]\`\)\?\.focus\(\)/, 'the new note is not focused');
});

test('selection, grouping and undo are all real', () => {
  const src = read('pinboard.js');
  assert.match(src, /e\.shiftKey.*\{ add: true \}/s, 'shift-click does not extend the selection');
  assert.match(src, /function beginMarquee/, 'there is no selection rectangle');
  assert.match(src, /meta && e\.key\.toLowerCase\(\) === 'a'/, 'there is no select-all');
  assert.match(src, /meta && e\.key\.toLowerCase\(\) === 'z'/, 'there is no undo');
  assert.match(src, /if \(e\.shiftKey\) redo\(\); else undo\(\);/, 'redo is missing');
  // Undo is a snapshot of the model, which is what makes it exact.
  assert.match(src, /past\.push\(before\)/);
  assert.match(src, /const moveSet = /, 'a group does not move together');
});

test('the board stays one spread — no pan, no zoom, no scroll', () => {
  /* The moment it scrolls it stops being two pages of a Book. */
  const src = read('pinboard.js');
  for (const forbidden of ['scrollLeft', 'translate3d', 'scale(', 'wheel']) {
    assert.ok(!src.includes(forbidden), `the board has grown a canvas (${forbidden})`);
  }
  assert.match(src, /clamp\(round2\(s\.x \+ ax\), 0, 100 - it\.w\)/,
    'a pin can be dragged off the spread');
});

test('the page menu asks what the page is FOR before what shape it is', () => {
  /* Purpose is the question a person actually has. Shape is a consequence of
   * it, and putting the consequence first made the menu read backwards. */
  const src = read('library-view.js');
  const from = src.indexOf("kind: 'library-page-menu'");
  const menu = src.slice(from, src.indexOf('wire: (el) =>', from));
  assert.ok(menu.indexOf('What this page is for') < menu.indexOf('Page shape'),
    'shape is still asked before purpose');
  assert.ok(menu.indexOf('Page shape') < menu.indexOf('lib-menu-foot'),
    'the settings come after the actions');
  assert.match(menu, /lib-menu-foot/, 'bookmark and archive are not set apart');
  assert.ok(menu.indexOf('data-act="archive"') > menu.indexOf('lib-menu-foot'),
    'archive is not in the separated footer');
  assert.match(read('app.css'), /\.lib-menu-foot\{[^}]*border-top/,
    'the separation is claimed but not drawn');
});

test('delete asks first, and offers archive as the way out', () => {
  const src = read('library-view.js');
  const fn = src.slice(src.indexOf("if (act === 'delete') {"));
  assert.match(fn, /ctx\.choose\(/, 'delete does not confirm');
  assert.match(fn, /Archive it instead/, 'the reversible option is not offered');
  assert.match(fn, /tone: 'danger'/);
  assert.match(fn, /Tasks, projects and diary entries a page linked to are not touched/,
    'the dialog does not say what is safe');
  /* And it has to be REACHABLE. A Book never opens the item view — clicking it
   * opens the Book itself — so a Delete button that only lives there would be
   * a delete no Book could ever use. The shelf menu is the one route every
   * kind of item shares. */
  assert.match(read('library-overview.js'), /data-act="delete"/,
    'the shelf menu has no Delete, so a Book cannot reach it');
  // No native dialogs anywhere in Library.
  assert.ok(!/\bconfirm\(|\bprompt\(|\balert\(/.test(src), 'a native dialog got into Library');
  assert.ok(!/\bconfirm\(|\bprompt\(|\balert\(/.test(read('pinboard.js')),
    'a native dialog got into the pinboard');
});

test('a drag survives a pointer that is already gone', () => {
  /* setPointerCapture throws when the pointer is no longer active — a
   * cancelled touch, a button released between the event and the handler. It
   * is a nicety, not a requirement, so letting it escape would abort the very
   * drag it was meant to smooth and leave the pin stuck. */
  const src = readFileSync(join(WEB_DIR, 'pinboard.js'), 'utf8');
  assert.ok(!/\.setPointerCapture\(e\.pointerId\)/.test(src),
    'setPointerCapture is called unguarded');
  assert.match(src, /const capture = \(el, id\) => \{ try \{ el\.setPointerCapture/);
});

test('selecting a pin does not rebuild the board under the pointer', () => {
  /* render() replaces innerHTML, which detaches every element. Selecting on
   * pointerdown and then beginning a drag on the same press handed the drag a
   * node no longer in the document: the first click selected a pin and did
   * nothing else, and you had to press again to move it. */
  const src = readFileSync(join(WEB_DIR, 'pinboard.js'), 'utf8');
  const sel = src.slice(src.indexOf('const select = (ids'), src.indexOf('/* ── Creating things'));
  assert.ok(!/render\(\)/.test(sel), 'selection still re-renders the whole board');
  assert.match(sel, /paintSelection\(\)/);
  assert.match(src, /function paintSelection\(\)/);
});
