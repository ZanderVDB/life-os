/**
 * What a person is shown about their own AI usage.
 *
 * ── The shape is deliberate ──────────────────────────────────────────────
 *
 * "14% of your allowance" leads. "2,387,124 tokens" is behind a details
 * section, because it is true, occasionally useful, and answers no question
 * anybody actually has.
 *
 * ── Everything here is computed by the server ────────────────────────────
 *
 * The percentage, the remaining amount, the warning level, whether AI is
 * available at all. The browser renders these; it never derives them. A
 * client that could compute its own allowance is a client that could be
 * persuaded it has more.
 */
import { sql, and, eq, gte, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiTurns } from '../db/schema.js';
import { allowanceState, THRESHOLDS, blockedMessage, type AllowanceState } from './allowance.js';
import { totalsForUser, breakdown } from './ledger.js';
import { fxRate } from './fx.js';

/** Assistant turns in the window — the number a person recognises. */
async function turnCount(db: Db, userId: string, from: Date, to: Date | null) {
  const parts = [eq(aiTurns.userId, userId), gte(aiTurns.createdAt, from)];
  if (to) parts.push(lt(aiTurns.createdAt, to));
  const [row] = await db.select({ n: sql<number>`count(*)::int` })
    .from(aiTurns).where(and(...parts));
  return Number((row as any)?.n ?? 0);
}

export type UsageSummary = AllowanceState & {
  /** What to say, if anything. Written for the person, decided by the server. */
  message: string | null;
  thresholds: { notice: number; warning: number };
  /** The currency the numbers are enforced in. Rand is presentation. */
  currency: 'USD';
};

const NOTICE = 'You have used most of your AI allowance for this period.';
const WARNING = 'You are close to your AI allowance for this period. '
  + 'Contact Zander if you would like it increased.';

export async function usageSummary(db: Db, userId: string, workspaceId?: string | null) {
  const state = await allowanceState(db, userId, { workspaceId: workspaceId ?? null });
  const turns = await turnCount(db, userId, state.periodStart, state.periodEnd);
  const message = state.status === 'blocked' || state.status === 'disabled'
    ? blockedMessage(state)
    : state.status === 'warning' ? WARNING
      : state.status === 'notice' ? NOTICE
        : null;
  return {
    ...state,
    turns,
    message,
    thresholds: { ...THRESHOLDS },
    currency: 'USD' as const,
  } satisfies UsageSummary;
}

/**
 * The same, plus the technical detail a curious person can open.
 *
 * Separate call because the overview is on a hot path — it rides along with
 * every turn — and this is not.
 */
export async function usageDetail(db: Db, userId: string, workspaceId?: string | null) {
  const summary = await usageSummary(db, userId, workspaceId);
  const window = { from: summary.periodStart, to: summary.periodEnd };
  const [totals, parts] = await Promise.all([
    totalsForUser(db, userId, window),
    breakdown(db, { userId }, window),
  ]);
  const fx = fxRate();
  return {
    ...summary,
    tokens: {
      input: totals.inputTokens,
      output: totals.outputTokens,
      cacheRead: totals.cacheReadTokens,
      cacheWrite: totals.cacheWriteTokens,
    },
    calls: totals.calls,
    failures: totals.failures,
    /* Named honestly: some rows were priced at a ceiling because the model was
       not in the registry, and a total that quietly mixed the two would be
       presenting an estimate as a measurement. */
    estimatedCalls: totals.estimatedCalls,
    providerCostUsd: totals.providerCostUsd,
    byJob: parts.map((p) => ({
      job: p.job,
      model: p.model,
      calls: p.calls,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      billableCostUsd: p.billableCostUsd,
      billableCostZar: fx ? Math.round(p.billableCostUsd * fx.rate * 1e4) / 1e4 : null,
    })).sort((a, b) => b.billableCostUsd - a.billableCostUsd),
  };
}
