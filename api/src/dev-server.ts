/**
 * Local dev server — the whole v2 stack with nothing to provision.
 *
 * Runs the real Fastify app against PGlite (genuine Postgres compiled to WASM),
 * applying the same migration files Railway will run. No DATABASE_URL, no
 * Docker, no cloud account. Use it to work on /web before staging exists.
 *
 *     npm run dev:local
 *
 * Auth uses DEV_AUTH_BYPASS. That is safe by construction: loadEnv() refuses to
 * accept the variable at all when NODE_ENV is staging or production, so this
 * door cannot be opened on a deployed service.
 *
 * The database lives in memory and is DISCARDED on exit. This is a scratch
 * environment, never a place to keep anything.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './db/schema.js';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');

const DEV_TOKEN = 'local-dev-token';
const PORT = Number(process.env.PORT ?? 8080);

const client = new PGlite();
const db = drizzle(client, { schema }) as any;

for (const f of readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()) {
  for (const stmt of readFileSync(join(drizzleDir, f), 'utf8').split('--> statement-breakpoint')) {
    const s = stmt.trim();
    if (s) await client.exec(s);
  }
  console.log(`  migration applied: ${f}`);
}

const env = loadEnv({
  NODE_ENV: 'development',
  PORT: String(PORT),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  DATABASE_URL: 'postgresql://pglite/in-memory',
  FIREBASE_PROJECT_ID: 'local-dev',
  // Allow any local origin so `npx serve web` on any port can talk to this.
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:3000,http://localhost:4173,http://127.0.0.1:5173',
  DEV_AUTH_BYPASS: DEV_TOKEN,
} as any);

const app = buildApp(db, env);
await app.listen({ port: PORT, host: '127.0.0.1' });

console.log(`
  Life OS v2 API — LOCAL DEV (in-memory database, discarded on exit)

  API        http://localhost:${PORT}
  Health     http://localhost:${PORT}/health

  To point the web shell at it, run this in the browser console once:

    localStorage.setItem('los2_api','http://localhost:${PORT}')
    localStorage.setItem('los2_dev_token','${DEV_TOKEN}')

  Then reload. The shell skips Firebase entirely when a dev token is set and
  the API is on localhost.
`);
