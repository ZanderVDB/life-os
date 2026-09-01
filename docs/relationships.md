# Relationships in Life OS

The canonical map of how one thing in Life OS refers to another. Written from
the v2 schema and the live service, not from Legacy.

---

## 1. Philosophy: two kinds, and they are not interchangeable

**Structural relationships are foreign keys, and they stay foreign keys.**
A task belongs to a project. A page belongs to a section. A habit entry belongs
to a habit. One side owns the truth, the database enforces it, and deleting the
owner has defined consequences. Nothing in the generic layer replaces any of
these — two competing answers to "which project is this task in" is worse than
either answer alone.

**Semantic relationships** are edges between otherwise independent objects,
where neither owns the other and removing the edge removes nothing but the
edge. "This page is a resource for that task." "This meeting was discussed in
Tuesday's diary entry." These live in `item_links`, and `lib/relationships.ts`
is the only module that should write to it.

One polymorphic table, not `TaskLinks` + `EventLinks` + `ProjectLinks`. The
alternative is n² tables, n² queries, and n² places to forget to clean up on
delete.

---

## 2. Active entity types

Anything a person can open and would reasonably want to connect to something
else. Defined once, in `ENTITY_TYPES`:

| Type | Is |
|---|---|
| `task` | a single action |
| `project` | a finite outcome |
| `area` | a part of a life |
| `habit` | a recurring intention |
| `reminder` | a Life OS reminder (never Google's) |
| `event` | a calendar event, usually Google's |
| `library` | any library item: book, document, image, video, link, file |
| `book_page` | one page inside a Book |
| `diary` | one day's diary entry |

### The rule that decides membership

> **If an entity can take part in a relationship, a person must be able to
> discover that relationship from that entity.**

A graph that is bidirectional in the database and one-directional on screen is
not bidirectional to the person using it. So a type earns a place in
`ENTITY_TYPES` by having somewhere its own relationships are shown — and
`relationship-surfaces.test.ts` enforces exactly that, by checking every type
against the `data-rel-host` declarations in the web source. Adding a type
without a surface fails the suite.

### Why `task_schedule_blocks` is NOT an entity type

A block is **time set aside for a task**. It has no title of its own — the
service that used to summarise one read its name live from its task — no detail
sheet, no editor, and no route. On the Plan canvas it is a rectangle you drag
and resize; there is no way to open one, so there is nowhere a relationship
attached to a block could ever be seen from the block's end.

It was listed as linkable in the first pass and never had a surface. Two ways
out: build an inspector for it, or stop pretending it is a thing you point at.
**We stopped pretending.** A block has no identity a person thinks in — what
they mean when they point at one is the *task*, which is linkable, has an
editor, and is where the block's name already comes from. Building a detail
screen for a block would invent an object the product does not have.

Nothing was lost and nothing was migrated: the type had no surface, so no user
could have created such an edge, and none exists. `task_schedule_blocks`
remains a first-class domain object with its own table, its own foreign key to
its task and its optional `mirroredEventId`. It is simply not a semantic
endpoint. `scheduled_as` is unaffected — it couples a task to an **event**,
never to a block.

**`brain` and `board` are not here.** They were named in the original comment
on the table as future targets. Neither system was built, and **no row has ever
carried either value** — verified before this pass by searching every write
site. There was nothing to migrate and nothing to destroy. If either arrives,
it is added to `ENTITY_TYPES` and nowhere else.

---

## 3. Structural relationship matrix

Built into the canonical model. **Do not express any of these as an
`item_link`.**

| Relationship | Mechanism | On delete |
|---|---|---|
| Task → Project | `tasks.project_id` | `set null` — deleting a project never deletes work |
| Task → Area | `tasks.area_id` | `set null` |
| Project → Area | `projects.area_id` | `set null` |
| Habit → Area | `habits.area_id` | `set null` |
| Reminder → Area | `reminders.area_id` | `set null` |
| Task → Steps | `task_steps.task_id` | cascade |
| Project → primary Book | `project_books` | the Book survives; the caller chooses keep / archive / delete |
| Book → Sections → Pages | `book_sections.book_id`, `book_pages.section_id` | cascade |
| Habit → completion history | `habit_entries.habit_id` | cascade; archiving a habit keeps it |
| Task → Schedule block | `task_schedule_blocks.task_id` | cascade |
| Block → mirrored Event | `task_schedule_blocks.mirrored_event_id` | `set null` |
| Reminder → recurrence rule | `reminder_recurrence_rules.reminder_id` | cascade |
| Event → attendees / reminders / attachments | FKs on `calendar_events` | cascade |
| Project → chosen next action | `projects.next_task_id` | `set null` |

---

## 4. Semantic relationship matrix

Any active type may appear on **either** side of an edge. The pairs below are
the ones the application and the brief actually call for; the layer does not
enforce a whitelist beyond "both types are active and both rows exist", because
a whitelist is a list somebody has to remember to extend.

| From | To | Typical kind |
|---|---|---|
| Task | Book page / Library item | `resource` |
| Task | Event | `preparation`, `scheduled_as` (coupled) |
| Task | Reminder | `preparation` |
| Event | Project | `related` |
| Event | Reminder | `follow_up` |
| Book page | Event | `discussed_in` |
| Book page | Task / Project / Library | `context` (mirrored from page bodies) |
| Project | Diary entry | `discussed_in` |
| Project | Library item | `resource` |
| Diary entry | Task | `result` |
| Diary entry | Area | `related` |
| Habit | Project | `supports` |
| Reminder | Project | `deadline` |
| Library item | Area | `related` |

### Direction is not decoration

`label` is what the **source** says about the target; `inverse` is what the
target says back. Both rendered rows read the same way — **"this &lt;label&gt;
that"** — so the direction an edge is written in decides whether either end
makes sense. Three patterns are worth stating outright, because all three were
written backwards in the first pass's sample data and only the rendered rows
revealed it:

- **`resource`** puts the resource at the **target**. The source is whoever
  uses it. `task → page` reads "this task's Resource is that page" and "this
  page is Used by that task". Reversed, both ends are nonsense.
- **`preparation`** puts the preparation at the **source**. `task → event`
  reads "this task is Preparation for that meeting" and "this meeting is
  Prepared by that task". A meeting is not preparation for a task.
- **`follow_up`** puts the follow-up at the **target**. `event → reminder`
  reads "this meeting's Follow-up is that reminder" and "this reminder Follows
  from that meeting".

The test is mechanical: read both rows aloud. If either is not a sentence a
person would say, the edge is the wrong way round — and the fix is the
direction, never the vocabulary.

---

## 5. Supported relationship types

Small on purpose. A large ontology is a vocabulary nobody learns, and the
failure mode is ten synonyms for "related" chosen at random.

`label` reads from the source; `inverse` reads from the target. Both exist
because "preparation for" and "prepared by" are one edge seen from two ends,
and a backlink list showing the wrong one is simply wrong.

| Kind | From the source | From the target | Example |
|---|---|---|---|
| `related` | Related to | Related to | anything, when nothing more precise is true |
| `context` | Context | Referenced by | a page body that names a task |
| `resource` | Resource | Used by | the page holding the spec for a task |
| `preparation` | Preparation for | Prepared by | the meeting you must be ready for |
| `discussed_in` | Discussed in | Discusses | the diary entry that talks about a project |
| `result` | Resulted in | Result of | the task that came out of a meeting |
| `deadline` | Deadline for | Deadline | the reminder that dates a task |
| `follow_up` | Follow-up | Follows from | the task after the task |
| `supports` | Supports | Supported by | the habit that serves a project |
| `scheduled_as` | Scheduled as | Schedules | **coupled** — see §7 |

A free-text `note` may accompany any edge. It is a human aside, never the
canonical type: nothing branches on it.

---

## 6. Visibility and backlinks

**A relationship that exists only in the database is not a relationship the
user has.** One component, `web/related.js`, renders the same `Related` section
wherever an object is open:

### The visibility matrix

Every active linkable type, and where its relationships are on screen. There is
no row with "nowhere" in it, and there cannot be — the suite fails if one
appears.

| Type | Where its Related section lives | Link | Backlinks | Opens the other end |
|---|---|---|---|---|
| `task` | Task editor, foot of the body | yes | yes | opens the task's editor |
| `project` | Project detail, below Tasks and above the Book card | yes | yes | `#projects/<id>` |
| `area` | **Area inspector** — Settings › Areas › *Details* | yes | yes | opens the inspector |
| `habit` | Habit editor, below the recent-history strip | yes | yes | opens the habit's editor |
| `reminder` | **Reminder editor**, outside "More options" | yes | yes | opens the reminder's editor |
| `event` | Event editor *and* the Google detail sheet | yes | yes | **`#calendar/event/<id>`** |
| `library` | **Book cover** for a Book; **item page** for everything else | yes | yes | `#library/book/<bookId>` or `#library/item/<id>` |
| `book_page` | Foot of the open page, on the spread | yes | yes | `#library/book/<bookId>?p=<pageId>` |
| `diary` | Foot of the day's check-in page | yes | yes | `#diary/<date>` |

Two of those destinations were wrong before this pass and are worth naming: a
Book link pointed at `#library/book/<libraryItemId>`, which resolves to
nothing, because the route takes the `library_books` id; and every non-book
item pointed at the shelf, which is not following a link, it is being told
roughly where to look.

**Where each surface is, and why there:**

| Surface | Placement |
|---|---|
| Task editor | foot of the modal body |
| Project detail | its own section, below Tasks, above the Book card |
| Calendar event (editor) | inside "More options", beside the other Life OS-only fields, under a line saying Google will not show them |
| Calendar event (Google detail sheet) | foot of the sheet |
| Habit editor | below the recent-history strip |
| Reminder editor | **outside** "More options" — what a reminder is *for* is not an advanced setting, and a reminder is the one Calendar object that is entirely ours |
| Area inspector | the whole point of the surface; it sits under the counts |
| Book cover | under the closed cover — the book **as an object** |
| Library item page | under the facts, on `#library/item/<id>` |
| Diary | foot of the check-in page |
| Book page | foot of the page, on the spread |

### Three different things in the Library, kept apart

Conflating these would make all three useless:

1. **Book → Section → Page is ownership**, and structural. It is the contents
   list. It is never an `item_link` and never appears in a Related section.
2. **What the Book is about** is a relationship belonging to the **library
   item**, and it lives on the **cover** — the book as a closed object.
3. **What one page is connected to** belongs to that **page**, and appears on
   the spread when that page is open.

**Page links are deliberately not rolled up onto the Book.** A book with forty
pages would show forty relationships that are not about the book, and the one
that *is* about the book would be lost among them.

A single stored row `A → B` answers both questions. `linksFor(type, id)` runs
two indexed queries — one on `(source_type, source_id)`, one on
`(target_type, target_id)` — and returns one normalised list with `direction`
recorded and the label already resolved to the correct end. **Backlinks are
never a second row.** Storing the reverse would mean every unlink had to find
and delete both, and the first miss would leave the graph disagreeing with
itself.

Clicking a link opens the thing. Tasks, habits, areas and reminders open their
own editor — the same one used everywhere else, because a link that opened a
different, read-only version of a task would be a second task screen. A
reminder fetches the reminder list first if it is not already loaded, so the
click behaves the same from Today as it does from Calendar. Everything else
navigates by URL, and every one of those URLs survives a refresh.

Dense list rows are deliberately left alone. `linkBadgeHtml` exists for a count
where one is wanted; the Today board does not use it, because a board is for
deciding what to do next, not for reading a graph.

---

## 7. Synchronisation: informational vs coupled

**Nine of the ten kinds carry no behaviour at all.** A task linked to a page as
a `resource` does not rename the page when the task is renamed, does not move
it and does not delete it. The edge carries meaning for a reader and nothing
else.

`scheduled_as` is the single exception, and it is marked `coupled: true` in
`LINK_KINDS`. Behaviour lives on the **kind**, not on the row — putting a
`coupled` flag on each row would let two edges of the same kind behave
differently, which is a bug waiting to be filed.

It is created **only** by the scheduling flow (`linkTaskToEvent` in
`lib/calendar-mutations.ts`). `createLink` refuses it outright: handing it out
generically would let anything claim two records are the same work without any
of the machinery that keeps them honest.

### Opening the exact event

`#calendar/event/<id>` — where `<id>` is the **local `calendar_events` row**.
Following an event link moves the Calendar to that event's day and opens it in
its normal surface: the Google detail sheet for a synced event, the editor for
one of ours. There is no second event page, and the phone gets the same
surface as the desktop, in its usual sheet treatment.

**Why a local id is the whole identity.** Google is polled with
`singleEvents: true`, so a recurring series arrives **already expanded into
occurrences**. Each occurrence carries its own `providerEventId`
(`<seriesId>_<utcStart>`), and the upsert is keyed on
`(calendar_id, provider_event_id)` — so every occurrence has its own row and
that row's uuid is stable across every future sync.

Which means a link names **one occurrence**, unambiguously, and the URL needs
no series id, no start time, no calendar and no Google account. `9am Tuesday`
of a weekly meeting can never resolve to a different Tuesday. `recurringEventId`
and `originalStartTime` come back in the payload — so a surface can say *which*
occurrence of *what* this is — but they are never how it is found.

**Never a title-and-date lookup.** Two occurrences of one weekly meeting share
a title and a series and differ only by start; the day that heuristic is used
is the day it silently opens the wrong one.

`GET /calendar/events/:id` resolves it, returning the event in the same shape
`/calendar/range` sends, plus the civil `day` to move to and an `occurrence`
block when the row is part of a series. The event is added to the loaded range
if it is not already in it — Agenda mode always asks for the next sixty days
regardless of the anchor, so "move the calendar and hope" is not enough.

**A stale link fails gracefully.** A deleted event, a disconnected calendar or
a mistyped id is a 404, and the client turns it into: the hash goes back to
plain `#calendar` with `replaceState` (a dead link must not become a Back
step), the Calendar renders normally, and a message says *"That event is no
longer in your calendar."* Closing the surface also drops the route back to
`#calendar`, and only when the hash still belongs to that event — closing after
navigating elsewhere must not drag anyone back.

### Task ↔ Event: exactly what happens

| Event | Behaviour |
|---|---|
| **Task title changes** | Nothing propagates. The event keeps its own title. |
| **Event title changes** | Nothing propagates. The task keeps its own title. |
| **Task `scheduledAt` changes in Life OS** | The event is **not** silently moved. Rescheduling through the calendar goes through the normal event-edit path, which is confirmed and which Google must accept. |
| **Event moves (in Life OS, after Google confirms)** | `syncLinkedTaskTime` sets the task's `scheduledAt` to the new start. Runs **after** Google confirms, never before — a task claiming a time Google refused is a lie the user cannot see. |
| **Event moves in Google externally** | Same path on the next sync. |
| **Event deleted** | `releaseLinkedTasks`: the task **survives**. Its `scheduledAt` is cleared only if that value is the one this event put there (`metadata.setScheduledAt`); a time the user set by hand is theirs. The **due date is never touched**. The edge is removed. |
| **Task deleted** | `cleanupLinksFor` removes the edge. The event is untouched — deleting a task must never delete a meeting other people were invited to. |
| **Relationship removed** | Not offered in the UI for a coupled edge: the row shows a marker instead of an unlink control, because the way to undo "this is scheduled as that" is to unschedule. `removeLink` refuses it too. |

### What deliberately does NOT synchronise, and why

- **Titles, in either direction.** Renaming a task must not rewrite a Google
  event that other attendees can see. Any change that would reach Google goes
  through the existing calendar confirmation flow — which checks the event's
  `etag` first and refuses if it changed underneath you.
- **`dueDate` and `scheduledAt`.** "Due Friday" and "I'll do it Wednesday" are
  different statements. Collapsing them makes both untrustworthy.
- **Completion.** Finishing the task does not erase the hour it took;
  cancelling the meeting does not mean the work is done.
- **Anything at all for the other nine kinds.** They are informational.

**A Life OS schedule block** is different from a Google event and is treated
so: it has no title of its own, and its display name is read live from its
task. Deriving it is safe precisely because the block is ours — nobody else can
see it and no external system owns it.

---

## 8. Deleting

- **Unlinking removes the edge and nothing else.** Both objects survive. This
  is why unlink needs no confirmation.
- **Deleting an entity removes its edges.** `item_links` is polymorphic, so it
  has no foreign key to what it points at and nothing in the database will do
  this. `cleanupLinksFor` is called on task, project, habit and reminder
  deletion, and library deletion already cleaned up its own page edges.
- **An edge never cascades into an entity.** Deleting a link cannot delete a
  page. `linksFor` also drops any edge whose far end no longer resolves, so a
  path that forgets to clean up degrades to an invisible row rather than a
  broken screen.
- Structural deletion semantics are unchanged: orphaning a project's tasks,
  archiving vs deleting a habit, the Book keep/archive/delete choice.

---

## 9. The service and API

`api/src/lib/relationships.ts` is authoritative. Routes, UI and — later — the
assistant all call it; none of them touch `item_links` directly. The single
documented exception is `lib/book-links.ts`, which mirrors references out of
page documents inside the page-save transaction.

| Function | Does |
|---|---|
| `createLink(db, ws, {…})` | validates both types, both rows, the kind and self-linking; returns the existing edge if one matches, so pressing "link" twice is not an error |
| `removeLink(db, ws, id)` | deletes the edge only; refuses coupled kinds |
| `linksFor(db, ws, type, id)` | `{ outgoing, incoming, links, count }`, entity summaries resolved |
| `summarise(db, ws, refs)` | titles, subtitles and hrefs, batched per type, read **live** — never copied into the edge |
| `searchLinkable(db, ws, q)` | candidates across every type at once |
| `cleanupLinksFor(db, ws, type, id)` | every edge touching an entity being deleted |
| `linkCounts(db, ws, type, ids)` | counts for badges |
| `entityExists`, `isEntityType`, `isLinkKind`, `isCoupled` | the guards |

Endpoints, all workspace-scoped under `/api/v1/workspaces/:workspaceId`:

```
GET    /links/kinds                     the vocabulary, so the client cannot offer
                                        a kind the server rejects
GET    /links?type=&id=                 outgoing + incoming, one shape
GET    /links/search?q=                 candidates across every type
POST   /links                           201 created, 200 if it already existed
DELETE /links/:id                       the edge only
```

One route outside the links namespace exists for the same purpose — resolving a
link to the thing it points at:

```
GET    /calendar/events/:id             one event, by its local id, plus the
                                        civil `day` to open and an `occurrence`
                                        block when it belongs to a series.
                                        404 when it is gone — see §7.
```

### Migration

**None was required.** `source_type`, `target_type` and `kind` are plain `text`
with no CHECK constraint, so new values are additive at the database level.
Both directions were already indexed (`item_links_source_idx`,
`item_links_target_idx`) and the unique index already covered
`(source_type, source_id, target_type, target_id, kind)`. Validation is done in
the service rather than in a constraint, deliberately: a CHECK would have to
tolerate every value ever written, and the set of active types is a product
decision that changes more often than a schema should.

---

## 10. How the assistant should use this

`docs/ai-contract.md` still governs: **propose, never write.** Two proposal
kinds exist for relationships:

- `link.create` — ordinary. A link is cheap and reversible.
- `link.remove` — **important**. It destroys a judgement somebody made, so it
  needs its own explicit confirmation.

The traversal the assistant needs is the one the UI already uses:

1. resolve an entity (`searchLinkable`, or an id it already holds);
2. `linksFor(type, id)` — everything connected, both directions, summarised;
3. follow `entity.type` / `entity.id` on any result;
4. repeat.

There is deliberately **no separate "AI query"**. A second answer to the same
question is a second answer free to drift from the first.

### Inferring a relationship (Phase 4)

The assistant may NOTICE a connection and propose it. When the user says

> *"The client call on Thursday is where we're going to discuss the annual
> returns"*

and both entities resolve confidently, the right response is a `link.create`
proposal with `kind: discussed_in`.

Three rules make that safe, and they are enforced outside the model:

1. **An inferred link is a mutation.** It goes on a card and waits for
   confirmation like everything else. There is no path by which noticing
   something writes an edge.
2. **Both ends must resolve to real ids.** The shared resolver
   (`ai-system.md` §6f) answers `resolved`, `ambiguous` or `none`; only the
   first may be linked. *"Link the call to the project"* with three plausible
   calls produces a question, not a choice.
3. **The kind comes from what the user said**, and `scheduled_as` is never
   available to `link.create` — it is created by scheduling, being the one
   coupled kind (§7).

A link created this way is one `item_links` row, identical to one the UI would
have written. Nothing about it is AI-specific, and there is no second table.

---

## 11. Current limitations

Four of the limitations recorded after the first pass are gone: events deep-link
to the exact event, Areas and Reminders have their own surfaces, and `block` is
no longer a linkable type. What is actually left:

- **The `scheduled_as` coupling can only be demonstrated with a connected
  Google account.** It is created by the scheduling flow, which writes through
  Google. Its rules are covered by tests, and `createLink` refuses the kind, so
  the safety is enforced rather than assumed — but there is no synthetic path
  that produces a coupled edge to look at.
- **A diary day is found in the picker by its date, not by what it says.** The
  Diary has full-text search of its own; the link picker matches titles (and a
  diary day's date), because one shared `LIKE` across seven tables is not the
  place to reimplement it.
- **No link is created automatically except** page-body references (`context`,
  by `book-links.ts`) and scheduling (`scheduled_as`). Nothing infers a
  relationship from matching titles, and nothing should: that is precisely the
  guess this design exists to avoid.
- **No graph view.** You can see a thing's neighbours from that thing. You
  cannot see the whole shape, deliberately — §1.
- `linkCounts` exists but no list view calls it. Dense rows were left clean on
  purpose; wire it in if a count turns out to be wanted.
