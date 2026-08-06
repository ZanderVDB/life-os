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

/**
 * A row of chips behaving as one control.
 *
 * `radiogroup`, not a list of buttons: a screen reader should hear "Feeling,
 * Good, 4 of 5", not five unrelated toggles. Roving tabindex, so the group is
 * one tab stop and the arrow keys move within it.
 */
function chipRow(name, label, options, selected, { size = '' } = {}) {
  const activeIdx = Math.max(0, options.findIndex((o) => o.id === selected));
  return `<div class="dia-ci-row">
    <span class="dia-ci-label" id="dia-ci-${name}-l">${esc(label)}</span>
    <div class="dia-chips ${size}" role="radiogroup" aria-labelledby="dia-ci-${name}-l"
      data-group="${name}">
      ${options.map((o, i) => `<button type="button" role="radio" class="dia-chip${
  selected === o.id ? ' on' : ''}" data-choice="${o.id}"
        aria-checked="${selected === o.id}" tabindex="${i === activeIdx ? '0' : '-1'}"
        >${esc(o.label)}</button>`).join('')}
    </div>
  </div>`;
}

/**
 * The whole right page.
 *
 * @param {object} entry the saved entry, or null on a blank day
 * @param {object} refl  the live reflection (may be ahead of `entry`)
 * @param {object} streak `{ current, wroteToday }`, or null while it loads
 */
export function checkinHtml(entry, refl, streak) {
  const c = refl?.checkin ?? {};
  const feeling = FEELINGS.find((f) => f.id === c.feeling) ?? null;
  const chosen = new Set(c.feelingDetail ?? []);

  return `<div class="dia-checkin">
    <header class="dia-ci-head">
      <h3 class="dia-ci-title">How was it?</h3>
      <p class="dia-ci-sub">A few taps. Nothing here is required.</p>
    </header>

    ${chipRow('feeling', 'Overall', FEELINGS, c.feeling)}

    ${feeling ? `<div class="dia-detail" role="group"
      aria-label="More precisely than ${esc(feeling.label)}">
      <p class="dia-detail-lead">More precisely?</p>
      <div class="dia-chips dia-chips-sm" data-group="feelingDetail">
        ${feeling.detail.map((d) => `<button type="button" class="dia-chip dia-chip-sm${
  chosen.has(d) ? ' on' : ''}" data-choice="${d}"
          aria-pressed="${chosen.has(d)}">${esc(cap(d))}</button>`).join('')}
      </div>
    </div>` : ''}

    ${chipRow('energy', 'Energy', ENERGIES, entry?.energy ?? null, { size: 'dia-chips-sm' })}
    ${chipRow('social', 'Social battery', SOCIAL, c.social, { size: 'dia-chips-sm' })}

    <div class="dia-notes">
      ${NOTES.map((n) => `<label class="dia-note">
        <span class="dia-note-l">${esc(n.label)}</span>
        <input class="dia-note-i" data-note="${n.id}" maxlength="500"
          value="${esc(c[n.id] ?? '')}" placeholder="${esc(n.hint)}"
          aria-label="${esc(n.label)} — ${esc(n.hint)}">
      </label>`).join('')}
    </div>

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

/**
 * The prompts, beneath the free writing.
 *
 * Below the open writing, never above it: a page that opens with five questions
 * is a questionnaire. The questions are there for the days when the blank page
 * is too big, and out of the way on the days it is not.
 *
 * Autosizing textareas rather than fixed rows, so an answer never scrolls
 * inside a two-line box while the page around it has room.
 */
export function promptsHtml(refl) {
  const answers = refl?.prompts ?? {};
  const answered = PROMPTS.filter((p) => answers[p.id]).length;
  return `<section class="dia-prompts" aria-labelledby="dia-prompts-h">
    <div class="dia-prompts-head">
      <h3 class="dia-prompts-h" id="dia-prompts-h">If you want a place to start</h3>
      ${answered ? `<span class="dia-prompts-n">${answered} of ${PROMPTS.length}</span>` : ''}
    </div>
    ${PROMPTS.map((p) => `<label class="dia-prompt${answers[p.id] ? ' is-filled' : ''}">
      <span class="dia-prompt-q">${esc(p.label)}</span>
      <textarea class="dia-prompt-a" data-prompt="${p.id}" rows="1" maxlength="2000"
        aria-label="${esc(p.label)}">${esc(answers[p.id] ?? '')}</textarea>
    </label>`).join('')}
  </section>`;
}

/** Grows a textarea to its content. Called on input and once on mount. */
export function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export { esc };
