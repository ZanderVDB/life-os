/**
 * Phase C4 — Today interaction contract.
 *
 * These lock the behaviours C4 was commissioned to fix. Like web-shell, they
 * assert against SOURCE, so they prove a rule is written down rather than that a
 * browser honours it; the runtime behaviour was measured in a real browser and
 * the numbers are in the phase report. What they catch cheaply is regression —
 * someone reintroducing a full-route reload on save, dropping a priority level,
 * or putting Quick Capture back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
/* index.html + app.css: the stylesheet moved out of the page so the home
 * page is 5KB instead of 350KB. These assertions are about the app's CSS,
 * which is still the app's CSS — it just has its own file now. */
const html = read('index.html') + read('app.css');
const app = read('app.js');
const motion = read('motion.js');
const stars = read('stars.js');
const taskModal = read('task-modal.js');
const habitModal = read('habit-modal.js');

/** Same stripper as web-shell: several rules are also described in comments. */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const appCode = code(app);
const motionCode = code(motion);
const taskModalCode = code(taskModal);
const habitModalCode = code(habitModal);

/* ── Save architecture: the flicker defect ───────────────────────────── */

test('save: task mutations patch in place and never reload the route', () => {
  // The defect was a full-region rebuild on every save, which read as a page
  // flash. The fix is a card-level patch, so the mutation paths must not call
  // the route loader or replace the scroll region wholesale.
  for (const fn of ['function patchCard', 'function rebuildBucket']) {
    assert.ok(appCode.includes(fn), `${fn} missing — the in-place patch path is gone`);
  }
  const mutators = ['async function toggleTask', 'async function moveTask'];
  for (const m of mutators) {
    const start = appCode.indexOf(m);
    assert.ok(start > -1, `${m} missing`);
    // Read to the next top-level function declaration.
    const rest = appCode.slice(start + m.length);
    const end = rest.search(/\n(?:async )?function /);
    const body = end === -1 ? rest : rest.slice(0, end);
    assert.ok(!/\bloadRoute\b/.test(body), `${m} calls loadRoute — that is the flash`);
    assert.ok(!/\brefreshToday\b/.test(body), `${m} calls refreshToday — that is the flash`);
    assert.ok(!/main-scroll'\)\.innerHTML\s*=/.test(body),
      `${m} replaces main-scroll — that is the flash`);
  }
});

test('save: the indicator is a quiet status, not a route change', () => {
  assert.ok(appCode.includes('function saved('), 'no saved() indicator');
  assert.match(html, /\.save-state\{/, 'no .save-state style');
});

test('save: the stagger cannot replay on a patch', () => {
  // `.stagger` is the first-paint entrance. Re-applying it on every save was
  // half of what made a save look like a reload.
  const patchStart = appCode.indexOf('function patchCard');
  const body = appCode.slice(patchStart, patchStart + 900);
  assert.ok(!body.includes('stagger'), 'patchCard re-applies the entrance stagger');
});

/* ── Motion ──────────────────────────────────────────────────────────── */

test('motion: FLIP animates transform only, never layout properties', () => {
  assert.ok(motionCode.includes('export function flip'), 'no flip()');
  const flipStart = motionCode.indexOf('export function flip');
  const body = motionCode.slice(flipStart, motionCode.indexOf('export function pulse'));
  assert.ok(body.includes('getBoundingClientRect'), 'flip does not measure');
  for (const prop of ['left:', 'top:', 'width:', 'marginTop']) {
    assert.ok(!body.includes(prop), `flip animates ${prop} — that thrashes layout`);
  }
});

test('motion: every animated teardown is guaranteed, not left to onfinish', () => {
  // A hidden tab or a detached element can leave an animation `running`
  // forever, so `onfinish` never arrives. When that callback is what removes a
  // completed task, the card is stranded on screen until a reload.
  assert.ok(motionCode.includes('export function settle'), 'no settle() guarantee');
  assert.match(motionCode, /setTimeout\(once,\s*duration/, 'settle has no timeout fallback');
  assert.match(motionCode, /anim\.oncancel\s*=\s*once/, 'settle ignores cancellation');
  assert.ok(motionCode.includes('settle(anim, 200, onDone)'),
    'collapseOut does not use the guarantee');
  for (const [name, src] of [['task', taskModalCode], ['habit', habitModalCode]] as const) {
    assert.match(src, /settle\(a,\s*160,\s*done\)/, `${name} modal teardown is not guaranteed`);
  }
});

test('motion: every path respects reduced motion', () => {
  for (const [name, src] of [['motion', motionCode], ['task-modal', taskModalCode],
    ['habit-modal', habitModalCode], ['app', appCode]] as const) {
    assert.ok(src.includes('reducedMotion'), `${name} ignores reduced motion`);
  }
  assert.match(html, /prefers-reduced-motion:reduce/, 'no reduced-motion media query');
});

/* ── Task modal ──────────────────────────────────────────────────────── */

test('modal: the side drawer is gone and the dialog is centred', () => {
  assert.ok(!appCode.includes('function openDetail'), 'the old drawer survives');
  assert.match(html, /\.modal\{position:fixed[^}]*transform:translate\(-50%,-50%\)/,
    'the dialog is not centred');
  assert.match(html, /\.modal-scrim\{/, 'no scrim');
});

test('modal: entrance keyframes never touch `transform`', () => {
  // Centring lives in `transform`, and the mobile sheet removes it entirely.
  // An animation that set `transform` overrode whichever applied and threw the
  // dialog off screen — measured at 310px off-centre before the fix.
  for (const [name, src] of [['task', taskModalCode], ['habit', habitModalCode]] as const) {
    assert.ok(src.includes('RISE_IN') && src.includes('RISE_OUT'),
      `${name} modal does not use the shared keyframes`);
    const kf = src.slice(src.indexOf('const RISE_IN'), src.indexOf('const RISE_OUT') + 220);
    assert.ok(!kf.includes('transform:'), `${name} modal keyframes animate transform`);
    assert.ok(kf.includes('translate:') && kf.includes('scale:'),
      `${name} modal does not use the independent properties`);
  }
});

test('modal: it traps focus, restores it, and guards unsaved work', () => {
  assert.match(taskModalCode, /role',\s*'dialog'/, 'not a dialog');
  assert.match(taskModalCode, /aria-modal/, 'not modal to assistive tech');
  assert.ok(taskModalCode.includes('isDirty'), 'no unsaved-change guard');
  assert.ok(taskModalCode.includes('opener'), 'focus is not returned to the opener');
  assert.match(taskModalCode, /e\.key !== 'Tab'/, 'no focus trap');
  assert.match(taskModalCode, /e\.key === 'Escape'/, 'Escape does not close');
});

test('modal: the mobile bottom sheet is a sheet, not a squeezed dialog', () => {
  assert.match(html, /\.modal\{left:0;right:0;bottom:0;top:auto;transform:none/,
    'the mobile sheet still carries the desktop centring');
  assert.match(html, /border-radius:20px 20px 0 0/, 'the sheet is not bottom-anchored in shape');
});

test('modal: Project is named when there is one, and absent when there is not', () => {
  // C4 showed a permanent "Project — Arrives with Projects" line, so its
  // absence read as "not yet" instead of "forgotten". Projects exist now, so
  // that placeholder is just an unfinished-looking field in every task editor.
  assert.ok(!taskModal.includes('Arrives with Projects'),
    'the coming-soon placeholder outlived the feature it was waiting for');
  assert.match(taskModal, /\$\{project \? `<div class="m-project">/,
    'a task in a project does not say which project');
  assert.match(taskModal, /project = null \} = ctx/, 'the modal cannot be told its project');
});

/* ── Task card ───────────────────────────────────────────────────────── */

test('card: all five priority levels exist and are distinct', () => {
  for (const p of ['urgent', 'high', 'medium', 'low', 'someday']) {
    assert.match(html, new RegExp(`\\.pri-${p}\\{`), `priority ${p} has no styling`);
    assert.ok(taskModal.includes(`'${p}'`), `priority ${p} is not offered in the editor`);
  }
  // Urgent must not be merely a darker high — it carries its own outline.
  // Anchored on `.task.pri-urgent`: `.un-pri.pri-urgent` also contains the
  // substring and is a different rule entirely.
  const at = html.indexOf('.task.pri-urgent{');
  assert.ok(at > -1, 'no urgent card rule');
  assert.match(html.slice(at, at + 300), /box-shadow:inset/,
    'urgent is not visually separated');
});

test('card: actions are vertically centred with the task row', () => {
  // E2.5 made `.task` a COLUMN — the task row, then its steps beneath it — so
  // the three-column grid and its centring moved to `.t-row`. Centring on
  // `.task` would now centre the steps panel against the row instead.
  assert.match(html, /\.t-row\{[^}]*align-items:center/, 'row contents are not centred');
  assert.match(html, /\.t-row\{display:grid;grid-template-columns:auto minmax\(0,1fr\) auto/,
    'the task row lost its three-column grid');
});

test('card: the move controls do not depend on hover', () => {
  assert.match(html, /@media \(hover:none\),\(pointer:coarse\),\(max-width:768px\)\{/,
    'no coarse-pointer fallback');
  const mq = html.slice(html.indexOf('@media (hover:none)'));
  assert.match(mq, /\.t-actions\{opacity:1\}/, 'actions stay hover-gated on touch');
});

test('card: small controls keep a 44px hit area on touch', () => {
  const mq = html.slice(html.indexOf('@media (hover:none)'));
  for (const sel of ['.t-tick', '.hb-ring', '.hb-add', '.m-tick', '.m-close']) {
    assert.ok(mq.includes(sel), `${sel} has no expanded hit area`);
  }
  assert.match(mq, /width:44px;height:44px;transform:translate\(-50%,-50%\)/,
    'the hit-area overlay is not 44px');
});

/* ── Habits ──────────────────────────────────────────────────────────── */

test('habits: the control is a ring, not a checkbox', () => {
  // C4.1 replaced the computed circumference with pathLength="100". Hard-coding
  // 2*PI*r was wrong — the browser's real Bezier path length is 81.155, not
  // 81.681 — so the constant it used to assert must NOT come back.
  assert.ok(!appCode.includes('RING_C'), 'the hard-coded circumference returned');
  assert.match(appCode, /pathLength="100"/, 'the ring does not declare its length');
  assert.match(appCode, /stroke-dashoffset/, 'the ring does not carry progress');
  assert.ok(appCode.includes('hr-fill') && appCode.includes('hr-track'),
    'the ring has no track/fill pair');
});

test('habits: partial progress shows for multi-count habits', () => {
  // The branch moved into habitPct() when check/undo were unified in C4.1.
  assert.match(appCode, /function habitPct/, 'no shared fill calculation');
  assert.match(appCode, /target > 1/, 'a 3-of-5 habit reads as all-or-nothing');
});

test('habits: the streak is shown and updates optimistically', () => {
  assert.ok(appCode.includes('hb-streak'), 'no streak display');
  assert.ok(appCode.includes('function patchHabit(id)'), 'the rail is rebuilt instead of patched');
  const t = appCode.indexOf('async function toggleHabit');
  const body = appCode.slice(t, t + 1200);
  assert.ok(body.includes('patchHabit(id)'), 'the toggle does not patch in place');
  assert.ok(/Object\.assign\(h, before\)/.test(body), 'a failed toggle does not roll back');
});

test('habits: an edit path exists outside Settings', () => {
  assert.ok(appCode.includes('function editHabit'), 'habits cannot be edited from the rail');
  assert.ok(habitModalCode.includes('onArchive') && habitModalCode.includes('onDelete'),
    'no archive/delete path');
  assert.ok(habitModal.includes('cannot be undone'), 'deletion is not warned about');
  // Archive must be the default; permanent deletion is the opt-in.
  assert.ok(appCode.includes('permanent=true'), 'delete is not explicitly permanent');
});

test('habits: a load failure never masquerades as an empty state', () => {
  assert.ok(appCode.includes('habitsError'), 'errors are swallowed into "no habits"');
  assert.ok(appCode.includes('hb-retry'), 'a failed load offers no retry');
});

/* ── Today: what was removed ─────────────────────────────────────────── */

test('today: Quick Capture is gone', () => {
  for (const marker of ['quick-capture', 'quickCapture', 'qc-input']) {
    assert.ok(!app.includes(marker), `Quick Capture survives as ${marker}`);
    assert.ok(!html.includes(marker), `Quick Capture styling survives as ${marker}`);
  }
});

test('today: Completed left the header but stayed reachable', () => {
  assert.ok(!appCode.includes('todayHeaderActions'), 'the header control survives');
  assert.ok(appCode.includes("'history'"), 'the Completed route was removed entirely');
});

test('today: Area filters are still there', () => {
  assert.ok(appCode.includes('rail-area') || appCode.includes('areaFilter')
    || html.includes('.rail-area'), 'the Area filter was dropped');
});

/* ── Decoration ──────────────────────────────────────────────────────── */

test('stars: ambient, inert, and stable', () => {
  const s = code(stars);
  assert.ok(s.includes('aria-hidden'), 'the star layer is announced to screen readers');
  // The layer's own rule lives in the stylesheet, not the module.
  const layer = html.slice(html.indexOf('#los-stars{'), html.indexOf('#los-stars{') + 220);
  assert.match(layer, /pointer-events:none/, 'the star layer can intercept clicks');
  assert.match(layer, /position:fixed/, 'the star layer is not a fixed backdrop');
  // A Math.random() field re-rolls on every render and shimmers.
  assert.ok(!s.includes('Math.random'), 'the sky is not seeded — it will shimmer');
  assert.ok(s.includes('function starPath') || s.includes('starPath'), 'stars are not drawn as stars');
});

test('stars: the layer does not create a stacking trap for fixed elements', () => {
  // Listing .modal in the z-index lift set `position:relative` on it, silently
  // overriding `position:fixed` and throwing the dialog 310px off centre.
  const lift = html.match(/\.shell[^{]*\{position:relative;z-index:1\}/);
  assert.ok(lift, 'the shell is not lifted above the stars');
  assert.ok(!/\.modal[^{]*\{position:relative/.test(html),
    '.modal is forced to position:relative — that breaks centring');
});
