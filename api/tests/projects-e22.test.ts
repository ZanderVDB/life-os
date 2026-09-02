/**
 * Phase E2.2 — next-action integrity and the duplicated task row.
 *
 * The duplication was reported as "the task might have been duplicated in the
 * data", so the first thing here is a test that answers that question rather
 * than an assurance that it did not happen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, and } from 'drizzle-orm';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { tasks } from '../src/db/schema.js';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const strip = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
const appCode = strip(read('app.js'));
const pjCode = strip(read('projects.js'));
const dragCode = strip(read('drag.js'));
const modalCode = strip(read('project-modal.js'));
const css = strip(read('index.html') + read('app.css'));

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
  const del = (url: string) => app.inject({ method: 'DELETE', url: base + url, headers: auth() });
  const get = (url: string) => app.inject({ method: 'GET', url: base + url, headers: auth() });

  const project = (await post('/projects', {
    title: 'P', outcome: 'o', areaId, focus: 'now',
  })).json().project;
  const add = async (title: string, over: any = {}) => {
    const t = (await post('/tasks', { title, ...over })).json().task;
    await post(`/projects/${project.id}/tasks`, { taskId: t.id });
    return t;
  };
  return { app, db, ws, areaId, project, post, patch, del, get, add };
}

/* ── Was anything actually duplicated? ───────────────────────────────── */

test('integrity: choose + reorder together never duplicates a task record', async () => {
  // The question the report raised. Answered against the database, not assumed.
  const { db, ws, project, post, get, add } = await setup();
  const a = await add('A');
  const b = await add('B');

  // The exact overlap: a next-action write and a reorder, interleaved.
  await Promise.all([
    post(`/projects/${project.id}/next-action`, { taskId: b.id }),
    post(`/projects/${project.id}/tasks/${b.id}/reorder`, { to: 'top' }),
  ]);
  // …and repeated, because a duplicate would compound.
  for (let i = 0; i < 5; i++) {
    await Promise.all([
      post(`/projects/${project.id}/next-action`, { taskId: a.id }),
      post(`/projects/${project.id}/tasks/${a.id}/reorder`, { to: 'bottom' }),
    ]);
  }

  const rows = await db.select().from(tasks).where(eq(tasks.workspaceId, ws));
  assert.equal(rows.length, 2, 'a task record was duplicated');
  assert.equal(new Set(rows.map((r: any) => r.id)).size, 2);
  // Exactly one row per project position holder — no phantom ordering rows.
  const inProject = (await get(`/projects/${project.id}`)).json().tasks;
  assert.equal(inProject.length, 2);
  assert.equal(new Set(inProject.map((t: any) => t.id)).size, 2,
    'the project returned the same task twice');
});

test('integrity: repeated next-action writes are idempotent', async () => {
  const { project, post, get, add } = await setup();
  const a = await add('A');
  for (let i = 0; i < 4; i++) await post(`/projects/${project.id}/next-action`, { taskId: a.id });
  const r = (await get(`/projects/${project.id}`)).json();
  assert.equal(r.tasks.length, 1);
  assert.equal(r.project.nextTaskId, a.id);
});

/* ── Next-action invalidation ────────────────────────────────────────── */

test('invalidation: an explicit choice clears when it stops being eligible', async () => {
  const { app, ws, project, post, patch, del, get, add } = await setup();
  const keep = await add('Keep');

  const cases: [string, () => Promise<unknown>][] = [
    ['completed', async () => {
      const t = await add('Done it');
      await post(`/projects/${project.id}/next-action`, { taskId: t.id });
      return app.inject({
        method: 'PATCH', url: `/api/v1/workspaces/${ws}/tasks/${t.id}`,
        headers: auth(), payload: { status: 'done' },
      });
    }],
    ['cancelled', async () => {
      const t = await add('Not doing it');
      await post(`/projects/${project.id}/next-action`, { taskId: t.id });
      return app.inject({
        method: 'PATCH', url: `/api/v1/workspaces/${ws}/tasks/${t.id}`,
        headers: auth(), payload: { status: 'cancelled' },
      });
    }],
    ['removed from the project', async () => {
      const t = await add('Removed');
      await post(`/projects/${project.id}/next-action`, { taskId: t.id });
      return del(`/projects/${project.id}/tasks/${t.id}`);
    }],
    ['deleted', async () => {
      const t = await add('Deleted');
      await post(`/projects/${project.id}/next-action`, { taskId: t.id });
      return app.inject({
        method: 'DELETE', url: `/api/v1/workspaces/${ws}/tasks/${t.id}`, headers: auth(),
      });
    }],
  ];

  for (const [name, run] of cases) {
    await run();
    const r = (await get(`/projects/${project.id}`)).json();
    assert.ok(r.project, `the project broke after its next action was ${name}`);
    assert.notEqual(r.project.nextAction?.explicit, true,
      `an explicit next action survived being ${name}`);
    // The fallback still answers, and it is the remaining open task.
    assert.equal(r.project.nextAction?.id, keep.id,
      `inference did not fall back after the choice was ${name}`);
  }
});

test('invalidation: a task moved to another project stops being next', async () => {
  const { project, post, get, add, areaId } = await setup();
  const other = (await post('/projects', {
    title: 'Other', outcome: 'o', areaId, focus: 'now',
  })).json().project;
  const keep = await add('Keep');
  const moving = await add('Moving');
  await post(`/projects/${project.id}/next-action`, { taskId: moving.id });

  await post(`/projects/${other.id}/tasks`, { taskId: moving.id });

  const r = (await get(`/projects/${project.id}`)).json();
  assert.notEqual(r.project.nextAction?.explicit, true,
    'the next action still points at a task in another project');
  assert.equal(r.project.nextAction?.id, keep.id);
});

test('invalidation: an ineligible task is refused as a choice', async () => {
  const { app, ws, project, post, add } = await setup();
  const t = await add('Done');
  await app.inject({
    method: 'PATCH', url: `/api/v1/workspaces/${ws}/tasks/${t.id}`,
    headers: auth(), payload: { status: 'done' },
  });
  const r = await post(`/projects/${project.id}/next-action`, { taskId: t.id });
  assert.equal(r.statusCode, 400, 'a completed task was accepted as the next action');
});

/* ── Choose: the trigger ─────────────────────────────────────────────── */

test('choose: opens a picker instead of writing null and rebuilding the page', () => {
  // THE DEFECT: the button labelled "Choose" was the CLEAR button wearing a
  // second label. It POSTed `taskId: null` — a no-op when the action was already
  // inferred — and then reloaded the whole detail body.
  assert.ok(!/id="pjd-next-clear"/.test(pjCode),
    'the clear button is still doing double duty as Choose');
  assert.match(pjCode, /id="pjd-next-choose"/, 'there is no Choose trigger');
  assert.match(appCode, /async function chooseNextAction\(project\)/, 'Choose opens nothing');
  const fn = body(appCode, 'async function chooseNextAction(project)');
  assert.match(fn, /openTaskPicker\(\{/, 'Choose does not open a picker');
  assert.ok(!/reloadProjectDetail/.test(fn), 'Choose still rebuilds the detail page');
});

test('choose: every trigger is type="button", so nothing can submit a form', () => {
  const slot = body(pjCode, 'export function nextActionSlotHtml(p)');
  const buttons = [...slot.matchAll(/<button([^>]*)>/g)].map((m) => m[1]!);
  assert.ok(buttons.length > 0);
  for (const attrs of buttons) {
    assert.match(attrs, /type="button"/, `a next-action button has no explicit type: ${attrs}`);
  }
});

test('choose: the picker shows only this project\'s open tasks, and explains both modes', () => {
  const fn = body(appCode, 'async function chooseNextAction(project)');
  assert.match(fn, /pj\.detail\?\.tasks \?\? \[\]\)\.filter\(\(t\) => t\.status === 'open'\)/,
    'the picker is not restricted to open tasks in this project');
  assert.match(fn, /autoOption:/, 'there is no way back to automatic');
  assert.match(fn, /hint:/, 'the two modes are not explained');
  assert.match(fn, /until it is done, removed or/, 'explicit mode is not described');
  assert.match(fn, /Due date, then priority, then order/, 'automatic mode is not described');
  assert.match(fn, /if \(chosen === null\) return;/, 'cancelling still writes');
  // No raw ids, no completed tasks, no other projects — all follow from the
  // source list plus the picker rendering titles.
  assert.ok(!/\$\{t\.id\}<\/span>/.test(modalCode), 'the picker renders raw ids');
});

/* ── No rebuild, no duplicate node ───────────────────────────────────── */

test('next action: saving patches one slot and leaves the task list mounted', () => {
  const fn = body(appCode, 'async function setProjectNextAction(taskId)');
  assert.match(fn, /patchNextActionSlot\(\)/, 'the slot is not patched');
  assert.ok(!/reloadProjectDetail/.test(fn), 'saving rebuilds the whole detail page');
  assert.match(fn, /if \(!project \|\| nextActionSaving\) return;/,
    'a second Choose submission can race the first');
  // Failure restores exactly what was there, and says so.
  assert.match(fn, /slot\.innerHTML = before/, 'a failed save leaves the slot wrong');
  assert.match(fn, /toast\(e\.message, true\)/, 'a failed save is silent');
  const patch = body(appCode, 'function patchNextActionSlot()');
  assert.match(patch, /fill: 'forwards'/, 'the crossfade reverts and flashes the old value');
  assert.ok(!/pjd-tasks/.test(patch), 'patching the slot touches the task list');
});

test('next action: the slot renders its own node, never the task list row', () => {
  // If the slot reused or moved the list's row, the same task would exist once
  // in two places — which is precisely the duplication that was reported.
  const slot = body(pjCode, 'export function nextActionSlotHtml(p)');
  assert.match(slot, /class="pjd-next-open"/, 'the slot has no presentation node of its own');
  assert.ok(!/class="task"/.test(slot), 'the slot renders a task-list row');
  assert.ok(!/appendChild|querySelector/.test(slot), 'the slot moves an existing node');
});

test('drag: a list rebuilt mid-drag can never leave a ghost row', () => {
  // The mechanism: the dragged card is parked on document.body, so replacing
  // the list destroys the placeholder and strands the card, and `replaceWith`
  // on a detached node is a silent no-op.
  assert.match(dragCode, /document\.body\.appendChild\(card\)/,
    'the drag no longer parks the card on body — this test needs rewriting');
  assert.match(dragCode, /const orphaned = \(s\) => !s\.ph\.isConnected/,
    'the drag cannot detect that the list was rebuilt underneath it');
  const reclaim = body(dragCode, 'function reclaimOrphan(s)');
  assert.match(reclaim, /querySelector\(`\.drop \.task\[data-id="\$\{s\.id\}"\]`\)/,
    'orphan recovery does not check whether a live row already exists');
  assert.match(reclaim, /s\.card\.remove\(\)/, 'the stranded card is never removed');
  assert.match(reclaim, /s\.ph\.remove\(\)/, 'the placeholder is never cleaned up');
  // Both exit paths check it.
  for (const fn of ['function finish(hooks)', 'function abort()']) {
    assert.match(body(dragCode, fn), /orphaned\(s\)/, `${fn} does not check for a rebuilt list`);
  }

  // …and `orphaned` alone is NOT enough, which is the subtle half. The next
  // pointermove moves the placeholder into the NEW list, so by drop time it is
  // connected again and the dragged card lands beside its own twin. Verified in
  // a browser: rebuild mid-drag then move → the list ended
  // ['t1','t2','t3','t2'] before this check existed.
  assert.match(dragCode, /function strayTwin\(s\)/,
    'a re-attached placeholder still lets the dragged card land beside its twin');
  for (const fn of ['function finish(hooks)', 'function abort()']) {
    assert.match(body(dragCode, fn), /twin\?\.remove\(\)/, `${fn} leaves the twin in place`);
  }
});

test('drag: a detail rebuild is refused while a drag is in flight', () => {
  const fn = body(appCode, 'function reloadProjectDetail()');
  assert.match(fn, /if \(isDragging\(\)\) return/,
    'the detail page can be rebuilt out from under a drag');
});

test('integrity: one row per task id is an invariant, checked and repaired', () => {
  assert.match(appCode, /function assertOneRowPerTask\(host\)/, 'there is no invariant');
  const fn = body(appCode, 'function assertOneRowPerTask(host)');
  assert.match(fn, /row\.remove\(\)/, 'the invariant complains but does not repair');
  assert.match(fn, /console\.warn/, 'a duplicate is repaired silently, so it goes unnoticed');
  // Checked after both reconciliation paths.
  assert.match(body(appCode, 'function patchProjectTaskOrder()'), /assertOneRowPerTask/);
  assert.match(appCode, /assertOneRowPerTask\(document\.getElementById\('pjd-tasks'\)\)/,
    'a full detail render does not check the invariant');
  // …and the data is deduped before it can produce two rows.
  assert.match(body(appCode, 'function patchProjectTaskOrder()'),
    /!seen\.has\(t\.id\) && seen\.add\(t\.id\)/, 'a stale response can repeat a task');
});

/* ── Group colour ────────────────────────────────────────────────────── */

test('groups: every group is labelled in text, colour is only a second cue', () => {
  // The label comes from the server's group label and is always rendered.
  assert.match(pjCode, /<h2 class="pj-group-h">\$\{esc\(g\.label\)\}<\/h2>/,
    'a group can render without a text label');
  // The colour lives on a 3px mark beside the heading, not on whole cards.
  assert.match(css, /\.pj-group-h::before\{content:""/, 'there is no heading mark');
  assert.match(css, /width:3px/, 'the group mark is not a restrained rule');
});

test('groups: the semantic colours are the app\'s existing ones', () => {
  const pairs: [string, string][] = [
    ['attention', 'var(--warn)'],
    ['now', 'var(--accent)'],
    ['upcoming', 'var(--p-low)'],
    ['on_hold', 'var(--muted)'],
    ['recent', 'var(--ok)'],
  ];
  for (const [group, token] of pairs) {
    const rule = new RegExp(`\\.pj-group\\[data-group="${group}"\\] \\.pj-group-h::before\\{background:${
      token.replace(/[()-]/g, (c) => `\\${c}`)}\\}`);
    assert.match(css, rule, `${group} does not use ${token}`);
  }
  // Green means completion and nothing else; red is not used for ordinary
  // attention, which is amber.
  assert.ok(!/\.pj-group\[data-group="(now|upcoming|on_hold|attention)"\][^}]*var\(--ok\)/.test(css),
    'green is used for something other than completion');
  assert.ok(!/\.pj-group\[data-group="attention"\][^}]*var\(--danger\)/.test(css),
    'ordinary attention is red rather than amber');
});

test('groups: the row tint is a hint, never a coloured card', () => {
  // Two decimal places of alpha. Anything heavier turns a calm list into five
  // competing blocks.
  /* The colour may be literal channels or a token — `rgba(var(--accent-rgb),
     .05)`. Only the ALPHA is the rule here, so the channels are matched
     loosely and the alpha precisely. */
  const tints = [...css.matchAll(/\.pj-group\[data-group="[^"]+"\] \.pj-row\{background:\s*linear-gradient\(0deg, rgba\((?:[\d\s,]+?|var\(--[a-z-]+\)),\s*\.(\d+)\)/g)]
    .map((m) => Number(`0.${m[1]}`));
  assert.ok(tints.length >= 2, 'no group tint is applied at all');
  for (const a of tints) {
    assert.ok(a <= 0.08, `a group tint of ${a} is strong enough to read as a coloured card`);
  }
  // On hold and Recently completed are secondary, not disabled.
  assert.match(css, /\.pj-group\[data-group="on_hold"\] \.pj-row,\s*\.pj-group\[data-group="recent"\] \.pj-row\{background:var\(--surface\)\}/,
    'secondary groups are tinted or dimmed rather than simply quiet');
  assert.ok(!/\.pj-group\[data-group="(on_hold|recent)"\][^}]*opacity:/.test(css),
    'a secondary group is dimmed, which reads as disabled');
});

test('groups: the cue survives a narrow viewport without thick borders', () => {
  const mobile = css.slice(css.indexOf('@media (max-width:900px)'));
  assert.match(mobile, /\.pj-group-h\{padding-left:10px\}/, 'the group mark is lost on mobile');
  assert.ok(!/\.pj-row\{[^}]*border-left:\s*[4-9]px/.test(css),
    'a thick coloured card border was introduced');
});
