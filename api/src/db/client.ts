import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export type Db = ReturnType<typeof makeDb>['db'];

export function makeDb(url: string, opts: { max?: number } = {}) {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    // Railway Postgres requires TLS; local dev usually does not.
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : 'require',
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}
