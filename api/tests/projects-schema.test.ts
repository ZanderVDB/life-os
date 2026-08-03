/**
 * Phase E2 — Projects schema and derived logic, against real Postgres (PGlite).
 *
 * The migration SQL is executed here, so the CHECK constraints, partial indexes
 * and the foreign key behaviour are genuinely exercised rather than described.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { freshDb, identity } from './helpers.js';
import { ensureUserAndWorkspace } from '../src/lib/bootstrap.js';
import { projects, tasks, areas, PROJECT_STATUSES, PROJECT_FOCUSES } from '../src/db/schema.js';
import {
  progressFor, nextActionFor, healthFor, surfacesAutomatically,
} from '../src/routes/projects.js';

async function setup() {
  const { db, client } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());
  const [area] = await db.select().from(areas)
    .where(and(eq(areas.workspaceId, p.workspaceId), eq(areas.name, 'Work')));
  return { db, client, ws: p.workspaceId, areaId: area.id };
}

const mkProject = (ws: string, over: Record<string, any> = {}) => ({
  workspaceId: ws, title: 'A project', outcome: 'It is done', ...over,
});
const mkTask = (ws: string, over: Record<string, any> = {}) => ({
  workspaceId: ws, title: 'A task', ...over,
});

/* ── Schema ──────────────────────────────────────────────────────────── */

test('schema: the projects table exists with status and focus defaults', async () => {
  const { db, ws } = await setup();
  const [row] = await db.insert(projects).values(mkProject(ws)).returning();
  // Defaults matter: a project created without a stated intention should be
  // Planning and quiet, never Active and loud.
  assert.equal(row.status, 'planning');
  assert.equal(row.focus, 'upcoming');
  assert.equal(row.archivedAt, null);
  assert.equal(row.preArchiveStatus, null);
});

test('schema: status and focus are constrained, and independent', async () => {
  const { db, ws } = await setup();
  for (const status of PROJECT_STATUSES) {
    for (const focus of PROJECT_FOCUSES) {
      // Every combination must be storable — including 'on_hold' + 'now'.
      // That pair is contradictory in behaviour, not in data, and it is
      // resolved by suppressing surfacing rather than by refusing the write.
      const [row] = await db.insert(projects)
        .values(mkProject(ws, { status, focus })).returning();
      assert.equal(row.status, status);
      assert.equal(row.focus, focus);
    }
  }
  await assert.rejects(
    () => db.insert(projects).values(mkProject(ws, { status: 'archived' })),
    /projects_status_check|violates check/i,
    'archived was accepted as a lifecycle status',
  );
  await assert.rejects(
    () => db.insert(projects).values(mkProject(ws, { focus: 'later' })),
    /projects_focus_check|violates check/i,
  );
});

test('schema: an archived project must remember where to go back to', async () => {
  const { db, ws } = await setup();
  // Archive without a stored status would make restore a guess.
  await assert.rejects(
    () => db.insert(projects).values(mkProject(ws, { archivedAt: new Date() })),
    /archive_pair|violates check/i,
    'a project can be archived with nothing to restore to',
  );
  await assert.rejects(
    () => db.insert(projects).values(mkProject(ws, { preArchiveStatus: 'active' })),
    /archive_pair|violates check/i,
    'a live project can carry a pre-archive status',
  );
  const [ok] = await db.insert(projects)
    .values(mkProject(ws, { archivedAt: new Date(), preArchiveStatus: 'active' })).returning();
  assert.equal(ok.preArchiveStatus, 'active');
});

test('schema: legacy_id is unique per workspace, so an import is idempotent', async () => {
  const { db, ws } = await setup();
  await db.insert(projects).values(mkProject(ws, { legacyId: 'b1' }));
  await assert.rejects(
    () => db.insert(projects).values(mkProject(ws, { legacyId: 'b1' })),
    /projects_legacy_idx|duplicate key/i,
  );
  // …but two projects with no legacy id are fine (the index is partial).
  await db.insert(projects).values(mkProject(ws));
  await db.insert(projects).values(mkProject(ws));
});

/* ── The task foreign key ────────────────────────────────────────────── */

test('fk: deleting a project keeps its tasks and clears the link', async () => {
  const { db, ws, areaId } = await setup();
  const [project] = await db.insert(projects).values(mkProject(ws, { areaId })).returning();
  const [task] = await db.insert(tasks)
    .values(mkTask(ws, { projectId: project.id, areaId, dueDate: '2026-09-01' })).returning();

  await db.delete(projects).where(eq(projects.id, project.id));

  const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  assert.ok(after, 'deleting a project deleted work — the FK must be set null, never cascade');
  assert.equal(after.projectId, null);
  // Everything else about the task survives untouched.
  assert.equal(after.areaId, areaId);
  assert.equal(after.dueDate, '2026-09-01');
  assert.equal(after.title, 'A task');
});

test('fk: a task cannot point at a project that does not exist', async () => {
  const { db, ws } = await setup();
  await assert.rejects(
    () => db.insert(tasks).values(mkTask(ws, { projectId: '00000000-0000-0000-0000-000000000000' })),
    /foreign key|violates/i,
    'project_id accepts anything, so orphaned links are possible',
  );
});

test('fk: deleting the next-action task clears the pointer, not the project', async () => {
  const { db, ws } = await setup();
  const [project] = await db.insert(projects).values(mkProject(ws)).returning();
  const [task] = await db.insert(tasks).values(mkTask(ws, { projectId: project.id })).returning();
  await db.update(projects).set({ nextTaskId: task.id }).where(eq(projects.id, project.id));

  await db.delete(tasks).where(eq(tasks.id, task.id));
  const [after] = await db.select().from(projects).where(eq(projects.id, project.id));
  assert.ok(after, 'deleting a task deleted the project');
  assert.equal(after.nextTaskId, null);
});

test('fk: the migration leaves every existing task projectless', async () => {
  // The whole point of E2's migration: it adds a constraint to a column that
  // is null on every row, so it cannot move or reclassify any work.
  const { db, ws, areaId } = await setup();
  for (let i = 0; i < 5; i++) {
    await db.insert(tasks).values(mkTask(ws, { title: `T${i}`, areaId }));
  }
  const before = await db.select().from(tasks);
  assert.equal(before.length, 5);
  assert.equal(before.filter((t: any) => t.projectId !== null).length, 0,
    'a task acquired a project during the schema migration');
});

test('fk: losing an area keeps the project', async () => {
  const { db, ws, areaId } = await setup();
  const [project] = await db.insert(projects).values(mkProject(ws, { areaId })).returning();
  await db.delete(areas).where(eq(areas.id, areaId));
  const [after] = await db.select().from(projects).where(eq(projects.id, project.id));
  assert.ok(after);
  assert.equal(after.areaId, null);
});

/* ── Workspace isolation ─────────────────────────────────────────────── */

test('isolation: projects are scoped to a workspace and die with it', async () => {
  const { db, ws } = await setup();
  const other = await ensureUserAndWorkspace(db, identity('other@example.com', 'uid-2'));
  await db.insert(projects).values(mkProject(ws, { title: 'Mine' }));
  await db.insert(projects).values(mkProject(other.workspaceId, { title: 'Theirs' }));

  const mine = await db.select().from(projects).where(eq(projects.workspaceId, ws));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, 'Mine');
});

/* ── Derived logic ───────────────────────────────────────────────────── */

const P = (over: any = {}) => ({
  id: 'p1', workspaceId: 'w1', status: 'active', focus: 'now',
  archivedAt: null, targetDate: null, nextTaskId: null, ...over,
}) as any;
const T = (over: any = {}) => ({
  id: 't1', workspaceId: 'w1', projectId: 'p1', status: 'open',
  priority: 'medium', position: 0, dueDate: null, title: 'T', ...over,
}) as any;

test('progress: counts, never a bare percentage, never a fake zero', () => {
  assert.equal(progressFor([]).percent, null,
    'a project with no tasks reports 0% — it must report nothing measured');
  assert.equal(progressFor([]).total, 0);

  const some = progressFor([T({ status: 'done' }), T({ id: 't2' }), T({ id: 't3' })]);
  assert.equal(some.done, 1);
  assert.equal(some.open, 2);
  assert.equal(some.total, 3);
  assert.equal(some.percent, 33);
});

test('progress: cancelled work leaves the denominator entirely', () => {
  // A task you decided not to do is not incomplete work. Counting it keeps a
  // finished project looking unfinished forever.
  const p = progressFor([T({ status: 'done' }), T({ id: 't2', status: 'cancelled' })]);
  assert.equal(p.total, 1);
  assert.equal(p.percent, 100);
  assert.equal(p.cancelled, 1);
});

test('next action: inferred by due date, then priority, then position', () => {
  const list = [
    T({ id: 'a', priority: 'low', position: 0 }),
    T({ id: 'b', priority: 'urgent', position: 1 }),
    T({ id: 'c', dueDate: '2026-08-10', priority: 'someday', position: 2 }),
  ];
  const next = nextActionFor(P(), list);
  assert.equal(next.task?.id, 'c', 'a date is a commitment; priority is an opinion');
  assert.equal(next.explicit, false);

  const noDates = nextActionFor(P(), [list[0], list[1]]);
  assert.equal(noDates.task?.id, 'b', 'priority did not break the tie');
});

test('next action: an explicit override wins only while it is valid', () => {
  const list = [T({ id: 'a', dueDate: '2026-08-01' }), T({ id: 'b' })];
  const chosen = nextActionFor(P({ nextTaskId: 'b' }), list);
  assert.equal(chosen.task?.id, 'b');
  assert.equal(chosen.explicit, true);

  // Completed: falls back, and reports that the stored override is stale.
  const done = nextActionFor(P({ nextTaskId: 'b' }), [list[0], T({ id: 'b', status: 'done' })]);
  assert.equal(done.task?.id, 'a');
  assert.equal(done.explicit, false);
  assert.equal(done.staleOverride, true);

  // Reassigned to another project: same treatment.
  const moved = nextActionFor(P({ nextTaskId: 'b' }), [list[0], T({ id: 'b', projectId: 'other' })]);
  assert.equal(moved.task?.id, 'a');
  assert.equal(moved.staleOverride, true);
});

test('next action: nothing open says so, and does not invent one', () => {
  const none = nextActionFor(P(), [T({ status: 'done' })]);
  assert.equal(none.task, null);
});

test('health: active with nothing to do is attention; planning is not', () => {
  const today = '2026-08-03';
  assert.equal(healthFor(P({ status: 'active' }), [], today).length, 1);
  assert.equal(healthFor(P({ status: 'active' }), [], today)[0]!.id, 'no_next_action');
  assert.equal(healthFor(P({ status: 'planning' }), [], today).length, 0,
    'a planning project with no tasks was flagged — that is what planning is');
  assert.equal(healthFor(P({ status: 'on_hold' }), [], today).length, 0);
});

test('health: overdue needs a passed target AND open work', () => {
  const today = '2026-08-03';
  const overdue = healthFor(P({ targetDate: '2026-07-01' }), [T()], today);
  assert.ok(overdue.some((h) => h.id === 'overdue'));
  // Past its date but everything is done — that is a project waiting to be
  // marked complete, not an overdue one.
  const finished = healthFor(P({ targetDate: '2026-07-01' }), [T({ status: 'done' })], today);
  assert.ok(!finished.some((h) => h.id === 'overdue'));
});

test('health: every signal explains itself', () => {
  const all = [
    ...healthFor(P({ status: 'active' }), [], '2026-08-03'),
    ...healthFor(P({ targetDate: '2026-07-01' }), [T()], '2026-08-03'),
  ];
  for (const h of all) {
    assert.ok(h.label && h.label.length > 2, 'an unlabelled signal');
    assert.ok(h.why && h.why.length > 10, `"${h.label}" appears without saying why`);
  }
});

test('health: completed and archived projects are never unhealthy', () => {
  const today = '2026-08-03';
  assert.equal(healthFor(P({ status: 'completed', targetDate: '2020-01-01' }), [T()], today).length, 0);
  assert.equal(healthFor(P({ archivedAt: new Date(), targetDate: '2020-01-01' }), [T()], today).length, 0);
});

test('surfacing: only Now surfaces, and status can always veto focus', () => {
  assert.equal(surfacesAutomatically(P({ status: 'active', focus: 'now' })), true);
  assert.equal(surfacesAutomatically(P({ status: 'active', focus: 'upcoming' })), false);
  assert.equal(surfacesAutomatically(P({ status: 'active', focus: 'someday' })), false);
  assert.equal(surfacesAutomatically(P({ status: 'planning', focus: 'now' })), true);
  // The contradictory pair. The status is what the user just chose, so it wins.
  assert.equal(surfacesAutomatically(P({ status: 'on_hold', focus: 'now' })), false,
    'an on-hold project still pushed work forward');
  assert.equal(surfacesAutomatically(P({ status: 'completed', focus: 'now' })), false);
  assert.equal(surfacesAutomatically(P({ status: 'active', focus: 'now', archivedAt: new Date() })), false);
});
