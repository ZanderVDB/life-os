# Allowances, admin and the beta

*Life OS v2. Current as of the pre-beta build.*

Companion to [`ai-usage-accounting.md`](./ai-usage-accounting.md), which covers
how spend is measured. This covers what is done with it.

---

## 1. Allowances

### The rule that outranks everything else

> **When the allowance is gone, the AI stops. Life OS does not.**

Tasks, Projects, Calendar, Diary, Library, Settings — all of it keeps working.
This is structural rather than a promise: `assertCanUseAi` is reachable from
the AI routes and from nowhere else, so a spent allowance *cannot* lock somebody
out of their own data.

`api/tests/usage-limits.test.ts` asserts it directly: with the assistant
returning 402, every other route and creating a task by hand are all checked to
still work.

### Money, not tokens

The unit is cost. Tokens are recorded and available; they are not the currency
of the limit, because "2,387,124 tokens" answers no question anybody has.

Denominated in **USD**, because that is what the ledger and the provider both
use and enforcement must happen in the same unit as measurement. Rand is what
the interface shows, at the configured rate.

### A period, not a running total

`ai_usage_policies` holds one live policy per user:

| Field | Meaning |
|---|---|
| `ai_enabled` | Off is an admin decision. Different from spent. |
| `allowance_usd` | `NULL` is unlimited. `0` is "enabled, nothing left" — a different state. |
| `period_start`, `period_end` | The window usage is counted in. |
| `plan_id` | Reserved. Nothing reads it. See §5. |

"A two-week beta" and "a monthly plan" are the same object with different
dates. Building the beta as a special case would have meant designing this
twice.

A policy is created **lazily**, on first sight, and its period starts when the
**account** did — not when the row happened to be created. Otherwise a policy
row that was ever lost and recreated would silently hand somebody a fresh
allowance, which is the one way an append-only ledger can still be made to lie.

### The default

One value: `BETA_AI_ALLOWANCE_USD`, default **$11** (about R200 at 18.2).
`BETA_AI_ALLOWANCE_ZAR` is also accepted and used *only when a rate is
configured* — with no rate there is no honest conversion, so the USD default
stands rather than a made-up number. `unlimited` is a sayable value, and is not
the same as leaving it unset.

An admin can change any individual tester's allowance; this is only what a new
account starts with.

### Thresholds

| Fraction used | Status | What the person sees |
|---|---|---|
| < 0.70 | `ok` | Nothing. |
| ≥ 0.70 | `notice` | A quiet line. |
| ≥ 0.90 | `warning` | An amber line. |
| ≥ 1.00 | `blocked` | The assistant stops, with an explanation. |
| — | `unlimited` | No limit set. |
| — | `disabled` | Switched off by an admin. |

Red is used **only** when the assistant has actually stopped. Red for "nearly
there" trains people to ignore red, and then it is worth nothing on the day it
matters.

The server decides all of these. The browser renders what it is told and never
derives a limit — see §4.

### Enforcement, and the overshoot

Two checks:

1. **Before the turn.** `assertCanUseAi` runs server-side in the route, before
   any provider work. Blocked → `402 AI_ALLOWANCE_EXCEEDED` with the numbers.
2. **Between calls.** The remaining balance travels with the meter scope as a
   budget. After each completed call the spend is charged against it, and the
   *next* provider call is refused once the line is crossed.

Nobody can know what a call will cost before it returns — the output length is
the model's decision, and pretending otherwise would be the dishonest version
of a pre-flight check. So instead the overshoot is **bounded**:

> **Maximum overspend: one provider call.**
> At the configured models, about **$0.24** (≈ R4.40), from a ceiling of
> 60,000 input and 4,096 output tokens. `overshootBound()` computes and reports
> it; the Admin overview prints it.

Without the between-calls check the bound would have been a whole turn — four
to six calls, roughly five times as much.

### The refusal

`402` with code `AI_ALLOWANCE_EXCEEDED`, `details` carrying the figures, and a
sentence written for a person:

> You have reached your AI allowance for this period. The rest of Life OS is
> still available — tasks, projects, calendar, diary and library all work as
> normal. Contact Zander if you would like your beta allowance increased.

No mention of upgrading or buying, because there is nothing to buy yet. On the
assistant screen this is a **persistent state** under the orb, not a toast: the
assistant will keep refusing until something changes, and somebody who looks
away for four seconds should not have to send again to find out why.

### Credits

`ai_usage_adjustments` — a row, never an edit. Positive amounts increase what is
available for the period. Granting one is proven not to alter a single usage
event.

---

## 2. Admin

### Authorisation

Two independent ideas, deliberately not one:

```
role          may this person administer Life OS?   user | admin
account_type  what kind of account is this?         beta | tester | standard
```

An admin is also a beta user. **A paid plan must never be able to grant
administrative access** — and the only way to guarantee that is for them not to
be the same field.

There is **no second login**. The identity is the same verified
Google/Firebase identity every other request uses; being an admin is a property
of that identity. A homemade credential beside a working identity provider is a
second thing to get wrong and the only one an attacker would bother with.

### Bootstrap

`ADMIN_EMAILS` — a comma-separated allowlist on the API service, **with no
default**. A deployment that forgets it has no admins at all rather than an
accidental one.

It is evaluated **live and never written to the `role` column**. If it were
persisted, removing an address would leave the access behind and the operator
would believe they had revoked something they had not. Explicit promotions do
write the column, because those are decisions rather than configuration.

`isAdmin = role === 'admin' || allowlist.has(email)`.

### The guard

Every admin route runs `requireAdmin` server-side, after `authenticate`. A
normal signed-in user calling any of them gets a plain `403` with no detail —
telling somebody why they were refused is telling them what exists. Typing
`#admin` in the browser reaches a screen that says "Not available".

### What Admin shows

Straight from the ledger. No sampled analytics, no estimates, no rounded-up
vanity numbers — every figure is a `count` or a `sum` over rows that exist.

* **Overview** — spend today and all time, provider calls, failures, accounts
  by type, who is near and at their limit, tokens, the default allowance, the
  overshoot bound, and anything the operator still has to configure.
* **People** — a list with account type, allowance, used, percentage, status
  and last active. A table on a desktop and a stack of cards on a phone, from
  the *same* markup.
* **One person** — the period, where the money went job by job, the account
  controls, credits, recent provider calls, and what has been changed.
* **Changes** — the audit log.

### What Admin never shows

No API key, no database URL, no OAuth token, no Firebase credential is read by
`routes/admin.ts` or reachable through it. It shows usage and status; it is not
a control panel for the deployment. Asserted by test.

### The audit log

Every admin mutation writes `admin_audit_log`: actor, target, action, before,
after, timestamp — and **only the fields that actually changed**, because an
entry listing forty unchanged fields says nothing.

The actor's email is *copied* into the row rather than joined at read time, so
history keeps saying who did it after an account is renamed or removed.

An admin cannot remove their own admin access.

### What admin changes never do

Touch usage history. Changing an allowance, changing an account type, granting
a credit and starting a new period are each asserted to leave every ledger row
intact — and `new-period` throws rather than succeeds if the row count moves.

Starting a new period moves the **window** usage is read through. It does not
edit the history. History is why a number looks the way it does.

---

## 3. Account types and the beta

| Type | Meaning |
|---|---|
| `beta` | An invited external tester. |
| `tester` | Internal or friendly; more flexible handling. |
| `standard` | The future ordinary account. |

Beta metadata lives on `users`: `beta_start_at`, `beta_end_at`,
`intro_accepted_at`, `last_active_at`, `admin_note` (never shown to the tester).

### The introduction, and the acknowledgement

`web/beta-intro.js` holds the four sections — Beta, Feedback, AI usage, How
long — as data, and both surfaces render the same array:

* the **landing page**, before anybody signs in (its markup is static in
  `index.html` so the first paint does not wait for a module; a test asserts
  the two agree, because two copies of a promise about money is exactly the
  kind of thing that drifts);
* the **first-run gate** inside the app, for an account that has not
  acknowledged it.

`intro_accepted_at` is **server-held** and forward-only. A `localStorage` flag
would ask again on a new phone, ask again after clearing site data, and leave
no way to know from the outside whether somebody had ever actually read what
they were agreeing to about money. Acknowledging grants nothing — asserted.

The introduction can be re-read from **Settings → Beta & feedback**.

### The mark

A small `beta` chip beside the name in the sidebar and the phone's top bar. It
explains the rough edges without being the first thing anybody reads, and
tapping it opens the feedback sheet — the moment you remember you are on a beta
is usually the moment you have something to say about it.

---

## 4. Feedback

Two buttons: WhatsApp and email, both pre-filled with a subject and the facts
that make a bug report actionable. No form — a form means a new endpoint, a new
table, a moderation problem and an inbox nobody watches, and during a beta of a
dozen friends the thing that gets used is the app they already message you in.

**What is attached** (a fixed allowlist, built field by field):

```
Build:  <build id>
Screen: <route name>
Device: <browser> on <platform>
Window: <width>x<height>
Time:   <ISO timestamp>
```

**What is never attached**: anything the person wrote, anything from their
tasks, diary or library, their email address, any token, any key, any URL
beyond the route name. Anything that iterated over what was available would
eventually pick up something personal, and would do it silently.

Configuration: `PUBLIC_BETA_WHATSAPP_URL`, `PUBLIC_BETA_SUPPORT_EMAIL` on the
**web** service. Public by design — a WhatsApp link and an email address exist
to be handed out. With neither set the sheet says what is missing rather than
showing two dead buttons.

---

## 5. The client decides nothing

Every number a person or an admin sees — the percentage, the remaining
balance, the status, the totals, whether Admin appears — is computed by the
server and rendered by the browser.

`isAdmin` in the `/me` payload is for **rendering only**. Every admin endpoint
re-checks; a client that forced the menu entry to appear would get a series of
403s.

Asserted directly: a normal user cannot raise their own allowance through the
usage endpoint, the turn endpoint, or the preferences endpoint; cannot read
another person's usage; and cannot grant themselves anything by acknowledging
the beta.

---

## 6. Future subscriptions — documented only

**Nothing about paid plans is implemented, and nothing should be built on this
section today.**

The intent, recorded so the current design is understood as deliberate rather
than accidental:

* A future plan should **grant a policy** — an allowance, a period length,
  perhaps rules about which jobs are permitted. `ai_usage_policies.plan_id`
  exists, nullable, and is read by nothing.
* The ledger does not change. `billable_cost_usd` already exists separately
  from `provider_cost_usd` precisely so plan rules can differ from raw cost.
* A plan must **never** grant `role = 'admin'`. That is why role and account
  type are separate columns.
* `account_type = 'standard'` is where a paying account lands.

What is deliberately absent: pricing, checkout, Stripe or Paystack, payment
collection, add-on purchases, and any user-facing "upgrade" wording. The
blocked message says "contact Zander", not "buy more", because the second would
be a promise the system cannot keep.
