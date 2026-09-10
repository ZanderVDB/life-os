/**
 * Test harness. Runs the REAL migration SQL against PGlite — genuine Postgres
 * compiled to WASM — so schema constraints, partial indexes and CHECKs are
 * actually exercised. No provisioning, no account access, no staging database.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as schema from '../src/db/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');

/**
 * Refuse a raw Date as a query parameter — because production does.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * drizzle's postgres-js driver swaps the date and timestamp serializers for
 * pass-throughs and relies on its COLUMN encoders to turn a Date into a string
 * before the driver sees it. A Date that reaches the driver without passing
 * through a column — `gte(sql\`coalesce(...)\`, someDate)`, a raw `sql`
 * template interpolating a Date — makes postgres-js call
 * `Buffer.byteLength(Date)`, which throws, and the request 500s.
 *
 * PGlite serialises a Date by itself, so the same query passes here. That gap
 * took the whole calendar down in production on 10 September 2026: every load
 * of /calendar/range 500'd while the sync loop kept working, so it presented as
 * a calendar that "keeps disconnecting and will not reconnect". 1,836 tests
 * were green, because every one of them ran on the driver that forgives it.
 *
 * So the test driver no longer forgives it. The check is exactly as strict as
 * production and no stricter: a properly encoded timestamp is already a string
 * by the time it gets here, so only the bug class trips it.
 */
function refuseRawDates(params: unknown) {
  if (!Array.isArray(params)) return;
  for (const p of params) {
    if (p instanceof Date) {
      throw new TypeError(
        'A raw Date was bound as a query parameter. On production Postgres '
        + '(drizzle + postgres-js) this throws ERR_INVALID_ARG_TYPE and the request '
        + 'returns 500. Put a COLUMN on the left of the comparison so drizzle can '
        + 'encode it, or bind `date.toISOString()` instead.',
      );
    }
  }
}

function guardClient<T extends { query: (...a: any[]) => any }>(c: T): T {
  const query = c.query.bind(c);
  (c as any).query = (text: string, params?: unknown[], opts?: unknown) => {
    refuseRawDates(params);
    return query(text, params, opts);
  };
  return c;
}

export async function freshDb() {
  const client = new PGlite();
  guardClient(client);
  /* Transactions hand drizzle a separate client, which has its own `query`.
     Guarding only the outer one would leave every transactional write — the
     calendar mutations, the diary saves — forgiven exactly as before. */
  const transaction = client.transaction.bind(client);
  (client as any).transaction = (fn: (tx: any) => unknown) =>
    transaction(async (tx: any) => fn(guardClient(tx)));
  const db = drizzle(client, { schema });

  const files = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = readFileSync(join(drizzleDir, f), 'utf8');
    for (const stmt of sqlText.split('--> statement-breakpoint')) {
      const s = stmt.trim();
      if (s) await client.exec(s);
    }
  }
  return { client, db: db as any };
}

export const identity = (email = 'zander@example.com', uid = 'firebase-uid-1') => ({
  externalUid: uid, email, displayName: 'Zander Test',
});
