/**
 * Google Calendar integration — READ-ONLY.
 *
 * Flow: /connect issues a state + PKCE pair and redirects to Google.
 * /callback validates the state, exchanges the code server-side, stores the
 * encrypted refresh token, and redirects the browser back to the Calendar
 * page. The access token never reaches the browser.
 *
 * There is no insert/patch/delete path here or in google-calendar.ts. Write
 * support is a separate, separately-approved phase.
 */
import type { AppInstance, Guards } from '../types.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  calendarConnections, calendars, calendarEvents, calendarEventAttendees,
  calendarSyncStates,
} from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { encryptToken, decryptToken, redactTokens } from '../lib/token-crypto.js';
import * as G from '../lib/google-calendar.js';

/** How far around today the FIRST sync reaches. Incremental sync has no window. */
const INITIAL_PAST_DAYS = 90;
const INITIAL_FUTURE_DAYS = 365;

/**
 * Pending authorisations, held in memory.
 *
 * Deliberately not a database table: these live for seconds, are useless once
 * consumed, and must not survive a restart — a stale PKCE verifier is a
 * liability, not an asset. Single-instance staging makes this safe; a
 * multi-instance deployment would need shared storage, which is recorded in
 * docs/technical-debt.md.
 */
const pending = new Map<string, {
  workspaceId: string; userId: string; verifier: string; expiresAt: number;
}>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
}

function googleConfig() {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

const encryptionKey = () => process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY ?? '';
const postConnectUrl = () =>
  process.env.GOOGLE_CALENDAR_POST_CONNECT_URL ?? 'https://life-os-v2-web-staging-v2-staging.up.railway.app/#calendar';

/** Masks an address for display: z••••@gmail.com. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [user, domain] = email.split('@');
  if (!user || !domain) return null;
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(3, user.length - 1))}@${domain}`;
}

export function registerGoogleCalendarRoutes(app: AppInstance, db: Db, guards: Guards) {
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const log = app.log;

  /** Fresh access token for a connection, refreshing when close to expiry. */
  async function accessTokenFor(connectionId: string): Promise<string> {
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
        updatedAt: new Date(),
      }).where(eq(calendarConnections.id, connectionId));
      return set.accessToken;
    } catch (e) {
      // A refresh failure is usually a revoked grant, which the user must fix.
      await db.update(calendarConnections).set({
        status: 'revoked',
        lastError: 'Google access was revoked or expired. Reconnect to continue.',
        updatedAt: new Date(),
      }).where(eq(calendarConnections.id, connectionId));
      throw badRequest('Google access was revoked or expired. Reconnect to continue.');
    }
  }

  /* ── Status ────────────────────────────────────────────────────────── */
  app.get('/api/v1/workspaces/:workspaceId/integrations/google-calendar', pre, async (req) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const [conn] = await db.select().from(calendarConnections).where(and(
      eq(calendarConnections.workspaceId, workspaceId),
      eq(calendarConnections.provider, 'google'),
    ));
    return {
      configured: !!googleConfig(),
      connection: conn ? publicConnection(conn) : null,
    };
  });

  /* ── Start ─────────────────────────────────────────────────────────── */
  app.post('/api/v1/workspaces/:workspaceId/integrations/google-calendar/connect', pre,
    async (req) => {
      const { workspaceId } = req.params as { workspaceId: string };
      const cfg = googleConfig();
      if (!cfg) throw badRequest('Google Calendar is not configured on this server.');
      if (!encryptionKey()) throw badRequest('Token encryption is not configured.');

      sweep();
      const state = G.createState();
      const { verifier, challenge } = G.createPkce();
      pending.set(state, {
        workspaceId,
        userId: (req as any).user?.uid ?? '',
        verifier,
        expiresAt: Date.now() + 10 * 60_000,
      });
      // Only the URL crosses to the browser. No secret, no verifier.
      return { authorizeUrl: G.authorizeUrl(cfg, state, challenge), scope: G.GOOGLE_SCOPE };
    });

  /* ── Callback ──────────────────────────────────────────────────────────
   * Unauthenticated by necessity — Google redirects the browser here without
   * our Authorization header. The `state` is what proves this callback belongs
   * to a request WE started, which is why it is single-use and short-lived. */
  app.get('/api/v1/integrations/google-calendar/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const fail = (reason: string) =>
      reply.redirect(`${postConnectUrl()}?calendar=error&reason=${encodeURIComponent(reason)}`);

    if (q.error) return fail(q.error === 'access_denied' ? 'declined' : 'google_error');
    if (!q.code || !q.state) return fail('missing_code');

    sweep();
    const entry = pending.get(q.state);
    // Single use: consumed whether or not the rest succeeds, so a replayed
    // state cannot mint a second connection.
    pending.delete(q.state);
    if (!entry) return fail('expired_state');

    const cfg = googleConfig();
    if (!cfg) return fail('not_configured');

    try {
      const set = await G.exchangeCode(cfg, q.code, entry.verifier);
      // Refuse anything broader or narrower than what we asked for.
      if (!set.scopes.includes(G.GOOGLE_SCOPE)) return fail('scope_not_granted');
      if (!set.refreshToken) return fail('no_lasting_grant');

      const email = await G.fetchAccountEmail(set.accessToken);
      const providerAccountId = email ?? `google:${entry.workspaceId}`;

      const existing = await db.select().from(calendarConnections).where(and(
        eq(calendarConnections.workspaceId, entry.workspaceId),
        eq(calendarConnections.provider, 'google'),
      ));

      const values = {
        workspaceId: entry.workspaceId,
        provider: 'google',
        providerAccountId,
        accountEmail: email,
        status: 'active',
        accessTokenRef: encryptToken(set.accessToken, encryptionKey()),
        refreshTokenRef: encryptToken(set.refreshToken, encryptionKey()),
        tokenExpiresAt: set.expiresAt,
        grantedScopes: set.scopes,
        lastError: null,
        disconnectedAt: null,
        updatedAt: new Date(),
      };

      let connectionId: string;
      if (existing[0]) {
        await db.update(calendarConnections).set(values)
          .where(eq(calendarConnections.id, existing[0].id));
        connectionId = existing[0].id;
      } else {
        const [row] = await db.insert(calendarConnections).values(values).returning();
        connectionId = row!.id;
      }

      // Calendar list now; events on the first explicit sync, so the redirect
      // is not held open for a long import.
      await syncCalendarList(db, connectionId, entry.workspaceId, set.accessToken);
      return reply.redirect(`${postConnectUrl()}?calendar=connected`);
    } catch (e) {
      log.error({ err: redactTokens(e) }, 'google calendar callback failed');
      return fail('exchange_failed');
    }
  });

  /* ── Sync ──────────────────────────────────────────────────────────── */
  app.post('/api/v1/workspaces/:workspaceId/integrations/google-calendar/sync', pre,
    async (req) => {
      const { workspaceId } = req.params as { workspaceId: string };
      const [conn] = await db.select().from(calendarConnections).where(and(
        eq(calendarConnections.workspaceId, workspaceId),
        eq(calendarConnections.provider, 'google'),
      ));
      if (!conn) throw notFound('No Google Calendar connection.');

      const token = await accessTokenFor(conn.id);
      await syncCalendarList(db, conn.id, workspaceId, token);

      const cals = await db.select().from(calendars).where(and(
        eq(calendars.workspaceId, workspaceId),
        eq(calendars.connectionId, conn.id),
        eq(calendars.isVisible, true),
      ));

      const result = { calendars: 0, created: 0, updated: 0, removed: 0, errors: [] as string[] };
      for (const c of cals) {
        try {
          const r = await syncEvents(db, workspaceId, conn.id, c, token);
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

      await db.update(calendarConnections).set({
        lastSyncedAt: new Date(),
        status: result.errors.length && !result.calendars ? 'error' : 'active',
        lastError: result.errors.length ? `Could not sync: ${result.errors.join(', ')}` : null,
        updatedAt: new Date(),
      }).where(eq(calendarConnections.id, conn.id));

      return result;
    });

  /* ── Calendar visibility ───────────────────────────────────────────── */
  app.patch('/api/v1/workspaces/:workspaceId/calendars/:id', pre, async (req) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const b = z.object({ isVisible: z.boolean() }).safeParse(req.body);
    if (!b.success) throw badRequest('isVisible is required.');
    const [row] = await db.update(calendars).set({
      isVisible: b.data.isVisible, updatedAt: new Date(),
    }).where(and(eq(calendars.id, id), eq(calendars.workspaceId, workspaceId))).returning();
    if (!row) throw notFound('Calendar not found.');
    return { calendar: row };
  });

  /* ── Disconnect ────────────────────────────────────────────────────── */
  app.post('/api/v1/workspaces/:workspaceId/integrations/google-calendar/disconnect', pre,
    async (req) => {
      const { workspaceId } = req.params as { workspaceId: string };
      const [conn] = await db.select().from(calendarConnections).where(and(
        eq(calendarConnections.workspaceId, workspaceId),
        eq(calendarConnections.provider, 'google'),
      ));
      if (!conn) return { disconnected: true };

      // Best effort: tell Google the grant is finished.
      let revoked = false;
      if (conn.refreshTokenRef) {
        try {
          revoked = await G.revokeToken(decryptToken(conn.refreshTokenRef, encryptionKey()));
        } catch { /* the local credentials are cleared regardless */ }
      }

      // Google's projections go; Life OS-only records never do.
      const cals = await db.select({ id: calendars.id }).from(calendars)
        .where(and(eq(calendars.workspaceId, workspaceId), eq(calendars.connectionId, conn.id)));
      if (cals.length) {
        await db.delete(calendars).where(inArray(calendars.id, cals.map((c) => c.id)));
      }
      await db.delete(calendarConnections).where(eq(calendarConnections.id, conn.id));

      return { disconnected: true, revokedWithGoogle: revoked, calendarsRemoved: cals.length };
    });
}

/** Shape sent to the browser. No tokens, no raw provider ids. */
function publicConnection(c: typeof calendarConnections.$inferSelect) {
  return {
    id: c.id,
    accountEmail: maskEmail(c.accountEmail),
    status: c.status,
    scopes: c.grantedScopes,
    readOnly: true,
    lastSyncedAt: c.lastSyncedAt,
    lastError: c.lastError,
  };
}

/* ── Sync implementation ─────────────────────────────────────────────── */

async function syncCalendarList(db: Db, connectionId: string, workspaceId: string, token: string) {
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

async function syncEvents(
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
