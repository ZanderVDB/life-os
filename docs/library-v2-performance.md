# Library — performance

> **Measure before adding complexity.** §27 and §39 both say it, and this
> document exists so the next person does not add virtualisation on a hunch.

All numbers below are from a real browser at 1280×900 against the full sample
collection: **45 objects across 6 shelves** (12 Books, 7 Documents, 5 Images,
4 Videos, 6 Links, 5 Files).

## What was measured

| | |
|---|---|
| full overview repaint — `innerHTML` + wiring, 45 objects, 6 shelves | **23.5 ms** |
| `nearestIndex` — the per-scroll-frame geometry read | **0.03 ms** |
| `setProminent` — the class write when the index changes | **0.02 ms** |
| all six shelves recomputing prominence at once | **0.35 ms** |
| elements composited in 3D, at rest | **6 of 45** |

## Why prominence is cheap

Two things keep the scroll path from costing anything:

1. The scroll handler coalesces into one `requestAnimationFrame`, so it runs at
   most once per frame regardless of how many scroll events arrive.
2. `setProminent` returns immediately when the index has not changed. A long
   scroll across a shelf writes classes a handful of times, not sixty times a
   second.

At 0.03 ms a frame, the prominence calculation has about 0.5% of a 16 ms frame
budget. There is nothing here to optimise.

## Why 3D is not a problem here

Because there is almost none of it. `perspective` sits on the slot rather than
the row, so each object gets its own small stacking context instead of the whole
shelf sharing one, and only `.is-prominent` carries a rotation — **one element
per shelf, six in the whole page**.

The alternative design (every book drawn as a real 3D object with a rotated
spine face) would have been 45 composited subtrees with rotated glyphs. That is
the version §39 warns about, and it is the reason the spine is a drawn gradient
rather than a rotated face.

## Thumbnails

Every preview is `loading="lazy"` and `decoding="async"`, so offscreen images
never block the first paint. The frame's height is **fixed at 104px** and the
fallback is drawn underneath, so nothing in the layout depends on an image
arriving — or on it arriving at a particular size.

Measured with a deliberately unreachable URL: after the load failed, the frame,
the object, the rail's `scrollWidth` and all nine siblings were identical to the
tenth of a pixel.

## Virtualisation: not built, and why

**No evidence justifies it yet.** A 45-object Library repaints in 23.5 ms, which
is one frame over budget on a single interaction that already replaces the page.
Virtualising a horizontal scroller costs real complexity — measured item sizes,
a scroll-position mapping, keyboard order that must survive recycling, and
`markReturn` having to find an object that may not currently exist in the DOM.

The trigger to revisit: **a repaint over ~100 ms, or a shelf that stutters
while scrolling.** At the current per-object cost that is roughly 200+ objects.
If it is needed, the honest first step is to stop rendering the whole overview
with `innerHTML` on every filter change, which is where most of the 23.5 ms
goes — not to virtualise the rails.

## What could not be measured here

The harness browser does not composite frames, so:

- real paint and layout timings are unavailable;
- CSS transitions do not advance, which means `getComputedStyle` returns the
  transition's **start** value unless transitions are disabled first;
- `requestAnimationFrame` never fires, so anything rAF-gated cannot be driven
  by a real scroll — the geometry functions were called directly instead.

Every measurement above is a synchronous script timing or a layout read, both of
which are accurate in this environment. Frame-level smoothness is the one thing
that still needs a human on real hardware; it is listed in the stop report as
requiring your check.
