# Motion strategy

## The rule

> **Interaction-explaining motion is built alongside each feature.
> Purely decorative motion may be refined later.**

Locked in Phase C4.1.

The distinction is not "important vs unimportant" — it is **whether the motion
carries information the user needs in order to understand what just happened**.

If removing an animation would leave the user guessing where something went,
whether an action registered, or where a card will land, that animation is part
of the feature and ships with it. If removing it would only make the product
less pretty, it can wait.

## Why this rule exists

C4 shipped a Today board where a completed task disappeared, a moved task
teleported, and a dragged task gave no indication of where it would land. Each
of those was logged as "animation polish, deferred". They were not polish. They
were the only thing that explained the interaction, and without them the board
felt broken rather than plain.

Deferring interaction feedback creates a second, much worse problem: by the time
someone returns to it, the feature's DOM strategy has usually hardened around
rebuilding markup — and rebuilt markup cannot be animated, because animation
needs stable node identity. That is exactly what happened. The C4 FLIP call was
real, but it ran after `rebuildBucket()` had already replaced the bucket's
`innerHTML`, so there were no surviving nodes to animate and the effect was
invisible in the deployed app.

**Interaction motion constrains architecture.** That is the real reason it
cannot be a later phase.

## Built now (C4.1)

These are considered part of their feature and must not regress:

| Motion | What it explains |
|---|---|
| Task drag insertion preview | Where the card will land, before release |
| Task reorder within a bucket | That the order changed, and how |
| Cross-bucket movement | That the card left one list and joined another |
| Task completion | That the task was finished, and the list closed up |
| Habit completion and undo | That the tick registered, and the progress it made |
| Modal open and close | Where the dialog came from and returned to |
| Optimistic rollback | That a save failed and the change was reverted |
| Layout settling | That neighbours moved because of what you did |

## Deferred

Refine whenever there is time; nothing depends on them:

- elaborate page and route transitions
- rich celebration effects
- advanced star-field animation
- cinematic section entrances
- non-essential ambient effects
- complex composer animation

## Implementation constraints

These follow from the rule and are enforced by tests.

1. **Never rebuild markup you intend to animate.** `innerHTML =` destroys node
   identity, and FLIP keyed on `data-id` then treats every card as new. Mutate
   attributes and move nodes instead. `patchCard`, `patchHabitRow` and the drag
   placeholder all exist for this reason.

2. **An animation is not a callback.** A hidden tab, a detached element or a
   paused compositor can leave an animation in `running` forever, so `onfinish`
   never arrives. Anything that *removes* an element must go through
   `settle()` in `motion.js`, which fires on whichever of finish, cancel or a
   timeout comes first.

3. **Animate `transform` and `opacity`.** Layout properties thrash. The one
   deliberate exception is `height` in `collapseOut`, where the point is that
   the surrounding layout reflows.

4. **Do not animate `transform` on a positioned element whose layout depends on
   it.** The modal is centred with `transform: translate(-50%,-50%)` on desktop
   and not centred at all as a mobile sheet. Its keyframes animate the
   independent `translate` and `scale` properties, which compose with
   `transform` rather than replacing it.

5. **Persist once.** Movement animations run against local state. The API is
   called after the interaction settles — never per frame, never per
   insertion-index change.

6. **Every path honours reduced motion.** `reducedMotion()` checks both the OS
   setting and the in-app preference, and each animated path has a working
   no-motion branch that still produces the correct final state.

## Ring geometry note

SVG progress rings must declare `pathLength="100"` and work in percentages.
Computing `2 * PI * r` in JavaScript is wrong: a browser renders `<circle>` as
four cubic Bézier arcs whose real path length is measurably shorter — 81.155
rather than 81.681 for `r=13`. The mismatch drifts every partial fill and
misjoins the seam. Use `butt` caps, not `round`: a round cap paints half the
stroke width beyond each end, which overshoots the seam at 100% and leaves a
floating dot at 0%.
