# The calendar keeps itself current

Two problems, one symptom: a calendar that quietly stopped being true.

---

## One — a bad minute was recorded as a dead grant

`accessTokenFor` wrapped the token refresh in a `try/catch` that treated
**every** failure the same way:

```ts
} catch (e) {
  await db.update(calendarConnections).set({ status: 'revoked', … });
  throw badRequest('Google access was revoked or expired. Reconnect to continue.');
}
```

`revoked` is permanent. Nothing in the system leaves it except a person
noticing and clicking Reconnect. And the `catch` caught everything: a Google
503, a DNS failure, a socket timeout, a 429 rate limit. One bad second on
Google's side ended the integration until somebody happened to look.

The sentence made it worse. "Reconnect to continue" is an instruction, and
following it was useless work for a problem the user did not have.

**Now:** `GoogleTokenError` carries Google's own error code, and `permanent` is
true for exactly three of them — `invalid_grant`, `invalid_client`,
`unauthorized_client`. Those mean the grant really is gone. Everything else is
a bad minute: the connection stays `active`, the failure is counted, and the
scheduler tries again. An error from somewhere unexpected is treated as
transient, because not knowing that something is fatal is not evidence that it
is.

## Two — nothing synced unless a browser was open

The only thing that ever pulled Google was `syncCalendarQuietly`, in
`web/app.js`, on an interval started by `loadCalendar`. Close the tab and the
calendar stopped updating. Open it a week later and the first thing you saw was
last week, until a poll caught up.

"It syncs automatically" described the tab, not the product.

**Now:** `startCalendarScheduler` runs in the API process, which is awake
regardless. Every connected workspace is pulled on a five-minute cycle whether
or not anyone is looking.

---

## How the scheduler behaves

| | |
|---|---|
| Tick | every 60s — one indexed query, usually finding nothing |
| Interval | 5 min per connection, ±10% jitter |
| Batch | 10 connections per tick |
| Backoff | 2 min, doubling, capped at 1 hour |
| Claim | `syncing_since`, retaken after 15 min |

Four rules shape it, and each is a test:

**Claim before working.** A conditional `UPDATE` that only one caller can win.
Two overlapping ticks — or two instances during a deploy — cannot both sync one
account, which would double the quota and interleave sync tokens.

**Back off, never give up.** A failing connection retries on a doubling delay
up to an hour, and then keeps retrying at an hour. It is never abandoned,
because a calendar that quietly stopped forever is the bug being fixed.

**A revoked grant is not retried.** There is nothing to retry with. Those are
excluded from the query until the user reconnects, so a dead connection does
not burn a Google call a minute.

**A tick never throws.** This runs unattended; an unhandled rejection would
take down the API for everyone.

### Not in `buildApp`

The scheduler starts in `src/index.ts`, the real server entry. Every test builds
an app, and none of them wants a background timer calling Google. It is skipped
entirely when the Google credentials are absent, so a local checkout runs
exactly as before.

---

## Two smaller bugs found on the way

**A missing `sequence` stopped a calendar permanently.** `mapEvent` mapped an
absent `sequence` field to `null`, but the column is `NOT NULL DEFAULT 0` — and
an explicit `null` *overrides* a default rather than falling back to it. The
insert failed, which aborted that calendar's whole pass **before its sync token
advanced**, so the identical failure repeated on every pass thereafter. One
optional field, one calendar stopped for good. Now `0`.

**No request timeout.** Neither the token exchange nor the Calendar API GET had
one. Because the scheduler runs one pass at a time, a single request that never
settled would have stopped every calendar syncing for the life of the process.
Both now time out (20s and 30s).

---

## What the user sees

Three states, not two:

| Status | Dot | Says |
|---|---|---|
| `active` | green | Connected · Read-only |
| `error` | amber | Having trouble · retrying |
| `revoked` | red | Reconnect needed |

Red is reserved for the one state that needs the user. Amber means the server
is already handling it and there is nothing to do. A revoked connection now
offers a **Reconnect** button — previously the only control was Disconnect, so
the fix was disconnect-then-reconnect: two steps for a one-step problem.

Under the sync row, one line says what is actually happening: *"Kept up to date
automatically, even when Life OS is closed."*

A manual **Sync now** during an outage returns `503` with "Your calendar is
still connected — Life OS will keep trying on its own", and pushes the next
scheduled pull back so the button does not leave a redundant sync due seconds
later. A manual sync against a genuinely revoked grant still says Reconnect —
softening *that* would be the original bug wearing the opposite face.

---

## Migration `0013_calendar_auto_sync`

Additive: `next_sync_at`, `syncing_since`, `sync_failure_count`, and an index on
the first.

It also returns `revoked` connections that still hold a refresh token to
`active`. Those rows are indistinguishable from genuinely revoked ones — the
old code wrote the same status for both — so an unknown number of them are
healthy grants killed by a transient error. Trying once is the only way to find
out, and it costs a single refresh call: if the grant really is gone, the next
attempt marks it revoked again, this time for the right reason.

Existing connections get `next_sync_at = NULL`, which reads as *due now*, so the
first tick after deploy catches everyone up.

---

---

## What staging taught, that 1280 passing tests could not

The loop shipped green and then did nothing. `/health/version` reported
`started: true, passes: 0` for nine minutes.

**The diagnostics had the same disease as the bug.** `passes` was only written
on the success path, so a loop whose every pass threw was indistinguishable
from a loop whose timer never fired. A thrown pass now counts, timestamps and
records its message — bounded, message only, never the error object, which can
carry a token.

With that in place the cause appeared within two minutes:

> The "string" argument must be of type string or an instance of Buffer or
> ArrayBuffer. Received an instance of Date

The claim query interpolated `now` and `staleClaim` into a raw drizzle
``sql`...` `` template, which passes the value to the driver verbatim. **PGlite
accepts a `Date` there; the production Postgres driver does not** — so no test
run against PGlite could ever have caught it. (The earlier `NULLS NOT DISTINCT`
case was the mirror image: PGlite is PG16 and accepted syntax the PG15 target
rejected.)

The claim is now built from drizzle helpers, which bind by column type. It
became two statements — select candidates, then claim them — and stays
exclusive because the `UPDATE` was always the lock, not the `SELECT`: it
re-checks the same predicate, so only one caller can flip `syncing_since`.
Asserted with two concurrent passes.

Since PGlite cannot catch this class of defect, the rule is enforced on the
source instead: **a raw `sql` template in the scheduler may name columns and
nothing else.** Every value goes through `eq`, `lte`, `inArray` or `isNull`.

Verified on staging at build `1564486`: a pass every 60 seconds, zero failures.

## Still true

Read-only, and asserted as such against the new files: no `insertEvent`,
`patchEvent`, `deleteEvent` or `createEvent` anywhere, and no write scope named.
Unattended and automatic is exactly when an accidental write would be worst and
least likely to be noticed.

## The remaining limit

"24/7" is now bounded by the API process being up, not by a browser being open.
If the host sleeps or restarts the service, syncing pauses until it returns —
and then resumes on its own, because `next_sync_at` is already in the past.

Push notifications (Google's `watch` channels) would cut the worst-case
staleness from five minutes to seconds, but they need a publicly reachable
webhook and channel renewal, and they are strictly an improvement on top of
this loop rather than a replacement for it.
