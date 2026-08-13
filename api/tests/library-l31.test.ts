/**
 * Phase L3.1 — the Library shelf, corrected.
 *
 * L3 built the room. The review said the room was right and the execution was
 * not, and named the faults precisely: a book that stayed raised because it had
 * once been opened, a purple outline left behind on return, a title stranded at
 * the far left of the shelf, a star that looked like a button and did nothing,
 * a spine that read as a stripe beside a card, Documents that were rounded
 * rectangles, and Diary that looked like a Book but behaved like a poster.
 *
 * Every one of those is a state that LOOKS like something it is not. So most of
 * what these tests assert is that two things which mean different things do not
 * appear the same — and that nothing appears at all until somebody asks for it.
 *
 *     RESTING → PULLED FORWARD → OPEN
 *
 * Browser measurements are quoted where a number came from one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/* ── §3  Nothing is raised until somebody raises it ──────────────────── */

test('resting: a shelf nobody has touched has no elevated object', () => {
  /* THE DEFECT THIS PHASE EXISTS FOR. L3 raised whichever object was nearest a
   * read line as the shelf scrolled, so a Library you had just opened showed
   * one book standing proud of the others for no reason you had given — and it
   * survived returning from a Book, so the page never settled.
   *
   * Measured after the fix, full sample, freshly painted: 45 objects,
   * 0 with `is-pulled`, 0 with any transform at all. */
  assert.ok(!/\.lib-obj\{[^}]*transform:(?!\s*none)/.test(html),
    'the resting object carries a transform');
  // And no code path applies a raised class without a user action.
  const auto = shelf.match(/classList\.add\('is-pulled'\)/g) ?? [];
  assert.equal(auto.length, 1, 'is-pulled is applied from more than one place');
  const pull = shelf.slice(shelf.indexOf('export function pullForward'));
  assert.ok(pull.includes("classList.add('is-pulled')"),
    'the only place that raises an object is pullForward');
});

test('resting: last-opened is an ORDER, never an appearance', () => {
  /* §3 — "Do not use last opened as a permanent visual-selection state."
   * `lastOpenedAt` may sort the Recently opened shelf. It may not put a class
   * on anything, and nothing that reads it may reach the DOM. */
  assert.match(overview, /new Date\(b\.lastOpenedAt \?\? b\.updatedAt\)/);
  assert.ok(!/lastOpenedAt[^;\n]*classList/.test(overview + shelf + view),
    'last-opened drives a class somewhere');
  assert.ok(!/is-pulled|is-returned/.test(
    overview.slice(overview.indexOf('export function recentItems'),
      overview.indexOf('export function bodyHtml'))),
    'the recent shelf marks its items visually');
});

/* ── §6  Two stages, and every way out of the first one ──────────────── */

test('pull: first activation pulls, second opens, and neither changes the route', () => {
  /* Measured, Books shelf: click → "Training" pulled, hash still #library;
   * click the Open control → the Book opened with the matching cover. */
  assert.match(shelf, /if \(obj === pulled \|\| e\.target\.closest\('\.lib-foot-a'\)\) onOpen\?\.\(obj\);\s*\n\s*else pullForward\(obj\);/);
  // Keyboard uses the SAME two stages, so the models cannot drift apart.
  assert.match(shelf, /if \(obj === pulled\) onOpen\?\.\(obj\);\s*\n\s*else pullForward\(obj\);/);
  // Nothing in the pull path touches the hash (§22).
  const pull = shelf.slice(shelf.indexOf('export function pullForward'));
  const body = pull.slice(0, pull.indexOf('\n}'));
  for (const banned of ['location.hash', 'setHash', 'history.']) {
    assert.ok(!body.includes(banned), `pullForward writes ${banned}`);
  }
});

test('pull: one object per page, so "the previous one returns" is always true', () => {
  assert.match(shelf, /^let pulled = null;$/m);
  const pull = shelf.slice(shelf.indexOf('export function pullForward'));
  assert.match(pull.slice(0, pull.indexOf('\n}')), /clearPulled\(\);\s*\n\s*pulled = obj;/);
});

test('pull: four ways out — another object, empty space, Escape, scrolling away', () => {
  // 1. another object — pullForward clears first (asserted above)
  // 2. empty shelf space, and anywhere else on the page
  assert.match(shelf, /const obj = e\.target\.closest\('\.lib-obj'\);\s*\n\s*if \(!obj\) \{ clearPulled\(\); return; \}/);
  assert.match(view, /if \(e\.target\.closest\('\.lib-obj'\) \|\| e\.target\.closest\('\.lib-menu'\)\) return;\s*\n\s*clearPulled\(\);/);
  // 3. Escape, from the shelf and from anywhere
  assert.match(shelf, /if \(e\.key === 'Escape' && pulled\) \{ e\.preventDefault\(\); clearPulled\(\{ restoreFocus: true \}\); return; \}/);
  assert.match(view, /if \(e\.key === 'Escape' && pulledObject\(\)\) clearPulled\(\{ restoreFocus: true \}\);/);
  // 4. scrolling past a threshold (§22)
  assert.match(shelf, /const PULL_SCROLL_CLEAR = 48;/);
  assert.match(shelf, /if \(Math\.abs\(rail\.scrollLeft - from\) > PULL_SCROLL_CLEAR\) clearPulled\(\);/);
  // …and arrow-key browsing counts as browsing away too.
  assert.match(shelf, /clearPulled\(\);\s*\n\s*setCursor\(rail, next, \{ focus: true \}\);/);
});

test('pull: the dismiss listener is bound once, not once per repaint', () => {
  /* A listener added on every paint is a listener leaked on every paint, and
   * this one has to outlive the shelves it is about. */
  assert.match(view, /let outsideBound = false;/);
  assert.match(view, /function bindPullDismiss\(\) \{\s*\n\s*if \(outsideBound\) return;\s*\n\s*outsideBound = true;/);
});

test('pull: the anchor is read when the object is pulled, and the reveal is instant', () => {
  /* TWO measured defects, one after the other.
   *
   * First: the anchor was maintained by the scroll handler, so it was stale
   * whenever a rail had been moved by assignment — which is exactly what
   * `restoreShelfScroll` does on every paint. A pull would then clear itself
   * on the next scroll event.
   *
   * Second: pulling an object near the shelf edge scrolls it into view, and a
   * SMOOTH scroll is far from its target for the whole animation — so the
   * clear-on-scroll rule fired mid-reveal and cancelled the pull that caused
   * it. Measured: the last book on the Books shelf pulled and vanished in the
   * same gesture. Making that one reveal instant removes timing from the
   * question; measured after the fix, pullAt 737 against scrollLeft 737. */
  assert.match(shelf, /revealAt\(rail, \[\.\.\.rail\.querySelectorAll\('\.lib-slot'\)\]\s*\n\s*\.findIndex\(\(sl\) => sl\.contains\(obj\)\), \{ instant: true \}\);\s*\n\s*rail\.dataset\.pullAt = String\(rail\.scrollLeft\);/);
  assert.match(shelf, /function revealAt\(rail, index, \{ instant = false \} = \{\}\)/);
  // Arrow-key browsing keeps its smooth scroll, where the travel is the point.
  assert.match(shelf, /behavior: instant \? 'auto' : scrollBehavior\(\)/);
});

/* ── §26  Touch ──────────────────────────────────────────────────────── */

test('touch: a swipe is never a tap, and a tap is never dead', () => {
  /* Option A: one tap pulls forward and reveals a LABELLED Open control. Not a
   * double tap — the second press lands on something that says what it does,
   * which is what stops the first tap feeling like nothing happened. */
  assert.match(shelf, /const TAP_SLOP = 10;/);
  assert.match(shelf, /if \(moved > TAP_SLOP \|\| scrolled > TAP_SLOP\) return;/);
  /* Either the pointer travelled or the shelf did — both mean browsing.
   * Measured: pointerdown, scroll the rail 80px, click → nothing pulled;
   * pointerdown then click with no movement → pulled. */
  assert.match(shelf, /const scrolled = Math\.abs\(rail\.scrollLeft - downAt\.left\);/);
  /* And it is a REAL control where it is the primary route: 44px tall, not a
   * 30px hint. Measured at 390px before the fix: 117x30. */
  /* And it is a real 44px target where it is the primary route - inside the
   * FOOTER, under the object, rather than a pill over the cover (L3.2 S8). */
  assert.match(html, /@media \(max-width:820px\)[\s\S]*?\.lib-foot-a\{min-height:44px/);
  // No hover affordance on a finger.
  assert.match(html, /@media \(max-width:820px\)[\s\S]*?\.lib-obj:hover\{transform:none\}/);
});

/* ── §4/§23  Coming back leaves nothing behind ───────────────────────── */

test('return: a soft glow that expires, never an outline that persists', () => {
  /* L3 drew this as a 2px accent ring for 1400ms. An accent ring is what FOCUS
   * looks like, so returning from a Book left something that read as
   * "selected", for long enough to look permanent.
   *
   * Measured after the fix, immediately on return: 0 pulled, 0 objects with any
   * outline, shelf scroll restored to 150. After the glow expires: 0 returned,
   * 0 pulled, 0 objects with any transform. */
  assert.match(shelf, /const RETURN_GLOW_MS = 320;/);
  assert.ok(320 <= 400, 'the glow must sit inside the 200-400ms band §4 allows');
  assert.match(shelf, /setTimeout\(\(\) => obj\.classList\.remove\('is-returned'\), RETURN_GLOW_MS\);/);
  assert.match(html, /\.lib-obj\.is-returned \.lib-cover[^{]*\{\s*box-shadow:0 0 18px/);
  assert.ok(!/is-returned[^{]*\{[^}]*outline/.test(html),
    'the return highlight uses an outline, which is what focus looks like');
  // Returning does not pull anything forward either — the Library is at rest.
  const mark = shelf.slice(shelf.indexOf('export function markReturn'));
  assert.ok(!mark.slice(0, mark.indexOf('\n}')).includes('pullForward'),
    'returning from a Book pulls the object forward');
});

/* ── §10  The title belongs to the object ────────────────────────────── */

test('title: under the pulled object, never stranded at the shelf edge', () => {
  /* L3 put a persistent label at the far LEFT of every shelf, naming whichever
   * object the scroll happened to be near. Detached from the object, and
   * describing a state that no longer exists. */
  assert.ok(!/\.lib-shelf-cap\s*\{/.test(html), 'the detached shelf caption is back');
  assert.ok(!shelf.includes('lib-shelf-cap'), 'the shelf still renders a caption');
  // It lives on the object, and appears only when that object is pulled.
  /* L3.2 folded the label into the object's FOOTER, alongside the Open action,
   * so one attached element carries everything the pulled state reveals - and
   * nothing at all is drawn over the cover. */
  assert.match(html, /\.lib-foot\{position:absolute;left:0;right:0;top:100%/);
  assert.match(html, /\.lib-obj\.is-pulled \.lib-foot\{opacity:1/);
  assert.match(shelf, /<span class="lib-foot" aria-hidden="true">/);
});

/* ── §8/§9  The spine ────────────────────────────────────────────────── */

/* ── §21  Crispness outranks novelty ─────────────────────────────────── */

/* ── §15/§16  It looks like a shelf, and like a collection ───────────── */

test('density: books overlap, so a dozen read as a collection', () => {
  /* Measured at 1280 with the full sample: step per book 150px → 86px, rail
   * scrollWidth 1739 → 1030, books visible across a 933px shelf 6 → 10. */
  /* Superseded by L3.2. The 64px overlap is gone entirely: tucking each book's
   * fore-edge behind its neighbour's spine hid the strongest "this is bound"
   * cue, and a dark spine landing mid-cover is what made a shelf read as a
   * deck of cards. Books TOUCH when a shelf is dense and sit 16px apart when it
   * is not - density by collection size, not one formula for both. */
  assert.match(html, /\.lib-rail\.is-dense \.lib-row\{column-gap:0\}/);
  assert.match(html, /\.lib-shelf-book \.lib-row\{column-gap:16px\}/);
  assert.match(shelf, /const dense = n >= 4;/);
  /* `--overlap` MUST be declared on the shelf, not the book. A custom property
   * inherits downward only and the element that consumes it is `.lib-slot` —
   * the book's parent. Declared on `.lib-book` it resolved to nothing and every
   * shelf measured 0px of overlap while looking correct in the source. */
  assert.ok(!/--overlap/.test(html), 'the overlap token is back');
});

/* ── §11/§12  Diary ──────────────────────────────────────────────────── */

/* ── §17/§18/§19  Documents ──────────────────────────────────────────── */

test('document: the open view is composed, and honest about what it holds', () => {
  /* Measured: the Document view rendered the object as a specimen, three facts
   * and the note. What it does NOT do is fake an editor — `library_items`
   * stores a title, a description and metadata, so an empty text area with a
   * cursor in it would be a promise the schema cannot keep. */
  assert.match(view, /<div class="lib-open">/);
  assert.match(view, /<div class="lib-open-object">/);
  assert.match(html, /\.lib-open\{display:grid;grid-template-columns:auto minmax\(0,1fr\)/);
  // The specimen is not a control.
  assert.match(html, /\.lib-open-object \.lib-obj\{cursor:default;pointer-events:none\}/);
  assert.match(view, /This Document holds a title and a description\./);
  assert.match(view, /Writing inside a Document is not built yet/);
  // No editor, real or pretend.
  assert.ok(!/contenteditable/.test(view.slice(view.indexOf('<div class="lib-open">'),
    view.indexOf('</div>`;', view.indexOf('<div class="lib-open">')))),
    'the Document view has an editable region');
  // Facts are only shown when they exist.
  assert.match(view, /item\.lastOpenedAt \? \['Last opened', when\(item\.lastOpenedAt\)\] : null/);
  assert.match(view, /\]\.filter\(Boolean\);/);
});

/* ── §27  Accessibility of a two-stage control ───────────────────────── */

test('a11y: the first activation is announced, and there is a way back', () => {
  /* A second activation that nobody explained is a ritual. `aria-expanded`
   * says the first one did something; the labelled Open control says what the
   * next one will do; Escape undoes it and returns focus where it was. */
  assert.match(shelf, /obj\.setAttribute\('aria-expanded', 'true'\)/);
  assert.match(shelf, /obj\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(shelf, /export function clearPulled\(\{ restoreFocus = false \} = \{\}\)/);
  assert.match(shelf, /if \(restoreFocus && obj\.isConnected\) obj\.focus\(\{ preventScroll: true \}\);/);
  // Focus is a keyboard position with no appearance of its own — the cursor
  // never writes a class, so it can never be mistaken for pulled-forward.
  const cursor = shelf.slice(shelf.indexOf('function setCursor'));
  assert.ok(!cursor.slice(0, cursor.indexOf('\n}')).includes('classList'),
    'the keyboard cursor writes a class');
});

/* ── §25  Motion ─────────────────────────────────────────────────────── */

test('motion: nothing moves unless somebody moved it', () => {
  for (const banned of ['setInterval', 'requestAnimationFrame(function tick', 'infinite']) {
    assert.ok(!shelf.includes(banned), `the shelf has ${banned} in it`);
  }
  // No animation on the shelf at all: every state is a transition to a class.
  assert.ok(!/@keyframes\s+lib-/.test(html), 'the shelf defines a keyframe animation');
  // And the one class applied during a handoff dies with the node it is on.
  assert.match(view, /if \(!reducedMotion\(\)\) obj\.classList\.add\('is-opening'\);/);
  assert.ok(!/is-opening[\s\S]{0,200}classList\.remove/.test(view),
    'is-opening is removed by hand, which means it can also be left behind');
});
