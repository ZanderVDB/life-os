/**
 * Legacy import — the WRITE path.
 *
 * Design rules, in priority order:
 *
 *  1. **Refuse anything unexpected.** The counts Zander approved are passed in
 *     and checked before a single row is written. If the file disagrees, the
 *     import stops and reports the difference rather than adapting to it.
 *  2. **All or nothing.** Areas, tasks and steps are written in ONE transaction.
 *     A failure leaves the database exactly as it was.
 *  3. **Retry is safe.** Every row carries its `legacy_id`, unique per
 *     workspace, and the source fingerprint is recorded — so the same export
 *     cannot be imported twice and a retry after failure cannot duplicate.
 *  4. **Never invent data.** A completed task with no usable `doneAt` gets a
 *     null `completed_at`, not a guessed one.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, inArray, sql as raw } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { areas, tasks, taskSteps, taskActivity, migrationRuns } from '../db/schema.js';
import { buildImportPlan, type ImportPlan, type PlannedTask } from './legacy-import.js';
import { normaliseAreaName } from './bootstrap.js';

/** Sparse gap, matching the Task API so later moves behave identically. */
const GAP = 1000;
export const IMPORT_STEP = 'legacy-tasks-v1';
export const CONFIRM_PHRASE = (n: number) => `IMPORT ${n} TASKS`;

export interface ApprovedCounts {
  tasks: number; steps: number; areas: number; duplicateLegacyIds: number;
}

/**
 * Stable fingerprint of the source export.
 *
 * Keys are sorted so that re-serialising the same file always produces the same
 * digest, and only the Personal document plus the export header contribute —
 * a change to an ignored profile must not make an already-imported file look
 * new. The digest is over content we never store, so it also acts as proof of
 * which file was used without keeping the file.
 */
export function sourceFingerprint(exp: any): string {
  const stable = (v: any): any => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc: any, k) => { acc[k] = stable(v[k]); return acc; }, {});
    }
    return v;
  };
  const personalId = (exp?.profiles ?? []).find((p: any) =>
    p?.id === 'main' || p?.mode === 'personal' || /^personal$/i.test(String(p?.name ?? '')))?.id;
  const material = {
    exportFormat: exp?.exportFormat, exportVersion: exp?.exportVersion,
    appVersion: exp?.appVersion, createdAt: exp?.createdAt,
    personal: exp?.documents?.[personalId]?.data ?? null,
  };
  return createHash('sha256').update(JSON.stringify(stable(material))).digest('hex');
}

export interface CountMismatch { field: string; approved: number; found: number }

/** Compares the plan against the approved numbers. Empty array means proceed. */
export function checkApprovedCounts(plan: ImportPlan, approved: ApprovedCounts): CountMismatch[] {
  const dupes = plan.tasks.skipped.find((s) => s.reason === 'duplicate legacy id')?.count ?? 0;
  const found = {
    tasks: plan.tasks.total, steps: plan.steps.total,
    areas: plan.areas.total, duplicateLegacyIds: dupes,
  };
  return (Object.keys(found) as (keyof ApprovedCounts)[])
    .filter((k) => found[k] !== approved[k])
    .map((k) => ({ field: k, approved: approved[k], found: found[k] }));
}

/**
 * Assigns positions within each bucket.
 *
 * Active tasks come first, in legacy `ord` order, so the buckets look the way
 * they did in the old app. Completed tasks follow in their own range — they are
 * hidden from the buckets, but giving them positions inside the same sequence
 * keeps every position unique per bucket, which is what the ordering strategy
 * assumes.
 *
 * Tasks with no usable `ord` sort last, tie-broken by `legacyId`, so the result
 * is deterministic rather than dependent on object order in the file.
 */
export function assignPositions(plan: PlannedTask[]): Map<string, number> {
  const out = new Map<string, number>();
  const byBucket = new Map<string, PlannedTask[]>();
  for (const t of plan) {
    const list = byBucket.get(t.bucket) ?? [];
    list.push(t);
    byBucket.set(t.bucket, list);
  }
  const order = (a: PlannedTask, b: PlannedTask) => {
    const ao = a.legacyOrd ?? Number.MAX_SAFE_INTEGER;
    const bo = b.legacyOrd ?? Number.MAX_SAFE_INTEGER;
    return ao !== bo ? ao - bo : a.legacyId.localeCompare(b.legacyId);
  };
  for (const list of byBucket.values()) {
    const active = list.filter((t) => t.status !== 'done').sort(order);
    const done = list.filter((t) => t.status === 'done').sort(order);
    [...active, ...done].forEach((t, i) => out.set(t.legacyId, (i + 1) * GAP));
  }
  return out;
}

export interface ImportOutcome {
  ok: boolean;
  runId: string | null;
  fingerprint: string;
  /** What is actually in the database as a result. */
  written: { areas: number; tasks: number; steps: number; activity: number };
  /** Detail a human needs to trust the result, all counts. */
  detail: {
    activeTasks: number; completedTasks: number;
    completedWithTimestamp: number; completedWithoutTimestamp: number;
    scheduledAtParsed: number; scheduledTimeKeptRaw: number;
    createdAtFromLegacyDate: number;
    areasCreated: number; areasReusedExisting: number;
    tasksWithNoArea: number;
    unknownAreaKeys: string[];
    byBucket: Record<string, number>;
    activeByBucket: Record<string, number>;
  };
  errors: string[];
  warnings: string[];
}

/**
 * Performs the import. Everything below happens inside one transaction, so a
 * throw anywhere rolls back all of it — including the migration_runs row, which
 * is why a failure is recorded separately by the caller.
 */
export async function executeImport(
  db: Db, workspaceId: string, userId: string, exp: any, approved: ApprovedCounts,
): Promise<ImportOutcome> {
  const fingerprint = sourceFingerprint(exp);
  const plan = buildImportPlan(exp);
  const errors: string[] = [];
  const warnings: string[] = [...plan.warnings];

  const fail = (msg: string): ImportOutcome => ({
    ok: false, runId: null, fingerprint,
    written: { areas: 0, tasks: 0, steps: 0, activity: 0 },
    detail: emptyDetail(), errors: [msg, ...errors], warnings,
  });

  if (!plan.ok) return fail(`The export did not produce a usable plan: ${plan.errors.join('; ')}`);
  if (!plan.source.verified) return fail('Only a VERIFIED export may be imported.');

  const mismatches = checkApprovedCounts(plan, approved);
  if (mismatches.length) {
    return fail('The file no longer matches the approved counts: '
      + mismatches.map((m) => `${m.field} approved ${m.approved}, found ${m.found}`).join('; '));
  }

  // Has this exact file already been imported successfully?
  const prior = await db.select().from(migrationRuns).where(and(
    eq(migrationRuns.workspaceId, workspaceId),
    eq(migrationRuns.step, IMPORT_STEP),
    eq(migrationRuns.sourceRef, fingerprint),
    eq(migrationRuns.status, 'succeeded'),
  )).limit(1);
  if (prior.length) {
    return fail('This export has already been imported into this workspace. '
      + 'Importing it again would be a duplicate, so it was refused.');
  }

  const positions = assignPositions(plan.tasks.plan);
  const detail = emptyDetail();

  const runId = await db.transaction(async (tx) => {
    const [run] = await tx.insert(migrationRuns).values({
      workspaceId, phase: 'v2-relaunch', step: IMPORT_STEP,
      status: 'running', dryRun: false, sourceRef: fingerprint,
    }).returning();

    /* ── Areas ──────────────────────────────────────────────────────── */
    // Existing Areas are matched on the SAME normalised form the unique index
    // uses, so the import can never create a case- or spacing-variant duplicate.
    const existing = await tx.select().from(areas)
      .where(and(eq(areas.workspaceId, workspaceId), isNull(areas.deletedAt)));
    const byName = new Map(existing.map((a) => [normaliseAreaName(a.name), a]));
    const byLegacy = new Map(existing.filter((a) => a.legacyId).map((a) => [a.legacyId!, a]));
    /** legacy key (workProject id, or __personal/__work) → v2 area uuid */
    const areaIdFor = new Map<string, string>();

    const personal = byName.get('personal');
    const work = byName.get('work');
    if (personal) areaIdFor.set('__personal', personal.id);
    if (work) areaIdFor.set('__work', work.id);

    let maxPos = existing.reduce((n, a) => Math.max(n, a.position), 0);
    for (const a of plan.areas.plan) {
      const key = normaliseAreaName(a.name);
      const already = byLegacy.get(a.legacyId) ?? byName.get(key);
      if (already) {
        areaIdFor.set(a.legacyId, already.id);
        detail.areasReusedExisting++;
        continue;
      }
      const [created] = await tx.insert(areas).values({
        workspaceId, name: a.name.trim(), color: a.color,
        position: ++maxPos, isSystem: false, legacyId: a.legacyId,
      }).returning();
      areaIdFor.set(a.legacyId, created!.id);
      detail.areasCreated++;
    }

    /* ── Tasks ──────────────────────────────────────────────────────── */
    const taskRows = plan.tasks.plan.map((t) => {
      let areaId: string | null = null;
      if (t.areaLegacyKey) {
        const mapped = areaIdFor.get(t.areaLegacyKey);
        if (mapped) areaId = mapped;
        // An unmapped key is reported, never guessed at. The task still
        // imports; it simply arrives with no Area rather than a wrong one.
        else if (!detail.unknownAreaKeys.includes(t.areaLegacyKey)) {
          detail.unknownAreaKeys.push(t.areaLegacyKey);
        }
      }
      if (!areaId) detail.tasksWithNoArea++;
      if (t.status === 'done') {
        detail.completedTasks++;
        if (t.completedAt) detail.completedWithTimestamp++; else detail.completedWithoutTimestamp++;
      } else detail.activeTasks++;
      if (t.scheduledAt) detail.scheduledAtParsed++;
      if (t.legacyScheduledTimeRaw) detail.scheduledTimeKeptRaw++;
      if (t.legacyCreatedAt) detail.createdAtFromLegacyDate++;
      detail.byBucket[t.bucket] = (detail.byBucket[t.bucket] ?? 0) + 1;
      if (t.status !== 'done') {
        detail.activeByBucket[t.bucket] = (detail.activeByBucket[t.bucket] ?? 0) + 1;
      }

      return {
        workspaceId, areaId,
        // Projects do not exist. Never infer a relationship that never existed.
        projectId: null,
        title: t.title, notes: t.notes,
        status: t.status, bucket: t.bucket, priority: t.priority,
        dueDate: t.dueDate, scheduledAt: t.scheduledAt ? new Date(t.scheduledAt) : null,
        position: positions.get(t.legacyId) ?? GAP,
        // No doneAt in the source means no completion time. Leaving this null
        // is the honest answer; a stand-in date would be invented precision.
        completedAt: t.completedAt ? new Date(t.completedAt) : null,
        legacyId: t.legacyId,
        legacyScheduledTimeRaw: t.legacyScheduledTimeRaw,
        ...(t.legacyCreatedAt ? { createdAt: new Date(t.legacyCreatedAt) } : {}),
      };
    });

    const inserted = taskRows.length
      ? await tx.insert(tasks).values(taskRows).returning({ id: tasks.id, legacyId: tasks.legacyId })
      : [];
    const taskIdFor = new Map(inserted.map((r) => [r.legacyId!, r.id]));

    /* ── Steps ──────────────────────────────────────────────────────── */
    const stepRows = plan.tasks.plan.flatMap((t) => {
      const taskId = taskIdFor.get(t.legacyId);
      if (!taskId) return [];
      return t.steps.map((s, i) => ({
        taskId, workspaceId, title: s.title, completed: s.completed, position: i * GAP,
      }));
    });
    if (stepRows.length) await tx.insert(taskSteps).values(stepRows);

    /* ── Provenance ─────────────────────────────────────────────────── */
    // One activity row per task, attributed to the import rather than to a
    // person, so history reads truthfully later.
    const activityRows = inserted.map((r) => ({
      taskId: r.id, workspaceId, actorType: 'system' as const, actorUserId: userId,
      action: 'imported', changes: { source: 'legacy-v242', runId: run!.id },
    }));
    if (activityRows.length) await tx.insert(taskActivity).values(activityRows);

    await tx.update(migrationRuns).set({
      status: 'succeeded', finishedAt: new Date(),
      counts: { areas: detail.areasCreated, tasks: inserted.length, steps: stepRows.length },
      validation: detail,
    }).where(eq(migrationRuns.id, run!.id));

    detail.byBucket = detail.byBucket;
    return run!.id;
  });

  const written = await countWritten(db, workspaceId);
  if (detail.unknownAreaKeys.length) {
    warnings.push(`${detail.unknownAreaKeys.length} legacy Area key(s) could not be mapped; `
      + 'those tasks were imported with no Area rather than a guessed one.');
  }
  return { ok: true, runId, fingerprint, written, detail, errors, warnings };
}

async function countWritten(db: Db, workspaceId: string) {
  const [a] = await db.select({ n: raw<number>`count(*)::int` }).from(areas)
    .where(and(eq(areas.workspaceId, workspaceId), raw`${areas.legacyId} is not null`));
  const [t] = await db.select({ n: raw<number>`count(*)::int` }).from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), raw`${tasks.legacyId} is not null`));
  const [s] = await db.select({ n: raw<number>`count(*)::int` }).from(taskSteps)
    .where(and(eq(taskSteps.workspaceId, workspaceId),
      raw`${taskSteps.taskId} in (select id from tasks where legacy_id is not null)`));
  const [ac] = await db.select({ n: raw<number>`count(*)::int` }).from(taskActivity)
    .where(and(eq(taskActivity.workspaceId, workspaceId), eq(taskActivity.action, 'imported')));
  return { areas: a?.n ?? 0, tasks: t?.n ?? 0, steps: s?.n ?? 0, activity: ac?.n ?? 0 };
}

function emptyDetail(): ImportOutcome['detail'] {
  return {
    activeTasks: 0, completedTasks: 0,
    completedWithTimestamp: 0, completedWithoutTimestamp: 0,
    scheduledAtParsed: 0, scheduledTimeKeptRaw: 0, createdAtFromLegacyDate: 0,
    areasCreated: 0, areasReusedExisting: 0, tasksWithNoArea: 0,
    unknownAreaKeys: [], byBucket: {}, activeByBucket: {},
  };
}

/* ══ Staging-only cleanup of synthetic test records ══════════════════════
 *
 * Deliberately NOT a database reset. It can only delete tasks, only ones the
 * caller names explicitly, only ones with no `legacy_id` (so an imported row is
 * unreachable), and only outside production. Users, workspaces, memberships
 * and Areas are not touchable through this path at all.
 */
export const CLEANUP_CONFIRM = (n: number) => `DELETE ${n} STAGING TASKS`;

/**
 * The environment gate, as a plain predicate so it can be asserted directly.
 *
 * Inferring it from an HTTP response is not good enough: in production the
 * request would be rejected by authentication first, so a non-200 proves
 * nothing about this rule.
 */
export const isStagingCleanupAllowed = (nodeEnv: string): boolean => nodeEnv !== 'production';

/** Candidates: tasks that did not come from an import. */
export async function cleanupCandidates(db: Db, workspaceId: string) {
  const rows = await db.select({
    id: tasks.id, title: tasks.title, bucket: tasks.bucket,
    status: tasks.status, createdAt: tasks.createdAt,
  }).from(tasks).where(and(eq(tasks.workspaceId, workspaceId), isNull(tasks.legacyId)));
  return rows;
}

export async function deleteSyntheticTasks(
  db: Db, workspaceId: string, ids: string[],
): Promise<{ deleted: number; refused: { id: string; reason: string }[] }> {
  if (!ids.length) return { deleted: 0, refused: [] };

  const found = await db.select({ id: tasks.id, legacyId: tasks.legacyId })
    .from(tasks).where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, ids)));

  const refused: { id: string; reason: string }[] = [];
  const foundIds = new Set(found.map((r) => r.id));
  for (const id of ids) if (!foundIds.has(id)) refused.push({ id, reason: 'not in this workspace' });

  // The guard that matters: an imported row can never be deleted here.
  const deletable = found.filter((r) => {
    if (r.legacyId) { refused.push({ id: r.id, reason: 'imported record — refused' }); return false; }
    return true;
  }).map((r) => r.id);

  if (!deletable.length) return { deleted: 0, refused };
  // Steps and activity cascade with the task; nothing else is touched.
  const gone = await db.delete(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, deletable)))
    .returning({ id: tasks.id });
  return { deleted: gone.length, refused };
}
