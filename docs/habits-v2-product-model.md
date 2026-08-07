# Habits — product model

A habit is a **recurring intention with a completion history**. Deliberately not
a task: a task is finished once and gone; a habit is never finished, and its
value is the run rather than the tick.

Legacy tangled habits into `routineLog` beside diary journal text. v2 keeps
them apart, so each can be reasoned about on its own — and so that **diary text
can never become a habit completion by accident**. That rule survives D2.2
unchanged; what changed is that Diary can now be *asked* a question, which is a
different thing from Diary writing into habits.

---

## The system has two kinds of member

| | Stored habits | The computed Diary habit |
|---|---|---|
| lives in | `habits` + `habit_entries` | nowhere — derived on read |
| completed by | ticking | writing a diary entry that day |
| can be renamed | yes | no |
| can be reordered | yes | no — it is first, or absent |
| can be deleted | archive | turn the preference off |
| counts toward totals | yes | yes, when enabled |
| appears in history | yes | yes, when enabled |

Both are **members of one system**, and that is the whole point of D2.2 §6.

## One calculation, everywhere

`api/src/lib/diary-habit.ts` is the single provider. Today's panel, the Calendar
month cells, the Calendar day sheet, `GET /habits/history` and anything
statistical later all go through it. The client renders what the server returns
and computes nothing.

    GET …/habits?date=YYYY-MM-DD
      { habits: [...], diaryHabit: {...} | null, totals: { due, done } }

    GET …/habits/history?from&to
      { days: [{ date, due, done }], diarySeries: {...} | null }

    GET …/calendar/range?from&to
      { habitDays: [...], habitTotal, diaryDays: [...] }

### Why the server owns the total

D2.1's defect was not a rendering mistake. Today drew the computed row and then
summed `due.length`, and the computed row is not in `due` — so the screen said
`0/5` with the row above it visibly complete. Two calculations of "how many"
will eventually disagree, and the one people see is whichever is nearer the
screen. There is now one, and it is not on the client.

`habitTotals(ordinary, diary)` is the only place the two are added together.

### `date` is always sent, never derived

The client sends the **local civil day** it is drawing. `entry_date` is a `date`
column, not a timestamp. Deriving the day server-side is how a tick lands on the
wrong square — silently, near midnight, for some users only. The same rule Diary
and `habit-history.ts` live by.

---

## The Diary habit

### It is computed, and it always will be

There is no habit row and no `habit_entries` row behind `Write in Diary`, and
there never will be. Storing a parallel habit would give "did I write today?"
two answers that can disagree, and the one people would see is the copy.

Its id is `system:diary` — deliberately **not a UUID**, so a `check` or a
`PATCH` naming it is rejected on shape alone. There is nothing to tick and
nothing to rename, and an endpoint that accepted it would be lying.

### Completion

A day is complete when it holds a **meaningful** diary entry, decided by
`isMeaningfulEntry` — the same rule the write path uses. A row survives having
its content cleared (that is what makes restore possible), so counting rows told
people they had written on a day they had just emptied.

### When it is due

Today: **always**, when enabled. A diary habit that stops being due on the days
you have not written is a habit that is complete whenever you ignore it.

History: from the **first day you wrote**, which is the equivalent of an
ordinary habit's `createdAt`. `habit-history.ts` already refuses to count days
before a habit existed, for the same reason: a history screen that backfills
guilt for the years before you kept a diary is not worth looking at.

### It looks like the others (D2.2 §7)

Same row, same 32px ring drawn by the same SVG, same type, same spacing, same
hover, same completed appearance, same `streakHtml`. It is inside `.hb-list`,
first.

The `SYSTEM` badge is gone. What remains is only what behaves differently: a
quiet divider below it, a small diary mark, and "Automatic" as the title on both
controls. Pressing either opens today's Diary rather than toggling — a habit you
can mark done without doing it stops meaning anything.

The distinction explains the behaviour without inventing a component.

### The preference

`diaryHabit` — *"Count writing in Diary as a daily habit"*, in Settings →
Habits. Server-scoped, so it follows the account. Default **on**, and the
default is what makes it migration-safe: no row is written for a workspace that
never touches it.

Off means: absent from Today, excluded from every total, absent from the
Calendar series and the day sheet. **No diary content is affected in either
direction** — the habit is computed *from* diary content and no diary content is
computed from it, so the setting can be flipped for ever. Turning it back on
brings the whole history with it, derived, with nothing restored.

---

## What Habits still does not do

- **No streak pressure.** A run is stated, never demanded. No "don't break it",
  no loss language, no red.
- **No AI.** Nothing infers a habit from behaviour.
- **No habit inside Diary.** The connection runs one way only: Today and
  Calendar ask Diary whether a day holds writing. Diary shows no habits, no
  tasks and no events.

---

# D2.3 — the completion ring, and the boundary with Diary

## The ring closes

One component, `ringSvg(h)`, drawn identically for an ordinary habit and for the
computed `Write in Diary` row — neither builds its own `<circle>` any more,
which is what stops them drifting apart again.

**A complete ring has no dash at all.** `pathLength="100"` with
`stroke-dasharray="100"` makes the dash exactly one full turn, so its flat end
lands on its own start and the two butt caps antialias into a visible seam —
worst at high pixel density, where measured coverage fell to **0.6%** of the
surrounding stroke. Removing the dash makes the stroke a genuinely continuous
closed circle. Full detail and the four-DPR measurements are in
`animation-house-rules.md`.

Completion is read from `completedToday`, never from arithmetic: a 99.x% final
state is impossible because no percentage is consulted.

## A Diary check-in is not a habit

D2.3 added four passive daily dimensions to Diary — Nourishment, Movement,
Outside, Sleep. **None of them touches this system.**

|  | Diary check-in | Habit |
|---|---|---|
| is | an observation of how the day went | a behaviour you intend to repeat |
| chosen by | nobody — it is always asked | you, deliberately |
| stored in | `diary_entries.reflection.checkin` | `habits` + `habit_entries` |

    Movement = Very active   does NOT complete a Gym habit.
    Nourishment = Great      does NOT create an Eating Well habit.

**Gym belongs here, not in Diary**, and that is the clearest statement of the
boundary: going to the gym is something you decided to do and want to keep
doing. Movement is something that happens to everybody every day, in some
amount, whether or not they meant it.

Asserted with a test that inspects the database directly after a full check-in:
zero habit rows, zero habit entries, and the ordinary habit list byte-identical
before and after. The only thing that moves is `Write in Diary`, and it moves
because the day now holds writing — never because of what was recorded in it.

A future `Customize daily check-in` surface may allow a **deliberate** link
between a Diary dimension and a habit. That is the only sanctioned route, it
must be an explicit act in settings, and D2.3 builds none of it — see
`diary-v2-daily-checkin.md`.
