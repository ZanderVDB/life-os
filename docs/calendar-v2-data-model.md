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
