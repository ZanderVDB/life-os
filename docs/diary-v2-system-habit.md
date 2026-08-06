# `Write in Diary` — the computed system habit

## What it is

A row pinned above the ordinary habits in Today. It is **computed, not stored**.

There is no `habits` row and no `habit_entries` row behind it. Its completion is
whether today holds a meaningful Diary entry; its streak is the run of such days
ending today or yesterday. Both come from `GET /diary/streak`.

## Why computed

Storing a parallel habit would give "did I write today?" two answers that can
disagree — and the one people would see is the copy. **Diary is the only source
of truth**, and Today asks it.

Every constraint the phase asked for falls out of that, rather than being
enforced:

| Requirement | How it holds |
|---|---|
| cannot be deleted | there is nothing to delete |
| cannot be renamed | the name is a string in the renderer |
| cannot be reordered below ordinary habits | it is not in the list; it is above it |
| cannot be manually completed | there is no entry to write |
| no duplicate habit data | nothing is written at all |

## Completing it means writing something

The whole row — including the ring — opens today's Diary. A habit you can mark
done without doing it is a habit that stops meaning anything, so there is no
toggle to press.

## The bug this section exists because of

The streak counted **rows**, not meaningful ones.

A diary row survives having its content cleared — that is precisely what makes
`restore` possible — so a day somebody had just emptied still counted, and the
habit stayed complete. Verified: writing → `current: 1, wroteToday: true`;
clearing → `current: 0, wroteToday: false` while `daysInWindow` stays 1, so the
row is still there.

The fix filters with `isMeaningfulEntry`, the **same function the write path
uses**. Re-implementing the rule in SQL would have given the question two
answers again, one layer down.

A day recorded only as a mood still counts — verified.

## Tone

`3 day streak`, stated and nothing more. A zero says nothing at all. A diary
that punishes the weeks you could not write is a diary you stop opening during
the weeks that matter.

## Historical habit views

Diary completion is a **computed series**, derived on read from `diary_entries`.
It is never materialised into `habit_entries`. Any future history view must ask
Diary for the range rather than joining habit data.

---

# D2.2 — it joined the system

## The defect

The row was drawn on Today and was not **in** the habit system. Today reported
`0/5` with `Write in Diary` visibly complete, because the total was
`due.length` and the computed row is not in `due`. Calendar knew nothing about
it at all.

A habit you can see completed while the counter beside it says you have done
nothing is worse than no habit.

## One provider

`api/src/lib/diary-habit.ts`. Today's totals, the Calendar day totals, the
Calendar history series, the day sheet and `/diary/streak` all come through it.
There is deliberately **no second implementation in the web client** — the
client renders what the server returns and computes nothing.

    writtenDays(rows)                  meaningful days, by isMeaningfulEntry
    diaryStreak(written, today)        the run ending today, or yesterday
    diaryHabitSince(written, today)    the first day it counts as due
    diaryHabitRow(written, today)      the row Today draws
    addDiaryToHabitDays(days, …)       folds the series into per-day totals
    habitTotals(ordinary, diary)       the ONE sum

`habitTotals` is the only place ordinary habits and the computed one are added
together. §6's example holds: five ordinary plus an enabled Diary habit is six,
and writing only the diary shows `1/6`.

## Due from when you started

Today is always due — that is the point of the row. History is due from the
**first day you wrote**, the equivalent of an ordinary habit's `createdAt`.
`habit-history.ts` already refuses to count days before a habit existed, and a
history screen that backfills guilt for the years before you kept a diary is not
worth looking at.

## The preference

`diaryHabit`, default **on**. Off removes it from Today, from every total and
from the Calendar series — and touches **no diary data in either direction**.
Verified: with the setting off, `/diary/streak` still answered `current 1,
wroteToday true`, and re-enabling restored the whole history derived, with
nothing to restore.

## Visual parity

Same row, same 32px ring markup, same type, same spacing, same hover, same
completed appearance, same `streakHtml`. Inside `.hb-list`, first. The `SYSTEM`
badge is gone.

Measured: the Diary row and every ordinary row are **46px tall with a 32×32
ring**. What remains different is a quiet divider, a small diary mark, and
"Automatic" as the title — which explains the behaviour without inventing a
component.
