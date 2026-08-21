/**
 * Book typographic grid and editor correction (Phase F2.1).
 *
 * The defect: converting a paragraph to a heading pushed it down by one ruled
 * row, and that row belonged to NO element — it was `margin-top: 30px`. A
 * margin is outside every box, so the caret could never be placed in it. It
 * looked like writing space and was not.
 *
 * The fix is one formula, not a set of nudges:
 *
 *     height = (lead + lines) x 30px
 *
 * `lead` is padding INSIDE the block (clickable, and it belongs to something),
 * and a lead row is painted over with paper so it carries no rule. A writable
 * blank line always has a rule; typography-owned space never does.
 *
 * What is asserted where:
 *   - the CSS model and the absence of margins — here, against the source;
 *   - the block rules (Enter, Backspace, style changes) — here, run in Node
 *     against a DOM stub, because they are logic;
 *   - the resulting pixel geometry — in a browser, because only a layout
 *     engine can produce it. Those numbers are in the phase report and in
 *     library-v2-client.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');

/* index.html + app.css: the stylesheet moved out of the page so the home
 * page is 5KB instead of 350KB. These assertions are about the app's CSS,
 * which is still the app's CSS — it just has its own file now. */
const html = read('index.html') + read('app.css');
const bookJs = read('library-book.js');
const blocksJs = read('editor-blocks.js');

const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const blocksCode = code(blocksJs);
const bookCode = code(bookJs);

/** The CSS rule body for a selector, comments stripped. */
function rule(selector: string): string {
  const src = html.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = src.indexOf(selector);
  assert.ok(at > -1, `no CSS rule for ${selector}`);
  const open = src.indexOf('{', at);
  const close = src.indexOf('}', open);
  return src.slice(open + 1, close);
}

/* ══ The grid model (§2, §8) ═══════════════════════════════════════════ */

test('the 30px cycle is stated once and every block follows it', () => {
  // The gradient, the line-height and the lead all come from the same number.
  assert.match(html, /transparent 29px,var\(--paper-line\) 29px,var\(--paper-line\) 30px/);
  assert.match(rule('.bk-editor{'), /line-height:30px/);
  assert.match(rule('.bk-editor > *{'), /line-height:30px/);
  assert.match(rule('.bk-editor h2,.bk-editor h3{'), /padding:30px 0 0/);
});

test('lead is padding, never margin — that is the whole fix', () => {
  // A margin belongs to no element, so the caret cannot be put in it. This is
  // the exact line that produced the inaccessible row.
  const heads = rule('.bk-editor h2,.bk-editor h3{');
  assert.match(heads, /margin:0/);
  assert.doesNotMatch(heads, /margin-top:\s*30px/);
  assert.doesNotMatch(heads, /margin:\s*30px/);
  // And no :first-child escape hatch, which would be a per-case patch.
  assert.doesNotMatch(code(html), /\.bk-editor h[23]:first-child\{margin-top:0\}/);
});

test('browser defaults are zeroed, so nothing can collapse or leak in', () => {
  assert.match(rule('.bk-editor > *{'), /margin:0/);
  assert.match(rule('.bk-editor > *{'), /padding:0/);
  for (const sel of ['.bk-editor ul,.bk-editor ol{', '.bk-editor li{',
    '.bk-editor blockquote{']) {
    assert.match(rule(sel), /margin:0/, `${sel} keeps a browser margin`);
  }
});

test('a lead row is unruled, so it cannot be mistaken for a writable line', () => {
  const mask = rule('.bk-editor h2::before,.bk-editor h3::before{');
  assert.match(mask, /position:absolute/);
  assert.match(mask, /top:0/);
  assert.match(mask, /height:30px/);
  assert.match(mask, /background:var\(--paper\)/);
  // It must never eat a click — the space belongs to the heading, and clicking
  // it has to put the caret there.
  assert.match(mask, /pointer-events:none/);
  assert.match(rule('.bk-editor h2,.bk-editor h3{'), /position:relative/);
});

test('lists and quotes claim no lead — they are exactly their content', () => {
  assert.match(rule('.bk-editor ul,.bk-editor ol{'), /padding:0 0 0 24px/);
  assert.match(rule('.bk-editor blockquote{'), /padding:0 0 0 15px/);
  // Horizontal padding only. Vertical padding here would be the same phantom
  // row in a different costume.
  assert.doesNotMatch(rule('.bk-editor blockquote{'), /padding:\s*\d+px \d+px \d+px \d+px/);
});

test('the ruled area is a whole number of rows', () => {
  // So the page ends ON a rule and an internal scroll moves whole lines.
  assert.match(rule('.bk-editor{'), /height:round\(down,100%,30px\)/);
});

test('the page title band has an explicit height', () => {
  // §9: the body grid must begin at a stated place, not wherever a font left it.
  assert.match(rule('.bk-page-hdr{'), /height:60px/);
  assert.match(rule('.bk-page-hdr{'), /margin:0/);
});

test('no per-element escape hatches were used', () => {
  // §8: one model, or it is not a model. These are what "patching examples"
  // looks like, and none of them may appear in the editor's CSS.
  const editorCss = html.slice(html.indexOf('THE BLOCK GRID'), html.indexOf('.bk-unknown'));
  assert.doesNotMatch(editorCss, /margin-top:-/, 'a negative margin was used');
  assert.doesNotMatch(editorCss, /translateY/, 'a transform was used to nudge a block');
  assert.doesNotMatch(editorCss, /@media[^{]*\{[^}]*\.bk-editor (h2|h3|li|blockquote)/,
    'a viewport-specific correction was used');
});

/* ══ The block rules (§4, §5, §7) ══════════════════════════════════════ */

const blocks = await import('../../web/editor-blocks.js' as string);

test('the visible style names never expose a DOM tag', () => {
  // §5: Body / Heading / Subheading / Quote. `h2` is the document's business.
  assert.deepEqual(blocks.BLOCK_STYLES.map((s: any) => s.label),
    ['Body', 'Heading', 'Subheading', 'Quote']);
  assert.deepEqual(blocks.BLOCK_STYLES.map((s: any) => s.id),
    ['body', 'heading', 'subheading', 'quote']);
  // The option VALUES are the ids, so nothing in the markup says "h2" either.
  assert.match(bookJs, /BLOCK_STYLES\.map\(\(st\) => `<option value="\$\{st\.id\}"/);
  assert.doesNotMatch(bookCode, /<option value="h[23]"/);
});

test('style ids map to the document both ways', () => {
  assert.equal(blocks.tagForStyleId('heading'), 'h2');
  assert.equal(blocks.tagForStyleId('subheading'), 'h3');
  assert.equal(blocks.tagForStyleId('body'), 'p');
  assert.equal(blocks.tagForStyleId('quote'), 'blockquote');
  assert.equal(blocks.styleIdForTag('H2'), 'heading');
  assert.equal(blocks.styleIdForTag('h3'), 'subheading');
  assert.equal(blocks.styleIdForTag('div'), 'body', 'an unstyled block is Body');
});

test('every edit goes through execCommand, so undo keeps working', () => {
  // Hand-written DOM surgery produces the right shape and then breaks Ctrl+Z,
  // which is a worse bug than the one it fixes.
  assert.doesNotMatch(blocksCode, /\.remove\(\)|\.insertBefore\(|\.appendChild\(|\.after\(/,
    'the block rules edit the DOM directly instead of through execCommand');
  assert.match(blocksCode, /const exec = \(cmd, value = null\) => document\.execCommand/);
});

test('leaving a quote outdents rather than reformatting', () => {
  // formatBlock on a paragraph inside a blockquote restyles the paragraph and
  // leaves it in the quote, so "Quote to Body" appeared to do nothing.
  const fn = blocksCode.slice(blocksCode.indexOf('export function applyBlockStyle'));
  assert.match(fn.slice(0, 400), /closestIn\(root, 'blockquote'\)/);
  assert.match(fn.slice(0, 400), /exec\('outdent'\)/);
});

test('an empty list item leaves the list, and an empty quote paragraph leaves the quote', () => {
  const fn = blocksCode.slice(blocksCode.indexOf('export function handleEnter'));
  assert.match(fn, /if \(li && isEmpty\(li\)\)[\s\S]{0,120}exec\('outdent'\)/);
  assert.match(fn, /quote\.lastElementChild === para[\s\S]{0,120}exec\('outdent'\)/);
  // Chrome can leave a <div>; the grammar has no div, so it is normalised at
  // the point of the edit rather than guessed at by htmlToDoc later.
  assert.match(fn, /exec\('formatBlock', '<p>'\)/);
});

test('Enter never produces a second heading', () => {
  // Two headings in a row is almost never what Enter meant, and one keystroke
  // turns it back.
  const fn = blocksCode.slice(blocksCode.indexOf('export function handleEnter'));
  const tail = fn.slice(fn.indexOf('caretAtStart'));
  assert.match(tail, /exec\('insertParagraph'\);\s*exec\('formatBlock', '<p>'\)/);
});

test('the caret rules read text, not node offsets', () => {
  // `<h2><strong>|Text</strong></h2>` is at the start even though the offset is
  // 0 of a node that is not the block's first child. Offset arithmetic gets
  // that wrong every time a mark is involved.
  for (const fn of ['caretAtStart', 'caretAtEnd']) {
    const body = blocksCode.slice(blocksCode.indexOf(`export function ${fn}`));
    assert.match(body.slice(0, 500), /probe\.toString\(\)\.length === 0/,
      `${fn} does not compare text`);
  }
});

test('Backspace at the start of a heading converts rather than merges', () => {
  const fn = blocksCode.slice(blocksCode.indexOf('export function handleBackspace'));
  assert.match(fn.slice(0, 400), /caretAtStart\(block\)/);
  assert.match(fn.slice(0, 400), /exec\('formatBlock', '<p>'\)/);
  assert.doesNotMatch(fn.slice(0, 400), /delete|merge/i);
});

test('Enter and Backspace are claimed before the browser sees them', () => {
  const kd = bookCode.slice(bookCode.indexOf("el.addEventListener('keydown'"));
  const handler = kd.slice(0, kd.indexOf('});'));
  assert.match(handler, /if \(handleEnter\(el\)\) \{\s*e\.preventDefault\(\)/);
  assert.match(handler, /if \(handleBackspace\(el\)\) \{\s*e\.preventDefault\(\)/);
  // Shift+Enter is a soft break and stays the browser's.
  assert.match(handler, /e\.key === 'Enter' && !e\.shiftKey/);
  // A claimed keystroke still has to reach autosave.
  assert.match(handler, /new Event\('input', \{ bubbles: true \}\)/);
});

test('the toolbar reads the caret from the DOM, not from queryCommandValue', () => {
  // queryCommandValue reports a paragraph inside a blockquote as "p", so Quote
  // never showed as the active style.
  assert.match(bookCode, /const id = currentStyleId\(ed\)/);
  const paint = bookCode.slice(bookCode.indexOf('function updateToolbarState'));
  assert.doesNotMatch(paint.slice(0, 900), /queryCommandValue\('formatBlock'\)/);
  // §13: the active type is announced, not just shown.
  assert.match(paint, /setAttribute\('aria-label', `Text style: /);
});

/* ══ Structure safety (§12, §13) ═══════════════════════════════════════ */

test('no spacer node is ever inserted to correct a visual offset', () => {
  // The structured document must reflect only actual content. The whole point
  // of solving this in CSS is that the JSON is untouched by it.
  for (const [name, src] of Object.entries({ blocks: blocksCode, book: bookCode })) {
    assert.doesNotMatch(src, /spacer|&nbsp;|\\u00a0/i, `${name} inserts filler`);
  }
});

test('headings, lists and quotes stay real elements', () => {
  // §13: not styled paragraphs imitating them.
  assert.match(bookCode, /docToHtml/);
  const doc = code(read('editor-doc.js'));
  /* Real elements, now carrying their stable block id. `${bid}` is an
   * attribute, not a wrapper: the heading is still an `h2`, which is the thing
   * §13 is about. The id is what a bookmark, a Task link and a future AI
   * citation point at, and it has to survive the round trip through a
   * contenteditable — see htmlToDoc. */
  assert.match(doc, /return `<h\$\{level\}\$\{bid\}>/);
  assert.match(doc, /type === 'bulletList' \? 'ul' : 'ol'/);
  assert.match(doc, /return `<blockquote\$\{bid\}>/);
  assert.match(doc, /const bid = node\.attrs\?\.id \? ` data-block="/);
  assert.match(doc, /\{ type: 'heading', attrs: \{ level: tag === 'h3' \? 3 : 2 \}/);
});

/* ══ Regression: F2 must be untouched (§14) ════════════════════════════ */

test('the approved Book geometry is unchanged', () => {
  for (const r of [
    'aspect-ratio:210/297', 'aspect-ratio:420/297', 'max-width:780px', 'max-width:1320px',
    'gap:6px', 'padding:28px 32px 18px 58px', 'border-radius:14px',
    'border-radius:20px 20px 4px 4px',
  ]) {
    assert.ok(html.includes(r), `F2.1 changed the approved geometry: ${r}`);
  }
  assert.match(html, /\.bk-page::before\{[^}]*left:46px/);
  assert.match(html, /inset 3px 0 0 0 var\(--accent-c/);
  assert.match(html, /inset -3px 0 0 0 var\(--accent-c/);
  assert.match(html, /\.26s cubic-bezier\(\.4,0,\.2,1\)/);
});

test('the cover is unchanged', () => {
  assert.match(html, /\.bk-cover-title\{[^}]*font-size:64px/);
  assert.match(html, /\.bk-cover-rule\{width:140px/);
  assert.match(bookJs, /bk-cover-pre">Notebook/);
});

test('the mobile width fix is unchanged', () => {
  /* `:not(.dia-book)` since D2: the Diary reuses `.bk-spread` for its own
   * two pages, and STACKS them on a phone rather than paginating. Without
   * the exclusion this rule hid the diary's entire right page. */
  assert.match(html, /\.bk-book\.bk-spread:not\(\.dia-book\)\{aspect-ratio:210\/297/);
  assert.match(html, /#bk-prev\{left:2px\}/);
  assert.match(html, /#bk-next\{right:2px\}/);
});

test('body text is still Inter and no handwriting font was introduced', () => {
  // §5: Playfair may stay for headings; body stays Inter.
  assert.doesNotMatch(html, /Kalam/);
  assert.doesNotMatch(rule('.bk-editor{'), /font-family/);
  assert.match(rule('.bk-editor h2,.bk-editor h3{'), /'Playfair Display'/);
});

test('autosave and its conflict handling are untouched', () => {
  /* The rules moved to `editor-save.js` in D1 so Diary could reuse rather than
   * fork them. The rules themselves did not change, and this asserts exactly
   * that — the behavioural tests in library-f2.test.ts run the machine and are
   * the real proof. */
  const save = code(read('editor-save.js'));
  assert.match(save, /expectedUpdatedAt: sentVersion \?\? undefined/);
  assert.match(save, /if \(e\.version !== sentVersion\)/);
  assert.match(save, /err\.conflict\) setStatus\(e, 'conflict'/);
  // And Library still binds it to Library's endpoint, not to a copy.
  const binding = code(read('library-save.js'));
  assert.match(binding, /createSaveCoordinator/);
  assert.match(binding, /savePage\(pageId/);
});
