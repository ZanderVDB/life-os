/**
 * The computed `Write in Diary` habit — ONE provider, every screen.
 *
 * ── What was wrong ───────────────────────────────────────────────────────
 *
 * D2.1 built the row on Today by asking `/diary/streak` and drawing something
 * that looked like a habit. It was not part of the habit SYSTEM: Today still
 * said `0/5` with the diary written, because the total came from the ordinary
 * habit rows and this was drawn above them. Calendar knew nothing about it at
 * all. A habit you can see completed while the counter beside it says you have
 * done nothing is worse than no habit.
 *
 * So §6 asks for one calculation, and this is it. Today's totals, the Calendar
 * day totals, the Calendar history series and anything statistical later all
 * come through here. There is deliberately no second implementation in the web
 * client: the client renders what this returns and computes nothing.
 *
 * ── Why it is still computed and not a row ───────────────────────────────
 *
 * Storing a parallel habit would give "did I write today?" two answers that can
 * disagree, and the one people see would be the copy. There is no habit row and
 * no `habit_entries` row; there never will be. Consequences, all deliberate:
 * it cannot be renamed, reordered, deleted or ticked, and turning the setting
 * off removes it from every total without touching a single diary entry.
 *
 * ── Dates are strings, and stay strings ──────────────────────────────────
 *
 * The same rule as habit-history.ts and Diary itself: the caller sends the
 * LOCAL civil day it is drawing. Nothing here turns a day into an instant.
 */
import { isMeaningfulEntry, addDays } from './diary-entry.js';
import type { HabitDay } from './habit-history.js';

/**
 * The id this habit answers to.
 *
 * Deliberately not a UUID. Every real habit id is one, so a `check` or `delete`
 * naming this can be rejected by shape alone — there is nothing to tick and
 * nothing to remove, and an endpoint that accepted it would be lying.
 */
export const DIARY_HABIT_ID = 'system:diary';
export const DIARY_HABIT_NAME = 'Write in Diary';

/** The preference that turns it on. Named once, here. */
export const DIARY_HABIT_PREFERENCE = 'diaryHabit';

/** Whether the preference map has it enabled. Absent means on. */
export const diaryHabitEnabled = (prefs: Record<string, string> | null | undefined): boolean =>
  (prefs?.[DIARY_HABIT_PREFERENCE] ?? 'on') !== 'off';

/** The shape this module needs from a diary row. Deliberately narrow. */
export type DiaryRowForHabit = {
  entryDate: string;
  document: unknown;
  title: string | null;
  mood: string | null;
  energy: string | null;
  weatherNote: string | null;
  locationNote: string | null;
  daySummary: string | null;
  reflection: unknown;
};

/**
 * The days that hold a MEANINGFUL entry.
 *
 * Not "the days that have a row". A row survives having its content cleared —
 * that is what makes restore possible — so counting rows told somebody they had
 * written on a day they had just emptied, and the habit stayed complete. The
 * rule is `isMeaningfulEntry`, the same one the write path uses.
 */
export function writtenDays(rows: DiaryRowForHabit[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (isMeaningfulEntry(r.document as any, {
      title: r.title,
      mood: r.mood,
      energy: r.energy,
      weatherNote: r.weatherNote,
      locationNote: r.locationNote,
      daySummary: r.daySummary,
      reflection: r.reflection as any,
    })) out.add(r.entryDate);
  }
  return out;
}

/**
 * The run of consecutive written days ending today — or yesterday.
 *
 * Yesterday counts as the end, deliberately: a streak is not broken at one
 * minute past midnight, before the day has been had.
 */
export function diaryStreak(written: Set<string>, today: string) {
  const wroteToday = written.has(today);
  let cursor = wroteToday ? today : addDays(today, -1);
  let current = 0;
  while (written.has(cursor)) { current += 1; cursor = addDays(cursor, -1); }
  return { current, wroteToday };
}

/**
 * The first day this habit counts as due.
 *
 * The equivalent of a habit's `createdAt`, and it exists for the same reason
 * habit-history.ts refuses to count days before a habit existed: a history
 * screen that backfills guilt for the years before you kept a diary is not
 * worth looking at. Today is always due — that is the point of the row —
 * so the answer is the earlier of "the first day you wrote" and today.
 */
export function diaryHabitSince(written: Set<string>, today: string): string {
  let first = today;
  for (const d of written) if (d < first) first = d;
  return first;
}

/** The row Today draws. Shaped like a habit because it behaves like one. */
export function diaryHabitRow(written: Set<string>, today: string) {
  const { current, wroteToday } = diaryStreak(written, today);
  return {
    id: DIARY_HABIT_ID,
    name: DIARY_HABIT_NAME,
    kind: 'diary' as const,
    /* Always. A diary habit that stops being due on the days you have not
     * written is a habit that is complete whenever you ignore it. */
    dueToday: true,
    completedToday: wroteToday,
    todayCount: wroteToday ? 1 : 0,
    targetCount: 1,
    streak: current,
    /** Where the completion circle goes, since there is nothing to tick. */
    route: '#diary',
  };
}

/**
 * Folds the diary series into per-day habit totals.
 *
 * Returns a NEW array; `habitHistory`'s output is not mutated. Days before the
 * habit's first written day are returned untouched, which is what keeps an
 * eight-year-old Calendar month from suddenly reading `3/4` instead of `3/3`.
 */
export function addDiaryToHabitDays(
  days: HabitDay[],
  written: Set<string>,
  { enabled, since }: { enabled: boolean; since: string },
): HabitDay[] {
  if (!enabled) return days;
  return days.map((d) => (d.date < since ? d : {
    date: d.date,
    due: d.due + 1,
    done: d.done + (written.has(d.date) ? 1 : 0),
  }));
}

/**
 * Today's totals, ordinary habits plus the computed one.
 *
 * §6's example, in code: five ordinary habits and an enabled diary habit is a
 * total of six, and writing only the diary shows 1/6.
 */
export function habitTotals(
  ordinary: { dueToday: boolean; completedToday: boolean }[],
  diary: { dueToday: boolean; completedToday: boolean } | null,
) {
  const due = ordinary.filter((h) => h.dueToday);
  let total = due.length;
  let done = due.filter((h) => h.completedToday).length;
  if (diary?.dueToday) {
    total += 1;
    if (diary.completedToday) done += 1;
  }
  return { due: total, done };
}
