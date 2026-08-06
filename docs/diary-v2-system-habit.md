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
