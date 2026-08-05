/**
 * Phase E2.8 — Today task separation and daily arrangement.
 *
 * Two ideas, and the second only works because of the first:
 *
 *   SEPARATION. A bucket shows standalone work and project work as two runs of
 *   cards under adaptive headings. The tasks stay DIRECT children of the drop
 *   zone, because the drag code inserts relative to direct children.
 *
 *   ARRANGEMENT. Once per local calendar day, standalone tasks are put into a
 *   recommended order. Project tasks are never touched — their order can encode
 *   a dependency someone chose on purpose.
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
const dragCode = strip(readWeb('drag.js'));
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
  const get = (url: string) => app.inject({ method: 'GET', url: base + url, headers: auth() });
  return { app, ws, areaId, post, get };
}

/* The comparator is a pure module with no DOM, so it is imported and RUN
 * rather than pattern-matched. A sort rule asserted by regex is a rule nobody
 * has actually executed. */
const arrange = await import('../../web/arrange.js' as string);

const task = (over: any = {}) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  title: over.title ?? 'T', projectId: null, priority: 'medium',
  scheduledAt: null, dueDate: null, position: 0, ...over,
});
const NOW = new Date('2026-08-05T09:00:00');
const at = (h: number) => new Date(`2026-08-05T${String(h).padStart(2, '0')}:00:00`).toISOString();

/* ── §4  Standalone detection ────────────────────────────────────────── */

test('standalone: only a null project makes a task standalone', () => {
  assert.equal(arrange.isStandalone(task()), true);
  assert.equal(arrange.isStandalone(task({ projectId: 'p1' })), false);
  // Not "the project is on hold", not "it is not the next action" — the field.
  assert.equal(arrange.isStandalone(task({ projectId: 'p1', priority: 'urgent' })), false);
});

test('standalone: an unresolvable project stays PROJECT work', () => {
  const list = [task({ id: 'a' }), task({ id: 'b', projectId: 'gone' })];
  const { standalone, project, unresolved } = arrange.partition(list, {});
  assert.deepEqual(standalone.map((t: any) => t.id), ['a']);
  assert.deepEqual(project.map((t: any) => t.id), ['b'],
    'a task whose project failed to load fell through to standalone');
  assert.equal(unresolved, 1, 'the failure is not reported');
});

test('ui: an unresolvable project says so rather than rendering nothing', () => {
  const fn = body(appCode, 'function taskHtml(t)');
  assert.match(fn, /else if \(t\.projectId\)/, 'a task with an unloadable project renders bare');
  assert.match(fn, /Project unavailable/);
  assert.match(css, /\.tm-project\.is-missing\{/);
});

/* ── §2/§16  Adaptive subsections ────────────────────────────────────── */

test('ui: headings appear only where they separate something', () => {
  const fn = body(appCode, 'function bucketInnerHtml(list)');
  assert.match(fn, /const bothKinds = standalone\.length > 0 && project\.length > 0/);
  assert.match(fn, /if \(bothKinds\) out\.push\(subHeadHtml\('tasks', 'Tasks'\)\)/,
    'TASKS shows even when there is no project work to separate it from');
  assert.match(fn, /if \(project\.length\) out\.push\(subHeadHtml\('projects', 'Projects'\)\)/);
});

test('ui: the tasks stay DIRECT children of the drop zone', () => {
  const fn = body(appCode, 'function bucketInnerHtml(list)');
  // A wrapper per subsection would break drag: `zone.insertBefore(ph, card)`
  // needs `card` to be a direct child, and querySelectorAll matches any depth.
  assert.ok(!/<div class="sub-section|<section/.test(fn),
    'the rows were wrapped, which breaks insertBefore in drag.js');
  assert.match(fn, /out\.push\(\.\.\.standalone\.map\(\(t\) => taskHtml\(t\)\)\)/);
  assert.match(fn, /out\.push\(\.\.\.project\.map\(\(t\) => taskHtml\(t\)\)\)/);
});

test('ui: the drawn order matches the partition, so a rebuild cannot reshuffle', () => {
  const fn = body(appCode, 'const inBucket = (b) =>');
  assert.match(fn, /\[\.\.\.standalone, \.\.\.project\]/);
  // Position still decides WITHIN a group — the partition is display only.
  assert.match(fn, /\.sort\(\(x, y\) => x\.position - y\.position\)/);
});

/* ── §10  Drag stays inside its subsection ───────────────────────────── */

test('drag: a card can only be dropped among its own kind', () => {
  const fn = body(dragCode, 'function updateInsertion(x, y)');
  assert.match(fn, /sectionOf\(c\) === kind/,
    'a standalone task can still be dropped among project rows');
  assert.match(fn, /if \(!before && cards\.length\)/,
    'dragging past the last card of a section falls through to the whole zone');
  const section = body(dragCode, 'function sectionOf(card)');
  assert.match(section, /card\.dataset\.project \? 'project' : 'standalone'/);
  // Fixed at lift: "the section above me" changes as the placeholder moves.
  assert.match(dragCode, /kind: sectionOf\(card\)/);
});

/* ── §6  The comparator, executed ────────────────────────────────────── */

test('sort: a scheduled block beats priority', () => {
  const low2pm = task({ id: 'low2pm', scheduledAt: at(14), priority: 'low' });
  const urgent4pm = task({ id: 'urgent4pm', scheduledAt: at(16), priority: 'urgent' });
  const out = arrange.arrangeStandalone([urgent4pm, low2pm], NOW);
  assert.deepEqual(out.map((t: any) => t.id), ['low2pm', 'urgent4pm'],
    '14:00 must come before 16:00 whatever the priority says');
});

test('sort: a due date is NOT treated as a scheduled start', () => {
  const scheduled = task({ id: 'sched', scheduledAt: at(16), priority: 'low' });
  const dueToday = task({ id: 'due', dueDate: '2026-08-05', priority: 'urgent' });
  const out = arrange.arrangeStandalone([dueToday, scheduled], NOW);
  assert.deepEqual(out.map((t: any) => t.id), ['sched', 'due'],
    'a date-only task jumped ahead of work someone actually blocked time for');
});

test('sort: due today beats due tomorrow, and both beat undated', () => {
  const out = arrange.arrangeStandalone([
    task({ id: 'undated' }),
    task({ id: 'tomorrow', dueDate: '2026-08-06' }),
    task({ id: 'today', dueDate: '2026-08-05' }),
  ], NOW);
  assert.deepEqual(out.map((t: any) => t.id), ['today', 'tomorrow', 'undated']);
});

test('sort: overdue sits between due and undated, oldest first', () => {
  const out = arrange.arrangeStandalone([
    task({ id: 'undated' }),
    task({ id: 'old', dueDate: '2026-07-01' }),
    task({ id: 'recent', dueDate: '2026-08-04' }),
    task({ id: 'duetoday', dueDate: '2026-08-05' }),
  ], NOW);
  assert.deepEqual(out.map((t: any) => t.id), ['duetoday', 'old', 'recent', 'undated'],
    'overdue ordering is not oldest-first, or it outranked work still due');
});

test('sort: priority decides only when dates tie', () => {
  const out = arrange.arrangeStandalone([
    task({ id: 'low', priority: 'low' }),
    task({ id: 'urgent', priority: 'urgent' }),
    task({ id: 'medium', priority: 'medium' }),
    task({ id: 'high', priority: 'high' }),
  ], NOW);
  assert.deepEqual(out.map((t: any) => t.id), ['urgent', 'high', 'medium', 'low']);
});

test('sort: a full tie keeps the previous manual order, and is stable', () => {
  const list = ['c', 'a', 'b'].map((id) => task({ id, priority: 'medium' }));
  const once = arrange.arrangeStandalone(list, NOW);
  assert.deepEqual(once.map((t: any) => t.id), ['c', 'a', 'b'],
    'tasks that tie on everything were reshuffled');
  // Deterministic: running it again changes nothing.
  const twice = arrange.arrangeStandalone(once, NOW);
  assert.deepEqual(twice.map((t: any) => t.id), once.map((t: any) => t.id));
});

test('sort: the input array is never sorted in place', () => {
  const list = [task({ id: 'b', priority: 'low' }), task({ id: 'a', priority: 'urgent' })];
  arrange.arrangeStandalone(list, NOW);
  assert.deepEqual(list.map((t: any) => t.id), ['b', 'a'],
    'the caller lost the previous order it needs for Undo');
});

test('sort: a scheduled block already in the past is not a commitment', () => {
  const past = task({ id: 'past', scheduledAt: at(7), priority: 'low' });
  const urgent = task({ id: 'urgent', priority: 'urgent' });
  const out = arrange.arrangeStandalone([past, urgent], NOW);
  assert.deepEqual(out.map((t: any) => t.id), ['urgent', 'past']);
});

/* ── §8/§9  What it never touches ────────────────────────────────────── */

test('exclusion: only the standalone partition is sorted', () => {
  const fn = body(appCode, 'async function arrangeToday({ manual = false, claimedDate = null } = {})');
  assert.match(fn, /const \{ standalone \} = partition\(list, state\.projectsById\)/);
  assert.match(fn, /arrangeStandalone\(standalone, now\)/);
  // Sorting everything and re-splitting would still move project rows relative
  // to one another, which is the thing this is not allowed to do.
  assert.ok(!/arrangeStandalone\(list/.test(fn), 'the whole bucket is being sorted');
  assert.match(fn, /const slots = standalone\.map\(\(t\) => t\.position\)/,
    'the arrangement renumbers outside the slots the standalone tasks held');
});

test('exclusion: the arrangement never reads or writes a step', () => {
  const fn = body(appCode, 'async function arrangeToday({ manual = false, claimedDate = null } = {})');
  assert.ok(!/\.steps|stepPosition|currentStep|readyToFinish/.test(fn),
    'the arranger touches steps');
  const mod = readWeb('arrange.js');
  assert.ok(!/steps/.test(strip(mod)), 'arrange.js knows about steps at all');
});

test('exclusion: order only — never bucket, date, priority or project', () => {
  const mod = strip(readWeb('arrange.js'));
  // An ASSIGNMENT, not a comparison — `t.projectId == null` is how `isStandalone`
  // reads the field and is exactly what this module is supposed to do.
  for (const field of ['bucket', 'dueDate', 'priority', 'projectId', 'areaId', 'status']) {
    const assigns = new RegExp(`\.${field}\s*=(?!=)`);
    assert.ok(!assigns.test(mod), `arrange.js assigns to ${field}`);
  }
  // The one thing it may write is order, and only through the caller.
  assert.ok(!/api\(|fetch\(/.test(mod), 'the comparator module talks to the server');
});

test('exclusion: an urgent Future task stays in Future', async () => {
  const h = await setup();
  const t = (await h.post('/tasks', { title: 'Someday urgent', bucket: 'future', priority: 'urgent' })).json().task;
  // Nothing in the arrangement path can move a bucket; the reorder endpoint
  // refuses the field outright.
  const r = await h.post('/tasks/reorder', { positions: [{ id: t.id, position: 1, bucket: 'today' }] });
  assert.equal(r.statusCode, 400, 'the reorder endpoint accepted a bucket change');
  assert.equal((await h.get(`/tasks/${t.id}`)).json().task.bucket, 'future');
});

/* ── §14  A task created after the arrangement ───────────────────────── */

test('insert: a newcomer lands in one place without re-sorting the rest', () => {
  const list = [
    task({ id: 'a', scheduledAt: at(14) }),
    task({ id: 'b', dueDate: '2026-08-05' }),
    task({ id: 'c' }),
  ];
  // A newly created urgent-but-undated task belongs before the undated one.
  assert.equal(arrange.insertionIndex(list, task({ id: 'new', priority: 'urgent' }), NOW), 2);
  // A scheduled one goes to the front.
  assert.equal(arrange.insertionIndex(list, task({ id: 'new', scheduledAt: at(9) }), NOW), 0);
  // A plain one goes last.
  assert.equal(arrange.insertionIndex(list, task({ id: 'new', priority: 'low' }), NOW), 3);
});

test('insert: one row is written, and failure leaves it at the end', () => {
  const fn = body(appCode, 'async function placeNewTask(task)');
  assert.match(fn, /if \(!isStandalone\(task\)\) return/, 'a new project task gets arranged');
  assert.match(fn, /positions: \[\{ id: task\.id, position: task\.position \}\]/,
    'more than the new task is being rewritten');
  assert.match(fn, /catch \{/, 'a failed insert is not survivable');
});

/* ── §5/§13  Once per local day ──────────────────────────────────────── */

test('date: the local calendar date, never the UTC one', () => {
  const fn = body(strip(readWeb('arrange.js')), 'export function localDate(d = new Date())');
  assert.match(fn, /d\.getFullYear\(\)/);
  assert.match(fn, /d\.getMonth\(\) \+ 1/);
  assert.ok(!/toISOString/.test(fn),
    'toISOString gives the UTC date, which is yesterday in Johannesburg before 02:00');
  // Proven, not asserted: 00:30 local on the 5th is still the 5th.
  const justAfterMidnight = new Date(2026, 7, 5, 0, 30, 0);
  assert.equal(arrange.localDate(justAfterMidnight), '2026-08-05');
});

test('claim: the first caller wins the day and the second is refused', async () => {
  const h = await setup();
  const first = (await h.post('/today/arrange-claim', { localDate: '2026-08-05' })).json();
  assert.equal(first.claimed, true);
  assert.equal(first.lastArrangedOn, null);

  const second = (await h.post('/today/arrange-claim', { localDate: '2026-08-05' })).json();
  assert.equal(second.claimed, false, 'a second tab arranged the same day again');
  assert.equal(second.lastArrangedOn, '2026-08-05');
});

test('claim: a new local date claims again', async () => {
  const h = await setup();
  await h.post('/today/arrange-claim', { localDate: '2026-08-05' });
  const next = (await h.post('/today/arrange-claim', { localDate: '2026-08-06' })).json();
  assert.equal(next.claimed, true, 'the next day was refused');
});

test('claim: concurrent claims still yield exactly one winner', async () => {
  const h = await setup();
  // Fired together — the conditional UPDATE is the whole guard.
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    h.post('/today/arrange-claim', { localDate: '2026-08-05' })));
  const wins = results.map((r: any) => r.json().claimed).filter(Boolean).length;
  assert.equal(wins, 1, `${wins} tabs each thought they had won the day`);
});

test('claim: releasing gives the day back, and only for that date', async () => {
  const h = await setup();
  await h.post('/today/arrange-claim', { localDate: '2026-08-05' });
  // A release naming a different day must not clear the marker.
  await h.post('/today/arrange-release', { localDate: '2026-08-04' });
  assert.equal((await h.post('/today/arrange-claim', { localDate: '2026-08-05' })).json().claimed,
    false, 'releasing the wrong date cleared the day');

  await h.post('/today/arrange-release', { localDate: '2026-08-05' });
  assert.equal((await h.post('/today/arrange-claim', { localDate: '2026-08-05' })).json().claimed,
    true, 'the released day was not offered again');
});

test('claim: a malformed date is refused', async () => {
  const h = await setup();
  for (const localDate of ['05-08-2026', '2026-8-5', 'today', '']) {
    assert.equal((await h.post('/today/arrange-claim', { localDate })).statusCode, 400,
      `"${localDate}" was accepted as a local date`);
  }
});

/* ── §20  The bulk write is atomic ───────────────────────────────────── */

test('reorder: all positions or none', async () => {
  const h = await setup();
  const a = (await h.post('/tasks', { title: 'A', bucket: 'today' })).json().task;
  const b = (await h.post('/tasks', { title: 'B', bucket: 'today' })).json().task;

  // One good id and one that does not exist: nothing may move.
  const r = await h.post('/tasks/reorder', {
    positions: [
      { id: a.id, position: 50 },
      { id: '00000000-0000-0000-0000-000000000000', position: 60 },
    ],
  });
  assert.equal(r.statusCode, 404);
  assert.notEqual((await h.get(`/tasks/${a.id}`)).json().task.position, 50,
    'a half-applied reorder left the board in an order nobody chose');

  const ok = await h.post('/tasks/reorder', {
    positions: [{ id: a.id, position: 50 }, { id: b.id, position: 40 }],
  });
  assert.equal(ok.statusCode, 200);
  assert.equal((await h.get(`/tasks/${a.id}`)).json().task.position, 50);
  assert.equal((await h.get(`/tasks/${b.id}`)).json().task.position, 40);
});

test('reorder: a duplicate id is refused rather than applied twice', async () => {
  const h = await setup();
  const a = (await h.post('/tasks', { title: 'A', bucket: 'today' })).json().task;
  const r = await h.post('/tasks/reorder', {
    positions: [{ id: a.id, position: 1 }, { id: a.id, position: 2 }],
  });
  assert.equal(r.statusCode, 400);
});

test('reorder: a task from another workspace cannot be moved', async () => {
  const h = await setup();
  const other = await setup();
  const mine = (await h.post('/tasks', { title: 'Mine', bucket: 'today' })).json().task;
  const theirs = (await other.post('/tasks', { title: 'Theirs', bucket: 'today' })).json().task;
  const r = await h.post('/tasks/reorder', {
    positions: [{ id: mine.id, position: 1 }, { id: theirs.id, position: 2 }],
  });
  assert.equal(r.statusCode, 404, 'a cross-workspace id was accepted');
});

/* ── §11  Undo and feedback ──────────────────────────────────────────── */

test('undo: the exact prior positions are recorded, not just an order', () => {
  const fn = body(appCode, 'async function arrangeToday({ manual = false, claimedDate = null } = {})');
  assert.match(fn, /before\.set\(b\.id, standalone\.map\(\(t\) => \(\{ id: t\.id, position: t\.position \}\)\)\)/,
    'Undo would have to guess the previous order');
  const undo = body(appCode, 'async function undoArrange()');
  assert.match(undo, /t\.position = position/);
  assert.match(undo, /tasks\/reorder/, 'Undo is cosmetic — it never writes');
  assert.match(undo, /arrange-release/, 'a rejected arrangement still costs the user the day');
});

test('feedback: nothing is said when nothing moved', () => {
  const fn = body(appCode, 'async function arrangeToday({ manual = false, claimedDate = null } = {})');
  assert.match(fn, /if \(!orderChanged\(standalone, sorted\)\) continue/);
  assert.match(fn, /if \(!writes\.length\)/);
  assert.match(fn, /if \(manual\) toast\('Today is already in the recommended order\.'\)/,
    'an automatic run with nothing to do still interrupts the user');
});

test('feedback: the toast carries one verb and lives long enough to use', () => {
  const fn = body(appCode, 'function toast(msg, isError = false, action = null)');
  assert.match(fn, /toast-action/);
  assert.match(fn, /action \? 9000 : 3600/,
    'a toast you are meant to act on vanishes as fast as one you only read');
  assert.match(css, /\.toast-action\{/);
});

test('failure: a rejected arrangement rolls every position back', () => {
  const fn = body(appCode, 'async function arrangeToday({ manual = false, claimedDate = null } = {})');
  const catchAt = fn.indexOf('} catch (e) {');
  const tail = fn.slice(catchAt);
  assert.match(tail, /t\.position = position/, 'the local state keeps the rejected order');
  assert.match(tail, /rebuildBucket\(bucketId\)/);
  assert.match(tail, /arrangeUndo = null/, 'Undo would replay an arrangement that never happened');
  assert.match(tail, /Could not arrange Today/, 'the failure is silent');
});

/* ── §22  Safety ─────────────────────────────────────────────────────── */

test('safety: no Legacy migration, no Google writes, no Boards', () => {
  const web = ['app.js', 'arrange.js', 'steps.js', 'task-modal.js'].map(readWeb).join('\n');
  assert.ok(!/legacyImport|migrateLegacyProjects/.test(web));
  assert.ok(!/googleapis\.com\/calendar\/v3[^'"]*',\s*\{\s*method:\s*'(POST|PUT|PATCH|DELETE)/.test(web));
  assert.ok(!/data-board|openBoard\(/.test(web));
});

test('safety: projects, steps, habits and calendar all still work', async () => {
  const h = await setup();
  const project = (await h.post('/projects', {
    title: 'Intact', outcome: 'Yes', areaId: h.areaId, focus: 'now',
  })).json().project;
  const t = (await h.post('/tasks', { title: 'With steps', projectId: project.id })).json().task;
  await h.post(`/tasks/${t.id}/steps`, { title: 'one' });
  assert.equal((await h.get(`/tasks/${t.id}`)).json().task.steps.length, 1);
  assert.equal((await h.get(`/projects/${project.id}`)).json().project.progress.total, 1);

  const habit = (await h.post('/habits', { name: 'Walk' })).json().habit;
  await h.post(`/habits/${habit.id}/check`, { date: '2026-08-03' });
  assert.equal((await h.get('/habits/history?from=2026-08-03&to=2026-08-03')).json().days[0].done, 1);
  assert.ok(Array.isArray((await h.get('/calendar/range?from=2026-08-01&to=2026-08-07')).json().habitDays));
});

test('safety: arranging leaves project task positions alone', async () => {
  const h = await setup();
  const project = (await h.post('/projects', {
    title: 'Untouched', outcome: 'Yes', areaId: h.areaId, focus: 'now',
  })).json().project;
  const p1 = (await h.post('/tasks', { title: 'P1', projectId: project.id, bucket: 'today' })).json().task;
  const p2 = (await h.post('/tasks', { title: 'P2', projectId: project.id, bucket: 'today' })).json().task;
  const s1 = (await h.post('/tasks', { title: 'S1', bucket: 'today', priority: 'low' })).json().task;
  const s2 = (await h.post('/tasks', { title: 'S2', bucket: 'today', priority: 'urgent' })).json().task;

  // What the client sends after arranging: ONLY the standalone rows, swapped
  // within the slots they already held.
  await h.post('/tasks/reorder', {
    positions: [{ id: s2.id, position: s1.position }, { id: s1.id, position: s2.position }],
  });

  const after = (await h.get('/tasks?bucket=today&includeCompleted=false')).json().tasks;
  const pos = (id: string) => after.find((t: any) => t.id === id).position;
  assert.equal(pos(p1.id), p1.position, 'a project task was renumbered');
  assert.equal(pos(p2.id), p2.position, 'a project task was renumbered');
  assert.equal(pos(s2.id), s1.position);
  assert.equal(pos(s1.id), s2.position);
});
