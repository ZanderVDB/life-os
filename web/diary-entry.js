/**
 * One day, and everything on it.
 *
 * Deliberately NOT a Book page. No cover, no spread, no section tabs, no page
 * turn, no coloured page edge. Diary shares the editor and the document
 * grammar with Library and shares none of its furniture, because a book is an
 * object you hold and a diary is a sequence you move through.
 *
 * What Diary does keep from the Book is the ruled paper and the F2.1 block
 * grid — a 30px cycle with headings claiming one unruled lead row. That is not
 * decoration carried over out of habit: it is the only part of the Book that
 * exists to make WRITING read well, and it does the same work here.
 */

import { docToHtml } from './editor-doc.js';
import { BLOCK_STYLES } from './editor-blocks.js';
import {
  dia, MOODS, ENERGIES, formatLong, dayName, relativeDay, localToday, addDays,
} from './diary-api.js';
import { STATUS_LABEL } from './diary-save.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── Header ──────────────────────────────────────────────────────────── */

/**
 * The page head.
 *
 * `dia-page` is the marker the shell watches to hide the right rail — the same
 * mechanism Calendar, Projects and Library use. Diary uses its width for
 * writing.
 */
export function headerHtml() {
  const today = localToday();
  const isToday = dia.date === today;
  return `<p class="eyebrow dia-page">Life OS</p>
    <h1>Diary</h1>
    <p class="sub">${esc(relativeDay(dia.date, today))}</p>
    <div class="page-actions">
      <button class="btn btn-ghost btn-sm" id="dia-history"
        aria-label="Diary history and search">${icon('cal')}<span>History</span></button>
      ${isToday ? '' : `<button class="btn btn-ghost btn-sm" id="dia-today">Today</button>`}
    </div>`;
}

const icon = (name) => {
  const paths = {
    cal: '<rect x="3" y="4.5" width="14" height="13" rx="2.5"/><path d="M3 8.5h14M7 3v3M13 3v3"/>',
    left: 'm12 4-6 6 6 6',
    right: 'm8 4 6 6-6 6',
    search: '<circle cx="9" cy="9" r="5"/><path d="m13 13 3.5 3.5"/>',
  };
  const d = paths[name];
  const body = d.startsWith('<') ? d : `<path d="${d}"/>`;
  return `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    >${body}</svg>`;
};

/* ── Date navigation (§13) ───────────────────────────────────────────── */

/**
 * Two pairs of arrows, and they are NOT the same thing.
 *
 * Day steps by calendar date, including days with nothing on them. Entry jumps
 * to the nearest date that actually holds writing. Both are labelled, because
 * two adjacent unlabelled chevron pairs would be a guess every time.
 */
export function navHtml() {
  return `<nav class="dia-nav" aria-label="Move between days">
    <div class="dia-nav-group">
      <button type="button" class="dia-step" data-go="prev-day"
        aria-label="Previous day" title="Previous day">${icon('left')}</button>
      <span class="dia-nav-label">Day</span>
      <button type="button" class="dia-step" data-go="next-day"
        aria-label="Next day" title="Next day">${icon('right')}</button>
    </div>
    <div class="dia-nav-group">
      <button type="button" class="dia-step" data-go="prev-entry"
        aria-label="Previous entry" title="Jump to the previous day you wrote on"
        >${icon('left')}</button>
      <span class="dia-nav-label">Entry</span>
      <button type="button" class="dia-step" data-go="next-entry"
        aria-label="Next entry" title="Jump to the next day you wrote on"
        >${icon('right')}</button>
    </div>
    <label class="dia-pick">
      <span class="sr-only">Jump to a date</span>
      <input type="date" id="dia-date" value="${esc(dia.date)}" aria-label="Jump to a date">
    </label>
  </nav>`;
}

/* ── The entry surface ───────────────────────────────────────────────── */

export function entryHtml() {
  const e = dia.entry;
  const archived = dia.archivedEntry;

  if (archived) return archivedHtml(archived);

  return `${navHtml()}
  <article class="dia-sheet" aria-labelledby="dia-date-h">
    <header class="dia-sheet-head">
      <p class="dia-day">${esc(dayName(dia.date))}</p>
      <h2 class="dia-date" id="dia-date-h">${esc(formatLong(dia.date))}</h2>
      <input class="dia-title" id="dia-title" value="${esc(e?.title ?? '')}"
        placeholder="Add a title (optional)" aria-label="Entry title" maxlength="300">
    </header>

    ${toolbarHtml()}

    <div class="dia-body">
      <div class="dia-editor" id="dia-editor" contenteditable="true" spellcheck="true"
        role="textbox" aria-multiline="true"
        aria-label="Diary entry for ${esc(formatLong(dia.date))}"
        data-placeholder="Write about your day…">${docToHtml(e?.document)}</div>
    </div>

    ${contextHtml(e)}

    <footer class="dia-foot">
      <span class="dia-hint">${e ? '' : 'Nothing is saved until you write something.'}</span>
      <span class="dia-save" id="dia-save" role="status">${STATUS_LABEL.saved}</span>
      ${e ? `<button type="button" class="dia-archive" id="dia-archive"
        aria-label="Archive this entry">Archive</button>` : ''}
    </footer>
  </article>`;
}

/**
 * The same restrained set as the Book, in Diary's own chrome.
 *
 * Style names are Body / Heading / Subheading / Quote — the shared
 * `BLOCK_STYLES` table, so a DOM tag is never shown to anyone.
 */
export function toolbarHtml() {
  const b = (cmd, label, glyph, key) =>
    `<button type="button" class="dia-tb" data-cmd="${cmd}" aria-label="${label}"
      title="${label}${key ? ` (${key})` : ''}" aria-pressed="false">${glyph}</button>`;
  return `<div class="dia-toolbar" role="toolbar" aria-label="Formatting">
    <select class="dia-tb-style" data-cmd="style" aria-label="Text style">
      ${BLOCK_STYLES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}
    </select>
    <span class="dia-tb-sep" aria-hidden="true"></span>
    ${b('bold', 'Bold', '<b>B</b>', 'Ctrl B')}
    ${b('italic', 'Italic', '<i>I</i>', 'Ctrl I')}
    ${b('underline', 'Underline', '<u>U</u>', 'Ctrl U')}
    ${b('strikeThrough', 'Strikethrough', '<s>S</s>')}
    <span class="dia-tb-sep" aria-hidden="true"></span>
    ${b('insertUnorderedList', 'Bullet list', '•—')}
    ${b('insertOrderedList', 'Numbered list', '1—')}
    ${b('link', 'Add link', '🔗', 'Ctrl K')}
    <span class="dia-tb-sep" aria-hidden="true"></span>
    ${b('undo', 'Undo', '↶', 'Ctrl Z')}
    ${b('redo', 'Redo', '↷', 'Ctrl ⇧ Z')}
  </div>`;
}

/**
 * The optional daily context (§17).
 *
 * Collapsed by default and never required. No row of faces: a diary that asks
 * you to classify your feeling before it will let you write has changed what it
 * is for. Every option has a text label, so nothing depends on reading an icon.
 */
function contextHtml(e) {
  const filled = [e?.mood, e?.energy, e?.weatherNote, e?.locationNote, e?.daySummary]
    .filter(Boolean).length;
  const open = dia.contextOpen || filled > 0;
  return `<section class="dia-context ${open ? 'is-open' : ''}">
    <button type="button" class="dia-context-toggle" id="dia-context-toggle"
      aria-expanded="${open}" aria-controls="dia-context-body">
      <span>${open ? 'Day context' : 'Add context'}</span>
      ${filled ? `<span class="dia-context-n">${filled}</span>` : ''}
      <span class="dia-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
    </button>
    <div class="dia-context-body" id="dia-context-body" ${open ? '' : 'hidden'}>
      <div class="dia-field">
        <label for="dia-mood">Mood</label>
        <select id="dia-mood" data-field="mood">
          <option value="">Not recorded</option>
          ${MOODS.map((m) => `<option value="${m.id}"${
  e?.mood === m.id ? ' selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <div class="dia-field">
        <label for="dia-energy">Energy</label>
        <select id="dia-energy" data-field="energy">
          <option value="">Not recorded</option>
          ${ENERGIES.map((m) => `<option value="${m.id}"${
  e?.energy === m.id ? ' selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <div class="dia-field">
        <label for="dia-weather">Weather</label>
        <input id="dia-weather" data-field="weatherNote" maxlength="300"
          value="${esc(e?.weatherNote ?? '')}" placeholder="Optional">
      </div>
      <div class="dia-field">
        <label for="dia-location">Where</label>
        <input id="dia-location" data-field="locationNote" maxlength="300"
          value="${esc(e?.locationNote ?? '')}" placeholder="Optional">
      </div>
      <div class="dia-field dia-field-wide">
        <label for="dia-summary">Day summary</label>
        <textarea id="dia-summary" data-field="daySummary" rows="2" maxlength="2000"
          placeholder="A sentence or two, for looking back later">${esc(e?.daySummary ?? '')}</textarea>
      </div>
    </div>
  </section>`;
}

/**
 * A date whose entry was archived.
 *
 * The day is not offered as blank paper: writing here would be refused by the
 * server anyway, and quietly showing an empty editor would look like the
 * writing was gone.
 */
function archivedHtml(entry) {
  return `${navHtml()}
  <article class="dia-sheet dia-sheet-archived">
    <header class="dia-sheet-head">
      <p class="dia-day">${esc(dayName(dia.date))}</p>
      <h2 class="dia-date">${esc(formatLong(dia.date))}</h2>
      <p class="dia-arch-badge">Archived</p>
    </header>
    <div class="dia-arch-body">
      <p class="dia-arch-lead">${entry.title
    ? `“${esc(entry.title)}” is archived.` : 'This day is archived.'}</p>
      <p class="dia-arch-note">Nothing was deleted. Restore it to read it and keep
        writing on this date.</p>
      <button type="button" class="btn btn-primary" id="dia-restore">Restore this entry</button>
    </div>
  </article>`;
}

/* ── Loading and error, without a blank page ─────────────────────────── */

export const loadingHtml = () => `<div class="dia-sheet dia-sheet-skel">
  <div class="skeleton" style="height:52px"></div>
  <div class="skeleton" style="height:220px;margin-top:14px"></div>
</div>`;

export const errorHtml = (msg) => `<div class="state">
  <b>That day did not load</b>${esc(msg)}
  <div style="margin-top:16px"><button class="btn" id="dia-retry">Try again</button></div>
</div>`;

export { esc, icon };
