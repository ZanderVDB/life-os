/**
 * What a date in a sentence MEANS.
 *
 * Phase 3.1 made "Saturday" resolve to the right day. This is the other half,
 * and it failed silently while the first half passed: the date was right and
 * the FIELD was a guess. "I need a haircut Saturday" became a deadline, with a
 * card saying so — self-consistent, and disagreeing with the person who had
 * said neither.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTiming, readingFromChoice } from '../src/lib/timing-intent.js';

const reading = (t: string) => classifyTiming(t).reading;

/* ══ The examples from the review ════════════════════════════════════════ */

test('timing: a deadline is when it must be FINISHED', () => {
  for (const t of [
    'Finish the report by Friday',
    'Finish report by Friday',
    'The report is due Friday',
    'Report is due Friday',
    'Finish the proposal by Friday.',
    'The deposit needs to be paid by Monday',
    'Pay the deposit before Friday',
    'Deadline is Thursday',
    'Hand it in by Wednesday',
    'No later than Friday',
  ]) assert.equal(reading(t), 'deadline', `"${t}"`);
});

test('timing: scheduled is when they intend to DO it', () => {
  for (const t of [
    "I'll work on the report Friday",
    "I'll work on report Friday",
    'Work on the proposal Friday.',
    'Do the report Friday',
    'Sit down with the accounts on Sunday',
    'Start on the deck Monday',
    'Spend an hour on it Thursday',
  ]) assert.equal(reading(t), 'scheduled', `"${t}"`);
});

test('timing: holding a span of time is scheduled, and says so', () => {
  for (const t of [
    'Put an hour aside Friday to work on the proposal.',
    'Schedule the proposal work Friday at 2.',
    'Block out Thursday morning',
    'Book me a haircut Saturday at 10',
    'Find me an hour on Wednesday',
    'Put it in my calendar for Friday',
  ]) {
    const r = classifyTiming(t);
    assert.equal(r.reading, 'scheduled', `"${t}"`);
    assert.equal(r.block, true, `"${t}" did not read as holding time`);
  }
});

test('timing: being told is neither field', () => {
  for (const t of [
    'Remind me Friday about the proposal.',
    'Remind me Friday to call Oscar',
    "Don't let me forget the deposit on Monday",
  ]) assert.equal(reading(t), 'reminder', `"${t}"`);
});

test('timing: a date and nothing saying which it is, is a question', () => {
  for (const t of [
    'I need a haircut Saturday',
    'I need to call the dentist tomorrow',
    'Dentist Tuesday',
    'The car on Thursday',
  ]) assert.equal(reading(t), 'ambiguous', `"${t}"`);
});

test('timing: no date at all is not a timing question', () => {
  for (const t of ['Add milk', 'Complete Morning walk', 'Written by John', '']) {
    assert.equal(reading(t), 'none', `"${t}"`);
  }
});

/* ══ The rules behind the readings ═══════════════════════════════════════ */

test('timing: a clock time can never be a deadline', () => {
  /* `dueDate` holds a DAY. Somebody who names an hour is planning to be
     somewhere, not setting a date field. */
  const r = classifyTiming('Coffee with Sam Tuesday at 3');
  assert.equal(r.reading, 'scheduled');
  assert.equal(r.hasTime, true);
  assert.equal(classifyTiming('Haircut Saturday at 10').reading, 'scheduled');
});

test('timing: scheduling wins when a sentence carries both', () => {
  /* "Block out Friday morning to finish the report by Monday" is two facts,
     and the one being ASKED for is the block. The deadline is something to say
     on the card, not the field to write. */
  const r = classifyTiming('Block out Friday morning to finish the report by Monday');
  assert.equal(r.reading, 'scheduled');
  assert.equal(r.block, true);
});

test('timing: "by" only counts when it governs a time', () => {
  assert.equal(reading('A report written by John'), 'none');
  assert.equal(reading('Send the note written by John on Friday'), 'ambiguous');
  assert.equal(reading('Send the note by Friday'), 'deadline');
});

test('timing: a chosen clarification maps back to a field', () => {
  assert.equal(readingFromChoice('Do it then'), 'scheduled');
  assert.equal(readingFromChoice('Have it done by then'), 'deadline');
  assert.equal(readingFromChoice('Do it on Saturday'), 'scheduled');
  assert.equal(readingFromChoice('Have it finished by Saturday'), 'deadline');
  assert.equal(readingFromChoice('Neither of those'), null);
});
