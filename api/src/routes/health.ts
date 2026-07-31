import type { AppInstance } from '../types.js';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

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

  app.get('/health/version', async () => ({ version, node: process.version }));
}
