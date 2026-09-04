# Pre-beta status

**Where Phases 1–8 actually stand.** Companion to
[`pre-beta-roadmap.md`](./pre-beta-roadmap.md), which is the plan; this is the
state.

Last updated: 4 September 2026. Staging `dae6c299ba4c`.

---

## READY TO INVITE BETA TESTERS

All eight phases are complete, the five configuration values are set on
staging, and the accounting has been reconciled against three real Anthropic
turns.

**One thing to look at yourself before you send the first invitation.** Sign in
and check that Settings shows **Admin**. `/health/version` reports that exactly
one address is in the allowlist, but a count is not an identity — it cannot
tell you the address is *yours* rather than a typo or a different mailbox. That
is the only check in this document nobody but you can run, and it takes ten
seconds.

---

## Phases

| Phase | | Status |
|---|---|---|
| — | Preflight — assistant response speed | **COMPLETE** |
| 1 | AI usage accounting backend | **COMPLETE** |
| 2 | Usage allowances and hard limits | **COMPLETE** |
| 3 | Admin foundation | **COMPLETE** |
| 4 | User-facing AI usage | **COMPLETE** |
| 5 | Beta account controls | **COMPLETE** |
| 6 | Beta landing / introduction | **COMPLETE** |
| 7 | Feedback experience | **COMPLETE** — contacts configured and resolving |
| 8 | Beta readiness | **COMPLETE** |

---

## Configuration, as deployed

All five are set on staging and confirmed from outside. `/health/version`
reports the API side without a session — a **count** of admins, never an
address, because an email is personal data:

```
GET /health/version → "beta": {
  "adminsConfigured": 1, "fxRate": 18.2, "defaultAllowanceUsd": 11 }

GET /config.js      → beta = {
  "whatsappUrl": "https://wa.me/27…", "supportEmail": "…@gmail.com" }
```

The reference below is what each value does, kept for the day one of them has
to change.

### 1. `ADMIN_EMAILS` — on the **API** service. Required.

```
ADMIN_EMAILS=zander@...
```

Comma-separated, case-insensitive. **There is no default**: until this is set,
no account can reach Admin — including yours. Removing an address revokes
access immediately, because the allowlist is read live rather than copied into
the database.

Deliberately not guessed. Admin is the most powerful surface in Life OS and
the one value that decides who has it is not something to infer from a git
config.

### 2. `PUBLIC_BETA_WHATSAPP_URL` and `PUBLIC_BETA_SUPPORT_EMAIL` — on the **web** service. Required for feedback.

```
PUBLIC_BETA_WHATSAPP_URL=https://wa.me/27XXXXXXXXX
PUBLIC_BETA_SUPPORT_EMAIL=zander@...
```

Public by design — a WhatsApp link and an email address exist to be handed
out. Until they are set, the feedback sheet says which variable is missing
rather than showing two dead buttons.

### 3. `USD_ZAR_RATE` — on the **API** service. Optional but wanted.

```
USD_ZAR_RATE=18.20
```

Until it is set, every amount is tracked, enforced and shown in **USD**, and
nothing is estimated. With it set, rand appears everywhere and the rate used is
stored on every usage row so any figure can be checked later. A value outside
1–100 is refused rather than believed.

Admin's overview says this is missing, in the "Needs your attention" section.

### 4. `BETA_AI_ALLOWANCE_USD` — on the **API** service. Optional.

Defaults to **$11** (about R200 at 18.2). Only what a NEW account starts with;
any individual tester's allowance is changed in Admin. `unlimited` is a valid
value and is not the same as leaving it unset.

---

## What was verified, and how

* **Phases 1–5, 8B–8E** — 1,766 automated tests, all passing, against real
  Postgres (PGlite) through the real migration SQL and the real constraints.
  No real provider calls: the seam is `globalThis.fetch`, so the real Anthropic
  adapter reads real-shaped response bodies.
* **Phases 3D–7, 8A, 8G, 8H** — driven in a real browser against the real API,
  with a seeded beta of seven accounts spread across every state the interface
  has to handle (2%, 14%, 31%, 74%, 93%, 108%). Nineteen screenshots, checked
  for horizontal overflow on every one.
* **8D admin security** — exercised as a second identity, not asserted from
  source. A normal account gets 403 from all eight admin endpoints, sees no
  Admin section, and reaches "Not available" at `#admin`.

### The security review

The ten-point review is `api/tests/security-review.test.ts` — ten tests, one
per point, run with the rest of the suite. A review that lives in a report is
true on the day it is written; this one fails a build.

| | Point | How it is held |
|---|---|---|
| 1 | API keys are server-only | No client file names, contains or calls the provider; no route reads the key or the database URL |
| 2 | Usage cannot be forged | Five plausible client attempts refused; `recordUsage` takes a meter scope and a recorded call, and nothing else |
| 3 | A user cannot edit their own allowance | Five attempts change nothing; `updatePolicy` appears in `admin.ts` and no other route |
| 4 | Admin routes require server authorisation | Every route in the file uses the one guarded `pre`; 401/403 without it, 200 with |
| 5 | No reading another user's usage | The route has no user-id parameter; another workspace is 403 |
| 6 | Admin mutations are audited | Three mutations, three entries with actor and target; the count of mutating routes equals the count of audit writes |
| 7 | Limits enforced server-side | `assertCanUseAi` appears before `runTurn`; a spent account gets 402 |
| 8 | Usage is append-only | No `update`/`delete` against the ledger anywhere in the server; a new period and three account changes preserve every row; a correction is an adjustment |
| 9 | Feedback carries no secrets | The payload is five known lines; a planted Firebase key and API URL do not appear |
| 10 | The beta cannot grant admin | A hostile acknowledgement changes nothing; `role` is written in exactly one file, and the policy table has no column that could carry one |

### The one thing verified by proxy

**The staging migration.** `npm start` on the API is
`node dist/db/migrate.js && node dist/index.js`, and a failed migration sets a
non-zero exit code — so the server cannot start against a half-migrated
database. The API is up and answering, and `/api/v1/admin/overview` returns 401
rather than 404, which means the new code is deployed. That is strong evidence
the migration ran; it is not the same as having read the schema, because
staging requires a Google sign-in this session does not have.

### Live Anthropic usage capture — done, and it reconciles

Three real turns, 4 September 2026. Eleven provider calls, **$0.134114**
(R2.4409 at 18.2), zero failures, zero unpriced models.

| | |
|---|---|
| `plan` | 3 calls · `claude-sonnet-4-5` · 38,233 in / 555 out · $0.123024 |
| `extractMemory` | 5 calls · `claude-haiku-4-5-20251001` · 4,741 in / 331 out · $0.006396 |
| `interpret` | 3 calls · `claude-haiku-4-5-20251001` · 3,544 in / 230 out · $0.004694 |

Five figures that must agree, and did, to the tenth decimal place: the ledger
rows, the per-turn aggregation, Admin's all-time spend, the user's Settings
figure, and the user's own per-job breakdown. Both rand conversions check out
against the stored rate. Usage incremented rather than replaced — the three
live deltas sum to the total exactly, so every dollar is accounted for once.

The provider→ledger link was also checked by hand: 14,115 input and 161 output
tokens on Sonnet at $3/$15 per MTok is $0.044760, which is what was stored.

**The first run reported a discrepancy of $0.001392, and it was the
instrument's.** Memory extraction is fired without being awaited, and when it
needs a schema repair the second call can land a second after the answer; a
fixed 2.5s snapshot caught three of a turn's four rows and then read a total
that already included the fourth. The harness now polls until the row count
stops moving. No ledger row was touched — they were right throughout.

Re-runnable without spending anything:
`node api/tests/live-accounting.mjs --verify-only`.

### Worth knowing

**`extractMemory` needed a schema repair on 2 of 3 turns** — five calls where
three would do. The prompt asks for `{"category": ...}` and never lists the ten
values the Zod enum accepts, so the model guesses. It cost $0.002434 here, 1.8%
of the run. A one-line prompt change, deliberately NOT made during the freeze:
shipping an unverified change to the assistant's prompt the day before testers
arrive is not worth 1.8%. Revisit after the beta.

**The custom domain serves this build.** `life-os.web-anchor.com` and the
Railway staging host both return `dae6c299ba4c`, so the beta introduction is
what a visitor to the public address sees.

---

## Deliberately not built

Named here so their absence is understood as a decision rather than an
oversight:

* Subscriptions, pricing tiers, checkout, Stripe/Paystack, payment collection,
  AI add-on purchases. See `allowances-and-admin.md` §6 for how a future plan
  is intended to map onto what exists.
* Budget, Food, Circles, spoken AI / text-to-speech.
* Any further AI architecture work. The assistant is frozen for beta except
  for concrete bugs.

## Known, non-blocking

* **Desktop interim transcription visibly revises words while speaking.** The
  browser's own recogniser reports successive guesses at the current phrase and
  the composer shows the latest one. It is correct, it is what every voice
  interface using the Web Speech API does, and it looks unsettled. Worth a
  pass after the beta; not worth risking the transcription path before it.
* **The orb follows how much text arrives, not microphone loudness.** Shouting
  a short word does not spike it. True loudness needs a second `getUserMedia`
  stream, and that stream is what appeared to take the microphone away from the
  recogniser on a real phone. Now that transcription is trusted on a device,
  this is a decision that CAN be revisited — after the beta, not during it.

## Closed

* **Mobile voice duplication — verified on a real device, 4 September 2026.**
  Speech is transcribed correctly and words are no longer repeated. `mergeFinals`
  was the fix: Android Chrome emits cumulative finals, where every entry is
  final and each contains the whole sentence so far, and concatenating them
  produced "I I want I want to buy bread". Four rounds of reasoning about it
  got nowhere; the device's own trace settled it in one.

  This was the last thing carried as unverified. It is closed.
