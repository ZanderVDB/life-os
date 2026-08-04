# Projects — v2 product model

Status: **built in Phase E2** and deployed to v2 staging. The definition,
lifecycle, progress model, next-action rule and discoverability model below are
implemented. Boards, Library and AI are not — see
[projects-v2-future-architecture.md](projects-v2-future-architecture.md).

One thing changed between the E1 proposal and what was built, and it is the most
important addition: **lifecycle and focus are two separate fields.** See below.

---

## What a Project is

> **A Project is a finite outcome that needs more than one action, and enough
> context that you would lose the thread without somewhere to keep it.**

Two clauses, both load-bearing. "Finite outcome" separates a Project from an
Area. "Enough context that you would lose the thread" separates it from a Task
with subtasks — which is the distinction most tools get wrong, and the one that
decides whether Projects is a real system or a folder with a progress bar.

### Challenging the proposed definition

The brief proposed: *"a finite outcome or meaningful body of work that requires
multiple actions, context and progress over time."* Two problems.

**"Meaningful body of work" is not a test.** It cannot tell you whether
"Redesign the kitchen" is a Project. Anything can be argued into it, so
everything becomes one, and the overview turns into a second task list. The
context clause above is a test you can actually apply: *if I put this down for
three weeks, is there something I would need to read to pick it up again?* If
no, it is a Task with steps.

**"Progress over time" is a consequence, not a criterion.** Something is not a
Project because it has progress; it has progress because it is a Project. Using
it as part of the definition is what leads to progress bars on things that do
not need them.

### The boundary, stated once

| | Finishes? | Contains | Has state |
|---|---|---|---|
| **Area** | No — ongoing part of life | Projects, Tasks | No |
| **Project** | Yes — a defined outcome | Tasks, notes, dates, links | Yes |
| **Task** | Yes — one action | Steps | Open / done |
| **Reminder** | Recurs or fires once | Nothing | Firing / paused |
| **Habit** | Never — repeated behaviour | Entries | Streak |
| **Calendar event** | Occupies time | Nothing | — |

Rules that follow, and are not negotiable later:

- An Area is never a Project. Areas classify; Projects finish.
- A Project is never a folder. A folder holds things; a Project *is going
  somewhere*, and the interface must be able to say where.
- A Task may belong to zero or one Project. Not many.
- A Habit is never inside a Project. A Project can *depend* on a habit
  ("practise daily") but containing it would make the Project uncompletable.
- A Reminder is not work. It can point at a Project; it is never progress.

---

## Lifecycle

Four states. Adding a fifth needs a reason that cannot be answered by a filter.

```
          ┌──────────────────────────────────────────┐
          ▼                                          │
   ┌─────────────┐   start    ┌────────┐  complete  ┌───────────┐
   │  Planning   │───────────▶│ Active │───────────▶│ Completed │
   └─────────────┘            └────────┘            └───────────┘
          │                    ▲     │                     │
          │                    │pause│resume               │ archive
          │                    │     ▼                     ▼
          │                  ┌──────────┐            ┌──────────┐
          └─────────────────▶│ On hold  │───────────▶│ Archived │
             shelve          └──────────┘   archive  └──────────┘
```

- **Planning** — exists, outcome not yet committed to. Does not appear in
  "what am I working on".
- **Active** — being worked on. The only state that competes for attention.
- **On hold** — deliberately paused. Keeps everything; stops asking.
- **Completed** — the outcome happened. Fact, not tidying.
- **Archived** — out of the way. Says nothing about whether it succeeded.

**Completed and Archived are different, deliberately.** Completed means you got
what you wanted. Archived means you stopped caring. Collapsing them loses the
only interesting distinction in the tail of a project list — a project you
abandoned and a project you finished should never read the same.

**"Blocked" is not a status.** It is a *condition*, and it is almost always
temporary and specific ("waiting on David's invoice"), not a state of the whole
project. As a status it goes stale within days and nobody clears it. It belongs
as a **health signal** derived from evidence:

- no open Task, but the Project is Active → *nothing to do next*
- nothing has changed in 21 days → *stalled*
- target date passed with open Tasks → *overdue*
- an explicit "waiting on…" note the user wrote and can clear

Health is shown where it changes behaviour and nowhere else.

**Transitions.**
- Starts as Planning when created without a Task; Active when created with one.
  A project you create *in order to* do something should not need a second
  click to admit it.
- Pausing is one action and reversible. It never touches Tasks.
- Completing asks about open Tasks — see Task integration. It never silently
  completes them.
- Archiving is available from any state; restoring returns it to its previous
  state, not to Active.

---

## Core fields

**Essential for the first release** — the smallest set that supports the
overview, the detail page and progress:

| Field | Why it exists |
|---|---|
| `title` | The name you would say out loud. |
| `outcome` | One line: what is true when this is done. This is the field that makes a Project a Project. |
| `area_id` | Exactly one. Inherited by its Tasks by default. |
| `status` | The four states above. |
| `description` | Context you would need after three weeks away. |
| `target_date` | Optional. When it should be true by. |
| `next_task_id` | Optional explicit override — see Next action. |
| `position` | Manual order within a status group. |
| `completed_at`, `archived_at` | Facts, not flags. |

**Deliberately deferred, and why:**

- **`start_date`** — nobody looks at it. Add it when something needs it.
- **`priority`** — Tasks already have priority. A priority on the container as
  well means two answers to "what is most important" that will disagree.
  Order within Active is the same information, expressed once.
- **`progress` (stored)** — derived, never stored. See below.
- **Milestones** — a real feature with real UI, and none of the ~12 Legacy
  Projects has anything resembling one. Adding it now would ship an empty
  section on every project.
- **People / assignees** — one life, one workspace, one person. Legacy had
  People and it was removed in v2 for this reason.
- **Files** — belongs to Library. The link model below reaches it without
  Projects owning storage.

---

## Progress

**Derived from Tasks, never stored, and never shown when it would lie.**

```
open + done Tasks in the project
        │
        ├─ none          → no bar. Show the state instead: "Nothing planned yet".
        ├─ all open      → bar at 0 with a count: "0 of 6 done".
        └─ some done     → done / (done + open), always with the raw count.
```

Three rules that stop it becoming decorative:

1. **Never a bare percentage.** Always "4 of 9 done". A percentage alone hides
   whether it is 4/9 or 400/900, and those are different situations.
2. **A Project with no Tasks shows no progress**, not 0%. 0% claims you have
   measured something. "Nothing planned yet" is both true and actionable.
3. **Cancelled Tasks leave the denominator.** A task you decided not to do is
   not incomplete work.

**Weighting is deliberately not in v1.** Every weighting scheme (points, size,
milestones) requires the user to maintain it, and an out-of-date weight is
worse than an honest count. The distortion is real — one trivial task counts as
much as one large one — so the interface never presents the number as an
estimate of *effort remaining*. It says how many things are done, which is
exactly what it measures. If this proves insufficient, milestones are the
correct answer, not weights.

Progress is **not** shown for On hold, Completed or Archived projects. A paused
project's percentage is a number about the past.

---

## Next action

**Inferred by default, overridable, never AI.**

Default: the first open Task by (due date, then priority, then position). If
the user picks one explicitly, that choice wins until it is completed, at which
point the Project falls back to inference. A pinned next action that survives
its own completion is how these go stale.

If there is no open Task, the Project says so plainly — *"No next action —
add one"* — and that is a health signal, not an empty slot. An Active project
with nothing to do next is the single most useful thing the overview can
surface.

No claim of prioritisation, ranking or intelligence. The rule is written down
above precisely so the user can predict it.

---

## Projects overview

Answers, in order: **what am I working on, what needs attention, what have I
paused, what did I finish.**

Structure — one list, grouped, not a card gallery:

```
NEEDS ATTENTION   (only when non-empty)
  · no next action · stalled 21d+ · overdue target

ACTIVE
  <project rows, manually orderable>

ON HOLD           (collapsed by default when empty is not the case)

RECENTLY COMPLETED (last 30 days, then behind a filter)
```

Each row carries: title, outcome, Area, next action, progress count, and a
health mark only when there is one. That is the minimum that lets you decide
what to open without opening it.

**Not shown:** total project count, total task count, completion percentage of
the whole system. None of them changes what you do next. "12 projects" is the
kind of number that feels like information and is not.

**Needs attention only appears when it has something to say** — the same rule
the Calendar rail settled on in D4.6.

---

## Project detail

Answers: **what is this, what is next, what is left, what changed.**

```
HEADER      title · outcome · Area · status · target date
NEXT        the one action, with a way to change it
TASKS       open, then done — the same Task rows as Today
NOTES       one freeform field, not a document system
ACTIVITY    what changed and when
```

Sections deferred until the data supports them: **Timeline** (needs milestones
or dated events, and neither exists yet), **Linked calendar items** (arrives
with the link model, below), **Library** (does not exist).

Tasks in a Project use the **same rows, same interactions and same API** as
Today. A second task UI is a second set of bugs.

---

## Task integration

- A Task has zero or one Project. `tasks.project_id` already exists as a
  nullable column with an index — no migration needed.
- Adding a Task to a Project **adopts the Project's Area** if the Task has
  none. If the Task already has a *different* Area, the app **asks once**:
  keep the Task's Area, or move it to the Project's. It never changes an
  explicit classification silently — Area is how the user finds things.
- Changing a **Project's** Area offers to move its Tasks, defaulting to yes,
  and reports how many. Tasks whose Area was set by hand are listed separately.
- Project Tasks appear in Today and are schedulable in Plan week, unchanged.
  They are Tasks; the Project is context, not a container.
- Completing a Project **never completes its Tasks.** It asks: leave them,
  or cancel them. Cancelled is honest — you decided not to do them. Silently
  marking them done fabricates work.

---

## Calendar integration

First release, both directions read-only with respect to Google:

1. **Project target date** — a date on the Project, shown in Month/Agenda as a
   Life OS marker. Not an event, and never written to Google.
2. **Scheduled Project Tasks** — already works. A task block inherits its
   Task's Project, so Plan week can show what a block is *for*.
3. **Link an existing event to a Project** — via `calendar_item_links`
   (`sourceType: 'event'`, `targetType: 'project'`). The event stays a Google
   projection; the link is Life OS's.

Deferred: milestones as calendar items, project reminders, preparation tasks.

**No Google write access.** A Project date does not create a Google event, and
a linked event is not modified. If a link is ever mirrored to Google it goes in
a private extended property, and the user is told plainly that nobody else will
see it.

---

## Library (future)

Projects must be attachable to Library material without Projects owning files.
`calendar_item_links` is already polymorphic (`targetType: task | project |
library | diary`) but its name is wrong for general use.

Recommendation: **rename it to `item_links` in the E2 migration** and let it
carry every Life OS relationship, or add a sibling `item_links` table and leave
the calendar one alone. Either is cheap now; neither is cheap after Projects
ships with a project-specific link table.

No Library placeholders in the Projects UI. An empty "Documents" section on
every project is a promise the app cannot keep.

---

## Discoverability

The existing **Projects** sidebar item is the destination. From it: see all,
filter to Active / On hold / Completed, create, open, edit, archive, restore.

Completed and Archived are reachable but not prominent — a filter, matching the
Reminders workspace pattern from D4.6 (Active / Paused). Nothing about Projects
lives in Settings.

---

## Right rail

**Overview: no rail.** Everything the rail would show — what needs attention,
what is next — belongs in the list itself, where it can be acted on. A rail
that summarises the list next to the list is the "rail kept for symmetry"
D4.6 removed from Calendar.

**Detail: no rail in v1.** The candidates (activity, linked items) are either
secondary enough to sit at the bottom of the page or do not exist yet. Revisit
when Timeline or Library gives it something that cannot be inline.

This is a recommendation to build *nothing*, which is the point: the rail is
optional, and Projects has not yet earned one.

---

## Open questions for the user

Recorded in the E1 report rather than answered here.

---

## Responsive model

The overview is a **list**, not a card grid, and that decision is made here
rather than at the mobile breakpoint. A card grid has to become a list on a
phone, which means designing the same screen twice and having the two disagree.
A list is the same object at every width; only its density changes.

**Large desktop (≥1600)** — the calendar frame width, list rows with title,
outcome, area, next action and progress on one line. No rail.

**Laptop (1280–1600)** — same layout. Outcome truncates before next action does;
next action is the thing you came for.

**Tablet (768–1280)** — rows stack into two lines: title + status above,
next action + progress below. Touch targets ≥44px. Drag reordering keeps a long
press to start, and a visible handle, because drag-on-touch competes with scroll.

**Mobile / PWA (<768)** — one project per row, two lines, area as a colour mark
rather than a label. Detail is a **full page**, not a sheet: it is a
destination with its own sections, and a sheet that scrolls to a Tasks list
inside a scrolling page is the worst of both.

Detail on every size uses one column. The sections are already ordered by
importance, so narrowing does not require re-prioritising them.

**Drag alternatives.** Reordering by drag is desktop-first. Everywhere it exists
there is a non-drag path — "Move to top" in the row menu, and status changes
from a control rather than by dragging between groups. A touch user must never
be unable to do something a mouse user can.

---

## External patterns reviewed

Reviewed for interaction patterns only. Nothing here is a proposal to resemble
another product.

**Things — the "project as a thing with a heading and a list"**
*Useful:* a project reads as a single page with an outcome at the top and its
actions beneath, not a dashboard. Its distinction between a project and a
heading-inside-a-project is the clearest expression of "a project is not a
folder" in any of these tools.
*Not copying:* its Areas/Projects/Someday hierarchy is a full methodology. Life
OS already has Areas defined differently.

**Linear — status as the spine, and speed as a feature**
*Useful:* a small fixed status set applied consistently everywhere, and
keyboard-first navigation with state preserved when you go back. Its "no
decorative dashboards" instinct matches Life OS's rule about counting things.
*Not copying:* cycles, estimates, triage and multi-assignee work. All of it
exists because Linear is for teams. One person does not have a triage queue.

**Notion — everything is a database view**
*Useful:* one underlying record shown several ways, which is the argument for
Project Tasks being *the same Task rows* as Today rather than a copy.
*Not copying:* the flexibility itself. A system where the user must design the
schema is the opposite of a personal operating system with opinions. Life OS
decides what a Project is; that is the product.

**Todoist — projects as containers for tasks**
*Useful:* adding a task to a project is one interaction, and the task stays a
first-class task everywhere else.
*Not copying:* projects as pure folders with no outcome, state or progress —
this is precisely the failure mode the definition above exists to avoid.

**Sunsama — the daily planning ritual**
*Useful:* pulling project work into a day, which Life OS already does through
Plan week. Reinforces that scheduling belongs to Calendar, not to Projects.
*Not copying:* the guided daily ritual. Life OS's Today is a board, not a
wizard.

**Basecamp — the project as a place with a few fixed sections**
*Useful:* a small number of named sections that every project has, so the
structure is learnable. Directly supports the fixed section list in Project
detail rather than user-configurable blocks.
*Not copying:* message boards, check-ins, and everything else that exists for
communication between people.

**Height — automatic status from activity**
*Useful:* it demonstrates the appeal of derived state — and Legacy Life OS
already tried it, deriving `status` from recency. The lesson from the Legacy
audit is the opposite of the pattern's promise: a status the user did not choose
becomes a status the user does not trust. Hence *health is derived, status is
chosen* in the model above.

### What the review changed

1. **List, not cards** — Things and Linear both treat the project list as a
   list of things you might open, not a portfolio to admire.
2. **Fixed sections** — from Basecamp: learnable beats configurable.
3. **Derived health, chosen status** — from Height, as a negative result
   confirmed by Legacy's own recency-status behaviour.
4. **Same task identity everywhere** — from Notion's one-record-many-views, and
   the reason Projects will not own a task table.

---

## Focus — added in E2, and why it matters

The E1 model had one `status` field. Building the overview showed why that is
not enough: **"where the work is" and "how loudly it should ask" are different
questions, and a single field forces them to share an answer.**

A project can be genuinely Active and deliberately quiet — real work, in
progress, that you do not want competing for today's attention. With one field
you have to lie about one of those to express the other, and Legacy's own model
is the proof: it had `status`, then quietly recomputed it from recency, so the
user's answer was overwritten by how recently they had opened the thing.

So:

| | Question | Values |
|---|---|---|
| `status` | Where is this work? | planning · active · on_hold · completed |
| `focus` | How loudly should it ask? | now · upcoming · someday |

Independent, and nothing derives one from the other. The full matrix and the
one contradictory pair are in
[projects-v2-data-model.md](projects-v2-data-model.md).

### What focus actually does

**Defaults only.** A task created in a Now project starts in Today; anywhere
else it starts in the backlog. That is the entire mechanism.

Focus never moves an existing task, never changes a bucket, never clears a date
and never touches a schedule. A task that is due appears because it is due —
whatever its project says. This is the line that stops Projects becoming a
second, competing task-bucket system, and it is asserted by test.

## Archive, precisely

Archive is an **overlay**, not a fifth status: `archived_at` plus
`pre_archive_status`. A project archived while On hold comes back On hold. This
is why Completed and Archived can stay distinct — a project you finished and a
project you abandoned should never read the same, and restore should never have
to guess.

## Health, as built

Two signals only, both evidence:

- **No next action** — Active with nothing open. *Planning with nothing open is
  normal and is never flagged.*
- **Past its target date** — the date has passed **and** work is still open.
  Past its date with everything done is a project waiting to be completed, not
  an overdue one.

**Stalled was specified and deliberately not built.** `updated_at` moves when
notes or metadata change, so a recency signal would call a project stalled while
you were reading it and unstalled because you fixed a typo. A signal that
unreliable trains people to ignore signals.

A project with a health signal is lifted into Needs attention and **removed from
its normal group**, so it appears exactly once.

---

## Tasks versus Steps (locked in E2.3)

> **A Project Task is one Task record shown in several places. Next action is
> prominence applied to that Task, not a different kind of Task.**

The same record appears on Today, in Project detail, in the Next action slot and
in Plan week, and every one of them shows the same id, title, steps, notes,
priority, due date, bucket, area, project, schedule and completion state.
Nothing copies task fields anywhere.

| | Project Task | Task Step |
|---|---|---|
| A meaningful action toward the outcome | yes | no — a checklist item inside one task |
| Can be scheduled, prioritised, surfaced | yes | no |
| Can belong to a project | yes | never independently |
| Appears on Today / Calendar | yes | no — inherits its parent's context |
| Can be the next action | yes | no |

*Launch WebAnchor website* has Project Tasks — purchase the domain, finalise the
homepage, configure analytics. "Purchase the domain" has Steps — compare
registrars, confirm billing, buy it.

**Progress counts Tasks, never Steps.** One task with ten completed steps is
still one open task, and the project is no further along until the task itself
is done. Letting steps count would let a project reach 90% without finishing
anything.

## Next action, as built

It reports **which rule chose it**, because a rule the user cannot predict is a
rule they will not trust:

- *Chosen explicitly* — a user override, valid until the task is done, removed,
  cancelled, deleted or reassigned.
- *From its due date* · *From its priority* · *From the order below* — which of
  the three inference steps actually decided.

The slot shows what the task row shows — due date, priority, bucket, schedule,
step progress — because a next action that says less than the list does makes
the same Task look like a lesser object. Opening it opens the shared task
editor, not a reduced one.

## Project context on Today

A task that belongs to a project shows the **project name as a link** and, where
it applies, a **Next action** marker. Both are words; neither is a colour, since
colour cannot say *which* project. Opening the name goes to the project and
coming back restores the board's scroll position, area filter and focused card.

Visual clustering of a project's tasks under a header on Today is deliberately
**not** built — see technical-debt.md for the drag consequences that decision
turns on.

---

## E2.5 — Tasks and Steps inside a Project

The Task and Step model is written up in full in `tasks-v2-product-model.md`.
What matters for Projects:

- **A Project task row is the same row as a Today task row** — `taskHtml`, one
  function — and it gets the same inline Steps component. There is no
  project-specific Steps implementation.
- **Steps never move Project progress.** Progress counts Tasks: done over
  (open + done), cancelled excluded. Ten completed steps on one open task move
  it by nothing. Asserted by test.
- **Every step complete does not complete the Task**, so a project's progress
  does not advance until the user ticks the parent themselves.
- **The next-action slot reports `x/y steps`** as counts computed from the
  task's own steps — not a second copy of the step list. Opening the next action
  reaches the same Task and the same Steps.
- **Project order and Today order are independent.** `project_position` and
  `position` are separate columns; reordering in one context leaves the other
  untouched, in both directions.

Boards remain planned and unbuilt — see `projects-v2-boards.md`.
