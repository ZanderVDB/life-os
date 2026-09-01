/**
 * Civil dates — the arithmetic, pinned to real calendar days.
 *
 * These are here because the assistant got "Saturday" wrong in production
 * prose while every existing test stayed green: the resolver was correct and
 * simply was not on the planner's path, so nothing exercised the thing that
 * was actually deciding. The pairs below are checked against `Date` itself, so
 * an off-by-one cannot pass by matching a constant somebody typed twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKDAYS, todayIn, addDays, weekdayOf, isWeekday, longDate, isCivilDate,
  resolveRelativeDate, nextWeekday, calendarWindow, weekdayNamesIn,
} from '../src/lib/civil-date.js';
import { retitleForDate } from '../src/ai/validate.js';

/** What the real calendar says, independent of anything under test. */
const realWeekday = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })
    .toLowerCase();

/* ══ The week the bug was found in ═══════════════════════════════════════ */

test('Tuesday 1 September 2026: every named day lands where the calendar says',
  () => {
    const TUE = '2026-09-01';
    assert.equal(weekdayOf(TUE), 'tuesday', 'the fixture is not the day it claims');
    assert.equal(realWeekday(TUE), 'tuesday');

    /* The three the screenshots got wrong. */
    assert.equal(resolveRelativeDate('Friday', TUE)!.date, '2026-09-04');
    assert.equal(resolveRelativeDate('Saturday', TUE)!.date, '2026-09-05');
    assert.equal(resolveRelativeDate('Monday', TUE)!.date, '2026-09-07');

    /* And the rest of the week, checked against the calendar rather than
       against more constants. */
    for (const [phrase, expected] of [
      ['wednesday', '2026-09-02'], ['thursday', '2026-09-03'],
      ['sunday', '2026-09-06'], ['tuesday', '2026-09-08'],
    ] as const) {
      const got = resolveRelativeDate(phrase, TUE)!;
      assert.equal(got.date, expected, `${phrase} resolved to ${got.date}`);
      assert.equal(realWeekday(got.date), phrase,
        `${got.date} is a ${realWeekday(got.date)}, not a ${phrase}`);
    }
  });

test('a weekday is the NEXT one and never today', () => {
  const TUE = '2026-09-01';
  assert.equal(resolveRelativeDate('tuesday', TUE)!.date, '2026-09-08',
    'today was offered back as "Tuesday"');
  /* Every day of the week, from every day of the week. The invariant is not a
     date: it is that the answer is strictly ahead and is the day named. */
  for (let offset = 0; offset < 7; offset += 1) {
    const from = addDays('2026-09-01', offset);
    for (const day of WEEKDAYS) {
      const got = resolveRelativeDate(day, from)!.date;
      assert.ok(got > from, `${day} from ${from} gave ${got}, which is not ahead`);
      assert.equal(realWeekday(got), day);
      assert.ok(got <= addDays(from, 7), `${day} from ${from} went more than a week out`);
    }
  }
});

test('this / next / plain, as documented', () => {
  const TUE = '2026-09-01';
  // "this Friday" is the coming one — the same as plain "Friday".
  assert.equal(resolveRelativeDate('this Friday', TUE)!.date, '2026-09-04');
  assert.equal(resolveRelativeDate('on Friday', TUE)!.date, '2026-09-04');
  // "next Friday" is a week later than that. Stated, and shown on the card.
  assert.equal(resolveRelativeDate('next Friday', TUE)!.date, '2026-09-11');
  assert.equal(realWeekday('2026-09-11'), 'friday');
  // The weekend is Saturday: a date field holds one day, and that is the one.
  assert.equal(resolveRelativeDate('this weekend', TUE)!.date, '2026-09-05');
  assert.equal(resolveRelativeDate('next weekend', TUE)!.date, '2026-09-12');
});

test('today, tomorrow, yesterday and offsets', () => {
  const TUE = '2026-09-01';
  assert.equal(resolveRelativeDate('today', TUE)!.date, TUE);
  assert.equal(resolveRelativeDate('tonight', TUE)!.date, TUE);
  assert.equal(resolveRelativeDate('tomorrow', TUE)!.date, '2026-09-02');
  assert.equal(resolveRelativeDate('yesterday', TUE)!.date, '2026-08-31');
  assert.equal(resolveRelativeDate('in 3 days', TUE)!.date, '2026-09-04');
  assert.equal(resolveRelativeDate('in 2 weeks', TUE)!.date, '2026-09-15');
  assert.equal(resolveRelativeDate('2026-12-25', TUE)!.date, '2026-12-25');

  // Anything vaguer than the vocabulary returns nothing rather than a guess.
  for (const vague of ['next month', 'sometime', 'the week after', 'end of the quarter']) {
    assert.equal(resolveRelativeDate(vague, TUE), null, `"${vague}" was resolved anyway`);
  }
});

/* ══ Boundaries ══════════════════════════════════════════════════════════ */

test('month and year boundaries are ordinary day arithmetic', () => {
  // Month, forwards and backwards.
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-09-01', -1), '2026-08-31');
  assert.equal(resolveRelativeDate('tomorrow', '2026-08-31')!.date, '2026-09-01');
  // A 30-day month, and February.
  assert.equal(addDays('2026-04-30', 1), '2026-05-01');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01', '2026 is not a leap year');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29', '2028 is');

  // Year.
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(resolveRelativeDate('tomorrow', '2026-12-31')!.date, '2027-01-01');
  // 31 December 2026 is a Thursday, so "Saturday" crosses into January.
  assert.equal(realWeekday('2026-12-31'), 'thursday');
  const sat = resolveRelativeDate('Saturday', '2026-12-31')!;
  assert.equal(sat.date, '2027-01-02');
  assert.equal(realWeekday(sat.date), 'saturday');
});

/* ══ Timezone ════════════════════════════════════════════════════════════ */

test('today is the day where the USER is, not where the server is', () => {
  /* 23:30 UTC on 1 September. In Auckland it is already the 2nd; in Los
     Angeles it is still the afternoon of the 1st. `toISOString().slice(0,10)`
     answers "1 September" for both, and is wrong for one of them. */
  const instant = new Date('2026-09-01T23:30:00.000Z');
  assert.equal(todayIn('Pacific/Auckland', instant), '2026-09-02');
  assert.equal(todayIn('America/Los_Angeles', instant), '2026-09-01');
  assert.equal(todayIn('Africa/Johannesburg', instant), '2026-09-02');
  assert.equal(todayIn('UTC', instant), '2026-09-01');

  /* And the other edge: 00:30 UTC, where Los Angeles is still the day before. */
  const early = new Date('2026-09-02T00:30:00.000Z');
  assert.equal(todayIn('America/Los_Angeles', early), '2026-09-01');
  assert.equal(todayIn('Pacific/Auckland', early), '2026-09-02');

  // No zone, or a nonsense one, falls back rather than throwing.
  assert.equal(todayIn(null, instant), '2026-09-01');
  assert.equal(todayIn('Not/AZone', instant), '2026-09-01');
});

test('a civil date never acquires a time or an offset', () => {
  /* The failure this guards: doing day arithmetic through an instant and
     letting the instant leak. Everything produced here is a bare label. */
  for (const iso of [addDays('2026-09-01', 5), nextWeekday('2026-09-01', 'saturday'),
    resolveRelativeDate('Friday', '2026-09-01')!.date]) {
    assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(isCivilDate(iso));
  }
  /* Arithmetic in a non-UTC process must not shift the day either: the anchor
     is explicit, so this holds whatever TZ the server runs in. */
  assert.equal(addDays('2026-03-29', 1), '2026-03-30', 'a DST boundary moved a civil date');
  assert.equal(addDays('2026-10-25', 1), '2026-10-26');
});

/* ══ The semantic check ══════════════════════════════════════════════════ */

test('a date can be asked whether it really is the day it was called', () => {
  assert.equal(isWeekday('2026-09-05', 'saturday'), true);
  assert.equal(isWeekday('2026-09-06', 'saturday'), false, 'the exact bug that shipped');
  assert.equal(isWeekday('2026-09-04', 'friday'), true);
  assert.equal(isWeekday('2026-09-05', 'friday'), false);
  assert.equal(isWeekday('not-a-date', 'friday'), false);

  assert.deepEqual(weekdayNamesIn('Haircut on Saturday'), ['saturday']);
  assert.deepEqual(weekdayNamesIn('Saturday means 2026-09-06'), ['saturday']);
  assert.deepEqual(weekdayNamesIn('between Monday and Friday').sort(), ['friday', 'monday']);
  assert.deepEqual(weekdayNamesIn('Add milk'), []);

  assert.match(longDate('2026-09-05'), /^Saturday,? 5 September 2026$/);
});

test('the calendar handed to the planner is the real calendar', () => {
  const window = calendarWindow('2026-09-01', 14);
  assert.equal(window.length, 15, 'today plus a fortnight');
  assert.equal(window[0]!.date, '2026-09-01');
  assert.equal(window[0]!.weekday, 'tuesday');
  for (const row of window) {
    assert.equal(row.weekday, realWeekday(row.date), `${row.date} is mislabelled`);
  }
  /* The rows the model needed and had to compute for itself. */
  const byDay = new Map(window.map((r) => [r.date, r.weekday]));
  assert.equal(byDay.get('2026-09-04'), 'friday');
  assert.equal(byDay.get('2026-09-05'), 'saturday');
  assert.equal(byDay.get('2026-09-07'), 'monday');
});

test('a stale weekday in a title is corrected, not deleted', () => {
  /* An amendment moves the date under a title the model wrote. Dropping the
     title would leave a card with no name; leaving it is the same lie in the
     place a reader looks first. */
  assert.equal(
    retitleForDate('Set haircut deadline to Saturday', { id: 'x', changes: { dueDate: '2026-09-07' } }),
    'Set haircut deadline to Monday');
  // Casing follows what was written.
  assert.equal(retitleForDate('haircut on saturday', { dueDate: '2026-09-07' }), 'haircut on monday');
  // Already right: untouched.
  assert.equal(retitleForDate('Haircut on Saturday', { dueDate: '2026-09-05' }), 'Haircut on Saturday');
  // No weekday named, or nothing to check against: untouched.
  assert.equal(retitleForDate('Add milk', { title: 'Milk' }), 'Add milk');
  assert.equal(retitleForDate('Between Monday and Friday', { dueDate: '2026-09-07' }),
    'Between Monday and Friday', 'a range was rewritten');
  // Two different dates: no single right answer, so nothing is guessed.
  assert.equal(
    retitleForDate('Saturday', { dueDate: '2026-09-07', startDate: '2026-09-09' }), 'Saturday');
});
