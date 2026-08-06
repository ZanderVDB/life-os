# Library — client architecture

Written after the D2.2 regression, because the regression was architectural
rather than a slip: **three modules each held a private answer to the same
question, and only one of them was ever asked.**

For the product model see `library-v2-product-model.md`; for the shelf, the Book
and the editor see `library-v2-client.md`. This file is about the lifecycle.

---

## The modules

| File | Owns |
|---|---|
| `library-api.js` | the one id-keyed store, and every URL |
| `library-view.js` | the route controller — shelf, item, Book |
| `library-overview.js` | the shelf's markup |
| `library-book.js` | the spread's markup and the editor mount |
| `library-save.js` | one save coordinator per page |
| `library-modal.js` | the creation and rename forms |

Nothing outside `library-api.js` builds a URL. Nothing outside `library-view.js`
decides what an error looks like — the shell injects `toast`, `run`,
`openSurface` and `choose`, so Library has one voice with the rest of the app.

---

## The D2.2 regression: who owns the hash

### What was seen

`#library` opened, the header said `Opening…`, a large skeleton stayed, and the
shelf never rendered. Permanently.

### The root cause

Every asynchronous render captures a navigation token and refuses to paint if a
newer navigation has happened (see `shell-navigation-and-transition-model.md`).
That is correct. What was wrong is what counted as a navigation.

Three modules wrote `location.hash`:

- `app.js` — via a private `ownHashWrite`
- `library-view.js` — via a private `suppressHash`
- `diary-view.js` — via its own private `suppressHash`

The shell's `hashchange` handler could only see **app.js's**. So a hash Library
wrote *about where the person already was* — opening a Book, turning a page —
was counted as a NAVIGATION. It bumped the token. `loadBook` returned, found
itself stale, and returned without painting, leaving the loading shell up for
ever.

A hash write is a navigation when a **person** made it. It is not one when the
app wrote it to record where the person already is: those writes come *after*
the decision, not before it.

### The fix

`web/nav.js` owns both halves — the token and the record of what was written.

    setHash(next)        writes, and remembers that we did
    hashWasOurs(hash?)   answers once, and consumes the record

Everything that writes a hash goes through `setHash`. The shell asks
`hashWasOurs()` **exactly once** per event, at the top of the handler, and
passes the answer down to `libraryHashChanged(ours)` and
`diaryHashChanged(ours)`. Consuming is deliberate: a second caller would be told
"no" and would treat our own write as a navigation, which is the bug again.

A safety net clears the record on the next tick, so a `hashchange` that never
arrives cannot leave a stale entry to mislabel a later, genuine navigation.

### One thing it also fixed

`go(id)` used to flatten the hash to `#id`. A deep link arriving from elsewhere
— `#diary/2026-08-05` from a Calendar habit row — would silently open *today*.
A hash already inside the target section is now left alone.

---

## The loading lifecycle

> A loading state is a promise that something is coming. If it can be left on
> screen for ever, the promise is a lie.

The token bug is fixed, and this is the guarantee that no future cause produces
the same screen.

Every path that raises a loading shell calls `beginLoading(what, onRetry)`,
which arms a watchdog. Every path that reaches a real screen calls
`endLoading()`. If the watchdog fires, the shell is replaced by a retry state
that says what happened.

**A loading state has exactly three legitimate ends:**

    overview  |  empty  |  error-with-retry

Every shell carries `data-loading`, which is what makes the watchdog possible —
and `isLoadingShellUp()` is exported so a check can be made from outside.

### The shells themselves

Restrained and shaped like what is coming, so arrival is a fill rather than a
reflow:

- **shelf** — a filter bar and four card skeletons at the cards' real height
- **book** — two page shapes in the spread's own 420:297 proportions
- **item** — one card skeleton

The 60vh grey slab is gone. It was the visible half of the regression: a
placeholder large enough to be the page is indistinguishable from a page that
failed.

The Book's header carries the **real title** while it loads — the shelf already
knew what the book was called, and a stable header is what makes a wait read as
loading rather than as having landed somewhere unnamed.

---

## The rendering rule (unchanged)

The overview and the item view rebuild freely. **The Book does not.** While a
spread is on screen its editor elements are never replaced, because replacing a
contenteditable destroys the selection, the caret and the browser's undo
history. A spread is rebuilt only when the spread itself changes — a page turn,
a section change — and never in response to typing or to a save completing.

Legacy re-rendered the whole notebook with `innerHTML` on every change. That is
exactly what it cost.

## Animations

See `docs/animation-house-rules.md`. Library contributed two of its four
defects: the frozen page turn (F2) and, found during D2.2, an entrance
animation that a throttled timeline held at `opacity: 0` indefinitely. Both
`turn()`'s leave class and `enterOnce()`'s enter class come off on a timer, so
the stylesheet owns the final state whatever the timeline does.
