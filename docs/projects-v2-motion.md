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
