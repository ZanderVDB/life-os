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

try {
  await migrate(db, { migrationsFolder });
  console.log('[migrate] up to date');
} catch (err) {
  // Fail the deploy loudly. A service that starts against a half-migrated
  // database is far worse than one that refuses to start at all.
  console.error('[migrate] FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
