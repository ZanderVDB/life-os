/**
 * The background calendar sync.
 *
 * Until now the only thing that ever pulled Google was a browser with the
 * Calendar tab open. Close the laptop and the calendar stopped being true;
 * open it a week later and the first thing you saw was last week. "It syncs
 * automatically" was a description of the tab, not of the product.
 *
 * This loop runs in the API process, which is awake regardless, and keeps
 * every connected workspace current. Four rules shape it:
 *
 *   CLAIM BEFORE WORKING. A connection is marked as taken by a conditional
 *   UPDATE that only one caller can win. Two ticks overlapping — or two
 *   instances during a deploy — cannot both sync the same account.
 *
 *   BACK OFF ON FAILURE, NEVER GIVE UP. A failing connection retries on a
 *   doubling delay up to a ceiling. It is never abandoned, because the thing
 *   that broke is usually Google having a minute, and a calendar that quietly
 *   stopped forever is the bug this whole phase exists to fix.
 *
 *   A REVOKED GRANT IS NOT A FAILURE TO RETRY. There is nothing to retry with.
 *   Those are excluded from the query entirely until the user reconnects.
 *
 *   NEVER LET A TICK THROW. This runs unattended. An unhandled rejection here
 *   takes down the API for everyone.
 */
import { and, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { calendarConnections } from '../db/schema.js';
import { redactTokens } from './token-crypto.js';
import { syncConnection, recordSyncOutcome, googleConfig, type SyncLogger } from './calendar-sync.js';

/** How often the loop looks for work. Cheap: one indexed query. */
export const TICK_MS = 60_000;

/** How often a healthy connection is pulled. */
export const SYNC_INTERVAL_MS = 5 * 60_000;

/** The first retry delay after a failure, doubled each time up to the ceiling. */
export const BACKOFF_BASE_MS = 2 * 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

/** Connections handled per tick, so one busy account cannot starve the rest. */
export const BATCH = 10;

/** A claim older than this was left by a crashed process and may be retaken. */
export const CLAIM_STALE_MS = 15 * 60_000;

/**
 * When a failure becomes worth telling the user about.
 *
 * Below this the app says nothing: a single missed pull is invisible to
 * someone whose calendar is still five minutes fresh, and reporting it would
 * train them to ignore the one that matters.
 */
export const FAILURES_BEFORE_VISIBLE = 3;

/** The retry delay after `n` consecutive failures. */
export function backoffMs(n: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, n - 1), BACKOFF_MAX_MS);
}

/**
 * A spread of up to ±10%.
 *
 * Without it every connection created in the same deploy syncs in the same
 * second forever, which turns a steady trickle of Google calls into a spike
 * once every five minutes.
 */
export function jitter(ms: number, rand = Math.random): number {
  return Math.round(ms * (0.9 + rand() * 0.2));
}

/**
 * The loop's own account of itself, for /health/version.
 *
 * A background job you cannot see is a background job you cannot trust. This
 * is what makes "is the calendar actually syncing?" answerable without a
 * database session — the question that had no answer while the old bug was
 * quietly disconnecting people. Counters only: no workspace, no account, no
 * token, nothing that is anyone's private business.
 */
const status = {
  started: false,
  passes: 0,
  lastPassAt: null as string | null,
  lastSynced: 0,
  lastFailed: 0,
  consecutivePassFailures: 0,
  /* A pass that THREW is the state most worth seeing, and the first version of
   * this recorded nothing at all for it — so a loop failing every minute was
   * indistinguishable from a loop that had never run. Never again. */
  failedPasses: 0,
  lastError: null as string | null,
};

export const schedulerStatus = () => ({ ...status });

export type SchedulerHandle = {
  /** Runs one pass immediately and resolves when it is done. For tests. */
  runOnce: () => Promise<{ synced: number; failed: number; skipped: number }>;
  stop: () => void;
};

/**
 * Claims up to BATCH due connections and syncs them.
 *
 * Exported separately from the timer so a test can drive it deterministically
 * without waiting a minute of real time.
 */
export async function runSyncPass(db: Db, log: SyncLogger) {
  const outcome = { synced: 0, failed: 0, skipped: 0 };
  if (!googleConfig()) { outcome.skipped = 1; return outcome; }

  const now = new Date();
  const staleClaim = new Date(now.getTime() - CLAIM_STALE_MS);

  /* Claim and read in one statement. `syncingSince IS NULL` is the lock: a
   * second caller matches zero rows and does nothing, which is exactly right.
   * A stale claim is retaken so a crash mid-sync cannot strand an account. */
  const claimed = await db.update(calendarConnections)
    .set({ syncingSince: now })
    .where(and(
      ne(calendarConnections.status, 'revoked'),
      or(isNull(calendarConnections.syncingSince), lte(calendarConnections.syncingSince, staleClaim)),
      or(isNull(calendarConnections.nextSyncAt), lte(calendarConnections.nextSyncAt, now)),
      sql`${calendarConnections.refreshTokenRef} IS NOT NULL`,
      sql`${calendarConnections.id} IN (
        SELECT id FROM calendar_connections
        WHERE status <> 'revoked'
          AND refresh_token_ref IS NOT NULL
          AND (syncing_since IS NULL OR syncing_since <= ${staleClaim})
          AND (next_sync_at IS NULL OR next_sync_at <= ${now})
        ORDER BY next_sync_at ASC NULLS FIRST
        LIMIT ${BATCH}
      )`,
    ))
    .returning();

  for (const conn of claimed) {
    try {
      const result = await syncConnection(db, conn, log);
      await recordSyncOutcome(db, conn.id, result);
      await db.update(calendarConnections).set({
        syncingSince: null,
        nextSyncAt: new Date(Date.now() + jitter(SYNC_INTERVAL_MS)),
      }).where(sql`${calendarConnections.id} = ${conn.id}`);
      outcome.synced++;
      if (result.created || result.updated || result.removed) {
        log.info({
          workspace: conn.workspaceId, ...result, errors: result.errors.length,
        }, 'calendar auto-sync');
      }
    } catch (e) {
      /* Reread: accessTokenFor may have just marked this revoked, and writing
       * a retry time over that would put a dead connection back in the queue. */
      const failures = (conn.syncFailureCount ?? 0) + 1;
      const delay = jitter(backoffMs(failures));
      await db.update(calendarConnections).set({
        syncingSince: null,
        nextSyncAt: new Date(Date.now() + delay),
        syncFailureCount: failures,
        /* Only speak up once it is a pattern, and never overwrite a status the
         * token refresh has already decided (revoked stays revoked). */
        lastError: failures >= FAILURES_BEFORE_VISIBLE
          ? `Google has not responded since ${conn.lastSyncedAt?.toISOString().slice(0, 16).replace('T', ' ') ?? 'the last sync'}. Still trying.`
          : conn.lastError,
      }).where(and(
        sql`${calendarConnections.id} = ${conn.id}`,
        ne(calendarConnections.status, 'revoked'),
      ));
      /* A revoked connection still needs its claim released or the stale-claim
       * timeout is the only thing that frees it. */
      await db.update(calendarConnections).set({ syncingSince: null })
        .where(sql`${calendarConnections.id} = ${conn.id}`);
      outcome.failed++;
      log.warn({
        workspace: conn.workspaceId, failures, retryInMs: delay, err: redactTokens(e),
      }, 'calendar auto-sync failed');
    }
  }
  return outcome;
}

/** Starts the loop. Returns a handle so tests and shutdown can control it. */
export function startCalendarScheduler(db: Db, log: SyncLogger): SchedulerHandle {
  let running = false;
  let stopped = false;

  const pass = async () => {
    // One pass at a time in this process, whatever the timer thinks.
    if (running || stopped) return { synced: 0, failed: 0, skipped: 1 };
    running = true;
    try {
      const r = await runSyncPass(db, log);
      status.passes++;
      status.lastPassAt = new Date().toISOString();
      status.lastSynced = r.synced;
      status.lastFailed = r.failed;
      status.consecutivePassFailures = r.failed > 0 ? status.consecutivePassFailures + 1 : 0;
      if (r.failed === 0) status.lastError = null;
      return r;
    } catch (e) {
      // Unattended code: a throw here would be an unhandled rejection.
      status.passes++;
      status.failedPasses++;
      status.lastPassAt = new Date().toISOString();
      status.consecutivePassFailures++;
      // The message only, and never the error object: it can carry a token.
      status.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      try { log.error({ err: redactTokens(e) }, 'calendar scheduler pass failed'); }
      catch { /* a logger that throws must not take the loop with it */ }
      return { synced: 0, failed: 1, skipped: 0 };
    } finally {
      running = false;
    }
  };

  status.started = true;
  const timer = setInterval(() => { void pass(); }, TICK_MS);
  // Never hold the process open on this alone.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    runOnce: pass,
    stop: () => { stopped = true; status.started = false; clearInterval(timer); },
  };
}
