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

| | | |
|---|---|---|
| **Overall feeling** | 5 | Rough · Low · Steady · Good · Great, each with a face |
| **Energy** | 5 | Lowest → Highest, with a segmented meter |
| **Social battery** | 5 | Empty · Running low · OK · Good · Full, with a battery |
| **Daily Rhythm** | 4 × 4 | Nourishment · Movement · Outside · Sleep |

The counts are the rule, not a coincidence — see **5/5/5 and 4/4/4/4** below.

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

## Day Pulse — removed in D2.4

D2.3 drew three bars — Mind, Energy, Connection — each read straight off one of
the three core scales above it. **It is gone**, element and copy both.

It restated three answers the user had just given, one scroll-length below the
chips that gave them, and it did so in the language of a dashboard. Whatever it
was meant to be, what it actually did was re-present a selection as a
measurement. The three scales say it better, in the user's own words, and they
say it where the tap happened.

The reasoning below is kept because the constraints it records still bind
anything that might later summarise a day:

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

---

# D2.4 — consistency, colour and the three states

## 5/5/5 and 4/4/4/4

The three **core** check-ins have five options each. The four **Daily Rhythm**
rows have four each. There is no longer a scale with a different length to its
neighbour.

Before: feeling 5, energy 5, social 4, sleep 5, everything else 4. Nothing
depended on the mismatch, and nothing was gained by it — but the eye reads two
rows of different length as two rows that mean different amounts, so a four-step
Social battery next to a five-step Energy quietly implied the battery was the
coarser question. It was not.

| | Before | After |
|---|---|---|
| Social battery | 4 — Empty, Running low, Enough, Full | **5** — Empty, Running low, OK, Good, Full |
| Sleep | 5 | **4** — Rough, Poor, Fine, Rested |

Sleep lost a step rather than gaining one because Daily Rhythm is a four-row
block and the fifth option was the one nobody could distinguish from its
neighbour. Old `great` values still read correctly: `SLEEP_ALIAS` maps them to
`rested` on the way in, in both the server validator and the client, so no
stored day changes meaning and nothing had to be migrated.

The battery's fill still comes from `index / (length - 1)` and nothing else, so
five states are 0 / 25 / 50 / 75 / 100% by construction — measured shell 30×13
in every state, fill steps even to a quarter-pixel.

## One grid, not four rows that each guess their own width

Every option row — core and rhythm — is a CSS grid of equal tracks:

    .dia-chips        { grid-template-columns: repeat(auto-fit, minmax(52px, 1fr)) }
    .dia-chips-rhythm { grid-template-columns: repeat(auto-fit, minmax(42px, 1fr)) }

and every Daily Rhythm row is `display: contents` inside **one** parent grid, so
all four rows share a single label column and a single option column. The four
labels line up because they are the same track, not because four separate
paddings were tuned to agree.

That fixed the overlap: `Nourishment` needs 98px and the old fixed label column
was 66px with `overflow: visible`, so 24.3px of painted text sat on top of the
first chip. A wider fixed column would have fixed that one word and waited for
the next one. A shared track cannot have the problem.

### The 42px minimum is load-bearing

`auto-fit` with a minimum that does not fit **wraps**, and a wrapped rhythm row
is not a cosmetic problem. At 1280×900 the rhythm's option track is 183.4px;
a 44px minimum needs 4 × 44 + 3 gaps = 188, so only three chips fitted and the
fourth dropped to a second line — in all four rows. That cost the right page
130px and pushed a **blank** spread 24px past the composer. 4 × 42 + 12 = 180
fits, and 42px still holds `Rested` without an ellipsis.

Measured on a genuinely blank day (no writing, no selections) at 1280×900 with
the page unscrolled:

| | wrapped (44px) | fixed (42px) |
|---|---|---|
| check-in block | 678 | **550** |
| Daily Rhythm | 261 | **133** |
| rhythm lines per row | 2 | **1** |
| spread | 724 | **685** |
| clearance above the composer | **−24** | **+15** |

## Colour hierarchy

Four hues, assigned per group and used for **selection only**:

| | |
|---|---|
| Overall feeling | `--ci-lav` `#B69BF0` |
| Energy | `--ci-blu` `#8FA6F5` |
| Social battery | `--ci-tea` `#7FC6D9` |
| Daily Rhythm | `--ci-neu` `#A79ECB` |

Each group sets `--ci` and every state inside it reads that one variable, so a
group cannot end up half-recoloured. The hues distinguish *which question you
are answering*; they never rank an answer. There is no green-good / red-bad
anywhere on this page, and the option a hue lands on says nothing about whether
the day went well.

The unselected chip carries no hue at all — it is the surface plus a hairline.
The page reads as one material with a few lit points, not as a paint chart.

## Hover, selected and focused are three different things

They were two, and the weaker two looked alike: a hover that lifted and lightened
was easy to mistake for a selection, especially while dragging a pointer across a
row looking for the right word.

| State | Signal |
|---|---|
| hover | background → 8.5% white, border → 20% white, `translateY(-1px)` |
| **selected** | filled with `--ci`, dark text, weight 600, a soft `--ci` shadow, and a shape mark (`::after`) |
| selected + hover | stays filled, `brightness(1.1)` — it never falls back to the hover look |
| focused | `2px` accent outline, `outline-offset: 2px`, on `:focus-visible` only |

Selection is the only state that changes **fill**; hover only changes surface.
And because selection also carries a `::after` shape, it survives greyscale,
which hover deliberately does not — hover is transient and does not need to.

Focus is drawn with the app accent, not with `--ci`, so keyboard position is
never confused with a chosen value. One tab stop per group, arrows within.

## Every option shows what it means

The chips now carry the same drawing the answer will later be shown with:
a face on Overall feeling, a segmented meter on Energy, a battery on Social.
`optionPreview()` is the single place that decides which, and it returns the
same components History uses, so the vocabulary is learned once and never
contradicts itself.

Rhythm chips stay text-only. Four rows × four icons is a texture, not a
legend, and the rows are already labelled.

## Type size

10px, down from 11. Sixteen labels truncated at 11px once the core rows went to
five options; at 10px with tighter padding, **zero** truncate at any width down
to the container-query breakpoint. Below that the label stacks above its options
instead, which gives the chips the full page width rather than squeezing them
further.
