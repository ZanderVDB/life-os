# Library — Concept C2, the chosen direction

**Status:** a lab prototype at `#library/lab`, staging only. The real Library is
**unchanged** by this phase and C2 has not been integrated into it.

C was chosen out of the six directions in [L3.3](library-v2-l33-concept-bakeoff.md).
C2 is C with the three things the choice came with.

---

## What C2 keeps from C

- the **architecture** — categories in horizontal bays, editorial and restrained;
- **spine browsing** — Books rest spine-on, close together, and you read across
  them the way you read across a shelf;
- the **palette and typography** — nothing warmer, nothing more decorated.

## What C2 changes

| | C | C2 |
|---|---|---|
| Spine → cover | the spine widened and the cover **crossfaded in place** | the Book **turns ~90° on its own hinge** |
| Non-Books | archival folders that borrowed the shelf | **front-facing** portfolios, sleeves, clippings, jackets |
| Shelf | a back plane and one thin lip | a **built** niche: back panel, boundary uprights, ledge, front face |
| Thickness | decorative variation | derived from **page count** |

### The turn

The spine and the cover are two faces of **one box**, hinged at the spine's
outer edge — the point a real book pivots on when you pull it out of a row. The
box carries a third face, the page block, seen edge-on once the Book has turned.

Nothing is added to or removed from the DOM during the turn, and no transform is
ever written from script. `is-cover` is a class; `rotateY(-90deg)` is a rule.
An interrupted, throttled or reduced-motion turn therefore still lands on the
committed state, which is the house rule: *animations illustrate state changes;
DOM and CSS own the final state.*

### How the neighbours make room

By **layout**, not by pushing. Each Book sits in a slot whose width is the
Book's thickness. A turning Book's slot widens to the cover's width and the row
reflows.

Measured at 1280 — turning *Market Notes* (53px thick, depth 10):

| | before | after |
|---|---|---|
| its slot | 53px | 136px |
| the three Books to its right | — | **+83px** each |
| the five Books to its left | — | 0px |

83 = 136 − 53, exactly. Only the right side moves, because the hinge is on the
left — which is what a book does when you turn it out of a row.

One transition on one property. Two Books cannot end up in the same place,
because layout will not let them.

---

## Measured, at 1280 × 900

**The resting shelf** — nine Books (the Diary plus eight):

| Book | pages | thickness | height |
|---|---|---|---|
| My Diary | 120 | 50px | 208px |
| Notes | 0 | 26px | 181px |
| The Laws of Gravity | 25 | 37px | 190px |
| Letters I Did Not Send | 60 | 43px | 199px |
| Systems That Survive | 8 | 32px | 208px |
| Market Notes | 150 | 53px | 172px |
| Atlas | 540 | 58px | 181px |
| On Sleep | 42 | 40px | 190px |
| The Garden Book | 96 | 48px | 199px |

- **one baseline** — every Book bottoms at 505.03px. Not "about the same": the
  same number, in all four bays.
- **thickness 26–58px**, **height 172–208px**, five height steps.
- **gap 3px** between every pair. Close, not touching.
- **ledge 9px** in all four bays.

**The turned state:** cover 126 × 172 (the Book's own height, not a standard
one), page block 10px, `--cv: 0.235` giving a 15.04px cover title.

**Collections:**

| Books | row width | shelf width | behaviour |
|---|---|---|---|
| 3 (starter) | 116px of content | 897px | left-aligned on a mostly empty shelf |
| 9 (sample) | 411px of content | 897px | comfortable |
| 40 | 1824px | 897px | scrolls; nothing compresses |

**Responsive:** 1440, 1280, 1024, 768 all hold one baseline and produce no
page-level horizontal overflow. At 1024 the perspective flattens 1500 → 1900px
so the turn stays legible in a shallower row; at 820 and below the gap tightens
3 → 2px and the niche padding drops 14 → 10px. The cover stays 126 × 172 at
every width — it is never scaled, because scaling live type is what blurred the
shelf in L3.2.

---

## The shelf, as four layers

Because the honest criticism of C was that its shelf was *dark empty space plus
one thin horizontal line*.

1. **Back panel** — a graphite niche with a very restrained radial highlight at
   the top, so the bay reads as recessed and Book shoulders read brighter than
   their lower edges. It should not be noticeable as a lighting effect.
2. **Boundary uprights** — 5px structural verticals at each end of the bay only.
   Never between Books: a vertical between every Book is a rack, not a shelf.
3. **Ledge** — 9px, with a lit top arris, a stone top and a darker front face.
4. **Cast shadow** — below the front face, so the shelf sits in front of the
   wall rather than being drawn on it.

Everything is graphite, one highlight and one shadow. No wood, no moulding.

---

## What C2 does not do

- **It is not integrated.** The real Library still renders its L3.2 shelf. That
  is deliberate: adopting C2 is a separate decision and a separate phase.
- **Desktop first.** 768 is verified as viable, not designed.
- **Open routes to the real Library.** The lab owns no Book view.
- **A, B, D, E and F are frozen.** They stay reachable so the comparison that
  produced the choice can be re-made, and they get no further design work.

## If C2 is adopted

The integration is mostly deletion. `shared-cover.js` should move to the web
root and the **Book view should own it**, with the Library importing it — not
the reverse. The Library then drops its own cover markup, and the two covers
cannot drift again because there is only one.

See [the cover system](library-v2-cover-system.md),
[the resource grammar](library-v2-resource-grammar.md),
[system Books](library-v2-system-books.md) and
[starter Books](library-v2-starter-books.md).
