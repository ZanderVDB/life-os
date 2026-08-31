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
import { createReminder, ReminderCreateInput } from '../../lib/actions/reminders.js';
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
  ],
};
