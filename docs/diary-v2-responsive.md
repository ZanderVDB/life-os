# Diary — responsive (Phase D1)

Diary is first-class on a phone. It is where writing is most likely to happen
away from a desk, and a squeezed desktop layout would make that the worst place
to use it.

## The writing surface

One sheet at every width — there was never a spread to collapse. The sheet is
`max-width: 760px` and centred; below 820px it loses its outer padding rather
than its content.

| Width | What changes |
|---|---|
| ≥1080px | history is a two-column grid: calendar and recent side by side |
| <1080px | history stacks to one column |
| <820px | sheet padding 24/22, date heading 25px, the toolbar becomes **sticky** at the top of the sheet, date-navigation steps grow to 44px, calendar cells to 44px, the date picker goes full width |
| <480px | sheet padding 20/16, heading 22px, context fields stack to one column, the two navigation groups share the row evenly |

## Measured at 390px

| | |
|---|---|
| horizontal overflow | 0 |
| sheet / editor width | 336 / 304px |
| navigation steps | 44 × 44 |
| calendar cells | 44 × 44 |
| toolbar | `position: sticky` |
| composer clearance at the bottom of a long entry | 84px |
| save status reachable with the page scrolled | yes |

## The toolbar is sticky, deliberately

On a phone the formatting controls are at the top of the sheet and the caret is
usually below the fold. A toolbar that scrolls away is a toolbar you have to
scroll back to, having lost your place. Sticky keeps it one tap away, and it
carries the sheet's own background so text never shows through it.

## The keyboard

The editor is a normal contenteditable inside the page flow, so the browser
scrolls the caret into view when the keyboard opens. The global composer is
`position: fixed`; the page scrolls clear of it, and the entry footer — which
carries the save status — sits above it with room to spare.

## Known limitation

Date navigation while the on-screen keyboard is open was verified by geometry
rather than with a real keyboard: the harness browser has none. The controls
stay in the layout and remain hit-testable, but the behaviour of a real iOS or
Android keyboard resizing the visual viewport mid-edit is untested. Recorded in
`technical-debt.md`.

---

# D2.2 — the spread's height

The D2 change over-corrected. `aspect-ratio` became a minimum by way of

    min-height: calc((100vw - 460px) * 297 / 420)

which reads the **window** to size an element inside a column. It was wrong at
every width where the rail or the drawer changed that column, and combined with
five always-open prompt fields it put an empty spread far below the fold.

## The rule

    height = max(approvedBaseHeight, leftRequired, rightRequired)

All three terms are **layout**. No element is measured, no inline height is
written, and nothing animates the result — so there is no stale height to clear,
nothing to settle under a throttled timeline, and the shrink when writing is
deleted is simply the grid re-solving.

| Term | How it is expressed |
|---|---|
| `approvedBaseHeight` | a zero-content `::before` spanning both columns at `aspect-ratio: 420/297` — exactly the open Library Book's height at the same width, with no arithmetic |
| `leftRequired`, `rightRequired` | the natural height of each page's content |
| both pages equal | `align-items: stretch`, so the gutter, the edges and the margin stripes extend together |

The ruled writing area is `flex: 1 0 auto`, so it absorbs the slack: on a light
day it renders around 155px even though its floor is 120px, and the spread rests
on the base. **The floor is deliberately well below the height it renders at** —
a floor tall enough to bind is a floor that pushes the spread past the base,
which is exactly what the old 180px did.

## What does not count as content

Empty prompts beyond their compact resting size, hidden progressive-disclosure
content, placeholder text and inactive rows. All of them are satisfied by
construction: prompts past the third are **absent from the DOM**, not merely
`display:none`, and a closed Moment tile has no input inside it.

## Measured at 1280 × 720

| | |
|---|---|
| base (`width × 297/420`) | 569 |
| blank day | **569** — exactly the base |
| 20 paragraphs | 1021, both pages equal |
| deleted again | **569** |
| four Moment tiles open | 631 |
| tiles closed | **569** |
| inline `style` on `.dia-book` | none, at every step |

## Prompt density

Three prompts rest open; the other two are one press away. Five empty fields
cost 411px — more than the free writing above them. A prompt that already holds
an answer is never hidden, so an answer below the fold forces the whole set
open: collapsing something somebody wrote out of sight is how they lose track of
having written it.

The empty resting height is 40px, the top of the 36–40px the phase asked for.

---

# D2.4 — the right page sizes itself against its own width

## The container query is keyed on the page, not the window

    .dia-right { container-type: inline-size; container-name: diapage }

    @container diapage (max-width: 264px) {
      .dia-rhythm { grid-template-columns: minmax(0, 1fr); row-gap: 3px }
    }

The window is the wrong thing to ask. The right page's width depends on the
sidebar, the drawer and the spread's own column split, so the same 1024px window
can give it 220px or 290px. A media query would have to guess which; a container
query measures it.

Under the breakpoint the Daily Rhythm label moves **above** its options rather
than the options getting narrower, so the four chips get the full page width at
the width where they need it most.

## The `auto-fit` minimums, and what they cost when wrong

| | minimum | why that number |
|---|---|---|
| core rows | `52px` | five chips × 52 + four gaps = 276, inside the 286px option track at a 310px page |
| rhythm rows | `42px` | four × 42 + three gaps = 180, inside the 183.4px option track — 44px needed 188 and wrapped every row |

A minimum that does not fit does not clip, it **wraps**, and a wrapped row costs
the page a whole extra line. The rhythm at 44px cost 130px and put a blank spread
past the composer; see `diary-v2-daily-checkin.md` for the measured table.

## Measured, blank day, page unscrolled

| Viewport | right page | rhythm cols | lines per row | spread | clearance |
|---|---|---|---|---|---|
| 1440×900 | 476 | `91 / 259` | 1 | 685 | +15 |
| 1280×900 | 310 | `91 / 183` | 1 | 685 | +15 |
| 1024×768 | 290 | stacked, `193.5` | 1 | — | scrolls |

At 1024 the **core** rows wrap to two lines by design — five 52px chips do not
fit a 266px track, and §9's rule is compact rows rather than a permanently taller
Diary. Nothing truncates there, no chip escapes its group, and both the right
page and the document report zero horizontal scroll.

> A measurement note worth keeping: `display: contents` elements return a **zero**
> `getBoundingClientRect()`, so an overflow check written against a chip row's
> immediate parent (`.dia-rh-row`) reports overflow for every row, always. Check
> against `.dia-rhythm`, or against the group box, and check `scrollWidth` too.
