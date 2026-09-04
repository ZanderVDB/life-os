/**
 * THREE real Anthropic turns, and the reconciliation they exist to prove.
 *
 * ── What this is for ─────────────────────────────────────────────────────
 *
 * Every part of the accounting path is already proven against a scripted
 * provider, at the HTTP boundary, in `usage-accounting.test.ts`. What that
 * cannot prove is that the real API returns the shape we parse. This does —
 * once, deliberately, at a cost of a few cents.
 *
 * It is NOT a benchmark. Three turns, each asked once, each asking a different
 * question of the same seam:
 *
 *   1  a simple question       → is one call captured, priced and attributed?
 *   2  a planner request       → do several jobs aggregate to one turn?
 *   3  another interaction     → does usage ADD rather than replace?
 *
 * Then five numbers that must agree:
 *
 *   provider's own `usage` → ledger row → turn aggregation → Admin → Settings
 *
 * Nothing here writes to the ledger, edits a row, or adjusts a total to make
 * them match. If they disagree, that is the finding.
 *
 *   node --env-file-if-exists=api/.env api/node_modules/tsx/dist/cli.mjs \
 *        api/tests/live-server.ts &
 *   node api/tests/live-accounting.mjs
 */
const API = process.env.LOS_API ?? 'http://127.0.0.1:8080';
const TOKEN = 'dev-verify-token';
const TODAY = '2026-09-04';

/* Reconcile what is already recorded, and make no provider calls at all.
   Used to re-check the arithmetic after a harness fix without buying three
   more turns. */
const VERIFY_ONLY = process.argv.includes('--verify-only');

const money = (n) => `$${Number(n).toFixed(6)}`;
const rand = (n) => (n === null || n === undefined ? '—' : `R${Number(n).toFixed(4)}`);

const req = async (method, path, body, extra = {}) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};

const line = (s = '') => console.log(s);

/**
 * Wait until no new usage row has appeared for a while.
 *
 * Returns as soon as the count has been stable for two consecutive checks, and
 * gives up after ten seconds — a turn that is still writing rows after that is
 * a finding, not something to wait longer for.
 */
async function settle(quietMs = 1500, capMs = 12000) {
  const started = Date.now();
  let last = -1;
  let stableSince = 0;
  for (;;) {
    const r = await fetch(`${API}/api/v1/admin/users/${USER}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const n = (await r.json()).usage.calls;
    if (n === last) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= quietMs) return n;
    } else {
      last = n;
      stableSince = 0;
    }
    if (Date.now() - started > capMs) return n;
    await new Promise((res) => { setTimeout(res, 400); });
  }
}
const rule = (t) => { line(); line(`══ ${t} ${'═'.repeat(Math.max(0, 66 - t.length))}`); };

/* ══ Setup ═══════════════════════════════════════════════════════════════ */

const me = await req('GET', '/api/v1/me');
if (me.status !== 200) throw new Error(`/me returned ${me.status}: ${me.text}`);
const WS = me.json.workspace.id;
const USER = me.json.user.id;

const version = await req('GET', '/health/version');
line(`API build      ${version.json.build}`);
line(`assistant      configured=${version.json.assistant.configured}`);
line(`beta config    admins=${version.json.beta.adminsConfigured} `
  + `fx=${version.json.beta.fxRate} allowance=$${version.json.beta.defaultAllowanceUsd}`);
line(`user           ${me.json.user.email}  ws=${WS.slice(0, 8)}`);

if (!version.json.assistant.configured) {
  throw new Error('No model is configured — there is nothing to spend. '
    + 'Run with --env-file-if-exists=api/.env');
}
const FX = version.json.beta.fxRate;

/* A clean slate for the three turns, so the arithmetic is unambiguous. This is
   a fresh PGlite database per run; the seeded fortnight is removed rather than
   worked around, because "usage increments" is only checkable from a known
   starting point. */
const before = await req('GET', `/api/v1/workspaces/${WS}/ai/usage`);
if (VERIFY_ONLY) line('MODE: --verify-only — no provider calls will be made.');
line(`starting usage ${money(before.json.usedUsd)} of `
  + `${before.json.allowanceUsd === null ? 'unlimited' : money(before.json.allowanceUsd)}`);

/* ══ The turns ═══════════════════════════════════════════════════════════ */

const TURNS = VERIFY_ONLY ? [] : [
  {
    n: 1,
    label: 'a simple question',
    text: 'What tasks do I have today?',
  },
  {
    n: 2,
    label: 'a planner request, which causes several jobs',
    /* Safe and disposable: it proposes, and nothing is confirmed, so no row is
       created in the workspace. The proposal is discarded afterwards. */
    text: 'Add a task called Delete me after the beta test, due Friday, '
      + 'and remind me about it on Thursday.',
  },
  {
    n: 3,
    label: 'another ordinary interaction',
    text: 'What is on my calendar this week?',
  },
];

const results = [];
let runningLedgerUsd = 0;

for (const t of TURNS) {
  rule(`TURN ${t.n} — ${t.label}`);
  line(`asked: "${t.text}"`);

  const usageBefore = await req('GET', `/api/v1/workspaces/${WS}/ai/usage`);
  const started = Date.now();
  const r = await req('POST', `/api/v1/workspaces/${WS}/ai/turn`,
    { text: t.text, today: TODAY, timeZone: 'Africa/Johannesburg' });
  const ms = Date.now() - started;

  if (r.status !== 200) {
    line(`FAILED ${r.status}: ${r.text.slice(0, 400)}`);
    results.push({ ...t, failed: true, status: r.status, body: r.text });
    continue;
  }
  const turnId = r.json.turnId;
  line(`turnId ${turnId}  status=${r.json.status}  ${ms}ms`);
  line(`understood: ${JSON.stringify(r.json.understood)}`);
  if (r.json.answer) line(`answer: ${JSON.stringify(String(r.json.answer).slice(0, 160))}`);
  if (r.json.actions?.length) {
    line(`proposed ${r.json.actions.length} action(s): `
      + r.json.actions.map((a) => a.capability).join(', '));
  }

  /* ── Wait for the turn to SETTLE, not for a fixed interval ────────
   *
   * This is where the first run of this harness reported a discrepancy that
   * turned out to be its own. Memory extraction is fired and deliberately not
   * awaited — the user should not wait for it — and when it needs a schema
   * repair it makes a SECOND call that can land a second or two after the
   * answer. A fixed 2.5s snapshot caught three of turn 2's four rows, then
   * read the running total after the fourth had arrived, and the difference
   * looked like an accounting error.
   *
   * So: poll until the row count stops moving. The instrument has to be at
   * least as trustworthy as the thing it is measuring. */
  await settle();

  /* ── The ledger, straight from the admin detail (same rows, per job) ── */
  const detail = await req('GET', `/api/v1/admin/users/${USER}`);
  const rows = detail.json.usage.recent.filter((e) => e.turnId === turnId);

  line();
  line('  ledger rows for this turn:');
  line('    job            model                    att  in     out   cache_r cache_w  cost');
  let turnUsd = 0;
  for (const e of rows) {
    turnUsd += Number(e.billableCostUsd);
    line(`    ${String(e.job).padEnd(14)} ${String(e.model).padEnd(24)} `
      + `${String(e.attempt).padEnd(4)} ${String(e.inputTokens).padEnd(6)} `
      + `${String(e.outputTokens).padEnd(5)} ${'—'.padEnd(7)} ${'—'.padEnd(7)} `
      + `${money(e.billableCostUsd)}`);
  }
  runningLedgerUsd += turnUsd;
  line(`    turn total: ${money(turnUsd)}  ${FX ? rand(turnUsd * FX) : ''}`);

  /* Discard turn 2's proposal so nothing is left in the workspace. */
  if (r.json.actions?.length) {
    const d = await req('POST', `/api/v1/workspaces/${WS}/ai/turn/${turnId}/discard`);
    line(`  proposal discarded (${d.status}) — nothing was created`);
  }

  const usageAfter = await req('GET', `/api/v1/workspaces/${WS}/ai/usage`);
  line(`  user usage: ${money(usageBefore.json.usedUsd)} → ${money(usageAfter.json.usedUsd)} `
    + `(+${money(usageAfter.json.usedUsd - usageBefore.json.usedUsd)})`);

  results.push({
    ...t, turnId, rows, turnUsd,
    usedBefore: usageBefore.json.usedUsd,
    usedAfter: usageAfter.json.usedUsd,
    calls: rows.length,
  });
}

/* ══ Reconciliation ══════════════════════════════════════════════════════ */

rule('RECONCILIATION');

/* 1 · Every row, straight from the ledger. In a normal run that is the three
      turns this script just made; in --verify-only it is whatever is there. */
const detail = await req('GET', `/api/v1/admin/users/${USER}`);
const turnIds = VERIFY_ONLY
  ? [...new Set(detail.json.usage.recent.map((e) => e.turnId))]
  : results.filter((r) => !r.failed).map((r) => r.turnId);
const all = detail.json.usage.recent.filter((e) => turnIds.includes(e.turnId));
const ledgerUsd = all.reduce((n, e) => n + Number(e.billableCostUsd), 0);

/* The per-turn totals, recomputed from the ledger rather than from the
   snapshot taken while the turn was still finishing. */
const perTurn = new Map();
for (const e of all) {
  perTurn.set(e.turnId, (perTurn.get(e.turnId) ?? 0) + Number(e.billableCostUsd));
}
if (VERIFY_ONLY) {
  runningLedgerUsd = [...perTurn.values()].reduce((n, v) => n + v, 0);
  line();
  line('per turn, from the ledger:');
  for (const [id, usd] of perTurn) {
    const n = all.filter((e) => e.turnId === id).length;
    line(`  ${id.slice(0, 8)}  ${String(n).padStart(2)} calls  ${money(usd)}`);
  }
}

/* 2 · The turn aggregation, per job, as Admin's "where it went" builds it. */
const byJob = new Map();
for (const e of all) {
  const at = byJob.get(e.job) ?? { calls: 0, input: 0, output: 0, usd: 0, models: new Set() };
  at.calls += 1;
  at.input += e.inputTokens;
  at.output += e.outputTokens;
  at.usd += Number(e.billableCostUsd);
  at.models.add(e.model);
  byJob.set(e.job, at);
}

/* 3 · Admin's own totals, and 4 · the user's own Settings figure. */
const admin = await req('GET', '/api/v1/admin/overview');
const usage = await req('GET', `/api/v1/workspaces/${WS}/ai/usage`);

line();
line('per job (this run):');
line('  job            calls  input     output   models                    cost');
let sumIn = 0; let sumOut = 0;
for (const [job, v] of [...byJob].sort((a, b) => b[1].usd - a[1].usd)) {
  sumIn += v.input; sumOut += v.output;
  line(`  ${job.padEnd(14)} ${String(v.calls).padEnd(6)} `
    + `${String(v.input).padEnd(9)} ${String(v.output).padEnd(8)} `
    + `${[...v.models].join(',').padEnd(25)} ${money(v.usd)}`);
}

line();
line('the five numbers that must agree:');
line(`  1 ledger rows (sum of ${all.length})     ${money(ledgerUsd)}`);
line(`  2 turn aggregation (sum of 3 turns) ${money(runningLedgerUsd)}`);
line(`  3 admin all-time spend              ${money(admin.json.spend.allTime.usd)}`
  + `  ${rand(admin.json.spend.allTime.zar)}`);
line(`  4 user Settings "used"              ${money(usage.json.usedUsd)}`
  + `  ${rand(usage.json.zar?.used)}`);
line(`  5 user Settings billable total      ${money(usage.json.byJob.reduce((n, j) => n + j.billableCostUsd, 0))}`);

const near = (a, b) => Math.abs(a - b) < 1e-9;
const checks = [
  ['ledger rows === turn aggregation', near(ledgerUsd, runningLedgerUsd)],
  ['ledger rows === admin all-time', near(ledgerUsd, admin.json.spend.allTime.usd)],
  ['ledger rows === user Settings used', near(ledgerUsd, usage.json.usedUsd)],
  ['user byJob sum === user used',
    near(usage.json.byJob.reduce((n, j) => n + j.billableCostUsd, 0), usage.json.usedUsd)],
  ['admin call count === ledger row count',
    admin.json.activity.providerCallsAllTime === all.length],
];

/* ZAR is derived, and is checked against the rate the server actually stored
   rather than recomputed from a rate this script chose. */
if (FX) {
  checks.push([`zar === usd x ${FX} (admin)`,
    Math.abs(admin.json.spend.allTime.zar - admin.json.spend.allTime.usd * FX) < 1e-4]);
  checks.push([`zar === usd x ${FX} (user)`,
    Math.abs(usage.json.zar.used - usage.json.usedUsd * FX) < 1e-4]);
}

line();
for (const [what, ok] of checks) line(`  ${ok ? 'OK  ' : 'FAIL'}  ${what}`);

/* ══ Increment, not replacement ══════════════════════════════════════════ */

rule('USAGE INCREMENTED RATHER THAN REPLACED');
let rising = true;
if (VERIFY_ONLY) {
  /* Nothing was asked, so there is nothing to increment. The three deltas from
     the run that produced these rows are in that run's own output. */
  line('  (--verify-only: no turns were made)');
}
for (const r of results.filter((x) => !x.failed)) {
  const delta = r.usedAfter - r.usedBefore;
  const ok = delta > 0 && Math.abs(delta - r.turnUsd) < 1e-9;
  if (!ok) rising = false;
  line(`  turn ${r.n}: ${money(r.usedBefore)} → ${money(r.usedAfter)} `
    + `(+${money(delta)}, turn cost ${money(r.turnUsd)}) ${ok ? 'OK' : 'MISMATCH'}`);
}
line(`  monotonic and additive: ${rising ? 'yes' : 'NO'}`);

rule('ALLOWANCE');
line(`  allowance   ${money(usage.json.allowanceUsd)}  ${rand(usage.json.zar?.allowance)}`);
line(`  used        ${money(usage.json.usedUsd)}  ${rand(usage.json.zar?.used)}`);
line(`  remaining   ${money(usage.json.remainingUsd)}  ${rand(usage.json.zar?.remaining)}`);
line(`  percent     ${(usage.json.fraction * 100).toFixed(4)}%`);
line(`  status      ${usage.json.status}`);
line(`  turns       ${usage.json.turns}`);

rule('TOTALS FOR THE REPORT');
line(`  real provider calls   ${all.length}`);
line(`  input tokens          ${sumIn}`);
line(`  output tokens         ${sumOut}`);
line(`  cache read / write    ${usage.json.tokens.cacheRead} / ${usage.json.tokens.cacheWrite}`);
line(`  provider cost USD     ${money(ledgerUsd)}`);
line(`  stored ZAR            ${rand(FX ? ledgerUsd * FX : null)}  (rate ${FX ?? 'not configured'})`);
line(`  failures              ${usage.json.failures}`);
line(`  estimated-price calls ${usage.json.estimatedCalls}`);

const bad = checks.filter(([, ok]) => !ok);
line();
line(bad.length === 0 && rising
  ? 'RECONCILES EXACTLY.'
  : `DISCREPANCY: ${bad.map(([w]) => w).join('; ')}${rising ? '' : '; usage did not increment'}`);
process.exit(bad.length === 0 && rising ? 0 : 1);
