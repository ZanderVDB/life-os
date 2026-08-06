/**
 * Library client (Phase F2).
 *
 * Two kinds of test, deliberately separated.
 *
 * BEHAVIOURAL — the save coordinator, the routing and the filtering are
 * imported and RUN. Those are the rules with teeth: a stale response marking
 * newer text saved, or a deep link opening the wrong page, are the failures
 * that cost somebody their writing.
 *
 * SOURCE — the audited geometry and the "no fake buttons" rule are asserted
 * against the files. Those prove a decision is still written down. The
 * geometry's real proof is the browser measurements in the phase report; this
 * is the tripwire for someone rounding 58px to 56px a year from now.
 *
 * `editor-doc.js` uses the DOM, so its round-trip is verified in a real
 * browser rather than faked here — a fake DOM would only prove the fake works.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');

const html = read('index.html');
const app = read('app.js');
const routes = read('routes.js');
const bookJs = read('library-book.js');
const overviewJs = read('library-overview.js');
const viewJs = read('library-view.js');
const saveJs = read('library-save.js');
const docJs = read('editor-doc.js');
const audit = readFileSync(join('..', 'docs', 'library-v2-legacy-book-audit.md'), 'utf8');

/** Comments are documentation, not contract — strip them before asserting. */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const viewCode = code(viewJs);
const bookCode = code(bookJs);
const saveCode = code(saveJs);

/* ══ Routing (§4) ══════════════════════════════════════════════════════ */

const view = await import('../../web/library-view.js' as string);

test('#library routes: shelf, item, book, and a book at a page', () => {
  assert.deepEqual(view.parseLibraryHash('#library'), { view: 'overview' });
  assert.deepEqual(view.parseLibraryHash('#library/item/abc'), { view: 'item', id: 'abc' });
  assert.deepEqual(view.parseLibraryHash('#library/book/b1'),
    { view: 'book', bookId: 'b1', sectionId: null, pageId: null });
  assert.deepEqual(view.parseLibraryHash('#library/book/b1?s=s9&p=p4'),
    { view: 'book', bookId: 'b1', sectionId: 's9', pageId: 'p4' });
});

test('a hash for another route is not a Library route', () => {
  assert.equal(view.parseLibraryHash('#projects/x'), null);
  assert.equal(view.parseLibraryHash('#today'), null);
});

test('a deep link carries IDs, never page numbers', () => {
  // Page numbers shift the moment a page is inserted in front. A link that
  // opens the wrong page is worse than one that does not open at all.
  assert.match(viewCode, /sectionId: q\.get\('s'\)/);
  assert.match(viewCode, /pageId: q\.get\('p'\)/);
  assert.doesNotMatch(viewCode, /pageNumber|spreadIdx.*fromHash/);
});

/* ══ The save coordinator (§16, §17) ═══════════════════════════════════ */

const api = await import('../../web/library-api.js' as string);
const save = await import('../../web/library-save.js' as string);

/** A fake transport: every request is resolved by hand, in whatever order. */
function transport() {
  const calls: any[] = [];
  const pending: Array<(v: any) => void> = [];
  const rejecters: Array<(e: any) => void> = [];
  api.initLibraryApi((path: string, opts: any) => {
    calls.push({ path, body: opts?.body });
    return new Promise((resolve, reject) => { pending.push(resolve); rejecters.push(reject); });
  });
  return {
    calls,
    resolve: (i: number, page: any) => pending[i]!({ page }),
    reject: (i: number, message: string) => rejecters[i]!(Object.assign(new Error(message), {})),
    count: () => pending.length,
  };
}

const doc = (text: string) =>
  ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

test('a response for a version already moved past cannot declare newer text saved', async () => {
  save.forgetAll();
  const t = transport();
  const page = { id: 'p1', content: doc('one'), updatedAt: 'v1' };
  save.trackPage(page);

  save.queueSave(page, doc('two'));
  const first = save.flush('p1');
  await Promise.resolve();

  // While that is in flight the user types again.
  save.queueSave(page, doc('three'));
  assert.equal(save.statusOf('p1'), 'unsaved');

  t.resolve(0, { id: 'p1', content: doc('two'), updatedAt: 'v2' });
  await first;

  // "three" is still unsaved. The slow answer about "two" must not claim it.
  assert.equal(save.statusOf('p1'), 'unsaved',
    'a response for an older version marked newer content saved');
});

test('every write carries the last confirmed version token', async () => {
  save.forgetAll();
  const t = transport();
  const page = { id: 'p2', content: doc('a'), updatedAt: 'v1' };
  save.trackPage(page);

  save.queueSave(page, doc('b'));
  const run = save.flush('p2');
  await Promise.resolve();
  assert.equal(t.calls[0].body.expectedUpdatedAt, 'v1');
  t.resolve(0, { id: 'p2', content: doc('b'), updatedAt: 'v2' });
  await run;

  save.queueSave(page, doc('c'));
  const run2 = save.flush('p2');
  await Promise.resolve();
  assert.equal(t.calls[1].body.expectedUpdatedAt, 'v2',
    'the second write did not carry the version the server confirmed');
  t.resolve(1, { id: 'p2', content: doc('c'), updatedAt: 'v3' });
  await run2;
  assert.equal(save.statusOf('p2'), 'saved');
});

test('a failed write keeps the typed content and can be retried', async () => {
  save.forgetAll();
  const t = transport();
  const page = { id: 'p3', content: doc('kept'), updatedAt: 'v1' };
  save.trackPage(page);

  save.queueSave(page, doc('typed while offline'));
  const run = save.flush('p3');
  await Promise.resolve();
  t.reject(0, 'Network request failed');
  await run;

  assert.equal(save.statusOf('p3'), 'failed');
  assert.equal(save.hasUnsaved(), true, 'a failure must still count as unsaved work');

  const again = save.retry('p3');
  await Promise.resolve();
  // The SAME content is sent again. Nothing is discarded because a request lost.
  assert.deepEqual(t.calls[1].body.content, doc('typed while offline'));
  t.resolve(1, { id: 'p3', content: doc('typed while offline'), updatedAt: 'v2' });
  await again;
  assert.equal(save.statusOf('p3'), 'saved');
});

test('a 409 stops writing and asks, rather than overwriting', async () => {
  save.forgetAll();
  const t = transport();
  const page = { id: 'p4', content: doc('mine'), updatedAt: 'v1' };
  save.trackPage(page);

  save.queueSave(page, doc('my newer text'));
  const run = save.flush('p4');
  await Promise.resolve();
  t.reject(0, 'This page changed somewhere else. Reopen it to see the newer version.');
  await run;

  assert.equal(save.statusOf('p4'), 'conflict');
  // Nothing more is sent until the person chooses.
  save.queueSave(page, doc('and more'));
  await save.flush('p4');
  assert.equal(t.count(), 1, 'a conflicted page kept writing');
});

test('typing back to what the server has is Saved again, not Unsaved forever', async () => {
  save.forgetAll();
  transport();
  const page = { id: 'p5', content: doc('home'), updatedAt: 'v1' };
  save.trackPage(page);
  save.queueSave(page, doc('changed'));
  assert.equal(save.statusOf('p5'), 'unsaved');
  save.queueSave(page, doc('home'));      // undo, all the way back
  assert.equal(save.statusOf('p5'), 'saved');
});

test('taking the newer version hands the local text back to the caller', async () => {
  save.forgetAll();
  transport();
  const page = { id: 'p6', content: doc('base'), updatedAt: 'v1' };
  save.trackPage(page);
  save.queueSave(page, doc('what I wrote'));
  const mine = save.resolveTakeTheirs('p6', { content: doc('theirs'), updatedAt: 'v9' });
  assert.deepEqual(mine, doc('what I wrote'),
    'the local text was dropped instead of returned for the clipboard');
  assert.equal(save.statusOf('p6'), 'saved');
});

/* ══ The shelf (§5–§9) ═════════════════════════════════════════════════ */

const overview = await import('../../web/library-overview.js' as string);

const item = (over: any) => ({
  id: over.id ?? 'i', type: 'document', title: 'T', description: null, sourceUrl: null,
  archivedAt: null, updatedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

test('archived items are hidden until they are asked for', () => {
  api.lib.items = [item({ id: 'a' }), item({ id: 'b', archivedAt: '2026-08-02T00:00:00.000Z' })];
  api.lib.filter = 'all'; api.lib.query = ''; api.lib.showArchived = false;
  assert.deepEqual(overview.visibleItems().map((i: any) => i.id), ['a']);
  api.lib.showArchived = true;
  assert.deepEqual(overview.visibleItems().map((i: any) => i.id), ['a', 'b']);
  api.lib.showArchived = false;
});

test('the type filter and the search narrow together', () => {
  api.lib.items = [
    item({ id: 'bk', type: 'book', title: 'Field Notes' }),
    item({ id: 'dc', type: 'document', title: 'Field guide' }),
    item({ id: 'ln', type: 'link', title: 'Something else' }),
  ];
  api.lib.filter = 'all'; api.lib.query = 'field';
  assert.deepEqual(overview.visibleItems().map((i: any) => i.id), ['bk', 'dc']);
  api.lib.filter = 'book';
  assert.deepEqual(overview.visibleItems().map((i: any) => i.id), ['bk']);
  api.lib.filter = 'all'; api.lib.query = '';
});

test('search matches the description and the address, not only the title', () => {
  api.lib.items = [
    item({ id: 'd', description: 'about emphasis by de-emphasis' }),
    item({ id: 'u', type: 'link', sourceUrl: 'https://refactoringui.test/x' }),
    item({ id: 'n' }),
  ];
  api.lib.filter = 'all';
  api.lib.query = 'emphasis';
  assert.deepEqual(overview.visibleItems().map((i: any) => i.id), ['d']);
  api.lib.query = 'refactoringui';
  assert.deepEqual(overview.visibleItems().map((i: any) => i.id), ['u']);
  api.lib.query = '';
});

test('only the three types with a complete endpoint can be created', () => {
  // Upload Image / Video / File are ABSENT, not disabled. A greyed-out control
  // still claims the feature exists; an absent one says nothing and is honest.
  assert.deepEqual(overview.CREATABLE.map((c: any) => c.type), ['book', 'document', 'link']);
  assert.doesNotMatch(code(overviewJs), /data-new="(image|video|file)"/);
  assert.doesNotMatch(code(overviewJs), /disabled[^>]*data-new/);
});

/* ══ The spread (§11, §12, §20) ════════════════════════════════════════ */

test('the odd final page faces a blank that is not a database row', () => {
  api.lib.book = { sections: [{ id: 's', accent: 'peach', pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] }] };
  api.lib.sectionIdx = 0;
  api.lib.spreadIdx = 1;
  const { left, right } = api.currentSpread();
  assert.equal(left.id, 'p3');
  assert.equal(right, null, 'a row was invented to fill a layout');
  assert.equal(api.spreadCount(api.currentSection()), 2);
  // And nothing in the client creates a page to pair one up.
  assert.doesNotMatch(viewCode, /createPages\([^)]*\)\s*;?\s*\/\/\s*pad/i);
  api.lib.book = null;
});

test('an empty section still counts as one spread, so a book is never blank', () => {
  assert.equal(api.spreadCount({ pages: [] }), 1);
  assert.equal(api.spreadCount(null), 1);
});

/* ══ The audited geometry (§2, §11) ════════════════════════════════════ */

test('the Book carries the audited geometry verbatim', () => {
  // Each of these appears in library-v2-legacy-book-audit.md, which was read
  // from the Legacy source. Changing one here means changing the book.
  for (const rule of [
    'aspect-ratio:210/297',
    'aspect-ratio:420/297',
    'max-width:780px',
    'max-width:1320px',
    'gap:6px',
    'padding:28px 32px 18px 58px',
    'border-radius:14px',
    'border-radius:20px 20px 4px 4px',
  ]) {
    assert.ok(html.includes(rule), `the audited rule "${rule}" is gone from the Book`);
  }
});

test('the margin stripe and the mirrored coloured edge survive', () => {
  assert.match(html, /\.bk-page::before\{[^}]*left:46px/);
  assert.match(html, /\.bk-page-right::before\{[^}]*right:46px/);
  assert.match(html, /inset 3px 0 0 0 var\(--accent-c/);
  assert.match(html, /inset -3px 0 0 0 var\(--accent-c/);
});

test('the ruled-line cycle equals the line-height, and scrolls with the text', () => {
  // The audit records why this lives on the text element and not the page: on
  // the page the rules drift the moment a heading sits above them.
  assert.match(html, /transparent 29px,var\(--paper-line\) 29px,var\(--paper-line\) 30px/);
  assert.match(html, /\.bk-editor\{[^}]*line-height:30px/);
  assert.match(html, /background-attachment:local/);
  // Every block is a whole number of rules, or text floats between the lines.
  // F2.1 moved this from a list of selectors to `.bk-editor > *`, which also
  // zeroes the browser defaults — see library-f21.test.ts for the full model.
  assert.match(html, /\.bk-editor > \*\{[^}]*line-height:30px/);
  assert.match(html, /\.bk-editor p,\.bk-editor li,\.bk-editor blockquote p\{[^}]*line-height:30px/);
});

test('the six section colours are all present', () => {
  for (const c of ['peach', 'sage', 'lavender', 'gold', 'blue', 'rose']) {
    assert.ok(html.includes(`--a-${c}:`), `the ${c} accent is missing`);
    assert.ok(audit.includes(c), `${c} is not one of the audited colours`);
  }
  assert.deepEqual((bookJs.match(/export const ACCENTS = \[([^\]]+)\]/)?.[1] ?? '')
    .split(',').map((s) => s.trim().replace(/'/g, '')),
  ['peach', 'sage', 'lavender', 'gold', 'blue', 'rose']);
});

test('the page turn is the audited timing, with no 3D curl', () => {
  assert.match(html, /translateX\(-14%\)/);
  assert.match(html, /translateX\(14%\)/);
  assert.match(html, /\.26s cubic-bezier\(\.4,0,\.2,1\)/);
  assert.doesNotMatch(html, /\.bk-book[^{]*\{[^}]*rotateY/);
});

/* ══ Editing rules (§13, §14, §15, §16) ════════════════════════════════ */

test('the client never drops a node it does not recognise', () => {
  // The server drops unknown nodes, correctly — it must not store what it
  // cannot describe. The client round-trips, so doing the same here would let
  // an older tab silently delete content a newer one wrote.
  assert.match(code(docJs), /bk-unknown/);
  assert.match(code(docJs), /data-unknown="\$\{esc\(\s*JSON\.stringify\(node\)\)\}/);
  assert.match(code(docJs), /JSON\.parse\(el\.dataset\.unknown\)/);
  assert.match(code(docJs), /contenteditable="false"/);
});

test('the editor element is never replaced while it is being typed into', () => {
  // Legacy re-rendered the whole notebook with innerHTML on every change, which
  // destroyed the caret, the selection and the undo history on every keystroke.
  const input = bookCode.slice(bookCode.indexOf("el.addEventListener('input'"));
  const handler = input.slice(0, input.indexOf('});'));
  assert.doesNotMatch(handler, /innerHTML/);
  assert.doesNotMatch(handler, /paintBookBody|spreadHtml/);
  assert.match(handler, /queueSave/);
});

test('the save baseline is captured before anything is typed', () => {
  // Capturing it lazily on the first keystroke captured the user's own typing
  // as "what the server has", so nothing ever looked unsaved and no write was
  // ever queued. The status said Saved while the words went nowhere.
  assert.match(bookCode, /trackPage\(mounted\)/);
  const input = bookCode.slice(bookCode.indexOf("el.addEventListener('input'"));
  const handler = input.slice(0, input.indexOf('});'));
  assert.ok(handler.indexOf('queueSave') < handler.indexOf('page.content = doc'),
    'the local copy is updated before the save is queued, which makes the '
    + 'unchanged-content check compare the new text against itself');
});

test('anything that takes the editor away flushes first', () => {
  const nav = viewCode.slice(viewCode.indexOf('async function navigate'));
  assert.match(nav.slice(0, 600), /await flushAll\(\)/);
  assert.match(viewCode, /export async function libraryWillLeave[\s\S]{0,200}await flushAll\(\)/);
  assert.match(code(app), /if \(state\.route === 'library'\) await libraryWillLeave\(\)/);
});

test('the toolbar stays restrained', () => {
  const from = bookJs.indexOf('export function toolbarHtml');
  const end = bookJs.indexOf('/* ══ Mounting', from);
  const bar = bookJs.slice(from, end > -1 ? end : undefined);
  // The buttons come from a `b('cmd', …)` helper, so read the calls, not the
  // template literal they all share.
  const cmds = [...bar.matchAll(/\bb\('([a-zA-Z]+)',/g)].map((m) => m[1]);
  assert.deepEqual(new Set(cmds), new Set([
    'bold', 'italic', 'underline', 'strikeThrough',
    'insertUnorderedList', 'insertOrderedList', 'link', 'undo', 'redo',
  ]));
  // Plus the one block-style control, and nothing else that carries a command.
  assert.deepEqual([...bar.matchAll(/data-cmd="([a-z]+)"/g)].map((m) => m[1]), ['style']);
  // No colours, no fonts, no sizes. A ribbon in a book is a word processor
  // wearing a book's clothes, and Legacy's font-colour wrappers are exactly
  // how text ended up invisible on a dark theme.
  assert.doesNotMatch(bar, /foreColor|backColor|fontName|fontSize/);
});

test('paste is taken as plain text', () => {
  // Whatever was copied is usually a whole styled document. Taking the text and
  // letting the grammar re-block it is the only way to be sure nothing enters
  // that the document model cannot describe.
  assert.match(bookCode, /clipboardData\?\.getData\('text\/plain'\)/);
});

/* ══ Honesty rules (§10, §24, §35) ═════════════════════════════════════ */

test('Library is a real route, not a placeholder', () => {
  assert.doesNotMatch(routes, /id: 'library'[^}]*placeholder/);
  assert.doesNotMatch(routes, /^\s*library: \{/m);
  assert.match(code(app), /if \(state\.route === 'library'\) return renderLibrary\(nav\)/);
});

test('no native dialogs anywhere in Library', () => {
  for (const [name, src] of Object.entries({
    view: viewCode, book: bookCode, overview: code(overviewJs), modal: code(read('library-modal.js')),
  })) {
    assert.doesNotMatch(src, /\bwindow\.(confirm|prompt|alert)\b/, `${name} uses a native dialog`);
    assert.doesNotMatch(src, /(^|[^.\w])(confirm|alert|prompt)\(/m, `${name} uses a native dialog`);
  }
});

test('sample data is a console hook, and the server is the real guard', () => {
  assert.match(viewCode, /window\.__sampleLibrary/);
  assert.doesNotMatch(code(overviewJs), /sample/i);
  const sample = readFileSync(join('src', 'lib', 'sample-library.ts'), 'utf8');
  assert.match(sample, /isLibrarySampleAllowed/);
  const route = readFileSync(join('src', 'routes', 'library.ts'), 'utf8');
  assert.match(route, /Sample data is not available in production/);
});

test('archive is reversible, so it offers Undo rather than a confirmation', () => {
  const act = viewCode.slice(viewCode.indexOf("if (act === 'archive')"));
  assert.match(act.slice(0, 600), /label: 'Undo'/);
  assert.match(act.slice(0, 600), /restoreItem/);
});

test('Library uses its width for Library', () => {
  // An empty contextual rail is worse than no rail, and the rail's grid track
  // has to collapse too or the column keeps its 320px.
  assert.match(html, /body:has\(\.lib-page\) \.main-wrap\{grid-template-columns:minmax\(0,1fr\) 0\}/);
  assert.match(html, /body:has\(\.lib-page\) \.rail\{display:none\}/);
});

/* ══ Motion and reach (§26, §27, §29) ══════════════════════════════════ */

test('reduced motion swaps the spread instantly instead of freezing mid-flip', () => {
  const turn = viewCode.slice(viewCode.indexOf('async function turn'));
  assert.match(turn.slice(0, 400), /reducedMotion\(\)/);
  assert.match(turn.slice(0, 400), /paintBookBody/);
});

test('the page turn cannot get stuck waiting for an event that never comes', () => {
  // animationend does not arrive if the element is removed or the tab is
  // backgrounded, and a turn that never finishes leaves the book mid-flip.
  const fn = viewCode.slice(viewCode.indexOf('function afterAnimation'));
  assert.match(fn.slice(0, 400), /setTimeout\(finish, ms \+ 60\)/);
});

test('touch targets stay at 44px where a finger has to reach them', () => {
  assert.match(html, /\.bk-arrow\{[^}]*width:44px;height:44px/);
  assert.match(html, /@media \(min-width:900px\)\{\.bk-arrow\{width:48px;height:48px\}\}/);
});

test('nothing in Library scrolls the page sideways', () => {
  // The tabs are the one thing allowed to scroll, and they scroll themselves.
  assert.match(html, /\.bk-tabs\{[^}]*flex-wrap:nowrap;overflow-x:auto/);
  /* `:not(.dia-book)` since D2: the Diary reuses `.bk-spread` for its own
   * two pages, and STACKS them on a phone rather than paginating. Without
   * the exclusion this rule hid the diary's entire right page. */
  assert.match(html, /\.bk-book\.bk-spread:not\(\.dia-book\)\{aspect-ratio:210\/297/);
});

test('the editor is reachable and announced', () => {
  assert.match(bookJs, /role="textbox"/);
  assert.match(bookJs, /aria-multiline="true"/);
  assert.match(bookJs, /aria-label="Page content"/);
  assert.match(bookJs, /role="tablist"/);
  assert.match(bookJs, /aria-selected="\$\{i === lib\.sectionIdx\}"/);
  assert.match(bookJs, /role="status"/);
});

test('every archive endpoint the API exposes is reachable from the interface', () => {
  // The reverse of a fake button: an endpoint with real guards and no control
  // leaves the Book unmanageable. Items, sections and pages all have one.
  assert.match(viewCode, /archiveItem\(/);
  assert.match(viewCode, /archiveSection\(section\.id\)/);
  assert.match(viewCode, /archivePage\(page\.id\)/);
  assert.match(bookCode, /data-section-more=/);
  assert.match(bookCode, /data-page-more=/);
});

test('the last section and the last page state the reason instead of erroring', () => {
  // The API refuses both. A control that fails when pressed teaches nothing;
  // saying so up front is the same information delivered usefully.
  assert.match(viewCode, /The only section cannot be archived\. Archive the book instead\./);
  assert.match(viewCode, /The only page of a section cannot be archived\./);
  const sec = viewCode.slice(viewCode.indexOf('function openSectionMenu'));
  assert.match(sec.slice(0, 900), /lib\.book\.sections\.length === 1/);
  const pg = viewCode.slice(viewCode.indexOf('function openPageMenu'));
  assert.match(pg.slice(0, 700), /section\.pages\.length === 1/);
});

test('archiving a section re-reads the book rather than guessing what went', () => {
  // Archiving a section takes its pages with it. Splicing locally is how a
  // stale page id ends up being written to.
  const act = viewCode.slice(viewCode.indexOf("if (act === 'archive')",
    viewCode.indexOf('async function sectionAction')));
  assert.match(act.slice(0, 700), /await loadBook\(lib\.bookId\)/);
  assert.match(act.slice(0, 700), /forgetAll\(\)/);
});

test('archiving a page cancels any pending write to it', () => {
  const act = viewCode.slice(viewCode.indexOf('async function pageAction'));
  assert.match(act.slice(0, 700), /forgetPage\(page\.id\)/);
  assert.match(act.slice(0, 900), /label: 'Undo'/);
});

test('the forward arrow is disabled only when there is genuinely nowhere to go', () => {
  // And the back arrow never is: on the first page, back is the cover.
  assert.match(bookCode, /id="bk-next" \$\{canGoNext\(\) \? '' : 'disabled'\}/);
  assert.doesNotMatch(bookCode, /id="bk-prev"[^>]*disabled/);
});
