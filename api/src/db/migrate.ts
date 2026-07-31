/** Applies pending SQL migrations, then exits. Run before the server serves. */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadEnv } from '../env.js';
import { makeDb } from './client.js';

const env = loadEnv();
const { sql, db } = makeDb(env.DATABASE_URL, { max: 1 });
await migrate(db, { migrationsFolder: 'drizzle' });
await sql.end();
console.log('[migrate] up to date');
