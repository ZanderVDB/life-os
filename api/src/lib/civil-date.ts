/**
 * Civil dates — the one place a day is worked out from words.
 *
 * ── The bug this exists to end ───────────────────────────────────────────
 *
 * The planner was told "Today is 2026-09-01." and asked to turn "Saturday"
 * into a date. To do that it must first work out that 2026-09-01 is a
 * Tuesday, then count forward — calendar arithmetic done in a language model's
 * head, and wrong about half the time. The same sentence produced
 * `Saturday means 2026-09-05` in one run and `Saturday means 2026-09-06` in
 * the next. Nothing downstream could tell which was right, because both are
 * valid ISO dates.
 *
 * There were already two date resolvers in the codebase — one in the fast
 * path and, effectively, one inside the model. Now there is one, here, and
 * the model is handed the ANSWER rather than asked for it.
 *
 * ── A civil date is not an instant ───────────────────────────────────────
 *
 * "2026-09-05" is a day on a wall calendar. It has no time and no zone, and
 * converting it to an instant to do arithmetic is how it moves. So every
 * function here treats an ISO date as a bare label, anchors it at UTC midnight
 * purely as a stable frame for counting days, and returns a label again. The
 * anchor never leaks: no value produced here has a time or an offset.
 *
 * The one place a real zone matters is deciding what day it is NOW, and that
 * is `todayIn` — which asks Intl, not `toISOString()`. `new
 * Date().toISOString().slice(0, 10)` is the UTC day, and for anyone east of
 * Greenwich after midnight it is tomorrow.
 */

export const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A stable frame for counting days. Never returned, never rendered. */
const anchor = (iso: string) => new Date(`${iso}T00:00:00Z`);

export const isCivilDate = (v: unknown): v is string =>
  typeof v === 'string' && ISO.test(v) && !Number.isNaN(anchor(v).getTime());

/**
 * What day is it where the user is?
 *
 * `en-CA` because it formats as `YYYY-MM-DD`, which is the shape everything
 * else here speaks. An unknown or missing zone falls back to UTC — wrong by at
 * most a day for somebody who sent no zone, rather than throwing.
 */
export function todayIn(timeZone?: string | null, now: Date = new Date()): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(now);
    } catch { /* an invalid zone is not worth failing a request over */ }
  }
  return now.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = anchor(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday, matching `Date.getUTCDay`. */
export const weekdayIndex = (iso: string): number => anchor(iso).getUTCDay();

export const weekdayOf = (iso: string): Weekday => WEEKDAYS[weekdayIndex(iso)]!;

/** Does this date actually fall on the day it was called? */
export const isWeekday = (iso: string, name: string): boolean =>
  isCivilDate(iso) && weekdayOf(iso) === name.toLowerCase();

/** "Saturday 5 September 2026" — for a card, an assumption, a prompt. */
export function longDate(iso: string): string {
  if (!isCivilDate(iso)) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(anchor(iso));
}

/* ══ Words to a day ══════════════════════════════════════════════════════ */

export type ResolvedDate = {
  date: string;
  /** The words consumed, so a caller can strip them from a title. */
  matched: string;
  /** Which rule fired. Named so a test can assert the reading, not the date. */
  kind: 'explicit' | 'today' | 'tomorrow' | 'yesterday' | 'offset' | 'weekday' | 'weekend';
  /** For `weekday` and `weekend`: the day named, so it can be checked later. */
  weekday?: Weekday;
};

const DAY_WORDS = WEEKDAYS.join('|');

/**
 * The relative-date vocabulary Life OS is willing to be certain about.
 *
 * Deliberately small. Everything it does not recognise returns null, and the
 * caller either asks or falls through to the planner — a reminder on the wrong
 * day is worse than one that took a moment longer to propose.
 *
 * ── The weekday rule, stated once ────────────────────────────────────────
 *
 *   "Friday"        the NEXT Friday, and never today. Somebody saying "remind
 *                   me Friday" on a Friday means the one that has not
 *                   happened yet.
 *   "this Friday"   the same thing. In ordinary speech "this Friday" is the
 *                   coming one, and treating it as "today, if today is
 *                   Friday" produces a reminder that has already passed.
 *   "next Friday"   the Friday of the FOLLOWING week — seven days later than
 *                   plain "Friday". This is the one genuinely contested
 *                   reading in English; Life OS picks the later one, states
 *                   it on the card, and lets the user correct it there.
 *
 * Month and year boundaries need no special handling: everything is day
 * arithmetic on a real calendar, so 31 December + 1 is 1 January.
 */
export function resolveRelativeDate(text: string, today: string): ResolvedDate | null {
  if (!isCivilDate(today)) return null;
  const t = String(text ?? '').toLowerCase();

  const explicit = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (explicit && isCivilDate(explicit[1]!)) {
    return { date: explicit[1]!, matched: explicit[0], kind: 'explicit' };
  }

  if (/\btoday\b/.test(t)) return { date: today, matched: 'today', kind: 'today' };
  if (/\btonight\b/.test(t)) return { date: today, matched: 'tonight', kind: 'today' };
  if (/\btomorrow\b/.test(t)) {
    return { date: addDays(today, 1), matched: 'tomorrow', kind: 'tomorrow' };
  }
  if (/\byesterday\b/.test(t)) {
    return { date: addDays(today, -1), matched: 'yesterday', kind: 'yesterday' };
  }

  const inDays = t.match(/\bin (\d{1,3}) days?\b/);
  if (inDays) {
    return { date: addDays(today, Number(inDays[1])), matched: inDays[0], kind: 'offset' };
  }
  const inWeeks = t.match(/\bin (\d{1,2}) weeks?\b/);
  if (inWeeks) {
    return { date: addDays(today, Number(inWeeks[1]) * 7), matched: inWeeks[0], kind: 'offset' };
  }

  /* "This weekend" is Saturday. Not Sunday, and not "Saturday and Sunday" —
     a date field holds one day, and the earlier one is what people mean. */
  const weekend = t.match(/\b(?:this |next |the )?weekend\b/);
  if (weekend) {
    const next = t.includes('next weekend');
    const base = nextWeekday(today, 'saturday');
    return {
      date: next ? addDays(base, 7) : base,
      matched: weekend[0],
      kind: 'weekend',
      weekday: 'saturday',
    };
  }

  const day = t.match(new RegExp(`\\b(on |next |this |come )?(${DAY_WORDS})\\b`));
  if (day) {
    const name = day[2] as Weekday;
    const base = nextWeekday(today, name);
    const isNext = (day[1] ?? '').trim() === 'next';
    return {
      date: isNext ? addDays(base, 7) : base,
      matched: day[0],
      kind: 'weekday',
      weekday: name,
    };
  }
  return null;
}

/** The next occurrence of a weekday, strictly after `today`. */
export function nextWeekday(today: string, name: Weekday): string {
  const want = WEEKDAYS.indexOf(name);
  const from = weekdayIndex(today);
  const delta = ((want - from + 7) % 7) || 7;
  return addDays(today, delta);
}

/**
 * The next fortnight, resolved.
 *
 * This is what the planner is given instead of being asked to do calendar
 * arithmetic: "Saturday" stops being a computation and becomes a lookup in a
 * table it can see. Two weeks covers every relative phrase in the vocabulary
 * above except an explicit date, which needs no help.
 */
export function calendarWindow(today: string, days = 14): { date: string; weekday: string }[] {
  const out: { date: string; weekday: string }[] = [];
  for (let i = 0; i <= days; i += 1) {
    const date = addDays(today, i);
    out.push({ date, weekday: weekdayOf(date) });
  }
  return out;
}

/**
 * Every weekday NAME appearing in some words, for checking a resolved date.
 *
 * The semantic half of the problem: a payload saying `2026-09-06` beside a
 * card saying "Saturday" is valid ISO and wrong, and only the weekday name
 * makes it checkable. Weekday names are used because they are unambiguous —
 * unlike prose in general, there is exactly one right answer to "is this date
 * a Saturday".
 */
export function weekdayNamesIn(text: string): Weekday[] {
  const found = String(text ?? '').toLowerCase().match(new RegExp(`\\b(${DAY_WORDS})\\b`, 'g'));
  return [...new Set((found ?? []) as Weekday[])];
}
