/**
 * Phase L3.3 — the Library design lab.
 *
 * A change of process rather than another correction. Five phases had each
 * fixed something real about the shelf and the result still did not look right,
 * which is the signature of optimising the wrong metaphor. The lab presents six
 * complete directions over one fixed set of objects so the visual question can
 * be answered by looking rather than by iterating.
 *
 * What these tests protect is not the concepts — those are disposable — but the
 * three properties that make the lab safe to ship to staging:
 *
 *   1. it cannot appear in production;
 *   2. it cannot write anything;
 *   3. it cannot leak when you switch between concepts.
 *
 * Plus the one prototype that has to actually work: Concept A's turn, which
 * must end in a committed, untransformed state rather than a frozen animation.
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

const view = code(read('lab-view.js'));
const data = code(read('lab-data.js'));
const css = read('lab.css');
const libView = code(readFileSync(join('..', 'web', 'library-view.js'), 'utf8'));
const CONCEPTS = ['a', 'b', 'c', 'd', 'e', 'f'];
const concept = (id: string) => code(read(`concept-${id}.js`));

/* ── §2  Staging only, and isolated ──────────────────────────────────── */

test('lab: availability is decided by the SERVER, not guessed', () => {
  /* Asked of `GET /library/sample`, whose `allowed` is exactly
   * `NODE_ENV !== 'production'` — the same guard the sample tooling uses. A
   * hostname check would be a guess, and a new config flag would be one more
   * thing to set wrong. This way the lab cannot appear in production without
   * the sample endpoints appearing too. */
  assert.match(view, /const r = await ctx\.api\('\/library\/sample'\);/);
  assert.match(view, /allowed = r\?\.allowed === true;/);
  // A failure to ask is not permission.
  assert.match(view, /catch \{[\s\S]*?allowed = false;/);
  // And the route refuses before mounting anything.
  assert.match(view, /if \(!\(await labAllowed\(\)\)\) return false;/);
});

test('lab: production falls through to the Library rather than erroring', () => {
  assert.match(libView, /if \(parts\[1\] === 'lab'\) return \{ view: 'lab' \};/);
  assert.match(libView, /if \(!shown && !navStale\(nav\)\) \{\s*\n\s*setHash\('#library'\);\s*\n\s*return renderOverview\(head, scroll, nav\);/);
});

test('lab: nothing of it is loaded unless somebody asks for it', () => {
  /* A dynamic import and a stylesheet appended on demand, so a visitor who
   * never opens the lab never fetches six concept modules — and in production
   * nobody can. */
  assert.match(libView, /await import\('\.\/modules\/library-lab\/lab-view\.js'\)/);
  assert.match(libView, /labCss\.href = '\.\/modules\/library-lab\/lab\.css';/);
  // The real Library renderer has no concept branches in it.
  assert.ok(!/concept-[a-f]/.test(libView), 'the real Library imports a lab concept');
  for (const c of CONCEPTS) {
    assert.ok(!libView.includes(`lab-${c}`), `the real Library references concept ${c}`);
  }
});

/* ── §24  Read-only by construction ──────────────────────────────────── */

test('lab: it cannot mutate anything, because it never asks for anything', () => {
  /* The only network call in the whole lab is the availability check. There is
   * no fetch, no POST, no PATCH — the subject is a literal set in lab-data.js,
   * which makes §24 true by construction rather than by discipline. */
  const all = [view, data, ...CONCEPTS.map(concept)].join('\n');
  /* CALL SHAPES, not English words. Banning the string "archive" flags Concept
   * F's "personal archive" and "archival furniture" — prose describing a
   * metaphor, not a mutation. A test that reads the dictionary rather than the
   * code is a test that will be silenced rather than fixed. */
  for (const banned of ['fetch(', 'XMLHttpRequest', "method: 'POST'", "method: 'PATCH'",
    "method: 'DELETE'", 'savePage(', 'createItem(', 'updateItem(', 'archiveItem(']) {
    assert.ok(!all.includes(banned), `the lab contains ${banned}`);
  }
  // Exactly one API call, and it is the gate.
  const calls = [...view.matchAll(/ctx\.api\(/g)].length;
  assert.equal(calls, 1, 'the lab makes more than the one availability call');
  for (const c of CONCEPTS) {
    assert.ok(!concept(c).includes('ctx.api'), `concept ${c} calls the API`);
  }
});

/* ── §3  One subject, six views ──────────────────────────────────────── */

test('data: every concept draws the same objects', () => {
  /* A concept that looked better because it drew nicer titles would be a
   * measurement of the sample rather than of the design. */
  assert.match(data, /export const BOOKS = \[/);
  const books = [...data.matchAll(/\{ id: 'b\d+',/g)].length;
  assert.equal(books, 8, '§3 asks for 6–8 books; the set is 8');
  assert.match(data, /export const DIARY = \{/);
  assert.equal([...data.matchAll(/\{ id: 'd\d+',/g)].length, 3, '3 documents');
  assert.equal([...data.matchAll(/\{ id: 'i\d+',/g)].length, 2, '2 images');
  assert.equal([...data.matchAll(/\{ id: 'v\d+',/g)].length, 2, '2 videos');
  assert.equal([...data.matchAll(/\{ id: 'l\d+',/g)].length, 3, '3 links');
  assert.equal([...data.matchAll(/\{ id: 'f\d+',/g)].length, 2, '2 files');
  // The awkward cases §25 asks for.
  assert.ok(data.includes("title: 'Notes'"), 'no one-word title');
  assert.ok(data.includes('Systems That Survive Contact With A Tuesday'), 'no very long title');
  assert.ok(data.includes("title: 'The Laws of Gravity'"));
  // Every concept imports the shared set rather than inventing its own.
  for (const c of CONCEPTS) {
    assert.match(concept(c), /from '\.\/lab-data\.js'/, `concept ${c} does not use the shared data`);
    assert.ok(!/\bconst BOOKS = \[/.test(concept(c)), `concept ${c} defines its own books`);
  }
});

test('data: a book looks like the same book in every concept', () => {
  /* One cover-template assignment, derived from the id, so switching concepts
   * shows you the same volume rather than a different library. */
  assert.match(data, /export const templateFor = \(id\) =>/);
  assert.match(data, /export function coverFace\(b, cls = ''\)/);
  /* The templates are namespaced `tpl-`, and that prefix is load-bearing: they
   * were first named `rule`, `band`, `frame`, `plate`, and `lab-cover-rule`
   * collided with the divider element INSIDE the cover. Every book on that
   * template inherited `width:30px;height:1px` for its whole cover — measured
   * as a 30px cover in a 126px face, title wrapping one character per line. */
  assert.match(data, /COVER_TEMPLATES = \['tpl-line', 'tpl-band', 'tpl-frame', 'tpl-plate'\]/);
  assert.ok(!/'rule'|'band'|'frame'|'plate'/.test(data),
    'an unprefixed template name is back, and it can collide with an element class');
  // The cover fills whatever face it is given.
  assert.match(css, /\.lab-cover\{[\s\S]*?width:100%;height:100%/);
});

/* ── §4/§21  Six concepts, none recommended ──────────────────────────── */

test('lab: six concepts, neutrally labelled', () => {
  for (const c of CONCEPTS) {
    assert.match(view, new RegExp(`id: '${c}'`), `concept ${c} is not registered`);
  }
  assert.match(view, /desc: 'Spine-first'/);
  assert.match(view, /desc: 'Fantasy shelf'/);
  assert.match(view, /desc: 'Modern library'/);
  assert.match(view, /desc: 'Cover-forward'/);
  assert.match(view, /desc: 'Alcoves'/);
  assert.match(view, /desc: 'Personal archive'/);
  // Nothing is marked preferred. The choice is the user's.
  for (const steer of ['Recommended', 'recommended', 'preferred', 'best', 'suggested']) {
    assert.ok(!view.includes(steer), `the lab steers the choice with "${steer}"`);
  }
});

test('lab: each concept states its premise in five bullets or fewer (§22)', () => {
  for (const c of CONCEPTS) {
    const src = concept(c);
    assert.match(src, /export const notes = \[/, `concept ${c} has no design notes`);
    const block = src.slice(src.indexOf('export const notes'));
    const bullets = block.slice(0, block.indexOf('];')).split('\n')
      .filter((l) => l.trim().startsWith("'")).length;
    assert.ok(bullets > 0 && bullets <= 5, `concept ${c} has ${bullets} notes; the cap is 5`);
  }
});

/* ── §31  Switching must not leak ────────────────────────────────────── */

test('lab: every concept returns a teardown, and switching calls it', () => {
  /* Measured: switching A→B→C→A three times left the stage node count
   * identical (203 → 203) with exactly one concept mounted throughout. */
  for (const c of CONCEPTS) {
    const src = concept(c);
    assert.match(src, /return \(\) => \{/, `concept ${c} has no teardown`);
    assert.match(src, /removeEventListener/, `concept ${c} never removes its listeners`);
  }
  assert.match(view, /function unmount\(stage\) \{\s*\n\s*try \{ teardown\?\.\(\); \}/);
  assert.match(view, /teardown = mod\.render\(host\) \?\? null;/);
  // Mounting always unmounts first.
  const mount = view.slice(view.indexOf('async function mount'));
  const body = mount.slice(0, mount.indexOf('\n}'));
  assert.ok(body.indexOf('unmount(stage)') < body.indexOf('mod.render'),
    'a concept is mounted before the previous one is torn down');
  // Concept A clears its timers, which are the only ones in the lab.
  assert.match(concept('a'), /timers\.forEach\(clearTimeout\)/);
  // And leaving Library entirely stops the lab too.
  assert.match(libView, /m\.leaveLab\(\)/);
});

/* ── §16/§17  Concept A: the turn, and its committed end state ───────── */

test('concept A: books rest spine-on, not cover-on', () => {
  /* The premise of the concept, and the thing every previous Library iteration
   * did not do: the primary visible surface at rest is the bound edge. */
  assert.match(css, /\.cA-spine\{left:0;width:var\(--sw\);transform:translateZ\(63px\)/);
  assert.match(css, /\.cA-front\{left:calc\(var\(--sw\) \/ 2 - 63px\);width:126px;\s*\n\s*transform:rotateY\(90deg\)/);
  // Two real faces of one box — not a flattened image of a book.
  assert.match(css, /\.cA-vol\{[^}]*transform-style:preserve-3d/);
  assert.match(css, /\.cA-box\{position:absolute;inset:0;transform-style:preserve-3d/);
  assert.match(concept('a'), /<span class="cA-face cA-spine">/);
  assert.match(concept('a'), /<span class="cA-face cA-front">/);
});

test('concept A: the turn ENDS in an untransformed cover', () => {
  /* §17. A cover left sitting at `rotateY(-90deg)` rasterises on a transformed
   * grid and is permanently slightly soft — which is the exact failure the last
   * two phases were correcting. When the turn finishes the 3D is dropped
   * entirely and the cover becomes an ordinary element.
   *
   * Measured after the commit: cover 126 × 214, title box 104px wide,
   * `transform: none`. */
  assert.match(css, /\.cA-vol\.is-flat \.cA-box\{transform:none;transform-style:flat\}/);
  assert.match(css, /\.cA-vol\.is-flat \.cA-front\{position:relative;left:0;width:126px;height:var\(--h\);\s*\n\s*transform:none/);
  assert.match(css, /\.cA-vol\.is-flat \.cA-spine\{display:none\}/);
  // The commit is guaranteed by a timer, not only by an event that may not fire.
  const a = concept('a');
  assert.match(a, /const commit = \(\) => \{ if \(turned === obj\) obj\.classList\.add\('is-flat'\); \};/);
  assert.match(a, /obj\.addEventListener\('transitionend', commit, \{ once: true \}\);/);
  assert.match(a, /after\(commit, TURN_MS \+ 60\);/);
  // And the duration is inside §16's band.
  assert.match(a, /const TURN_MS = 300;/);
  assert.ok(300 >= 260 && 300 <= 320, 'the turn must be 260-320ms');
});

test('concept A: two activations, and a way back', () => {
  const a = concept('a');
  assert.match(a, /if \(obj === turned \|\| e\.target\.closest\('\[data-open\]'\)\)/);
  assert.match(a, /if \(e\.key === 'Escape'\) \{ restAll\(\); return; \}/);
  assert.match(a, /if \(!obj\) \{ restAll\(\); return; \}/);
});

/* ── §12/§13/§18  Every concept designs its shelf and its Document ───── */

test('concepts: each one designs a shelf, not a dark rectangle', () => {
  /* §12 — a back plane, a surface, a front edge. Each concept builds its own,
   * and none of them is a single flat panel with a line under it. */
  const shelves: Record<string, RegExp> = {
    a: /\.cA-shelf::after\{content:'';display:block;height:9px/,
    b: /\.cB-bay::after\{content:'';display:block;height:14px/,
    c: /\.cC-shelf::after\{content:'';display:block;height:5px/,
    d: /\.cD-shelf::after\{content:'';display:block;height:11px/,
    e: /\.cE-sill\{display:block;height:9px/,
    f: /\.cF-shelf \.cF-unit-in\{[^}]*border-bottom:9px solid/,
  };
  for (const [id, re] of Object.entries(shelves)) {
    assert.match(css, re, `concept ${id} has no drawn shelf edge`);
  }
  // B and E build a real opening: posts, a lintel, a sill.
  assert.match(css, /\.cB-frame::before,\.cB-frame::after\{content:'';position:absolute/);
  assert.match(css, /\.cE-lintel\{display:block;height:13px/);
});

test('concepts: no two share a Document treatment (§18)', () => {
  /* "Documents look like an afterthought" was the feedback. Each concept gives
   * them their own storage, native to that concept. */
  const docs: Record<string, string> = {
    a: 'cA-binder',        // slim labelled binders, standing
    b: 'cB-folio',         // cloth folios, tied
    c: 'cC-folder',        // premium archival folders
    d: 'cD-port',          // front-facing portfolios
    e: 'cE-rack-item',     // a rack of tabbed folios
    f: 'cF-folio',         // a folio rack with pull tabs
  };
  for (const [id, cls] of Object.entries(docs)) {
    assert.ok(concept(id).includes(cls), `concept ${id} has no Document of its own`);
    assert.ok(css.includes(`.${cls}`), `concept ${id}'s Document has no style`);
  }
  // Nobody falls back to a generic card.
  for (const c of CONCEPTS) {
    assert.ok(!/lib-res-face|lib-card/.test(concept(c)),
      `concept ${c} reuses the real Library's Document`);
  }
});

test('concepts: E and F carry every resource type (§20)', () => {
  for (const c of ['e', 'f']) {
    const src = concept(c);
    for (const kind of ['IMAGES', 'VIDEOS', 'LINKS', 'FILES', 'DOCUMENTS']) {
      assert.ok(src.includes(kind), `concept ${c} does not show ${kind}`);
    }
  }
});

/* ── §32  Basic usability, even in a prototype ───────────────────────── */

test('concepts: every object is named, focusable and keyboard-activated', () => {
  for (const c of CONCEPTS) {
    const src = concept(c);
    assert.match(src, /role="button" tabindex="0"/, `concept ${c} has unfocusable objects`);
    assert.match(src, /aria-label="/, `concept ${c} has unnamed objects`);
    /* Either form: some concepts test for Enter/Space, Concept A returns early
     * on everything else. Both activate; the shape of the condition is not the
     * thing being asserted. */
    assert.ok(/e\.key === 'Enter' \|\| e\.key === ' '/.test(src)
      || /e\.key !== 'Enter' && e\.key !== ' '/.test(src),
    `concept ${c} cannot be activated by keyboard`);
  }
  // Reduced motion turns travel off everywhere, and A goes straight to its
  // committed state rather than being stranded mid-turn.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?\.lab-stage \*\{transition:none !important/);
  assert.match(css, /\.cA-vol\.is-turned \.cA-front\{position:relative;left:0;width:126px;height:var\(--h\);transform:none\}/);
});

/* ── §30  Isolation on disk ──────────────────────────────────────────── */

test('lab: it all lives in one folder that can be deleted in one move', () => {
  const files = readdirSync(LAB).sort();
  assert.deepEqual(files, [
    'concept-a.js', 'concept-b.js', 'concept-c.js', 'concept-d.js',
    'concept-e.js', 'concept-f.js', 'lab-data.js', 'lab-view.js', 'lab.css',
  ]);
  // Nothing outside the lab imports a concept.
  assert.ok(!libView.includes('concept-'), 'the real Library imports a concept directly');
});
