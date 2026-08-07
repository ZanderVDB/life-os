# Diary — revised direction (Phase D2)

D1 shipped a working diary that felt like a form. Everything saved, nothing
invited you in. D2 changes the shape of the thing without changing what it is.

## What changed, and why

**Diary opens as a two-page spread**, in the same book language as Library. The
D1 single centred sheet was correct in the abstract — a diary is a sequence, not
an object you hold — and wrong in practice: it read as a document with fields
attached, and it did not look like part of Life OS.

The book metaphor turns out to earn its place here for a different reason than
in Library. Library's spread exists because a book *is* two facing pages. In
Diary the two pages are two different **kinds of thinking**:

| | |
|---|---|
| **Left** | reflective writing — the day in your own words, then guided prompts |
| **Right** | a quick check-in — how it actually felt, in a few taps |

That is a real division, not decoration. Writing is slow and open; a check-in is
fast and closed. Putting them on one surface made the check-in feel like a form
you had to finish before the writing counted.

## Diary and Library: the boundary, restated

**Unchanged at the data layer.** `diary_entries` is its own table. A diary entry
is not a `library_items` row and never becomes one. Diary is keyed by civil
date; Library is keyed by nothing but identity.

**Shared at the presentation layer**, deliberately and by name:

| Shared | Where it lives |
|---|---|
| document grammar | `editor-doc.js` |
| Enter/Backspace rules, block styles, the 30px block grid | `editor-blocks.js` |
| the save state machine | `editor-save.js` |
| the book geometry — A4 pages, 420/297 spread, 6px gutter, ruled paper, margin stripe, mirrored page edge | the `.bk-*` CSS layer |

D1 said Diary "shares the editor and nothing else" and treated the Book's
geometry as furniture to avoid. That was the wrong line. The geometry is not
Library's property — it is **the house style for a page you write on**, and two
surfaces that both hold writing should not invent two of them.

What stays Library's alone: the shelf, item cards and types, sections and their
tabs, the archive model for resources.

What is Diary's alone: the date as the organising fact, guided prompts, the
check-in, the month history, and the streak.

## The right page is not a mood tracker

Diary makes no claim about your health and infers nothing from what you wrote.
The check-in exists because a day has a texture that prose is slow at, and
because a diary you can *start* in two taps is a diary you open again tomorrow.

Rules it lives by:

- **Nothing is required.** No field gates the writing.
- **No native selects.** Chips, segmented controls and expandable cards, in the
  app's own language.
- **Words, never only a glyph.** Every option is labelled; nothing depends on
  reading an emoji or distinguishing a colour.
- **Two levels, not twenty.** Pick a broad feeling; open it if you want a
  precise one. The broad answer alone is a complete answer.
- **The streak is a fact, not a scoreboard.** It is shown small, it never
  scolds, and breaking it costs nothing. A diary that punishes the weeks you
  could not write is a diary you stop opening during the weeks that matter.

## The top controls

D1 had two labelled chevron pairs — Day and Entry — and a native date input.
"Entry" was never legible: it meant "jump to the previous day I actually wrote
on", which is a real thing to want and not a thing anyone reads off a chevron.

D2 keeps: **Previous day · Today · Next day**, a **month/date jump** in the app's
own styling, and **History**. The jump-to-previous-written-day behaviour moves
into the History surface, where a month grid already shows exactly where those
days are — the grid answers the question better than a button ever did.

## Storage

One new column: `reflection jsonb`. It holds the guided prompt answers and the
check-in as a single validated object.

Not eleven columns. The prompts and the check-in are both sets that will change
as the product learns what people actually answer, and a schema migration per
question is a tax on finding that out. `mood` and `energy` stay as columns
because history and search already read them.

The meaningful-entry rule extends to cover it: a day with only a mood and a
gratitude is a day somebody wrote.

---

## Deferred, deliberately

These are good and none of them are D2.

**Month-as-tabs navigation.** The Book's section tabs, reused as months along
the top of the diary. It needs a decision about what a year looks like when it
does not fit, and that decision is easier once the month overview exists.

**Month overview spread.** A whole month as a two-page spread — the grid on the
left, the month's shape on the right. This is where "what was happening in
March" gets answered properly, and it wants the history data model to settle
first.

**Year jump.** Only interesting once there is more than a year to jump through.

**The diary-as-first-book / system-book concept.** Diary appearing as the first
book on the Library shelf, or Life OS presenting one shelf of "system books"
(Diary, Brain, Projects) beside your own. Attractive, and it would immediately
put pressure on the boundary this document just drew — a diary on the shelf is a
diary somebody will try to archive, rename and file. Worth doing only with that
answered.

**Library bookshelf redesign.** The shelf is a card grid. It could be a shelf.
Out of scope while the Book itself is still settling.

---

# D2.2 — the correction

D2 was right about the spread and wrong about its size. Two of its decisions
over-corrected, and one thing it added was never wired into the system it
belonged to.

## What was reversed

**"The spread grows."** It grew from a viewport formula —
`min-height: calc((100vw - 460px) * 297/420)` — which reads the *window* to size
an element inside a column. Combined with five always-open prompt fields, an
empty day ran far below the fold. The base is now the Book's own 420:297 shape,
expressed as a pseudo-element, and content is the only thing that adds to it.
See `diary-v2-responsive.md`.

**Five prompts, all open.** Three now, with two a press away. Five empty fields
cost 411px — more than the free writing above them.

**Four always-open Moment fields.** Four tiles now, opening into one line each.
262px became 96px for something most days leave blank.

## What was completed

**The computed habit was a picture, not a member.** D2.1 drew `Write in Diary`
on Today and left the totals alone, so the panel said `0/5` with the row visibly
complete. It is now part of one shared calculation on the server, and it reaches
Today, the Calendar month cells, the Calendar day sheet and the history series.
See `habits-v2-product-model.md`.

## What was kept, unchanged

The spread itself, and the reason for it: two kinds of thinking, one object.
Reflective writing on the left, a fast check-in on the right. The `.bk-*`
geometry, the ruled paper, the 30px block grid, the margin stripe, the mirrored
coloured edge. Diary and Library remain separate in the data model, and a diary
entry is still never a `library_items` row.

Nothing about Tasks, Calendar events or Habit details entered Diary. The only
connection still runs the other way: Today and Calendar ask Diary whether a day
holds writing.

---

# D2.3 — the page rule, and two regressions

The two-page spread is approved and unchanged. What D2.3 settles is **what each
page is for**, which D2.2 had left implicit and then violated.

## The rule

    LEFT PAGE  = THINGS YOU WRITE.
    RIGHT PAGE = THINGS YOU TAP.

D2.2's Moment tiles were the counter-example that made the rule necessary: four
text fields dressed as controls, on the page whose whole value is that it is
fast. They opened the keyboard, competed with the writing across the gutter, and
put an essay at the end of a two-tap check-in.

## What was reversed

- **The four Moment text fields** left the right page. They survive on the left,
  as prompts, only on days that already hold one.
- **The initial writing region** stopped absorbing spare space. Seven ruled
  lines, then the prompts.
- **The social battery's geometry** — cells replaced by one continuous fill, so
  the four states are evenly spaced by construction rather than by accident.

## What was added

Five feeling faces from one system; four passive daily dimensions; a Day Pulse;
History cells that draw the right page's own indicators.

## What was fixed

The Diary rubber-band and the habit ring's seam — both documented at length in
`diary-v2-navigation.md` and `animation-house-rules.md`. Both had the shape of
every defect in this project so far: **something arriving late, or drawn
twice, was allowed to overrule a decision that was already correct.**
