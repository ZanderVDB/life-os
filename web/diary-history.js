/**
 * Diary history — which days have writing on them, and where.
 *
 * A month grid plus recent entries plus search. Not a heatmap and not a streak
 * counter: Diary is a record, not a habit, and a screen that rewards
 * consecutive days quietly punishes the weeks somebody could not write. The
 * grid answers "where is that day" and "how has this month gone", and stops.
 */

import {
  dia, monthGrid, monthName, relativeDay, formatShort, localToday, MOODS,
} from './diary-api.js';
/* The SAME components the right page draws with (D2.3 §12). Reused, never
 * re-implemented: a month grid that spoke a second visual language would be a
 * second vocabulary to learn, and the two would drift. */
import {
  FEELINGS, ENERGIES, SOCIAL, PASSIVE,
  face, glyph, energyMeter, batteryMeter, scaleValue, labelOf,
} from './diary-checkin.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const moodLabel = (id) => MOODS.find((m) => m.id === id)?.label ?? null;

export function historyHtml() {
  const today = localToday();
  const byDate = new Map(dia.days.map((d) => [d.date, d]));
  const cells = monthGrid(dia.month ?? dia.date);

  return `<div class="dia-history">
    <div class="dia-hist-main">
      ${searchBarHtml()}
      ${dia.results ? resultsHtml() : `
        <section class="dia-cal" aria-labelledby="dia-cal-h">
          <div class="dia-cal-head">
            <button type="button" class="dia-step" data-month="-1"
              aria-label="Previous month">‹</button>
            <h3 class="dia-cal-title" id="dia-cal-h" aria-live="polite"
              >${esc(monthName(dia.month ?? dia.date))}</h3>
            <button type="button" class="dia-step" data-month="1"
              aria-label="Next month">›</button>
          </div>
          <div class="dia-grid" role="grid" aria-labelledby="dia-cal-h">
            <div class="dia-grid-row dia-grid-head" role="row">
              ${WEEKDAYS.map((d) => `<span role="columnheader" abbr="${d}">${d}</span>`).join('')}
            </div>
            ${chunk(cells, 7).map((week) => `<div class="dia-grid-row" role="row">
              ${week.map((c) => dayCell(c, byDate.get(c.date), today)).join('')}
            </div>`).join('')}
          </div>
          <p class="dia-cal-key" title="A written day shows one line of what it
            was about, and the tint follows how it felt. It is never a
            judgement: a hard day is warm, never red.">A written day shows what
            it was about. The tint follows how it felt, never how it went.</p>
        </section>`}
    </div>

    <aside class="dia-hist-side" aria-labelledby="dia-recent-h">
      <h3 class="dia-side-h" id="dia-recent-h">Recent</h3>
      ${dia.recent.length ? `<ul class="dia-recent" role="list">
        ${dia.recent.map((e) => `<li><button type="button" class="dia-recent-row"
          data-open="${esc(e.date)}">
          <span class="dia-recent-when">${esc(relativeDay(e.date, today))}</span>
          <span class="dia-recent-title">${esc(e.title ?? summaryOf(e) ?? excerptOf(e))}</span>
          ${e.mood ? `<span class="dia-recent-mood">${esc(moodLabel(e.mood))}</span>` : ''}
        </button></li>`).join('')}
      </ul>` : `<p class="dia-side-empty">Nothing written yet. Days you write on
        will appear here.</p>`}
    </aside>
  </div>`;
}

/**
 * One day.
 *
 * ── THE DAILY SNAPSHOT (D2.3 §12) ────────────────────────────────────────
 *
 * D2.2's cell showed a line of context and the feeling as a word, and on most
 * days that word was the only thing there: a month read as a column of
 * `GREAT`, `STEADY`, `GOOD`. A word is not a snapshot.
 *
 * The cell now speaks the SAME visual language as the right page, using the
 * same components — `face`, `energyMeter`, `batteryMeter` — imported from
 * `diary-checkin.js` rather than re-drawn here. One vocabulary, learned once:
 *
 *   row 1   feeling face · energy meter · social battery
 *   row 2   the day number and one short line of context
 *   row 3   four tiny passive marks, when there are any (§13)
 *
 * Exact values live in the accessible name and in `title`, so hovering or
 * focusing a day says what it actually was without any of it being written
 * into a 60px square.
 *
 * Presence is carried by FOUR non-colour things — the indicators, the context
 * line, a bolder weight, and the accessible name. The tint is decoration and
 * is never the only signal (§14).
 */
function dayCell(cell, entry, today) {
  const has = !!entry;
  const isToday = cell.date === today;
  const isOpen = cell.date === dia.date;
  const feeling = has ? FEELINGS.find((f) => f.id === entry.feeling) ?? null : null;
  const preview = has ? (entry.preview ?? null) : null;
  const energy = has ? entry.energy ?? null : null;
  const social = has ? entry.social ?? null : null;
  const rhythm = (has && entry.rhythm) || {};
  const said = [
    feeling ? `felt ${feeling.label.toLowerCase()}` : '',
    energy ? `energy ${(labelOf(ENERGIES, energy) ?? '').toLowerCase()}` : '',
    social ? `social battery ${(labelOf(SOCIAL, social) ?? '').toLowerCase()}` : '',
    ...PASSIVE.map((p) => (rhythm[p.key]
      ? `${p.label.toLowerCase()} ${(labelOf(p.scale, rhythm[p.key]) ?? '').toLowerCase()}` : '')),
  ].filter(Boolean);
  const label = [
    formatShort(cell.date),
    has ? 'has an entry' : 'no entry',
    ...said,
    preview ?? '',
    isToday ? 'today' : '',
  ].filter(Boolean).join(', ');

  /* §17: ALL FOUR passive dimensions, always, on a day that answered any of
   * them. An unanswered one is drawn faint rather than omitted, so the four
   * marks sit in the same four positions on every cell and a month can be
   * scanned down a column. Omitting the missing ones made the row shuffle
   * left, which is unreadable at a glance and was the point of having it. */
  const anyRhythm = PASSIVE.some((p) => rhythm[p.key]);

  return `<button type="button" role="gridcell" class="dia-day-cell${
    cell.inMonth ? '' : ' is-outside'}${has ? ' has-entry' : ''}${
    isToday ? ' is-today' : ''}${isOpen ? ' is-open' : ''}"
    data-open="${esc(cell.date)}" aria-label="${esc(label)}"
    ${said.length ? `title="${esc(said.join(' · '))}"` : ''}
    ${feeling ? `data-feel="${esc(feeling.id)}"` : ''}
    ${isOpen ? 'aria-current="date"' : ''} tabindex="${isOpen ? '0' : '-1'}">
    <span class="dia-day-top">
      <span class="dia-day-n">${cell.day}</span>
      ${has ? `<span class="dia-day-ind" aria-hidden="true">
        ${feeling ? face(feeling, 16) : '<span class="dia-day-gap"></span>'}
        ${energy ? energyMeter(energy, 'dia-meter-xs') : '<span class="dia-day-gap"></span>'}
        ${social ? batteryMeter(social, 'dia-batt-xs') : '<span class="dia-day-gap"></span>'}
      </span>` : ''}
    </span>
    ${preview ? `<span class="dia-day-prev">${esc(preview)}</span>` : ''}
    ${anyRhythm ? `<span class="dia-day-rh" aria-hidden="true">${PASSIVE.map((p) => {
    const id = rhythm[p.key];
    const v = id ? scaleValue(p.scale, id) : null;
    return `<span class="dia-day-rh-i${v === null ? ' is-unset' : ''}"
      style="--v:${v === null ? 0 : Math.round(v * 100)}">${glyph(p.icon, 11)}</span>`;
  }).join('')}</span>` : ''}
  </button>`;
}

const summaryOf = (e) => (e.daySummary ? e.daySummary.slice(0, 80) : null);
/* An entry with no title and no summary still has words in it. Showing those
 * beats showing "Untitled", which describes the label rather than the day. */
const excerptOf = (e) => (e.preview ?? (e.excerpt ? `${e.excerpt.slice(0, 80)}…` : 'Untitled'));

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* ── Search (§16) ────────────────────────────────────────────────────── */

export function searchBarHtml() {
  return `<div class="dia-searchbar">
    <label class="dia-search">
      <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor"
        stroke-width="1.7" stroke-linecap="round" aria-hidden="true"
        ><circle cx="9" cy="9" r="5"/><path d="m13 13 3.5 3.5"/></svg>
      <input type="search" id="dia-q" value="${esc(dia.query)}"
        placeholder="Search your diary" aria-label="Search your diary">
    </label>
    ${dia.query ? '<button type="button" class="btn btn-ghost btn-sm" id="dia-clear-q">Clear</button>' : ''}
  </div>`;
}

function resultsHtml() {
  const rs = dia.results ?? [];
  if (!rs.length) {
    return `<div class="state dia-empty"><b>Nothing matched “${esc(dia.query)}”</b>
      Try a shorter word, or clear the search.</div>`;
  }
  const today = localToday();
  return `<section class="dia-results" aria-label="Search results">
    <h3 class="dia-side-h">${rs.length} ${rs.length === 1 ? 'day' : 'days'}</h3>
    <ul class="dia-result-list" role="list">
      ${rs.map((r) => `<li><button type="button" class="dia-result"
        data-open="${esc(r.date)}" data-match="${esc(dia.query)}">
        <span class="dia-result-when">${esc(relativeDay(r.date, today))}</span>
        ${r.title ? `<span class="dia-result-title">${esc(r.title)}</span>` : ''}
        <span class="dia-result-text">${esc(r.excerpt)}</span>
      </button></li>`).join('')}
    </ul>
  </section>`;
}

export { esc };
