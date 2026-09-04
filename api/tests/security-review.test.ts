/**
 * The pre-beta security review, as ten tests rather than ten claims.
 *
 * Each one is numbered to the review it answers. A review that lives in a
 * report is true on the day it is written; this one fails a build.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { allowanceState, updatePolicy } from '../src/usage/allowance.js';
import {
  users, aiUsageEvents, adminAuditLog, aiUsagePolicies, aiUsageAdjustments,
} from '../src/db/schema.js';

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DEV_AUTH_BYPASS: TOKEN,
} as any);
const as = (email: string) => ({ authorization: `Bearer ${TOKEN}`, 'x-dev-email': email });
const BOSS = 'zander@example.com';
const USER = 'friend@example.com';

afterEach(() => { delete process.env['ADMIN_EMAILS']; });

async function two() {
  const { db } = await freshDb();
  const app = buildApp(db, env);
  const boss = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: as(BOSS) })).json();
  const user = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: as(USER) })).json();
  return { db, app, boss, user };
}

const src = (p: string) => readFileSync(join('..', p), 'utf8');
const webFiles = () => readdirSync(join('..', 'web'))
  .filter((f) => f.endsWith('.js') || f.endsWith('.html') || f.endsWith('.css'));

/* ══ 1. API keys are server-only ═════════════════════════════════════════ */

test('SEC-1: no client file reads a provider key, and none is ever sent to one', () => {
  for (const f of webFiles()) {
    const text = src(join('web', f));
    assert.doesNotMatch(text, /ANTHROPIC_API_KEY/, `${f} names the provider key`);
    assert.doesNotMatch(text, /sk-ant-/, `${f} contains something shaped like a key`);
    assert.doesNotMatch(text, /api\.anthropic\.com/, `${f} talks to the provider directly`);
  }
  /* And the server never puts one in a response. The one file that reads the
     key is the vendor adapter, which returns strings. */
  const routes = readdirSync(join('..', 'api', 'src', 'routes'))
    .map((f) => src(join('api', 'src', 'routes', f))).join('\n');
  assert.doesNotMatch(routes, /ANTHROPIC_API_KEY/, 'a route reads the provider key');
  assert.doesNotMatch(routes, /DATABASE_URL/, 'a route reads the database URL');
});

/* ══ 2. Usage cannot be forged by the client ═════════════════════════════ */

test('SEC-2: there is no route through which a client can write usage', async () => {
  const o = await two();
  const before = await o.db.select().from(aiUsageEvents);

  /* Everything a client could plausibly try. None of these endpoints accepts
     usage, and none of them is supposed to. */
  const attempts: [string, string, any][] = [
    ['POST', `/api/v1/workspaces/${o.user.workspace.id}/ai/usage`, { billableCostUsd: -100 }],
    ['PUT', `/api/v1/workspaces/${o.user.workspace.id}/ai/usage`, { usedUsd: 0 }],
    ['POST', '/api/v1/usage', { inputTokens: 1 }],
    ['POST', '/api/v1/ai-usage-events', { inputTokens: 1 }],
    ['PATCH', `/api/v1/workspaces/${o.user.workspace.id}/ai/usage`, { usedUsd: 0 }],
  ];
  for (const [method, url, payload] of attempts) {
    const r = await o.app.inject({ method: method as any, url, headers: as(USER), payload });
    assert.ok(r.statusCode >= 400, `${method} ${url} was accepted`);
  }
  const after = await o.db.select().from(aiUsageEvents);
  assert.equal(after.length, before.length, 'a client wrote a usage row');

  /* Structurally: usage is written from exactly one function, and it is not
     reachable from a route handler with client-supplied numbers. */
  const ledger = src(join('api', 'src', 'usage', 'ledger.ts'));
  assert.match(ledger, /export async function recordUsage\(\s*db: Db, scope: MeterScope, call: CallRecord,/,
    'recordUsage takes something other than a meter scope and a recorded call');
  await o.app.close();
});

/* ══ 3. A user cannot edit their own allowance ═══════════════════════════ */

test('SEC-3: no normal-user route changes a policy', async () => {
  const o = await two();
  const before = await allowanceState(o.db, o.user.user.id);

  for (const [method, url, payload] of [
    ['PUT', '/api/v1/preferences', { allowanceUsd: 9999, aiEnabled: true, role: 'admin' }],
    ['POST', `/api/v1/workspaces/${o.user.workspace.id}/ai/turn`,
      { text: 'hi', today: '2026-09-04', allowanceUsd: 9999 }],
    ['POST', '/api/v1/me/intro-accepted', { allowanceUsd: 9999 }],
    ['PATCH', `/api/v1/admin/users/${o.user.user.id}`, { allowanceUsd: 9999 }],
    ['POST', `/api/v1/admin/users/${o.user.user.id}/credit`,
      { amountUsd: 9999, reason: 'me' }],
  ] as const) {
    await o.app.inject({ method: method as any, url, headers: as(USER), payload });
  }
  const after = await allowanceState(o.db, o.user.user.id);
  assert.equal(after.allowanceUsd, before.allowanceUsd);
  assert.equal(after.adjustmentsUsd, 0);
  assert.equal(after.aiEnabled, before.aiEnabled);

  /* And the only writer is behind the admin guard. */
  const admin = src(join('api', 'src', 'routes', 'admin.ts'));
  const other = readdirSync(join('..', 'api', 'src', 'routes'))
    .filter((f) => f !== 'admin.ts')
    .map((f) => src(join('api', 'src', 'routes', f))).join('\n');
  assert.match(admin, /updatePolicy\(/, 'admin cannot change a policy at all');
  assert.doesNotMatch(other, /updatePolicy\(/, 'a non-admin route changes a policy');
  assert.doesNotMatch(other, /aiUsageAdjustments/, 'a non-admin route grants a credit');
  await o.app.close();
});

/* ══ 4. Admin routes require server authorisation ════════════════════════ */

test('SEC-4: every admin route runs the guard, and refuses without it', async () => {
  const o = await two();
  process.env['ADMIN_EMAILS'] = BOSS;

  const admin = src(join('api', 'src', 'routes', 'admin.ts'));
  /* One `pre`, built from the guard, used by every route in the file. */
  assert.match(admin, /const pre = \{ preHandler: \[guards\.authenticate, requireAdmin\] \}/);
  const routes = [...admin.matchAll(/app\.(get|post|patch|put|delete)\(`\$\{base\}[^`]*`,\s*([a-zA-Z]+)/g)];
  assert.ok(routes.length >= 6, `only ${routes.length} admin routes found`);
  for (const m of routes) {
    assert.equal(m[2], 'pre', `an admin route uses ${m[2]} instead of the guard`);
  }

  /* And behaviourally, for a signed-in non-admin and for no session at all. */
  for (const headers of [as(USER), {}]) {
    const r = await o.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers });
    assert.ok([401, 403].includes(r.statusCode), `got ${r.statusCode}`);
  }
  const ok = await o.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: as(BOSS) });
  assert.equal(ok.statusCode, 200);
  await o.app.close();
});

/* ══ 5. A user cannot read another user's usage ══════════════════════════ */

test('SEC-5: the usage route takes no user id, and another workspace is refused', async () => {
  const o = await two();
  const ai = src(join('api', 'src', 'routes', 'ai.ts'));
  const usage = ai.slice(ai.indexOf('/ai/usage`'), ai.indexOf('/ai/usage`') + 320);
  /* The id comes from the verified token. There is no parameter for it. */
  assert.match(usage, /const \{ userId, workspaceId \} = owner\(req\);/);
  assert.doesNotMatch(usage, /req\.query|req\.body|params\.userId/);

  const r = await o.app.inject({
    method: 'GET', url: `/api/v1/workspaces/${o.boss.workspace.id}/ai/usage`, headers: as(USER),
  });
  assert.equal(r.statusCode, 403);
  /* Their own works, and returns their own numbers. */
  const own = await o.app.inject({
    method: 'GET', url: `/api/v1/workspaces/${o.user.workspace.id}/ai/usage`, headers: as(USER),
  });
  assert.equal(own.statusCode, 200);
  await o.app.close();
});

/* ══ 6. Admin mutations are audited ══════════════════════════════════════ */

test('SEC-6: every admin mutation writes an audit row', async () => {
  const o = await two();
  process.env['ADMIN_EMAILS'] = BOSS;
  const target = o.user.user.id;

  await o.app.inject({
    method: 'PATCH', url: `/api/v1/admin/users/${target}`, headers: as(BOSS),
    payload: { accountType: 'tester', allowanceUsd: 20 },
  });
  await o.app.inject({
    method: 'POST', url: `/api/v1/admin/users/${target}/credit`, headers: as(BOSS),
    payload: { amountUsd: 3, reason: 'testing' },
  });
  await o.app.inject({
    method: 'POST', url: `/api/v1/admin/users/${target}/new-period`, headers: as(BOSS),
    payload: {},
  });

  const rows = await o.db.select().from(adminAuditLog);
  assert.deepEqual(rows.map((r: any) => r.action).sort(),
    ['user.credit', 'user.new-period', 'user.update']);
  for (const r of rows as any[]) {
    assert.equal(r.actorEmail, BOSS, 'an entry does not name the actor');
    assert.equal(r.targetEmail, USER, 'an entry does not name the target');
    assert.ok(Object.keys(r.after).length, 'an entry records no "after"');
  }

  /* Structurally: every mutating route in the file records one. */
  const admin = src(join('api', 'src', 'routes', 'admin.ts'));
  const mutating = [...admin.matchAll(/app\.(post|patch|put|delete)\(`\$\{base\}([^`]*)`/g)];
  assert.equal(mutating.length,
    (admin.match(/recordAdminAction\(db, \{/g) ?? []).length,
    'a mutating admin route leaves no trace');
  await o.app.close();
});

/* ══ 7. Limits are enforced server-side ══════════════════════════════════ */

test('SEC-7: the limit is checked by the server before any provider work', async () => {
  const o = await two();
  await updatePolicy(o.db, o.user.user.id, { allowanceUsd: 0 });

  const ai = src(join('api', 'src', 'routes', 'ai.ts'));
  const turn = ai.slice(ai.indexOf("app.post(`${base}/ai/turn`"), ai.indexOf('/** Read a turn back'));
  /* Before `runTurn`, not after, and not conditional on anything the client
     sent. */
  assert.ok(turn.indexOf('assertCanUseAi') < turn.indexOf('runTurn('),
    'the allowance is checked after the model has been asked');
  assert.match(turn, /await assertCanUseAi\(db, request\.userId/);

  const r = await o.app.inject({
    method: 'POST', url: `/api/v1/workspaces/${o.user.workspace.id}/ai/turn`,
    headers: as(USER), payload: { text: 'hello', today: '2026-09-04' },
  });
  assert.equal(r.statusCode, 402);
  assert.equal(r.json().error.code, 'AI_ALLOWANCE_EXCEEDED');
  await o.app.close();
});

/* ══ 8. Usage is append-only ═════════════════════════════════════════════ */

test('SEC-8: nothing updates or deletes a usage event', async () => {
  const o = await two();
  process.env['ADMIN_EMAILS'] = BOSS;

  /* Structurally, across the whole server: no update and no delete against
     the ledger table, anywhere. */
  const dirs = ['api/src/routes', 'api/src/usage', 'api/src/admin', 'api/src/ai'];
  for (const dir of dirs) {
    for (const f of readdirSync(join('..', dir))) {
      if (!f.endsWith('.ts')) continue;
      const text = src(join(dir, f));
      assert.doesNotMatch(text, /update\(aiUsageEvents\)/, `${dir}/${f} updates the ledger`);
      assert.doesNotMatch(text, /delete\(aiUsageEvents\)/, `${dir}/${f} deletes from the ledger`);
    }
  }

  /* Behaviourally: the most destructive-sounding admin action preserves every
     row, and corrections happen as adjustments instead. */
  for (let i = 0; i < 4; i += 1) {
    await o.db.insert(aiUsageEvents).values({
      workspaceId: o.user.workspace.id, userId: o.user.user.id,
      provider: 'anthropic', model: 'claude-haiku-4-5', job: 'plan',
      requestKey: `sec8-${i}`, pricingVersion: 'test',
      providerCostUsd: '1.0000000000', billableCostUsd: '1.0000000000',
    });
  }
  await o.app.inject({
    method: 'POST', url: `/api/v1/admin/users/${o.user.user.id}/new-period`,
    headers: as(BOSS), payload: { allowanceUsd: 50 },
  });
  await o.app.inject({
    method: 'PATCH', url: `/api/v1/admin/users/${o.user.user.id}`,
    headers: as(BOSS), payload: { allowanceUsd: 1, accountType: 'standard', aiEnabled: false },
  });
  assert.equal((await o.db.select().from(aiUsageEvents)).length, 4);

  /* And the accounting mechanism that IS allowed leaves its own record. */
  await o.app.inject({
    method: 'POST', url: `/api/v1/admin/users/${o.user.user.id}/credit`,
    headers: as(BOSS), payload: { amountUsd: -2, reason: 'Correcting a double charge' },
  });
  const adj = await o.db.select().from(aiUsageAdjustments);
  assert.equal(adj.length, 1);
  assert.equal(Number(adj[0]!.amountUsd), -2);
  assert.equal((await o.db.select().from(aiUsageEvents)).length, 4);
  await o.app.close();
});

/* ══ 9. Feedback metadata carries no secrets ═════════════════════════════ */

test('SEC-9: the feedback payload is five known fields and nothing else', async () => {
  const fb = await import(
    `file://${join(process.cwd(), '..', 'web', 'feedback.js')}?t=${Math.random()}`
  ) as any;
  (globalThis as any).window = {
    LIFE_OS_BUILD: 'abc123',
    LIFE_OS_CONFIG: {
      beta: { supportEmail: 'z@example.com' },
      apiBaseUrl: 'https://api.example.com',
      firebase: { apiKey: 'AIza-SECRET-LOOKING-VALUE' },
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 Chrome/140' }, configurable: true, writable: true,
  });
  const body = decodeURIComponent(fb.mailHref('diary'));
  for (const forbidden of ['AIza-SECRET', 'apiKey', 'firebase', 'api.example.com',
    'dev-verify-token', 'Bearer']) {
    assert.ok(!body.includes(forbidden), `the feedback body contains ${forbidden}`);
  }
  assert.equal(fb.technicalDetails('diary').split('\n').length, 5);
  delete (globalThis as any).window;
});

/* ══ 10. Nothing about the beta can grant admin ══════════════════════════ */

test('SEC-10: neither the introduction nor an account type can make an admin', async () => {
  const o = await two();
  const target = o.user.user.id;

  /* Acknowledging the introduction, with every hostile field attached. */
  await o.app.inject({
    method: 'POST', url: '/api/v1/me/intro-accepted', headers: as(USER),
    payload: { role: 'admin', isAdmin: true, accountType: 'standard', admin: true },
  });
  /* And the one admin field a client might hope is writable. */
  await o.app.inject({
    method: 'PUT', url: '/api/v1/preferences', headers: as(USER),
    payload: { role: 'admin', accountType: 'tester' },
  });

  const [row] = await o.db.select().from(users).where(eq(users.id, target));
  assert.equal(row!.role, 'user');
  assert.equal(row!.accountType, 'beta');

  const me = await o.app.inject({ method: 'GET', url: '/api/v1/me', headers: as(USER) });
  assert.equal(me.json().account.isAdmin, false);
  const admin = await o.app.inject({
    method: 'GET', url: '/api/v1/admin/overview', headers: as(USER),
  });
  assert.equal(admin.statusCode, 403);

  /* Structurally: `role` is written in exactly one place, and it is behind the
     admin guard. An account TYPE cannot reach it — they are different columns
     precisely so a future paid plan cannot grant administrative access. */
  const dirs = ['api/src/routes', 'api/src/lib', 'api/src/auth', 'api/src/admin'];
  const writers: string[] = [];
  for (const dir of dirs) {
    for (const f of readdirSync(join('..', dir))) {
      if (!f.endsWith('.ts')) continue;
      if (/userSet\['role'\]|set\(\{[^}]*role:/s.test(src(join(dir, f)))) writers.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(writers, ['api/src/routes/admin.ts'],
    `role is written outside admin: ${writers.join(', ')}`);

  /* And the policy table has no column that could carry a role. */
  const schema = src(join('api', 'src', 'db', 'schema.ts'));
  const policy = schema.slice(schema.indexOf("pgTable('ai_usage_policies'"),
    schema.indexOf("pgTable('ai_usage_adjustments'"));
  assert.doesNotMatch(policy, /role|isAdmin|admin/i, 'a policy can carry a role');
  assert.match(policy, /planId: text\('plan_id'\)/, 'the future plan hook is gone');
  await o.app.close();
});
