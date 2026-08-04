/**
 * Phase E2.6 — ordered Steps and controlled parent completion.
 *
 * E2.5 gave Tasks inline Steps. It rendered them as a flat checklist, which is
 * not the product: Steps are an ORDERED SEQUENCE.
 *
 *   Today GUIDES.   One step is actionable, the next is a preview, the rest
 *                   wait, and the parent cannot be finished while any remain.
 *   The editor OVERRIDES. Every step is freely tickable, out of order, and the
 *                   parent can be completed early — with a real confirmation.
 *
 * The sequence is read from `task_steps.position`, a stored incrementing
 * column, never from creation time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const readWeb = (f: string) => readFileSync(join(here, '..', '..', 'web', f), 'utf8');
const strip = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
const appCode = strip(readWeb('app.js'));
const stepsCode = strip(readWeb('steps.js'));
const modalCode = strip(readWeb('task-modal.js'));
const css = readWeb('index.html');

function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `${decl} not found`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:async )?(?:export )?(?:function |const \w+ = )/);
  return end === -1 ? rest : rest.slice(0, end);
}

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused',
  FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = () => ({ authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'zander@example.com' });

async function setup() {
  const { db } = await freshDb();
  const app = buildApp(db, env);
  await app.ready();
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth() })).json();
  const ws = me.workspace.id;
  const areaId = me.areas.find((a: any) => a.name === 'Work').id;
  const base = `/api/v1/workspaces/${ws}`;
  const post = (url: string, payload?: any) =>
    app.inject({ method: 'POST', url: base + url, headers: auth(), payload: payload ?? {} });
  const patch = (url: string, payload: any) =>
    app.inject({ method: 'PATCH', url: base + url, headers: auth(), payload });
  const get = (url: string) => app.inject({ method: 'GET', url: base + url, headers: auth() });
  return { app, ws, areaId, post, patch, get };
}

async function withSteps(h: any, title: string, names: string[], over: any = {}) {
  const task = (await h.post('/tasks', { title, ...over })).json().task;
  for (const n of names) await h.post(`/tasks/${task.id}/steps`, { title: n });
  return (await h.get(`/tasks/${task.id}`)).json().task;
}

/* ── §1/§3  The stored order is the sequence ─────────────────────────── */

test('order: position is stored and incrementing, never creation time', async () => {
  const h = await setup();
  const t = await withSteps(h, 'Ordered', ['first', 'second', 'third']);
  assert.deepEqual(t.steps.map((s: any) => s.position), [0, 1, 2],
    'steps were not given incrementing positions');
  assert.deepEqual(t.steps.map((s: any) => s.title), ['first', 'second', 'third']);
});

test('order: a new step appends to the END of the sequence', async () => {
  const h = await setup();
  const t = await withSteps(h, 'Appending', ['a', 'b']);
  const added = (await h.post(`/tasks/${t.id}/steps`, { title: 'c' })).json().step;
  assert.equal(added.position, 2, 'a new step did not land at the end');
  const after = (await h.get(`/tasks/${t.id}`)).json().task;
  assert.deepEqual(after.steps.map((s: any) => s.title), ['a', 'b', 'c']);
});

test('order: the client sorts by position and never by array order', () => {
  const fn = body(stepsCode, 'export function orderedSteps(task)');
  assert.match(fn, /sort\(\(a, b\) => \(a\.position \?\? 0\) - \(b\.position \?\? 0\)\)/,
    'the sequence is not read from the stored position');
  // A copy, so a caller cannot reorder the record by sorting it.
  assert.match(fn, /\[\.\.\.\(task\?\.steps \?\? \[\]\)\]/);
});

/* ── §3  Current / next / later ──────────────────────────────────────── */

test('sequence: current is the FIRST incomplete step by order', () => {
  const fn = body(stepsCode, 'export function currentStep(task)');
  assert.match(fn, /orderedSteps\(task\)\.find\(\(s\) => !s\.completed\)/);
  const next = body(stepsCode, 'export function nextStep(task)');
  assert.match(next, /filter\(\(s\) => !s\.completed\)/);
  assert.match(next, /list\[1\]/, 'next is not the second incomplete step');
  const later = body(stepsCode, 'export function laterSteps(task)');
  assert.match(later, /\.slice\(2\)/);
});

test('sequence: a completed step AFTER the current one stays completed', () => {
  // The override case: someone ticked step 3 in the editor while 1 is current.
  // Today must keep guiding from 1 and must not undo their deliberate act.
  const fn = body(stepsCode, 'export function currentStep(task)');
  assert.ok(!/completed = false|\.forEach|splice/.test(fn),
    'the current-step calculation mutates the steps it is reading');
});

test('sequence: all complete means no current step, and ready to finish', () => {
  const fn = body(stepsCode, 'export function currentStep(task)');
  assert.match(fn, /\?\? null/, 'a fully complete task still reports a current step');
  const ready = body(stepsCode, 'export function readyToFinish(task)');
  assert.match(ready, /total > 0 && done === total/);
});

/* ── §4/§5  What Today draws, and what it lets you touch ─────────────── */

test('today: current is actionable, next is a preview, later is a count', () => {
  const fn = body(stepsCode, 'export function stepsPanelInnerHtml(task)');
  assert.match(fn, /ts-group-current/);
  assert.match(fn, /<span class="ts-label">Current<\/span>/);
  assert.match(fn, /<span class="ts-label">Next<\/span>/);
  assert.match(fn, /more step\$\{later\.length === 1 \? '' : 's'\}/,
    'later steps are not summarised as a count');

  const row = body(stepsCode, "function stepRowHtml(s, { state = 'plain', undoable = false } = {})");
  // A `next` step has NO toggle at all — not a disabled one that looks pressable.
  assert.match(row, /const locked = state === 'next'/);
  assert.match(row, /locked\s*\n?\s*\? `<span class="ts-tick is-locked"/,
    'the next step still renders a checkbox');
});

test('today: a locked step is a labelled button, never a bare padlock', () => {
  const row = body(stepsCode, "function stepRowHtml(s, { state = 'plain', undoable = false } = {})");
  assert.match(row, /ts-name-locked/, 'a locked step name is not focusable');
  assert.match(row, /not yet; open the task to do it out of order/,
    'the locked step does not explain itself');
  assert.ok(!/🔒|padlock|lock-icon/.test(stepsCode), 'an unexplained lock icon appeared');
  // And it is not a dead end.
  const wire = body(stepsCode, 'export function wireSteps(rowEl, task, ctx, { onChanged, onOpenTask } = {})');
  assert.match(wire, /\[data-step-later\], \[data-step-open\]/);
  assert.match(wire, /return onOpenTask\?\.\(\)/, 'a locked step silently does nothing');
});

test('today: the locked route reaches the right editor from each surface', () => {
  const card = body(appCode, 'function wireCardSteps(el, id)');
  assert.match(card, /onOpenTask: \(\) => openTask\(id\)/);
  const project = body(appCode, 'function wireProjectTaskRows(project)');
  assert.match(project, /onOpenTask: \(\) => openProjectTask\(id\)/);
});

/* ── §6  Undoing a completed step ────────────────────────────────────── */

test('undo: only the step immediately before current may be undone inline', () => {
  const fn = body(stepsCode, 'export function undoableStep(task)');
  assert.match(fn, /const currentAt = list\.findIndex\(\(s\) => !s\.completed\)/);
  assert.match(fn, /currentAt === -1 \? list\[list\.length - 1\] : list\[currentAt - 1\]/,
    'the undoable step is not the one immediately before current');
  assert.match(fn, /before\?\.completed \? before : null/);

  // Every other completed step renders a disabled tick that says where to go.
  const row = body(stepsCode, "function stepRowHtml(s, { state = 'plain', undoable = false } = {})");
  assert.match(row, /state === 'done' && undoable/, 'any completed step can be undone inline');
  assert.match(row, /Open the task to change an earlier step/);
});

/* ── §7  Parent completion on Today ──────────────────────────────────── */

test('parent: the reason is a sentence, carried where it can be read', () => {
  const fn = body(stepsCode, 'export function parentBlockedReason(task)');
  assert.match(fn, /Complete the remaining \$\{remaining\} step/);
  assert.match(fn, /remaining === 1 \? '' : 's'/, 'the message is not singular-safe');
  assert.match(fn, /if \(!remaining\) return null/);

  const tick = body(appCode, 'function parentTickHtml(t)');
  assert.match(tick, /disabled/, 'the blocked control is still pressable');
  assert.match(tick, /aria-label="\$\{esc\(blocked\)\}" title="\$\{esc\(blocked\)\}"/,
    'the reason is not available to a screen reader or on hover');
  // Not hover-only, and not colour-only: the count is rendered as text.
  assert.match(tick, /t-tick-count/);
});

test('parent: the rule is enforced at the write, not only at the control', () => {
  // `Space` on a focused card reaches toggleTask directly, bypassing a disabled
  // button entirely.
  const today = body(appCode, 'async function toggleTask(id, dirty = null)');
  assert.match(today, /const blocked = parentBlockedReason\(t\)/);
  assert.match(today, /if \(blocked\) return toast\(/, 'Today can still complete past its steps');
  assert.match(today, /if \(!wasDone\)/, 'reopening a completed task is being blocked too');

  const project = body(appCode, 'async function completeProjectTask(taskId, dirty = null)');
  assert.match(project, /const blocked = parentBlockedReason\(task\)/,
    'Project detail does not enforce the sequence');
});

test('parent: a task with NO steps completes normally', async () => {
  const h = await setup();
  const t = (await h.post('/tasks', { title: 'Plain task', bucket: 'today' })).json().task;
  const r = (await h.post(`/tasks/${t.id}/complete`)).json();
  assert.equal(r.task.status, 'done', 'a task with no steps was blocked');
});

test('parent: the tick re-renders when the sequence unblocks it', () => {
  const fn = body(stepsCode, 'export function repaintSteps(rowEl, task)');
  assert.match(fn, /const wasBlocked = !!rowEl\.querySelector\('\.t-tick'\)\?\.disabled/);
  assert.match(fn, /if \(wasBlocked !== !!parentBlockedReason\(task\)\) return true/,
    'finishing the last step leaves the parent control stale');
});

/* ── §8/§9  The editor is the override surface ───────────────────────── */

test('override: the editor keeps a flat list where every step is tickable', () => {
  // `stepRow` in the modal is deliberately NOT the guided `stepRowHtml`.
  assert.match(modalCode, /const stepRow = \(s\) =>/);
  const row = body(modalCode, 'const stepRow = (s) =>');
  assert.ok(!/is-locked|ts-name-locked|disabled/.test(row),
    'the editor locks steps, so there is nowhere left to override the sequence');
});

test('override: completing out of order explains what Today will do', () => {
  assert.match(modalCode, /Completed out of order — Today still guides from the earliest unfinished step\./);
  // Said only when it is actually out of order, and never blocking.
  assert.match(modalCode, /const ahead = turningOn &&/);
  assert.ok(!/confirm\(.*out of order/i.test(modalCode),
    'deliberate editing in the full detail is being blocked');
});

test('override: completing a parent with open steps asks first', () => {
  const fn = body(modalCode, "dlg.querySelector('#m-toggle').onclick = async () =>");
  assert.match(fn, /const open = \(ctx\.task\?\.steps \?\? \[\]\)\.filter\(\(x\) => !x\.completed\)/);
  assert.match(fn, /const go = await confirmOverride\(dlg, open\.length\)/,
    'the parent completes silently while steps are unfinished');
  assert.match(fn, /if \(!go\) return;/, 'declining still completes the task');
  // Then every remaining step is completed, before the parent.
  const stepsAt = fn.indexOf('await ctx.steps.toggle(st.id, true)');
  const parentAt = fn.indexOf('await ctx.onToggle(');
  assert.ok(stepsAt > -1 && stepsAt < parentAt,
    'the parent completes before its remaining steps');
});

test('override: the confirmation offers no leave-steps-open escape hatch', () => {
  const fn = body(modalCode, 'function confirmOverride(dlg, count)');
  assert.match(fn, /Complete task and mark all steps complete/);
  assert.match(fn, /Go back/);
  // A completed task with unfinished steps is a self-contradicting record.
  assert.ok(!/leave (the )?steps|without completing/i.test(fn));
  assert.match(fn, /e\.key === 'Escape'/, 'the question cannot be dismissed');
  assert.match(fn, /aria-modal', 'true'/);
});

test('override: the confirmation does not break the modal it sits over', () => {
  // `.modal` is position:fixed centred by transform. Giving it position:relative
  // to contain an absolute overlay silently threw it 310px off centre once
  // already — so the overlay is fixed and needs no containing block.
  assert.match(css, /\.m-confirm\{position:fixed;inset:0/);
  assert.ok(!/\.modal[^{]*\{position:relative/.test(css),
    '.modal is forced to position:relative again');
});

test('override: the parent completes once, with every step complete', async () => {
  const h = await setup();
  const t = await withSteps(h, 'Override me', ['a', 'b', 'c'], { bucket: 'today' });
  // What the confirmed override does, in order: steps, then the parent.
  for (const s of t.steps) await h.patch(`/tasks/${t.id}/steps/${s.id}`, { completed: true });
  const r = (await h.post(`/tasks/${t.id}/complete`)).json();

  assert.equal(r.task.status, 'done');
  const after = (await h.get(`/tasks/${t.id}`)).json().task;
  assert.ok(after.steps.every((s: any) => s.completed),
    'a completed task was left holding unfinished steps');
  assert.deepEqual(after.steps.map((s: any) => `${s.position}:${s.title}`),
    ['0:a', '1:b', '2:c'], 'step text or order changed during the override');
});

/* ── §11  Adding a step ──────────────────────────────────────────────── */

test('add: a new step on a ready task becomes current and re-blocks the parent', async () => {
  const h = await setup();
  const t = await withSteps(h, 'Ready then not', ['a', 'b'], { bucket: 'today' });
  for (const s of t.steps) await h.patch(`/tasks/${t.id}/steps/${s.id}`, { completed: true });

  const ready = (await h.get(`/tasks/${t.id}`)).json().task;
  assert.ok(ready.steps.every((s: any) => s.completed));

  await h.post(`/tasks/${t.id}/steps`, { title: 'c' });
  const after = (await h.get(`/tasks/${t.id}`)).json().task;
  const open = after.steps.filter((s: any) => !s.completed);
  assert.equal(open.length, 1);
  assert.equal(open[0].title, 'c', 'the new step is not the one left to do');
  assert.equal(open[0].position, 2, 'the new step was not appended to the end');
});

test('add: failure returns the text and keeps the panel open', () => {
  const wire = body(stepsCode, 'export function wireSteps(rowEl, task, ctx, { onChanged, onOpenTask } = {})');
  assert.match(wire, /if \(box\) box\.value = v;/, 'a failed add discards the typed text');
  assert.match(wire, /fail\(rowEl, err\.message\)/, 'the failure is silent');
  assert.ok(!/panel\.hidden = true/.test(wire), 'a failed add collapses the panel');
});

/* ── §13/§15  Hierarchy and accessibility ────────────────────────────── */

test('visual: three levels, and only the current step carries weight', () => {
  assert.match(css, /\.ts-current\{/, 'the current step has no distinct treatment');
  assert.match(css, /\.ts-done-list \.ts-row\{opacity:\.72\}/, 'completed steps are not quieter');
  assert.match(css, /\.ts-group-current \.ts-label\{color:var\(--accent\)\}/);
  // A dashed outline, not a filled grey box that reads as broken.
  assert.match(css, /\.ts-tick\.is-locked\{[^}]*dashed/);
  assert.ok(!/\.ts-next[^{]*\{[^}]*background:var\(--danger\)/.test(css));
});

test('a11y: the sequence is never carried by colour alone', () => {
  const fn = body(stepsCode, 'export function stepsPanelInnerHtml(task)');
  // The words "Current" and "Next" are rendered as text, not implied by hue.
  assert.match(fn, />Current</);
  assert.match(fn, />Next</);
  const row = body(stepsCode, "function stepRowHtml(s, { state = 'plain', undoable = false } = {})");
  assert.match(row, /aria-label="\$\{s\.completed/, 'step ticks have no accessible label');
  assert.match(row, /Mark done: \$\{esc\(s\.title\)\}/);
  assert.match(row, /Undo: \$\{esc\(s\.title\)\}/);
});

test('a11y: the ready state is announced, not merely styled', () => {
  assert.match(stepsCode, /class="ts-ready" role="status"/,
    'reaching ready-to-finish is silent to a screen reader');
});

/* ── §18  Safety ─────────────────────────────────────────────────────── */

test('safety: no Boards, no Google writes, no Legacy migration', () => {
  const web = ['app.js', 'steps.js', 'task-modal.js', 'projects.js'].map(readWeb).join('\n');
  assert.ok(!/data-board|class="board|openBoard\(/.test(web), 'Board UI appeared');
  assert.ok(!/googleapis\.com\/calendar\/v3[^'"]*',\s*\{\s*method:\s*'(POST|PUT|PATCH|DELETE)/
    .test(web), 'a Google Calendar write appeared');
  assert.ok(!/legacyImport|migrateLegacyProjects/.test(web), 'legacy migration appeared');
});

test('safety: habits and calendar still work', async () => {
  const h = await setup();
  const habit = (await h.post('/habits', { name: 'Walk' })).json().habit;
  await h.post(`/habits/${habit.id}/check`, { date: '2026-08-03' });
  const hist = (await h.get('/habits/history?from=2026-08-03&to=2026-08-03')).json();
  assert.equal(hist.days[0].done, 1);
  const range = (await h.get('/calendar/range?from=2026-08-01&to=2026-08-07')).json();
  assert.ok(Array.isArray(range.habitDays));
});

test('safety: project progress still counts parent tasks only', async () => {
  const h = await setup();
  const project = (await h.post('/projects', {
    title: 'Counting', outcome: 'Done', areaId: h.areaId, focus: 'now',
  })).json().project;
  const t = await withSteps(h, 'Sequenced', ['a', 'b', 'c'], { projectId: project.id });
  for (const s of t.steps) await h.patch(`/tasks/${t.id}/steps/${s.id}`, { completed: true });
  const p = (await h.get(`/projects/${project.id}`)).json().project;
  assert.deepEqual({ done: p.progress.done, total: p.progress.total }, { done: 0, total: 1 },
    'a fully stepped but incomplete task counted as project progress');
});
