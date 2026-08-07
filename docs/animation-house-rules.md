# Animation house rules

> **Animations illustrate state changes; DOM and CSS own the final state.**

This is not a style preference. It is the conclusion of four separate defects in
this codebase, each of which left something visibly and permanently wrong, and
each of which had the same shape: **an animation was allowed to decide what
something looked like after it finished.**

---

## The rule

An animation may draw the journey. It may never be the record of the
destination.

Before an animation starts, and after it ends, the correct appearance must
already be expressed in the DOM and the stylesheet — in a class, an attribute, a
computed style. If you removed every animation from the app, every screen would
still be right. That is the test.

Three corollaries follow, and they are the whole of it:

1. **Nothing waits on `onfinish`, `animationend` or `transitionend` alone.**
   Every one of those can fail to arrive. Pair them with a timeout that always
   fires — `settle()` for a Web Animation, `afterAnimation()` for a CSS
   animation, `afterTransition()` for a transition. The event is the fast path;
   the timeout is the guarantee.

2. **Every animation is cancelled, committed or discarded during teardown.**
   A running Web Animation *overrides* computed style for the properties it
   touches. One that never completes holds the element at whatever value the
   timeline stopped at. Cancel it, or throw the node away.

3. **`animation-fill-mode: forwards` needs an owner.** It holds the element at
   the last keyframe for ever. That is correct only while a replacement is on
   its way. Remove the class in a `finally`, or destroy the node.

---

## The four defects this came from

### 1. The stranded grow (Today drag geometry, D2.1 addendum)

A dragged card landing in the full-width Future bucket played a width animation
from the compact drag width to its resting width. Under a throttled timeline the
animation stayed `running` indefinitely — and because a running animation
overrides computed style, the card sat at **160px inside a 577px bucket**, for
ever.

The width was already correct in CSS the whole time. The animation was the only
thing making it wrong.

    const grow = card.animate([{ width: `${dragW}px` }, { width: `${landed}px` }], …);
    settle(grow, 260, () => grow.cancel());   // ← the animation never decides

### 2. The invisible day (Diary, D2.2 §14)

`.dia-book.leave-next` is `animation-fill-mode: forwards` — translated aside and
transparent. Correct while the next day loads. If `renderEntry` returned early
— a stale navigation, a failed fetch — the class stayed on and the day was
permanently invisible.

Fixed by removing the class in a `finally`, so the wait ending is enough,
whatever happened next. (The same audit found the selector had been targeting
`.dia-sheet`, an element that stopped existing in D2 — so the transition had
silently not run at all. Also fixed.)

### 3. The frozen book (Library, F2)

A page turn waited on `animationend`, which does not arrive if the element is
removed, if the tab is backgrounded mid-animation, or if a stylesheet has not
applied. The book froze mid-flip. Fixed with `afterAnimation`'s timeout.

### 4. The snapping ring (Today habits, C4)

The opposite failure, and it belongs here because it is the same mistake read
backwards. `patchHabitRow` replaced the row node, so the browser got a fresh
`<circle>` already at its final `stroke-dashoffset` and had nothing to
interpolate from — the ring snapped instead of filling.

The lesson is not "keep the node so the animation works". It is that the DOM
already held the final state (it did), and the animation was decoration that
happened to need a starting point. Mutating the existing node gives it one
without giving it authority.

---

## What this forbids

- Reading an element's size or position back out of a running animation.
- Setting a final width, height, opacity or transform *only* inside a keyframe.
- `fill: 'forwards'` on a Web Animation without a cancel or a node teardown.
- Cleanup that lives only in an `onfinish` handler.
- A layout that depends on a measurement taken mid-transition.

## What it permits

Everything else. Motion is good and this codebase uses plenty of it — page
turns, FLIP reorders, ring fills, rise-in dialogs, the drag lift. All of it is
free to be as expressive as it likes, precisely *because* none of it is load
bearing.

---

## Layout that needs no animation at all

The strongest form of the rule is not needing it. The Diary spread's height is
the example (see `diary-v2-responsive.md`):

    height = max(approvedBaseHeight, leftRequired, rightRequired)

All three terms are CSS — an `aspect-ratio` minimum and the natural height of
the content, resolved by a grid with `align-items: stretch`. Nothing is
measured, no inline height is written, and there is nothing to animate. Growth
and shrink are the grid re-solving, which is instant, correct under any
throttling, and leaves no stale value behind because there was never a value to
leave.

Reach for JavaScript geometry only when CSS genuinely cannot express the
relationship. Every inline height is a thing that can be left behind.

---

## Where the helpers live

| Helper | File | For |
|---|---|---|
| `settle(anim, ms, done)` | `web/motion.js` | a Web Animation |
| `afterTransition(el, prop, ms, done)` | `web/motion.js` | a CSS transition |
| `afterAnimation(el, ms)` | `web/library-view.js`, `web/diary-view.js` | a CSS animation |
| `reducedMotion()` | `web/motion.js` | the escape hatch |

Reduced motion is honoured globally in `index.html` (`prefers-reduced-motion`
plus `html[data-motion="reduced"]`, which the Settings preference sets). Because
no animation owns a final state, reducing motion to 1ms cannot break a layout —
which is the other reason the rule is worth keeping.

---

# D2.3 — a fifth defect, and the rule applied to a stroke

### 5. The habit ring's seam

Not an animation this time — a **dash** — but the same shape of mistake, and it
belongs here because the fix has the same form.

`pathLength="100"` with `stroke-dasharray="100"` makes the dash exactly one
full turn of the circle, so its END lands precisely on its own START. With
`stroke-linecap: butt` those are two flat cuts meeting, not a join —
`stroke-linejoin` never applies to a dash boundary — and each is antialiased on
its own, so where they abut the coverage sums to less than one pixel of paint.

Rasterised at four device pixel ratios, stroke coverage at the seam as a
fraction of the average around the ring:

| DPR | before | after |
|---|---|---|
| 1 | 46.5% | 93.1% |
| 1.25 | 34.5% | 88.4% |
| 1.5 | 21.5% | 93.2% |
| 2 | **0.6%** | 94.0% |

At DPR 2 it is not a hairline, it is a hole — which is why it showed on a
retina screenshot and was easy to miss elsewhere. **The defect gets worse with
pixel density**, the opposite of most rendering artefacts.

The fix is not to paint over the seam. It is to stop drawing a dash when there
is nothing to dash: a complete ring has `stroke-dasharray: none`, so the stroke
is a genuinely continuous closed circle with no start and no end for a seam to
appear at.

**A first attempt at measuring this found nothing** — a 3×3 neighbourhood
maximum washed the sub-pixel dip out entirely, and the control (the OLD
geometry) passed too. A measurement whose control passes is not a measurement.
Integrating alpha across the stroke at 0.5° steps is what made it visible.

### The rule, applied here

The sweep to full still needs a dash to animate along; the finished ring must
not have one. So the offset is driven to 0, and the dash is removed **on a
timer** once it has arrived:

    fill.addEventListener('transitionend', drop, { once: true });
    fill._dashT = setTimeout(drop, 320);

`transitionend` alone would leave the seam exactly where §17 says it must not
be, on any throttled timeline. The same rule as everywhere else on this page:
the animation paints the journey, and something else guarantees the
destination.

### 6. The Diary day turn

D2.2 animated the live spread and awaited it before fetching. D2.3 makes the
outgoing day a **detached clone** instead, which turns the guarantee from
"remember to take the class off" into "the thing deletes itself":

    const drop = () => ghost.remove();
    ghost.addEventListener('animationend', drop, { once: true });
    setTimeout(drop, TURN_MS + 120);

and every paint sweeps any survivor with `endTurn()`. The live layer is never
animated at all, so there is no state on it for a stalled timeline to hold.

The clone carries one measurement — the box it is pinned to. That is permitted
by the rule as stated: what is forbidden is an animation owning a **final**
state, and this one's final state is *gone*.
