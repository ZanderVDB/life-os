# Library — the cover system

**One cover, rendered at two scales.** Not two covers kept in step.

## The problem this replaces

The cover a Book showed on the shelf and the cover it showed when it opened were
two implementations: `coverHtml()` in `web/library-book.js` for the Book view,
and a separate shelf cover in `web/library-shelf.js`. Two implementations of one
identity is two things to maintain, and they had already drifted — different
elements, different order, different type scale.

A Book must be the same object everywhere. If the shelf shows you something and
opening it shows you something else, the shelf was not showing you the Book.

## The structure

Six elements, always in this order:

```
bk-cover-mark      Life OS
bk-cover-pre       NOTEBOOK  |  JOURNAL      ← what kind of Book
bk-cover-title     the title
bk-cover-sub       the subtitle, when there is one
bk-cover-rule      the divider
bk-cover-author    author · year
```

Plus an accent edge down the binding side, from the Book's own accent.

`web/modules/library-lab/shared-cover.js` emits exactly this markup, with the
**real** `bk-cover-*` class names. Because the classes are the real ones, the
shelf cover inherits the real typography, the real paper and the real accent —
there is no second design to keep in step.

## Scale is one variable

The shelf cover restates **only** size, through a single custom property:

```css
.c2-cover { --cv: 0.235; }
.c2-cover .bk-cover-title { font-size: calc(64px * var(--cv)); }
```

Every size in the shelf cover is `calc(<the Book view size> * var(--cv))`. There
is no second set of font sizes, so there is nothing to drift. A test fails if a
hard-coded size appears in that block.

At `--cv: 0.235` a 126px shelf cover carries a 15.04px title — legible at a
glance without being a caption.

**Type is never scaled by `transform`.** L3.2 established why: a 126px cover at
`scale(1.06)` is 133.56px, which is a fractional pixel grid and a blurred title.
The cover is laid out at its final size and stays there.

## Nothing is printed underneath

The cover already says what the Book is. A title repeated below it is a product
card, and a metadata block below that is a catalogue entry. Both were tried in
earlier phases and both are what made the Library read as a shop.

The one affordance — **Open** — lives *inside* the lower edge of the cover, and
only while the Book is pointed at or focused.

## Where this should live

Today `shared-cover.js` sits in the lab because the lab is disposable and the
real Library is untouched.

If C2 is adopted, the function moves to the web root and **the Book view owns
it**: `library-book.js` exports the cover, and the Library imports it. Not the
reverse. The Book view is where the design belongs; everything else renders it.

See [the C2 direction](library-v2-l3-c2-direction.md).

---

## L3.5 — unchanged, and now used by two things

The cover system is not under comparison. Every resting treatment and every
pulled treatment in the component lab renders `bookCoverHtml()` from
`shared-cover.js` — the Book view's own `bk-cover-*` markup — and restates only
scale, through the same single `--cv: 0.235`. A test fails on a hard-coded size
in that block.

Nothing is printed beneath a pulled Book in any of the five treatments: no
repeated title, no subtitle, no card footer. The one affordance is `Open`, inside
the lower edge of the cover, visible only on hover or focus. It does not even
need its own pointer target — the click lands on the slot, and the slot knows the
Book is already selected (see [Book physics](library-v2-l3-book-physics.md)).

The move that still has to happen on adoption is unchanged: `shared-cover.js`
goes to the web root and the **Book view exports it**, with the Library
importing. Not the reverse.
