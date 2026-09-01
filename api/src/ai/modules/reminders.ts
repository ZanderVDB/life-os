/**
 * Reminders, as the assistant sees them.
 *
 * The safest thing in the app for an assistant to create: a reminder is ours
 * alone, occupies no time, has no attendees and reaches no external system.
 * "Remind me to call Dad tomorrow" is a reminder, not a calendar event, and
 * routing it to Google would put a zero-length appointment in front of
 * everyone who shares that calendar.
 */
import { and, asc, eq, ilike } from 'drizzle-orm';
import { z } from 'zod';
import { reminders } from '../../db/schema.js';
import {
  createReminder, updateReminder, completeReminder, setReminderPaused, resumeReminder,
  deleteReminder, ReminderCreateInput, ReminderUpdateInput,
} from '../../lib/actions/reminders.js';
import type { AiModule } from '../registry.js';

import type { ContextSource } from '../types.js';

const source = (row: typeof reminders.$inferSelect, level: 1 | 2 | 3 = 2): ContextSource => ({
  ref: { type: 'reminder', id: row.id },
  module: 'reminders',
  title: row.title,
  summary: row.dueTime ? `${row.dueDate} at ${row.dueTime}` : row.dueDate,
  data: {
    dueDate: row.dueDate,
    dueTime: row.dueTime,
    status: row.status,
    leadDays: row.leadDays,
    areaId: row.areaId,
  },
  via: 'direct',
  level,
});

export const remindersModule: AiModule = {
  id: 'reminders',
  name: 'Reminders',
  entities: ['reminder'],
  rules: [
    'A reminder is a Life OS record and NEVER a Google event. It asks for attention on or '
      + 'before a date; it has no duration, no attendees and no calendar.',
    'Prefer a reminder over a calendar event whenever the user asked to be reminded rather '
      + 'than to reserve time.',
    'dueTime is local HH:MM. Null means all day, not midnight.',
    'Completing a RECURRING reminder advances it to the next occurrence; it does not end the '
      + 'series. Pausing stops it asking without ending it. Deleting removes it entirely.',
  ],
  available: () => ({ enabled: true }),
  capabilities: [
    {
      id: 'reminder.search',
      module: 'reminders',
      kind: 'search',
      label: 'Find reminders',
      description: 'Find reminders by words in their title.',
      input: z.object({
        query: z.string().trim().min(2).max(200),
        limit: z.number().int().min(1).max(25).default(10),
      }).strict(),
      risk: 'safe',
      async run(ctx, input: { query: string; limit: number }) {
        const rows = await ctx.db.select().from(reminders).where(and(
          eq(reminders.workspaceId, ctx.request.workspaceId),
          ilike(reminders.title, `%${input.query}%`),
        )).orderBy(asc(reminders.dueDate)).limit(input.limit);
        return rows.map((r) => source(r));
      },
    },
    {
      id: 'reminder.create',
      module: 'reminders',
      kind: 'mutate',
      label: 'Create reminder',
      description: 'Create a Life OS reminder. Nothing is sent to Google.',
      input: ReminderCreateInput,
      risk: 'confirm',
      async execute(ctx, input) {
        const row = await createReminder(ctx.db, ctx.request.workspaceId, input as any);
        return {
          status: 'done' as const,
          ref: { type: 'reminder' as const, id: row.id },
          message: `Reminder set: "${row.title}".`,
        };
      },
    },
    {
      id: 'reminder.update',
      module: 'reminders',
      kind: 'mutate',
      label: 'Change reminder',
      description: 'Change a reminder - its title, date, time, area, lead days or recurrence. '
        + 'Omit recurrence to leave repeating alone; send null to stop it repeating.',
      input: z.object({ id: z.string().uuid(), changes: ReminderUpdateInput }).strict(),
      risk: 'confirm',
      async execute(ctx, input: { id: string; changes: any }) {
        const row = await updateReminder(ctx.db, ctx.request.workspaceId, input.id, input.changes);
        return {
          status: 'done' as const,
          ref: { type: 'reminder' as const, id: row.id },
          message: `Updated "${row.title}".`,
        };
      },
    },
    {
      id: 'reminder.complete',
      module: 'reminders',
      kind: 'mutate',
      label: 'Tick a reminder',
      description: 'Mark a reminder done. A recurring one ADVANCES to its next occurrence '
        + 'rather than ending.',
      input: z.object({ id: z.string().uuid() }).strict(),
      risk: 'confirm',
      async execute(ctx, input: { id: string }) {
        const r = await completeReminder(ctx.db, ctx.request.workspaceId, input.id);
        return {
          status: 'done' as const,
          ref: { type: 'reminder' as const, id: input.id },
          message: r.advancedTo
            ? `Done - next one on ${r.advancedTo}.`
            : `Done: "${r.reminder.title}".`,
        };
      },
    },
    {
      id: 'reminder.setPaused',
      module: 'reminders',
      kind: 'mutate',
      label: 'Pause or resume',
      description: 'Stop a reminder asking without ending it, or start it again. Resuming a '
        + 'stale recurring reminder rolls it forward rather than firing in the past.',
      input: z.object({ id: z.string().uuid(), paused: z.boolean() }).strict(),
      risk: 'confirm',
      async execute(ctx, input: { id: string; paused: boolean }) {
        if (input.paused) {
          const row = await setReminderPaused(ctx.db, ctx.request.workspaceId, input.id, true);
          return {
            status: 'done' as const,
            ref: { type: 'reminder' as const, id: row.id },
            message: `Paused "${row.title}".`,
          };
        }
        const r = await resumeReminder(ctx.db, ctx.request.workspaceId, input.id);
        return {
          status: 'done' as const,
          ref: { type: 'reminder' as const, id: input.id },
          message: `Resumed "${r.reminder.title}"${r.nextOccurrence ? ` - next on ${r.nextOccurrence}` : ''}.`,
        };
      },
    },
    {
      id: 'reminder.delete',
      module: 'reminders',
      kind: 'mutate',
      label: 'Delete reminder',
      description: 'Remove a reminder entirely. Prefer pausing when the user means "stop '
        + 'asking me" - this cannot be undone.',
      input: z.object({ id: z.string().uuid() }).strict(),
      risk: 'important',
      async execute(ctx, input: { id: string }) {
        await deleteReminder(ctx.db, ctx.request.workspaceId, input.id);
        return { status: 'done' as const, ref: null, message: 'Reminder deleted.' };
      },
    },
  ],
};
