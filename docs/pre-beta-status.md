# Pre-beta status

**Where Phases 1–8 actually stand**, and what still needs a human. Companion
to [`pre-beta-roadmap.md`](./pre-beta-roadmap.md), which is the plan; this is
the state.

Last updated: 4 September 2026, staging build `4e3c2aa`.

---

## Phases

| Phase | | Status |
|---|---|---|
| — | Preflight — assistant response speed | **COMPLETE** |
| 1 | AI usage accounting backend | **COMPLETE** |
| 2 | Usage allowances and hard limits | **COMPLETE** |
| 3 | Admin foundation | **COMPLETE** — one manual value required |
| 4 | User-facing AI usage | **COMPLETE** |
| 5 | Beta account controls | **COMPLETE** |
| 6 | Beta landing / introduction | **COMPLETE** |
| 7 | Feedback experience | **PARTIAL** — built; two contact values required |
| 8 | Beta readiness | **COMPLETE** — one item verified by proxy, see below |

---

## What still needs a person

These are configuration values, not code. Everything around them is built,
deployed and tested; each one is reported inside the product rather than left
to be discovered.

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
rather than showing two dead buttons. This is the only reason Phase 7 is
PARTIAL: the experience is complete and tested, it simply has nowhere to send.

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

### The one thing verified by proxy

**The staging migration.** `npm start` on the API is
`node dist/db/migrate.js && node dist/index.js`, and a failed migration sets a
non-zero exit code — so the server cannot start against a half-migrated
database. The API is up and answering, and `/api/v1/admin/overview` returns 401
rather than 404, which means the new code is deployed. That is strong evidence
the migration ran; it is not the same as having read the schema, because
staging requires a Google sign-in this session does not have.

### Not verified at all

**Live Anthropic usage capture.** Every part of the accounting path is proven
against a scripted provider, including the exact response shape the API
returns. What has not happened is one real call landing one real row, because
that costs money and was not authorised for this pass. It is a single turn
whenever you want it.

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
  recogniser on a real phone. Revisit once voice duplication is confirmed fixed
  on a device.
