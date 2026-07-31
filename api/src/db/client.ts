import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export type Db = ReturnType<typeof makeDb>['db'];

/**
 * Decide TLS from the connection string.
 *
 * Railway hands out two different URLs and they do NOT have the same
 * requirements:
 *
 *   DATABASE_URL          public TCP proxy, crosses the internet → TLS required
 *   DATABASE_PRIVATE_URL  *.railway.internal, private network    → no TLS
 *
 * Forcing `require` on the internal host fails to connect at all; forcing it
 * off on the public host would send credentials across the internet in the
 * clear. An explicit `sslmode` in the URL always wins, so this can be
 * overridden from Railway without a code change.
 */
export function sslModeFor(url: string): 'require' | false {
  let parsed: URL | null = null;
  try { parsed = new URL(url); } catch { /* fall through to raw host matching */ }

  const explicit = parsed?.searchParams.get('sslmode');
  if (explicit) return explicit === 'disable' ? false : 'require';

  const host = parsed?.hostname ?? url;
  if (/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(host)) return false;
  if (/\.railway\.internal$/.test(host)) return false;
  if (host === 'pglite') return false;               // the in-memory dev server
  return 'require';
}

export function makeDb(url: string, opts: { max?: number } = {}) {
  const sql = postgres(url, {
    /**
     * Pool size per service instance. A Railway Postgres instance shares
     * roughly 100 connections across everything that talks to it, and this
     * number is multiplied by every replica — so keep it modest and raise it
     * deliberately rather than hopefully.
     */
    max: opts.max ?? Number(process.env.DATABASE_POOL_MAX ?? 10),
    /** Recycle idle connections so a database restart doesn't strand them. */
    idle_timeout: 30,
    /** Fail a hung connect rather than holding a request open indefinitely. */
    connect_timeout: 10,
    ssl: sslModeFor(url),
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}
