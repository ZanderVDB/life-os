/**
 * Recurrence expansion — the engine Month, Agenda, Plan and the Reminders
 * overview all share. Two implementations of "what comes next" is how a
 * calendar starts disagreeing with itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expand, describe as describeRule, nextAfter } from '../src/lib/recurrence.js';

const weekly = { frequency: 'WEEKLY', interval: 1, byWeekday: [3] };
const monthly = { frequency: 'MONTHLY', interval: 1, byMonthDay: [28] };
const dates = (o: { date: string }[]) => o.map((x) => x.date);

test('future months appear WITHOUT completing the current one', () => {
  // The bug this whole engine exists for: September was invisible until
  // August had been ticked off.
  assert.deepEqual(
    dates(expand('2026-08-28', monthly, '2026-09-01', '2026-09-30')),
    ['2026-09-28'],
    'next month is invisible until the current occurrence is completed',
  );
  assert.deepEqual(
    dates(expand('2026-08-28', monthly, '2026-12-01', '2026-12-31')),
    ['2026-12-28'],
    'a month four ahead is invisible',
  );
});

test('weekly expands across every week in range', () => {
  assert.deepEqual(dates(expand('2026-08-05', weekly, '2026-08-01', '2026-08-31')),
    ['2026-08-05', '2026-08-12', '2026-08-19', '2026-08-26']);
  assert.deepEqual(dates(expand('2026-08-05', weekly, '2026-09-01', '2026-09-30')),
    ['2026-09-02', '2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30']);
});

test('nothing is generated before the reminder existed', () => {
  // Inventing history would make an overdue count meaningless.
  assert.deepEqual(dates(expand('2026-08-05', weekly, '2026-06-01', '2026-06-30')), []);
});

test('the stored occurrence is real; the rest are virtual', () => {
  const out = expand('2026-08-05', weekly, '2026-08-01', '2026-08-31');
  assert.equal(out[0]!.isVirtual, false, 'the canonical row is marked virtual');
  assert.ok(out.slice(1).every((o) => o.isVirtual), 'derived occurrences are not marked virtual');
});

test('short months clamp instead of overflowing', () => {
  assert.deepEqual(
    dates(expand('2026-01-31', { frequency: 'MONTHLY', interval: 1, byMonthDay: [31] },
      '2026-02-01', '2026-04-30')),
    ['2026-02-28', '2026-03-31', '2026-04-30'],
    'the 31st overflowed into the following month',
  );
});

test('until and count end the series', () => {
  assert.deepEqual(
    dates(expand('2026-08-05', { ...weekly, until: '2026-08-20' }, '2026-08-01', '2026-09-30')),
    ['2026-08-05', '2026-08-12', '2026-08-19']);
  assert.equal(
    expand('2026-08-05', { ...weekly, count: 3 }, '2026-08-01', '2026-12-31').length, 4,
    'count is not honoured');
});

test('a one-off appears once, only in its own range', () => {
  assert.deepEqual(dates(expand('2026-08-15', null, '2026-08-01', '2026-08-31')), ['2026-08-15']);
  assert.deepEqual(dates(expand('2026-08-15', null, '2026-09-01', '2026-09-30')), []);
});

test('expansion cannot run away', () => {
  const out = expand('2020-01-01', { frequency: 'DAILY', interval: 1 }, '2020-01-01', '2030-01-01');
  assert.ok(out.length <= 401, `expansion produced ${out.length} occurrences`);
});

test('completion and expansion agree on what comes next', () => {
  // Both go through nextAfter, so they cannot drift.
  assert.equal(nextAfter('2026-08-05', weekly), '2026-08-12');
  assert.equal(nextAfter('2026-08-28', monthly), '2026-09-28');
});

test('recurrence is described in words, never raw syntax', () => {
  assert.equal(describeRule(weekly), 'Every Wednesday');
  assert.equal(describeRule(monthly), 'Monthly on the 28th');
  assert.equal(describeRule({ frequency: 'MONTHLY', interval: 1, byMonthDay: [1] }),
    'Monthly on the 1st');
  assert.equal(describeRule({ frequency: 'MONTHLY', interval: 1, byMonthDay: [22] }),
    'Monthly on the 22nd');
  assert.equal(describeRule({ frequency: 'WEEKLY', interval: 2, byWeekday: [1] }),
    'Every 2 weeks on Monday');
  assert.equal(describeRule(null), null);
  // No RRULE strings anywhere near the user.
  assert.ok(!/RRULE|FREQ=|BYDAY/.test(describeRule(weekly) ?? ''));
});
