# Today — product model (Phase E2.8)

Today answers one question: **what am I doing?** Not what exists, not what is
possible — what is in front of me now.

It shows work in four time buckets — Today, This Week, This Month, Future — and
the bucket is always authoritative. Nothing on this page moves a task between
buckets on its own.

---

## Two kinds of work, one page

| | |
|---|---|
| **Standalone task** | `project_id is null`. Loose work that answers to nobody. |
| **Project task** | belongs to a Project, and its order may encode a plan. |

They share the buckets, because "when am I doing this" is the same question
either way. They are drawn as two runs of cards under adaptive headings, because
"is this part of something bigger" is a different question and the answer
changes what you can do to it.

```
TODAY

TASKS
○ Phone David
○ Pay electricity

PROJECTS
○ Reconcile against the bank    TriFusion annual returns   NEXT ACTION
○ Pay the deposit               Rage 2026 planning         NEXT ACTION
```

### The headings are adaptive

| Bucket contains | Headings |
|---|---|
| both kinds | `TASKS` and `PROJECTS` |
| standalone only | **none** — the bucket is already the container |
| project only | `PROJECTS` alone |

A divider that separates one thing from nothing is noise. The user sees
separation only where there is something to separate.

### The rows stay flat, and that is structural

The task cards are **direct children of the drop zone**. The headings are
siblings between them, not wrappers around them.

`drag.js` finds candidates with `zone.querySelectorAll('.task')` — which matches
at any depth — and then calls `zone.insertBefore(placeholder, candidate)`, which
requires the candidate to be a *direct child*. Wrapping each subsection in a
`<div>` would throw `NotFoundError` on the first drag into the second section.
Flat rows keep the drop zone intact and the drag code untouched.

### No nested project grouping — a deliberate choice

§3 of the phase brief offered grouping the project rows under per-project
headings, with an explicit fallback "if grouping creates unreliable drag
semantics". The fallback was taken.

Per-project grouping needs a drag partition per project, so a task from project
A cannot be dropped among project B's rows and silently appear to have moved
between them. That is one partition plus N, all of which have to stay correct as
tasks are added, completed and reassigned. Two partitions — standalone and
project — can be reasoned about and tested completely. Each project row keeps its
compact linked project name, which is what actually identifies it.

Reliability over visual ambition, as the brief asks.

### Drag stays inside its own kind

A standalone task cannot be dropped among the project rows, and a project task
cannot be dropped among the standalone ones. Project membership is changed in
the task editor, deliberately — never as a side effect of where a card was
released.

This is done by filtering the *candidates*, not by rejecting the drop: the
placeholder simply stops at the section boundary, so the gap shows where the
task can actually go instead of appearing somewhere it will not stay.

### A project that will not load

A task with a `project_id` whose project could not be fetched stays in the
**project** section and says `Project unavailable`. It never falls through to
standalone. A failed request must not change what a task *is* — and if it did,
the daily arranger, which is not allowed near project work, would happily
reorder it.

---

## The daily arrangement

Once per local calendar day, when Today is first opened, **standalone** tasks
are put into a recommended order.

It is a suggestion made once, not a sort that keeps enforcing itself. For the
rest of that day the order is whatever the user leaves it.

### The comparator

Applied independently inside each bucket's standalone run. Five rules, each
consulted only when everything above it ties.

1. **Scheduled work first**, earliest first. A task scheduled at 14:00 comes
   before one at 16:00 *regardless of priority*.
   A due date is **not** a scheduled start. "This is due Thursday" and "I am
   doing this at 14:00" are different statements, and conflating them would let
   a date-only task jump ahead of work someone actually blocked time for. A
   scheduled block already in the past is no longer a commitment and falls
   through.
2. **Due date/time**, earliest first. A date-only item is ordered as the **end**
   of its day, so due-today still sorts after everything scheduled today and
   before anything due tomorrow. The interpretation is for ordering only —
   nothing displays an invented time.
3. **Overdue**, after everything still due and before undated work: it has
   already missed its moment, so it should not outrank a commitment that has
   not. **Oldest overdue first**, because it has waited longest.
4. **Priority** — urgent, high, medium, low, someday. The existing values.
5. **Previous manual position**, as the final tie-break. This is what makes the
   arrangement both deterministic and stable: two tasks that tie on everything
   the rule cares about do not swap places just because it ran again.

### What it never touches

**Project tasks.** The list is *partitioned first* and only the standalone half
is sorted — not sorted whole and re-separated afterwards, which would still move
project rows relative to each other. Renumbering reuses the exact position slots
the standalone tasks already held, so project rows in the same bucket keep the
values they had.

**Steps.** `arrange.js` contains the word "step" nowhere. Asserted by test.

**Anything but order.** Not bucket, due date, scheduled time, priority, area,
project, notes or completion. An urgent task in Future stays in Future.

### Once per local day, across tabs and devices

The marker is `workspace_memberships.last_today_arranged_on` — a `date`, on the
membership, because the record is "this person's Today in this workspace".

Claiming it is one conditional `UPDATE`:

```sql
UPDATE workspace_memberships SET last_today_arranged_on = $date
WHERE workspace_id = $ws AND user_id = $uid
  AND (last_today_arranged_on IS NULL OR last_today_arranged_on <> $date)
```

The `WHERE` clause is the entire guard. Two tabs open at 08:00 both ask,
Postgres serialises them, and exactly one gets a row back. No advisory locks, no
leader election, no assuming a single tab. Proven by a test that fires six
concurrent claims and asserts exactly one winner.

**The date comes from the client**, deliberately. "Once per local calendar day"
means the *user's* day; the server does not know their timezone and inventing
one would be worse than trusting the browser about to render the result. It is
validated as a real ISO date and only ever compared.

The client computes it with local getters, never `toISOString().slice(0, 10)` —
that is the UTC date, which in Johannesburg is *yesterday* until 02:00 every
morning.

### Feedback and Undo

When the order actually changes:

> Today was arranged by time and priority. **[Undo]**

Nothing is said when nothing moved, and an automatic run with nothing to do
never interrupts. A toast carrying a verb lives 9 seconds rather than 3.6 — a
message you are meant to act on must not vanish while you are still reading it.

**Undo is real.** The exact prior `position` of every affected task is recorded
before the arrangement, and Undo writes those values back. It also *releases the
day*, so an arrangement the user rejected does not also cost them tomorrow's
offer.

### A task created afterwards

It is inserted **once**, at the position the comparator says it belongs, and
nothing else moves. Re-sorting the bucket would throw away every manual move
made since the morning; leaving it at the bottom would contradict the order the
user was just given. One row is written.

A task *edited* later in the day does not re-sort anything at all.

### Arrange today

In the Today overflow menu, not the toolbar. It re-runs the same
standalone-only arrangement with the same Undo. A way to retry the rule without
waiting for tomorrow — and not something to look at all day.

---

## Order-field ownership

| Field | Orders | Written by |
|---|---|---|
| `tasks.position` | within a Today bucket | drag, Move menu, daily arrangement, new-task insertion |
| `tasks.project_position` | within a Project | the project reorder endpoint only |
| `task_steps.position` | within a Task | step creation only |

The daily arrangement writes `tasks.position` and nothing else, for standalone
tasks only. It never writes `project_position` or a step position, and the
project reorder endpoint never writes `tasks.position`.

`POST …/tasks/reorder` takes `{ id, position }` pairs and applies them in ONE
transaction — all of them or none. The daily arrangement rewrites a whole bucket
at once, and doing that as N separate calls would leave the board half-sorted
whenever the network dropped in the middle: an order nobody chose and nothing
would ever correct. It accepts position only; letting it move a task between
buckets would turn a display concern into a data migration.

## Today — partition-aware drag insertion (D2.1)

A standalone Task has `project_id = null`; a Project Task does not. **A drag
never changes that identity** — project membership is edited in the task editor,
deliberately, and never as a side effect of where a card was released.

`updateInsertion` enforces that by filtering drag candidates to the dragged
card's own kind, so the placeholder stops at the partition boundary.

**The regression:** with no candidates of that kind — a standalone task dragged
into a bucket holding only project work — the filter left an empty list, and the
code fell through to `zone.appendChild(placeholder)`. The task landed *after*
every project row. The bucket where the boundary matters most was the one where
it was not applied.

**The fix is in the insertion model, not in a post-drop re-sort:**

- `partitionAnchor(zone, kind)` returns where a partition BEGINS even when it
  holds nothing — standalone work before the first project row or its heading,
  project work at the end.
- `syncPartitionHeads()` shows the heading the drop *would* create, during the
  drag, above the placeholder. The placeholder is the real future layout; a
  preview without the heading would be lying about where the card is going.
  Previews are marked `data-ph-head` and swept on every teardown, including a
  cancelled drag.
- `syncBucketHeads()` runs after the drop settles and reconciles which dividers
  still earn their place, using the same adaptive rule as `bucketInnerHtml`.
  It adds and removes headings only — the rows are already where the drop put
  them, and re-sorting would discard the FLIP that just finished.

Measured in a browser, the exact reported case: during the drag,
`[tasks*] PH [projects] P P P`; after the drop, `[tasks] S [projects] P P P`;
and the source bucket loses its now-empty `[tasks]` heading.

## Keyboard and menu moves obey the same partition rule (D2.1)

The pointer drag enforced the boundary by filtering its candidates. Every
non-pointer path — Move up, Move down, Move to top, Move to bottom, and the
bucket shift arrows — was still anchoring against the WHOLE bucket, which is how
"Move down" and "Move to bottom" walked a standalone task into the project half.

Two shared helpers, and every path uses them:

- `partitionFor(task)` — the rows a move may land among: the task's own
  partition, never the bucket. Stepping past its edge does nothing, which is the
  same boundary the drag placeholder shows.
- `boundaryAnchor(task, bucket)` — where a task lands in a bucket that has none
  of its kind yet. Standalone work goes before the first project row; project
  work goes last, which is `{}` and already correct. The keyboard twin of
  `partitionAnchor` in `drag.js`.

`project_id` is never touched by any of them. Identity is edited in the task
editor, deliberately, and never as a side effect of a move.

The adaptive headings are correct on both paths: the keyboard route goes through
`rebuildBucket`, which re-runs `bucketInnerHtml`; the pointer route uses
`syncBucketHeads` after the drop settles.

Verified in a browser: moving a standalone task back one bucket into a
project-only bucket produced `[tasks] S [projects] P P P P` and removed the
now-empty `[tasks]` heading from the bucket it left.

## Drag geometry: one width for the whole gesture

`.bucket.future` is `grid-column: 1/-1`, so a Future task rests two or three
times wider than one in Today, This Week or This Month.

**The defect.** Lifting it at that resting width made the floating card cover
the neighbouring buckets and hide the very thing the drag is for — you could not
see where the card was going, because the card was on top of it. It also hid the
TASKS and PROJECTS partition previews.

There was a second, opposite half: `adoptWidth(zone)` re-measured the card
against each destination as the pointer crossed into it. That made the card
breathe, and when a measurement was stale it left the card at the wrong width —
the "does not always shrink reliably" in the report.

**The rule now.** The drag visual takes the **compact** width, decided once at
lift by `dragWidth()` — the narrowest drop zone on the board — and never
re-adopted. On a narrow screen every bucket is the same width, so nothing
changes.

| | |
|---|---|
| resting | Future full-width; the other three compact |
| lift | compact immediately, whatever it was resting at |
| during | one width, unchanged, whichever bucket is beneath |
| placeholder | follows the DESTINATION — `adoptGap` measures the card at that width, because a long title wraps differently in a column |
| drop into a compact bucket | stays compact |
| drop into Future | settles into position, then widens |
| cancel / failure | exact resting width, nothing inline left behind |

**Expansion happens after settling, never while floating** — widening over
Future before release would cover the buckets either side at the exact moment
the person is aiming.

### The animation may not own the final width

A running Web Animation overrides the computed width. One that never completes —
a backgrounded tab, a throttled timeline — would hold the card compact in a
bucket where it should be full width.

Observed directly: the harness browser throttles its animation timeline, and the
card sat at 160px inside a 577px bucket indefinitely. The grow animation is now
`settle(grow, 260, () => grow.cancel())`, so the effect is dropped on a
guaranteed timer and the card returns to its own layout whatever happened. The
animation paints the journey; it never decides the destination.

Measured at 1280px: resting 577 -> lift 160 -> stable 160 across the whole drag
-> no overlap with the neighbouring bucket -> lands 160 in Today, 577 in Future,
with a clean `style` attribute every time. Cancel restores exactly, with no
stray placeholder, preview heading or duplicate node.
