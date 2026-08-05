# Library — the client (Phases F2 and F2.1)

F1 built the schema and the API. F2 built the thing you actually use: the shelf,
the Book, the editor and everything that keeps what you type.

The product rules live in [`library-v2-product-model.md`](library-v2-product-model.md).
The Book's geometry comes from [`library-v2-legacy-book-audit.md`](library-v2-legacy-book-audit.md).
This file records the decisions F2 made and, where they cost something, why.

---

## The modules, and why they are separate

| File | What it owns |
|---|---|
| `library-api.js` | every URL, and the one id-keyed store |
| `library-doc.js` | the document ⇄ DOM mapping |
| `library-save.js` | the save state machine |
| `library-book.js` | cover, spread, tabs, toolbar |
| `library-overview.js` | the shelf: cards, filters, results |
| `library-modal.js` | the create/rename form |
| `library-view.js` | routing, and everything that is a decision rather than a rendering |

**One store, keyed by id.** Nothing keeps its own copy of an item, a section or
a page. Two copies of a page is how an editor and a search result start
disagreeing about what was typed.

**No module writes a URL except `library-api.js`.** That is also the one place
a 409 is recognised, because a conflict needs a completely different response
from a failure and the difference must be made once.

**No module imports the shell.** `app.js` injects the API caller, the toast, the
error wrapper, the anchored surface and the choice dialog. Library therefore has
no opinion about auth, workspaces or what an error looks like.

---

## The rendering rule

The shelf and the item view rebuild freely.

**The Book does not.** While a spread is on screen its editor elements are never
replaced. Replacing a contenteditable destroys the selection, the caret and the
browser's undo history — Legacy re-rendered the whole notebook with `innerHTML`
on every change, and that is precisely what it cost. A spread is rebuilt only
when the spread itself changes: a page turn, a section change, a search jump.
Never in response to typing, and never in response to a save completing.

The save status is the test of this. It changes *while you are typing*, so it is
painted in place, at a fixed width, and touches nothing else.

---

## Saving

Five states: `Saved`, `Unsaved`, `Saving…`, `Save failed`, `Changed elsewhere`.

**One writer per page, ever.** A second flush waits for the first and then sends
whatever is pending by then, which coalesces a burst of typing into one more
write rather than a queue of them.

**Every write carries `expectedUpdatedAt`** from the last successful response.

**The ordering rule.** A response that arrives for a version we have already
moved past updates the version token and *nothing else*. It cannot mark newer
text saved. Without that, a slow save for "two" arriving after you have typed
"three" declares "three" safe when the server has never seen it.

**A failure puts the content back into `pending`.** Nothing is ever discarded
because a request lost. Retry sends the same text again.

**A flush happens before anything takes the editor away** — a page turn, a
section change, closing the book, leaving the route. `app.js` awaits
`libraryWillLeave()` before the route changes, not alongside it.

### The bug this section exists because of

The save entry records `committed` — what the server is known to hold. It was
originally created lazily, on the first keystroke, from the page object. But the
input handler had already written the new document onto that object, so
`committed` equalled what had just been typed, the unchanged-content check said
nothing had changed, and no write was ever queued.

The status sat on **Saved** while the words went nowhere.

Two changes: `trackPage()` registers a page when its editor mounts, while the
baseline is still true; and the local copy is updated *after* the save is
queued, never before. Both are covered by tests, because the failure is silent
and looks exactly like success.

---

## Conflicts

A 409 stops the writer and asks. Three ways out, and all three keep your words:

- **Keep what I wrote** — re-reads the page for a fresh token, then writes over
  it. Deliberately a re-read and not a blind overwrite: the token has to come
  from the server or the next save conflicts again for the same reason.
- **Load the newer version** — copies your text to the clipboard *first*, then
  replaces the page.
- **Copy my text** — clipboard only, nothing changes.

The only genuinely unacceptable outcome is a person losing words they wrote.
Whichever they choose, they can still get their own back.

---

## Forward compatibility (§13)

The server **drops** node types it does not recognise. That is right at the
boundary: it must never store something it cannot describe.

**The client never drops.** It round-trips — read a page, edit one paragraph,
save it back — so repeating the server's rule would let an older tab silently
delete an `image` node a newer build wrote. An unknown node renders as a
visible, non-editable placeholder saying what it is, and is carried back out
verbatim.

Content you cannot yet edit is still content you still have.

Verified in a browser: a synthetic `callout` node survived a full round trip
byte-for-byte while an ordinary paragraph next to it edited normally.

---

## The editor

`document.execCommand` is deprecated and is still the only API that edits a
contenteditable while preserving the browser's own undo stack.

Legacy's problem was not using it — it was **storing what it produced**, so
`<font color="black">` wrappers reached the database and made text invisible on
a dark theme. Here nothing it emits is stored: `htmlToDoc` reads the DOM back
through a fixed grammar, so a stray wrapper contributes its text and nothing
else. The command is a means of editing, never a format.

**Paste is taken as plain text.** Whatever was copied is usually a whole styled
document; taking the text and letting the grammar re-block it is the only way to
be certain nothing enters that the model cannot describe.

**The toolbar is restrained**: style, bold, italic, underline, strikethrough,
two lists, link, undo, redo. No colours, no fonts, no sizes. A ribbon in a book
is a word processor wearing a book's clothes.

### Blocks that contain blocks

`execCommand` nests. Apply a list inside a quote and you get
`<blockquote><h3><ul><li>…`. Reading only the editor's direct children treated
that tower as one blockquote and — since it had no `<p>` child — swept every
word into a single quoted paragraph. The heading and the list survived as text
and vanished as structure, silently, on the next reload.

`collectBlocks()` now unwraps a block that contains blocks. The wrapper is lost,
which is correct: this grammar has no heading-inside-a-quote to store. The
content is kept, in the right shape.

A blockquote made of paragraphs is **not** unwrapped — that is genuinely its
shape. `ul`/`ol` are never unwrapped; their `li` children are their own content.

---

## The block grid (F2.1)

F2 pinned every block to `line-height: 30px` and gave headings `margin-top: 30px`
so they would not sit flush against the paragraph above.

That margin was the defect. **A margin belongs to no element.** It drew a ruled
line — the editor's background paints one every 30px regardless of what is
there — and the caret could never be placed in it, because there was nothing to
place it in. It looked like a line you should be able to write on and it was
not. Measured before the fix: a 30px gap between one block's bottom and the
next block's top, belonging to neither.

### The formula

    height = (lead + lines) x 30px

`lines` is however many ruled lines the text wraps onto. It needs no
declaration — it follows from `line-height: 30px` applying everywhere.

`lead` is the number of rows a block claims for its own typography:

| Block | lead | rows for one line |
|---|---|---|
| Body paragraph | 0 | 1 |
| Empty paragraph | 0 | 1 |
| Heading | 1 | 2 |
| Subheading | 1 | 2 |
| Quote | 0 | its paragraphs, exactly |
| List | 0 | its items, exactly |

Two rules make it work, and both matter:

1. **Lead is padding, never margin.** Padding is inside the block, so clicking
   it puts the caret in the heading — which is where it belongs, and which is
   the interaction half of the fix.
2. **A lead row is unruled.** `h2::before` / `h3::before` paint `var(--paper)`
   over exactly the lead, with `pointer-events: none`. A writable blank line
   always has a rule; typography-owned space never does. That is the entire
   visual grammar, and it is why the lead cannot be mistaken for an empty line.

Nothing else was needed — no negative margins, no transforms, no first-block
special case, no viewport-specific corrections. Browser defaults are zeroed on
`.bk-editor > *` rather than overridden per element, so nothing can collapse or
leak in from the user agent stylesheet.

The ruled area itself is `height: round(down, 100%, 30px)`, so the page ends on
a rule and an internal scroll moves whole lines. The page-title band is a
declared 60px, so the body grid begins at a stated place.

### What it looks like

The row map of the regression page, derived from the measured layout — every
unruled row is owned by a heading, and every ruled row has text on it:

    row  0 ──────  p           A body paragraph, to begin
    row  1 ──────  p           (wrapped)
    row  2         h2          A Heading          <- lead, unruled
    row  3 ──────  h2          A Heading
    row  4 ──────  p           Body again
    row  5         h3          A Subheading       <- lead, unruled
    row  6 ──────  h3          A Subheading
    row  7 ──────  p           Body again
    row  8-11 ───  ol          numbered, one item wrapped
    row 12-13 ───  ul          bulleted
    row 14-16 ───  blockquote  wrapped quotation
    row 17 ──────  p           A final body paragraph

There is no ruled row without content. That was the whole complaint.

## Enter, Backspace and the caret

`library-blocks.js` holds the rules. Every one goes through `execCommand` — not
because it is a good API, it is deprecated, but because it is the only one that
edits a contenteditable while keeping the browser's undo stack. Hand-written DOM
surgery produces the right shape and then breaks Ctrl+Z, which is a worse bug
than the one it fixes.

| Keystroke | What happens |
|---|---|
| Enter at the END of a heading | a body paragraph on the next row |
| Enter at the START of a heading | a real empty paragraph above; caret stays in the heading |
| Enter in the MIDDLE of a heading | heading keeps the text before the caret, the rest becomes body |
| Enter on an EMPTY list item | leaves the list, as body |
| Enter on an EMPTY quote paragraph | leaves the quote, as body |
| Enter in a quote with text | a new paragraph inside the quote |
| Backspace at the START of a heading | becomes a body paragraph |

Backspace **converts rather than merges**, deliberately: converting is
recoverable with one more keystroke, merging two blocks is not.

Nothing fakes a paragraph to correct a visual offset. The document contains only
real content — verified by reading the JSON back after every one of these.

### Two things the toolbar was getting wrong

**`queryCommandValue('formatBlock')` reports a paragraph inside a blockquote as
`p`**, so Quote never showed as the active style. The toolbar now reads the
caret's block from the DOM.

**`formatBlock` cannot leave a quote.** Applied to a paragraph inside a
blockquote it restyles the paragraph and leaves it where it is, so "Quote to
Body" appeared to do nothing. `applyBlockStyle` outdents first.

### Style names

The interface says **Body, Heading, Subheading, Quote**. The option values are
`body`/`heading`/`subheading`/`quote`, mapped to `p`/`h2`/`h3`/`blockquote` in
one table in `library-blocks.js`. `h2` is the document's business and appears
nowhere a person can see. The active style is announced through the select's
`aria-label`, and headings, lists and quotes stay real elements — never styled
paragraphs imitating them.


## Routing

```
#library                         the shelf
#library/item/{id}               one non-book item
#library/book/{bookId}           a book, at its cover
#library/book/{bookId}?s=…&p=…   a book, at a section and page
```

Section and page travel as **ids, never page numbers**. A saved link must not
open the wrong page because a page was inserted in front of it. A hit whose page
has since moved is resolved against the current structure, or reported as moved
— never opened blind.

The hash is written on every turn, so Back walks back through the book and a
refresh lands where you were.

---

## Reading, and the shape of the page

The audited geometry is carried verbatim: A4 `210/297`, spread `420/297`, a 6px
gutter, `28px 32px 18px 58px` padding mirrored on the right page, a 46px margin
stripe, a `3px`/`-3px` mirrored coloured edge, `20px 20px 4px 4px` tabs, and the
ruled gradient whose 30px cycle equals the line-height with
`background-attachment: local`.

**Every block in the editor is a whole number of 30px rules.** F2 did this with
`line-height: 30px` plus a 30px top margin on headings; F2.1 replaced the margin
with padding and an unruled lead row, because a margin belongs to no element and
the caret could not be placed in it. See [The block grid](#the-block-grid-f21).

**The blank facing an odd final page is a rendering decision, not a row.** It
carries the `Add pages` action. Pressing it when the count is odd adds **one**
page, not two — you pressed Add on a blank and should not get another blank.

### Two departures from the audit, stated plainly

1. **Page body text is Inter, not Kalam.** Playfair carries the cover, the tabs
   and the page headings, which is what makes the book read as a book. A
   handwriting-adjacent face at 15px on ruled lines is harder to read, not more
   charming, and it costs another font request. This is a deliberate departure
   and is easy to revisit.
2. **Paper is dark.** A white page in a dark application is a searchlight. The
   paper is warm and lighter than the surfaces around it, so it still reads as
   paper on a desk.

---

## Narrow screens

Below **820px** a `420:297` spread is two unreadable columns, so the spread is
read one page at a time. The DOM is unchanged — only which half is shown — so a
resize needs no reload.

Navigation is symmetrical: forward goes left → right → next spread, and back
retraces it exactly, ending at the cover. The back arrow is **never** disabled
while a spread is showing, because there is always somewhere back to go. It used
to be disabled on the first spread, which made the cover unreachable by arrow
and, on a phone, made the left-hand page of the first spread unreachable at all.

Below **480px** the arrows move out of the row and sit over the outer edges of
the page. In the row they took 100px of a 321px column — a third of the screen —
leaving a 221px page nobody can write on. The 44px target is kept; the page gets
the width.

---

## Library uses its width for Library

No right rail. Item details, backlinks and activity would fill one; none of them
exist yet, and an empty rail is worse than no rail.

Hiding `.rail` is not enough — the grid track has to collapse too, or the column
keeps its 320px and the book renders at 485px. Both rules are asserted in
`web-shell.test.ts`.

---

## Sections and pages

The active tab and each page carry a small actions control. Only the ACTIVE
tab — a control on every tab is six controls competing, and one section is being
worked on at a time.

Sections can be renamed, recoloured (the six audited accents) and archived.
Pages can be archived, with Undo.

**The API's two refusals are stated, not thrown.** The last section of a book
and the last page of a section cannot be archived — a book with no section has
nowhere to put a page, and a section with no page cannot be opened to. The menu
says so where the button would have been. A control that fails when pressed
teaches nothing; the same information given before the press is useful.

**Archiving a section re-reads the book.** It takes its pages with it, and
guessing which local rows went is how a stale page id ends up being written to.
Archiving a page forgets its save entry first, so no pending write survives it.

## Honesty

- **No fake buttons.** New Book, New Document and Save Link are the three types
  with a complete endpoint. Upload Image, Video and File are **absent, not
  disabled** — a greyed-out control still claims the feature exists.
- **No native dialogs.** No `confirm`, no `prompt`, no `alert`. Adding a link
  uses a small inline surface; choices use the app's own dialog.
- **Archive offers Undo, not a confirmation.** It is reversible, so a dialog in
  front of it is a tax on the common case.
- **Sample data is a console hook** (`__sampleLibrary.add/check/remove`), never a
  control. The real guard is server-side: both endpoints refuse outright when
  `NODE_ENV` is production.

---

## What F2 did not build

- **No uploads.** Image, Video and File items are records of a resource; their
  bytes are not stored. The item view says so rather than implying a viewer.
- **No cross-system links.** `item_links` is ready; nothing writes Library edges
  into it yet.
- **No Diary.** Diary will reuse the Book engine and nothing else, when it is
  built.
- **No Legacy content.** Nothing was read, previewed, imported or migrated.
  Legacy was inspected for its design only.

---

## Verified in a browser

Driven against a real Fastify API on PGlite (`api/tests/live-server.ts`), not
inferred from source.

| Behaviour | Measurement |
|---|---|
| Spread geometry | ratio `1.414`, max-width `1320px`, gap `6px`, padding `28px 32px 18px 58px` mirrored, inset `3px`/`-3px`, tab radius `20px 20px 4px 4px` |
| Ruled paper | `line-height: 30px`, gradient `29px→30px`, `background-attachment: local` |
| Save cycle | `Saved → Unsaved → Saved`, content confirmed on the server after reload |
| Bold round trip | `<b>` → `bold` mark → `<strong>` after reload |
| Conflict | second writer → 409 → dialog → *Keep what I wrote* → server holds my text |
| Unknown node | `callout` survived a round trip byte-for-byte |
| Page turns | `1L → 1R → 2L → 2R → 3L`, and back to the cover, at 768px |
| Add pages | odd section 5 → 6, blank consumed, focus on the new page |
| Add section | validation refuses empty; section arrives with 2 pages, accent cycles to gold |
| Library-wide search | text inside a book found from the shelf, opens the right page |
| Deep link | refresh restores section and page |
| Responsive | 1440 / 1280 / 1024 / 768 / 390 / 375 — no horizontal overflow at any width |
| Composer | 70px clearance at the bottom of the scroll on a 390px screen |
| Reduced motion | no animation class applied; the spread swaps instantly |
| Block grid (F2.1) | every block a whole number of rows, zero gaps, at 1280 / 768 / 390 |
| Heading lead row (F2.1) | 30px of padding inside the heading, unruled, caret lands in the heading |
| Enter / Backspace (F2.1) | all seven rules, plus undo restoring the block type |
| Block conversion (F2.1) | Body to Heading to Body and Body to Quote to Body, no phantom nodes |
| Internal scroll (F2.1) | editor exactly 15 rows, scroll lands on whole rows, nothing clipped |
| New Book | cover shows the title and subtitle; arrives with 1 section, 2 pages |
| Section colour | rose applied to the tab and the page edge together |
| Archive page | count 6 to 5, Undo restores it |
| Archive section | section and its pages gone, book re-read, header recounted |
| Last-one guards | the only section and the only page show the reason, not a button |

**Timing caveat.** The Browser pane throttles `setTimeout` when it is not
displayed, so debounces measured there read as ~1s rather than their real value.
The API itself answered search in 7–11ms; the delay is the harness, not the app.
