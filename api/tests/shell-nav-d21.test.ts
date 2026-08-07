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
   * refused to paint them.
   *
   * D2.2 moved the record into nav.js, because app.js's private `ownHashWrite`
   * only ever knew about ITS OWN writes. Library and Diary each kept a separate
   * flag the shell could not see, so every hash they wrote about themselves
   * bumped the token — which IS the Library regression. One writer, one record,
   * one answer, and the shell asks exactly once per event. */
  assert.equal(typeof nav.setHash, 'function');
  assert.equal(typeof nav.hashWasOurs, 'function');
  assert.match(app, /const ours = hashWasOurs\(\);/);
  assert.match(app, /if \(!ours\) bumpNav\(\)/);
  assert.doesNotMatch(app, /ownHashWrite/, 'the private flag is back');
  // …and the answer is passed down rather than asked for again. `hashWasOurs`
  // consumes the record, so a second caller would be told "no".
  assert.match(app, /libraryHashChanged\(ours\)/);
  assert.match(app, /diaryHashChanged\(ours\)/);
  // Neither section keeps a flag of its own any more.
  assert.doesNotMatch(libView, /let suppressHash/);
  assert.doesNotMatch(diaView, /let suppressHash/);
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
  /* Diary is guarded by TWO tokens from D2.3 §18: the route token above, and a
   * DATE-navigation token. Moving between days does not change the route, so
   * `navStale` was false for every date press and every stale render was free
   * to paint — that was the rubber-band. `stale()` is both questions. */
  const entry = diaView.slice(diaView.indexOf('async function renderEntry'));
  assert.match(entry.slice(0, 900), /const stale = \(\) => navStale\(nav\) \|\| dayNavStale\(day\)/);
  assert.ok(entry.indexOf('if (stale()) return;') < entry.indexOf('setHash('),
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
  /* A day already on screen stays there until the next one has arrived.
   *
   * D2.3 §21 sharpened this rather than relaxing it. On a DATE change the live
   * layer is replaced immediately with the REQUESTED day's paper and heading,
   * while the day being left animates away as a ghost above it — because when
   * the network is slow the ghost fades in 260ms and whatever is underneath
   * becomes visible. If that were still the old day, a slow connection would
   * show the day you just left as the current one. Nothing is ever cleared to
   * nothing; what changes is which day the placeholder belongs to. */
  assert.match(diaView, /if \(animate \|\| !scroll\.querySelector\('\.dia-book'\)\)/);
  assert.match(diaView, /scroll\.innerHTML = loadingHtml\(date\)/);
  assert.match(code(read('diary-entry.js')),
    /export const loadingHtml = \(date = dia\.date\)/);
  assert.match(read('diary-entry.js'), /esc\(formatLong\(date\)\)/);
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
  assert.match(fn.slice(0, 1600), /d\.name/);
  /* REVERSED by D2.2 §7. It used to be rendered ABOVE the list so it could not
   * be reordered into it, and the result read as a different component that
   * happened to live in the habits card. It is now the FIRST ROW OF THE LIST,
   * with the same `.hb-row` class, the same 32px ring markup and the same
   * `streakHtml`. Being first is still structural: it is emitted before the
   * map, so nothing can reorder it. */
  const rail = app.slice(app.indexOf('function renderRail'));
  const list = rail.slice(rail.indexOf('hb-list'));
  assert.ok(list.indexOf('diarySystemHabitHtml()') < list.indexOf('due.map(habitRowHtml)'),
    'the computed habit is not first inside the list');
  assert.match(fn.slice(0, 1600), /class="hb-row hb-diary/);
  assert.match(fn.slice(0, 1600), /class="hb-ring"/);
  assert.doesNotMatch(fn.slice(0, 1600), /hb-sys-tag/, 'the SYSTEM badge is back');
  // No toggle: completing it means writing something, so it opens the Diary.
  assert.doesNotMatch(fn.slice(0, 1600), /data-habit-toggle/);
  assert.match(app, /\[data-diary-open\]'\)\.forEach[\s\S]{0,180}go\('diary'\)/);
});

test('the habit stores nothing — Diary stays the only source of truth', () => {
  /* Still true, and now enforced on the SERVER, where the one provider lives.
   * D2.2 moved the client's refresh from `/diary/streak` to `/habits`, because
   * the totals have to move with the row — asking for the streak alone updated
   * the row and left `1/6` reading `0/6`. */
  const fn = app.slice(app.indexOf('async function loadDiaryStreak'));
  assert.match(fn.slice(0, 500), /await loadHabits\(\)/);
  const lib = readFileSync(join('src', 'lib', 'diary-habit.ts'), 'utf8');
  assert.match(lib, /export const DIARY_HABIT_ID = 'system:diary'/);
  // It reads Diary. It never writes a habit or a habit_entries row.
  assert.doesNotMatch(lib, /db\.insert|db\.update|db\.delete/,
    'the computed habit writes something');
  // And the id is deliberately not a UUID, so a check or delete cannot name it.
  assert.doesNotMatch(lib, /DIARY_HABIT_ID = '[0-9a-f]{8}-/);
});

test('the streak counts MEANINGFUL days, not surviving rows', () => {
  /* A row survives having its content cleared — that is what makes restore
   * possible — so counting rows said somebody had written on a day they had
   * just emptied, and the habit stayed complete.
   *
   * D2.2 moved the rule into `lib/diary-habit.ts`, so the streak, Today's
   * totals and the Calendar history all read the same `writtenDays`. */
  const lib = readFileSync(join('src', 'lib', 'diary-habit.ts'), 'utf8');
  assert.match(lib, /export function writtenDays\(/);
  assert.match(lib, /if \(isMeaningfulEntry\(/);
  const route = readFileSync(join('src', 'routes', 'diary.ts'), 'utf8');
  const fn = route.slice(route.indexOf('/diary/streak'));
  assert.match(fn.slice(0, 2400), /const have = writtenDays\(rows\)/);
  // …by the SAME rule the write path uses, not a re-implementation in SQL.
  assert.doesNotMatch(fn.slice(0, 2400), /document_text <> ''/);
});

test('the streak line left the Diary page', () => {
  const checkin = read('diary-checkin.js');
  assert.doesNotMatch(code(checkin), /dia-streak/,
    'the streak is still rendered on the diary right page');
  /* The prose moved with D2.3's rewrite of this file; what is asserted is the
   * behaviour, not a sentence. Continuity lives on Today as the computed
   * habit — the right page shows how the day WAS, never a running total. */
  assert.doesNotMatch(code(checkin), /streak/i,
    'a streak has crept back onto the right page');
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
  /* 46px in D2.1; 40px from D2.2 §5, the top of the 36–40px range the phase
   * asked for. Still a SURFACE — the border, the radius and the inset shadow
   * are what make it one, not its height. */
  assert.match(rule, /min-height:40px/);
  assert.match(rule, /border-radius:8px/);
  assert.match(rule, /border:1px solid/);
  assert.match(rule, /box-shadow:inset/);
  // It grows rather than scrolling inside itself.
  assert.match(rule, /overflow:hidden/);
  assert.match(rule, /resize:none/);
  assert.match(code(read('diary-checkin.js')), /export function autosize/);
});

test('the spread grows with its content, from a stated base', () => {
  /* REVISED by D2.2 §3/§4. D2 made `aspect-ratio` a minimum by writing
   * `min-height:calc((100vw - 460px) * 297/420)` — reading the WINDOW to size
   * an element inside a column. It over-corrected: the empty spread ran far
   * below the fold, and the number was wrong at every width where the rail or
   * the drawer changed the column.
   *
   *   height = max(approvedBaseHeight, leftRequired, rightRequired)
   *
   * All three terms are layout. The base is a zero-content pseudo-element
   * spanning both columns at the Book's own 420:297, so it is exactly the open
   * Book's height at the same width and needs no arithmetic at all. */
  assert.match(html, /\.dia-book\.bk-spread\{aspect-ratio:auto;height:auto;align-items:stretch\}/);
  assert.match(html, /\.dia-book\.bk-spread::before\{content:'';grid-row:1;grid-column:1\/-1;[\s\S]{0,60}aspect-ratio:420\/297/);
  assert.doesNotMatch(html, /\.dia-book\.bk-spread\{[^}]*min-height:calc\(\(100vw/,
    'the viewport-derived minimum is back');
  // Both pages take the taller of the two, so the gutter and edges extend.
  assert.match(html, /\.dia-book\.bk-spread > \.dia-left\{grid-row:1;grid-column:1\}/);
  assert.match(html, /\.dia-book\.bk-spread > \.dia-right\{grid-row:1;grid-column:2\}/);
  assert.match(html, /\.dia-scroll\{[^}]*overflow:visible/);
  /* The ruled writing area absorbs the slack, and its floor is well below the
   * height it renders at — a floor tall enough to bind is one that pushes the
   * spread past the base, which is what the old 180px did. */
  /* REVISED by D2.3 §1. `flex:1 0 auto` let the ruled area swallow every spare
   * pixel, so a blank day opened with half a page of empty paper before the
   * prompts appeared. The editor is now exactly as tall as its content with a
   * SEVEN-LINE floor, and the spare room sits below the prompts instead. */
  assert.match(html, /\.dia-editor\{flex:0 0 auto\}/);
  assert.match(html, /\.dia-editor\{outline:0;min-height:210px/);
  assert.match(html, /\.dia-left \.dia-scroll::after\{content:'';flex:1 1 auto/);
  /* No JavaScript owns the SPREAD's height, so there is no inline value to go
   * stale. The one height D2.3 writes belongs to the outgoing ghost, which is
   * pinned to the box it replaces and then deletes itself. */
  const spreadCode = diaView.replace(
    diaView.slice(diaView.indexOf('function beginTurn'), diaView.indexOf('function endTurn')), '');
  assert.doesNotMatch(spreadCode, /style\.height = /);
});

/* ══ Drag geometry ═════════════════════════════════════════════════════ */

test('the dragged card is always the compact width, whatever it was resting at', () => {
  /* `.bucket.future` is grid-column 1/-1, so a Future task rests two or three
   * times wider. Lifting it at that width made the floating card cover the
   * neighbouring buckets and hide the insertion point — you could not see where
   * the card was going, because the card was on top of it. */
  assert.match(dragJs, /function compactZoneWidth\(\)/);
  assert.match(dragJs, /function dragWidth\(card\)/);
  const fn = dragJs.slice(dragJs.indexOf('function dragWidth'));
  assert.match(fn.slice(0, 400), /Math\.min\(own, compact\)/);
  // Applied at lift, to the card and to the session.
  assert.match(dragJs, /card\.style\.width = `\$\{width\}px`/);
  assert.match(html, /\.bucket\.future\{grid-column:1\/-1\}/);
});

test('the width is measured ONCE and never re-adopted mid-drag', () => {
  /* Resizing per-bucket as the pointer crossed a boundary made the card breathe
   * — and a Future card that adopted the full-row width covered the buckets
   * either side of the one being aimed at. `adoptWidth` is gone; `adoptGap`
   * resizes only the PLACEHOLDER.
   *
   * Asserted on `session.width`, not on `style.width`: adoptGap does set the
   * card's width for a moment to measure the height it would need there, and
   * puts it straight back. What must never happen is the session's geometry
   * changing after lift. */
  assert.doesNotMatch(dragJs, /function adoptWidth/, 'the card still adopts bucket widths');
  assert.match(dragJs, /function adoptGap\(zone\)/);
  const after = dragJs.slice(dragJs.indexOf('function begin(card, e, hooks)') + 200);
  assert.doesNotMatch(after, /session\.width = /,
    'the drag width is reassigned after the lift');
  assert.doesNotMatch(after, /session\.grabX = /,
    'the grab point is recomputed mid-drag, which makes the card jump');
  // The gap still follows the destination, because a title wraps differently.
  const gap = dragJs.slice(dragJs.indexOf('function adoptGap'));
  assert.match(gap.slice(0, 800), /session\.ph\.style\.height/);
});

test('the placeholder gap is measured at the width the card will actually be', () => {
  // A Future card is wide and short; the same words in a column wrap and are
  // taller, so measuring from the resting rect opens a gap too small.
  const fn = dragJs.slice(dragJs.indexOf('const width = dragWidth(card)'));
  assert.match(fn.slice(0, 500), /card\.style\.width = `\$\{width\}px`;\s*height = card\.getBoundingClientRect\(\)\.height/);
  assert.match(dragJs, /ph\.style\.height = `\$\{height\}px`/);
});

test('expansion into Future happens after settling, never while floating', () => {
  const fn = dragJs.slice(dragJs.indexOf('const landed = s.card.getBoundingClientRect().width'));
  assert.match(fn.slice(0, 900), /if \(landed > s\.width \+ 1\)/);
  // It is measured AFTER the card has been placed in its final slot.
  const finish = dragJs.slice(dragJs.indexOf('function finish(hooks)'));
  assert.ok(finish.indexOf('s.ph.replaceWith(s.card)') < finish.indexOf('const landed ='),
    'the landed width is measured before the card is in place');
});

test('an unfinished grow animation cannot strand the card at the wrong width', () => {
  /* A running animation overrides the computed width. One that never completes
   * — a backgrounded tab, a throttled timeline — would hold the card compact in
   * a bucket where it should be full width. Observed in the harness browser,
   * whose animation timeline is throttled: the card sat at 160px in a 577px
   * bucket until the animation was cancelled. */
  assert.match(dragJs, /settle\(grow, 260, \(\) => grow\.cancel\(\)\)/);
  assert.match(dragJs, /import \{ settle, reducedMotion \}/);
});

test('every teardown path clears the temporary geometry', () => {
  const fn = dragJs.slice(dragJs.indexOf('function restoreCard(s)'));
  assert.match(fn.slice(0, 700), /'width', 'height', 'position', 'left', 'top', 'zIndex'/);
  // Cancel, drop and orphan-reclaim all go through it.
  assert.match(dragJs, /function abort\(\)[\s\S]{0,300}restoreCard/);
  assert.match(dragJs, /function reclaimOrphan\(s\)\s*\{\s*restoreCard\(s\)/);
});

test('the resting width is remembered, so a cancel restores it exactly', () => {
  assert.match(dragJs, /restWidth: rect\.width/);
});
