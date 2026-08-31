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
| `block` | a Life OS schedule block — time set aside for a task |
| `library` | any library item: book, document, image, video, link, file |
| `book_page` | one page inside a Book |
| `diary` | one day's diary entry |

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
| Task | Book page | `resource` |
| Task | Event | `preparation`, `scheduled_as` (coupled) |
| Event | Project | `related` |
| Event | Task | `preparation` |
| Book page | Event | `discussed_in` |
| Book page | Task / Project / Library | `context` (mirrored from page bodies) |
| Diary entry | Project | `discussed_in` |
| Diary entry | Task | `result` |
| Diary entry | Event | `related` |
| Habit | Project | `supports` |
| Reminder | Task | `deadline` |
| Library item | anything | `resource`, `reference` |

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

| Surface | Where |
|---|---|
| Task editor | foot of the modal body |
| Project detail | its own section, below Tasks, above the Book card |
| Calendar event (editor) | replaces the old "Life OS links" chips |
| Calendar event (Google detail sheet) | foot of the sheet |
| Habit editor | below the recent-history strip |
| Diary | foot of the check-in page |
| Book page | foot of the page |

A single stored row `A → B` answers both questions. `linksFor(type, id)` runs
two indexed queries — one on `(source_type, source_id)`, one on
`(target_type, target_id)` — and returns one normalised list with `direction`
recorded and the label already resolved to the correct end. **Backlinks are
never a second row.** Storing the reverse would mean every unlink had to find
and delete both, and the first miss would leave the graph disagreeing with
itself.

Clicking a link opens the thing: tasks and habits in their own editors,
everything else by URL (`#projects/<id>`, `#diary/<date>`,
`#library/book/<item>?p=<page>`, `#calendar/reminders`).

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

---

## 11. Current limitations

- **Events have no deep link.** A link to an event navigates to `#calendar`,
  not to that event. Every other type opens at the exact object.
- **`area` and `block` can be linked but have no Related section of their
  own** — they appear as the far end of other objects' links. Areas are
  configuration; blocks are addressed through their task.
- **The `scheduled_as` coupling only exists for Google-backed events.** A
  Life OS schedule block relates to its task structurally
  (`task_schedule_blocks.task_id`), so there is no edge to show and nothing to
  demonstrate without a connected Google account.
- **No link is created automatically except** page-body references (`context`,
  by `book-links.ts`) and scheduling (`scheduled_as`). Nothing infers a
  relationship from matching titles, and nothing should: that is precisely the
  guess this design exists to avoid.
- **Reminders have no Related section yet.** They can be linked and appear on
  other objects' lists; the reminders list itself is a utility view rather than
  a detail surface.
- `linkCounts` exists but no list view calls it. Dense rows were left clean on
  purpose; wire it in if a count turns out to be wanted.
