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

---

## L3 — the shelf, narrower

The shelf does not collapse into a list, and the objects get **bigger** as the
screen gets smaller. That is the opposite of what a squeezed desktop layout does,
and it is the reason a phone Library reads as designed rather than as left over.

| Width | Book cover | What changes |
|---|---|---|
| desktop | 128px | full treatment, 7° turn on the prominent object |
| ≤1024px | 124px | **the 3D turn is dropped** — under a finger, turning the item you touched is noise |
| ≤820px | 132px | rails bleed edge to edge, arrows removed, overflow menu always visible |
| ≤480px | 128px | tighter shelf gaps, composer clearance, safe-area aware |

### Measured, full sample, unscrolled

| Viewport | rail | resting book | books in view | clipped cover titles | horizontal page scroll |
|---|---|---|---|---|---|
| 1440×900 | 1085 | 128×181 | 6 | 0 | 0 |
| 1024×768 | 701 | 124×176 | 3 | 0 | 0 |
| 768×1024 | 739 | 132×186 | 4 | 0 | 0 |
| 390×844 | 376 | 132×186 | 2 | 0 | 0 |
| 375×667 | 361 | 140×181 | 2 | 0 | 0 |

At 375×667 scrolled to the bottom, the last shelf clears the fixed composer by
**173px**.

### The edge-to-edge bleed

Below 820px the rails are pulled out to the screen edges with `margin-inline:
-16px` — `.main-wrap`'s own padding at that breakpoint, cancelled and then
reapplied to the heading and the row so that only the **scrolling** part
bleeds.

That is not decoration. A shelf that stops at a margin looks finished; a shelf
that runs off the edge of the screen tells you there is more to the right
without an arrow having to say so.

### Touch targets

The overflow menu stays 30px of ink and gains a **44px hit area** through a
`::before`. A control sized to its ink on a 132px cover would take a third of
the cover; a control measured by its ink is measured wrong. Verified with
`elementFromPoint` at ±20px in all four directions.

> **A measurement note.** The `.lib-rail` is deliberately 4px wider than its
> section on each side, so an overflow check written against its parent reports
> overflow on every shelf, always. Check `document.documentElement.scrollWidth`
> instead — that is the number that means something.

---

## L3.1 — overlap and touch

What varies by width is now the **overlap** rather than a depth effect:

| Width | cover | spine | overlap | visible per book |
|---|---|---|---|---|
| desktop | 126px | 24px | 64px | 86px |
| ≤1024px | 124px | 24px | 60px | 88px |
| ≤820px | 132px | 22px | **44px** | 110px |
| ≤480px | 128px | 22px | 40px | 110px |

Books sit further apart under a finger, because a book you have to hit exactly
is a book you miss.

**Hover is switched off entirely below 820px.** There is no hover on a finger,
and a state only a mouse can reach must never be on the path to anything. The
Open control grows there too, because on a phone it is the primary route rather
than a convenience.

The open view stacks to one column below 820px, with the object centred above
what is known about it.
