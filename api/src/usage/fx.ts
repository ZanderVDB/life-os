/**
 * USD → ZAR, and the honest refusal to guess.
 *
 * ── Why USD stays canonical ──────────────────────────────────────────────
 *
 * Anthropic bills in dollars. That is what Life OS actually pays, it is exact,
 * and it never moves. Rand is a PRESENTATION of it — useful, because everybody
 * involved thinks in rand, and dangerous, because a converted number that has
 * been stored without the rate it used is a number nobody can ever check
 * again.
 *
 * So: the dollar figure is the record. The rand figure is derived, stored
 * alongside the exact rate that produced it, and never used to reconstruct the
 * dollars.
 *
 * ── Why there is no live rate feed ───────────────────────────────────────
 *
 * A network call to an exchange-rate service on the path of every AI turn is a
 * new dependency, a new failure mode and a new bill, in exchange for accuracy
 * nobody needs — the allowance is a soft budget for a two-week beta, not a
 * settlement. A configured rate, reviewed by a person, is both safer and more
 * truthful about what it is.
 *
 * With no rate configured, everything still works: USD is tracked exactly,
 * allowances denominated in USD are enforced exactly, and rand simply is not
 * shown. It is never invented.
 */

export type FxRate = {
  from: 'USD';
  to: 'ZAR';
  rate: number;
  /** Where this came from, recorded on every event that uses it. */
  source: string;
  setAt: string;
};

const NAME = 'USD_ZAR_RATE';

/**
 * The configured rate, or null.
 *
 * Null is a real answer and every caller handles it. Refusing to convert is
 * correct behaviour; inventing 18.5 because it is roughly right would put a
 * made-up number into a financial record.
 */
export function fxRate(env: NodeJS.ProcessEnv = process.env): FxRate | null {
  const raw = env[NAME];
  if (!raw) return null;
  const rate = Number(raw);
  /* A nonsense rate is worse than none: it would silently misreport every
     amount in the product. Refuse anything outside what a real USD/ZAR rate
     could plausibly be rather than trusting a typo. */
  if (!Number.isFinite(rate) || rate < 1 || rate > 100) return null;
  return {
    from: 'USD',
    to: 'ZAR',
    rate,
    source: env['USD_ZAR_RATE_SOURCE'] || 'configured',
    setAt: env['USD_ZAR_RATE_SET_AT'] || '',
  };
}

/** What an operator has to do to make rand appear. Reported, never guessed. */
export const FX_SETUP = {
  variable: NAME,
  example: '18.20',
  note: 'Set on the API service. Until it is set, every amount is shown and '
    + 'enforced in USD; nothing is estimated.',
} as const;

export const toZar = (usd: number, fx: FxRate | null): number | null =>
  (fx ? Math.round(usd * fx.rate * 1e6) / 1e6 : null);
