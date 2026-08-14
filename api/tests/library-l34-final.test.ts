/**
 * Phase L3.4 — the final Library hybrid.
 *
 * The bake-off is over. The authenticated user chose, component by component:
 *
 *     Resting Book  A      Pulled Book  E (completed to front)
 *     Shelf         A      Document     D
 *     Media         E      Links        A      Files  A
 *
 * This suite protects the implementation of that choice in the REAL Library, and
 * it also carries forward every property that the retired L3/L3.1/L3.2 tests
 * protected but expressed against the flat Book model — one baseline, no scale
 * in a committed state, hover strictly weaker than a pull, neighbours that do
 * not reflow the rail, the Diary having no Library identity, resources never
 * given a spine, and the accessible names.
 *
 * The geometry claims here were measured in the browser and are recorded in
 * `docs/library-v2-physical-object-model.md`.
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

const shelf = code(raw('library-shelf.js'));
const view = code(raw('library-view.js'));
const book = code(raw('library-book.js'));
const html = raw('index.html');
/* The Library region of the stylesheet, bounded at both ends — an unbounded
 * slice is how three L3.4 assertions once ended up reading the component lab. */
const css = html.slice(html.indexOf('LIBRARY (Phase F2)'), html.indexOf('DIARY', html.indexOf('LIBRARY (Phase F2)')));

/* ── §3/§4/§5  The resting Book ─────────────────────────────────────────── */

test('final: the Book rests spine-first, as a solid with four faces', () => {
  for (const f of ['lib-back', 'lib-edge', 'lib-spine', 'lib-board']) {
    assert.ok(shelf.includes(f), `the volume has no ${f}`);
  }
  assert.match(shelf, /<span class="lib-vol">/);
  // The cover lives ON the front board, not beside the spine.
  const vol = shelf.slice(shelf.indexOf('function volumeHtml'), shelf.indexOf('export function bookObjectHtml'));
  assert.ok(vol.indexOf('lib-board') < vol.indexOf('lib-cover'), 'the cover is not on the board');
  // And nothing renders a cover-forward card.
  assert.ok(!/lib-block\b/.test(shelf), 'the old flat fore-edge strip is still rendered');
});

test('final: decorative detail belongs to the face it is printed on (§9)', () => {
  /* The bands and the rule are CHILDREN of the spine, so they turn away with it.
   * A line that lives outside the face it decorates is the "detail stays
   * visually straight" defect the review named. */
  const spine = shelf.slice(shelf.indexOf('lib-face lib-spine'), shelf.indexOf('lib-face lib-board'));
  for (const c of ['lib-spine-band', 'lib-spine-t', 'lib-spine-rule']) {
    assert.ok(spine.includes(c), `${c} is not inside the spine face`);
  }
  // The page block's striations likewise belong to the page block.
  assert.match(shelf, /<span class="lib-face lib-edge"[^>]*><span class="lib-leaves">/);
});

test('final: heights are deterministic, irregular and bounded', () => {
  assert.ok(!/Math\.random/.test(shelf), 'a Book size is randomised');
  assert.match(shelf, /const HEIGHTS = \[190, 200, 180, 195, 210, 185, 175, 200,\s*\n\s*190, 215, 185, 195, 170, 205, 190, 180\];/);
  const L = [190, 200, 180, 195, 210, 185, 175, 200, 190, 215, 185, 195, 170, 205, 190, 180];
  assert.ok(Math.min(...L) >= 170 && Math.max(...L) <= 215);
  for (const v of L) assert.equal(v % 5, 0, `${v} is off the 5px grid`);
  // Middle-weighted, and the extremes are rare rather than absent.
  assert.equal(L.filter((v) => v === 190).length, 3);
  assert.equal(L.filter((v) => v === 170).length, 1);
  assert.equal(L.filter((v) => v === 215).length, 1);
  // The hash avalanches, so sequential ids do not walk the ladder in order.
  assert.match(shelf, /h \^= h >>> 16; h = Math\.imul\(h, 2246822507\)/);
});

test('final: thickness means content, and the tie-breaker cannot lie about it', () => {
  assert.match(shelf, /const body = p > 0 \? Math\.round\(6 \* \(p \*\* 0\.35\)\) : 0;/);
  assert.match(shelf, /Math\.min\(52, Math\.max\(24, 24 \+ body \+ bind\)\)/);
  const thick = (p: number, b = 0) =>
    Math.min(52, Math.max(24, 24 + (p > 0 ? Math.round(6 * (p ** 0.35)) : 0) + b));
  assert.equal(thick(0), 24, 'an empty Book is not the minimum');
  assert.equal(thick(5000), 52, 'the tail is not clamped');
  assert.ok(thick(0) < thick(8) && thick(8) < thick(60) && thick(60) < thick(400));
  /* The curve must separate SHORT Books, because that is where a real Library
   * lives. A square root did not: it put every sample Book between 25 and 30px.
   * One page against eight has to be visible on a shelf. */
  assert.ok(thick(8) - thick(1) >= 6, 'short Books are still indistinguishable');
  // ±2px cannot reorder two Books by apparent volume.
  assert.ok(thick(20, 2) < thick(100, -2), 'the binding offset can invert volume');
});

test('final: the materials are muted Book cloths, not brand colours (§5)', () => {
  assert.match(shelf, /export const MATERIALS = \['plum', 'navy', 'slate', 'moss', 'walnut', 'claret', 'graphite'\];/);
  for (const m of ['plum', 'navy', 'slate', 'moss', 'walnut', 'claret', 'graphite']) {
    assert.ok(css.includes(`.lib-book[data-material="${m}"]`), `no cloth for ${m}`);
  }
  /* Life OS purple stays the interface accent and is not a Book material: no
   * cloth may be the app accent, or the Library becomes a colour key. */
  const cloths = css.slice(css.indexOf('---- THE MATERIALS'), css.indexOf('---- THE TURN'));
  assert.ok(!/var\(--accent\)/.test(cloths), 'a Book cloth uses the app accent');
  assert.ok(!/#7C4DFF|#C28DFF/i.test(cloths), 'a Book cloth is Life OS purple');
});

/* ── §6  Hover ──────────────────────────────────────────────────────────── */

test('final: hover is obvious, and still strictly weaker than a pull', () => {
  /* Both are tokens now (S2.1), so the numbers are read from the token block
   * rather than from the rules — but the RELATIONSHIP is still the thing that
   * matters, and it is still enforced here. */
  const token = (t: string) => Number(css.match(new RegExp(`${t}:\\s*([\\d.]+)`))![1]);
  const hov = token('--lib-book-hover');
  const pull = token('--lib-book-pull');
  assert.match(css, /\.lib-obj:hover\{transform:translateY\(calc\(-1 \* var\(--lib-book-hover\)\)\)/);
  assert.match(css, /\.lib-obj\.is-pulled\{transform:translateY\(calc\(-1 \* var\(--lib-book-pull\)\)\)/);
  assert.ok(hov >= 5 && hov <= 8, `hover travel is ${hov}px, §6 asks for 5–8`);
  assert.ok(hov < pull, 'hover is not weaker than a pull');
  assert.ok(pull >= hov * 3, 'hover and pull are too close to tell apart');
  // Material brightens; nothing is revealed.
  assert.match(css, /\.lib-obj:hover \.lib-spine\{filter:brightness\(1\.16\)\}/);
  assert.ok(!/\.lib-obj:hover[^{]*\{[^}]*rotateY/.test(css), 'hover turns the Book');
  assert.ok(!/\.lib-obj:hover \.lib-foot\{[^}]*opacity:1/.test(css), 'hover reveals the cover label');
});

/* ── §7–§13  The turn ───────────────────────────────────────────────────── */

test('final: one rotation about the spine hinge, with no scale anywhere', () => {
  assert.match(css, /\.lib-vol\{[^}]*transform-origin:left center/);
  assert.match(css, /\.lib-obj\.is-pulled \.lib-vol\{\s*\n\s*transform:translateZ\(calc\(-1 \* var\(--bt\)\)\) rotateY\(-90deg\)\}/);
  /* No `scale()` in any Library state. The pulled Book is translated and
   * rotated; it is never grown, which is what kept the type crisp in L3.2 and
   * is the same rule here. */
  assert.ok(!/\.lib-obj[^{]*\{[^}]*\bscale\(/.test(css), 'a Library state scales');
  // And no width interpolation: the Book keeps its shelf width when pulled.
  assert.ok(!/\.lib-obj\.lib-book\.is-pulled\{[^}]*width:/.test(css),
    'the pulled Book changes its layout width');
  assert.match(css, /\.lib-obj\.lib-book\.is-pulled::before\{content:'';position:absolute;left:0;top:0;\s*\n\s*width:var\(--bw\);height:100%\}/);
});

test('final: the turn finishes front-facing and hands off to flat DOM', () => {
  /* Measured: at -90 degrees the cover is 126px wide at x=721, and the committed
   * flat cover is 126px wide at x=721. The handoff is seamless because the
   * compensating translateZ puts the cover back in the screen plane. */
  /* And it ARRIVES rather than travels. Both of these carry
   * `transition: transform`, so dropping the 3D used to animate: the turn played
   * over 400ms and the commit unwound the same rotation 520ms later over another
   * 400ms, landing somewhere that looks identical. One click, two turns. */
  assert.match(css, /\.lib-obj\.is-front \.lib-vol\{transform:none;transform-style:flat;transition:none\}/);
  assert.match(css, /\.lib-obj\.is-front \.lib-board\{transform:none;left:0;transition:none\}/);
  /* Every depth face stops painting, the head included — it was added in S2 so
   * the resting tilt has a top to expose, and a face that only exists to be
   * seen in 3D has no business surviving into the flat state. */
  const hidden = css.match(/\.lib-obj\.is-front \.lib-spine,[\s\S]*?\{display:none\}/)![0];
  for (const f of ['lib-spine', 'lib-edge', 'lib-back', 'lib-head']) {
    assert.ok(hidden.includes(f), `${f} still paints in the committed state`);
  }

});

test('final: the commit is guaranteed, not hoped for', () => {
  /* `transitionend` is the optimisation; the timer is the guarantee. A throttled
   * or interrupted transition must not be able to strand a Book half-turned. */
  assert.match(shelf, /function commitFront\(obj\)/);
  assert.match(shelf, /vol\?\.addEventListener\('transitionend', done\)/);
  assert.match(shelf, /commitTimer = setTimeout\(\(\) => \{[^}]*commitFront\(obj\)/);
  // Reduced motion arrives immediately and never rotates.
  assert.match(shelf, /if \(prefersReduced\(\)\) \{ commitFront\(obj\); return; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?\.lib-vol\{transition:none\}/);
  // Committing is idempotent and never fires on a Book that has been put back.
  assert.match(shelf, /if \(!obj\?\.isConnected \|\| !obj\.classList\.contains\('is-pulled'\)\) return;/);
});

test('final: no stationary filler stands in for depth (§11)', () => {
  /* The page block is a FACE of the box, at the end opposite the spine, with
   * page striations on it — not a coloured rectangle parked between the covers.
   * `translateZ`, because depth is depth: a layout offset would be converted
   * into depth by the rotation and then thrown sideways by perspective. */
  assert.match(css, /\.lib-edge\{left:0;width:var\(--bt\);transform:translateZ\(calc\(-1 \* var\(--bw\)\)\)/);
  assert.match(css, /\.lib-leaves\{position:absolute;inset:2px 2px;background:\s*\n\s*repeating-linear-gradient/);
  assert.ok(!/\.lib-edge\{[^}]*left:\d+px/.test(css), 'the page block is positioned by layout');
});

test('final: perspective is safe at both ends of the turn', () => {
  assert.match(css, /\.lib-results \.lib-row\{perspective:1400px\}/);
  /* It is on the ROW, so every Book is seen from the same eye, and it cannot
   * magnify either terminal state: the spine is at z=0 at rest and the cover is
   * at z=0 when it arrives. Measured — rest 29px = spine width exactly, arrived
   * cover 126px exactly, both with perspective on. */
  assert.ok(!/\.lib-vol\{[^}]*perspective:/.test(css), 'perspective is on the Book, not the row');
});

/* ── §14  Neighbours ────────────────────────────────────────────────────── */

test('final: the two sides make room differently, because the cover is not centred', () => {
  /* The Book is hinged at its spine, on the LEFT, so the cover swings out to the
   * RIGHT and ends up 126px wide against a 24–52px spine. The two sides
   * therefore have different jobs, and treating them the same was a real defect:
   * a symmetric 16px nudge left the right neighbour underneath the cover, which
   * the review saw as a Book opening "in front of the books to its right".
   *
   * Left: a token's worth, enough to be readable.
   * Right: the cover's OVERHANG past the spine, so it actually clears. */
  assert.match(css, /\.lib-slot\.is-nudge-l\{transform:translateX\(calc\(-1 \* var\(--lib-book-neighbour\)\)\)\}/);
  assert.match(css, /\.lib-slot\.is-nudge-r\{transform:translateX\(calc\(var\(--lib-book-clear, 0px\) \+ var\(--lib-book-neighbour\)\)\)\}/);
  const nudge = Number(css.match(/--lib-book-neighbour:\s*(\d+)px/)![1]);
  assert.ok(nudge >= 10 && nudge <= 18, `neighbour clearance is ${nudge}px, §14 asks for 10-18`);
  /* A multiple of four, so it lands on a whole device pixel at DPR 1, 1.25, 1.5
   * and 2. 14 x 1.25 is 17.5 — half a device pixel out, which is exactly the
   * phase error L3.2 traced the shelf blur to. */
  assert.equal(nudge % 4, 0, `${nudge}px is not device-pixel exact`);

  // The overhang is measured from the Book itself, not written down.
  assert.match(shelf, /const cover = parseFloat\(getComputedStyle\(obj\)\.getPropertyValue\('--bw'\)\)/);
  assert.match(shelf, /const spine = parseFloat\(getComputedStyle\(obj\)\.getPropertyValue\('--bt'\)\)/);
  assert.match(shelf, /Math\.max\(0, Math\.round\(cover - spine\)\)/);
  assert.match(shelf, /slot\.previousElementSibling\?\.classList\.toggle\('is-nudge-l', on\)/);
  /* EVERY following slot moves by the same amount, which keeps their spacing
   * exactly as it was. Moving only the immediate one would have opened a hole
   * and then buried the next Book instead. */
  assert.match(shelf, /for \(let n = slot\.nextElementSibling; n; n = n\.nextElementSibling\)/);
  // Applied on pull and removed on return, so nothing can be left standing aside.
  assert.match(shelf, /setNeighbours\(obj, true\)/);
  assert.match(shelf, /setNeighbours\(obj, false\)/);
  assert.match(shelf, /slot\.style\.removeProperty\('--lib-book-clear'\)/);
  /* Measured at 1280, pulling the FIRST Book: the pulled Book does not move, the
   * two to its right move +108px each, the cover ends at x=814 and the next Book
   * begins at x=830 — clear. It is a transform, so no layout reflows and the
   * row's centring cannot redistribute it. */
  assert.ok(!/:has\(\.is-pulled\) \+ \.lib-slot\{transform/.test(css),
    'the old whole-row :has() nudge is back');
});

/* ── §16/§18/§19  Activation, Open, overflow ────────────────────────────── */

test('final: first activation pulls, second opens, Escape returns', () => {
  assert.match(shelf, /export function pullForward\(obj\)/);
  assert.match(shelf, /export function clearPulled\(\{ restoreFocus = false \} = \{\}\)/);
  assert.match(shelf, /obj\.classList\.remove\('is-pulled', 'is-front'\)/);
  assert.match(shelf, /obj\.setAttribute\('aria-expanded', 'true'\)/);
  assert.match(shelf, /obj\.setAttribute\('aria-expanded', 'false'\)/);
});

test('final: the Open action is quiet, and there is no floating pill', () => {
  /* §18 — beneath the arrived Book: its title, optionally its subtitle, and a
   * small `Open`. The second click on the cover still opens, so this is a label
   * that happens to be actionable rather than the only way through. */
  assert.match(shelf, /const objectFoot = \(title, sub, action\) => `<span class="lib-foot"/);
  assert.match(shelf, /<span class="lib-foot-a">\$\{esc\(action\)\}<\/span>/);
  assert.ok(!/Open book/.test(shelf), 'the old "Open book" pill text is back');
  assert.ok(!/lib-open-pill|lib-cta/.test(shelf + css), 'a floating CTA is back');
  // The label is absolutely positioned, so revealing it cannot shift the row.
  assert.match(css, /\.lib-foot\{position:absolute;left:0;right:0;top:100%/);
});

test('final: management never paints onto a resting object (§19)', () => {
  /* A 24px menu cannot sit on a 29px spine without becoming the spine, and a
   * control that appears mid-turn is one you hit by accident. Measured: a
   * resting Book reports opacity 0 AND pointer-events none. */
  assert.match(css, /\.lib-book \.lib-obj-more\{pointer-events:none\}/);
  assert.match(css, /\.lib-book\.is-front \.lib-obj-more\{pointer-events:auto\}/);
  assert.match(css, /\.lib-book\.is-front \.lib-obj-more,/);
  assert.ok(!/\.lib-book:hover \.lib-obj-more\{opacity:1\}/.test(css),
    'hovering a resting spine reveals the menu');
});

/* ── §30  The Diary ─────────────────────────────────────────────────────── */

test('final: the Diary is the same Book with a different cloth', () => {
  /* Bounded by a marker that survives comment stripping. An end marker that is
   * only in a comment is no end marker at all, and the slice then runs to the
   * end of the file and reads somebody else's markup. */
  const from = shelf.indexOf('export function diaryObjectHtml');
  const d = shelf.slice(from, shelf.indexOf('const TYPE_GLYPH', from));
  assert.ok(d.length > 100 && d.length < 1200, 'the Diary slice is not the Diary');
  // Same volume renderer, so it turns and commits exactly like every other Book.
  assert.match(d, /\$\{volumeHtml\('My Diary', null, 'Journal', 'Life OS Journal', 'My Diary'\)\}/);
  assert.match(d, /data-material="plum"/);
  // No Library identity, and therefore nothing to manage.
  assert.ok(!d.includes('data-item'), 'the Diary was given a Library item id');
  assert.ok(!d.includes('lib-obj-more'), 'the Diary has an overflow menu');
  assert.ok(!/Archive|Rename/.test(d), 'the Diary offers management');
  // The distinction is material and wording, never a badge or a system button.
  assert.ok(!/system-mark|is-star|★|badge/.test(d), 'the Diary has a system badge');
  assert.match(css, /\.lib-book-system\{--cl-1:#251B33/);
});

/* ── §22/§25/§26/§28/§29  The flat families ─────────────────────────────── */

test('final: Document D — a folio with sheets standing behind its lid', () => {
  assert.match(shelf, /<span class="lib-folio" aria-hidden="true">/);
  assert.equal((shelf.match(/lib-folio-sheet/g) ?? []).length, 3);   // 2 sheets, one with a modifier
  assert.match(shelf, /<span class="lib-folio-lid">/);
  assert.match(css, /\.lib-folio-sheet\{position:absolute[^}]*background:linear-gradient\(180deg,var\(--paper\)/);
  // It is not a Book: no spine, no box, no turn.
  const fam = shelf.slice(shelf.indexOf('function resourceFace'), shelf.indexOf('export function resourceObjectHtml'));
  for (const c of ['lib-vol', 'lib-spine', 'lib-face', 'lib-board']) {
    assert.ok(!fam.includes(c), `a flat resource borrowed ${c}`);
  }
});

test('final: Link A and File A are their own objects', () => {
  assert.match(shelf, /<span class="lib-clip" aria-hidden="true">/);
  assert.match(shelf, /<span class="lib-clip-mark">/);
  assert.match(shelf, /<span class="lib-jacket" aria-hidden="true">/);
  assert.match(shelf, /<span class="lib-jacket-corner"><\/span>/);
  // The clipped corner is what makes a jacket a jacket rather than a card.
  assert.match(css, /\.lib-jacket-body\{[^}]*clip-path:polygon\(0 0,100% 0,100% 100%,12px 100%,0 calc\(100% - 12px\)\)\}/);
  // A Link says where it came from; a File says what it is and how big.
  assert.match(shelf, /<span class="lib-res-domain">\$\{esc\(host \|\| 'Link'\)\}<\/span>/);
  assert.match(shelf, /<span class="lib-res-kind">\$\{esc\(fileKind\(item\)\)\}<\/span>/);
});

test('final: Media E shows the real thing, with no heavy footer bar (§26)', () => {
  // The preview is the default-plus-image pattern: a dead URL leaves a frame.
  assert.match(shelf, /onerror="this\.remove\(\)"/);
  assert.match(shelf, /loading="lazy"/);
  // Video always identifiable, and it says how long.
  assert.match(shelf, /item\.type === 'video' && Number\.isFinite\(item\.metadata\?\.durationSeconds\)/);
  assert.match(shelf, /<span class="lib-frame-play"/);
  /* The caption is plain text under the picture — no bar behind it. Measured:
   * the caption's background computes to rgba(0,0,0,0). */
  assert.match(shelf, /<span class="lib-cap" aria-hidden="true">/);
  assert.match(css, /\.lib-cap\{display:block;margin-top:8px;min-width:0\}/);
  assert.ok(!/\.lib-cap\{[^}]*background:/.test(css), 'the media caption has a bar behind it');
  // And the visual object gets the quiet foot, which carries only the action.
  assert.match(shelf, /<span class="lib-foot is-quiet" aria-hidden="true"><span class="lib-foot-a">Open<\/span><\/span>/);
});

/* ── §45  Accessibility ─────────────────────────────────────────────────── */

test('final: every object names itself and its type', () => {
  assert.match(shelf, /aria-label="\$\{esc\(item\.title\)\}\$\{b\.subtitle \? `\. \$\{esc\(b\.subtitle\)\}` : ''\}, Book\$\{/);
  assert.match(shelf, /aria-label="My Diary, Life OS Journal, opens Diary"/);
  assert.match(shelf, /aria-label="\$\{esc\(item\.title\)\}, \$\{TYPE_LABEL\[item\.type\] \?\? 'item'\}/);
  // Type is never communicated by shape alone: it is in the spoken name too.
  assert.match(shelf, /export const TYPE_LABEL = \{/);
  // Everything that turns says whether it is turned.
  assert.match(shelf, /role="button" tabindex="-1" aria-expanded="false"/);
  // The scenery is hidden; only the cover carries real text.
  assert.match(shelf, /<span class="lib-face lib-spine" aria-hidden="true">/);
  assert.match(shelf, /<span class="lib-face lib-back" aria-hidden="true"><\/span>/);
});

/* ── §2/§39  Isolation and regression ───────────────────────────────────── */

test('final: no concept-switching code reaches the real Library (§2)', () => {
  for (const [name, src] of [['library-shelf.js', shelf], ['library-book.js', book]] as const) {
    assert.ok(!/concept-|component-lab|lab-books|book-physics|library-lab/.test(src),
      `${name} reaches into the design lab`);
    assert.ok(!/\bcb-|\bc2-/.test(src), `${name} uses a lab class`);
  }
  /* `library-view.js` still carries the lab ROUTE, which is staging-only and
   * gated by the server — but no lab code renders the Library itself. */
  assert.ok(!/objectHtml[\s\S]{0,200}concept/.test(view), 'Library rendering branches on a concept');
});

test('final: the Book editor and the shelf remain separate implementations', () => {
  // The shelf never renders a page, and the Book view never renders a shelf.
  assert.ok(!/lib-vol|lib-face|is-nudge/.test(book), 'the Book view took shelf internals');
  assert.ok(!/bk-page|bk-spread/.test(shelf), 'the shelf took Book editor internals');
});

test('final: the shelf still reads as a shelf (§20)', () => {
  // Back plane, ledge line, lit edge, floor wash — the L3.2 construction, kept.
  assert.match(css, /--shelf-drop:30px/);
  assert.match(css, /\.lib-rail\{overflow-x:scroll/);
  for (const piece of ['--shelf-contact', '--shelf-head']) {
    assert.ok(css.includes(piece), `the shelf lost ${piece}`);
  }
});

test('final: scrolling a shelf returns the Book on it (§33)', () => {
  assert.match(shelf, /rail\.dataset\.pullAt = String\(rail\.scrollLeft\)/);
  assert.match(shelf, /clearPulled\(\)/);
});
