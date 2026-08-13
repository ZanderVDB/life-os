# Library — the physical object model

Three rules. Everything on a shelf obeys all three, whatever kind of thing it is.

> **1. ONE PLANE.** Every object's bottom sits the same distance from its
> shelf's ledge — whatever the object is, whatever shelf it is on.
>
> **2. ONE PHYSICS.** Every object lifts by the same amount, with the same two
> shadows, and nothing scales.
>
> **3. THE PULLED STATE IS THE BEST STATE.** If an effect makes the chosen
> object softer or harder to read, the effect goes.

---

## The shelf plane

    ledge line    = rail bottom − var(--shelf-drop)      /* 30px */
    object bottom = ledge line  − var(--shelf-contact)   /* 4px  */

Objects may be any height **above** that line. A Document is shorter than a
Book and rests on the same plane, because that is what a shelf means.

### The two things that broke it, both measured

**A shelf with its own padding.** The ledge is drawn from the rail's bottom
edge, so a rail with different padding puts its objects on a different plane.
Measured before: contact gap **Diary −6px, Book +36px, Document +36px** — the
Diary hanging 42px lower than everything else. No shelf sets its own rail
padding now, and a test fails if one does.

**A scrollbar that only exists sometimes.** A horizontal scrollbar lives inside
the rail's border box, so a shelf that *overflows* is ~10px shorter in content
than one that fits. Measured: books rail `offsetHeight` 287 against
`clientHeight` 277; personal rail 242 against 242 — 10px out even after the
padding was unified.

`scrollbar-gutter: stable` does **not** fix this: it reserves the *inline*
gutter, not the block-end one. `overflow-x: scroll` on every rail does.

**Measured after:** Diary, Book, Document, Media, Clippings and Recently opened
all at exactly **18px**. One value, six shelves, four object types.

## The book

    ┌──┬──────────────┬─┐
    │  │  Life OS     │ │   spine  22px   bound edge, lit on its outer face
    │  │  NOTEBOOK    │ │   cover 126px   the approved Book identity
    │  │  Atlas       │ │   block   6px   the FORE-EDGE — the page block
    │  │  ─────       │ │
    │  │  ZANDER·2026 │ │
    └──┴──────────────┴─┘

The **fore-edge** is what L3.1 was missing, and it is most of why the object now
reads as bound: a card has no page block. It is finely lined so it reads as
paper rather than as a bar, and lit from the same side as everything else.

All three heights come from **one expression** — `calc(var(--bw) * 297 / 210)` —
so they cannot drift apart.

> `aspect-ratio` used to size the cover, and **it yields to content**: a cover
> with a long title, a subtitle, a rule and an author line grew past its ratio.
> Measured: a sample Book **212.7px** tall against the Diary's 178.2. Every book
> is now 178.19px, and anything that does not fit is clipped rather than allowed
> to stretch the object.

The **hinge** is drawn on the cover, lit to match the spine's falloff, so the
junction reads as a fold rather than a seam between two separate things.

### The spine (option C)

22px, 10px type, vertical and reading bottom-to-top, with a title cut at a word
boundary and marked with an ellipsis. Accent bands at head and tail.

The full title is never lost — it is on the cover, in `title`, in the accessible
name, and in the footer when the object is pulled. §4's rule: *do not cram the
full title merely because the data exists.*

## Density, by collection size

|  | |
|---|---|
| **1–3 objects** | 16px gap. Two Books must read as two Books. |
| **4+** | gap 0 — books **touch**, each page block against the next spine |

L3.1 used one formula at every size: 64px of overlap on a 150px object, so each
book showed 86px and the next book's *dark spine* landed in the middle of the
previous cover. Cover / dark band / cover / dark band is a card stack, which is
exactly what the review saw.

**The overlap is gone entirely rather than reduced.** Tucking each fore-edge
behind its neighbour's spine would hide the strongest "this is bound" cue to buy
6px. Books that simply touch already read as a shelf.

Measured: step per book 150 → **154**, with a 16px gap at three books and 0 at
twelve.

## The two shadows

Not an elevation scale. **A resting object here casts nothing.**

| | Resting | Pulled |
|---|---|---|
| **contact** — a tight ellipse where the object meets the shelf | full | shrinks, fades, drops |
| **depth** — a soft cast shadow on the face | absent | appears |

Both are tokens (`--obj-edge`, `--obj-lift`) used by the cover, the folio and
the media frame, so a Document and a Book cannot drift apart stylistically.

That is how a real object leaving a surface behaves, and it is the difference
between shelf contact and Material elevation — which gives everything a cast
shadow whether it has left the surface or not.

## Crispness

**Root cause, found by measurement.** L3.1 pulled with
`translateY(-22px) scale(1.06)`. A non-integer scale resamples everything
inside: a 126px cover became 133.56px and every glyph was redrawn on a grid it
had not been laid out on.

The fix is not a smaller scale. **It is no scale.**

Measured after, resting against pulled:

| | Resting | Pulled |
|---|---|---|
| cover width | 126.000 | 126.000 |
| title box | 45.4844 × 17.3906 | 45.4844 × 17.3906 |
| title left | 1120.25 | 1120.25 |
| title top | 903.5 | 873.5 |
| divider rule | 1px | 1px |

The vertical offset is exactly **30.0000** and the **subpixel phase is identical
in both axes** — so the rasterisation is unchanged. §5's rule holds by
construction rather than by tuning.

### Why 32px and not 30

The travel must land on a whole **device** pixel at every supported ratio, or
the pulled object rasterises on a different phase from the resting one. 30 ×
1.25 = 37.5 — half a device pixel out. **Any multiple of four is exact at DPR 1,
1.25, 1.5 and 2**, and 32 is the smallest one in §6's list that unmistakably
reads as pulled. The opening handoff uses 48 for the same reason.

## Hover is smaller than a pull

3px against 32, and only the pull reveals anything. Hover says *this responds*;
pulling says *this one*.

## The object footer

The title, the subtitle and the Open action share one footer **beneath** the
object, at the object's own width, inside the shelf's label zone.

L3.1 floated a bright purple pill over the cover, in the same corner region as
the overflow menu. The review called it a debug badge, and it was: a saturated
UI chip on top of the artwork, belonging to neither the object nor the page.

The overflow menu now sits at the object's **top**, the Open action at its
**bottom** — opposite ends, so they cannot compete for the same press, and the
menu can never cover the title. Measured: menu 5px from the object's top edge,
footer 163px below the menu's bottom, footer width 154px against an object width
of 154px.

## Local breathing room

Pulling an object moves its two **neighbours** aside by 16px — a transform on
two siblings, so nothing is measured, the rail does not reflow, and nothing that
is not adjacent moves at all.

## The Document folio

Flatter than a book (118px against 178) and landscape, because a folio lies
down.

| | |
|---|---|
| **paper stock** | the same `--paper` as a Book cover and a Diary page |
| **2–3px radius** | not a card radius. Paper corners are square-ish |
| **sheet edge** | a lined page block down the right, matching the book's fore-edge |
| **accent tab** | 4px down the left, the way a filed folio is tabbed |
| **its own title** | so it needs no detached resting label |

It gets the same baseline, the same two shadows and the same 32px lift with no
scale. What it does not get is a spine, because it is not bound.

Media frames share the folio's 118px height, so a mixed shelf sits on one line.

## The Diary is the same Book family

Same cover width, same spine, same fore-edge, same height, same baseline —
measured 154 × 178.2 with an identical 18px contact gap. What makes it distinct
is **material and words**: a deeper cloth, a lavender spine edge, and "System
journal" in its footer. Never geometry.

---

## L3.4 — the measured object

The Book is a solid with four faces in one coordinate system:

| face | position | size |
|---|---|---|
| back board | `x = 0` | 126 x h |
| spine | `z = 0` | t x h |
| front cover | `x = t` | 126 x h |
| page block | `z = -126` | t x h |

`t` is the thickness (24-52px, from `pageCount`), `h` the height (170-215px, from
a sixteen-rung ladder), 126px the cover width. **Depth is `translateZ`, never a
layout offset** — inside a rotating `preserve-3d` box, `left` becomes depth and
is then thrown sideways by perspective.

### Measured through the turn (29px-thick Book, 1280px viewport)

| angle | cover | spine | page block | total span |
|---|---|---|---|---|
| 0 deg | 0 | 29 | 29 | 29 |
| 22.5 | 48.22 | 26.79 | 26.79 | 75.0 |
| 45 | 89.10 | 20.51 | 20.51 | 109.6 |
| 67.5 | 116.41 | 11.10 | 11.10 | 127.5 |
| 90 | 126 | 0 | 0 | 126 |

Exactly `126 sin(theta)` and `29 cos(theta)`. Every face foreshortens together,
which is what a rotating solid does; the 1.5px span excursion at ~77 degrees is
the honest geometry of a solid turning, not an interpolated width.

### The commit

| | cover width | cover left |
|---|---|---|
| arrived (-90 deg, 3D) | 126 | 721 |
| committed (flat DOM) | 126 | 721 |

Identical, because the compensating `translateZ(-t)` returns the cover to the
screen plane. Perspective (1400px, on the row) therefore magnifies neither
terminal state — verified with perspective enabled.

### The hit rule

Nothing inside a volume takes pointer input: every face is transformed, and a
transformed element's hit box is its projected quad, which is not where the Book
looks like it is. `.lib-obj` is the only target and is never rotated. When a Book
is pulled, an untransformed `::before` at the cover's footprint extends the
target to match what you can see.
