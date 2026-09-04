/**
 * How much AI a person may use, and what happens when it runs out.
 *
 * ── The rule that outranks everything else here ──────────────────────────
 *
 *   WHEN THE ALLOWANCE IS GONE, THE AI STOPS. LIFE OS DOES NOT.
 *
 * Tasks, Projects, Calendar, Diary, Library, Settings — all of it keeps
 * working. Nothing in this file is reachable from any route except the AI
 * ones, which is the structural reason a spent allowance cannot lock somebody
 * out of their own data rather than merely a promise that it will not.
 *
 * ── Money, not tokens ────────────────────────────────────────────────────
 *
 * The unit is cost. Tokens are a technical detail nobody outside this codebase
 * should have to reason about, and "2,387,124 tokens" answers no question a
 * person actually has. Tokens are still recorded; they are just not the
 * currency of the limit.
 *
 * ── USD, and why ─────────────────────────────────────────────────────────
 *
 * Anthropic bills dollars, the ledger is dollars, and enforcement has to
 * happen in the same unit as the measurement or it drifts every time an
 * exchange rate moves. Rand is what everybody involved thinks in, so it is
 * what the interface shows — converted at a configured rate, and simply
 * absent when no rate has been set. See `fx.ts`.
 *
 * ── A period, not a running total ────────────────────────────────────────
 *
 * "A two-week beta" and "a monthly plan" are the same object with different
 * dates. Building the beta as a special case would mean designing this twice.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiUsagePolicies, users } from '../db/schema.js';
import { allowanceExceeded } from '../lib/errors.js';
import { totalsForUser, adjustmentsTotal, asNumber } from './ledger.js';
import { fxRate, toZar, type FxRate } from './fx.js';
import { priceFor, ceilingFor } from './pricing.js';

/* ══ Configuration — one value, not a number scattered through code ══════ */

/**
 * The default beta allowance, in USD.
 *
 * USD because that is the unit the ledger and the provider both use. The
 * figure everybody says out loud is "about R200"; at a rate around 18 that is
 * roughly $11, and setting `USD_ZAR_RATE` is what makes the rand version
 * appear in the interface. Overridable per deployment, and per TESTER by an
 * admin — this is only what a new account starts with.
 */
export const DEFAULT_BETA_ALLOWANCE_USD = 11;

export function defaultAllowanceUsd(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env['BETA_AI_ALLOWANCE_USD'];
  if (raw !== undefined && raw !== '') {
    /* An explicit "unlimited" has to be sayable, and it is not the same as
       "nothing configured" — one is a decision and the other is an omission. */
    if (raw.toLowerCase() === 'unlimited') return null;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  /* Expressed in rand, which is how the beta is actually talked about. Only
     usable when a rate exists — otherwise there is no honest conversion and
     the USD default stands. */
  const zar = Number(env['BETA_AI_ALLOWANCE_ZAR']);
  const fx = fxRate(env);
  if (Number.isFinite(zar) && zar > 0 && fx) return Math.round((zar / fx.rate) * 1e6) / 1e6;
  return DEFAULT_BETA_ALLOWANCE_USD;
}

/** Where the gentle nudge and the serious warning sit. */
export const THRESHOLDS = { notice: 0.7, warning: 0.9 } as const;

/* ══ The policy row ══════════════════════════════════════════════════════ */

export type Policy = {
  id: string;
  userId: string;
  aiEnabled: boolean;
  /** null is unlimited. Zero is "enabled, nothing left" — a different state. */
  allowanceUsd: number | null;
  periodStart: Date;
  periodEnd: Date | null;
  planId: string | null;
  label: string | null;
};

const shape = (row: any): Policy => ({
  id: row.id,
  userId: row.userId,
  aiEnabled: row.aiEnabled,
  allowanceUsd: row.allowanceUsd === null ? null : asNumber(row.allowanceUsd),
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
  planId: row.planId ?? null,
  label: row.label ?? null,
});

/**
 * The policy in force for a user, created on first sight.
 *
 * Lazily rather than at sign-up, so an account that predates this system gets
 * one the first time anything asks — no backfill migration, and no user
 * without a policy.
 */
export async function policyFor(
  db: Db, userId: string, workspaceId?: string | null,
): Promise<Policy> {
  const [existing] = await db.select().from(aiUsagePolicies)
    .where(eq(aiUsagePolicies.userId, userId)).limit(1);
  if (existing) return shape(existing);

  const allowance = defaultAllowanceUsd();
  /* The period starts when the ACCOUNT did, not when this row happened to be
     created. Starting it at `now()` would exclude everything the account had
     already spent — so a policy row that was ever lost and recreated would
     silently hand somebody a fresh allowance, which is the one way an
     append-only ledger can still be made to lie. */
  const [account] = await db.select({ createdAt: users.createdAt })
    .from(users).where(eq(users.id, userId)).limit(1);
  const periodStart = account?.createdAt && account.createdAt < new Date()
    ? account.createdAt : new Date();

  const [made] = await db.insert(aiUsagePolicies).values({
    userId,
    workspaceId: workspaceId ?? null,
    aiEnabled: true,
    allowanceUsd: allowance === null ? null : allowance.toFixed(10),
    periodStart,
    label: 'beta',
  }).onConflictDoNothing().returning();
  if (made) return shape(made);
  /* Lost a race with a concurrent request. Read the winner. */
  const [now] = await db.select().from(aiUsagePolicies)
    .where(eq(aiUsagePolicies.userId, userId)).limit(1);
  return shape(now);
}

/* ══ Where somebody stands ═══════════════════════════════════════════════ */

export type AllowanceStatus =
  /** No limit set. */
  | 'unlimited'
  /** Switched off by an admin. Not the same as spent. */
  | 'disabled'
  | 'ok'
  /** Past ~70%. A heads-up, not an alarm. */
  | 'notice'
  /** Past ~90%. */
  | 'warning'
  /** Spent. New AI work is refused; the rest of Life OS is untouched. */
  | 'blocked';

export type AllowanceState = {
  status: AllowanceStatus;
  aiEnabled: boolean;
  allowanceUsd: number | null;
  usedUsd: number;
  /** Credits an admin has granted this period. Positive gives more room. */
  adjustmentsUsd: number;
  remainingUsd: number | null;
  /** 0..1 of the allowance consumed, or null when there is no allowance. */
  fraction: number | null;
  periodStart: Date;
  periodEnd: Date | null;
  /** Rand, only when a rate is configured. Never estimated. */
  zar: { rate: number; allowance: number | null; used: number; remaining: number | null } | null;
  /** Assistant turns and provider calls this period. */
  calls: number;
  turns: number;
  policyId: string;
};

export async function allowanceState(
  db: Db, userId: string, opts: { workspaceId?: string | null; fx?: FxRate | null } = {},
): Promise<AllowanceState> {
  const policy = await policyFor(db, userId, opts.workspaceId ?? null);
  const window = { from: policy.periodStart, to: policy.periodEnd };
  const [totals, credits] = await Promise.all([
    totalsForUser(db, userId, window),
    adjustmentsTotal(db, userId, policy.periodStart),
  ]);

  const usedUsd = totals.billableCostUsd;
  const allowanceUsd = policy.allowanceUsd === null ? null : policy.allowanceUsd + credits;
  const remainingUsd = allowanceUsd === null ? null
    : Math.round((allowanceUsd - usedUsd) * 1e10) / 1e10;
  const fraction = allowanceUsd === null || allowanceUsd <= 0
    ? (allowanceUsd === null ? null : 1)
    : Math.min(1, usedUsd / allowanceUsd);

  const status: AllowanceStatus = !policy.aiEnabled ? 'disabled'
    : allowanceUsd === null ? 'unlimited'
      : remainingUsd !== null && remainingUsd <= 0 ? 'blocked'
        : (fraction ?? 0) >= THRESHOLDS.warning ? 'warning'
          : (fraction ?? 0) >= THRESHOLDS.notice ? 'notice'
            : 'ok';

  const fx = opts.fx === undefined ? fxRate() : opts.fx;
  return {
    status,
    aiEnabled: policy.aiEnabled,
    allowanceUsd,
    usedUsd,
    adjustmentsUsd: credits,
    remainingUsd,
    fraction,
    periodStart: policy.periodStart,
    periodEnd: policy.periodEnd,
    zar: fx ? {
      rate: fx.rate,
      allowance: toZar(allowanceUsd ?? 0, fx) === null || allowanceUsd === null
        ? null : toZar(allowanceUsd, fx),
      used: toZar(usedUsd, fx)!,
      remaining: remainingUsd === null ? null : toZar(remainingUsd, fx),
    } : null,
    calls: totals.calls,
    /* A turn is a thing a person did; a call is a thing the system did about
       it. The user-facing number is turns. */
    turns: 0,
    policyId: policy.id,
  };
}

/* ══ The bound on how far past the line one turn can go ══════════════════ */

/**
 * The most one PROVIDER CALL can cost, at the models this deployment uses.
 *
 * ── Why a bound rather than a promise ────────────────────────────────────
 *
 * Nobody can know what a call will cost before it returns; the output length
 * is the model's decision. Pretending otherwise would be the dishonest
 * version of this. What CAN be known is a ceiling: the caps this code sets on
 * `max_tokens`, plus an assumed ceiling on how much context is ever sent.
 *
 * The check runs between calls rather than only before the turn. A turn that
 * crosses the line on its second of four calls is stopped there, so the
 * overshoot is one call rather than one whole turn — roughly a fifth as much.
 */
const INPUT_CEILING_TOKENS = 60_000;
const OUTPUT_CEILING_TOKENS = 4_096;

export function worstCaseCallUsd(model?: string): number {
  const m = model ?? process.env['AI_MODEL_PLAN'] ?? 'claude-sonnet-4-5';
  const price = priceFor('anthropic', m) ?? ceilingFor('anthropic');
  if (!price) return 0;
  return (INPUT_CEILING_TOKENS / 1e6) * price.inputPerMTok
    + (OUTPUT_CEILING_TOKENS / 1e6) * price.outputPerMTok;
}

/** Stated plainly so it can be documented and reported rather than guessed at. */
export const overshootBound = () => ({
  perCallUsd: Math.round(worstCaseCallUsd() * 1e6) / 1e6,
  assumptions: {
    inputCeilingTokens: INPUT_CEILING_TOKENS,
    outputCeilingTokens: OUTPUT_CEILING_TOKENS,
    note: 'A turn is stopped between provider calls, so the most an allowance '
      + 'can be exceeded by is one call at these ceilings.',
  },
});

/* ══ The gate ════════════════════════════════════════════════════════════ */

export class AllowanceBlocked extends Error {
  constructor(readonly state: AllowanceState) {
    super('AI allowance exhausted');
    this.name = 'AllowanceBlocked';
  }
}

/** What a blocked person is told. Written for them, not for an operator. */
export function blockedMessage(state: AllowanceState): string {
  if (!state.aiEnabled) {
    return 'The assistant is switched off for this account. Everything else in '
      + 'Life OS is still available. Contact Zander if that is not expected.';
  }
  return 'You have reached your AI allowance for this period. The rest of Life '
    + 'OS is still available — tasks, projects, calendar, diary and library all '
    + 'work as normal. Contact Zander if you would like your beta allowance '
    + 'increased.';
}

/**
 * May this person start AI work right now?
 *
 * Called BEFORE any provider request, server-side. The browser is never asked
 * and never believed: it renders what this returns.
 */
export async function assertCanUseAi(
  db: Db, userId: string, opts: { workspaceId?: string | null } = {},
): Promise<AllowanceState> {
  const state = await allowanceState(db, userId, opts);
  if (state.status === 'disabled' || state.status === 'blocked') {
    throw allowanceExceeded(blockedMessage(state), {
      status: state.status,
      allowanceUsd: state.allowanceUsd,
      usedUsd: state.usedUsd,
      remainingUsd: state.remainingUsd,
      periodEnd: state.periodEnd,
      zar: state.zar,
    });
  }
  return state;
}

/* ══ Admin-side changes, as data ═════════════════════════════════════════ */

export type PolicyPatch = {
  aiEnabled?: boolean;
  /** null sets unlimited. */
  allowanceUsd?: number | null;
  periodStart?: Date;
  periodEnd?: Date | null;
  label?: string | null;
};

/**
 * Change a policy. Never touches usage.
 *
 * Changing an allowance, an account type or a period must not delete or
 * rewrite a single ledger row: usage is financial history and the reason a
 * number looks the way it does. A period change moves the WINDOW that history
 * is read through; it does not edit the history.
 */
export async function updatePolicy(
  db: Db, userId: string, patch: PolicyPatch,
): Promise<{ before: Policy; after: Policy }> {
  const before = await policyFor(db, userId);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.aiEnabled !== undefined) set['aiEnabled'] = patch.aiEnabled;
  if (patch.allowanceUsd !== undefined) {
    set['allowanceUsd'] = patch.allowanceUsd === null ? null : patch.allowanceUsd.toFixed(10);
  }
  if (patch.periodStart !== undefined) set['periodStart'] = patch.periodStart;
  if (patch.periodEnd !== undefined) set['periodEnd'] = patch.periodEnd;
  if (patch.label !== undefined) set['label'] = patch.label;

  await db.update(aiUsagePolicies).set(set)
    .where(and(eq(aiUsagePolicies.userId, userId), eq(aiUsagePolicies.id, before.id)));
  const after = await policyFor(db, userId);
  return { before, after };
}
