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
const html = read('index.html');

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

/* ══ Keyboard partition moves ══════════════════════════════════════════ */

test('every non-pointer move works within the task own partition', () => {
  /* The pointer drag filtered its candidates; the keyboard and menu paths were
   * still anchoring against the WHOLE bucket, which is how Move down and Move
   * to bottom walked a standalone task into the project half. */
  assert.match(app, /function partitionFor\(task, bucket = task\.bucket\)/);
  const nudge = app.slice(app.indexOf('function nudge(id, dir)'));
  assert.match(nudge.slice(0, 400), /const list = partitionFor\(t\)/);
  assert.doesNotMatch(nudge.slice(0, 400), /inBucket\(t\.bucket\)/,
    'nudge still anchors against the whole bucket');
});

test('a move into a bucket with no matching partition lands at its boundary', () => {
  assert.match(app, /function boundaryAnchor\(task, bucket\)/);
  const fn = app.slice(app.indexOf('function boundaryAnchor'));
  // Standalone work goes before the first project row; project work goes last,
  // which is `{}` and already correct.
  assert.match(fn.slice(0, 600), /if \(!isStandalone\(task\)\) return \{\};/);
  assert.match(fn.slice(0, 600), /beforeTaskId: project\[0\]\.id/);
  // Used by every non-pointer path that can cross into a new bucket.
  assert.match(app, /moveTask\(id, b\.dataset\.b, boundaryAnchor\(t, b\.dataset\.b\)\)/);
  assert.match(app, /moveTask\(id, next\.id, boundaryAnchor\(t, next\.id\)\)/);
});

test('Move to top and bottom mean the partition, not the bucket', () => {
  const at = app.indexOf("b.dataset.o === 'top'");
  assert.ok(at > -1);
  const around = app.slice(at - 500, at + 200);
  assert.match(around, /const list = partitionFor\(t\)\.filter/);
  assert.match(around, /if \(!list\.length\) return moveTask\(id, t\.bucket, boundaryAnchor/);
});

/* ══ The computed Diary habit ══════════════════════════════════════════ */

test('Write in Diary is computed, pinned, and cannot be mutated', () => {
  assert.match(app, /function diarySystemHabitHtml\(\)/);
  const fn = app.slice(app.indexOf('function diarySystemHabitHtml'));
  assert.match(fn.slice(0, 900), /Write in Diary/);
  // Rendered ABOVE the list, so it cannot be reordered into it.
  const rail = app.slice(app.indexOf('function renderRail'));
  assert.ok(rail.indexOf('diarySystemHabitHtml()') < rail.indexOf('due.map(habitRowHtml)'),
    'the system habit is not pinned above the ordinary habits');
  // No toggle: completing it means writing something, so it opens the Diary.
  assert.doesNotMatch(fn.slice(0, 900), /data-habit-toggle/);
  assert.match(app, /#hb-diary'\)\?\.addEventListener\('click', \(\) => go\('diary'\)\)/);
});

test('the habit stores nothing — Diary stays the only source of truth', () => {
  const fn = app.slice(app.indexOf('async function loadDiaryStreak'));
  assert.match(fn.slice(0, 500), /diary\/streak\?today=/);
  // It reads Diary. It never writes a habit or a habit entry.
  assert.doesNotMatch(fn.slice(0, 500), /habits|toggleHabit|habitEntries/i);
});

test('the streak counts MEANINGFUL days, not surviving rows', () => {
  /* A row survives having its content cleared — that is what makes restore
   * possible — so counting rows said somebody had written on a day they had
   * just emptied, and the habit stayed complete. */
  const route = readFileSync(join('src', 'routes', 'diary.ts'), 'utf8');
  const fn = route.slice(route.indexOf('/diary/streak'));
  assert.match(fn.slice(0, 2200), /\.filter\(\(r\) => isMeaningfulEntry\(/);
  // …and by the SAME rule the write path uses, not a re-implementation in SQL.
  assert.doesNotMatch(fn.slice(0, 2200), /document_text <> ''/);
});

test('the streak line left the Diary page', () => {
  const checkin = read('diary-checkin.js');
  assert.doesNotMatch(code(checkin), /dia-streak/,
    'the streak is still rendered on the diary right page');
  assert.match(checkin, /moved to Today's Habits panel/);
});

/* ══ Diary writing surface ═════════════════════════════════════════════ */

test('the permanent Diary toolbar is gone, and storage is untouched', () => {
  const entry = code(read('diary-entry.js'));
  const spread = entry.slice(entry.indexOf('export function spreadHtml'));
  assert.doesNotMatch(spread.slice(0, 1800), /toolbarHtml\(\)/,
    'the spread still renders a permanent toolbar');
  // Existing formatted entries must still RENDER — docToHtml is untouched.
  assert.match(entry, /docToHtml\(e\?\.document\)/);
  const doc = code(read('editor-doc.js'));
  assert.match(doc, /return `<h\$\{level\}>/);
  assert.match(doc, /type === 'bulletList' \? 'ul' : 'ol'/);
  assert.match(doc, /return `<blockquote>/);
});

test('a prompt response is a surface, not an underline', () => {
  const rule = html.slice(html.indexOf('.dia-prompt-a{'), html.indexOf('.dia-prompt-a::placeholder'));
  assert.match(rule, /min-height:46px/);
  assert.match(rule, /border-radius:8px/);
  assert.match(rule, /border:1px solid/);
  assert.match(rule, /box-shadow:inset/);
  // It grows rather than scrolling inside itself.
  assert.match(rule, /overflow:hidden/);
  assert.match(rule, /resize:none/);
  assert.match(code(read('diary-checkin.js')), /export function autosize/);
});

test('the spread grows with its content', () => {
  // aspect-ratio becomes a MINIMUM; the grid keeps both pages the same height.
  assert.match(html, /\.dia-book\.bk-spread\{aspect-ratio:auto;min-height:/);
  assert.match(html, /\.dia-scroll\{[^}]*overflow:visible/);
});
