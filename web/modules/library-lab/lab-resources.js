/**
 * NON-BOOK RESOURCES — the alternatives (L3.5 §23–§27).
 *
 * Books look like Books. Everything else is a front-facing archive object, and
 * what is being chosen here is *which* archive object each kind should be.
 *
 * Every variant of every kind renders the same records, at the same size, in the
 * same bay. Nothing is a bright white card: these are dark Life OS surfaces, and
 * the physicality has to come from edges, layers and depth rather than from
 * inverting the palette.
 */

import { esc } from './shared-cover.js';

const initial = (s) => esc(String(s ?? '?').replace(/^www\./, '').slice(0, 1).toUpperCase());

/* ── §23  Documents ──────────────────────────────────────────────────────── */

export const DOCS = [
  { id: 'a', label: 'A', name: 'Portfolio', note: 'A slim professional portfolio with a visible binding edge.' },
  { id: 'b', label: 'B', name: 'Folder', note: 'A modern dark folder: a small tab, papers layered behind.' },
  { id: 'c', label: 'C', name: 'Document jacket', note: 'A rigid archival jacket with a title plate.' },
  { id: 'd', label: 'D', name: 'File folio', note: 'Half open — pages visible behind the cover. Compact.' },
  { id: 'e', label: 'E', name: 'Stack and cover', note: 'A restrained stack under a front sheet. Depth without clutter.' },
];

export function documentEl(d, variant) {
  const inner = {
    a: `<span class="cb-d-bind"></span><span class="cb-d-kind">Document</span>
        <span class="cb-d-t">${esc(d.title)}</span>
        <span class="cb-d-x">${esc(d.excerpt ?? '')}</span>`,
    b: `<span class="cb-d-leaf"></span><span class="cb-d-leaf cb-d-leaf2"></span>
        <span class="cb-d-tab"></span><span class="cb-d-t">${esc(d.title)}</span>
        <span class="cb-d-m">Document</span>`,
    c: `<span class="cb-d-plate"><span class="cb-d-kind">Document</span>
        <span class="cb-d-t">${esc(d.title)}</span></span>
        <span class="cb-d-x">${esc(d.excerpt ?? '')}</span>`,
    d: `<span class="cb-d-sheet"></span><span class="cb-d-sheet cb-d-sheet2"></span>
        <span class="cb-d-lid"><span class="cb-d-kind">Document</span>
        <span class="cb-d-t">${esc(d.title)}</span></span>`,
    e: `<span class="cb-d-stack"></span><span class="cb-d-stack cb-d-stack2"></span>
        <span class="cb-d-top"><span class="cb-d-t">${esc(d.title)}</span>
        <span class="cb-d-x">${esc(d.excerpt ?? '')}</span></span>`,
  }[variant] ?? '';
  return `<li class="cb-cell"><article class="cb-doc cb-d-${esc(variant)}" data-obj="${esc(d.id)}"
    data-accent="${esc(d.accent)}" role="button" tabindex="0"
    aria-label="${esc(d.title)}, Document">${inner}</article></li>`;
}

/* ── §24  Media ──────────────────────────────────────────────────────────── */

export const MEDIA = [
  { id: 'a', label: 'A', name: 'Contact print', note: 'Framed like a modern archival print, with a wide lower margin.' },
  { id: 'b', label: 'B', name: 'Media sleeve', note: 'A dark sleeve with a window cut through it.' },
  { id: 'c', label: 'C', name: 'Framed tile', note: 'A slightly physical frame around an aspect-safe image.' },
  { id: 'd', label: 'D', name: 'Film archive', note: 'Contact-sheet language: perforated rails, a numbered frame.' },
  { id: 'e', label: 'E', name: 'Display tray', note: 'Sitting slightly forward on a shallow ledge of its own.' },
];

const play = `<span class="cb-play"><svg viewBox="0 0 20 20" width="12" height="12"
  fill="currentColor" aria-hidden="true"><path d="m7 5 8 5-8 5z"/></svg></span>`;

export function mediaEl(m, variant) {
  const isVideo = m.kind === 'Video';
  /* Video always says so, and always says how long (§24). A still and a clip
   * that look identical until you open them is the one failure this family
   * cannot have. */
  const badge = `${isVideo ? play : ''}<span class="cb-m-meta">${esc(m.meta)}</span>`;
  const frame = `<span class="cb-m-win">${badge}</span>`;
  const inner = {
    a: `${frame}<span class="cb-m-t">${esc(m.title)}</span>`,
    b: `<span class="cb-m-sleeve">${frame}</span><span class="cb-m-t">${esc(m.title)}</span>`,
    c: `<span class="cb-m-frame">${frame}</span><span class="cb-m-t">${esc(m.title)}</span>`,
    d: `<span class="cb-m-strip"><span class="cb-m-perf"></span>${frame}
        <span class="cb-m-perf"></span></span><span class="cb-m-t">${esc(m.title)}</span>`,
    e: `${frame}<span class="cb-m-t">${esc(m.title)}</span><span class="cb-m-tray"></span>`,
  }[variant] ?? '';
  return `<li class="cb-cell"><article class="cb-med cb-m-${esc(variant)}${isVideo ? ' is-video' : ''}"
    data-obj="${esc(m.id)}" data-accent="${esc(m.accent)}" role="button" tabindex="0"
    aria-label="${esc(m.title)}, ${esc(m.kind)}${isVideo ? `, ${esc(m.meta)}` : ''}">${inner}</article></li>`;
}

/* ── §25  Links ──────────────────────────────────────────────────────────── */

export const LINKVARS = [
  { id: 'a', label: 'A', name: 'Clipping card', note: 'A cutting kept flat, source mark at the left.' },
  { id: 'b', label: 'B', name: 'Bookmark strip', note: 'A narrow strip with a coloured tail, laid in the tray.' },
  { id: 'c', label: 'C', name: 'Reference slip', note: 'A small filing slip: rule above, domain beneath.' },
  { id: 'd', label: 'D', name: 'Pinned card', note: 'Held under a rail at the top, as if pinned.' },
];

export function linkEl(l, variant) {
  const mark = `<span class="cb-l-mark">${initial(l.meta)}</span>`;
  const body = `<span class="cb-l-t">${esc(l.title)}</span><span class="cb-l-m">${esc(l.meta)}</span>`;
  const inner = {
    a: `${mark}<span class="cb-l-body">${body}</span>`,
    b: `<span class="cb-l-tail"></span><span class="cb-l-body">${body}</span>${mark}`,
    c: `<span class="cb-l-rule"></span><span class="cb-l-body">${body}</span>`,
    d: `<span class="cb-l-rail"></span>${mark}<span class="cb-l-body">${body}</span>`,
  }[variant] ?? '';
  return `<li class="cb-cell"><article class="cb-lnk cb-l-${esc(variant)}" data-obj="${esc(l.id)}"
    data-accent="${esc(l.accent)}" role="button" tabindex="0"
    aria-label="${esc(l.title)}, Link, ${esc(l.meta)}">${inner}</article></li>`;
}

/* ── §26  Files ──────────────────────────────────────────────────────────── */

export const FILEVARS = [
  { id: 'a', label: 'A', name: 'File jacket', note: 'A stiff jacket with a clipped corner.' },
  { id: 'b', label: 'B', name: 'Labelled folder', note: 'A folder with a printed label across the front.' },
  { id: 'c', label: 'C', name: 'Drawer front', note: 'An archive drawer face with a recessed pull.' },
  { id: 'd', label: 'D', name: 'Envelope', note: 'A document envelope with a visible flap seam.' },
];

export function fileEl(f, variant) {
  const body = `<span class="cb-f-kind">${esc(f.kind)}</span>
    <span class="cb-f-t">${esc(f.title)}</span><span class="cb-f-m">${esc(f.meta)}</span>`;
  const inner = {
    a: `<span class="cb-f-body">${body}</span><span class="cb-f-corner"></span>`,
    b: `<span class="cb-f-body"><span class="cb-f-label">${body}</span></span>`,
    c: `<span class="cb-f-body">${body}<span class="cb-f-pull"></span></span>`,
    d: `<span class="cb-f-body">${body}<span class="cb-f-flap"></span></span>`,
  }[variant] ?? '';
  return `<li class="cb-cell"><article class="cb-fil cb-f-${esc(variant)}" data-obj="${esc(f.id)}"
    data-accent="${esc(f.accent)}" role="button" tabindex="0"
    aria-label="${esc(f.title)}, ${esc(f.kind)} file, ${esc(f.meta)}">${inner}</article></li>`;
}

/* ── §27  One architecture, or one per kind ───────────────────────────────
 *
 * The comparison is: does giving each kind its own storage structure read as one
 * rich Library, or as five unrelated metaphors? Concept F in the L3.3 bake-off
 * took this furthest and the note there still stands — five metaphors is five
 * things to learn. This puts the two arrangements side by side instead of
 * arguing about it.
 */
export const MIXED = [
  { kind: 'Books', furniture: 'shelf', note: 'An open shelf, spine-on.' },
  { kind: 'Documents', furniture: 'tray', note: 'A folio tray: shallower, no uprights.' },
  { kind: 'Media', furniture: 'display', note: 'A display tray with a lit front edge.' },
  { kind: 'Links', furniture: 'rail', note: 'A clipping rail — cards under a top bar.' },
  { kind: 'Files', furniture: 'slot', note: 'An archive slot: deeper recess, heavier base.' },
];
