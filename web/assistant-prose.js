/**
 * Rendering an answer — the small formatting subset, and nothing else.
 *
 * ── The problem ──────────────────────────────────────────────────────────
 *
 * The assistant writes like a person, and people writing quickly reach for
 * `**Urgent**` and a hyphen list. Rendered with `esc()` and nothing else, that
 * reached the screen as literal asterisks. Telling the model never to use them
 * helps and does not hold: models slip, and a slip should look like a bold
 * word rather than like a bug.
 *
 * ── Why not a Markdown library ───────────────────────────────────────────
 *
 * Because the surface does not want Markdown. It wants three things —
 * paragraphs, a bold run, a simple list — and a library would bring headings,
 * tables, images, raw HTML passthrough and a sanitiser to undo it again. The
 * whole grammar below is four rules, and the security argument is the short
 * one: EVERYTHING IS ESCAPED FIRST. Tags are produced only by this file, from
 * a fixed set, after the text can no longer contain any. There is no path by
 * which model output becomes an element.
 *
 * Anything outside the subset — a heading, a link, a code fence — has its
 * markers stripped and its words kept. That is the honest fallback: the reader
 * loses an emphasis they were never promised, not the sentence.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Bold and inline code, on text that is ALREADY escaped. */
function inline(safe) {
  return safe
    /* `**bold**` and `__bold__`. Non-greedy, no nesting, no crossing a line. */
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    /* A single `*word*` is emphasis in Markdown and a bullet or a footnote
       everywhere else, so it is left alone rather than guessed at. */
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    /* Markers for things this subset does not render: keep the words.
       `&gt;` rather than `>` because this runs on ALREADY-ESCAPED text — which
       is the whole safety argument, and also the reason a blockquote marker
       has to be matched in its escaped form. */
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^&gt;\s?/gm, '');
}

/* A bare marker with nothing after it counts as a bullet — an empty one,
   which `flushList` then drops. Otherwise a lone "-" falls through and is
   drawn as a paragraph containing a hyphen, which is the same padding showing
   up in a different shape. */
const BULLET = /^\s{0,3}[-*•](?:\s+(.*))?$/;
const NUMBER = /^\s{0,3}(\d{1,2})[.)](?:\s+(.*))?$/;

/**
 * An answer, as HTML.
 *
 * Blank lines separate paragraphs; consecutive bullet or number lines become
 * one list; everything else is a paragraph. Empty list items are dropped —
 * "Two more without a priority set: - (none visible)" was the model padding a
 * list it could not fill, and an empty bullet is the visible half of that.
 */
export function proseHtml(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return '';

  const lines = esc(raw).split('\n');
  const out = [];
  let list = null;          // { tag, items }
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.filter((i) => i.trim().length);
    if (items.length) {
      out.push(`<${list.tag}>${items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    }
    list = null;
  };

  for (const line of lines) {
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const bullet = line.match(BULLET);
    const numbered = line.match(NUMBER);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((bullet ? bullet[1] : numbered[2]) ?? '');
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join('');
}

/**
 * The same text with every marker removed, for somewhere that cannot hold
 * elements — a transcript line, a toast, an aria-label.
 */
export function proseText(text) {
  return String(text ?? '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export { esc };
