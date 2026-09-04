/**
 * What a model costs, in one place.
 *
 * ── Why a registry and not a constant next to the call ───────────────────
 *
 * A price scattered through application code is a price that is wrong
 * somewhere. Worse, it is a price that gets EDITED — and editing it silently
 * rewrites what last month cost, which is the one thing financial history must
 * never do. So prices are data with an effective date, a usage event records
 * the price it was charged at, and changing this file changes only what
 * happens next.
 *
 * ── What a snapshot is for ───────────────────────────────────────────────
 *
 * Every usage event stores the rates it was computed from. If Anthropic
 * changes pricing tomorrow, yesterday's row still knows what it was charged
 * and why, and an auditor can recompute it without this file. That is the
 * difference between a ledger and a cache.
 *
 * ── The model we do not know ─────────────────────────────────────────────
 *
 * A model that is not listed here is not free, and pretending it is would let
 * somebody spend an unbounded amount against an allowance that never moves.
 * It is charged at the most expensive rate this provider has, marked
 * `estimated`, and reported in Admin so it gets a real entry. Conservative and
 * labelled beats cheap and wrong.
 */

export type Provider = 'anthropic';

/** USD per million tokens. The unit every published price is quoted in. */
export type ModelPrice = {
  provider: Provider;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** Reading a cached prefix. An order of magnitude cheaper than fresh input. */
  cacheReadPerMTok: number;
  /** Writing one. Slightly MORE than input — it is stored as well as read. */
  cacheWritePerMTok: number;
  /** From when these rates apply. Rows before it keep the older entry. */
  effectiveAt: string;
  /** Which published sheet this came from. Recorded on every event. */
  version: string;
};

/**
 * Anthropic's published rates.
 *
 * Cache multipliers are the documented ones — a 5-minute cache write is 1.25×
 * the input rate and a cache read is 0.1× — rather than separately quoted
 * numbers, so a tier change cannot leave the cache rates behind.
 */
const V = 'anthropic-2026-06';
const at = '2026-01-01T00:00:00.000Z';

const tier = (model: string, input: number, output: number): ModelPrice => ({
  provider: 'anthropic',
  model,
  inputPerMTok: input,
  outputPerMTok: output,
  cacheReadPerMTok: +(input * 0.1).toFixed(6),
  cacheWritePerMTok: +(input * 1.25).toFixed(6),
  effectiveAt: at,
  version: V,
});

export const PRICES: ModelPrice[] = [
  /* Fable tier. */
  tier('claude-fable-5-1', 10, 50),
  tier('claude-fable-5', 10, 50),
  /* Opus tier. */
  tier('claude-opus-5', 5, 25),
  tier('claude-opus-4-8', 5, 25),
  tier('claude-opus-4-7', 5, 25),
  tier('claude-opus-4-6', 5, 25),
  /* Sonnet tier. Note 4.6 and 4.5 are dearer than Sonnet 5. */
  tier('claude-sonnet-5', 2, 10),
  tier('claude-sonnet-4-6', 3, 15),
  tier('claude-sonnet-4-5', 3, 15),
  /* Haiku tier — what Life OS uses for interpret and memory extraction. */
  tier('claude-haiku-4-5', 1, 5),
];

/**
 * Match a model id to a price.
 *
 * Dated snapshots (`claude-haiku-4-5-20251001`) are the same model at the same
 * price as the undated id, so the longest registered id that the given model
 * starts with wins. Anything else is unknown.
 */
export function priceFor(
  provider: string, model: string, when: Date = new Date(),
): ModelPrice | null {
  const t = when.getTime();
  const candidates = PRICES.filter((p) => p.provider === provider
    && (p.model === model || model.startsWith(`${p.model}-`))
    && Date.parse(p.effectiveAt) <= t);
  if (!candidates.length) return null;
  /* Longest id first, so `claude-opus-4-8` beats a hypothetical `claude-opus`;
     then the latest effective date that has already started. */
  candidates.sort((a, b) => (b.model.length - a.model.length)
    || (Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt)));
  return candidates[0]!;
}

/** The dearest rate a provider has. What an unknown model is charged at. */
export function ceilingFor(provider: string): ModelPrice | null {
  const own = PRICES.filter((p) => p.provider === provider);
  if (!own.length) return null;
  return own.reduce((worst, p) => (p.outputPerMTok > worst.outputPerMTok ? p : worst));
}

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type Priced = {
  /** USD, exact to ten decimal places. A single Haiku token is 1e-6 USD. */
  usd: number;
  price: ModelPrice;
  /** True when the model was not in the registry and the ceiling was used. */
  estimated: boolean;
  /** What this event was charged at, recorded on the row. */
  snapshot: Record<string, unknown>;
};

const per = (tokens: number, perMTok: number) => (tokens / 1_000_000) * perMTok;

/**
 * What one provider call cost.
 *
 * Note what is NOT here: any notion of what the user should be charged. That
 * is `billable`, decided by policy, and keeping the two apart is what lets a
 * retry be absorbed later without losing what it actually cost us.
 */
export function priceUsage(
  provider: string, model: string, tokens: TokenCounts, when: Date = new Date(),
): Priced | null {
  const exact = priceFor(provider, model, when);
  const price = exact ?? ceilingFor(provider);
  if (!price) return null;
  const usd = per(tokens.inputTokens, price.inputPerMTok)
    + per(tokens.outputTokens, price.outputPerMTok)
    + per(tokens.cacheReadTokens, price.cacheReadPerMTok)
    + per(tokens.cacheWriteTokens, price.cacheWritePerMTok);
  return {
    usd: Math.round(usd * 1e10) / 1e10,
    price,
    estimated: !exact,
    snapshot: {
      provider: price.provider,
      pricedModel: price.model,
      requestedModel: model,
      inputPerMTok: price.inputPerMTok,
      outputPerMTok: price.outputPerMTok,
      cacheReadPerMTok: price.cacheReadPerMTok,
      cacheWritePerMTok: price.cacheWritePerMTok,
      version: price.version,
      effectiveAt: price.effectiveAt,
      ...(exact ? {} : {
        estimated: true,
        why: 'This model is not in the pricing registry; the provider’s '
          + 'most expensive rate was used so the allowance cannot be underspent.',
      }),
    },
  };
}
