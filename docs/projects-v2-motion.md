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
