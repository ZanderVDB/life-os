/**
 * The right page — the quick check-in.
 *
 * ── THE PRODUCT RULE (D2.3) ──────────────────────────────────────────────
 *
 *   LEFT PAGE  = THINGS YOU WRITE.
 *   RIGHT PAGE = THINGS YOU TAP.
 *
 * There is no textarea here, no one-line input, and nothing that opens a
 * keyboard. The whole page can be completed with the thumb in ten to twenty
 * seconds, and if it cannot, something on it is wrong.
 *
 * D2.2 put four editable "Moment" tiles here. They were a second writing
 * surface pretending to be a control: they opened the keyboard, they competed
 * with the writing across the gutter, and they made a fast check-in feel like a
 * form with an essay at the end. They are gone — see `promptsHtml`, which
 * surfaces any that already hold words as guided prompts on the LEFT page,
 * where writing belongs.
 *
 * ── The rules that survive from D2 ───────────────────────────────────────
 *
 * Nothing here is required, and nothing gates the writing.
 *
 * No native `<select>`. Chips and segmented controls in the app's own language,
 * because a browser dropdown in the middle of a journal page reads as a form.
 *
 * Every option carries a WORD. Nothing depends on reading an icon or on
 * distinguishing a colour — the same rule the history calendar follows.
 *
 * Two levels, never twenty: pick a broad feeling, and open it only if you want
 * a precise one. "Good" on its own is a complete answer.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── The vocabularies ────────────────────────────────────────────────────
 *
 * Kept in step with `api/src/lib/diary-reflection.ts`, which validates them.
 * Every scale is ordered least → most, and the only arithmetic anything may do
 * with one is `index / (length - 1)`. See `scaleValue`.
 */

/**
 * The broad feelings.
 *
 * `face` is a five-step expression drawn from ONE system (D2.3 §5): the same
 * 20×20 grid, the same 1.7 stroke, the same eyes, and only the mouth and the
 * brows change. Not emoji — an emoji set is somebody else's drawing, renders
 * differently on every platform, and would be the one thing on this page that
 * does not match the rest of it. History reuses this exact vocabulary.
 *
 * The icon supports the label; the label is always present.
 */
export const FEELINGS = [
  {
    id: 'rough',
    label: 'Rough',
    detail: ['drained', 'anxious', 'sad', 'angry', 'numb'],
    face: '<path d="M6.6 7.4 8.8 8.6M13.4 7.4 11.2 8.6"/><path d="M7 14.2q3-2.6 6 0"/>',
  },
  {
    id: 'low',
    label: 'Low',
    detail: ['tired', 'flat', 'worried', 'lonely', 'restless'],
    face: '<path d="M6.8 8.2h2.1M11.1 8.2h2.1"/><path d="M7.2 13.6q2.8-1.5 5.6 0"/>',
  },
  {
    id: 'steady',
    label: 'Steady',
    detail: ['calm', 'focused', 'patient', 'ordinary', 'quiet'],
    face: '<circle cx="7.6" cy="8.4" r=".9" fill="currentColor" stroke="none"/><circle cx="12.4" cy="8.4" r=".9" fill="currentColor" stroke="none"/><path d="M7.2 12.9h5.6"/>',
  },
  {
    id: 'good',
    label: 'Good',
    detail: ['peaceful', 'proud', 'relieved', 'connected', 'curious'],
    face: '<circle cx="7.6" cy="8.2" r=".9" fill="currentColor" stroke="none"/><circle cx="12.4" cy="8.2" r=".9" fill="currentColor" stroke="none"/><path d="M7.1 12.1q2.9 2.4 5.8 0"/>',
  },
  {
    id: 'great',
    label: 'Great',
    detail: ['excited', 'grateful', 'joyful', 'inspired', 'loved'],
    face: '<path d="M6.5 8.5q1.1-1.5 2.2 0M11.3 8.5q1.1-1.5 2.2 0"/><path d="M6.7 11.6q3.3 3.4 6.6 0"/>',
  },
];

/**
 * FIVE states from D2.4 §4.
 *
 * Four made this the odd one out beside Overall Feeling and Energy, and it
 * forced an uneven battery — four cells cannot be evenly spaced against a
 * five-step sibling. `good` is the state that was missing: between "just
 * enough to get through" and "plenty".
 *
 * The chip says `Low`; the accessible name and every tooltip say
 * `Running low`. Five words across a 286px control need to be short, and
 * `long` is how nothing is lost by shortening one.
 */
export const SOCIAL = [
  { id: 'empty', label: 'Empty' },
  { id: 'low', label: 'Low', long: 'Running low' },
  { id: 'ok', label: 'Enough' },
  { id: 'good', label: 'Good' },
  { id: 'full', label: 'Full' },
];

export const ENERGIES = [
  { id: 'very_low', label: 'Lowest', long: 'Very low' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'very_high', label: 'Highest', long: 'Very high' },
];

/* ── The passive daily check-ins (§7, §8) ────────────────────────────────
 *
 * THEY DESCRIBE A DAY. THEY ARE NOT HABITS.
 *
 *   a diary check-in  = an observation of how the day went
 *   a habit           = a behaviour you intend to repeat, and chose to track
 *
 * `Movement = Very active` does not complete a Gym habit. `Nourishment =
 * Great` does not create an Eating Well habit. Nothing here writes a
 * `habit_entries` row or touches a habit total.
 *
 * Gym is deliberately absent: it is an intentional activity and belongs to
 * Habits. Movement is universal and descriptive, which is why it is here.
 */
export const NOURISHMENT = [
  { id: 'poor', label: 'Poor' },
  { id: 'okay', label: 'Okay' },
  { id: 'good', label: 'Good' },
  { id: 'great', label: 'Great' },
];
/* The wording is shorter than §7's draft, and measurement is why (§7 allows
 * exactly this). "Barely moved" and "Some time" forced their rows onto two
 * lines, which cost the right page 76px each and pushed the whole spread below
 * the fold. The `long` label is what a screen reader and the History tooltip
 * say, so nothing is lost — only the chip is short. */
export const MOVEMENT = [
  { id: 'barely', label: 'Barely', long: 'Barely moved' },
  { id: 'light', label: 'Light' },
  { id: 'active', label: 'Active' },
  { id: 'very_active', label: 'A lot', long: 'Very active' },
];
export const OUTSIDE = [
  { id: 'none', label: 'None' },
  { id: 'little', label: 'A bit', long: 'A little' },
  { id: 'some', label: 'Some', long: 'Some time' },
  { id: 'plenty', label: 'Plenty' },
];
/**
 * FOUR states from D2.4 §8, like every other Daily Rhythm row.
 *
 * `Rested` is the top state rather than `Great`, deliberately: it names the
 * outcome you actually notice the next morning rather than grading the night.
 * "Great sleep" and "I feel rested" are the same answer, and only one of them
 * is a thing you can report without thinking about it.
 *
 * `great` is still accepted on the way in and normalised to `rested` by the
 * server — see `SLEEP_ALIAS` in `diary-reflection.ts`.
 */
export const SLEEP = [
  { id: 'rough', label: 'Rough' },
  { id: 'poor', label: 'Poor' },
  { id: 'fine', label: 'Fine' },
  { id: 'rested', label: 'Rested' },
];

/** Retired ids, so an old day still draws. Read only; never written. */
export const SLEEP_ALIAS = { great: 'rested' };

/** The four passive rows, in the order they are asked. */
export const PASSIVE = [
  { key: 'nourishment', label: 'Nourishment', scale: NOURISHMENT, icon: 'bowl' },
  { key: 'movement', label: 'Movement', scale: MOVEMENT, icon: 'stride' },
  { key: 'outside', label: 'Outside', scale: OUTSIDE, icon: 'sun' },
  { key: 'sleep', label: 'Sleep', scale: SLEEP, icon: 'moon' },
];

/**
 * A position on an ordered scale, 0–1.
 *
 * The ONLY arithmetic these scales permit. It is a position, never a score:
 * §10 forbids a total, a percentage or any judgement about how the day went.
 * Two dimensions are never summed and never averaged.
 */
export const scaleValue = (scale, id) => {
  if (!id) return null;
  const at = scale.findIndex((o) => o.id === id);
  if (at < 0) return null;
  return scale.length > 1 ? at / (scale.length - 1) : 1;
};

const labelOf = (scale, id) => scale.find((o) => o.id === id)?.label ?? null;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ── Icons ───────────────────────────────────────────────────────────────
 * One system: 20×20, 1.7 stroke, round caps, no fill except deliberate dots.
 */
const face = (f, size = 20) => `<svg class="dia-face" viewBox="0 0 20 20"
  width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="10" cy="10" r="8.1"/>${f.face}</svg>`;

const GLYPH = {
  bowl: '<path d="M3.4 9.5h13.2a6.6 6.6 0 0 1-13.2 0Z"/><path d="M7 6.4q.8-1.4 0-2.6M10 6.4q.8-1.4 0-2.6M13 6.4q.8-1.4 0-2.6"/>',
  stride: '<circle cx="12.4" cy="3.9" r="1.5"/><path d="M11.4 7.2 8.6 9.4l1.6 2.6-1 4.6M11.4 7.2l2.6 1.5.9 3M10.2 12 6.6 13"/>',
  sun: '<circle cx="10" cy="10" r="3.6"/><path d="M10 2.2v1.9M10 15.9v1.9M2.2 10h1.9M15.9 10h1.9M4.5 4.5l1.35 1.35M14.15 14.15l1.35 1.35M15.5 4.5l-1.35 1.35M5.85 14.15 4.5 15.5"/>',
  moon: '<path d="M16.2 12.4A6.9 6.9 0 0 1 7.6 3.8a6.9 6.9 0 1 0 8.6 8.6Z"/>',
};
const glyph = (name, size = 14) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}"
  fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true">${GLYPH[name]}</svg>`;

/* ── The visual responses ────────────────────────────────────────────────
 *
 * Each sits BESIDE a text label and never replaces it. Somebody who cannot see
 * the meter reads "Medium" and loses nothing.
 */

/**
 * The energy signal. Five bars rising left to right, filled to the choice.
 *
 * ── The geometry (D2.4 §13) ──────────────────────────────────────────────
 *
 * `height: calc(6px + var(--seg) * 2px)` gave 6, 8, 10, 12, 14 — a 33% jump
 * from bar 1 to bar 2 and only 17% from bar 4 to 5, so at History's size the
 * first gap read as a mistake. The rise is now LINEAR in the bar's own index
 * over a stated box:
 *
 *     h(i) = MIN + (MAX - MIN) * i / 4
 *
 * with equal width and equal gap, so every step is the same number of pixels
 * and the icon box is fixed however many bars are lit. `--n` is the bar's
 * index and `--bars` the count; the arithmetic lives in one CSS rule, used at
 * both sizes.
 */
export function energyMeter(selected, cls = '') {
  const at = ENERGIES.findIndex((e) => e.id === selected);
  return `<span class="dia-meter ${cls}" aria-hidden="true"
    style="--bars:${ENERGIES.length}">${ENERGIES.map((e, i) =>
    `<span class="dia-meter-seg${at > -1 && i <= at ? ' on' : ''}"
      style="--n:${i}"></span>`).join('')}</span>`;
}

/**
 * The social battery.
 *
 * ── The geometry (D2.3 §6) ───────────────────────────────────────────────
 *
 * D2.2 drew one cell per level and filled up to the choice, which made the
 * four states 1/4, 2/4, 3/4 and 4/4 of the cells — but the CELLS were the
 * units, so "Running low" and "Enough" differed by one cell of a four-cell row
 * and read as almost the same amount. Worse, the lit region's width depended on
 * how many gaps fell inside it, so the middle two states were not evenly
 * spaced: two cells plus one gap is not twice one cell.
 *
 * Now the shell holds ONE continuous fill whose width is a percentage of the
 * inner track, and the percentages are exactly `index / (length - 1)`.
 *
 * D2.4 §4 made the scale FIVE states, which makes the arithmetic land on
 * quarters — the clean progression the brief asked for:
 *
 *   Empty 0%   Running low 25%   Enough 50%   Good 75%   Full 100%
 *
 * The outer shell, the internal padding and the cap are identical in every
 * state — only the fill's width changes — so the progression is monotonic by
 * construction and no state can be accidentally wider than its neighbour.
 * The tick marks are decoration drawn on top at the same fractions.
 *
 * ONE component, at two sizes: the right page and History share this function
 * and differ only by a class (§14). There is no second approximation.
 */
export function batteryMeter(selected, cls = '') {
  const v = scaleValue(SOCIAL, selected);
  const pct = v === null ? 0 : Math.round(v * 100);
  return `<span class="dia-batt ${cls}${selected ? ` is-${selected}` : ''}" aria-hidden="true">
    <span class="dia-batt-body">
      <span class="dia-batt-fill" style="width:${pct}%"></span>
      ${SOCIAL.slice(1, -1).map((_, i) =>
    `<span class="dia-batt-tick" style="left:${Math.round(((i + 1) / (SOCIAL.length - 1)) * 100)}%"></span>`).join('')}
    </span>
    <span class="dia-batt-cap"></span>
  </span>`;
}

/**
 * The per-option preview inside a core chip.
 *
 * ── Why it exists (D2.4 §3) ──────────────────────────────────────────────
 *
 * §3 asks the three core rows to be one designed system with consistent
 * height. Overall Feeling's chips are face-over-word; Energy's and Social
 * Battery's were word-only, so the rows could only match by padding text out
 * to 50px, which reads as a mistake rather than a system.
 *
 * Instead every core option previews ITSELF, with the same component that
 * shows the answer afterwards: the third Energy chip shows three bars, the
 * fourth Social chip shows a 75% battery. The rows become structurally
 * identical — indicator over word, five across — and each chip now says what
 * choosing it means before you choose it, which the word alone did not.
 */
function optionPreview(group, o) {
  if (group === 'feeling') return face(o, 19);
  if (group === 'energy') return energyMeter(o.id, 'dia-meter-opt');
  if (group === 'social') return batteryMeter(o.id, 'dia-batt-opt');
  return '';
}

/* The Day Pulse was REMOVED in D2.4 §6.
 *
 * Three bars derived from Overall Feeling, Energy and Social Battery — sitting
 * directly above Overall Feeling, Energy and Social Battery. It restated the
 * three controls beneath it and added a line of copy explaining that it was not
 * a score, which is a good sign a component is not earning its place: nothing
 * that says what it is for needs to.
 *
 * The three controls now preview themselves (see `optionPreview`), so the
 * information the pulse carried is on the controls that own it, and the page
 * has one fewer thing to read. Nothing was kept merely because it was built.
 */

/* ── Groups ──────────────────────────────────────────────────────────────
 *
 * Four questions running down one page with nothing between them read as a
 * form; small quiet surfaces read as things you MAY answer, which is what they
 * are. The inset is barely there — this sits on paper, beside somebody
 * writing, and a card with a real edge would compete with the writing.
 */
const group = (id, title, body, extra = '') => `<section class="dia-ci-group"
  data-group-id="${id}" aria-labelledby="dia-ci-${id}-l">
  <div class="dia-ci-grouphead">
    <span class="dia-ci-label" id="dia-ci-${id}-l">${esc(title)}</span>${extra}
  </div>
  ${body}
</section>`;

/**
 * A row of chips behaving as one control.
 *
 * `radiogroup`, so a screen reader hears "Energy, Medium, 3 of 5" rather than
 * five unrelated toggles. Roving tabindex, so the group is one tab stop and the
 * arrow keys move within it.
 *
 * ── ONE CONTROL GRID (D2.4 §5) ───────────────────────────────────────────
 *
 * `kind` selects a grid, never a set of margins. §5 forbids correcting each row
 * independently, and it was right to: before D2.4 the Social Battery's chips
 * were `flex-wrap` with intrinsic widths, so its five words came out
 * 53 / 84 / 60 / 38px while Energy's were a uniform 53.9. Two rows of the same
 * system disagreeing about their own column widths.
 *
 *   `core`    5 equal columns, indicator over word — Feeling, Energy, Social
 *   `rhythm`  4 equal columns, word only — the Daily Rhythm rows
 *   `detail`  intrinsic, wrapping — the precise feelings, which are a tag list
 *             rather than a scale and must not pretend to be one
 *
 * The grid is `repeat(n, minmax(0, 1fr))`, so every option in a row is exactly
 * the same width by construction and the row starts and ends where its
 * neighbours do. No row can terminate early.
 */
function chips(name, options, selected, kind = 'core') {
  const at = Math.max(0, options.findIndex((o) => o.id === selected));
  return `<div class="dia-chips dia-chips-${kind}" style="--opts:${options.length}"
    role="radiogroup" aria-labelledby="dia-ci-${name}-l" data-group="${name}">
    ${options.map((o, i) => `<button type="button" role="radio" class="dia-chip${
  selected === o.id ? ' on' : ''}" data-choice="${o.id}"
      aria-checked="${selected === o.id}" tabindex="${i === at ? '0' : '-1'}"
      ${o.long ? `aria-label="${esc(o.long)}" title="${esc(o.long)}"` : ''}
      >${kind === 'core' ? `<span class="dia-chip-i">${optionPreview(name, o)}</span>` : ''
}<span class="dia-chip-t">${esc(o.label)}</span></button>`).join('')}
  </div>`;
}

/**
 * The whole right page.
 *
 * @param {object} entry the saved entry, or null on a blank day
 * @param {object} refl  the live reflection (may be ahead of `entry`)
 *
 * The streak is deliberately not a parameter. It moved to Today's habits panel
 * in D2.1 and stays there: this page says how the day WAS, never how many in a
 * row — a running total on the page you are writing on turns a diary into
 * something you perform for.
 */
export function checkinHtml(entry, refl) {
  const c = refl?.checkin ?? {};
  const feeling = FEELINGS.find((f) => f.id === c.feeling) ?? null;
  const chosen = new Set(c.feelingDetail ?? []);
  const energy = entry?.energy ?? null;

  /* The day's colour, scoped to the check-in and no further. A wash across the
   * whole page would tint the writing on the other side of the gutter, which
   * is somebody's diary and not a mood indicator. */
  const tone = feeling ? ` data-tone="${feeling.id}"` : '';

  return `<div class="dia-checkin"${tone}>
    <header class="dia-ci-head">
      <h3 class="dia-ci-title">How was it?</h3>
      <p class="dia-ci-sub">A few taps. Nothing here is required.</p>
    </header>

    ${group('feeling', 'Overall feeling', `
      ${chips('feeling', FEELINGS, c.feeling)}
      ${feeling ? `<div class="dia-detail" role="group"
        aria-label="More precisely than ${esc(feeling.label)}">
        <p class="dia-detail-lead">More precisely?</p>
        <div class="dia-chips dia-chips-detail" data-group="feelingDetail">
          ${feeling.detail.map((d) => `<button type="button" class="dia-chip${
  chosen.has(d) ? ' on' : ''}" data-choice="${d}"
            aria-pressed="${chosen.has(d)}"><span class="dia-chip-t"
            >${esc(cap(d))}</span></button>`).join('')}
        </div>
      </div>` : ''}`,
    `<span class="dia-ci-read">${esc(feeling?.label ?? '—')}</span>`)}

    ${group('energy', 'Energy', chips('energy', ENERGIES, energy),
    `<span class="dia-ci-read">${esc(labelOf(ENERGIES, energy) ?? '—')}</span>`)}

    ${group('social', 'Social battery', chips('social', SOCIAL, c.social),
    `<span class="dia-ci-read">${esc(labelOf(SOCIAL, c.social) ?? '—')}</span>`)}

    ${group('rhythm', 'Day rhythm', `<div class="dia-rhythm">
      ${PASSIVE.map((p) => `<div class="dia-rh-row" data-rhythm="${p.key}">
        <span class="dia-rh-l" id="dia-ci-${p.key}-l">
          <span class="dia-rh-i" aria-hidden="true">${glyph(p.icon)}</span
          ><span class="dia-rh-t">${esc(p.label)}</span></span>
        ${chips(p.key, p.scale, c[p.key], 'rhythm')}
      </div>`).join('')}
    </div>`)}
  </div>`;
}

/* The four Moment TEXT fields left this page in D2.3. The right page is
 * tap-only: no textarea, no input, nothing that opens a keyboard. Anything
 * already written into one is surfaced by `promptsHtml` on the left page,
 * where writing belongs. Nothing creates a new one. */

/* ── The left page's guided prompts ──────────────────────────────────── */

export const PROMPTS = [
  { id: 'stood_out', label: 'What stood out today?' },
  { id: 'felt_good', label: 'What felt good?' },
  { id: 'felt_hard', label: 'What felt difficult?' },
  { id: 'remember', label: 'What do I want to remember?' },
  { id: 'differently', label: 'What would I do differently tomorrow?' },
];

/**
 * The four retired Moment lines, as prompts.
 *
 * Offered ONLY on a day that already holds one. D2.3 §2 says these belong on
 * the left page if they are kept at all, and §3 forbids them on the right —
 * but the five prompts above already cover the same ground, so a fresh day is
 * not given nine questions. What an old day holds stays editable, in one
 * place, and keeps its storage key so nothing has to be migrated.
 */
export const MOMENT_PROMPTS = [
  { id: 'highlight', label: 'Highlight', store: 'checkin' },
  { id: 'win', label: 'A win', store: 'checkin' },
  { id: 'challenge', label: 'Challenge', store: 'checkin' },
  { id: 'gratitude', label: 'Grateful for', store: 'checkin' },
];

/* PROGRESSIVE DISCLOSURE REMOVED in D2.4 §7.
 *
 * D2.2 showed three and hid two behind `+ 2 more prompts`, because five empty
 * fields cost 411px on a page whose editor was also absorbing every spare
 * pixel. D2.3 gave the editor a seven-line floor and stopped it growing into
 * the slack, which returned that space — so the reason for hiding two prompts
 * no longer exists, and a control that exists only to undo a constraint that
 * has gone is worse than the fields it hides.
 *
 * All five show. The measurement that justifies it is in
 * `diary-v2-responsive.md`; if it ever stops being true, the fields get more
 * compact before the disclosure comes back. */

/** Every prompt this day should offer, in order, with where each is stored. */
export function promptsFor(refl) {
  const c = refl?.checkin ?? {};
  return [
    ...PROMPTS.map((p) => ({ ...p, store: 'prompts' })),
    ...MOMENT_PROMPTS.filter((m) => c[m.id]),
  ];
}

const valueOf = (refl, p) => (p.store === 'checkin'
  ? refl?.checkin?.[p.id] : refl?.prompts?.[p.id]) ?? '';

/**
 * The prompts, beneath the free writing.
 *
 * Below the open writing, never above it: a page that opens with five questions
 * is a questionnaire. The questions are there for the days when the blank page
 * is too big, and out of the way on the days it is not.
 *
 * Three rest open. Five empty fields cost more vertical space than the writing
 * above them, and that is the wrong ratio on a page whose point is the writing.
 * A prompt that already HAS an answer is never hidden — collapsing something
 * somebody wrote out of sight is how they lose track of having written it.
 */
export function promptsHtml(refl) {
  const all = promptsFor(refl);
  const answered = all.filter((p) => valueOf(refl, p)).length;

  return `<section class="dia-prompts" aria-labelledby="dia-prompts-h">
    <div class="dia-prompts-head">
      <h3 class="dia-prompts-h" id="dia-prompts-h">If you want a place to start</h3>
      ${answered ? `<span class="dia-prompts-n">${answered} of ${all.length}</span>` : ''}
    </div>
    ${all.map((p) => {
    const v = valueOf(refl, p);
    return `<label class="dia-prompt${v ? ' is-filled' : ''}">
      <span class="dia-prompt-q">${esc(p.label)}</span>
      <textarea class="dia-prompt-a" data-prompt="${p.id}" data-store="${p.store}"
        rows="1" maxlength="2000" aria-label="${esc(p.label)}">${esc(v)}</textarea>
    </label>`;
  }).join('')}
  </section>`;
}

/** Grows a textarea to its content. Called on input and once on mount. */
export function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export { esc, face, glyph, labelOf, cap };
