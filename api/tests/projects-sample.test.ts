/**
 * Sample data for the E2 review — TEMPORARY, and these tests go with it.
 *
 * The point of testing throwaway data is the CLEANUP. D4.3 nearly deleted real
 * reminders because synthetic rows were identified by a flag that had also been
 * set on real ones. So: cleanup must remove exactly the sample set, must leave
 * real records untouched, and must never match on anything a real record could
 * also match on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { freshDb, identity } from './helpers.js';
import { ensureUserAndWorkspace } from '../src/lib/bootstrap.js';
import { projects, tasks, areas } from '../src/db/schema.js';
import {
  seedSampleProjects, removeSampleProjects, sampleFootprint,
  isSampleAllowed, SAMPLE_PREFIX,
} from '../src/lib/sample-projects.js';

async function setup() {
  const { db } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());
  const rows = await db.select().from(areas).where(eq(areas.workspaceId, p.workspaceId));
  const byName = new Map<string, string>(rows.map((a: any) => [a.name as string, a.id as string]));
  return { db, ws: p.workspaceId, byName };
}

test('sample: production is refused outright', () => {
  assert.equal(isSampleAllowed('production'), false, 'sample data can be seeded in production');
  assert.equal(isSampleAllowed('staging'), true);
  assert.equal(isSampleAllowed('development'), true);
});

test('sample: seeds one project per overview state', async () => {
  const { db, ws, byName } = await setup();
  const r = await seedSampleProjects(db, ws, byName);
  assert.ok(r.projectsCreated >= 10, 'not enough states are covered to review the overview');
  assert.ok(r.tasksCreated > 0);

  const rows = await db.select().from(projects).where(eq(projects.workspaceId, ws));
  const statuses = new Set(rows.map((p: any) => p.status));
  const focuses = new Set(rows.map((p: any) => p.focus));
  for (const s of ['planning', 'active', 'on_hold', 'completed']) {
    assert.ok(statuses.has(s), `no sample project is ${s}`);
  }
  for (const f of ['now', 'upcoming', 'someday']) {
    assert.ok(focuses.has(f), `no sample project is focused ${f}`);
  }
  assert.ok(rows.some((p: any) => p.archivedAt), 'nothing is archived, so Restore cannot be tried');
  // The archived one must remember a status to come back to.
  const archived = rows.find((p: any) => p.archivedAt);
  assert.ok(archived.preArchiveStatus, 'the archived sample cannot be restored');
});

test('sample: seeding twice adds nothing', async () => {
  const { db, ws, byName } = await setup();
  const first = await seedSampleProjects(db, ws, byName);
  const second = await seedSampleProjects(db, ws, byName);
  assert.equal(second.projectsCreated, 0, 'a second run duplicated the sample set');
  assert.equal(second.tasksCreated, 0);
  assert.equal(second.alreadyPresent, first.projectsCreated);
});

test('sample: every row carries the marker, and only sample rows do', async () => {
  const { db, ws, byName } = await setup();
  // A real project and a real task, created the way the user would.
  const [realProject] = await db.insert(projects).values({
    workspaceId: ws, title: 'A real project', outcome: 'Real', legacyId: null,
  }).returning();
  await db.insert(tasks).values({ workspaceId: ws, title: 'A real task' });
  await seedSampleProjects(db, ws, byName);

  const allProjects = await db.select().from(projects).where(eq(projects.workspaceId, ws));
  for (const p of allProjects) {
    const isSample = p.id !== realProject.id;
    assert.equal(String(p.legacyId ?? '').startsWith(SAMPLE_PREFIX), isSample,
      `"${p.title}" is marked wrongly — this is exactly how D4.3 nearly deleted real data`);
  }
});

test('sample: cleanup removes the sample set and nothing else', async () => {
  const { db, ws, byName } = await setup();
  const [realProject] = await db.insert(projects).values({
    workspaceId: ws, title: 'A real project', outcome: 'Real',
  }).returning();
  const [realTask] = await db.insert(tasks).values({
    workspaceId: ws, title: 'A real task', dueDate: '2026-09-01', bucket: 'today',
  }).returning();
  await seedSampleProjects(db, ws, byName);

  const footprint = await sampleFootprint(db, ws);
  const removed = await removeSampleProjects(db, ws);
  assert.equal(removed.projects, footprint.projects, 'cleanup removed a different number than it reported');
  assert.equal(removed.tasks, footprint.tasks);

  const left = await db.select().from(projects).where(eq(projects.workspaceId, ws));
  assert.equal(left.length, 1, 'cleanup removed a real project');
  assert.equal(left[0].id, realProject.id);

  const [task] = await db.select().from(tasks).where(eq(tasks.id, realTask.id));
  assert.ok(task, 'cleanup deleted a real task');
  assert.equal(task.dueDate, '2026-09-01');
  assert.equal(task.bucket, 'today');
});

test('sample: a real task assigned to a sample project survives cleanup', async () => {
  // The foreign key is `on delete set null`, so the work is kept and simply
  // loses the assignment. Losing a task because it was filed in test data would
  // be the worst possible outcome of a cleanup.
  const { db, ws, byName } = await setup();
  await seedSampleProjects(db, ws, byName);
  const [sampleProject] = await db.select().from(projects)
    .where(and(eq(projects.workspaceId, ws), eq(projects.status, 'active'))).limit(1);
  const [realTask] = await db.insert(tasks).values({
    workspaceId: ws, title: 'Mine, filed in a sample project',
    projectId: sampleProject.id, dueDate: '2026-09-15',
  }).returning();

  await removeSampleProjects(db, ws);
  const [after] = await db.select().from(tasks).where(eq(tasks.id, realTask.id));
  assert.ok(after, 'a real task was deleted with the sample project it was filed in');
  assert.equal(after.projectId, null);
  assert.equal(after.dueDate, '2026-09-15');
});

test('sample: cleanup matches ONLY the marker', () => {
  // Never on title, never on a date, never on "created recently" — every one of
  // those can also describe a real record.
  const src = readFileSync(join('src', 'lib', 'sample-projects.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export async function removeSampleProjects'));
  assert.match(fn, /like\(tasks\.legacyId, `\$\{SAMPLE_PREFIX\}%`\)/);
  assert.match(fn, /like\(projects\.legacyId, `\$\{SAMPLE_PREFIX\}%`\)/);
  for (const wrong of ['title', 'createdAt', 'isSynthetic']) {
    assert.ok(!fn.includes(wrong), `cleanup matches on ${wrong}, which a real record can also match`);
  }
  // A colon cannot appear in a Legacy uid(), so an imported project can never
  // collide with the marker.
  assert.match(src, /SAMPLE_PREFIX = 'sample:e2:'/);
});

test('sample: it is one module and one route block, so removing it is one commit', () => {
  const routes = readFileSync(join('src', 'routes', 'projects.ts'), 'utf8');
  assert.match(routes, /TEMPORARY — sample data for E2 review/,
    'the sample routes are not marked as temporary');
  assert.match(routes, /Sample data — TEMPORARY, staging only/);
  const web = readFileSync(join('..', 'web', 'app.js'), 'utf8');
  assert.match(web, /window\.__sample = \{/, 'there is no way to trigger it');
  // Not a control in the interface.
  assert.ok(!/Seed sample|Add test data|sample-btn/i.test(web),
    'sample data has a button in the product');
});
