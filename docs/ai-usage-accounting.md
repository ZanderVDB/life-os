# AI usage accounting

*Life OS v2. Current as of the pre-beta build.*

The system that answers three questions exactly: what did that turn cost, what
has this person used, and what is Life OS spending in total.

---

## 1. The event model

**One row per real provider request.** Not per user message.

A single message — "book a haircut Saturday and remind me the day before" —
causes an `interpret`, a `plan`, sometimes an `answer`, and a background
`extractMemory`. "What did that turn cost" is unanswerable unless each of them
is written down separately, so each of them is.

`ai_usage_events` (see `api/drizzle/0018_usage_accounting.sql`):

| Column | Why it exists |
|---|---|
| `workspace_id`, `user_id` | Ownership. Both are from the verified token. |
| `conversation_id`, `turn_id` | Attribution. **No foreign key** — a turn can be deleted, what it cost cannot. |
| `provider`, `model`, `job` | Which model did which job. |
| `attempt` | 1 is the first request. Higher is a schema repair, which is a real second cost. |
| `origin` | `user` (charged) or `system` (attributed, not charged). |
| `provider_request_id` | The provider's own id. Globally unique — the strongest idempotency key there is. |
| `request_key` | Ours: `scope:job:attempt:sequence`. Always present. |
| `input/output/cache_read/cache_write_tokens` | All four, from the provider's own `usage` block. |
| `provider_cost_usd` | What Life OS incurred. |
| `billable_cost_usd` | What the user's allowance consumes. |
| `fx_rate_usd_zar`, `*_zar` | The derived rand figure **and the rate that produced it**. |
| `pricing_version`, `pricing_effective_at`, `pricing_snapshot` | What it was charged at. |
| `cost_estimated` | True when the model was not in the registry. |
| `status`, `error_type`, `latency_ms` | Operating detail. |

### The table is append-only

Nothing in `api/src/usage/ledger.ts` updates or deletes an event, and there is
no function there that could. Corrections are `ai_usage_adjustments` rows,
which have their own history. An accounting system whose past can be edited is
evidence of nothing.

---

## 2. How a call is captured

The problem: the only place that knows a request actually happened, and what it
cost in tokens the provider itself reported, is `call()` inside
`api/src/ai/providers/anthropic.ts`. The only place that knows *whose* request
it was is the route, four layers up.

Threading a workspace id down would have put an accounting argument on
`summarise(text)` — exactly the leak the provider contract exists to prevent —
and the adapter is deliberately denied a database handle, so it cannot be the
thing that writes either.

**`AsyncLocalStorage`** (`api/src/usage/meter.ts`) is the answer. `runTurn`
opens a scope; anything it awaits, however deep, can ask which scope it is in.

```
route  →  withMeter({ workspaceId, userId, turnId, budgetUsd })
            └─ runTurn
                 ├─ interpret   → call() → recordCall() ─┐
                 ├─ plan        → call() → recordCall() ─┼→ onCall → recordUsage()
                 ├─ answer      → call() → recordCall() ─┤          (writes immediately)
                 └─ extractMemory → call() → recordCall()┘
```

Two properties worth stating:

* **A call made outside a scope belongs to nobody** and is silently not
  recorded, rather than charged to whoever happened to be last. That is what
  the module-level `lastMetrics` array it replaces did.
* **The turn's id is generated before the first provider call** and used as the
  row's own id when the turn is written. Recording usage after the turn exists
  would lose every event of a turn that FAILS — and a turn that fails after
  three model calls is exactly the one whose cost you want to see.

---

## 3. Pricing

`api/src/usage/pricing.ts`. One registry, with effective dates.

* Rates are **USD per million tokens**, as published.
* Cache rates are derived from the input rate (read = 0.1×, write = 1.25×), so
  a tier change cannot leave them behind.
* A dated snapshot (`claude-haiku-4-5-20251001`) matches the undated id by
  longest prefix — the deployment configures the dated one, and a registry that
  only knew the plain id would have priced every `interpret` at the ceiling.

### Historical usage never changes

Every event stores `pricing_snapshot`: the exact rates it was charged at. An
auditor can recompute the cost from the row alone, without this file and
without trusting it. Editing the registry changes only what happens next.

### A model that is not registered

Charged at the provider's **most expensive** rate, flagged `cost_estimated`, and
surfaced in Admin as "priced at the unknown-model ceiling".

It is not free. Treating an unregistered model as costless would let somebody
spend an unbounded amount against an allowance that never moves. Conservative
and labelled beats cheap and wrong.

---

## 4. Currency

**USD is canonical.** Anthropic bills dollars, the ledger is dollars, and
enforcement happens in the same unit as measurement so it cannot drift.

**ZAR is a presentation**, derived at a configured rate and stored *with that
rate* on every row, so it can always be checked rather than believed.

With `USD_ZAR_RATE` unset:

* USD is tracked and enforced exactly;
* rand simply is not shown;
* nothing is estimated.

A rate outside 1–100 is refused rather than believed — a typo there would
silently misreport every amount in the product. There is deliberately no live
FX feed: a network call on the path of every turn would be a new dependency, a
new failure mode and a new bill, in exchange for precision a two-week soft
budget does not need.

---

## 5. Provider cost vs billable cost

Two columns, identical during beta, separate by design.

* `provider_cost_usd` — what Life OS actually paid.
* `billable_cost_usd` — what this person's allowance consumes.

Keeping them apart is what will later allow an internal retry to be absorbed, a
turn to be credited, or a plan rule to apply — without losing what it really
cost. Collapsing them now would make all three a migration.

---

## 6. Idempotency

Two mechanisms, for two different failures.

| Failure | Caught by |
|---|---|
| Our own write replayed (a retried flush, a duplicated call) | `UNIQUE(request_key)` + `ON CONFLICT DO NOTHING` |
| The same provider response persisted from another process | `UNIQUE(provider, provider_request_id)` |

And the case that must **not** be collapsed: a schema repair asks the model
again. That is a second real request, it carries `attempt = 2`, and it is a
second row — because it was a second cost.

---

## 7. Failures

A call that fails records what failed, and charges nothing:

* zero tokens — there is no usage to report, and estimating one from the prompt
  length would put a guess in a financial record;
* `status = 'failed'` with an `error_type` (`auth`, `rate_limit`, `timeout`,
  `network`, `http_5xx`, …);
* enforced by a **CHECK constraint**, not by trust:
  `status = 'ok' OR (provider_cost_usd = 0 AND billable_cost_usd = 0)`.

A response that arrives and is then rejected for being empty **is** charged —
the provider generated and billed it, and treating a shape failure as free
would understate the bill by exactly the calls that went wrong.

---

## 8. Background work

Memory extraction happens after the answer is on screen and is not awaited. It
is still inside the meter scope — `AsyncLocalStorage` propagates into the
fire-and-forget promise — so it is attributed to the same turn and the same
person.

Work genuinely owned by the system rather than by a person is recorded with
`origin = 'system'`: attributed, so it can be seen, but not charged to anybody.

---

## 9. Aggregation

`api/src/usage/ledger.ts` sums in SQL, never in JavaScript. A user with ten
thousand events costs one round trip.

* `totalsForUser(db, userId, window)` — the number an allowance uses.
* `totalsForAll(db, window)` — the Admin overview.
* `breakdown(db, { userId | turnId }, window)` — the "Plan R0.21" list.
* `recentEvents(db, userId)` — the last twenty, operating detail only.

---

## 10. Tests

`api/tests/usage-accounting.test.ts` — 20 tests, **no real provider calls**.

The seam is `globalThis.fetch`. Everything above it is real: the real adapter
reading a real-shaped response body, the real meter, the real pricing registry,
the real ledger writing to real Postgres (PGlite) through the real constraints.
Stubbing the provider object instead would have tested nothing — the point is
that the *adapter* reads `usage` correctly and that a repair is recognised as a
second cost, and neither of those exists above the HTTP boundary.

Proving pricing arithmetic does not require buying tokens.
