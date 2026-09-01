/**
 * Calendar, as the assistant sees them.
 *
 * ── The one module that can reach outside Life OS ────────────────────────
 *
 * Almost every event belongs to Google. Creating, moving or deleting one is a
 * write to somebody else's system, visible to other attendees, subject to
 * their rate limits and — once sent — not ours to take back.
 *
 * So this module does NOT get a shortcut. `preview` calls the same
 * `proposeCreateEvent` / `proposeUpdateEvent` / `proposeDeleteEvent` the UI
 * calls, which writes a row into the `calendar_mutations` ledger keyed by a
 * requestId; `execute` calls `executeMutation` with that requestId and nothing
 * else. There is no path from an assistant action to Google that does not go
 * through a proposal the ledger recorded first, and `executeMutation` checks
 * the event's etag before it writes.
 *
 * The consequence worth stating plainly: the assistant cannot invent an event.
 * It can only confirm one that was proposed, and a proposal it did not make
 * cannot be confirmed by id it does not have.
 *
 * ── Availability ─────────────────────────────────────────────────────────
 *
 * Registered on every deployment, available only where a Google account is
 * connected and the grant covers writing. A workspace with no calendar sees no
 * calendar capabilities at all — which is the registry doing its job, not a
 * special case.
 */
import { and, desc, eq, gte, ilike, lte } from 'drizzle-orm';
import { z } from 'zod';
import { calendarEvents, calendars, tasks } from '../../db/schema.js';
import {
  writeState, checkAvailability, linkTaskToEvent,
  proposeCreateEvent, proposeUpdateEvent, proposeDeleteEvent, executeMutation,
} from '../../lib/calendar-mutations.js';
import type { AiModule, Capability } from '../registry.js';
import type { ContextSource } from '../types.js';

const uuid = z.string().uuid();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const source = (row: typeof calendarEvents.$inferSelect, level: 1 | 2 | 3 = 2): ContextSource => ({
  ref: { type: 'event', id: row.id },
  module: 'calendar',
  title: row.title ?? 'Untitled event',
  summary: row.isAllDay ? `All day ${row.startDate}` : row.startsAt?.toISOString() ?? null,
  data: {
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    isAllDay: row.isAllDay,
    startDate: row.startDate,
    location: row.location,
    /* Occurrence identity, carried so a plan about "the 9am Tuesday one" names
       that row and not its series. Google is polled with singleEvents:true, so
       each occurrence already has its own stable row. */
    recurringEventId: row.recurringEventId,
    originalStartTime: row.originalStartTime,
    isRecurringOccurrence: Boolean(row.recurringEventId),
    syncState: row.syncState,
  },
  via: 'direct',
  level,
});

/** A draft, kept deliberately narrower than the UI's: no attendee email edits. */
const Draft = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(8000).nullish(),
  location: z.string().max(500).nullish(),
  isAllDay: z.boolean().default(false),
  startDate: z.string().regex(ISO_DATE).nullish(),
  endDate: z.string().regex(ISO_DATE).nullish(),
  startsAt: z.string().datetime({ offset: true }).nullish(),
  endsAt: z.string().datetime({ offset: true }).nullish(),
  timeZone: z.string().max(80).nullish(),
}).strict();

/**
 * The handle a confirmed calendar action carries.
 *
 * `requestId` is produced by `preview` and recorded in the ledger. Execution
 * takes nothing else about the GOOGLE write — no draft, no calendar, no event
 * id — so a confirmed action can only do what was actually proposed.
 *
 * `taskId` is not part of that write. It is the Life OS statement that this
 * event and that task are the same commitment, checked at preview time and
 * recorded locally after the event exists.
 */
const ConfirmedMutation = z.object({
  requestId: z.string().min(8).max(80),
  taskId: uuid.optional(),
}).strict();

const createCap: Capability = {
  id: 'event.create',
  module: 'calendar',
  kind: 'mutate',
  label: 'Create event',
  description: 'Reserve time in the calendar. This writes to Google and other attendees can '
    + 'see it. Use a reminder instead when the user wants to be reminded rather than to hold time.',
  input: z.object({
    calendarId: uuid,
    draft: Draft,
    requestId: z.string().min(8).max(80),
    /**
     * The task this event is holding time for, when there is one.
     *
     * "Put an hour in on Thursday for the client handover" is one intention
     * and two objects, and the link between them is what makes the event
     * visible from the task and the task visible from the event. Life OS has
     * always made this link when the UI schedules a task; the assistant could
     * create the event and not the link, which left a scheduled task that did
     * not know it had been scheduled.
     */
    taskId: uuid.optional(),
  }).strict(),
  confirmed: ConfirmedMutation,
  risk: 'external',
  async preview(ctx, input: { calendarId: string; draft: any; requestId: string; taskId?: string }) {
    /* Checked HERE, before the user is asked. A task id that names nothing
       must not survive to become a failure after the event has been written
       to Google, which is the one part of this that cannot be taken back. */
    if (input.taskId) {
      const [task] = await ctx.db.select().from(tasks).where(and(
        eq(tasks.workspaceId, ctx.request.workspaceId), eq(tasks.id, input.taskId),
      )).limit(1);
      if (!task) throw new Error('That task is no longer here.');
    }
    const p = await proposeCreateEvent(ctx.db, ctx.request.workspaceId, {
      requestId: input.requestId,
      calendarId: input.calendarId,
      draft: input.draft,
      origin: 'assistant',
      userId: ctx.request.userId,
    });
    return {
      summary: `${p.summary.title} — ${p.summary.when}`,
      warnings: [
        ...(p.summary.warnings ?? []),
        ...(p.conflicts?.length ? [`Clashes with ${p.conflicts.length} existing event(s).`] : []),
      ],
      handle: p.requestId,
      ...(input.taskId ? { carry: { taskId: input.taskId } } : {}),
    };
  },
  async execute(ctx, input: { requestId: string; taskId?: string }) {
    const r = await executeMutation(ctx.db, ctx.request.workspaceId, input.requestId, {
      userId: ctx.request.userId,
    });
    /* After the event exists, and never before. The link is a local write
       through the same service the UI uses, so it appears on both objects at
       once; failing to make it does not undo an event Google already has. */
    let linked = false;
    if (input.taskId && r.event?.id) {
      linked = Boolean(await linkTaskToEvent(
        ctx.db, ctx.request.workspaceId, input.taskId, r.event.id, ctx.request.userId,
      ).catch(() => null));
    }
    return {
      status: 'done' as const,
      ref: r.event ? { type: 'event' as const, id: r.event.id } : null,
      message: r.alreadyDone
        ? 'That event was already created.'
        : linked ? 'Added to the calendar and linked to the task.' : 'Added to the calendar.',
    };
  },
};

const updateCap: Capability = {
  id: 'event.update',
  module: 'calendar',
  kind: 'mutate',
  label: 'Change event',
  description: 'Move or edit an existing event. Identify it by its Life OS event id, which '
    + 'names ONE occurrence of a repeating series - never a title and a date. Writes to Google.',
  input: z.object({
    eventId: uuid,
    draft: Draft.partial(),
    /* Which of a repeating series is being changed. Defaults to this
       occurrence alone, because that is what "move Tuesday's" means. */
    scope: z.enum(['single', 'instance', 'series']).optional(),
    requestId: z.string().min(8).max(80),
  }).strict(),
  confirmed: ConfirmedMutation,
  risk: 'external',
  async preview(ctx, input: { eventId: string; draft: any; scope?: any; requestId: string }) {
    const p = await proposeUpdateEvent(ctx.db, ctx.request.workspaceId, {
      requestId: input.requestId,
      eventId: input.eventId,
      draft: input.draft,
      ...(input.scope ? { scope: input.scope } : {}),
      origin: 'assistant',
      userId: ctx.request.userId,
    });
    return {
      summary: `${p.summary.title} — ${p.summary.when}`,
      warnings: p.summary.warnings ?? [],
      handle: p.requestId,
    };
  },
  async execute(ctx, input: { requestId: string }) {
    const r = await executeMutation(ctx.db, ctx.request.workspaceId, input.requestId, {
      userId: ctx.request.userId,
    });
    return {
      status: 'done' as const,
      ref: r.event ? { type: 'event' as const, id: r.event.id } : null,
      message: r.alreadyDone ? 'That change was already made.' : 'Calendar updated.',
    };
  },
};

const deleteCap: Capability = {
  id: 'event.delete',
  module: 'calendar',
  kind: 'mutate',
  label: 'Delete event',
  description: 'Remove an event. For a repeating series this removes one occurrence unless '
    + 'told otherwise. Other attendees will see it disappear.',
  input: z.object({
    eventId: uuid,
    scope: z.enum(['single', 'instance', 'series']).optional(),
    requestId: z.string().min(8).max(80),
  }).strict(),
  confirmed: ConfirmedMutation,
  risk: 'external',
  async preview(ctx, input: { eventId: string; scope?: any; requestId: string }) {
    const p = await proposeDeleteEvent(ctx.db, ctx.request.workspaceId, {
      requestId: input.requestId,
      eventId: input.eventId,
      ...(input.scope ? { scope: input.scope } : {}),
      origin: 'assistant',
      userId: ctx.request.userId,
    });
    return {
      summary: `Delete ${p.summary.title} — ${p.summary.when}`,
      warnings: p.summary.warnings ?? [],
      handle: p.requestId,
    };
  },
  async execute(ctx, input: { requestId: string }) {
    await executeMutation(ctx.db, ctx.request.workspaceId, input.requestId, {
      userId: ctx.request.userId,
    });
    return { status: 'done' as const, ref: null, message: 'Removed from the calendar.' };
  },
};

export const calendarModule: AiModule = {
  id: 'calendar',
  routing: [
    'A commitment occupying real TIME, especially involving other people or a place.',
    'Holding time to work on something - a block on the calendar - as opposed to merely noting when.',
  ],
  name: 'Calendar',
  entities: ['event'],
  rules: [
    'Google owns almost every event. Creating, moving or deleting one is an external write '
      + 'that other attendees can see and that Life OS cannot silently undo.',
    'Every write goes through propose then confirm. A proposal is recorded in the mutation '
      + 'ledger and execution takes only its requestId, so nothing can be written that was '
      + 'not proposed first.',
    'A recurring series is stored already expanded: each occurrence is its own row with its '
      + 'own id. Identify an occurrence by that id, never by title and date. Changing one '
      + 'occurrence is not changing the series.',
    'A task due date is not a calendar event. Scheduling a task can create one, but that is '
      + 'a separate explicit action.',
    'To hold time FOR a task, use event.create with that task\u2019s taskId. The event and the '
      + 'task are then linked, and each is visible from the other. Creating the event without '
      + 'the taskId leaves a task that does not know it was scheduled.',
    'Never write a Life OS relationship into a Google event field.',
  ],
  async available(ctx) {
    const s = await writeState(ctx.db, ctx.request.workspaceId).catch(() => null);
    if (!s || !s.connected) {
      return { enabled: false, reason: 'No Google Calendar account is connected.' };
    }
    if (!s.canWrite) {
      /* Readable, not writable — the middle state, and the one that used to be
         collapsed into "off". Collapsing it meant a workspace whose grant
         could not write was also told it could not SEE its calendar, and the
         assistant said "I cannot find that meeting" about a meeting it had
         already retrieved. Now the reads stay and only the writes go. */
      return {
        enabled: true,
        canMutate: false,
        mutateReason: s.reason
          ?? 'Calendar changes are not available — this Google connection can only read.',
      };
    }
    return { enabled: true };
  },
  capabilities: [
    {
      id: 'event.search',
      module: 'calendar',
      kind: 'search',
      label: 'Find events',
      description: 'Find calendar events by words in their title, optionally within a date range. '
        + 'Each result is one occurrence, with its own id.',
      input: z.object({
        query: z.string().trim().min(2).max(200).optional(),
        from: z.string().regex(ISO_DATE).optional(),
        to: z.string().regex(ISO_DATE).optional(),
        limit: z.number().int().min(1).max(25).default(10),
      }).strict(),
      risk: 'safe',
      async run(ctx, input: { query?: string; from?: string; to?: string; limit: number }) {
        const ws = ctx.request.workspaceId;
        const rows = await ctx.db.select().from(calendarEvents).where(and(
          eq(calendarEvents.workspaceId, ws),
          ...(input.query ? [ilike(calendarEvents.title, `%${input.query}%`)] : []),
          ...(input.from ? [gte(calendarEvents.startsAt, new Date(`${input.from}T00:00:00Z`))] : []),
          ...(input.to ? [lte(calendarEvents.startsAt, new Date(`${input.to}T23:59:59Z`))] : []),
        )).orderBy(desc(calendarEvents.startsAt)).limit(input.limit);
        return rows.map((r) => source(r));
      },
    },
    {
      id: 'event.read',
      module: 'calendar',
      kind: 'read',
      label: 'Read an event',
      description: 'Load one event by id, including whether it is an occurrence of a series.',
      input: z.object({ id: uuid }).strict(),
      risk: 'safe',
      async run(ctx, input: { id: string }) {
        const [row] = await ctx.db.select().from(calendarEvents).where(and(
          eq(calendarEvents.workspaceId, ctx.request.workspaceId), eq(calendarEvents.id, input.id),
        )).limit(1);
        return row ? [source(row, 1)] : [];
      },
    },
    {
      id: 'calendar.availability',
      module: 'calendar',
      kind: 'read',
      label: 'Check availability',
      description: 'What already occupies a window of time. Ask before proposing a new event.',
      input: z.object({
        startsAt: z.string().datetime({ offset: true }),
        endsAt: z.string().datetime({ offset: true }),
      }).strict(),
      risk: 'safe',
      async run(ctx, input: { startsAt: string; endsAt: string }) {
        const r = await checkAvailability(ctx.db, ctx.request.workspaceId, input);
        return (r.conflicts ?? []).map((c: any) => ({
          ref: { type: 'event' as const, id: c.id ?? '00000000-0000-0000-0000-000000000000' },
          module: 'calendar',
          title: c.title ?? 'Busy',
          summary: `${c.start} – ${c.end}`,
          data: { start: c.start, end: c.end },
          via: 'direct' as const,
          level: 2 as const,
        }));
      },
    },
    {
      id: 'calendar.list',
      module: 'calendar',
      kind: 'read',
      label: 'List calendars',
      description: 'Which calendars exist and which of them can be written to.',
      input: z.object({}).strict(),
      risk: 'safe',
      async run(ctx) {
        const rows = await ctx.db.select().from(calendars)
          .where(and(eq(calendars.workspaceId, ctx.request.workspaceId), eq(calendars.isSynthetic, false)));
        return rows.map((c) => ({
          ref: { type: 'event' as const, id: c.id },
          module: 'calendar',
          title: c.name,
          summary: c.isReadOnly ? 'read-only' : 'writable',
          data: { calendarId: c.id, isReadOnly: c.isReadOnly, isDefaultTarget: c.isDefaultTarget },
          via: 'direct' as const,
          level: 2 as const,
        }));
      },
    },
    createCap,
    updateCap,
    deleteCap,
  ],
};

export { ConfirmedMutation };
