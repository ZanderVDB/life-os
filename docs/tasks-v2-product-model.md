# Tasks and Steps — product model (Phase E2.5)

The Task is the unit of work in Life OS. Everything else is context around it:
an Area says what part of your life it belongs to, a Project says what it adds
up to, a bucket says when you intend to do it, and a Step says what it takes.

---

## The hierarchy, and why it stops where it does

```
Project        an outcome, made of Tasks
  └ Task       the unit of work — the only thing you complete
      └ Step   a checklist item required to finish that one Task
```

A **Step** belongs to exactly one Task and to nothing else. It:

- is never a Today task in its own right;
- never counts toward Project progress on its own;
- never carries a Project, Area, due date, schedule or priority.

Those all belong to the Task. A step that could hold a due date would be a task,
and then Life OS would have two words for one thing.

**There is no Step inside a Step.** Not an oversight — the moment a checklist
item can hold a checklist, the model is a tree and every screen has to answer
"how deep do I draw?". A step that needs steps is a Task.

### The structural guarantee

Steps render **inside** the task's `<article>`, never as siblings of it.

This is not a stylistic choice. The Today board's drop zones treat everything
inside them as a task; a step row sitting as a sibling would become a legitimate
insertion target and could be dragged away from its parent. Nesting makes that
impossible rather than merely discouraged, and `drag.js` additionally refuses to
start a drag from inside `.t-steps`.

---

## Completing every Step does not complete the Task

The last step turning green means the work is **ready to be finished**, not that
it is finished.

Auto-completing would take the decision away at exactly the moment it matters,
and it would be wrong whenever a task carries a step the user never intends to
tick. So:

- the parent stays visible, on Today and in its Project;
- Project progress does not move;
- a restrained line appears: **"All steps complete — ready to finish"**;
- the parent's own checkbox is the only thing that completes it;
- unticking any step removes the state immediately.

`readyToFinish()` is derived on every read and never stored. A stored flag goes
stale the instant a step is unticked — which is precisely when it is being
looked at.

The converse also holds: **a Task may be completed with Steps unfinished.**
Deciding a task is done despite an open checklist item is a legitimate,
deliberate act, and the unfinished states are preserved exactly in history.

---

## Inline Steps

A task with steps shows `2/4 steps` in its meta line. The chip is a **button**
that expands the list beneath the task:

```
○ Prepare client proposal                         2/4 steps ▾
   ✓ Confirm scope
   ✓ Calculate pricing
   ○ Write proposal
   ○ Send to client
   [ Add a step…            ] [Add]
```

Inline you can tick, untick, add, rename and delete. Expanding does **not** open
the editor — they are different intentions, and the chip is the only control
that means "show me the steps". The full editor remains available separately and
shows the same steps through the same handlers.

**One component**, `web/steps.js`, used by the Today board and by Project detail.
Not two implementations that look alike: the row is `taskHtml` in both places and
the record is one record, so a step ticked in a project and a step ticked on
Today are the same write against the same object.

**A task with no steps shows no chip.** A chip on every card would be noise on
the majority that have none, so the way in is *Add step* in the task menu — on
Today and in Project detail alike. It reveals the panel and focuses the field.

### Expansion is view state

Tracked in a module-level `Set` keyed by task id, deliberately not a property on
the record: it must never be sent to the server, and it must survive the record
being replaced by a fresh copy from a response. A row re-rendered anywhere comes
back open if it was open.

---

## Completed tasks

### The defect this phase fixed

Clicking a task in Completed history opened a **blank Create Task form**.

The root cause was a lookup scoped to the wrong collection. `findTask` was
`state.tasks.find(...)` — the *active board only*. A completed task is removed
from `state.tasks` the moment it is ticked and lives in `state.history`, so the
click passed a perfectly valid id, got `undefined` back, and the editor's
`task ? edit : create` fallback quietly turned "not found" into "new task".

Not a missing id, not a mode flag, not an event-target mismatch: the id was
correct at every step and was resolved against a list that by construction could
never contain the answer.

Two changes, because either alone leaves the trap armed:

1. `findTask` searches every mounted collection — the board, the open project's
   tasks, and history — so one id resolves to one object wherever it is.
2. `openTask` treats an id that resolves to nothing as a **bug**, not as a
   request for a new task. The create path is reached by calling `openTask()`
   with no id at all; a failed lookup fetches the record by id and, if that
   fails too, says so out loud.

### What a completed task shows

The editor has three states, and the difference is visible: **New task**,
**Edit task**, and **Completed task**. A completed one carries a bar reading
`Completed 4 August 2026` and a **Restore** action, alongside everything the
record holds — title, notes, steps and their individual states, area, project,
priority, due date and bucket.

### Restore

The **same record**, uncompleted. `/uncomplete` clears `status` and
`completedAt` and touches nothing else, so title, notes, steps and their
individual completed states, area, project, priority, dates and bucket all
survive untouched. Restoring a task you finished with two of four steps ticked
gives you back exactly that.

It returns to the bucket it already had — the bucket was never cleared on
completion, so the original is still there and still valid. The toast names the
destination. Project progress and the next action both recalculate, because both
are derived on read and neither is stored.

---

## Ordering is contextual

A Task holds **two positions** without ever becoming two Tasks:

| Column | Orders |
|---|---|
| `tasks.position` | within its Today bucket |
| `tasks.project_position` | within its Project |

Reordering on Today does not touch project order. Reordering in a Project does
not touch Today. Asserted in both directions by test and verified in a browser.

Reordering changes position and nothing else — not bucket, area, project, due
date, priority, schedule, notes or steps.

### Dragging an expanded task

The step panel **collapses before the card is measured**, and reopens after the
drop.

Measuring first would size the placeholder to a card three times the height of
its neighbours, and the insertion gap would read as wrong. Measured: a task with
four steps expanded was 226px; during the drag both card and placeholder were
71px, matching every sibling.

The steps are hidden, never detached — the panel is inside the article, so it
travels with its parent and no step row can be left behind or become an
insertion target.

### Ordering without a drag

Drag is not the only way. Both the Today menu and the Project task menu carry
**Move up**, **Move down**, **Move to top** and **Move to bottom**, applying
within the current bucket (or project) only. `Alt+↑/↓` does the same from the
keyboard. Drag is unavailable to a keyboard and awkward on touch, so it cannot
be the sole mechanism.

---

## One authoritative state

`findTask(id)` resolves a task from whichever collection currently holds it, and
`syncTaskEverywhere(id)` redraws every mount of it: the Today card, the project
row, and the next-action slot's step counts.

No copied step arrays. The next-action slot reports `{ total, done }` computed
from the task's own steps; it does not hold a second copy of the list, because
two copies in one response is how a slot and a row start disagreeing.

---

## Deliberately not built

**Boards** remain a planned flagship Project feature — see
`projects-v2-boards.md`. No empty Board UI is exposed.

**The mobile redesign** remains deferred.
