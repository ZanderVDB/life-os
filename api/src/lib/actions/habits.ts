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
import { habits, habitEntries } from '../../db/schema.js';
import { notFound } from '../errors.js';

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
