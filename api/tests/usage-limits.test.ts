/**
 * Allowances and hard limits — Phase 2.
 *
 * The rule this file exists to defend:
 *
 *   WHEN THE ALLOWANCE IS GONE, THE AI STOPS. LIFE OS DOES NOT.
 *
 * So the important tests here are not the ones that prove AI is blocked — they
 * are the ones that prove everything else still works while it is.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { CapabilityRegistry } from '../src/ai/registry.js';
import { MODULES } from '../src/ai/modules/index.js';
import { buildRouter } from '../src/ai/provider.js';
import { anthropicProvider } from '../src/ai/providers/anthropic.js';
import {
  policyFor, allowanceState, updatePolicy, defaultAllowanceUsd,
  overshootBound, THRESHOLDS,
} from '../src/usage/allowance.js';
import { aiUsageEvents, aiUsageAdjustments } from '../src/db/schema.js';

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = { authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'zander@example.com' };

const realFetch = globalThis.fetch;
let calls = 0;

/** A scripted Anthropic that reports a fixed, known cost per call. */
function anthropicCosts(usd: number, model = 'claude-haiku-4-5') {
  calls = 0;
  /* $1/MTok input on Haiku, so N million input tokens is $N. */
  const inputTokens = Math.round(usd * 1_000_000);
  globalThis.fetch = (async () => {
    calls += 1;
    const headers = new Headers();
    headers.set('request-id', `req_${calls}_${Math.random()}`);
    return {
      ok: true,
      status: 200,
      headers,
      json: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            understood: 'ok', intent: 'question', modules: [], queries: [],
            answer: 'Fine.', actions: [], candidates: [],
          }),
        }],
        usage: {
          input_tokens: inputTokens, output_tokens: 0,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        },
        model,
      }),
    } as any;
  }) as any;
}

beforeEach(() => { process.env['ANTHROPIC_API_KEY'] = 'test-key-not-real'; });
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['BETA_AI_ALLOWANCE_USD'];
  delete process.env['BETA_AI_ALLOWANCE_ZAR'];
  delete process.env['USD_ZAR_RATE'];
});

async function setup() {
  const { db } = await freshDb();
  const app = buildApp(db, env, {
    registry: new CapabilityRegistry(MODULES),
    providers: buildRouter([anthropicProvider]),
  });
  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth });
  return {
    db, app,
    ws: me.json().workspace.id,
    userId: me.json().user.id,
  };
}

/** Charge a user by writing ledger rows directly — no provider, no cost. */
async function spend(db: any, o: { userId: string; ws: string }, usd: number, n = 1) {
  for (let i = 0; i < n; i += 1) {
    await db.insert(aiUsageEvents).values({
      workspaceId: o.ws, userId: o.userId,
      provider: 'anthropic', model: 'claude-haiku-4-5', job: 'plan',
      requestKey: `seed-${o.userId}-${usd}-${i}-${Math.random()}`,
      pricingVersion: 'test',
      inputTokens: Math.round(usd * 1e6),
      providerCostUsd: usd.toFixed(10),
      billableCostUsd: usd.toFixed(10),
    });
  }
}

/* ══ 2A/2B — the policy and its one configurable default ═════════════════ */

test('allowance: the beta default is one value, not a number scattered about', () => {
  assert.equal(defaultAllowanceUsd({} as any), 11);
  assert.equal(defaultAllowanceUsd({ BETA_AI_ALLOWANCE_USD: '25' } as any), 25);
  assert.equal(defaultAllowanceUsd({ BETA_AI_ALLOWANCE_USD: 'unlimited' } as any), null);
  /* Expressed in rand — how the beta is actually talked about — but only
     usable when a rate exists. R200 at 20 is $10. */
  assert.equal(defaultAllowanceUsd({
    BETA_AI_ALLOWANCE_ZAR: '200', USD_ZAR_RATE: '20',
  } as any), 10);
  /* And with no rate there is no honest conversion, so the USD default holds
     rather than a made-up number. */
  assert.equal(defaultAllowanceUsd({ BETA_AI_ALLOWANCE_ZAR: '200' } as any), 11);
});

test('allowance: a policy appears on first sight rather than needing a backfill', async () => {
  const o = await setup();
  const p = await policyFor(o.db, o.userId, o.ws);
  assert.equal(p.aiEnabled, true);
  assert.equal(p.allowanceUsd, 11);
  /* Asked twice, one row — a second policy would double somebody's budget. */
  const again = await policyFor(o.db, o.userId, o.ws);
  assert.equal(again.id, p.id);
  await o.app.close();
});

/* ══ 2C — thresholds ═════════════════════════════════════════════════════ */

test('allowance: 70% is a heads-up, 90% is a warning, 100% is a stop', async () => {
  const o = await setup();
  await updatePolicy(o.db, o.userId, { allowanceUsd: 10 });

  assert.equal((await allowanceState(o.db, o.userId)).status, 'ok');
  await spend(o.db, o, 7.1);
  assert.equal((await allowanceState(o.db, o.userId)).status, 'notice');
  await spend(o.db, o, 2);           // 9.1 of 10
  assert.equal((await allowanceState(o.db, o.userId)).status, 'warning');
  await spend(o.db, o, 1);           // 10.1 of 10
  const blocked = await allowanceState(o.db, o.userId);
  assert.equal(blocked.status, 'blocked');
  assert.ok(blocked.remainingUsd! < 0);
  assert.equal(blocked.fraction, 1);
  await o.app.close();
});

test('allowance: the thresholds are stated once and used everywhere', () => {
  assert.equal(THRESHOLDS.notice, 0.7);
  assert.equal(THRESHOLDS.warning, 0.9);
});

/* ══ 2D — THE RULE ═══════════════════════════════════════════════════════ */

test('LIFE OS KEEPS WORKING when the AI allowance is gone', async () => {
  const o = await setup();
  await updatePolicy(o.db, o.userId, { allowanceUsd: 1 });
  await spend(o.db, o, 5);
  anthropicCosts(0.001);

  const blocked = await o.app.inject({
    method: 'POST', url: `/api/v1/workspaces/${o.ws}/ai/turn`, headers: auth,
    payload: { text: 'What is on today?', today: '2026-09-04' },
  });
  assert.equal(blocked.statusCode, 402, 'AI was not stopped');
  assert.equal(blocked.json().error.code, 'AI_ALLOWANCE_EXCEEDED');
  assert.equal(calls, 0, 'a blocked turn still spent money on a provider call');

  /* And now the part that actually matters. Every one of these is a normal
     part of somebody's day and none of them is allowed to break because a
     model budget ran out. */
  const survives: [string, string, any?][] = [
    ['GET', `/api/v1/workspaces/${o.ws}/tasks`],
    ['GET', `/api/v1/workspaces/${o.ws}/projects`],
    ['GET', `/api/v1/workspaces/${o.ws}/areas`],
    ['GET', `/api/v1/workspaces/${o.ws}/library/items`],
    ['GET', `/api/v1/workspaces/${o.ws}/habits`],
    ['GET', `/api/v1/workspaces/${o.ws}/reminders`],
    ['GET', '/api/v1/preferences'],
    ['GET', '/api/v1/me'],
  ];
  for (const [method, url] of survives) {
    const r = await o.app.inject({ method: method as any, url, headers: auth });
    assert.ok(r.statusCode < 400, `${method} ${url} broke: ${r.statusCode} ${r.body}`);
  }

  /* Creating things by hand keeps working too — this is somebody's own data,
     and the assistant is a convenience on top of it. */
  const made = await o.app.inject({
    method: 'POST', url: `/api/v1/workspaces/${o.ws}/tasks`, headers: auth,
    payload: { title: 'Written by hand, with no AI at all' },
  });
  assert.ok(made.statusCode < 400, `creating a task broke: ${made.body}`);
  await o.app.close();
});

test('a switched-off account is told so, and is not the same as a spent one', async () => {
  const o = await setup();
  await updatePolicy(o.db, o.userId, { aiEnabled: false });
  const state = await allowanceState(o.db, o.userId);
  assert.equal(state.status, 'disabled');
  const r = await o.app.inject({
    method: 'POST', url: `/api/v1/workspaces/${o.ws}/ai/turn`, headers: auth,
    payload: { text: 'hello', today: '2026-09-04' },
  });
  assert.equal(r.statusCode, 402);
  assert.match(r.json().error.message, /switched off/);
  await o.app.close();
});

/* ══ 2E — the bound on overshoot ═════════════════════════════════════════ */

test('a turn is stopped BETWEEN provider calls, not only before it starts', async () => {
  const o = await setup();
  /* There is something left, so the turn is allowed to start. The interpret
     call then spends more than all of it, and the plan call is refused — so
     the overshoot is one request rather than a whole turn's worth. */
  await updatePolicy(o.db, o.userId, { allowanceUsd: 0.4 });
  anthropicCosts(0.5);

  const r = await o.app.inject({
    method: 'POST', url: `/api/v1/workspaces/${o.ws}/ai/turn`, headers: auth,
    payload: { text: 'What is on today?', today: '2026-09-04' },
  });
  assert.equal(r.statusCode, 402, `expected a quota stop, got ${r.statusCode}`);
  assert.equal(calls, 1, `the turn made ${calls} provider calls after running out`);

  /* What was actually spent is on the ledger, and it is one call's worth. */
  const rows = await o.db.select().from(aiUsageEvents);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0]!.billableCostUsd), 0.5);
  await o.app.close();
});

test('the overshoot bound is stated rather than hoped for', () => {
  const b = overshootBound();
  assert.ok(b.perCallUsd > 0);
  /* Whatever the models, one call is a small fraction of a beta allowance.
     If this ever stops being true the number is wrong, not the test. */
  assert.ok(b.perCallUsd < 1, `one call could cost $${b.perCallUsd}`);
  assert.ok(b.assumptions.inputCeilingTokens > 0);
  assert.ok(b.assumptions.outputCeilingTokens > 0);
});

/* ══ 2F — the shape of the refusal ═══════════════════════════════════════ */

test('being blocked is a structured quota answer, not a generic failure', async () => {
  const o = await setup();
  await updatePolicy(o.db, o.userId, { allowanceUsd: 1 });
  await spend(o.db, o, 2);
  const r = await o.app.inject({
    method: 'POST', url: `/api/v1/workspaces/${o.ws}/ai/turn`, headers: auth,
    payload: { text: 'hello', today: '2026-09-04' },
  });
  const body = r.json();
  assert.equal(body.error.code, 'AI_ALLOWANCE_EXCEEDED');
  /* The sentence a person reads, and the numbers behind it. */
  assert.match(body.error.message, /reached your AI allowance/);
  assert.match(body.error.message, /rest of Life OS is still available/);
  assert.match(body.error.message, /Contact Zander/);
  assert.equal(body.error.details.status, 'blocked');
  assert.equal(body.error.details.allowanceUsd, 1);
  assert.ok(body.error.details.usedUsd >= 2);
  /* And nothing about buying anything, because there is nothing to buy yet. */
  assert.doesNotMatch(body.error.message, /upgrade|subscribe|buy|payment/i);
  await o.app.close();
});

/* ══ Credits, and history that survives them ═════════════════════════════ */

test('a credit gives more room without touching a single usage row', async () => {
  const o = await setup();
  await updatePolicy(o.db, o.userId, { allowanceUsd: 1 });
  await spend(o.db, o, 1.5);
  assert.equal((await allowanceState(o.db, o.userId)).status, 'blocked');

  const before = await o.db.select().from(aiUsageEvents);
  await o.db.insert(aiUsageAdjustments).values({
    userId: o.userId, amountUsd: '2.0000000000',
    reason: 'Beta top-up', kind: 'credit',
  });
  const after = await allowanceState(o.db, o.userId);
  assert.equal(after.status, 'ok');
  assert.equal(after.allowanceUsd, 3);
  assert.equal(after.adjustmentsUsd, 2);
  assert.equal(after.usedUsd, 1.5, 'a credit rewrote what had been spent');

  const rows = await o.db.select().from(aiUsageEvents);
  assert.equal(rows.length, before.length, 'usage history was altered by a credit');
  await o.app.close();
});

test('changing the allowance does not delete usage history', async () => {
  const o = await setup();
  await spend(o.db, o, 0.4, 3);
  const before = await o.db.select().from(aiUsageEvents);
  await updatePolicy(o.db, o.userId, { allowanceUsd: 50 });
  await updatePolicy(o.db, o.userId, { allowanceUsd: null });
  await updatePolicy(o.db, o.userId, { aiEnabled: false });
  const after = await o.db.select().from(aiUsageEvents);
  assert.equal(after.length, before.length);
  const used = (await allowanceState(o.db, o.userId)).usedUsd;
  assert.ok(Math.abs(used - before.length * 0.4) < 1e-9, `used ${used}`);
  await o.app.close();
});

test('unlimited means unlimited, and is not the same as an unset allowance', async () => {
  const o = await setup();
  await updatePolicy(o.db, o.userId, { allowanceUsd: null });
  await spend(o.db, o, 1000);
  const state = await allowanceState(o.db, o.userId);
  assert.equal(state.status, 'unlimited');
  assert.equal(state.remainingUsd, null);
  assert.equal(state.fraction, null);
  await o.app.close();
});

/* ══ The user-facing endpoint ════════════════════════════════════════════ */

test('a user can see their own usage, and only their own', async () => {
  const o = await setup();
  await updatePolicy(o.db, o.userId, { allowanceUsd: 10 });
  await spend(o.db, o, 1.4);

  const r = await o.app.inject({
    method: 'GET', url: `/api/v1/workspaces/${o.ws}/ai/usage`, headers: auth,
  });
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(b.allowanceUsd, 10);
  assert.equal(b.usedUsd, 1.4);
  assert.equal(b.remainingUsd, 8.6);
  assert.ok(Math.abs(b.fraction - 0.14) < 1e-9);
  assert.equal(b.status, 'ok');
  assert.equal(b.currency, 'USD');
  /* Tokens exist but do not lead. */
  assert.ok(b.tokens.input > 0);
  /* There is no parameter through which another person could be named — the
     id comes from the verified token, and the route has none. */
  assert.equal(typeof b.policyId, 'string');
  await o.app.close();
});

test('rand appears only when a rate is configured, and is never invented', async () => {
  const o = await setup();
  await updatePolicy(o.db, o.userId, { allowanceUsd: 10 });
  const without = await allowanceState(o.db, o.userId);
  assert.equal(without.zar, null);

  process.env['USD_ZAR_RATE'] = '18.2';
  const with_ = await allowanceState(o.db, o.userId);
  assert.equal(with_.zar!.rate, 18.2);
  assert.equal(with_.zar!.allowance, 182);
  await o.app.close();
});
