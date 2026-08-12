# Library — shelf architecture options

Five treatments, in `#library/lab` → **Components** → **Shelf**.

**Identical Books in identical positions in all five.** Measured: every slot's
offset and width matches byte-for-byte across A–E. Only the furniture changes,
because a comparison where two things move at once is not a comparison.

---

## One construction, five expressions

Every bay is built from the same four layers, and a variant that does not want a
layer **hides** it rather than the markup changing shape:

```
cb-wall     the back panel
cb-post ×2  uprights, at the boundaries only
cb-scroll   the Books
cb-ledge    the shelf surface and its front face
```

Uprights at the ends only, never between Books — a vertical between every Book
is a rack, not a shelf.

## The five

### A — Graphite built-in
A recessed niche. Defined side boundaries, a solid 9px ledge with a lit arris,
restrained top light, cast shadow. **This is C2, better built** — the reference
point rather than a new idea.

### B — Floating stone
A heavy slab: **17px** front face, no uprights at all, 6px side padding. The mass
is at the bottom and the Books are strongly grounded. Architectural rather than
decorative — the shelf is a thing the wall is holding, not a frame around the
Books.

### C — Metal frame
Thin structural uprights (3px, running slightly proud of the bay top and bottom)
at the ends only, a slim **5px** plane, a recessed backing with a 1px inner
line. Restrained on purpose: a frame, not scaffolding.

### D — Recessed light niche
A deeper opening — 18px side padding, 32px above the Books — lit from above. The
light is a gradient falling down the back panel and dying by the halfway point;
the depth is read from the shadowed head and jambs, and the jambs are 9px of
darkness fading inward rather than a drawn edge. **No visible fitting.**

### E — Monolith
One substantial **24px** ledge, a shadowed recess, 4px of side padding and no
frame at all. The silhouette does the work.

## The constraints all five keep

- Life OS dark graphite. One highlight, one shadow.
- **No `url()` anywhere** — no photographic texture, asserted by test.
- No wood, no moulding, no ornament, no fantasy.
- Scroll-first browsing preserved; the rail overflows and scrolls at 40 Books.
- One Book baseline per bay, at every width.
- Small and large collections both work: 3 Books left-align on an otherwise
  empty shelf without stretching; 40 Books scroll.

## What is still open

Whether any of these is *distinctive enough*. The honest position after L3.4 was
that C2's shelf read as "dark space plus a line". A and D answer that with
construction, B and E with mass, C with structure. None has been chosen, and the
lab does not mark a preference.

See [the component lab](library-v2-l3-component-lab.md).
