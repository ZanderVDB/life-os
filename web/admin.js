/**
 * Admin — an operational area inside Life OS, not a second product.
 *
 * ── What this is for ─────────────────────────────────────────────────────
 *
 * Answering four questions quickly: what is this costing, who is close to
 * their limit, what did that person actually use it on, and can I change it
 * without breaking anything. Everything on screen is a number from the
 * ledger. Nothing is sampled, rounded up, or invented.
 *
 * ── Why it looks denser than the rest of Life OS ─────────────────────────
 *
 * Because it is a different kind of looking. Today is a screen you glance at;
 * this is a screen you scan for an outlier. It keeps the same palette, the
 * same typography and the same components, and spends the difference on
 * information density rather than on a new visual language.
 *
 * ── The client decides nothing ───────────────────────────────────────────
 *
 * No number here is computed in the browser. Percentages, remaining balances,
 * statuses and totals all arrive from the server, because a client that can
 * work out an allowance is a client that can be persuaded it has a bigger one.
 * This file renders and posts; it does not reason about money.
 */
import { icon } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Money, in whichever currency the server was able to give us.
 *
 * Rand when a rate is configured, dollars otherwise. Never both at once, and
 * never a rand figure derived here — see `usage/fx.ts` for why an invented
 * exchange rate is worse than none.
 */
export function money(v) {
  if (!v && v !== 0) return '—';
  const { usd, zar } = typeof v === 'object' ? v : { usd: v, zar: null };
  if (zar !== null && zar !== undefined) return `R${fmt(zar)}`;
  return `$${fmt(usd)}`;
}

const fmt = (n) => {
  const x = Number(n ?? 0);
  if (!Number.isFinite(x)) return '0.00';
  if (Math.abs(x) >= 100) return x.toFixed(0);
  if (Math.abs(x) >= 1) return x.toFixed(2);
  return x.toFixed(x === 0 ? 2 : 3);
};

const pct = (f) => (f === null || f === undefined ? '—' : `${Math.round(f * 100)}%`);

const day = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

const ago = (iso) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return '—';
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

/** ok · notice · warning · blocked · disabled · unlimited — the server's word. */
const STATUS = {
  ok: ['ok', 'Healthy'],
  notice: ['warn', 'Over 70%'],
  warning: ['warn', 'Over 90%'],
  blocked: ['stop', 'At limit'],
  disabled: ['off', 'AI off'],
  unlimited: ['ok', 'Unlimited'],
};

const statusChip = (s) => {
  const [tone, label] = STATUS[s] ?? ['off', s ?? '—'];
  return `<span class="adm-chip is-${tone}">${esc(label)}</span>`;
};

const bar = (fraction, status) => {
  const w = Math.max(0, Math.min(1, fraction ?? 0)) * 100;
  const tone = status === 'blocked' ? 'stop'
    : status === 'warning' ? 'warn' : status === 'notice' ? 'notice' : 'ok';
  return `<div class="adm-bar is-${tone}" role="img"
    aria-label="${pct(fraction)} of allowance used">
    <i style="width:${w.toFixed(1)}%"></i></div>`;
};

/* ══ Overview ════════════════════════════════════════════════════════════ */

const stat = (label, value, sub = '') => `<div class="adm-stat">
  <span class="adm-stat-v">${value}</span>
  <span class="adm-stat-l">${esc(label)}</span>
  ${sub ? `<span class="adm-stat-s">${sub}</span>` : ''}
</div>`;

function overviewHtml(state) {
  const o = state.adminOverview;
  if (!o) return `<div class="adm-load">Loading…</div>`;

  /* Anything an operator has to go and do is said out loud rather than left
     to be discovered when a number looks wrong. */
  const todo = [];
  if (!o.config.fxConfigured) {
    todo.push(`Rand is not being shown: set <code>${esc(o.config.fxSetup.variable)}</code>
      on the API service (e.g. <code>${esc(o.config.fxSetup.example)}</code>).
      Everything is tracked and enforced in USD until then — nothing is estimated.`);
  }
  if (o.activity.estimatedPriceCalls > 0) {
    todo.push(`${o.activity.estimatedPriceCalls} provider call${
      o.activity.estimatedPriceCalls === 1 ? ' was' : 's were'} priced at the
      unknown-model ceiling because the model is not in the pricing registry.
      Their cost is an upper bound, not a measurement.`);
  }

  const spark = (state.adminSpend?.days ?? []);
  const peak = Math.max(0.0001, ...spark.map((d) => d.usd));

  return `
    <section class="adm-sec">
      <h3 class="adm-h">Spend</h3>
      <div class="adm-stats">
        ${stat('Today', money(o.spend.today))}
        ${stat('All time', money(o.spend.allTime))}
        ${stat('Provider calls today', o.activity.providerCallsToday)}
        ${stat('Failures today', o.activity.failuresToday,
    o.activity.failuresToday ? 'charged nothing' : '')}
      </div>
      ${spark.length ? `<div class="adm-spark" role="img"
        aria-label="Daily provider spend over the last ${spark.length} days">
        ${spark.map((d) => `<i title="${esc(d.day)}: ${money({ usd: d.usd, zar: d.zar })}"
          style="height:${Math.max(2, (d.usd / peak) * 100).toFixed(1)}%"></i>`).join('')}
      </div>
      <p class="adm-note">Daily provider spend, straight from the usage ledger.</p>` : ''}
    </section>

    <section class="adm-sec">
      <h3 class="adm-h">People</h3>
      <div class="adm-stats">
        ${stat('Accounts', o.users.total)}
        ${stat('Beta', o.users.byAccountType.beta ?? 0)}
        ${stat('Testers', o.users.byAccountType.tester ?? 0)}
        ${stat('Near their limit', o.users.nearLimit)}
        ${stat('At their limit', o.users.atLimit)}
        ${stat('AI switched off', o.users.aiDisabled)}
      </div>
    </section>

    <section class="adm-sec">
      <h3 class="adm-h">Assistant</h3>
      <div class="adm-stats">
        ${stat('Turns', o.activity.assistantTurns)}
        ${stat('Provider calls', o.activity.providerCallsAllTime)}
        ${stat('Failures', o.activity.failuresAllTime)}
        ${stat('Default allowance',
    o.config.defaultAllowanceUsd === null ? 'Unlimited'
      /* In the same currency as every other figure on the page. The rate is
         the server's; if it has none, this falls back to dollars like the
         rest rather than being converted here. */
      : money({
        usd: o.config.defaultAllowanceUsd,
        zar: o.spend.fx ? +(o.config.defaultAllowanceUsd * o.spend.fx.rate).toFixed(2) : null,
      }),
    'what a new account starts with')}
      </div>
      <p class="adm-note">Input ${o.tokens.input.toLocaleString('en-GB')} ·
        output ${o.tokens.output.toLocaleString('en-GB')} ·
        cache read ${o.tokens.cacheRead.toLocaleString('en-GB')} ·
        cache write ${o.tokens.cacheWrite.toLocaleString('en-GB')} tokens.</p>
      <p class="adm-note">A turn is stopped between provider calls, so an
        allowance can be exceeded by at most one request —
        about $${o.config.overshoot.perCallUsd} at the current models.</p>
    </section>

    ${todo.length ? `<section class="adm-sec">
      <h3 class="adm-h">Needs your attention</h3>
      <ul class="adm-todo">${todo.map((t) => `<li>${t}</li>`).join('')}</ul>
    </section>` : ''}`;
}

/* ══ Users ═══════════════════════════════════════════════════════════════ */

function usersHtml(state) {
  const list = state.adminUsers;
  if (!list) return `<div class="adm-load">Loading…</div>`;
  if (!list.length) return `<p class="adm-empty">Nobody has signed in yet.</p>`;

  /* A table on a desktop and a stack of cards on a phone — the SAME markup,
     re-laid-out in CSS. A desktop table squeezed onto a 375px screen is a
     horizontal scroller nobody can read, and a second markup path for phones
     is a second thing to keep correct. */
  return `<div class="adm-table" role="table" aria-label="Life OS accounts">
    <div class="adm-tr adm-thead" role="row">
      <span role="columnheader">Person</span>
      <span role="columnheader">Account</span>
      <span role="columnheader">Allowance</span>
      <span role="columnheader">Used</span>
      <span role="columnheader">Status</span>
      <span role="columnheader">Last active</span>
    </div>
    ${list.map((u) => `<button type="button" class="adm-tr adm-row" role="row"
      data-admin-user="${esc(u.id)}">
      <span class="adm-who" role="cell">
        <span class="adm-name">${esc(u.displayName || u.email)}</span>
        <span class="adm-mail">${esc(u.email)}</span>
      </span>
      <span class="adm-cell" role="cell" data-k="Account">
        <span class="adm-type">${esc(u.accountType)}</span>
        ${u.isAdmin ? `<span class="adm-chip is-admin">admin${
  u.adminViaAllowlist ? ' · config' : ''}</span>` : ''}
      </span>
      <span class="adm-cell" role="cell" data-k="Allowance">${
  u.allowanceUsd === null ? 'Unlimited' : money(u.allowance)}</span>
      <span class="adm-cell" role="cell" data-k="Used">
        ${money(u.used)}
        ${bar(u.fraction, u.status)}
        <small>${pct(u.fraction)}</small>
      </span>
      <span class="adm-cell" role="cell" data-k="Status">${statusChip(u.status)}</span>
      <span class="adm-cell adm-quiet" role="cell" data-k="Last active">${ago(u.lastActiveAt)}</span>
    </button>`).join('')}
  </div>`;
}

/* ══ One person ══════════════════════════════════════════════════════════ */

const field = (label, inner, hint = '') => `<label class="adm-field">
  <span class="adm-field-l">${esc(label)}</span>
  ${inner}
  ${hint ? `<span class="adm-field-h">${hint}</span>` : ''}
</label>`;

function detailHtml(state) {
  const d = state.adminUser;
  if (!d) return `<div class="adm-load">Loading…</div>`;
  const u = d.user;
  const a = d.allowance;
  const usd = (n) => (n === null || n === undefined ? '' : String(n));

  return `
    <header class="adm-detail-head">
      <button type="button" class="adm-back" data-admin-back>
        <span class="adm-back-chev" aria-hidden="true"></span><span>All people</span>
      </button>
      <h3>${esc(u.displayName || u.email)}</h3>
      <p>${esc(u.email)} · joined ${day(u.createdAt)} · last active ${ago(u.lastActiveAt)}</p>
    </header>

    <section class="adm-sec">
      <h3 class="adm-h">This period</h3>
      <div class="adm-stats">
        ${stat('Allowance', a.allowanceUsd === null ? 'Unlimited' : money(a.allowance))}
        ${stat('Used', money(a.used), pct(a.fraction))}
        ${stat('Remaining', a.remainingUsd === null ? '—' : money(a.remaining))}
        ${stat('Status', statusChip(a.status))}
      </div>
      ${bar(a.fraction, a.status)}
      <p class="adm-note">${day(a.periodStart)} → ${a.periodEnd ? day(a.periodEnd) : 'open'}
        · ${d.usage.calls} provider calls
        · ${d.usage.failures} failure${d.usage.failures === 1 ? '' : 's'}
        ${a.adjustmentsUsd ? ` · credits ${money({ usd: a.adjustmentsUsd,
    zar: d.fx ? +(a.adjustmentsUsd * d.fx.rate).toFixed(2) : null })}` : ''}</p>
    </section>

    <section class="adm-sec">
      <h3 class="adm-h">Where it went</h3>
      ${d.usage.byJob.length ? `<div class="adm-jobs">
        ${d.usage.byJob.map((j) => `<div class="adm-job">
          <span class="adm-job-n">${esc(j.job)}</span>
          <span class="adm-job-m">${esc(j.model)}</span>
          <span class="adm-job-c">${j.calls} call${j.calls === 1 ? '' : 's'}</span>
          <span class="adm-job-t">${j.inputTokens.toLocaleString('en-GB')} in ·
            ${j.outputTokens.toLocaleString('en-GB')} out</span>
          <span class="adm-job-$">${money({ usd: j.billableCostUsd, zar: j.zar ?? null })}</span>
        </div>`).join('')}
      </div>` : `<p class="adm-empty">Nothing yet this period.</p>`}
    </section>

    <section class="adm-sec">
      <h3 class="adm-h">Account</h3>
      <form class="adm-form" id="adm-account-form" data-user="${esc(u.id)}">
        <div class="adm-grid">
          ${field('Account type', `<select name="accountType">
            ${['beta', 'tester', 'standard'].map((t) => `<option value="${t}"
              ${u.accountType === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>`, 'Beta is an invited tester. Tester is one of ours.')}

          ${field('Admin', `<select name="role">
            ${['user', 'admin'].map((t) => `<option value="${t}"
              ${u.role === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>`, u.adminViaAllowlist
    ? 'Currently an admin because their address is in ADMIN_EMAILS. That grant is '
      + 'configuration, not a decision recorded here.'
    : 'Whether this person can reach Admin. Nothing to do with their account type.')}

          ${field('AI', `<select name="aiEnabled">
            <option value="true" ${a.aiEnabled ? 'selected' : ''}>On</option>
            <option value="false" ${a.aiEnabled ? '' : 'selected'}>Off</option>
          </select>`, 'Off stops the assistant. The rest of Life OS keeps working.')}

          ${field('Allowance (USD)', `<input type="number" name="allowanceUsd" step="0.01"
            min="0" value="${esc(usd(a.allowanceUsd))}" placeholder="empty = unlimited">`,
    'Leave empty for unlimited. Changing this never touches what has been spent.')}

          ${field('Beta starts', `<input type="date" name="betaStartAt"
            value="${u.betaStartAt ? new Date(u.betaStartAt).toISOString().slice(0, 10) : ''}">`)}

          ${field('Beta ends', `<input type="date" name="betaEndAt"
            value="${u.betaEndAt ? new Date(u.betaEndAt).toISOString().slice(0, 10) : ''}">`)}
        </div>

        ${field('Note (only you see this)', `<textarea name="adminNote" rows="2"
          placeholder="Anything worth remembering about this tester">${esc(u.adminNote ?? '')}</textarea>`)}

        <div class="adm-actions">
          <button type="submit" class="btn btn-primary">Save changes</button>
          <span class="adm-said" id="adm-account-said" role="status"></span>
        </div>
      </form>
    </section>

    <section class="adm-sec">
      <h3 class="adm-h">Add allowance</h3>
      <form class="adm-form" id="adm-credit-form" data-user="${esc(u.id)}">
        <div class="adm-grid">
          ${field('Amount (USD)', `<input type="number" name="amountUsd" step="0.01"
            placeholder="e.g. 5" required>`,
    'A credit is added to this period. It is a record of its own — it does not '
    + 'change the allowance and it does not rewrite what has been used.')}
          ${field('Reason', `<input type="text" name="reason" maxlength="500"
            placeholder="Why" required>`)}
        </div>
        <div class="adm-actions">
          <button type="submit" class="btn">Add credit</button>
          <button type="button" class="btn btn-quiet" id="adm-new-period">Start a new period</button>
          <span class="adm-said" id="adm-credit-said" role="status"></span>
        </div>
      </form>
      <p class="adm-note">Starting a new period moves the window usage is counted
        in. It does not delete a single usage record — history is why a number
        looks the way it does.</p>
    </section>

    ${d.adjustments.length ? `<section class="adm-sec">
      <h3 class="adm-h">Credits</h3>
      <div class="adm-log">
        ${d.adjustments.map((c) => `<div class="adm-log-row">
          <span class="adm-log-t">${day(c.createdAt)}</span>
          <span class="adm-log-a">${esc(c.kind)} ${money({ usd: c.amountUsd,
    zar: d.fx ? +(c.amountUsd * d.fx.rate).toFixed(2) : null })}</span>
          <span class="adm-log-d">${esc(c.reason)}</span>
        </div>`).join('')}
      </div>
    </section>` : ''}

    ${d.usage.recent.length ? `<section class="adm-sec">
      <h3 class="adm-h">Recent provider calls</h3>
      <div class="adm-log">
        ${d.usage.recent.map((e) => `<div class="adm-log-row">
          <span class="adm-log-t">${ago(e.createdAt)}</span>
          <span class="adm-log-a">${esc(e.job)}${e.attempt > 1 ? ` · try ${e.attempt}` : ''}</span>
          <span class="adm-log-d">${esc(e.model)}
            ${e.status === 'failed' ? `<span class="adm-chip is-stop">${esc(e.errorType ?? 'failed')}</span>` : ''}
            ${e.costEstimated ? `<span class="adm-chip is-warn">estimated price</span>` : ''}</span>
          <span class="adm-log-$">${e.status === 'failed' ? '—'
    : money({ usd: e.billableCostUsd,
      zar: d.fx ? +(e.billableCostUsd * d.fx.rate).toFixed(4) : null })}</span>
        </div>`).join('')}
      </div>
    </section>` : ''}

    ${d.audit.length ? `<section class="adm-sec">
      <h3 class="adm-h">What has been changed</h3>
      <div class="adm-log">
        ${d.audit.map((e) => `<div class="adm-log-row">
          <span class="adm-log-t">${day(e.createdAt)}</span>
          <span class="adm-log-a">${esc(e.actorEmail)}</span>
          <span class="adm-log-d">${esc(e.action)} —
            ${esc(JSON.stringify(e.before))} → ${esc(JSON.stringify(e.after))}
            ${e.note ? `<em>${esc(e.note)}</em>` : ''}</span>
        </div>`).join('')}
      </div>
    </section>` : ''}`;
}

/* ══ Audit ═══════════════════════════════════════════════════════════════ */

function auditHtml(state) {
  const entries = state.adminAudit;
  if (!entries) return `<div class="adm-load">Loading…</div>`;
  if (!entries.length) {
    return `<p class="adm-empty">No admin changes have been made yet.</p>`;
  }
  return `<div class="adm-log">
    ${entries.map((e) => `<div class="adm-log-row">
      <span class="adm-log-t">${day(e.createdAt)}</span>
      <span class="adm-log-a">${esc(e.actorEmail)}</span>
      <span class="adm-log-d">${esc(e.action)}
        ${e.targetEmail ? `→ ${esc(e.targetEmail)}` : ''}
        <code>${esc(JSON.stringify(e.before))}</code> →
        <code>${esc(JSON.stringify(e.after))}</code>
        ${e.note ? `<em>${esc(e.note)}</em>` : ''}</span>
    </div>`).join('')}
  </div>`;
}

/* ══ The shell ═══════════════════════════════════════════════════════════ */

export const ADMIN_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'People' },
  { id: 'audit', label: 'Changes' },
];

export function adminHtml(state) {
  /* ── Refused ──────────────────────────────────────────────────────
     Somebody typed the address, or followed an old link. The server has
     already said no; this is only what that looks like. Deliberately plain:
     no explanation of what Admin contains, because describing what somebody
     cannot reach is describing what exists. */
  if (state.adminDenied) {
    return `<div class="adm adm-denied">
      <h2>Not available</h2>
      <p>This part of Life OS is not available on your account.</p>
      <button type="button" class="btn btn-primary" data-admin-exit>Back to Life OS</button>
    </div>`;
  }
  const tab = state.adminTab ?? 'overview';
  const body = state.adminUserId && tab === 'users' ? detailHtml(state)
    : tab === 'users' ? usersHtml(state)
      : tab === 'audit' ? auditHtml(state)
        : overviewHtml(state);

  return `<div class="adm">
    <header class="adm-head">
      <div class="adm-title">
        <h2>Admin</h2>
        <p>Usage, spend and accounts. Every figure comes from the usage ledger.</p>
      </div>
      <button type="button" class="btn btn-quiet adm-exit" data-admin-exit>
        ${icon('chevL', 16)}<span>Back to Life OS</span>
      </button>
    </header>
    <nav class="adm-tabs" aria-label="Admin sections">
      ${ADMIN_TABS.map((t) => `<button type="button" data-admin-tab="${t.id}"
        ${tab === t.id ? 'aria-current="page"' : ''}>${t.label}</button>`).join('')}
    </nav>
    <div class="adm-body">${body}</div>
  </div>`;
}
