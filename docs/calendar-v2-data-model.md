# Calendar v2 — data model

**Status:** built in D2. Migration `api/drizzle/0002_calendar.sql`, 11 tables,
purely additive. Schema lives in `api/src/db/schema.ts`.

See also [calendar-v2-product-model.md](calendar-v2-product-model.md) for the
product rules these tables encode, and [calendar-google-sync.md](calendar-google-sync.md)
for the sync design.

## The tables

| Table | Holds | Owner |
|---|---|---|
| `calendar_connections` | one connected provider account | Life OS |
| `calendars` | a calendar the connection can see | Google |
| `calendar_sync_states` | sync token + resync state, one per calendar | Life OS |
| `calendar_events` | a mirrored Google event | Google |
| `calendar_event_attendees` | attendees + RSVP (read-only) | Google |
| `calendar_event_reminders` | per-event notification overrides | Google |
| `calendar_event_attachments` | Drive attachment metadata | Google |
| `reminders` | a Life OS reminder | Life OS |
| `reminder_recurrence_rules` | RRULE-shaped recurrence | Life OS |
| `task_schedule_blocks` | "I will do this task at this time" | Life OS |
| `calendar_item_links` | Event↔Task/Project/Library relationships | Life OS |

Every table carries `workspace_id`. Every `area_id` is `ON DELETE SET NULL`,
matching the existing rule that an Area classifies but never owns.

## The four decisions worth knowing

**1. Reminders are not events.** A reminder asks for attention *on or before* a
date and has no duration. It has its own table, and there is nowhere in it to
put an end time. It is never pushed to Google as an event to make it appear on
a canvas.

**2. Due date ≠ scheduled time.** `tasks.due_date` says when something is due.
`task_schedule_blocks` says when you plan to do it. A task due Friday that you
plan for Wednesday morning carries both, and neither overwrites the other.
Tested directly in `calendar-schema.test.ts`.

**3. Habits never become events.** Habit completion stays in `habit_entries`.
Calendar reads it for summaries; it does not copy it.

**4. Tokens are references.** `access_token_ref` / `refresh_token_ref` point
into encrypted storage. A database dump contains no usable credential.

## Identity columns that matter

`calendar_events` carries five columns purely for correctness:

- `provider_event_id` — the id to write back to
- `ical_uid` — stable across copies of an invitation
- `recurring_event_id` — the series this instance belongs to
- `original_start_time` — which occurrence an exception replaces
- `etag` + `sequence` — optimistic concurrency, so a stale write is rejected

Drop any of them and editing a single occurrence of a recurring event corrupts
the series.

The unique index on `(calendar_id, provider_event_id)` is **partial**
(`WHERE provider_event_id IS NOT NULL`) so that idempotent sync upserts work
while synthetic and local-only events — which have no provider id — can still
coexist on one calendar.

## Synthetic data boundary

`calendars`, `calendar_events`, `reminders` and `task_schedule_blocks` each
carry `is_synthetic`. Everything created for D3/D4 demonstration is flagged, so
it can be removed in one statement per table before any real Google connection
is made. No Legacy event content is used.

---

## E2.4 — Habit history in Month

### What Calendar says about habits

**Month cell:** one chip, `3/5` — done over **due that day**. Nothing else.
Habits repeat by definition, so listing names per cell would fill all thirty-one
squares with the same five words and bury what actually differs between days.

Nothing is drawn when nothing was due (an empty square is the honest answer for a
day that asked nothing) and nothing is drawn on a **future** day (a day that has
not happened has not been missed; `0/5` across the rest of the month turns a
history into a wall of failure).

Nothing here goes red. A missed habit is not an error, and the month must not
read as a scorecard.

**Selected day:** a `Habits n/m` card in the rail listing every habit that was
due that day, each one tickable. This is the point of the feature — Life OS could
already tell you that you did 3 of 5 habits a fortnight ago and offered no way to
correct it. A history you cannot fix is a history you stop trusting.

**Month only.** Agenda answers "what is coming", and a habit is not coming — it
is a rhythm. Plan is about placing work into hours.

### `due` and `done`, computed once

`src/lib/habit-history.ts` is the single implementation, used by both
`GET …/habits/history?from=&to=` and the Calendar range endpoint.

They were about to differ. Calendar's original version counted **any** entry row
as done, against a flat total of unarchived habits — so a Monday-only habit
counted against every Sunday, and a habit with a target of 3 read as complete
after one tick. Two answers to "3 of what?" is worse than either alone.

Rules, in order:

1. **An existing entry always counts.** If the user ticked a day, that day
   counted — whatever the frequency rule says. This covers a habit created today
   and then ticked for last Thursday (without it, the tick lands, the square
   stays blank, and the user tries again), and imported history that predates the
   habit record. A frequency rule is a default about the future, not a veto over
   the past.
2. Otherwise, a habit created **after** a day was not due on it. Backfilling
   guilt for a habit that did not exist yet makes a history screen not worth
   opening.
3. Otherwise, `dueOn()` decides — `specific_days` checks the weekday, everything
   else is available any day.
4. **Done means `completedCount >= targetCount`.** A 3-glass habit ticked once is
   in progress, not done.

### Dates are strings, and stay strings

`entry_date` is a `date` column. The client sends the **local** day it is drawing
— `iso()` in `calendar.js` uses local getters, never `toISOString()` — and
nothing on either side converts a day into an instant.

Parsing `"2026-08-03"` as a Date anywhere west of Greenwich yields the 2nd. It
fails silently, near midnight, for some users only. The one unavoidable Date is
the weekday probe for `specific_days`, built at **noon UTC** so no offset can
push it into the day either side. Asserted by a test that scans the file for
unguarded `new Date(...)` calls.

### Writes

`check` and `uncheck` already accepted a `date`; nothing needed inventing. What
was missing was a way to reach them for a past day.

Ticking is optimistic: the row flips, the request goes, the month cell's `n/m` is
recomputed locally and patched in place, and a failure puts both back. The
calendar is never reloaded to change two characters. A response for a day that is
no longer selected is discarded, so a slow request cannot paint the 3rd's habits
into the 4th's card.

`GET …/habits/history` rejects a backwards range and anything longer than a year.
