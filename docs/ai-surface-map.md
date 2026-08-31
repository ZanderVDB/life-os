# Life OS — what exists, and what connects to what

Written to be handed to someone planning the AI layer. It describes **v2 as
built today**, from the Postgres schema and the live route handlers.

> Do not use `data-model-map.md`, `integration-map.md` or
> `page-capability-map.md` for this. Those describe **Legacy v1** — the
> Firestore app, with `S.tasks[]`, Notebook and Brain. v2 shares almost none
> of that shape.
>
> `ai-contract.md` **is** current, and is the safety model this must obey.
> `ai-system.md` is the canonical AI architecture document and supersedes this
> file wherever the two disagree about what the assistant can do — this map
> describes what EXISTS to reason about; that one describes the reasoning.
> `relationships.md` is the canonical map of how anything here refers to
> anything else, and supersedes §3 below wherever the two disagree.

Everything below lives inside one **workspace**. Every table carries
`workspace_id`; every route is `/api/v1/workspaces/:workspaceId/…`. There is
no cross-workspace anything, and the AI never needs to think about it.

---

## 1. The eight systems

| System | What it is | Table(s) |
|---|---|---|
| **Tasks** | A single action. The Today board. | `tasks`, `task_steps`, `task_activity` |
| **Projects** | A finite outcome needing more than one action. | `projects`, `project_books` |
| **Areas** | The parts of a life. Everything optionally belongs to one. | `areas` |
| **Habits** | A recurring intention, ticked per day. | `habits`, `habit_entries` |
| **Calendar** | Events, mostly Google's. Plus reminders and time blocks. | `calendar_events`, `reminders`, `task_schedule_blocks` |
| **Library** | Books, documents, images, links, files. | `library_items`, `library_books`, `book_sections`, `book_pages`, `book_bookmarks` |
| **Diary** | One entry per day, plus a structured check-in. | `diary_entries` |
| **Links** | The one polymorphic edge joining any of the above. | `item_links` |

---

## 2. Each system in detail

### Tasks — `tasks`

The unit of work. A task is *one action*; anything needing several is a Project.

| Field | Values |
|---|---|
| `status` | `open` · `done` · `cancelled` |
| `bucket` | `today` · `week` · `month` · `future` |
| `priority` | `urgent` · `high` · `medium` · `low` · `someday` |
| `dueDate` | a date — the deadline |
| `scheduledAt` | a timestamp — *when you intend to do it* |
| `estimatedMinutes` | how long you think it takes |
| `areaId` → Areas | nullable |
| `projectId` → Projects | nullable, `on delete set null` |
| `position` | order within its bucket |
| `projectPosition` | order within its project — **a separate ordering**, so dragging inside a project does not reshuffle Today |

`dueDate` and `scheduledAt` are different facts and both matter to an AI:
"due Friday" and "I'll do it Wednesday morning" are not the same sentence.

**Steps** (`task_steps`) are ordered sub-items with their own completion. They
are strictly sequential in the UI: current / next / later.

**Actions:** `GET|POST /tasks` · `GET|PATCH|DELETE /tasks/:id` ·
`/tasks/:id/complete` · `/uncomplete` · `/archive` · `/move` ·
`/tasks/reorder` · `/tasks/:id/steps` (`POST`, `PATCH`, `DELETE`) ·
`/today/arrange-claim` · `/today/arrange-release`

### Projects — `projects`

**Two independent dimensions, and keeping them independent is the point:**

- `status` — where the work *is*: `planning` · `active` · `on_hold` · `completed`
- `focus` — how loudly it should *ask*: `now` · `upcoming` · `someday`

A project can be genuinely Active and deliberately quiet. Legacy collapsed
these into one field and recomputed it from recency, which overwrote the
user's choice.

**Archive is not a status.** It is an overlay: `archivedAt` plus
`preArchiveStatus`, so restore does not guess, and "completed" and "abandoned"
never read the same.

`nextTaskId` is an optional hand-picked next action; when null the app
*resolves* one. Both the Projects page and the Today badge call the same
`nextActionFor()` — two implementations would disagree.

Other fields: `outcome` (what done looks like), `description`, `notes`,
`targetDate`, `areaId`.

**Actions:** `GET|POST /projects` · `GET|PATCH|DELETE /projects/:id` ·
`/archive` · `/restore` · `/complete` · `/next-action` · `/area` · `/book` ·
`/move-to-top` · `/projects/:id/tasks` (attach/detach/reorder)

### Areas — `areas`

Name, colour, icon, position. `isSystem` marks the built-ins. Tasks, projects,
habits and reminders each carry an optional `areaId`. Deleting an area is
`set null` everywhere — it never destroys work.

**Actions:** `GET|POST /areas` · `PATCH|DELETE /areas/:id`

### Habits — `habits` + `habit_entries`

| Field | Meaning |
|---|---|
| `frequencyType` + `frequencyConfig` | `daily`, or a JSON rule |
| `targetCount` | 1 = a checkbox; >1 = a counter ("3 glasses") |
| `isActive` / `archivedAt` | archiving keeps the history |

Entries are one row per habit per day with a `completedCount`. Streaks and
`historyCount` are **derived**, and `historyCount` only counts entries inside
`historyDays` of today.

There is also a **system Diary habit** — writing a diary entry counts as a
habit tick. It is computed, not a row in `habits`.

**Actions:** `GET|POST /habits` · `PATCH|DELETE /habits/:id` ·
`/habits/:id/check` · `/uncheck` · `GET /habits/history`

### Calendar — three different things

**1. Events** (`calendar_events`) — almost always **Google's**. Fields mirror
Google: `providerEventId`, `icalUid`, `recurringEventId`, `originalStartTime`,
`recurrence`, all-day vs timed, attendees, reminders, attachments. Sync state
lives in `calendar_sync_states`; push notifications in
`calendar_watch_channels`; our outgoing writes are queued in
`calendar_mutations`.

**2. Reminders** (`reminders`) — **ours, never Google's.** Title, `dueDate`,
`dueTime` (`HH:MM` local, null = all-day), `leadDays`, status, `deferredTo`.
Recurrence in `reminder_recurrence_rules` (`frequency`, `interval`,
`byWeekday`, `byMonthDay`, `until`/`count`), so a series can be paused,
resumed or ended.

**3. Task schedule blocks** (`task_schedule_blocks`) — "set aside 09:00–10:00
for this task". Points at a task, has a start and end, and can optionally
mirror to a Google event (`mirroredEventId`).

**Actions:** `GET /calendar/range` · `/calendar/pulse` ·
`POST|PATCH|DELETE /calendar/events/:id` · `/calendar/blocks` ·
`/reminders` (+ `/complete` `/reopen` `/pause` `/resume` `/end-series`) ·
`GET|PATCH /calendars/:id`

### Library — `library_items` and the Book stack

`type`: `book` · `document` · `image` · `video` · `link` · `file`.

A **Book** adds `library_books` (cover style, page style, author label) and a
tree: `book_sections` → `book_pages`.

A page has `content` (rich JSON) + `contentText` (for search), a `layout`
(`notes` · `blank` · `two_columns` · `quad` · `comparison` · `pinboard`) and an
optional `purpose` (`checklist` · `ideas` · `research` · `learning` ·
`meeting`). `spansSpread` marks a page that occupies both leaves — the
Pinboard is the one that does.

A project can own a Book (`project_books`).

**Actions:** `/library/items` (CRUD, archive, restore, opened) ·
`/library/books` · `/sections` · `/pages` (+ `/layout`, `/purpose`, archive,
restore) · `/bookmarks` · `GET /library/search` · `GET /library/links`

### Diary — `diary_entries`

One row per `entryDate`. `document` (rich JSON) + `documentText` (search).
Structured check-in fields: `mood`, `energy`, `weatherNote`, `locationNote`,
`daySummary`. Written with `PUT /diary/entries/:date` — the date is the key,
so there is no "which entry" ambiguity.

**Actions:** `PUT /diary/entries/:date` · `GET /diary/entries/:date` ·
`/diary/days` · `/recent` · `/adjacent` · `/search` · `/streak` ·
`/entries/:id/archive` · `/restore`

---

## 3. How things connect

Two mechanisms, and they are different in kind.

**Hard foreign keys** — ownership and belonging:

```
Area  ←── Task, Project, Habit, Reminder     (all nullable, all `set null`)
Project ←── Task            (`set null`: deleting a project never deletes work)
Project ←── Book            (project_books)
Task  ←── Step, ScheduleBlock, Activity
Book  ←── Section ←── Page ←── Bookmark
Habit ←── Entry (one per day)
Calendar ←── Event ←── Attendee, Reminder, Attachment
Reminder ←── RecurrenceRule (one)
```

**`item_links`** — one polymorphic edge for everything else, and deliberately
the *only* one:

```
source: event | reminder | task | habit | library | book_page
target: task  | project  | library | diary | brain | board
kind:   answer | preparation | deadline | resource | …
```

So "this event is preparation for that project", "this reminder is the
deadline for that task", "this book page answers that question" are all the
same row shape. **If the AI needs a new relationship, it belongs here — not in
a new table.**

**This is now a real service, not just a table.** `lib/relationships.ts` owns
every write, validates both ends, refuses self-links and duplicates, and
answers `linksFor(type, id)` with outgoing AND incoming edges in one shape —
backlinks come from a single stored row, never a second one. Ten typed kinds
(`related`, `context`, `resource`, `preparation`, `discussed_in`, `result`,
`deadline`, `follow_up`, `supports`, `scheduled_as`), each phrased for both
ends. Endpoints: `GET /links?type=&id=`, `GET /links/search?q=`,
`GET /links/kinds`, `POST /links`, `DELETE /links/:id`.

**Nine linkable types, and every one of them is inspectable.** task, project,
area, habit, reminder, event, library, book_page, diary — each has a Related
section on its own surface, so a relationship the AI creates can be found by
the person it was created for. `block` is deliberately NOT linkable: a
schedule block has no detail surface, so a link to one could never be seen from
its own end. See `relationships.md` §2.

**An event can be pointed at exactly**: `#calendar/event/<local id>` opens that
event in its normal surface, and because Google is polled with
`singleEvents: true`, that id names ONE OCCURRENCE of a recurring series rather
than the series. A proposal that mentions a meeting can therefore link to the
meeting.

Exactly one kind carries behaviour: `scheduled_as` couples a task to the event
holding its hour, and only the TIME syncs — never titles, never in a way that
reaches Google without the existing confirmation. Everything else is
informational. See `relationships.md` §7.

One rule: links are **never** written into Google event fields. If one is ever
mirrored it goes in a *private* extended property, and the user is told
plainly that other Google users will not see it.

---

## 4. What is already decided about the AI

`web/assistant-contract.js` + `docs/ai-contract.md`. The safety model is:

```
LISTEN → UNDERSTAND → PROPOSE → USER EDITS → CONFIRM → EXECUTE
```

There is **no arrow from listening to writing**. A provider has one method,
`propose()`, which returns a *description* of changes. Nothing a provider
returns reaches the database; a separate executor runs only on explicit
confirmation, past `assertConfirmable()`.

Proposal kinds that already exist:

| Kind | System | Notes |
|---|---|---|
| `task.create` `task.complete` `task.update` `task.schedule` | Tasks | `complete` is *important* |
| `event.create` `event.update` `event.delete` | Calendar | `update`/`delete` are *important* |
| `reminder.create` | Reminders | |
| `habit.check` | Habits | |
| `project.update` | Projects | *important* |
| `list.add` `library.append` | Library | |
| `link.create` `link.remove` | Relationships | `remove` is *important* |
| `answer` | — | not a change; no confirmation, not counted |

*Important* = never committed on a voice command alone, however confident the
model is: a meeting other people were invited to, a project's state, a deleted
task. Each needs its own explicit confirmation.

Editable field types the proposal UI can render: `text`, `date`, `time`,
`duration`, `choice`, `note`.

---

## 5. Gaps worth naming before designing

**As of the AI foundation pass, the authoritative answer to "what can the
assistant do" is `GET /ai/capabilities`, built from module registration.** The
list below is the remaining gap between what the app can do and what any module
has registered — see `ai-system.md` §19.

Things the app can do that the assistant currently has **no capability for** —
each is a deliberate decision, not an oversight to fix silently:

- Creating or editing **Projects** (only `project.update` exists), **Areas**,
  **Habits** (only `check`), or **Books/Sections/Pages** beyond appending
- Writing a **Diary** entry or a check-in field
- **Reordering** anything, or moving a task between buckets
  (`task.update` may cover this; the contract does not say)
- **Reminder recurrence** — `reminder.create` exists; series control does not

**Relationships are no longer on that list.** `link.inspect`, `link.traverse`,
`link.create` and `link.remove` are registered capabilities and go through the
relationship service rather than the table. `link.remove` is *important*: it
destroys a judgement somebody made.

**Nor are Habits and Reminders.** `habit.check` and `reminder.create` are
registered, and both call the same application service the UI calls. Projects
gained `project.update`; creating and completing one are still absent, with
reasons recorded in `ai-system.md` §19.

And two facts an AI planner needs to hold:

1. **Google owns most events.** Creating one is a write to somebody else's
   system, subject to their rate limits and visible to other attendees. Our
   reminders and blocks are ours alone and are safe to be liberal with.
2. **`dueDate` ≠ `scheduledAt`, and `status` ≠ `focus`.** Most natural-
   language scheduling errors will be a collapse of one of those two pairs.
