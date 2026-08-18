import type { AppInstance } from '../types.js';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schedulerStatus } from '../lib/calendar-scheduler.js';
import { googleConfig } from '../lib/calendar-sync.js';

export function registerHealthRoutes(app: AppInstance, db: Db, version: string) {
  /** Liveness — no dependencies, no auth. Railway uses this. */
  app.get('/health', async () => ({ status: 'ok', service: 'life-os-v2-api' }));

  /** Readiness — can we actually serve? Checks the database. */
  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ok = true;
    try { await db.execute(sql`select 1`); checks['database'] = 'ok'; }
    catch { checks['database'] = 'unreachable'; ok = false; }
    if (!ok) reply.code(503);
    return { status: ok ? 'ready' : 'degraded', checks };
  });

  /**
   * What is deployed, and whether the background work is actually running.
   *
   * `build` is the commit, which the package version is not: verifying a
   * deploy by reading "0.1.0" back proves only that something is up. The
   * calendar block makes an unattended loop visible — the thing it does is
   * invisible by design, so its absence was too.
   */
  app.get('/health/version', async () => ({
    version,
    build: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? process.env.BUILD_ID ?? 'dev',
    node: process.version,
    calendarSync: { configured: !!googleConfig(), ...schedulerStatus() },
  }));
}
