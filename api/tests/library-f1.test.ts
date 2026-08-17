/**
 * Phase F1 — Library foundation.
 *
 * Three rules the tests exist to defend:
 *
 *   The TYPE is stored, never inferred from a MIME string.
 *   Page content is a validated DOCUMENT, never HTML.
 *   Nothing a person wrote is destroyed by one click.
 *
 * And one that matters more than any of them: no Legacy content is read,
 * written or migrated anywhere in this phase.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { validateDoc, docToText, EMPTY_DOC } from '../src/lib/book-doc.js';
import { SAMPLE_PREFIX, isLibrarySampleAllowed } from '../src/lib/sample-library.js';

const here = dirname(fileURLToPath(import.meta.url));

const TOKEN = 'test-bypass-token';
const envFor = (nodeEnv: string) => loadEnv({
  NODE_ENV: nodeEnv, PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused',
  FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = () => ({ authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'zander@example.com' });

async function setup(nodeEnv = 'test') {
  const { db } = await freshDb();
  const app = buildApp(db, envFor(nodeEnv));
  await app.ready();
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth() })).json();
  const ws = me.workspace.id;
  const base = `/api/v1/workspaces/${ws}`;
  const post = (url: string, payload?: any) =>
    app.inject({ method: 'POST', url: base + url, headers: auth(), payload: payload ?? {} });
  const patch = (url: string, payload: any) =>
    app.inject({ method: 'PATCH', url: base + url, headers: auth(), payload });
  const get = (url: string) => app.inject({ method: 'GET', url: base + url, headers: auth() });
  return { app, db, ws, post, patch, get };
}

/** A book with sections and pages, ready to poke at. */
async function aBook(h: any, title = 'Field Notes') {
  const created = (await h.post('/library/books', { title })).json();
  const full = (await h.get(`/library/books/${created.book.id}`)).json();
  return { ...created, full };
}

/* ── §3  No Legacy migration, at all ─────────────────────────────────── */

test('legacy: nothing in this phase reads or writes Legacy content', () => {
  const src = ['src/routes/library.ts', 'src/lib/sample-library.ts', 'src/lib/book-doc.ts']
    .map((f) => readFileSync(join(here, '..', f), 'utf8')).join('\n');
  for (const banned of ['legacyImport', 'importLegacy', 'S.notebook', 'firestore', 'Firestore']) {
    assert.ok(!src.includes(banned), `Library touches ${banned}`);
  }
  /* `legacy_id` is written in exactly ONE file — the sample seeder, where the
   * value is v2's own `sample:f1:` marker. It is a cleanup handle, not a Legacy
   * import hook, and nothing else in Library may write it. */
  const routes = readFileSync(join(here, '..', 'src', 'routes', 'library.ts'), 'utf8');
  assert.ok(!/legacyId\s*:/.test(routes), 'the Library routes write legacy_id');

  const seeder = readFileSync(join(here, '..', 'src', 'lib', 'sample-library.ts'), 'utf8')
    /* Comments stripped first — this check is about code, and prose written
     * near an assignment is not an assignment. */
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(seeder, /SAMPLE_PREFIX = 'sample:f1:'/);

  /* Two checks, because there are two ways to write this column.
   *
   * The single "whatever follows the word legacyId" scan this replaced could
   * not tell an assignment from the next property after a shorthand. L3 put a
   * conditional spread after `legacyId,` and the test reported
   * `...(spec.archived` as a suspicious legacy_id source. Property shorthand
   * has no value at that position — its value is the DECLARATION — so the
   * declaration is what gets checked. */

  // (a) every explicit `legacyId: <value>` is built from the prefix
  for (const value of [...seeder.matchAll(/legacyId\s*:\s*([^,\n}]*)/g)].map((m) => (m[1] ?? '').trim())) {
    assert.ok(
      /^(bookLegacyId|legacyId)$/.test(value)      // a local, checked in (b)
      || value.includes('SAMPLE_PREFIX')           // the prefix itself
      || value.includes('libraryItems.legacyId'),  // a column reference, not a write
      `legacy_id assigned from something unexpected: ${value}`,
    );
  }
  // (b) and every local that a shorthand can refer to is built from the prefix
  const locals = [...seeder.matchAll(/const\s+(\w*[lL]egacyId)\s*=\s*([^;\n]*)/g)];
  assert.ok(locals.length, 'no legacy_id local found — has the seeder changed shape?');
  for (const [, name, value] of locals) {
    assert.ok(value.includes('SAMPLE_PREFIX'),
      `${name} is not built from the sample prefix: ${value.trim()}`);
  }
});

test('legacy: the F1 migration adds tables and renames one — it moves no data', () => {
  const sql = readFileSync(join(here, '..', 'drizzle', '0006_library.sql'), 'utf8');
  assert.ok(!/\bINSERT\b/i.test(sql), 'the migration inserts rows');
  assert.ok(!/\bUPDATE\b/i.test(sql), 'the migration rewrites rows');
  assert.ok(!/\bDROP TABLE\b/i.test(sql), 'the migration drops a table');
  assert.match(sql, /ALTER TABLE calendar_item_links RENAME TO item_links/);
});

/* ── §8  One link model ──────────────────────────────────────────────── */

test('links: there is exactly one polymorphic link table', () => {
  const schema = readFileSync(join(here, '..', 'src', 'db', 'schema.ts'), 'utf8');
  assert.match(schema, /pgTable\('item_links'/);
  assert.ok(!schema.includes("pgTable('calendar_item_links'"), 'the old name is back');
  // A second general link table is the outcome the rename exists to prevent.
  const linkTables = [...schema.matchAll(/pgTable\('(\w*links?\w*)'/g)].map((m) => m[1]);
  assert.deepEqual(linkTables, ['item_links'], `more than one link table: ${linkTables}`);
});

test('links: renaming did not change what Calendar returns', async () => {
  const h = await setup();
  const r = await h.get('/calendar/range?from=2026-08-01&to=2026-08-07');
  assert.equal(r.statusCode, 200);
  assert.ok('links' in r.json(), 'the calendar range response lost its links field');
});

/* ── §2  Types are stored, not inferred ──────────────────────────────── */

test('items: every type round-trips, and the type is a column', async () => {
  const h = await setup();
  for (const type of ['document', 'image', 'video', 'file'] as const) {
    const r = await h.post('/library/items', { type, title: `A ${type}` });
    assert.equal(r.statusCode, 201, `${type} was rejected`);
    assert.equal(r.json().item.type, type);
  }
  // Same MIME, different types — which is the whole reason type is stored.
  const doc = (await h.post('/library/items',
    { type: 'document', title: 'Brief', mimeType: 'text/plain' })).json().item;
  const file = (await h.post('/library/items',
    { type: 'file', title: 'Export', mimeType: 'text/plain' })).json().item;
  assert.notEqual(doc.type, file.type);
  assert.equal(doc.mimeType, file.mimeType);
});

test('items: an unknown type is refused', async () => {
  const h = await setup();
  assert.equal((await h.post('/library/items', { type: 'spreadsheet', title: 'X' })).statusCode, 400);
});

test('items: a book cannot be created through the generic route', async () => {
  const h = await setup();
  // It would produce a book with no section and no pages — unreachable.
  const r = await h.post('/library/items', { type: 'book', title: 'Nope' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /library\/books/);
});

test('items: a link needs a URL, and a bad URL is refused', async () => {
  const h = await setup();
  assert.equal((await h.post('/library/items', { type: 'link', title: 'No url' })).statusCode, 400);
  assert.equal((await h.post('/library/items',
    { type: 'link', title: 'Bad', sourceUrl: 'not-a-url' })).statusCode, 400);
  assert.equal((await h.post('/library/items',
    { type: 'link', title: 'Good', sourceUrl: 'https://example.com/x' })).statusCode, 201);
});

/* ── §26  Archive, not delete ────────────────────────────────────────── */

test('archive: reversible, idempotent, and hidden from the default list', async () => {
  const h = await setup();
  const item = (await h.post('/library/items', { type: 'document', title: 'Brief' })).json().item;

  const archived = (await h.post(`/library/items/${item.id}/archive`)).json().item;
  assert.ok(archived.archivedAt);
  assert.equal(archived.status, 'archived');

  // Twice must not move the timestamp — when it happened is information.
  const again = (await h.post(`/library/items/${item.id}/archive`)).json().item;
  assert.equal(new Date(again.archivedAt).getTime(), new Date(archived.archivedAt).getTime());

  assert.ok(!(await h.get('/library/items')).json().items.some((i: any) => i.id === item.id));
  assert.ok((await h.get('/library/items?includeArchived=true')).json()
    .items.some((i: any) => i.id === item.id));

  const restored = (await h.post(`/library/items/${item.id}/restore`)).json().item;
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.status, 'active');
});

test('archive: permanent deletion is not exposed for anything holding content', () => {
  const src = readFileSync(join(here, '..', 'src', 'routes', 'library.ts'), 'utf8');
  const deletes = [...src.matchAll(/app\.delete\(`\$\{base\}([^`]+)`/g)].map((m) => m[1]);
  /* Items, sections and pages archive; they hold work nobody wants to lose to a
   * misclick, and that rule has not moved.
   *
   * Bookmarks and links are the two things that hold NO content. A bookmark is
   * a shortcut and a link is an edge — deleting either loses a pointer, not a
   * word, and archiving a shortcut would be a shortcut you cannot get rid of.
   * Note especially that deleting a link never touches the Task at either end
   * of it (§15). */
  const allowed = new Set(['/library/bookmarks/:id', '/library/links/:id']);
  for (const route of deletes) {
    assert.ok(allowed.has(route!),
      `DELETE ${route} exists — that is content, and content archives`);
  }
});

/* ── §7/§18  Books arrive ready to write in ──────────────────────────── */

test('book: creation makes an item, a book, a section and TWO pages', async () => {
  const h = await setup();
  const { book, full } = await aBook(h, 'Field Notes');

  assert.equal(full.item.type, 'book');
  assert.equal(full.item.title, 'Field Notes');
  assert.equal(full.book.id, book.id);
  assert.equal(full.sections.length, 1);
  // Two, because a spread needs two pages to be a spread.
  assert.equal(full.sections[0].pages.length, 2);
  assert.deepEqual(full.sections[0].pages.map((p: any) => p.content), [EMPTY_DOC, EMPTY_DOC]);
});

test('book: a rename reaches the shelf AND the cover', async () => {
  const h = await setup();
  const { book } = await aBook(h);
  await h.patch(`/library/books/${book.id}`, { title: 'Renamed' });
  const full = (await h.get(`/library/books/${book.id}`)).json();
  assert.equal(full.item.title, 'Renamed', 'the Library list still shows the old title');
  const listed = (await h.get('/library/items')).json().items.find((i: any) => i.type === 'book');
  assert.equal(listed.title, 'Renamed');
});

test('book: the list carries section and page counts without a request per card', async () => {
  const h = await setup();
  const { book } = await aBook(h);
  await h.post(`/library/books/${book.id}/sections`, { title: 'Research', accent: 'sage' });
  const listed = (await h.get('/library/items?type=book')).json().items[0];
  assert.equal(listed.book.sectionCount, 2);
  assert.equal(listed.book.pageCount, 4);
});

test('sections: ordered, accented, and the last one cannot be archived', async () => {
  const h = await setup();
  const { book, full } = await aBook(h);
  const first = full.sections[0];

  const second = (await h.post(`/library/books/${book.id}/sections`,
    { title: 'Research', accent: 'sage' })).json().section;
  assert.ok(second.position > first.position, 'a new section did not land at the end');

  // The only section cannot go: a book with none has nowhere to put a page.
  const solo = await setup();
  const onlyBook = await aBook(solo);
  const refused = await solo.post(`/library/sections/${onlyBook.section.id}/archive`);
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error.message, /only section/);

  // With two, archiving one takes its pages with it.
  const ok = await h.post(`/library/sections/${second.id}/archive`);
  assert.equal(ok.statusCode, 200);
  const after = (await h.get(`/library/books/${book.id}`)).json();
  assert.equal(after.sections.length, 1);
  assert.equal(after.sections[0].id, first.id);
});

test('sections: an invalid accent is refused', async () => {
  const h = await setup();
  const { book } = await aBook(h);
  assert.equal((await h.post(`/library/books/${book.id}/sections`,
    { title: 'X', accent: 'chartreuse' })).statusCode, 400);
});

test('pages: added deliberately, in a pair, at the end', async () => {
  const h = await setup();
  const { book, section } = await aBook(h);
  const before = (await h.get(`/library/books/${book.id}`)).json().sections[0].pages;

  const added = (await h.post(`/library/sections/${section.id}/pages`)).json().pages;
  assert.equal(added.length, 2, 'pages are not added as a spread');
  assert.ok(added[0].position > before[before.length - 1].position);

  const after = (await h.get(`/library/books/${book.id}`)).json().sections[0].pages;
  assert.equal(after.length, 4);
});

test('pages: the last page of a section cannot be archived', async () => {
  const h = await setup();
  const { book, section } = await aBook(h);
  const pages = (await h.get(`/library/books/${book.id}`)).json().sections[0].pages;

  assert.equal((await h.post(`/library/pages/${pages[0].id}/archive`)).statusCode, 200);
  const refused = await h.post(`/library/pages/${pages[1].id}/archive`);
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error.message, /only page/);

  // And archiving is undoable.
  assert.equal((await h.post(`/library/pages/${pages[0].id}/restore`)).statusCode, 200);
  assert.equal((await h.get(`/library/books/${book.id}`)).json().sections[0].pages.length, 2);
  void section;
});

/* ── §15  The document model ─────────────────────────────────────────── */

test('doc: a known grammar survives, and everything else is dropped', () => {
  const out = validateDoc({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Sub' }] },
      { type: 'script', content: [{ type: 'text', text: 'alert(1)' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] },
    ],
  });
  assert.deepEqual(out.content.map((b) => b.type), ['paragraph', 'heading', 'bulletList'],
    'an unknown node type survived validation');
});

test('doc: HTML is not a document, and never becomes one', () => {
  assert.deepEqual(validateDoc('<p onclick="alert(1)">hi</p>'), EMPTY_DOC);
  assert.deepEqual(validateDoc({ type: 'doc', content: '<script>x</script>' }), EMPTY_DOC);
  // There is no HTML anywhere in the stored shape, so there is nothing to sanitise.
  const out = validateDoc({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] },
  ] });
  assert.equal((out.content[0] as any).content[0].text, '<script>alert(1)</script>',
    'text was mangled — it is data, and escaping is the renderer’s job');
});

test('doc: only http(s) links survive; the rest become plain text', () => {
  const link = (href: string) => validateDoc({ type: 'doc', content: [{
    type: 'paragraph',
    content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href } }] }],
  }] });
  assert.ok((link('https://example.com').content[0] as any).content[0].marks);
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'nonsense']) {
    const out = link(bad);
    assert.equal((out.content[0] as any).content[0].marks, undefined,
      `${bad} survived as a link`);
    assert.equal((out.content[0] as any).content[0].text, 'click', 'the words were lost too');
  }
});

test('doc: headings are limited to two levels', () => {
  for (const [given, expected] of [[1, 2], [2, 2], [3, 3], [6, 2]] as const) {
    const out = validateDoc({ type: 'doc', content: [
      { type: 'heading', attrs: { level: given }, content: [{ type: 'text', text: 'H' }] },
    ] });
    assert.equal((out.content[0] as any).attrs.level, expected);
  }
});

test('doc: text extraction is what search reads', () => {
  const d = validateDoc({ type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Body text.' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] }] },
  ] });
  const text = docToText(d);
  for (const word of ['Title', 'Body text.', 'Item']) assert.ok(text.includes(word));
  // Block boundaries become spaces, so "Title" and "Body" never fuse.
  assert.ok(!text.includes('TitleBody'));
});

/* ── §16  Save safety ────────────────────────────────────────────────── */

test('save: content persists, and reload returns exactly what went in', async () => {
  const h = await setup();
  const { book } = await aBook(h);
  const page = (await h.get(`/library/books/${book.id}`)).json().sections[0].pages[0];

  const content = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Ideas' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Something worth keeping.' }] },
  ] };
  const saved = (await h.patch(`/library/pages/${page.id}`, { content, title: 'Ideas' })).json().page;
  assert.equal(saved.title, 'Ideas');
  assert.equal(saved.contentText, 'Ideas Something worth keeping.');

  const reloaded = (await h.get(`/library/books/${book.id}`)).json().sections[0].pages[0];
  /* Everything that went in comes back, plus a stable `id` on each top-level
   * block. The server mints one for any block that arrives without it — that
   * id is what a bookmark, a Task link and a future AI citation address, so it
   * has to exist for content the editor has never touched. Nothing else about
   * the document is altered. */
  assert.equal(reloaded.content.content.length, 2);
  for (const [i, block] of reloaded.content.content.entries()) {
    const { id, ...attrs } = block.attrs ?? {};
    assert.match(id, /^b[a-z0-9]+$/, 'a block came back with no stable id');
    assert.deepEqual({ ...block, attrs: Object.keys(attrs).length ? attrs : undefined },
      { ...content.content[i], attrs: content.content[i]!.attrs });
  }
});

test('save: a block that already has an id KEEPS it', async () => {
  /* The property everything else rests on. An id regenerated on each save
   * would break every bookmark and every link pointing at that block, silently,
   * the first time the page was edited. */
  const h = await setup();
  const { book } = await aBook(h);
  const page = (await h.get(`/library/books/${book.id}`)).json().sections[0].pages[0];

  const content = { type: 'doc', content: [
    { type: 'paragraph', attrs: { id: 'keepme' }, content: [{ type: 'text', text: 'Bank details' }] },
  ] };
  await h.patch(`/library/pages/${page.id}`, { content });
  const first = (await h.get(`/library/books/${book.id}`)).json().sections[0].pages[0];
  assert.equal(first.content.content[0].attrs.id, 'keepme');

  // And again, with the id it came back with.
  await h.patch(`/library/pages/${page.id}`, { content: first.content });
  const second = (await h.get(`/library/books/${book.id}`)).json().sections[0].pages[0];
  assert.equal(second.content.content[0].attrs.id, 'keepme');
});

test('save: a stale write is rejected, never silently applied', async () => {
  const h = await setup();
  const { book } = await aBook(h);
  const page = (await h.get(`/library/books/${book.id}`)).json().sections[0].pages[0];

  const first = (await h.patch(`/library/pages/${page.id}`, {
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'newer' }] }] },
    expectedUpdatedAt: page.updatedAt,
  })).json().page;

  // A second tab still holding the ORIGINAL timestamp must not win.
  const stale = await h.patch(`/library/pages/${page.id}`, {
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'older' }] }] },
    expectedUpdatedAt: page.updatedAt,
  });
  assert.equal(stale.statusCode, 409, 'an older save overwrote a newer one');

  const now = (await h.get(`/library/books/${book.id}`)).json().sections[0].pages[0];
  assert.equal(now.contentText, 'newer');
  void first;
});

test('save: writing a page marks the book as recently used', async () => {
  const h = await setup();
  const { book, full } = await aBook(h);
  const before = new Date(full.item.updatedAt).getTime();
  await new Promise((r) => setTimeout(r, 12));
  const page = full.sections[0].pages[0];
  await h.patch(`/library/pages/${page.id}`, {
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
  });
  const after = (await h.get(`/library/books/${book.id}`)).json();
  assert.ok(new Date(after.item.updatedAt).getTime() > before,
    'the shelf entry does not show when the book was last written in');
});

/* ── §19  Search ─────────────────────────────────────────────────────── */

test('search: finds a page by content and says where it is', async () => {
  const h = await setup();
  const { book, section, full } = await aBook(h, 'Field Notes');
  const page = full.sections[0].pages[0];
  await h.patch(`/library/pages/${page.id}`, {
    title: 'First principles',
    content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'A distinctive phrase about kestrels.' }] },
    ] },
  });

  const r = (await h.get('/library/search?q=kestrels')).json();
  assert.equal(r.pages.length, 1);
  const hit = r.pages[0];
  assert.equal(hit.bookId, book.id);
  assert.equal(hit.sectionId, section.id);
  assert.equal(hit.pageId, page.id);
  assert.equal(hit.bookTitle, 'Field Notes');
  assert.match(hit.excerpt, /kestrels/, 'the excerpt does not contain the match');
});

test('search: matches titles and descriptions across item types', async () => {
  const h = await setup();
  await h.post('/library/items', { type: 'link', title: 'Kestrel notes', sourceUrl: 'https://example.com' });
  await h.post('/library/items', { type: 'document', title: 'Other', description: 'mentions kestrel here' });
  const r = (await h.get('/library/search?q=kestrel')).json();
  assert.equal(r.items.length, 2);
});

test('search: can be scoped to one book', async () => {
  const h = await setup();
  const a = await aBook(h, 'Book A');
  const b = await aBook(h, 'Book B');
  for (const bk of [a, b]) {
    await h.patch(`/library/pages/${bk.full.sections[0].pages[0].id}`, {
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'shared word' }] }] },
    });
  }
  const all = (await h.get('/library/search?q=shared')).json();
  assert.equal(all.pages.length, 2);
  const scoped = (await h.get(`/library/search?q=shared&bookId=${a.book.id}`)).json();
  assert.equal(scoped.pages.length, 1);
  assert.equal(scoped.pages[0].bookId, a.book.id);
  assert.equal(scoped.items.length, 0, 'a book-scoped search returned Library items');
});

test('search: archived content is not findable', async () => {
  const h = await setup();
  const item = (await h.post('/library/items',
    { type: 'document', title: 'Findable kestrel' })).json().item;
  assert.equal((await h.get('/library/search?q=kestrel')).json().items.length, 1);
  await h.post(`/library/items/${item.id}/archive`);
  assert.equal((await h.get('/library/search?q=kestrel')).json().items.length, 0);
});

/* ── Workspace isolation ─────────────────────────────────────────────── */

test('isolation: one workspace cannot see or touch another’s Library', async () => {
  const mine = await setup();
  const theirs = await setup();
  const theirBook = await aBook(theirs, 'Private');

  /* Not "my Library is empty" — it has starter Books now — but "THEIR book is
   * not in it", which is the thing isolation is actually about. */
  const seen = (await mine.get('/library/items')).json().items;
  assert.ok(!seen.some((i: any) => i.book?.id === theirBook.book.id),
    'another workspace’s book appeared on this shelf');
  assert.ok(!seen.some((i: any) => i.title === 'Private'));
  assert.equal((await mine.get(`/library/books/${theirBook.book.id}`)).statusCode, 404);
  assert.equal((await mine.patch(`/library/books/${theirBook.book.id}`, { title: 'Hijacked' })).statusCode, 404);
  const page = theirBook.full.sections[0].pages[0];
  assert.equal((await mine.patch(`/library/pages/${page.id}`, { title: 'x' })).statusCode, 404);
  assert.equal((await mine.post(`/library/pages/${page.id}/archive`)).statusCode, 404);
});

/* ── §24  Sample tooling ─────────────────────────────────────────────── */

/* F1 asserted ONE book and one of every other type, because F1 was reviewing
 * the Book editor and one deep book was the whole requirement.
 *
 * L3 reviews a SHELF, and a shelf of one proves nothing about a shelf: not the
 * scrolling, not the prominence, not whether a long title sits next to a short
 * one without looking like a mistake. §37 therefore asks for 10–14 Books and
 * several of each other type. The old counts are not wrong, they are the counts
 * for a different question — so they are replaced by ranges that state what the
 * shelf actually needs. */
test('sample: seeds a full shelf — many books and several of every other type', async () => {
  const h = await setup();
  const r = (await h.post('/library/sample')).json();
  assert.ok(r.booksCreated >= 10 && r.booksCreated <= 14,
    `L3 §37 wants 10–14 books, got ${r.booksCreated}`);
  // The deep book still has its three sections; the shelf books add one each.
  assert.ok(r.sectionsCreated >= 3 + 10, `only ${r.sectionsCreated} sections seeded`);
  assert.ok(r.pagesCreated >= 6, `only ${r.pagesCreated} pages seeded`);

  const items = (await h.get('/library/items?includeArchived=true')).json().items;
  const byType: Record<string, number> = {};
  for (const i of items) byType[i.type] = (byType[i.type] ?? 0) + 1;
  for (const t of ['book', 'document', 'image', 'video', 'link', 'file']) {
    assert.ok(byType[t], `the sample set has no ${t}`);
  }
  /* The §37 minimums, so a future trim to the sample cannot quietly leave the
   * shelf too thin to judge. */
  assert.ok(byType.document >= 5, `only ${byType.document} documents`);
  assert.ok(byType.image >= 4, `only ${byType.image} images`);
  assert.ok(byType.video >= 3, `only ${byType.video} videos`);
  assert.ok(byType.link >= 5, `only ${byType.link} links`);
  assert.ok(byType.file >= 4, `only ${byType.file} files`);

  /* §38's deliberate awkward cases. Each one is a state the shelf has to
   * survive, and each is unmissable in review only if it is actually present. */
  assert.ok(items.some((i: any) => i.archivedAt), 'nothing archived — §38 wants one');
  assert.ok(items.some((i: any) => i.type === 'image' && !i.metadata && !i.thumbnailKey),
    'no image with a missing preview');
  assert.ok(items.some((i: any) => i.sourceUrl?.includes('.invalid')),
    'no deliberately broken external preview');
  assert.ok(items.some((i: any) => i.title.length > 40), 'no long title');
  assert.ok(items.some((i: any) => i.title.length <= 8), 'no short title');
  assert.ok(items.filter((i: any) => /quokka/i.test(`${i.title} ${i.description ?? ''}`)).length === 1,
    'the search needle must appear exactly once');
});

test('sample: the size dial seeds one shelf, a small one, or the lot', async () => {
  /* §38 asks for one Book, three Books and many Books, and those are three
   * different screens — a collection of many cannot demonstrate the first two.
   * One prefix, one cleanup, one system with a dial on it. */
  const solo = await setup();
  /* Measured as a DELTA. A new account arrives with starter Books, so the
   * absolute count no longer says anything about what the sample seeded. */
  const before = (await solo.get('/library/items')).json().items.length;
  const s = (await solo.post('/library/sample', { size: 'solo' })).json();
  assert.equal(s.booksCreated, 1, 'solo is the one deep book and nothing else');
  assert.equal((await solo.get('/library/items')).json().items.length - before, 1);

  const small = await setup();
  const m = (await small.post('/library/sample', { size: 'small' })).json();
  assert.equal(m.booksCreated, 3, 'small is three books');
  assert.ok(m.itemsCreated > 3, 'small still has a few non-books to sit beside them');
});

test('sample: seeding twice does not duplicate', async () => {
  const h = await setup();
  await h.post('/library/sample');
  const list = () => h.get('/library/items?type=book&includeArchived=true')
    .then((r) => r.json().items.length);
  const afterFirst = await list();

  const second = (await h.post('/library/sample')).json();
  assert.equal(second.itemsCreated, 0);
  assert.equal(second.booksCreated, 0);
  assert.ok(second.alreadyPresent > 0, 'the second seed did not recognise the first');
  // The count is COMPARED, not restated: a second seed must change nothing.
  assert.equal(await list(), afterFirst);
});

test('sample: cleanup matches the exact prefix and nothing else', async () => {
  const h = await setup();
  // Real content, deliberately named like the sample.
  const real = (await h.post('/library/items',
    { type: 'document', title: 'Life OS Field Notes' })).json().item;
  const realBook = await aBook(h, 'Life OS Field Notes');
  await h.post('/library/sample');

  const removed = (await h.post('/library/sample/remove')).json();
  assert.ok(removed.removed >= 6);

  const left = (await h.get('/library/items')).json().items;
  assert.ok(left.some((i: any) => i.id === real.id), 'a real item with a sample-like title was deleted');
  assert.ok(left.some((i: any) => i.id === realBook.item.id), 'a real book was deleted');
  assert.ok(!left.some((i: any) => i.legacyId?.startsWith(SAMPLE_PREFIX)), 'sample rows survived');
});

test('sample: production refuses to seed or remove', () => {
  /* Tested at the guard rather than through a production app, because a
   * production environment REFUSES to boot with DEV_AUTH_BYPASS set — which is
   * itself the stronger protection, and means there is no way to reach these
   * routes in production at all. */
  assert.equal(isLibrarySampleAllowed('production'), false);
  assert.equal(isLibrarySampleAllowed('staging'), true);
  assert.equal(isLibrarySampleAllowed('test'), true);

  const src = readFileSync(join(here, '..', 'src', 'routes', 'library.ts'), 'utf8');
  const seed = src.slice(src.indexOf("app.post(`${base}/library/sample`"));
  assert.match(seed.slice(0, 400), /if \(!isLibrarySampleAllowed\(env\.NODE_ENV\)\)/,
    'the seed route does not check the environment');
  const remove = src.slice(src.indexOf("app.post(`${base}/library/sample/remove`"));
  assert.match(remove.slice(0, 400), /if \(!isLibrarySampleAllowed\(env\.NODE_ENV\)\)/,
    'the cleanup route does not check the environment');
});

test('sample: removing a book cascades to its sections and pages', async () => {
  const h = await setup();
  await h.post('/library/sample');
  /* The DEEP book by name, not `items[0]`. The list is ordered by `updatedAt`
   * and L3 seeds eleven more books after it, so "the first book" stopped being
   * the one with three sections — the test was reading position as identity. */
  const books = (await h.get('/library/items?type=book')).json().items;
  const book = books.find((i: any) => i.title === 'Life OS Field Notes');
  assert.ok(book, 'the deep sample book is missing');
  const full = (await h.get(`/library/books/${book.book.id}`)).json();
  assert.equal(full.sections.length, 3);

  await h.post('/library/sample/remove');
  // The cascade is what removes sections and pages — they carry no prefix of
  // their own, which is precisely why cleanup cannot reach a user's page.
  assert.equal((await h.get(`/library/books/${book.book.id}`)).statusCode, 404);
});

/* ── §29  Nothing else moved ─────────────────────────────────────────── */

test('safety: tasks, projects, steps, habits and calendar all still work', async () => {
  const h = await setup();
  const me = (await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth() })).json();
  const areaId = me.areas[0].id;

  const project = (await h.post('/projects',
    { title: 'Still fine', outcome: 'Yes', areaId, focus: 'now' })).json().project;
  const task = (await h.post('/tasks', { title: 'A task', projectId: project.id })).json().task;
  await h.post(`/tasks/${task.id}/steps`, { title: 'A step' });
  assert.equal((await h.get(`/tasks/${task.id}`)).json().task.steps.length, 1);
  assert.equal((await h.get(`/projects/${project.id}`)).json().project.progress.total, 1);

  const habit = (await h.post('/habits', { name: 'Walk' })).json().habit;
  await h.post(`/habits/${habit.id}/check`, { date: '2026-08-03' });
  assert.equal((await h.get('/habits/history?from=2026-08-03&to=2026-08-03')).json().days[0].done, 1);

  const range = (await h.get('/calendar/range?from=2026-08-01&to=2026-08-07')).json();
  assert.ok(Array.isArray(range.habitDays));
  assert.ok(Array.isArray(range.links));
});

test('safety: no Google write appeared with Library', () => {
  const files = readdirSync(join(here, '..', 'src', 'routes'))
    .map((f) => readFileSync(join(here, '..', 'src', 'routes', f), 'utf8')).join('\n');
  assert.ok(!/googleapis\.com[^'"]*',\s*\{\s*method:\s*'(POST|PUT|PATCH|DELETE)/.test(files));
});
