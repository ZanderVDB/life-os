/**
 * Reminder recurrence expansion.
 *
 * THE PROBLEM THIS SOLVES
 * A reminder stores ONE canonical due date. That is correct as state — it is
 * the occurrence you are being asked about right now — but it meant September's
 * "pay salaries" was invisible until August's had been ticked off. A calendar
 * that cannot show you next month is not a calendar.
 *
 * So the stored row stays canonical, and views expand the rule into VIRTUAL
 * occurrences for whatever range they are showing. Nothing extra is written to
 * the database: materialising future rows would mean every edit had to chase
 * down and rewrite an unbounded set of them, and a missed one becomes a
 * reminder that fires on a date its own rule no longer agrees with.
 *
 * All dates are plain calendar dates ('YYYY-MM-DD'), never UTC instants.
 * Converting through UTC shifts the day for anyone east or west of Greenwich,
 * which for a reminder on the 1st of the month means it lands in the wrong one.
 */

export interface RecurrenceRule {
  frequency: string;          // DAILY | WEEKLY | MONTHLY | YEARLY
  interval: number;
  byWeekday?: number[] | null;
  byMonthDay?: number[] | null;
  until?: string | null;
  count?: number | null;
}

export interface Occurrence {
  /** The date this occurrence falls on. */
  date: string;
  /** False for the stored row, true for one derived from the rule. */
  isVirtual: boolean;
}

/** How far expansion will ever run, as a guard against a pathological rule. */
const MAX_OCCURRENCES = 400;

const parse = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  + `-${String(d.getDate()).padStart(2, '0')}`;

/** Last day of the month containing `d` — used to clamp "the 31st". */
const lastDayOf = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

/**
 * The next date strictly after `fromIso`.
 *
 * Exported because completion uses the same function the expansion does; two
 * implementations of "what comes next" is how a calendar starts disagreeing
 * with itself.
 */
export function nextAfter(fromIso: string, rule: RecurrenceRule): string {
  const step = Math.max(1, rule.interval || 1);
  const at = parse(fromIso);

  if (rule.frequency === 'DAILY') {
    at.setDate(at.getDate() + step);
    return fmt(at);
  }

  if (rule.frequency === 'WEEKLY') {
    const days = (rule.byWeekday?.length ? [...rule.byWeekday] : [at.getDay()])
      .slice().sort((a, b) => a - b);
    const later = days.find((n) => n > at.getDay());
    if (later !== undefined) {
      at.setDate(at.getDate() + (later - at.getDay()));
      return fmt(at);
    }
    // Wrap to the first listed day, `interval` weeks on.
    at.setDate(at.getDate() + (7 * step) - (at.getDay() - days[0]!));
    return fmt(at);
  }

  if (rule.frequency === 'MONTHLY') {
    const target = rule.byMonthDay?.length ? rule.byMonthDay[0]! : at.getDate();
    const next = new Date(at.getFullYear(), at.getMonth() + step, 1);
    // "The 31st" in a 30-day month is the 30th, not the 1st of the month after,
    // which is what unclamped date arithmetic produces.
    next.setDate(Math.min(target, lastDayOf(next.getFullYear(), next.getMonth())));
    return fmt(next);
  }

  const next = new Date(at.getFullYear() + step, at.getMonth(), 1);
  next.setDate(Math.min(at.getDate(), lastDayOf(next.getFullYear(), next.getMonth())));
  return fmt(next);
}

/**
 * Every occurrence of a reminder that falls inside [from, to].
 *
 * `anchor` is the reminder's stored due date — the canonical occurrence. Dates
 * before it are not generated: a reminder created today did not "occur" last
 * year, and inventing history would make an overdue count meaningless.
 */
export function expand(
  anchor: string,
  rule: RecurrenceRule | null,
  from: string,
  to: string,
): Occurrence[] {
  // No rule: the reminder exists once, on its own date.
  if (!rule) {
    return anchor >= from && anchor <= to ? [{ date: anchor, isVirtual: false }] : [];
  }

  const out: Occurrence[] = [];
  let cursor = anchor;
  let emitted = 0;

  // The stored date itself, when it lands in range.
  if (cursor >= from && cursor <= to) out.push({ date: cursor, isVirtual: false });

  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const next = nextAfter(cursor, rule);
    // A rule that fails to advance would spin forever.
    if (next <= cursor) break;
    cursor = next;
    emitted++;

    if (rule.until && cursor > rule.until) break;
    if (rule.count && emitted >= rule.count) {
      if (cursor >= from && cursor <= to) out.push({ date: cursor, isVirtual: true });
      break;
    }
    if (cursor > to) break;
    if (cursor >= from) out.push({ date: cursor, isVirtual: true });
  }

  return out;
}

/** Plain wording for a rule — the API and the UI must agree on this. */
export function describe(rule: RecurrenceRule | null): string | null {
  if (!rule) return null;
  const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const n = Math.max(1, rule.interval || 1);
  const every = n > 1 ? `Every ${n} ` : 'Every ';

  if (rule.frequency === 'DAILY') return n > 1 ? `${every}days` : 'Every day';
  if (rule.frequency === 'WEEKLY') {
    const days = rule.byWeekday?.length
      ? rule.byWeekday.map((d) => DAY[d]).join(' and ') : null;
    if (n > 1) return days ? `${every}weeks on ${days}` : `${every}weeks`;
    return days ? `Every ${days}` : 'Every week';
  }
  if (rule.frequency === 'MONTHLY') {
    const day = rule.byMonthDay?.length ? rule.byMonthDay[0] : null;
    const suffix = day ? ` on the ${day}${ordinal(day)}` : '';
    return n > 1 ? `${every}months${suffix}` : `Monthly${suffix}`;
  }
  return n > 1 ? `${every}years` : 'Every year';
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  return ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
}
