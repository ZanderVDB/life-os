/**
 * The Google Calendar sync engine — READ-ONLY.
 *
 * This lives apart from the route that used to hold it because it now has two
 * callers with different urgencies: a person pressing "Sync now", and the
 * scheduler that keeps the calendar current while nobody is watching. The
 * engine itself cannot tell them apart, and should not.
 *
 * There is no insert/patch/delete path here. Write support is a separate,
 * separately-approved phase.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  calendarConnections, calendars, calendarEvents, calendarEventAttendees,
  calendarSyncStates,
} from '../db/schema.js';
import { badRequest, notFound } from './errors.js';
import { encryptToken, decryptToken, redactTokens } from './token-crypto.js';
import * as G from './google-calendar.js';

/** How far around today the FIRST sync reaches. Incremental sync has no window. */
export const INITIAL_PAST_DAYS = 90;
export const INITIAL_FUTURE_DAYS = 365;

export type SyncLogger = {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
};

export function googleConfig() {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export const encryptionKey = () => process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY ?? '';

/**
 * A fresh access token, refreshing when close to expiry.
 *
 * The catch here used to mark EVERY failure `revoked` — a permanent state that
 * only a human clicking Reconnect can leave. A Google 503, a DNS blip or a
 * rate limit therefore killed the calendar until somebody noticed. Now only
 * Google actually saying the grant is gone counts; everything else is a bad
 * minute, and a bad minute is the scheduler's problem, not the user's.
 */
export async function accessTokenFor(db: Db, connectionId: string): Promise<string> {
  const cfg = googleConfig();
  if (!cfg) throw badRequest('Google Calendar is not configured on this server.');
  const [conn] = await db.select().from(calendarConnections)
    .where(eq(calendarConnections.id, connectionId));
  if (!conn) throw notFound('Connection not found.');
  if (!conn.refreshTokenRef) throw badRequest('This connection needs to be reconnected.');

  const stillValid = conn.accessTokenRef && conn.tokenExpiresAt
    && conn.tokenExpiresAt.getTime() - Date.now() > 60_000;
  if (stillValid) return decryptToken(conn.accessTokenRef!, encryptionKey());

  const refresh = decryptToken(conn.refreshTokenRef, encryptionKey());
  try {
    const set = await G.refreshAccessToken(cfg, refresh);
    await db.update(calendarConnections).set({
      accessTokenRef: encryptToken(set.accessToken, encryptionKey()),
      tokenExpiresAt: set.expiresAt,
      status: 'active',
      lastError: null,
      syncFailureCount: 0,
      updatedAt: new Date(),
    }).where(eq(calendarConnections.id, connectionId));
    return set.accessToken;
  } catch (e) {
    if (G.isTransientTokenError(e)) {
      /* Leave the connection alone. It is not broken; Google was busy. The
       * caller records the failure and the scheduler tries again. */
      throw e;
    }
    await db.update(calendarConnections).set({
      status: 'revoked',
      lastError: 'Google access was revoked or expired. Reconnect to continue.',
      updatedAt: new Date(),
    }).where(eq(calendarConnections.id, connectionId));
    throw badRequest('Google access was revoked or expired. Reconnect to continue.');
  }
}

export type SyncResult = {
  calendars: number; created: number; updated: number; removed: number; errors: string[];
};

/**
 * Pull one connection up to date.
 *
 * Never throws for a single bad calendar — one calendar failing must not cost
 * the other five. It DOES throw when the token itself could not be obtained,
 * because that is the whole connection and the caller decides what it means.
 */
export async function syncConnection(
  db: Db, conn: typeof calendarConnections.$inferSelect, log: SyncLogger,
): Promise<SyncResult> {
  const token = await accessTokenFor(db, conn.id);
  await syncCalendarList(db, conn.id, conn.workspaceId, token);

  const cals = await db.select().from(calendars).where(and(
    eq(calendars.workspaceId, conn.workspaceId),
    eq(calendars.connectionId, conn.id),
    eq(calendars.isVisible, true),
  ));

  const result: SyncResult = { calendars: 0, created: 0, updated: 0, removed: 0, errors: [] };
  for (const c of cals) {
    try {
      const r = await syncEvents(db, conn.workspaceId, conn.id, c, token);
      result.calendars++;
      result.created += r.created;
      result.updated += r.updated;
      result.removed += r.removed;
    } catch (e) {
      // One bad calendar must not abort the rest.
      result.errors.push(c.name);
      log.warn({ calendar: c.name, err: redactTokens(e) }, 'calendar sync failed');
    }
  }
  return result;
}

/** Records a successful pass. Shared, so manual and scheduled syncs agree. */
export async function recordSyncOutcome(db: Db, connectionId: string, result: SyncResult) {
  const failedEntirely = result.errors.length > 0 && result.calendars === 0;
  await db.update(calendarConnections).set({
    lastSyncedAt: new Date(),
    status: failedEntirely ? 'error' : 'active',
    lastError: result.errors.length ? `Could not sync: ${result.errors.join(', ')}` : null,
    syncFailureCount: failedEntirely ? 1 : 0,
    updatedAt: new Date(),
  }).where(eq(calendarConnections.id, connectionId));
}

/* ── Sync implementation ─────────────────────────────────────────────── */

export async function syncCalendarList(
  db: Db, connectionId: string, workspaceId: string, token: string,
) {
  const list = await G.listCalendars(token);
  for (const c of list) {
    const values = {
      workspaceId,
      connectionId,
      providerCalendarId: c.id,
      name: c.summary ?? 'Calendar',
      description: c.description ?? null,
      color: c.backgroundColor ?? null,
      timeZone: c.timeZone ?? null,
      accessRole: c.accessRole,
      isPrimary: !!c.primary,
      isReadOnly: G.roleIsReadOnly(c.accessRole),
      isSynthetic: false,
      updatedAt: new Date(),
    };
    // Idempotent: a re-run updates rather than duplicating.
    await db.insert(calendars).values({
      ...values,
      // Google's own "selected" decides the default, once.
      isVisible: c.selected !== false,
    }).onConflictDoUpdate({
      target: [calendars.workspaceId, calendars.providerCalendarId],
      set: values,
    });
  }
  return list.length;
}

export async function syncEvents(
  db: Db, workspaceId: string, connectionId: string,
  cal: typeof calendars.$inferSelect, token: string,
) {
  const [state] = await db.select().from(calendarSyncStates)
    .where(eq(calendarSyncStates.calendarId, cal.id));

  const window = () => {
    const min = new Date(); min.setDate(min.getDate() - INITIAL_PAST_DAYS);
    const max = new Date(); max.setDate(max.getDate() + INITIAL_FUTURE_DAYS);
    return { timeMin: min.toISOString(), timeMax: max.toISOString() };
  };

  let page: G.EventPage;
  let fullResync = false;
  try {
    page = await G.listEvents(token, cal.providerCalendarId,
      state?.syncToken ? { syncToken: state.syncToken } : window());
  } catch (e) {
    if (!G.isSyncTokenInvalid(e)) throw e;
    // Google expired the token. Start again from a clean window — but do NOT
    // delete anything first: the upserts below reconcile, and wiping would
    // briefly empty the user's calendar.
    fullResync = true;
    page = await G.listEvents(token, cal.providerCalendarId, window());
  }

  let created = 0; let updated = 0; let removed = 0;

  for (const raw of page.items) {
    // Cancelled instances arrive during incremental sync and must be removed.
    if (raw.status === 'cancelled') {
      const del = await db.delete(calendarEvents).where(and(
        eq(calendarEvents.calendarId, cal.id),
        eq(calendarEvents.providerEventId, raw.id),
      )).returning({ id: calendarEvents.id });
      removed += del.length;
      continue;
    }

    const m = G.mapEvent(raw);
    if (!m) continue;
    const { attendees, ...row } = m;

    const [saved] = await db.insert(calendarEvents).values({
      workspaceId,
      calendarId: cal.id,
      ...row,
      syncState: 'synced',
      isSynthetic: false,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [calendarEvents.calendarId, calendarEvents.providerEventId],
      // The index is PARTIAL (`WHERE provider_event_id IS NOT NULL`), and
      // Postgres refuses to match ON CONFLICT to a partial index unless the
      // statement repeats the predicate. Without this every event insert threw
      // "no unique or exclusion constraint matching the ON CONFLICT
      // specification", so a connection synced its calendar list and no events.
      targetWhere: isNotNull(calendarEvents.providerEventId),
      set: {
        ...row,
        syncState: 'synced',
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      },
    }).returning({ id: calendarEvents.id, createdAt: calendarEvents.createdAt });

    if (saved) {
      // Cheap create/update discrimination without a second query.
      if (Date.now() - saved.createdAt.getTime() < 5_000) created++; else updated++;
      await db.delete(calendarEventAttendees)
        .where(eq(calendarEventAttendees.eventId, saved.id));
      if (attendees.length) {
        await db.insert(calendarEventAttendees).values(
          attendees.map((a: typeof attendees[number]) =>
            ({ workspaceId, eventId: saved.id, ...a })),
        );
      }
    }
  }

  const syncValues = {
    workspaceId,
    calendarId: cal.id,
    connectionId,
    syncToken: page.nextSyncToken,
    // A full window read counts as a full sync; an incremental one does not
    // reset the marker, so "when did we last read everything" stays true.
    fullSyncCompletedAt: state?.syncToken && !fullResync
      ? state.fullSyncCompletedAt : new Date(),
    lastIncrementalAt: new Date(),
    tokenInvalidatedAt: fullResync ? new Date() : null,
    isSyncing: false,
    consecutiveFailures: 0,
    lastError: null,
    updatedAt: new Date(),
  };
  await db.insert(calendarSyncStates).values(syncValues)
    .onConflictDoUpdate({ target: calendarSyncStates.calendarId, set: syncValues });

  return { created, updated, removed, fullResync };
}
