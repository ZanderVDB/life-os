# Library — motion (Phase F1)

Tokens only: 90ms press, 140ms hover, 200ms content replacement, 260ms
structural movement, 320ms reserved for a full book open. No springs, no
overshoot, no looping decoration.

The Legacy book already used **0.26s `cubic-bezier(.4,0,.2,1)`** for its page
turn, which lands exactly on the structural token. That easing and duration
carry across unchanged.

---

## Page turn

Legacy's approach, kept: the outgoing spread translates 14% in the direction of
travel and fades; the incoming spread arrives from the opposite side.

```
@keyframes flipLeft  { to   { transform: translateX(-14%); opacity: 0 } }
@keyframes enterLeft { from { transform: translateX(14%);  opacity: 0 } }
```

**No 3D curl.** Legacy declares `perspective: 1600px` on the book and never uses
it — the ambition is visible in the source and was never made stable. A curl
that stutters is worse than a slide that does not, and the brief asks for the
slide.

The **gutter and the book frame stay still**. Only the page contents move, so the
object reads as a book being turned rather than a screen being replaced.

In a spread both pages animate together, so it is one motion rather than two
pages racing.

## Cover → spread

The cover settles and fades; the spread opens in its place. The book stays
spatially anchored — same centre, same footprint — so opening it is the book
opening, not a page navigating.

## Section change

The accent transitions, the content crossfades, **the tabs do not move**. A tab
strip that reflows when you select a tab makes the next selection a guess.

## What Legacy got wrong here, and F1 must not repeat

`nbSwapBook` starts the exit animation, then swaps `innerHTML` on a
`setTimeout(…, 220)`. Any render arriving inside that window replaces content the
animation is still using. F1's rendering has to hold the outgoing node until its
animation genuinely finishes, or skip the animation — not guess at 220ms.

## Reduced motion

Positions update immediately; opacity feedback and every status message remain;
functionality is identical. Handled by the existing `motion.js` helpers rather
than a Library-specific path.

---

## L3 — the shelf's motion

| | |
|---|---|
| object hover | 140ms — `translateY(-4px)` |
| prominent settle | 200ms — lift, scale, 7° turn, spine narrowing |
| Book open handoff | 320ms — rise, scale, fade |
| return highlight | 1400ms class, then removed |
| shelf step (arrow / keyboard) | native smooth scroll |

Nothing loops. Nothing auto-rotates. No shelf moves on its own, ever — which is
the motion half of "a shelf is not a carousel".

### The house rule, applied to a handoff

*Animations illustrate state changes; DOM and CSS own the final state.*

The open handoff is the interesting case, because a shared-element transition is
exactly where that rule usually gets broken. It is not broken here for a
structural reason rather than a careful one: **`is-opening` is only ever applied
to an element the next paint destroys.** There is no `classList.remove` to
forget, no timer that has to fire, and no state for the animation to own —
asserted by a test that fails if the class is ever removed by hand, because a
class that has to be removed is a class that can be left behind.

Under reduced motion the class is not applied at all and the route simply
changes.

### Reduced motion removes travel, not information

Every transform is dropped. Prominence survives as a ring on the cover; focus
still outlines; the archived flag, the system mark and the duration badge are
unaffected. Nothing in the shelf was ever *only* movement, which is why turning
the movement off costs nothing.

### The return highlight is not an animation that owns anything

`is-returned` is a class with a timer, added to an object that is already in its
final position. If the timer never fires the worst case is a permanently
highlighted book — visible, harmless, and corrected by the next repaint.

---

## L3.1 — the shelf's motion, corrected

| | |
|---|---|
| hover lift | 140ms |
| pull forward | 200ms |
| return to rest | 200ms |
| open handoff | 320ms |
| return glow | **320ms**, then gone |

**Nothing moves unless somebody moved it.** No object animates on idle, nothing
loops, no shelf scrolls itself, and there is no keyframe animation on the shelf
at all — every state is a transition to a class.

### The return glow replaced an accent ring

L3 drew the "you were just here" mark as a 2px accent ring for 1400ms. An accent
ring is what **focus** looks like, so returning from a Book left something that
read as selected, for long enough to look permanent.

It is now a soft glow in the **object's own accent** — not the app accent — for
320ms, inside the 200—400ms band the phase allows. It cannot be mistaken for
focus because it is not an outline, and it cannot be mistaken for a selection
because it is gone before you could act on it.

### Reduced motion

Travel goes, information stays. Pulled-forward keeps its shadow, its Open
control and its label; hover keeps its surface; focus keeps its outline; the
return glow does not play at all. Nothing in the shelf was ever *only* movement,
which is why turning the movement off costs nothing.

---

## L3.2 — the numbers, corrected

| | |
|---|---|
| hover lift | 140ms, **3px** |
| pull forward | 200ms, **32px**, no scale |
| neighbours stepping aside | 200ms, 16px |
| open handoff | 320ms, 48px |
| return glow | 320ms |

Every distance is a multiple of four, so every state lands on a whole device
pixel at DPR 1, 1.25, 1.5 and 2. That is not a stylistic choice: a transform
that lands on a half device pixel resamples the type inside it, which is what
made the pulled Book look soft.

**One depth cue, not three.** The distance is the cue; the shadow supports it;
the scale does not exist. A test fails if any shelf state introduces a
`scale()` or a `filter`.

---

## L3.4 — the turn (Concept C2, lab only)

| | |
|---|---|
| spine to cover | **300ms** `cubic-bezier(.2,.7,.2,1)` |
| the neighbour reflow | **300ms**, the same curve, on `width` |
| hover lift | 140ms, 4px |
| `Open` appearing inside the cover | 140ms opacity |

The turn is `rotateY(-90deg)` on a box hinged at `left center` -- the point a
real book pivots on when you pull it out of a row. The rotation and the reflow
share a duration and a curve, so the Book and the space it is making arrive
together.

**Nothing writes a transform from script.** `is-cover` is a class; the transform
is a rule. There is no `requestAnimationFrame`, no `setTimeout`, no
`transitionend` in the concept -- a test fails if one appears. That is what makes
an interrupted turn safe: there is no in-flight value to be stranded at, because
the state was never the animation.

**Reduced motion** removes the travel and keeps the state. The Book still faces
you; it simply arrives. The rotation is *not* cancelled -- cancelling it would
remove the information -- and the turned Book gains an accent outline so the
state is still visible without the movement that announced it.

Rotation is allowed here, where L3.2 banned it, because it is a change of
**state** rather than a resting appearance. A resting Book at 7 degrees is
permanently resampled type; a Book that rotates for 300ms and stops at 90 degrees
is a flat, axis-aligned cover for as long as you are reading it. Measured after
the turn: cover 126 x 172, no fractional geometry.

---

## L3.4 — the final motion table

| | |
|---|---|
| hover | 140ms, 8px |
| pull | 200ms, 32px up |
| **Book turn** | **300ms**, `--d-turn` |
| neighbour clearance | 200ms, 16px, with the pull |
| open handoff | 320ms |
| return | 200ms |

No springs, no overshoot, no bounce, nothing looping.

**The turn is one rotation** about the spine's outer edge, with a compensating
`translateZ(-t)` that puts the cover back in the screen plane on arrival. Nothing
scales and no width is interpolated, so both terminal states are device-pixel
exact: measured, the resting spine is 29px and the arrived cover is 126px, with
perspective on.

**The commit.** Animation illustrates state; DOM and CSS own the final state. At
the end of the turn the 3D is dropped — the box transform goes, the three depth
faces stop painting, and the cover becomes an ordinary untransformed element with
its title on the pixel grid. `transitionend` is the optimisation; a 380ms timer
is the guarantee, so a throttled or interrupted turn cannot strand a Book.

**Reduced motion** commits synchronously. The Book arrives front-facing without
ever rotating, and every state semantic is identical.

**Every travel is a multiple of four**, so it lands on a whole device pixel at
DPR 1, 1.25, 1.5 and 2. The neighbour clearance is 16px and not 14 for exactly
this reason: 14 x 1.25 is 17.5, half a device pixel out.
