# Legacy Notebook — book audit (Phase F1)

Read from source, not from screenshots: `index.html` in the repo root, 19,114
lines, single file. Legacy was **not modified**. **No Legacy data was read.**

The purpose is to carry the *design* across and to be precise about which of the
implementation can come with it.

---

## 1. Structure

```
.nb-tabs                       section tabs, above the book
.nb-book-wrap                  [arrow] [book] [arrow], centred
  .nb-arrow                    44px circle (48px ≥900px), OUTSIDE the book
  .nb-book                     the object itself
    .nb-page                   left page
    .nb-page.right-page        right page, spread only
      .nb-page-hdr             section name + page meta + icon buttons
      .nb-cells                grid: single | half | quad
        .nb-cell
          .nb-cell-ta          contenteditable, the ruled writing surface
```

Cover is not a separate component: it is a `.nb-page.nb-cover-page` holding
`.nb-cover`, swapped into the same slot.

## 2. Geometry and proportion — the identity

| | |
|---|---|
| `.nb-book` | `aspect-ratio: 210/297` (A4), `max-width: 780px` (820 ≥900px) |
| `.nb-book.spread` | `aspect-ratio: 420/297`, `max-width: 1320px` |
| `.nb-page` | `border-radius: 14px`, `padding: 28px 32px 18px 58px` |
| gap between pages | `6px` — the gutter is a gap, not a drawn spine |
| `perspective` | `1600px` on `.nb-book` (declared; the flip never uses 3D) |

The tall A4 ratio, the deep left padding and the 6px gutter *are* the book. Lose
any of them and it becomes a card.

## 3. The page surface

**Margin stripe.** `.nb-page::before` — `left: 46px`, `width: 1px`,
`opacity: .55`. Mirrored to `right: 46px` on the right page.

**Coloured outer edge.** `box-shadow: var(--shadow-lift), inset 3px 0 0 0
<section colour>` — mirrored to `inset -3px` on the right page. This is what
makes the section legible at a glance in a spread whose two pages may come from
different sections.

**Ruled lines.** On the *textarea*, not the page:

```css
background-image: repeating-linear-gradient(to bottom,
  transparent 0, transparent 29px, var(--paper-line) 29px, var(--paper-line) 30px);
background-attachment: local;
line-height: 30px;
```

The repeat cycle equals the line-height exactly, and `local` makes the rules
scroll with the text. Legacy's own comment records why it moved here: on the
page, the lines drifted once a header sat above them and text floated between
rules. **Carry this technique verbatim.**

**Type.** `Kalam` (handwriting) for writing, falling back to Playfair. Headers
and the cover are `Playfair Display`. UI chrome is `Inter`.

## 4. Section tabs

`border-radius: 20px 20px 4px 4px` — round at the top, square at the bottom, so
they read as tabs rising out of the book. Playfair, 12px, 600. The strip is
`flex-wrap: nowrap` with `overflow-x: auto` and a dashed bottom border;
deliberately never wraps to a second row.

Six colours: `peach, sage, lavender, gold, blue, rose`. Each drives three things
— the tab background, the page's inset edge, and the margin rule at 0.35 opacity.

## 5. Cover

`.nb-cover`, centred column: flourish, small-caps pre-title (Inter, 11px,
`letter-spacing: .32em`), **Playfair 64px title**, italic subtitle, a 140px ×
1px rule with 32px margins, an uppercase author line, and a hint pinned to the
bottom with `margin-top: auto`.

At spread width the title drops to 46px; on mobile to 42px.

Note: in Legacy the cover is an **empty state** — shown when no sections exist —
plus a `NB.cover` counter (0/1/2) for the opening flip. It is not a durable
property of the book.

## 6. Page turn

```css
@keyframes nbFlipLeft  { to { transform: translateX(-14%); opacity: 0 } }
@keyframes nbEnterLeft { from{ transform: translateX(14%);  opacity: 0 } }
```

`0.26s cubic-bezier(.4,0,.2,1)`, both pages animating together in spread so it
reads as one motion. **No 3D curl** — `perspective` is declared and unused. The
brief's preferred approach is what Legacy already does.

## 7. What can be reused

- the geometry: aspect ratios, max-widths, padding, the 6px gutter;
- the ruled-line gradient and its `background-attachment: local`;
- the coloured inset edge and the mirrored right page;
- the tab shape and the six colour tokens;
- the cover composition and its type scale;
- the flip keyframes, timing and easing;
- the arrow geometry outside the book.

That is the design, and it is nearly all CSS.

## 8. What must be rewritten, and why

**Every line of the JavaScript.** Not a style preference — six specific reasons:

1. **`nbSwapBook` does `book.innerHTML = html`.** Every render destroys and
   recreates the contenteditable. Selection, focus, undo history and any
   in-flight IME composition die with it. Legacy works around this by capturing
   `document.activeElement` before the swap and re-focusing after, which cannot
   restore a caret position. §21 forbids this outright.

2. **Autosave is `setTimeout(() => svAll(), 1200)`.** `svAll()` writes the
   *entire application state*. There is no per-page write, no request ordering,
   no failure path, no status, and no flush on navigation. This is precisely the
   defect class E2.4 spent a phase removing from Tasks, and §16 says not to
   repeat it in Library.

3. **The flip is `setTimeout(…, 220)` then swap.** Any render arriving inside
   that window swaps content the animation is still using.

4. **Formatting uses `execCommand`.** Legacy's own comment records the symptom:
   it leaves `<font color="black">` wrappers that made text vanish on the dark
   theme, worked around with `!important`. Deprecated, and it produces markup
   nobody chose.

5. **Content is raw HTML strings with no sanitisation**, written straight into
   `innerHTML`. Acceptable in a single-user local app; not a foundation.

6. **Global mutable `NB` + `S.notebook`, `document.getElementById`, inline
   `on*` attributes.** Not portable into a module system, and untestable.

## 9. Defects not to copy

- the cover as an empty state rather than a real property of a book;
- `page.cells[]` as a fixed array indexed by layout — layout and content are
  entangled, so changing layout can strand text;
- search that strips HTML on every keystroke across every page (fine at
  Legacy's scale, not a pattern to inherit);
- `nbAddPageAfter` reachable from rapid clicks with no guard;
- the mobile bars rendered as a separate DOM tree with duplicated actions.

## 10. Data-model assumptions

Legacy: `S.notebook.sections[] → pages[] → cells[]`, in one client-side blob,
with `id` and `updatedAt` per page and no server model at all. v2 needs real
tables; the audit's contribution is the *shape* — a book has ordered sections,
a section has ordered pages — and the warning that `cells` should not survive
into it.

---

## Conclusion

**Take the CSS, leave the JavaScript.** The identity of the Legacy book is
almost entirely in its geometry, its ruled paper and its type; the behaviour
underneath it is a decade of single-file accretion with two defects (destructive
re-render, whole-state autosave) that v2 has already paid to fix elsewhere.

---

## What F2 actually carried over — 2026-08-05

Every geometric value in this document is in `web/index.html` and is asserted by
`api/tests/library-f2.test.ts`, so it cannot be quietly rounded off. Measured in
a browser at 1440px: ratio `1.414`, max-width `1320px`, gutter `6px`, padding
`28px 32px 18px 58px` mirrored to `28px 58px 18px 32px`, radius `14px`, inset
`3px`/`-3px`, stripe at `46px`, tabs `20px 20px 4px 4px`, rules `29px→30px` at
`line-height: 30px` with `background-attachment: local`.

**One addition the audit did not anticipate.** Legacy ruled a *textarea*, where
every line is the same height. The v2 editor has headings, lists and quotes, so
every block is pinned to a whole number of 30px rules — otherwise text floats
between the lines the moment a heading appears, which is the same drift recorded
in §3 for a different reason.

F2.1 finished that thought. A heading claims one extra row for its own
typography, and **that row carries no rule**: `h2::before` paints paper over it.
A ruled row means writable space; an unruled one means space a block owns. The
first attempt used a top margin instead, which drew a rule nobody could put the
caret into — a textarea could never have produced that defect, which is why the
audit had no reason to warn about it. See `library-v2-client.md`.

**Two deliberate departures**, both recorded in `library-v2-client.md`: page body
text is Inter rather than Kalam, and the paper is dark rather than white.

**The behaviour was not carried over.** Legacy re-rendered the whole notebook
with `innerHTML` on every change; F2 never replaces an editor element while it
is being typed into. §8's note that the identity is "geometry, ruled paper and
type" is exactly why that was safe to leave behind.
