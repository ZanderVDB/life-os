/**
 * Admin — Phases 3 and 5.
 *
 * ── The tests that matter most ───────────────────────────────────────────
 *
 * Not the ones proving an admin can change an allowance. The ones proving a
 * NORMAL user cannot — by calling the API directly, by knowing a user id, by
 * setting a flag in a body, or by any of the other things that work when
 * authorisation is decided in a browser.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { adminAllowlist, adminIdentity, ADMIN_SETUP } from '../src/admin/authz.js';
import { allowanceState, updatePolicy } from '../src/usage/allowance.js';
import {
  users, aiUsageEvents, adminAuditLog, aiUsagePolicies,
} from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DEV_AUTH_BYPASS: TOKEN,
} as any);

const as = (email: string) => ({ authorization: `Bearer ${TOKEN}`, 'x-dev-email': email });
const BOSS = 'zander@example.com';
const TESTER = 'friend@example.com';

afterEach(() => { delete process.env['ADMIN_EMAILS']; });

async function twoPeople() {
  const { db } = await freshDb();
  const app = buildApp(db, env);
  /* Both sign in, which is what provisions them. */
  const bossMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: as(BOSS) });
  const testerMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: as(TESTER) });
  return {
    db, app,
    boss: bossMe.json(),
    tester: testerMe.json(),
  };
}

/* ══ 3A/3B — who is an admin, and how they became one ════════════════════ */

test('admin: with nothing configured, nobody is an admin', () => {
  assert.equal(adminAllowlist({} as any).size, 0);
  assert.equal(adminIdentity({ id: 'u', email: BOSS, role: 'user' }, {} as any).isAdmin, false);
});

test('admin: the bootstrap allowlist is read live, so removing an address revokes', () => {
  const withIt = { ADMIN_EMAILS: ` ${BOSS.toUpperCase()} , other@example.com ` } as any;
  const who = adminIdentity({ id: 'u', email: BOSS, role: 'user' }, withIt);
  assert.equal(who.isAdmin, true);
  assert.equal(who.viaAllowlist, true, 'a configuration grant is not marked as one');
  /* And with the variable gone the access is gone — because it was never
     copied into the database, which is the whole reason it is read live. */
  assert.equal(adminIdentity({ id: 'u', email: BOSS, role: 'user' }, {} as any).isAdmin, false);
});

test('admin: an explicit promotion is a column, not configuration', () => {
  const who = adminIdentity({ id: 'u', email: 'someone@example.com', role: 'admin' }, {} as any);
  assert.equal(who.isAdmin, true);
  assert.equal(who.viaAllowlist, false);
});

test('admin: role and account type are separate ideas', async () => {
  const o = await twoPeople();
  process.env['ADMIN_EMAILS'] = BOSS;
  const me = await o.app.inject({ method: 'GET', url: '/api/v1/me', headers: as(BOSS) });
  const acct = me.json().account;
  assert.equal(acct.isAdmin, true);
  /* Being an admin did NOT make them something other than a beta account. A
     plan must never be able to grant administrative access, and the only way
     to guarantee that is for them not to be the same field. */
  assert.equal(acct.accountType, 'beta');
  assert.equal(acct.role, 'user', 'the bootstrap wrote itself into the database');
  await o.app.close();
});

test('admin: the one manual value is reported rather than guessed at', () => {
  assert.equal(ADMIN_SETUP.variable, 'ADMIN_EMAILS');
  assert.match(ADMIN_SETUP.note, /no\s+default/i);
});

/* ══ 3C — the guard ══════════════════════════════════════════════════════ */

test('SECURITY: a normal user gets 403 from every admin endpoint', async () => {
  const o = await twoPeople();
  process.env['ADMIN_EMAILS'] = BOSS;

  const attempts: [string, string, any?][] = [
    ['GET', '/api/v1/admin/overview'],
    ['GET', '/api/v1/admin/users'],
    ['GET', `/api/v1/admin/users/${o.boss.user.id}`],
    ['GET', '/api/v1/admin/audit'],
    ['GET', '/api/v1/admin/spend'],
    ['PATCH', `/api/v1/admin/users/${o.tester.user.id}`, { allowanceUsd: 9999 }],
    ['POST', `/api/v1/admin/users/${o.tester.user.id}/credit`,
      { amountUsd: 500, reason: 'giving myself money' }],
    ['POST', `/api/v1/admin/users/${o.tester.user.id}/new-period`, {}],
  ];
  for (const [method, url, payload] of attempts) {
    const r = await o.app.inject({
      method: method as any, url, headers: as(TESTER),
      ...(payload ? { payload } : {}),
    });
    assert.equal(r.statusCode, 403, `${method} ${url} returned ${r.statusCode}`);
    /* And nothing useful comes back with the refusal. Telling somebody why
       they were refused is telling them what exists. */
    const body = r.body;
    assert.doesNotMatch(body, /allowance|usd|email|usage/i, `${url} leaked detail`);
  }
  await o.app.close();
});

test('SECURITY: a user cannot raise their own allowance through a normal route', async () => {
  const o = await twoPeople();
  const before = await allowanceState(o.db, o.tester.user.id);

  /* Every plausible attempt: the AI usage endpoint, the turn endpoint, the
     preferences endpoint. None of them accepts an allowance, and a body that
     tries is either ignored or refused — never obeyed. */
  const tries = [
    ['GET', `/api/v1/workspaces/${o.tester.workspace.id}/ai/usage`, { allowanceUsd: 9999 }],
    ['POST', `/api/v1/workspaces/${o.tester.workspace.id}/ai/turn`,
      { text: 'hi', allowanceUsd: 9999, today: '2026-09-04' }],
    ['PUT', '/api/v1/preferences', { allowanceUsd: 9999, role: 'admin' }],
  ] as const;
  for (const [method, url, payload] of tries) {
    await o.app.inject({ method: method as any, url, headers: as(TESTER), payload });
  }
  const after = await allowanceState(o.db, o.tester.user.id);
  assert.equal(after.allowanceUsd, before.allowanceUsd);
  assert.equal(after.aiEnabled, before.aiEnabled);

  /* And they are still not an admin. */
  const me = await o.app.inject({ method: 'GET', url: '/api/v1/me', headers: as(TESTER) });
  assert.equal(me.json().account.isAdmin, false);
  assert.equal(me.json().account.role, 'user');
  await o.app.close();
});

test('SECURITY: a user cannot read another user’s usage', async () => {
  const o = await twoPeople();
  /* The usage route takes no user id — the id comes from the verified token.
     Asking for somebody else's workspace is refused by the workspace guard. */
  const r = await o.app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${o.boss.workspace.id}/ai/usage`,
    headers: as(TESTER),
  });
  assert.equal(r.statusCode, 403);
  await o.app.close();
});

/* ══ 3E/3F — what an admin sees ══════════════════════════════════════════ */

test('admin overview is built from the ledger, not from analytics', async () => {
  const o = await twoPeople();
  process.env['ADMIN_EMAILS'] = BOSS;
  await o.db.insert(aiUsageEvents).values({
    workspaceId: o.tester.workspace.id, userId: o.tester.user.id,
    provider: 'anthropic', model: 'claude-haiku-4-5', job: 'plan',
    requestKey: 'k-overview-1', pricingVersion: 'test',
    inputTokens: 2_000_000,
    providerCostUsd: '2.0000000000', billableCostUsd: '2.0000000000',
  });

  const r = await o.app.inject({
    method: 'GET', url: '/api/v1/admin/overview', headers: as(BOSS),
  });
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(b.users.total, 2);
  assert.equal(b.spend.allTime.usd, 2);
  assert.equal(b.activity.providerCallsAllTime, 1);
  assert.equal(b.tokens.input, 2_000_000);
  /* The manual steps still outstanding are reported, not hidden. */
  assert.equal(b.config.adminSetup.variable, 'ADMIN_EMAILS');
  assert.ok(b.config.overshoot.perCallUsd > 0);
  await o.app.close();
});

test('SECURITY: admin never shows a secret', async () => {
  const o = await twoPeople();
  process.env['ADMIN_EMAILS'] = BOSS;
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-super-secret-value';
  try {
    for (const url of ['/api/v1/admin/overview', '/api/v1/admin/users',
      `/api/v1/admin/users/${o.tester.user.id}`, '/api/v1/admin/audit']) {
      const r = await o.app.inject({ method: 'GET', url, headers: as(BOSS) });
      const body = r.body;
      assert.doesNotMatch(body, /sk-ant-/, `${url} leaked the API key`);
      assert.doesNotMatch(body, /ANTHROPIC_API_KEY/, `${url} named the key variable`);
      assert.doesNotMatch(body, /postgres(ql)?:\/\//, `${url} leaked a database URL`);
      assert.doesNotMatch(body, /refresh_token|access_token/i, `${url} leaked a token`);
    }
  } finally {
    delete process.env['ANTHROPIC_API_KEY'];
  }
  await o.app.close();
});

/* ══ 3G — the audit log ══════════════════════════════════════════════════ */

test('every admin mutation is audited, with before and after', async () => {
  const o = await twoPeople();
  process.env['ADMIN_EMAILS'] = BOSS;
  await updatePolicy(o.db, o.tester.user.id, { allowanceUsd: 5 });

  const r = await o.app.inject({
    method: 'PATCH', url: `/api/v1/admin/users/${o.tester.user.id}`, headers: as(BOSS),
    payload: { allowanceUsd: 20, accountType: 'tester' },
  });
  assert.equal(r.statusCode, 200, r.body);

  const [entry] = await o.db.select().from(adminAuditLog);
  assert.ok(entry, 'a powerful mutation left no trace');
  assert.equal(entry!.action, 'user.update');
  assert.equal(entry!.actorEmail, BOSS);
  assert.equal(entry!.targetEmail, TESTER);
  assert.equal((entry!.before as any).allowanceUsd, 5);
  assert.equal((entry!.after as any).allowanceUsd, 20);
  assert.equal((entry!.before as any).accountType, 'beta');
  assert.equal((entry!.after as any).accountType, 'tester');
  /* Only what changed. An entry listing forty unchanged fields says nothing. */
  assert.equal((entry!.after as any).role, undefined);
  await o.app.close();
});

test('a credit is audited and leaves usage history untouched', async () => {
  const o = await twoPeople();
  process.env['ADMIN_EMAILS'] = BOSS;
  await o.db.insert(aiUsageEvents).values({
    workspaceId: o.tester.workspace.id, userId: o.tester.user.id,
    provider: 'anthropic', model: 'claude-haiku-4-5', job: 'plan',
    requestKey: 'k-credit-1', pricingVersion: 'test',
    providerCostUsd: '1.0000000000', billableCostUsd: '1.0000000000',
  });
  const before = await o.db.select().from(aiUsageEvents);

  const r = await o.app.inject({
    method: 'POST', url: `/api/v1/admin/users/${o.tester.user.id}/credit`,
    headers: as(BOSS), payload: { amountUsd: 15, reason: 'Extended their beta' },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().allowance.adjustmentsUsd, 15);

  const after = await o.db.select().from(aiUsageEvents);
  assert.equal(after.length, before.length, 'a credit rewrote usage history');
  const entries = await o.db.select().from(adminAuditLog);
  assert.ok(entries.some((e: any) => e.action === 'user.credit'));
  await o.app.close();
});

test('starting a new period preserves every usage row', async () => {
  const o = await twoPeople();
  process.env['ADMIN_EMAILS'] = BOSS;
  for (let i = 0; i < 3; i += 1) {
    await o.db.insert(aiUsageEvents).values({
      workspaceId: o.tester.workspace.id, userId: o.tester.user.id,
      provider: 'anthropic', model: 'claude-haiku-4-5', job: 'plan',
      requestKey: `k-period-${i}`, pricingVersion: 'test',
      providerCostUsd: '1.0000000000', billableCostUsd: '1.0000000000',
    });
  }
  const r = await o.app.inject({
    method: 'POST', url: `/api/v1/admin/users/${o.tester.user.id}/new-period`,
    headers: as(BOSS), payload: { allowanceUsd: 30 },
  });
  assert.equal(r.statusCode, 200, r.body);
  /* The window moved, so nothing counts against the new period... */
  assert.equal(r.json().allowance.usedUsd, 0);
  assert.equal(r.json().allowance.allowanceUsd, 30);
  /* ...and every row is still there, which is what makes the first fact
     recoverable rather than a story. */
  const rows = await o.db.select().from(aiUsageEvents);
  assert.equal(rows.length, 3);
  await o.app.close();
});

/* ══ 3F/5B — the controls ════════════════════════════════════════════════ */

test('admin can shape a beta account without touching what it has spent', async () => {
  const o = await twoPeople();
  process.env['ADMIN_EMAILS'] = BOSS;
  await o.db.insert(aiUsageEvents).values({
    workspaceId: o.tester.workspace.id, userId: o.tester.user.id,
    provider: 'anthropic', model: 'claude-haiku-4-5', job: 'plan',
    requestKey: 'k-shape-1', pricingVersion: 'test',
    providerCostUsd: '0.5000000000', billableCostUsd: '0.5000000000',
  });

  const r = await o.app.inject({
    method: 'PATCH', url: `/api/v1/admin/users/${o.tester.user.id}`, headers: as(BOSS),
    payload: {
      accountType: 'tester',
      aiEnabled: false,
      allowanceUsd: 40,
      betaStartAt: '2026-09-02T00:00:00.000Z',
      betaEndAt: '2026-09-16T00:00:00.000Z',
      adminNote: 'Client — watch the calendar sync',
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  const [u] = await o.db.select().from(users).where(eq(users.id, o.tester.user.id));
  assert.equal(u!.accountType, 'tester');
  assert.equal(u!.adminNote, 'Client — watch the calendar sync');
  assert.ok(u!.betaEndAt);

  const state = await allowanceState(o.db, o.tester.user.id);
  assert.equal(state.aiEnabled, false);
  assert.equal(state.status, 'disabled');
  assert.equal(state.allowanceUsd, 40);
  assert.equal(state.usedUsd, 0.5, 'shaping the account changed what it had spent');
  await o.app.close();
});

test('an admin cannot lock themselves out', async () => {
  const o = await twoPeople();
  process.env['ADMIN_EMAILS'] = BOSS;
  /* Promote for real, then try to demote self. */
  await o.db.update(users).set({ role: 'admin' }).where(eq(users.id, o.boss.user.id));
  const r = await o.app.inject({
    method: 'PATCH', url: `/api/v1/admin/users/${o.boss.user.id}`, headers: as(BOSS),
    payload: { role: 'user' },
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /your own admin access/);
  await o.app.close();
});

test('admin user detail shows the job-by-job breakdown of what was spent', async () => {
  const o = await twoPeople();
  process.env['ADMIN_EMAILS'] = BOSS;
  const jobs: [string, string][] = [
    ['interpret', '0.0200000000'], ['plan', '0.0900000000'],
    ['answer', '0.2100000000'], ['extractMemory', '0.0200000000'],
  ];
  for (const [job, usd] of jobs) {
    await o.db.insert(aiUsageEvents).values({
      workspaceId: o.tester.workspace.id, userId: o.tester.user.id,
      provider: 'anthropic', model: 'claude-haiku-4-5', job,
      requestKey: `k-${job}`, pricingVersion: 'test',
      providerCostUsd: usd, billableCostUsd: usd,
    });
  }
  const r = await o.app.inject({
    method: 'GET', url: `/api/v1/admin/users/${o.tester.user.id}`, headers: as(BOSS),
  });
  const b = r.json();
  assert.equal(b.usage.calls, 4);
  assert.ok(Math.abs(b.usage.billableCostUsd - 0.34) < 1e-9, `total ${b.usage.billableCostUsd}`);
  /* Dearest first, which is the order somebody actually reads it in. The two
     cheapest cost the same, so their order between themselves is not a fact
     worth asserting. */
  assert.deepEqual(b.usage.byJob.slice(0, 2).map((j: any) => j.job), ['answer', 'plan']);
  assert.deepEqual(b.usage.byJob.slice(2).map((j: any) => j.job).sort(),
    ['extractMemory', 'interpret']);
  await o.app.close();
});

/* ══ Beta acknowledgement ════════════════════════════════════════════════ */

test('the beta acknowledgement is server-held, forward-only and idempotent', async () => {
  const o = await twoPeople();
  const first = await o.app.inject({
    method: 'GET', url: '/api/v1/me', headers: as(TESTER),
  });
  assert.equal(first.json().account.introRequired, true);

  const ack = await o.app.inject({
    method: 'POST', url: '/api/v1/me/intro-accepted', headers: as(TESTER),
  });
  assert.equal(ack.json().changed, true);
  const at = ack.json().introAcceptedAt;

  /* A double tap must not rewrite when somebody agreed. */
  const again = await o.app.inject({
    method: 'POST', url: '/api/v1/me/intro-accepted', headers: as(TESTER),
  });
  assert.equal(again.json().changed, false);
  assert.equal(again.json().introAcceptedAt, at);

  const after = await o.app.inject({ method: 'GET', url: '/api/v1/me', headers: as(TESTER) });
  assert.equal(after.json().account.introRequired, false);
  /* And it survives a new device, because it was never in the browser. */
  await o.app.close();
});

test('SECURITY: acknowledging the beta cannot grant anything', async () => {
  const o = await twoPeople();
  const r = await o.app.inject({
    method: 'POST', url: '/api/v1/me/intro-accepted', headers: as(TESTER),
    payload: { role: 'admin', accountType: 'standard', allowanceUsd: 9999 },
  });
  assert.equal(r.statusCode, 200);
  const [u] = await o.db.select().from(users).where(eq(users.id, o.tester.user.id));
  assert.equal(u!.role, 'user');
  assert.equal(u!.accountType, 'beta');
  const [policy] = await o.db.select().from(aiUsagePolicies)
    .where(eq(aiUsagePolicies.userId, o.tester.user.id));
  assert.notEqual(Number(policy?.allowanceUsd ?? 0), 9999);
  await o.app.close();
});
