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
 * ── What "prominent" means, and what it does not ─────────────────────────
 *
 * L3 §23 asks for five distinct states, and they are five distinct mechanisms
 * here rather than five shades of one:
 *
 *   default     resting
 *   hover       surface lifts — pointer only, never required for anything
 *   focus       an accent outline, from :focus-visible
 *   prominent   the item the shelf is CURRENTLY ABOUT: raised, cover fuller
 *   open        the one being handed over to the Book view
 *
 * Prominence is not selection. Nothing is chosen by scrolling past it, nothing
 * is committed, and the route never changes because a shelf moved — see §33.
 * It is the shelf saying "this is the one under your attention", which is what
 * makes surrounding items feel like they are beside something rather than
 * merely next to each other.
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
 * A cover face in the approved 210:297 proportion, plus a spine standing to
 * its left. Not a photograph of a book: a flat cover and a narrow gradient
 * strip, which reads as an object on a shelf at a glance and costs one element
 * each. The spine is `aria-hidden` — its title is the cover's title, and a
 * screen reader should hear a book once.
 *
 * Deliberately NOT drawn in 3D. Twelve `preserve-3d` subtrees with rotated text
 * is a lot of compositing for a shelf that has to stay smooth while it scrolls,
 * and rotated glyphs are exactly where type stops being crisp. The one item
 * that rotates is the prominent one — see `.is-prominent` in the stylesheet —
 * so at most one 3D layer exists per shelf at any moment.
 */
export function bookObjectHtml(item, index, total) {
  const b = item.book ?? {};
  const archived = !!item.archivedAt;
  const accent = accentOf(item);
  const year = new Date(item.createdAt).getFullYear();
  return `<article class="lib-obj lib-book${archived ? ' is-archived' : ''}"
    data-item="${esc(item.id)}" data-type="book" data-book="${esc(b.id ?? '')}"
    data-accent="${accent}" role="button" tabindex="-1"
    aria-label="${esc(item.title)}${b.subtitle ? `. ${esc(b.subtitle)}` : ''}, Book, ${
  index + 1} of ${total}${archived ? ', archived' : ''}"
    title="${esc(item.title)}">
    <span class="lib-spine" aria-hidden="true">
      <span class="lib-spine-t">${esc(item.title)}</span>
    </span>
    <span class="lib-cover">
      <span class="lib-cover-mark" aria-hidden="true">Life OS</span>
      <span class="lib-cover-pre" aria-hidden="true">Notebook</span>
      <span class="lib-cover-title">${esc(item.title)}</span>
      ${b.subtitle ? `<span class="lib-cover-sub">${esc(b.subtitle)}</span>` : ''}
      <span class="lib-cover-rule" aria-hidden="true"></span>
      <span class="lib-cover-author">${esc(b.authorLabel || 'Life OS')} · ${year}</span>
    </span>
    ${archived ? '<span class="lib-obj-flag">Archived</span>' : ''}
    <button type="button" class="lib-obj-more" data-more="${esc(item.id)}"
      aria-label="Actions for ${esc(item.title)}" aria-haspopup="menu" tabindex="-1">
      <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true"
        ><circle cx="5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15" cy="10" r="1.4"/></svg>
    </button>
  </article>`;
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
  return `<article class="lib-obj lib-book lib-book-system" data-system="diary"
    data-accent="lavender" role="button" tabindex="-1"
    aria-label="My Diary, opens Diary" title="My Diary">
    <span class="lib-spine" aria-hidden="true"><span class="lib-spine-t">My Diary</span></span>
    <span class="lib-cover">
      <span class="lib-cover-mark" aria-hidden="true">Life OS</span>
      <span class="lib-cover-pre" aria-hidden="true">Journal</span>
      <span class="lib-cover-title">My Diary</span>
      <span class="lib-cover-rule" aria-hidden="true"></span>
      <span class="lib-cover-author">Every day</span>
    </span>
    <span class="lib-obj-sys" aria-hidden="true" title="Part of Life OS">
      <svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor"
        stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
        ><path d="M10 3.2 12 8h4.8l-3.9 3 1.5 4.8L10 13l-4.4 2.8L7.1 11 3.2 8H8z"/></svg>
    </span>
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

export function resourceObjectHtml(item, index, total) {
  const archived = !!item.archivedAt;
  const visual = item.type === 'image' || item.type === 'video';
  const sub = subLine(item);
  return `<article class="lib-obj lib-res lib-res-${esc(item.type)}${
    archived ? ' is-archived' : ''}"
    data-item="${esc(item.id)}" data-type="${esc(item.type)}" role="button" tabindex="-1"
    aria-label="${esc(item.title)}, ${TYPE_LABEL[item.type] ?? 'item'}, ${
  index + 1} of ${total}${archived ? ', archived' : ''}"
    title="${esc(item.title)}">
    ${visual ? previewHtml(item) : `<span class="lib-res-face" aria-hidden="true">
      <span class="lib-res-glyph">${glyph(item.type, 18)}</span>
      ${item.type === 'document' && item.description
    ? `<span class="lib-res-excerpt">${esc(item.description)}</span>` : ''}
      ${item.type === 'file' ? `<span class="lib-res-kind">${esc(fileKind(item))}</span>` : ''}
      ${item.type === 'link' ? `<span class="lib-res-domain">${esc(domainOf(item.sourceUrl))}</span>` : ''}
    </span>`}
    <span class="lib-res-body">
      <span class="lib-res-title">${esc(item.title)}</span>
      ${sub ? `<span class="lib-res-sub">${esc(sub)}</span>` : ''}
    </span>
    ${archived ? '<span class="lib-obj-flag">Archived</span>' : ''}
    <button type="button" class="lib-obj-more" data-more="${esc(item.id)}"
      aria-label="Actions for ${esc(item.title)}" aria-haspopup="menu" tabindex="-1">
      <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true"
        ><circle cx="5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15" cy="10" r="1.4"/></svg>
    </button>
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
    <div class="lib-rail" data-rail="${esc(id)}">
      <ul class="lib-row" role="list">
        ${extraLead ? `<li class="lib-slot">${extraLead}</li>` : ''}
        ${items.map((it, i) => `<li class="lib-slot">${objectHtml(it, i, n)}</li>`).join('')}
      </ul>
    </div>
    <p class="lib-shelf-cap" aria-hidden="true"></p>
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
 * Which object the shelf is currently ABOUT.
 *
 * The one whose centre is nearest a READ LINE — and the read line travels with
 * the scroll rather than sitting still.
 *
 * A fixed line does not work, and it fails at exactly the moment that matters
 * most. Put it a third of the way in and, on a shelf sitting at rest, the
 * SECOND book is nearest it: the first book is 185px away and the second is
 * 26px away, so a shelf you have not touched is about the book you did not
 * land on — and because you cannot scroll left of zero, the first book can
 * never become prominent at all. Measured on the Books shelf: index 1 at
 * scrollLeft 0. The same thing happens mirrored at the far end.
 *
 * So the line runs from the left edge to the right edge as the shelf runs from
 * its start to its end. At rest it is over the first object, at the end it is
 * over the last, and in between it is wherever you have got to — which is both
 * correct at the extremes and a truer description of where somebody is looking.
 */
function nearestIndex(rail) {
  const slots = [...rail.querySelectorAll('.lib-slot')];
  if (!slots.length) return -1;
  const box = rail.getBoundingClientRect();
  const max = rail.scrollWidth - rail.clientWidth;
  const progress = max > 1 ? Math.min(1, Math.max(0, rail.scrollLeft / max)) : 0;
  const inset = Math.min(box.width * 0.18, 90);
  const line = box.left + inset + progress * (box.width - inset * 2);
  let best = 0; let bestD = Infinity;
  slots.forEach((s, i) => {
    const r = s.getBoundingClientRect();
    const d = Math.abs((r.left + r.width / 2) - line);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/**
 * Marks one object prominent, and exactly one.
 *
 * Two class writes per change, never per frame — the scroll handler computes an
 * index and returns immediately if it has not moved. Prominence is a
 * presentation state and lives only in the DOM: it is never written to the
 * hash (§33) and never sent anywhere.
 */
function setProminent(rail, index, { focus = false } = {}) {
  const objs = [...rail.querySelectorAll('.lib-obj')];
  if (!objs.length) return;
  const at = Math.max(0, Math.min(index, objs.length - 1));
  if (rail.dataset.prominent === String(at) && !focus) return;
  rail.dataset.prominent = String(at);
  objs.forEach((o, i) => {
    o.classList.toggle('is-prominent', i === at);
    /* Roving tabindex: one stop per shelf. Tab lands on the item the shelf is
     * about, arrows move along it. Forty books must not be forty tab stops. */
    o.tabIndex = i === at ? 0 : -1;
  });
  /* The full title, unclamped, for the object the shelf is about (§24). A
   * cover clamps a long title to four lines and a spine cannot hold one at all,
   * so this is where "Systems That Survive Contact With A Tuesday" is readable
   * without hovering. `aria-hidden`, because the object's own accessible name
   * already carries it and announcing it twice helps nobody. */
  const cap = rail.parentElement?.querySelector('.lib-shelf-cap');
  if (cap) cap.textContent = objs[at].getAttribute('title') ?? '';
  if (focus) objs[at].focus({ preventScroll: true });
}

/** Brings an object fully into view without yanking the whole page. */
function revealAt(rail, index) {
  const slots = [...rail.querySelectorAll('.lib-slot')];
  const slot = slots[index];
  if (!slot) return;
  const box = rail.getBoundingClientRect();
  const r = slot.getBoundingClientRect();
  const pad = 24;
  let delta = 0;
  if (r.left < box.left + pad) delta = r.left - box.left - pad;
  else if (r.right > box.right - pad) delta = r.right - box.right + pad;
  if (delta) rail.scrollBy({ left: delta, behavior: scrollBehavior() });
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

  setProminent(rail, Number(rail.dataset.prominent ?? 0));

  /* Scroll → prominence. Coalesced into one rAF, and `setProminent` exits
   * immediately when the index has not changed, so a long scroll writes classes
   * a handful of times rather than sixty times a second. */
  let ticking = false;
  rail.addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        setProminent(rail, nearestIndex(rail));
      });
    }
    /* Remembered per shelf so returning from a Book lands where you left. */
    if (rail.dataset.rail) lib.shelfScroll[rail.dataset.rail] = rail.scrollLeft;
    onScrollChange?.(rail);
    syncSteps(rail);
  }, { passive: true });

  wireWheel(rail);

  rail.addEventListener('pointerenter', () => syncSteps(rail));

  rail.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { e.stopPropagation(); onMenu?.(more, more.dataset.more); return; }
    const obj = e.target.closest('.lib-obj');
    if (obj) onOpen?.(obj);
  });

  rail.addEventListener('keydown', (e) => {
    const obj = e.target.closest('.lib-obj');
    if (!obj) return;
    const all = objs();
    const at = all.indexOf(obj);
    const go = (next) => {
      e.preventDefault();
      setProminent(rail, next, { focus: true });
      revealAt(rail, next);
    };
    if (e.key === 'ArrowRight') return go(Math.min(at + 1, all.length - 1));
    if (e.key === 'ArrowLeft') return go(Math.max(at - 1, 0));
    if (e.key === 'Home') return go(0);
    if (e.key === 'End') return go(all.length - 1);
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(obj); }
  });

  /* Focus follows prominence, so tabbing into a shelf and then scrolling it
   * does not leave the outline behind on an object that has left the screen. */
  rail.addEventListener('focusin', (e) => {
    const obj = e.target.closest('.lib-obj');
    if (!obj) return;
    const at = objs().indexOf(obj);
    if (at > -1) { setProminent(rail, at); revealAt(rail, at); }
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
    setProminent(rail, nearestIndex(rail));
    syncSteps(rail);
  });
}

/**
 * Re-identifies the object you came back from, briefly (§18).
 *
 * A class with a timer, not an animation that owns anything: the object is
 * already in its final position and this only draws attention to it. If the
 * timer never fires the worst case is a permanently highlighted book, so the
 * class is also removed on the next interaction with the shelf.
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
    const at = [...rail.querySelectorAll('.lib-obj')].indexOf(obj);
    setProminent(rail, at);
    revealAt(rail, at);
  }
  if (prefersReduced()) return;         // §31: no spatial emphasis when reduced
  obj.classList.add('is-returned');
  setTimeout(() => obj.classList.remove('is-returned'), 1400);
}

export { esc, accentOf, setProminent, nearestIndex, stepSize };
