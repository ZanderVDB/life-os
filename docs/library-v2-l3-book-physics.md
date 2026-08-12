# Library — Book physics

Height, thickness, the box, and the hit rule. All of it in
`web/modules/library-lab/book-physics.js` and `lab-books.js`.

---

## Height — the pattern that looked generated

**The complaint.** The shelf silhouette read as

> increase, increase, increase, reset, increase, increase, reset

**The cause.** L3.4 hashed the id with `n = (n * 31 + ch) % 997` and took
`n % 5`. That is a fine hash for lookup and a bad one for appearance, because it
does not **avalanche**: two ids differing in one low character produce two `n`
values differing by a small amount, and `% 5` then walks the buckets in order.
The sample ids are `b1 … b8` — sequential — so the buckets came out sequential.

The defect was never the five steps. It was that **consecutive ids produced
consecutive buckets**.

**The fix, in two parts.**

1. **A hash that avalanches.** FNV-1a for mixing, then murmur3's `fmix32`
   finaliser. The finaliser is the part that matters: it is what makes `b1` and
   `b2` produce uncorrelated outputs, however ids are assigned.

2. **A curated ladder**, not arithmetic on the hash. Sixteen rungs, hand-weighted:

   | 170 | 175 | 180 | 185 | 190 | 195 | 200 | 205 | 210 | 215 |
   |---|---|---|---|---|---|---|---|---|---|
   | ×1 | ×1 | ×2 | ×2 | ×3 | ×2 | ×2 | ×1 | ×1 | ×1 |

   Middle-weighted, so most Books are ordinary and about one in sixteen is tall
   enough to notice. The order of the entries in the table is itself irregular,
   so no arrangement of ids can walk it in steps.

   A table rather than a formula because the thing being controlled is a
   *distribution*, and a table is the only version of it you can read at a glance
   and argue with. A uniform draw over the range gives a silhouette that reads as
   damage; averaging draws to fix that pulls the tails in so far that 170 and 215
   never appear at all (measured: 175–205 across 40 Books). The table gives both.

**Measured over 40 Books:**

| | old rule | new rule |
|---|---|---|
| longest ascending run | 5, by construction | **3** |
| identical neighbours | 0 | 7 / 39 (18%) |
| distinct heights | 5 | **9** |
| range used | 172–208 | **170–210** |

The first twenty, as rendered:

```
210 180 190 190 175 195 195 200 190 180 190 180 180 205 185 190 190 180 195 185
```

Quantised to 5px throughout: neighbours differing by 1–2px read as misalignment
rather than as variation, which was the right instinct behind having steps.

## Thickness — still means content

```
clamp(26, 26 + round(sqrt(pages) * 2.2) + bind(id), 58)
```

The square root keeps early differences legible while flattening the tail; a
linear mapping would make a 500-page Book eight times a 60-page one, which is a
wardrobe standing next to some envelopes.

`bind(id)` is **−2 … +2**, deterministic from the id. Its only job is to stop two
Books with the same page count being pixel-identical twins, which on a shelf
reads as a duplicated render. It is deliberately small: **±2px cannot reorder two
Books by apparent volume** — the gap between 60 and 150 pages is 10px, more than
twice the widest possible swing — so *thicker still means more inside*, which is
the property that must not be traded away.

| pages | 0 | 8 | 25 | 60 | 150 | 500+ |
|---|---|---|---|---|---|---|
| thickness | 26 | 32 | 37 | 43 | 53 | 58 |

(±2 from the binding offset, re-clamped.)

## The box

A closed hardcover is a solid, and the lab builds it as one. Four faces, in the
box's local frame, with the spine facing you at rest:

| face | position |
|---|---|
| back board | `x = 0` |
| spine | `z = 0` |
| front cover | `x = t` |
| fore-edge (page block) | `z = −126` |

Rotating the box about its left edge brings the front cover toward you at
`z = +t`, the back board behind it at `z = 0`, the spine edge-on at the hinge and
the page block edge-on at the far side. A real turned book, not a picture of one
— which is what lets a pulled Book show spine, boards and page block at once.

### The bug this replaces

C2 placed the page block with **`left: 126px`**. `left` is a *layout* offset, and
the box's rotation maps layout-x into **Z** — so 126px of layout became 126px of
depth *toward the viewer*, and perspective then threw the face sideways.

Measured: the page block of a turned Book rendered at **x 432–439** while its own
slot was **458–590** — 26px over its left neighbour, which it then swallowed for
pointer input. The page block had been on the wrong side of the Book the whole
time. It was only ever 10px wide, so nobody saw it.

**Depth is now `translateZ`, which is what it is.**

## The hit rule

> Nothing inside a volume takes pointer input — not the faces, and not the box
> that carries them. `.cb-vol` is the only target, it is never transformed, and
> it fills its slot exactly.

So a Book's hit area **is** the space it occupies on the shelf, in every state
and at every angle, and it is checkable with `elementFromPoint` rather than being
argued from a stack of z-indexes.

The slot widens to the turned Book's **projected** width:

```
126·|cos θ| + t·|sin θ|
```

Measured at 1280, middle Book turned, sweeping every pixel across the row:

| treatment | slot width | hit width | exact |
|---|---|---|---|
| A (82°) | 52px | 52px | ✓ |
| B (62°) | 90px | 90px | ✓ |
| C (72°) | 72px | 72px | ✓ |
| D (70°) | 90px | 90px | ✓ |
| E (52°) | 105px | 105px | ✓ |

with the uniform 3px margin intact between every pair — no overhang, no dead
zone. Left and right neighbours are owned by themselves at their own centres,
and clicking either selects it directly. There is no close-first step.

**One more overhang found on the way.** After the faces were made
`pointer-events: none`, B, C and D still reached 3px past their slots, because
`.cb-box` is itself transformed and its hit box is the *projected quad*. Small,
and the same class of defect as the 26px one. Fixed by making the box
non-interactive too — which is why the rule is "nothing inside", not "not the
faces".

## The five pulled treatments

None ends at 90°. At exactly 90° the cover is axis-aligned, the spine and page
block collapse to nothing, and what is left is a front-facing card — which is
the criticism this component exists to answer.

| | turn | movement |
|---|---|---|
| **A** True hinged turn | 82° | +20px toward you |
| **B** Three-quarter | 62° | +14px |
| **C** Pull and part | 72° | +18px, front board lifts 12° on the spine hinge |
| **D** Forward display | 70° | +46px, tipped 2° from above |
| **E** Shelf resting turn | 52° | none — pivots on its bottom corner, base on the ledge |

C's 12° is the most it can be: more would promise an interior this state does
not have.

See [the component lab](library-v2-l3-component-lab.md).
