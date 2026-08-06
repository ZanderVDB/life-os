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
