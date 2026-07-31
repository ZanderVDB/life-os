/**
 * Applies pending SQL migrations, then exits. Runs before the server serves.
 *
 * On Railway this runs as compiled JavaScript (`node dist/db/migrate.js`), not
 * through tsx — tsx is a devDependency, and a production install omits those.
 * Depending on it here would mean the deploy works only by the accident of
 * devDependencies happening to be installed.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from '../env.js';
import { makeDb } from './client.js';

/**
 * Resolve the migrations folder from THIS file rather than from the working
 * directory, so the command behaves the same however it is invoked.
 * Layout:  <api>/dist/db/migrate.js  →  <api>/drizzle
 */
const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', 'drizzle');

const env = loadEnv();
// One connection: a migration is a single serial operation, and holding a pool
// open would waste connections the running service needs.
const { sql, db } = makeDb(env.DATABASE_URL, { max: 1 });

/**
 * Railway's private network (`*.railway.internal`) needs a moment to come up
 * when a container starts, and this script runs immediately. A cold boot can
 * therefore lose the race and see ECONNREFUSED / ENOTFOUND against a database
 * that is perfectly healthy a second later.
 *
 * Retry only connection-level failures. A migration that fails because the SQL
 * is wrong must fail on the first attempt — retrying that would just take
 * longer to report the same real problem.
 */
const TRANSIENT = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|starting up|terminating connection/i;
const ATTEMPTS = 6;

let lastError: unknown;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    await migrate(db, { migrationsFolder });
    console.log('[migrate] up to date');
    lastError = undefined;
    break;
  } catch (err) {
    lastError = err;
    const message = err instanceof Error ? err.message : String(err);
    if (!TRANSIENT.test(message) || attempt === ATTEMPTS) break;
    const waitMs = 500 * 2 ** (attempt - 1);   // 0.5s, 1s, 2s, 4s, 8s
    console.log(`[migrate] database not reachable yet (attempt ${attempt}/${ATTEMPTS}), retrying in ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

if (lastError) {
  // Fail the deploy loudly. A service that starts against a half-migrated
  // database is far worse than one that refuses to start at all.
  console.error('[migrate] FAILED:', lastError instanceof Error ? lastError.message : lastError);
  process.exitCode = 1;
}

await sql.end();
