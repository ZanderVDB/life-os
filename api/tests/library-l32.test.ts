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

/* ── §5/§27  Crispness ───────────────────────────────────────────────── */

/* ── §6/§21  One depth cue, and hover below pull ─────────────────────── */

test('depth: one strong cue, not three competing ones', () => {
  /* §6 — "Do not combine large distance + large scale + large shadow." The
   * distance is the cue. The shadow supports it and the scale does not exist. */
  const pulled = html.match(/\.lib-obj\.is-pulled\{[^}]*\}/)![0];
  assert.ok(!/scale\(/.test(pulled), 'the pulled state scales');
  assert.ok(!/rotate/.test(pulled), 'the pulled state rotates');
  assert.match(pulled, /translateY\(-32px\)/);
});

/* ── §7  Local breathing room ────────────────────────────────────────── */

/* ── §8/§9  The Open action, and the overflow menu ───────────────────── */

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

/* ── §15/§16/§17  The Document folio ─────────────────────────────────── */

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
