/**
 * Pausing a recurring reminder returned a 500, and had since reminders shipped.
 *
 * `setReminderPaused` writes `status: 'paused'`. The CHECK constraint on that
 * column permitted `open`, `done` and `dismissed` and nothing else. Every other
 * part of the feature was correct and consistent — `calendar.ts` reads
 * `'paused'` to suppress future occurrences, `resumeReminder` sets it back to
 * `'open'`, the AI module exposes it — and the one place it was never written
 * down was the constraint.
 *
 * ── Why the existing tests could not catch it ───────────────────────────
 *
 * They assert the SOURCE: that the action exists, that the route is registered,
 * that the calendar suppresses a paused series. Every one of those was true.
 * Nothing actually pressed the button against a database with the constraint
 * on it, so nothing ever asked Postgres whether the value was allowed.
 *
 * These do. Same lesson as `pglite-vs-production-postgres`: a green suite is
 * not proof the query runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { freshDb } from './helpers.js';
import {
  setReminderPaused, resumeReminder, completeReminder,
} from '../src/lib/actions/reminders.js';
import {
  reminders, reminderRecurrenceRules, users, workspaces, workspaceMemberships,
} from '../src/db/schema.js';

async function ws() {
  const { db } = await freshDb();
  const [u] = await db.insert(users)
    .values({ email: 'z@example.com', displayName: 'Z' }).returning();
  const [w] = await db.insert(workspaces)
    .values({ ownerUserId: u!.id, name: 'Life OS' }).returning();
  await db.insert(workspaceMemberships).values({ workspaceId: w!.id, userId: u!.id });
  return { db, workspaceId: w!.id as string };
}

async function weekly(db: any, workspaceId: string, dueDate = '2026-10-01') {
  const [r] = await db.insert(reminders)
    .values({ workspaceId, title: 'Water the plants', dueDate }).returning();
  await db.insert(reminderRecurrenceRules)
    .values({ workspaceId, reminderId: r!.id, frequency: 'WEEKLY', interval: 1 });
  return r!;
}

test('pause: a recurring reminder can actually be paused', async () => {
  const { db, workspaceId } = await ws();
  const r = await weekly(db, workspaceId);

  /* The whole bug, in one call. This threw a check-constraint violation, which
     the route turned into "Something went wrong." */
  const paused = await setReminderPaused(db, workspaceId, r.id, true);
  assert.equal(paused.status, 'paused', 'pausing did not record itself');

  const [stored] = await db.select().from(reminders);
  assert.equal(stored!.status, 'paused', 'the database did not accept the value');
});

test('pause: and unpausing puts it back to open', async () => {
  const { db, workspaceId } = await ws();
  const r = await weekly(db, workspaceId);
  await setReminderPaused(db, workspaceId, r.id, true);
  const back = await setReminderPaused(db, workspaceId, r.id, false);
  assert.equal(back.status, 'open', 'unpausing left it paused');
});

test('pause: resuming rolls a stale series forward rather than arriving overdue', async () => {
  const { db, workspaceId } = await ws();
  /* Paused in the past: a weekly reminder resumed a month later must not come
     back due before today and read as overdue the instant it returns. */
  const r = await weekly(db, workspaceId, '2026-08-05');
  await setReminderPaused(db, workspaceId, r.id, true);
  const resumed = await resumeReminder(db, workspaceId, r.id, '2026-09-09');
  assert.equal(resumed.reminder.status, 'open');
  assert.ok(resumed.reminder.dueDate! >= '2026-09-09',
    `resumed due ${resumed.reminder.dueDate}, which is already in the past`);
});

test('pause: every status the code writes is a status the column permits', async () => {
  /* The general form of the bug, so the next value added anywhere has to be
     added here too. Read out of the SQL rather than the schema builder: the
     constraint that matters is the one in the migration Railway runs. */
  const sql = readFileSync(join('drizzle', '0019_reminder_paused.sql'), 'utf8');
  const allowed = [...sql.matchAll(/'(\w+)'/g)].map((m) => m[1]!);
  for (const status of ['open', 'done', 'dismissed', 'paused']) {
    assert.ok(allowed.includes(status), `the column forbids '${status}'`);
  }

  const { db, workspaceId } = await ws();
  const r = await weekly(db, workspaceId);
  /* And prove it, one value at a time, against a database that has the
     constraint on it. A list in a test file is a claim; an INSERT is a fact. */
  for (const status of ['open', 'done', 'dismissed', 'paused']) {
    const [row] = await db.update(reminders).set({ status })
      .where(eq(reminders.id, r.id)).returning();
    assert.equal(row!.status, status, `the database refused '${status}'`);
  }
});

test('pause: completing a paused series reopens it rather than leaving it silent', async () => {
  const { db, workspaceId } = await ws();
  const r = await weekly(db, workspaceId, '2026-09-09');
  await setReminderPaused(db, workspaceId, r.id, true);
  /* A paused-then-advanced reminder that stayed paused would silently stop
     asking for the next occurrence — the comment in `completeReminder` says so,
     and now something checks it. */
  const done = await completeReminder(db, workspaceId, r.id, '2026-09-09');
  assert.equal(done.reminder.status, 'open', 'the series stayed paused after completing one');
});
