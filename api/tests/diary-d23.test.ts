/**
 * Phase D2.3 — the tap-only right page, the daily pulse, History snapshots,
 * and two authenticated regressions.
 *
 * The product rule this phase locks:
 *
 *     LEFT PAGE  = THINGS YOU WRITE.
 *     RIGHT PAGE = THINGS YOU TAP.
 *
 * Both regressions had the same shape as D2.2's, one layer down: something
 * arriving late was allowed to overrule a decision already made. A load for a
 * day already left reinstated that day. A dash that was exactly one full turn
 * met its own start and left a seam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import {
  validateReflection, scaleValue, PASSIVE, PASSIVE_KEYS,
  NOURISHMENT, MOVEMENT, OUTSIDE, SLEEP, SOCIAL, FEELINGS,
} from '../src/lib/diary-reflection.js';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const app = code(read('app.js'));
const diaView = code(read('diary-view.js'));
const diaApi = code(read('diary-api.js'));
const diaSave = code(read('diary-save.js'));
const checkin = code(read('diary-checkin.js'));
const entryJs = code(read('diary-entry.js'));
const historyJs = code(read('diary-history.js'));
/* index.html + app.css: the stylesheet moved out of the page so the home
 * page is 5KB instead of 350KB. These assertions are about the app's CSS,
 * which is still the app's CSS — it just has its own file now. */
const html = read('index.html') + read('app.css');

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = { authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'd23@example.com' };

async function setup() {
  const { db } = await freshDb();
  const server = buildApp(db, env);
  await server.ready();
  const me = (await server.inject({ method: 'GET', url: '/api/v1/me', headers: auth })).json();
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await server.inject({
      method: method as any, url, headers: auth, payload: payload as any,
    });
    return { status: r.statusCode, body: r.json() };
  };
  return { db, ws: me.workspace.id, call };
}

const doc = (text: string) =>
  ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

/* ══ §1 THE LEFT PAGE ══════════════════════════════════════════════════ */

test('the writing region is six to eight ruled lines, and it is a FLOOR', () => {
  /* D2.2 gave the editor `flex:1 0 auto`, so it swallowed every spare pixel
   * and a blank day opened with roughly half a page of empty paper before the
   * prompts appeared. "Enough space to begin writing" had become "nothing else
   * is visible". */
  assert.match(html, /\.dia-editor\{flex:0 0 auto\}/);
  const m = /\.dia-editor\{outline:0;min-height:(\d+)px/.exec(html);
  assert.ok(m, 'the editor has no stated writing region');
  const px = Number(m![1]);
  assert.ok(px >= 180 && px <= 240, `${px}px is not 6–8 ruled lines`);
  assert.equal(px % 30, 0, 'the writing region is off the 30px block grid');
  // The spare room sits BELOW the prompts, so they stay where the eye finds them.
  assert.match(html, /\.dia-left \.dia-scroll::after\{content:'';flex:1 1 auto/);
});

test('the prompts follow the writing, and the page still grows and shrinks', () => {
  // The prompts are a SIBLING of the editor inside the same column, so they
  // move down with it and back up when writing is deleted. Nothing measures.
  const spread = entryJs.slice(entryJs.indexOf('export function spreadHtml'));
  assert.ok(spread.indexOf('dia-editor') < spread.indexOf('promptsHtml'),
    'the prompts come before the open writing');
  assert.match(html, /\.dia-prompts\{[^}]*flex:0 0 auto/);
  assert.match(html, /\.dia-book\.bk-spread\{aspect-ratio:auto;height:auto;align-items:stretch\}/);
});

/* ══ §2, §3 TAP ONLY ═══════════════════════════════════════════════════ */

test('the right page contains nothing that opens a keyboard', () => {
  const body = checkin.slice(checkin.indexOf('export function checkinHtml'),
    checkin.indexOf('export const PROMPTS'));
  assert.doesNotMatch(body, /<textarea|<input|contenteditable/,
    'the right page renders something that opens a keyboard');
  assert.doesNotMatch(checkin, /data-note|dia-moment|momentsHtml/);
  assert.doesNotMatch(html, /\.dia-moments\{|\.dia-moment-t\{|\.dia-note-i\{/);
  // Nothing wires one either.
  const wire = diaView.slice(diaView.indexOf('function wireCheckin'));
  assert.doesNotMatch(wire.slice(0, 1400), /data-note|data-moment-open/);
});

test('the four Moment lines moved to the LEFT page, and only when written', () => {
  /* §2: if they are kept at all they belong on the left. The five standing
   * prompts already cover the same ground, so a fresh day is not given nine
   * questions — a retired line appears only on a day that already holds one,
   * and keeps its original storage key so nothing has to be migrated. */
  assert.match(checkin, /export const MOMENT_PROMPTS = \[/);
  const fn = checkin.slice(checkin.indexOf('export function promptsFor'));
  assert.match(fn.slice(0, 700), /MOMENT_PROMPTS\.filter\(\(m\) => c\[m\.id\]\)/);
  assert.match(checkin, /store: 'checkin'/);
  assert.match(diaView, /function setPrompt\(id, value, store = 'prompts'\)/);
  const set = diaView.slice(diaView.indexOf('function setPrompt'));
  assert.match(set.slice(0, 800), /if \(store === 'checkin'\)/);
  // The grammar still accepts them, so an old day is never silently emptied.
  const kept = validateReflection({
    checkin: { highlight: 'The long way home', win: 'Finished it' },
  });
  assert.equal(kept.checkin?.highlight, 'The long way home');
  assert.equal(kept.checkin?.win, 'Finished it');
});

/* ══ §5 THE FEELING ICON ═══════════════════════════════════════════════ */

test('every broad feeling has a face from ONE system, beside its word', () => {
  for (const f of FEELINGS) {
    assert.match(checkin, new RegExp(`id: '${f.id}'`), `${f.id} is missing`);
  }
  const list = checkin.slice(checkin.indexOf('export const FEELINGS'),
    checkin.indexOf('export const SOCIAL'));
  assert.equal((list.match(/face: '/g) ?? []).length, 5, 'a feeling has no face');
  // One system: the same 20x20 grid and the same stroke for all five, and the
  // eyes/mouth are the only difference. Not emoji — an emoji set is somebody
  // else's drawing and renders differently on every platform.
  assert.match(checkin, /const face = \(f, size = 20\)/);
  assert.match(checkin, /viewBox="0 0 20 20"[\s\S]{0,140}stroke-width="1\.7"/);
  assert.doesNotMatch(list, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji crept in');
  /* D2.4 §3: every CORE option previews itself with the same component that
   * shows the answer afterwards, so the three rows are structurally identical
   * — indicator over word — and a chip says what choosing it means before you
   * choose it. The label is still always there. */
  assert.match(checkin, /function optionPreview\(group, o\)/);
  assert.match(checkin, /if \(group === 'feeling'\) return face\(o, 19\)/);
  const fn = checkin.slice(checkin.indexOf('function chips('));
  assert.match(fn.slice(0, 1400), /optionPreview\(name, o\)/);
  assert.match(fn.slice(0, 1400), /<span class="dia-chip-t"/);
  // History reuses the same component rather than drawing its own.
  assert.match(historyJs, /face\(feeling, 16\)/);
});

/* ══ §6 THE SOCIAL BATTERY GEOMETRY ════════════════════════════════════ */

test('the battery is FIVE states on a fixed shell, evenly stepped', () => {
  /* D2.2 lit one CELL per level, so the lit width depended on how many
   * inter-cell gaps fell inside it. D2.3 replaced that with one continuous
   * fill. D2.4 §4 made the scale FIVE states, which is what makes the
   * arithmetic land on clean quarters and puts this row in step with Overall
   * Feeling and Energy:
   *
   *   Empty 0%   Running low 25%   Enough 50%   Good 75%   Full 100%
   *
   * Measured in a browser: shell 30x13 in every state, and History's cells
   * showed 0% / 25% / 50% from the same component at the `-xs` size. */
  assert.equal(SOCIAL.length, 5, 'the social battery lost a state');
  assert.deepEqual(SOCIAL.map((s) => Math.round(scaleValue(SOCIAL, s.id)! * 100)),
    [0, 25, 50, 75, 100]);
  const steps = SOCIAL.map((s) => scaleValue(SOCIAL, s.id)!);
  const deltas = steps.slice(1).map((v, i) => v - steps[i]!);
  assert.ok(Math.max(...deltas) - Math.min(...deltas) < 1e-9, 'the steps are uneven');
  assert.doesNotMatch(checkin, /dia-batt-cell/, 'the per-cell battery is back');
  assert.match(checkin, /class="dia-batt-fill" style="width:\$\{pct\}%"/);
  // ONE shell, at three sizes, driven by variables rather than three rules.
  assert.match(html, /\.dia-batt\{--b-w:30px; --b-h:13px; --b-pad:2px;/);
  assert.match(html, /\.dia-batt-opt\{--b-w:26px/);
  assert.match(html, /\.dia-batt-xs\{--b-w:18px/);
  const fn = checkin.slice(checkin.indexOf('export function batteryMeter'));
  assert.match(fn.slice(0, 900), /scaleValue\(SOCIAL, selected\)/);
});

/* ══ §7, §8 THE PASSIVE DIMENSIONS ═════════════════════════════════════ */

test('the four passive dimensions are FOUR-option scales, least to most', () => {
  assert.deepEqual(PASSIVE_KEYS, ['nourishment', 'movement', 'outside', 'sleep']);
  /* D2.4 §8: exactly four options in EVERY Daily Rhythm row. Sleep had five,
   * which made it the one row that could not share the others' grid. `Rested`
   * is now the top state rather than `Great` — it names the outcome you notice
   * the next morning rather than grading the night, and `great` is still
   * accepted on the way in and normalised, so no existing day is emptied. */
  for (const k of PASSIVE_KEYS) {
    assert.equal(PASSIVE[k].length, 4, `${k} does not have four options`);
  }
  for (const k of PASSIVE_KEYS) {
    const scale = PASSIVE[k];
    assert.equal(scaleValue(scale, scale[0]!.id), 0, `${k} does not start at 0`);
    assert.equal(scaleValue(scale, scale[scale.length - 1]!.id), 1, `${k} does not end at 1`);
    const vals = scale.map((o) => scaleValue(scale, o.id)!);
    assert.ok(vals.every((v, i) => i === 0 || v > vals[i - 1]!), `${k} is not monotonic`);
    // Four options put every step on an exact third.
    assert.deepEqual(vals.map((v) => Math.round(v * 100)), [0, 33, 67, 100]);
  }
  assert.equal(scaleValue(SLEEP, null), null, 'unanswered is not the same as zero');
  assert.equal(scaleValue(SLEEP, 'nonsense'), null);
  // The retired id is normalised, not dropped.
  const kept = validateReflection({ checkin: { sleep: 'great' } });
  assert.equal(kept.checkin?.sleep, 'rested', 'an old sleep value was silently emptied');
});

test('the server stores the passive dimensions and drops anything else', async () => {
  const { ws, call } = await setup();
  const r = await call('PUT', `/api/v1/workspaces/${ws}/diary/entries/2026-08-07`, {
    document: doc('A day.'),
    timezone: 'Africa/Johannesburg',
    reflection: {
      checkin: {
        feeling: 'good',
        nourishment: 'great',
        movement: 'light',
        outside: 'some',
        sleep: 'rough',
        // Not a value on any of these scales, and not a key we know.
        movementIntensity: 'extreme',
        sleep_hours: 9,
      },
    },
  });
  // 201 on the write that brings the row into being, 200 thereafter.
  assert.ok(r.status === 200 || r.status === 201, `unexpected ${r.status}`);
  const c = r.body.entry.reflection.checkin;
  assert.equal(c.nourishment, 'great');
  assert.equal(c.movement, 'light');
  assert.equal(c.outside, 'some');
  assert.equal(c.sleep, 'rough');
  assert.equal(c.movementIntensity, undefined, 'an undescribed key was stored');
  assert.equal(c.sleep_hours, undefined);
  // An id from the wrong scale is refused rather than stored.
  const bad = validateReflection({ checkin: { nourishment: 'very_active' } });
  assert.equal(bad.checkin?.nourishment, undefined);
});

test('A DIARY CHECK-IN IS NOT A HABIT', async () => {
  /* §8, and it is the boundary the whole feature rests on:
   *
   *   a diary check-in = an observation of how the day went
   *   a habit          = a behaviour you intend to repeat, and chose to track
   *
   * `Movement = Very active` does not complete a Gym habit. Nothing here
   * writes a habit_entries row or moves a habit total. */
  const { ws, call, db } = await setup();
  const today = '2026-08-07';
  const before = await call('GET', `/api/v1/workspaces/${ws}/habits?date=${today}`);

  await call('PUT', `/api/v1/workspaces/${ws}/diary/entries/${today}`, {
    document: doc('Moved a great deal.'),
    timezone: 'Africa/Johannesburg',
    reflection: {
      checkin: {
        movement: 'very_active', nourishment: 'great', outside: 'plenty', sleep: 'great',
      },
    },
  });

  const schema = await import('../src/db/schema.js');
  assert.equal((await db.select().from(schema.habits)).length, 0,
    'a passive tracker created a habit');
  assert.equal((await db.select().from(schema.habitEntries)).length, 0,
    'a passive tracker wrote a habit entry');

  const after = await call('GET', `/api/v1/workspaces/${ws}/habits?date=${today}`);
  assert.deepEqual(after.body.habits, before.body.habits);
  /* The ONE thing that does move is the computed `Write in Diary` habit — and
   * it moves because the day now holds writing, not because of what was
   * recorded in it. */
  assert.equal(after.body.diaryHabit.completedToday, true);
  assert.equal(before.body.diaryHabit.completedToday, false);

  /* Gym is deliberately not a Diary dimension: it is an intentional activity
   * and belongs to Habits. Asserted against the CODE, not the file — both
   * files discuss Gym at length in their comments, explaining precisely why it
   * is absent, and a test that reads its own prose proves nothing. */
  const reflectionCode = code(readFileSync(join('src', 'lib', 'diary-reflection.ts'), 'utf8'));
  assert.doesNotMatch(reflectionCode, /\bgym\b/i, 'Gym became a Diary dimension');
  assert.doesNotMatch(checkin, /\bgym\b/i, 'Gym became a Diary tracker');
  // And no control offers to make a habit from here (§16 defers that).
  assert.doesNotMatch(checkin, /Add habit|data-make-habit/);
});

/* ══ §10 DAY PULSE ═════════════════════════════════════════════════════ */

test('THE DAY PULSE WAS REMOVED', () => {
  /* D2.4 §6. Three bars derived from Overall Feeling, Energy and Social
   * Battery — sitting directly above Overall Feeling, Energy and Social
   * Battery. It restated the three controls beneath it, and it carried a line
   * of copy explaining that it was not a score, which is a reliable sign a
   * component is not earning its place: nothing that has to say what it is for
   * needs to be there.
   *
   * §6 is explicit that a component must not be kept merely because it was
   * already built. The information it carried now lives on the controls that
   * own it — every core option previews itself. */
  assert.doesNotMatch(checkin, /pulseHtml|pulseValues|PULSE|dia-pulse/);
  assert.doesNotMatch(diaView, /pulseHtml|paintPulse/);
  assert.doesNotMatch(html, /\.dia-pulse/);
  assert.doesNotMatch(checkin, /A snapshot of today, not a score/);
  /* What the rule protected survives: no total, no percentage, no average, no
   * colour that means good or bad. `scaleValue` is still the ONLY arithmetic
   * these scales permit, and it is a position on one list. */
  const fn = checkin.slice(checkin.indexOf('export const scaleValue'));
  assert.match(fn.slice(0, 400), /at \/ \(scale\.length - 1\)/);
  const body = checkin.slice(checkin.indexOf('export function checkinHtml'),
    checkin.indexOf('export const PROMPTS'));
  assert.doesNotMatch(body, /reduce\(|average|overall score/i,
    'something folds the dimensions into one figure');
});

test('the pulse derives, and derives nothing when nothing was said', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify({ mind: null, energy: null, connection: null })),
    { mind: null, energy: null, connection: null },
  );
  // The three sources, at their extremes.
  assert.equal(scaleValue(FEELINGS, 'rough'), 0);
  assert.equal(scaleValue(FEELINGS, 'great'), 1);
  assert.equal(scaleValue(SOCIAL, 'empty'), 0);
  assert.equal(scaleValue(SOCIAL, 'full'), 1);
});

/* ══ §11 MOTION ════════════════════════════════════════════════════════ */

test('right-page motion sits inside the stated budget, and nothing loops', () => {
  assert.match(html, /\.dia-chip\{[^}]*transition:background var\(--t-hover\)/);
  assert.match(html, /\.dia-batt-fill\{[^}]*transition:width var\(--d-base\)/);
  assert.match(html, /\.dia-meter-seg\{[^}]*transition:opacity var\(--d-fast\)/);
  assert.match(html, /\.dia-detail\{[^}]*animation:diaOpen var\(--d-base\)/);
  // --d-fast is 140ms and --d-base is 200ms; both are the stated numbers.
  assert.match(html, /--d-fast:140ms/);
  assert.match(html, /--d-base:200ms/);
  // Nothing on this page repeats, bounces or celebrates.
  const dia = html.slice(html.indexOf('.dia-checkin{'), html.indexOf('/* ── History'));
  assert.doesNotMatch(dia, /animation-iteration-count:\s*infinite|infinite/);
  assert.doesNotMatch(dia, /confetti|bounce|elastic|back\.out/i);
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{\s*\*\{animation-duration:1ms/);
});

/* ══ §12, §13 HISTORY ══════════════════════════════════════════════════ */

test('the month cell speaks the right page\'s language, using its components', () => {
  assert.match(historyJs, /from '\.\/diary-checkin\.js'/);
  for (const fn of ['face', 'glyph', 'energyMeter', 'batteryMeter', 'scaleValue', 'labelOf']) {
    assert.match(historyJs, new RegExp(`\\b${fn}\\b`), `history does not reuse ${fn}`);
  }
  assert.match(historyJs, /class="dia-day-ind"/);
  assert.match(historyJs, /energyMeter\(energy, 'dia-meter-xs'\)/);
  assert.match(historyJs, /batteryMeter\(social, 'dia-batt-xs'\)/);
  assert.match(historyJs, /class="dia-day-prev"/);
  /* D2.4 §17: ALL FOUR passive marks, always, on a day that answered any of
   * them — an unanswered one holds its place faintly rather than closing the
   * gap, so the four sit at the same four positions on every cell and a month
   * can be read down a column. */
  assert.match(historyJs, /const anyRhythm = PASSIVE\.some/);
  assert.match(historyJs, /anyRhythm \? [\s\S]{0,120}PASSIVE\.map/);
  assert.match(historyJs, /is-unset/);
  assert.match(html, /\.dia-day-rh-i\.is-unset\{opacity/);
  assert.match(historyJs, /glyph\(p\.icon, 11\)/);
  // A missing PRIMARY indicator holds its place too, for the same reason.
  assert.match(historyJs, /class="dia-day-gap"/);
  assert.doesNotMatch(historyJs, /dia-day-rh[\s\S]{0,200}labelOf\(p\.scale/,
    'the passive values are written into the cell as text');
  assert.match(historyJs, /title="\$\{esc\(said\.join\(' · '\)\)\}"/);
});

test('the month endpoint sends ids for the indicators, not writing', async () => {
  const { ws, call } = await setup();
  await call('PUT', `/api/v1/workspaces/${ws}/diary/entries/2026-08-07`, {
    document: doc('Rebuilt the shelf.'),
    energy: 'high',
    timezone: 'Africa/Johannesburg',
    reflection: {
      checkin: {
        feeling: 'good', social: 'low',
        nourishment: 'great', movement: 'light', outside: 'some', sleep: 'rough',
        highlight: 'The long way home',
      },
      prompts: { stood_out: 'A private thought that belongs in the entry.' },
    },
  });
  const r = await call('GET', `/api/v1/workspaces/${ws}/diary/days?month=2026-08-01`);
  const day = r.body.days.find((d: any) => d.date === '2026-08-07');
  assert.equal(day.feeling, 'good');
  assert.equal(day.energy, 'high');
  assert.equal(day.social, 'low');
  assert.deepEqual(day.rhythm,
    { nourishment: 'great', movement: 'light', outside: 'some', sleep: 'rough' });
  // The context line is chosen and cut on the server; the writing is not sent.
  assert.equal(day.preview, 'The long way home');
  assert.equal(day.reflection, undefined, 'the whole reflection reached the grid');
  assert.equal(day.excerpt, undefined);
});

test('History shows the day, never a habit total', () => {
  /* §15. History answers "what did my days feel like", not "how many goals did
   * I complete". Habit analytics stay in Calendar and Habits. */
  assert.doesNotMatch(historyJs, /habit/i, 'a habit reached Diary History');
  assert.doesNotMatch(historyJs, /streak/i);
});

/* ══ §14 THE TINT ══════════════════════════════════════════════════════ */

test('a difficult day is warm, and colour is never the only signal', () => {
  const tints = html.slice(html.indexOf('.dia-day-cell[data-feel="rough"]'),
    html.indexOf('.dia-cal-key{'));
  assert.match(tints, /\[data-feel="rough"\]\{background:rgba\(214,124,110/);
  assert.match(tints, /\[data-feel="low"\]\{background:rgba\(214,142,124/);
  assert.match(tints, /\[data-feel="steady"\]\{background:var\(--surface-2\)/);
  assert.match(tints, /\[data-feel="good"\]\{background:rgba\(122,190,146/);
  assert.match(tints, /\[data-feel="great"\]\{background:rgba\(160,136,240/);
  assert.doesNotMatch(tints, /--danger|#FF646E|\bred\b/i);
  // The indicators carry the same information without any colour at all.
  assert.match(historyJs, /class="dia-day-ind"/);
});

/* ══ §17 THE HABIT RING ════════════════════════════════════════════════ */

test('a complete ring has no dash, so it has no seam', () => {
  /* ROOT CAUSE, found by measurement. `pathLength="100"` with
   * `stroke-dasharray="100"` makes the dash exactly one full turn, so its END
   * lands on its own START. With `butt` caps those are two flat cuts meeting,
   * not a join — `stroke-linejoin` never applies to a dash boundary — and each
   * is antialiased alone, so the coverage where they abut sums to less than one
   * pixel of paint.
   *
   * Rasterised at four device pixel ratios, stroke coverage at the seam as a
   * fraction of the average around the ring:
   *
   *     DPR 1     46.5%   →  93.1%
   *     DPR 1.25  34.5%   →  88.4%
   *     DPR 1.5   21.5%   →  93.2%
   *     DPR 2      0.6%   →  94.0%     (a hole, not a hairline)
   *
   * It gets WORSE with pixel density, which is why it showed on a retina
   * screenshot. The fix is to stop drawing a dash when there is nothing to
   * dash: a complete ring is a plain closed circle with no start and no end. */
  assert.match(app, /const ringDash = \(h\) =>/);
  const fn = app.slice(app.indexOf('const ringDash'));
  assert.match(fn.slice(0, 500),
    /if \(h\.completedToday\) return 'stroke-dasharray="none" stroke-dashoffset="0"'/);
  // Completion is read from the flag, never from the arithmetic — §17 forbids
  // a 99.x% final state and floating-point division is how one would arrive.
  assert.doesNotMatch(fn.slice(0, 500), /pct === 1|>= 1|\.toFixed\(2\) === '0/);
  // The partial case is unchanged and still exact.
  assert.match(fn.slice(0, 500), /stroke-dasharray="100" stroke-dashoffset="\$\{\(100 - pct \* 100\)/);
  // Butt caps: a round cap overshoots the seam when full and leaves a dot at 0.
  assert.match(html, /\.hr-fill\{[^}]*stroke-linecap:butt/);
});

test('ordinary habits and the Diary habit draw the SAME ring', () => {
  assert.match(app, /const ringSvg = \(h\) =>/);
  const ordinary = app.slice(app.indexOf('function habitRowHtml'));
  assert.match(ordinary.slice(0, 900), /\$\{ringSvg\(h\)\}/);
  const diary = app.slice(app.indexOf('function diarySystemHabitHtml'));
  assert.match(diary.slice(0, 1600), /\$\{ringSvg\(/);
  // Neither draws its own <circle> any more, which is what stops them drifting.
  assert.equal((app.match(/class="hr-fill/g) ?? []).length, 1,
    'a second ring is being drawn by hand');
});

test('the sweep animates, and the dash is dropped once it has arrived', () => {
  /* The transition needs a dash to animate along; the finished ring must not
   * have one. The timer is the guarantee, not `transitionend` — a throttled
   * timeline would otherwise leave the seam exactly where §17 says it must not
   * be. The animation house rule, applied to a stroke instead of a layout. */
  assert.match(app, /function settleDash\(fill\)/);
  const fn = app.slice(app.indexOf('function settleDash'));
  assert.match(fn.slice(0, 700), /setAttribute\('stroke-dasharray', 'none'\)/);
  assert.match(fn.slice(0, 700), /transitionend', drop, \{ once: true \}/);
  assert.match(fn.slice(0, 700), /setTimeout\(drop, 320\)/);
  const patch = app.slice(app.indexOf('function patchHabitRow'));
  assert.match(patch.slice(0, 1600), /if \(h\.completedToday\) \{[\s\S]{0,200}settleDash\(fill\)/);
});

/* ══ §18–§21 THE DATE-NAVIGATION TRANSACTION ═══════════════════════════ */

test('a date navigation is a transaction, claimed before anything is awaited', () => {
  /* THE RUBBER-BAND. Measured before the fix: Next, Next, Previous, Next showed
   * 8 Aug, then 7 Aug, then 8 Aug again, settling after 3.6 seconds, with four
   * requests for three days.
   *
   * Three causes. `loadDay` set `dia.date` itself, so a response for a day
   * already left made that day CURRENT again. Nothing distinguished a render
   * belonging to the newest press from one three presses old. And the target
   * was computed from `dia.date`, which was not committed until after the save
   * flush — so rapid presses all computed from the same stale base. */
  assert.match(diaApi, /export function beginDayNav\(date\)/);
  assert.match(diaApi, /export const dayNavStale = \(t\) => t !== dayNav/);
  const go = diaView.slice(diaView.indexOf('export async function goToDate'));
  const head = go.slice(0, go.indexOf('await renderEntry'));
  assert.ok(head.indexOf('beginDayNav(date)') < head.indexOf('flushAll()'),
    'the date is committed after the flush again');
  // The heading, the controls and the hash are correct in the first frame.
  assert.match(head, /head\.innerHTML = headerHtml\(\)/);
  assert.match(head, /setHash\(`#diary\/\$\{date\}`\)/);
  assert.match(head, /beginTurn\(scroll, direction\)/);
});

test('nothing belonging to an older day may paint', () => {
  // `loadDay` no longer decides which day is open…
  const fn = diaApi.slice(diaApi.indexOf('export async function loadDay'));
  assert.match(fn.slice(0, 500), /if \(date !== dia\.date\) return r;/);
  assert.doesNotMatch(fn.slice(0, 500), /dia\.date = date/,
    'loadDay reinstates the day it was asked about');
  // …and a month preload cannot move the selection either (§19).
  assert.match(diaApi, /export async function loadMonth\(monthDate, day = null\)/);
  assert.match(diaApi, /if \(day !== null && dayNavStale\(day\)\) return r;/);
  // Every render checks BOTH tokens before it paints.
  const entry = diaView.slice(diaView.indexOf('async function renderEntry'));
  assert.match(entry.slice(0, 900), /const stale = \(\) => navStale\(nav\) \|\| dayNavStale\(day\)/);
  assert.ok(entry.indexOf('if (stale()) return;') < entry.indexOf('setHash('));
});

test('a save for the day being left finishes, but cannot take the screen', () => {
  /* §18 exactly: it may update that Diary record, and it may not restore the
   * previous date visually. Verified in a browser — navigating mid-autosave
   * landed on the requested day, and the abandoned day's text was on the
   * server afterwards. */
  assert.match(diaSave, /if \(date === dia\.date\) \{\s*dia\.entry = r\.entry;/);
  assert.match(diaSave, /onCreated\?\.\(r\.entry, r\.created, date\)/);
  const created = diaView.slice(diaView.indexOf('onEntryCreated('));
  assert.match(created.slice(0, 700), /if \(date && date !== dia\.date\) return;/);
});

test('the turn is two layers, and the outgoing one always leaves', () => {
  assert.match(diaView, /const TURN_MS = 260/);
  const fn = diaView.slice(diaView.indexOf('function beginTurn'));
  assert.match(fn.slice(0, 2200), /book\.cloneNode\(true\)/);
  // The clone is inert, has no ids and cannot be typed into.
  assert.match(fn.slice(0, 2200), /ghost\.inert = true/);
  assert.match(fn.slice(0, 2200), /removeAttribute\('id'\)/);
  assert.match(fn.slice(0, 2200), /contenteditable', 'false'/);
  // It removes itself on the event AND on a timer, so a throttled timeline
  // cannot leave a ghost day sitting over the real one.
  assert.match(fn.slice(0, 2200), /animationend', drop, \{ once: true \}/);
  assert.match(fn.slice(0, 2200), /setTimeout\(drop, TURN_MS \+ 120\)/);
  assert.match(diaView, /function endTurn\(/);
  // The book frame never moves: only the clone is animated.
  assert.match(html, /\.dia-ghost\{position:absolute/);
  assert.doesNotMatch(html, /\.dia-book\.leave-next\{/,
    'the live book is animated again');
});

test('a slow day never shows the day you left as the current one', () => {
  /* §21. The ghost fades in 260ms; whatever is underneath then becomes
   * visible. If that were still the old day, a slow connection would show it
   * as current — the rubber-band wearing a different hat. */
  assert.match(diaView, /scroll\.innerHTML = loadingHtml\(date\)/);
  assert.match(entryJs, /export const loadingHtml = \(date = dia\.date\)/);
  assert.match(read('diary-entry.js'), /esc\(formatLong\(date\)\)/);
  assert.match(html, /\.dia-skel-lines span\{display:block;height:30px/);
});

test('the hash stays centrally owned, and Back is a real navigation', () => {
  // §20: no private suppress flags, ever again.
  assert.doesNotMatch(diaView, /suppressHash/);
  assert.match(diaView, /import \{ navToken, navStale, setHash \} from '\.\/nav\.js'/);
  assert.match(diaView, /export function diaryHashChanged\(ours = false\)/);
  // Back/Forward and a pasted URL each claim their own date navigation.
  const render = diaView.slice(diaView.indexOf('export async function renderDiary'));
  assert.match(render.slice(0, 900), /const day = beginDayNav\(route\.date\)/);
});
