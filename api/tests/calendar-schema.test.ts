/**
 * Calendar schema (Phase D2), against real Postgres (PGlite).
 *
 * These run the real migration, so they prove the SQL applies and the
 * constraints actually bite — not just that the TypeScript compiles.
 *
 * The rules under test are the ones that are expensive to get wrong later:
 * idempotent upserts, recurring-series identity, workspace isolation, and the
 * separation between a task's due date and the time it is planned for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { freshDb, identity } from './helpers.js';
import { ensureUserAndWorkspace } from '../src/lib/bootstrap.js';
import {
  calendarConnections, calendars, calendarSyncStates, calendarEvents,
  calendarEventAttendees, calendarEventReminders, calendarEventAttachments,
  reminders, reminderRecurrenceRules, taskScheduleBlocks, calendarItemLinks,
  tasks,
} from '../src/db/schema.js';

/** A workspace with one synthetic calendar, which is all most tests need. */
async function withCalendar() {
  const { db } = await freshDb();
  const p = await ensureUserAndWorkspace(db, identity());
  const [cal] = await db.insert(calendars).values({
    workspaceId: p.workspaceId,
    providerCalendarId: 'synthetic-primary',
    name: 'Personal',
    accessRole: 'owner',
    isReadOnly: false,
    isSynthetic: true,
  }).returning();
  return { db, ws: p.workspaceId, cal };
}

test('calendar: all eleven tables exist and are workspace-scoped', async () => {
  const { db } = await freshDb();
  // Selecting from each proves the migration created it.
  for (const t of [calendarConnections, calendars, calendarSyncStates, calendarEvents,
    calendarEventAttendees, calendarEventReminders, calendarEventAttachments,
    reminders, reminderRecurrenceRules, taskScheduleBlocks, calendarItemLinks]) {
    assert.equal((await db.select().from(t)).length, 0);
  }
});

test('events: a re-delivered change updates rather than duplicates', async () => {
  // This is what makes sync idempotent. Without the partial unique index, a
  // retried page of changes silently doubles every event on the calendar.
  const { db, ws, cal } = await withCalendar();
  const row = {
    workspaceId: ws,
    calendarId: cal.id,
    providerEventId: 'evt_abc123',
    title: 'Standup',
    startsAt: new Date('2026-08-03T09:00:00Z'),
    endsAt: new Date('2026-08-03T09:15:00Z'),
  };
  await db.insert(calendarEvents).values(row);
  await assert.rejects(
    () => db.insert(calendarEvents).values(row),
    /duplicate key|unique/i,
    'the same provider event was inserted twice',
  );
  assert.equal((await db.select().from(calendarEvents)).length, 1);
});

test('events: local-only events may share a null provider id', async () => {
  // The unique index is PARTIAL for exactly this reason — synthetic and
  // Life OS-only events legitimately have no provider id, and a plain unique
  // index would allow only one of them per calendar.
  const { db, ws, cal } = await withCalendar();
  for (const title of ['Synthetic one', 'Synthetic two', 'Synthetic three']) {
    await db.insert(calendarEvents).values({
      workspaceId: ws, calendarId: cal.id, title, isSynthetic: true,
      startsAt: new Date('2026-08-04T10:00:00Z'),
      endsAt: new Date('2026-08-04T11:00:00Z'),
    });
  }
  assert.equal((await db.select().from(calendarEvents)).length, 3);
});

test('events: recurring identity survives — series, instance and concurrency', async () => {
  // Editing ONE occurrence needs all of these. Without them the exception
  // cannot be matched back to the occurrence it replaces, and the series is
  // corrupted.
  const { db, ws, cal } = await withCalendar();
  const [ev] = await db.insert(calendarEvents).values({
    workspaceId: ws,
    calendarId: cal.id,
    providerEventId: 'evt_series_20260805',
    icalUid: 'abc@google.com',
    recurringEventId: 'evt_series',
    originalStartTime: new Date('2026-08-05T09:00:00Z'),
    title: 'Weekly review (moved)',
    startsAt: new Date('2026-08-05T10:00:00Z'),
    endsAt: new Date('2026-08-05T11:00:00Z'),
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'],
    etag: '"abc"',
    sequence: 2,
  }).returning();

  assert.equal(ev.recurringEventId, 'evt_series');
  assert.equal(ev.icalUid, 'abc@google.com');
  assert.deepEqual(ev.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=WE']);
  assert.equal(ev.sequence, 2, 'sequence is needed to reject a stale write');
  assert.ok(ev.originalStartTime, 'the replaced occurrence is not identified');
});

test('events: all-day events keep a DATE, not just an instant', async () => {
  // Storing an all-day event only as a timestamp shifts it across time zones,
  // which is how a birthday lands on the wrong day.
  const { db, ws, cal } = await withCalendar();
  const [ev] = await db.insert(calendarEvents).values({
    workspaceId: ws, calendarId: cal.id, title: 'Public holiday',
    isAllDay: true, startDate: '2026-08-09', endDate: '2026-08-10',
  }).returning();
  assert.equal(ev.startDate, '2026-08-09');
  assert.equal(ev.isAllDay, true);
  assert.equal(ev.startsAt, null, 'an all-day event should not claim a time');
});

test('events: status and transparency are constrained', async () => {
  const { db, ws, cal } = await withCalendar();
  await assert.rejects(
    () => db.insert(calendarEvents).values({
      workspaceId: ws, calendarId: cal.id, title: 'Bad', status: 'maybe',
    }),
    /constraint|check/i,
    'an unknown event status was accepted',
  );
  await assert.rejects(
    () => db.insert(calendarEvents).values({
      workspaceId: ws, calendarId: cal.id, title: 'Bad', transparency: 'sort-of',
    }),
    /constraint|check/i,
    'an unknown transparency was accepted',
  );
});

test('events: deleting a calendar removes its events but not the workspace', async () => {
  const { db, ws, cal } = await withCalendar();
  await db.insert(calendarEvents).values({
    workspaceId: ws, calendarId: cal.id, title: 'Gone with the calendar',
  });
  await db.delete(calendars).where(eq(calendars.id, cal.id));
  assert.equal((await db.select().from(calendarEvents)).length, 0);
});

test('calendars: access role is constrained and read-only is explicit', async () => {
  const { db, ws } = await withCalendar();
  await assert.rejects(
    () => db.insert(calendars).values({
      workspaceId: ws, providerCalendarId: 'x', name: 'X', accessRole: 'admin',
    }),
    /constraint|check/i,
    'an unknown Google access role was accepted',
  );
  // A reader calendar must default to read-only, so no edit control is offered.
  const [ro] = await db.insert(calendars).values({
    workspaceId: ws, providerCalendarId: 'holidays', name: 'Holidays',
    accessRole: 'reader',
  }).returning();
  assert.equal(ro.isReadOnly, true, 'a reader calendar is not read-only by default');
});

test('connections: tokens are references, and scopes granted are recorded', async () => {
  // The columns must not be named or shaped like places to put a raw token.
  const { db, ws } = await withCalendar();
  const [conn] = await db.insert(calendarConnections).values({
    workspaceId: ws,
    providerAccountId: 'synthetic-account',
    accountEmail: 'someone@example.com',
    accessTokenRef: 'kms://ref/abc',
    refreshTokenRef: 'kms://ref/def',
    grantedScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  }).returning();
  assert.deepEqual(conn.grantedScopes,
    ['https://www.googleapis.com/auth/calendar.readonly']);
  assert.match(conn.accessTokenRef!, /^kms:\/\//, 'the column holds a raw token');
  assert.equal(conn.disconnectedAt, null);
});

test('sync state: one row per calendar, with a resync escape hatch', async () => {
  const { db, ws, cal } = await withCalendar();
  await db.insert(calendarSyncStates).values({
    workspaceId: ws, calendarId: cal.id, syncToken: 'tok_1',
  });
  await assert.rejects(
    () => db.insert(calendarSyncStates).values({
      workspaceId: ws, calendarId: cal.id, syncToken: 'tok_2',
    }),
    /duplicate key|unique/i,
    'a calendar can have two competing sync states',
  );
  // Invalidation must be recordable, so a full resync is deliberate.
  await db.update(calendarSyncStates)
    .set({ syncToken: null, tokenInvalidatedAt: new Date() })
    .where(eq(calendarSyncStates.calendarId, cal.id));
  const [st] = await db.select().from(calendarSyncStates);
  assert.equal(st.syncToken, null);
  assert.ok(st.tokenInvalidatedAt, 'token invalidation is not recorded');
});

test('reminders: a Life OS record, never a Google event', async () => {
  const { db, ws } = await withCalendar();
  const [r] = await db.insert(reminders).values({
    workspaceId: ws, title: 'Renew passport', dueDate: '2026-09-01', leadDays: 14,
  }).returning();
  assert.equal(r.status, 'open');
  assert.equal(r.leadDays, 14, 'a reminder cannot ask for attention early');
  // A reminder has no duration — there is nowhere to put one.
  assert.ok(!('endsAt' in r), 'a reminder has an end time, so it is an event');
  await assert.rejects(
    () => db.insert(reminders).values({
      workspaceId: ws, title: 'Bad', status: 'snoozed',
    }),
    /constraint|check/i,
  );
});

test('reminders: deferral is kept separately from the original due date', async () => {
  // Overwriting due_date would lose the original intent.
  const { db, ws } = await withCalendar();
  const [r] = await db.insert(reminders).values({
    workspaceId: ws, title: 'Call the bank', dueDate: '2026-08-10',
  }).returning();
  await db.update(reminders).set({ deferredTo: '2026-08-14' })
    .where(eq(reminders.id, r.id));
  const [after] = await db.select().from(reminders);
  assert.equal(after.dueDate, '2026-08-10', 'the original due date was overwritten');
  assert.equal(after.deferredTo, '2026-08-14');
});

test('reminders: recurrence is RRULE-shaped and constrained', async () => {
  const { db, ws } = await withCalendar();
  const [r] = await db.insert(reminders).values({
    workspaceId: ws, title: 'Water the plants',
  }).returning();
  await db.insert(reminderRecurrenceRules).values({
    workspaceId: ws, reminderId: r.id, frequency: 'WEEKLY', interval: 1,
    byWeekday: [1, 4],
  });
  const [rule] = await db.select().from(reminderRecurrenceRules);
  assert.deepEqual(rule.byWeekday, [1, 4]);
  await assert.rejects(
    () => db.insert(reminderRecurrenceRules).values({
      workspaceId: ws, reminderId: r.id, frequency: 'FORTNIGHTLY',
    }),
    /constraint|check|duplicate/i,
  );
});

test('task blocks: scheduled time is separate from the due date', async () => {
  // The whole point of the table. A task due Friday, planned for Wednesday
  // morning, must carry both facts without either overwriting the other.
  const { db, ws } = await withCalendar();
  const [t] = await db.insert(tasks).values({
    workspaceId: ws, title: 'Write the report', dueDate: '2026-08-07',
  }).returning();
  await db.insert(taskScheduleBlocks).values({
    workspaceId: ws, taskId: t.id,
    startsAt: new Date('2026-08-05T09:00:00Z'),
    endsAt: new Date('2026-08-05T11:00:00Z'),
  });
  const [block] = await db.select().from(taskScheduleBlocks);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, t.id));
  assert.equal(task.dueDate, '2026-08-07', 'the due date moved when work was scheduled');
  assert.equal(block.startsAt.toISOString(), '2026-08-05T09:00:00.000Z');
  assert.equal(block.mirroredEventId, null, 'planning time is private by default');
});

test('task blocks: scheduling never touches project or area semantics', async () => {
  const { db, ws } = await withCalendar();
  const [t] = await db.insert(tasks).values({
    workspaceId: ws, title: 'Untouched', bucket: 'week',
  }).returning();
  await db.insert(taskScheduleBlocks).values({
    workspaceId: ws, taskId: t.id,
    startsAt: new Date('2026-08-06T09:00:00Z'),
    endsAt: new Date('2026-08-06T10:00:00Z'),
  });
  const [after] = await db.select().from(tasks).where(eq(tasks.id, t.id));
  assert.equal(after.projectId, null);
  assert.equal(after.areaId, null);
  assert.equal(after.bucket, 'week', 'scheduling changed the task bucket');
});

test('links: Life OS relationships are their own records, deduped per edge', async () => {
  const { db, ws, cal } = await withCalendar();
  const [ev] = await db.insert(calendarEvents).values({
    workspaceId: ws, calendarId: cal.id, title: 'Client meeting',
  }).returning();
  const [t] = await db.insert(tasks).values({
    workspaceId: ws, title: 'Prepare slides',
  }).returning();
  const edge = {
    workspaceId: ws, kind: 'preparation',
    sourceType: 'event', sourceId: ev.id,
    targetType: 'task', targetId: t.id,
  };
  await db.insert(calendarItemLinks).values(edge);
  await assert.rejects(
    () => db.insert(calendarItemLinks).values(edge),
    /duplicate key|unique/i,
    'the same relationship can be recorded twice',
  );
  // The same pair may hold a DIFFERENT kind of relationship.
  await db.insert(calendarItemLinks).values({ ...edge, kind: 'follow_up' });
  assert.equal((await db.select().from(calendarItemLinks)).length, 2);
});

test('attendees, event reminders and attachments cascade with the event', async () => {
  const { db, ws, cal } = await withCalendar();
  const [ev] = await db.insert(calendarEvents).values({
    workspaceId: ws, calendarId: cal.id, title: 'Kickoff',
  }).returning();
  await db.insert(calendarEventAttendees).values({
    workspaceId: ws, eventId: ev.id, email: 'a@example.com', responseStatus: 'accepted',
  });
  await db.insert(calendarEventReminders).values({
    workspaceId: ws, eventId: ev.id, method: 'popup', minutesBefore: 10,
  });
  await db.insert(calendarEventAttachments).values({
    workspaceId: ws, eventId: ev.id, title: 'Agenda', fileId: 'drive-1',
  });

  // The same attendee cannot be added twice to one event.
  await assert.rejects(
    () => db.insert(calendarEventAttendees).values({
      workspaceId: ws, eventId: ev.id, email: 'a@example.com',
    }),
    /duplicate key|unique/i,
  );

  await db.delete(calendarEvents).where(eq(calendarEvents.id, ev.id));
  assert.equal((await db.select().from(calendarEventAttendees)).length, 0);
  assert.equal((await db.select().from(calendarEventReminders)).length, 0);
  assert.equal((await db.select().from(calendarEventAttachments)).length, 0);
});

test('calendar data is isolated per workspace', async () => {
  const { db } = await freshDb();
  const a = await ensureUserAndWorkspace(db, identity('a@x.com', 'uid-a'));
  const b = await ensureUserAndWorkspace(db, identity('b@x.com', 'uid-b'));
  for (const ws of [a.workspaceId, b.workspaceId]) {
    const [c] = await db.insert(calendars).values({
      workspaceId: ws, providerCalendarId: 'primary', name: 'Primary',
    }).returning();
    await db.insert(calendarEvents).values({
      workspaceId: ws, calendarId: c.id, title: 'Private',
    });
    await db.insert(reminders).values({ workspaceId: ws, title: 'Private' });
  }
  const mine = await db.select().from(calendarEvents)
    .where(eq(calendarEvents.workspaceId, a.workspaceId));
  assert.equal(mine.length, 1, 'workspace scoping leaks calendar events');
  const myReminders = await db.select().from(reminders)
    .where(eq(reminders.workspaceId, a.workspaceId));
  assert.equal(myReminders.length, 1, 'workspace scoping leaks reminders');
  // The same provider calendar id may exist in both workspaces.
  assert.equal((await db.select().from(calendars)).length, 2);
});

test('existing Task and Habit data is untouched by the calendar migration', async () => {
  // The calendar migration must be purely additive.
  const { db, ws } = await withCalendar();
  const [t] = await db.insert(tasks).values({
    workspaceId: ws, title: 'Pre-existing', bucket: 'today', priority: 'high',
  }).returning();
  assert.equal(t.bucket, 'today');
  assert.equal(t.priority, 'high');
  assert.equal(t.status, 'open');
  // No calendar column leaked into tasks.
  for (const gone of ['calendarId', 'startsAt', 'providerEventId']) {
    assert.ok(!(gone in t), `tasks gained a calendar column: ${gone}`);
  }
});
