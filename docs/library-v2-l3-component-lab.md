# Library — the component lab

**Route:** `#library/lab` → **Components**. Staging only.
**Nothing here is integrated.** The real Library is untouched by this phase.

---

## Why one decision at a time

L3.3 compared six whole Libraries and produced a direction: Concept C. L3.4
refined it into C2, and C2 produced a narrower question than the one it was
asked — *the resting shelf is right, several specific things standing on it are
not.*

Comparing whole Libraries again would answer that badly. A full concept changes
eight things at once, so when you dislike one you cannot tell which. So the lab
now holds one decision per page, with four to six genuinely different treatments
of it, and **everything not under comparison held identical**: same Books, same
order, same sizes, same positions, same bay, same scroll, same selected Book.

The output is a set of choices — one per category — which a later phase
combines.

## The pages

| | Options | The decision |
|---|---|---|
| **Resting Books** | 4 | How much physical detail a spine carries |
| **Pulled Book** | 5 | What "selected" looks like |
| **Shelf** | 5 | What kind of furniture this is |
| **Documents** | 5 | What a Document *is* as an object |
| **Media** | 5 | How images and video are kept |
| **Links** | 4 | What a saved link is |
| **Files** | 4 | What a stored file is |
| **One room or five?** | — | Whether each kind gets its own structure (§27) |

Plus the row-size picker (9 / 20 / 40 Books) on the Book pages, and an optional
side-by-side toggle everywhere.

## What is held identical

- **Shelf positions.** Measured across all five architectures: every slot's
  offset and width is byte-identical. Every layer (wall, uprights, ledge) exists
  in every variant; a variant that wants no uprights hides them rather than the
  markup changing shape.
- **Scroll.** Switching a variant restores each rail's `scrollLeft`. Measured:
  57px before, 57px after.
- **The selected Book.** Held as an **id**, not an element, so switching from
  pulled-A to pulled-C shows you the *same Book* in the new treatment. Measured:
  `b6` before, `b6` after.
- **Clicking the lab's own controls does not close the Book.** Switching a
  variant is a question about the Book you are looking at; closing it there
  answers by taking the subject away. Only clicking the shelf itself puts a Book
  back.

## Side by side

Optional, and never the only way to compare. Two panels, two treatments, the
**same Book turned in both** — measured: two `is-out` volumes, both `b5`, in
treatments A and B. At 1280 the columns are 454.5px each; below 1100px the grid
collapses to one column rather than squeezing, because two half-visible shelves
are worse than one whole one.

## Known limitations

- **Desktop first.** 1440 / 1280 / 1024 / 768 are all verified for hit accuracy,
  baseline and overflow. 768 is *viability*, not a designed mobile layout. The
  likely mobile direction is one bay at a time with the variant tabs collapsed
  into a select — not attempted here.
- **The lab is still disposable.** Sixteen files in
  `web/modules/library-lab/`, removable in one move; a test asserts the
  inventory and that nothing outside the folder imports any of it.
- **The six frozen concepts still ship to staging.** A, B, D, E and F get no
  further work but still cost download. They should go when the components are
  chosen.
- **`Open` routes to the real Library.** The lab owns no Book view.

See [Book physics](library-v2-l3-book-physics.md),
[shelf options](library-v2-l3-shelf-options.md),
[the resource grammar](library-v2-resource-grammar.md),
[the cover system](library-v2-cover-system.md).
