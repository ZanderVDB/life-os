# Tasks and Steps — product model (Phases E2.5–E2.6)

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

## Steps are an ordered sequence (E2.6)

E2.5 gave Tasks inline Steps and rendered them as a flat checklist. That was
wrong: **Steps are a sequence**, and Today's job is to guide you through it.

`task_steps.position` is a real, stored, incrementing column — assigned
`max + 1` on create and used for every read. The order is data, never inferred
from creation time.

| | |
|---|---|
| **Current** | the first incomplete step, by stored order |
| **Next** | the first incomplete step after the current one |
| **Later** | everything still incomplete behind that |
| **Ready to finish** | no current step — every step is done |

A completed step **after** the current one stays completed. Someone ticked it
deliberately in the editor, and Today has no business undoing that; it simply
carries on guiding from the earliest thing still open.

### Today guides. The editor overrides.

This is the whole design, and every rule follows from it.

**On Today** (and in Project detail — the same row, the same rules):

- only the **Current** step can be completed;
- **Next** is a preview: readable, labelled `Next`, with no checkbox at all —
  not a disabled one that looks pressable;
- later steps collapse to `N more steps`;
- pressing a locked step or that count **opens the full task**. It never
  silently does nothing;
- the parent's checkbox is **unavailable** while any step remains.

**In the full editor**, every step is freely tickable, in any order. Completing
one ahead of the current step is allowed and says so once:

> Completed out of order — Today still guides from the earliest unfinished step.

### Undoing a completed step inline

Only the step **immediately before the current one** can be undone from Today.
That is "the one you just finished", and undoing it simply makes it current
again — the sequence stays possible.

Undoing an earlier one would leave a gap behind the current step: step 1
incomplete, step 2 complete, step 3 current. Today must never produce that. Any
other completed step renders a disabled tick whose title points at the editor,
where the sequence can be rearranged deliberately.

### The parent checkbox while steps remain

Not clickable-then-an-error. The control is **disabled**, and it carries the
reason in `aria-label` and `title`:

> Complete the remaining 2 steps first

Visually it becomes a small progress ring with `1/3` inside it, so the state is
legible without hovering and without relying on colour. The rule is also
enforced in `toggleTask` and `completeProjectTask` themselves — `Space` on a
focused card reaches the mutation directly, and a rule that only lives on a
control is a rule with a hole in it.

A task with **no** steps completes normally. Nothing here applies to it.

### Completing a parent early

The editor is the only place this can happen, and it is a decision, not a side
effect:

> **Complete task?**
> 2 steps are still unfinished.
> — Complete task and mark all steps complete
> — Go back

If confirmed: every remaining step is marked complete **first**, then the
parent. Step text and order are untouched — marked complete, never discarded.

There is deliberately **no** "complete the task but leave the steps open"
option. A finished task holding unfinished steps is a record that contradicts
itself, and every later screen would have to invent a meaning for it.

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
that expands the sequence beneath the task:

```
○ Prepare client proposal                         2/4 steps ▾
   ✓ Confirm scope
   ✓ Calculate pricing

   CURRENT
   ○ Write proposal

   NEXT
     Send to client

   [ Add a step…            ] [Add]
```

Inline you can complete the **current** step, undo the one before it, add a step
and rename one. Expanding does **not** open the editor — they are different
intentions, and the chip is the only control that means "show me the steps". The
full editor remains available separately, shows the same steps through the same
handlers, and is where the sequence can be overridden.

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

---

## E2.7 — one step control, and a parent control that changes state

### The alignment root cause: four controls, not one

Measured on screen before changing anything:

| Context | Control | Glyph | Text column |
|---|---|---|---|
| Today, completed | 15px | 10px | x = 362 |
| Today, current | **16px** | 10px | x = **363** |
| Today, next | 15px | — | x = 362 |
| Full editor | **16.7px** | **10.8px** | x = **387** |

Every one of those was vertically centred against its text box **to the pixel**
— `offCentre` was 0 everywhere. The defect was horizontal. Because each row laid
its text out with flexbox *after* the control, a control one pixel wider pushed
its text one pixel right, and rows that should have shared a left edge did not.
That is what reads as "off", and chasing it with vertical nudges would never
have fixed it.

So there is now **one** control, `stepTickHtml()` in `steps.js`, used by Today,
Project detail and the full editor, sized from tokens:

```
--step-tick : 18px   the control
--step-glyph: 11px   the checkmark inside it (61% — legible, not a green block)
--step-gap  :  9px   control to text
--step-text : calc(row-padding + tick + gap)   where step TEXT begins
```

And the row is a **grid**, not a flex line:

```
grid-template-columns: var(--step-tick) minmax(0,1fr) auto
```

The trailing cell is rendered even when empty, so a row without a delete button
does not let its text column stretch. Measured after: every step text, both
group labels and "N more steps" begin at exactly the same x, in every state.

Everything that is not a step row — the `Current` and `Next` labels, the more
count, the ready line, the error line, the add field — hangs off `--step-text`,
so none of them can drift a couple of pixels away from the text they belong to.

### The parent control has three states, and they are different controls

| State | Control |
|---|---|
| No steps | the ordinary task checkbox |
| Steps remain | a 22px progress arc, `aria-disabled` |
| All steps done | **the ordinary task checkbox**, outlined in the success colour |

The middle one is a **progress arc with no number in it**. It used to carry
`1/3` in 7.5px digits inside a 20px circle, which was not readable at any size
anyone actually uses. The count already exists, legibly, in the `1/3 steps` chip
on the meta line; the ring is the glanceable shape and the label carries the
sentence:

> 1 of 3 steps complete. Complete the remaining 2 steps first.

It is **`aria-disabled`, not `disabled`**. A truly disabled button does nothing
when pressed, and doing nothing is its own small failure — the user gets no
answer. Pressing this one expands the steps and says why, so the remaining work
is on screen instead of implied.

When the last step completes it becomes the **same 20px checkbox a task with no
steps has**. Not a 3/3 ring: reaching the end of a sequence has to hand back the
normal way to finish, or the user is left wondering whether they are allowed to.

### The collapsed card says so too

`5/5 steps · Ready to finish`, with an active checkbox. Without the words, a
finishable task looked identical to an unfinishable one and the only way to find
out was to expand it.
