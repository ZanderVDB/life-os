/**
 * Phase L3 — the Library shelf.
 *
 * The rule the whole phase rests on, and the one these tests exist to keep:
 *
 *     A SHELF IS A SCROLLABLE COLLECTION. IT IS NOT A CAROUSEL.
 *
 * Most of what follows therefore checks for the ABSENCE of carousel machinery
 * as much as the presence of shelf machinery — no auto-rotation, no looping, no
 * arrow-only path, no single centred item with the rest hidden. Those are easy
 * to add later by accident, one convenience at a time, and each one alone looks
 * reasonable.
 *
 * Browser measurements that motivated a number are quoted beside it. A spatial
 * phase drifts back fastest when the reason for a magic number is not written
 * down next to the number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { SAMPLE_PREFIX, isLibrarySampleAllowed } from '../src/lib/sample-library.js';

/* ── SUPERSEDED BY L3.4 ───────────────────────────────────────────────────
 *
 * The tests removed from this file asserted the FLAT Book: a spine strip laid
 * beside a cover, depth drawn rather than rotated, and an explicit ban on any
 * transform that was not a translation. That model was replaced in L3.4 by an
 * authenticated visual decision -- the Book is now a solid that turns -- so
 * those assertions describe a design that no longer exists, and keeping them
 * would only record that we once did it differently.
 *
 * Nothing they protected was dropped. Every property that survives the change
 * -- one baseline, no scale in any committed state, hover strictly weaker than
 * a pull, neighbours that do not reflow the rail, the Diary having no Library
 * identity, resources never being given a spine, and the accessible names --
 * is re-asserted against the new model in `library-l34-final.test.ts`.
 */

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
  const base = `/api/v1/workspaces/${me.workspace.id}`;
  return {
    app,
    post: (url: string, payload?: any) =>
      app.inject({ method: 'POST', url: base + url, headers: auth(), payload: payload ?? {} }),
    get: (url: string) => app.inject({ method: 'GET', url: base + url, headers: auth() }),
  };
}

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
/** Source with comments removed — prose near a rule is not the rule. */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const html = read('index.html');
const shelf = code(read('library-shelf.js'));
const overview = code(read('library-overview.js'));
const view = code(read('library-view.js'));
const appjs = code(read('app.js'));

/* ── §7  Shelf, not carousel ─────────────────────────────────────────── */

test('shelf: the rail is an ordinary scroller, and works before the script does', () => {
  /* The single most important property of this design. Everything the module
   * adds — prominence, keys, arrows — is an enhancement of an element that
   * already scrolls, so a failure in any of it degrades to a plain scroller
   * rather than to a shelf that cannot be moved. */
  /* `scroll`, not `auto`, since L3.2: a horizontal scrollbar lives inside the
   * rail's border box, so a shelf that overflows loses 10px that one which
   * fits does not -- and the ledge is drawn from that edge. Reserving it on
   * every rail is what makes one baseline formula true for every shelf. */
  assert.match(html, /\.lib-rail\{[^}]*overflow-x:scroll/,
    'the rail is not a native horizontal scroller');
  assert.match(html, /\.lib-rail\{[^}]*scroll-snap-type:x proximity/,
    'snap must be proximity — mandatory snap fights trackpad momentum (§22)');
  assert.ok(!/scroll-snap-type:\s*x\s+mandatory/.test(html),
    'mandatory snap forces every scroll to land on one object (§22)');
});

test('shelf: no carousel machinery anywhere', () => {
  const src = `${shelf}\n${overview}\n${view}`;
  for (const banned of ['setInterval', 'autoplay', 'autoRotate', 'infinite', 'carousel']) {
    assert.ok(!src.includes(banned), `the shelf has ${banned} in it`);
  }
  /* Looping is the specific failure §7 names: an arrow that wraps a shelf
   * around turns browsing into a ride you cannot get off. `syncSteps` DISABLES
   * at each end instead. */
  assert.match(shelf, /prev\.disabled = rail\.scrollLeft <= 1/);
  assert.match(shelf, /next\.disabled = rail\.scrollLeft >= max - 1/);
});

test('shelf: arrows are secondary — hidden when useless, never a tab stop', () => {
  assert.match(html, /\.lib-shelf-nav\{[^}]*display:none/,
    'arrows are shown by default rather than only when the shelf overflows');
  assert.match(html, /\.lib-shelf-nav\.is-live\{display:flex\}/);
  assert.match(shelf, /nav\.classList\.toggle\('is-live', max > 1\)/);
  // Not reachable by keyboard: the keyboard already has a better route.
  assert.match(shelf, /class="lib-shelf-nav" aria-hidden="true"/);
  assert.match(shelf, /class="lib-step" data-shelf-step="-1" tabindex="-1"/);
  assert.match(shelf, /class="lib-step" data-shelf-step="1" tabindex="-1"/);
  // And they are hidden entirely on touch, where there is no pointer to aim.
  assert.match(html, /@media \(max-width:820px\)[\s\S]*?\.lib-shelf-nav\{display:none !important\}/);
});

/* ── §21  Scrolling that cannot become a trap ────────────────────────── */

test('wheel: releases at the ends, and latches out during a fast page scroll', () => {
  /* Both rules, or the pattern is scroll-jacking with extra steps.
   *
   * 1. At either end the event is NOT cancelled, so the page scrolls. This is
   *    what stops a shelf swallowing a page.
   * 2. After the page has started moving past a shelf, that shelf refuses to
   *    capture again until the wheel has been still. Without it, a fast flick
   *    down the page is caught by each shelf in turn. */
  assert.match(shelf, /const atEnd = dir > 0 \? rail\.scrollLeft >= max - 1 : rail\.scrollLeft <= 1;/);
  assert.match(shelf, /if \(atEnd\) \{ latchedOut = true; return; \}/);
  assert.match(shelf, /idle = setTimeout\(\(\) => \{ latchedOut = false; \}, LATCH_MS\);/);
  assert.match(shelf, /if \(latchedOut\) return;/);
  // Horizontal intent is never touched — a trackpad is already doing it right.
  assert.match(shelf, /if \(Math\.abs\(e\.deltaX\) > Math\.abs\(e\.deltaY\)\) return;/);
  // Browser zoom is not browsing.
  assert.match(shelf, /if \(e\.ctrlKey\) return;/);
  // deltaMode 1 is LINES and 2 is PAGES; using either as pixels is meaningless.
  assert.match(shelf, /e\.deltaMode === 1 \? 18 : e\.deltaMode === 2 \? rail\.clientWidth : 1/);
});

test('wheel: preventDefault only happens when the shelf can actually consume it', () => {
  /* The order matters: every early return sits ABOVE the preventDefault, so
   * there is no path that cancels a scroll and then declines to use it. */
  const fn = shelf.slice(shelf.indexOf('function wireWheel'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  const cancelAt = body.indexOf('e.preventDefault()');
  assert.ok(cancelAt > -1, 'the wheel handler never cancels');
  for (const guard of ['if (e.ctrlKey) return;', 'if (latchedOut) return;',
    'if (max <= 1) return;', 'if (atEnd)']) {
    assert.ok(body.indexOf(guard) > -1 && body.indexOf(guard) < cancelAt,
      `"${guard}" must be checked before the event is cancelled`);
  }
});

/* ── §23  Five states, five mechanisms ───────────────────────────────── */

/* L3 asserted a `prominent` state that the shelf gave to whatever object was
 * nearest a read line as it scrolled. L3.1 removed it outright: a shelf nobody
 * had touched had one book permanently raised, which reads as "this one is
 * chosen" when nothing had been chosen. These three tests now assert the model
 * that replaced it — explicit pull-forward — and, just as importantly, that
 * the old one has not crept back. */

test('prominence: the scroll-driven raised object is gone entirely', () => {
  /* Not merely unused — ABSENT. A dormant `setProminent` is one call site away
   * from the defect coming back, so the machinery is deleted rather than left
   * switched off. */
  for (const gone of ['setProminent', 'nearestIndex', 'is-prominent', 'lib-shelf-cap']) {
    assert.ok(!shelf.includes(gone), `${gone} still exists in the shelf module`);
    assert.ok(!view.includes(gone), `${gone} still exists in the view`);
  }
  assert.ok(!html.includes('is-prominent'), 'the prominent style rule is still in the stylesheet');
  // The shelf keeps a CURSOR instead: a keyboard position with no appearance.
  assert.match(shelf, /function setCursor\(rail, index/);
  const cursor = shelf.slice(shelf.indexOf('function setCursor'));
  const body = cursor.slice(0, cursor.indexOf('\n}'));
  assert.ok(!/classList/.test(body),
    'setCursor writes a class, which would give the cursor an appearance again');
});

test('pull-forward: one per page, and scrolling does not create one', () => {
  // ONE object across the whole page, not one per shelf.
  assert.match(shelf, /^let pulled = null;$/m);
  assert.match(shelf, /export function clearPulled/);
  assert.match(shelf, /export function pullForward/);
  // The scroll handler cannot pull anything; it can only put one back.
  const onScroll = shelf.slice(shelf.indexOf("rail.addEventListener('scroll'"));
  const body = onScroll.slice(0, onScroll.indexOf('}, { passive: true });'));
  assert.ok(!body.includes('pullForward'), 'scrolling pulls an object forward');
  assert.ok(body.includes('clearPulled'), 'scrolling never returns a pulled object');
});

/* ── §36  Keyboard and screen reader ─────────────────────────────────── */

test('keyboard: one tab stop per shelf, arrows within it', () => {
  /* Forty books must not be forty tab stops. Measured: 45 objects across six
   * shelves produced exactly 6 elements with tabindex="0". */
  assert.match(shelf, /o\.tabIndex = i === at \? 0 : -1;/);
  assert.match(shelf, /if \(e\.key === 'ArrowRight'\)/);
  assert.match(shelf, /if \(e\.key === 'ArrowLeft'\)/);
  assert.match(shelf, /if \(e\.key === 'Home'\)/);
  assert.match(shelf, /if \(e\.key === 'End'\)/);
  assert.match(shelf, /if \(e\.key === 'Enter' \|\| e\.key === ' '\)/);
});

test('motion: reduced motion removes travel, not information', () => {
  const block = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce){',
    html.indexOf('.lib-obj')));
  const reduced = block.slice(0, block.indexOf('\n}'));
  assert.match(reduced, /\.lib-obj,\.lib-obj:hover,\.lib-obj\.is-pulled,\.lib-res\.is-pulled\{transform:none\}/);
  /* Pulled forward survives as a RING when it cannot survive as movement, and
   * its Open control and label are unaffected — the state has to stay
   * distinguishable, which is the whole point. */
  assert.match(reduced, /\.lib-obj\.is-pulled \.lib-cover\{box-shadow:0 0 0 2px/);
  assert.match(reduced, /\.lib-obj\.is-pulled \.lib-foot\{transform:none\}/);
  // And the return glow simply does not play.
  assert.match(shelf, /if \(prefersReduced\(\)\) return;\s*\n\s*obj\.classList\.add\('is-returned'\)/);
});

/* ── §8/§9  Covers and spines ────────────────────────────────────────── */


/* ── §10  The non-Book family ────────────────────────────────────────── */

test('previews: the fallback is the floor, and a dead URL cannot move anything', () => {
  /* §28. The fallback is DRAWN FIRST and the image sits on top of it, so an
   * image that fails leaves a frame rather than a hole. Measured against the
   * deliberately-broken sample row: after the load failed, the frame, the
   * object, the rail's scrollWidth and all nine siblings were unchanged to the
   * tenth of a pixel. */
  assert.match(shelf, /<span class="lib-frame-fallback" aria-hidden="true">/);
  assert.match(shelf, /onerror="this\.remove\(\)"/);
  assert.match(shelf, /loading="lazy"\s*\n?\s*decoding="async"/);
  // The frame's height is fixed, so nothing depends on the image arriving.
  assert.match(html, /\.lib-frame\{position:relative;display:block;width:100%;height:118px/);
});

test('formatters: sizes and durations never lie about their units', () => {
  assert.match(shelf, /return `\$\{\(mb \/ 1024\)\.toFixed\(1\)\} GB`/);
  // 1:15:17, never 75:17.
  assert.match(shelf, /return h \? `\$\{h\}:\$\{pad\(m\)\}:\$\{pad\(sec\)\}` : `\$\{m\}:\$\{pad\(sec\)\}`/);
});

/* ── §11/§25/§26  Composition ────────────────────────────────────────── */

test('composition: only shelves with something on them are drawn', () => {
  /* §11 — four empty category headings is a filing cabinet showing you its
   * dividers. Measured: filtering to Documents rendered exactly one shelf. */
  assert.match(overview, /if \(!own\.length && s\.id !== 'books'\) return '';/);
});

test('composition: a small collection is centred, and the rule is inert once it overflows', () => {
  /* §26. `justify-content` on a flex row does nothing until there is slack, so
   * one rule covers both cases and nothing has to be measured. Measured with
   * three books at 1280: is-full false, justify-content center, first slot at
   * x=509 in a rail starting at x=272. */
  assert.match(html, /\.lib-rail:not\(\.is-full\) \.lib-row\{justify-content:center\}/);
  assert.match(shelf, /rail\.classList\.toggle\('is-full', max > 1\)/);
});

test('composition: an empty Library shows one faint ledge, not a rack of nothing', () => {
  // §25 — a Library you have not filled should not show you the size of the gap.
  assert.match(overview, /class="lib-shelf lib-shelf-blank"/);
  assert.match(html, /\.lib-blank\{height:96px;opacity:\.5\}/);
  // And it never pretends the Diary is a shelf full of books.
  assert.ok(overview.indexOf('personalShelfHtml()') < overview.indexOf('lib-shelf-blank'),
    'the empty state should still show the personal ledge');
});

/* ── §12  Recently opened ────────────────────────────────────────────── */

test('recent: ordered by opening, and honest when it is guessing', () => {
  /* `updated_at` is an EDIT time. Using it to ORDER a recent list is a
   * reasonable fallback; using it to say "opened" is not, so each object says
   * which of the two it is showing. */
  assert.match(overview, /new Date\(b\.lastOpenedAt \?\? b\.updatedAt\) - new Date\(a\.lastOpenedAt \?\? a\.updatedAt\)/);
  assert.match(shelf, /return `\$\{opened \? 'Opened' : 'Edited'\} \$\{when\}`;/);
  // A recent shelf listing most of what you own is a second copy of the room.
  assert.match(overview, /if \(items\.length < 8\) return \[\];/);
  assert.match(overview, /\.slice\(0, 6\)/);
});

test('recent: the open mark is fire-and-forget and never bumps the edit time', async () => {
  const h = await setup();
  const item = (await h.post('/library/items',
    { type: 'document', title: 'Read me' })).json().item;
  assert.equal(item.lastOpenedAt, null, 'a new item has never been opened');

  await new Promise((r) => { setTimeout(r, 15); });
  const opened = await h.post(`/library/items/${item.id}/opened`);
  assert.equal(opened.statusCode, 200);
  assert.ok(opened.json().lastOpenedAt, 'the route did not report when it happened');

  const after = (await h.get(`/library/items/${item.id}`)).json().item;
  assert.ok(after.lastOpenedAt, 'the opening was not recorded');
  /* THE POINT. Reading is not editing. If opening moved `updated_at` then
   * "recently opened" and "recently changed" would collapse into one number
   * that answers neither question — which is exactly why the column exists. */
  assert.equal(after.updatedAt, item.updatedAt, 'opening a resource changed its edit time');
});

/* ── §16/§18  Coming back ────────────────────────────────────────────── */

test('return: the position is captured at the moment of leaving, not trusted to a listener', () => {
  /* A position remembered only by having observed every scroll event is wrong
   * whenever an event was missed — and events ARE missed when the page is not
   * rendering, which is exactly when a Book is taking over the screen. */
  assert.match(shelf, /export function captureShelfScroll/);
  assert.match(view, /captureShelfScroll\(obj\.closest\('#main-scroll'\) \?\? document\)/);
  assert.match(view, /export async function libraryWillLeave\(\) \{[\s\S]*?captureShelfScroll\(\);/);
  /* Every repaint too, so a filter change keeps its place (14). `clearPulled`
   * sits between them in L3.1: the pulled object is about to be destroyed with
   * the DOM it lives in, and a stale reference would make the next click on
   * that book open it instead of pulling it forward. */
  assert.match(view, /captureShelfScroll\(scroll\);[\s\S]{0,300}?scroll\.innerHTML = bodyHtml\(\);/);
  assert.match(view, /clearPulled\(\);\s*\n\s*scroll\.innerHTML = bodyHtml\(\);/);
});

test('return: the shelf is positioned before the book is re-identified', () => {
  /* Otherwise the highlight lands and then the shelf moves under it. */
  const paint = view.slice(view.indexOf('function paintOverview'));
  const body = paint.slice(0, paint.indexOf('\n}'));
  assert.ok(body.indexOf('restoreShelfScroll') < body.indexOf('markReturn'),
    'the scroll must be restored before the returned object is marked');
  // Restored by assignment: a smooth scroll from 0 would animate the very
  // thing the restoration exists to avoid noticing.
  assert.match(shelf, /if \(at\) rail\.scrollLeft = at;/);
});

test('return: an object on two shelves is re-identified on the one you left', () => {
  /* The same Book is on Books and on Recently opened. Marking whichever comes
   * first in the document lights up a shelf you were not on. */
  assert.match(shelf, /export function markReturn\(root = document, itemId, shelfId = null\)/);
  assert.match(shelf, /shelfId && root\.querySelector\(`\[data-rail="\$\{CSS\.escape\(shelfId\)\}"\] \$\{sel\}`\)/);
  assert.match(view, /lib\.cameFromShelf = obj\.closest\('\.lib-rail'\)\?\.dataset\.rail \?\? null;/);
});

test('open: the Book hands over without a second movement', () => {
  /* THERE IS NO HANDOFF ANIMATION ANY MORE (S2.6).
   *
   * `is-opening` flew the object up 48px and faded it to 10% over 320ms, to
   * cover a wait that does not exist: measured, the Book view replaces the shelf
   * 18ms after the click. The animation got about one frame — just enough for
   * the Book you had turned to face you to jerk upward and start vanishing
   * before the screen swapped, which read as the Book moving twice for one
   * click. The committed front-facing cover now simply hands over.
   *
   * The rule it was there to satisfy still holds, more strictly: nothing is
   * applied to the object on the way out, so there is nothing that could be
   * left behind. */
  assert.ok(!view.includes("classList.add('is-opening')"), 'the handoff animation is back');
  assert.ok(!/\.lib-obj\.is-opening\{/.test(html), 'the handoff class still has a look');
});

/* ── §19  The Diary shortcut ─────────────────────────────────────────── */

test('diary: it is never a library_items row, and never in Library search', () => {
  // Nothing creates a row for it.
  assert.ok(!/type:\s*'diary'/.test(view) && !/type:\s*'diary'/.test(overview),
    'something creates a diary-typed Library item');
  /* The search surface is built from `visibleItems()`, which reads `lib.items`
   * — the server's Library list. A shortcut that is not in that list cannot
   * appear in results, by construction rather than by filtering. */
  assert.match(overview, /if \(searching\) return `\$\{filtersHtml\(\)\}\$\{resultsHtml\(items\)\}/);
  assert.ok(!/diaryObjectHtml/.test(overview.slice(overview.indexOf('export function resultsHtml'))),
    'the Diary shortcut can appear in search results');
});

test('diary: leaving Library is the SHELL’s job, not a hash written from a shelf', () => {
  /* §33. Writing `#diary` from Library would change the URL without telling
   * the shell — sidebar still on Library, pending Library writes unflushed. */
  assert.match(view, /if \(obj\.dataset\.system === 'diary'\) \{ ctx\.goRoute\('diary'\); return; \}/);
  assert.match(appjs, /goRoute: \(id\) => void go\(id\)/);
});

/* ── §13/§14  Search and filters ─────────────────────────────────────── */

test('search: a focused result surface, not four shelves to hunt through', () => {
  /* Measured: searching the sample's unique needle rendered 0 shelves and 1
   * result; clearing it restored all 6 shelves. */
  assert.match(overview, /export function resultsHtml\(items\)/);
  assert.match(overview, /<section class="lib-results" aria-label="Search results">/);
  // Results keep their own type's visual — a Book still arrives as a cover.
  assert.match(overview, /items\.map\(\(it, i\) => objectHtml\(it, i, items\.length\)\)/);
});

test('search: clearing it puts the shelves back where they were', () => {
  assert.match(view, /restoreShelfScroll\(scroll\);\s*\n\}/);
  const results = view.slice(view.indexOf('function paintResults'));
  assert.ok(results.slice(0, results.indexOf('\n}')).includes('restoreShelfScroll'),
    'clearing a search does not restore shelf positions');
});

test('filters: compact, and they never blank the Library', () => {
  // §14 — pills, not a control that dominates the page.
  assert.match(overview, /class="chip \$\{lib\.filter === f\.id \? 'on' : ''\}" role="tab"/);
  // A type with nothing in it is not offered.
  assert.match(overview, /FILTERS\.filter\(\(f\) => f\.id === 'all' \|\| counts\[f\.id\]\)/);
});

/* ── §29  Archive ────────────────────────────────────────────────────── */

test('archive: in the overflow menu, never on a spine', () => {
  /* Measured: the menu offered Open book / Rename… / Archive, and the shelf
   * itself carried zero archive controls. */
  assert.match(overview, /data-act="archive">Archive<\/button>/);
  const objects = shelf.slice(shelf.indexOf('export function bookObjectHtml'),
    shelf.indexOf('export function shelfHtml'));
  assert.ok(!objects.includes('data-act="archive"'),
    'an archive control was put directly on a shelf object');
  // Archived items are still legible as archived, and not by opacity alone.
  assert.match(shelf, /<span class="lib-obj-flag">Archived<\/span>/);
});

/* ── §32  Loading ────────────────────────────────────────────────────── */

test('loading: shelf-shaped skeletons, and the D2.2 lifecycle guarantee intact', () => {
  assert.match(overview, /export function shelfSkeletonHtml\(\)/);
  assert.match(html, /\.lib-skel-book\{flex:0 0 auto;width:141px;height:181px/);
  assert.match(html, /\.lib-skel-res\{flex:0 0 auto;width:172px;height:132px/);
  // The watchdog that makes a permanent "Opening…" impossible is untouched.
  assert.match(view, /const LOADING_LIMIT = 8000;/);
  assert.match(view, /function endLoading\(\)/);
  assert.match(view, /data-loading="shelf"/);
});

/* ── §34/§35  Responsive ─────────────────────────────────────────────── */

/* ── §37/§38  Sample tooling ─────────────────────────────────────────── */

test('sample: one prefix, one cleanup, one system with a dial on it', () => {
  const seeder = readFileSync(join('src', 'lib', 'sample-library.ts'), 'utf8');
  assert.equal(SAMPLE_PREFIX, 'sample:f1:', 'L3 must reuse the existing prefix, not invent one');
  assert.match(seeder, /export type SampleSize = 'solo' \| 'small' \| 'full';/);
  // Every size writes the SAME prefix, so the existing cleanup covers all three.
  const removes = [...seeder.matchAll(/like\(libraryItems\.legacyId, `\$\{SAMPLE_PREFIX\}%`\)/g)];
  assert.ok(removes.length >= 2, 'cleanup and footprint must both match the prefix');
  assert.equal(isLibrarySampleAllowed('production'), false);
});

test('sample: the shelf books are shallow on purpose, and the deep one survives', () => {
  const seeder = readFileSync(join('src', 'lib', 'sample-library.ts'), 'utf8');
  /* Eleven deep books would slow seeding and make cleanup harder to reason
   * about for no extra coverage — what these exercise is the SHELF. */
  assert.match(seeder, /const shelfBookPages = \(title: string\)/);
  assert.match(seeder, /const SHELF_BOOKS = \[/);
  // And the variety §38 asks for is actually in the data, not just intended.
  const accents = new Set([...seeder.matchAll(/accent: '(\w+)' as const/g)].map((m) => m[1]));
  assert.ok(accents.size >= 5, `only ${accents.size} accents across the sample shelf`);
});
