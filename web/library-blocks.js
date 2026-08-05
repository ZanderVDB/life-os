/**
 * Block editing — what Enter and Backspace mean inside a page.
 *
 * Separate from rendering on purpose. These are the rules that decide what the
 * document becomes, and they were the source of the F2.1 defect report: a
 * heading that appeared to have an empty line above it which the caret could
 * never reach.
 *
 * ── Everything here goes through execCommand ─────────────────────────────
 *
 * Not because it is a good API — it is deprecated — but because it is the only
 * one that edits a contenteditable while keeping the browser's own undo stack.
 * Hand-written DOM surgery would produce the right shape and then break Ctrl+Z,
 * which is a worse bug than the one it fixed. Selection moves between commands
 * are free: the undo stack records edits, not where the caret went.
 *
 * ── The rules, stated so they can be relied on ───────────────────────────
 *
 *   Enter at the END of a heading      → a body paragraph on the next row
 *   Enter at the START of a heading    → a real empty paragraph above it,
 *                                        caret stays in the heading
 *   Enter in the MIDDLE of a heading   → heading keeps the text before the
 *                                        caret; the rest becomes body
 *   Enter on an EMPTY list item        → leaves the list, as body
 *   Enter on an EMPTY quote paragraph  → leaves the quote, as body
 *   Backspace at the START of a heading→ becomes a body paragraph
 *                                        (it does NOT merge into the block
 *                                        above — converting is recoverable in
 *                                        one keystroke, merging is not)
 *
 * Everything else is left to the browser, which already does it correctly.
 */

const HEADINGS = new Set(['h2', 'h3']);
const tag = (el) => el?.nodeName?.toLowerCase() ?? '';

/** The direct child of the editor that the caret is in. */
export function blockOf(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let n = sel.anchorNode;
  if (!n || !root.contains(n)) return null;
  if (n.nodeType === Node.TEXT_NODE) n = n.parentElement;
  while (n && n.parentElement && n.parentElement !== root) n = n.parentElement;
  return n?.parentElement === root ? n : null;
}

/** The nearest ancestor of the caret matching `name`, within the editor. */
export function closestIn(root, name) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let n = sel.anchorNode;
  if (n?.nodeType === Node.TEXT_NODE) n = n.parentElement;
  while (n && n !== root) {
    if (tag(n) === name) return n;
    n = n.parentElement;
  }
  return null;
}

/**
 * Is the caret at the very start / end of `block`?
 *
 * Measured by the text BETWEEN the caret and the boundary, not by node offsets.
 * `<h2><strong>|Text</strong></h2>` is at the start even though the offset is 0
 * of a node that is not the block's first child, and offset arithmetic gets
 * that wrong every time there is a mark involved.
 */
export function caretAtStart(block) {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  const probe = document.createRange();
  probe.selectNodeContents(block);
  try { probe.setEnd(r.startContainer, r.startOffset); } catch { return false; }
  return probe.toString().length === 0;
}

export function caretAtEnd(block) {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  const probe = document.createRange();
  probe.selectNodeContents(block);
  try { probe.setStart(r.endContainer, r.endOffset); } catch { return false; }
  return probe.toString().length === 0;
}

/** Nothing but whitespace and the placeholder `<br>`. */
const isEmpty = (el) => !el || el.textContent.replace(/​/g, '').trim() === '';

function placeCaretIn(el, atEnd = false) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(!atEnd);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

const exec = (cmd, value = null) => document.execCommand(cmd, false, value);

/**
 * Enter.
 *
 * @returns {boolean} true if this took the keystroke; the caller then prevents
 *   the default so the browser does not act a second time.
 */
export function handleEnter(root) {
  const li = closestIn(root, 'li');
  const block = blockOf(root);
  if (!block) return false;

  /* An empty list item means "I am done with this list". Outdent lifts it out
   * and is undoable; deleting the node by hand would not be. */
  if (li && isEmpty(li)) {
    exec('outdent');
    // Chrome can leave a <div> behind. The grammar has no div, so normalise
    // now rather than letting htmlToDoc guess later.
    exec('formatBlock', '<p>');
    return true;
  }

  const quote = closestIn(root, 'blockquote');
  if (quote && !li) {
    const para = closestIn(root, 'p');
    if (para && isEmpty(para) && quote.lastElementChild === para) {
      exec('outdent');
      exec('formatBlock', '<p>');
      return true;
    }
    return false;         // a quote with real text splits normally
  }

  if (!HEADINGS.has(tag(block))) return false;

  if (caretAtStart(block) && !isEmpty(block)) {
    /* A real paragraph ABOVE, with the caret left in the heading.
     * insertParagraph at offset 0 gives two blocks of the heading's type; the
     * first is the empty one, so that is the one that becomes body. */
    exec('insertParagraph');
    const after = blockOf(root);
    const above = after?.previousElementSibling;
    if (above && HEADINGS.has(tag(above))) {
      placeCaretIn(above);
      exec('formatBlock', '<p>');
      const restored = blockOf(root)?.nextElementSibling;
      if (restored) placeCaretIn(restored);
    }
    return true;
  }

  /* At the end, or in the middle: the new block is always body. Two headings in
   * a row is almost never what Enter meant, and one keystroke turns it back. */
  exec('insertParagraph');
  exec('formatBlock', '<p>');
  return true;
}

/**
 * Backspace at the start of a heading turns it into body text.
 *
 * @returns {boolean} true if this took the keystroke.
 */
export function handleBackspace(root) {
  const block = blockOf(root);
  if (!block || !HEADINGS.has(tag(block))) return false;
  if (!caretAtStart(block)) return false;
  exec('formatBlock', '<p>');
  return true;
}

/**
 * The visible style names, and what they mean in the document.
 *
 * `h2`/`h3` are the document's business. What a person chooses is Body,
 * Heading, Subheading or Quote, and the interface says only that.
 */
export const BLOCK_STYLES = [
  { id: 'body', label: 'Body', tag: 'p' },
  { id: 'heading', label: 'Heading', tag: 'h2' },
  { id: 'subheading', label: 'Subheading', tag: 'h3' },
  { id: 'quote', label: 'Quote', tag: 'blockquote' },
];

const BY_TAG = new Map(BLOCK_STYLES.map((s) => [s.tag, s.id]));

/** The style id for a DOM tag, defaulting to Body for anything unstyled. */
export const styleIdForTag = (t) => BY_TAG.get(String(t).toLowerCase()) ?? 'body';

/** The tag a style id applies. */
export const tagForStyleId = (id) =>
  BLOCK_STYLES.find((s) => s.id === id)?.tag ?? 'p';

/**
 * Applies a block style.
 *
 * Leaving a quote needs `outdent`, not `formatBlock`: formatBlock on a
 * paragraph inside a blockquote restyles the paragraph and leaves it in the
 * quote, so "Quote → Body" would appear to do nothing.
 */
export function applyBlockStyle(root, id) {
  const target = tagForStyleId(id);
  const inQuote = closestIn(root, 'blockquote');
  if (inQuote && target !== 'blockquote') exec('outdent');
  exec('formatBlock', target === 'p' ? '<p>' : `<${target}>`);
  return target;
}

/** What the caret is sitting in, for the toolbar to reflect. */
export function currentStyleId(root) {
  if (closestIn(root, 'blockquote')) return 'quote';
  const block = blockOf(root);
  return styleIdForTag(tag(block));
}
