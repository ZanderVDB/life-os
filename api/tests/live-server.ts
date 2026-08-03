/**
 * A real API on a real port, backed by PGlite, for in-browser verification.
 *
 * NOT a test and not shipped: this is the harness that lets the actual UI be
 * driven against the actual routes, so a claim like "completion updates the
 * Completed section" can be demonstrated rather than inferred from source.
 *
 * Same `buildApp` the production entry point uses, same migration SQL, same
 * seed. The only differences are the driver (PGlite instead of postgres-js)
 * and DEV_AUTH_BYPASS, which is already a first-class local-only path in the
 * web client.
 *
 *   npx tsx tests/live-server.ts
 */
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { freshDb } from './helpers.js';
import { seedSampleProjects } from '../src/lib/sample-projects.js';
import { habits, habitEntries } from '../src/db/schema.js';

const TOKEN = 'dev-verify-token';
const PORT = 8080;

const env = loadEnv({
  NODE_ENV: 'test', PORT: String(PORT), LOG_LEVEL: 'warn',
  DATABASE_URL: 'postgresql://unused/unused',
  FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  DEV_AUTH_BYPASS: TOKEN,
} as any);

const { db } = await freshDb();
const app = buildApp(db, env);
await app.ready();

// NO x-dev-email: the browser does not send one either, so this resolves the
// same identity — and therefore the same workspace — that the UI will use.
const auth = { authorization: `Bearer ${TOKEN}` };
const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth })).json();
const ws = me.workspace.id;

await seedSampleProjects(db, ws, new Map(me.areas.map((a: any) => [a.name, a.id])));

/* Habits, so the Calendar history has something to show. Three daily habits
 * and a Monday-only one, with entries scattered across the last fortnight —
 * enough that a month grid shows partial days, complete days and empty ones. */
// Created 60 days ago, deliberately: a habit is only counted as due on days
// after it existed, so a habit created today would produce an empty history
// and hide the very thing being verified.
const born = new Date();
born.setDate(born.getDate() - 60);
const made = await db.insert(habits).values([
  { workspaceId: ws, name: 'Morning walk', frequencyType: 'daily', targetCount: 1, position: 1000, createdAt: born },
  { workspaceId: ws, name: 'Read 20 pages', frequencyType: 'daily', targetCount: 1, position: 2000, createdAt: born },
  { workspaceId: ws, name: 'Water: 3 glasses', frequencyType: 'daily', targetCount: 3, position: 3000, createdAt: born },
  {
    workspaceId: ws, name: 'Weekly review', frequencyType: 'specific_days',
    frequencyConfig: { days: [1] }, targetCount: 1, position: 4000, createdAt: born,
  },
]).returning();

const day = (back: number) => {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const entries: any[] = [];
for (let back = 1; back <= 14; back++) {
  // A deliberately uneven history: some days complete, some partial, some bare.
  if (back % 4 !== 0) {
    entries.push({ workspaceId: ws, habitId: made[0]!.id, entryDate: day(back), completedCount: 1, source: 'user' });
  }
  if (back % 3 === 0) {
    entries.push({ workspaceId: ws, habitId: made[1]!.id, entryDate: day(back), completedCount: 1, source: 'user' });
  }
  if (back % 5 === 0) {
    // Partial: 2 of a target of 3, so "done" must NOT count it.
    entries.push({ workspaceId: ws, habitId: made[2]!.id, entryDate: day(back), completedCount: 2, source: 'user' });
  }
}
if (entries.length) await db.insert(habitEntries).values(entries);

await app.listen({ port: PORT, host: '127.0.0.1' });
// eslint-disable-next-line no-console
console.log(JSON.stringify({ ready: true, port: PORT, token: TOKEN, workspace: ws }));
