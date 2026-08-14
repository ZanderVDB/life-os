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

---

## Resting Book tuning

Four numbers decide how a Book stands on the shelf. They live in **one place** —
the `RESTING BOOK TUNING` block on `:root` in `web/index.html` — and nothing
below restates them. To change the look, change these and nothing else.

| token | committed | range | larger means |
|---|---|---|---|
| `--lib-book-gap` | **0px** | 0–14px | more air between Books |
| `--lib-book-lean` | **0deg** | −6–6deg | leans further right (negative: left) |
| `--lib-book-top-tilt` | **−4deg** | −10–10deg | tips further back, showing the head (negative: forward, showing the tail) |
| `--lib-book-yaw` | **−6deg** | −12–12deg | swings the back edge further round toward you |
| `--lib-book-depth` | **0px** | 0–16px | Book stands further proud |
| `--lib-page-grain` | **90deg** | 90 / 0 | flips which way the page edges run |

**These are the authenticated choices**, made on the real shelf with the Book
Tuner rather than guessed. The pose that came out of it: Books touching, standing
square, tipped slightly **forward** so you read the tail rather than the head,
and turned a little to the **left** so the front board catches the eye. Nothing
stands proud — the yaw does that work now, and the depth nudge only softened it.

Measured after committing, on the real `#library` with three Books:

- gap between Books: **exactly 0px** — they touch
- tail exposed (tipped forward): **8.99px**
- side (front board) visible: **13.17px** — the yaw doing the work
- every object bottoms **exactly on the ledge** — 0px, on all five shelves
- spine title unchanged at 11.5px

### How it is built

Two nested frames, because they pivot about different points:

- **`.lib-stand`** owns the resting pose — `rotateX(top-tilt)` then
  `rotateZ(lean)` then `translateZ(depth)`, with `transform-origin: left bottom`
  so the Book leans *while standing on the shelf*. A centre origin would swing
  the base off the ledge and the Book would read as floating.
- **`.lib-vol`** owns the turn, hinged at `left center` — the spine's outer
  edge, where a book pivots when you pull it from a row.

The order inside the stand is load-bearing: tilt back about the base first, then
lean the standing Book. The other way round tips it along the already-leaned
axis and the bottom corner lifts.

The tilt has something to reveal because the box gained a **head** — a real
fifth face, `t` across and 126 deep, showing the head of the page block. It is a
face of the same box, not a drawn edge, and it stops painting when the cover
commits.

### How it behaves

Pulling unwinds the pose over the **same 400ms and the same curve** as the turn,
so the two read as one motion and the pull begins from the Book's actual resting
orientation — there is no snap to square before anything rotates. Measured after
commit: cover **126px, flat, `transform: none`**. Escape restores the resting
pose exactly.

The stand and the volume take **no pointer input**. Both are transformed, so
their hit boxes are projected quads that overhang the neighbours — the first
thing that cost was a click on one Book pulling the one beside it. `.lib-obj`
stays the only target: untransformed, and exactly its own space on the shelf.
Verified: each of the three Books owns its own centre.

### Known limitation

The spine title now sits on a plane tilted 4° and leaned 2°, so it is resampled
rather than pixel-aligned. It is still 11.5px and its geometry is unchanged, but
whether it reads as crisp enough is a judgement only the eye can make — if it
looks soft, **reduce `--lib-book-top-tilt` first**; it costs the least.

### The Book Tuner (staging only)

Rather than sending numbers back and forth, the eight values are adjustable
live on the real shelf. Open **Library** on staging and press **Book Tuner**
beside the title; move a slider and the real Books change immediately.

It exists only where `GET /library/sample` reports `allowed` — the same
authority the sample tooling and the design lab use, which is exactly
`NODE_ENV !== 'production'`. There is no query flag to set.

It writes **nothing**: no request, no database, no stored preference. Each
control sets one custom property on `document.documentElement`; a reload
returns to the committed defaults, and leaving Library removes the panel and
every override with it. `Copy configuration` gives both the one-line summary and
the CSS declarations, ready to be committed as the new defaults.

Two numbers that used to be literals became tokens so the tuner could reach
them: `--lib-book-hover`, `--lib-book-pull` and `--lib-book-neighbour`. The turn
duration is now **one authoritative value** — the JS commit timer is derived
from `--d-turn` rather than written down beside it, so slowing the turn cannot
leave a Book committing mid-rotation.

| token | current | range |
|---|---|---|
| `--lib-book-hover` | 8px | 0–14px |
| `--lib-book-pull` | 32px | 20–48px |
| `--d-turn` | 400ms | 250–650ms |
| `--lib-book-neighbour` | 16px | 0–28px |

Shelf headroom is 52px so a Book still clears its rail at the **maximum** pull
distance, not merely the current one — verified at 48px: 3px of clearance, no
clipping.

### Three axes, and the page grain

The resting pose is three rotations about the base, not one:

| token | axis | current | range |
|---|---|---|---|
| `--lib-book-lean` | `rotateZ` — leans left or right | 2deg | −6…6 |
| `--lib-book-top-tilt` | `rotateX` — tips back (head) or forward (tail) | 4deg | −10…10 |
| `--lib-book-yaw` | `rotateY` — swings the back edge toward you | 0deg | −12…12 |
| `--lib-book-depth` | `translateZ` — stands it proud | 6px | 0…16 |

Lean and tilt are symmetric so either side can be looked at; yaw is the one
that brings the back round and shows the side. All three pivot at the bottom of
the spine, and shelf contact measured **0px at every extreme** of all three.

Tipping forward needed something to show, so the box gained a **tail** — the
bottom face, built like the head and darker because the shelf is right under it.
Without it, a negative tilt showed the inside of an open box.

**The page grain was wrong on the fore-edge.** Pages stack from the front board
to the back board — across the Book's *thickness* — so on both page faces the
grain repeats across the element's width, and each line runs the other way: down
the height on the fore-edge, away from you on the head. The fore-edge had been
running horizontal lines stacked vertically, which is ruled paper seen face-on
rather than a page block seen edge-on, on the one face you see most.

`--lib-page-grain` (90deg / 0deg) flips both together, so the direction can be
settled by looking rather than by arguing about which way a book faces.

#### The head and tail were inside-out

The first version of both faces swept from the FRONT edge backward, and the
direction of the sweep is what decides which way the painted side ends up
pointing. Measured: the head's normal came out `(0, +1, 0)` — facing **down**,
into the Book — and with `backface-visibility: hidden` inherited from
`.lib-face`, the only side you can look at it from was the culled one. Tilting
back therefore showed a hollow box rather than paper, which is exactly what the
review described. The tail had the same fault mirrored.

Both now sweep from the back edge forward — `translateZ(-126px) rotateX(±90deg)`
— which rotates first and pushes the plane back after, so the sweep still spans
the full depth and the normal comes out facing the eye: `(0, -1, 0)` up for the
head, `(0, +1, 0)` down for the tail. Re-measured after: head sits exactly on
the spine's top edge, 9.97px of it projected at 4° of tilt, with the grain
running front-to-back.

### S2.5 — four corrections from the real shelf

**Books stand on the ledge; flat resources sit above it.** A Book is standing on
a shelf and a folio in a tray is not, and putting both on the same line made the
trays look like they had fallen to the bottom of their bay. `--lib-flat-lift`
(14px, tunable) lifts Documents, Media, Links and Files. Measured: Book 0px from
the ledge, Document 14px above it.

**A Book carries no label beneath it.** The cover already says what the Book is,
and by the time the footer was readable the title was set across the middle of
the cover anyway. The second click on the cover still opens it. Flat resources
keep theirs — they have no cover to read.

**The two sides make room differently.** The Book is hinged at its spine, on the
LEFT, so the cover swings out to the RIGHT and ends up 126px wide against a
24–52px spine. A symmetric 16px nudge therefore left the right neighbour
*underneath* the cover — a Book opening in front of the Books to its right. The
right side now clears the cover's **overhang past the spine**, measured per Book
when it is pulled, and every following slot moves by the same amount so their
spacing is unchanged. Nothing to the left moves. Measured pulling the first
Book: the pulled Book stays put, the two to its right move +108px, the cover
ends at x=814 and the next Book begins at x=830.

**The skeleton waits.** A Book usually arrives in well under a tenth of a
second, so painting a skeleton first made every open go shelf → grey pages →
Book: three paints for one action, the middle one on screen just long enough to
register as a glitch. The skeleton is now deferred by 180ms and cancelled if the
Book beats it. Measured across a full open with a mutation observer: the
skeleton painted **0 times** and "Opening…" **0 times**.

### S2.6 — the Book was not reloading

The reported symptom was the Book "re-shooting" itself every time the side view
opened, assumed to be a reload for the page content and the overflow menu.

**It was not a reload.** Measured with a mutation observer across a full open:
the Book body is written to `#main-scroll` exactly **once**, 18ms after the
click. Nothing re-fetches and nothing repaints.

What was actually happening: `is-opening` flew the shelf object up 48px and
faded it to 10% over 320ms, to cover a wait that does not exist. At 18ms it got
about one frame — just enough for the Book you had carefully turned to face you
to jerk upward and start vanishing before the screen swapped. One activation,
two movements, the second a stub of an animation that never finished.

The hand-off is gone. The committed front-facing cover simply hands over.
Re-measured: the object is already detached by the first 33ms sample, with no
intermediate position or opacity, and the body still paints once. If a Book ever
is slow to arrive, the shelf stays on screen until it does — the same rule
everywhere else.

### The Book Tuner has been removed

It did its job: the resting pose was chosen on the real shelf and committed in
S2.4. `web/library-tuner.js`, its stylesheet, its trigger, its staging gate and
its test file are all deleted. The tokens it drove remain, in one block, and can
still be changed by editing them.
