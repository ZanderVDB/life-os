/**
 * Habits import — the WRITE path. Same safety model as the Task import:
 * approved counts must match, one transaction, and the same file cannot be
 * imported twice.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { habits, habitEntries, migrationRuns } from '../db/schema.js';
import { buildHabitImportPlan } from './habit-import.js';

export const HABIT_IMPORT_STEP = 'legacy-habits-v1';
export const HABIT_CONFIRM = (n: number) => `IMPORT ${n} HABITS`;

export interface ApprovedHabitCounts { habits: number; entries: number }

/** Fingerprint over the habits slice of the Personal document only. */
export function habitSourceFingerprint(exp: any): string {
  const personalId = (exp?.profiles ?? []).find((p: any) =>
    p?.id === 'main' || p?.mode === 'personal' || /^personal$/i.test(String(p?.name ?? '')))?.id;
  const stable = (v: any): any => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((a: any, k) => { a[k] = stable(v[k]); return a; }, {});
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(stable({
    exportFormat: exp?.exportFormat, appVersion: exp?.appVersion, createdAt: exp?.createdAt,
    habits: exp?.documents?.[personalId]?.data?.habits ?? null,
  }))).digest('hex');
}

export interface HabitImportOutcome {
  ok: boolean;
  runId: string | null;
  fingerprint: string;
  written: { habits: number; entries: number };
  errors: string[];
  warnings: string[];
}

export async function executeHabitImport(
  db: Db, workspaceId: string, exp: any, approved: ApprovedHabitCounts,
): Promise<HabitImportOutcome> {
  const fingerprint = habitSourceFingerprint(exp);
  const plan = buildHabitImportPlan(exp);
  const fail = (msg: string): HabitImportOutcome => ({
    ok: false, runId: null, fingerprint, written: { habits: 0, entries: 0 },
    errors: [msg, ...plan.errors], warnings: plan.warnings,
  });

  if (!plan.ok) return fail(`The export did not produce a usable plan: ${plan.errors.join('; ')}`);
  if (!plan.source.verified) return fail('Only a VERIFIED export may be imported.');

  const mismatches: string[] = [];
  if (plan.habits.total !== approved.habits) {
    mismatches.push(`habits approved ${approved.habits}, found ${plan.habits.total}`);
  }
  if (plan.entries.total !== approved.entries) {
    mismatches.push(`entries approved ${approved.entries}, found ${plan.entries.total}`);
  }
  if (mismatches.length) {
    return fail(`The file no longer matches the approved counts: ${mismatches.join('; ')}`);
  }

  const prior = await db.select().from(migrationRuns).where(and(
    eq(migrationRuns.workspaceId, workspaceId),
    eq(migrationRuns.step, HABIT_IMPORT_STEP),
    eq(migrationRuns.sourceRef, fingerprint),
    eq(migrationRuns.status, 'succeeded'),
  )).limit(1);
  if (prior.length) {
    return fail('These habits have already been imported into this workspace.');
  }

  const runId = await db.transaction(async (tx) => {
    const [run] = await tx.insert(migrationRuns).values({
      workspaceId, phase: 'v2-relaunch', step: HABIT_IMPORT_STEP,
      status: 'running', dryRun: false, sourceRef: fingerprint,
    }).returning();

    const habitRows = plan.habits.plan.map((h) => ({
      workspaceId, name: h.name, color: h.color, position: h.position,
      targetCount: h.targetCount, frequencyType: h.frequencyType,
      legacyId: h.legacyId, isActive: true,
      ...(h.createdAt ? { createdAt: new Date(`${h.createdAt}T12:00:00Z`) } : {}),
    }));
    const inserted = habitRows.length
      ? await tx.insert(habits).values(habitRows).returning({ id: habits.id, legacyId: habits.legacyId })
      : [];
    const idFor = new Map(inserted.map((r) => [r.legacyId!, r.id]));

    const entryRows = plan.habits.plan.flatMap((h) => {
      const habitId = idFor.get(h.legacyId);
      if (!habitId) return [];
      return h.entryDates.map((entryDate) => ({
        habitId, workspaceId, entryDate, completedCount: 1,
        // Imported history has no real completion timestamp. Leaving this null
        // is honest; a stand-in would be invented precision.
        completedAt: null, source: 'import' as const,
      }));
    });
    if (entryRows.length) await tx.insert(habitEntries).values(entryRows);

    await tx.update(migrationRuns).set({
      status: 'succeeded', finishedAt: new Date(),
      counts: { habits: inserted.length, entries: entryRows.length },
      validation: {
        earliest: plan.entries.earliest, latest: plan.entries.latest,
        duplicatesCollapsed: plan.entries.duplicatesCollapsed,
        routineChecksExcluded: plan.notImported.routineCheckMarks,
        journalDaysUntouched: plan.notImported.journalDays,
      },
    }).where(eq(migrationRuns.id, run!.id));

    return run!.id;
  });

  const [h] = await db.select({ n: habits.id }).from(habits)
    .where(and(eq(habits.workspaceId, workspaceId)));
  void h;
  const written = {
    habits: (await db.select().from(habits).where(eq(habits.workspaceId, workspaceId)))
      .filter((r) => r.legacyId).length,
    entries: (await db.select().from(habitEntries).where(eq(habitEntries.workspaceId, workspaceId)))
      .filter((r) => r.source === 'import').length,
  };
  return { ok: true, runId, fingerprint, written, errors: [], warnings: plan.warnings };
}
