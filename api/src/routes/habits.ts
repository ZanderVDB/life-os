/**
 * Habits API.
 *
 * A habit is a recurring intention with a completion history — deliberately not
 * a task. The legacy app tangled habits into `routineLog` next to diary journal
 * text; this keeps them apart so each can be reasoned about on its own.
 *
 * Completion is idempotent per day. `habit_entries` has a unique index on
 * (habit_id, entry_date), so ticking twice updates a count rather than creating
 * a second row — which is also what makes the legacy import safe to re-run.
 */
import type { AppInstance, Guards } from '../types.js';
import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { habits, habitEntries, areas, FREQUENCY_TYPES } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';

const GAP = 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const HabitCreate = z.object({
  name: z.string().trim().min(1, 'A name is required.').max(200),
  description: z.string().max(2000).nullish(),
  areaId: z.string().uuid().nullish(),
  frequencyType: z.enum(FREQUENCY_TYPES).default('daily'),
  frequencyConfig: z.record(z.any()).nullish(),
  targetCount: z.number().int().min(1).max(100).default(1),
  color: z.string().max(32).default('sage'),
}).strict();

const HabitUpdate = HabitCreate.partial().extend({
  isActive: z.boolean().optional(),
  position: z.number().int().optional(),
}).strict();

/** Does this habit apply on this date? Drives what "today" shows. */
export function isDueOn(habit: { frequencyType: string; frequencyConfig: unknown }, date: Date): boolean {
  const cfg = (habit.frequencyConfig ?? {}) as { days?: number[] };
  switch (habit.frequencyType) {
    case 'specific_days':
      // 0 = Sunday, matching getDay(). An empty list means "no day", not "every day"
      // — guessing the opposite would silently show a habit the user muted.
      return Array.isArray(cfg.days) ? cfg.days.includes(date.getDay()) : false;
    case 'weekly':
    case 'times_per_week':
      // A weekly target is available to tick on any day of that week.
      return true;
    case 'daily':
    default:
      return true;
  }
}

export function registerHabitRoutes(app: AppInstance, db: Db, guards: Guards) {
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const base = '/api/v1/workspaces/:workspaceId';

  const assertArea = async (wsId: string, areaId?: string | null) => {
    if (!areaId) return;
    const a = (await db.select().from(areas).where(and(
      eq(areas.id, areaId), eq(areas.workspaceId, wsId), isNull(areas.deletedAt),
    )).limit(1))[0];
    if (!a) throw badRequest('That Area does not exist in this workspace.');
  };

  /**
   * GET …/habits?date=YYYY-MM-DD
   * Returns habits with today's entry attached, plus a streak count.
   */
  app.get(`${base}/habits`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const q = z.object({
      date: z.string().regex(ISO_DATE).optional(),
      includeArchived: z.enum(['true', 'false']).optional(),
      historyDays: z.coerce.number().int().min(0).max(400).default(30),
    }).parse(req.query ?? {});

    const today = q.date ?? new Date().toISOString().slice(0, 10);
    const where = [eq(habits.workspaceId, wsId)];
    if (q.includeArchived !== 'true') where.push(isNull(habits.archivedAt));

    const rows = await db.select().from(habits).where(and(...where))
      .orderBy(asc(habits.position), asc(habits.createdAt));
    if (!rows.length) return { habits: [], date: today };

    const from = new Date(`${today}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - q.historyDays);
    const fromStr = from.toISOString().slice(0, 10);

    const entries = await db.select().from(habitEntries).where(and(
      eq(habitEntries.workspaceId, wsId),
      gte(habitEntries.entryDate, fromStr),
      lte(habitEntries.entryDate, today),
    ));

    const byHabit = new Map<string, typeof entries>();
    for (const e of entries) {
      const list = byHabit.get(e.habitId) ?? [];
      list.push(e); byHabit.set(e.habitId, list);
    }

    return {
      date: today,
      habits: rows.map((h) => {
        const mine = byHabit.get(h.id) ?? [];
        const todayEntry = mine.find((e) => e.entryDate === today) ?? null;
        // Consecutive days ending today (or yesterday, so an unticked today
        // does not read as a broken streak before the day is over).
        const done = new Set(mine.filter((e) => e.completedCount >= h.targetCount)
          .map((e) => e.entryDate));
        let streak = 0;
        const cursor = new Date(`${today}T00:00:00Z`);
        if (!done.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
        while (done.has(cursor.toISOString().slice(0, 10))) {
          streak++;
          cursor.setUTCDate(cursor.getUTCDate() - 1);
        }
        return {
          ...h,
          dueToday: isDueOn(h, new Date(`${today}T12:00:00Z`)),
          todayCount: todayEntry?.completedCount ?? 0,
          completedToday: (todayEntry?.completedCount ?? 0) >= h.targetCount,
          streak,
          historyCount: mine.length,
        };
      }),
    };
  });

  app.post(`${base}/habits`, pre, async (req, reply) => {
    const wsId = req.workspaceId!;
    const body = HabitCreate.parse(req.body);
    await assertArea(wsId, body.areaId);

    const [maxRow] = await db.select({ max: sql<number>`coalesce(max(${habits.position}), 0)` })
      .from(habits).where(eq(habits.workspaceId, wsId));
    const created = (await db.insert(habits).values({
      workspaceId: wsId, name: body.name, description: body.description ?? null,
      areaId: body.areaId ?? null, frequencyType: body.frequencyType,
      frequencyConfig: body.frequencyConfig ?? null, targetCount: body.targetCount,
      color: body.color, position: Number(maxRow?.max ?? 0) + GAP,
    }).returning())[0]!;
    reply.code(201);
    return { habit: created };
  });

  app.patch(`${base}/habits/:habitId`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { habitId } = req.params as { habitId: string };
    const body = HabitUpdate.parse(req.body);
    if (!Object.keys(body).length) throw badRequest('No fields to update.');
    await assertArea(wsId, body.areaId);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ['name', 'description', 'areaId', 'frequencyType', 'frequencyConfig',
      'targetCount', 'color', 'isActive', 'position'] as const) {
      if (body[k] !== undefined) patch[k] = body[k] ?? null;
    }
    const updated = (await db.update(habits).set(patch)
      .where(and(eq(habits.id, habitId), eq(habits.workspaceId, wsId))).returning())[0];
    if (!updated) throw notFound('Habit not found.');
    return { habit: updated };
  });

  /**
   * DELETE …/habits/:id — archives by default.
   *
   * A habit's value is its history; deleting one throws that away. Archiving
   * keeps the record and hides it. `?permanent=true` is available but must be
   * asked for explicitly.
   */
  app.delete(`${base}/habits/:habitId`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { habitId } = req.params as { habitId: string };
    const q = z.object({ permanent: z.enum(['true', 'false']).optional() }).parse(req.query ?? {});

    if (q.permanent === 'true') {
      const gone = await db.delete(habits)
        .where(and(eq(habits.id, habitId), eq(habits.workspaceId, wsId))).returning();
      if (!gone.length) throw notFound('Habit not found.');
      return { deleted: true, archived: false };
    }
    const archived = (await db.update(habits)
      .set({ archivedAt: new Date(), isActive: false, updatedAt: new Date() })
      .where(and(eq(habits.id, habitId), eq(habits.workspaceId, wsId))).returning())[0];
    if (!archived) throw notFound('Habit not found.');
    return { deleted: false, archived: true, habit: archived };
  });

  /**
   * POST …/habits/:id/check — record a completion for a day.
   *
   * Idempotent: the unique index on (habit_id, entry_date) means a second call
   * updates the count instead of inserting a duplicate.
   */
  app.post(`${base}/habits/:habitId/check`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { habitId } = req.params as { habitId: string };
    const body = z.object({
      date: z.string().regex(ISO_DATE).optional(),
      count: z.number().int().min(0).max(100).optional(),
    }).parse(req.body ?? {});

    const habit = (await db.select().from(habits)
      .where(and(eq(habits.id, habitId), eq(habits.workspaceId, wsId))).limit(1))[0];
    if (!habit) throw notFound('Habit not found.');

    const day = body.date ?? new Date().toISOString().slice(0, 10);
    const existing = (await db.select().from(habitEntries)
      .where(and(eq(habitEntries.habitId, habitId), eq(habitEntries.entryDate, day))).limit(1))[0];
    const next = body.count ?? (existing ? existing.completedCount + 1 : 1);

    if (next <= 0) {
      // Undo removes the row entirely rather than storing a zero — an absent
      // entry and a zero entry would otherwise both mean "not done".
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
      habitId, date: day, completedCount: row.completedCount,
      completed: row.completedCount >= habit.targetCount,
    };
  });

  /** POST …/habits/:id/uncheck — the explicit undo. */
  app.post(`${base}/habits/:habitId/uncheck`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { habitId } = req.params as { habitId: string };
    const body = z.object({ date: z.string().regex(ISO_DATE).optional() }).parse(req.body ?? {});
    const day = body.date ?? new Date().toISOString().slice(0, 10);

    const habit = (await db.select().from(habits)
      .where(and(eq(habits.id, habitId), eq(habits.workspaceId, wsId))).limit(1))[0];
    if (!habit) throw notFound('Habit not found.');

    await db.delete(habitEntries)
      .where(and(eq(habitEntries.habitId, habitId), eq(habitEntries.entryDate, day)));
    return { habitId, date: day, completedCount: 0, completed: false };
  });
}
