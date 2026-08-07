# Diary — the daily check-in

> **LEFT PAGE = THINGS YOU WRITE. RIGHT PAGE = THINGS YOU TAP.**

That is the product rule, locked in D2.3. It decides every question this page
raises, and it is the reason the right page has no text field of any kind.

---

## Why the rule exists

D2.2 put four editable "Moment" tiles on the right page — Highlight, A win,
Challenge, Grateful for. They looked like controls and behaved like a form:
they opened the keyboard, they competed with the writing across the gutter, and
they turned a fast check-in into a check-in with an essay at the end.

A right page you can finish **without opening the keyboard** is a right page you
finish. Ten to twenty seconds, with a thumb.

The four lines were not deleted. Anything already written into one now appears
as a guided prompt on the **left** page, keeping its original storage key so no
data had to move. A fresh day is not offered them: the five standing prompts
already ask the same questions, and nine prompts is not a diary, it is a form.

## What the right page contains

| | |
|---|---|
| **Day Pulse** | three bars — Mind, Energy, Connection |
| **Overall feeling** | Rough · Low · Steady · Good · Great, each with a face, opening into five precise words |
| **Energy** | five levels, with a segmented meter |
| **Social battery** | four levels, with a battery |
| **Day rhythm** | Nourishment · Movement · Outside · Sleep |

Every one is optional. Nothing gates the writing, and no interaction is
required before a day counts as meaningful.

---

## The feeling faces

Five expressions from **one system**: a 20×20 circle, a 1.7 stroke, and only
the mouth and brows change between them. Not emoji — an emoji set is somebody
else's drawing, renders differently on every platform, and would be the single
thing on the page not drawn in the app's own hand.

The **icon supports the label; it never replaces it**. Every chip shows its
word. History reuses this exact component (`face()`), so the vocabulary is
learned once.

## The social battery, and the geometry it needed

D2.2 drew one **cell** per level and lit them cumulatively. The lit width
therefore depended on how many inter-cell gaps fell inside it — two cells plus
one gap is not twice one cell — so the two middle states were not evenly spaced
and read as almost the same amount.

The shell is now fixed and holds **one continuous fill** whose width is a
percentage of the inner track, taken straight from `index / (length - 1)`:

| | Empty | Running low | Enough | Full |
|---|---|---|---|---|
| fill | 0% | 33% | 67% | 100% |

Measured in a browser: shell **30×13 in every state**, fill 0 / 7.91 / 16.08 /
24px, steps of 7.91 / 8.17 / 7.92 — even to a quarter-pixel, and monotonic by
construction because only the fill's width changes.

## Day Pulse — a snapshot, not a grade

Three bars, each read straight off its own scale:

    Mind        ← Overall feeling
    Energy      ← Energy
    Connection  ← Social battery

**There is no total, no percentage, no average and no score.** Nothing sums or
combines the three, and no colour on the page means "good" or "bad". A diary
that grades you is a diary you start performing for.

A dimension nobody answered is drawn as an **empty track**, not as zero. "I did
not say" and "it was the lowest it goes" are different answers, and drawing
them the same way would put words in somebody's mouth.

---

## Passive dimensions are NOT habits

This is the boundary the whole feature rests on.

|  | Diary check-in | Habit |
|---|---|---|
| is | an observation of how the day went | a behaviour you intend to repeat |
| chosen by | nobody — it is always asked | you, deliberately |
| lives in | `diary_entries.reflection.checkin` | `habits` + `habit_entries` |
| completing it | describes the past | is the point |

    Movement = Very active   does NOT complete a Gym habit.
    Nourishment = Great      does NOT create an Eating Well habit.

Nothing here writes a `habit_entries` row. Nothing here moves a habit total.
Asserted in a test that inspects the database directly after a full check-in.

**Gym is deliberately absent.** It is an intentional activity and belongs to
Habits — that is exactly what a habit is for. Movement is universal and
descriptive, which is why it belongs here: everybody moves some amount every
day whether or not they meant to.

The one thing Diary does feed is the computed `Write in Diary` habit, and it
turns on whether you **wrote**, never on what you recorded.

## The wording, and why it is shorter than the brief

§7 allowed refinement if measurement showed the labels needed it, and it did:
"Barely moved" and "Some time" wrapped their rows onto two lines, costing the
right page 76px each and pushing the spread below the fold.

| Stored id | Chip | Full wording (screen reader, tooltip, History) |
|---|---|---|
| `barely` | Barely | Barely moved |
| `very_active` | A lot | Very active |
| `little` | A bit | A little |
| `some` | Some | Some time |

The short form is the chip only. `aria-label` and `title` carry the full
wording, so nothing is lost.

---

## Interaction rules

- **Every selection can be un-chosen.** A control you cannot un-choose has
  trapped you into an answer you did not mean.
- **A selection patches one `<section>`**, never the page — and never the left
  page, where the caret may be. Verified: the caret held at the same offset
  through every interaction on this page.
- **The local copy is authoritative** until the server answers, so a tap shows
  immediately and no interaction can produce a false "Saved".
- **Chips are `radiogroup`s** with a roving tabindex: one tab stop per group,
  arrow keys within it.
- **Reduced motion** is honoured globally, and because nothing here owns a
  final state, reducing every duration to 1ms cannot break the layout.

## Motion budget (§11)

| | |
|---|---|
| broad feeling | 140ms |
| precise expansion | 200ms |
| Day Pulse | 200ms |
| energy meter | 140ms |
| social battery | 200ms |
| passive selection | 140ms |

Nothing loops, bounces or celebrates. A selection should feel answered, not
rewarded.

---

## Future: `Customize daily check-in` — documented, not built

D2.3 deliberately builds none of this. Recorded so the shape is known:

- enable or disable individual passive trackers
- reorder them
- add further reflection dimensions
- **deliberately** link a dimension to an ordinary Habit

That last one is the only sanctioned route from a check-in to a habit, and it
must be an explicit act in a settings surface. There is **no `+ Add habit`
beside a Diary tracker**, and there must not be: that would mix configuring
your reflection with doing it, in the place you do it every day.
