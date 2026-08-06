# Diary — product model (Phase D1)

Diary is the **chronological record of a life**. One entry per local calendar
day, written in whatever shape the day took.

It answers: what happened today, what was I thinking, what changed, what was
happening during that period, what have my days looked like over time.

It is **not** a task manager, a project log, a generic notebook, a collection of
Library Books, a feed, a mood tracker with writing bolted on, or a daily form
that must be completed. Writing is the centre; everything else is optional and
quiet.

---

## Diary and Library are different things

| | Library | Diary |
|---|---|---|
| holds | durable resources you return to | dated records of a life |
| organised by | type, and inside a Book by section and page | the calendar |
| a thing is | an item on a shelf | a day |
| removal | archive an item | archive a day |

**A diary entry is not a `library_items` row and never becomes one.** They share
the editor and the document grammar. Nothing else.

Putting entries on the shelf would mean every diary day competing with a saved
link for the same attention, and would make "archive this resource" and "archive
this day" the same action. Two different questions, one button.

### What Diary reuses

The generic editor modules, renamed in D1 to say what they actually are:

| Module | What it owns |
|---|---|
| `editor-doc.js` | the document ⇄ DOM mapping |
| `editor-blocks.js` | Enter / Backspace rules, block styles, the F2.1 grid model |
| `editor-save.js` | the save state machine, as a factory |

Library and Diary each bind the save factory to their own endpoint, so pages and
days never share a queue, a status or a version token.

### What Diary deliberately does not reuse

The cover, the two-page spread, the section tabs, the page turn, the coloured
page edges, the Library overview cards, the Library archive model. A book is an
object you hold; a diary is a sequence you move through.

What it *does* borrow visually is the ruled paper and the block grid — the parts
of the Book that exist to make **writing** read well, and which do the same work
here.

---

## One entry per local day

The civil date belongs to the person, not to UTC. The client sends the date it
is showing; the server validates the shape, compares it, and never derives one.
In Johannesburg, `toISOString().slice(0,10)` is yesterday until 02:00 — which
would file an entry written after midnight under the wrong day.

An entry keeps the date it was written on, for ever. Changing timezone does not
move history.

## Nothing exists until somebody writes it

Opening a date creates nothing. An editor cannot help producing `<p><br></p>`;
if that counted, the month grid would fill with days holding nothing and stop
meaning "here is where I wrote".

An entry is **meaningful** when any one of these is present: document text, a
custom title, a mood, an energy, a weather note, a location note, or a day
summary. Someone who recorded only "mood: low" on a hard day has written an
entry, and their calendar should say so.

## The title is optional

No title means the formatted date is the heading. **The date is never written
into the title column** — a title the user did not write would then be
searchable as if they had. No "Dear Diary" framing anywhere.

## Optional context, never a form

Mood, energy, weather, location and a short day summary. Collapsed by default,
every one nullable, every option carrying a text label. No row of faces, and
nothing to choose before you are allowed to write. Diary makes no health claim
and infers nothing from what you wrote.

## Archive, not delete

Archive is explicit and reversible. There is no permanent-delete route.

An archived entry **still holds its date**, deliberately: if it vacated the date,
writing there again would create a second row and orphan the first — a day
archived and then silently rebuilt on top of itself. Holding the date is what
lets the API refuse and offer to restore instead.

---

## What D1 does not do

- **No Legacy Diary migration.** No old entries, moods, images or notes were
  read, previewed or imported. Nothing from Legacy entered v2.
- **No AI.** No generated summaries, no semantic search, no inferred mood. The
  day summary exists partly so a future assisted recap has an input, and is
  written by hand.
- **No cross-system links yet.** `item_links` (F1) is the path Diary will use;
  D1 establishes Diary as a valid future source and target and builds no linking
  UI. A second Diary-specific link table would give the codebase two answers to
  "what relates to what".
- **No read-only day context.** Showing the day's completed Tasks, Calendar
  events and Habit ticks beside the entry is designed and **deferred** — see
  `technical-debt.md`. Writing and history were the mandatory half; a context
  panel that duplicates Today is worth doing carefully rather than quickly.
- **No uploads, no images in entries.** Waiting on Library upload storage.

## D2.1 additions

**Diary contains no Tasks, no Calendar events and no Habit details.** The only
connection to Habits runs the other way: Today asks Diary whether today has a
meaningful entry, for the computed `Write in Diary` row. See
`diary-v2-system-habit.md`.

**The writing surface is simplified.** The permanent formatting toolbar and the
block-style dropdown are gone — Diary is a place to begin writing, not a
document editor, and a ribbon over a journal page made the spread read as a
form. Storage is unchanged: existing entries with headings, subheadings, quotes
and lists render exactly as before, and the shared Enter/Backspace rules still
apply. What is gone is the way to create new block types by hand.

**Prompt and moment responses share one grammar.** A modest inset surface —
8px radius, 1px border, inner shadow, 46px minimum — that grows with its text
rather than scrolling inside itself. The old thin underline read as decoration
when empty and as ordinary page prose when filled; you could not tell an answer
from the paragraph above it.

**The spread grows.** `aspect-ratio` is a minimum, not a fixed frame. The grid
keeps both page backgrounds the same outer height, so the taller side sets the
spread and the gutter extends with it. Ordinary page scrolling replaces the
cramped internal wells.

**The streak left the right page** for Today's habits panel.
