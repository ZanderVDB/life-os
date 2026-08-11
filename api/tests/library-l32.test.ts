/**
 * Phase L3.2 — the Library's physical object model.
 *
 * L3.1 fixed the interaction. The review then said the shelf still did not read
 * as a Library, and named why: overlapped books looked like layered cards, the
 * pulled book went soft, the Open action was a badge stuck on the cover, and
 * Personal, Books and Documents sat at visibly different heights.
 *
 * Three rules came out of it, and this file exists to keep them:
 *
 *   1. ONE PLANE. Every object's bottom sits the same distance from its shelf's
 *      ledge, whatever the object is and whatever shelf it is on.
 *   2. ONE PHYSICS. Every object lifts by the same amount, with the same
 *      shadows, and nothing scales.
 *   3. THE PULLED STATE IS THE BEST STATE. If an effect makes the chosen object
 *      softer or harder to read, the effect goes.
 *
 * Measurements are quoted where a number came from one.
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

const html = read('index.html');
const shelf = code(read('library-shelf.js'));
const view = code(read('library-view.js'));

/* ── §10  One shelf plane ────────────────────────────────────────────── */

test('baseline: one formula, and no shelf may opt out of it', () => {
  /* MEASURED DEFECT. Before this phase: contact gap Diary −6px, Book +36px,
   * Document +36px. The Diary hung 42px lower than everything else relative to
   * its own shelf, because the personal rail carried its own padding and the
   * ledge is drawn from the rail's bottom edge.
   *
   * After: Diary, Book, Document, Media, Clippings and Recently opened all at
   * exactly 18px. One distinct value across six shelves and four object types. */
  assert.match(html, /--shelf-drop:30px;/);
  assert.match(html, /--shelf-contact:4px;/);
  assert.match(html, /padding:var\(--shelf-head\) 0 calc\(var\(--shelf-drop\) \+ var\(--shelf-contact\)\)/);
  // No shelf sets its own rail padding. That is what broke it.
  assert.ok(!/\.lib-shelf-\w+ \.lib-rail\{[^}]*padding/.test(html),
    'a shelf overrides the rail padding, which puts its objects on another plane');
});

test('baseline: every rail reserves its scrollbar, full or not', () => {
  /* The second half of the same defect, and subtler. A horizontal scrollbar
   * lives inside the rail's border box, so a shelf that OVERFLOWS is 10px
   * shorter in content than one that fits — and the ledge is drawn from that
   * bottom edge. Measured: books rail offsetHeight 287 against clientHeight
   * 277, personal rail 242 against 242, which left the Diary 10px out even
   * after the padding was unified.
   *
   * `scrollbar-gutter: stable` does NOT fix it: that property reserves the
   * inline gutter, not the block-end one. `overflow-x: scroll` does. */
  assert.match(html, /\.lib-rail\{overflow-x:scroll/);
  assert.ok(!/\.lib-rail\{[^}]*overflow-x:auto/.test(html),
    'a rail that only scrolls when full sits on a different plane from one that does not');
});

/* ── §2/§23/§24  Density by collection size ──────────────────────────── */

test('density: books touch when a shelf is dense, and sit apart when it is not', () => {
  /* L3.1 used one formula at every size: 64px of overlap on a 150px object, so
   * each book showed 86px and the NEXT book's dark spine landed in the middle
   * of the previous cover. Cover / dark band / cover / dark band is a card
   * stack, which is exactly what the review saw.
   *
   * The overlap is gone entirely rather than reduced. Books TOUCH on a dense
   * shelf — each page block against the next spine, which is what books on a
   * shelf actually do — and sit 16px apart below four objects, so two Books
   * read as two Books. Measured: step per book 150 → 154 with a 16px gap at
   * three books, and 154 with a 0px gap at twelve. */
  assert.match(shelf, /const dense = n >= 4;/);
  assert.match(shelf, /<div class="lib-rail\$\{dense \? ' is-dense' : ''\}"/);
  assert.match(html, /\.lib-shelf-book \.lib-row\{column-gap:16px\}/);
  assert.match(html, /\.lib-rail\.is-dense \.lib-row\{column-gap:0\}/);
  assert.ok(!/--overlap/.test(html), 'the overlap is back');
  /* Scoped to the shelf region: the stylesheet has perfectly good negative
   * margins elsewhere (the Today toolbar, the Steps list), and a scan of the
   * whole file would be asserting against the alphabet rather than the design. */
  const shelfCss = html.slice(html.indexOf('.lib-rail{'), html.indexOf('.lib-hits'));
  assert.ok(!/margin-left:calc/.test(shelfCss), 'a negative margin is pulling objects together');
});

/* ── §3  One solid object ────────────────────────────────────────────── */

test('silhouette: spine, cover and fore-edge, all locked to one height', () => {
  /* Three parts, and the fore-edge is the one L3.1 was missing. A card has no
   * page block; adding one is most of what makes the thing read as bound.
   *
   * All three heights derive from the SAME expression, so they cannot drift.
   * `aspect-ratio` used to size the cover and it yields to content — measured
   * a sample Book at 212.7px against the Diary's 178.2 because its cover had a
   * subtitle. Every book is now 178.19px. */
  assert.match(html, /\.lib-book\{--bw:126px;--spine-w:22px;--edge-w:6px\}/);
  assert.match(html, /\.lib-spine\{[^}]*height:calc\(var\(--bw\) \* 297 \/ 210\)/);
  assert.match(html, /\.lib-cover\{[\s\S]{0,120}?height:calc\(var\(--bw\) \* 297 \/ 210\);overflow:hidden/);
  assert.match(html, /\.lib-block\{[^}]*height:calc\(var\(--bw\) \* 297 \/ 210 - 4px\)/);
  assert.ok(!/\.lib-cover\{[^}]*aspect-ratio/.test(html),
    'the cover is sized by a ratio again, so a fuller cover will grow');
  // Drawn in the order a book is built.
  const book = shelf.slice(shelf.indexOf('export function bookObjectHtml'));
  const body = book.slice(0, book.indexOf('\n}'));
  assert.ok(body.indexOf('lib-spine') < body.indexOf('lib-block'), 'the fore-edge precedes the spine');
  assert.ok(body.indexOf('lib-block') < body.indexOf('lib-cover'), 'the cover precedes the fore-edge');
});

test('silhouette: the fore-edge is paper, and the hinge is a fold', () => {
  // Finely lined, so it reads as a page block rather than as a bar.
  assert.match(html, /\.lib-block\{[\s\S]*?repeating-linear-gradient\(90deg,\s*\n?\s*rgba\(255,255,255,\.10\) 0 1px,transparent 1px 2px\)/);
  // The radii meet: the spine rounds outward on the left, the block on the right.
  assert.match(html, /\.lib-spine\{[^}]*border-radius:2px 0 0 2px/);
  assert.match(html, /\.lib-block\{[^}]*border-radius:0 2px 2px 0/);
  // And the hinge is drawn on the COVER, lit to match the spine's falloff.
  assert.match(html, /\.lib-cover::before\{content:'';position:absolute;left:0;top:0;bottom:0;width:10px/);
});

/* ── §5/§27  Crispness ───────────────────────────────────────────────── */

test('crispness: the pulled object is translated by whole device pixels, never scaled', () => {
  /* ROOT CAUSE, found by measurement rather than guessed. L3.1 pulled with
   * `translateY(-22px) scale(1.06)`. A non-integer scale resamples everything
   * inside: a 126px cover became 133.56px, and every glyph was redrawn on a
   * grid it had not been laid out on. That is the softness the review saw.
   *
   * The fix is not a smaller scale, it is no scale. Measured after: the cover
   * is 126.000px in both states, the title box is 45.4844px wide in both, the
   * horizontal position is identical, and the vertical offset is exactly
   * 30.0000 — so the subpixel phase is unchanged and the rasterisation is the
   * same. §5's rule, satisfied by construction.
   *
   * 32px rather than 30: the travel must land on a whole DEVICE pixel at every
   * supported ratio, and 30 × 1.25 = 37.5. Any multiple of four is exact at 1,
   * 1.25, 1.5 and 2. */
  assert.match(html, /\.lib-obj\.is-pulled\{transform:translateY\(-32px\);z-index:6\}/);
  assert.match(html, /\.lib-res\.is-pulled\{transform:translateY\(-32px\)\}/);
  assert.equal(32 % 4, 0, 'the pull distance must be a multiple of 4 to be device-pixel exact at DPR 1.25');
  assert.equal(48 % 4, 0, 'the opening distance must be device-pixel exact too');
  // No scale anywhere in a state that contains type.
  const states = [...html.matchAll(/\.lib-(obj|res)[.:][^{]*\{[^}]*\}/g)].map((m) => m[0]);
  const scaled = states.filter((r) => /transform:[^;}]*scale\(/.test(r));
  assert.deepEqual(scaled, [],
    `a state scales live typography: ${scaled[0]}`);
  // …and no filter, which is the other way to soften something.
  assert.ok(!/\.lib-(obj|res|cover|spine)[^{]*\{[^}]*filter:/.test(html),
    'a filter is applied to a shelf object');
});

/* ── §6/§21  One depth cue, and hover below pull ─────────────────────── */

test('depth: hover is smaller than a pull, and reveals nothing', () => {
  /* §21. Hover says "this responds"; pulling says "this one". 3px against 32,
   * and only the pull reveals the footer. */
  assert.match(html, /\.lib-obj:hover\{transform:translateY\(-3px\);z-index:3\}/);
  /* What hover must not reveal is the FOOTER. It may reveal the overflow menu
   * -- that is a pointer affordance and it lives at the other end of the object
   * -- and it may adjust the contact shadow. Asserting "hover reveals nothing
   * with opacity:1" caught both of those and was simply wrong about the design;
   * the rule is about the footer, so the test is about the footer. */
  assert.ok(!/\.lib-obj:hover[^{]*\.lib-foot/.test(html), 'hover reveals the footer');
  assert.match(html, /\.lib-obj\.is-pulled \.lib-foot\{opacity:1/);
});

test('depth: one strong cue, not three competing ones', () => {
  /* §6 — "Do not combine large distance + large scale + large shadow." The
   * distance is the cue. The shadow supports it and the scale does not exist. */
  const pulled = html.match(/\.lib-obj\.is-pulled\{[^}]*\}/)![0];
  assert.ok(!/scale\(/.test(pulled), 'the pulled state scales');
  assert.ok(!/rotate/.test(pulled), 'the pulled state rotates');
  assert.match(pulled, /translateY\(-32px\)/);
});

/* ── §7  Local breathing room ────────────────────────────────────────── */

test('space: the neighbours step aside without the rail reflowing', () => {
  /* Measured: pulling a book moved the object before it 16px left and the one
   * after it 16px right, with no change to the rail's scroll width. A transform
   * on two siblings, so nothing is measured and nothing that is not adjacent
   * moves at all. */
  assert.match(html, /\.lib-slot:has\(\.is-pulled\) \+ \.lib-slot\{transform:translateX\(16px\)\}/);
  assert.match(html, /\.lib-slot:has\(\+ \.lib-slot \.is-pulled\)\{transform:translateX\(-16px\)\}/);
});

/* ── §8/§9  The Open action, and the overflow menu ───────────────────── */

test('open action: a footer under the object, never a chip on the cover', () => {
  /* The review rejected a bright purple pill floating over the artwork. The
   * title, the subtitle and the Open action now share one footer beneath the
   * object, at the object's own width, inside the shelf's label zone.
   * Measured: footer width 154px against an object width of 154px, sitting
   * below the object's bottom edge. */
  assert.match(shelf, /const objectFoot = \(title, sub, action\)/);
  assert.match(html, /\.lib-foot\{position:absolute;left:0;right:0;top:100%/);
  assert.match(html, /\.lib-foot-a\{display:inline-flex/);
  // Nothing is positioned over the cover.
  assert.ok(!/\.lib-foot\{[^}]*bottom:/.test(html), 'the footer is anchored inside the object');
  assert.ok(!html.includes('lib-obj-pull'), 'the Open pill is back');
  // The action is text with an arrow, in the accent, not a filled button.
  const act = html.match(/\.lib-foot-a\{[^}]*\}/)![0];
  assert.ok(!/background:/.test(act), 'the Open action is a filled button again');
  assert.match(act, /color:var\(--accent\)/);
});

test('open action: the overflow menu sits at the opposite end', () => {
  /* §9 — they used to compete for the same corner. The menu is at the object's
   * TOP, the Open action at its bottom. Measured: menu 5px from the object's
   * top edge, footer 163px below the menu's bottom. */
  assert.match(html, /\.lib-obj-more\{position:absolute;right:4px;top:5px/);
  // Pressing the menu never opens the object.
  assert.match(shelf, /if \(more\) \{ e\.stopPropagation\(\); onMenu\?\.\(more, more\.dataset\.more\); return; \}/);
  assert.match(view, /if \(more\) \{ e\.stopPropagation\(\); openItemMenu\(more, more\.dataset\.more\); return; \}/);
  // …and an open menu does not leave the object looking chosen.
  assert.match(view, /if \(e\.target\.closest\('\.lib-obj'\) \|\| e\.target\.closest\('\.lib-menu'\)\) return;/);
});

/* ── §12  One contact-shadow grammar ─────────────────────────────────── */

test('shadow: contact and depth are two different shadows with two meanings', () => {
  /* Not an elevation scale. A resting object here casts NOTHING — it has a
   * tight contact ellipse where it meets the shelf and a 2px edge, and that is
   * all. The cast shadow appears only when it lifts, and the contact shrinks
   * and fades at the same time, which is how a real object leaving a surface
   * behaves. */
  assert.match(html, /--obj-edge:0 2px 4px -2px rgba\(0,0,0,\.5\)/);
  assert.match(html, /--obj-lift:0 18px 30px -14px rgba\(0,0,0,\.68\)/);
  assert.match(html, /\.lib-obj::after\{content:'';position:absolute;left:6%;right:6%;bottom:-3px;height:7px/);
  assert.match(html, /\.lib-obj\.is-pulled::after\{transform:scaleX\(\.84\) scaleY\(1\.5\) translateY\(6px\);opacity:\.5\}/);
  // Every face uses the SAME two tokens, so a Document and a Book cannot drift.
  for (const face of ['.lib-cover', '.lib-res-face', '.lib-frame']) {
    const re = new RegExp(`\\${face}\\{[^}]*box-shadow:var\\(--obj-edge\\)`);
    assert.ok(re.test(html), `${face} does not use the shared edge shadow`);
  }
  assert.match(html, /\.lib-obj\.is-pulled \.lib-cover\{box-shadow:var\(--obj-lift\)\}/);
  assert.match(html, /\.lib-obj\.is-pulled \.lib-res-face\{box-shadow:var\(--obj-lift\)\}/);
  assert.match(html, /\.lib-obj\.is-pulled \.lib-frame\{box-shadow:var\(--obj-lift\)\}/);
});

/* ── §15/§16/§17  The Document folio ─────────────────────────────────── */

test('folio: paper stock, square-ish corners, a sheet edge and a tab', () => {
  /* The review said it still read as a rounded UI card, and it did: a card
   * radius plus an ambient shadow is dashboard-tile language whatever is drawn
   * inside it.
   *
   * A folio now — flatter than a book (118px against 178), landscape, a 2–3px
   * radius rather than a card radius, a sheet edge matching the book's
   * fore-edge, a filed tab, and paper stock rather than surface stock. */
  assert.match(html, /\.lib-res-face\{position:relative;display:flex;width:100%;height:118px;\s*\n?\s*border-radius:2px 3px 3px 2px/);
  assert.match(html, /background:linear-gradient\(158deg,var\(--paper\) 0%,var\(--paper-2\) 100%\)/);
  assert.match(html, /\.lib-res-edge\{position:absolute;right:0;top:3px;bottom:3px;width:5px/);
  assert.match(html, /\.lib-res-tab\{position:absolute;left:0;top:0;bottom:0;width:4px/);
  // The sheet edge is lined like the book's fore-edge — one material language.
  assert.match(html, /\.lib-res-edge\{[\s\S]*?repeating-linear-gradient\(0deg,rgba\(255,255,255,\.09\) 0 1px/);
  // It carries its own title, so it needs no detached resting label (§19).
  assert.match(shelf, /<span class="lib-res-name">\$\{esc\(item\.title\)\}<\/span>/);
  // And it is not a book: no spine anywhere near it.
  assert.ok(!/lib-res[\s\S]{0,200}lib-spine/.test(shelf), 'a folio was given a book spine');
});

test('folio: the same baseline and the same physics as a Book', () => {
  /* §16/§17 — shorter is fine; floating is not. Measured: Document bottom on
   * the same 18px contact gap as the Diary and the Books, lifting the same
   * 32px, with no scale. */
  assert.match(html, /\.lib-res\{--rw:178px;flex-direction:row;align-items:flex-end/);
  assert.match(html, /\.lib-res\.is-pulled\{transform:translateY\(-32px\)\}/);
  assert.ok(!/\.lib-res\.is-pulled\{[^}]*scale\(/.test(html), 'the folio scales when pulled');
  // Media frames share the folio's height so a mixed shelf sits on one line.
  assert.match(html, /\.lib-frame\{position:relative;display:block;width:100%;height:118px/);
});

/* ── §11  Vertical composition ───────────────────────────────────────── */

test('shelf: a real ledge, and no blank stage above it', () => {
  /* §22 — the back plane is 1.4% white, quiet enough to read as depth rather
   * than as a section band, and the objects stay the focal point. Three drawn
   * layers: back plane, lit front edge, floor wash.
   *
   * Measured: books rail height 311px → 287px for the same 178px object. */
  const rail = html.slice(html.indexOf('.lib-rail{'), html.indexOf('.lib-rail::-webkit'));
  assert.equal((rail.match(/linear-gradient/g) ?? []).length, 3,
    'the shelf should be exactly three drawn layers');
  assert.match(rail, /rgba\(255,255,255,\.014\)/);          // back plane
  assert.match(rail, /rgba\(255,255,255,\.13\) calc\(100% - var\(--shelf-drop\)\)/); // lit edge
  assert.match(html, /--shelf-head:26px;/);
});

/* ── §13/§14  Diary ──────────────────────────────────────────────────── */

test('diary: the same Book family, the same size, the same plane', () => {
  /* §14 asked for a deliberate decision. It is the SAME physical family: same
   * cover width, same spine, same fore-edge, same height, same baseline. What
   * makes it distinct is material and words — a deeper cloth, a lavender spine
   * edge, and "System journal" in its footer — never geometry. Measured: Diary
   * and Book both 154 × 178.2 with an identical 18px contact gap. */
  const diary = shelf.slice(shelf.indexOf('export function diaryObjectHtml'));
  const body = diary.slice(0, diary.indexOf('\n}'));
  assert.match(body, /class="lib-obj lib-book lib-book-system"/);
  assert.match(body, /<span class="lib-block" aria-hidden="true"><\/span>/);
  assert.match(body, /objectFoot\('My Diary', 'System journal', 'Open Diary'\)/);
  // No size override anywhere.
  assert.ok(!/\.lib-book-system\{[^}]*--bw/.test(html), 'the Diary is a different size from a Book');
  assert.match(html, /\.lib-book-system \.lib-spine\{box-shadow:inset 1\.5px 0 0 rgba\(182,155,240/);
});

/* ── §18  The open view ──────────────────────────────────────────────── */

test('open view: composed, and still honest about having no editor', () => {
  assert.match(html, /\.lib-open\{display:grid;grid-template-columns:auto minmax\(0,1fr\)/);
  assert.match(html, /\.lib-open-object \.lib-obj\{cursor:default;pointer-events:none\}/);
  assert.match(html, /\.lib-open-object \.lib-obj-more,\.lib-open-object \.lib-foot\{display:none\}/);
  assert.match(view, /This Document holds a title and a description\./);
  assert.ok(!/contenteditable/.test(view.slice(view.indexOf('<div class="lib-open">'),
    view.indexOf('</div>`;', view.indexOf('<div class="lib-open">')))),
    'the open view has an editable region');
});

/* ── §20  A resting shelf looks resting ──────────────────────────────── */

test('resting: nothing raised, nothing glowing, nothing revealed', () => {
  /* Measured on a fresh paint of the full sample: 45 objects, 0 pulled, 0 with
   * any transform, 0 visible footers. */
  assert.ok(!/\.lib-obj\{[^}]*transform:(?!\s*none)/.test(html),
    'the resting object carries a transform');
  assert.match(html, /\.lib-foot\{[^}]*opacity:0/);
  const auto = shelf.match(/classList\.add\('is-pulled'\)/g) ?? [];
  assert.equal(auto.length, 1, 'is-pulled is applied from more than one place');
});
