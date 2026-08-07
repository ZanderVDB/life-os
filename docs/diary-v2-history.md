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

---

# D2.3 — the daily snapshot

D2.2's cell showed a context line and the feeling as a word. On most days the
word was the only thing there, so a month read as a column of `GREAT`,
`STEADY`, `GOOD`. **A word is not a snapshot.**

## The cell now

    row 1   feeling face · energy meter · social battery
    row 2   the day number and one short line of context
    row 3   four small marks, one per passive dimension

Drawn with the **same components** the right page uses — `face()`,
`energyMeter()`, `batteryMeter()`, `glyph()`, imported from `diary-checkin.js`
rather than re-implemented. One vocabulary, learned once, and the two surfaces
cannot drift apart.

The cell is 72px, stated, and identical on every row, with `overflow: hidden`
and a two-line clamp on the context line, so nothing can push a row taller than
its neighbours.

## The passive marks (§13)

Four glyphs — bowl, stride, sun, moon. The **glyph** says which dimension; its
**opacity** says roughly how much, from `scaleValue`. No option text is written
into the square.

Exact values live in the cell's `title` and its accessible name:

    felt good · energy high · social battery running low ·
    nourishment great · movement light · outside some · sleep rough

so hovering or focusing a day says exactly what it was, and a month can be
scanned for patterns without any of it being spelled out in a 60px box.

## What the endpoint sends

`/diary/days` returns **ids**, not writing: `feeling`, `energy`, `social` and a
`rhythm` object. The prompts and the retired Moment lines are deliberately not
sent — those are writing, and a month grid is not where writing belongs. The
context line is still chosen and cut to 90 characters in SQL.

## §15 — History shows days, not goals

Diary History answers *what did my days feel like*, never *how many did I
complete*. Ordinary habit completion does not appear here and must not: habit
analytics belong to Calendar and Habits. The passive dimensions do appear,
because they are part of the Diary reflection itself.

Asserted directly: `diary-history.js` contains no reference to habits or
streaks at all.

## Colour is still subordinate

The tint is unchanged — muted warm rose for Rough and Low, plain surface for
Steady, soft green for Good, lilac for Great, never `--danger`. What changed is
that it now has less work to do: the indicators carry the same information with
no colour at all.

## Measured at 1280×900

Month card 557px, whole History column ending at 751px against a composer top of
836px — **it fits**, with six week-rows at 72px and no overflow in any cell.

---

# D2.4 — cell density and the indicator grammar

## A column you can scan down

The problem was not how much a cell held, it was that the marks moved. A day
with no feeling recorded drew its rhythm marks where a day with a feeling drew
its face, so nothing lined up down a column and the grid had to be read cell by
cell.

Two rules fix it, and both are about **position**, not content:

1. A missing primary indicator leaves a `dia-day-gap` — 16×9px of nothing — so
   the marks after it keep their place.
2. **All four** rhythm marks are always drawn. An unanswered one is the same
   mark at `opacity: .12`.

An unanswered dimension is therefore visibly *unanswered* rather than absent,
which is the honest reading: "I did not say" is not "it did not happen". And
because every cell has the same slots in the same places, a column can be
scanned in one pass — which is what History is for.

Cells are 80px, and a month fits above the composer with 37px to spare at
1280×900.

## The grammar

| Slot | Drawn when | Drawn how when missing |
|---|---|---|
| feeling face | a feeling is recorded | `dia-day-gap`, 16×9px |
| energy meter | energy is recorded | `dia-day-gap` |
| social battery | social is recorded | `dia-day-gap` |
| 4 rhythm marks | **always** | same mark, `opacity: .12` |

The face, the meter and the battery are the same components the right page uses.
There is no History-only iconography to learn.

## Hover, selected and today are three different things

| | |
|---|---|
| **hover** | `inset 0 0 0 1.5px` strong border, a soft drop shadow, `translateY(-1px)` |
| **selected** (`.is-open`) | `--accent-soft` fill, `inset 0 0 0 2px` accent ring, white text |
| **today** | its own marker, independent of both — today can be hovered, selected, neither or both |

Selection overrides the feeling tint (`.dia-day-cell[data-feel].is-open` is
specific enough to win), because a cell you have opened should read as opened
first and as a mood second. Hover never overrides the tint: it lifts and outlines
the cell without repainting it, so passing the pointer across a month cannot be
mistaken for having selected something.

## Sample data for visual QA

`POST /diary/sample/history` seeds **14 days across four weeks**, with gaps, so
the grid can be judged with realistic density instead of one hand-made day.

It is refused unless `NODE_ENV` allows it — there is no production sample
capability, and the route returns the refusal rather than seeding a subset.
Every row is marked with the existing `sample:d1:` prefix on `timezone`, so the
existing cleanup removes exactly the sample records and nothing else. No private
data is used anywhere in the set.
