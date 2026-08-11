# Library L3 — the bookshelf (BUILT)

> **Status: implemented.** This was the approved direction, kept here as the
> record of what was intended and what the gating question was. The design as
> shipped is in **`library-v2-l3-spatial-design.md`**; read that one first.
>
> The gating question below — *how do the five non-Book types live on a shelf?*
> — was answered before any shelf was drawn, which is why it is still the first
> heading. The answer is a related-but-honest visual family: same shelf, same
> ledge, same five states, same type scale, and **no spine on anything that is
> not a book**. A spine on a JPEG is a lie about what the thing is.

Library should feel like a library, not a badge grid.

- Books represented by covers and spines, browsed on a shelf.
- **Scrolling** rather than repeated side-click navigation.
- A selected Book may come forward from the ones around it, and the ones around
  it stay spatially visible — you should never lose your place on the shelf.
- A curved or half-circle arrangement is worth trying and must be **tested for
  usability before it is committed to**. Curves look wonderful in a mockup and
  are frequently harder to scan and much harder to make keyboard-navigable.

## The question that gates it

**How do Documents, Links, Images, Videos and Files live on a shelf?**

Five of the six Library types are not books. Forcing them onto a literal
bookshelf makes a saved URL pretend to be an object it is not; putting them
somewhere else makes Library two browsers with one name.

Decorative shelves must not be built before that is answered. A shelf that only
works for one of six types is a redesign that immediately needs a second one.

## Diary on the shelf

Diary may appear as a system shortcut or a book-shaped reference. It remains a
**separate data model**: it cannot be archived, renamed or filed as an ordinary
Library Book, and it never becomes a `library_items` row.

That is precisely the pressure this idea puts on the boundary, and why it is
deferred rather than sketched: a diary that looks like a book on a shelf is a
diary somebody will try to rename.

## Related deferrals

Month-as-tabs, the month overview spread and the year jump are recorded in
`diary-v2-direction-d2.md`.

---

## What was decided, against what was written above

| Written here | Shipped |
|---|---|
| covers and spines on a shelf | both — cover face plus a drawn spine strip |
| scrolling rather than side-clicks | native `overflow-x`, arrows secondary and hidden when useless |
| a selected Book comes forward, neighbours stay visible | `.is-prominent`: lift, 1.045 scale, a 7° turn; nothing is ever hidden |
| **a curve, tested for usability before committing** | **not built** — see below |
| Diary as a system shortcut | built, on its own "Personal" ledge |

### The curve was tried on paper and rejected

§6 permitted a very shallow arc "only if scroll remains predictable, titles
remain readable, keyboard focus remains logical, and Book positions do not feel
like a carousel trap". Every one of those is a cost, and the benefit is
atmosphere.

Two of them are hard failures rather than trade-offs: an arc means each object
sits at a different rotation, so **every** object needs its own 3D transform
(45 composited subtrees instead of 6), and objects at the ends of the arc are
rotated far enough that their titles stop being crisp — which §24 forbids.

The prominent-object turn keeps the part of the idea that was worth having: the
shelf has depth, and the thing you are looking at is turned toward you. Recorded
here rather than silently dropped, because a shallow arc is exactly the kind of
idea that comes back.
