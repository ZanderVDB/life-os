/**
 * The Library design lab — the shared subject (L3.3 §3/§25).
 *
 * ONE fixed set of objects, held here as literals rather than fetched.
 *
 * That is deliberate and it is the whole point of the phase: six concepts can
 * only be compared if they are drawing the same thing. Reading the workspace
 * would make each concept's appearance depend on what happened to be seeded,
 * and a concept that looked better because it drew nicer titles would be a
 * measurement of the sample rather than of the design.
 *
 * It also makes §24 true by construction: the lab issues no requests at all, so
 * there is no path by which it could mutate Library data.
 */

/** The six approved section accents. Nothing here invents a colour. */
export const ACCENTS = ['peach', 'sage', 'lavender', 'gold', 'blue', 'rose'];

/**
 * Eight books, chosen to be awkward in the ways that matter (§25):
 * a one-word title, a very long one, a subject spread, subtitles present and
 * absent, and every accent represented.
 */
export const BOOKS = [
  { id: 'b1', title: 'Notes', sub: null, accent: 'peach', author: 'Zander', year: 2026 },
  { id: 'b2', title: 'The Laws of Gravity', sub: 'What falls, and why it keeps falling', accent: 'blue', author: 'Zander', year: 2025 },
  { id: 'b3', title: 'Letters I Did Not Send', sub: null, accent: 'lavender', author: 'Zander', year: 2024 },
  { id: 'b4', title: 'Systems That Survive Contact With A Tuesday', sub: 'Routines that do not need me at my best', accent: 'sage', author: 'Zander', year: 2026 },
  { id: 'b5', title: 'Market Notes', sub: 'Quarterly, and mostly wrong', accent: 'gold', author: 'Zander', year: 2025 },
  { id: 'b6', title: 'Atlas', sub: null, accent: 'rose', author: 'Zander', year: 2023 },
  { id: 'b7', title: 'On Sleep', sub: 'Eight months of honest numbers', accent: 'blue', author: 'Zander', year: 2026 },
  { id: 'b8', title: 'The Garden Book', sub: 'Seasons, failures, one success', accent: 'sage', author: 'Zander', year: 2024 },
];

export const DIARY = {
  id: 'diary', title: 'My Diary', sub: 'System journal',
  accent: 'lavender', author: 'Every day', year: 2026, system: true,
};

export const DOCUMENTS = [
  { id: 'd1', title: 'Weekly review — the four questions', kind: 'Document', accent: 'blue',
    excerpt: 'What moved, what stalled, what I am pretending about, what is next.' },
  { id: 'd2', title: 'Moving checklist', kind: 'Document', accent: 'blue',
    excerpt: 'Meters, keys, redirects, and the box that always gets lost.' },
  { id: 'd3', title: 'Life OS — one-page brief', kind: 'Document', accent: 'blue',
    excerpt: 'What it is, who it is for, and what it deliberately is not.' },
];

export const IMAGES = [
  { id: 'i1', title: 'Shelf study — spine spacing', kind: 'Image', accent: 'rose', meta: '1600 × 1200' },
  { id: 'i2', title: 'Panorama — long and thin', kind: 'Image', accent: 'rose', meta: '4000 × 900' },
];

export const VIDEOS = [
  { id: 'v1', title: 'Walkthrough — Today and Projects', kind: 'Video', accent: 'gold', meta: '6:12' },
  { id: 'v2', title: 'Bench test — scroll performance', kind: 'Video', accent: 'gold', meta: '1:36' },
];

export const LINKS = [
  { id: 'l1', title: 'Container queries — the part I forget', kind: 'Link', accent: 'sage', meta: 'example.com' },
  { id: 'l2', title: 'Scroll snap without fighting momentum', kind: 'Link', accent: 'sage', meta: 'example.org' },
  { id: 'l3', title: 'Kerning', kind: 'Link', accent: 'sage', meta: 'example.com' },
];

export const FILES = [
  { id: 'f1', title: 'Lease agreement', kind: 'PDF', accent: 'peach', meta: '2.1 MB' },
  { id: 'f2', title: 'Colour tokens export', kind: 'JSON', accent: 'peach', meta: '8 KB' },
];

/** Everything that is not a Book or the Diary, in one list. */
export const RESOURCES = [...DOCUMENTS, ...IMAGES, ...VIDEOS, ...LINKS, ...FILES];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * A spine title that fits (§15).
 *
 * Every spine-based concept uses this one function, so a long title is handled
 * the same way in all of them and the comparison is about the SHELF rather than
 * about who happened to truncate better.
 */
export function spineTitle(title, max = 20) {
  const t = String(title ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * Four cover templates (§14), assigned deterministically by index.
 *
 * The SAME book gets the SAME template in every concept, so a book stays
 * recognisable as you switch — which is what makes the six views comparable
 * rather than six different libraries.
 */
/* Prefixed `tpl-`, and that prefix is load-bearing.
 * The templates were first named `rule`, `band`, `frame`, `plate`, which
 * produced `lab-cover-rule` on the cover — the same class the little divider
 * INSIDE the cover already used. Every book assigned that template inherited
 * `width:30px;height:1px` for its whole cover. Measured: a 30px cover in a
 * 126px face, with the title wrapping one character per line. */
export const COVER_TEMPLATES = ['tpl-line', 'tpl-band', 'tpl-frame', 'tpl-plate'];
export const templateFor = (id) => {
  let n = 0;
  for (const ch of String(id)) n = (n + ch.charCodeAt(0)) % 97;
  return COVER_TEMPLATES[n % COVER_TEMPLATES.length];
};

/** One cover face, in whichever template this book was assigned. */
export function coverFace(b, cls = '') {
  const t = templateFor(b.id);
  return `<span class="lab-cover lab-cover-${t} ${cls}" data-accent="${b.accent}">
    <span class="lab-cover-mark">Life OS</span>
    <span class="lab-cover-pre">${b.system ? 'Journal' : 'Notebook'}</span>
    <span class="lab-cover-title">${esc(b.title)}</span>
    ${b.sub ? `<span class="lab-cover-sub">${esc(b.sub)}</span>` : ''}
    <span class="lab-cover-rule"></span>
    <span class="lab-cover-author">${esc(b.author)} · ${b.year}</span>
  </span>`;
}
