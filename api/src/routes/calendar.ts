/**
 * Calendar API (Phase D3) — synthetic data only.
 *
 * There is NO Google code here, deliberately. The whole point of D3 is to
 * design against realistic data before connecting a real account, so that the
 * UI is not shaped by whatever happened to be in the user's calendar.
 *
 * Every row this file creates carries `is_synthetic = true`, so the entire
 * demonstration dataset can be removed with one delete per table before any
 * real connection is made.
 */
import type { AppInstance, Guards } from '../types.js';
import { and, asc, eq, gte, lte, or, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  calendars, calendarEvents, calendarEventAttendees, reminders,
  taskScheduleBlocks, itemLinks, tasks, habitEntries, habits,
  reminderRecurrenceRules,
} from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { habitHistory } from '../lib/habit-history.js';
import { isStagingCleanupAllowed } from '../lib/import-writer.js';
import { expand, describe as describeRule, nextAfter } from '../lib/recurrence.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Typed verbatim to confirm. Long enough that it cannot be an accident. */
const CONFIRM_PHRASE = 'DELETE SYNTHETIC CALENDAR DATA';

const RangeQuery = z.object({
  from: z.string().regex(ISO_DATE, 'from must be YYYY-MM-DD'),
  to: z.string().regex(ISO_DATE, 'to must be YYYY-MM-DD'),
});

const EventBody = z.object({
  calendarId: z.string().uuid().nullish(),
  title: z.string().trim().min(1, 'A title is required.').max(500),
  description: z.string().max(8000).nullish(),
  location: z.string().max(500).nullish(),
  isAllDay: z.boolean().default(false),
  startsAt: z.string().datetime().nullish(),
  endsAt: z.string().datetime().nullish(),
  startDate: z.string().regex(ISO_DATE).nullish(),
  endDate: z.string().regex(ISO_DATE).nullish(),
  timeZone: z.string().max(80).nullish(),
  recurrence: z.array(z.string()).nullish(),
  transparency: z.enum(['opaque', 'transparent']).default('opaque'),
  visibility: z.enum(['default', 'public', 'private', 'confidential']).default('default'),
  providerColorId: z.string().max(16).nullish(),
});

const BlockBody = z.object({
  taskId: z.string().uuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

/**
 * A recurrence rule, in the shape the reminder_recurrence_rules table stores.
 *
 * Deliberately structured rather than an RRULE string: "monthly on day 25" is
 * something Life OS has to reason about — to work out the next occurrence and
 * whether it is overdue — and parsing an RRULE every time to answer that would
 * be doing the same work twice.
 */
const RecurrenceBody = z.object({
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  interval: z.number().int().min(1).max(52).default(1),
  byWeekday: z.array(z.number().int().min(0).max(6)).nullish(),
  byMonthDay: z.array(z.number().int().min(1).max(31)).nullish(),
  until: z.string().regex(ISO_DATE).nullish(),
  count: z.number().int().min(1).max(999).nullish(),
});

const ReminderBody = z.object({
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(4000).nullish(),
  dueDate: z.string().regex(ISO_DATE).nullish(),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
  areaId: z.string().uuid().nullish(),
  leadDays: z.number().int().min(0).max(90).default(0),
  // Zod strips unknown keys, so an unlisted `recurrence` vanished without an
  // error and the modal's Repeat control never persisted anything.
  recurrence: RecurrenceBody.nullish(),
});

/** Day offset from today, as a Date at a given local hour. */
function at(dayOffset: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}
function isoDay(dayOffset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  return d.toISOString().slice(0, 10);
}

export function registerCalendarRoutes(app: AppInstance, db: Db, guards: Guards) {
  // Same guard pair every other route uses: authenticate, then resolve and
  // authorise the workspace in the path.
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };

  /* ── Calendars ─────────────────────────────────────────────────────── */
  app.get('/api/v1/workspaces/:workspaceId/calendars', pre, async (req) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const rows = await db.select().from(calendars)
      .where(eq(calendars.workspaceId, workspaceId))
      .orderBy(asc(calendars.name));
    return { calendars: rows };
  });

  /* ── Everything in a date range ────────────────────────────────────────
   * One request per view. Month, Agenda and Plan differ in how they PRESENT
   * time, not in what they can see, so they share this endpoint and filter
   * client-side by layer. */
  app.get('/api/v1/workspaces/:workspaceId/calendar/range', pre, async (req) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const q = RangeQuery.safeParse(req.query);
    if (!q.success) throw badRequest(q.error.issues[0]!.message);
    const from = new Date(`${q.data.from}T00:00:00.000Z`);
    const to = new Date(`${q.data.to}T23:59:59.999Z`);

    const cals = await db.select().from(calendars)
      .where(eq(calendars.workspaceId, workspaceId));
    const calById = new Map(cals.map((c) => [c.id, c]));

    // Timed events overlapping the window, plus all-day events by date.
    const events = await db.select().from(calendarEvents).where(and(
      eq(calendarEvents.workspaceId, workspaceId),
      or(
        and(gte(calendarEvents.startsAt, from), lte(calendarEvents.startsAt, to)),
        and(gte(calendarEvents.startDate, q.data.from), lte(calendarEvents.startDate, q.data.to)),
      ),
    )).orderBy(asc(calendarEvents.startsAt));

    const attendees = events.length
      ? await db.select().from(calendarEventAttendees)
        .where(eq(calendarEventAttendees.workspaceId, workspaceId))
      : [];
    const byEvent = new Map<string, typeof attendees>();
    for (const a of attendees) {
      if (!byEvent.has(a.eventId)) byEvent.set(a.eventId, []);
      byEvent.get(a.eventId)!.push(a);
    }

    /*
     * Reminders are fetched WITHOUT a date filter, then expanded.
     *
     * Filtering by due date first would hide exactly the reminders this needs:
     * a monthly reminder anchored in August must still produce an occurrence
     * in December, and its stored row is nowhere near December.
     */
    const allRems = await db.select().from(reminders)
      .where(eq(reminders.workspaceId, workspaceId));
    const rules = await db.select().from(reminderRecurrenceRules)
      .where(eq(reminderRecurrenceRules.workspaceId, workspaceId));
    const ruleFor = new Map(rules.map((r) => [r.reminderId, r]));

    // One row per occurrence in range. The id stays the canonical reminder's,
    // so completing any occurrence reaches the right record; `occurrenceDate`
    // is what the view places.
    const rems = allRems.flatMap((r) => {
      if (!r.dueDate) return [];
      // A paused reminder keeps its rule but produces no future occurrences.
      if (r.status === 'paused') return [];
      const rule = ruleFor.get(r.id) ?? null;
      return expand(r.dueDate, rule, q.data.from, q.data.to).map((o) => ({
        ...r,
        dueDate: o.date,
        occurrenceDate: o.date,
        isVirtual: o.isVirtual,
        // Only the stored occurrence can carry a completion; a virtual one is
        // by definition still ahead of you.
        status: o.isVirtual ? 'open' : r.status,
        recurrence: rule,
        recurrenceText: describeRule(rule),
      }));
    }).sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    const blocks = await db.select({
      id: taskScheduleBlocks.id,
      taskId: taskScheduleBlocks.taskId,
      startsAt: taskScheduleBlocks.startsAt,
      endsAt: taskScheduleBlocks.endsAt,
      title: tasks.title,
      priority: tasks.priority,
      areaId: tasks.areaId,
      dueDate: tasks.dueDate,
    }).from(taskScheduleBlocks)
      .innerJoin(tasks, eq(tasks.id, taskScheduleBlocks.taskId))
      .where(and(
        eq(taskScheduleBlocks.workspaceId, workspaceId),
        gte(taskScheduleBlocks.startsAt, from),
        lte(taskScheduleBlocks.startsAt, to),
      )).orderBy(asc(taskScheduleBlocks.startsAt));

    // Task DEADLINES are a different layer from scheduled blocks — the whole
    // point of keeping due date and scheduled time apart.
    const deadlines = await db.select({
      id: tasks.id, title: tasks.title, dueDate: tasks.dueDate,
      priority: tasks.priority, areaId: tasks.areaId, status: tasks.status,
    }).from(tasks).where(and(
      eq(tasks.workspaceId, workspaceId),
      gte(tasks.dueDate, q.data.from),
      lte(tasks.dueDate, q.data.to),
      eq(tasks.status, 'open'),
    ));

    /* Habit completion COUNTS only — Calendar summarises rhythm, it does not
     * turn habits into events or repeat them as daily agenda noise.
     *
     * `due` AND `done` per day, from the shared helper. It used to be a plain
     * `count(*)` of entry rows against a flat total of unarchived habits, and
     * both halves were wrong: a Monday-only habit counted against every day of
     * the week, and a habit with a target of 3 read as done after one tick. The
     * grid was showing "2/5" on days where two of two were finished.
     *
     * Days with nothing due are dropped, so the grid can distinguish "nothing
     * was asked of you" from "you did none of it". */
    const habitRows = await db.select().from(habits).where(and(
      eq(habits.workspaceId, workspaceId), isNull(habits.archivedAt),
    ));
    const habitEntryRows = habitRows.length
      ? await db.select().from(habitEntries).where(and(
        eq(habitEntries.workspaceId, workspaceId),
        gte(habitEntries.entryDate, q.data.from),
        lte(habitEntries.entryDate, q.data.to),
      ))
      : [];
    const habitDays = habitHistory(habitRows, habitEntryRows, q.data.from, q.data.to)
      .filter((d) => d.due > 0);
    const habitTotal = habitRows.length;

    const links = await db.select().from(itemLinks)
      .where(eq(itemLinks.workspaceId, workspaceId));

    return {
      calendars: cals,
      events: events.map((e) => ({
        ...e,
        calendarName: calById.get(e.calendarId)?.name ?? null,
        calendarColor: calById.get(e.calendarId)?.color ?? null,
        isReadOnly: calById.get(e.calendarId)?.isReadOnly ?? true,
        attendees: byEvent.get(e.id) ?? [],
      })),
      reminders: rems,
      blocks,
      deadlines,
      habitDays,
      habitTotal,
      links,
    };
  });

  /* ── Event create / update / delete (synthetic only in D3) ──────────── */
  app.post('/api/v1/workspaces/:workspaceId/calendar/events', pre, async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const b = EventBody.safeParse(req.body);
    if (!b.success) throw badRequest(b.error.issues[0]!.message);

    let calendarId = b.data.calendarId ?? null;
    if (!calendarId) {
      const [primary] = await db.select().from(calendars).where(and(
        eq(calendars.workspaceId, workspaceId), eq(calendars.isReadOnly, false),
      )).limit(1);
      if (!primary) throw badRequest('No writable calendar is available.');
      calendarId = primary.id;
    }
    const [cal] = await db.select().from(calendars).where(and(
      eq(calendars.id, calendarId), eq(calendars.workspaceId, workspaceId),
    ));
    if (!cal) throw notFound('Calendar not found.');
    // A reader calendar must never accept a write, whatever the UI offered.
    if (cal.isReadOnly) throw badRequest('That calendar is read-only.');

    const [row] = await db.insert(calendarEvents).values({
      workspaceId, calendarId,
      title: b.data.title,
      description: b.data.description ?? null,
      location: b.data.location ?? null,
      isAllDay: b.data.isAllDay,
      startsAt: b.data.isAllDay ? null : (b.data.startsAt ? new Date(b.data.startsAt) : null),
      endsAt: b.data.isAllDay ? null : (b.data.endsAt ? new Date(b.data.endsAt) : null),
      startDate: b.data.isAllDay ? b.data.startDate ?? null : null,
      endDate: b.data.isAllDay ? b.data.endDate ?? null : null,
      timeZone: b.data.timeZone ?? null,
      recurrence: b.data.recurrence ?? null,
      transparency: b.data.transparency,
      visibility: b.data.visibility,
      providerColorId: b.data.providerColorId ?? null,
      syncState: 'local_only',
      isSynthetic: true,
    }).returning();
    reply.code(201);
    return { event: row };
  });

  app.patch('/api/v1/workspaces/:workspaceId/calendar/events/:id', pre, async (req) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const b = EventBody.partial().safeParse(req.body);
    if (!b.success) throw badRequest(b.error.issues[0]!.message);

    const [existing] = await db.select().from(calendarEvents).where(and(
      eq(calendarEvents.id, id), eq(calendarEvents.workspaceId, workspaceId),
    ));
    if (!existing) throw notFound('Event not found.');
    const [cal] = await db.select().from(calendars)
      .where(eq(calendars.id, existing.calendarId));
    if (cal?.isReadOnly) throw badRequest('That event is on a read-only calendar.');

    const d = b.data;
    const allDay = d.isAllDay ?? existing.isAllDay;
    const [row] = await db.update(calendarEvents).set({
      ...(d.title !== undefined ? { title: d.title } : {}),
      ...(d.description !== undefined ? { description: d.description ?? null } : {}),
      ...(d.location !== undefined ? { location: d.location ?? null } : {}),
      ...(d.isAllDay !== undefined ? { isAllDay: allDay } : {}),
      ...(d.startsAt !== undefined ? { startsAt: allDay || !d.startsAt ? null : new Date(d.startsAt) } : {}),
      ...(d.endsAt !== undefined ? { endsAt: allDay || !d.endsAt ? null : new Date(d.endsAt) } : {}),
      ...(d.startDate !== undefined ? { startDate: allDay ? d.startDate ?? null : null } : {}),
      ...(d.endDate !== undefined ? { endDate: allDay ? d.endDate ?? null : null } : {}),
      ...(d.transparency !== undefined ? { transparency: d.transparency } : {}),
      ...(d.visibility !== undefined ? { visibility: d.visibility } : {}),
      ...(d.providerColorId !== undefined ? { providerColorId: d.providerColorId ?? null } : {}),
      ...(d.recurrence !== undefined ? { recurrence: d.recurrence ?? null } : {}),
      updatedAt: new Date(),
    }).where(eq(calendarEvents.id, id)).returning();
    return { event: row };
  });

  app.delete('/api/v1/workspaces/:workspaceId/calendar/events/:id', pre, async (req, reply) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const [existing] = await db.select().from(calendarEvents).where(and(
      eq(calendarEvents.id, id), eq(calendarEvents.workspaceId, workspaceId),
    ));
    if (!existing) throw notFound('Event not found.');
    const [cal] = await db.select().from(calendars)
      .where(eq(calendars.id, existing.calendarId));
    if (cal?.isReadOnly) throw badRequest('That event is on a read-only calendar.');
    await db.delete(calendarEvents).where(eq(calendarEvents.id, id));
    reply.code(204);
    return null;
  });

  /* ── Reminders ─────────────────────────────────────────────────────── */
  app.post('/api/v1/workspaces/:workspaceId/reminders', pre, async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const b = ReminderBody.safeParse(req.body);
    if (!b.success) throw badRequest(b.error.issues[0]!.message);
    const { recurrence, ...fields } = b.data;

    // Reminders created through the app are the user's own records, not
    // demonstration data — `isSynthetic` was left true from the seed work and
    // would have made real reminders eligible for the staging cleanup.
    const [row] = await db.insert(reminders).values({
      workspaceId, ...fields, isSynthetic: false,
    }).returning();
    if (!row) throw badRequest('Could not create the reminder.');

    if (recurrence) {
      await db.insert(reminderRecurrenceRules).values({
        workspaceId,
        reminderId: row.id,
        frequency: recurrence.frequency,
        interval: recurrence.interval,
        byWeekday: recurrence.byWeekday ?? null,
        byMonthDay: recurrence.byMonthDay ?? null,
        until: recurrence.until ?? null,
        count: recurrence.count ?? null,
      });
    }
    reply.code(201);
    return { reminder: { ...row, recurrence: recurrence ?? null } };
  });

  /**
   * Completing a reminder.
   *
   * A RECURRING reminder is not finished when you tick it — it rolls to its
   * next occurrence. Marking it permanently done would silently end a monthly
   * obligation the user expected to keep seeing, which is the worst kind of
   * data loss: invisible and only noticed when the payment is late.
   *
   * A one-off reminder closes normally.
   */
  app.post('/api/v1/workspaces/:workspaceId/reminders/:id/complete', pre, async (req) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const [existing] = await db.select().from(reminders).where(and(
      eq(reminders.id, id), eq(reminders.workspaceId, workspaceId),
    ));
    if (!existing) throw notFound('Reminder not found.');

    const [rule] = await db.select().from(reminderRecurrenceRules)
      .where(eq(reminderRecurrenceRules.reminderId, id));

    if (rule && existing.dueDate) {
      const next = nextAfter(existing.dueDate, rule);
      // Past the end of the series? Then it really is finished.
      const ended = (rule.until && next > rule.until) || !next;
      const [row] = await db.update(reminders).set(
        ended
          ? { status: 'done', completedAt: new Date(), updatedAt: new Date() }
          : { dueDate: next, status: 'open', completedAt: null, updatedAt: new Date() },
      ).where(eq(reminders.id, id)).returning();
      return { reminder: { ...row, recurrence: rule }, advancedTo: ended ? null : next };
    }

    const [row] = await db.update(reminders)
      .set({ status: 'done', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(reminders.id, id)).returning();
    return { reminder: row, advancedTo: null };
  });

  app.patch('/api/v1/workspaces/:workspaceId/reminders/:id', pre, async (req) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const b = ReminderBody.partial().safeParse(req.body);
    if (!b.success) throw badRequest(b.error.issues[0]!.message);
    const { recurrence, ...fields } = b.data;

    const [row] = await db.update(reminders)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(reminders.id, id), eq(reminders.workspaceId, workspaceId)))
      .returning();
    if (!row) throw notFound('Reminder not found.');

    // `recurrence: undefined` means "not mentioned" and must leave the rule
    // alone; `null` means "stop repeating". Conflating the two would silently
    // drop a recurrence every time an unrelated field was edited.
    if (recurrence !== undefined) {
      await db.delete(reminderRecurrenceRules)
        .where(eq(reminderRecurrenceRules.reminderId, id));
      if (recurrence) {
        await db.insert(reminderRecurrenceRules).values({
          workspaceId, reminderId: id,
          frequency: recurrence.frequency,
          interval: recurrence.interval,
          byWeekday: recurrence.byWeekday ?? null,
          byMonthDay: recurrence.byMonthDay ?? null,
          until: recurrence.until ?? null,
          count: recurrence.count ?? null,
        });
      }
    }
    const [rule] = await db.select().from(reminderRecurrenceRules)
      .where(eq(reminderRecurrenceRules.reminderId, id));
    return { reminder: { ...row, recurrence: rule ?? null } };
  });

  app.delete('/api/v1/workspaces/:workspaceId/reminders/:id', pre, async (req, reply) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    // The rule cascades from the reminder.
    const gone = await db.delete(reminders).where(and(
      eq(reminders.id, id), eq(reminders.workspaceId, workspaceId),
    )).returning({ id: reminders.id });
    if (!gone.length) throw notFound('Reminder not found.');
    reply.code(204);
    return null;
  });

  app.post('/api/v1/workspaces/:workspaceId/reminders/:id/reopen', pre, async (req) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const [row] = await db.update(reminders)
      .set({ status: 'open', completedAt: null, updatedAt: new Date() })
      .where(and(eq(reminders.id, id), eq(reminders.workspaceId, workspaceId)))
      .returning();
    if (!row) throw notFound('Reminder not found.');
    return { reminder: row };
  });

  /**
   * All reminders, for the Reminders overview.
   *
   * Deliberately separate from the range query: the overview is about the
   * RULES ("monthly on the 28th"), not about which dates happen to fall inside
   * a window. Filtering that by date range is what made reminders feel like
   * they only existed on the days they appeared.
   */
  app.get('/api/v1/workspaces/:workspaceId/reminders', pre, async (req) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const rows = await db.select().from(reminders)
      .where(eq(reminders.workspaceId, workspaceId))
      .orderBy(asc(reminders.dueDate));
    const rules = await db.select().from(reminderRecurrenceRules)
      .where(eq(reminderRecurrenceRules.workspaceId, workspaceId));
    const ruleFor = new Map(rules.map((r) => [r.reminderId, r]));
    const today = new Date().toISOString().slice(0, 10);

    return {
      reminders: rows.map((r) => {
        const rule = ruleFor.get(r.id) ?? null;
        // "Next" is the stored date when it is still ahead, otherwise the next
        // one the rule produces — an overdue reminder should still tell you
        // when it comes round again.
        const next = r.status === 'done' || !r.dueDate ? null
          : r.dueDate >= today ? r.dueDate
            : rule ? nextAfter(r.dueDate, rule) : r.dueDate;
        return {
          ...r,
          recurrence: rule,
          recurrenceText: describeRule(rule),
          nextOccurrence: next,
          isOverdue: r.status === 'open' && !!r.dueDate && r.dueDate < today,
        };
      }),
    };
  });

  /** Pause and resume: a rule that keeps its history but stops firing. */
  app.post('/api/v1/workspaces/:workspaceId/reminders/:id/pause', pre, async (req) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const [row] = await db.update(reminders)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(and(eq(reminders.id, id), eq(reminders.workspaceId, workspaceId)))
      .returning();
    if (!row) throw notFound('Reminder not found.');
    return { reminder: row };
  });

  /**
   * Resume.
   *
   * A reminder paused in March and resumed in August must not come back due in
   * March. Rolling the rule forward to the first occurrence that is not in the
   * past is the only unambiguous answer — the alternatives are firing
   * immediately for a date that has passed, or silently inventing the months
   * that were skipped.
   *
   * A one-off whose date has passed resumes as overdue, which IS accurate: it
   * never happened and still has not.
   */
  app.post('/api/v1/workspaces/:workspaceId/reminders/:id/resume', pre, async (req) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const [existing] = await db.select().from(reminders).where(and(
      eq(reminders.id, id), eq(reminders.workspaceId, workspaceId),
    ));
    if (!existing) throw notFound('Reminder not found.');
    const [rule] = await db.select().from(reminderRecurrenceRules)
      .where(eq(reminderRecurrenceRules.reminderId, id));

    const today = new Date().toISOString().slice(0, 10);
    let due = existing.dueDate;
    if (rule && due && due < today) {
      // Bounded: a daily rule paused for years must not spin.
      for (let i = 0; i < 500 && due < today; i++) due = nextAfter(due, rule);
    }

    const [row] = await db.update(reminders)
      .set({ status: 'open', dueDate: due, updatedAt: new Date() })
      .where(eq(reminders.id, id)).returning();
    return { reminder: { ...row, recurrence: rule ?? null }, nextOccurrence: due };
  });

  /**
   * End a series without deleting its history.
   *
   * Distinct from Delete, which removes the reminder entirely, and from
   * Complete, which advances to the next occurrence. Three different intents
   * that a single "done" button would blur together.
   */
  app.post('/api/v1/workspaces/:workspaceId/reminders/:id/end-series', pre, async (req) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const [row] = await db.select().from(reminders).where(and(
      eq(reminders.id, id), eq(reminders.workspaceId, workspaceId),
    ));
    if (!row) throw notFound('Reminder not found.');
    await db.delete(reminderRecurrenceRules)
      .where(eq(reminderRecurrenceRules.reminderId, id));
    const [updated] = await db.update(reminders)
      .set({ status: 'done', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(reminders.id, id)).returning();
    return { reminder: { ...updated, recurrence: null } };
  });

  /* ── Task schedule blocks — Plan mode ──────────────────────────────────
   * Creating a block NEVER touches the task's due date, bucket, area or
   * project. Scheduling when you will do something is not a statement about
   * when it is due. */
  app.post('/api/v1/workspaces/:workspaceId/calendar/blocks', pre, async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const b = BlockBody.safeParse(req.body);
    if (!b.success) throw badRequest(b.error.issues[0]!.message);
    const [task] = await db.select().from(tasks).where(and(
      eq(tasks.id, b.data.taskId), eq(tasks.workspaceId, workspaceId),
    ));
    if (!task) throw notFound('Task not found.');
    const [row] = await db.insert(taskScheduleBlocks).values({
      workspaceId, taskId: b.data.taskId,
      startsAt: new Date(b.data.startsAt),
      endsAt: new Date(b.data.endsAt),
      isSynthetic: true,
    }).returning();
    reply.code(201);
    return { block: row };
  });

  app.patch('/api/v1/workspaces/:workspaceId/calendar/blocks/:id', pre, async (req) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const b = BlockBody.partial().omit({ taskId: true }).safeParse(req.body);
    if (!b.success) throw badRequest(b.error.issues[0]!.message);
    const [row] = await db.update(taskScheduleBlocks).set({
      ...(b.data.startsAt ? { startsAt: new Date(b.data.startsAt) } : {}),
      ...(b.data.endsAt ? { endsAt: new Date(b.data.endsAt) } : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(taskScheduleBlocks.id, id), eq(taskScheduleBlocks.workspaceId, workspaceId),
    )).returning();
    if (!row) throw notFound('Block not found.');
    return { block: row };
  });

  app.delete('/api/v1/workspaces/:workspaceId/calendar/blocks/:id', pre, async (req, reply) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    await db.delete(taskScheduleBlocks).where(and(
      eq(taskScheduleBlocks.id, id), eq(taskScheduleBlocks.workspaceId, workspaceId),
    ));
    reply.code(204);
    return null;
  });

  /* ── Synthetic dataset ─────────────────────────────────────────────────
   * Seeds a realistic month so Month, Agenda and Plan can be designed against
   * data with the shapes that actually cause trouble: overlaps, all-day spans,
   * a read-only source, an overdue reminder, a deadline with no planned work.
   *
   * Idempotent: seeding twice replaces the synthetic set rather than doubling
   * it. Nothing here touches real Tasks or Habits. */
  app.post('/api/v1/workspaces/:workspaceId/calendar/seed-synthetic', pre, async (req) => {
    const { workspaceId } = req.params as { workspaceId: string };
    await clearSynthetic(db, workspaceId);

    const [personal] = await db.insert(calendars).values({
      workspaceId, providerCalendarId: 'synthetic-personal', name: 'Personal',
      color: '#8A5DFF', accessRole: 'owner', isPrimary: true,
      isReadOnly: false, isSynthetic: true, timeZone: 'Africa/Johannesburg',
    }).returning();
    const [work] = await db.insert(calendars).values({
      workspaceId, providerCalendarId: 'synthetic-work', name: 'Work',
      color: '#4E8FC4', accessRole: 'writer', isReadOnly: false,
      isSynthetic: true, timeZone: 'Africa/Johannesburg',
    }).returning();
    const [holidays] = await db.insert(calendars).values({
      workspaceId, providerCalendarId: 'synthetic-holidays', name: 'Public holidays',
      color: '#F0913D', accessRole: 'reader', isReadOnly: true, isSynthetic: true,
    }).returning();

    // `returning()` is typed as an array, so each row is possibly-undefined.
    // These three were just inserted; assert once here rather than sprinkling
    // non-null assertions through the seed data below.
    if (!personal || !work || !holidays) {
      throw badRequest('Could not create the synthetic calendars.');
    }

    type NewEvent = typeof calendarEvents.$inferInsert;
    const ev = (v: Omit<NewEvent, 'workspaceId'>): NewEvent => ({
      workspaceId, isSynthetic: true, syncState: 'local_only', ...v,
    });

    const inserted = await db.insert(calendarEvents).values([
      // A plain timed meeting.
      ev({ calendarId: work.id, title: 'Design review', location: 'Studio',
        startsAt: at(0, 10), endsAt: at(0, 11), providerColorId: '1' }),
      // Two that OVERLAP — the conflict case Month and Plan must show.
      ev({ calendarId: work.id, title: 'Client call — Trifusion',
        startsAt: at(2, 14), endsAt: at(2, 15), location: 'Google Meet',
        hangoutLink: 'https://meet.google.com/synthetic-abc-def' }),
      ev({ calendarId: personal.id, title: 'Dentist', location: '12 Oak Road',
        startsAt: at(2, 14, 30), endsAt: at(2, 15, 30) }),
      // All-day, and a multi-day span.
      ev({ calendarId: holidays.id, title: 'Public holiday', isAllDay: true,
        startDate: isoDay(5), endDate: isoDay(6) }),
      ev({ calendarId: personal.id, title: 'Cape Town trip', isAllDay: true,
        startDate: isoDay(12), endDate: isoDay(16) }),
      // A recurring series and a birthday.
      ev({ calendarId: work.id, title: 'Weekly planning',
        startsAt: at(1, 9), endsAt: at(1, 9, 30),
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        recurringEventId: 'synthetic-weekly-planning' }),
      ev({ calendarId: personal.id, title: "Mom's birthday", isAllDay: true,
        startDate: isoDay(9), endDate: isoDay(9), eventType: 'birthday' }),
      // A busy day, to exercise the overflow count and workload state.
      ev({ calendarId: work.id, title: 'Standup', startsAt: at(3, 8), endsAt: at(3, 8, 15) }),
      ev({ calendarId: work.id, title: 'Sprint planning', startsAt: at(3, 9), endsAt: at(3, 10, 30) }),
      ev({ calendarId: work.id, title: 'Supplier sync', startsAt: at(3, 11), endsAt: at(3, 12) }),
      ev({ calendarId: personal.id, title: 'Gym', startsAt: at(3, 17), endsAt: at(3, 18) }),
      ev({ calendarId: work.id, title: 'Retro', startsAt: at(3, 15), endsAt: at(3, 16) }),
      // A free-looking day deliberately left empty: isoDay(4).
      ev({ calendarId: personal.id, title: 'Coffee with Sam', location: 'Bean There',
        startsAt: at(7, 10), endsAt: at(7, 11) }),
      ev({ calendarId: work.id, title: 'Quarterly review', startsAt: at(8, 13), endsAt: at(8, 15),
        transparency: 'opaque', visibility: 'private' }),
    ]).returning();

    // An event with attendees, including one who has not replied.
    const clientCall = inserted.find((e) => e.title?.startsWith('Client call'));
    if (clientCall) {
      await db.insert(calendarEventAttendees).values([
        { workspaceId, eventId: clientCall.id, email: 'you@example.com',
          displayName: 'You', responseStatus: 'accepted', isSelf: true, isOrganizer: true },
        { workspaceId, eventId: clientCall.id, email: 'sam@example.com',
          displayName: 'Sam Petersen', responseStatus: 'accepted' },
        { workspaceId, eventId: clientCall.id, email: 'ana@example.com',
          displayName: 'Ana Duarte', responseStatus: 'needsAction' },
      ]);
    }

    await db.insert(reminders).values([
      { workspaceId, title: 'Renew vehicle licence', dueDate: isoDay(6), leadDays: 7,
        isSynthetic: true },
      // Overdue — "needs attention" must surface this.
      { workspaceId, title: 'Send insurance documents', dueDate: isoDay(-3),
        isSynthetic: true },
      { workspaceId, title: 'Pay school fees', dueDate: isoDay(11), dueTime: '09:00',
        isSynthetic: true },
    ]);

    // Scheduled work: a block for a real task, so Plan has something true to
    // show. Uses whichever open tasks exist; creates none.
    const openTasks = await db.select().from(tasks).where(and(
      eq(tasks.workspaceId, workspaceId), eq(tasks.status, 'open'),
    )).limit(3);
    if (openTasks[0]) {
      await db.insert(taskScheduleBlocks).values({
        workspaceId, taskId: openTasks[0].id,
        startsAt: at(1, 11), endsAt: at(1, 12, 30), isSynthetic: true,
      });
    }
    if (openTasks[1]) {
      await db.insert(taskScheduleBlocks).values({
        workspaceId, taskId: openTasks[1].id,
        startsAt: at(4, 9), endsAt: at(4, 10), isSynthetic: true,
      });
    }
    // A preparation link: task -> event. Life OS-only, never sent to Google.
    if (openTasks[2] && clientCall) {
      await db.insert(itemLinks).values({
        workspaceId, kind: 'preparation',
        sourceType: 'event', sourceId: clientCall.id,
        targetType: 'task', targetId: openTasks[2].id,
      });
    }

    return {
      seeded: true,
      calendars: 3,
      events: inserted.length,
      reminders: 3,
      blocks: openTasks.slice(0, 2).length,
      note: 'All rows are flagged is_synthetic and can be removed in one call.',
    };
  });

  /* ── Synthetic cleanup: preview, then confirm ────────────────────────
   * Deliberately two calls. Deleting demonstration data next to 500+ real
   * Google events is exactly the operation that should not happen behind one
   * opaque request — you see the counts first, then type the phrase.
   *
   * Counts only. No event titles, ever. */
  app.get('/api/v1/workspaces/:workspaceId/calendar/synthetic/preview', pre, async (req) => {
    const { workspaceId } = req.params as { workspaceId: string };
    if (!isStagingCleanupAllowed(process.env.NODE_ENV ?? 'development')) {
      throw badRequest('Synthetic cleanup is not available in production.');
    }
    return { ...(await syntheticCounts(db, workspaceId)), confirmPhrase: CONFIRM_PHRASE };
  });

  app.post('/api/v1/workspaces/:workspaceId/calendar/synthetic/cleanup', pre, async (req) => {
    const { workspaceId } = req.params as { workspaceId: string };
    if (!isStagingCleanupAllowed(process.env.NODE_ENV ?? 'development')) {
      throw badRequest('Synthetic cleanup is not available in production.');
    }
    const b = z.object({ confirm: z.string() }).safeParse(req.body);
    if (!b.success || b.data.confirm !== CONFIRM_PHRASE) {
      throw badRequest(`To confirm, send exactly: ${CONFIRM_PHRASE}`);
    }

    const before = await syntheticCounts(db, workspaceId);
    // One transaction: a partial cleanup that removed calendars but left
    // reminders would be worse than none.
    await db.transaction(async (tx) => { await clearSynthetic(tx as unknown as Db, workspaceId); });
    const after = await syntheticCounts(db, workspaceId);

    // Audit line carries counts only — never a title, never an id.
    app.log.info({
      workspaceId,
      removed: {
        calendars: before.syntheticCalendars - after.syntheticCalendars,
        events: before.syntheticEvents - after.syntheticEvents,
        reminders: before.syntheticReminders - after.syntheticReminders,
        blocks: before.syntheticBlocks - after.syntheticBlocks,
      },
      retained: {
        googleCalendars: after.googleCalendars,
        googleEvents: after.googleEvents,
        tasks: after.tasks,
        habits: after.habits,
      },
    }, 'synthetic calendar cleanup');

    return { removed: before, remaining: after };
  });
}

/** Removes every synthetic calendar row for a workspace, and nothing else. */
async function clearSynthetic(db: Db, workspaceId: string) {
  const synthCals = await db.select({ id: calendars.id }).from(calendars).where(and(
    eq(calendars.workspaceId, workspaceId), eq(calendars.isSynthetic, true),
  ));
  await db.delete(taskScheduleBlocks).where(and(
    eq(taskScheduleBlocks.workspaceId, workspaceId),
    eq(taskScheduleBlocks.isSynthetic, true),
  ));
  await db.delete(reminders).where(and(
    eq(reminders.workspaceId, workspaceId), eq(reminders.isSynthetic, true),
  ));
  // Events and attendees cascade from the calendar.
  for (const c of synthCals) {
    await db.delete(calendars).where(eq(calendars.id, c.id));
  }
  return { calendars: synthCals.length };
}

/**
 * Counts on both sides of the line: what cleanup would remove, and what it
 * must leave completely alone.
 */
async function syntheticCounts(db: Db, workspaceId: string) {
  const n = async (table: any, where: any) => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(table).where(where);
    return row?.c ?? 0;
  };
  const synthCalIds = (await db.select({ id: calendars.id }).from(calendars).where(and(
    eq(calendars.workspaceId, workspaceId), eq(calendars.isSynthetic, true),
  ))).map((r) => r.id);

  return {
    syntheticCalendars: synthCalIds.length,
    syntheticEvents: await n(calendarEvents, and(
      eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.isSynthetic, true))),
    syntheticReminders: await n(reminders, and(
      eq(reminders.workspaceId, workspaceId), eq(reminders.isSynthetic, true))),
    syntheticBlocks: await n(taskScheduleBlocks, and(
      eq(taskScheduleBlocks.workspaceId, workspaceId),
      eq(taskScheduleBlocks.isSynthetic, true))),
    // Everything below is RETAINED. Listed so the preview shows what survives,
    // not only what disappears.
    googleCalendars: await n(calendars, and(
      eq(calendars.workspaceId, workspaceId), eq(calendars.isSynthetic, false))),
    googleEvents: await n(calendarEvents, and(
      eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.isSynthetic, false))),
    realReminders: await n(reminders, and(
      eq(reminders.workspaceId, workspaceId), eq(reminders.isSynthetic, false))),
    realBlocks: await n(taskScheduleBlocks, and(
      eq(taskScheduleBlocks.workspaceId, workspaceId),
      eq(taskScheduleBlocks.isSynthetic, false))),
    tasks: await n(tasks, eq(tasks.workspaceId, workspaceId)),
    habits: await n(habits, eq(habits.workspaceId, workspaceId)),
    habitEntries: await n(habitEntries, eq(habitEntries.workspaceId, workspaceId)),
  };
}

/**
 * The next date in a recurrence, from a given occurrence.
 *
 * Works in plain calendar dates, never in UTC instants. A monthly reminder on
 * the 25th means the 25th wherever the user is; converting through UTC would
 * shift it a day for anyone east or west of Greenwich at the month boundary.
 */
export function nextOccurrence(fromIso: string, rule: {
  frequency: string; interval: number;
  byWeekday?: number[] | null; byMonthDay?: number[] | null;
}): string {
  const [y, m, d] = fromIso.split('-').map(Number);
  const step = Math.max(1, rule.interval ?? 1);
  const at = new Date(y!, m! - 1, d!);
  const out = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
    + `-${String(dt.getDate()).padStart(2, '0')}`;

  if (rule.frequency === 'DAILY') {
    at.setDate(at.getDate() + step);
    return out(at);
  }

  if (rule.frequency === 'WEEKLY') {
    const days = (rule.byWeekday?.length ? rule.byWeekday : [at.getDay()]).slice().sort();
    // Another weekday later in the same week?
    const later = days.find((n) => n > at.getDay());
    if (later !== undefined) {
      at.setDate(at.getDate() + (later - at.getDay()));
      return out(at);
    }
    // Otherwise the first listed day, `interval` weeks on.
    const first = days[0]!;
    at.setDate(at.getDate() + (7 * step) - (at.getDay() - first));
    return out(at);
  }

  if (rule.frequency === 'MONTHLY') {
    const target = rule.byMonthDay?.length ? rule.byMonthDay[0]! : d!;
    const next = new Date(y!, m! - 1 + step, 1);
    // Clamp: "day 31" in a 30-day month means the 30th, not the 1st of the
    // month after — which is what naive date arithmetic produces.
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(target, lastDay));
    return out(next);
  }

  // YEARLY
  const next = new Date(y! + step, m! - 1, 1);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(d!, lastDay));
  return out(next);
}
