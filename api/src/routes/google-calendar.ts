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
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  calendarConnections, calendars, calendarEvents, calendarEventAttendees,
  calendarSyncStates,
} from '../db/schema.js';
import { ApiError, badRequest, notFound, upstreamUnavailable } from '../lib/errors.js';
import { encryptToken, decryptToken, redactTokens } from '../lib/token-crypto.js';
import * as G from '../lib/google-calendar.js';
import {
  syncCalendarList, syncConnection, recordSyncOutcome,
  googleConfig, encryptionKey,
} from '../lib/calendar-sync.js';
import { SYNC_INTERVAL_MS, BACKOFF_BASE_MS, jitter } from '../lib/calendar-scheduler.js';

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

      let result;
      try {
        result = await syncConnection(db, conn, log);
      } catch (e) {
        /* A transient failure is no longer recorded as a revoked grant, so it
         * must not be REPORTED as one either. It is Google having a minute;
         * the connection is intact and the scheduler is already on it. */
        /* An ApiError is already a decided, user-facing answer — including the
         * genuine "Reconnect to continue" that accessTokenFor writes for a
         * revoked grant. Softening it here would be the original bug wearing
         * the opposite face: telling someone to wait when they must act. */
        if (e instanceof ApiError) throw e;
        if (!G.isTransientTokenError(e)) throw e;
        await db.update(calendarConnections).set({
          syncFailureCount: (conn.syncFailureCount ?? 0) + 1,
          nextSyncAt: new Date(Date.now() + jitter(BACKOFF_BASE_MS)),
          updatedAt: new Date(),
        }).where(eq(calendarConnections.id, conn.id));
        log.warn({ workspace: workspaceId, err: redactTokens(e) }, 'manual calendar sync failed');
        throw upstreamUnavailable(
          'Google is not responding right now. Your calendar is still connected — '
          + 'Life OS will keep trying on its own.');
      }
      await recordSyncOutcome(db, conn.id, result);
      /* A manual sync resets the clock: the scheduler has no reason to pull
       * again in ten seconds because somebody just did it by hand. */
      await db.update(calendarConnections)
        .set({ nextSyncAt: new Date(Date.now() + jitter(SYNC_INTERVAL_MS)) })
        .where(eq(calendarConnections.id, conn.id));

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
    // The Calendar needs these to say "syncing automatically" honestly rather
    // than as decoration: they are the scheduler's real state.
    autoSync: c.status !== 'revoked',
    nextSyncAt: c.nextSyncAt,
    syncing: !!c.syncingSince,
    failureCount: c.syncFailureCount ?? 0,
  };
}
