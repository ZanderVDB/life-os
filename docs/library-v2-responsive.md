# Library — responsive foundation (Phase F1)

The dedicated mobile design is a later phase. F1's obligation is that the Book
is not desktop-only, and that its identity survives a narrow screen.

Legacy's own breakpoints, from the audit:

| Width | Legacy behaviour |
|---|---|
| ≥900px | `.nb-book` max-width 820px, 48px arrows |
| ≤900px | max-width 560px, page padding 22/22/16/50, ruled lines 28px |
| ≤700px | cover title 42px, padding 32/24 |

Spread is force-reverted to single below the wide breakpoint — the two-page
spread is never squeezed onto a phone.

## The rule

**Desktop** — two-page spread, arrows outside the book.

**Tablet** — spread where the width genuinely allows it; otherwise a deliberate
single page. Not a squeezed spread.

**Mobile** — one page at a time. The cover scales rather than cropping. Section
tabs scroll horizontally, which is what Legacy already does and why its tab strip
is `flex-wrap: nowrap`. Page controls stay reachable without scrolling. Touch
targets ≥44px — Legacy's arrows are already 44px, which is the floor rather than
a coincidence.

**The mobile Book may work differently while remaining the same object.** A
phone showing one ruled page with a coloured edge and a section tab above it is
recognisably the same book as the desktop spread. A phone showing two 160px-wide
pages is not a book, it is a diagram of one.

## What must never happen

- horizontal page overflow;
- a browser scrollbar inside a page;
- the spread persisting below its breakpoint;
- controls that require a pinch to hit.

## Status

The schema, API and document model are width-independent and complete. The
responsive **rules** are recorded here and the Legacy breakpoints are carried
forward; the client that implements them is the next step, and the dedicated
mobile refinement remains a later phase.
