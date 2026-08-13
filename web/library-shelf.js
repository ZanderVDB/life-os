/**
 * The shelf — Library's spatial layer (Phase L3).
 *
 * ── The rule this file exists to enforce ─────────────────────────────────
 *
 *   A SHELF IS A SCROLLABLE COLLECTION. IT IS NOT A CAROUSEL.
 *
 * Every decision below follows from that. There is no auto-rotation, no loop,
 * no single centred item with the rest hidden, and no state in which the arrows
 * are the only way forward. The arrows are a courtesy for a mouse without a
 * horizontal wheel and for anyone who prefers a target to a gesture; the rail
 * is a plain `overflow-x` element, so scrolling it works before any of this
 * JavaScript has run and keeps working if it fails.
 *
 * ── RESTING → PULLED FORWARD → OPEN (L3.1) ——
 *
 * L3 gave prominence to whatever object happened to be nearest a read line as
 * the shelf scrolled. It was wrong, and the review said so: a shelf sitting
 * untouched had one book permanently raised, which reads as "this one is
 * chosen" when nothing had been chosen at all. Worse, the raise survived
 * coming back from a Book, so the Library never looked calm.
 *
 * A resting shelf now has NO raised object. Every state below is caused by the
 * user, and ends when their attention does:
 *
 *   RESTING     on the shelf. No object is elevated, ever, by itself.
 *   HOVER       a small lift — pointer only, never required for anything.
 *   FOCUS       a keyboard ring. Never confused with pulled-forward.
 *   PULLED      explicit: a click, Enter/Space, or a tap. ONE per page.
 *   OPENING     the handoff, on a node the next paint destroys.
 *   RETURNED    a soft glow for 320ms after coming back, then nothing.
 *
 * A pulled object is not a selection either — it is being looked at, not
 * chosen — but unlike prominence it is something somebody did on purpose, and
 * it can be undone: Escape, a click on empty shelf, scrolling away, or pulling
 * something else. The route still never changes because a shelf moved.
 */

import { lib } from './library-api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const TYPE_LABEL = {
  book: 'Book', document: 'Document', image: 'Image',
  video: 'Video', link: 'Link', file: 'File',
};

/** The six approved section accents. A book with no sections falls back. */
const ACCENTS = ['peach', 'sage', 'lavender', 'gold', 'blue', 'rose'];
const accentOf = (item) => (ACCENTS.includes(item.book?.accent) ? item.book.accent : 'peach');

/* ── Small honest formatters ─────────────────────────────────────────── */

export function fileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** `1:36`, or `1:15:17` when it runs to hours. Never `75:17`. */
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * "opened yesterday" / "edited 3 days ago".
 *
 * The VERB is part of the answer. `last_opened_at` is null for everything that
 * predates L3, and calling an edit time an opening would be the invented
 * behavioural data §12 forbids — so when the fallback is in use, the label says
 * so. See `openedAt` in library-api.js.
 */
export function recencyLabel(item) {
  const opened = item.lastOpenedAt ?? null;
  const iso = opened ?? item.updatedAt;
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const when = days <= 0 ? 'today'
    : days === 1 ? 'yesterday'
      : days < 7 ? `${days} days ago`
        : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${opened ? 'Opened' : 'Edited'} ${when}`;
}

/* ── The book object ─────────────────────────────────────────────────────
 *
 * A cover face in the approved 210:297 proportion with a spine standing to its
 * left, and — the L3.1 change — the pair OVERLAPS its neighbours, so the
 * shelf reads as a row of STORED books rather than a row of displayed ones. At
 * rest you see each spine and a strip of each cover, which is what a shelf
 * actually looks like. Pulling a book forward raises it above its neighbours
 * and the whole cover appears: nothing grows, nothing reflows, and the object
 * never leaves the shelf.
 *
 * Not drawn in 3D, and after L3.1 not rotated at all. Rotated glyphs are where
 * type stops being crisp, the review noticed it, and §21 is explicit that
 * crispness outranks novelty. Depth is carried by overlap, shadow, scale and
 * translation — all of which leave text on the pixel grid.
 *
 * `lib-foot` is the object's footer: the full title, the subtitle and a quiet
 * Open action, revealed together when the object is pulled forward. A second
 * click is never a mystery, and nothing is ever drawn over the cover (§8).
 */
/**
 * The object footer (L3.2 §8, option C).
 *
 * L3.1 put a bright purple pill over the cover. The review called it a debug
 * badge, and it was: a saturated UI chip floating on top of the artwork, in the
 * same corner region as the overflow menu, belonging to neither the object nor
 * the page.
 *
 * The title, the subtitle and the Open action now share one compact footer
 * BENEATH the object, at the object's own width. Nothing covers the cover, the
 * label is spatially attached to the thing it names, and the second activation
 * has an obvious target that is part of the object rather than pasted on it.
 *
 * Absolutely positioned, so revealing it can never shift the row.
 */
const objectFoot = (title, sub, action) => `<span class="lib-foot" aria-hidden="true">
    <span class="lib-foot-t">${esc(title)}</span>
    ${sub ? `<span class="lib-foot-s">${esc(sub)}</span>` : ''}
    <span class="lib-foot-a">${esc(action)}</span>
  </span>`;

/* ── The physical Book (L3.4 §9/§10) ─────────────────────────────────────
 *
 * A closed hardcover is a solid, and the shelf builds it as one: four faces in
 * one coordinate system, so when the Book turns, every face turns with it and
 * every decorative line turns with the face it is printed on.
 *
 *     back board   x = 0        spine        z = 0
 *     front cover  x = t        page block   z = −126
 *
 * The dimensions are REAL and they do not change. There is no width
 * interpolation and no scale anywhere in the turn — the only thing that
 * animates is a rotation about the spine's outer edge, and a compensating
 * `translateZ` that puts the cover back in the screen plane when it arrives.
 * That is what makes both terminal states device-pixel exact.
 */

/** A hash that avalanches, so two adjacent ids do not give adjacent results. */
function hash32(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Height: sixteen rungs, hand-weighted (170–215px).
 *
 * A table rather than arithmetic, because what is being controlled is a
 * distribution and a table is the version of it you can read and argue with.
 * Middle-weighted, so most Books are ordinary and about one in sixteen is tall
 * enough to notice; the order of the entries is itself irregular so no
 * arrangement of ids can walk it in steps.
 */
const HEIGHTS = [190, 200, 180, 195, 210, 185, 175, 200,
  190, 215, 185, 195, 170, 205, 190, 180];

/**
 * The Book's cloth (§5). Muted materials — never brand colours, never a
 * rainbow. Life OS purple stays the interface accent and is not in this list.
 */
export const MATERIALS = ['plum', 'navy', 'slate', 'moss', 'walnut', 'claret', 'graphite'];

/**
 * Thickness from content, with a small deterministic binding offset.
 *
 *     clamp(24, 24 + round(6 · pages^0.35) + bind(id), 52)
 *
 * The exponent matters more than it looks. A square root was tried first and it
 * produced a shelf of near-identical Books — measured across the full sample,
 * every spine landed between 25 and 30px — because real Books start at one or
 * two pages and √2 and √8 are only 3px apart. Most of a Library lives in the
 * first dozen pages, so that is where the curve has to do its work: 1 page is
 * 30px, 8 is 37, 100 is at the ceiling.
 *
 * `bind` is −2 … +2 so two Books of the same length are not pixel-identical
 * twins, which reads as a duplicated render. It is small enough that it can
 * never reorder two Books by apparent volume: thicker still means more inside.
 */
function thicknessOf(item) {
  const p = Math.max(0, Number(item.book?.pageCount ?? item.book?.pages ?? 0) || 0);
  const bind = (hash32(`bind:${item.id}`) % 5) - 2;
  const body = p > 0 ? Math.round(6 * (p ** 0.35)) : 0;
  return Math.min(52, Math.max(24, 24 + body + bind));
}

export function bookMetrics(item) {
  const h = hash32(item.id ?? item.title ?? '');
  return {
    height: HEIGHTS[h % HEIGHTS.length],
    thickness: thicknessOf(item),
    material: MATERIALS[hash32(`mat:${item.id ?? item.title ?? ''}`) % MATERIALS.length],
  };
}

/**
 * The four faces, plus the cover that lives on the front board.
 *
 * `lib-vol` is the box. Everything inside it is `aria-hidden` scenery except the
 * cover, which carries the real title — the object itself is the control and it
 * is never transformed, so its hit area is its own space on the shelf whatever
 * the Book is doing.
 */
function volumeHtml(title, sub, pre, author, spine) {
  return `<span class="lib-vol">
    <span class="lib-face lib-back" aria-hidden="true"></span>
    <span class="lib-face lib-edge" aria-hidden="true"><span class="lib-leaves"></span></span>
    <span class="lib-face lib-spine" aria-hidden="true">
      <span class="lib-spine-band"></span>
      <span class="lib-spine-t">${esc(spine)}</span>
      <span class="lib-spine-rule"></span>
      <span class="lib-spine-band"></span>
    </span>
    <span class="lib-face lib-board">
      <span class="lib-cover">
        <span class="lib-cover-mark" aria-hidden="true">Life OS</span>
        <span class="lib-cover-pre" aria-hidden="true">${esc(pre)}</span>
        <span class="lib-cover-title">${esc(title)}</span>
        ${sub ? `<span class="lib-cover-sub">${esc(sub)}</span>` : ''}
        <span class="lib-cover-rule" aria-hidden="true"></span>
        <span class="lib-cover-author">${esc(author)}</span>
      </span>
    </span>
  </span>`;
}

export function bookObjectHtml(item, index, total) {
  const b = item.book ?? {};
  const archived = !!item.archivedAt;
  const accent = accentOf(item);
  const year = new Date(item.createdAt).getFullYear();
  const m = bookMetrics(item);
  return `<article class="lib-obj lib-book${archived ? ' is-archived' : ''}"
    data-item="${esc(item.id)}" data-type="book" data-book="${esc(b.id ?? '')}"
    data-accent="${accent}" data-material="${m.material}"
    style="--bt:${m.thickness}px;--bh:${m.height}px"
    role="button" tabindex="-1" aria-expanded="false"
    aria-label="${esc(item.title)}${b.subtitle ? `. ${esc(b.subtitle)}` : ''}, Book${
  archived ? ', archived' : ''}"
    title="${esc(item.title)}">
    ${volumeHtml(item.title, b.subtitle, 'Notebook',
    `${b.authorLabel || 'Life OS'} · ${year}`, spineTitle(item.title))}
    ${archived ? '<span class="lib-obj-flag">Archived</span>' : ''}
    <button type="button" class="lib-obj-more" data-more="${esc(item.id)}"
      aria-label="Actions for ${esc(item.title)}" aria-haspopup="menu" tabindex="-1">
      <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true"
        ><circle cx="5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15" cy="10" r="1.4"/></svg>
    </button>
    ${objectFoot(item.title, b.subtitle, 'Open')}
  </article>`;
}

/**
 * The spine's title, shortened on purpose (§8).
 *
 * A spine is roughly 150px of vertical room at 10px type, which is about
 * twenty-two characters. Setting a thirty-character title in it produces
 * exactly what the review called poor: unreadably small text, or text clipped
 * mid-word with nothing to say it was clipped. Cutting at a word boundary and
 * marking it with an ellipsis is honest — and the full title is still on
 * the cover, in `title`, in the accessible name, and under the pulled book.
 */
export function spineTitle(title, max = 22) {
  const t = String(title ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.55 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * The Diary book (L3 §19/§30, treatment B — a personal ledge).
 *
 * It looks like a Book because it IS one to the person reading it, and it
 * behaves like nothing else on the shelf because it is not a Library item:
 * there is no `library_items` row behind it, no overflow menu, no archive, no
 * rename, and it never appears in Library search. It carries a visible system
 * mark so the difference is on screen and not only in the code.
 */
export function diaryObjectHtml() {
  /* Same Book, same turn, same open (§30). What makes it the Diary is the
   * lavender cloth, the word JOURNAL on the cover and the fact that it carries
   * no overflow menu — because there is nothing to rename or archive. The
   * distinction is material and behavioural, never a badge or a system button. */
  return `<article class="lib-obj lib-book lib-book-system" data-system="diary"
    data-accent="lavender" data-material="plum" style="--bt:38px;--bh:205px"
    role="button" tabindex="-1" aria-expanded="false"
    aria-label="My Diary, Life OS Journal, opens Diary" title="My Diary">
    ${volumeHtml('My Diary', null, 'Journal', 'Life OS Journal', 'My Diary')}
    ${objectFoot('My Diary', null, 'Open Diary')}
  </article>`;
}

/* ── The non-book objects (§10) ──────────────────────────────────────────
 *
 * Related, not identical. A Document is a folio, an Image is a frame, a Video
 * is a frame with a duration, a Link is a clipping, a File is a slab with its
 * type on it. They share the shelf, the ledge, the five states and the type
 * scale — which is what makes them one Library — and they do not share a
 * spine, because a spine on a JPEG is a lie about what the thing is.
 */

const TYPE_GLYPH = {
  document: '<path d="M5.5 3h6L15 6.5V17H5.5z"/><path d="M11.5 3v3.5H15M8 10h4M8 13h4"/>',
  image: '<rect x="3" y="4.5" width="14" height="11" rx="2"/><circle cx="7.5" cy="8.5" r="1.3"/><path d="m3.6 14 3.8-3.6 3 2.8 2.6-2.3 3.4 3.1"/>',
  video: '<rect x="3" y="5" width="10" height="10" rx="2"/><path d="m13 10 4-2.6v5.2z"/>',
  link: '<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1"/>',
  file: '<path d="M5.5 3h6L15 6.5V17H5.5z"/><path d="M11.5 3v3.5H15"/>',
};

const glyph = (type, size = 15) =>
  `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    >${TYPE_GLYPH[type] ?? TYPE_GLYPH.file}</svg>`;

/** A short extension-ish word for a File, from its MIME type. Never a guess. */
function fileKind(item) {
  const m = item.mimeType ?? '';
  if (!m) return 'File';
  if (m === 'application/pdf') return 'PDF';
  if (m === 'application/zip') return 'ZIP';
  if (m === 'application/json') return 'JSON';
  if (m.includes('spreadsheet') || m.includes('excel')) return 'Sheet';
  if (m.includes('wordprocessing') || m.includes('msword')) return 'Doc';
  if (m.startsWith('text/')) return 'Text';
  const sub = m.split('/')[1] ?? '';
  return sub ? sub.slice(0, 6).toUpperCase() : 'File';
}

/**
 * The picture inside an Image or Video object.
 *
 * The fallback is the DEFAULT, and a successful load replaces it — not the
 * other way round. An `<img>` that fails leaves a broken frame, an alt string
 * and a hole in the row; §28 requires that one dead external URL cannot break
 * the composition, so the frame always has a drawn floor underneath and the
 * image sits on top of it. `onerror` removes the image and the floor is simply
 * what remains.
 *
 * `loading="lazy"` and `decoding="async"` because a shelf of forty thumbnails
 * must not block the first paint (§28).
 */
function previewHtml(item) {
  const src = item.thumbnailKey || (item.type === 'image' ? item.sourceUrl : null);
  const ratio = item.metadata?.width && item.metadata?.height
    ? `${item.metadata.width} / ${item.metadata.height}` : '';
  return `<span class="lib-frame"${ratio ? ` style="--ratio:${esc(ratio)}"` : ''}>
    <span class="lib-frame-fallback" aria-hidden="true">${glyph(item.type, 22)}</span>
    ${src ? `<img class="lib-frame-img" src="${esc(src)}" alt="" loading="lazy"
      decoding="async" onerror="this.remove()">` : ''}
    ${item.type === 'video' && Number.isFinite(item.metadata?.durationSeconds)
    ? `<span class="lib-frame-badge">${esc(duration(item.metadata.durationSeconds))}</span>`
    : ''}
    ${item.type === 'video' ? `<span class="lib-frame-play" aria-hidden="true">
      <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor"><path d="m7 5 8 5-8 5z"/></svg>
    </span>` : ''}
  </span>`;
}

/** The one honest sub-line for each type. Never a made-up statistic. */
function subLine(item) {
  if (item.type === 'link') return domainOf(item.sourceUrl) || 'Link';
  if (item.type === 'file') return [fileKind(item), fileSize(item.sizeBytes)].filter(Boolean).join(' · ');
  if (item.type === 'video') {
    const d = Number.isFinite(item.metadata?.durationSeconds)
      ? duration(item.metadata.durationSeconds) : '';
    return d || fileSize(item.sizeBytes) || 'Video';
  }
  if (item.type === 'image') {
    const { width, height } = item.metadata ?? {};
    return width && height ? `${width} × ${height}` : (fileSize(item.sizeBytes) || 'Image');
  }
  return item.description ? '' : 'Document';
}

/* ── The three flat families (L3.4 §22/§28/§29) ──────────────────────────
 *
 * Chosen from the component lab, and each one is a different physical object
 * rather than the same rectangle in three tints:
 *
 *   DOCUMENT  a file folio, half open — sheets standing behind a lid that
 *             carries the title. The sheets are what make it a folio and not a
 *             card, and they are why it does not need a Book's spine.
 *   LINK      a clipping card, source mark at the left, domain beneath.
 *   FILE      a jacket with a clipped lower corner, kind and size.
 *
 * None of them rotates. A folder does not turn round: they come forward.
 */
function resourceFace(item) {
  if (item.type === 'document') {
    return `<span class="lib-folio" aria-hidden="true">
      <span class="lib-folio-sheet"></span>
      <span class="lib-folio-sheet lib-folio-sheet2"></span>
      <span class="lib-folio-lid">
        <span class="lib-res-kind">Document</span>
        <span class="lib-res-name">${esc(item.title)}</span>
        ${item.description ? `<span class="lib-res-excerpt">${esc(item.description)}</span>` : ''}
      </span>
    </span>`;
  }
  if (item.type === 'link') {
    const host = domainOf(item.sourceUrl);
    return `<span class="lib-clip" aria-hidden="true">
      <span class="lib-clip-mark">${esc((host || 'L').replace(/^www\./, '').slice(0, 1).toUpperCase())}</span>
      <span class="lib-clip-body">
        <span class="lib-res-name">${esc(item.title)}</span>
        <span class="lib-res-domain">${esc(host || 'Link')}</span>
      </span>
    </span>`;
  }
  return `<span class="lib-jacket" aria-hidden="true">
    <span class="lib-jacket-body">
      <span class="lib-res-kind">${esc(fileKind(item))}</span>
      <span class="lib-res-name">${esc(item.title)}</span>
      <span class="lib-res-domain">${esc(fileSize(item.sizeBytes) || 'File')}</span>
    </span>
    <span class="lib-jacket-corner"></span>
  </span>`;
}

export function resourceObjectHtml(item, index, total) {
  const archived = !!item.archivedAt;
  const visual = item.type === 'image' || item.type === 'video';
  const sub = subLine(item);
  return `<article class="lib-obj lib-res lib-res-${esc(item.type)}${
    archived ? ' is-archived' : ''}"
    data-item="${esc(item.id)}" data-type="${esc(item.type)}" role="button" tabindex="-1"
    aria-expanded="false"
    aria-label="${esc(item.title)}, ${TYPE_LABEL[item.type] ?? 'item'}, ${
  index + 1} of ${total}${archived ? ', archived' : ''}"
    title="${esc(item.title)}">
    ${visual ? previewHtml(item) : resourceFace(item)}
    ${archived ? '<span class="lib-obj-flag">Archived</span>' : ''}
    ${visual ? `<span class="lib-cap" aria-hidden="true">
      <span class="lib-cap-t">${esc(item.title)}</span>
      ${sub ? `<span class="lib-cap-m">${esc(sub)}</span>` : ''}
    </span>` : ''}
    <button type="button" class="lib-obj-more" data-more="${esc(item.id)}"
      aria-label="Actions for ${esc(item.title)}" aria-haspopup="menu" tabindex="-1">
      <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true"
        ><circle cx="5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15" cy="10" r="1.4"/></svg>
    </button>
    ${visual
    /* §26 — no heavy footer bar under a picture. The content dominates and the
     * caption is plain text; only the action needs revealing. */
    ? `<span class="lib-foot is-quiet" aria-hidden="true"><span class="lib-foot-a">Open</span></span>`
    : objectFoot(item.title, sub, item.type === 'link' ? 'Open link' : 'Open')}
  </article>`;
}

export const objectHtml = (item, i, n) =>
  (item.type === 'book' && item.book ? bookObjectHtml(item, i, n) : resourceObjectHtml(item, i, n));

/* ── A shelf ─────────────────────────────────────────────────────────── */

/**
 * One labelled, scrollable shelf.
 *
 * `role="group"` with a label rather than a landmark: a Library with six
 * landmarks is a Library whose landmark list is useless. The rail itself is a
 * plain list — items are buttons, so "open" is the obvious action and nothing
 * has to explain itself.
 *
 * The arrows are marked `data-shelf-step`, sit AFTER the rail in the DOM, and
 * are `tabindex="-1"` when the shelf does not overflow. A control that cannot
 * do anything should not be a tab stop, and one that is only decorative should
 * not be reachable at all.
 */
export function shelfHtml({ id, title, items, extraLead = '', note = '', kind = 'book' }) {
  const n = items.length + (extraLead ? 1 : 0);
  const hid = `lib-sh-${id}`;
  /* ADAPTIVE DENSITY (§23/§24). Two or three books must read as two or three
   * separate objects, with a gap between them; a dozen should read as a shelf,
   * with the books touching. One overlap formula for both sizes is what made
   * two Books look like a deck of cards. Four is the threshold because three
   * objects still read individually at any spacing, and four is where a row
   * starts wanting rhythm. */
  const dense = n >= 4;
  return `<section class="lib-shelf lib-shelf-${esc(kind)}" data-shelf="${esc(id)}"
    role="group" aria-labelledby="${hid}">
    <div class="lib-shelf-head">
      <h2 class="lib-shelf-h" id="${hid}">${esc(title)}</h2>
      ${items.length ? `<span class="lib-shelf-n">${items.length}</span>` : ''}
      ${note ? `<span class="lib-shelf-note">${esc(note)}</span>` : ''}
      <div class="lib-shelf-nav" aria-hidden="true">
        <button type="button" class="lib-step" data-shelf-step="-1" tabindex="-1"
          aria-label="Scroll ${esc(title)} left"><svg viewBox="0 0 20 20" width="15" height="15"
          fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"
          stroke-linejoin="round"><path d="m12 4-6 6 6 6"/></svg></button>
        <button type="button" class="lib-step" data-shelf-step="1" tabindex="-1"
          aria-label="Scroll ${esc(title)} right"><svg viewBox="0 0 20 20" width="15" height="15"
          fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"
          stroke-linejoin="round"><path d="m8 4 6 6-6 6"/></svg></button>
      </div>
    </div>
    <div class="lib-rail${dense ? ' is-dense' : ''}" data-rail="${esc(id)}">
      <ul class="lib-row" role="list">
        ${extraLead ? `<li class="lib-slot">${extraLead}</li>` : ''}
        ${items.map((it, i) => `<li class="lib-slot">${objectHtml(it, i, n)}</li>`).join('')}
      </ul>
    </div>
  </section>`;
}

/* ── Rail behaviour ─────────────────────────────────────────────────────
 *
 * Everything below is an ENHANCEMENT of an element that already scrolls.
 */

/** How far one arrow press or one arrow key moves: roughly one object. */
function stepSize(rail) {
  const first = rail.querySelector('.lib-slot');
  if (!first) return Math.round(rail.clientWidth * 0.8);
  const gap = parseFloat(getComputedStyle(rail.querySelector('.lib-row')).columnGap) || 0;
  return Math.round(first.getBoundingClientRect().width + gap);
}

/**
 * THE SHELF CURSOR — a keyboard position, and nothing visual.
 *
 * L3 had one function doing two jobs: deciding which object looked raised AND
 * deciding which object was the shelf's tab stop. Tying them together is what
 * produced the defect the review found — scrolling moved the tab stop, so it
 * also raised a book, so a shelf nobody had touched had one book standing out.
 *
 * They are separate now. The cursor is where Tab lands and where the arrow keys
 * start from. It has NO appearance of its own: an object at the cursor looks
 * exactly like every other resting object until it is focused or pulled.
 */
function setCursor(rail, index, { focus = false } = {}) {
  const objs = [...rail.querySelectorAll('.lib-obj')];
  if (!objs.length) return;
  const at = Math.max(0, Math.min(index, objs.length - 1));
  rail.dataset.cursor = String(at);
  /* One tab stop per shelf. Forty books must not be forty tab stops. */
  objs.forEach((o, i) => { o.tabIndex = i === at ? 0 : -1; });
  if (focus) objs[at].focus({ preventScroll: true });
}

/* —— Pulled forward (L3.1 §6/§7) ——
 *
 * ONE object across the whole page, not one per shelf. Two books half-out of
 * two different shelves is a page that has lost track of what you were doing,
 * and the rule "clicking another Book returns the previous one" is much easier
 * to trust when there is only ever one thing to return.
 *
 * Held as a module-level node reference rather than in `lib`, deliberately: it
 * is presentation, it must not survive a route change, and it dies with the DOM
 * it points at. Nothing about it is ever written to the hash.
 */
let pulled = null;

/**
 * The commit (§12/§13).
 *
 * The turn is 3D; the arrived state is not. Once the Book has come round, the
 * box transform is dropped, the three depth faces stop being painted, and the
 * front cover becomes an ordinary untransformed element — so the title is set
 * on the pixel grid rather than on a rotated plane, which is the difference
 * between a crisp cover and a soft one.
 *
 * The handoff is seamless because the animation ends where the flat state
 * begins: a compensating `translateZ(-t)` puts the cover back in the screen
 * plane at −90°, so its projected width there is exactly its layout width. No
 * pop, no scale, no width interpolation.
 *
 * `transitionend` is the optimisation and the timer is the guarantee. A
 * throttled or interrupted transition must not be able to strand a Book
 * half-turned, and a browser that never fires the event must still arrive.
 */
let commitTimer = 0;
function commitFront(obj) {
  if (!obj?.isConnected || !obj.classList.contains('is-pulled')) return;
  obj.classList.add('is-front');
}
function scheduleCommit(obj) {
  clearTimeout(commitTimer);
  const vol = obj.querySelector('.lib-vol');
  if (prefersReduced()) { commitFront(obj); return; }
  const done = (e) => {
    if (e.target !== vol || e.propertyName !== 'transform') return;
    vol.removeEventListener('transitionend', done);
    commitFront(obj);
  };
  vol?.addEventListener('transitionend', done);
  commitTimer = setTimeout(() => { vol?.removeEventListener('transitionend', done); commitFront(obj); }, 380);
}

/** Only the immediate neighbours move (§14). The rest of the shelf holds still. */
function setNeighbours(obj, on) {
  const slot = obj?.closest('.lib-slot');
  if (!slot) return;
  slot.previousElementSibling?.classList.toggle('is-nudge-l', on);
  slot.nextElementSibling?.classList.toggle('is-nudge-r', on);
}

/** Puts the pulled object back on the shelf. Safe to call at any time. */
export function clearPulled({ restoreFocus = false } = {}) {
  if (!pulled) return;
  const obj = pulled;
  pulled = null;
  clearTimeout(commitTimer);
  setNeighbours(obj, false);
  obj.classList.remove('is-pulled', 'is-front');
  obj.setAttribute('aria-expanded', 'false');
  if (restoreFocus && obj.isConnected) obj.focus({ preventScroll: true });
}

export const pulledObject = () => (pulled?.isConnected ? pulled : null);

/**
 * Pulls one object forward, returning any other one first.
 *
 * `aria-expanded` is how a screen reader learns that the first activation did
 * something other than nothing — and the Open control inside the pulled state
 * is what it does next, so a second activation is never an unexplained ritual
 * (§27).
 */
export function pullForward(obj) {
  if (!obj || obj === pulled) return;
  clearPulled();
  pulled = obj;
  obj.classList.add('is-pulled');
  obj.setAttribute('aria-expanded', 'true');
  setNeighbours(obj, true);
  if (obj.classList.contains('lib-book')) scheduleCommit(obj);
  const rail = obj.closest('.lib-rail');
  if (rail) {
    const at = [...rail.querySelectorAll('.lib-obj')].indexOf(obj);
    if (at > -1) setCursor(rail, at);
    /* Where the shelf was WHEN THIS WAS PULLED. Recorded here rather than
     * tracked by the scroll handler, because the handler only learns about
     * positions it was told about: `restoreShelfScroll` moves a rail by
     * assignment, and a synthetic move fires no event, so an anchor maintained
     * from scroll events is stale exactly when the shelf has been moved for
     * you. Reading it at the moment of pulling cannot be stale. */
    /* The reveal is INSTANT here, and the anchor is read after it.
     *
     * Pulling an object near the shelf edge scrolls it into view, and that
     * scroll can exceed the clear threshold — so a smooth reveal trips the
     * "you have browsed away" rule mid-flight and cancels the pull that caused
     * it. Measured: the last book on the Books shelf pulled and cleared itself
     * in the same gesture.
     *
     * Anchoring to the scroll's TARGET does not fix it, because during a smooth
     * scroll the current position is far from the target by design. Making this
     * one reveal instant makes the position exact the moment it is read, and
     * removes timing from the question entirely. Arrow-key browsing keeps its
     * smooth scroll, where the travel is the point. */
    revealAt(rail, [...rail.querySelectorAll('.lib-slot')]
      .findIndex((sl) => sl.contains(obj)), { instant: true });
    rail.dataset.pullAt = String(rail.scrollLeft);
  }
}

/** Brings an object fully into view without yanking the whole page. */
function revealAt(rail, index, { instant = false } = {}) {
  const slots = [...rail.querySelectorAll('.lib-slot')];
  const slot = slots[index];
  if (!slot) return 0;
  const box = rail.getBoundingClientRect();
  const r = slot.getBoundingClientRect();
  const pad = 24;
  let delta = 0;
  if (r.left < box.left + pad) delta = r.left - box.left - pad;
  else if (r.right > box.right - pad) delta = r.right - box.right + pad;
  if (delta) {
    rail.scrollBy({ left: delta, behavior: instant ? 'auto' : scrollBehavior() });
  }
  return delta;
}

const prefersReduced = () =>
  typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const scrollBehavior = () => (prefersReduced() ? 'auto' : 'smooth');

/**
 * Wheel translation, and the two guards that keep it from becoming a trap.
 *
 * L3 §21 asks for a mouse wheel over a shelf to browse the shelf, and §21 also
 * forbids trapping ordinary vertical page scroll. Both are satisfiable, but
 * only with the release rules — without them this is precisely the pattern that
 * makes a page impossible to scroll past.
 *
 *   1. RELEASE AT THE ENDS. When the rail cannot consume more movement in the
 *      direction asked for, the event is not cancelled and the page scrolls.
 *      This is what stops a shelf from swallowing a page.
 *
 *   2. LATCH OUT DURING A FLICK. Once the page has started scrolling past a
 *      shelf, that shelf refuses to capture again until the wheel has been
 *      still for 220ms. Without this, a fast scroll down the page is caught by
 *      each shelf in turn and the page appears stuck.
 *
 * Horizontal intent is never touched: a trackpad sending `deltaX` is already
 * doing the right thing and the browser handles it natively.
 */
const LATCH_MS = 220;

/**
 * How far the shelf may move before a pulled object goes back (§22).
 *
 * 48px is about a third of a book. Below that it is the small drift of a
 * trackpad settling and returning the object would feel twitchy; above it the
 * user is browsing somewhere else, and a book held out over a shelf that has
 * moved on is an object in the wrong place.
 */
const PULL_SCROLL_CLEAR = 48;

/**
 * How far a pointer may travel and still count as a tap (§26).
 *
 * Separates a swipe from a tap on touch, where the two start identically. 10px
 * is the usual platform slop; anything more and the gesture was browsing, so
 * nothing opens and nothing pulls forward.
 */
const TAP_SLOP = 10;
function wireWheel(rail) {
  let latchedOut = false;
  let idle = 0;
  rail.addEventListener('wheel', (e) => {
    clearTimeout(idle);
    idle = setTimeout(() => { latchedOut = false; }, LATCH_MS);

    if (e.ctrlKey) return;                                  // browser zoom
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;    // already horizontal
    if (latchedOut) return;

    const max = rail.scrollWidth - rail.clientWidth;
    if (max <= 1) return;                                   // nothing to scroll
    const dir = Math.sign(e.deltaY);
    const atEnd = dir > 0 ? rail.scrollLeft >= max - 1 : rail.scrollLeft <= 1;
    if (atEnd) { latchedOut = true; return; }               // rule 1 → page scrolls

    e.preventDefault();
    /* `deltaMode` 1 is lines and 2 is pages; a raw number from either is
     * meaningless as pixels. Normalised so a mouse and a trackpad move the
     * shelf by comparable amounts. */
    const unit = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? rail.clientWidth : 1;
    rail.scrollLeft += e.deltaY * unit;
  }, { passive: false });
}

/**
 * Wires one rail. Returns nothing — everything it does is on the element.
 *
 * `onOpen(itemId | {system})` is called for a click or Enter/Space on an
 * object. The shelf does not decide what opening means.
 */
export function wireRail(rail, { onOpen, onMenu, onScrollChange } = {}) {
  const objs = () => [...rail.querySelectorAll('.lib-obj')];

  setCursor(rail, Number(rail.dataset.cursor ?? 0));

  /* Scrolling changes NOTHING about how anything looks (L3.1 §3). It records
   * the position, keeps the arrows honest, and — past a threshold — returns a
   * pulled object to the shelf, because an object held forward while the shelf
   * slides underneath it is an object in the wrong place (§22). */
  rail.addEventListener('scroll', () => {
    if (rail.dataset.rail) lib.shelfScroll[rail.dataset.rail] = rail.scrollLeft;
    if (pulled && rail.contains(pulled)) {
      const from = Number(rail.dataset.pullAt ?? rail.scrollLeft);
      if (Math.abs(rail.scrollLeft - from) > PULL_SCROLL_CLEAR) clearPulled();
    }
    onScrollChange?.(rail);
    syncSteps(rail);
  }, { passive: true });

  wireWheel(rail);

  rail.addEventListener('pointerenter', () => syncSteps(rail));

  /* A tap that was really a swipe must not open anything. Tracked on the rail
   * rather than per object, because the finger that started on a book very
   * often ends up somewhere else entirely. */
  let downAt = null;
  rail.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY, left: rail.scrollLeft };
  }, { passive: true });

  rail.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { e.stopPropagation(); onMenu?.(more, more.dataset.more); return; }

    const obj = e.target.closest('.lib-obj');
    if (!obj) { clearPulled(); return; }   // empty shelf space returns it

    if (downAt) {
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      const scrolled = Math.abs(rail.scrollLeft - downAt.left);
      downAt = null;
      /* A drag is browsing, not choosing. Either the pointer travelled or the
       * shelf did; either one means this was a swipe. */
      if (moved > TAP_SLOP || scrolled > TAP_SLOP) return;
    }

    /* Two stages. The first is "let me look at this", the second is "open it",
     * and the second is also reachable from the labelled Open control — which
     * is the route a phone and a screen reader actually take. */
    if (obj === pulled || e.target.closest('.lib-foot-a')) onOpen?.(obj);
    else pullForward(obj);
  });

  rail.addEventListener('keydown', (e) => {
    const obj = e.target.closest('.lib-obj');
    if (!obj) return;
    const all = objs();
    const at = all.indexOf(obj);
    const go = (next) => {
      e.preventDefault();
      /* Moving along the shelf returns whatever was held forward. Browsing past
       * a pulled book while it stays out is the keyboard version of the scroll
       * problem in §22. */
      clearPulled();
      setCursor(rail, next, { focus: true });
      revealAt(rail, next);
    };
    if (e.key === 'ArrowRight') return go(Math.min(at + 1, all.length - 1));
    if (e.key === 'ArrowLeft') return go(Math.max(at - 1, 0));
    if (e.key === 'Home') return go(0);
    if (e.key === 'End') return go(all.length - 1);
    if (e.key === 'Escape' && pulled) { e.preventDefault(); clearPulled({ restoreFocus: true }); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      // Same two stages as the pointer, so the models cannot drift apart.
      if (obj === pulled) onOpen?.(obj);
      else pullForward(obj);
    }
  });

  /* Focus moves the CURSOR, never the appearance. Tabbing onto an object shows
   * a focus ring and nothing else — pulling forward stays something you ask
   * for. */
  rail.addEventListener('focusin', (e) => {
    const obj = e.target.closest('.lib-obj');
    if (!obj) return;
    const at = objs().indexOf(obj);
    if (at > -1) { setCursor(rail, at); revealAt(rail, at); }
  });

  rail.parentElement?.querySelectorAll('[data-shelf-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      rail.scrollBy({ left: stepSize(rail) * Number(btn.dataset.shelfStep),
        behavior: scrollBehavior() });
    });
  });

  syncSteps(rail);
}

/**
 * Shows the arrows only when they can do something.
 *
 * A shelf that fits has no use for them, and an arrow at the end of a shelf
 * that does nothing when pressed is the small dishonesty §35 of the earlier
 * phase set out to remove. `aria-hidden` on the group and `tabindex="-1"` on
 * the buttons keep them out of the keyboard path entirely — arrows are the
 * secondary route, and the keyboard already has a better one.
 */
export function syncSteps(rail) {
  const max = rail.scrollWidth - rail.clientWidth;
  /* `is-full` means "this shelf overflows". The stylesheet centres a row that
   * does NOT, so one to three objects sit in the middle of the shelf rather
   * than hugging the far left (§26) — and the rule is inert the moment there is
   * anything to scroll. */
  rail.classList.toggle('is-full', max > 1);
  const nav = rail.parentElement?.querySelector('.lib-shelf-nav');
  if (!nav) return;
  nav.classList.toggle('is-live', max > 1);
  const [prev, next] = nav.querySelectorAll('[data-shelf-step]');
  if (prev) prev.disabled = rail.scrollLeft <= 1;
  if (next) next.disabled = rail.scrollLeft >= max - 1;
}

/**
 * Snapshots where every shelf is, right now (§16/§18).
 *
 * Called at the moment of LEAVING rather than trusted to the scroll handler.
 * The handler also records as you go, but a position remembered only by having
 * observed every scroll event is a position that is wrong whenever an event was
 * missed — and it is genuinely missed when the page is not rendering, which is
 * exactly when a Book is taking over the screen. Reading the DOM at the moment
 * it matters cannot miss anything.
 */
export function captureShelfScroll(root = document) {
  root.querySelectorAll('.lib-rail[data-rail]').forEach((rail) => {
    lib.shelfScroll[rail.dataset.rail] = rail.scrollLeft;
  });
}

/**
 * Puts every shelf back where it was (§16/§18).
 *
 * Assignment, not `scrollTo({behavior:'smooth'})`: this runs while the Library
 * is being painted after a Book closes, and a smooth scroll from 0 to where you
 * were is an animation of the thing you were trying not to notice.
 */
export function restoreShelfScroll(root = document) {
  root.querySelectorAll('.lib-rail[data-rail]').forEach((rail) => {
    const at = lib.shelfScroll[rail.dataset.rail];
    if (at) rail.scrollLeft = at;
    /* The cursor goes back to the start of the shelf, not to whatever is under
     * the scroll position. It is a keyboard position with no appearance, so
     * there is nothing to see either way — and deriving it from scroll is what
     * used to leave a raised book on a shelf nobody had touched. */
    setCursor(rail, 0);
    syncSteps(rail);
  });
}

/**
 * Re-identifies the object you came back from, briefly (§23).
 *
 * L3 drew this as a 2px accent ring for 1400ms, and the review was right about
 * it: an accent ring is what FOCUS looks like, so returning from a Book left
 * something that read as "this is selected" sitting on the shelf, for long
 * enough to look permanent. Two different meanings, one appearance.
 *
 * It is now a soft glow, in the object's own accent rather than the app accent,
 * for 320ms — inside the 200—400ms §4 allows. It cannot be mistaken for
 * focus because it is not an outline, and it cannot be mistaken for a selection
 * because it is gone before you could act on it.
 *
 * The object is already in its final position; this only draws attention to it.
 * A missed timer would leave a glowing book, which is visible, harmless, and
 * cleared by the next repaint.
 */
export function markReturn(root = document, itemId, shelfId = null) {
  if (!itemId) return;
  const sel = `.lib-obj[data-item="${CSS.escape(itemId)}"]`;
  /* The same Book can be on two shelves at once — its own, and Recently
   * opened. Coming back has to land on the one you LEFT from, or the shelf
   * lights up in a place you were not, which is worse than not lighting up at
   * all. The shelf id is recorded on the way out for exactly this. */
  const obj = (shelfId && root.querySelector(`[data-rail="${CSS.escape(shelfId)}"] ${sel}`))
    || root.querySelector(sel);
  if (!obj) return;
  const rail = obj.closest('.lib-rail');
  if (rail) {
    /* Bring it into view and put the keyboard cursor on it, so Tab lands where
     * you were — but do NOT pull it forward. Coming back from a Book should
     * leave the Library at rest (§23). */
    const at = [...rail.querySelectorAll('.lib-obj')].indexOf(obj);
    setCursor(rail, at);
    revealAt(rail, at);
  }
  if (prefersReduced()) return;         // §25: no spatial emphasis when reduced
  obj.classList.add('is-returned');
  setTimeout(() => obj.classList.remove('is-returned'), RETURN_GLOW_MS);
}

/** 320ms, inside the 200—400ms band §4 allows. */
const RETURN_GLOW_MS = 320;

export { esc, accentOf, setCursor, stepSize };
