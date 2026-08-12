/**
 * Phase L3.5 — the component lab.
 *
 * L3.4 produced a narrower question than the one it was asked: the resting
 * shelf is right, several specific things standing on it are not. Comparing
 * whole Libraries again would answer that badly, because a full concept changes
 * eight things at once and you cannot tell which one you are reacting to.
 *
 * So the lab now compares ONE DECISION AT A TIME. What these tests protect:
 *
 *   1. the comparison is fair — same data, same sizes, same positions, and only
 *      the thing under comparison changes;
 *   2. the height distribution is deterministic AND does not cycle;
 *   3. thickness still means content volume;
 *   4. a Book's hit area is its slot, in every state and at every angle — the
 *      defect this phase was called to fix;
 *   5. nothing here reaches the real Library.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LAB = join('..', 'web', 'modules', 'library-lab');
const read = (f: string) => readFileSync(join(LAB, f), 'utf8');
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const physics = code(read('book-physics.js'));
const books = code(read('lab-books.js'));
const furniture = code(read('lab-furniture.js'));
const resources = code(read('lab-resources.js'));
const shell = code(read('component-lab.js'));
const view = code(read('lab-view.js'));
const css = read('lab.css');
const CB = css.slice(css.indexOf('THE COMPONENT LAB'));

const WEB = join('..', 'web');
const web = (f: string) => code(readFileSync(join(WEB, f), 'utf8'));
const libShelf = web('library-shelf.js');
const libBook = web('library-book.js');
const libView = web('library-view.js');
const indexHtml = readFileSync(join(WEB, 'index.html'), 'utf8');

/* Re-implementations of the rules, so the assertions are about behaviour rather
 * than about the shape of the source. */
function hash32(str: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
const LADDER = [190, 200, 180, 195, 210, 185, 175, 200, 190, 215, 185, 195, 170, 205, 190, 180];
const height = (id: string) => LADDER[hash32(id) % LADDER.length];
const bind = (id: string) => (hash32(`bind:${id}`) % 5) - 2;
const thick = (pages: number, id = '') => {
  const p = Math.max(0, Number(pages) || 0);
  return Math.min(58, Math.max(26, 26 + Math.round(Math.sqrt(p) * 2.2) + (id ? bind(id) : 0)));
};
const ROW = ['diary', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8',
  ...Array.from({ length: 31 }, (_, i) => `x${String(i + 1).padStart(2, '0')}`)];

/* ── §4  The height pattern ─────────────────────────────────────────────── */

test('l35: the hash avalanches, so sequential ids are not sequential heights', () => {
  /* The whole defect. The old hash was `(n * 31 + ch) % 997` with `% 5` on the
   * end: ids b1…b8 differ in one low character, so `n` moved a little and the
   * bucket walked in order — increase, increase, increase, reset. */
  assert.match(physics, /h \^= h >>> 16; h = Math\.imul\(h, 2246822507\)/);
  assert.match(physics, /h \^= h >>> 13; h = Math\.imul\(h, 3266489909\)/);
  assert.ok(!/% 997/.test(physics), 'the old non-avalanching hash is still here');

  // Sequential ids must land on unrelated rungs.
  const seq = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'].map((id) => hash32(id) % 16);
  let inOrder = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] === (seq[i - 1] + 1) % 16) inOrder++;
  assert.ok(inOrder <= 1, `sequential ids still walk the ladder in order: ${seq}`);
});

test('l35: no ascending cycle across twenty Books', () => {
  const h = ROW.slice(0, 20).map(height);
  let run = 1; let longest = 1;
  for (let i = 1; i < h.length; i++) { run = h[i] > h[i - 1] ? run + 1 : 1; longest = Math.max(longest, run); }
  /* The old rule produced runs of five by construction. Anything up to three is
   * what an irregular sequence does by chance. */
  assert.ok(longest <= 3, `an ascending run of ${longest}: ${h.join(' ')}`);
});

test('l35: adjacent Books commonly differ, and sometimes do not', () => {
  const h = ROW.map(height);
  let same = 0;
  for (let i = 1; i < h.length; i++) if (h[i] === h[i - 1]) same++;
  const ratio = same / (h.length - 1);
  assert.ok(ratio > 0, 'no two neighbours are ever alike — that reads as generated too');
  assert.ok(ratio < 0.3, `${same}/${h.length - 1} neighbours identical`);
});

test('l35: heights are stable, bounded, and use the whole ladder', () => {
  assert.equal(height('b3'), height('b3'));
  assert.equal(height('x17'), height('x17'));
  const all = ROW.map(height);
  assert.ok(Math.min(...all) >= 170 && Math.max(...all) <= 215, 'a Book left the range');
  assert.ok(new Set(all).size >= 7, 'the silhouette uses too few distinct heights');
  // Every rung is 5px, so no neighbour pair differs by 1–2px and reads as skew.
  for (const v of new Set(all)) assert.equal(v % 5, 0, `${v} is off the 5px grid`);
  // And the ladder itself is middle-weighted rather than flat.
  assert.equal(LADDER.filter((v) => v === 190).length, 3);
  assert.equal(LADDER.filter((v) => v === 170).length, 1);
  assert.equal(LADDER.filter((v) => v === 215).length, 1);
});

/* ── §5  Thickness ──────────────────────────────────────────────────────── */

test('l35: thickness still means content volume', () => {
  assert.ok(thick(0, 'b1') < thick(60, 'b1'), 'more pages must not be thinner');
  assert.ok(thick(60, 'b1') < thick(400, 'b1'));
  assert.equal(thick(0, ''), 26);
  assert.equal(thick(5000, ''), 58);
  assert.equal(thick(-9, ''), 26);
  assert.equal(thick(NaN as unknown as number, ''), 26);
});

test('l35: the binding offset breaks ties without lying about volume', () => {
  assert.match(physics, /export function bindingOffset\(id\) \{\s*\n\s*return \(hash32\(`bind:\$\{id\}`\) % 5\) - 2;/);
  for (const id of ROW) assert.ok(Math.abs(bind(id)) <= 2, `binding offset out of range for ${id}`);
  // Two Books with the same page count are not pixel-identical twins…
  const same = ROW.map((id) => thick(60, id));
  assert.ok(new Set(same).size > 1, 'equal page counts still produce identical Books');
  /* …but ±2px can never reorder them by apparent volume: the gap between 60 and
   * 150 pages is 10px, which is more than twice the widest possible swing. */
  const lo = Math.max(...ROW.map((id) => thick(60, id)));
  const hi = Math.min(...ROW.map((id) => thick(150, id)));
  assert.ok(lo < hi, 'the offset can make a 60-page Book look thicker than a 150-page one');
});

/* ── §12/§14  The Book is a solid, and its hit area is its slot ─────────── */

test('l35: depth is translateZ, never a layout offset', () => {
  /* The bug. `left: 126px` is layout, and the box rotation maps layout-x into
   * Z — so it became 126px of depth toward the viewer and perspective threw the
   * face sideways, over the left neighbour. */
  assert.match(CB, /\.cb-edge\{left:0;width:var\(--t\);transform:translateZ\(-126px\)/);
  assert.ok(!/\.cb-edge\{[^}]*left:126px/.test(CB), 'the page block is positioned by layout again');
  // Four faces, so the pulled state can show spine, boards and page block at once.
  for (const f of ['cb-back', 'cb-edge', 'cb-spine', 'cb-front']) {
    assert.ok(books.includes(f), `the box has no ${f}`);
  }
  assert.match(CB, /\.cb-front\{transform:translateX\(var\(--t\)\) rotateY\(90deg\)\}/);
});

test('l35: nothing inside a volume takes pointer input', () => {
  /* This is what makes the hit area checkable rather than arguable: `.cb-vol`
   * is never transformed and fills its slot, so its hit box IS the slot. */
  assert.match(CB, /\.cb-face\{position:absolute;top:0;height:100%;pointer-events:none\}/);
  assert.match(CB, /\.cb-box\{[^}]*pointer-events:none\}/);
  assert.match(CB, /\.cb-vol\{position:absolute;inset:0/);
  assert.ok(!/\.cb-vol\{[^}]*transform:/.test(CB), 'the hit target itself is transformed');
});

test('l35: a turned Book reserves exactly the width it occupies', () => {
  const turnedWidth = (deg: number, t: number) => {
    const r = (Math.abs(deg) * Math.PI) / 180;
    return Math.ceil(126 * Math.abs(Math.cos(r)) + t * Math.abs(Math.sin(r)));
  };
  assert.match(physics, /export function turnedWidth\(deg, thickness\)/);
  assert.match(physics, /COVER_W \* Math\.abs\(Math\.cos\(r\)\) \+ thickness \* Math\.abs\(Math\.sin\(r\)\)/);
  // Every treatment must fit inside its own reservation.
  for (const [deg, t] of [[82, 32], [62, 32], [72, 40], [70, 26], [52, 58]] as const) {
    const w = turnedWidth(deg, t);
    assert.ok(w >= 126 * Math.abs(Math.cos((deg * Math.PI) / 180)), `${deg}° reserves too little`);
    assert.ok(w <= 126, `${deg}° reserves more than a flat cover`);
  }
  assert.match(books, /export function slotWidth\(variant, thickness, turned\)/);
});

test('l35: the slot is what widens, so neighbours slide rather than collide', () => {
  assert.match(CB, /\.cb-slot\{flex:0 0 auto;width:var\(--t\)/);
  assert.match(CB, /\.cb-slot\{[^}]*transition:width 300ms/);
  assert.match(shell, /slot\.style\.width = on \? `\$\{slotWidth\(variant, t, true\)\}px` : '';/);
});

test('l35: no treatment ends flat, so the Book stays a solid', () => {
  /* At exactly 90° the cover is axis-aligned, the spine and page block collapse
   * to nothing, and what is left is a front-facing card — which is the whole
   * criticism this component exists to answer (§6). */
  const angles = [...CB.matchAll(/\.cb-vol\.is-out \.cb-box\{transform:[^}]*rotateY\(-(\d+)deg\)/g)]
    .map((m) => Number(m[1]));
  assert.equal(angles.length, 5, `expected five treatments, found ${angles.length}`);
  for (const a of angles) assert.ok(a < 90 && a >= 45, `a treatment turns ${a}°`);
  assert.equal(new Set(angles).size >= 4, true, 'the treatments are barely different from each other');
});

test('l35: one Book out at a time, and a neighbour can take its place directly', () => {
  assert.match(shell, /stage\.querySelectorAll\('\.cb-vol\.is-out'\)\.forEach\(\(v\) => applyTurn\(v, false\)\);/);
  // No close-first step: activating a neighbour selects the neighbour.
  assert.match(shell, /select\(obj\.dataset\.obj\);/);
  assert.ok(!/must close|closeFirst|requireClose/.test(shell));
  // Escape reverses, and the resting label is restored rather than rebuilt.
  assert.match(shell, /if \(e\.key === 'Escape' && state\.selected\) \{ e\.preventDefault\(\); select\(state\.selected\); return; \}/);
  assert.match(shell, /vol\.setAttribute\('aria-label', vol\.dataset\.label \|\| /);
});

/* ── §15  Nothing added beneath the Book ────────────────────────────────── */

test('l35: a pulled Book grows no metadata', () => {
  const vol = books.slice(books.indexOf('export function volume'), books.indexOf('export const bookRow'));
  assert.match(vol, /bookCoverHtml\(b, 'cb-cover'\)/);
  assert.match(vol, /<span class="cb-open" data-open>Open<\/span>/);
  assert.ok(!/cb-(meta|foot|caption|sub|card)\b/.test(vol), 'the pulled Book grew a footer');
  assert.match(CB, /\.cb-open\{position:absolute;left:0;right:0;bottom:0/);
  assert.match(CB, /\.cb-open\{[^}]*opacity:0/);
});

test('l35: the cover is the shared one, restated only in scale', () => {
  assert.match(books, /import \{ bookCoverHtml \} from '\.\/shared-cover\.js'/);
  assert.match(CB, /\.cb-cover\{--cv:0\.235;/);
  const block = CB.slice(CB.indexOf('.cb-cover{'), CB.indexOf('.cb-open{'));
  const sizes = block.match(/font-size:[^;]+/g) ?? [];
  assert.ok(sizes.length >= 5);
  for (const s of sizes) assert.match(s, /var\(--cv\)/, `a hard-coded cover size: ${s}`);
});

/* ── §16  Shelf architecture ────────────────────────────────────────────── */

test('l35: five shelf treatments over one construction', () => {
  assert.equal(SHELF_IDS().length, 5);
  /* Every layer exists in every variant so a variant hides what it does not
   * want, rather than the markup changing shape — which is what keeps the Books
   * in identical positions across all five. */
  for (const layer of ['cb-wall', 'cb-post cb-post-l', 'cb-post cb-post-r', 'cb-ledge']) {
    assert.ok(furniture.includes(layer), `the bay has no ${layer}`);
  }
  for (const v of ['a', 'b', 'c', 'd', 'e']) {
    assert.ok(CB.includes(`.cb-s-${v} .cb-wall{`), `shelf ${v} has no back panel`);
    assert.ok(CB.includes(`.cb-s-${v} .cb-ledge{`), `shelf ${v} has no ledge`);
  }
  // Nothing decorative, nothing photographic.
  for (const banned of ['url(', 'wood', 'oak', 'walnut', 'marble']) {
    assert.ok(!CB.includes(banned), `the shelves use ${banned}`);
  }
});
function SHELF_IDS() {
  return [...furniture.matchAll(/\{ id: '(\w)', label:/g)].map((m) => m[1]);
}

/* ── §23–§26  The resource families ─────────────────────────────────────── */

test('l35: the right number of genuinely separate treatments', () => {
  for (const [name, n] of [['DOCS', 5], ['MEDIA', 5], ['LINKVARS', 4], ['FILEVARS', 4]] as const) {
    const at = resources.indexOf(`export const ${name}`);
    const block = resources.slice(at, resources.indexOf('];', at));
    assert.equal((block.match(/\{ id: '/g) ?? []).length, n, `${name} should have ${n}`);
    // Each is a different object, not a restyle of the same one.
    assert.equal(new Set(block.match(/name: '[^']+'/g)).size, n, `${name} repeats a treatment`);
  }
  // Each renderer covers every one of its own ids — no silently missing variant.
  for (const [fn, ids] of [['documentEl', 'abcde'], ['mediaEl', 'abcde'],
    ['linkEl', 'abcd'], ['fileEl', 'abcd']] as const) {
    const body = resources.slice(resources.indexOf(`export function ${fn}`));
    for (const id of ids) assert.match(body, new RegExp(`\\n\\s*${id}: \``), `${fn} has no ${id}`);
  }
});

test('l35: video always says it is video, and how long', () => {
  assert.match(resources, /const isVideo = m\.kind === 'Video';/);
  assert.match(resources, /\$\{isVideo \? play : ''\}<span class="cb-m-meta">\$\{esc\(m\.meta\)\}<\/span>/);
  assert.match(resources, /aria-label="[^"]*\$\{isVideo \? `, \$\{esc\(m\.meta\)\}` : ''\}"/);
});

test('l35: no resource borrows the Book physics', () => {
  const flat = resources.slice(resources.indexOf('export function documentEl'));
  for (const c of ['cb-box', 'cb-spine', 'cb-face', 'rotateY']) {
    assert.ok(!flat.includes(c), `a resource borrowed ${c}`);
  }
  const rules = CB.slice(CB.indexOf('.cb-doc,.cb-med,.cb-lnk,.cb-fil{'));
  assert.ok(!/rotateY/.test(rules), 'a resource rotates');
  assert.match(rules, /\.cb-doc:hover,\.cb-med:hover,\.cb-lnk:hover,\.cb-fil:hover\{transform:translateY\(-4px\)\}/);
});

test('l35: every object is a reachable, named control', () => {
  for (const src of [books, resources]) {
    const arts = src.match(/<article class="cb-[a-z]+[^>]*/g) ?? [];
    assert.ok(arts.length >= 1);
    for (const a of arts) {
      assert.match(a, /role="button"/);
      assert.match(a, /tabindex="0"/);
      assert.match(a, /aria-label="/);
    }
  }
});

/* ── §30/§31/§32  Sample rows, state, comparison ────────────────────────── */

test('l35: 9, 20 and 40 Book rows, deterministic', () => {
  assert.match(physics, /export const ROW_SIZES = \[9, 20, 40\];/);
  assert.match(physics, /export function sampleRow\(n, DIARY, BOOKS\)/);
  assert.ok(!/Math\.random/.test(physics), 'the sample rows are generated randomly');
  const extra = physics.slice(physics.indexOf('const EXTRA'), physics.indexOf('\n];', physics.indexOf('const EXTRA')));
  assert.ok((extra.match(/\['x\d\d',/g) ?? []).length >= 31, 'not enough Books to fill a 40 row');
  // Varied page counts, including the extremes the thickness rule has to handle.
  const pages = [...extra.matchAll(/,\s*(\d+)\],?\s*$/gm)].map((m) => Number(m[1]));
  assert.ok(Math.min(...pages) <= 10 && Math.max(...pages) >= 400, 'the page counts are all mid-range');
});

test('l35: the starter Books are on the shelf to be judged', () => {
  const data = code(read('lab-data.js'));
  for (const t of ['Notes', 'Ideas', 'Learning']) {
    assert.ok(data.includes(`'${t}'`), `no ${t} Book in the sample`);
  }
});

test('l35: switching a variant preserves scroll and the selected Book', () => {
  assert.match(shell, /const saveScroll = \(\) =>/);
  assert.match(shell, /const restoreScroll = \(\) =>/);
  assert.match(shell, /const restoreSelection = \(\) =>/);
  /* The selection is an id, not an element, so switching treatment shows the
   * SAME Book in the new one instead of closing it and making you find it. */
  assert.match(shell, /selected: null,/);
  assert.match(shell, /\.cb-vol\[data-obj="\$\{CSS\.escape\(state\.selected\)\}"\]/);
  // Clicking the lab's own controls must not answer by taking the subject away.
  assert.match(shell, /if \(state\.selected && e\.target\.closest\('#cb-stage'\)\) select\(state\.selected\);/);
});

test('l35: side by side is optional and never the only way to compare', () => {
  assert.match(shell, /compare: false,/);
  assert.match(shell, /if \(!state\.compare\) return panel\(/);
  assert.match(CB, /\.cb-side\{display:grid;grid-template-columns:1fr 1fr/);
  // It collapses before it squeezes: two half-visible shelves are worse than one.
  assert.match(CB, /@media \(max-width:1100px\)\{\s*\n\s*\.cb-side\{grid-template-columns:1fr\}/);
});

/* ── §33  Motion ────────────────────────────────────────────────────────── */

test('l35: 300ms, no bounce, and the state is owned by CSS', () => {
  const durations = [...CB.matchAll(/transition:[^;}]*?(\d+)ms/g)].map((m) => Number(m[1]));
  for (const d of durations) {
    assert.ok(d === 300 || d === 140, `an out-of-band duration: ${d}ms`);
  }
  assert.ok(!/cubic-bezier\([^)]*,\s*-/.test(CB), 'a curve overshoots');
  assert.ok(!/requestAnimationFrame|transitionend/.test(shell), 'the turn is driven by script');
  assert.ok(!/style\.transform/.test(shell), 'a transform is written from script');
});

test('l35: reduced motion keeps the state and drops the travel', () => {
  const rm = CB.slice(CB.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(rm, /\.cb-slot,\.cb-box,[^{]*\{transition:none !important\}/);
  assert.ok(!/is-out \.cb-box\{transform:none/.test(rm), 'reduced motion cancels the turn');
  assert.match(rm, /\.cb-vol\.is-out \.cb-front\{box-shadow:0 0 0 2px/);
});

/* ── §36  Nothing reaches the real product ──────────────────────────────── */

test('l35: the real Library, Book view and page know nothing of this', () => {
  for (const [name, src] of [['library-shelf.js', libShelf], ['library-book.js', libBook],
    ['library-view.js', libView]] as const) {
    assert.ok(!/\bcb-/.test(src), `${name} uses a component-lab class`);
    assert.ok(!src.includes('component-lab'), `${name} imports the component lab`);
    assert.ok(!src.includes('book-physics'), `${name} imports the lab physics`);
    assert.ok(!src.includes('lab-books'), `${name} imports the lab Book`);
  }
  assert.ok(!/\bcb-(vol|slot|niche|ledge|spine|box)\b/.test(indexHtml), 'index.html carries lab styling');
});

test('l35: it is all still one deletable folder', () => {
  assert.deepEqual(readdirSync(LAB).sort(), [
    'book-physics.js', 'component-lab.js',
    'concept-a.js', 'concept-b.js', 'concept-c.js', 'concept-c2.js', 'concept-d.js',
    'concept-e.js', 'concept-f.js',
    'lab-books.js', 'lab-data.js', 'lab-furniture.js', 'lab-resources.js',
    'lab-view.js', 'lab.css', 'shared-cover.js',
  ]);
  assert.ok(!libView.includes('concept-'), 'the real Library imports a concept');
});

test('l35: the lab still cannot write, and still asks the server first', () => {
  for (const [n, s] of [['component-lab', shell], ['lab-books', books],
    ['lab-resources', resources], ['book-physics', physics], ['lab-furniture', furniture]] as const) {
    assert.ok(!/\bfetch\(|ctx\.api\(|XMLHttpRequest/.test(s), `${n} makes a request`);
  }
  assert.match(view, /if \(!\(await labAllowed\(\)\)\) return false;/);
  assert.match(view, /id: 'cb',[\s\S]*?mod: \(\) => import\('\.\/component-lab\.js'\)/);
  assert.match(view, /await mount\(stage, current \?\? 'cb', nav\);/);
  // C2 stays reachable as the baseline it is measured against (§1).
  assert.match(view, /id: 'c2',/);
});

test('l35: switching away tears everything down', () => {
  const teardown = shell.slice(shell.lastIndexOf('return () => {'));
  for (const ev of ['click', 'change', 'keydown']) {
    assert.ok(shell.includes(`root.addEventListener('${ev}'`), `no ${ev} listener`);
    assert.ok(teardown.includes(`root.removeEventListener('${ev}'`), `${ev} is never removed`);
  }
});
