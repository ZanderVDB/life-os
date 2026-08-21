/**
 * Phase S3 — the Project management menu, and the bounded Book open.
 *
 * Two unrelated blockers, one phase, because both were reported as "it does
 * nothing" and both turned out to be something other than what the report said.
 *
 * The Project menu was never unwired. It had a handler, a full action list and
 * six working mutations behind it. What it did not have was a lookup that could
 * find the project the row was rendered from — see below. The Library freeze is
 * the other half: a hard renderer hang that, measured, does not happen.
 *
 * These tests pin the properties that make each of those true, not the symptom.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const raw = (f: string) => readFileSync(join(WEB, f), 'utf8');
/* Comments stripped: every one of these files explains its own bug in prose,
 * and prose that mentions `pj.data.groups` must not satisfy an assertion about
 * the code that reads it. */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const app = code(raw('app.js'));
const projects = raw('projects.js');
const view = code(raw('library-view.js'));
const shelf = code(raw('library-shelf.js'));
const html = raw('index.html') + raw('app.css');
const css = html.slice(html.indexOf('LIBRARY (Phase F2)'), html.indexOf('DIARY', html.indexOf('LIBRARY (Phase F2)')));

/* ══ §1/§21  The Project menu ═════════════════════════════════════════════
 *
 * THE BUG, exactly.
 *
 * The overview is fetched with no filter, so the server fills the compatibility
 * field `groups` with `views.working` and sends all six real views beside it.
 * The list renders from `views[pj.filter]`. The menu looked the project up in
 * `groups`.
 *
 * So the menu could only find a project that was ALSO in the working view.
 * Measured against real data: 3 of 14 rows were unreachable — everything under
 * Someday (working excludes focus 'someday' by definition), everything under
 * Archived (working is built from the non-archived list), and any project
 * completed more than thirty days ago (it has left "Recently completed").
 * `openProjectMenu` starts `if (!project) return`, so the button did nothing
 * whatsoever: no menu, no error, no console warning. That silence is why this
 * was reported as a menu that had never been wired at all.
 *
 * It also explains why it looked tab-specific and yet inconsistent: in Planning,
 * a project focused 'someday' was dead while the one beside it worked.
 */

test('s3: the menu looks a project up across every view, not just working', () => {
  /* The specific regression. `groups` is one view wearing a compatibility name;
   * searching it is searching the Working tab no matter which tab you are on. */
  const fn = app.slice(app.indexOf('function findProject('), app.indexOf('function openProjectMenu('));
  assert.ok(fn.length > 0, 'findProject is gone');
  assert.match(fn, /pj\.data\?\.views/, 'findProject does not consult the views');
  assert.match(fn, /Object\.values\(views\)/, 'findProject does not search ALL views');
  /* `groups` may remain ONLY as the fallback for a payload with no views. */
  const beforeFallback = fn.slice(0, fn.indexOf('groups'));
  assert.match(beforeFallback, /views/, 'groups is consulted before views');
});

test('s3: the three-dot handler uses that shared lookup and nothing else', () => {
  const wire = app.slice(app.indexOf('function wireProjectRows('), app.indexOf('function findProject('));
  assert.match(wire, /\[data-pj-menu\]/);
  assert.match(wire, /findProject\(b\.dataset\.pjMenu\)/,
    'the menu handler does not go through the shared lookup');
  /* The old inline lookup must be gone, not merely bypassed. */
  assert.ok(!/groups\s*\?\?\s*\[\]\)\.flatMap/.test(wire), 'the groups-only lookup survives');
});

test('s3: opening the menu never navigates to the project', () => {
  const wire = app.slice(app.indexOf('function wireProjectRows('), app.indexOf('function findProject('));
  assert.match(wire, /e\.stopPropagation\(\)/, 'the three-dot click still bubbles');
  /* Enter on the trigger fires the BUTTON, and the row's own Enter handler used
   * to run as well — so one keystroke opened the menu and navigated underneath
   * it. The row only answers for itself now. */
  assert.match(wire, /if \(e\.target !== row\) return;/,
    'the row still claims Enter from the buttons inside it');
});

test('s3: every lifecycle state offers actions the API will accept', () => {
  const menu = app.slice(app.indexOf('function openProjectMenu('), app.indexOf('async function projectWrite('));
  /* Archived is genuinely different: the server refuses a PATCH to an archived
   * project until it is restored, so Edit there would be a button that returns
   * a conflict. Restore and Delete are the whole truthful set. */
  assert.match(menu, /archived\s*\n?\s*\?\s*\[\{ id: 'restore'.*\{ id: 'delete'/s);
  /* Completed gets the way back out. Before S3 it had no route out of the
   * state at all from the overview. */
  assert.match(menu, /completed[\s\S]{0,120}id: 'reopen'/);
  assert.match(menu, /id: 'complete'/);
  for (const id of ['edit', 'reopen', 'complete', 'archive', 'restore', 'top', 'delete']) {
    assert.match(menu, new RegExp(`id === '${id}'`), `${id} has no action`);
  }
});

test('s3: reopening leaves completed without a second write to tidy up after it', () => {
  const fn = app.slice(app.indexOf('async function reopenProject('), app.indexOf('async function moveProjectToTop('));
  assert.match(fn, /method: 'PATCH'/);
  assert.match(fn, /status: 'active'/);
  /* Optimistic concurrency, the same as every other project write. */
  assert.match(fn, /expectedUpdatedAt: project\.updatedAt/);
  /* completedAt is the API's business — it clears it whenever status leaves
   * completed. A client that also cleared it would be a second author of one
   * fact. */
  assert.ok(!/completedAt/.test(fn), 'the client is second-guessing completedAt');
});

test('s3: deleting a project asks first, and never destroys by default', () => {
  const fn = app.slice(app.indexOf('async function deleteProject('), app.indexOf('async function completeProjectTask('));
  assert.match(fn, /openChoiceDialog/, 'delete does not confirm');
  /* The cancel path. The choices grew — keeping the tasks, taking them with it,
   * or not deleting at all — so the guard is now on the cancel answer rather
   * than on one specific yes. An unanswered dialog must still do nothing. */
  assert.match(fn, /if \(choice === 'cancel' \|\| !choice\) return;/,
    'delete proceeds without an answer');
  assert.match(fn, /tone: 'danger'/);
  /* Keeping the work is still what happens unless the user says otherwise. */
  assert.match(fn, /let tasksMode = 'keep';/, 'the default is no longer to keep the tasks');
});

test('s3: switching lifecycle tab cannot leave a menu behind', () => {
  const fn = app.slice(app.indexOf('function setProjectFilter('), app.indexOf('function wireProjectRows('));
  assert.match(fn, /closeUtility\(\)/, 'a filter change leaves the open menu mounted');
  /* Before the repaint, not after — the rows it is anchored to are removed. */
  assert.ok(fn.indexOf('closeUtility()') < fn.indexOf('pj.filter = filter'),
    'the menu is closed after the filter has already changed');
});

test('s3: one menu at a time, Escape closes it, focus comes back', () => {
  /* All three are properties of the shared component rather than of Projects,
   * which is the point of having one. Pinned here because the Project menu is
   * the thing this phase promised. */
  const util = raw('utility-menu.js');
  assert.match(util, /let open = null;/);
  assert.match(util, /closeUtility\(\);\s*\n\s*const el = document\.createElement/,
    'opening a menu does not close the previous one');
  assert.match(util, /if \(e\.key === 'Escape'\).*closeUtility\(\{ focus: true \}\)/s);
  assert.match(util, /if \(focus\) anchor\.focus\(\);/);
});

test('s3: the trigger names the project it acts on', () => {
  /* "Actions for X" left a screen reader to infer what kind of thing X is from
   * the surrounding list. Both triggers say it. */
  assert.match(projects, /aria-label="Project actions for \$\{esc\(p\.title\)\}"/);
  const detail = projects.slice(projects.indexOf('projectDetailHeaderHtml'));
  assert.match(detail, /id="pjd-menu"[\s\S]{0,140}aria-label="Project actions for \$\{esc\(p\.title\)\}"/);
  assert.match(projects, /aria-haspopup="menu"/);
});

/* ══ §7–§15/§22  The Book open ════════════════════════════════════════════
 *
 * WHAT THE FREEZE TURNED OUT TO BE.
 *
 * Instrumented in real Chrome on the deployed build: opening a Book fires the
 * ResizeObserver zero times, mounts one spread, adds one mount's worth of
 * listeners, and produces a full frame on demand immediately afterwards. There
 * is no loop to remove. The original evidence — a screenshot timing out after
 * thirty seconds — came from the recording tool wedging its own tab, which had
 * already produced one wrong diagnosis earlier in this work.
 *
 * So there is no fix here to protect. What these tests protect is the
 * BOUNDEDNESS that makes the freeze impossible to reintroduce quietly: the
 * shapes that turn into loops are the read-then-write ones, and both of them
 * now refuse to write a value that is already committed.
 */

test('s3: there is exactly one ResizeObserver in the app, and it is replaced, not stacked', () => {
  const all = raw('library-view.js') + raw('library-shelf.js') + raw('library-book.js') + raw('app.js');
  const made = (all.match(/new ResizeObserver/g) ?? []).length;
  assert.equal(made, 1, `${made} ResizeObservers — each one is a loop that can start`);
  assert.match(view, /shelfSizer\?\.disconnect\(\);\s*\n\s*shelfSizer = new ResizeObserver/,
    'the shelf observer is not disconnected before being replaced');
});

test('s3: the observer callback cannot feed itself', () => {
  /* syncSteps reads the rail's size and writes a class to that same rail, which
   * is the exact shape of a ResizeObserver feedback loop. It is safe today only
   * because `is-full` happens to touch the child row and not the rail's own
   * box — a property of the stylesheet, which this function has no control
   * over. Writing only on a real change makes it safe regardless. */
  const fn = shelf.slice(shelf.indexOf('export function syncSteps('), shelf.indexOf('export function captureShelfScroll('));
  assert.match(fn, /if \(rail\.classList\.contains\('is-full'\) !== full\)/,
    'syncSteps writes is-full unconditionally');
  assert.match(fn, /if \(nav\.classList\.contains\('is-live'\) !== full\)/);
  assert.match(fn, /prev\.disabled !== wantPrev/);
  assert.match(fn, /next\.disabled !== wantNext/);
});

test('s3: applyHalf is idempotent — same state in, no DOM writes', () => {
  const fn = view.slice(view.indexOf('function applyHalf('), view.indexOf('async function navigate('));
  assert.match(fn, /classList\.contains\('show-right'\) !== wantRight/,
    'applyHalf re-writes show-right every call');
  assert.match(fn, /next\.disabled !== wantDisabled/,
    'applyHalf re-writes the arrow state every call');
  /* It is reachable from a resize listener, so an unconditional write here is
   * one resize away from being a style-invalidation loop. */
  assert.match(view, /window\.addEventListener\('resize', \(\) => \{ if \(lib\.bookId && !lib\.cover\) applyHalf\(\); \}\)/);
});

test('s3: the window listeners are installed once, not per Book', () => {
  /* Mount, leave and return must not accumulate. installGlobals is called from
   * initLibrary, which app.js runs a single time. */
  assert.match(view, /export function initLibrary\(c\) \{[\s\S]{0,200}installGlobals\(\);/);
  const calls = (raw('app.js').match(/initLibrary\(/g) ?? []).length;
  assert.equal(calls, 1, 'initLibrary is called more than once');
});

test('s3: one open is one render, whatever the hash does', () => {
  /* Opening a Book writes the hash TWICE — once to route, once to record the
   * section and page — so two hashchange events for one intent is correct and
   * expected. What must not happen is two renders. Every write goes through
   * setHash, which records it, and the shell asks hashWasOurs() once per event
   * and declines to re-render its own writes. */
  const nav = raw('nav.js');
  assert.match(nav, /pendingWrites\.push\(want\)/);
  assert.match(nav, /export function hashWasOurs/);
  assert.match(nav, /pendingWrites\.splice\(at, 1\);\s*\n\s*return true;/,
    'hashWasOurs does not consume the record, so one write could answer twice');
  assert.match(view, /function setHashAndRender\(next\) \{\s*\n\s*setHash\(next\);\s*\n\s*void renderLibrary\(\);/);
});

test('s3: the spread mounts the editors already in the DOM', () => {
  /* mountSpread wires elements; it never creates them. That is what keeps one
   * open to one mount — and what keeps selection and undo alive while typing. */
  const b = code(raw('library-book.js'));
  const fn = b.slice(b.indexOf('export function mountSpread('));
  assert.match(fn, /root\.querySelectorAll\('\[data-editor\]'\)/);
  assert.ok(!/createElement\('div'\)[\s\S]{0,80}data-editor/.test(fn),
    'mountSpread builds editors, so remounting would duplicate them');
});

/* ══ §17  Nothing about the Book changed ══════════════════════════════════ */

test('s3: the approved resting pose is untouched', () => {
  /* The values the authenticated user chose in S2. This phase had no licence to
   * move any of them, and the freeze work did not need to. */
  const want: Record<string, string> = {
    '--lib-book-gap': '0px', '--lib-book-lean': '0deg', '--lib-book-top-tilt': '-4deg',
    '--lib-book-yaw': '-6deg', '--lib-book-depth': '0px', '--lib-page-grain': '90deg',
    '--lib-book-hover': '8px', '--lib-book-pull': '32px', '--lib-book-neighbour': '16px',
  };
  for (const [token, value] of Object.entries(want)) {
    assert.match(css, new RegExp(`${token}\\s*:\\s*${value.replace(/[-]/g, '\\-')}`),
      `${token} is no longer ${value}`);
  }
  assert.match(html, /--d-turn:\s*400ms/);
});

test('s3: the committed Book still snaps rather than turning a second time', () => {
  /* S2.11. The commit sets transform back to none on two transitioned elements;
   * without transition:none that unwound the turn over another 400ms and read
   * as the Book turning twice for one click. */
  assert.match(css, /\.lib-obj\.is-front \.lib-vol\{transform:none;transform-style:flat;transition:none\}/);
  assert.match(css, /\.lib-obj\.is-front \.lib-board\{transform:none;left:0;transition:none\}/);
});

test('s3: the shelf contact and the neighbour clearance are unchanged', () => {
  assert.match(css, /\.lib-slot\.is-nudge-r\{transform:translateX\(calc\(var\(--lib-book-clear, 0px\) \+ var\(--lib-book-neighbour\)\)\)\}/);
  assert.match(css, /padding:52px 0 calc\(var\(--shelf-drop\) - var\(--shelf-contact\)\)|--shelf-head:52px/);
});
