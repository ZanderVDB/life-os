/**
 * Phase L3.4 — Concept C2, the refinement of the chosen direction.
 *
 * L3.3 put six directions side by side and C — Modern Library — was chosen.
 * C2 keeps C's architecture and spine browsing and adds the three things the
 * choice came with: a real physical turn from spine to cover, D's front-facing
 * treatment for everything that is not a Book, and a shelf that reads as built
 * rather than implied.
 *
 * What these tests protect:
 *
 *   1. C2 is confined to the lab. The real Library is untouched by this phase,
 *      and nothing outside `web/modules/library-lab/` knows C2 exists.
 *   2. The physical rules are deterministic. A Book is the same size on every
 *      render, because a shelf whose silhouette changes on every paint is a
 *      shelf you cannot learn the shape of.
 *   3. The turn is a STATE, not an animation. Classes and CSS own the committed
 *      appearance, so a throttled, interrupted or reduced-motion turn still
 *      lands on the right thing.
 *   4. One cover renderer. The shelf cover and the Book view's cover are the
 *      same markup, so they cannot drift again.
 *
 * These are source-level assertions on purpose. There is no DOM here, and the
 * measurements that need one were taken in the browser and are recorded in
 * `docs/library-v2-l3-c2-direction.md`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LAB = join('..', 'web', 'modules', 'library-lab');
const read = (f: string) => readFileSync(join(LAB, f), 'utf8');
/** Strip comments — an assertion that passes because of prose proves nothing. */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const c2 = code(read('concept-c2.js'));
const cover = code(read('shared-cover.js'));
const data = code(read('lab-data.js'));
const view = code(read('lab-view.js'));
const css = read('lab.css');
const WEB = join('..', 'web');
const libShelf = code(readFileSync(join(WEB, 'library-shelf.js'), 'utf8'));
const libView = code(readFileSync(join(WEB, 'library-view.js'), 'utf8'));
const indexHtml = readFileSync(join(WEB, 'index.html'), 'utf8');

/* The C2 region of the stylesheet. Scanning the whole file would let a rule
 * belonging to one of the six frozen concepts satisfy a C2 assertion. */
const C2CSS = css.slice(css.indexOf('CONCEPT C2'));

/* ── §1  C2 is isolated ──────────────────────────────────────────────── */

test('c2: the real Library does not know it exists', () => {
  for (const [name, src] of [['library-shelf.js', libShelf], ['library-view.js', libView]] as const) {
    assert.ok(!src.includes('concept-c2'), `${name} imports C2`);
    assert.ok(!src.includes('shared-cover'), `${name} imports the lab cover renderer`);
    assert.ok(!/\bc2-/.test(src), `${name} uses a C2 class`);
  }
  // And no C2 markup or styling has leaked into the shipped page.
  assert.ok(!/\bc2-(vol|slot|niche|ledge|spine|cover)\b/.test(indexHtml),
    'index.html carries C2 styling');
});

test('c2: it reaches the browser only through the lab route', () => {
  /* Same gate as every other concept: a lazy import from lab-view, which itself
   * only runs after the server has said the lab is allowed. */
  assert.match(view, /id: 'c2',[\s\S]*?mod: \(\) => import\('\.\/concept-c2\.js'\)/);
  assert.match(view, /if \(!\(await labAllowed\(\)\)\) return false;/);
  // C2 is the default mount, because it is the concept under development.
  assert.match(view, /await mount\(stage, current \?\? 'c2', nav\);/);
});

test('c2: the lab still writes nothing', () => {
  /* The concept renders literals. If it could fetch, it could write. */
  assert.ok(!/\bfetch\(|ctx\.api\(|XMLHttpRequest/.test(c2), 'C2 makes a request');
  assert.ok(!/\bfetch\(|ctx\.api\(/.test(cover), 'the cover renderer makes a request');
  assert.ok(!/\bfetch\(|ctx\.api\(/.test(data), 'the lab data makes a request');
});

/* ── §7  Height: deterministic, five steps ───────────────────────────── */

test('c2: a Book is the same height on every render', () => {
  assert.ok(!/Math\.random/.test(cover), 'height is randomised');
  assert.match(cover, /export function bookHeight\(id\)/);
  assert.match(cover, /n = \(n \* 31 \+ ch\.charCodeAt\(0\)\) % 997/);
  assert.match(cover, /const step = n % 5;/);
  assert.match(cover, /Math\.round\(BOOK_H \* \(0\.905 \+ step \* 0\.0475\)\)/);
});

test('c2: the height steps span 172–208px and there are exactly five', () => {
  const H = 190;
  const heights = [0, 1, 2, 3, 4].map((s) => Math.round(H * (0.905 + s * 0.0475)));
  assert.deepEqual(heights, [172, 181, 190, 199, 208]);
  /* ±9.5% around the base. Enough that the skyline is uneven, not so much that
   * a short Book looks like a different kind of object. */
  assert.equal(new Set(heights).size, 5);
});

/* ── §8/§42  Thickness: from the content, clamped ────────────────────── */

test('c2: thickness comes from page count, by square root, clamped', () => {
  assert.match(cover, /export const THICK_MIN = 26;/);
  assert.match(cover, /export const THICK_MAX = 58;/);
  assert.match(cover, /THICK_MIN \+ Math\.round\(Math\.sqrt\(p\) \* 2\.2\)/);
  assert.match(cover, /Math\.min\(THICK_MAX, Math\.max\(THICK_MIN, t\)\)/);

  const thick = (pages: number) => {
    const p = Math.max(0, Number(pages) || 0);
    return Math.min(58, Math.max(26, 26 + Math.round(Math.sqrt(p) * 2.2)));
  };
  /* An empty Book is the minimum, not zero: a Book you have not written in is
   * still a Book on the shelf. */
  assert.equal(thick(0), 26);
  assert.equal(thick(8), 32);
  assert.equal(thick(25), 37);
  assert.equal(thick(60), 43);
  assert.equal(thick(150), 53);
  // The tail is flattened rather than allowed to run away.
  assert.equal(thick(500), 58);
  assert.equal(thick(5000), 58);
  // Nonsense in, minimum out — never a negative or NaN width.
  assert.equal(thick(-40), 26);
  assert.equal(thick(NaN as unknown as number), 26);
});

test('c2: the cover depth follows thickness but stays a detail', () => {
  assert.match(cover, /Math\.min\(10, Math\.max\(4, Math\.round\(thickness \* 0\.18\)\)\)/);
  const depth = (t: number) => Math.min(10, Math.max(4, Math.round(t * 0.18)));
  assert.equal(depth(26), 5);
  assert.equal(depth(58), 10);
  /* Bounded, because past ~10px the page block stops reading as the edge of a
   * Book and starts reading as a second object standing beside it. */
  assert.equal(depth(200), 10);
  assert.equal(depth(4), 4);
});

test('c2: every Book carries a page count, so no Book falls back to a guess', () => {
  const from = data.indexOf('export const BOOKS');
  const books = data.slice(from, data.indexOf('\n];', from));
  const entries = books.match(/\{ id: '[^']+',[^}]*\}/g) ?? [];
  assert.ok(entries.length >= 8, 'the sample lost its books');
  for (const e of entries) assert.match(e, /pages: \d+/, `a Book has no page count: ${e}`);
  assert.match(data, /pages: 120/);          // the Diary
});

/* ── §14  The Diary is a Book on the Books shelf ─────────────────────── */

test('c2: the Diary stands first among the Books, not in a bay of its own', () => {
  assert.match(c2, /const shelfBooks = \(\) => \[DIARY, \.\.\.BOOKS\];/);
  // One Books bay, and it is built from that list.
  assert.match(c2, /bay\('Books', books\.map\(\(b, i\) => volume\(b, i, books\.length\)\)/);
  assert.ok(!/bay\('Diary'|bay\('Journal'/.test(c2), 'the Diary was given its own bay');
});

test('c2: the system Book is marked by material, not by a control', () => {
  assert.match(c2, /class="c2-vol\$\{b\.system \? ' is-system' : ''\}"/);
  // Material only: an edge colour and a cloth. No badge, no lock, no button.
  assert.match(C2CSS, /\.c2-vol\.is-system \.c2-spine\{box-shadow:inset 1\.5px 0 0 rgba\(182,155,240,\.55\)/);
  assert.match(C2CSS, /\.c2-vol\.is-system \.c2-cover\{box-shadow:inset 3px 0 0 0 var\(--a-lavender\)\}/);
  // It turns and opens exactly like every other Book.
  assert.ok(!/is-system[\s\S]{0,400}(pointer-events|cursor:default|disabled)/.test(C2CSS),
    'the system Book was made un-openable');
});

/* ── §5/§6  The turn is a state ──────────────────────────────────────── */

test('c2: spine and cover are two faces of one box, hinged at the spine', () => {
  /* Not two elements swapped. If they were, the turn would be a crossfade
   * wearing a rotation, and an interrupted one would leave nothing on screen. */
  assert.match(c2, /<span class="c2-face c2-spine">/);
  assert.match(c2, /<span class="c2-face c2-front">/);
  assert.match(c2, /<span class="c2-face c2-edge"><\/span>/);
  assert.match(C2CSS, /\.c2-box\{[^}]*transform-origin:left center/);
  assert.match(C2CSS, /\.c2-front\{left:0;width:126px;transform:rotateY\(90deg\);transform-origin:left center/);
});

test('c2: the committed cover state is a class the stylesheet owns', () => {
  assert.match(C2CSS, /\.c2-vol\.is-cover \.c2-box\{transform:rotateY\(-90deg\)\}/);
  // Nothing writes a transform from JavaScript, so nothing can strand one.
  assert.ok(!/style\.transform|style\.setProperty\('transform/.test(c2),
    'C2 sets a transform from script');
  assert.ok(!/requestAnimationFrame|setTimeout|transitionend/.test(c2),
    'C2 drives the turn from a timer or an event');
});

test('c2: turning is a toggle of exactly one Book', () => {
  assert.match(c2, /let turned = null;/);
  assert.match(c2, /const toCover = \(obj\) => \{[\s\S]*?toSpine\(\);[\s\S]*?turned = obj;/);
  assert.match(c2, /obj\.classList\.add\('is-cover'\)/);
  assert.match(c2, /obj\.classList\.remove\('is-cover'\)/);
});

test('c2: the turned Book announces itself, and gets its name back', () => {
  assert.match(c2, /aria-expanded="false"/);
  assert.match(c2, /setAttribute\('aria-expanded', 'true'\)/);
  assert.match(c2, /setAttribute\('aria-expanded', 'false'\)/);
  assert.match(c2, /cover view\. Press again to open\./);
  /* The resting label is REMEMBERED rather than reconstructed, so returning to
   * the spine restores "3 of 9" rather than dropping the position. */
  assert.match(c2, /if \(!obj\.dataset\.label\) obj\.dataset\.label = obj\.getAttribute\('aria-label'\)/);
  assert.match(c2, /obj\.dataset\.label \?\?/);
});

test('c2: the keyboard can turn, open, and reverse', () => {
  assert.match(c2, /role="button" tabindex="0"/);
  assert.match(c2, /if \(e\.key !== 'Enter' && e\.key !== ' '\) return;/);
  assert.match(c2, /if \(e\.key === 'Escape' && turned\) \{ e\.preventDefault\(\); toSpine\(\{ focus: true \}\); return; \}/);
  // Escape returns focus to the Book it reversed, not to the page.
  assert.match(c2, /if \(focus && obj\.isConnected\) obj\.focus\(\{ preventScroll: true \}\)/);
});

test('c2: a second activation opens; the first only turns', () => {
  assert.match(c2, /if \(obj === turned \|\| e\.target\.closest\('\[data-open\]'\)\) \{[\s\S]*?lab-open/);
  assert.match(c2, /toCover\(obj\);/);
});

/* ── §13  Neighbours make room by layout ─────────────────────────────── */

test('c2: the slot owns the width, so neighbours slide instead of colliding', () => {
  /* Measured at 1280: turning a 53px Book widened its slot to 136px and the
   * three Books to its right moved exactly +83px. Absolute positioning would
   * have needed every neighbour to be told; layout tells them. */
  assert.match(C2CSS, /\.c2-slot\{[^}]*width:var\(--t\)/);
  assert.match(C2CSS, /\.c2-slot\{[^}]*transition:width 300ms/);
  assert.match(C2CSS, /\.c2-slot:has\(\.is-cover\)\{width:calc\(126px \+ var\(--d\)\)\}/);
  assert.match(c2, /class="c2-slot" style="--t:\$\{t\}px;--h:\$\{h\}px;--d:\$\{d\}px"/);
});

/* ── §19  The shelf is built ─────────────────────────────────────────── */

test('c2: the shelf has a back panel, uprights, a ledge and a front face', () => {
  assert.match(C2CSS, /\.c2-niche\{[\s\S]*?linear-gradient\(180deg,#1E1928/);          // back panel
  assert.match(C2CSS, /\.c2-niche::before,\.c2-niche::after\{content:'';position:absolute/); // uprights
  assert.match(C2CSS, /\.c2-ledge\{position:absolute;left:0;right:0;bottom:0;height:9px/);   // ledge
  assert.match(C2CSS, /box-shadow:0 9px 17px -8px rgba\(0,0,0,\.85\)/);                      // its cast shadow
  // Uprights at the boundaries only — one at each end, never between Books.
  assert.match(C2CSS, /\.c2-niche::before\{left:0\}/);
  assert.match(C2CSS, /\.c2-niche::after\{right:0/);
  assert.ok(!/\.c2-slot::(before|after)\{content:''[^}]*background:linear-gradient\(90deg,#2C2539/.test(C2CSS),
    'an upright was drawn between every Book');
});

test('c2: every bay is built the same way', () => {
  assert.match(c2, /const bay = \(label, inner, cls = ''\) => `<section class="c2-bay \$\{cls\}">/);
  assert.match(c2, /<div class="c2-niche">[\s\S]*?<span class="c2-ledge" aria-hidden="true">/);
  // Four bays, one construction.
  for (const label of ['Books', 'Documents', 'Media', 'Links & Files']) {
    assert.ok(c2.includes(`bay('${label}'`), `no ${label} bay`);
  }
});

/* ── §10/§35  One cover ──────────────────────────────────────────────── */

test('c2: the shelf cover is the Book view cover, not a copy of it', () => {
  /* The class names are the real ones, in the real order, so the cover inherits
   * the real typography rather than carrying a second set that can drift. */
  const order = ['bk-cover-mark', 'bk-cover-pre', 'bk-cover-title', 'bk-cover-sub',
    'bk-cover-rule', 'bk-cover-author'];
  let at = -1;
  for (const cls of order) {
    const i = cover.indexOf(cls);
    assert.ok(i > at, `${cls} is missing or out of order in the shared cover`);
    at = i;
  }
  assert.match(c2, /\$\{bookCoverHtml\(b\)\}/);
});

test('c2: only SCALE is restated on the shelf, through one variable', () => {
  assert.match(C2CSS, /\.c2-cover\{--cv:0\.235;/);
  const block = C2CSS.slice(C2CSS.indexOf('.c2-cover{'), C2CSS.indexOf('.c2-open{'));
  const sizes = block.match(/font-size:[^;]+/g) ?? [];
  assert.ok(sizes.length >= 5, 'the shelf cover stopped scaling its type');
  for (const s of sizes) {
    assert.match(s, /var\(--cv\)/, `a shelf cover size is a hard-coded second value: ${s}`);
  }
});

test('c2: nothing is printed underneath the cover', () => {
  /* The cover already says what the Book is. A title repeated below it is a
   * product card, and it is what made the old shelf read as a catalogue. */
  const front = c2.slice(c2.indexOf('c2-face c2-front'), c2.indexOf('c2-face c2-edge'));
  assert.match(front, /bookCoverHtml\(b\)/);
  assert.match(front, /<span class="c2-open" data-open>Open<\/span>/);
  assert.ok(!/c2-(foot|meta|caption|label)\b/.test(front), 'the cover grew a caption');
  // The one affordance lives inside the cover, and only while pointed at.
  assert.match(C2CSS, /\.c2-open\{position:absolute;left:0;right:0;bottom:0/);
  assert.match(C2CSS, /\.c2-open\{[^}]*opacity:0/);
  assert.match(C2CSS, /\.c2-vol\.is-cover:hover \.c2-open,\.c2-vol\.is-cover:focus-visible \.c2-open\{opacity:1\}/);
});

/* ── §22–§27  Non-Books are not Books ────────────────────────────────── */

test('c2: Documents, media, links and files face front and never rotate', () => {
  for (const fn of ['portfolio', 'sleeve', 'clipping', 'jacket']) {
    assert.ok(c2.includes(`const ${fn} = (`), `no ${fn} renderer`);
  }
  // None of them borrows the Book's box, spine or hinge.
  const flat = c2.slice(c2.indexOf('const portfolio'), c2.indexOf('const bay'));
  assert.ok(!/c2-box|c2-spine|c2-face/.test(flat), 'a non-Book borrowed the Book physics');
  assert.ok(!/rotateY/.test(C2CSS.slice(C2CSS.indexOf('.c2-port,'))),
    'a non-Book rotates');
  // They come forward instead, on the same 140ms as every other hover.
  assert.match(C2CSS, /\.c2-port:hover,\.c2-media:hover,\.c2-clip:hover,\.c2-file:hover\{transform:translateY\(-4px\)\}/);
});

test('c2: every object on the shelf is reachable and named', () => {
  const arts = c2.match(/<article class="c2-[a-z]+"?[^>]*/g) ?? [];
  assert.ok(arts.length >= 5, 'the object renderers vanished');
  for (const a of arts) {
    assert.match(a, /role="button"/, `an object is not a control: ${a.slice(0, 40)}`);
    assert.match(a, /tabindex="0"/, `an object is not reachable: ${a.slice(0, 40)}`);
  }
  assert.equal((c2.match(/aria-label="/g) ?? []).length, 5);
});

/* ── §40  Reduced motion ─────────────────────────────────────────────── */

test('c2: reduced motion removes the travel, not the state', () => {
  const rm = C2CSS.slice(C2CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(rm, /\.c2-slot,\.c2-box,[^{]*\{transition:none !important\}/);
  assert.match(rm, /\.c2-vol:not\(\.is-cover\):hover \.c2-box\{transform:none\}/);
  /* The rotation itself is NOT cancelled: the Book still faces you, it simply
   * arrives there. A cancelled rotation would remove the information. */
  assert.ok(!/is-cover \.c2-box\{transform:none/.test(rm),
    'reduced motion cancelled the turn instead of shortening it');
  // And the turned Book is still marked, by an outline rather than by travel.
  assert.match(rm, /\.c2-vol\.is-cover \.c2-front\{box-shadow:0 0 0 2px var\(--accent-c/);
});

/* ── §31  Switching concepts leaves nothing behind ───────────────────── */

test('c2: it tears down every listener it added', () => {
  const teardown = c2.slice(c2.lastIndexOf('return () => {'));
  for (const ev of ['click', 'keydown']) {
    assert.ok(c2.includes(`root.addEventListener('${ev}'`), `no ${ev} listener`);
    assert.ok(teardown.includes(`root.removeEventListener('${ev}'`), `${ev} is never removed`);
  }
  assert.match(c2, /r\.addEventListener\('scroll', onScroll, \{ passive: true \}\)/);
  assert.match(teardown, /r\.removeEventListener\('scroll', onScroll\)/);
  assert.match(teardown, /turned = null;/);
  // The lab unmounts before it mounts, and a broken concept cannot wedge it.
  assert.match(view, /function unmount\(stage\) \{\s*\n\s*try \{ teardown\?\.\(\); \} catch/);
});

test('c2: scrolling a shelf away returns the turned Book', () => {
  /* The same rule the real Library applies to a pulled object: something held
   * open over a shelf that has moved on is in the wrong place. */
  assert.match(c2, /if \(Math\.abs\(rail\.scrollLeft - from\) > 64\) toSpine\(\);/);
  assert.match(c2, /if \(!\(rail instanceof Element\) \|\| !rail\.contains\(turned\)\) return;/);
});

/* ── §37/§38  Collections at both ends ───────────────────────────────── */

test('c2: a new collection has something on the shelf', () => {
  /* Three starter Books, all at the minimum thickness, so a shelf with nothing
   * written in it is still legible as a shelf. */
  assert.match(data, /export const STARTER_BOOKS = \[/);
  const starter = data.slice(data.indexOf('STARTER_BOOKS'), data.indexOf(']', data.indexOf('STARTER_BOOKS')));
  assert.equal((starter.match(/\{ id: 's\d'/g) ?? []).length, 3);
  for (const t of ['Notes', 'Ideas', 'Learning']) assert.ok(starter.includes(t), `no ${t} starter`);
});

test('c2: a large collection scrolls rather than shrinking', () => {
  /* Measured at 1280: 40 Books gave a 1824px row inside an 897px shelf, which
   * scrolls. Nothing compresses, so a Book means the same thing at any count. */
  assert.match(C2CSS, /\.c2-row\{list-style:none;margin:0;padding:0;display:flex;align-items:flex-end;\s*\n\s*width:max-content;min-width:100%/);
  assert.match(C2CSS, /\.c2-scroll\{overflow-x:scroll/);
  assert.match(C2CSS, /\.c2-slot\{flex:0 0 auto/);
});
