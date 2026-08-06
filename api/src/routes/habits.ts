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
import {
  habits, habitEntries, areas, diaryEntries, FREQUENCY_TYPES,
} from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
// One implementation of "due and done on a day", shared with Calendar.
import { habitHistory } from '../lib/habit-history.js';
/* The computed `Write in Diary` habit. Habits, Calendar and Today all go
 * through this one provider — §6 of D2.2 exists because they did not. */
import {
  writtenDays, diaryHabitRow, diaryHabitSince, addDiaryToHabitDays,
  diaryHabitEnabled, habitTotals, DIARY_HABIT_ID,
} from '../lib/diary-habit.js';
import { readPreferences } from './preferences.js';

const GAP = 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Civil date arithmetic on UTC midnights. A day counter, not a timestamp. */
const addDaysUtc = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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

  /**
   * The diary side of the habit system, for a date range.
   *
   * One query, one rule, whatever asked. Returns an empty set when the setting
   * is off, so every caller's arithmetic stays the same and no caller has to
   * remember to check the preference twice.
   */
  const diarySide = async (wsId: string, userId: string, from: string, to: string) => {
    const prefs = await readPreferences(db, userId);
    const enabled = diaryHabitEnabled(prefs);
    if (!enabled) return { enabled, written: new Set<string>() };
    const rows = await db.select({
      entryDate: diaryEntries.entryDate,
      document: diaryEntries.document,
      title: diaryEntries.title,
      mood: diaryEntries.mood,
      energy: diaryEntries.energy,
      weatherNote: diaryEntries.weatherNote,
      locationNote: diaryEntries.locationNote,
      daySummary: diaryEntries.daySummary,
      reflection: diaryEntries.reflection,
    }).from(diaryEntries).where(and(
      eq(diaryEntries.workspaceId, wsId),
      isNull(diaryEntries.archivedAt),
      gte(diaryEntries.entryDate, from),
      lte(diaryEntries.entryDate, to),
    ));
    return { enabled, written: writtenDays(rows) };
  };

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

    /* The computed row and the totals, from the ONE provider. Fetched even when
     * there are no ordinary habits: "0/1" on a workspace whose only habit is
     * the diary is a correct answer, and returning early with `{habits: []}`
     * was how Today came to report `0/5` with the diary written. */
    const diaryFrom = addDaysUtc(today, -400);
    const { enabled: diaryOn, written } = await diarySide(
      wsId, req.principal!.userId, diaryFrom, today,
    );
    const diaryHabit = diaryOn ? diaryHabitRow(written, today) : null;

    if (!rows.length) {
      return {
        date: today,
        habits: [],
        diaryHabit,
        totals: habitTotals([], diaryHabit),
      };
    }

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

    const ordinary = rows.map((h) => {
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
      });

    return {
      date: today,
      habits: ordinary,
      /* Beside the list, never IN it. It has no row, no position and nothing to
       * tick, so a client that merged it into `habits` would eventually try to
       * PATCH or check it. The totals below are the only place the two are
       * added together, and they are added in exactly one place. */
      diaryHabit,
      totals: habitTotals(ordinary, diaryHabit),
    };
  });

  /**
   * GET …/habits/history?from=YYYY-MM-DD&to=YYYY-MM-DD
   *
   * One row per day in the range: how many habits were due, and how many were
   * done. This is what the Calendar month grid needs — a whole month in one
   * request instead of thirty-one calls to `GET /habits?date=`.
   *
   * **The dates are plain strings and are never turned into instants.** The
   * client sends the LOCAL day it is drawing; `entry_date` is a `date` column,
   * not a timestamp. Parsing "2026-08-03" as a Date in a UTC+2 process, or
   * anywhere west of Greenwich, is how a tick lands on the wrong square — and
   * it does it silently, only near midnight, only for some users.
   *
   * The one place a Date is unavoidable is the weekday for `specific_days`, and
   * it is built at NOON so no timezone offset can push it into the day either
   * side.
   */
  app.get(`${base}/habits/history`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const q = z.object({
      from: z.string().regex(ISO_DATE),
      to: z.string().regex(ISO_DATE),
    }).parse(req.query ?? {});
    if (q.to < q.from) throw badRequest('`to` cannot be before `from`.');
    // ISO dates sort correctly as text, so this comparison needs no parsing.
    const span = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000;
    if (span > 366) throw badRequest('That range is longer than a year.');

    // Archived habits are excluded: they were not being tracked, so counting
    // them as due would invent misses that never happened.
    const rows = await db.select().from(habits)
      .where(and(eq(habits.workspaceId, wsId), isNull(habits.archivedAt)))
      .orderBy(asc(habits.position), asc(habits.createdAt));

    const entries = rows.length
      ? await db.select().from(habitEntries).where(and(
        eq(habitEntries.workspaceId, wsId),
        gte(habitEntries.entryDate, q.from),
        lte(habitEntries.entryDate, q.to),
      ))
      : [];

    /* The Diary series, folded into the same day rows (§9). Not a second
     * response field the caller has to remember to add: a day that was 2/3
     * becomes 2/4 or 3/4 here, and every existing reader is already correct. */
    const { enabled, written } = await diarySide(
      wsId, req.principal!.userId, addDaysUtc(q.from, -400), q.to,
    );
    const days = addDiaryToHabitDays(
      habitHistory(rows, entries, q.from, q.to),
      written,
      { enabled, since: diaryHabitSince(written, q.to) },
    );

    return {
      from: q.from,
      to: q.to,
      days,
      /* Named so a caller can label the series and open the day it belongs to.
       * Null when the setting is off — which is also how the client knows to
       * stop drawing it, without a second request for the preference. */
      diarySeries: enabled
        ? { id: DIARY_HABIT_ID, name: 'Write in Diary', route: '#diary' }
        : null,
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
