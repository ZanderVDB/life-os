/**
 * Navigation reliability and partition-aware drag (Phase D2.1).
 *
 * Two defects, both reported from authenticated testing, both about something
 * arriving LATE and overwriting a decision the person had already made.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const app = code(read('app.js'));
const dragJs = code(read('drag.js'));
const libView = code(read('library-view.js'));
const diaView = code(read('diary-view.js'));

/* ══ The navigation token ══════════════════════════════════════════════ */

const nav = await import('../../web/nav.js' as string);

test('a token identifies each navigation, and only the newest is current', () => {
  const a = nav.bumpNav();
  assert.equal(nav.navStale(a), false);
  const b = nav.bumpNav();
  assert.equal(nav.navStale(a), true, 'an older navigation is still considered current');
  assert.equal(nav.navStale(b), false);
  assert.equal(nav.ifCurrent(a, () => 'painted'), undefined, 'a stale render ran');
  assert.equal(nav.ifCurrent(b, () => 'painted'), 'painted');
});

test('go() claims the navigation BEFORE it awaits anything', () => {
  /* The root cause. `go` waits on a pending save before changing the route, and
   * during that wait `state.route` is still the old one — so a second and third
   * click entered the same branch. Three concurrent navigations, and whichever
   * finished last painted last. */
  const fn = app.slice(app.indexOf('async function go(id)'));
  const head = fn.slice(0, fn.indexOf('if (state.route === id)'));
  assert.match(head, /const nav = bumpNav\(\)/);
  // …and the token is checked again after the flush, before anything is drawn.
  assert.match(fn.slice(0, 1600), /await diaryWillLeave\(\);[\s\S]{0,120}if \(navStale\(nav\)\) return;/);
});

test('a hash written BY go() is not treated as a new navigation', () => {
  /* `location.hash = id` fires hashchange, and bumping there invalidated the
   * very navigation that had just written it — Today fetched its tasks and then
   * refused to paint them. */
  assert.match(app, /ownHashWrite = `#\$\{id\}`/);
  assert.match(app, /if \(location\.hash === ownHashWrite\) ownHashWrite = null;\s*else bumpNav\(\)/);
});

test('every async route branch checks the token before it paints', () => {
  assert.match(app, /async function loadRoute\(nav = navToken\(\)\)/);
  for (const fetchCall of ['await loadTasks\\(\\)', 'await loadHistory\\(true\\)']) {
    const at = app.search(new RegExp(fetchCall));
    assert.ok(at > -1, fetchCall);
    assert.match(app.slice(at, at + 200), /if \(navStale\(nav\)\) return;/,
      `${fetchCall} paints without checking the navigation token`);
  }
});

test('a stale Library or Diary render can neither paint nor rewrite the hash', () => {
  // This is what actually put people back inside a Book: the stale render did
  // not merely repaint, it called setHash and changed the URL.
  assert.match(libView, /export async function renderLibrary\(nav = navToken\(\)\)/);
  assert.match(diaView, /export async function renderDiary\(nav = navToken\(\)\)/);
  const entry = diaView.slice(diaView.indexOf('async function renderEntry'));
  assert.ok(entry.indexOf('if (navStale(nav)) return;') < entry.indexOf('setHash('),
    'the diary sets the hash before checking whether the navigation is current');
  const book = libView.slice(libView.indexOf('async function renderBook'));
  assert.match(book.slice(0, 1800), /if \(navStale\(nav\)\) return;/);
});

test('a save landing late may finish, but it may not take the screen', () => {
  // A pending save updates its own record and its own coordinator. It must
  // never call a render routine that assumes the old route is still the route.
  const conflict = diaView.slice(diaView.indexOf('export async function showConflict'));
  assert.match(conflict.slice(0, 400), /dia\.mode !== 'entry' \|\| dia\.date !== date/);
  const libConflict = libView.slice(libView.indexOf('export async function showConflict'));
  assert.match(libConflict.slice(0, 400), /document\.querySelector\('\.bk-book'\)/);
});

/* ══ No blank frame while fetching ═════════════════════════════════════ */

test('known content is not cleared before its replacement is ready', () => {
  // A day already on screen stays there until the next one has arrived.
  assert.match(diaView, /if \(!scroll\.querySelector\('\.dia-book'\)\) scroll\.innerHTML = loadingHtml\(\)/);
  assert.match(diaView, /if \(!scroll\.querySelector\('\.dia-history'\)\)/);
  assert.match(libView, /if \(!scroll\.querySelector\('\.bk-book'\)\)/);
});

/* ══ Partition-aware drag ══════════════════════════════════════════════ */

test('a partition has a home even when it holds nothing yet', () => {
  /* The regression. `updateInsertion` filters candidates to the dragged card's
   * own kind — correct — but with no candidates it fell through to
   * `zone.appendChild`, putting a standalone task after every project row. */
  assert.match(dragJs, /function partitionAnchor\(zone, kind\)/);
  const fn = dragJs.slice(dragJs.indexOf('function partitionAnchor'));
  assert.match(fn.slice(0, 500), /if \(kind !== 'standalone'\) return null;/);
  assert.match(fn.slice(0, 500), /sub-head\[data-sub="projects"\]/);
  // And the empty-partition case is handled BEFORE the generic append.
  const upd = dragJs.slice(dragJs.indexOf('function updateInsertion'));
  assert.ok(upd.indexOf('if (!cards.length)') < upd.indexOf('zone.appendChild(session.ph)'),
    'the empty-partition case is still falling through to a plain append');
});

test('the drag previews the heading its drop would create', () => {
  // The placeholder is the real future layout. A standalone task landing in a
  // project-only bucket will create a TASKS heading, so it appears during the
  // drag or the preview is lying about where the card is going.
  assert.match(dragJs, /function syncPartitionHeads\(\)/);
  const fn = dragJs.slice(dragJs.indexOf('function syncPartitionHeads'));
  assert.match(fn.slice(0, 1400), /if \(!withPh\.standalone \|\| !withPh\.project\) return;/);
  assert.match(fn, /dataset\.phHead = '1'/);
});

test('a preview heading never survives the gesture', () => {
  assert.match(dragJs, /function finish\(hooks\)[\s\S]{0,400}\[data-ph-head\]/);
  assert.match(dragJs, /reclaimOrphan[\s\S]{0,400}\[data-ph-head\]/);
});

test('headings are reconciled after the drop, not the rows re-sorted', () => {
  // §6 forbids solving this with a post-drop re-sort. The rows are already
  // where the drop put them; only the dividers are recomputed.
  assert.match(app, /function syncBucketHeads\(\)/);
  assert.match(dragJs, /hooks\.onSettled\?\.\(\)/);
  assert.match(app, /onSettled: syncBucketHeads/);
  const fn = app.slice(app.indexOf('function syncBucketHeads'));
  assert.doesNotMatch(fn.slice(0, 1600), /sort\(|arrangeStandalone|insertionIndex/,
    'the heading reconciliation re-sorts the rows');
  // The same adaptive rule the rendered bucket uses.
  assert.match(fn.slice(0, 1600), /bothKinds = standalone\.length > 0 && project\.length > 0/);
});

test('a drag still cannot change what a task IS', () => {
  // Project membership is changed in the editor, never by where a card landed.
  assert.match(dragJs, /sectionOf\(c\) === kind/);
  assert.match(read('arrange.js'), /export const isStandalone = \(t\) => t\.projectId == null/);
});
