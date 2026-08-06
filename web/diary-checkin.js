/**
 * The right page — the quick check-in.
 *
 * The half of a day that prose is slow at. A diary you can START in two taps is
 * a diary you open again tomorrow, and the writing on the left page is easier
 * to begin once something is already on the paper.
 *
 * ── The rules it lives by ────────────────────────────────────────────────
 *
 * Nothing here is required, and nothing gates the writing.
 *
 * No native `<select>`. Chips and segmented controls in the app's own language,
 * because a browser dropdown in the middle of a journal page reads as a form
 * and makes the whole spread feel like one.
 *
 * Every option carries a WORD. Nothing depends on reading an emoji or on
 * distinguishing a colour — the same rule the history calendar follows.
 *
 * Two levels, never twenty: pick a broad feeling, and open it only if you want
 * a precise one. "Good" on its own is a complete answer.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Kept in step with `api/src/lib/diary-reflection.ts`. */
export const FEELINGS = [
  { id: 'rough', label: 'Rough', detail: ['drained', 'anxious', 'sad', 'angry', 'numb'] },
  { id: 'low', label: 'Low', detail: ['tired', 'flat', 'worried', 'lonely', 'restless'] },
  { id: 'steady', label: 'Steady', detail: ['calm', 'focused', 'patient', 'ordinary', 'quiet'] },
  { id: 'good', label: 'Good', detail: ['peaceful', 'proud', 'relieved', 'connected', 'curious'] },
  { id: 'great', label: 'Great', detail: ['excited', 'grateful', 'joyful', 'inspired', 'loved'] },
];

export const SOCIAL = [
  { id: 'empty', label: 'Empty' },
  { id: 'low', label: 'Running low' },
  { id: 'ok', label: 'Enough' },
  { id: 'full', label: 'Full' },
];

export const ENERGIES = [
  { id: 'very_low', label: 'Very low' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'very_high', label: 'Very high' },
];

/** One line each. Anything longer belongs in the writing, not in a field. */
export const NOTES = [
  { id: 'highlight', label: 'Highlight', hint: 'The best bit' },
  { id: 'win', label: 'A win', hint: 'However small' },
  { id: 'challenge', label: 'Challenge', hint: 'What was hard' },
  { id: 'gratitude', label: 'Grateful for', hint: 'One thing' },
];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* The chips are `radiogroup`s, not lists of buttons: a screen reader should
 * hear "Energy, Medium, 3 of 5", not five unrelated toggles. Roving tabindex,
 * so each group is one tab stop and the arrow keys move within it. D2.2 folded
 * the old shared `chipRow` helper into `checkinHtml`, where each group now
 * carries its own reading beside the label. */

/* ── The visual responses (D2.2 §10, §11) ────────────────────────────────
 *
 * Three of the six ideas offered, chosen because each one answers a question
 * that words alone answer slowly: how much, how full, and what shape was the
 * day. The other three were declined — a feeling constellation and a page-wide
 * colour wash both compete with the writing across the gutter, and a
 * "one word for today" field is a new searchable concept, which §11 says not to
 * add unless it fits the validated structure. It would have.
 *
 * Every one of these sits BESIDE a text label and never replaces it. A person
 * who cannot see the meter reads "Medium" and loses nothing.
 */

/** B — the energy arc. Five segments, filled to the chosen one. */
function energyMeter(selected) {
  const at = ENERGIES.findIndex((e) => e.id === selected);
  return `<span class="dia-meter" aria-hidden="true">${ENERGIES.map((e, i) =>
    `<span class="dia-meter-seg${at > -1 && i <= at ? ' on' : ''}"
      style="--seg:${i}"></span>`).join('')}</span>`;
}

/** C — the social battery. A cell per level, filled to the chosen one. */
function batteryMeter(selected) {
  const at = SOCIAL.findIndex((s) => s.id === selected);
  return `<span class="dia-batt${at > -1 ? ` is-${SOCIAL[at].id}` : ''}" aria-hidden="true">
    <span class="dia-batt-body">${SOCIAL.map((s, i) =>
    `<span class="dia-batt-cell${at > -1 && i <= at ? ' on' : ''}"></span>`).join('')}</span>
    <span class="dia-batt-cap"></span>
  </span>`;
}

/**
 * A group of the check-in, on its own quiet surface.
 *
 * §10's first ask. Four questions running down one page with nothing between
 * them read as a form; four small surfaces read as four things you may answer.
 */
const group = (id, title, body, extra = '') => `<section class="dia-ci-group"
  data-group-id="${id}" aria-labelledby="dia-ci-${id}-l">
  <div class="dia-ci-grouphead">
    <span class="dia-ci-label" id="dia-ci-${id}-l">${esc(title)}</span>${extra}
  </div>
  ${body}
</section>`;

/**
 * The whole right page.
 *
 * @param {object} entry the saved entry, or null on a blank day
 * @param {object} refl  the live reflection (may be ahead of `entry`)
 * @param {object} streak `{ current, wroteToday }`, or null while it loads
 * @param {string|null} openNote the Moment tile currently expanded
 */
export function checkinHtml(entry, refl, streak, openNote = null) {
  const c = refl?.checkin ?? {};
  const feeling = FEELINGS.find((f) => f.id === c.feeling) ?? null;
  const chosen = new Set(c.feelingDetail ?? []);
  const energy = ENERGIES.find((e) => e.id === (entry?.energy ?? null)) ?? null;
  const social = SOCIAL.find((s) => s.id === c.social) ?? null;

  /* D — the day's colour, scoped to the check-in and nothing else. A wash
   * across the whole page would tint the writing on the other side of the
   * gutter, which is somebody's diary and not a mood indicator. */
  const tone = feeling ? ` data-tone="${feeling.id}"` : '';

  return `<div class="dia-checkin"${tone}>
    <header class="dia-ci-head">
      <h3 class="dia-ci-title">How was it?</h3>
      <p class="dia-ci-sub">A few taps. Nothing here is required.</p>
    </header>

    ${group('feeling', 'Overall feeling', `
      <div class="dia-chips" role="radiogroup" aria-labelledby="dia-ci-feeling-l"
        data-group="feeling">
        ${FEELINGS.map((f, i) => `<button type="button" role="radio" class="dia-chip${
  c.feeling === f.id ? ' on' : ''}" data-choice="${f.id}"
          aria-checked="${c.feeling === f.id}" tabindex="${
  i === Math.max(0, FEELINGS.findIndex((x) => x.id === c.feeling)) ? '0' : '-1'}"
          >${esc(f.label)}</button>`).join('')}
      </div>
      ${feeling ? `<div class="dia-detail" role="group"
        aria-label="More precisely than ${esc(feeling.label)}">
        <p class="dia-detail-lead">More precisely?</p>
        <div class="dia-chips dia-chips-sm" data-group="feelingDetail">
          ${feeling.detail.map((d) => `<button type="button" class="dia-chip dia-chip-sm${
  chosen.has(d) ? ' on' : ''}" data-choice="${d}"
            aria-pressed="${chosen.has(d)}">${esc(cap(d))}</button>`).join('')}
        </div>
      </div>` : ''}`)}

    ${group('energy', 'Energy', `
      <div class="dia-chips dia-chips-sm" role="radiogroup" aria-labelledby="dia-ci-energy-l"
        data-group="energy">
        ${ENERGIES.map((e, i) => `<button type="button" role="radio" class="dia-chip dia-chip-sm${
  energy?.id === e.id ? ' on' : ''}" data-choice="${e.id}"
          aria-checked="${energy?.id === e.id}" tabindex="${
  i === Math.max(0, ENERGIES.findIndex((x) => x.id === energy?.id)) ? '0' : '-1'}"
          >${esc(e.label)}</button>`).join('')}
      </div>`, `${energyMeter(energy?.id)}<span class="dia-ci-read">${
  esc(energy?.label ?? '—')}</span>`)}

    ${group('social', 'Social battery', `
      <div class="dia-chips dia-chips-sm" role="radiogroup" aria-labelledby="dia-ci-social-l"
        data-group="social">
        ${SOCIAL.map((s, i) => `<button type="button" role="radio" class="dia-chip dia-chip-sm${
  social?.id === s.id ? ' on' : ''}" data-choice="${s.id}"
          aria-checked="${social?.id === s.id}" tabindex="${
  i === Math.max(0, SOCIAL.findIndex((x) => x.id === social?.id)) ? '0' : '-1'}"
          >${esc(s.label)}</button>`).join('')}
      </div>`, `${batteryMeter(social?.id)}<span class="dia-ci-read">${
  esc(social?.label ?? '—')}</span>`)}

    ${group('moments', 'Moments', momentsHtml(c, openNote))}
  </div>`;
}

/**
 * E — the Moment tiles.
 *
 * Four labelled tiles, one row of text each once opened. Four always-open text
 * fields cost 262px of a 569px page for something most days leave blank; four
 * tiles cost 96px and say the same thing. A tile that HOLDS an answer shows it,
 * because a collapsed answer is a lost answer.
 */
function momentsHtml(c, openNote) {
  return `<div class="dia-moments">
    ${NOTES.map((n) => {
    const value = c[n.id] ?? '';
    const open = openNote === n.id || !!value;
    return `<div class="dia-moment${open ? ' is-open' : ''}${value ? ' is-filled' : ''}"
      data-moment="${n.id}">
      <button type="button" class="dia-moment-t" data-moment-open="${n.id}"
        aria-expanded="${open}" aria-controls="dia-moment-${n.id}">
        <span class="dia-moment-l">${esc(n.label)}</span>
        ${value ? `<span class="dia-moment-v">${esc(value)}</span>`
    : `<span class="dia-moment-h">${esc(n.hint)}</span>`}
      </button>
      ${open ? `<input class="dia-note-i" id="dia-moment-${n.id}" data-note="${n.id}"
        maxlength="500" value="${esc(value)}" placeholder="${esc(n.hint)}"
        aria-label="${esc(n.label)} — ${esc(n.hint)}">` : ''}
    </div>`;
  }).join('')}
  </div>`;
}

/* The streak used to live here. It moved to Today's Habits panel, as the
 * computed `Write in Diary` system habit — continuity belongs beside the other
 * things you keep up, not at the bottom of the page you are writing on. Diary
 * remains the source of truth for both; Today asks it. */

/* ── The left page's guided prompts ──────────────────────────────────── */

export const PROMPTS = [
  { id: 'stood_out', label: 'What stood out today?' },
  { id: 'felt_good', label: 'What felt good?' },
  { id: 'felt_hard', label: 'What felt difficult?' },
  { id: 'remember', label: 'What do I want to remember?' },
  { id: 'differently', label: 'What would I do differently tomorrow?' },
];

/** How many prompts rest open. The other two are one press away. */
export const PROMPTS_LEAD = 3;

/**
 * The prompts, beneath the free writing.
 *
 * Below the open writing, never above it: a page that opens with five questions
 * is a questionnaire. The questions are there for the days when the blank page
 * is too big, and out of the way on the days it is not.
 *
 * ── Why only three rest open (D2.2 §5) ───────────────────────────────────
 *
 * Five empty fields cost 411px — more than the free writing above them — and
 * that, not the frame, is what pushed the spread far below the fold. Three
 * still reads as "here are some ways in"; the remaining two are one press away
 * and cost nothing until asked for.
 *
 * A prompt that already HAS an answer is never hidden. Collapsing something
 * somebody wrote out of sight is how they lose track of having written it, so
 * an answer below the fold forces the whole set open.
 *
 * Autosizing textareas rather than fixed rows, so an answer never scrolls
 * inside a two-line box while the page around it has room.
 */
export function promptsHtml(refl, open = false) {
  const answers = refl?.prompts ?? {};
  const answered = PROMPTS.filter((p) => answers[p.id]).length;
  const forced = PROMPTS.slice(PROMPTS_LEAD).some((p) => answers[p.id]);
  const showAll = open || forced;
  const shown = showAll ? PROMPTS : PROMPTS.slice(0, PROMPTS_LEAD);
  const hidden = PROMPTS.length - shown.length;

  return `<section class="dia-prompts" aria-labelledby="dia-prompts-h">
    <div class="dia-prompts-head">
      <h3 class="dia-prompts-h" id="dia-prompts-h">If you want a place to start</h3>
      ${answered ? `<span class="dia-prompts-n">${answered} of ${PROMPTS.length}</span>` : ''}
    </div>
    ${shown.map((p) => `<label class="dia-prompt${answers[p.id] ? ' is-filled' : ''}">
      <span class="dia-prompt-q">${esc(p.label)}</span>
      <textarea class="dia-prompt-a" data-prompt="${p.id}" rows="1" maxlength="2000"
        aria-label="${esc(p.label)}">${esc(answers[p.id] ?? '')}</textarea>
    </label>`).join('')}
    ${hidden ? `<button type="button" class="dia-prompts-more" data-prompts-more
      aria-expanded="false">${hidden} more prompt${hidden === 1 ? '' : 's'}</button>` : ''}
  </section>`;
}

/** Grows a textarea to its content. Called on input and once on mount. */
export function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export { esc };
