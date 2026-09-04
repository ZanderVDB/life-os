/**
 * AI usage accounting — Phase 1.
 *
 * ── What is stubbed, and why that is the right seam ──────────────────────
 *
 * `globalThis.fetch`. Everything above it is the real thing: the real Anthropic
 * adapter reading a real-shaped response body, the real meter, the real
 * pricing registry, the real ledger writing to real Postgres (PGlite) through
 * the real constraints.
 *
 * Stubbing the provider object instead would have tested nothing — the whole
 * point is that the ADAPTER reads `usage` correctly and that a schema repair
 * is recognised as a second cost, and neither of those exists above the HTTP
 * boundary. Stubbing lower would be stubbing the network.
 *
 * No real provider call is made anywhere in this file. Proving that pricing
 * arithmetic is right does not require buying tokens.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { withMeter, recordCall, requestKey } from '../src/usage/meter.js';
import { recordUsage, totalsForUser, breakdown, adjustmentsTotal } from '../src/usage/ledger.js';
import { priceFor, priceUsage, PRICES, ceilingFor } from '../src/usage/pricing.js';
import { fxRate, toZar } from '../src/usage/fx.js';
import { anthropicProvider } from '../src/ai/providers/anthropic.js';
import { aiUsageEvents, users, workspaces, workspaceMemberships } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

/* ══ A scripted Anthropic ════════════════════════════════════════════════ */

type Reply = {
  status?: number;
  text?: string;
  usage?: Record<string, number>;
  requestId?: string | null;
  body?: unknown;
};

let scripted: Reply[] = [];
let sent: any[] = [];
const realFetch = globalThis.fetch;

function anthropicSays(replies: Reply[]) {
  scripted = [...replies];
  sent = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    sent.push(JSON.parse(String(init.body)));
    const r = scripted.shift() ?? scripted[scripted.length - 1] ?? {};
    const headers = new Headers();
    if (r.requestId !== null) headers.set('request-id', r.requestId ?? `req_${sent.length}`);
    const status = r.status ?? 200;
    const body = r.body ?? {
      content: [{ type: 'text', text: r.text ?? '{}' }],
      usage: r.usage ?? {
        input_tokens: 1000, output_tokens: 500,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      },
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      json: async () => body,
    } as any;
  }) as any;
}

beforeEach(() => { process.env['ANTHROPIC_API_KEY'] = 'test-key-not-real'; });
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['USD_ZAR_RATE'];
});

async function owner() {
  const { db } = await freshDb();
  const [u] = await db.insert(users).values({
    email: 'zander@example.com', displayName: 'Zander',
  }).returning();
  const [ws] = await db.insert(workspaces).values({
    ownerUserId: u!.id, name: 'Life OS',
  }).returning();
  await db.insert(workspaceMemberships).values({ workspaceId: ws!.id, userId: u!.id });
  return { db, userId: u!.id, workspaceId: ws!.id };
}

/** The one object every AI job takes. The adapter reads `today` from it. */
const REQ = {
  workspaceId: 'w', userId: 'u', today: '2026-09-04',
  timeZone: 'Africa/Johannesburg', surface: null,
} as any;

const scope = (o: { userId: string; workspaceId: string }, extra: any = {}) => ({
  workspaceId: o.workspaceId, userId: o.userId,
  conversationId: null, turnId: null, origin: 'user' as const, ...extra,
});

/* ══ 1D — the pricing registry ═══════════════════════════════════════════ */

test('pricing: a dated model snapshot is the same model at the same price', () => {
  /* `claude-haiku-4-5-20251001` is what this deployment actually configures.
     A registry that only knew the undated id would have priced every single
     interpret and memory-extraction call at the unknown-model ceiling. */
  const dated = priceFor('anthropic', 'claude-haiku-4-5-20251001');
  const plain = priceFor('anthropic', 'claude-haiku-4-5');
  assert.ok(dated, 'the dated snapshot is not priced');
  assert.equal(dated!.inputPerMTok, plain!.inputPerMTok);
  assert.equal(dated!.outputPerMTok, plain!.outputPerMTok);
});

test('pricing: cost is computed from all four token categories', () => {
  /* Haiku 4.5 is $1/MTok in, $5/MTok out; a cache read is a tenth of input and
     a cache write is 1.25x it. Counting only input and output would be wrong
     in both directions. */
  const p = priceUsage('anthropic', 'claude-haiku-4-5', {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  })!;
  assert.equal(p.usd, 1 + 5 + 0.1 + 1.25);
  assert.equal(p.estimated, false);
});

test('pricing: an unknown model is charged at the ceiling and marked estimated', () => {
  /* Not free. A model nobody registered is still spending real money, and
     treating it as zero would let somebody run past an allowance that never
     moves. Conservative and labelled beats cheap and wrong. */
  const p = priceUsage('anthropic', 'claude-something-nobody-added', {
    inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  })!;
  const ceiling = ceilingFor('anthropic')!;
  assert.equal(p.usd, ceiling.inputPerMTok);
  assert.equal(p.estimated, true);
  assert.match(String(p.snapshot['why']), /not in the pricing registry/);
});

test('pricing: every registered model has coherent rates', () => {
  for (const p of PRICES) {
    assert.ok(p.outputPerMTok > p.inputPerMTok, `${p.model}: output is not dearer than input`);
    assert.ok(p.cacheReadPerMTok < p.inputPerMTok, `${p.model}: a cache read is not cheaper`);
    assert.ok(p.cacheWritePerMTok > p.inputPerMTok, `${p.model}: a cache write is not dearer`);
    assert.ok(p.version && p.effectiveAt, `${p.model}: unversioned`);
  }
});

/* ══ 1E — USD → ZAR ══════════════════════════════════════════════════════ */

test('fx: with no rate configured, rand is not invented', () => {
  delete process.env['USD_ZAR_RATE'];
  assert.equal(fxRate({} as any), null);
  assert.equal(toZar(1.23, null), null);
});

test('fx: a nonsense rate is refused rather than believed', () => {
  /* A typo here would silently misreport every amount in the product. */
  assert.equal(fxRate({ USD_ZAR_RATE: '0.0001' } as any), null);
  assert.equal(fxRate({ USD_ZAR_RATE: '1820' } as any), null);
  assert.equal(fxRate({ USD_ZAR_RATE: 'eighteen' } as any), null);
  assert.equal(fxRate({ USD_ZAR_RATE: '18.2' } as any)?.rate, 18.2);
});

/* ══ 1A/1B/1C — capture ══════════════════════════════════════════════════ */

test('capture: the adapter records what the provider actually reported', async () => {
  const o = await owner();
  anthropicSays([{
    text: JSON.stringify({ understood: 'x', intent: 'question', modules: [], queries: [] }),
    usage: {
      input_tokens: 4321, output_tokens: 123,
      cache_read_input_tokens: 900, cache_creation_input_tokens: 50,
    },
    requestId: 'req_abc123',
  }]);

  await withMeter(scope(o, { turnId: null }), async (s) => {
    await anthropicProvider.interpret!({ text: 'hello', request: REQ, modules: [] });
    for (const c of s.calls) await recordUsage(o.db, s, c);
  });

  const [row] = await o.db.select().from(aiUsageEvents);
  assert.equal(row!.inputTokens, 4321);
  assert.equal(row!.outputTokens, 123);
  assert.equal(row!.cacheReadTokens, 900);
  assert.equal(row!.cacheWriteTokens, 50);
  assert.equal(row!.job, 'interpret');
  assert.equal(row!.providerRequestId, 'req_abc123');
  assert.equal(row!.status, 'ok');
  /* Not estimated from a character count — these are the provider's numbers. */
  assert.equal(row!.costEstimated, false);
  assert.ok(Number(row!.providerCostUsd) > 0);
});

test('capture: the snapshot is enough to recompute the cost without the registry', async () => {
  const o = await owner();
  anthropicSays([{ text: '{"understood":"x","intent":"question","modules":[],"queries":[]}' }]);
  await withMeter(scope(o), async (s) => {
    await anthropicProvider.interpret!({ text: 'hi', request: REQ, modules: [] });
    for (const c of s.calls) await recordUsage(o.db, s, c);
  });
  const [row] = await o.db.select().from(aiUsageEvents);
  const snap = row!.pricingSnapshot as any;
  /* An auditor with only this row can add it up again. That is the whole
     point: if Anthropic changes its prices tomorrow, this row does not. */
  const recomputed = (row!.inputTokens / 1e6) * snap.inputPerMTok
    + (row!.outputTokens / 1e6) * snap.outputPerMTok
    + (row!.cacheReadTokens / 1e6) * snap.cacheReadPerMTok
    + (row!.cacheWriteTokens / 1e6) * snap.cacheWritePerMTok;
  assert.ok(Math.abs(recomputed - Number(row!.providerCostUsd)) < 1e-9);
  assert.ok(snap.version, 'the row does not say which price sheet it used');
});

/* ══ 1B — a turn is many jobs ════════════════════════════════════════════ */

test('aggregation: one turn, four jobs, and a total that adds up', async () => {
  const o = await owner();
  const turnId = '11111111-1111-4111-8111-111111111111';
  anthropicSays([{ usage: { input_tokens: 500, output_tokens: 100 } }]);

  await withMeter(scope(o, { turnId }), async (s) => {
    for (const job of ['interpret', 'plan', 'answer', 'extractMemory']) {
      recordCall({
        provider: 'anthropic', model: 'claude-haiku-4-5', job, attempt: 1,
        inputTokens: 1_000_000, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        providerRequestId: `r-${job}`, status: 'ok', errorType: null, latencyMs: 10,
      });
    }
    for (const c of s.calls) await recordUsage(o.db, s, c);
  });

  const rows = await o.db.select().from(aiUsageEvents).where(eq(aiUsageEvents.turnId, turnId));
  assert.equal(rows.length, 4, 'only the visible response was recorded');
  const parts = await breakdown(o.db, { turnId });
  assert.deepEqual(parts.map((p) => p.job).sort(),
    ['answer', 'extractMemory', 'interpret', 'plan']);
  const totals = await totalsForUser(o.db, o.userId);
  /* $1/MTok x 4 million input tokens. */
  assert.equal(Math.round(totals.providerCostUsd * 1e6) / 1e6, 4);
  assert.equal(totals.calls, 4);
});

/* ══ 1G — idempotency, and the retry that is not a duplicate ═════════════ */

test('idempotency: the same provider response cannot be persisted twice', async () => {
  const o = await owner();
  await withMeter(scope(o), async (s) => {
    const c = recordCall({
      provider: 'anthropic', model: 'claude-haiku-4-5', job: 'plan', attempt: 1,
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
      providerRequestId: 'req_same', status: 'ok', errorType: null, latencyMs: 5,
    })!;
    /* Written three times — a replayed flush, a retried write, a second
       process. The unique index makes all but the first a no-op. */
    await recordUsage(o.db, s, c);
    await recordUsage(o.db, s, c);
    await recordUsage(o.db, s, c);
  });
  const rows = await o.db.select().from(aiUsageEvents);
  assert.equal(rows.length, 1);
});

test('idempotency: a genuine schema repair IS a second cost', async () => {
  const o = await owner();
  await withMeter(scope(o), async (s) => {
    for (const attempt of [1, 2]) {
      const c = recordCall({
        provider: 'anthropic', model: 'claude-haiku-4-5', job: 'plan', attempt,
        inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
        providerRequestId: `req_try_${attempt}`, status: 'ok', errorType: null, latencyMs: 5,
      })!;
      await recordUsage(o.db, s, c);
    }
  });
  const rows = await o.db.select().from(aiUsageEvents);
  assert.equal(rows.length, 2, 'a real second request was collapsed into one row');
  assert.deepEqual(rows.map((r: any) => r.attempt).sort(), [1, 2]);
});

test('idempotency: the provider request id blocks a duplicate across scopes', async () => {
  const o = await owner();
  /* Two different scopes produce two different request keys, so only the
     PROVIDER's own id can catch this — which is exactly what it is for. */
  for (const _ of [1, 2]) {
    await withMeter(scope(o), async (s) => {
      const c = recordCall({
        provider: 'anthropic', model: 'claude-haiku-4-5', job: 'plan', attempt: 1,
        inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
        providerRequestId: 'req_globally_unique', status: 'ok', errorType: null, latencyMs: 1,
      })!;
      await recordUsage(o.db, s, c);
    });
  }
  const rows = await o.db.select().from(aiUsageEvents);
  assert.equal(rows.length, 1);
});

test('idempotency: the request key names the scope, the job, the try and the sequence', async () => {
  await withMeter({
    workspaceId: 'w', userId: 'u', conversationId: null, turnId: null,
    origin: 'user', scopeId: 'scope-1',
  }, async (s) => {
    const a = recordCall({
      provider: 'anthropic', model: 'm', job: 'plan', attempt: 1,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      providerRequestId: null, status: 'ok', errorType: null, latencyMs: 0,
    })!;
    const b = recordCall({
      provider: 'anthropic', model: 'm', job: 'plan', attempt: 2,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      providerRequestId: null, status: 'ok', errorType: null, latencyMs: 0,
    })!;
    assert.equal(requestKey(s, a), 'scope-1:plan:1:1');
    assert.equal(requestKey(s, b), 'scope-1:plan:2:2');
  });
});

/* ══ 1C — a failure invents nothing ══════════════════════════════════════ */

test('failure: a refused call is recorded and charges nothing', async () => {
  const o = await owner();
  anthropicSays([{ status: 429, requestId: 'req_limited' }]);
  await withMeter(scope(o), async (s) => {
    await anthropicProvider.interpret!({ text: 'hi', request: REQ, modules: [] })
      .catch(() => null);
    for (const c of s.calls) await recordUsage(o.db, s, c);
  });
  const rows = await o.db.select().from(aiUsageEvents);
  assert.ok(rows.length >= 1, 'the failure was not recorded at all');
  for (const r of rows as any[]) {
    assert.equal(r.status, 'failed');
    assert.equal(r.errorType, 'rate_limit');
    assert.equal(Number(r.providerCostUsd), 0, 'a failed call invented a charge');
    assert.equal(r.inputTokens, 0, 'a failed call invented tokens');
  }
  const totals = await totalsForUser(o.db, o.userId);
  assert.equal(totals.providerCostUsd, 0);
  assert.ok(totals.failures >= 1);
});

test('failure: the database itself refuses a charged failure', async () => {
  const o = await owner();
  /* Belt and braces. The application already does the right thing; this is
     the constraint that keeps a future change from quietly undoing it. */
  await assert.rejects(() => o.db.insert(aiUsageEvents).values({
    workspaceId: o.workspaceId, userId: o.userId,
    provider: 'anthropic', model: 'm', job: 'plan',
    requestKey: 'k1', pricingVersion: 'v',
    status: 'failed', providerCostUsd: '1.0000000000', billableCostUsd: '1.0000000000',
  } as any));
});

/* ══ 1F — provider cost vs billable cost ═════════════════════════════════ */

test('cost: provider and billable are separate columns, equal for beta', async () => {
  const o = await owner();
  await withMeter(scope(o), async (s) => {
    const c = recordCall({
      provider: 'anthropic', model: 'claude-haiku-4-5', job: 'plan', attempt: 1,
      inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      providerRequestId: 'r1', status: 'ok', errorType: null, latencyMs: 1,
    })!;
    await recordUsage(o.db, s, c);
  });
  const [row] = await o.db.select().from(aiUsageEvents);
  assert.equal(Number(row!.providerCostUsd), 1);
  assert.equal(Number(row!.billableCostUsd), 1);
  /* An adjustment is how a credit happens — a row, never an edit to history. */
  assert.equal(await adjustmentsTotal(o.db, o.userId, null), 0);
});

/* ══ 1H — background work is attributed, not charged elsewhere ═══════════ */

test('origin: system work is attributed but marked as not the user’s doing', async () => {
  const o = await owner();
  await withMeter(scope(o, { origin: 'system' }), async (s) => {
    const c = recordCall({
      provider: 'anthropic', model: 'claude-haiku-4-5', job: 'summarise', attempt: 1,
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
      providerRequestId: 'r-sys', status: 'ok', errorType: null, latencyMs: 1,
    })!;
    await recordUsage(o.db, s, c);
  });
  const [row] = await o.db.select().from(aiUsageEvents);
  assert.equal(row!.origin, 'system');
  assert.equal(row!.userId, o.userId, 'system work lost its owner');
});

/* ══ The meter itself ════════════════════════════════════════════════════ */

test('meter: a call outside any scope belongs to nobody rather than to whoever was last', () => {
  /* The module-level array this replaces would have charged it to the previous
     request. Silence is the correct answer. */
  assert.equal(recordCall({
    provider: 'anthropic', model: 'm', job: 'plan', attempt: 1,
    inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    providerRequestId: null, status: 'ok', errorType: null, latencyMs: 0,
  }), null);
});

test('meter: two concurrent turns do not mix', async () => {
  const seen: Record<string, string[]> = { a: [], b: [] };
  const one = (who: 'a' | 'b') => withMeter({
    workspaceId: `ws-${who}`, userId: `u-${who}`, conversationId: null,
    turnId: null, origin: 'user',
    onCall: (_c, s) => { seen[who]!.push(s.userId); },
  }, async () => {
    await new Promise((r) => { setTimeout(r, who === 'a' ? 12 : 2); });
    recordCall({
      provider: 'anthropic', model: 'm', job: 'plan', attempt: 1,
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      providerRequestId: null, status: 'ok', errorType: null, latencyMs: 0,
    });
  });
  await Promise.all([one('a'), one('b')]);
  assert.deepEqual(seen['a'], ['u-a']);
  assert.deepEqual(seen['b'], ['u-b']);
});

/* ══ End to end: a real turn, through the real route ═════════════════════ */

test('a real turn writes one ledger row per provider job, keyed to the turn', async () => {
  const { db } = await freshDb();
  const { buildApp } = await import('../src/app.js');
  const { loadEnv } = await import('../src/env.js');
  const { CapabilityRegistry } = await import('../src/ai/registry.js');
  const { MODULES } = await import('../src/ai/modules/index.js');
  const { buildRouter } = await import('../src/ai/provider.js');

  const TOKEN = 'test-bypass-token';
  const env = loadEnv({
    NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DEV_AUTH_BYPASS: TOKEN,
  } as any);

  /* The REAL Anthropic provider, over a scripted socket. Interpret answers
     first, then plan. Both report usage exactly as the API does. */
  anthropicSays([
    {
      text: JSON.stringify({
        understood: 'What is on today', intent: 'question', modules: [], queries: ['today'],
      }),
      usage: { input_tokens: 2000, output_tokens: 60 },
      requestId: 'req_interpret',
    },
    {
      text: JSON.stringify({ understood: 'What is on today', answer: 'Nothing.', actions: [] }),
      usage: { input_tokens: 9000, output_tokens: 300 },
      requestId: 'req_plan',
    },
    {
      text: JSON.stringify({ candidates: [] }),
      usage: { input_tokens: 400, output_tokens: 20 },
      requestId: 'req_memory',
    },
  ]);

  const app = buildApp(db, env, {
    registry: new CapabilityRegistry(MODULES),
    providers: buildRouter([anthropicProvider]),
  });
  const auth = { authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'zander@example.com' };
  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth });
  const ws = me.json().workspace.id;

  const res = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${ws}/ai/turn`, headers: auth,
    payload: { text: 'What is on today?', today: '2026-09-04' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const turnId = res.json().turnId;

  /* Memory extraction is fired and deliberately not awaited, so give it the
     moment it needs before counting. */
  await new Promise((r) => { setTimeout(r, 120); });

  const rows = await db.select().from(aiUsageEvents);
  assert.ok(rows.length >= 2, `expected interpret + plan, got ${rows.length}`);
  const jobs = new Set(rows.map((r: any) => r.job));
  assert.ok(jobs.has('interpret') && jobs.has('plan'),
    `only ${[...jobs].join(', ')} were recorded`);

  /* Every row belongs to the turn, and the turn row exists under that id —
     which is what makes "Turn total: R0.34, of which Plan R0.21" answerable. */
  for (const r of rows as any[]) {
    assert.equal(r.turnId, turnId, `${r.job} was not attributed to the turn`);
    assert.ok(r.conversationId, `${r.job} lost its conversation`);
    assert.equal(r.origin, 'user');
  }
  const parts = await breakdown(db, { turnId });
  assert.ok(parts.length >= 2);
  const total = parts.reduce((n, p) => n + p.providerCostUsd, 0);
  assert.ok(total > 0, 'a turn that called a model twice cost nothing');
  await app.close();
});
