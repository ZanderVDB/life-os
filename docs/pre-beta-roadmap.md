# Pre-beta roadmap

**What this is.** The ordered list of what stands between Life OS today and
inviting real testers, and a record of where we actually are. Agreed 2 Sep 2026.

**How we are working now.** Small changes, tested on a real device, reported
back, fixed. Not another large development phase. Steps are worked in order,
and a step is not started because it looks interesting — step 9 in particular
is deliberately last.

---

## Where we are

**Steps 1–8 are done.** Step 9 is next, and is Zander's to start.

| Step | | Status |
|---|---|---|
| 1 | Immediate bugs and polish | **done** — voice duplication awaits a real-device retest |
| 2 | AI usage accounting backend | **done** |
| 3 | AI usage limits | **done** |
| 4 | Admin foundation | **done** — needs `ADMIN_EMAILS` set |
| 5 | User-facing AI usage | **done** |
| 6 | Beta account controls | **done** |
| 7 | New beta landing page | **done** |
| 8 | Feedback experience | **done** — needs the two contact values set |
| 9 | Real beta → data → subscriptions | not started, deliberately |

The state of each, and the four configuration values still needed, are in
[`pre-beta-status.md`](./pre-beta-status.md). How the accounting works is in
[`ai-usage-accounting.md`](./ai-usage-accounting.md); allowances, admin and the
beta are in [`allowances-and-admin.md`](./allowances-and-admin.md).

---

## 1. Immediate bugs and polish

- **Mobile voice input** — **awaiting real-device verification.** The
  transcript still duplicated on a real phone after a fix that was verified
  only against a scripted recogniser. A development-only diagnostics recorder
  is now deployed so the device can report what it actually emits, rather than
  a third guess. See `ai-system.md` §6j.
- **Assistant listening visual** — done. The concentric rings read as sonar
  and were replaced by a balanced audio waveform around the orb.
- **Reminder civil-date bug** — done. A reminder with no date used the UTC
  day; it now uses the user's, and a turn executes on the day it was planned.
- **Concrete UI and product bugs** — ongoing, as found in testing.

## 2. AI usage accounting backend

Provider and model usage, token categories, cost calculation, per-user and
per-turn attribution, and **historical pricing snapshots** — a cost computed
today must stay computable when a price list changes.

## 3. AI usage limits

Configurable monetary allowances, warning thresholds, and a hard AI limit that
**does not lock the rest of Life OS**. Losing the assistant must never mean
losing the tasks.

## 4. Admin foundation

A server-authorised admin role. Zander's ordinary account stays ordinary;
Settings reveals Admin only to an authorised admin, and the server decides —
not the client, and not a flag the browser can set. User, account, usage and
allowance management.

## 5. User-facing AI usage

A usage view in Settings: percentage, allowance, remaining. Understandable at
a glance, not an accounting report.

## 6. Beta account controls

Account states — admin, beta, tester, standard — with individual allowances,
manual changes and credits.

## 7. New beta landing page

A polished introduction: what Life OS is, what the beta is, what it costs to
run, what feedback is expected, and an acknowledgement. Centred, responsive,
with a better background.

## 8. Feedback experience

Beta status that is obvious, a WhatsApp or email path, and bug reporting that
takes seconds.

## 9. Real beta → data → subscriptions

Release to invited testers, measure **actual** usage and cost for one to two
weeks, and only then design pricing, allowances and add-ons.

**Pricing is designed from measured data, not from a guess.** That is the whole
reason it is step 9 rather than step 2, and it is not to be brought forward.
