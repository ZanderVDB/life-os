/**
 * One day, as a two-page spread.
 *
 * D1 rendered a single centred sheet on the reasoning that a diary is a
 * sequence rather than an object you hold. That was right in the abstract and
 * wrong on screen: it read as a document with fields attached, and it did not
 * look like part of Life OS.
 *
 * The spread earns its place here for a different reason than in Library.
 * Library's two pages are two facing pages of one text. Diary's two pages are
 * two KINDS OF THINKING:
 *
 *   left   reflective writing — the day in your own words, then guided prompts
 *   right  a quick check-in — how it actually felt, in a few taps
 *
 * Writing is slow and open; a check-in is fast and closed. On one surface the
 * check-in felt like a form to finish before the writing counted.
 *
 * ── What is reused ───────────────────────────────────────────────────────
 *
 * The `.bk-*` geometry, verbatim: the 420/297 spread, the 6px gutter, A4 pages,
 * the audited padding, the margin stripe, the mirrored coloured edge, the ruled
 * paper and the 30px block grid. That geometry is not Library's property — it
 * is the house style for a page you write on, and two surfaces that both hold
 * writing should not invent two of them.
 *
 * What is NOT reused: the cover, section tabs, page-turn-by-spread, the shelf.
 * Diary's pages are not pages of one book; they are today.
 */

import { docToHtml } from './editor-doc.js';
import { BLOCK_STYLES } from './editor-blocks.js';
import {
  dia, formatLong, dayName, relativeDay, localToday, monthName, monthGrid, formatShort,
} from './diary-api.js';
import { STATUS_LABEL } from './diary-save.js';
import { checkinHtml, promptsHtml } from './diary-checkin.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  cal: '<rect x="3" y="4.5" width="14" height="13" rx="2.5"/><path d="M3 8.5h14M7 3v3M13 3v3"/>',
  left: '<path d="m12 4-6 6 6 6"/>',
  right: '<path d="m8 4 6 6-6 6"/>',
};
const icon = (name, size = 15) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}"
  fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

/* ── Header ──────────────────────────────────────────────────────────────
 *
 * Four controls, and every one of them says what it does.
 *
 * D1 had two labelled chevron pairs — Day and Entry. "Entry" meant "jump to the
 * previous day I actually wrote on", which is a real thing to want and not a
 * thing anyone reads off a chevron. That behaviour moved into History, where a
 * month grid already shows exactly where those days are.
 */
export function headerHtml() {
  const today = localToday();
  const isToday = dia.date === today;
  return `<p class="eyebrow dia-page">Life OS</p>
    <h1>Diary</h1>
    <p class="sub">${esc(relativeDay(dia.date, today))}</p>
    <div class="page-actions dia-actions">
      <div class="dia-daynav" role="group" aria-label="Move between days">
        <button type="button" class="dia-step" data-go="prev-day"
          aria-label="Previous day" title="Previous day">${icon('left', 17)}</button>
        <button type="button" class="dia-today${isToday ? ' is-here' : ''}"
          data-go="today" ${isToday ? 'aria-current="date"' : ''}
          aria-label="${isToday ? 'You are on today' : 'Go to today'}">Today</button>
        <button type="button" class="dia-step" data-go="next-day"
          aria-label="Next day" title="Next day">${icon('right', 17)}</button>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="dia-jump"
        aria-haspopup="dialog" aria-expanded="false">${icon('cal')}<span>${
  esc(monthName(dia.date))}</span></button>
      <button type="button" class="btn btn-ghost btn-sm" id="dia-history">History</button>
    </div>`;
}

/**
 * The date jump.
 *
 * A month grid in the app's own surface, not `<input type="date">`. The native
 * control cannot be styled, opens an operating-system panel in the middle of a
 * journal, and looks like a form field — which is exactly the impression this
 * phase is removing. The grid also shows which days already have writing, which
 * a date input never could.
 */
export function jumpHtml(month = dia.date) {
  const today = localToday();
  const have = new Set(dia.days.map((d) => d.date));
  const cells = monthGrid(month);
  const week = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return `<div class="dia-jump" data-month="${esc(month)}">
    <div class="dia-jump-head">
      <button type="button" class="dia-step" data-jump-month="-1"
        aria-label="Previous month">${icon('left', 15)}</button>
      <span class="dia-jump-title" aria-live="polite">${esc(monthName(month))}</span>
      <button type="button" class="dia-step" data-jump-month="1"
        aria-label="Next month">${icon('right', 15)}</button>
    </div>
    <div class="dia-jump-grid" role="grid">
      <div class="dia-jump-row dia-jump-week" role="row">
        ${week.map((d) => `<span role="columnheader">${d}</span>`).join('')}
      </div>
      ${chunk(cells, 7).map((row) => `<div class="dia-jump-row" role="row">
        ${row.map((c) => {
    const has = have.has(c.date);
    const label = [formatShort(c.date), has ? 'has an entry' : 'no entry',
      c.date === today ? 'today' : ''].filter(Boolean).join(', ');
    return `<button type="button" role="gridcell" data-jump-to="${c.date}"
          class="dia-jump-cell${c.inMonth ? '' : ' is-outside'}${has ? ' has-entry' : ''}${
  c.date === today ? ' is-today' : ''}${c.date === dia.date ? ' is-open' : ''}"
          aria-label="${esc(label)}">${c.day}${
  has ? '<i class="dia-dot" aria-hidden="true"></i>' : ''}</button>`;
  }).join('')}
      </div>`).join('')}
    </div>
  </div>`;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* ── The spread ──────────────────────────────────────────────────────── */

export function spreadHtml() {
  if (dia.archivedEntry) return archivedHtml(dia.archivedEntry);
  const e = dia.entry;

  return `<div class="bk-stage dia-stage">
    <button type="button" class="bk-arrow" data-go="prev-day"
      aria-label="Previous day">${icon('left', 20)}</button>

    <div class="bk-book bk-spread dia-book" data-accent="lavender">
      <div class="bk-page bk-page-left dia-left" data-accent="lavender">
        <header class="dia-sheet-head">
          <p class="dia-day">${esc(dayName(dia.date))}</p>
          <h2 class="dia-date" id="dia-date-h">${esc(formatLong(dia.date))}</h2>
          <input class="dia-title" id="dia-title" value="${esc(e?.title ?? '')}"
            placeholder="Add a title (optional)" aria-label="Entry title" maxlength="300">
        </header>
        <div class="dia-scroll">
          <div class="dia-editor" id="dia-editor" contenteditable="true" spellcheck="true"
            role="textbox" aria-multiline="true"
            aria-label="Diary entry for ${esc(formatLong(dia.date))}"
            data-placeholder="Write about your day…">${docToHtml(e?.document)}</div>
          ${promptsHtml(dia.reflection)}
        </div>
      </div>

      <div class="bk-page bk-page-right dia-right" data-accent="lavender">
        <div class="dia-scroll">
          ${checkinHtml(e, dia.reflection)}
        </div>
      </div>
    </div>

    <button type="button" class="bk-arrow" data-go="next-day"
      aria-label="Next day">${icon('right', 20)}</button>
  </div>
  <div class="bk-foot dia-foot">
    <span class="dia-hint">${e ? '' : 'Nothing is saved until you write something.'}</span>
    <span class="dia-save" id="dia-save" role="status">${STATUS_LABEL.saved}</span>
    ${e ? `<button type="button" class="dia-archive" id="dia-archive"
      aria-label="Archive this entry">Archive</button>` : ''}
  </div>`;
}

/**
 * The formatting toolbar — no longer rendered.
 *
 * Diary is a place to begin writing, not a document editor, and a permanent
 * ribbon over a journal page makes the whole spread read as a form. Removed in
 * D2.1 along with the block-style dropdown.
 *
 * Nothing about STORAGE changed. Existing entries containing headings,
 * subheadings, quotes and lists still render exactly as before — `docToHtml`
 * and the block grid are untouched — and the shared Enter/Backspace rules still
 * apply, so pressing Enter at the end of an old heading still produces a body
 * paragraph. What is gone is the way to CREATE new block types by hand, which
 * new diary writing did not want.
 *
 * Kept as a function rather than deleted so the intent is legible and the
 * decision is reversible in one line.
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
 * A date whose entry was archived.
 *
 * Shown as a closed spread rather than as blank paper: writing here would be
 * refused by the server anyway, and an empty editor would look like the writing
 * was gone.
 */
function archivedHtml(entry) {
  return `<div class="bk-stage dia-stage">
    <button type="button" class="bk-arrow" data-go="prev-day"
      aria-label="Previous day">${icon('left', 20)}</button>
    <div class="bk-book bk-spread dia-book dia-book-archived" data-accent="lavender">
      <div class="bk-page bk-page-left dia-left" data-accent="lavender">
        <header class="dia-sheet-head">
          <p class="dia-day">${esc(dayName(dia.date))}</p>
          <h2 class="dia-date">${esc(formatLong(dia.date))}</h2>
          <p class="dia-arch-badge">Archived</p>
        </header>
        <div class="dia-arch-body">
          <p class="dia-arch-lead">${entry.title
    ? `“${esc(entry.title)}” is archived.` : 'This day is archived.'}</p>
          <p class="dia-arch-note">Nothing was deleted. Restore it to read it and
            keep writing on this date.</p>
          <button type="button" class="btn btn-primary" id="dia-restore">Restore this entry</button>
        </div>
      </div>
      <div class="bk-page bk-page-right dia-right dia-right-quiet" data-accent="lavender"></div>
    </div>
    <button type="button" class="bk-arrow" data-go="next-day"
      aria-label="Next day">${icon('right', 20)}</button>
  </div>`;
}

/* ── Loading and error, without a blank page ─────────────────────────── */

/**
 * The paper, waiting for a day.
 *
 * It carries the REQUESTED date's heading (D2.3 §19, §21). When the network is
 * slow the outgoing ghost fades in 260ms and whatever is underneath becomes
 * visible — so if that were still the old day, a slow connection would show
 * the day you just left as the current one, which is the rubber-band wearing a
 * different hat. The heading is right from the first frame; only the writing
 * is still on its way.
 */
export const loadingHtml = (date = dia.date) => `<div class="bk-stage dia-stage">
  <div class="bk-book bk-spread dia-book dia-book-skel" data-accent="lavender">
    <div class="bk-page bk-page-left dia-left" data-accent="lavender">
      <header class="dia-sheet-head">
        <p class="dia-day">${esc(dayName(date))}</p>
        <h2 class="dia-date">${esc(formatLong(date))}</h2>
      </header>
      <div class="dia-scroll" aria-hidden="true">
        <div class="dia-skel-lines">${'<span></span>'.repeat(6)}</div>
      </div>
    </div>
    <div class="bk-page bk-page-right dia-right" data-accent="lavender"></div>
  </div>
</div>`;

export const errorHtml = (msg) => `<div class="state">
  <b>That day did not load</b>${esc(msg)}
  <div style="margin-top:16px"><button class="btn" id="dia-retry">Try again</button></div>
</div>`;

export { esc, icon };
