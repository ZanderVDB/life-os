/**
 * Phase D2.4 — visual refinement, check-in consistency, History density and
 * the Today filter.
 *
 * A polish phase, so most of what is asserted here is GEOMETRY: that three
 * rows resolve to one grid, that five states are evenly spaced, that a label
 * cannot outgrow its column. The browser measurements that motivated each
 * number are quoted where they matter — a polish phase is exactly the kind
 * that drifts back if the reason is not written down beside the rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import {
  validateReflection, scaleValue, SOCIAL, SLEEP, FEELINGS, PASSIVE, PASSIVE_KEYS,
} from '../src/lib/diary-reflection.js';
import { historySampleCoverage, SAMPLE_PREFIX } from '../src/lib/sample-diary.js';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const app = code(read('app.js'));
const diaView = code(read('diary-view.js'));
const checkin = code(read('diary-checkin.js'));
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
const auth = { authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'd24@example.com' };

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

/* ══ §3, §4, §5 THE 5/5/5 CORE ═════════════════════════════════════════ */

test('all three core check-ins offer exactly five options', () => {
  /* §3. Social Battery had four, which made it the odd one out beside Overall
   * Feeling and Energy — and forced an uneven battery, because four cells
   * cannot be evenly spaced against a five-step sibling. */
  assert.equal(FEELINGS.length, 5);
  assert.equal(SOCIAL.length, 5);
  // Sliced to the next EXPORT, not to a comment — `checkin` is the
  // comment-stripped source, so a comment marker finds nothing.
  const energies = checkin.slice(checkin.indexOf('export const ENERGIES = ['),
    checkin.indexOf('export const NOURISHMENT'));
  assert.equal((energies.match(/id: '/g) ?? []).length, 5);
  // The fifth social state, and the order it sits in.
  assert.deepEqual(SOCIAL.map((s) => s.id), ['empty', 'low', 'ok', 'good', 'full']);
});

test('ONE control grid, not three sets of margins', () => {
  /* §5 forbids correcting each row independently, and it was right to: before
   * D2.4 the Social Battery's chips were flex-wrapped at intrinsic widths, so
   * its words came out 53 / 84 / 60 / 38px while Energy's were a uniform 53.9.
   *
   * Measured after, at a 310px page: all three rows 5 options, every chip
   * 53.5px, every row starting at x=13 and ending at x=296.5, every chip 45px
   * tall. One declaration is what makes that true. */
  assert.match(html,
    /\.dia-chips\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(52px,1fr\)\)/);
  assert.match(html, /\.dia-chips-rhythm\{grid-template-columns:repeat\(auto-fit,minmax\(42px,1fr\)\)/);
  // `kind` selects a grid; nothing selects a margin.
  assert.match(checkin, /function chips\(name, options, selected, kind = 'core'\)/);
  assert.match(checkin, /class="dia-chips dia-chips-\$\{kind\}"/);
  assert.doesNotMatch(html, /\.dia-ci-group\[data-group-id="(feeling|energy|social)"\] \.dia-chips\{[^}]*margin/);
  // The precise feelings are a TAG LIST, not a scale, and keep their own flow.
  assert.match(html, /\.dia-chips-detail\{display:flex;flex-wrap:wrap/);
});

test('the battery is five even states on one shell, at every size', () => {
  /* §4. Five states put the fill on exact quarters, which is the clean
   * progression the brief asked for. Measured in a browser: shell 30x13 in
   * every state; History drew 0% / 25% / 50% from the same component. */
  assert.deepEqual(SOCIAL.map((s) => Math.round(scaleValue(SOCIAL, s.id)! * 100)),
    [0, 25, 50, 75, 100]);
  const steps = SOCIAL.map((s) => scaleValue(SOCIAL, s.id)!);
  const deltas = steps.slice(1).map((v, i) => v - steps[i]!);
  assert.ok(Math.max(...deltas) - Math.min(...deltas) < 1e-9, 'the steps are uneven');
  // One shell, three sizes, driven by variables — never three rules (§14).
  assert.match(html, /\.dia-batt\{--b-w:30px; --b-h:13px; --b-pad:2px;/);
  assert.match(html, /\.dia-batt-opt\{--b-w:26px/);
  assert.match(html, /\.dia-batt-xs\{--b-w:18px/);
  assert.doesNotMatch(html, /\.dia-batt-xs \.dia-batt-fill\{width/,
    'History overrides the shared fill formula');
});

test('the energy signal rises linearly, in one component', () => {
  /* §13. `height: calc(6px + i * 2px)` gave 6, 8, 10, 12, 14 — a 33% jump from
   * bar 1 to bar 2 and 17% from bar 4 to 5, so at History's size the first gap
   * read as a mistake. h(i) = MIN + (MAX-MIN) * i/(bars-1) makes every step
   * the same number of pixels, at any size. */
  assert.match(html,
    /height:calc\(var\(--m-min\) \+ \(var\(--m-max\) - var\(--m-min\)\) \* var\(--n\) \/ \(var\(--bars\) - 1\)\)/);
  assert.doesNotMatch(html, /calc\(6px \+ var\(--seg\) \* 2px\)/, 'the uneven rise is back');
  // Equal width and equal gap, and a stated box however many are lit.
  assert.match(html, /\.dia-meter\{--m-min:5px; --m-max:15px; --m-w:3px; --m-gap:2px;/);
  assert.match(html, /\.dia-meter-seg\{width:var\(--m-w\)/);
  // Two smaller sizes of the SAME component; no separate approximation.
  assert.match(html, /\.dia-meter-opt\{--m-min:4px/);
  assert.match(html, /\.dia-meter-xs\{--m-min:3px/);
  assert.match(checkin, /style="--bars:\$\{ENERGIES\.length\}"/);
  assert.match(checkin, /style="--n:\$\{i\}"/);
});

test('every core option previews itself, with the component that shows it', () => {
  /* §3 asks the three rows to be one system with consistent height. Padding a
   * word-only chip out to match a face-over-word chip reads as a mistake; a
   * per-option preview makes them structurally identical AND makes each chip
   * say what choosing it means before you choose it. */
  assert.match(checkin, /function optionPreview\(group, o\)/);
  const fn = checkin.slice(checkin.indexOf('function optionPreview'));
  assert.match(fn.slice(0, 500), /group === 'feeling'\) return face\(o, 19\)/);
  assert.match(fn.slice(0, 500), /group === 'energy'\) return energyMeter\(o\.id, 'dia-meter-opt'\)/);
  assert.match(fn.slice(0, 500), /group === 'social'\) return batteryMeter\(o\.id, 'dia-batt-opt'\)/);
  // The preview box is STATED, so every core chip is the same height whatever
  // its indicator draws.
  assert.match(html, /\.dia-chip-i\{display:flex;align-items:center;justify-content:center;height:17px/);
  // Rhythm chips are word-only: four one-tap answers do not need previewing.
  assert.match(checkin, /kind === 'core' \? `<span class="dia-chip-i">/);
});

/* ══ §8, §9 DAILY RHYTHM ═══════════════════════════════════════════════ */

test('every Daily Rhythm row offers exactly four options', () => {
  for (const k of PASSIVE_KEYS) {
    assert.equal(PASSIVE[k].length, 4, `${k} does not have four options`);
    const vals = PASSIVE[k].map((o) => Math.round(scaleValue(PASSIVE[k], o.id)! * 100));
    assert.deepEqual(vals, [0, 33, 67, 100], `${k} is not evenly stepped`);
  }
  // Sleep lost its fifth state; `Rested` is the top one.
  assert.deepEqual(SLEEP.map((s) => s.id), ['rough', 'poor', 'fine', 'rested']);
});

test('a retired sleep value is normalised, never dropped', () => {
  /* Dropping `great` would silently empty the sleep value on any day recorded
   * before D2.4, the first time that day was re-saved. */
  assert.equal(validateReflection({ checkin: { sleep: 'great' } }).checkin?.sleep, 'rested');
  assert.equal(validateReflection({ checkin: { sleep: 'rested' } }).checkin?.sleep, 'rested');
  assert.equal(validateReflection({ checkin: { sleep: 'nonsense' } }).checkin?.sleep, undefined);
  // The alias is read on the way IN and never written back out as an option.
  assert.doesNotMatch(JSON.stringify(SLEEP), /great/);
});

test('THE NOURISHMENT OVERLAP: one grid, not a per-row margin', () => {
  /* ROOT CAUSE, measured. The label was `flex: 0 0 66px` with
   * `overflow: visible`. NOURISHMENT needs 98px of content, so 24.3px of text
   * painted ON TOP of its first chip; MOVEMENT overflowed by 7.2px; OUTSIDE
   * and SLEEP happened to fit. Not a Nourishment bug — a fixed column narrower
   * than its widest content, and §9 forbids fixing it with a special margin.
   *
   * `.dia-rhythm` is the grid and each row is `display: contents`, so all four
   * rows share ONE `auto` label column sized to the widest label and ONE set
   * of option columns. An `auto` column cannot be narrower than its content,
   * so the overlap is unreachable rather than merely absent.
   *
   * Measured after: label 91px on every row, `scrollWidth <= clientWidth` on
   * all four, every row's controls starting at the same x. */
  assert.match(html, /\.dia-rhythm\{display:grid;grid-template-columns:auto minmax\(0,1fr\)/);
  assert.match(html, /\.dia-rh-row\{display:contents\}/);
  assert.doesNotMatch(html, /\.dia-rh-l\{[^}]*flex:0 0 \d+px/, 'the fixed label column is back');
  assert.doesNotMatch(html, /\.dia-rh-row\[data-rhythm="nourishment"\]/,
    'Nourishment has a rule of its own again');
  // Below 264px of PAGE width the label stacks above its options rather than
  // squeezing them — §25 permits stacking, never squeezing.
  assert.match(html, /@container diapage \(max-width: 264px\)/);
  assert.match(html, /\.dia-right\{container-type:inline-size;container-name:diapage\}/);
});

/* ══ §11 THREE STATES ══════════════════════════════════════════════════ */

test('hover, selected and focus are three different things', () => {
  const rule = (sel: string) => {
    const at = html.indexOf(sel + '{');
    assert.ok(at > -1, `${sel} has no rule`);
    return html.slice(at, html.indexOf('}', at));
  };
  const hover = rule('.dia-chip:hover');
  const on = rule('.dia-chip.on');
  const onHover = rule('.dia-chip.on:hover');
  const focus = rule('.dia-chip:focus-visible');

  // HOVER lightens and lifts. It must NOT fill.
  assert.match(hover, /background:rgba\(255,255,255,\.085\)/);
  assert.match(hover, /transform:translateY\(-1px\)/);
  assert.doesNotMatch(hover, /var\(--ci\)/, 'hover uses the selected fill');
  // SELECTED fills with the group family, in dark ink, and persists.
  assert.match(on, /background:var\(--ci\)/);
  assert.match(on, /color:#1A1624/);
  assert.match(on, /font-weight:600/);
  // A selected chip under hover still reads as selected.
  assert.match(onHover, /background:var\(--ci\)/);
  // FOCUS is a ring, distinct from both.
  assert.match(focus, /outline:2px solid var\(--accent\)/);
  // And the state survives greyscale: the shape carries it too.
  assert.match(html, /\.dia-chip\.on::after\{content:''/);
});

test('History tells mood, hover and the open day apart', () => {
  /* §18. D2.3 used `filter: brightness(1.22)` for hover, which merely made the
   * tint brighter — so "hovered Steady" and "resting Good" looked alike, which
   * is exactly the confusion this rule exists to remove. */
  assert.doesNotMatch(html, /\.dia-day-cell\[data-feel\]:hover\{filter:brightness/,
    'hover is a brightness bump again');
  // Mood: background only. No border, no lift — it is ambience.
  assert.match(html, /\.dia-day-cell\[data-feel="good"\]\{background:rgba\(122,190,146/);
  // Hover: an outline and a lift, on any cell, tinted or not.
  assert.match(html, /\.dia-day-cell:hover\{box-shadow:inset 0 0 0 1\.5px var\(--border-strong\)/);
  assert.match(html, /\.dia-day-cell:hover\{[^}]*transform:translateY\(-1px\)/);
  // Selected: a persistent accent ring, and it beats every tint.
  assert.match(html, /\.dia-day-cell\.is-open,\.dia-day-cell\[data-feel\]\.is-open\{/);
  assert.match(html, /\.dia-day-cell\.is-open[^}]*box-shadow:inset 0 0 0 2px var\(--accent\)/);
  // Today is its own quieter ring, so it is findable without being selected.
  assert.match(html, /\.dia-day-cell\.is-today\{box-shadow:inset 0 0 0 1px var\(--border-strong\)\}/);
});

/* ══ §2, §23 COLOUR ════════════════════════════════════════════════════ */

test('colour is semantic tokens, per group, and never the only signal', () => {
  // One family per group, declared once and read by every rule below it.
  assert.match(html, /\.dia-checkin\{\s*--ci-lav:#B69BF0;/);
  assert.match(html, /--ci-blu:#8FA6F5;/);
  assert.match(html, /--ci-tea:#7FC6D9;/);
  assert.match(html, /--ci-neu:#A79ECB;/);
  for (const [id, tok] of [['feeling', 'lav'], ['energy', 'blu'],
    ['social', 'tea'], ['rhythm', 'neu']]) {
    assert.match(html, new RegExp(
      `\\.dia-ci-group\\[data-group-id="${id}"\\]\\{--ci:var\\(--ci-${tok}\\)\\}`));
  }
  /* Measured contrast against the paper (`rgb(38,34,51)`) and against each
   * fill: selected text 7.09–9.27, default text 6.98. Every one is above the
   * 4.5 AA floor. */
  // Never destructive red, and never a bright success green as decoration.
  const dia = html.slice(html.indexOf('.dia-checkin{'), html.indexOf('/* ── History'));
  assert.doesNotMatch(dia, /--danger|#FF646E/);
  assert.doesNotMatch(dia, /--ok\b/);
  // Every group's reading is still a WORD, and the group's rail is decoration
  // on top of a state the text already carries.
  assert.match(checkin, /class="dia-ci-read"/);
  assert.match(html, /\.dia-ci-group:has\(\.dia-chip\.on\)::before\{opacity:\.55\}/);
});

/* ══ §6, §7 REMOVALS ═══════════════════════════════════════════════════ */

test('the Day Pulse is gone, and nothing replaced it', () => {
  assert.doesNotMatch(checkin, /pulseHtml|pulseValues|PULSE|dia-pulse/);
  assert.doesNotMatch(diaView, /pulseHtml|paintPulse/);
  assert.doesNotMatch(html, /\.dia-pulse/);
  assert.doesNotMatch(checkin, /A snapshot of today, not a score/);
});

test('all five prompts show, with no disclosure control', () => {
  assert.doesNotMatch(checkin, /PROMPTS_LEAD|data-prompts-more/);
  assert.doesNotMatch(diaView, /promptsOpen/);
  assert.doesNotMatch(read('diary-api.js'), /promptsOpen: false/);
  assert.doesNotMatch(html, /\.dia-prompts-more\{/);
  assert.match(checkin, /export function promptsHtml\(refl\)/);
  const fn = checkin.slice(checkin.indexOf('export function promptsHtml'));
  assert.match(fn.slice(0, 1200), /\$\{all\.map\(\(p\) => \{/);
  // Six ruled lines is what pays for the fifth prompt.
  assert.match(html, /\.dia-editor\{outline:0;min-height:180px/);
  assert.match(html, /\.dia-prompt-a\{[^}]*min-height:36px/);
});

/* ══ §15–§17 HISTORY DENSITY ═══════════════════════════════════════════ */

test('a written cell uses three bands, in one stable order', () => {
  assert.match(html, /\.dia-day-cell\{[^}]*height:80px/);
  assert.match(historyJs, /class="dia-day-top"/);
  assert.match(historyJs, /class="dia-day-ind"/);
  assert.match(historyJs, /class="dia-day-prev"/);
  assert.match(historyJs, /class="dia-day-rh"/);
  /* §16/§17: a dimension this day did not answer HOLDS ITS PLACE rather than
   * closing the gap, so the indicators sit at the same x on every cell and a
   * month can be read down a column. Omitting them made the row shuffle left,
   * which is unreadable at a glance and was the point of having it. */
  assert.match(historyJs, /class="dia-day-gap"/);
  assert.match(historyJs, /is-unset/);
  assert.match(html, /\.dia-day-gap\{display:block;width:16px/);
  assert.match(html, /\.dia-day-rh-i\.is-unset\{opacity:\.12\}/);
  // The four marks are subordinate: smaller, fainter, and below.
  assert.match(html, /\.dia-day-rh\{[^}]*color:var\(--muted\)/);
  // Exact values live in the tooltip and the accessible name, never the square.
  assert.match(historyJs, /title="\$\{esc\(said\.join\(' · '\)\)\}"/);
  assert.doesNotMatch(historyJs, /dia-day-rh[\s\S]{0,200}labelOf\(p\.scale/);
});

/* ══ §19, §20 SAMPLE DATA ══════════════════════════════════════════════ */

test('the History fixture covers every state it claims to', () => {
  /* §19 asks for a month that makes a visual review meaningful. Coverage is
   * ASSERTED rather than hoped for — a fixture that quietly stops covering a
   * state is a review that quietly stops testing it. */
  const c = historySampleCoverage();
  assert.ok(c.days >= 12 && c.days <= 16, `${c.days} days is outside 12–16`);
  assert.equal(c.feeling.length, 5, 'not all five Overall Feelings appear');
  assert.equal(c.energy.length, 5, 'not all five Energies appear');
  assert.equal(c.social.length, 5, 'not all five Social Battery states appear');
  for (const k of PASSIVE_KEYS) {
    assert.equal((c as any)[k].length, 4, `not every ${k} value appears`);
  }
  assert.ok(c.titled >= 3, 'too few custom titles');
  assert.ok(c.untitled >= 3, 'too few untitled entries');
  assert.ok(c.written >= 3, 'too few days with writing');
  assert.ok(c.checkinOnly >= 3, 'too few check-in-only days');
});

test('the fixture seeds through the existing tooling, and cleanup is exact', async () => {
  const { ws, call, db } = await setup();
  const today = '2026-08-07';

  // A real entry that must survive cleanup, on a date the fixture does not use.
  await call('PUT', `/api/v1/workspaces/${ws}/diary/entries/2026-06-01`, {
    document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mine.' }] }] },
    timezone: 'Africa/Johannesburg',
  });

  const seeded = await call('POST', `/api/v1/workspaces/${ws}/diary/sample/history`, { today });
  assert.equal(seeded.status, 200);
  assert.equal(seeded.body.entriesCreated, historySampleCoverage().days);

  // Gaps between written days, so an empty cell can be compared with a full one.
  const dates: string[] = seeded.body.dates;
  const gaps = dates.slice(1).filter((d, i) => {
    const a = Date.parse(`${dates[i]}T00:00:00Z`);
    return Date.parse(`${d}T00:00:00Z`) - a > 86_400_000;
  });
  assert.ok(gaps.length >= 5, 'the fixture has too few empty days between written ones');

  // The month endpoint draws them with the real indicator ids.
  const month = await call('GET', `/api/v1/workspaces/${ws}/diary/days?from=2026-07-01&to=2026-08-07`);
  const drawn = month.body.days.filter((d: any) => dates.includes(d.date));
  assert.equal(drawn.length, dates.length);
  assert.ok(drawn.every((d: any) => d.feeling && d.energy && d.social && d.rhythm.sleep));

  // ONE cleanup, matching the exact marker — the fixture is a second SET, not
  // a second system (§19).
  const schema = await import('../src/db/schema.js');
  const removed = await call('POST', `/api/v1/workspaces/${ws}/diary/sample/remove`);
  assert.equal(removed.body.removed, dates.length);
  const left = await db.select().from(schema.diaryEntries);
  assert.equal(left.length, 1, 'cleanup took something that was not a sample');
  assert.equal(left[0].entryDate, '2026-06-01');
  assert.equal(SAMPLE_PREFIX, 'sample:d1:');
});

test('the fixture refuses to run in production', async () => {
  const prodEnv = loadEnv({
    NODE_ENV: 'production', PORT: '8080', LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
    CORS_ALLOWED_ORIGINS: 'https://example.com',
  } as any);
  const { db } = await freshDb();
  const server = buildApp(db, prodEnv);
  await server.ready();
  const r = await server.inject({
    method: 'POST',
    url: '/api/v1/workspaces/00000000-0000-0000-0000-000000000000/diary/sample/history',
    payload: { today: '2026-08-07' },
  });
  assert.ok(r.statusCode >= 400, 'production accepted a sample seed');
});

/* ══ §21 THE TODAY AREA FILTER ═════════════════════════════════════════ */

test('the Area filters have a real gap, from a shared token', () => {
  /* THE DEFECT: `.filters` had no rule at all. Its chips are inline-block, so
   * the only thing between them was the whitespace in the template — about 4px
   * at 12px type — and the pill borders read as touching. `.toolbar`'s own gap
   * separated Add Task from the GROUP, which is why only the pills inside
   * looked wrong.
   *
   * Measured after: 9px between every pill, 9px between wrapped rows, 13.5px
   * between Add Task and the group, nothing below 4px at any width. */
  assert.match(html, /:root\{--chip-gap:9px\}/);
  assert.match(html, /\.filters\{display:flex;gap:var\(--chip-gap\)[^}]*flex-wrap:wrap/);
  assert.match(html, /\.toolbar\{display:flex;gap:var\(--chip-gap\)/);
  // One token, so the two gaps cannot drift apart.
  assert.doesNotMatch(html, /\.filters \.chip\{[^}]*margin/, 'a per-chip margin is back');
  // The behaviour is untouched: same markup, same handler, same state.
  assert.match(app, /<div class="filters" role="group" aria-label="Filter by area">/);
  assert.match(app, /state\.areaFilter = id/);
});

/* ══ Regression ════════════════════════════════════════════════════════ */

test('the D2.3 fixes are all still in place', () => {
  // The date-navigation transaction.
  assert.match(read('diary-api.js'), /export function beginDayNav\(date\)/);
  assert.match(diaView, /const stale = \(\) => navStale\(nav\) \|\| dayNavStale\(day\)/);
  // The habit ring closes.
  assert.match(app, /if \(h\.completedToday\) return 'stroke-dasharray="none" stroke-dashoffset="0"'/);
  assert.match(app, /const ringSvg = \(h\) =>/);
  // The right page is still tap-only.
  const body = checkin.slice(checkin.indexOf('export function checkinHtml'),
    checkin.indexOf('export const PROMPTS'));
  assert.doesNotMatch(body, /<textarea|<input|contenteditable/);
  // A passive dimension still writes no habit.
  const lib = readFileSync(join('src', 'lib', 'diary-reflection.ts'), 'utf8');
  assert.doesNotMatch(code(lib), /habitEntries|habits\b/);
});
