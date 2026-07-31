/**
 * Legacy import — preview, execute, and staging-only cleanup.
 *
 * The export never leaves the user's device except to reach THIS API, which is
 * their own backend. It is never stored. The preview writes nothing at all, and
 * the writer refuses anything that disagrees with the approved counts.
 */
import type { AppInstance, Guards } from '../types.js';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { migrationRuns } from '../db/schema.js';
import { buildImportPlan, summarisePlan } from '../lib/legacy-import.js';
import {
  executeImport, sourceFingerprint, checkApprovedCounts, CONFIRM_PHRASE,
  CLEANUP_CONFIRM, IMPORT_STEP, cleanupCandidates, deleteSyntheticTasks,
  isStagingCleanupAllowed,
} from '../lib/import-writer.js';
import { buildHabitImportPlan, summariseHabitPlan } from '../lib/habit-import.js';
import {
  executeHabitImport, habitSourceFingerprint, HABIT_CONFIRM, HABIT_IMPORT_STEP,
} from '../lib/habit-import-writer.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import type { AppEnv } from '../env.js';

const ApprovedCounts = z.object({
  tasks: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  areas: z.number().int().nonnegative(),
  duplicateLegacyIds: z.number().int().nonnegative(),
});

export function registerImportRoutes(app: AppInstance, db: Db, guards: Guards, env: AppEnv) {
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const base = '/api/v1/workspaces/:workspaceId';

  /**
   * POST …/import/legacy/preview
   * Body: the parsed export JSON. Returns counts only. Writes NOTHING.
   */
  app.post(`${base}/import/legacy/preview`, pre, async (req) => {
    const body = z.object({ export: z.record(z.any()) }).safeParse(req.body);
    if (!body.success) throw badRequest('Send { "export": <the parsed export JSON> }.');
    const plan = buildImportPlan(body.data.export);
    return {
      preview: summarisePlan(plan),
      fingerprint: sourceFingerprint(body.data.export),
      confirmPhrase: CONFIRM_PHRASE(plan.tasks.total),
      wouldWrite: false,
    };
  });

  /**
   * POST …/import/legacy/execute — THE IRREVERSIBLE ONE.
   *
   * Requires the approved counts and the exact typed confirmation phrase. Any
   * disagreement stops the import before a single row is written.
   */
  app.post(`${base}/import/legacy/execute`, pre, async (req, reply) => {
    const parsed = z.object({
      export: z.record(z.any()),
      approved: ApprovedCounts,
      confirm: z.string(),
    }).safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Send { export, approved: {tasks,steps,areas,duplicateLegacyIds}, confirm }.');
    }
    const { export: exp, approved, confirm } = parsed.data;

    // The phrase names the number, so a confirmation typed for one count
    // cannot be replayed against a file that now has a different one.
    const expected = CONFIRM_PHRASE(approved.tasks);
    if (confirm.trim() !== expected) {
      throw badRequest(`To proceed, the confirmation must be exactly "${expected}".`);
    }

    // Checked here as well as in the writer, so the caller gets a precise diff
    // rather than a generic failure from inside the transaction.
    const plan = buildImportPlan(exp);
    const mismatches = checkApprovedCounts(plan, approved);
    if (plan.ok && mismatches.length) {
      reply.code(409);
      return {
        error: {
          code: 'COUNTS_CHANGED',
          message: 'This file no longer matches the approved counts. Nothing was imported.',
          details: { mismatches }, requestId: req.id,
        },
      };
    }

    const result = await executeImport(db, req.workspaceId!, req.principal!.userId, exp, approved);

    if (!result.ok) {
      // Record the refusal for the audit trail. Written outside the failed
      // transaction so it survives the rollback.
      await db.insert(migrationRuns).values({
        workspaceId: req.workspaceId!, phase: 'v2-relaunch', step: IMPORT_STEP,
        status: 'failed', dryRun: false, sourceRef: result.fingerprint,
        error: { messages: result.errors }, finishedAt: new Date(),
      });
      req.log.warn({ step: IMPORT_STEP, reasons: result.errors.length }, 'legacy import refused');
      reply.code(409);
      return {
        error: {
          code: 'IMPORT_REFUSED', message: result.errors[0] ?? 'The import was refused.',
          details: { errors: result.errors, wroteAnything: false }, requestId: req.id,
        },
      };
    }

    req.log.info({ runId: result.runId, written: result.written }, 'legacy import committed');
    return {
      ok: true, runId: result.runId, written: result.written,
      detail: result.detail, warnings: result.warnings,
    };
  });

  /* ── Habits import ──────────────────────────────────────────────────
   * Same safety model as Tasks: preview writes nothing, execute demands the
   * approved counts and a typed phrase, and the same file cannot land twice.
   */
  app.post(`${base}/import/habits/preview`, pre, async (req) => {
    const body = z.object({ export: z.record(z.any()) }).safeParse(req.body);
    if (!body.success) throw badRequest('Send { "export": <the parsed export JSON> }.');
    const plan = buildHabitImportPlan(body.data.export);
    return {
      preview: summariseHabitPlan(plan),
      fingerprint: habitSourceFingerprint(body.data.export),
      confirmPhrase: HABIT_CONFIRM(plan.habits.total),
      wouldWrite: false,
    };
  });

  app.post(`${base}/import/habits/execute`, pre, async (req, reply) => {
    const parsed = z.object({
      export: z.record(z.any()),
      approved: z.object({
        habits: z.number().int().nonnegative(),
        entries: z.number().int().nonnegative(),
      }),
      confirm: z.string(),
    }).safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Send { export, approved: {habits,entries}, confirm }.');
    }
    const { export: exp, approved, confirm } = parsed.data;
    const expected = HABIT_CONFIRM(approved.habits);
    if (confirm.trim() !== expected) {
      throw badRequest(`To proceed, the confirmation must be exactly "${expected}".`);
    }

    const result = await executeHabitImport(db, req.workspaceId!, exp, approved);
    if (!result.ok) {
      await db.insert(migrationRuns).values({
        workspaceId: req.workspaceId!, phase: 'v2-relaunch', step: HABIT_IMPORT_STEP,
        status: 'failed', dryRun: false, sourceRef: result.fingerprint,
        error: { messages: result.errors }, finishedAt: new Date(),
      });
      reply.code(409);
      return {
        error: {
          code: 'IMPORT_REFUSED', message: result.errors[0] ?? 'The import was refused.',
          details: { errors: result.errors, wroteAnything: false }, requestId: req.id,
        },
      };
    }
    req.log.info({ runId: result.runId, written: result.written }, 'habit import committed');
    return { ok: true, runId: result.runId, written: result.written, warnings: result.warnings };
  });

  /** Import history for this workspace — counts and status only. */
  app.get(`${base}/import/legacy/runs`, pre, async (req) => {
    const rows = await db.select().from(migrationRuns)
      .where(and(eq(migrationRuns.workspaceId, req.workspaceId!), eq(migrationRuns.step, IMPORT_STEP)))
      .orderBy(desc(migrationRuns.startedAt)).limit(20);
    return {
      runs: rows.map((r) => ({
        id: r.id, status: r.status, dryRun: r.dryRun,
        // Enough of the fingerprint to recognise a file, not enough to be noise.
        sourceRef: r.sourceRef ? `${r.sourceRef.slice(0, 12)}…` : null,
        counts: r.counts, startedAt: r.startedAt, finishedAt: r.finishedAt,
      })),
    };
  });

  /* ── Staging-only cleanup ───────────────────────────────────────────
   *
   * Deliberately not a database reset. Tasks only, named explicitly by the
   * caller, never imported ones, never in production. Users, workspaces,
   * memberships and Areas are unreachable through this path.
   */
  const refuseInProduction = () => {
    if (!isStagingCleanupAllowed(env.NODE_ENV)) {
      throw forbidden('Staging cleanup does not exist in production.');
    }
  };

  app.get(`${base}/staging/cleanup/preview`, pre, async (req) => {
    refuseInProduction();
    const rows = await cleanupCandidates(db, req.workspaceId!);
    return {
      // Titles are returned so the caller can see what they are about to
      // delete — that is the whole point of a confirmation. They are never
      // written to the log.
      candidates: rows.map((r) => ({
        id: r.id, title: r.title, bucket: r.bucket, status: r.status, createdAt: r.createdAt,
      })),
      count: rows.length,
      confirmPhrase: CLEANUP_CONFIRM(rows.length),
      note: 'Only tasks with no legacy_id are listed. Imported records, users, '
        + 'workspaces, memberships and Areas can never be deleted here.',
    };
  });

  app.post(`${base}/staging/cleanup`, pre, async (req) => {
    refuseInProduction();
    const parsed = z.object({
      taskIds: z.array(z.string().uuid()).min(1).max(500),
      confirm: z.string(),
    }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Send { taskIds: [...], confirm: "DELETE N STAGING TASKS" }.');

    const { taskIds, confirm } = parsed.data;
    const expected = CLEANUP_CONFIRM(taskIds.length);
    if (confirm.trim() !== expected) {
      throw badRequest(`To proceed, the confirmation must be exactly "${expected}".`);
    }

    const result = await deleteSyntheticTasks(db, req.workspaceId!, taskIds);
    if (result.refused.some((r) => r.reason.includes('imported'))) {
      throw conflict('One or more of those ids are imported records. Nothing was deleted.');
    }
    // Counts only — never the titles of what was removed.
    req.log.info({ deleted: result.deleted, refused: result.refused.length }, 'staging cleanup');
    return { deleted: result.deleted, refused: result.refused };
  });
}
