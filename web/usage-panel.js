/**
 * "How much of the assistant have I used?" — answered in one sentence.
 *
 * ── What leads, and why ──────────────────────────────────────────────────
 *
 * "R28.40 of R200 · 14%". Not "2,387,124 tokens", which is true, occasionally
 * interesting, and answers no question anybody has ever actually had. Tokens
 * are recorded and shown — behind a details section, where somebody curious
 * can find them and nobody else has to.
 *
 * ── Nothing here is calculated ───────────────────────────────────────────
 *
 * Every number, the percentage, the warning level and whether the assistant
 * is available at all arrive from the server. This file formats them. A
 * browser that could work out its own allowance is a browser that could be
 * persuaded it had a bigger one.
 *
 * ── The tone of a warning ────────────────────────────────────────────────
 *
 * At 70% a quiet line. At 90% an amber one. Red only when the assistant has
 * actually stopped — because red for "you are nearly there" trains people to
 * ignore red, and then it is worth nothing on the day it matters.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (n) => {
  const x = Number(n ?? 0);
  if (!Number.isFinite(x)) return '0.00';
  return Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2);
};

/** Rand when the server gave us a rate, dollars otherwise. Never invented. */
const cash = (usd, zar) => (zar === null || zar === undefined
  ? `$${num(usd)}` : `R${num(zar)}`);

const day = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

const TONE = {
  ok: 'ok', unlimited: 'ok', notice: 'notice', warning: 'warn',
  blocked: 'stop', disabled: 'stop',
};

/**
 * The whole panel.
 *
 * @param u the server's usage detail, or null while it is loading
 */
export function usagePanelHtml(u) {
  if (u === null || u === undefined) {
    return `<div class="use-panel"><p class="set-empty">Loading…</p></div>`;
  }

  const tone = TONE[u.status] ?? 'ok';
  const unlimited = u.allowanceUsd === null;
  const zar = u.zar;
  const usedText = cash(u.usedUsd, zar?.used);
  const allowText = unlimited ? null : cash(u.allowanceUsd, zar?.allowance);
  const leftText = unlimited || u.remainingUsd === null
    ? null : cash(u.remainingUsd, zar?.remaining);
  const percent = u.fraction === null ? null : Math.round(u.fraction * 100);
  const from = day(u.periodStart);
  const to = day(u.periodEnd);

  return `<div class="use-panel is-${tone}">
    <div class="use-headline">
      <span class="use-big">${esc(usedText)}</span>
      ${allowText ? `<span class="use-of">of ${esc(allowText)}</span>` : `<span class="use-of">used</span>`}
      ${percent === null ? '' : `<span class="use-pct">${percent}%</span>`}
    </div>

    ${unlimited ? '' : `<div class="use-bar" role="img"
      aria-label="${percent}% of your AI allowance used">
      <i style="width:${Math.max(0, Math.min(100, percent ?? 0))}%"></i>
    </div>`}

    <p class="use-left">
      ${unlimited ? 'No limit is set on this account.'
    : `${esc(leftText ?? '—')} remaining`}
      ${u.turns ? ` · ${u.turns} assistant turn${u.turns === 1 ? '' : 's'}` : ''}
    </p>

    ${from ? `<p class="use-period">
      ${to ? `Period: ${esc(from)} – ${esc(to)}` : `Counting since ${esc(from)}`}
    </p>` : ''}

    ${u.message ? `<p class="use-msg is-${tone}">${esc(u.message)}</p>` : ''}

    <details class="use-details">
      <summary>Details</summary>
      <div class="use-detail-body">
        <div class="use-facts">
          ${factRow('Assistant turns', String(u.turns ?? 0))}
          ${factRow('Provider calls', String(u.calls ?? 0))}
          ${u.failures ? factRow('Calls that failed', `${u.failures} — these cost nothing`) : ''}
          ${factRow('Input tokens', (u.tokens?.input ?? 0).toLocaleString('en-GB'))}
          ${factRow('Output tokens', (u.tokens?.output ?? 0).toLocaleString('en-GB'))}
          ${u.tokens?.cacheRead
    ? factRow('Cached tokens read', u.tokens.cacheRead.toLocaleString('en-GB')) : ''}
          ${u.tokens?.cacheWrite
    ? factRow('Cached tokens written', u.tokens.cacheWrite.toLocaleString('en-GB')) : ''}
          ${zar ? factRow('Exchange rate used', `R${num(zar.rate)} to the dollar`) : ''}
        </div>

        ${(u.byJob ?? []).length ? `<div class="use-jobs">
          ${u.byJob.map((j) => `<div class="use-job">
            <span class="use-job-n">${esc(JOB_NAMES[j.job] ?? j.job)}</span>
            <span class="use-job-c">${j.calls} call${j.calls === 1 ? '' : 's'}</span>
            <span class="use-job-$">${esc(cash(j.billableCostUsd, j.billableCostZar))}</span>
          </div>`).join('')}
        </div>` : ''}

        ${u.estimatedCalls ? `<p class="use-fine">${u.estimatedCalls} call${
  u.estimatedCalls === 1 ? '' : 's'} could not be priced exactly and
          ${u.estimatedCalls === 1 ? 'was' : 'were'} charged at the highest rate,
          so this figure is an upper bound rather than an exact amount.</p>` : ''}

        <p class="use-fine">Costs are what the AI provider charges Life OS for
          your requests${zar ? ', converted at the rate above' : ''}. They are
          measured from what the provider itself reports, never estimated from
          what you typed.</p>
      </div>
    </details>
  </div>`;
}

const JOB_NAMES = {
  interpret: 'Understanding what you asked',
  plan: 'Working out what to do',
  answer: 'Answering a question',
  summarise: 'Summarising',
  extractMemory: 'Noticing things worth remembering',
};

const factRow = (k, v) => `<div class="use-fact">
  <span class="use-fact-k">${esc(k)}</span>
  <span class="use-fact-v">${esc(v)}</span>
</div>`;

/**
 * The one-line version, for the assistant screen and the shell.
 *
 * Returns null when there is nothing worth saying — which is most of the time,
 * and is the point. A usage warning on every screen at 3% is noise, and noise
 * is what makes the 90% one invisible.
 */
export function usageNoticeHtml(usage) {
  if (!usage?.message) return null;
  const tone = TONE[usage.status] ?? 'ok';
  return `<div class="use-notice is-${tone}" role="status">
    <span>${esc(usage.message)}</span>
  </div>`;
}
