/**
 * Phase S2.1 — the staging-only Book Tuner.
 *
 * S2 made the resting Book four numbers. This makes those numbers adjustable
 * without a deployment between adjustments, on the REAL `#library` shelf.
 *
 * The three properties worth protecting:
 *
 *   1. it cannot appear in production;
 *   2. it writes nothing — no request, no database, no stored preference;
 *   3. every control drives a token, and the token is the only source of that
 *      number, so tuning a value cannot leave a stale literal behind it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const raw = (f: string) => readFileSync(join(WEB, f), 'utf8');
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const tuner = code(raw('library-tuner.js'));
const view = code(raw('library-view.js'));
const shelf = code(raw('library-shelf.js'));
const html = raw('index.html');
const css = html.slice(html.indexOf('LIBRARY (Phase F2)'));
/* `--d-turn` is a motion token and lives with the others, above the Library
 * region — so token lookups search the whole sheet, and only the Library-scoped
 * assertions use `css`. */
const tokenIn = (t: string) => (t === '--d-turn' ? html : css);

/** Every control, and the property it must drive. */
const CONTROLS: Array<[string, string]> = [
  ['gap', '--lib-book-gap'],
  ['lean', '--lib-book-lean'],
  ['tilt', '--lib-book-top-tilt'],
  ['yaw', '--lib-book-yaw'],
  ['depth', '--lib-book-depth'],
  ['grain', '--lib-page-grain'],
  ['hover', '--lib-book-hover'],
  ['pull', '--lib-book-pull'],
  ['turn', '--d-turn'],
  ['neighbours', '--lib-book-neighbour'],
];

/* ── §2  Staging only ───────────────────────────────────────────────────── */

test('tuner: the SERVER decides whether it exists', () => {
  /* The same authority the sample tooling and the design lab use — `allowed` on
   * `GET /library/sample`, which is exactly `NODE_ENV !== 'production'`. No new
   * query flag, so there is nothing a visitor could set to summon it. */
  assert.match(view, /const r = await ctx\.api\('\/library\/sample'\);/);
  assert.match(view, /tunerAllowed = r\?\.allowed === true;/);
  // A failure to ask is not permission.
  assert.match(view, /catch \{\s*\n\s*tunerAllowed = false;/);
  assert.match(view, /if \(!\(await tunerIsAllowed\(\)\) \|\| !head\.isConnected\) return;/);
});

test('tuner: nothing of it loads unless somebody asks for it', () => {
  // A dynamic import behind the gate, so the module is never in the first paint.
  assert.match(view, /const m = await import\('\.\/library-tuner\.js'\);/);
  assert.ok(!/^import .*library-tuner/m.test(view), 'the tuner is imported eagerly');
});

test('tuner: it is not in product navigation', () => {
  /* A quiet trigger beside the Library title, and nowhere else. If it appeared
   * in the sidebar it would be a feature rather than a utility. */
  assert.match(view, /btn\.id = 'lib-tuner-open';/);
  assert.match(view, /btn\.title = 'Staging only — live Book geometry';/);
  for (const f of ['nav.js', 'app.js', 'routes.js']) {
    assert.ok(!raw(f).includes('library-tuner'), `${f} routes to the tuner`);
    assert.ok(!raw(f).includes('Book Tuner'), `${f} advertises the tuner`);
  }
});

/* ── §13/§14  It writes nothing, and it changes no data ────────────────── */

test('tuner: it makes no request and stores nothing', () => {
  for (const banned of ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage',
    "method: 'POST'", "method: 'PATCH'", "method: 'DELETE'", 'ctx.api(']) {
    assert.ok(!tuner.includes(banned), `the tuner uses ${banned}`);
  }
});

test('tuner: it cannot touch a Book', () => {
  /* Geometry only. It never renames, archives, reorders, creates or re-covers
   * anything — it does not even read the item list. */
  for (const banned of ['lib.items', 'renameItem', 'archiveItem', 'createItem',
    'data-item', 'accent']) {
    assert.ok(!tuner.includes(banned), `the tuner reaches into ${banned}`);
  }
  // The single mechanism, and its whole surface area.
  assert.match(tuner, /document\.documentElement\.style\.setProperty\(c\.css, `\$\{value\[key\]\}\$\{c\.unit\}`\)/);
});

test('tuner: it never rebuilds the shelf', () => {
  /* A slider drag repaints the Books because CSS recomputed, not because
   * anything was re-rendered. Measured: the document node count was identical
   * before and after a full pass over every control. */
  for (const banned of ['paintOverview', 'renderLibrary', 'replaceChildren']) {
    assert.ok(!tuner.includes(banned), `the tuner calls ${banned}`);
  }
  /* The ONE `innerHTML` builds the panel itself, once, in `mountTuner`. Nothing
   * on the tuning path writes markup — `set()` reaches `apply()` and `paintOut()`
   * and neither of them constructs anything. */
  const writes = tuner.match(/\w+\.innerHTML =/g) ?? [];
  assert.deepEqual(writes, ['panel.innerHTML ='], `unexpected markup writes: ${writes}`);
  const tuning = tuner.slice(tuner.indexOf('function apply'), tuner.indexOf('export function mountTuner'));
  assert.ok(!tuning.includes('innerHTML'), 'the tuning path writes markup');
});

/* ── §5/§6  The eight controls ─────────────────────────────────────────── */

test('tuner: five resting controls, five advanced, and not thirty', () => {
  const primary = (tuner.match(/group: 'primary'/g) ?? []).length;
  const advanced = (tuner.match(/group: 'advanced'/g) ?? []).length;
  assert.equal(primary, 5, `${primary} primary controls`);
  assert.equal(advanced, 5, `${advanced} advanced controls`);
  assert.equal((tuner.match(/\{ key: '/g) ?? []).length, 10);
});

test('tuner: every control names the property it drives', () => {
  for (const [key, prop] of CONTROLS) {
    assert.match(tuner, new RegExp(`key: '${key}', css: '${prop.replace(/-/g, '-')}'`),
      `${key} does not drive ${prop}`);
  }
});

test('tuner: the ranges are the ones that were asked for', () => {
  const range = (k: string) => {
    const m = tuner.match(new RegExp(`key: '${k}',[\\s\\S]*?min: (-?[\\d.]+), max: (-?[\\d.]+), step: ([\\d.]+), def: (-?[\\d.]+)`))!;
    return { min: Number(m[1]), max: Number(m[2]), step: Number(m[3]), def: Number(m[4]) };
  };
  assert.deepEqual(range('gap'), { min: 0, max: 14, step: 1, def: 0 });
  /* Both of these read symmetrically now: lean goes left as well as right, and
   * tilt goes forward (showing the tail) as well as back (showing the head). */
  assert.deepEqual(range('lean'), { min: -6, max: 6, step: 0.5, def: 0 });
  assert.deepEqual(range('tilt'), { min: -10, max: 10, step: 0.5, def: -4 });
  assert.deepEqual(range('yaw'), { min: -12, max: 12, step: 0.5, def: -6 });
  assert.deepEqual(range('depth'), { min: 0, max: 16, step: 1, def: 0 });
  assert.deepEqual(range('hover'), { min: 0, max: 14, step: 1, def: 8 });
  assert.deepEqual(range('pull'), { min: 20, max: 48, step: 2, def: 32 });
  assert.deepEqual(range('turn'), { min: 250, max: 650, step: 25, def: 400 });
  assert.deepEqual(range('neighbours'), { min: 0, max: 28, step: 2, def: 16 });
});

test('tuner: slider and number input drive the same value and stay in step', () => {
  assert.match(tuner, /<input type="range" class="tn-slide" data-tune="\$\{c\.key\}"/);
  assert.match(tuner, /<input type="number" class="tn-input" data-tune-num="\$\{c\.key\}"/);
  /* `sync` deliberately skips the control the change came FROM, so typing into
   * the number box cannot fight the slider writing it back. */
  assert.match(tuner, /sync\(key, \{ slider: from !== 'slider', number: from !== 'number' \}\)/);
  // Out-of-range input is clamped rather than rejected.
  assert.match(tuner, /v = Math\.min\(c\.max, Math\.max\(c\.min, v\)\)/);
});

/* ── §20/§21/§22  The values are the only source ───────────────────────── */

test('tuner: the tokens are declared once, on :root', () => {
  /* On `:root` so a live override — an inline style on the same element — wins.
   * Declared on the shelves it would have lost to its own stylesheet. */
  for (const [, prop] of CONTROLS) {
    const declared = (tokenIn(prop).match(new RegExp(`\\s${prop}:`, 'g')) ?? []).length;
    assert.equal(declared, 1, `${prop} is declared ${declared} times`);
  }
});

test('tuner: turn duration drives BOTH the CSS turn and the commit timer', () => {
  /* §20 — one authoritative duration. A fixed commit timer left behind a live
   * duration is a Book that commits mid-rotation the moment the turn is slowed,
   * so the timer is DERIVED rather than written down beside it. */
  assert.match(shelf, /export function turnMs\(\)/);
  assert.match(shelf, /\.getPropertyValue\('--d-turn'\)/);
  assert.match(shelf, /const COMMIT_MARGIN = 120;/);
  assert.match(shelf, /turnMs\(\) \+ COMMIT_MARGIN/);
  assert.ok(!/setTimeout\([^)]*\},\s*\d{3}\)/.test(shelf), 'a hard-coded commit delay is back');
});

test('tuner: neighbour clearance drives both sides from one token', () => {
  assert.match(css, /\.lib-slot\.is-nudge-l\{transform:translateX\(calc\(-1 \* var\(--lib-book-neighbour\)\)\)\}/);
  assert.match(css, /\.lib-slot\.is-nudge-r\{transform:translateX\(var\(--lib-book-neighbour\)\)\}/);
  // No stale literal anywhere in the Library region.
  assert.ok(!/is-nudge-[lr]\{transform:translateX\(-?\d+px\)/.test(css),
    'a hard-coded neighbour distance survives');
});

test('tuner: hover and pull are tokens too', () => {
  assert.match(css, /\.lib-obj:hover\{transform:translateY\(calc\(-1 \* var\(--lib-book-hover\)\)\)/);
  assert.match(css, /\.lib-obj\.is-pulled\{transform:translateY\(calc\(-1 \* var\(--lib-book-pull\)\)\)/);
});

/* ── §9/§10/§11/§12  Readout, copy, reset, presets ─────────────────────── */

test('tuner: the configuration is readable and copyable without DevTools', () => {
  assert.match(tuner, /const summaryLine = \(\) => CONTROLS\s*\n\s*\.map\(\(c\) => `\$\{c\.key\} \$\{value\[c\.key\]\}\$\{c\.unit\}`\)\.join\(', '\)/);
  assert.match(tuner, /const cssLines = \(\) => CONTROLS\s*\n\s*\.map\(\(c\) => `\$\{c\.css\}: \$\{value\[c\.key\]\}\$\{c\.unit\};`\)/);
  /* A textarea rather than a span, so selecting works when the clipboard is
   * refused — which is the fallback the copy handler falls back TO. */
  assert.match(tuner, /<textarea class="tn-copy"/);
  assert.match(tuner, /navigator\.clipboard\?\.writeText/);
  assert.match(tuner, /\.catch\(\(\) => say\('Select the text above and copy'\)\)/);
});

test('tuner: reset restores the committed defaults', () => {
  assert.match(tuner, /CONTROLS\.forEach\(\(c\) => set\(c\.key, c\.def\)\);/);
  // And the defaults in the panel are the defaults in the stylesheet.
  const def = (k: string) => Number(tuner.match(new RegExp(`key: '${k}',[\\s\\S]*?def: (-?[\\d.]+)`))![1]);
  const token = (t: string) => Number(tokenIn(t).match(new RegExp(`\\s${t}:\\s*(-?[\\d.]+)`))![1]);
  for (const [key, prop] of CONTROLS) {
    assert.equal(def(key), token(prop), `${key} default disagrees with ${prop}`);
  }
});

test('tuner: three presets, and they are only starting points', () => {
  for (const p of ['Subtle', 'Current', 'Physical']) {
    assert.ok(tuner.includes(`${p}:`), `no ${p} preset`);
  }
  // They move the resting pose only; the retrieval numbers are left alone.
  const presets = tuner.slice(tuner.indexOf('const PRESETS'), tuner.indexOf('const value'));
  for (const advanced of ['hover', 'pull', 'turn', 'neighbours']) {
    assert.ok(!presets.includes(`${advanced}:`), `a preset changes ${advanced}`);
  }
});

test('tuner: warnings observe rather than block', () => {
  assert.match(tuner, /if \(value\.hover >= value\.pull\) out\.push\('Hover is currently as strong as Pull\.'\)/);
  assert.match(tuner, /High tilt may soften spine text\./);
  assert.match(tuner, /This may read more like a display than a shelf\./);
  assert.match(tuner, /Book will appear flatter\./);
  // Nothing refuses a value: experimentation is the point.
  assert.ok(!/return;\s*\/\/ blocked|throw new Error/.test(tuner), 'the tuner blocks a value');
});

/* ── §15  The Library keeps working ────────────────────────────────────── */

test('tuner: it owns only its own box', () => {
  /* A fixed panel with its own bounds. Nothing global, no overlay, no capture
   * phase — so the shelf still scrolls, hovers, pulls, turns and opens beneath
   * it. Verified in the browser with the panel open: pull, commit, Escape. */
  assert.match(css, /\.tn\{position:fixed/);
  assert.ok(!/\.tn\{[^}]*inset:0/.test(css), 'the panel covers the page');
  assert.ok(!/addEventListener\([^)]*, true\)/.test(tuner), 'the tuner captures events');
  assert.ok(!/document\.addEventListener|window\.addEventListener/.test(tuner),
    'the tuner listens globally');
});

test('tuner: leaving Library takes the panel and every override with it', () => {
  assert.match(view, /void closeTuner\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(tuner, /CONTROLS\.forEach\(\(c\) => document\.documentElement\.style\.removeProperty\(c\.css\)\);/);
  // Mounting twice is a no-op, so a re-render cannot leave two panels behind.
  assert.match(tuner, /if \(panel\?\.isConnected\) return;/);
});
