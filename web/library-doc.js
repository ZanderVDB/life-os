/**
 * The client's half of the page document model.
 *
 * The server grammar lives in `api/src/lib/book-doc.ts`; this mirrors it and
 * must not drift. Both directions are here — DOM out of a document, and a
 * document back out of the DOM — because they are the same mapping read twice,
 * and separating them is how they diverge.
 *
 * ── Forward compatibility (§13) ──────────────────────────────────────────
 *
 * The server DROPS node types it does not recognise. That is right at the
 * boundary — it must never store something it cannot describe — but it would be
 * catastrophic if the client repeated it, because the client round-trips: read
 * a page, edit one paragraph, save it back. A future `image` node written by a
 * newer build would be silently deleted by an older tab.
 *
 * So the client NEVER drops. An unknown node is rendered as a visible,
 * non-editable placeholder that says what it is, and is carried back out
 * verbatim on save. Content the user cannot yet edit is still content they
 * still have.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const EMPTY_DOC = { type: 'doc', content: [] };

/** Everything both sides understand. Keep in step with the server. */
const KNOWN_BLOCKS = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote',
]);
const MARK_TAG = { bold: 'strong', italic: 'em', underline: 'u', strike: 's' };

/* ── Document → DOM ──────────────────────────────────────────────────── */

function inlineHtml(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return '';
  return nodes.map((n) => {
    if (n?.type !== 'text' || typeof n.text !== 'string') return '';
    let html = esc(n.text);
    for (const m of n.marks ?? []) {
      if (MARK_TAG[m.type]) html = `<${MARK_TAG[m.type]}>${html}</${MARK_TAG[m.type]}>`;
      else if (m.type === 'link' && m.attrs?.href) {
        // `rel` is not decoration: a page can link anywhere, and a link that
        // hands the opener a window reference is a real hole.
        html = `<a href="${esc(m.attrs.href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
      }
    }
    return html;
  }).join('');
}

function blockHtml(node) {
  const type = node?.type;

  if (!KNOWN_BLOCKS.has(type)) {
    /* An unknown node — from a newer build, or a node type this version has
     * not learned yet. Shown, labelled, not editable, and preserved on save. */
    return `<div class="bk-unknown" contenteditable="false" data-unknown="${esc(
      JSON.stringify(node))}"><span>Content from a newer version${
      type ? ` (${esc(type)})` : ''} — open it in an updated tab to edit</span></div>`;
  }
  const inner = inlineHtml(node.content);
  switch (type) {
    case 'heading': {
      const level = node.attrs?.level === 3 ? 3 : 2;
      return `<h${level}>${inner || '<br>'}</h${level}>`;
    }
    case 'bulletList':
    case 'orderedList': {
      const tag = type === 'bulletList' ? 'ul' : 'ol';
      const items = (node.content ?? []).map((li) =>
        `<li>${(li.content ?? []).map((p) => inlineHtml(p.content)).join('<br>') || '<br>'}</li>`);
      return `<${tag}>${items.join('') || '<li><br></li>'}</${tag}>`;
    }
    case 'blockquote':
      return `<blockquote>${(node.content ?? [])
        .map((p) => `<p>${inlineHtml(p.content) || '<br>'}</p>`).join('')}</blockquote>`;
    default:
      // `<br>` rather than empty: a contenteditable paragraph with no content
      // has no height and cannot be clicked into.
      return `<p>${inner || '<br>'}</p>`;
  }
}

/** The editable HTML for one page. */
export function docToHtml(doc) {
  const blocks = doc?.content ?? [];
  if (!blocks.length) return '<p><br></p>';
  return blocks.map(blockHtml).join('');
}

/* ── DOM → document ──────────────────────────────────────────────────── */

function marksOf(el, root) {
  const marks = [];
  let node = el;
  while (node && node !== root) {
    const tag = node.nodeName?.toLowerCase();
    if (tag === 'strong' || tag === 'b') marks.push({ type: 'bold' });
    else if (tag === 'em' || tag === 'i') marks.push({ type: 'italic' });
    else if (tag === 'u') marks.push({ type: 'underline' });
    else if (tag === 's' || tag === 'strike' || tag === 'del') marks.push({ type: 'strike' });
    else if (tag === 'a' && node.getAttribute('href')) {
      marks.push({ type: 'link', attrs: { href: node.getAttribute('href') } });
    }
    node = node.parentElement;
  }
  // De-duplicated by type: nested <strong><strong> is one bold, not two.
  const seen = new Set();
  return marks.filter((m) => (seen.has(m.type) ? false : seen.add(m.type)));
}

function inlineFrom(el) {
  const out = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n = walk.nextNode();
  while (n) {
    const text = n.nodeValue ?? '';
    if (text) {
      const marks = marksOf(n.parentElement, el);
      out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
    }
    n = walk.nextNode();
  }
  return out;
}

function blockFrom(el) {
  // An unknown node carried through untouched — the whole point of §13.
  if (el.dataset?.unknown) {
    try { return JSON.parse(el.dataset.unknown); } catch { return null; }
  }
  const tag = el.nodeName.toLowerCase();
  if (tag === 'h2' || tag === 'h3') {
    return { type: 'heading', attrs: { level: tag === 'h3' ? 3 : 2 }, content: inlineFrom(el) };
  }
  if (tag === 'ul' || tag === 'ol') {
    const content = [...el.children]
      .filter((li) => li.nodeName.toLowerCase() === 'li')
      .map((li) => ({ type: 'listItem', content: [{ type: 'paragraph', content: inlineFrom(li) }] }))
      .filter((li) => li.content[0].content.length);
    return content.length ? { type: tag === 'ul' ? 'bulletList' : 'orderedList', content } : null;
  }
  if (tag === 'blockquote') {
    const paras = [...el.children].filter((c) => c.nodeName.toLowerCase() === 'p');
    const content = (paras.length ? paras : [el])
      .map((p) => ({ type: 'paragraph', content: inlineFrom(p) }))
      .filter((p) => p.content.length);
    return content.length ? { type: 'blockquote', content } : null;
  }
  return { type: 'paragraph', content: inlineFrom(el) };
}

/** Elements that are a block in this grammar. */
const BLOCK_TAGS = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'blockquote', 'div']);

/**
 * The editor's blocks, as a flat list.
 *
 * `execCommand` nests: apply a list inside a quote and you get
 * `<blockquote><h3><ul><li>…`. Reading only the editor's direct children then
 * treated that whole tower as one blockquote, and since it had no `<p>` child
 * the fallback swept every word into a single quoted paragraph — the heading
 * and the list survived as text and vanished as structure, silently, on the
 * next reload.
 *
 * So a block that CONTAINS blocks is unwrapped rather than read. The wrapper is
 * lost, which is correct: this grammar has no heading-inside-a-quote to store.
 * The content is kept, in the right shape, which is what matters.
 *
 * `ul`/`ol` are never unwrapped — their `li` children are their own content,
 * not nested blocks — and neither is an unknown node, which travels whole.
 */
function collectBlocks(root, depth = 0) {
  const out = [];
  for (const el of root.children) {
    const tag = el.nodeName.toLowerCase();
    if (el.dataset?.unknown || tag === 'ul' || tag === 'ol') { out.push(el); continue; }

    const kids = [...el.children].map((c) => c.nodeName.toLowerCase());
    // A blockquote made of paragraphs is a blockquote — that IS its shape. Only
    // a quote holding something else (a list, a heading) is a nesting accident.
    const nested = tag === 'blockquote'
      ? kids.some((k) => BLOCK_TAGS.has(k) && k !== 'p')
      : BLOCK_TAGS.has(tag) && kids.some((k) => BLOCK_TAGS.has(k));

    // A depth cap, because a malformed tree should degrade, never hang.
    if (nested && depth < 4) out.push(...collectBlocks(el, depth + 1));
    else out.push(el);
  }
  return out;
}

/**
 * Reads a document out of an editor element.
 *
 * Trailing empty paragraphs are trimmed — a contenteditable accumulates them
 * and they would otherwise grow the stored document every time the page is
 * opened. One is kept if that is all there is, so an empty page round-trips to
 * an empty document rather than to nothing.
 */
export function htmlToDoc(root) {
  const blocks = collectBlocks(root).map(blockFrom).filter(Boolean);
  while (blocks.length) {
    const last = blocks[blocks.length - 1];
    const empty = last.type === 'paragraph' && !(last.content ?? []).length;
    if (!empty) break;
    blocks.pop();
  }
  return { type: 'doc', content: blocks };
}

/** Cheap structural comparison, for "is this dirty?". */
export const sameDoc = (a, b) => JSON.stringify(a ?? EMPTY_DOC) === JSON.stringify(b ?? EMPTY_DOC);

/** A read-only rendering, for search excerpts and previews. */
export function docToText(doc) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n?.type === 'text' && typeof n.text === 'string') out.push(n.text);
      else if (Array.isArray(n?.content)) walk(n.content);
      if (KNOWN_BLOCKS.has(n?.type)) out.push(' ');
    }
  };
  walk(doc?.content);
  return out.join('').replace(/\s+/g, ' ').trim();
}
