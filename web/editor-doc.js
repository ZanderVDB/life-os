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
/**
 * Reference blocks.
 *
 * A reference carries an ID and nothing else. What it SHOWS — a Task's title,
 * whether it is done, when it is due — is read from the live entity at render
 * time and handed in through `refs`. The moment a title is copied into a page
 * it starts being wrong, and nothing will ever tell you which copy is real.
 */
const REF_BLOCKS = new Set(['taskRef', 'projectRef', 'bookRef', 'pageRef', 'resourceRef']);
const REF_ID_ATTR = {
  taskRef: 'taskId', projectRef: 'projectId', bookRef: 'bookId',
  pageRef: 'pageId', resourceRef: 'itemId',
};

const KNOWN_BLOCKS = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote',
  'checkItem', ...REF_BLOCKS,
]);
const MARK_TAG = { bold: 'strong', italic: 'em', underline: 'u', strike: 's' };

/**
 * Block identity, client side.
 *
 * The server assigns an id to any block that arrives without one, but the
 * editor has to mint them too: a block created and then referenced before the
 * next save has to have a name during that window, or a bookmark made in that
 * moment points at nothing.
 */
let seq = 0;
export const newBlockId = () => {
  seq = (seq + 1) % 0xffff;
  return `b${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
};

/* What the live entity a reference points at is currently called. Set by the
 * Book view from the `refs` the server resolved alongside the page. */
let refLookup = () => null;
export const setRefLookup = (fn) => { refLookup = typeof fn === 'function' ? fn : () => null; };

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

/**
 * A reference, drawn from the live entity.
 *
 * `contenteditable="false"` so the card is an object in the text rather than
 * something you can type into the middle of, and the id travels in a data
 * attribute so reading the DOM back reconstructs the node exactly.
 *
 * A reference whose target has been deleted renders as UNAVAILABLE and stays in
 * the page (§15). Removing writing because a Task was deleted somewhere else is
 * exactly the silent data loss the delete semantics forbid.
 */
function refHtml(node) {
  const type = node.type;
  const attr = REF_ID_ATTR[type];
  const id = node.attrs?.[attr];
  const live = refLookup(type, id);
  const bid = node.attrs?.id ?? '';

  if (!live) {
    return `<div class="bk-ref bk-ref-gone" contenteditable="false" data-ref="${esc(type)}"
      data-ref-id="${esc(id ?? '')}" data-block="${esc(bid)}">
      <span class="bk-ref-k">${type === 'taskRef' ? 'Task' : 'Reference'}</span>
      <span class="bk-ref-t">No longer available</span>
      <button type="button" class="bk-ref-x" data-ref-remove aria-label="Remove this reference">×</button>
    </div>`;
  }

  const done = live.status === 'done' || live.status === 'completed';
  const meta = [
    live.dueDate ? `Due ${esc(String(live.dueDate).slice(5))}` : '',
    live.priority && live.priority !== 'normal' ? esc(live.priority) : '',
    live.stepsTotal ? `${live.stepsDone ?? 0}/${live.stepsTotal} steps` : '',
  ].filter(Boolean);

  return `<div class="bk-ref bk-ref-${esc(type.replace('Ref', ''))}${done ? ' is-done' : ''}"
    contenteditable="false" data-ref="${esc(type)}" data-ref-id="${esc(id)}"
    data-block="${esc(bid)}" tabindex="0" role="link"
    aria-label="${esc(live.title ?? 'Reference')}${done ? ', done' : ''}">
    <span class="bk-ref-k">${esc(live.kindLabel ?? 'Task')}</span>
    <span class="bk-ref-t">${esc(live.title ?? '')}</span>
    ${meta.length ? `<span class="bk-ref-m">${meta.join(' · ')}</span>` : ''}
    <button type="button" class="bk-ref-x" data-ref-remove
      aria-label="Remove this reference from the page">×</button>
  </div>`;
}

function blockHtml(node) {
  const type = node?.type;

  if (REF_BLOCKS.has(type)) return refHtml(node);

  if (type === 'checkItem') {
    const on = node.attrs?.checked === true;
    /* The box is not editable; the words are. One element with two editing
     * rules is what keeps a checklist a paragraph you can tick rather than a
     * widget you have to fight. */
    return `<div class="bk-check${on ? ' is-on' : ''}" data-block="${esc(node.attrs?.id ?? '')}">
      <span class="bk-check-box" contenteditable="false" data-check
        role="checkbox" aria-checked="${on}" tabindex="0"></span>
      <span class="bk-check-t">${inlineHtml(node.content) || '<br>'}</span>
    </div>`;
  }

  if (!KNOWN_BLOCKS.has(type)) {
    /* An unknown node — from a newer build, or a node type this version has
     * not learned yet. Shown, labelled, not editable, and preserved on save. */
    return `<div class="bk-unknown" contenteditable="false" data-unknown="${esc(
      JSON.stringify(node))}"><span>Content from a newer version${
      type ? ` (${esc(type)})` : ''} — open it in an updated tab to edit</span></div>`;
  }
  const inner = inlineHtml(node.content);
  /* The block's stable id rides on the element. It is what a bookmark, a Task
   * link and a future AI citation all point at, so it has to survive the trip
   * through a contenteditable and back — see blockFrom. */
  const bid = node.attrs?.id ? ` data-block="${esc(node.attrs.id)}"` : '';
  switch (type) {
    case 'heading': {
      const level = node.attrs?.level === 3 ? 3 : 2;
      return `<h${level}${bid}>${inner || '<br>'}</h${level}>`;
    }
    case 'bulletList':
    case 'orderedList': {
      const tag = type === 'bulletList' ? 'ul' : 'ol';
      const items = (node.content ?? []).map((li) =>
        `<li>${(li.content ?? []).map((p) => inlineHtml(p.content)).join('<br>') || '<br>'}</li>`);
      return `<${tag}${bid}>${items.join('') || '<li><br></li>'}</${tag}>`;
    }
    case 'blockquote':
      return `<blockquote${bid}>${(node.content ?? [])
        .map((p) => `<p>${inlineHtml(p.content) || '<br>'}</p>`).join('')}</blockquote>`;
    default:
      // `<br>` rather than empty: a contenteditable paragraph with no content
      // has no height and cannot be clicked into.
      return `<p${bid}>${inner || '<br>'}</p>`;
  }
}

/**
 * The editable HTML for one page, or for one REGION of one page.
 *
 * Multi-column layouts are not a second document model: every block carries an
 * optional `attrs.region`, and each column renders the blocks that claim it.
 * That keeps one page, one document, one save and one search index however many
 * columns the template happens to draw — and a layout change between flowed
 * templates never has to migrate anything.
 */
export function docToHtml(doc, region = null) {
  let blocks = doc?.content ?? [];
  if (region) {
    blocks = blocks.filter((b) => (b?.attrs?.region ?? 'a') === region);
  }
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

  /* A reference reads back from its data attributes, never from what it is
   * currently DRAWING. The card shows a live title; storing what the card said
   * would be storing a copy of the title, which is the whole thing references
   * exist to avoid. */
  if (el.dataset?.ref) {
    const type = el.dataset.ref;
    const attr = REF_ID_ATTR[type];
    if (!attr || !el.dataset.refId) return null;
    return { type, attrs: { id: el.dataset.block || newBlockId(), [attr]: el.dataset.refId } };
  }

  if (el.classList?.contains('bk-check')) {
    const text = el.querySelector('.bk-check-t');
    return {
      type: 'checkItem',
      attrs: {
        id: el.dataset.block || newBlockId(),
        checked: el.classList.contains('is-on'),
      },
      content: text ? inlineFrom(text) : [],
    };
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
    /* A reference card and a check item are single blocks with structure
     * INSIDE them. Unwrapping either would turn one object into its parts. */
    if (el.dataset?.ref || el.classList?.contains('bk-check')) { out.push(el); continue; }

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
export function htmlToDoc(root, region = null) {
  const els = collectBlocks(root);
  const blocks = els.map((el, i) => {
    const b = blockFrom(el);
    if (!b) return null;
    /* Identity is preserved across the round trip, not regenerated. A block
     * whose id changed on every save would break every bookmark and every link
     * pointing at it, silently, the first time the page was touched. A block
     * the user just created has no id yet and gets one here. */
    b.attrs = { ...(b.attrs ?? {}) };
    if (!b.attrs.id) b.attrs.id = els[i]?.dataset?.block || newBlockId();
    if (region) b.attrs.region = region;
    return b;
  }).filter(Boolean);

  while (blocks.length) {
    const last = blocks[blocks.length - 1];
    const empty = last.type === 'paragraph' && !(last.content ?? []).length;
    if (!empty) break;
    blocks.pop();
  }
  return { type: 'doc', content: blocks };
}

/**
 * One document from several region editors.
 *
 * The regions are read in template order and concatenated, so the stored
 * document keeps a stable, readable sequence — which matters because search,
 * plain-text extraction and anything reading the page later see that order and
 * not the columns.
 */
export function regionsToDoc(editors) {
  const content = [];
  for (const { region, el } of editors) {
    content.push(...htmlToDoc(el, region).content);
  }
  return { type: 'doc', content };
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
