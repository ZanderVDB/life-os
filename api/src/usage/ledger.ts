/**
 * Writing the ledger, and reading it back.
 *
 * The ledger is APPEND-ONLY. Nothing in this file updates or deletes a usage
 * event, and there is no function here that could. A correction is an
 * adjustment row, which is a different thing with its own history — an
 * accounting system whose past can be edited is a system whose past means
 * nothing.
 */
import { and, eq, gte, lt, sql, desc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiUsageEvents, aiUsageAdjustments } from '../db/schema.js';
import { priceUsage } from './pricing.js';
import { fxRate, toZar, type FxRate } from './fx.js';
import type { CallRecord, MeterScope } from './meter.js';
import { requestKey } from './meter.js';

/** Money as the database holds it: an exact decimal string. */
const money = (n: number) => n.toFixed(10);
export const asNumber = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export type RecordedEvent = {
  requestKey: string;
  providerCostUsd: number;
  billableCostUsd: number;
  estimated: boolean;
};

/**
 * Persist one provider call.
 *
 * `onConflictDoNothing` is the whole idempotency story: a replayed write hits
 * the unique index on `request_key` (or on the provider's own request id) and
 * changes nothing. A genuine retry carries a different attempt number and is a
 * different row, because it was a different request and a real second cost.
 *
 * A FAILED call records what failed and charges nothing. There is no usage to
 * report on a call that never completed, and estimating one from the prompt
 * length would be putting a guess into a financial record.
 */
export async function recordUsage(
  db: Db, scope: MeterScope, call: CallRecord,
  opts: { fx?: FxRate | null; now?: Date } = {},
): Promise<RecordedEvent> {
  const now = opts.now ?? new Date();
  const fx = opts.fx === undefined ? fxRate() : opts.fx;
  const key = requestKey(scope, call);

  const ok = call.status === 'ok';
  const priced = ok
    ? priceUsage(call.provider, call.model, {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: call.cacheReadTokens,
      cacheWriteTokens: call.cacheWriteTokens,
    }, now)
    : null;

  const providerCostUsd = priced?.usd ?? 0;
  /* For beta these are the same number. They are separate COLUMNS so that
     absorbing an internal retry, or crediting a turn, later changes what the
     user is charged without losing what Life OS actually paid. */
  const billableCostUsd = providerCostUsd;

  await db.insert(aiUsageEvents).values({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    conversationId: scope.conversationId,
    turnId: scope.turnId,
    provider: call.provider,
    model: call.model,
    job: call.job,
    attempt: call.attempt,
    origin: scope.origin,
    providerRequestId: call.providerRequestId,
    requestKey: key,
    inputTokens: ok ? call.inputTokens : 0,
    outputTokens: ok ? call.outputTokens : 0,
    cacheReadTokens: ok ? call.cacheReadTokens : 0,
    cacheWriteTokens: ok ? call.cacheWriteTokens : 0,
    providerCostUsd: money(providerCostUsd),
    billableCostUsd: money(billableCostUsd),
    fxRateUsdZar: fx ? money(fx.rate) : null,
    providerCostZar: fx ? money(toZar(providerCostUsd, fx)!) : null,
    billableCostZar: fx ? money(toZar(billableCostUsd, fx)!) : null,
    pricingVersion: priced?.price.version ?? (ok ? 'unpriced' : 'not-charged'),
    pricingEffectiveAt: priced ? new Date(priced.price.effectiveAt) : null,
    pricingSnapshot: (priced?.snapshot ?? {}) as Record<string, unknown>,
    costEstimated: priced?.estimated ?? false,
    status: call.status,
    errorType: call.errorType,
    latencyMs: call.latencyMs,
  }).onConflictDoNothing();

  return {
    requestKey: key,
    providerCostUsd,
    billableCostUsd,
    estimated: priced?.estimated ?? false,
  };
}

/* ══ Reading it back ═════════════════════════════════════════════════════ */

export type UsageTotals = {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  providerCostUsd: number;
  billableCostUsd: number;
  estimatedCalls: number;
};

const ZERO: UsageTotals = {
  calls: 0, failures: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0,
  providerCostUsd: 0, billableCostUsd: 0, estimatedCalls: 0,
};

/* Aggregated in SQL rather than in JavaScript, so a user with ten thousand
   events costs one round trip rather than ten thousand rows over the wire. */
const totalsSelect = {
  calls: sql<number>`count(*)::int`,
  failures: sql<number>`count(*) filter (where ${aiUsageEvents.status} = 'failed')::int`,
  inputTokens: sql<number>`coalesce(sum(${aiUsageEvents.inputTokens}), 0)::int`,
  outputTokens: sql<number>`coalesce(sum(${aiUsageEvents.outputTokens}), 0)::int`,
  cacheReadTokens: sql<number>`coalesce(sum(${aiUsageEvents.cacheReadTokens}), 0)::int`,
  cacheWriteTokens: sql<number>`coalesce(sum(${aiUsageEvents.cacheWriteTokens}), 0)::int`,
  providerCostUsd: sql<string>`coalesce(sum(${aiUsageEvents.providerCostUsd}), 0)`,
  billableCostUsd: sql<string>`coalesce(sum(${aiUsageEvents.billableCostUsd}), 0)`,
  estimatedCalls: sql<number>`count(*) filter (where ${aiUsageEvents.costEstimated})::int`,
};

const shape = (row: Record<string, unknown> | undefined): UsageTotals => (row ? {
  calls: asNumber(row['calls']),
  failures: asNumber(row['failures']),
  inputTokens: asNumber(row['inputTokens']),
  outputTokens: asNumber(row['outputTokens']),
  cacheReadTokens: asNumber(row['cacheReadTokens']),
  cacheWriteTokens: asNumber(row['cacheWriteTokens']),
  providerCostUsd: asNumber(row['providerCostUsd']),
  billableCostUsd: asNumber(row['billableCostUsd']),
  estimatedCalls: asNumber(row['estimatedCalls']),
} : { ...ZERO });

export type Window = { from?: Date | null; to?: Date | null };

const within = (w: Window) => {
  const parts = [];
  if (w.from) parts.push(gte(aiUsageEvents.createdAt, w.from));
  if (w.to) parts.push(lt(aiUsageEvents.createdAt, w.to));
  return parts;
};

/** Everything one user has spent in a window. The number an allowance uses. */
export async function totalsForUser(
  db: Db, userId: string, window: Window = {},
): Promise<UsageTotals> {
  const [row] = await db.select(totalsSelect).from(aiUsageEvents)
    .where(and(eq(aiUsageEvents.userId, userId), ...within(window)));
  return shape(row as any);
}

/** Everything, for the admin overview. */
export async function totalsForAll(db: Db, window: Window = {}): Promise<UsageTotals> {
  const parts = within(window);
  const q = db.select(totalsSelect).from(aiUsageEvents);
  const [row] = parts.length ? await q.where(and(...parts)) : await q;
  return shape(row as any);
}

/** What each job cost, for one user or one turn. The "Interpret R0.02" list. */
export async function breakdown(
  db: Db, where: { userId?: string; turnId?: string }, window: Window = {},
) {
  const parts = within(window);
  if (where.userId) parts.push(eq(aiUsageEvents.userId, where.userId));
  if (where.turnId) parts.push(eq(aiUsageEvents.turnId, where.turnId));
  const rows = await db.select({
    job: aiUsageEvents.job,
    model: aiUsageEvents.model,
    ...totalsSelect,
  }).from(aiUsageEvents)
    .where(parts.length ? and(...parts) : undefined)
    .groupBy(aiUsageEvents.job, aiUsageEvents.model);
  return rows.map((r: any) => ({ job: r.job, model: r.model, ...shape(r) }));
}

/** The most recent events, newest first. Operating detail, never content. */
export async function recentEvents(db: Db, userId: string, limit = 25) {
  const rows = await db.select({
    id: aiUsageEvents.id,
    turnId: aiUsageEvents.turnId,
    job: aiUsageEvents.job,
    model: aiUsageEvents.model,
    attempt: aiUsageEvents.attempt,
    origin: aiUsageEvents.origin,
    status: aiUsageEvents.status,
    errorType: aiUsageEvents.errorType,
    inputTokens: aiUsageEvents.inputTokens,
    outputTokens: aiUsageEvents.outputTokens,
    billableCostUsd: aiUsageEvents.billableCostUsd,
    costEstimated: aiUsageEvents.costEstimated,
    latencyMs: aiUsageEvents.latencyMs,
    createdAt: aiUsageEvents.createdAt,
  }).from(aiUsageEvents)
    .where(eq(aiUsageEvents.userId, userId))
    .orderBy(desc(aiUsageEvents.createdAt))
    .limit(limit);
  return rows.map((r: any) => ({ ...r, billableCostUsd: asNumber(r.billableCostUsd) }));
}

/** Credits and corrections in a period. Positive gives the user more room. */
export async function adjustmentsTotal(
  db: Db, userId: string, periodStart: Date | null,
): Promise<number> {
  const parts = [eq(aiUsageAdjustments.userId, userId)];
  if (periodStart) parts.push(gte(aiUsageAdjustments.periodStart, periodStart));
  const [row] = await db.select({
    total: sql<string>`coalesce(sum(${aiUsageAdjustments.amountUsd}), 0)`,
  }).from(aiUsageAdjustments).where(and(...parts));
  return asNumber((row as any)?.total);
}
