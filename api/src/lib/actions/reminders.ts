/**
 * Reminder application services.
 *
 * A reminder is a Life OS record and never a Google event. It asks for
 * attention on or before a date; it does not occupy time, has no attendees and
 * has no duration. That is why `reminders` is its own table rather than a
 * zero-length event, and it is the reason the assistant may create one freely
 * while creating a calendar event is an external, confirmed act.
 */
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { reminders, reminderRecurrenceRules } from '../../db/schema.js';
import { badRequest } from '../errors.js';

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
