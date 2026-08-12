# Library L3 — the spatial design

> **A SHELF IS A SCROLLABLE COLLECTION. IT IS NOT A CAROUSEL.**

That is the rule. Every decision below follows from it, and most of what the
tests assert is the *absence* of carousel machinery rather than the presence of
shelf machinery — because carousels are what shelves turn into, one convenience
at a time, and each convenience looks reasonable on its own.

---

## Why a shelf rather than a better grid

The old Library was a grid of cards. It was not broken; it answered "what do I
have". A shelf also answers **"where is it"** — you remember a position on a
shelf in a way you never remember a cell in a grid that reflows every time the
window changes. That memory is the whole product argument for this phase, and
it is why shelf scroll positions are restored (§16/§18) rather than treated as
transient.

## What the room is made of

Three things, and no more:

| | |
|---|---|
| a ledge | one hairline, drawn as a **background on the rail** |
| a floor shadow | a wash below the ledge where the objects sit |
| depth | one gutter shadow per object where the cover meets the spine |

No wood, no furniture, no wallpaper, no bevels. In a dark UI those read as
decoration rather than as structure, and §20 asks for structure.

The ledge is a background rather than an element because it belongs to the
**shelf**, not to the books. A background on a scroll container stays put while
the content scrolls, which is exactly what a shelf does — the books move, the
shelf does not. An element would have had to be as wide as `scrollWidth` and
would have travelled with them.

## The book object

    ┌──┬──────────────┐
    │  │  Life OS     │   spine  13px, narrowing to 9px when prominent
    │  │  NOTEBOOK    │   cover  128px wide, 210:297, the approved identity
    │  │  Atlas       │
    │  │  ─────       │
    │  │  ZANDER·2026 │
    └──┴──────────────┘

Measured at 1280×900: object 141×181, cover 128×181, ratio **1.414** against
297/210 = 1.414.

The cover carries the same marks in the same order as the Book that opens —
mark, pre-title, title, rule, author. §8 requires the object you press to
correspond to the cover it becomes, and the accent is the **book's own**: the
API now sends the first section's accent, so the colour on the shelf is the
colour inside. Deriving one from the id would have been stable and arbitrary,
and would have disagreed with the book itself.

The spine is a **drawn gradient strip**, not a rotated face. Its title is
`aria-hidden`, small and decorative; the cover already carries the accessible
name and a screen reader should hear a book once.

### Why the shelf is not drawn in 3D

Twelve `preserve-3d` subtrees with rotated glyphs is a lot of compositing for
something that has to stay smooth while it scrolls, and rotated text is exactly
where type stops being crisp. So:

- `perspective` sits on the **slot**, giving each object its own small stacking
  context instead of one enormous one;
- only `.is-prominent` actually rotates, at **7 degrees**.

Measured: 6 rotated elements out of 45 objects — one per shelf, ever.

Seven degrees, not twenty-five. Past about ten the type degrades and the shelf
starts being a diorama. §6 says prefer usability over spectacle, and this is
where that is spent.

## The five states (superseded by L3.1)

> **Corrected in L3.1.** The `prominent` state below was given to whichever
> object was nearest a read line as the shelf scrolled, and it was wrong: a
> shelf nobody had touched had one book permanently raised. It is replaced by
> an explicit **pulled-forward** state that only a user action can cause.
> The current model is `library-v2-interaction-model.md`; the section below is
> kept because the read-line arithmetic and its defect are still worth knowing.

## The five states (§23)

Five distinct **mechanisms**, not five shades of one:

| State | Owns | Never |
|---|---|---|
| default | resting | — |
| hover | surface + `translateY(-4px)` | changes fill |
| focus | a 2px **accent** outline, `:focus-visible` only | uses the group colour |
| **prominent** | lift + `scale(1.045)` + `rotateY(-7deg)`, fuller shadow, narrower spine | means "selected" |
| open | the handoff — rises, fades, and is destroyed | survives the transition |

**Prominence is not selection.** Nothing is chosen by scrolling past it, nothing
is committed, and the route never changes because a shelf moved. It is the shelf
saying *this is the one under your attention*, which is what makes the objects
around it feel like they are beside something rather than merely next to each
other.

### The read line, and the defect that shaped it

Prominence goes to the object nearest a **read line**, and the read line travels
with the scroll.

A fixed line does not work, and it fails at the moment that matters most.
Pinned a third of the way in, a Books shelf sitting at rest reported prominent
index **1**: the first book was 185px from the line and the second was 26px.
Since a rail cannot scroll left of zero, **book one could never become prominent
at all** — and the mirrored failure happened at the far end.

The line now runs from the left edge to the right edge as the shelf runs from
its start to its end. Re-measured on the same shelf: index 0 at rest, index 10
of 11 at the end, monotonic in between.

## Scrolling that cannot become a trap (§21)

The rail is a plain `overflow-x: auto` element. It scrolls before any of the
JavaScript has run and keeps scrolling if that JavaScript fails. Everything else
is enhancement.

Wheel-to-horizontal translation exists, with **two release rules** that are the
difference between browsing and scroll-jacking:

1. **Release at the ends.** When the rail cannot consume more movement in the
   direction asked for, the event is *not* cancelled and the page scrolls. This
   is what stops a shelf swallowing a page.
2. **Latch out during a flick.** Once the page has started moving past a shelf,
   that shelf refuses to capture again until the wheel has been still for 220ms.
   Without this, a fast scroll down the page is caught by each shelf in turn and
   the page appears stuck.

Horizontal intent is never touched — a trackpad sending `deltaX` is already
doing the right thing. `ctrlKey` is left alone, because browser zoom is not
browsing. `deltaMode` 1 and 2 are lines and pages, so a raw delta is normalised
rather than used as pixels.

Snap is **proximity, never mandatory**: mandatory snap fights trackpad momentum
and turns a flick into an argument.

## The arrows are secondary (§7)

They appear only when a shelf actually overflows, they disable at each end
rather than looping, they are never a tab stop, and on touch they are removed
entirely. The keyboard already has a better route, and an arrow that wraps a
shelf around is a carousel wearing arrows.

## The non-Book family (§10)

Related, not identical. They share the shelf, the ledge, the five states and the
type scale — which is what makes them one Library — and they do **not** share a
spine, because a spine on a JPEG is a lie about what the thing is.

| | |
|---|---|
| Document | a folio on paper stock, with an excerpt |
| Image | a frame, aspect-safe, with a drawn floor |
| Video | the same frame plus a duration badge and a play mark |
| Link | a clipping with a sage edge and its domain |
| File | a slab with its kind and its size |

### One dead URL cannot break the composition (§28)

The fallback is the **floor** and the image sits on top of it, so an image that
fails leaves a frame rather than a hole. `loading="lazy"` and `decoding="async"`
keep forty thumbnails from blocking the first paint.

Measured against the deliberately-broken sample row (`https://never.invalid/…`,
a reserved TLD that can never resolve, so the failure path is tested without
pointing a load at somebody else's server): after the load failed, the frame,
the object, the rail's `scrollWidth` and **all nine siblings** were unchanged to
the tenth of a pixel.

## Composition (§11)

Only shelves that have something on them are drawn. Four empty category headings
is a filing cabinet showing you its dividers.

    Recently opened     3–6, and only above a Library of 8
    Personal            the Diary ledge
    Books
    Documents
    Media               images + videos
    Links & Files

Media and Clippings deliberately group two types each. Six shelves for six types
would be a taxonomy; four is a room. And a Library with two videos does not get
a shelf of its own with two videos on it.

**Small collections are centred** (§26) with one rule — `justify-content: center`
on a row that is not overflowing. `justify-content` does nothing until there is
slack, so the rule is inert the moment the shelf fills, and nothing has to be
measured. Verified with three books at 1280: `is-full` false, first slot at
x=509 in a rail starting at x=272.

**An empty Library** (§25) shows the personal ledge and **one** faint blank
ledge — enough that the room is still legible as a room, without showing you the
size of the gap.

## The Diary ledge (§19/§30, treatment B)

Its own small **Personal** shelf above the Books, labelled *"Part of Life OS,
not a Library item"*.

It looks like a Book because it *is* one to the person reading it. It behaves
like nothing else on the shelf because it is not a Library item:

- no `library_items` row, and no `data-item` attribute for anything to look up;
- no overflow menu, so no rename, no archive, no delete;
- absent from search **by construction** — the result surface is built from
  `lib.items`, the server's Library list, which it is not in;
- opening it calls `ctx.goRoute('diary')`, because leaving Library is the
  **shell's** job. Writing `#diary` from a shelf would change the URL without
  telling the shell: sidebar still on Library, pending Library writes unflushed.

It carries a visible system mark, so the difference is on screen and not only in
the code — colour alone would be a colour-only distinction, which §36 forbids.

## Coming back (§16/§18)

The shelf position is **captured at the moment of leaving**, not trusted to the
scroll listener. A position remembered only by having observed every scroll
event is wrong whenever an event was missed — and events *are* missed when the
page is not rendering, which is exactly when a Book is taking over the screen.

`captureShelfScroll()` runs on three paths: opening an object, leaving Library
for another section, and the top of every repaint (so a filter change keeps its
place, §14).

On return: **position first, then identify.** The scroll is restored by
assignment — a smooth scroll from 0 would animate the very thing the restoration
exists to avoid noticing — and only then is the object you came from marked.

The shelf id travels with the item id, because the same Book can be on Books
*and* on Recently opened, and lighting up the wrong copy is worse than lighting
up none.

## Recently opened, and the column that made it honest (§12)

`updated_at` is an **edit** time. It moves when a page autosaves or a title is
renamed, and stays still while you read for an hour. Using it to *order* a
recent list is a reasonable fallback; using it to say **"opened"** is the
invented behavioural data §12 forbids.

So L3 adds one nullable column, `library_items.last_opened_at`:

- **not backfilled** — NULL means "not opened since L3", and inventing an
  opening from an edit time is the thing being avoided;
- written by a fire-and-forget `POST …/opened` that **never touches
  `updated_at`**, so reading and editing stay two different facts;
- and where the fallback is in use, the object says **"Edited"** rather than
  **"Opened"**, which is what actually happened.

---

# L3.1 corrections

L3's concept was approved and its execution was not. What changed:

| L3 | L3.1 |
|---|---|
| a raised object chosen by scroll position | **nothing raised until a user raises it** |
| a 1400ms accent ring after returning | a **320ms glow** in the object's own accent |
| a title at the far left of the shelf | the title **under the pulled object** |
| a star mark on the Diary | **no mark that looks like a control** |
| 13px spine, whole title crammed in | **24px spine**, title cut at a word, accent bands |
| books spaced like cards | books **overlap** — 10 across a shelf instead of 6 |
| a 7' rotation on the prominent object | **no rotation at all** — crispness outranks novelty |
| Documents as rounded rectangles | Documents as **folios**: a stack of sheets in a tabbed jacket |
| Diary looked like a Book, behaved like a poster | Diary has the **same interaction** as everything else |
| the item view as a card in the corner | a **composed** two-column open view |

## The shelf, strengthened

Three drawn layers on the rail, and one shadow per object:

1. a **back plane** one shade lighter than the page, that books stand in front of;
2. the **ledge front edge** — a 3px band lit along its top, which is the part
   the eye reads as "a surface with thickness";
3. a **floor wash** below it, where the shadow gathers;
4. a **contact shadow** under each object, which shrinks and softens as it lifts.

The contact shadow is the single cheapest thing that makes an object look like
it is *resting on* rather than *floating above*. Still no wood, no grain, no
furniture.

## Density: books overlap

`--overlap: 64px`, declared on the **shelf**, applied as a negative margin
between slots. At rest each book shows its 24px spine plus 62px of cover — which
is what a shelf actually looks like. Pulling one forward raises it above its
neighbours on z-index and the whole cover appears; nothing grows and nothing
reflows.

Measured at 1280 with the full sample: step per book **150px → 86px**, rail
scrollWidth **1739 → 1030**, books visible across a 933px shelf **6 → 10**.

> `--overlap` must be declared where the SLOT can inherit it, not on
> `.lib-book`. A custom property inherits downward only, and the element that
> consumes it is the book's parent. Declared on the book it resolved to nothing
> and every shelf measured 0px of overlap while looking correct in the source.

## The spine, redesigned

24px rather than 13, 10px type rather than 8.5, a title cut at a word boundary
with an ellipsis rather than crammed, and two accent bands at head and tail the
way a bound spine has. The lit edge runs across the spine and falls away toward
the cover, and the gutter shadow is drawn on the **cover** — so the junction reads
as a fold rather than a seam between two separate things.

Measured: spine 24px, cover 126px, both **178.2px tall**, gap between them
**0.00px**, 0 clipped spine titles across the sample shelf.

## Crispness

All rotation and all `perspective` are gone. A 7-degree `rotateY` puts glyphs on
a plane that no longer aligns with the pixel grid, and at 15px Playfair that is
visible — which is what the review meant by "slightly blurred". Depth is now
overlap, translation, scale, z-index and shadow, none of which resamples text.

---

## L3.4 — the direction changed

The shelf described above is the **real** Library's, and it is unchanged. But
the visual direction chosen in L3.3 was Concept C, and L3.4 refined it into C2
in the lab. Where C2 disagrees with this document, C2 is the direction and this
document is the current shipped state.

The three substantive disagreements:

- **The spine-to-cover change is a turn, not an in-place widen.** One box, three
  faces, hinged at the spine's outer edge.
- **Neighbours make room by layout**, not by transform: the slot widens and the
  row reflows. Measured at 1280 — a 53px Book widened its slot to 136px and the
  Books to its right moved exactly +83px.
- **Thickness comes from page count**, by square root, clamped to 26-58px. It is
  no longer decorative.

What survives unchanged into C2: one baseline per shelf (measured at 505.03px
across all four bays), no scaling of live type, spine-on resting, and depth
expressed as translation and shadow rather than as blur.

See [the C2 direction](library-v2-l3-c2-direction.md).
