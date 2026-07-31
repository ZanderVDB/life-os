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

export async function freshDb() {
  const client = new PGlite();
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
