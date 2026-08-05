# Diary — data model (Phase D1)

One table: `diary_entries`. Migration `0007_diary.sql` creates it and touches
nothing that already exists — no DROP, no DELETE, no ALTER of another table, no
seed INSERT.

| Column | Why it is what it is |
|---|---|
| `entry_date` `date` | a CIVIL date, from the client. Not a timestamp — see below |
| `timezone` `text` | what the browser believed. Recorded, never used for maths |
| `title` `text` null | null means "show the date". The date is never stored here |
| `document` `jsonb` | the same node grammar as `book_pages.content` |
| `document_text` `text` | maintained on write, so search is one indexed query |
| `mood` / `energy` | label enums with CHECK constraints, not numbers |
| `weather_note` / `location_note` | free text, optional |
| `day_summary` `text` | a short overview, separate from the entry |
| `archived_at` | soft archive; there is no delete route |

Mood and energy are stored as labels (`very_low` … `very_good`) rather than as
1–5. A number invites arithmetic on something that is not a measurement.

## The unique index covers archived rows

```sql
CREATE UNIQUE INDEX diary_entries_unique_day ON diary_entries (workspace_id, entry_date);
```

Deliberately **not** partial on `archived_at IS NULL`. If an archived entry did
not occupy its date, writing there again would create a second row and the
original would become unreachable. Holding the date is what lets the API answer
"there is an archived entry here — restore it?" instead of duplicating.

It is scoped to the workspace, so two workspaces may both hold the same day.

## Civil dates

`date`, not `timestamptz`, for the same reason `workspace_memberships.
last_today_arranged_on` is a `date`: the rule is about a person's calendar day,
and the server does not reliably know their zone. Deriving one from the request
would be worse than trusting the browser that is about to render the result.

All date arithmetic — client and server — is done at **noon UTC**, so no offset
can push a computed day into its neighbour. `addDays`, `monthBounds` and
`monthGrid` all work this way, and `localToday()` uses local getters, never
`toISOString()`.

`2026-02-30` matches the shape and is not a day; every date is round-tripped
through `Date` before it is accepted.

## The meaningful-entry rule

`api/src/lib/diary-entry.ts` — one function, used by the write path and by
history, so the two can never disagree about which days count.

`documentHasContent` does not count nodes: `{content:[{type:'paragraph'}]}` is
what an empty editor round-trips to. It tests whether any text survives, **or**
whether a node exists that carries meaning without text — a list, or a node type
from a newer build that this one cannot read but must not declare empty.

## API

| Route | Note |
|---|---|
| `GET /diary/entries/:date` | 200 with `entry: null` for a blank day. Never 404 — the date always exists, and a blank day is a normal answer, not a missing resource |
| `PUT /diary/entries/:date` | creates on first meaningful content, updates after. `expectedUpdatedAt` mismatch → 409. Archived date → 409 with a restore offer |
| `POST /diary/entries/:id/archive` and `/restore` | reversible; no DELETE route exists |
| `GET /diary/days?month=` | presence and a label only — never whole documents. Drawing thirty dots should not cost a month of reading |
| `GET /diary/recent?limit=` | newest first, for the history panel |
| `GET /diary/adjacent?date=&direction=` | the nearest day that actually has an entry. This is what makes "previous entry" different from "previous day", and it has to be a query — the client cannot know where the gaps are without fetching every month in between |
| `GET /diary/search?q=` | title, body, summary, location and weather |
| `/diary/sample`, `/diary/sample/remove` | staging only; refuse when `NODE_ENV` is production |

Every route is workspace-scoped and authenticated. Reaching into another
workspace is refused before any row is read.

## Sample data

Prefix `sample:d1:`, carried on **`timezone`**.

It began on `day_summary`, and that field is displayed — the marker appeared on
screen as "sample:d1: An ordinary Tuesday" in the history list. `timezone` is
metadata about the write, never rendered and never typed by a person, and a
value beginning `sample:d1:` is unmistakably not a zone.

Cleanup deletes only rows whose `timezone` starts with the exact prefix. Not the
title, which somebody might genuinely reuse; not the day summary, which is shown
on screen; not a date range, which would take real days with it. Verified in a
browser: a real entry sharing a sample's title **and** containing `sample:d1:`
in its typed summary survived removal untouched.

Seeding skips dates that already hold an entry — on a staging workspace with
real writing in it, seeding must never replace a day somebody wrote.
