/**
 * Per-day habit history: how many habits were due, and how many were done.
 *
 * ONE implementation, used by both `GET /habits/history` and the Calendar range
 * endpoint. They were about to compute this differently — the Calendar version
 * counted any entry row as "done" and used a flat habit count as the
 * denominator, so a habit due on Mondays counted against every Sunday, and a
 * 3-of-3 habit ticked once read as complete. Two answers to "3 of what?" is
 * worse than either answer alone.
 *
 * ── Dates are strings here, and stay strings ──────────────────────────────
 *
 * `entry_date` is a `date` column. The caller sends the LOCAL day it is
 * drawing. Nothing in this file converts a day into an instant, because that is
 * exactly how a tick lands on the wrong square: parse "2026-08-03" as a Date in
 * a browser at UTC-5 and you get the 2nd. It fails silently, near midnight,
 * for some users only.
 *
 * The single unavoidable Date is the weekday for `specific_days` habits, and it
 * is built at NOON UTC so no offset on earth can push it a day either way.
 */

/** A day counter, not a timestamp. UTC midnights, stepped by exact days. */
const DAY_MS = 86_400_000;

export type HabitForHistory = {
  id: string;
  targetCount: number;
  frequencyType: string;
  frequencyConfig: unknown;
  createdAt: Date | null;
};

export type EntryForHistory = {
  habitId: string;
  entryDate: string;
  completedCount: number;
};

export type HabitDay = { date: string; due: number; done: number };

/** Whether a habit asks to be ticked on a given day. */
export function dueOn(habit: HabitForHistory, date: string): boolean {
  const cfg = (habit.frequencyConfig ?? {}) as { days?: number[] };
  switch (habit.frequencyType) {
    case 'specific_days': {
      // 0 = Sunday, matching getUTCDay(). An empty list means "no day", not
      // "every day" — guessing the opposite would show a habit the user muted.
      if (!Array.isArray(cfg.days)) return false;
      return cfg.days.includes(new Date(`${date}T12:00:00Z`).getUTCDay());
    }
    // A weekly target can be ticked on any day of its week.
    case 'weekly':
    case 'times_per_week':
    case 'daily':
    default:
      return true;
  }
}

/**
 * One row per day between `from` and `to` inclusive.
 *
 * A habit created after a day was not due on it, so days before a habit existed
 * do not count it as missed. Backfilling guilt for a habit that did not exist
 * yet is the fastest way to make a history screen not worth looking at.
 */
export function habitHistory(
  habits: HabitForHistory[],
  entries: EntryForHistory[],
  from: string,
  to: string,
): HabitDay[] {
  const byDate = new Map<string, Map<string, number>>();
  for (const e of entries) {
    const day = byDate.get(e.entryDate) ?? new Map<string, number>();
    day.set(e.habitId, e.completedCount);
    byDate.set(e.entryDate, day);
  }

  const born = new Map(habits.map((h) => [
    h.id, h.createdAt ? h.createdAt.toISOString().slice(0, 10) : null,
  ]));

  const days: HabitDay[] = [];
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= Date.parse(`${to}T00:00:00Z`); ms += DAY_MS) {
    const date = new Date(ms).toISOString().slice(0, 10);
    const counts = byDate.get(date);
    let due = 0;
    let done = 0;
    for (const h of habits) {
      // An entry that already exists always counts, whatever the rules say.
      //
      // Two cases this covers, and both look like a bug without it: a habit
      // created today and then ticked for last Thursday (the tick lands, the
      // square stays blank, and the user tries again), and imported history
      // that predates the habit record it belongs to.
      //
      // The user ticking a day IS the evidence that it counted. A frequency
      // rule is a default about the future, not a veto over the past.
      const ticked = counts?.has(h.id) ?? false;
      if (!ticked) {
        const start = born.get(h.id);
        if (start && start > date) continue;
        if (!dueOn(h, date)) continue;
      }
      due++;
      // `>= targetCount`, not "has a row". A habit with a target of 3 ticked
      // once is in progress, not done.
      if ((counts?.get(h.id) ?? 0) >= h.targetCount) done++;
    }
    days.push({ date, due, done });
  }
  return days;
}
