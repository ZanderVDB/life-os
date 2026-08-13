/**
 * Phase S2 — the resting Book tuning tokens.
 *
 * The Book system was close but read too flat and straight-on. Rather than
 * another conceptual pass, the resting pose is now four numbers in one place, so
 * the look can be tuned by saying "gap 7px, lean 3deg" instead of by
 * redesigning.
 *
 * What these tests protect is the PROPERTY that makes that possible: each token
 * exists once, is the only source of its number, and drives the geometry it
 * claims to. They deliberately do not pin the values — those are the tunable
 * part. They pin the plumbing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
const shelf = readFileSync(join(WEB, 'library-shelf.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
/* Bounded at both ends — an unbounded slice reads whatever was appended next. */
const css = html.slice(html.indexOf('LIBRARY (Phase F2)'), html.indexOf('DIARY', html.indexOf('LIBRARY (Phase F2)')));

const TOKENS = ['--lib-book-gap', '--lib-book-lean', '--lib-book-top-tilt', '--lib-book-depth'];

/* ── §2/§3  The tokens ──────────────────────────────────────────────────── */

test('s2: every tuning token is declared exactly once', () => {
  /* The point of the phase. A number that appears in two places is a number you
   * cannot tune by changing one of them. */
  for (const t of TOKENS) {
    const declared = (css.match(new RegExp(`${t}\\s*:`, 'g')) ?? []).length;
    assert.equal(declared, 1, `${t} is declared ${declared} times`);
  }
});

test('s2: the tokens are declared together, in the tuning block', () => {
  const block = css.slice(css.indexOf('RESTING BOOK TUNING'), css.indexOf('.lib-book{--bw'));
  for (const t of TOKENS) assert.ok(block.includes(t), `${t} is not in the tuning block`);
  // Values are readable, and each carries a unit that matches its job.
  assert.match(block, /--lib-book-gap:\s*\d+px/);
  assert.match(block, /--lib-book-lean:\s*[\d.]+deg/);
  assert.match(block, /--lib-book-top-tilt:\s*[\d.]+deg/);
  assert.match(block, /--lib-book-depth:\s*\d+px/);
});

test('s2: the starting values are inside their documented safe ranges', () => {
  const num = (t: string) => Number(css.match(new RegExp(`${t}:\\s*([\\d.]+)`))![1]);
  assert.ok(num('--lib-book-gap') >= 2 && num('--lib-book-gap') <= 10);
  assert.ok(num('--lib-book-lean') >= 0 && num('--lib-book-lean') <= 4);
  assert.ok(num('--lib-book-top-tilt') >= 0 && num('--lib-book-top-tilt') <= 7);
  assert.ok(num('--lib-book-depth') >= 0 && num('--lib-book-depth') <= 14);
});

/* ── §4–§7  Each token drives the thing it names ───────────────────────── */

test('s2: the gap is token-driven, not a literal', () => {
  assert.match(css, /\.lib-shelf-book \.lib-row,\.lib-shelf-personal \.lib-row\{column-gap:var\(--lib-book-gap\)\}/);
});

test('s2: lean, tilt and depth all come from tokens, in one transform', () => {
  const stand = css.match(/\.lib-stand\{[^}]*\}/)![0];
  assert.match(stand, /rotateX\(var\(--lib-book-top-tilt\)\)/);
  assert.match(stand, /rotateZ\(var\(--lib-book-lean\)\)/);
  assert.match(stand, /translateZ\(var\(--lib-book-depth\)\)/);
  /* Order is load-bearing: tilt back about the base FIRST, then lean the
   * standing Book. The other way round tips it along the already-leaned axis
   * and the bottom corner lifts off the shelf. */
  assert.ok(stand.indexOf('rotateX') < stand.indexOf('rotateZ'),
    'the tilt must be applied before the lean');
});

test('s2: the tilt has a top to expose', () => {
  // A real face of the same box, not a drawn edge: t across, 126 deep.
  assert.match(shelf, /<span class="lib-face lib-head" aria-hidden="true"><span class="lib-leaves">/);
  assert.match(css, /\.lib-head\{top:0;left:0;width:var\(--bt\);height:var\(--bw\);\s*\n\s*transform:rotateX\(-90deg\);transform-origin:center top/);
});

/* ── §11/§12  It leans while standing on the shelf ─────────────────────── */

test('s2: the resting pose pivots at the bottom of the spine', () => {
  const stand = css.match(/\.lib-stand\{[^}]*\}/)![0];
  assert.match(stand, /transform-origin:left bottom/);
  /* Measured: origin resolves to `0px 215px` on a 215px Book — the bottom of
   * the spine — and every object's own box still bottoms exactly on the ledge. */
  assert.ok(!/transform-origin:(center|50%) (center|50%)/.test(stand),
    'a centre origin makes the Book float and rotate about its middle');
});

test('s2: the pose never becomes a scale', () => {
  const stand = css.match(/\.lib-stand\{[^}]*\}/)![0];
  assert.ok(!/scale/.test(stand), 'the resting pose scales');
});

/* ── §9  The pull begins from the resting orientation ──────────────────── */

test('s2: the pose unwinds with the turn, not before it', () => {
  assert.match(css, /\.lib-obj\.is-pulled \.lib-stand,\.lib-obj\.is-front \.lib-stand\{transform:none\}/);
  /* Same duration and same curve as the volume's turn, so the two read as one
   * motion. If the stand snapped to flat first there would be a visible jump
   * from leaned to square before anything rotated. */
  const stand = css.match(/\.lib-stand\{[^}]*\}/)![0];
  const vol = css.match(/\.lib-vol\{[^}]*\}/)![0];
  const dur = (s: string) => s.match(/transition:transform ([^;}]+)/)![1].trim();
  for (const [name, d] of [['pose', dur(stand)], ['turn', dur(vol)]] as const) {
    assert.match(d, /var\(--d-turn/, `the ${name} does not use the shared turn duration`);
    assert.match(d, /var\(--e-out\)/, `the ${name} does not use the shared curve`);
  }
});

/* ── §10  Hit accuracy survives the new frame ──────────────────────────── */

test('s2: the stand takes no pointer input', () => {
  /* It is transformed, so its hit box is its projected quad — which after a
   * lean and a tilt overhangs the neighbours. The first thing that cost was a
   * click on one Book pulling the one beside it. `.lib-obj` stays the only
   * target: untransformed, and exactly its own space on the shelf. */
  assert.match(css, /\.lib-stand\{[^}]*pointer-events:none/);
  for (const sel of ['.lib-face{', '.lib-vol{']) {
    const rule = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)) + 1);
    assert.match(rule, /pointer-events:none/, `${sel} takes pointer input`);
  }
});

test('s2: the two frames pivot about different points, on purpose', () => {
  const stand = css.match(/\.lib-stand\{[^}]*\}/)![0];
  const vol = css.match(/\.lib-vol\{[^}]*\}/)![0];
  assert.match(stand, /transform-origin:left bottom/);   // stands on the shelf
  assert.match(vol, /transform-origin:left center/);     // turns on the spine
  // Both keep the box 3D so the faces stay a solid.
  assert.match(stand, /transform-style:preserve-3d/);
  assert.match(vol, /transform-style:preserve-3d/);
});

test('s2: the markup nests stand outside volume', () => {
  assert.match(shelf, /<span class="lib-stand"><span class="lib-vol">/);
  assert.match(shelf, /<\/span><\/span>`;\s*\n\}/);
});
