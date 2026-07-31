/**
 * Schema + bootstrap + workspace isolation, against real Postgres (PGlite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, isNull } from 'drizzle-orm';
import { freshDb, identity } from './helpers.js';
import { ensureUserAndWorkspace, normaliseAreaName, DEFAULT_AREAS } from '../src/lib/bootstrap.js';
import { users, workspaces, workspaceMemberships, areas, tasks, taskSteps } from '../src/db/schema.js';

test('first-user bootstrap creates one user, one primary workspace, one membership', async () => {
  const { db } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());

  assert.ok(p.userId && p.workspaceId, 'principal is populated');
  assert.equal((await db.select().from(users)).length, 1);
  const ws = await db.select().from(workspaces);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].kind, 'primary');
  const mem = await db.select().from(workspaceMemberships);
  assert.equal(mem.length, 1);
  assert.equal(mem[0].role, 'owner');
});

test('bootstrap seeds EXACTLY Personal and Work — no optional Areas', async () => {
  const { db } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());
  const rows = await db.select().from(areas).where(eq(areas.workspaceId, p.workspaceId));
  const names = rows.map((r: any) => r.name).sort();
  assert.deepEqual(names, ['Personal', 'Work']);
  assert.equal(DEFAULT_AREAS.length, 2);
  for (const forbidden of ['Church', 'Health', 'Finance', 'Family', 'Learning']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be auto-seeded`);
  }
  assert.ok(rows.every((r: any) => r.isSystem), 'defaults are system areas');
});

test('bootstrap is idempotent — repeated sign-ins never duplicate', async () => {
  const { db } = await freshDb();
  const a = await ensureUserAndWorkspace(db, identity());
  const b = await ensureUserAndWorkspace(db, identity());
  const c = await ensureUserAndWorkspace(db, identity());
  assert.equal(a.workspaceId, b.workspaceId);
  assert.equal(b.workspaceId, c.workspaceId);
  assert.equal((await db.select().from(users)).length, 1);
  assert.equal((await db.select().from(workspaces)).length, 1);
  assert.equal((await db.select().from(areas)).length, 2);
});

test('an existing email is linked rather than duplicated when the uid changes', async () => {
  const { db } = await freshDb();
  const first = await ensureUserAndWorkspace(db, identity('same@example.com', 'uid-old'));
  const second = await ensureUserAndWorkspace(db, identity('same@example.com', 'uid-new'));
  assert.equal(first.userId, second.userId, 'same internal user');
  assert.equal((await db.select().from(users)).length, 1);
  const u = (await db.select().from(users))[0];
  assert.equal(u.firebaseUid, 'uid-new', 'external id is re-pointed');
});

test('only ONE primary workspace per user is possible', async () => {
  const { db } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());
  const userId = (await db.select().from(users))[0].id;
  await assert.rejects(
    () => db.insert(workspaces).values({ ownerUserId: userId, name: 'Second', kind: 'primary' }),
    'a second primary workspace must be rejected by the unique index',
  );
  assert.equal((await db.select().from(workspaces)).length, 1);
  assert.ok(p.workspaceId);
});

test('two users are fully isolated — no cross-workspace visibility', async () => {
  const { db } = await freshDb();
  const a = await ensureUserAndWorkspace(db, identity('a@example.com', 'uid-a'));
  const b = await ensureUserAndWorkspace(db, identity('b@example.com', 'uid-b'));
  assert.notEqual(a.workspaceId, b.workspaceId);

  await db.insert(tasks).values({ workspaceId: a.workspaceId, title: 'A task' });
  await db.insert(tasks).values({ workspaceId: b.workspaceId, title: 'B task' });

  const aTasks = await db.select().from(tasks).where(eq(tasks.workspaceId, a.workspaceId));
  assert.equal(aTasks.length, 1);
  assert.equal(aTasks[0].title, 'A task');

  // B is not a member of A's workspace.
  const cross = await db.select().from(workspaceMemberships).where(and(
    eq(workspaceMemberships.workspaceId, a.workspaceId),
    eq(workspaceMemberships.userId, (await db.select().from(users).where(eq(users.email, 'b@example.com')))[0].id),
  ));
  assert.equal(cross.length, 0, 'B must not be a member of A workspace');
});

test('Area names are unique per workspace after trim + case-fold', async () => {
  const { db } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());
  for (const dupe of ['work', 'WORK', '  Work  ', 'Work']) {
    await assert.rejects(
      () => db.insert(areas).values({ workspaceId: p.workspaceId, name: dupe }),
      `"${dupe}" must collide with the seeded Work area`,
    );
  }
  await db.insert(areas).values({ workspaceId: p.workspaceId, name: 'Church' });
  assert.equal((await db.select().from(areas).where(eq(areas.workspaceId, p.workspaceId))).length, 3);
});

test('normaliseAreaName folds case and collapses whitespace', () => {
  assert.equal(normaliseAreaName('  Work  '), 'work');
  assert.equal(normaliseAreaName('Deep   Work'), 'deep work');
  assert.equal(normaliseAreaName('PERSONAL'), 'personal');
});

test('the same Area name IS allowed in a different workspace', async () => {
  const { db } = await freshDb();
  const a = await ensureUserAndWorkspace(db, identity('a@example.com', 'uid-a'));
  const b = await ensureUserAndWorkspace(db, identity('b@example.com', 'uid-b'));
  await db.insert(areas).values({ workspaceId: a.workspaceId, name: 'Church' });
  await db.insert(areas).values({ workspaceId: b.workspaceId, name: 'Church' });
  assert.ok(true, 'uniqueness is scoped to the workspace, not global');
});

test('deleting an Area NEVER deletes its tasks (set null, not cascade)', async () => {
  const { db } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());
  const area = (await db.select().from(areas)
    .where(and(eq(areas.workspaceId, p.workspaceId), eq(areas.name, 'Work'))))[0];

  await db.insert(tasks).values({ workspaceId: p.workspaceId, areaId: area.id, title: 'Linked task' });
  await db.delete(areas).where(eq(areas.id, area.id));   // hard delete = worst case

  const remaining = await db.select().from(tasks).where(eq(tasks.workspaceId, p.workspaceId));
  assert.equal(remaining.length, 1, 'the task must survive');
  assert.equal(remaining[0].areaId, null, 'and simply lose its Area');
});

test('project_id is nullable and accepted for future Projects', async () => {
  const { db } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());
  const [none] = await db.insert(tasks).values({ workspaceId: p.workspaceId, title: 'No project' }).returning();
  assert.equal(none.projectId, null);
  const fakeProject = '11111111-2222-3333-4444-555555555555';
  const [withProj] = await db.insert(tasks)
    .values({ workspaceId: p.workspaceId, title: 'Future project task', projectId: fakeProject }).returning();
  assert.equal(withProj.projectId, fakeProject, 'placeholder accepts a uuid with no FK yet');
});

test('task CHECK constraints reject invalid enums', async () => {
  const { db } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());
  await assert.rejects(() => db.insert(tasks).values({
    workspaceId: p.workspaceId, title: 'x', bucket: 'someday-maybe' as any }), 'bad bucket');
  await assert.rejects(() => db.insert(tasks).values({
    workspaceId: p.workspaceId, title: 'x', priority: 'critical' as any }), 'bad priority');
  await assert.rejects(() => db.insert(tasks).values({
    workspaceId: p.workspaceId, title: 'x', status: 'wip' as any }), 'bad status');
});

test('task steps cascade with their task, and carry workspace_id', async () => {
  const { db } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());
  const [t] = await db.insert(tasks).values({ workspaceId: p.workspaceId, title: 'Parent' }).returning();
  await db.insert(taskSteps).values([
    { taskId: t.id, workspaceId: p.workspaceId, title: 'Step 1', position: 0 },
    { taskId: t.id, workspaceId: p.workspaceId, title: 'Step 2', position: 1 },
  ]);
  assert.equal((await db.select().from(taskSteps)).length, 2);
  await db.delete(tasks).where(eq(tasks.id, t.id));
  assert.equal((await db.select().from(taskSteps)).length, 0, 'steps go with the task');
});

test('deleting a workspace cascades its content', async () => {
  const { db } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());
  await db.insert(tasks).values({ workspaceId: p.workspaceId, title: 'x' });
  await db.delete(workspaces).where(eq(workspaces.id, p.workspaceId));
  assert.equal((await db.select().from(tasks)).length, 0);
  assert.equal((await db.select().from(areas)).length, 0);
});

test('legacy_id is unique per workspace — the idempotency guarantee', async () => {
  const { db } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());
  await db.insert(tasks).values({ workspaceId: p.workspaceId, title: 'One', legacyId: 'abc1234' });
  await assert.rejects(
    () => db.insert(tasks).values({ workspaceId: p.workspaceId, title: 'Dupe', legacyId: 'abc1234' }),
    're-importing the same legacy id must be rejected',
  );
  // …but many tasks may have NO legacy id (partial index).
  await db.insert(tasks).values({ workspaceId: p.workspaceId, title: 'a' });
  await db.insert(tasks).values({ workspaceId: p.workspaceId, title: 'b' });
  assert.equal((await db.select().from(tasks).where(isNull(tasks.legacyId))).length, 2);
});
