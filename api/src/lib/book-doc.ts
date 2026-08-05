/**
 * The book page document model.
 *
 * A page is a STRUCTURED DOCUMENT, not a string of HTML.
 *
 * Legacy stored `contenteditable.innerHTML` directly. Its own source comment
 * records the consequence: `execCommand` left `<font color="black">` wrappers
 * behind, which made text invisible on the dark theme, worked around with
 * `!important` on every descendant. That is what storing "whatever the browser
 * produced" costs — the data carries presentation decisions nobody made, and
 * every future renderer inherits them.
 *
 * So the wire format is a small, closed grammar. Anything not in it is
 * rejected at the door rather than stored and hoped about. That also makes the
 * XSS question trivial: there is no HTML to sanitise, because no HTML is ever
 * accepted.
 *
 * ── The grammar ─────────────────────────────────────────────────────────
 *
 *   doc         { type:'doc', content: Block[] }
 *   Block       paragraph | heading | bulletList | orderedList | blockquote
 *   paragraph   { type, content: Inline[] }
 *   heading     { type, attrs:{ level:2|3 }, content: Inline[] }
 *   list        { type, content: listItem[] }
 *   listItem    { type:'listItem', content: paragraph[] }
 *   blockquote  { type, content: paragraph[] }
 *   Inline      { type:'text', text, marks?: Mark[] }
 *   Mark        bold | italic | underline | strike | { type:'link', attrs:{ href } }
 *
 * Deliberately extensible: images, Library references, Task and Project
 * references and AI proposals all become new node types, and every one of them
 * is a node with attributes rather than a blob of markup. Markdown would have
 * made those impossible without inventing a syntax; HTML would have made them
 * unvalidatable.
 */

export type Mark =
  | { type: 'bold' | 'italic' | 'underline' | 'strike' }
  | { type: 'link'; attrs: { href: string } };

export type Inline = { type: 'text'; text: string; marks?: Mark[] };
export type Block = { type: string; attrs?: Record<string, unknown>; content?: unknown[] };
export type Doc = { type: 'doc'; content: Block[] };

export const EMPTY_DOC: Doc = { type: 'doc', content: [] };

const BLOCKS = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote']);
const SIMPLE_MARKS = new Set(['bold', 'italic', 'underline', 'strike']);

/** Only http(s). `javascript:` and `data:` are the whole reason this exists. */
function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (trimmed.length > 2000) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function cleanMarks(raw: unknown): Mark[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Mark[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const type = (m as any).type;
    if (SIMPLE_MARKS.has(type)) { out.push({ type } as Mark); continue; }
    if (type === 'link') {
      const href = safeHref((m as any).attrs?.href);
      // A link whose href is unusable becomes plain text rather than a broken
      // or dangerous link. Dropping the mark keeps the words.
      if (href) out.push({ type: 'link', attrs: { href } });
    }
  }
  return out.length ? out : undefined;
}

function cleanInline(raw: unknown): Inline[] {
  if (!Array.isArray(raw)) return [];
  const out: Inline[] = [];
  for (const n of raw) {
    if (!n || typeof n !== 'object' || (n as any).type !== 'text') continue;
    const text = (n as any).text;
    if (typeof text !== 'string' || text === '') continue;
    const marks = cleanMarks((n as any).marks);
    out.push(marks ? { type: 'text', text, marks } : { type: 'text', text });
  }
  return out;
}

function cleanParagraph(raw: unknown): Block | null {
  if (!raw || typeof raw !== 'object') return null;
  if ((raw as any).type !== 'paragraph') return null;
  return { type: 'paragraph', content: cleanInline((raw as any).content) };
}

function cleanBlock(raw: unknown, depth = 0): Block | null {
  if (!raw || typeof raw !== 'object' || depth > 3) return null;
  const type = (raw as any).type;
  if (!BLOCKS.has(type)) return null;

  if (type === 'paragraph') return cleanParagraph(raw);

  if (type === 'heading') {
    // Two levels only. A page is not a document outline, and h1 belongs to the
    // book, not to a page inside it.
    const level = (raw as any).attrs?.level === 3 ? 3 : 2;
    return { type: 'heading', attrs: { level }, content: cleanInline((raw as any).content) };
  }

  if (type === 'bulletList' || type === 'orderedList') {
    const items = Array.isArray((raw as any).content) ? (raw as any).content : [];
    const content = items
      .filter((li: any) => li && li.type === 'listItem')
      .map((li: any) => ({
        type: 'listItem',
        content: (Array.isArray(li.content) ? li.content : [])
          .map((p: unknown) => cleanBlock(p, depth + 1))
          .filter(Boolean),
      }))
      .filter((li: any) => li.content.length);
    return content.length ? { type, content } : null;
  }

  if (type === 'blockquote') {
    const content = (Array.isArray((raw as any).content) ? (raw as any).content : [])
      .map((p: unknown) => cleanParagraph(p))
      .filter(Boolean) as Block[];
    return content.length ? { type: 'blockquote', content } : null;
  }
  return null;
}

/**
 * Validates and normalises an incoming document.
 *
 * Never throws on unknown content — it DROPS it. A rejected save would lose
 * everything the user wrote to salvage nothing; dropping one unrecognised node
 * keeps the page. What it must never do is store something it does not
 * understand, because that is the thing that comes back to bite.
 */
export function validateDoc(raw: unknown): Doc {
  if (!raw || typeof raw !== 'object' || (raw as any).type !== 'doc') return EMPTY_DOC;
  const content = Array.isArray((raw as any).content) ? (raw as any).content : [];
  if (content.length > 500) throw Object.assign(new Error('That page is too long.'), { statusCode: 400 });
  const blocks = content.map((b: unknown) => cleanBlock(b)).filter(Boolean) as Block[];
  return { type: 'doc', content: blocks };
}

/**
 * The document's plain text, for search.
 *
 * Stored alongside the document and maintained on write, so searching is one
 * indexed `LIKE` rather than parsing every document in the workspace on every
 * keystroke — which is what Legacy did.
 */
export function docToText(doc: Doc): string {
  const out: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const node = n as any;
      if (node.type === 'text' && typeof node.text === 'string') out.push(node.text);
      else if (Array.isArray(node.content)) walk(node.content);
      // A block boundary is a space, so "end.Start" cannot match as one word.
      if (BLOCKS.has(node.type)) out.push(' ');
    }
  };
  walk(doc.content ?? []);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** A one-paragraph document, for seeds and simple writes. */
export const paragraph = (text: string): Block => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
});
