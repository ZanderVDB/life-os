/**
 * Reminder application services.
 *
 * A reminder is a Life OS record and never a Google event. It asks for
 * attention on or before a date; it does not occupy time, has no attendees and
 * has no duration. That is why `reminders` is its own table rather than a
 * zero-length event, and it is the reason the assistant may create one freely
 * while creating a calendar event is an external, confirmed act.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { reminders, reminderRecurrenceRules } from '../../db/schema.js';
import { nextAfter } from '../recurrence.js';
import { cleanupLinksFor } from '../relationships.js';
import { badRequest, notFound } from '../errors.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const RecurrenceInput = z.object({
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  interval: z.number().int().min(1).max(365).default(1),
  byWeekday: z.array(z.number().int().min(0).max(6)).max(7).nullish(),
  byMonthDay: z.array(z.number().int().min(1).max(31)).max(31).nullish(),
  until: z.string().regex(ISO_DATE).nullish(),
  count: z.number().int().min(1).max(500).nullish(),
});

export const ReminderCreateInput = z.object({
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(4000).nullish(),
  dueDate: z.string().regex(ISO_DATE).nullish(),
  /** Local `HH:MM`. Null means all day — not midnight. */
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
  areaId: z.string().uuid().nullish(),
  leadDays: z.number().int().min(0).max(90).default(0),
  recurrence: RecurrenceInput.nullish(),
});

export type ReminderCreate = z.infer<typeof ReminderCreateInput>;

export async function createReminder(db: Db, wsId: string, input: ReminderCreate) {
  const { recurrence, ...fields } = input;
  /* `isSynthetic: false` matters. It was left true from the seed work once,
     which made real reminders eligible for the staging cleanup. */
  const [row] = await db.insert(reminders).values({
    workspaceId: wsId, ...fields, isSynthetic: false,
  }).returning();
  if (!row) throw badRequest('Could not create the reminder.');

  if (recurrence) {
    await db.insert(reminderRecurrenceRules).values({
      workspaceId: wsId,
      reminderId: row.id,
      frequency: recurrence.frequency,
      interval: recurrence.interval,
      byWeekday: recurrence.byWeekday ?? null,
      byMonthDay: recurrence.byMonthDay ?? null,
      until: recurrence.until ?? null,
      count: recurrence.count ?? null,
    });
  }
  return { ...row, recurrence: recurrence ?? null };
}

/* ══ Editing and lifecycle ═══════════════════════════════════════════════ */

export const ReminderUpdateInput = ReminderCreateInput.partial().strict();

export async function updateReminder(
  db: Db, wsId: string, id: string, input: z.infer<typeof ReminderUpdateInput>,
) {
  const { recurrence, ...fields } = input;
  const [row] = await db.update(reminders)
    .set({ ...fields, updatedAt: new Date() })
    .where(and(eq(reminders.id, id), eq(reminders.workspaceId, wsId)))
    .returning();
  if (!row) throw notFound('Reminder not found.');

  /* `undefined` means "not mentioned" and leaves the rule alone; `null` means
     "stop repeating". Conflating the two would silently drop a recurrence
     every time an unrelated field was edited. */
  if (recurrence !== undefined) {
    await db.delete(reminderRecurrenceRules)
      .where(eq(reminderRecurrenceRules.reminderId, id));
    if (recurrence) {
      await db.insert(reminderRecurrenceRules).values({
        workspaceId: wsId,
        reminderId: id,
        frequency: recurrence.frequency,
        interval: recurrence.interval,
        byWeekday: recurrence.byWeekday ?? null,
        byMonthDay: recurrence.byMonthDay ?? null,
        until: recurrence.until ?? null,
        count: recurrence.count ?? null,
      });
    }
  }
  /* The STORED rule is returned, not the input. They differ — a stored rule
     carries its own id and defaults — and the client renders what is in the
     database rather than what it just sent. */
  const [rule] = await db.select().from(reminderRecurrenceRules)
    .where(eq(reminderRecurrenceRules.reminderId, id));
  return { ...row, recurrence: rule ?? null };
}

/**
 * Ticking a reminder.
 *
 * A RECURRING reminder is not finished when it is ticked — it ADVANCES to its
 * next occurrence. Marking it permanently done would silently end a monthly
 * obligation the user expected to keep seeing, which is the worst kind of data
 * loss: invisible, and noticed only when the payment is late.
 */
export async function completeReminder(db: Db, wsId: string, id: string) {
  const [existing] = await db.select().from(reminders).where(and(
    eq(reminders.id, id), eq(reminders.workspaceId, wsId),
  ));
  if (!existing) throw notFound('Reminder not found.');

  const [rule] = await db.select().from(reminderRecurrenceRules)
    .where(eq(reminderRecurrenceRules.reminderId, id));

  if (rule && existing.dueDate) {
    const next = nextAfter(existing.dueDate, rule as any);
    // Past the end of the series? Then it really is finished.
    const ended = (rule.until && next && next > rule.until) || !next;
    const [row] = await db.update(reminders).set(
      ended
        ? { status: 'done', completedAt: new Date(), updatedAt: new Date() }
        /* Reopened as well as moved. A paused-then-advanced reminder that
           stayed paused would silently stop asking for the next occurrence. */
        : { dueDate: next as string, status: 'open', completedAt: null, updatedAt: new Date() },
    ).where(eq(reminders.id, id)).returning();
    return { reminder: { ...row!, recurrence: rule }, advancedTo: ended ? null : next };
  }

  const [row] = await db.update(reminders)
    .set({ status: 'done', completedAt: new Date(), updatedAt: new Date() })
    .where(eq(reminders.id, id)).returning();
  return { reminder: row!, advancedTo: null };
}

/** Stop a series asking, without ending it. Resume brings it back. */
export async function setReminderPaused(db: Db, wsId: string, id: string, paused: boolean) {
  const [row] = await db.update(reminders)
    .set({ status: paused ? 'paused' : 'open', updatedAt: new Date() })
    .where(and(eq(reminders.id, id), eq(reminders.workspaceId, wsId)))
    .returning();
  if (!row) throw notFound('Reminder not found.');
  return row;
}

/**
 * Bring a paused reminder back, rolling a recurring one forward past today.
 *
 * A weekly reminder paused for a month would otherwise resume in the past and
 * present as overdue the instant it came back - technically correct and
 * useless. The roll is bounded, because a daily rule paused for years must not
 * spin.
 */
export async function resumeReminder(db: Db, wsId: string, id: string) {
  const [existing] = await db.select().from(reminders).where(and(
    eq(reminders.id, id), eq(reminders.workspaceId, wsId),
  ));
  if (!existing) throw notFound('Reminder not found.');
  const [rule] = await db.select().from(reminderRecurrenceRules)
    .where(eq(reminderRecurrenceRules.reminderId, id));

  const today = new Date().toISOString().slice(0, 10);
  let due = existing.dueDate;
  if (rule && due && due < today) {
    for (let i = 0; i < 500 && due < today; i += 1) due = nextAfter(due, rule as any);
  }

  const [row] = await db.update(reminders)
    .set({ status: 'open', dueDate: due, updatedAt: new Date() })
    .where(eq(reminders.id, id)).returning();
  return { reminder: { ...row!, recurrence: rule ?? null }, nextOccurrence: due };
}

export async function deleteReminder(db: Db, wsId: string, id: string) {
  const gone = await db.delete(reminders).where(and(
    eq(reminders.id, id), eq(reminders.workspaceId, wsId),
  )).returning({ id: reminders.id });
  if (!gone.length) throw notFound('Reminder not found.');
  /* The recurrence rule cascades; the semantic edges do not — nothing in the
     database points from a polymorphic edge back to a reminder. */
  await cleanupLinksFor(db, wsId, 'reminder', id);
  return { deleted: true };
}
