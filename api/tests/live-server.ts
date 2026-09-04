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
import { habits, habitEntries, calendars, calendarEvents } from '../src/db/schema.js';

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

/* One writable local calendar and a few events on it. Without these the
 * Calendar page has nothing to render, and no local object can point at an
 * hour. Synthetic and local_only: nothing here ever reaches Google. */
const [localCal] = await db.insert(calendars).values({
  workspaceId: ws, providerCalendarId: 'local:sample', name: 'Life OS',
  color: '#8b7ff5', accessRole: 'owner', isPrimary: true,
  isDefaultTarget: true, isReadOnly: false, isSynthetic: true,
}).returning();

const at = (back: number, hh: number, mins = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - back);
  d.setHours(hh, mins, 0, 0);
  return d;
};
const ev = (title: string, back: number, hh: number, len: number, location?: string) => ({
  workspaceId: ws, calendarId: localCal!.id, title, location: location ?? null,
  isAllDay: false, startsAt: at(back, hh), endsAt: at(back, hh + len),
  syncState: 'local_only' as const, isSynthetic: true,
});
await db.insert(calendarEvents).values([
  ev('Client call — Trifusion', -2, 12, 1, 'Google Meet'),
  ev('Design review', -1, 9, 1),
  ev('Gym', 0, 18, 1),
  ev('Handover walkthrough', -5, 14, 2, 'Their office'),
]);

/* ── The beta, with people in it ──────────────────────────────────────────
 *
 * Admin and the usage screens are unreadable against an empty database — an
 * overview of zero is not a picture of anything, and a user list of one says
 * nothing about how a list of twelve behaves. So this harness seeds a small,
 * realistic beta: a handful of accounts, spread across the states the
 * interface actually has to handle, with usage written as real ledger rows
 * through the real constraints.
 *
 * Not test data pretending to be production data: this file is the local
 * verification harness and is never deployed.
 */
process.env['ADMIN_EMAILS'] = process.env['ADMIN_EMAILS'] ?? 'dev@example.com';
process.env['USD_ZAR_RATE'] = process.env['USD_ZAR_RATE'] ?? '18.20';

const { users: usersTable, workspaces: wsTable, workspaceMemberships: memTable,
  aiUsageEvents: usageTable, adminAuditLog: auditTable } = await import('../src/db/schema.js');
const { updatePolicy, policyFor } = await import('../src/usage/allowance.js');

/* The signed-in account is a beta account like everybody else, and separately
   an admin — the two are different columns for exactly this reason. */
await db.update(usersTable)
  .set({ accountType: 'tester', betaStartAt: at(9, 9), betaEndAt: at(-5, 9) })
  .where((await import('drizzle-orm')).eq(usersTable.id, me.user.id));
await updatePolicy(db, me.user.id, {
  allowanceUsd: 11, periodStart: at(14, 0), periodEnd: null,
});

const PEOPLE = [
  /* The signed-in dev account, so the user-facing usage screens have real
     rows behind them rather than an empty state pretending to be one. */
  { name: 'Dev User', email: 'dev@example.com', type: 'tester', allowance: 11, spentFraction: 0.14, existing: true },
  { name: 'Michelle Botha', email: 'michelle@example.com', type: 'beta', allowance: 11, spentFraction: 0.14 },
  { name: 'Ruan Marais', email: 'ruan@example.com', type: 'beta', allowance: 11, spentFraction: 0.74 },
  { name: 'Thandi Nkosi', email: 'thandi@example.com', type: 'beta', allowance: 11, spentFraction: 0.93 },
  { name: 'Dave Coetzee', email: 'dave@example.com', type: 'beta', allowance: 11, spentFraction: 1.08 },
  { name: 'Aisha Patel', email: 'aisha@example.com', type: 'tester', allowance: 25, spentFraction: 0.31 },
  { name: 'Pieter du Toit', email: 'pieter@example.com', type: 'beta', allowance: 11, spentFraction: 0.02 },
];

const { eq } = await import('drizzle-orm');
const JOBS: [string, string, number][] = [
  ['interpret', 'claude-haiku-4-5', 0.06],
  ['plan', 'claude-sonnet-4-5', 0.62],
  ['answer', 'claude-sonnet-4-5', 0.26],
  ['extractMemory', 'claude-haiku-4-5', 0.06],
];

const { eq: eqCol } = await import('drizzle-orm');
for (const person of PEOPLE as any[]) {
  let u; let pw;
  if (person.existing) {
    u = (await db.select().from(usersTable).where(eqCol(usersTable.email, person.email)))[0];
    pw = { id: ws };
  } else {
    [u] = await db.insert(usersTable).values({
      email: person.email, displayName: person.name,
      accountType: person.type, betaStartAt: at(9, 9), betaEndAt: at(-5, 9),
      lastActiveAt: at(Math.floor(Math.random() * 3), 14),
    } as any).returning();
    [pw] = await db.insert(wsTable).values({
      ownerUserId: u!.id, name: person.name.split(' ')[0]!,
    }).returning();
    await db.insert(memTable).values({ workspaceId: pw!.id, userId: u!.id });
  }
  await policyFor(db, u!.id, pw!.id);
  /* The period covers the fortnight the seeded usage sits in. Without this
     the policy starts at the account's creation — a second ago — and every
     seeded row falls outside the window, which is correct behaviour and
     useless data. */
  await updatePolicy(db, u!.id, {
    allowanceUsd: person.allowance, periodStart: at(14, 0), periodEnd: null,
  });

  /* Spread over the fortnight, and split across the four jobs in roughly the
     proportion a real turn does — so "where did it go" is a shape somebody
     would actually see rather than four equal quarters. */
  const total = person.allowance * person.spentFraction;
  let n = 0;
  for (let daysAgo = 13; daysAgo >= 0; daysAgo -= 1) {
    for (const [job, model, share] of JOBS) {
      /* Days are NOT equal. A flat fortnight draws a solid block rather than
         a chart, and hides the one thing a spend graph is for: the day that
         was different from the others. */
      const shape = [0.5, 0.8, 1.4, 0.9, 1.7, 0.6, 0.3, 1.1, 1.9, 0.7, 1.2, 0.4, 1.5, 1.0];
      const usd = ((total * share) / 14) * (shape[daysAgo % shape.length] ?? 1);
      if (usd <= 0) continue;
      n += 1;
      await db.insert(usageTable).values({
        workspaceId: pw!.id, userId: u!.id,
        provider: 'anthropic', model, job,
        requestKey: `seed-${u!.id}-${daysAgo}-${job}`,
        pricingVersion: 'anthropic-2026-06',
        pricingSnapshot: { seeded: true },
        inputTokens: Math.round(usd * 300000),
        outputTokens: Math.round(usd * 12000),
        providerCostUsd: usd.toFixed(10),
        billableCostUsd: usd.toFixed(10),
        fxRateUsdZar: '18.2000000000',
        providerCostZar: (usd * 18.2).toFixed(10),
        billableCostZar: (usd * 18.2).toFixed(10),
        latencyMs: 400 + Math.round(Math.random() * 2600),
        createdAt: at(daysAgo, 9 + (n % 9)),
      });
    }
  }
  /* One failure each, so the "charged nothing" column is not always empty. */
  await db.insert(usageTable).values({
    workspaceId: pw!.id, userId: u!.id,
    provider: 'anthropic', model: 'claude-sonnet-4-5', job: 'plan',
    requestKey: `seed-fail-${u!.id}`, pricingVersion: 'not-charged',
    status: 'failed', errorType: 'rate_limit', latencyMs: 210,
    createdAt: at(2, 16),
  });
}

/* One earlier admin change, so the audit view is not empty on first look. */
const dave = (await db.select().from(usersTable).where(eq(usersTable.email, 'dave@example.com')))[0];
if (dave) {
  await db.insert(auditTable).values({
    actorUserId: me.user.id, actorEmail: me.user.email,
    targetUserId: dave.id, targetEmail: dave.email,
    action: 'user.update',
    before: { allowanceUsd: 5 }, after: { allowanceUsd: 11 },
    createdAt: at(4, 11),
  });
}

await app.listen({ port: PORT, host: '127.0.0.1' });
// eslint-disable-next-line no-console
console.log(JSON.stringify({ ready: true, port: PORT, token: TOKEN, workspace: ws }));
