/**
 * Habit application services.
 *
 * A tick is an entry for a habit on a DAY, and the day is part of the key —
 * ticking twice is a counter reaching two, not two rows. Undo removes the row
 * rather than storing a zero, because an absent entry and a zero entry would
 * otherwise both mean "not done" and the history could not tell them apart.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import {
  habits, habitEntries, FREQUENCY_TYPES,
} from '../../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { sql, isNull } from 'drizzle-orm';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const HabitCheckInput = z.object({
  /** The day being ticked. Defaults to today, in the server's civil date. */
  date: z.string().regex(ISO_DATE).optional(),
  /** An absolute count. Omitted means "one more than there is now". */
  count: z.number().int().min(0).max(100).optional(),
}).strict();

export type HabitCheck = z.infer<typeof HabitCheckInput>;

export async function checkHabit(db: Db, wsId: string, habitId: string, input: HabitCheck = {}) {
  const [habit] = await db.select().from(habits)
    .where(and(eq(habits.id, habitId), eq(habits.workspaceId, wsId))).limit(1);
  if (!habit) throw notFound('Habit not found.');

  const day = input.date ?? new Date().toISOString().slice(0, 10);
  const [existing] = await db.select().from(habitEntries)
    .where(and(eq(habitEntries.habitId, habitId), eq(habitEntries.entryDate, day))).limit(1);
  const next = input.count ?? (existing ? existing.completedCount + 1 : 1);

  if (next <= 0) {
    if (existing) await db.delete(habitEntries).where(eq(habitEntries.id, existing.id));
    return { habitId, date: day, completedCount: 0, completed: false };
  }

  const row = existing
    ? (await db.update(habitEntries)
      .set({ completedCount: next, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(habitEntries.id, existing.id)).returning())[0]!
    : (await db.insert(habitEntries).values({
      habitId, workspaceId: wsId, entryDate: day,
      completedCount: next, completedAt: new Date(), source: 'user',
    }).returning())[0]!;

  return {
    habitId,
    date: day,
    completedCount: row.completedCount,
    completed: row.completedCount >= habit.targetCount,
  };
}

/* ══ Creating and editing ════════════════════════════════════════════════ */

export const HabitCreateInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullish(),
  color: z.string().max(40).optional(),
  frequencyType: z.enum(FREQUENCY_TYPES).default('daily'),
  /** A JSON rule for the frequencies that need one, e.g. { days: [1,3,5] }. */
  frequencyConfig: z.record(z.unknown()).nullish(),
  /** 1 is a checkbox; more than 1 is a counter, e.g. "3 glasses". */
  targetCount: z.number().int().min(1).max(50).default(1),
  areaId: z.string().uuid().nullish(),
}).strict();

export const HabitUpdateInput = HabitCreateInput.partial().extend({
  isActive: z.boolean().optional(),
}).strict();

export async function createHabit(
  db: Db, wsId: string, input: z.infer<typeof HabitCreateInput>,
) {
  const [max] = await db.select({ m: sql<number>`coalesce(max(${habits.position}), 0)` })
    .from(habits).where(eq(habits.workspaceId, wsId));
  const [row] = await db.insert(habits).values([{
    workspaceId: wsId,
    name: input.name,
    description: input.description ?? null,
    ...(input.color ? { color: input.color } : {}),
    frequencyType: input.frequencyType,
    frequencyConfig: (input.frequencyConfig ?? null) as any,
    targetCount: input.targetCount,
    areaId: input.areaId ?? null,
    position: Number(max?.m ?? 0) + 1000,
  }]).returning();
  return row!;
}

export async function updateHabit(
  db: Db, wsId: string, id: string, input: z.infer<typeof HabitUpdateInput>,
) {
  if (!Object.keys(input).length) throw badRequest('No fields to update.');
  /* Field by field: `undefined` means "not mentioned" and null means "clear
     it", and a blanket spread would write undefined over a column. */
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ['name', 'description', 'areaId', 'frequencyType', 'frequencyConfig',
    'targetCount', 'color', 'isActive'] as const) {
    if ((input as any)[k] !== undefined) patch[k] = (input as any)[k] ?? null;
  }
  const [row] = await db.update(habits).set(patch)
    .where(and(eq(habits.id, id), eq(habits.workspaceId, wsId))).returning();
  if (!row) throw notFound('Habit not found.');
  return row;
}

/**
 * Archive, never delete.
 *
 * Archiving keeps the whole completion history and takes the habit off Today.
 * Deleting destroys a streak that took months to build, so the assistant is
 * given the reversible verb and not the other one — "stop showing me this" is
 * what people mean, and it is what this does.
 */
export async function archiveHabit(db: Db, wsId: string, id: string) {
  const [row] = await db.update(habits)
    .set({ archivedAt: new Date(), isActive: false, updatedAt: new Date() })
    .where(and(eq(habits.id, id), eq(habits.workspaceId, wsId))).returning();
  if (!row) throw notFound('Habit not found.');
  return row;
}

void isNull;
