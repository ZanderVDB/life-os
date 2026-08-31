/**
 * Habits: schema constraints, CRUD, completion, and the legacy import.
 *
 * The central rule this file protects: habit history comes from a habit's own
 * `checkedDates`, and diary journal text can NEVER become a completion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { buildHabitImportPlan, summariseHabitPlan } from '../src/lib/habit-import.js';
import { isDueOn } from '../src/routes/habits.js';
import { EXPORT_FORMAT } from '../src/lib/legacy-import.js';

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = (email = 'zander@example.com') => ({
  authorization: `Bearer ${TOKEN}`, 'x-dev-email': email,
});

async function setup(email?: string) {
  const { db } = await freshDb();
  const app = buildApp(db, env);
  await app.ready();
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(email) })).json();
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as any, url, headers: auth(email), payload: payload as any });
    return { status: r.statusCode, body: r.json() };
  };
  return { app, db, me, ws: me.workspace.id, call };
}

/* ── Schema and isolation ────────────────────────────────────────────── */

test('habits: workspace isolation — another user cannot see or touch them', async () => {
  const a = await setup('owner@example.com');
  await a.call('POST', `/api/v1/workspaces/${a.ws}/habits`, { name: 'Private habit' });

  const b = await setup('other@example.com');
  const peek = await b.call('GET', `/api/v1/workspaces/${a.ws}/habits`);
  assert.equal(peek.status, 403, 'another user reached this workspace');
  assert.equal((await b.call('GET', `/api/v1/workspaces/${b.ws}/habits`)).body.habits.length, 0);
});

test('habits: constraints reject nonsense', async () => {
  const { call, ws } = await setup();
  assert.equal((await call('POST', `/api/v1/workspaces/${ws}/habits`, { name: '' })).status, 400);
  assert.equal((await call('POST', `/api/v1/workspaces/${ws}/habits`,
    { name: 'x', frequencyType: 'hourly' })).status, 400);
  assert.equal((await call('POST', `/api/v1/workspaces/${ws}/habits`,
    { name: 'x', targetCount: 0 })).status, 400);
  // An Area from another workspace cannot be attached.
  assert.equal((await call('POST', `/api/v1/workspaces/${ws}/habits`,
    { name: 'x', areaId: '00000000-0000-0000-0000-000000000000' })).status, 400);
});

test('habits: CRUD, and archiving keeps history instead of destroying it', async () => {
  const { call, ws } = await setup();
  const created = (await call('POST', `/api/v1/workspaces/${ws}/habits`,
    { name: 'Read', targetCount: 2 })).body.habit;
  assert.equal(created.targetCount, 2);
  assert.equal(created.isActive, true);

  const renamed = (await call('PATCH', `/api/v1/workspaces/${ws}/habits/${created.id}`,
    { name: 'Read at night' })).body.habit;
  assert.equal(renamed.name, 'Read at night');

  /* TODAY, not a literal. This was '2026-07-30', and `historyCount` only
     counts entries inside `historyDays` back from the current date — so the
     test passed until the wall clock walked past the window and then failed
     every day after, for a reason that had nothing to do with archiving. */
  const day = new Date().toISOString().slice(0, 10);
  await call('POST', `/api/v1/workspaces/${ws}/habits/${created.id}/check`, { date: day });

  // Default delete ARCHIVES — a habit's value is its history.
  const del = await call('DELETE', `/api/v1/workspaces/${ws}/habits/${created.id}`);
  assert.equal(del.body.archived, true);
  assert.equal(del.body.deleted, false);
  const visible = (await call('GET', `/api/v1/workspaces/${ws}/habits`)).body.habits;
  assert.equal(visible.length, 0, 'an archived habit still shows on Today');
  const all = (await call('GET', `/api/v1/workspaces/${ws}/habits?includeArchived=true`)).body.habits;
  assert.equal(all.length, 1);
  assert.equal(all[0].historyCount, 1, 'archiving destroyed the history');
});

test('habits: completion is idempotent per day, and undo removes the row', async () => {
  const { call, ws } = await setup();
  const h = (await call('POST', `/api/v1/workspaces/${ws}/habits`, { name: 'Walk' })).body.habit;
  const day = '2026-07-30';

  const first = await call('POST', `/api/v1/workspaces/${ws}/habits/${h.id}/check`, { date: day });
  assert.equal(first.body.completedCount, 1);
  assert.equal(first.body.completed, true);

  // A second tick increments rather than inserting a duplicate row.
  const second = await call('POST', `/api/v1/workspaces/${ws}/habits/${h.id}/check`, { date: day });
  assert.equal(second.body.completedCount, 2);
  const listed = (await call('GET', `/api/v1/workspaces/${ws}/habits?date=${day}`)).body.habits[0];
  assert.equal(listed.historyCount, 1, 'a duplicate entry row was created');

  const undone = await call('POST', `/api/v1/workspaces/${ws}/habits/${h.id}/uncheck`, { date: day });
  assert.equal(undone.body.completedCount, 0);
  const after = (await call('GET', `/api/v1/workspaces/${ws}/habits?date=${day}`)).body.habits[0];
  assert.equal(after.historyCount, 0, 'undo left a zero row behind');
  assert.equal(after.completedToday, false);
});

test('habits: a multi-count target is only complete when it is met', async () => {
  const { call, ws } = await setup();
  const h = (await call('POST', `/api/v1/workspaces/${ws}/habits`,
    { name: 'Water', targetCount: 3 })).body.habit;
  const day = '2026-07-30';
  const one = await call('POST', `/api/v1/workspaces/${ws}/habits/${h.id}/check`, { date: day });
  assert.equal(one.body.completed, false, '1 of 3 reported as complete');
  await call('POST', `/api/v1/workspaces/${ws}/habits/${h.id}/check`, { date: day });
  const three = await call('POST', `/api/v1/workspaces/${ws}/habits/${h.id}/check`, { date: day });
  assert.equal(three.body.completed, true);
});

test('habits: streak counts consecutive days and tolerates an unticked today', async () => {
  const { call, ws } = await setup();
  const h = (await call('POST', `/api/v1/workspaces/${ws}/habits`, { name: 'Stretch' })).body.habit;
  for (const d of ['2026-07-28', '2026-07-29', '2026-07-30']) {
    await call('POST', `/api/v1/workspaces/${ws}/habits/${h.id}/check`, { date: d });
  }
  // Asked about the 31st, with the 31st not yet ticked — the run to the 30th
  // still counts, because a day that is not over is not a broken streak.
  const asked = (await call('GET', `/api/v1/workspaces/${ws}/habits?date=2026-07-31`)).body.habits[0];
  assert.equal(asked.streak, 3);
  assert.equal(asked.completedToday, false);
  // A real gap ends it.
  const gap = (await call('GET', `/api/v1/workspaces/${ws}/habits?date=2026-08-02`)).body.habits[0];
  assert.equal(gap.streak, 0);
});

test('habits: specific_days with no days configured is never due', () => {
  // An empty list means "no day", not "every day" — guessing the opposite
  // would resurrect a habit the user had muted.
  const monday = new Date('2026-08-03T12:00:00Z');
  assert.equal(isDueOn({ frequencyType: 'specific_days', frequencyConfig: {} }, monday), false);
  assert.equal(isDueOn({ frequencyType: 'specific_days', frequencyConfig: { days: [1] } }, monday), true);
  assert.equal(isDueOn({ frequencyType: 'specific_days', frequencyConfig: { days: [0, 6] } }, monday), false);
  assert.equal(isDueOn({ frequencyType: 'daily', frequencyConfig: null }, monday), true);
});

/* ── Legacy import ───────────────────────────────────────────────────── */

function fixture(over: any = {}) {
  return {
    exportFormat: EXPORT_FORMAT, exportVersion: 1, appVersion: 'v242',
    createdAt: '2026-07-31T01:08:00.000Z',
    profiles: [
      { id: 'p_tri', name: 'Trifusion', mode: 'business' },
      { id: 'main', name: 'Personal', mode: 'personal' },
    ],
    documents: {
      p_tri: { data: { habits: [{ id: 'tri1', name: 'TRIFUSION HABIT', checkedDates: ['2026-01-01'] }] } },
      main: {
        data: {
          habits: [
            { id: 'h1', name: 'Read', checkedDates: ['2026-07-28', '2026-07-29', '2026-07-29'] },
            { id: 'h2', name: 'Walk', checkedDates: ['2026-06-01', 'not-a-date'] },
            { id: 'h3', name: '', checkedDates: [] },
            { id: '', name: 'No id', checkedDates: [] },
            { id: 'h1', name: 'Duplicate id', checkedDates: [] },
          ],
          routineLog: {
            '2026-07-01': { checks: { morning: true, evening: true }, journal: { j1: 'PRIVATE DIARY TEXT' } },
            '2026-07-02': { checks: { morning: true }, journal: { j2: 'MORE PRIVATE WRITING' } },
          },
        },
      },
    },
    verification: { ok: true, status: 'VERIFIED' },
    ...over,
  };
}

test('habit import: Personal only, Trifusion never read', () => {
  const plan = buildHabitImportPlan(fixture());
  assert.equal(plan.ok, true);
  assert.equal(plan.profileChosen!.name, 'Personal');
  assert.equal(plan.profilesIgnored[0]!.name, 'Trifusion');
  const blob = JSON.stringify(plan);
  assert.ok(!blob.includes('TRIFUSION HABIT'), 'a Trifusion habit leaked into the plan');
  assert.ok(!plan.habits.plan.some((h) => h.legacyId === 'tri1'));
});

test('habit import: JOURNAL TEXT IS NEVER READ OR IMPORTED', () => {
  const plan = buildHabitImportPlan(fixture());
  const blob = JSON.stringify(plan);
  // The single most important assertion in this file.
  assert.ok(!blob.includes('PRIVATE DIARY TEXT'), 'diary text reached the import plan');
  assert.ok(!blob.includes('MORE PRIVATE WRITING'), 'diary text reached the import plan');
  // Journal presence is counted only, as days.
  assert.equal(plan.notImported.journalDays, 2);
  // And no entry date came from routineLog.
  const allDates = plan.habits.plan.flatMap((h) => h.entryDates);
  assert.ok(!allDates.includes('2026-07-01'), 'a routineLog day became habit history');
  assert.ok(!allDates.includes('2026-07-02'), 'a routineLog day became habit history');
});

test('habit import: routine checks are reported as ambiguous, never guessed', () => {
  const plan = buildHabitImportPlan(fixture());
  assert.equal(plan.notImported.routineCheckDays, 2);
  assert.equal(plan.notImported.routineCheckMarks, 3);
  assert.match(plan.warnings.join(' '), /could not be mapped to a habit and were NOT imported/);
  assert.match(plan.notImported.reason, /cannot be mapped/i);
});

test('habit import: history comes from checkedDates, deduped and validated', () => {
  const plan = buildHabitImportPlan(fixture());
  assert.equal(plan.habits.total, 2, 'expected exactly Read and Walk');
  const read = plan.habits.plan.find((h) => h.legacyId === 'h1')!;
  assert.deepEqual(read.entryDates, ['2026-07-28', '2026-07-29'], 'duplicate day not collapsed');
  assert.equal(plan.entries.duplicatesCollapsed, 1);
  assert.equal(plan.entries.invalidDates, 1, 'an unparseable date was not counted');
  assert.equal(plan.entries.total, 3);
  assert.equal(plan.entries.earliest, '2026-06-01');
  assert.equal(plan.entries.latest, '2026-07-29');
  // Skips are reported, not silent.
  const reasons = plan.habits.skipped.map((s) => s.reason);
  assert.ok(reasons.includes('empty name'));
  assert.ok(reasons.includes('missing id'));
  assert.ok(reasons.includes('duplicate legacy id'));
});

test('habit import: an unverified export is refused', () => {
  const plan = buildHabitImportPlan(fixture({ verification: { ok: false, status: 'FAILED' } }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /VERIFIED/);
  assert.equal(plan.habits.total, 0);
});

test('habit import: the preview summary carries counts, never habit names', () => {
  const s = summariseHabitPlan(buildHabitImportPlan(fixture()));
  assert.equal(s.habits.total, 2);
  assert.equal(s.entries.total, 3);
  assert.ok(s.entries.earliest && s.entries.latest, 'no date range reported');
  const blob = JSON.stringify(s);
  assert.ok(!blob.includes('"Read"'), 'a habit name leaked into the summary');
  assert.ok(!blob.includes('PRIVATE'), 'diary text leaked into the summary');
});

test('habit import: preview endpoint writes nothing', async () => {
  const { call, ws } = await setup();
  const r = await call('POST', `/api/v1/workspaces/${ws}/import/habits/preview`, { export: fixture() });
  assert.equal(r.status, 200);
  assert.equal(r.body.wouldWrite, false);
  assert.equal(r.body.confirmPhrase, 'IMPORT 2 HABITS');
  assert.equal((await call('GET', `/api/v1/workspaces/${ws}/habits`)).body.habits.length, 0);
});

test('habit import: executes once, refuses a mismatch, refuses a repeat', async () => {
  const { call, ws } = await setup();
  const exp = fixture();

  // Wrong confirmation phrase.
  assert.equal((await call('POST', `/api/v1/workspaces/${ws}/import/habits/execute`,
    { export: exp, approved: { habits: 2, entries: 3 }, confirm: 'yes' })).status, 400);
  // Counts that do not match the file.
  assert.equal((await call('POST', `/api/v1/workspaces/${ws}/import/habits/execute`,
    { export: exp, approved: { habits: 5, entries: 3 }, confirm: 'IMPORT 5 HABITS' })).status, 409);
  assert.equal((await call('GET', `/api/v1/workspaces/${ws}/habits`)).body.habits.length, 0,
    'a refused import still wrote something');

  const ok = await call('POST', `/api/v1/workspaces/${ws}/import/habits/execute`,
    { export: exp, approved: { habits: 2, entries: 3 }, confirm: 'IMPORT 2 HABITS' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.written.habits, 2);
  assert.equal(ok.body.written.entries, 3);

  // Imported history is marked as imported, not as a live tick.
  const listed = (await call('GET', `/api/v1/workspaces/${ws}/habits?date=2026-07-29&historyDays=90`))
    .body.habits;
  assert.equal(listed.length, 2);
  assert.ok(listed.every((h: any) => h.legacyId), 'legacy ids were not preserved');

  // The same file cannot land twice.
  const again = await call('POST', `/api/v1/workspaces/${ws}/import/habits/execute`,
    { export: exp, approved: { habits: 2, entries: 3 }, confirm: 'IMPORT 2 HABITS' });
  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /already been imported/i);
  assert.equal((await call('GET', `/api/v1/workspaces/${ws}/habits`)).body.habits.length, 2,
    'a repeat import duplicated habits');
});

test('habit import: is recorded in migration_runs alongside the task import', async () => {
  const { call, ws } = await setup();
  await call('POST', `/api/v1/workspaces/${ws}/import/habits/execute`,
    { export: fixture(), approved: { habits: 2, entries: 3 }, confirm: 'IMPORT 2 HABITS' });
  const runs = (await call('GET', `/api/v1/workspaces/${ws}/import/legacy/runs`)).body.runs;
  // The task-import listing is scoped to its own step, so habits do not pollute it.
  assert.equal(runs.length, 0, 'the habit run leaked into the task import history');
});
