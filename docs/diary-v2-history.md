# Diary — History

The screen that answers **"where is that day"** and **"how has this month
gone"**, and stops there.

Not a heatmap and not a streak counter. Diary is a record, not a habit, and a
screen that rewards consecutive days quietly punishes the weeks somebody could
not write. (The continuity that *is* worth showing lives on Today, as the
computed habit — see `diary-v2-system-habit.md`.)

---

## What a day shows (D2.2 §13)

D2 drew a dot. A month of writing therefore looked like a month of identical
dots: the grid answered "did I write" and never "what was that day", which is
the question you actually have when you are looking for something.

A written cell now carries three things:

1. **the day number**, bolder than an empty day's
2. **one short line of context**
3. **the broad feeling, as a word**

plus a restrained tint, which is decoration and never the only carrier.

### The context line is chosen on the server

`previewOf()` in `routes/diary.ts`, in order of how deliberately the words were
written:

    title  →  Highlight  →  day summary  →  the opening words

Never "Untitled" — that describes the label rather than the day.

Cut to **90 characters in SQL**, not on the client: a month of long entries is a
large response to send in order to throw away, and the cell can only show one
line either way. The raw document text never leaves the server.

### The feeling has two vocabularies and one answer

`reflection.checkin.feeling` (rough / low / steady / good / great) is what the
right page writes. `mood` is an older column holding the same five steps under
different names. The endpoint maps one onto the other, so a day recorded before
the check-in existed still has a feeling, and the grid never has to know which
one it came from.

    very_low → rough    low → low    neutral → steady
    good → good         very_good → great

---

## The tint

**A difficult day is not an error.** Never `--danger`, never a raw red.

| Feeling | Tint |
|---|---|
| Rough | muted warm rose `rgba(214,124,110,.16)` |
| Low | softer warm rose `rgba(214,142,124,.11)` |
| Steady | the plain surface — ordinary should look ordinary |
| Good | soft green `rgba(122,190,146,.13)` |
| Great | lilac `rgba(160,136,240,.15)` |

The tint follows how a day **felt**, never how it went. It is the fourth carrier
of presence, after the context line, the weight and the accessible name — so
removing colour entirely loses nothing.

---

## The month fits

D2's cells were `aspect-ratio: 1`, which on a ~900px column made each one about
120px tall and the six-week grid about 740px — taller than the room above the
composer once the header and the search bar are counted.

A written day needs three short lines, not a square. The cell height is
**stated** (60px) and identical on every row, so the grid cannot creep, and
`overflow: hidden` with a two-line clamp means one long Highlight can never push
a row taller than its neighbours.

**Measured at 1280px wide:** the calendar card is 485px and the whole History
column is 539px. It fits above the composer at a viewport height of **765px or
more**. At 720px it needs about 23px of scroll — worth knowing, and it is the
only case that does not fit.

## On a phone

Seven columns of ~44px cannot carry two lines of 10.5px text, so below 820px the
context line and the feeling word are hidden and the dot returns. The day
number, the weight, the tint and the accessible name stay: the same information
at the density the screen can actually carry. Tapping still opens the day, and
the cells are 44px tall.

---

## The rest of the screen

- **Recent** — the last eight days written, newest first, each with its own
  context line from the same `previewOf` rule.
- **Search** — debounced, and guarded by the query it was issued for, so a slow
  answer to an older term can never replace the results for what is in the box
  now. It searches the writing, the prompts and the check-in, because half of
  what a person writes in D2 lives outside the document.
- **Keyboard** — arrow keys walk the grid; the open day is the single tab stop.

## Still not built

- No year view, and no "on this day".
- No export from this screen.
- No filtering by feeling — the tints make a month scannable, and a filter would
  turn a record into a dataset.
