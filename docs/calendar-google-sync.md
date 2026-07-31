# Calendar — Google sync architecture

**Status:** designed in D1/D2, **not connected**. No OAuth scope is requested
and no Google API call is made until the user approves D4.

> This document records the *intended* design. Before D5 is implemented, the
> current Google Calendar API documentation must be re-audited — the field and
> scope lists below are the design target, not a verified snapshot.

## Where sync runs

**All sync and all writes go through the Railway backend.** The old
direct-from-browser architecture is retired: it exposed tokens to the client,
could not hold a sync token reliably, and had no way to retry safely.

The browser never sees a Google token.

## Authorisation

Narrowest scopes that satisfy the approved behaviour, requested in stages:

| Stage | Scope | Why |
|---|---|---|
| D5/D6 | `calendar.readonly` | read calendar list and events |
| D7 | `calendar.events` | create/edit/delete events the user owns |

Rules:

- Write scope is requested **only** when the user asks for editing, never
  bundled into the first connection.
- Each calendar's `accessRole` is respected independently. A `reader` calendar
  never shows an edit control, regardless of the granted scope.
- `granted_scopes` records what was actually granted, which can be narrower
  than what was requested. Write paths check this column, not the request.
- Refresh tokens are stored **server-side and encrypted**; the database holds a
  reference (`kms://…`), never the token.
- Tokens are never logged, never committed, never returned by an API route.
- Disconnect revokes at Google and clears the stored references.
- ACLs and sharing settings are **not** touched in any phase of Phase D.

## Sync loop

```
initial connect
  └─ list calendars                    → calendars
  └─ per calendar: FULL sync
       └─ paginate events              → calendar_events (upsert)
       └─ store syncToken              → calendar_sync_states

later
  └─ per calendar: INCREMENTAL sync using syncToken
       └─ paginate changes             → upsert / mark cancelled
       └─ store new syncToken
```

### What makes it safe

**Idempotent upserts.** `calendar_events` has a partial unique index on
`(calendar_id, provider_event_id)`. A re-delivered page of changes updates the
existing row; it cannot insert a duplicate. The index is partial because
synthetic and Life OS-only events legitimately have no provider id.

**Deletions.** Google reports removals as `status: "cancelled"` rather than by
omission. Cancelled events are marked, not silently dropped, so a link pointing
at one does not dangle.

**Recurring series.** Five columns carry identity: `provider_event_id`,
`ical_uid`, `recurring_event_id`, `original_start_time`, and
`etag`/`sequence`. Without all five, editing one occurrence cannot be matched
back to the occurrence it replaces, and the series is corrupted. That is the
specific failure this schema is shaped against.

**Sync-token invalidation.** When Google returns `410 GONE`, the token is dead.
The response is a *controlled full resync for that calendar only*:

1. stamp `token_invalidated_at`
2. clear `sync_token`
3. run a full sync
4. upsert everything returned

Never guess at the missing changes. Never delete Life OS-only data — reminders,
task blocks and links are not Google's to remove.

**Conflict detection.** `etag` and `sequence` give optimistic concurrency. A
write carrying a stale etag is rejected by Google rather than silently
clobbering someone else's change, and the user is told.

**Retries.** Failures increment `consecutive_failures` and back off. `is_syncing`
prevents two syncs racing on one calendar.

## Field mapping

### Round-trips to Google

| Life OS | Google |
|---|---|
| `title` | `summary` |
| `description` | `description` |
| `location` | `location` |
| `startsAt` / `endsAt` | `start.dateTime` / `end.dateTime` |
| `startDate` / `endDate` | `start.date` / `end.date` (all-day) |
| `timeZone` | `start.timeZone` |
| `recurrence` | `recurrence[]` (RRULE) |
| `status` | `status` |
| `transparency` | `transparency` (busy/free) |
| `visibility` | `visibility` |
| `providerColorId` | `colorId` |
| `eventType` | `eventType` |
| `conferenceData` / `hangoutLink` | `conferenceData` / `hangoutLink` |
| attendees | `attendees[]` |
| event reminders | `reminders.overrides[]` |
| attachments | `attachments[]` |

All-day events are stored as **both** a date and a timestamp. Storing them only
as an instant shifts them across time zones, which is how a birthday lands on
the wrong day.

### Life OS-only — never written as Google event content

- `calendar_item_links` — every Event↔Task, Event↔Project, Event↔Library
  relationship
- `reminders` and `reminder_recurrence_rules`
- `task_schedule_blocks` — unless the user explicitly mirrors one, in which
  case `mirrored_event_id` points at the created event
- habit completion history

If a relationship is ever mirrored to Google it goes in a **private extended
property**, and the UI must say plainly that other Google Calendar users will
not see it.

**The rule for the editor:** if a field cannot round-trip safely, it is either
omitted from the Google event editor or labelled explicitly as Life OS-only.
Never show a field that looks like it will appear in Google when it will not.

## What is deliberately not built

- No `calendar.settings`, ACL or sharing scopes.
- No auto-scheduling.
- No writing reminders, habits or task blocks to Google as events.
- No Legacy calendar or reminder import (that is D8, separately approved).
