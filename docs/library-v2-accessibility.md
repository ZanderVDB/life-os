# Library — accessibility

Written for L3, because a spatial redesign is where accessibility is most often
lost: depth, prominence and horizontal browsing are all easy to build as things
that only work with a pointer and only mean anything to an eye.

## The shelf regions

Each shelf is `role="group"` with `aria-labelledby` pointing at its own heading.

`group`, not a landmark. A Library with six landmarks is a Library whose
landmark list is useless — the point of a landmark list is to be short enough to
skim.

Verified: six shelves, six labelled regions, every label resolving to real text
(*Recently opened, Personal, Books, Documents, Media, Links & Files*).

## One tab stop per shelf

Objects use a **roving tabindex**: the prominent one is `tabindex="0"` and every
other is `-1`. Tab lands on the object the shelf is about; arrows move along it.

Measured: **45 objects, 6 tab stops.** Forty books must not be forty tab stops —
that is a shelf you have to tab past rather than one you can use.

| Key | Does |
|---|---|
| `←` `→` | previous / next object, moving prominence with focus |
| `Home` `End` | first / last object |
| `Enter` `Space` | open |

Focus and prominence are kept together deliberately: tabbing into a shelf and
then scrolling it must not leave the outline behind on something that has left
the screen.

The arrow buttons are **not** in the keyboard path — `tabindex="-1"`, their
container `aria-hidden`, and `display:none` entirely on touch. They exist for a
mouse without a horizontal wheel. The keyboard has a better route and does not
need a worse one offered to it.

## Accessible names carry the type and the place

    "Atlas, Book, 3 of 12"
    "Backup archive, File, 1 of 6"
    "Systems That Survive Contact With A Tuesday. Notes on routines…, Book, 2 of 12, archived"

Position is in the **name** rather than in `aria-posinset`. Those attributes need
list semantics the objects do not have (they are buttons, because "open" is the
action), and a name is announced everywhere without depending on how a given
screen reader treats a given role.

The Diary object deliberately breaks the pattern — *"My Diary, opens Diary"*. It
is alone on its ledge, so "1 of 1" would be noise, and what is worth announcing
about it is that it leaves Library.

The **full title always survives**, however hard the cover clamps it: `title` on
the object, and the caption under the shelf shows the prominent object's title
unclamped (§24). A cover clamps to four lines; a long title is still readable
without hovering.

## Nothing requires hover

- The overflow menu is hover-revealed on a pointer and **always visible on
  touch**, where there is no hover to reveal it with.
- Its hit area is **44px** even though the drawn control is 30px — `::before`
  extends what a finger hits. A target measured by its ink is measured wrong.
- Opening an object needs a click, `Enter` or `Space`. Prominence is never
  required for anything: you can open any object on the shelf, prominent or not.

Verified at 390px: `elementFromPoint` hits the control at ±20px in all four
directions.

## No state is colour alone

| | |
|---|---|
| prominent | position, scale and shadow — not a tint |
| archived | a drawn **"Archived"** flag, not only reduced opacity |
| the system Book | a **mark**, not merely a different cover colour |
| focus | an outline, in the app accent, distinct from every group colour |

## Reduced motion

`prefers-reduced-motion: reduce` removes **travel, not information**:

- every transform is dropped — hover, prominence, the open handoff;
- prominence survives as a **ring** on the cover, because the state still has to
  be distinguishable;
- the return highlight simply does not play;
- shelves still scroll, and every key still works.

Nothing in the shelf was ever *only* movement, which is why turning the movement
off costs nothing.

## DOM order follows shelf order

The perspective transforms are visual only. Objects appear in the DOM in the
same order they appear on the shelf, so screen-reader order and visual order
cannot disagree — which is the specific risk §36 names about 3D.

## Known gap

The on-screen-keyboard case on a real phone is still verified by geometry rather
than with a real keyboard: the harness browser has none. Recorded in
`technical-debt.md`.
