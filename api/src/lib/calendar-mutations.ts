/**
 * The one place a Google Calendar event is created, changed or deleted.
 *
 * ── Why one place ───────────────────────────────────────────────────────
 *
 * Every write goes: propose → confirm → execute. Nothing skips a step, and
 * there is no second door. That matters most for the thing that does not exist
 * yet: when the assistant can say "move my dentist appointment to Friday", it
 * will call `propose` and get back something for a person to look at. It will
 * not get a way to call Google directly, because there isn't one — the
 * enforcement is structural, not a sentence in a prompt that a model might
 * decide to work around.
 *
 * ── Google is authoritative ─────────────────────────────────────────────
 *
 * For a real event, Life OS is a client, not a source of truth. Nothing is
 * committed locally until Google has said yes. The alternative — write
 * locally, show success, sync later, hope — produces an event that exists in
 * the app and nowhere else, which is worse than an error, because the user has
 * already stopped thinking about it.
 *
 * The local mirror is updated from Google's OWN response to the mutation, so
 * the app shows the authoritative result immediately rather than waiting for a
 * webhook. The webhook is reconciliation, not the happy path.
 */
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  calendarConnections, calendars, calendarEvents, calendarEventAttendees,
  calendarMutations, itemLinks, tasks,
} from '../db/schema.js';
import {
  ApiError, badRequest, conflict, forbidden, notFound, upstreamUnavailable,
} from './errors.js';
import { redactTokens } from './token-crypto.js';
import * as G from './google-calendar.js';
import { accessTokenFor } from './calendar-sync.js';

/* ══ The proposal ════════════════════════════════════════════════════════ */

export type MutationKind = 'calendar.create' | 'calendar.update' | 'calendar.delete';
export type MutationScope = 'single' | 'instance' | 'series';

export type EventDraft = {
  title?: string;
  description?: string | null;
  location?: string | null;
  isAllDay?: boolean;
  /** YYYY-MM-DD for all-day; ISO instants otherwise. */
  startDate?: string | null;
  endDate?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  timeZone?: string | null;
  attendees?: string[];
  recurrence?: string[] | null;
  reminders?: { minutes: number; method?: string }[] | null;
  useDefaultReminders?: boolean;
  withMeet?: boolean;
  transparency?: 'opaque' | 'transparent';
  visibility?: string;
  /**
   * Google's own event type. `birthday` is a real thing with real rules — all
   * day, yearly, and it does not consume time — so Life OS uses it rather than
   * making an ordinary event that merely looks like one. An ordinary event
   * would block the day in free/busy and lose its meaning to every other
   * Google client.
   */
  eventType?: string;
  /** Google is told to email guests only when the user asked for it. */
  notifyGuests?: boolean;
};

export type Proposal = {
  id: string;
  requestId: string;
  kind: MutationKind;
  status: 'proposed' | 'confirmed' | 'executed' | 'failed' | 'cancelled';
  scope: MutationScope;
  calendar: { id: string; name: string; providerCalendarId: string } | null;
  /** Exactly what the confirmation screen shows. Never derived twice. */
  summary: {
    title: string;
    when: string;
    calendar: string | null;
    location?: string | null;
    attendees?: string[];
    recurrence?: string | null;
    changes?: { field: string; from: string; to: string }[];
    warnings?: string[];
  };
  conflicts?: { title: string | null; start: string; end: string }[];
  payload: EventDraft;
};

/* ══ Connection state ════════════════════════════════════════════════════ */

export type WriteState = {
  connected: boolean;
  status: string;
  canWrite: boolean;
  needsReconnect: boolean;
  reason: string | null;
};

/**
 * What the connection can do right now — asked before a form opens, not after
 * it is filled in.
 *
 * A grant issued before write support existed looks perfectly healthy: valid
 * token, syncing fine, and completely unable to create anything. The only way
 * to know is to have written down which scope set it was signed under.
 */
export async function writeState(db: Db, workspaceId: string): Promise<WriteState> {
  const [conn] = await db.select().from(calendarConnections).where(and(
    eq(calendarConnections.workspaceId, workspaceId),
    eq(calendarConnections.provider, 'google'),
  ));
  if (!conn) {
    return {
      connected: false, status: 'none', canWrite: false, needsReconnect: true,
      reason: 'Connect Google Calendar to create events.',
    };
  }
  if (conn.status === 'revoked' || conn.status === 'needs_reauth') {
    return {
      connected: true, status: conn.status, canWrite: false, needsReconnect: true,
      reason: 'Reconnect Google Calendar to create this event.',
    };
  }
  if (!conn.canWrite || (conn.scopesVersion ?? 1) < G.SCOPES_VERSION) {
    return {
      connected: true, status: conn.status, canWrite: false, needsReconnect: true,
      reason: 'Life OS needs permission to add events. Reconnect Google Calendar to grant it.',
    };
  }
  return { connected: true, status: conn.status, canWrite: true, needsReconnect: false, reason: null };
}

/** Throws the message the UI should show, rather than letting Google refuse later. */
async function requireWritable(db: Db, workspaceId: string) {
  const state = await writeState(db, workspaceId);
  if (!state.canWrite) throw forbidden(state.reason ?? 'Google Calendar is not connected.');
  const [conn] = await db.select().from(calendarConnections).where(and(
    eq(calendarConnections.workspaceId, workspaceId),
    eq(calendarConnections.provider, 'google'),
  ));
  return conn!;
}

/** A calendar Life OS may actually write to. */
async function writableCalendar(db: Db, workspaceId: string, calendarId: string) {
  const [cal] = await db.select().from(calendars).where(and(
    eq(calendars.workspaceId, workspaceId), eq(calendars.id, calendarId),
  ));
  if (!cal) throw notFound('That calendar is not connected.');
  if (cal.isReadOnly) {
    throw forbidden(`You can read “${cal.name}” but not add to it. Choose another calendar.`);
  }
  return cal;
}

/* ══ Time ════════════════════════════════════════════════════════════════
 *
 * Every timed event carries an explicit zone. A floating "14:00" is a value
 * that means something different depending on where it is read, which is
 * exactly the bug that makes calendars untrustworthy across a timezone change.
 */

const asGoogleTime = (d: EventDraft, zone: string) => (d.isAllDay
  ? {
    start: { date: d.startDate },
    // Google's all-day end is EXCLUSIVE; ours is the last day, inclusive.
    end: { date: shiftDay(d.endDate ?? d.startDate ?? '', 1) },
  }
  : {
    start: { dateTime: d.startsAt, timeZone: d.timeZone ?? zone },
    end: { dateTime: d.endsAt, timeZone: d.timeZone ?? zone },
  });

function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

function validateDraft(d: EventDraft) {
  if (!d.title || !d.title.trim()) throw badRequest('An event needs a title.');
  if (d.eventType === 'birthday') {
    /* Google refuses a birthday that is not all-day and annual, and its
     * refusal is a 400 with a message about eventType that means nothing to
     * anyone. Better to be clear here. */
    if (!d.isAllDay) throw badRequest('A birthday is an all-day event.');
    if (!(d.recurrence ?? []).some((r) => /FREQ=YEARLY/.test(r))) {
      throw badRequest('A birthday repeats every year.');
    }
  }
  if (d.isAllDay) {
    if (!d.startDate) throw badRequest('An all-day event needs a date.');
  } else {
    if (!d.startsAt || !d.endsAt) throw badRequest('An event needs a start and an end.');
    if (new Date(d.endsAt) <= new Date(d.startsAt)) {
      throw badRequest('The event ends before it starts.');
    }
  }
  for (const a of d.attendees ?? []) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) throw badRequest(`“${a}” is not an email address.`);
  }
}

/* ══ Conflicts ═══════════════════════════════════════════════════════════ */

/**
 * Busy time that overlaps a proposed slot.
 *
 * Only calendars marked as counting for busy are asked, because a birthdays
 * calendar that "conflicts" with everything makes the warning meaningless. The
 * result is a WARNING, never a block: Google lets you double-book, people
 * double-book on purpose, and an app that refuses is an app that gets worked
 * around.
 */
export async function checkAvailability(db: Db, workspaceId: string, opts: {
  startsAt: string; endsAt: string; ignoreProviderEventId?: string;
}) {
  const conn = await requireWritable(db, workspaceId).catch(() => null);
  if (!conn) return { conflicts: [], checked: false };

  const busyCals = await db.select().from(calendars).where(and(
    eq(calendars.workspaceId, workspaceId),
    eq(calendars.countsAsBusy, true),
    eq(calendars.isSynthetic, false),
  ));
  if (!busyCals.length) return { conflicts: [], checked: true };

  const token = await accessTokenFor(db, conn.id);
  const busy = await G.freeBusy(token, busyCals.map((c) => c.providerCalendarId),
    opts.startsAt, opts.endsAt);

  const from = new Date(opts.startsAt).getTime();
  const to = new Date(opts.endsAt).getTime();
  const byProvider = new Map(busyCals.map((c) => [c.providerCalendarId, c]));
  const conflicts: { title: string | null; start: string; end: string; calendar: string }[] = [];

  for (const [providerId, spans] of Object.entries(busy)) {
    for (const span of spans) {
      const s = new Date(span.start).getTime();
      const e = new Date(span.end).getTime();
      if (e <= from || s >= to) continue;
      /* free/busy returns times only — by design, since that is all the
       * narrower scope grants. A title, where we happen to have one, comes
       * from our own mirror rather than from a second, wider Google call. */
      const cal = byProvider.get(providerId);
      const [known] = cal ? await db.select({ title: calendarEvents.title, pid: calendarEvents.providerEventId })
        .from(calendarEvents)
        .where(and(
          eq(calendarEvents.workspaceId, workspaceId),
          eq(calendarEvents.calendarId, cal.id),
          eq(calendarEvents.startsAt, new Date(span.start)),
        )).limit(1) : [];
      if (known && opts.ignoreProviderEventId && known.pid === opts.ignoreProviderEventId) continue;
      conflicts.push({
        title: known?.title ?? null,
        start: span.start,
        end: span.end,
        calendar: cal?.name ?? 'Calendar',
      });
    }
  }
  return { conflicts, checked: true };
}

/* ══ Propose ═════════════════════════════════════════════════════════════ */

const fmtWhen = (d: EventDraft) => {
  if (d.isAllDay) {
    const a = d.startDate ?? '';
    const b = d.endDate && d.endDate !== d.startDate ? ` – ${d.endDate}` : '';
    return `All day · ${a}${b}`;
  }
  const s = new Date(d.startsAt!);
  const e = new Date(d.endsAt!);
  const zone = d.timeZone ?? 'UTC';
  const day = s.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: zone,
  });
  const t = (x: Date) => x.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: zone,
  });
  return `${day} · ${t(s)}–${t(e)}`;
};

const recurrenceWords = (rules: string[] | null | undefined) => {
  const rule = (rules ?? []).find((r) => r.startsWith('RRULE'));
  if (!rule) return null;
  const freq = /FREQ=(\w+)/.exec(rule)?.[1];
  const count = /COUNT=(\d+)/.exec(rule)?.[1];
  const until = /UNTIL=(\d{8})/.exec(rule)?.[1];
  const word = { DAILY: 'Every day', WEEKLY: 'Every week', MONTHLY: 'Every month', YEARLY: 'Every year' }[freq ?? ''] ?? 'Repeats';
  if (count) return `${word}, ${count} times`;
  if (until) return `${word}, until ${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
  return word;
};

/**
 * Prepare a change and describe it. Touches Google only to check availability.
 *
 * The summary produced here is what the confirmation screen renders — one
 * description of the change, built once, on the server. If the screen built
 * its own, the thing the user agreed to and the thing that executed could
 * drift apart, which is the whole failure mode a confirmation exists to
 * prevent.
 */
export async function proposeCreateEvent(db: Db, workspaceId: string, input: {
  requestId: string; calendarId: string; draft: EventDraft; origin?: string; userId?: string | null;
}): Promise<Proposal> {
  await requireWritable(db, workspaceId);
  const cal = await writableCalendar(db, workspaceId, input.calendarId);
  validateDraft(input.draft);

  const conflicts = input.draft.isAllDay ? { conflicts: [] } : await checkAvailability(db, workspaceId, {
    startsAt: input.draft.startsAt!, endsAt: input.draft.endsAt!,
  }).catch(() => ({ conflicts: [] as any[] }));

  const summary = {
    title: input.draft.title!.trim(),
    when: fmtWhen(input.draft),
    calendar: cal.name,
    location: input.draft.location ?? null,
    attendees: input.draft.attendees ?? [],
    recurrence: recurrenceWords(input.draft.recurrence),
    warnings: input.draft.attendees?.length && input.draft.notifyGuests
      ? ['Google will email the guests when this is added.'] : [],
  };

  const [row] = await db.insert(calendarMutations).values({
    workspaceId,
    requestId: input.requestId,
    kind: 'calendar.create',
    status: 'proposed',
    origin: input.origin ?? 'user',
    calendarId: cal.id,
    scope: 'single',
    payload: input.draft as any,
    summary: summary as any,
    createdBy: input.userId ?? null,
  }).onConflictDoUpdate({
    target: [calendarMutations.workspaceId, calendarMutations.requestId],
    set: { payload: input.draft as any, summary: summary as any, updatedAt: new Date() },
  }).returning();

  return {
    id: row!.id,
    requestId: input.requestId,
    kind: 'calendar.create',
    status: row!.status as any,
    scope: 'single',
    calendar: { id: cal.id, name: cal.name, providerCalendarId: cal.providerCalendarId },
    summary,
    conflicts: conflicts.conflicts,
    payload: input.draft,
  };
}

/** The event, its calendar, and the connection that owns it. */
async function loadEvent(db: Db, workspaceId: string, eventId: string) {
  const [row] = await db.select({ event: calendarEvents, calendar: calendars })
    .from(calendarEvents)
    .innerJoin(calendars, eq(calendarEvents.calendarId, calendars.id))
    .where(and(eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.id, eventId)));
  if (!row) throw notFound('That event is no longer here.');
  if (!row.event.providerEventId) {
    throw badRequest('That is a Life OS item, not a Google event.');
  }
  if (G.isReadOnlyEventType(row.event.eventType)) {
    throw forbidden('Google does not allow this kind of event to be changed from another app.');
  }
  if (row.calendar.isReadOnly) {
    throw forbidden(`“${row.calendar.name}” is read-only, so this event cannot be changed here.`);
  }
  return row;
}

export async function proposeUpdateEvent(db: Db, workspaceId: string, input: {
  requestId: string; eventId: string; draft: EventDraft; scope?: MutationScope;
  origin?: string; userId?: string | null;
}): Promise<Proposal> {
  await requireWritable(db, workspaceId);
  const { event, calendar } = await loadEvent(db, workspaceId, input.eventId);
  const scope: MutationScope = input.scope
    ?? (event.recurringEventId ? 'instance' : 'single');

  const merged: EventDraft = {
    title: input.draft.title ?? event.title ?? '',
    description: input.draft.description ?? event.description,
    location: input.draft.location ?? event.location,
    isAllDay: input.draft.isAllDay ?? event.isAllDay,
    startDate: input.draft.startDate ?? event.startDate,
    endDate: input.draft.endDate ?? event.endDate,
    startsAt: input.draft.startsAt ?? event.startsAt?.toISOString() ?? null,
    endsAt: input.draft.endsAt ?? event.endsAt?.toISOString() ?? null,
    timeZone: input.draft.timeZone ?? event.timeZone,
    attendees: input.draft.attendees,
    recurrence: input.draft.recurrence ?? undefined,
    reminders: input.draft.reminders,
    useDefaultReminders: input.draft.useDefaultReminders,
    notifyGuests: input.draft.notifyGuests,
  };
  validateDraft(merged);

  /* What actually changed, named in the words the confirmation will use.
   * "Update Google Calendar?" is a question nobody can answer without being
   * told what the update IS. */
  const before: EventDraft = {
    title: event.title ?? '', isAllDay: event.isAllDay,
    startDate: event.startDate, endDate: event.endDate,
    startsAt: event.startsAt?.toISOString() ?? null,
    endsAt: event.endsAt?.toISOString() ?? null,
    timeZone: event.timeZone,
  };
  const changes: { field: string; from: string; to: string }[] = [];
  if ((event.title ?? '') !== merged.title) {
    changes.push({ field: 'Title', from: event.title ?? '—', to: merged.title! });
  }
  if (fmtWhen(before) !== fmtWhen(merged)) {
    changes.push({ field: 'When', from: fmtWhen(before), to: fmtWhen(merged) });
  }
  if ((event.location ?? '') !== (merged.location ?? '')) {
    changes.push({ field: 'Where', from: event.location || '—', to: merged.location || '—' });
  }
  if ((event.description ?? '') !== (merged.description ?? '')) {
    changes.push({ field: 'Details', from: 'changed', to: 'changed' });
  }
  if (!changes.length) throw badRequest('Nothing has changed.');

  const moved = fmtWhen(before) !== fmtWhen(merged);
  const conflicts = moved && !merged.isAllDay
    ? await checkAvailability(db, workspaceId, {
      startsAt: merged.startsAt!, endsAt: merged.endsAt!,
      ignoreProviderEventId: event.providerEventId!,
    }).catch(() => ({ conflicts: [] as any[] }))
    : { conflicts: [] as any[] };

  const summary = {
    title: merged.title!,
    when: fmtWhen(merged),
    calendar: calendar.name,
    location: merged.location ?? null,
    changes,
    warnings: scope === 'series'
      ? ['This changes every event in the series.'] : [],
  };

  const [row] = await db.insert(calendarMutations).values({
    workspaceId,
    requestId: input.requestId,
    kind: 'calendar.update',
    status: 'proposed',
    origin: input.origin ?? 'user',
    calendarId: calendar.id,
    eventId: event.id,
    providerEventId: event.providerEventId,
    scope,
    payload: merged as any,
    summary: summary as any,
    createdBy: input.userId ?? null,
  }).onConflictDoUpdate({
    target: [calendarMutations.workspaceId, calendarMutations.requestId],
    set: { payload: merged as any, summary: summary as any, scope, updatedAt: new Date() },
  }).returning();

  return {
    id: row!.id,
    requestId: input.requestId,
    kind: 'calendar.update',
    status: row!.status as any,
    scope,
    calendar: { id: calendar.id, name: calendar.name, providerCalendarId: calendar.providerCalendarId },
    summary,
    conflicts: conflicts.conflicts,
    payload: merged,
  };
}

export async function proposeDeleteEvent(db: Db, workspaceId: string, input: {
  requestId: string; eventId: string; scope?: MutationScope; origin?: string; userId?: string | null;
}): Promise<Proposal> {
  await requireWritable(db, workspaceId);
  const { event, calendar } = await loadEvent(db, workspaceId, input.eventId);
  const scope: MutationScope = input.scope
    ?? (event.recurringEventId ? 'instance' : 'single');

  const draft: EventDraft = {
    title: event.title ?? '', isAllDay: event.isAllDay,
    startDate: event.startDate, endDate: event.endDate,
    startsAt: event.startsAt?.toISOString() ?? null,
    endsAt: event.endsAt?.toISOString() ?? null,
    timeZone: event.timeZone,
  };
  const summary = {
    title: event.title ?? 'Untitled event',
    when: fmtWhen(draft),
    calendar: calendar.name,
    location: event.location,
    warnings: scope === 'series'
      ? ['This removes every event in the series.']
      : (event.recurringEventId ? ['Only this occurrence is removed.'] : []),
  };

  const [row] = await db.insert(calendarMutations).values({
    workspaceId,
    requestId: input.requestId,
    kind: 'calendar.delete',
    status: 'proposed',
    origin: input.origin ?? 'user',
    calendarId: calendar.id,
    eventId: event.id,
    providerEventId: event.providerEventId,
    scope,
    summary: summary as any,
    createdBy: input.userId ?? null,
  }).onConflictDoUpdate({
    target: [calendarMutations.workspaceId, calendarMutations.requestId],
    set: { summary: summary as any, scope, updatedAt: new Date() },
  }).returning();

  return {
    id: row!.id,
    requestId: input.requestId,
    kind: 'calendar.delete',
    status: row!.status as any,
    scope,
    calendar: { id: calendar.id, name: calendar.name, providerCalendarId: calendar.providerCalendarId },
    summary,
    payload: draft,
  };
}

/* ══ Execute ═════════════════════════════════════════════════════════════ */

const eventBody = (d: EventDraft, zone: string): G.EventWrite => ({
  summary: d.title,
  description: d.description ?? undefined,
  location: d.location ?? undefined,
  ...asGoogleTime(d, zone),
  ...(d.attendees?.length ? { attendees: d.attendees.map((email) => ({ email })) } : {}),
  ...(d.recurrence?.length ? { recurrence: d.recurrence } : {}),
  ...(d.transparency ? { transparency: d.transparency } : {}),
  ...(d.visibility ? { visibility: d.visibility } : {}),
  ...(d.eventType ? { eventType: d.eventType } : {}),
  ...(d.useDefaultReminders === false && d.reminders
    ? {
      reminders: {
        useDefault: false,
        overrides: d.reminders.map((r) => ({ method: r.method ?? 'popup', minutes: r.minutes })),
      },
    }
    : d.useDefaultReminders === true ? { reminders: { useDefault: true } } : {}),
});

/**
 * Turn a Google API failure into something a person can act on.
 *
 * Raw Google JSON in a toast tells the user nothing and tells an attacker more
 * than it should. The detail stays in the server log.
 */
function friendly(e: unknown): Error {
  /* An ApiError is already a decided, user-facing answer — including the
   * stale-etag conflict this file raises itself. Running it through the
   * Google translator would turn "this changed in Google while you were
   * editing" into a generic "Google did not accept that change", which is
   * both wrong and unactionable. */
  if (e instanceof ApiError) return e;
  const g = e as any;
  const status = g?.status;
  const reason = String(g?.reason ?? '');
  if (status === 401 || status === 403) {
    if (/insufficient|scope/i.test(reason) || /insufficient/i.test(String(g?.message))) {
      return forbidden('Life OS does not have permission to change this calendar. Reconnect Google Calendar.');
    }
    if (/forbiddenForNonOrganizer|cannotChangeOrganizer/i.test(reason)) {
      return forbidden('Only the event organiser can change this one.');
    }
    return forbidden('Google refused that change. You may not have edit access to this calendar.');
  }
  if (status === 404 || status === 410) {
    return conflict('That event is no longer in Google Calendar. It may have been deleted elsewhere.');
  }
  if (status === 409) return conflict('Google already has an event with that identity.');
  if (status === 400 && /recurrence/i.test(reason + String(g?.message))) {
    return badRequest('Google did not accept that repeat pattern.');
  }
  if (status === 429 || status === 403 && /rateLimit|quota/i.test(reason)) {
    return upstreamUnavailable('Google is rate-limiting Life OS. Try again in a moment.');
  }
  if (status === 0 || status >= 500) {
    return upstreamUnavailable('Google is not responding right now. Nothing was changed.');
  }
  return badRequest('Google did not accept that change.');
}

/** Writes Google's own answer into the mirror, so the app shows the truth. */
async function mirrorFromGoogle(db: Db, workspaceId: string, calendarId: string, raw: any) {
  const m = G.mapEvent(raw);
  if (!m) return null;
  const { attendees, ...row } = m;
  const values = {
    workspaceId, calendarId, ...row,
    syncState: 'synced' as const, isSynthetic: false,
    lastSyncedAt: new Date(), updatedAt: new Date(),
  };
  const [saved] = await db.insert(calendarEvents).values(values).onConflictDoUpdate({
    target: [calendarEvents.calendarId, calendarEvents.providerEventId],
    targetWhere: sqlNotNull(),
    set: values,
  }).returning();
  if (saved && attendees.length) {
    await db.delete(calendarEventAttendees).where(eq(calendarEventAttendees.eventId, saved.id));
    await db.insert(calendarEventAttendees).values(
      attendees.map((a: any) => ({ workspaceId, eventId: saved.id, ...a })),
    );
  }
  return saved ?? null;
}

// The partial index on provider_event_id needs its predicate repeated.
import { isNotNull, sql } from 'drizzle-orm';
const sqlNotNull = () => isNotNull(calendarEvents.providerEventId);

type ExecuteCtx = { userId?: string | null; log?: { warn: (o: unknown, m?: string) => void } };

/**
 * Do the thing, once.
 *
 * Idempotency is the mutation row, not a guess: a retry finds its own executed
 * record and returns what it already produced. Matching on title and time
 * would happily create a second identical appointment for anyone who genuinely
 * wanted two.
 */
export async function executeMutation(db: Db, workspaceId: string, requestId: string,
  ctx: ExecuteCtx = {}) {
  const [row] = await db.select().from(calendarMutations).where(and(
    eq(calendarMutations.workspaceId, workspaceId),
    eq(calendarMutations.requestId, requestId),
  ));
  if (!row) throw notFound('That change was not proposed, so it cannot be confirmed.');
  if (row.status === 'executed') {
    // Already done. Say so with the result rather than doing it twice.
    const [event] = row.eventId
      ? await db.select().from(calendarEvents).where(eq(calendarEvents.id, row.eventId))
      : [];
    return { alreadyDone: true, mutation: row, event: event ?? null };
  }
  if (row.status === 'cancelled') throw badRequest('That change was cancelled.');

  const conn = await requireWritable(db, workspaceId);
  const [cal] = row.calendarId
    ? await db.select().from(calendars).where(eq(calendars.id, row.calendarId)) : [];
  if (!cal) throw notFound('That calendar is no longer connected.');

  const token = await accessTokenFor(db, conn.id);
  const draft = (row.payload ?? {}) as EventDraft;
  const zone = cal.timeZone ?? 'UTC';
  const sendUpdates = draft.notifyGuests ? 'all' : 'none';

  await db.update(calendarMutations).set({ status: 'confirmed', updatedAt: new Date() })
    .where(eq(calendarMutations.id, row.id));

  try {
    if (row.kind === 'calendar.create') {
      const body = eventBody(draft, zone);
      /* The link back to Life OS, stored on the Google event itself. Identity
       * only — never content — so that a later reader can tell that this event
       * and that Task are the same commitment without matching on title. */
      body.extendedProperties = {
        private: {
          losWorkspace: workspaceId,
          losMutation: row.id,
          ...(draft as any).losTaskId ? { losTaskId: (draft as any).losTaskId } : {},
          ...(draft as any).losProjectId ? { losProjectId: (draft as any).losProjectId } : {},
        },
      };
      if (draft.withMeet) {
        body.conferenceData = {
          createRequest: { requestId: row.id, conferenceSolutionKey: { type: 'hangoutsMeet' } },
        };
      }
      const created = await G.insertEvent(token, cal.providerCalendarId, body,
        { sendUpdates, withMeet: !!draft.withMeet });
      const saved = await mirrorFromGoogle(db, workspaceId, cal.id, created);
      await db.update(calendarMutations).set({
        status: 'executed', eventId: saved?.id ?? null,
        providerEventId: created?.id ?? null, executedAt: new Date(), updatedAt: new Date(),
      }).where(eq(calendarMutations.id, row.id));
      return { alreadyDone: false, mutation: row, event: saved };
    }

    if (row.kind === 'calendar.update') {
      const targetId = await resolveTarget(db, token, cal, row);
      const updated = await G.patchEvent(token, cal.providerCalendarId, targetId,
        eventBody(draft, zone), { sendUpdates });
      const saved = await mirrorFromGoogle(db, workspaceId, cal.id, updated);
      // Google agreed, so a task scheduled by this event moves with it.
      if (saved?.id) await syncLinkedTaskTime(db, workspaceId, saved.id);
      await db.update(calendarMutations).set({
        status: 'executed', eventId: saved?.id ?? row.eventId,
        executedAt: new Date(), updatedAt: new Date(),
      }).where(eq(calendarMutations.id, row.id));
      return { alreadyDone: false, mutation: row, event: saved };
    }

    // Delete.
    const targetId = await resolveTarget(db, token, cal, row);
    await G.deleteEvent(token, cal.providerCalendarId, targetId, { sendUpdates });
    /* Google said yes, so the mirror updates NOW rather than waiting for the
     * webhook. The webhook is reconciliation; the user is standing here. */
    /* Release before the rows go: once the event is deleted the link has
     * nothing to point at, and the task would keep a time nothing explains. */
    if (row.eventId) await releaseLinkedTasks(db, workspaceId, [row.eventId]);
    if (row.scope === 'series' && row.eventId) {
      const [ev] = await db.select().from(calendarEvents)
        .where(eq(calendarEvents.id, row.eventId));
      const seriesId = ev?.recurringEventId ?? ev?.providerEventId;
      if (seriesId) {
        await db.delete(calendarEvents).where(and(
          eq(calendarEvents.workspaceId, workspaceId),
          eq(calendarEvents.calendarId, cal.id),
          eq(calendarEvents.recurringEventId, seriesId),
        ));
        await db.delete(calendarEvents).where(and(
          eq(calendarEvents.workspaceId, workspaceId),
          eq(calendarEvents.providerEventId, seriesId),
        ));
      }
    } else if (row.eventId) {
      await db.delete(calendarEvents).where(eq(calendarEvents.id, row.eventId));
    }
    await db.update(calendarMutations).set({
      status: 'executed', executedAt: new Date(), updatedAt: new Date(),
    }).where(eq(calendarMutations.id, row.id));
    return { alreadyDone: false, mutation: row, event: null };
  } catch (e) {
    await db.update(calendarMutations).set({
      status: 'failed',
      error: String((e as any)?.message ?? e).slice(0, 500),
      updatedAt: new Date(),
    }).where(eq(calendarMutations.id, row.id));
    ctx.log?.warn({ workspace: workspaceId, kind: row.kind, err: redactTokens(e) },
      'calendar mutation failed');
    throw friendly(e);
  }
}

/**
 * Which Google event id to actually touch.
 *
 * For a recurring event this is the difference between moving one appointment
 * and moving all of them — the single most destructive thing this file can get
 * wrong. `series` targets the master; anything else targets the instance,
 * which for an occurrence already synced IS its own provider event id.
 */
async function resolveTarget(db: Db, token: string, cal: typeof calendars.$inferSelect,
  row: typeof calendarMutations.$inferSelect): Promise<string> {
  const [ev] = row.eventId
    ? await db.select().from(calendarEvents).where(eq(calendarEvents.id, row.eventId)) : [];
  if (!ev?.providerEventId) throw notFound('That event is no longer here.');

  if (row.scope === 'series') {
    // The master, which is what the occurrence points at.
    return ev.recurringEventId ?? ev.providerEventId;
  }
  /* Concurrency: re-read before a risky change. If Google's copy has moved on
   * since the editor was opened, overwriting it silently would destroy a change
   * somebody made on their phone thirty seconds ago. */
  if (row.kind === 'calendar.update' && ev.etag) {
    const fresh = await G.getEvent(token, cal.providerCalendarId, ev.providerEventId).catch(() => null);
    if (fresh?.etag && fresh.etag !== ev.etag) {
      throw conflict('This event changed in Google Calendar while you were editing it. '
        + 'Reopen it to see the latest version.');
    }
  }
  return ev.providerEventId;
}

/* ══ Task ↔ Event ════════════════════════════════════════════════════════ */

export const TASK_EVENT_KIND = 'scheduled_as';

/**
 * Link a Task to a Google event.
 *
 * A Task stays a Task and an event stays an event; this is an edge between
 * them, not a conversion. Which is what lets "completed" and "deleted" mean
 * different things on each side — finishing the task does not erase the hour
 * it took, and cancelling the meeting does not mean the work is done.
 */
export async function linkTaskToEvent(db: Db, workspaceId: string,
  taskId: string, eventId: string, userId?: string | null) {
  const [task] = await db.select().from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)));
  if (!task) throw notFound('That task is no longer here.');
  const [event] = await db.select().from(calendarEvents)
    .where(and(eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.id, eventId)));
  if (!event) throw notFound('That event is no longer here.');

  await db.insert(itemLinks).values({
    workspaceId,
    kind: TASK_EVENT_KIND,
    sourceType: 'task',
    sourceId: taskId,
    targetType: 'event',
    targetId: eventId,
    metadata: {
      calendarId: event.calendarId,
      providerEventId: event.providerEventId,
      projectId: task.projectId ?? null,
      /* Remembered so that deleting the event later can tell "this task was
       * scheduled BECAUSE of this event" from "the user set a time by hand and
       * separately linked an event". Only the first should be cleared. */
      setScheduledAt: event.startsAt?.toISOString() ?? null,
    },
    createdBy: userId ?? null,
  }).onConflictDoNothing();

  /* Scheduling means "I intend to work on this at this time", and the task is
   * where that intention lives. Leaving it unscheduled while its event sits on
   * the calendar makes Today and the Calendar disagree about the same day.
   *
   * The DUE DATE is untouched, deliberately. "Due Friday" and "I will do it
   * Wednesday afternoon" are different statements, and collapsing them makes
   * both untrustworthy. */
  if (event.startsAt) {
    await db.update(tasks).set({ scheduledAt: event.startsAt, updatedAt: new Date() })
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)));
  }
  return { linked: true, scheduledAt: event.startsAt ?? null };
}

/**
 * Keeps a scheduled task in step with the event that represents it.
 *
 * Called after Google has confirmed a change — never before, because a task
 * that claims to be scheduled for a time Google refused is a lie the user
 * cannot see.
 */
export async function syncLinkedTaskTime(db: Db, workspaceId: string, eventId: string) {
  const [event] = await db.select().from(calendarEvents)
    .where(and(eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.id, eventId)));
  if (!event?.startsAt) return { updated: 0 };

  const links = await db.select().from(itemLinks).where(and(
    eq(itemLinks.workspaceId, workspaceId),
    eq(itemLinks.kind, TASK_EVENT_KIND),
    eq(itemLinks.targetType, 'event'),
    eq(itemLinks.targetId, eventId),
  ));
  for (const link of links) {
    await db.update(tasks).set({ scheduledAt: event.startsAt, updatedAt: new Date() })
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, link.sourceId)));
    await db.update(itemLinks)
      .set({ metadata: { ...(link.metadata as any ?? {}), setScheduledAt: event.startsAt.toISOString() } })
      .where(eq(itemLinks.id, link.id));
  }
  return { updated: links.length };
}

/**
 * The event that held a task's time has gone.
 *
 * The TASK stays — a plan that fell through is not work that stopped
 * mattering. Its scheduled time is cleared only if that time exists because of
 * this event; a time the user set by hand is theirs, not the calendar's. The
 * due date is never touched.
 */
export async function releaseLinkedTasks(db: Db, workspaceId: string, eventIds: string[]) {
  if (!eventIds.length) return { released: 0 };
  const links = await db.select().from(itemLinks).where(and(
    eq(itemLinks.workspaceId, workspaceId),
    eq(itemLinks.kind, TASK_EVENT_KIND),
    eq(itemLinks.targetType, 'event'),
    inArray(itemLinks.targetId, eventIds),
  ));
  for (const link of links) {
    const owned = (link.metadata as any)?.setScheduledAt;
    if (owned) {
      const [task] = await db.select().from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, link.sourceId)));
      // Only clear the time this event actually put there.
      if (task?.scheduledAt && task.scheduledAt.toISOString() === owned) {
        await db.update(tasks).set({ scheduledAt: null, updatedAt: new Date() })
          .where(eq(tasks.id, link.sourceId));
      }
    }
    await db.delete(itemLinks).where(eq(itemLinks.id, link.id));
  }
  return { released: links.length };
}

export async function unlinkTaskFromEvent(db: Db, workspaceId: string,
  taskId: string, eventId: string) {
  await db.delete(itemLinks).where(and(
    eq(itemLinks.workspaceId, workspaceId),
    eq(itemLinks.kind, TASK_EVENT_KIND),
    eq(itemLinks.sourceType, 'task'),
    eq(itemLinks.sourceId, taskId),
    eq(itemLinks.targetType, 'event'),
    eq(itemLinks.targetId, eventId),
  ));
  return { unlinked: true };
}
