# Projects — motion model (proposal)

Motion is specified before implementation because of what happened in C4: a FLIP
was written after the list already rebuilt itself, so it ran on nodes that no
longer existed and was invisible. Motion designed after a feature is motion that
cannot be added.

Tokens are the locked ones. No new durations.

| Token | Value | Used for |
|---|---|---|
| `--d-instant` | 90ms | press feedback |
| `--d-fast` | 140ms | hover, small fades |
| `--d-base` | 200ms | surface opacity, content swap |
| `--d-slow` | 260ms | structural layout, list reflow |
| `--e-out` | `cubic-bezier(.2,.7,.2,1)` | everything entering or settling |
| `--e-inout` | `cubic-bezier(.4,0,.2,1)` | reversible movement |

No spring. No overshoot. Nothing decorative.

---

## The rule Projects must not break

**Node identity survives the change, or there is no animation.** Every motion
below requires that the element being animated is the same DOM node before and
after. That constrains the render architecture, which is why it is written down
now: the Projects list must be patchable in place, not rebuilt from
`innerHTML` on every state change.

If a change genuinely requires a rebuild (switching filters, loading a different
project), it gets a **crossfade**, not a fake reflow.

---

## Overview

**Row enters** (project created) — height 0→auto with opacity, `--d-slow`
`--e-out`, then the title field takes focus. The row enters *where it will
live*, not at the top and then jumping.

**Status change** (Active → On hold) — the row leaves its group and joins
another. FLIP: measure all rows, move the node, animate the deltas over
`--d-slow`. Everything below it slides once, together. This is the motion that
explains what the status control did; without it the row simply vanishes from
one place and appears in another.

**Archive / complete** — the row collapses out (`--d-slow`) and an undo appears.
Nothing reorders until the collapse finishes, or two motions compete for the
same space.

**Restore** — the reverse, into its restored position, with a brief highlight so
the eye finds where it went.

**Filter change** — content crossfade at `--d-base`. Not a reflow: the rows are
different rows, and pretending they moved is a lie about what happened.

**Reorder (drag)** — the dragged row follows the pointer; the others FLIP into
place at `--d-fast` as the gap moves. Drop settles at `--d-slow`.

**Needs attention appearing/disappearing** — the group animates its own height,
`--d-slow`. It appears only when non-empty, so this fires rarely and should be
noticeable when it does.

---

## Detail

**Overview → detail** — the canvas crossfades at `--d-base`; the header does
not. Deliberately *not* a shared-element transition of the row into the header:
it is expensive, fragile under scroll, and the two layouts do not correspond.

**Detail → overview** — reverse, and **scroll position, filter and expanded
groups are restored**. Losing the list position on back is the single most
irritating thing a detail page can do.

**Task added** — the row enters in place at `--d-slow`, and the progress count
updates *after* it lands, not during. Two numbers changing mid-motion reads as a
glitch.

**Task completed** — the row's own completion motion (already built for Today,
reused verbatim), then the count ticks. If completion moves it to the done
group, that is a FLIP, after the tick.

**Next action changes** — the new action crossfades in place at `--d-base`. No
movement: the slot is the same slot.

**Progress count** — never animates a number counting up. It changes once, when
the thing that caused it has finished moving.

**Project completed** — the header state changes, progress is replaced by the
completion fact, and the open-Tasks question appears as a surface. No confetti,
no celebration animation. Completion is information.

---

## Reduced motion

`prefers-reduced-motion: reduce` removes **movement**, not feedback:

- FLIP and drag reflow: off. Positions change immediately.
- Enter/leave: opacity only, `--d-fast`.
- Crossfades: kept — they are opacity, and they explain that content was
  replaced.
- Undo, focus and highlight: kept.

Nothing becomes unusable and nothing silently skips a step.

---

## Explicitly not doing

- Card hover lift, tilt or shadow bloom.
- Animated progress bars filling on load — the bar shows a state, not an event.
- Staggered list entry on first paint. It delays the whole list to decorate it.
- Page-level slide transitions between overview and detail.
- Any motion that runs on data arriving rather than on something the user did.

---

## As built (Phase E2)

The architecture is the deliverable, and it is the part that could not be added
later. `applyGroups()` reconciles the rendered list against new data: it finds
the existing row by id anywhere in the list, patches its contents in place, and
`appendChild`s it into its new group — which **moves** the node rather than
copying it. `paintProjects()` wraps that in `flip()`.

The result, measured in a browser: a project moved from Now to On hold keeps the
same DOM node (`before.b === after.b`), travels 148px into its new group, has its
status label updated, and there are no duplicate rows. That is what makes the
transition animatable at all.

What was avoided, explicitly: `container.innerHTML = …` after a mutation. It is
one line, it looks harmless, and it silently turns every transition in this
document into a jump. It is asserted against.

### Implemented

| Interaction | Motion |
|---|---|
| Create | modal closes **after** the write succeeds · row enters at its final group position · restrained landing highlight applied on the next frame |
| Status / focus change | same node, FLIP into the new group, surrounding rows reflow once |
| Archive | row collapses · undo bar rises · no full-list repaint |
| Restore | row enters at its restored position with the same landing highlight |
| Filter change | crossfade, and the list is rebuilt — these are different rows, and pretending they moved would be a lie |
| Needs attention | the group exists only when non-empty; resolving the last issue removes it |
| Overview → detail | canvas crossfade; shell and sidebar stay put; focus moves to Back |
| Detail → overview | filter, scroll position and row focus all restored |
| Notes | save state fades between Unsaved · Saving… · Saved · Not saved — retry |

Durations are the locked tokens only; a test enumerates every `duration:` in the
Projects code and fails on anything else. No springs, no overshoot, no stagger,
no confetti on completion — completion is information.

### Not implemented

**Drag reordering.** `position` exists and "Move to top" uses it, but drag was
not shipped: it needs pointer and touch handling, a live gap, one write on drop
and a rollback that returns the row to its exact prior position. Shipping an
unreliable version because the column exists is how a list becomes untrustworthy.

**Task completion inside Project detail reuses Today's task row**, so it inherits
that animation — but the "move into the Completed subsection with the same node"
choreography is not built; the detail page reloads its task list. Recorded in
technical-debt.md.

## E2.3 — completion, verified

Task completion in Project detail moves the **same node** into the Completed
section rather than reloading the list. Order: the row acknowledges the click
(`is-completing`, the class Today already uses), then it moves inside a FLIP,
and only then do the open count, progress and next action update — two things
changing during the movement reads as a glitch.

Measured in a browser across complete → reopen: same node throughout, unsaved
notes text intact, the Completed section created on demand and removed when it
empties, no duplicate rows, scroll unchanged.

Project context on Today is added inside the existing meta line, so a task
gaining a project label never moves its own title.

---

## E2.5 — steps, restoration and dragging an expanded task

**Expanding steps** is a disclosure, not a transition between screens. The panel
is `hidden` when collapsed rather than absent, so opening it builds no DOM and
the caret rotation is the whole animation. Nothing slides; a list appearing
under its own heading needs no help being understood.

**A step tick** repaints only its own row and the summary chip. The board is
never rebuilt, the card is never replaced, and the panel keeps its node — which
is what lets expansion survive a mutation.

**Ready to finish** appears in place, as a line of text. No celebration: the
task is still open and still needs a decision, so the state reports a fact and
asks for nothing.

**Dragging an expanded task** collapses its steps before the card is measured.
The card, its placeholder and every sibling are then the same shape, so the
insertion gap is honest — measured at 226px expanded, 71px during the drag, with
the placeholder matching at 71px. Expansion is restored on drop, because a
reorder must not quietly close something the user opened.

**Restoring a completed task** collapses its history row, puts the task back in
its own bucket, and gives it one brief `pulse` — the same acknowledgement a
completed card gets, in reverse. The toast names the destination rather than
leaving the user to find it. No page reload, and Project detail updates in
place.

All of the above respects `prefers-reduced-motion` through the existing `motion.js`
helpers; nothing here introduces a new animation primitive.

---

## E2.6 — advancing the sequence

**Completing the current step** is the phase's main movement, and it is
deliberately small: the checkbox responds at once, the row settles into its
completed styling and drops into the quieter completed group, the next step
rises into `Current`, and the one behind it appears as `Next`. The card's height
changes with it. Nothing else on the board moves.

The panel node is reused, so this is a repaint rather than a rebuild — the
expansion state, the scroll position and the listeners all survive. Only when
the parent's checkbox changes availability (the last step completing, or a new
step arriving on a ready task) is the surrounding row re-rendered, because the
control lives outside the panel.

**The final step** completes like any other; the difference is what follows.
"All steps complete — ready to finish" appears, and the parent's progress ring
becomes a real checkbox. The task does not move, does not complete itself, and
does not celebrate.

**Adding a step to a ready task** reverses that in place: the ready line goes,
the checkbox returns to a ring, and the new step becomes `Current` at the end of
the list.

**The override confirmation** is a fixed overlay above the editor rather than a
separate screen, so the task you are deciding about stays visible behind it.
After approval the remaining steps complete, then the parent, then the task
moves once.

No springs, no bounce, nothing celebratory. Everything routes through the
existing `motion.js` helpers, so `prefers-reduced-motion` is respected without
this phase adding a primitive of its own.

---

## E2.7 — the parent control changing state

The ring does not morph into the checkbox. They are different elements, and the
row is re-rendered when the state changes — which is honest, because the control
genuinely becomes a different control with a different affordance.

What makes that read as a transition rather than a flash is that everything
around it is stable: the card does not move, the step panel keeps its node and
its expansion, the meta line only gains a word. The 22px ring and the 20px
checkbox share a centre line, so nothing jumps sideways.

The re-render happens exactly once, driven by `repaintSteps` reporting that the
parent's availability changed. Every other step completion repaints only the
panel.

---

## E2.8 — the daily arrangement

One coordinated movement, not a sequence of hops. The existing standalone nodes
are measured, moved into the recommended order, and FLIPped together; project
rows are not in the set and do not move at all. The toast arrives after the
movement settles, because a message about something you have not finished
watching is a message you have not read.

Subsection headings appear and disappear as a bucket gains or loses its first or
last task of a kind. They are siblings inside the drop zone, so this is a
rebuild of that bucket rather than of the board.

Undo runs the same movement backwards through the same nodes, from recorded
positions — no reload, and project rows stay fixed.

`prefers-reduced-motion` is handled by the existing `flip` helper: positions
update immediately, the toast still appears, nothing animates.
