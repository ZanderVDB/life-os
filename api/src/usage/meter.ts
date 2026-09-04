/**
 * Who a provider call belongs to, known at the bottom of the stack.
 *
 * ── The problem ──────────────────────────────────────────────────────────
 *
 * The one place that knows a request was made — and what it actually cost, in
 * tokens the provider itself reported — is `call()` inside the vendor adapter.
 * The one place that knows WHOSE request it was is the route, four layers up.
 * Threading a workspace id down through every provider method would put an
 * accounting argument on `summarise(text)`, which is exactly the kind of leak
 * the provider contract exists to prevent — and the adapter is deliberately
 * denied a database handle, so it cannot be the thing that writes either.
 *
 * `AsyncLocalStorage` is the language's answer to precisely this. The turn
 * opens a scope; anything the turn awaits, however deep, can ask which scope
 * it is in; nothing has to pass it.
 *
 * ── What it is NOT ───────────────────────────────────────────────────────
 *
 * A global. Two concurrent requests get two independent scopes, and a call
 * made outside any scope belongs to nobody and is reported as unattributed
 * rather than charged to whoever happened to be last. That is why this is not
 * the module-level array it replaces.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type UsageOrigin = 'user' | 'system';

/** What one real provider request reported. Facts, not decisions. */
export type CallRecord = {
  provider: string;
  model: string;
  job: string;
  /** 1 is the first request. Higher means a schema repair asked again. */
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The provider's own id, when the response carries one. */
  providerRequestId: string | null;
  status: 'ok' | 'failed';
  errorType: string | null;
  latencyMs: number;
  /** Unique per real provider call, within the scope. */
  seq: number;
};

export type MeterScope = {
  /** Unique to this scope. Part of every request key it produces. */
  scopeId: string;
  workspaceId: string;
  userId: string;
  conversationId: string | null;
  /**
   * Generated BEFORE the first provider call and used as the turn's own id.
   *
   * The alternative was writing the events after the turn row exists, which
   * loses every event of a turn that fails — and a turn that fails after three
   * model calls is exactly the turn whose cost you want to see.
   */
  turnId: string | null;
  origin: UsageOrigin;
  /** Everything recorded so far, in order. */
  calls: CallRecord[];
  /**
   * What this scope may spend, in USD, and what it has.
   *
   * ── Why the check is between calls, not only before the turn ─────────
   *
   * Nobody can know what a call will cost before it returns — the output
   * length is the model's decision, and pretending otherwise would be the
   * dishonest version of a pre-flight check. What can be done is to stop the
   * NEXT call once the line has been crossed, which bounds the overshoot at
   * one request instead of one whole turn.
   *
   * Null is no budget, which is what unlimited and system work both mean.
   */
  budgetUsd?: number | null;
  spentUsd: number;
  exhausted: boolean;
  /** Handed a record the moment it is complete, so nothing waits on the turn. */
  onCall?: (record: CallRecord, scope: MeterScope) => void;
};

const storage = new AsyncLocalStorage<MeterScope>();

export type ScopeInput =
  Omit<MeterScope, 'scopeId' | 'calls' | 'spentUsd' | 'exhausted'>
  & Partial<Pick<MeterScope, 'scopeId'>>;

/** Run `fn` with everything inside it attributed to this owner. */
export function withMeter<T>(input: ScopeInput, fn: (scope: MeterScope) => Promise<T>): Promise<T> {
  const scope: MeterScope = {
    scopeId: input.scopeId ?? randomUUID(),
    workspaceId: input.workspaceId,
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    turnId: input.turnId ?? null,
    origin: input.origin ?? 'user',
    calls: [],
    budgetUsd: input.budgetUsd ?? null,
    spentUsd: 0,
    exhausted: false,
    ...(input.onCall ? { onCall: input.onCall } : {}),
  };
  return storage.run(scope, () => fn(scope));
}

/** The scope this code is running inside, or null. Null is a real answer. */
export const meterScope = (): MeterScope | null => storage.getStore() ?? null;

/**
 * Record one real provider request.
 *
 * Called by the vendor adapter and by nothing else. Outside a scope it is a
 * no-op rather than an error: a provider call made by a script or a test is
 * not a billing event, and throwing here would make accounting able to break
 * the assistant, which is precisely the wrong way round.
 */
export function recordCall(
  record: Omit<CallRecord, 'seq'>,
): CallRecord | null {
  const scope = storage.getStore();
  if (!scope) return null;
  const full: CallRecord = { ...record, seq: scope.calls.length + 1 };
  scope.calls.push(full);
  try { scope.onCall?.(full, scope); } catch { /* accounting never breaks a turn */ }
  return full;
}

/**
 * The idempotency key for one provider call.
 *
 * Scope + job + attempt + sequence. Replaying the same write cannot duplicate
 * a row; a genuine repair has a different `attempt` and is a different row,
 * because it really was a second request and really did cost money.
 */
export const requestKey = (scope: MeterScope, call: CallRecord) =>
  `${scope.scopeId}:${call.job}:${call.attempt}:${call.seq}`;

/**
 * Charge a completed call against the scope's budget.
 *
 * Returns whether the scope is now out. Separate from `recordCall` because the
 * meter deliberately knows nothing about prices — it counts requests; the
 * caller, which owns the pricing registry, decides what they were worth.
 */
export function noteSpend(scope: MeterScope, usd: number): boolean {
  scope.spentUsd += usd;
  if (scope.budgetUsd !== null && scope.budgetUsd !== undefined
    && scope.spentUsd >= scope.budgetUsd) {
    scope.exhausted = true;
  }
  return scope.exhausted;
}

/**
 * Has the current scope run out mid-turn?
 *
 * Read by the vendor adapter immediately before it opens a socket. False
 * outside any scope: a call with no owner has no budget to exceed, and
 * refusing it would make accounting able to break the assistant.
 */
export const overBudget = (): boolean => storage.getStore()?.exhausted === true;

/** Sum of everything in a scope, per job. What "the turn cost R0.34" is made of. */
export function byJob(scope: MeterScope) {
  const out = new Map<string, { calls: number; input: number; output: number }>();
  for (const c of scope.calls) {
    const at = out.get(c.job) ?? { calls: 0, input: 0, output: 0 };
    at.calls += 1;
    at.input += c.inputTokens;
    at.output += c.outputTokens;
    out.set(c.job, at);
  }
  return out;
}
