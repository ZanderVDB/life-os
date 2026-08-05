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
