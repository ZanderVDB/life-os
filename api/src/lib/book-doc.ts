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

/**
 * Reference nodes.
 *
 * A reference stores an ID and NOTHING ELSE — no title, no status, no date.
 * Those are read from the canonical row every time the page renders. The moment
 * a title is copied into a page it starts being wrong, and nothing in the
 * system will ever tell you which of the two copies is the real one.
 *
 * This is also what makes the page legible to something other than a renderer:
 * a link that exists as `{type:'taskRef', attrs:{taskId}}` can be followed by a
 * query, while a link that exists as the words "see the deposit task" cannot.
 */
const REF_BLOCKS = new Set(['taskRef', 'projectRef', 'bookRef', 'pageRef', 'resourceRef']);
const REF_ID_ATTR: Record<string, string> = {
  taskRef: 'taskId',
  projectRef: 'projectId',
  bookRef: 'bookId',
  pageRef: 'pageId',
  resourceRef: 'itemId',
};

const BLOCKS = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote',
  'checkItem', ...REF_BLOCKS,
]);
const SIMPLE_MARKS = new Set(['bold', 'italic', 'underline', 'strike']);

/** Regions for the multi-column layouts. A block outside these falls to 'a'. */
export const REGIONS = ['a', 'b', 'c', 'd'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * Block identity.
 *
 * Every top-level block carries a stable `id`, assigned here on write if the
 * client did not supply one, and PRESERVED if it did. That id is what a
 * bookmark, a Task link and a future AI citation all point at — "Garden
 * Renovation → Payments → Contractor Deposit" is only addressable if the block
 * has a name that survives the next edit.
 *
 * Ids are short and random rather than UUIDs: there are hundreds per page, they
 * are never foreign keys, and they travel in every save.
 */
let counter = 0;
export function blockId(): string {
  counter = (counter + 1) % 0xffff;
  return `b${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

const keepId = (raw: any): string => {
  const given = raw?.attrs?.id;
  return typeof given === 'string' && given.length > 0 && given.length <= 40 ? given : blockId();
};

const keepRegion = (raw: any): string | undefined => {
  const r = raw?.attrs?.region;
  return (REGIONS as readonly string[]).includes(r) ? r : undefined;
};

/** `id` and `region` ride along on every block, so this is written once. */
function withMeta(raw: any, block: Block): Block {
  const region = keepRegion(raw);
  block.attrs = { ...(block.attrs ?? {}), id: keepId(raw), ...(region ? { region } : {}) };
  return block;
}

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

function cleanParagraph(raw: unknown, top = false): Block | null {
  if (!raw || typeof raw !== 'object') return null;
  if ((raw as any).type !== 'paragraph') return null;
  const block: Block = { type: 'paragraph', content: cleanInline((raw as any).content) };
  // Only TOP-level blocks are addressable. A paragraph inside a list item is
  // part of that item, and giving it an id would invite citations to something
  // that cannot be navigated to.
  return top ? withMeta(raw, block) : block;
}

function cleanBlock(raw: unknown, depth = 0): Block | null {
  if (!raw || typeof raw !== 'object' || depth > 3) return null;
  const type = (raw as any).type;
  if (!BLOCKS.has(type)) return null;
  const top = depth === 0;

  if (type === 'paragraph') return cleanParagraph(raw, top);

  /* A reference is an ID and a relationship. Everything shown about the target
   * — its title, whether it is done, when it is due — is read live from the
   * target's own row at render time. */
  if (REF_BLOCKS.has(type)) {
    const attr = REF_ID_ATTR[type]!;
    const id = (raw as any).attrs?.[attr];
    if (!isUuid(id)) return null;      // a reference to nothing is not content
    const label = (raw as any).attrs?.label;
    return withMeta(raw, {
      type,
      attrs: {
        [attr]: id,
        ...(typeof label === 'string' && label ? { label: label.slice(0, 200) } : {}),
      },
    });
  }

  if (type === 'checkItem') {
    return withMeta(raw, {
      type: 'checkItem',
      attrs: { checked: (raw as any).attrs?.checked === true },
      content: cleanInline((raw as any).content),
    });
  }

  if (type === 'heading') {
    // Two levels only. A page is not a document outline, and h1 belongs to the
    // book, not to a page inside it.
    const level = (raw as any).attrs?.level === 3 ? 3 : 2;
    const block: Block = { type: 'heading', attrs: { level }, content: cleanInline((raw as any).content) };
    return top ? withMeta(raw, block) : block;
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
    if (!content.length) return null;
    const block: Block = { type, content };
    return top ? withMeta(raw, block) : block;
  }

  if (type === 'blockquote') {
    const content = (Array.isArray((raw as any).content) ? (raw as any).content : [])
      .map((p: unknown) => cleanParagraph(p))
      .filter(Boolean) as Block[];
    if (!content.length) return null;
    const block: Block = { type: 'blockquote', content };
    return top ? withMeta(raw, block) : block;
  }
  return null;
}

/* ── Pinboards ──────────────────────────────────────────────────────────
 *
 * A pinboard is a page whose content is POSITIONED rather than flowed, so it
 * gets its own document shape rather than being forced through the block
 * grammar. Same rules otherwise: every item has a stable id, and an item that
 * points at another entity stores the id and nothing else.
 *
 * Coordinates are percentages of the spread, not pixels. A pinboard laid out on
 * a 2560px monitor has to be the same pinboard on a laptop, and pixels would
 * make the arrangement a property of the screen it was made on.
 */
export const PIN_KINDS = ['text', 'image', 'link', 'video', 'file', 'task', 'project', 'resource', 'page'] as const;

/**
 * Note styles and image frames.
 *
 * A deliberately short list. A pinboard should be able to look like something
 * a person arranged, which a single grey card cannot — but an open colour
 * picker turns every board into confetti, and then the colours stop meaning
 * anything at all. Seven notes and three frames is enough to group by eye.
 */
export const NOTE_STYLES = ['plain', 'sun', 'rose', 'sky', 'sage', 'ink', 'quote'] as const;
export const IMAGE_FRAMES = ['none', 'frame', 'polaroid'] as const;

const PIN_REF_ATTR: Record<string, string> = {
  task: 'taskId', project: 'projectId', resource: 'itemId', page: 'pageId',
};

export type PinItem = {
  id: string; kind: string;
  x: number; y: number; w: number; h: number;
  text?: string; href?: string; accent?: string;
  taskId?: string; projectId?: string; itemId?: string; pageId?: string;
  /* Membership lives on the ITEM, not as a list on the group. One source of
   * truth: moving a pin out of a group is one field, and there is no way for
   * a group's list and an item's belief about itself to disagree. */
  groupId?: string;
  z?: number;
  style?: string; frame?: string; caption?: string;
  fileName?: string; fileType?: string; fileSize?: number;
  createdAt?: string; updatedAt?: string;
};

/** A group is identity and a name. What belongs to it is on the items. */
export type PinGroup = { id: string; title?: string };

/**
 * A relationship between two pins, stored as data rather than drawn as decoration.
 *
 * The line on screen is the least important part. This is a structured edge —
 * stable id, stable endpoints — so that a later reader can know the beach
 * photo and the location link belong to the same thought, without having to
 * infer it from two boxes happening to sit near each other.
 */
export type PinConnection = { id: string; from: string; to: string; label?: string };

export type Pinboard = {
  type: 'pinboard'; items: PinItem[]; groups: PinGroup[]; connections: PinConnection[];
};

export const EMPTY_PINBOARD: Pinboard = {
  type: 'pinboard', items: [], groups: [], connections: [],
};

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100));
};

/** One embedded image, and the whole board's worth. */
const MAX_IMAGE_CHARS = 900_000;
const MAX_BOARD_IMAGE_CHARS = 4_000_000;

const DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/i;

/**
 * An image source: an ordinary URL, or a bounded inline raster.
 *
 * Pasting a screenshot has to work, and there is no blob storage in this
 * stack, so a pasted image is stored inline. Two limits make that safe rather
 * than reckless: a size cap, and a whitelist of RASTER types only. SVG is
 * excluded deliberately — an SVG can carry script, and while an `<img>` will
 * not run it, storing one means the next surface to render it inline inherits
 * a problem this one merely avoided.
 */
function safeImageSrc(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const t = href.trim();
  if (/^data:/i.test(t)) {
    if (t.length > MAX_IMAGE_CHARS) return null;
    return DATA_IMAGE_RE.test(t) ? t : null;
  }
  return safeHref(t);
}

export function validatePinboard(raw: unknown): Pinboard {
  const src = raw && typeof raw === 'object' ? raw as any : {};
  const items = Array.isArray(src.items) ? src.items : [];
  if (items.length > 200) {
    throw Object.assign(new Error('That pinboard has too many items.'), { statusCode: 400 });
  }

  /* Groups first: an item may only claim a group that exists. */
  const groups: PinGroup[] = [];
  const groupIds = new Set<string>();
  for (const g of (Array.isArray(src.groups) ? src.groups : [])) {
    if (!g || typeof g !== 'object') continue;
    const id = typeof g.id === 'string' && g.id ? String(g.id).slice(0, 40) : blockId();
    if (groupIds.has(id)) continue;
    groupIds.add(id);
    const title = typeof g.title === 'string' ? g.title.slice(0, 80).trim() : '';
    groups.push(title ? { id, title } : { id });
  }

  const out: PinItem[] = [];
  const seen = new Set<string>();
  let imageChars = 0;
  for (const r of items) {
    if (!r || typeof r !== 'object') continue;
    const kind = (r as any).kind;
    if (!(PIN_KINDS as readonly string[]).includes(kind)) continue;

    const id = typeof (r as any).id === 'string' && (r as any).id
      ? String((r as any).id).slice(0, 40) : blockId();
    if (seen.has(id)) continue;        // a duplicated id is a broken edge waiting to happen
    seen.add(id);

    const item: PinItem = {
      id,
      kind,
      x: clamp((r as any).x, 0, 100, 4),
      y: clamp((r as any).y, 0, 100, 4),
      w: clamp((r as any).w, 4, 100, 26),
      h: clamp((r as any).h, 4, 100, 18),
    };

    const refAttr = PIN_REF_ATTR[kind];
    if (refAttr) {
      const rid = (r as any)[refAttr];
      if (!isUuid(rid)) continue;      // a reference pin with no target is nothing
      (item as any)[refAttr] = rid;
    }
    if (typeof (r as any).text === 'string') item.text = (r as any).text.slice(0, 4000);

    if (kind === 'image') {
      const imgSrc = safeImageSrc((r as any).href);
      if (imgSrc) {
        if (imgSrc.startsWith('data:')) {
          // A board that would exceed the total budget keeps what fits.
          if (imageChars + imgSrc.length > MAX_BOARD_IMAGE_CHARS) continue;
          imageChars += imgSrc.length;
        }
        item.href = imgSrc;
      } else if (!item.text) continue; // nothing to show and nowhere to go
    } else if (kind === 'link' || kind === 'video') {
      const href = safeHref((r as any).href);
      if (!href && !item.text) continue;
      if (href) item.href = href;
    } else if (kind === 'file') {
      const name = typeof (r as any).fileName === 'string'
        ? (r as any).fileName.trim().slice(0, 200) : '';
      if (!name) continue;             // a file pin with no filename says nothing
      item.fileName = name;
      const ft = (r as any).fileType;
      if (typeof ft === 'string' && ft) item.fileType = ft.slice(0, 100);
      const fsz = (r as any).fileSize;
      if (typeof fsz === 'number' && Number.isFinite(fsz) && fsz >= 0) {
        item.fileSize = Math.round(fsz);
      }
      const href = safeHref((r as any).href);
      if (href) item.href = href;
    }

    const gid = (r as any).groupId;
    if (typeof gid === 'string' && groupIds.has(gid)) item.groupId = gid;

    const z = (r as any).z;
    if (typeof z === 'number' && Number.isFinite(z)) {
      item.z = Math.min(9999, Math.max(0, Math.round(z)));
    }

    const style = (r as any).style;
    if ((NOTE_STYLES as readonly string[]).includes(style)) item.style = style;
    const frame = (r as any).frame;
    if ((IMAGE_FRAMES as readonly string[]).includes(frame)) item.frame = frame;
    const caption = (r as any).caption;
    if (typeof caption === 'string' && caption.trim()) item.caption = caption.slice(0, 300);

    const accent = (r as any).accent;
    if (typeof accent === 'string' && /^[a-z]{3,12}$/.test(accent)) item.accent = accent;
    if (typeof (r as any).createdAt === 'string') item.createdAt = (r as any).createdAt.slice(0, 40);
    out.push(item);
  }

  /* An edge to a pin that is not here is not an edge. Dropping it is the only
   * option that leaves the board describing something true. */
  const live = new Set(out.map((i) => i.id));
  const connections: PinConnection[] = [];
  const pairs = new Set<string>();
  for (const c of (Array.isArray(src.connections) ? src.connections : [])) {
    if (!c || typeof c !== 'object') continue;
    const from = typeof c.from === 'string' ? c.from : '';
    const to = typeof c.to === 'string' ? c.to : '';
    if (!live.has(from) || !live.has(to) || from === to) continue;
    const key = from + '>' + to;
    if (pairs.has(key)) continue;
    pairs.add(key);
    const id = typeof c.id === 'string' && c.id ? String(c.id).slice(0, 40) : blockId();
    const label = typeof c.label === 'string' ? c.label.slice(0, 80).trim() : '';
    connections.push(label ? { id, from, to, label } : { id, from, to });
  }

  // A group nobody belongs to is not a group.
  const used = new Set(out.map((i) => i.groupId).filter(Boolean) as string[]);
  return {
    type: 'pinboard',
    items: out,
    groups: groups.filter((g) => used.has(g.id)),
    connections,
  };
}

/** A pinboard's searchable text: its own words, not its references' titles. */
export const pinboardToText = (p: Pinboard): string => [
  ...(p.items ?? []).map((i) => [i.text, i.caption, i.fileName].filter(Boolean).join(' ')),
  ...(p.groups ?? []).map((g) => g.title ?? ''),
  ...(p.connections ?? []).map((c) => c.label ?? ''),
].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

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
  attrs: { id: blockId() },
  content: text ? [{ type: 'text', text }] : [],
});

/* ── One door for every layout ─────────────────────────────────────────── */

/**
 * Validates a page body against the layout that will render it.
 *
 * One function rather than a branch at every call site: the layout decides
 * which grammar applies, and nothing outside this file should have to know that
 * a pinboard is shaped differently from a page of notes.
 */
export function validatePageContent(layout: string, raw: unknown): Doc | Pinboard {
  return layout === 'pinboard' ? validatePinboard(raw) : validateDoc(raw);
}

export const pageToText = (layout: string, content: any): string => (layout === 'pinboard'
  ? pinboardToText(content as Pinboard)
  : docToText(content as Doc));

/**
 * Every Life OS entity a page body points at.
 *
 * This is the bridge between what is written and what can be QUERIED. The page
 * stores its references inline, where the editor needs them; this pulls them
 * out so they can be mirrored into `item_links` and answer "what references
 * me?" without opening a single document.
 *
 * Both shapes are read — flowed reference blocks and pinned reference items —
 * because a Task dropped on a pinboard and a Task dropped on a notes page are
 * the same relationship and must be equally findable.
 */
export type PageRef = { type: string; id: string; blockId: string };

export function extractRefs(layout: string, content: any): PageRef[] {
  const out: PageRef[] = [];
  const seen = new Set<string>();
  const push = (type: string, id: unknown, block: string) => {
    if (!isUuid(id)) return;
    const key = `${type}:${id}`;
    if (seen.has(key)) return;          // one edge per target per page
    seen.add(key);
    out.push({ type, id, blockId: block });
  };

  if (layout === 'pinboard') {
    for (const item of (content?.items ?? []) as PinItem[]) {
      const attr = PIN_REF_ATTR[item.kind];
      if (attr) push(item.kind, (item as any)[attr], item.id);
    }
    return out;
  }

  const walk = (nodes: unknown[]) => {
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const node = n as any;
      if (REF_BLOCKS.has(node.type)) {
        const attr = REF_ID_ATTR[node.type]!;
        push(node.type.replace(/Ref$/, ''), node.attrs?.[attr], node.attrs?.id ?? '');
      } else if (Array.isArray(node.content)) walk(node.content);
    }
  };
  walk(content?.content ?? []);
  return out;
}

/**
 * The starter content a layout opens with.
 *
 * A blank page under a template that promises structure is a template that has
 * not been applied. These are the headings and prompts that make the layout
 * legible the moment it is created — and they are ordinary blocks, so the user
 * can delete every one of them.
 */
const heading = (text: string, region?: string): Block => ({
  type: 'heading',
  attrs: { id: blockId(), level: 2, ...(region ? { region } : {}) },
  content: [{ type: 'text', text }],
});
const para = (region?: string): Block => ({
  type: 'paragraph',
  attrs: { id: blockId(), ...(region ? { region } : {}) },
  content: [],
});
const check = (text = ''): Block => ({
  type: 'checkItem',
  attrs: { id: blockId(), checked: false },
  content: text ? [{ type: 'text', text }] : [],
});

/* ── Changing a page's layout ───────────────────────────────────────────
 *
 * Flowed layouts share the block grammar, so moving between them keeps every
 * block untouched and is not a conversion at all.
 *
 * Crossing to or from a pinboard IS one, and the honest answer is not to
 * refuse: a note becomes a paragraph, a link becomes a paragraph with a link
 * in it, and a pinned Task becomes a Task reference block — the same
 * relationship, drawn in a line instead of at a position. Nothing is dropped.
 *
 * What IS lost is the arrangement: where things sat on the board. That is real
 * and the caller is told so plainly, because it is the one thing the user
 * cannot get back by undoing.
 */
const PIN_TO_REF: Record<string, string> = {
  task: 'taskRef', project: 'projectRef', resource: 'resourceRef', page: 'pageRef',
};
const REF_TO_PIN: Record<string, string> = {
  taskRef: 'task', projectRef: 'project', resourceRef: 'resource', pageRef: 'page',
};

const textBlock = (text: string, href?: string): Block => ({
  type: 'paragraph',
  attrs: { id: blockId() },
  content: text
    ? [href ? { type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }
      : { type: 'text', text }]
    : [],
});

export type Conversion = { content: Doc | Pinboard; note: string | null };

export function convertContent(from: string, to: string, raw: unknown): Conversion {
  const wasBoard = from === 'pinboard';
  const willBoard = to === 'pinboard';
  if (wasBoard === willBoard) return { content: raw as Doc | Pinboard, note: null };

  if (wasBoard) {
    const items = ((raw as Pinboard)?.items ?? []);
    const content: Block[] = [];
    for (const item of items) {
      const refType = PIN_TO_REF[item.kind];
      if (refType) {
        const attr = REF_ID_ATTR[refType]!;
        const id = (item as any)[attr];
        if (isUuid(id)) { content.push({ type: refType, attrs: { id: blockId(), [attr]: id } }); }
        continue;
      }
      const text = (item.text ?? '').trim() || item.href || '';
      if (text) content.push(textBlock(text, item.href));
    }
    return {
      content: { type: 'doc', content },
      note: items.length
        ? `${items.length} pinned item${items.length === 1 ? '' : 's'} became lines on the page. Where they sat on the board is not kept.`
        : null,
    };
  }

  // Flowed → pinboard. Laid out in a simple grid; nothing overlaps, and the
  // user can arrange from there.
  const blocks = ((raw as Doc)?.content ?? []);
  const items: PinItem[] = [];
  let col = 0; let row = 0;
  const place = () => {
    const pos = { x: 4 + col * 32, y: 4 + row * 22, w: 28, h: 18 };
    col += 1; if (col > 2) { col = 0; row += 1; }
    return pos;
  };
  for (const b of blocks) {
    const pinKind = REF_TO_PIN[b.type];
    if (pinKind) {
      const attr = REF_ID_ATTR[b.type]!;
      const id = (b.attrs as any)?.[attr];
      if (isUuid(id)) items.push({ id: blockId(), kind: pinKind, ...place(), [attr]: id } as PinItem);
      continue;
    }
    const text = docToText({ type: 'doc', content: [b] }).trim();
    if (text) items.push({ id: blockId(), kind: 'text', ...place(), text });
  }
  return {
    content: { type: 'pinboard', items, groups: [], connections: [] },
    note: blocks.length
      ? `${items.length} block${items.length === 1 ? '' : 's'} became pins. Drag them where you want them.`
      : null,
  };
}

/**
 * The blocks a PURPOSE starts a page with.
 *
 * This is the whole of what a purpose does to content: it writes the headings
 * you were going to write anyway. It is not a structure and it is not
 * exclusive with a shape — a research page can be two columns, and its
 * headings land in the first column like any other block.
 *
 * They are ordinary blocks. Every one of them can be deleted.
 */
export function purposeStarter(purpose: string | null | undefined, region?: string): Block[] {
  const r = region;
  switch (purpose) {
    case 'checklist':
      return [check(), check(), check()];
    case 'ideas':
      return [heading('Ideas', r), para(r)];
    case 'research':
      return [heading('Question', r), para(r), heading('What I found', r), para(r),
        heading('Sources', r), para(r)];
    case 'learning':
      return [heading('What I am learning', r), para(r), heading('Key points', r), para(r),
        heading('Still unclear', r), para(r)];
    case 'meeting':
      return [heading('Who was there', r), para(r), heading('Decisions', r), para(r),
        heading('Actions', r), check(), check()];
    default:
      return [];
  }
}

/**
 * What a new page opens with: the SHAPE's skeleton, filled by the PURPOSE.
 *
 * A page with neither is empty, which is correct — a blank page that arrives
 * pre-filled is a page arguing with you.
 */
export function starterContent(layout: string, purpose?: string | null): Doc | Pinboard {
  if (layout === 'pinboard') return EMPTY_PINBOARD;

  const opening = purposeStarter(purpose);
  switch (layout) {
    case 'two_columns':
      return {
        type: 'doc',
        content: [...purposeStarter(purpose, 'a'), ...(opening.length ? [] : [para('a')]), para('b')],
      };
    case 'comparison':
      return {
        type: 'doc',
        content: [heading('Option A', 'a'), para('a'), heading('Option B', 'b'), para('b')],
      };
    case 'quad':
      return {
        type: 'doc',
        content: [...purposeStarter(purpose, 'a'), ...(opening.length ? [] : [para('a')]),
          para('b'), para('c'), para('d')],
      };
    default:
      return { type: 'doc', content: opening };
  }
}
