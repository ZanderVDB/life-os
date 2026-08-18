/**
 * The write surface: propose, confirm, and the webhook Google talks to.
 *
 * Thin on purpose. Every rule about what may be written, by whom, and after
 * what confirmation lives in calendar-mutations.ts — these handlers parse,
 * authorise and hand over. A rule enforced in a route handler is a rule that
 * only applies to callers who happen to use that route, and the assistant will
 * not be one of them.
 */
import type { AppInstance, Guards } from '../types.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  calendarConnections, calendars, calendarEvents, calendarMutations, itemLinks, tasks,
} from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { redactTokens } from '../lib/token-crypto.js';
import {
  writeState, proposeCreateEvent, proposeUpdateEvent, proposeDeleteEvent,
  executeMutation, checkAvailability, linkTaskToEvent, unlinkTaskFromEvent,
  TASK_EVENT_KIND,
} from '../lib/calendar-mutations.js';
import {
  resolveChannel, noteNotification, ensureWatches, stopAllWatches, webhookConfigured,
} from '../lib/calendar-watch.js';
import { syncConnection, recordSyncOutcome } from '../lib/calendar-sync.js';

const uuid = z.string().uuid();

const Draft = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(8000).nullish(),
  location: z.string().max(500).nullish(),
  isAllDay: z.boolean().default(false),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  startsAt: z.string().datetime({ offset: true }).nullish(),
  endsAt: z.string().datetime({ offset: true }).nullish(),
  timeZone: z.string().max(80).nullish(),
  attendees: z.array(z.string().email()).max(50).default([]),
  recurrence: z.array(z.string().max(300)).max(5).nullish(),
  reminders: z.array(z.object({
    minutes: z.number().int().min(0).max(40320),
    method: z.enum(['popup', 'email']).default('popup'),
  })).max(5).nullish(),
  useDefaultReminders: z.boolean().optional(),
  withMeet: z.boolean().optional(),
  transparency: z.enum(['opaque', 'transparent']).optional(),
  notifyGuests: z.boolean().default(false),
  losTaskId: uuid.optional(),
  losProjectId: uuid.optional(),
}).strict();

export function registerCalendarWriteRoutes(app: AppInstance, db: Db, guards: Guards) {
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const log = app.log;
  const wsId = (req: any) => req.params.workspaceId as string;
  const userId = (req: any) => req.user?.id ?? null;
  const base = '/api/v1/workspaces/:workspaceId';

  /* ── Can we write at all? ──────────────────────────────────────────── */

  app.get(`${base}/calendar/write-state`, pre, async (req) => {
    const state = await writeState(db, wsId(req));
    const cals = await db.select({
      id: calendars.id, name: calendars.name, color: calendars.color,
      timeZone: calendars.timeZone, isReadOnly: calendars.isReadOnly,
      isPrimary: calendars.isPrimary, isVisible: calendars.isVisible,
      countsAsBusy: calendars.countsAsBusy, isDefaultTarget: calendars.isDefaultTarget,
      accessRole: calendars.accessRole,
    }).from(calendars).where(and(
      eq(calendars.workspaceId, wsId(req)),
      eq(calendars.isSynthetic, false),
    ));
    return {
      ...state,
      webhooks: webhookConfigured(),
      // Only calendars that can actually take an event are offered as targets.
      calendars: cals,
      writable: cals.filter((c) => !c.isReadOnly),
      defaultCalendarId: cals.find((c) => c.isDefaultTarget)?.id
        ?? cals.find((c) => c.isPrimary && !c.isReadOnly)?.id
        ?? cals.find((c) => !c.isReadOnly)?.id ?? null,
    };
  });

  /* ── Propose ───────────────────────────────────────────────────────── */

  app.post(`${base}/calendar/events/propose-create`, pre, async (req) => {
    const b = z.object({
      requestId: z.string().min(8).max(80),
      calendarId: uuid,
      draft: Draft,
    }).strict().parse(req.body ?? {});
    return {
      proposal: await proposeCreateEvent(db, wsId(req), {
        requestId: b.requestId,
        calendarId: b.calendarId,
        draft: b.draft as any,
        userId: userId(req),
      }),
    };
  });

  app.post(`${base}/calendar/events/:id/propose-update`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      requestId: z.string().min(8).max(80),
      draft: Draft.partial().extend({ title: z.string().trim().min(1).max(500).optional() }),
      scope: z.enum(['single', 'instance', 'series']).optional(),
    }).strict().parse(req.body ?? {});
    return {
      proposal: await proposeUpdateEvent(db, wsId(req), {
        requestId: b.requestId, eventId: id, draft: b.draft as any,
        scope: b.scope, userId: userId(req),
      }),
    };
  });

  app.post(`${base}/calendar/events/:id/propose-delete`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      requestId: z.string().min(8).max(80),
      scope: z.enum(['single', 'instance', 'series']).optional(),
    }).strict().parse(req.body ?? {});
    return {
      proposal: await proposeDeleteEvent(db, wsId(req), {
        requestId: b.requestId, eventId: id, scope: b.scope, userId: userId(req),
      }),
    };
  });

  /* ── Confirm ───────────────────────────────────────────────────────── */

  /**
   * The ONLY path to a Google write.
   *
   * It takes a requestId and nothing else: everything about what happens was
   * decided and recorded at propose time, so a caller cannot smuggle a
   * different change past the screen the user actually read.
   */
  app.post(`${base}/calendar/mutations/:requestId/confirm`, pre, async (req) => {
    const { requestId } = z.object({ requestId: z.string().min(8).max(80) }).parse(req.params);
    const b = z.object({ taskId: uuid.optional() }).strict().parse(req.body ?? {});
    const result = await executeMutation(db, wsId(req), requestId, { log });

    // A create that came from a Task carries the link through on success.
    if (b.taskId && result.event?.id) {
      await linkTaskToEvent(db, wsId(req), b.taskId, result.event.id, userId(req)).catch(() => null);
    }
    return {
      done: true,
      alreadyDone: result.alreadyDone,
      event: result.event,
      kind: result.mutation.kind,
    };
  });

  app.post(`${base}/calendar/mutations/:requestId/cancel`, pre, async (req) => {
    const { requestId } = z.object({ requestId: z.string().min(8).max(80) }).parse(req.params);
    await db.update(calendarMutations)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(
        eq(calendarMutations.workspaceId, wsId(req)),
        eq(calendarMutations.requestId, requestId),
        eq(calendarMutations.status, 'proposed'),
      ));
    return { cancelled: true };
  });

  /* ── Availability ──────────────────────────────────────────────────── */

  app.post(`${base}/calendar/availability`, pre, async (req) => {
    const b = z.object({
      startsAt: z.string().datetime({ offset: true }),
      endsAt: z.string().datetime({ offset: true }),
      ignoreProviderEventId: z.string().max(1024).optional(),
    }).strict().parse(req.body ?? {});
    return checkAvailability(db, wsId(req), b);
  });

  /* ── Calendar settings ─────────────────────────────────────────────── */

  app.patch(`${base}/calendars/:id/settings`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      countsAsBusy: z.boolean().optional(),
      isDefaultTarget: z.boolean().optional(),
    }).strict().parse(req.body ?? {});

    if (b.isDefaultTarget) {
      const [target] = await db.select().from(calendars)
        .where(and(eq(calendars.workspaceId, wsId(req)), eq(calendars.id, id)));
      if (!target) throw notFound('That calendar is not connected.');
      if (target.isReadOnly) {
        throw badRequest('A read-only calendar cannot be the default for new events.');
      }
      // Exactly one default, always.
      await db.update(calendars).set({ isDefaultTarget: false })
        .where(eq(calendars.workspaceId, wsId(req)));
    }
    const [row] = await db.update(calendars).set({ ...b, updatedAt: new Date() })
      .where(and(eq(calendars.workspaceId, wsId(req)), eq(calendars.id, id))).returning();
    if (!row) throw notFound('That calendar is not connected.');
    return { calendar: row };
  });

  /* ── Task ↔ Event ──────────────────────────────────────────────────── */

  app.get(`${base}/tasks/:id/calendar`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const links = await db.select({ link: itemLinks, event: calendarEvents, calendar: calendars })
      .from(itemLinks)
      .innerJoin(calendarEvents, eq(itemLinks.targetId, calendarEvents.id))
      .innerJoin(calendars, eq(calendarEvents.calendarId, calendars.id))
      .where(and(
        eq(itemLinks.workspaceId, wsId(req)),
        eq(itemLinks.kind, TASK_EVENT_KIND),
        eq(itemLinks.sourceType, 'task'),
        eq(itemLinks.sourceId, id),
      ));
    return {
      events: links.map(({ link, event, calendar }) => ({
        linkId: link.id,
        id: event.id,
        title: event.title,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        isAllDay: event.isAllDay,
        startDate: event.startDate,
        calendarName: calendar.name,
        calendarColor: calendar.color,
        providerHtmlLink: event.providerHtmlLink,
      })),
    };
  });

  app.delete(`${base}/tasks/:id/calendar/:eventId`, pre, async (req) => {
    const p = z.object({ id: uuid, eventId: uuid }).parse(req.params);
    /* Unlinking is not deleting. The event stays in Google, the task stays in
     * Life OS, and only the statement that they are the same commitment goes. */
    return unlinkTaskFromEvent(db, wsId(req), p.id, p.eventId);
  });

  /* ── Watches ───────────────────────────────────────────────────────── */

  app.post(`${base}/integrations/google-calendar/watch`, pre, async (req) => {
    const r = await ensureWatches(db, wsId(req), log);
    return { ...r, configured: webhookConfigured() };
  });

  app.post(`${base}/integrations/google-calendar/unwatch`, pre, async (req) => {
    const stopped = await stopAllWatches(db, wsId(req));
    return { stopped };
  });
}

/**
 * Google's webhook. Unauthenticated by necessity, so it authenticates itself.
 *
 * Registered separately from the workspace routes because Google is not a
 * signed-in user and has no workspace in its URL — the workspace is DERIVED
 * from a channel row we created, never taken from the request.
 */
export function registerCalendarWebhook(app: AppInstance, db: Db) {
  const log = app.log;

  app.post('/api/v1/integrations/google-calendar/notifications', async (req, reply) => {
    const h = req.headers as Record<string, string | undefined>;
    const state = h['x-goog-resource-state'];

    /* Google opens every channel with a `sync` handshake. Answering it is how
     * the channel becomes live; treating it as a change would trigger a
     * pointless sync on every renewal. */
    if (state === 'sync') return reply.code(200).send();

    const channel = await resolveChannel(db, {
      channelId: h['x-goog-channel-id'],
      resourceId: h['x-goog-resource-id'],
      token: h['x-goog-channel-token'],
    });
    if (!channel) {
      // Say nothing useful. An unmatched POST gets the same answer as a matched
      // one, so this cannot be used to discover which channels exist.
      log.warn({ channel: h['x-goog-channel-id'] }, 'unmatched calendar notification');
      return reply.code(200).send();
    }

    /* Answer Google immediately and sync afterwards. Google retries channels
     * that respond slowly, and a retry storm during a long sync would turn one
     * change into a queue of duplicate work. */
    reply.code(200).send();
    void noteNotification(db, channel.id).catch(() => {});

    void (async () => {
      try {
        const [conn] = await db.select().from(calendarConnections)
          .where(eq(calendarConnections.id, channel.connectionId));
        if (!conn || conn.status === 'revoked') return;
        const result = await syncConnection(db, conn, log);
        await recordSyncOutcome(db, conn.id, result);
        if (result.created || result.updated || result.removed) {
          log.info({ workspace: channel.workspaceId, ...result, errors: result.errors.length },
            'calendar sync from webhook');
        }
      } catch (e) {
        log.warn({ workspace: channel.workspaceId, err: redactTokens(e) },
          'webhook-triggered sync failed');
      }
    })();
    return reply;
  });
}
