/**
 * "I linked a task to a project, because that task has to do with that project,
 *  but it then added it as a related item instead of adding it as a task
 *  itself, which I think is stupid."
 *
 * Correct, and `relationships.ts` said so before the picker existed: STRUCTURAL
 * relationships are foreign keys and a generic edge must never express one,
 * because two competing answers to "which project is this task in" is worse
 * than either answer. The picker did exactly that, because making edges was all
 * it knew how to do.
 *
 * The second half is the same complaint in another place: it could only search,
 * which is fine when you know the name and useless when you do not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers.js';
import {
  structuralFor, browseLinkable, attachStructural,
} from '../src/lib/relationships.js';
import {
  tasks, projects, areas, itemLinks, users, workspaces, workspaceMemberships,
  libraryItems, libraryBooks, bookSections, bookPages,
} from '../src/db/schema.js';

/** A workspace with an owner, which is what every row here hangs off. */
async function ws() {
  const { db } = await freshDb();
  const [u] = await db.insert(users)
    .values({ email: 'z@example.com', displayName: 'Z' }).returning();
  const [w] = await db.insert(workspaces)
    .values({ ownerUserId: u!.id, name: 'Life OS' }).returning();
  await db.insert(workspaceMemberships).values({ workspaceId: w!.id, userId: u!.id });
  return { db, workspaceId: w!.id as string };
}

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const strip = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
const related = strip(read('related.js'));
const css = read('app.css');
const linksRoute = readFileSync(join('src', 'routes', 'links.ts'), 'utf8');

/* ══ The relationship that is a foreign key ══════════════════════════════ */

test('structural: the pairs that are real are declared once, beside the doctrine', () => {
  assert.equal(structuralFor('task', 'project')?.verb, 'Add to project');
  assert.equal(structuralFor('task', 'area')?.verb, 'Move to area');
  /* And the pairs that are genuinely semantic must NOT be here, or the picker
     would offer to "add" a diary entry to a habit. */
  assert.equal(structuralFor('task', 'diary'), null);
  assert.equal(structuralFor('task', 'book_page'), null);
  assert.equal(structuralFor('event', 'project'), null);
  // Declared on the server and served, so a client cannot guess a pair wrong.
  assert.match(linksRoute, /structural: Object\.entries\(STRUCTURAL\)/,
    'the structural pairs are not served with the kinds');
});

test('structural: attaching sets the foreign key and writes no edge', async () => {
  const { db, workspaceId } = await ws();
  const [area] = await db.insert(areas)
    .values({ workspaceId, name: 'Work', position: 0 }).returning();
  const [project] = await db.insert(projects)
    .values({ workspaceId, title: 'Kitchen' }).returning();
  const [task] = await db.insert(tasks)
    .values({ workspaceId, title: 'Order the tiles' }).returning();

  assert.equal(task!.projectId, null);
  await attachStructural(db, workspaceId, {
    sourceType: 'task', sourceId: task!.id, targetType: 'project', targetId: project!.id,
  });
  const [after] = await db.select().from(tasks);
  assert.equal(after!.projectId, project!.id, 'the task did not join the project');

  /* The point of the report: it must be IN the project, the way "add existing
     task" puts it there — not noted beside it as a related item. */
  const edges = await db.select().from(itemLinks);
  assert.equal(edges.length, 0, 'attaching also wrote a semantic edge');

  await attachStructural(db, workspaceId, {
    sourceType: 'task', sourceId: task!.id, targetType: 'area', targetId: area!.id,
  });
  const [after2] = await db.select().from(tasks);
  assert.equal(after2!.areaId, area!.id, 'the task did not move area');
});

test('structural: a pair with no real relationship is refused, not faked', async () => {
  const { db, workspaceId } = await ws();
  const [a] = await db.insert(tasks).values({ workspaceId, title: 'A' }).returning();
  const [b] = await db.insert(tasks).values({ workspaceId, title: 'B' }).returning();
  await assert.rejects(
    () => attachStructural(db, workspaceId, {
      sourceType: 'task', sourceId: a!.id, targetType: 'task', targetId: b!.id,
    }),
    /not related structurally/,
    'two tasks were "attached" to each other',
  );
});

/* ══ Browsing ════════════════════════════════════════════════════════════ */

test('browse: a book is walked into, and its pages come back in order', async () => {
  const { db, workspaceId } = await ws();
  const [item] = await db.insert(libraryItems)
    .values({ workspaceId, type: 'book', title: 'The house' }).returning();
  const [book] = await db.insert(libraryBooks)
    .values({ workspaceId, libraryItemId: item!.id }).returning();
  const [sec] = await db.insert(bookSections)
    .values({ workspaceId, bookId: book!.id, title: 'Plumbing', position: 0 }).returning();
  await db.insert(bookPages).values([
    { workspaceId, sectionId: sec!.id, title: 'The geyser', position: 1 },
    { workspaceId, sectionId: sec!.id, title: 'Stopcock', position: 0 },
  ]);

  /* Without a parent a page browse returns NOTHING rather than every page in
     the workspace. A page has no meaning without its book, and a flat list of
     every page you own is the search box again wearing a different hat. */
  const flat = await browseLinkable(db, workspaceId, 'book_page');
  assert.equal(flat.results.length, 0, 'pages were listed without a book');

  const pages = await browseLinkable(db, workspaceId, 'book_page', { parentId: book!.id });
  assert.deepEqual(pages.results.map((p) => p.title), ['Stopcock', 'The geyser'],
    'pages are not in the order the book puts them in');

  /* And the row you walk into has to say so, and has to carry the BOOK's id —
     pages hang off sections which hang off the book, so the library item's id
     reaches nothing. */
  const lib = await browseLinkable(db, workspaceId, 'library');
  const row = lib.results.find((r) => r.id === item!.id)!;
  assert.equal(row.subtype, 'book', 'a book does not say it is a book');
  assert.equal(row.intoId, book!.id, 'the row cannot be walked into');
});

test('browse: the endpoint exists and is separate from writing an edge', () => {
  assert.match(linksRoute, /links\/browse/, 'there is no browse endpoint');
  assert.match(linksRoute, /links\/attach/, 'there is no structural attach endpoint');
  /* POST /links stays semantic-only. A single endpoint that sometimes wrote an
     edge and sometimes a foreign key would be the ambiguity the doctrine
     forbids, wearing a different hat. */
  const post = linksRoute.slice(linksRoute.indexOf('app.post(`${base}/links`'),
    linksRoute.indexOf('app.delete'));
  assert.ok(post.length > 0, 'POST /links has moved');
  assert.ok(!/attachStructural/.test(post), 'POST /links now writes foreign keys too');
});

/* ══ The picker ══════════════════════════════════════════════════════════ */

test('picker: you pick a place before you pick a thing', () => {
  assert.match(related, /const PLACES = \[/, 'there is no place chooser');
  for (const p of ['task', 'event', 'project', 'library', 'diary', 'habit', 'area']) {
    assert.match(related, new RegExp(`id: '${p}'`), `${p} is not somewhere you can look`);
  }
  // Search stays, for when you already know the name.
  assert.match(related, /searchLinkable\(term/, 'the search box stopped working');
  assert.match(related, /browseLinkable\(type, view\.parent\)/, 'nothing browses');
  assert.match(css, /\.rel-places-grid\{/, 'the place chooser has no styling');
  assert.match(css, /\.rel-crumbs\{/, 'there is no way to see where you are');
});

test('picker: a Book is opened by a control of its own, not by the row', () => {
  /* "Link me to this book" and "show me its pages" are different answers, and
     one target cannot mean both. */
  assert.match(related, /data-into="\$\{esc\(r\.intoId\)\}"/, 'a book cannot be walked into');
  assert.match(related, /r\.subtype === 'book' && r\.intoId/,
    'anything in the library claims to have an inside');
  assert.match(css, /\.rel-pick-into\{/, 'the walk-in control has no styling');
});

test('picker: choosing a row says what will happen before it happens', () => {
  /* It used to link the instant you clicked, with whatever kind happened to be
     in the select. One more click, in exchange for the app never doing
     something other than what it said. */
  assert.match(related, /view\.chosen = \{/, 'a row still links immediately');
  assert.match(related, /data-rel-go/, 'there is nothing to confirm with');
  assert.match(related, /const st = structuralFor\(view\.chosen\.type\)/,
    'the footer does not know whether the pair is structural');
  assert.match(related, /await attachStructural\(\{/, 'the picker cannot attach structurally');
  // And the escape hatch, for a task that references a project it is not in.
  assert.match(related, /or just note a relationship/, 'the semantic option is gone');
  assert.match(css, /\.rel-pick-foot\{/, 'the footer has no styling');
});

/* ══ The guard this session earned ═══════════════════════════════════════ */

test('modules: every named import actually exists on the other side', async () => {
  /* Rewriting the picker deleted two unrelated exports that happened to sit
     next to it. `node --check` passed, the suite passed, and the app was
     completely dead — a bare white page — because an ES module that imports a
     name the other side does not export throws at LOAD time and takes the whole
     entry point with it.
     Nothing in a source-reading test can catch that. Actually importing can. */
  const { pathToFileURL } = await import('node:url');
  const web = (f: string) => pathToFileURL(join(process.cwd(), '..', 'web', f)).href;
  const app = readFileSync(join('..', 'web', 'app.js'), 'utf8');

  /* Every `import { a, b } from './x.js'` in app.js, which is the entry point
     and therefore the file whose failure is total. */
  const imports = [...app.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([\w-]+\.js)'/g)];
  assert.ok(imports.length > 5, 'app.js has stopped importing anything, which cannot be right');

  const wanted = new Map<string, Set<string>>();
  for (const m of imports) {
    const names = m[1]!.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
    if (!wanted.has(m[2]!)) wanted.set(m[2]!, new Set());
    for (const n of names) wanted.get(m[2]!)!.add(n);
  }

  for (const [file, names] of wanted) {
    let mod: Record<string, unknown>;
    try {
      mod = await import(web(file)) as Record<string, unknown>;
    } catch (e) {
      /* A module that needs a DOM at import time cannot be checked this way,
         and that is fine — the ones that can be, are. */
      if (/document|window|navigator|localStorage/.test(String(e))) continue;
      throw new Error(`app.js imports './${file}', which will not load: ${String(e)}`);
    }
    for (const n of names) {
      assert.ok(n in mod, `app.js imports { ${n} } from './${file}', which does not export it`);
    }
  }
});
