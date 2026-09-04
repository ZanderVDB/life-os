-- AI usage accounting, allowances, account types and the admin audit log.
--
-- Entirely ADDITIVE: four new tables and a set of nullable/defaulted columns on
-- `users`. Nothing existing is rewritten, no row is read during the migration,
-- and an older container running against a migrated database keeps working
-- unchanged — it simply does not know these columns exist.
--
-- Money is `numeric`, not a float. A double cannot hold 0.1 exactly, and a
-- ledger that cannot add up its own rows is not a ledger. USD is canonical
-- because that is the currency Anthropic actually bills in; ZAR is a derived
-- presentation stored WITH the rate that produced it, so it can always be
-- checked and never has to be believed.

/* ── The ledger ────────────────────────────────────────────────────────────
 *
 * One row per real provider request. Not per user message — a single message
 * can cause an interpret, a plan, an answer and a memory extraction, and
 * "what did that turn cost" is a question that can only be answered if each
 * of them is written down separately.
 *
 * `turn_id` and `conversation_id` carry NO foreign key on purpose. A turn can
 * be deleted; what it cost cannot. Financial history outlives the thing it
 * was about.
 */
CREATE TABLE IF NOT EXISTS ai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid,
  turn_id uuid,

  provider text NOT NULL,
  model text NOT NULL,
  -- interpret | plan | answer | summarise | extractMemory | …
  job text NOT NULL,
  -- 1 is the first request. Anything higher is a genuine second call to the
  -- provider — a schema repair — and therefore a genuine second cost.
  attempt integer NOT NULL DEFAULT 1,
  -- user  : caused by something a person did, and charged to their allowance.
  -- system: housekeeping with no user waiting. Attributed, never charged.
  origin text NOT NULL DEFAULT 'user',

  -- The provider's own id for this request, when it gives one. Globally
  -- unique, so it makes double-persisting the same response impossible.
  provider_request_id text,
  -- Ours, for when it does not. Unique per real provider call.
  request_key text NOT NULL,

  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,

  -- What Life OS incurred.
  provider_cost_usd numeric(20,10) NOT NULL DEFAULT 0,
  -- What this user's allowance consumes. Identical for beta, deliberately
  -- separate so a retry can be absorbed or a credit given without losing the
  -- true cost.
  billable_cost_usd numeric(20,10) NOT NULL DEFAULT 0,

  fx_rate_usd_zar numeric(20,10),
  provider_cost_zar numeric(20,10),
  billable_cost_zar numeric(20,10),

  pricing_version text NOT NULL,
  pricing_effective_at timestamptz,
  -- The rates this row was charged at. An auditor can recompute the cost from
  -- this alone, without the pricing registry and without trusting it.
  pricing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- True when the model was not in the registry and the dearest rate was used.
  cost_estimated boolean NOT NULL DEFAULT false,

  -- ok | failed. A failed call records why it failed and charges nothing:
  -- there is no usage to report, and inventing one would be inventing money.
  status text NOT NULL DEFAULT 'ok',
  error_type text,
  latency_ms integer,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_usage_events_status_check CHECK (status IN ('ok','failed')),
  CONSTRAINT ai_usage_events_origin_check CHECK (origin IN ('user','system')),
  CONSTRAINT ai_usage_events_attempt_check CHECK (attempt >= 1),
  -- A failed call has no tokens and no cost. Enforced here rather than trusted
  -- to the application, because this is the constraint that keeps a provider
  -- outage from looking like spending.
  CONSTRAINT ai_usage_events_failed_is_free CHECK (
    status = 'ok' OR (provider_cost_usd = 0 AND billable_cost_usd = 0)
  )
);
--> statement-breakpoint

-- Idempotency, twice over.
--
-- `request_key` is ours and always present, so a write replayed by our own
-- code cannot duplicate a row. `provider_request_id` is the provider's and is
-- globally unique, so the same response cannot be persisted twice even from a
-- different process that generated a different key.
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_events_request_key_idx
  ON ai_usage_events (request_key);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_events_provider_request_idx
  ON ai_usage_events (provider, provider_request_id)
  WHERE provider_request_id IS NOT NULL;
--> statement-breakpoint

-- The two questions asked constantly: "what has this user spent this period"
-- and "what did that turn cost".
CREATE INDEX IF NOT EXISTS ai_usage_events_owner_idx
  ON ai_usage_events (user_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_usage_events_workspace_idx
  ON ai_usage_events (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_usage_events_turn_idx
  ON ai_usage_events (turn_id) WHERE turn_id IS NOT NULL;
--> statement-breakpoint

/* ── Allowance ─────────────────────────────────────────────────────────────
 *
 * One live policy per user. Denominated in USD because that is what the ledger
 * is in and what the provider bills; the rand figure everybody talks about is
 * this converted at the configured rate.
 *
 * A PERIOD rather than a running total, so "a two-week beta" and "a monthly
 * plan" are the same object with different dates and no second design.
 */
CREATE TABLE IF NOT EXISTS ai_usage_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,

  ai_enabled boolean NOT NULL DEFAULT true,
  -- NULL means unlimited. Zero means "enabled but with nothing left", which is
  -- a different and useful state.
  allowance_usd numeric(20,10),

  period_start timestamptz NOT NULL DEFAULT now(),
  period_end timestamptz,

  -- Reserved so a paid plan can later grant a policy without a second design.
  -- Nothing reads it yet and nothing may be built on it today.
  plan_id text,
  label text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_policies_user_idx
  ON ai_usage_policies (user_id);
--> statement-breakpoint

/* ── Adjustments ───────────────────────────────────────────────────────────
 *
 * A credit, a waiver, a correction. Its own row rather than an edit to the
 * ledger, because the ledger is append-only and history that can be rewritten
 * is not evidence of anything.
 *
 * Positive amounts INCREASE what is available.
 */
CREATE TABLE IF NOT EXISTS ai_usage_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usd numeric(20,10) NOT NULL,
  reason text NOT NULL,
  -- credit | waiver | correction
  kind text NOT NULL DEFAULT 'credit',
  -- Which admin did it. Null for anything the system did to itself.
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The period this belongs to, so a new period starts clean.
  period_start timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_usage_adjustments_kind_check
    CHECK (kind IN ('credit','waiver','correction'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_usage_adjustments_user_idx
  ON ai_usage_adjustments (user_id, period_start);
--> statement-breakpoint

/* ── Admin audit ───────────────────────────────────────────────────────────
 *
 * Every admin mutation, with what it was before and what it became. An admin
 * who can change somebody's allowance without leaving a trace is an admin
 * nobody can check — including themselves, six weeks later, trying to work out
 * why a tester's numbers look wrong.
 */
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_email text NOT NULL,
  target_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_email text,
  action text NOT NULL,
  before jsonb NOT NULL DEFAULT '{}'::jsonb,
  after jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS admin_audit_log_time_idx
  ON admin_audit_log (created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS admin_audit_log_target_idx
  ON admin_audit_log (target_user_id, created_at DESC);
--> statement-breakpoint

/* ── Account shape on `users` ──────────────────────────────────────────────
 *
 * TWO independent ideas, deliberately not one.
 *
 *   role         — may this person administer Life OS?  user | admin
 *   account_type — what kind of account is this?        beta | tester | standard
 *
 * Collapsing them would make "admin" a kind of subscription, which it is not:
 * an admin is also a beta user, and a paid plan must never be able to grant
 * administrative access. They are separate columns so that confusion is not
 * expressible.
 *
 * The defaults are the safe ones. `role` defaults to 'user': nobody becomes an
 * admin because a column was added.
 */
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'beta';
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_start_at timestamptz;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_end_at timestamptz;
--> statement-breakpoint
-- When they acknowledged the beta introduction. Server-side, so it survives a
-- new device and cannot be skipped by clearing browser storage.
ALTER TABLE users ADD COLUMN IF NOT EXISTS intro_accepted_at timestamptz;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at timestamptz;
--> statement-breakpoint
-- An operator's own note about a tester. Never shown to the tester.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_note text;
--> statement-breakpoint

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','admin'));
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_type_check;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('beta','tester','standard'));
