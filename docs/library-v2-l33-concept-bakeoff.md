# Library L3.3 — the concept bake-off

**No winner is declared here.** The point of the phase is that the visual
direction is chosen by looking, not by another round of correction.

Route: **`#library/lab`** — staging only.

---

## Why a lab

L3, L3.1 and L3.2 each corrected something real — overlap, spine geometry,
scale blur, pull distance, shadows, baseline, fore-edge, shelf depth — and the
result still did not look like a Library. Every individual fix was measurable
and correct. That pattern is the signature of optimising the wrong metaphor,
not of a bug, and no further correction pass answers it.

So the process changed: six complete directions, one fixed set of objects,
compared side by side.

## What makes the comparison fair

Every concept draws the **same** eight books, the same Diary, the same three
documents (and, in E and F, the same images, videos, links and files) from
`lab-data.js`. Same titles, same subtitles, same accents, same viewport.

The same book gets the same cover template in every concept, so switching shows
you the same volume rather than a different library.

The data is held as literals rather than fetched. That is also what makes the
lab read-only by construction: it issues exactly one network request in its
whole lifetime — the availability check — so there is no path by which an
experiment could write anything.

---

## Concept A — Spine-first

**Premise.** *I see the hardbacks. I choose one. It turns toward me. I choose it
again and it opens.*

| | |
|---|---|
| Resting | Spine-on, shoulder to shoulder, heights 178–218px, spine widths 30–45px |
| Interaction | First press: the volume slides out and **turns ~90°** to face you. Second: opens |
| Document | Slim labelled binders standing on the same shelf |
| Shelf | Back plane, bright surface line, a 9px front lip with a lit top edge, floor wash |

**Strengths.** The only concept where the resting shelf is genuinely a shelf of
hardbacks. The turn is the most satisfying interaction of the six and the one
closest to the stated ideal.

**Weaknesses.** Titles are least discoverable at rest — you read spines, which
is slower than reading covers. A 45px spine holds about 20 characters.

**Technical risk.** The turn is the only real 3D in the lab. It is handled by
committing the final state: when the transition ends the 3D is dropped entirely
and the cover becomes an ordinary untransformed element. Measured after the
commit — cover 126 × 214, title box 104px, `transform: none`.

## Concept B — Fantasy shelf

**Premise.** A private study: deep, warm, a little grand.

| | |
|---|---|
| Resting | Cloth and leather volumes, heights 186–246px, head and tail bands, gilt rules |
| Interaction | The book **leans out and rises**, as if tipped by its head band; its cover peeks alongside |
| Document | Cloth folios tied with a band |
| Shelf | A framed bay — side posts, top rail, heavy front ledge, light falling from the opening |

**Strengths.** The most atmospheric, and the most obviously *a bookshelf* at a
glance. Height variation does a lot of work.

**Weaknesses.** The most decoration to keep in check; the framing costs vertical
room; the warmth pulls slightly away from the Life OS palette.

**Technical risk.** Low — all gradients and geometry, no 3D.

## Concept C — Modern library

**Premise.** Editorial and premium. A gallery, not a study.

| | |
|---|---|
| Resting | Level spines, generously spaced, widths 38–54px, one line of type each |
| Interaction | The spine **widens and the cover crossfades in place** — almost no travel |
| Document | Crisp archival folders, light stock, printed index |
| Shelf | Plain back plane and one precise stone-and-metal lip |

**Strengths.** The most restrained and the easiest to keep looking good as the
collection grows. Typography does the work.

**Weaknesses.** Least tactile; the crossfade is elegant but not physical, and it
is the concept furthest from "fantasy".

**Technical risk.** Lowest of the six.

## Concept D — Cover-forward

**Premise.** A reading-room display: what is here, shown properly.

| | |
|---|---|
| Resting | Covers out, **leaning ~1.6° back** against the ledge, with a visible side face and page block |
| Interaction | The book **straightens upright and comes forward** |
| Document | Front-facing portfolios with a visible flap |
| Shelf | A shelf with an 11px lit lip |

**Strengths.** Titles are readable without any interaction. The lean plus the
side face is what stops it reading as a card — this is the fair test of whether
covers are actually preferred once executed properly.

**Weaknesses.** Holds the fewest objects per screen. Closest of the six to the
current Library, which is the thing under review.

**Technical risk.** Low.

## Concept E — Alcoves

**Premise.** A room made of openings — everything has somewhere it lives.

| | |
|---|---|
| Resting | Each category in a shallow framed bay: lintel, jambs, sill, inner shadow |
| Interaction | The object **slides out of its slot** within the bay |
| Document | A rack of tabbed folios standing in slots |
| Others | Media in a framed tray; links and files in pigeonholes |

**Strengths.** The only concept besides F that gives every resource type a
native home. The architecture reads as a system without drawing a room.

**Weaknesses.** Five bays is a lot of vertical space; the frames compete with
the objects for attention.

**Technical risk.** Low, but the most layout to maintain.

## Concept F — Personal archive

**Premise.** One room, several kinds of storage.

| | |
|---|---|
| Books | An open shelf, spine-on |
| Documents | A folio rack with visible pull tabs |
| Media | A contact-sheet board, prints clipped in a row |
| Links | A clipping board, cards pinned under a rail |
| Files | Labelled drawer fronts that slide open |

**Strengths.** The most distinctive, and the most honest about different kinds
of thing being stored differently.

**Weaknesses.** **Five metaphors is five things to learn.** This is the concept
most at risk of reading as inconsistent rather than rich — which is precisely
why it is one of six rather than a proposal.

**Technical risk.** Low individually, highest in aggregate: five furniture
systems to keep coherent as the product grows.

---

## What is shared across all six

- the eight books, the Diary and the documents, from one file;
- four cover templates, assigned by book id, stable across concepts;
- one `spineTitle()` for every spine-based concept, so long titles are handled
  identically and the comparison is about the shelf;
- a drawn shelf in every concept — back plane, surface, front edge — never a
  dark rectangle with a line under it;
- keyboard focus and activation on every object, and reduced motion that
  removes travel without removing information.

## Known limitations

- **Desktop first (§23).** Built for 1280 × 900. Narrow widths get a viability
  preview, not a designed mobile layout.
- **A is the only complete interaction.** B–F are visually representative
  prototypes, as §28 allows.
- **Open routes to the real Library.** The lab does not own a Book view, so
  demonstrating the handoff means leaving the lab.
- **The lab is disposable.** Everything lives in `web/modules/library-lab/` and
  can be deleted in one move once a direction is chosen; a test asserts nothing
  outside that folder imports a concept.

## One bug worth recording

The four cover templates were first named `rule`, `band`, `frame`, `plate`,
producing `lab-cover-rule` on the cover element — which collided with the
`lab-cover-rule` divider *inside* the cover. Every book on that template
inherited `width:30px;height:1px` for its whole cover, and the title wrapped one
character per line. Measured as a 30px cover inside a 126px face.

Namespaced to `tpl-*`, and a test now fails if an unprefixed name returns.
