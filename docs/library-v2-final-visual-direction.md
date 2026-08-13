# Library — the final visual direction

**Authoritative.** This is the Library, chosen component by component by the
authenticated user from the L3.5 component lab. It holds until a future
deliberate Library redesign.

| | Chosen |
|---|---|
| Resting Book | **A** — cloth hardback |
| Book hover | **A**, strengthened |
| Pulled Book | **E** — shelf resting turn, completed to front |
| Shelf | **A** — graphite built-in |
| Documents | **D** — file folio |
| Media | **E** — display, refined |
| Links | **A** — clipping card |
| Files | **A** — file jacket |

It is implemented in the **real** `#library`. No concept-switching code runs in
Library rendering; the design lab survives only as a staging-only route, and is
marked for removal in the next housekeeping pass.

---

## The Book

A closed hardcover, built as a solid. Four faces in one coordinate system:

| face | position |
|---|---|
| back board | `x = 0` |
| spine | `z = 0` |
| front cover | `x = t` |
| page block | `z = −126` |

Every decorative line is a **child of the face it is printed on** — the spine's
bands and foil rule turn away with the spine, the page striations turn with the
page block. Nothing stays visually straight while the Book turns, which was the
review's first complaint.

**Materials** (§5), deterministic per Book: plum, navy, slate, moss, walnut,
claret, graphite. Muted cloths, not brand colours — Life OS purple stays the
interface accent and no Book may wear it. A test enforces that.

**Height**: sixteen hand-weighted rungs, 170–215px, middle-weighted. **Thickness**:
`clamp(24, 24 + round(6·pages^0.35) + bind(id), 52)`. The exponent matters — a
square root was tried and produced a shelf where every spine measured 25–30px,
because real Books start at one or two pages and √2 and √8 are 3px apart. Most
of a Library lives in the first dozen pages, so that is where the curve works.

## The turn

```
RESTING SPINE → pulls up and out → rotates on the spine hinge → FRONT COVER → OPEN
```

One rotation about the spine's outer edge, plus a compensating `translateZ(−t)`.
That compensation is the whole trick: at −90° it puts the cover back in the
screen plane, so its projected width there is **exactly** its layout width.

Measured at 1280, on a 29px-thick Book:

| angle | cover | spine | page block | span |
|---|---|---|---|---|
| 0° | 0 | 29 | 29 | 29 |
| 22.5° | 48.22 | 26.79 | 26.79 | 75.0 |
| 45° | 89.10 | 20.51 | 20.51 | 109.6 |
| 67.5° | 116.41 | 11.10 | 11.10 | 127.5 |
| 90° | 126 | 0 | 0 | 126 |

Exactly `126·sin θ` and `29·cos θ` — every face foreshortening together, which is
what a rotating solid does. **No inflation**: the terminal states are 29px and
126px precisely, and the 1.5px mid-turn excursion is the honest geometry of a
solid turning, not a width interpolation. There is no `scale()` anywhere and no
CSS width animation.

### The commit

Once round, the 3D is dropped: `is-front` removes the box transform, hides the
three depth faces, and lets the cover become an ordinary untransformed element.
Measured — the arrived cover is 126px at x=721 and the committed cover is 126px
at x=721. **Seamless**, because the animation ends where the flat state begins.

`transitionend` is the optimisation, a 380ms timer is the guarantee, and reduced
motion commits synchronously without ever rotating. A throttled or interrupted
turn cannot strand a Book half-way.

## Hover

8px up (was 3px, and the review called it too quiet), the cloth brightening 16%,
a deeper contact shadow. The hierarchy is arithmetic:

```
RESTING 0px   <   HOVER 8px   <   PULLED 32px
```

Nothing is revealed on hover; hover says *this responds*, pulling says *this one*.

## Neighbours

Only the two immediate neighbours move, by **16px** each. Measured: exactly
`[−16, 0, +16]` — nothing else on the shelf moves.

16 rather than 14 because every travel must land on a whole device pixel at DPR
1, 1.25, 1.5 and 2. 14 × 1.25 = 17.5, half a device pixel out, which is the
phase error L3.2 traced the shelf blur to. Any multiple of 4 is exact.

The pulled Book keeps its shelf width. An earlier version widened it to its
cover, which reflowed a centred row and moved the neighbours 48.5px — a
whole-shelf reflow. The cover simply overhangs, and an untransformed shim at the
cover's footprint gives it somewhere to be clicked.

## Open, and management

Beneath the arrived Book: its title, optionally its subtitle, and a quiet
`Open`. No floating purple pill. The second click on the cover still opens, so
the label is actionable rather than load-bearing. On mobile the action is a 44px
target — one tap to turn, one to open, no double-tap.

The overflow menu appears **only when front-facing**, and is `pointer-events:
none` until then. A 24px menu cannot sit on a 29px spine without becoming the
spine, and a control that appears mid-turn is one you hit by accident.

## The flat families

None of them rotates. A folder does not turn round: they come forward.

- **Document (D)** — a file folio, half open: two sheets standing behind a lid
  that carries the kind, title and opening line. The sheets are what make it a
  folio rather than a card.
- **Media (E)** — the picture dominates. A plain-text caption beneath it, no
  dark footer bar (the caption's background computes to `rgba(0,0,0,0)`). Video
  always carries a play mark and a duration, in the visual and in the name.
- **Link (A)** — a clipping card: source mark, title, domain.
- **File (A)** — a jacket with a clipped lower corner, kind and size.

## The Diary

The same Book, the same turn, the same commit. Lavender cloth, `JOURNAL` on the
cover, `Life OS Journal` as its author line. No overflow menu, because there is
nothing to rename or archive; no `library_items` row; no badge and no system
button. The distinction is material and behavioural.

## Motion

| | |
|---|---|
| hover | 140ms |
| pull | 200ms (`--t-select`) |
| turn | **300ms** (`--d-turn`) |
| neighbour clearance | 200ms, with the pull |
| open handoff | 320ms |

No springs, no overshoot, no bounce. Reduced motion skips the turn entirely and
arrives at the committed front-facing state; every state semantic is identical.

## Known limitations

- **The shelf is Concept A, unchanged.** §20 accepted it as sufficient rather
  than solved; §21 records the atmosphere work as future, deliberately not done.
- **Thickness is only as varied as the data.** The full sample Books hold 1–3
  pages, so they measure 30–36px. That is honest — they really do contain almost
  nothing — and the variation a real shelf gets comes mostly from height and
  cloth until Books are written in.
- **Screenshots still needed.** The harness cannot composite, so everything here
  is geometry and computed style, not appearance.
