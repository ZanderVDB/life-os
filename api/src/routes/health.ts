import type { AppInstance } from '../types.js';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schedulerStatus } from '../lib/calendar-scheduler.js';
import { googleConfig } from '../lib/calendar-sync.js';
import { webhookConfigured, webhookUrl } from '../lib/calendar-watch.js';
import { calendarWatchChannels } from '../db/schema.js';
import type { Assistant } from '../ai/index.js';

export function registerHealthRoutes(
  app: AppInstance, db: Db, version: string, assistant?: Assistant,
) {
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
    /* Whether push is actually working, which is the difference between a
     * calendar that updates in seconds and one that updates in minutes — and
     * is otherwise invisible, because a failed watch looks exactly like a
     * working one from the outside. Counts and the last error only; no
     * workspace, no calendar name, no token. */
    calendarPush: await pushStatus(),
    /* Whether a model is configured HERE. Without this the only way to find
       out whether staging has a key is to sign in and ask the assistant, and
       the answer to "why is it not working" was a shrug. A boolean and the
       job names; no key, no vendor host, no model id — this endpoint is
       public. */
    assistant: {
      configured: Boolean(assistant?.providers.for('plan')),
      jobs: assistant
        ? Object.fromEntries((['interpret', 'plan', 'answer', 'extractMemory'] as const)
          .map((j) => [j, Boolean(assistant.providers.for(j))]))
        : {},
    },
  }));

  async function pushStatus() {
    if (!webhookConfigured()) {
      return { configured: false, reason: 'no HTTPS webhook address', channels: 0 };
    }
    try {
      const rows = await db.select({
        status: calendarWatchChannels.status,
        expiresAt: calendarWatchChannels.expiresAt,
        notifyCount: calendarWatchChannels.notifyCount,
        lastNotifiedAt: calendarWatchChannels.lastNotifiedAt,
        lastError: calendarWatchChannels.lastError,
      }).from(calendarWatchChannels);
      const active = rows.filter((r) => r.status === 'active');
      return {
        configured: true,
        address: webhookUrl(),
        channels: rows.length,
        active: active.length,
        failed: rows.filter((r) => r.status === 'failed').length,
        notifications: rows.reduce((n, r) => n + (r.notifyCount ?? 0), 0),
        lastNotifiedAt: rows.map((r) => r.lastNotifiedAt).filter(Boolean)
          .sort().at(-1) ?? null,
        soonestExpiry: active.map((r) => r.expiresAt).filter(Boolean).sort().at(0) ?? null,
        // The reason a watch could not be opened is the thing worth seeing.
        lastError: rows.map((r) => r.lastError).filter(Boolean).at(-1) ?? null,
      };
    } catch (e) {
      return { configured: true, error: String((e as any)?.message ?? e).slice(0, 200) };
    }
  }
}
