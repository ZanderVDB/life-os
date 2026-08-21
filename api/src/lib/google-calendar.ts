/**
 * Google Calendar — client and sync engine.
 *
 * This header used to say READ-ONLY, and that the scope was
 * `calendar.readonly` and nothing else. Both stopped being true when two-way
 * sync landed, and a stale comment about scopes is worse than none: it is the
 * first thing anyone reads when asked what this app requests, including when
 * filling in Google's verification form.
 *
 * What is true: writes exist, they live in calendar-mutations.ts, and every
 * one of them goes through propose → confirm, so nothing reaches a calendar
 * that the person has not agreed to on screen.
 *
 * Two token systems live in this app and must never be confused:
 *   - Firebase ID tokens answer "who is signed into Life OS?"
 *   - These Google tokens answer "whose calendar may Life OS read?"
 * They have different lifetimes, different audiences and different storage.
 */
import { createHash, randomBytes } from 'node:crypto';

/**
 * The scopes, chosen to be the narrowest set that does the job.
 *
 *   calendar.events              read AND write events on calendars the user
 *                                can already access. This is the write grant,
 *                                and it is per-EVENT: it confers no power to
 *                                create, delete or re-share calendars.
 *   calendar.calendarlist.readonly   list the user's calendars and read their
 *                                metadata — name, colour, timezone and,
 *                                critically, accessRole. Deliberately chosen
 *                                over the full `calendar.readonly`, which
 *                                would also hand over every event on every
 *                                calendar for no additional benefit.
 *   calendar.freebusy            availability only. Returns busy INTERVALS,
 *                                never titles, guests or details — exactly
 *                                what conflict checking needs and nothing more.
 *
 * Not requested, and not needed: `calendar` (full control), any ACL scope, or
 * `calendar.settings`. Life OS never manages calendars or their sharing.
 *
 * `calendar.events` supersedes the old `calendar.readonly` for events, so the
 * read paths keep working on the new grant. Everyone must re-consent, because
 * a scope set that gains write is a genuinely different request — see
 * SCOPES_VERSION.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.freebusy',
] as const;

export const GOOGLE_SCOPE = GOOGLE_SCOPES.join(' ');

/**
 * Bumped whenever the scope set changes.
 *
 * A connection stamped with an older version holds a token that cannot write,
 * however healthy it looks. Comparing versions is how the app knows to ask for
 * a reconnect BEFORE someone fills in an event form, rather than after.
 */
export const SCOPES_VERSION = 2;

/** The scope that actually grants writes. Everything else is reading. */
export const WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/**
 * Does this grant contain what Life OS actually needs?
 *
 * `GOOGLE_SCOPE` is a space-joined REQUEST string; `granted` is an array of
 * individual scopes. Checking `granted.includes(GOOGLE_SCOPE)` compares an
 * array against a joined string and is therefore false forever — which is
 * exactly what happened the moment the single readonly scope became three, and
 * it rejected every connection with "Google did not grant calendar read
 * access" while Google had granted everything asked for.
 *
 * Required is the smallest set that makes the product work: read/write events,
 * and the calendar list they live on. `freebusy` is genuinely optional —
 * without it the conflict warning is skipped and everything else is fine — so
 * a user who unticks it gets a working calendar, not a wall.
 *
 * The legacy full `calendar` scope satisfies both requirements, so anyone
 * holding one from before is not forced to re-consent for no reason.
 */
export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const;

const FULL_CALENDAR = 'https://www.googleapis.com/auth/calendar';

export function grantSatisfies(granted: string[] | null | undefined): {
  ok: boolean; missing: string[];
} {
  const have = new Set(granted ?? []);
  if (have.has(FULL_CALENDAR)) return { ok: true, missing: [] };
  const missing = REQUIRED_SCOPES.filter((s) => !have.has(s));
  /* The old read-only scope covers the calendar list too, so a grant that
   * still carries it only lacks the write half. */
  if (have.has(`${FULL_CALENDAR}.readonly`)) {
    return {
      ok: !missing.includes(REQUIRED_SCOPES[0]),
      missing: missing.filter((m) => m === REQUIRED_SCOPES[0]),
    };
  }
  return { ok: missing.length === 0, missing };
}

/** Availability checking is optional; its absence costs only the clash warning. */
export const grantCanCheckFreeBusy = (granted: string[] | null | undefined): boolean =>
  (granted ?? []).some((s) => s === 'https://www.googleapis.com/auth/calendar.freebusy'
    || s === FULL_CALENDAR);

/** Can this grant write events? Google returns what it actually gave us. */
export const grantCanWrite = (granted: string[] | null | undefined): boolean =>
  (granted ?? []).some((s) => s === WRITE_SCOPE
    || s === 'https://www.googleapis.com/auth/calendar');
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/* ── PKCE ─────────────────────────────────────────────────────────────── */
const b64url = (b: Buffer) => b.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createPkce() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export const createState = () => b64url(randomBytes(24));

/**
 * `access_type=offline` + `prompt=consent` because a refresh token is only
 * issued on the first consent otherwise, and a reconnect after disconnect
 * would silently arrive without one.
 */
export function authorizeUrl(cfg: GoogleConfig, state: string, challenge: string): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

/**
 * A token failure, with enough detail to tell a dead grant from a bad minute.
 *
 * This distinction is the whole reason the class exists. Before it, every
 * failure of `refreshAccessToken` — a Google 503, a DNS blip, a timeout, a
 * rate limit — was recorded as `revoked`, which is a PERMANENT state that
 * demands the user reconnect by hand. One bad second on Google's side and the
 * calendar stayed dead until somebody noticed and clicked a button.
 *
 * `permanent` is true only when Google has actually said the grant is gone.
 */
export class GoogleTokenError extends Error {
  readonly status: number;
  readonly code: string;
  readonly permanent: boolean;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'GoogleTokenError';
    this.status = status;
    this.code = code;
    /* `invalid_grant` is Google's way of saying the refresh token is dead:
     * revoked in the account's permissions, expired after long disuse, or
     * invalidated by a password change. `invalid_client` means our own
     * credentials are wrong, which no amount of retrying fixes either.
     *
     * Everything else — 429, 5xx, network, timeout — is a bad minute. */
    this.permanent = code === 'invalid_grant' || code === 'invalid_client'
      || code === 'unauthorized_client';
  }
}

/** True for anything worth trying again later rather than giving up on. */
export const isTransientTokenError = (e: unknown): boolean =>
  !(e instanceof GoogleTokenError) || !e.permanent;

async function tokenRequest(body: URLSearchParams): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    /* Never reached Google at all. This is the case that most often masqueraded
     * as a revoked grant, and it is the least permanent thing there is. */
    throw new GoogleTokenError(
      `Could not reach Google: ${e instanceof Error ? e.message : String(e)}`, 0, 'network');
  }
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    // The error description is safe to surface; the token payload never is.
    const desc = typeof json.error_description === 'string' ? json.error_description
      : typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
    const code = typeof json.error === 'string' ? json.error : `http_${res.status}`;
    throw new GoogleTokenError(`Google rejected the request: ${desc}`, res.status, code);
  }
  const expiresIn = Number(json.expires_in ?? 3600);
  return {
    accessToken: String(json.access_token),
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: String(json.scope ?? '').split(' ').filter(Boolean),
  };
}

export const exchangeCode = (cfg: GoogleConfig, code: string, verifier: string) =>
  tokenRequest(new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
  }));

export const refreshAccessToken = (cfg: GoogleConfig, refreshToken: string) =>
  tokenRequest(new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }));

/** Best-effort revocation. Google may already consider the grant gone. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ── API calls (GET only) ─────────────────────────────────────────────── */

class GoogleError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
  }
}

/** A 410 means the sync token is dead and a full resync is required. */
export const isSyncTokenInvalid = (e: unknown) =>
  e instanceof GoogleError && e.status === 410;

async function get(accessToken: string, path: string, params: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, v);
  let res: Response;
  try {
    res = await fetch(`${API}${path}?${p.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      /* A request that never settles is worse than one that fails. The
       * scheduler runs one pass at a time, so a single hung call would stop
       * every calendar syncing for as long as the process lived — the exact
       * silent, permanent stop this work exists to remove. */
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new GoogleError(
      `Could not reach Google: ${e instanceof Error ? e.message : String(e)}`, 0, 'network');
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({})) as any;
    const reason = j?.error?.errors?.[0]?.reason;
    throw new GoogleError(j?.error?.message ?? `Google returned ${res.status}`, res.status, reason);
  }
  return res.json() as Promise<any>;
}

export interface GoogleCalendarListEntry {
  id: string;
  summary: string;
  description?: string;
  backgroundColor?: string;
  timeZone?: string;
  accessRole: string;
  primary?: boolean;
  selected?: boolean;
}

/** Paginated: a long-standing account can easily exceed one page. */
export async function listCalendars(accessToken: string): Promise<GoogleCalendarListEntry[]> {
  const out: GoogleCalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const page = await get(accessToken, '/users/me/calendarList', {
      maxResults: '250', pageToken, showHidden: 'true',
    });
    out.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export interface EventPage {
  items: any[];
  nextSyncToken: string | null;
}

/**
 * Lists events, following pagination to the end.
 *
 * `singleEvents: true` expands recurring series into instances, which is what
 * a calendar view actually needs — a raw RRULE cannot be placed on a grid
 * without a recurrence engine. The series identity survives on each instance
 * as `recurringEventId` + `originalStartTime`, so the relationship is not lost.
 *
 * `showDeleted` is on during incremental sync so cancellations arrive and can
 * be removed locally; without it a deleted event would linger forever.
 */
export async function listEvents(accessToken: string, calendarId: string, opts: {
  syncToken?: string;
  timeMin?: string;
  timeMax?: string;
}): Promise<EventPage> {
  const items: any[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;

  do {
    const page: any = await get(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
      maxResults: '250',
      singleEvents: 'true',
      showDeleted: opts.syncToken ? 'true' : undefined,
      pageToken,
      // A sync token cannot be combined with a time window; it already encodes
      // the last position. Sending both is an error.
      ...(opts.syncToken
        ? { syncToken: opts.syncToken }
        : { timeMin: opts.timeMin, timeMax: opts.timeMax, orderBy: 'startTime' }),
    });
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
  } while (pageToken);

  return { items, nextSyncToken };
}

/** The connected account's identity — used only for display, masked in UI. */
export async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const j = await res.json() as any;
    return typeof j.email === 'string' ? j.email : null;
  } catch {
    return null;
  }
}

/* ── Mapping ──────────────────────────────────────────────────────────── */

/** Google's access roles, reduced to the single question the UI asks. */
export const roleIsReadOnly = (role: string) => role !== 'owner' && role !== 'writer';

/**
 * Maps one Google event onto our row shape.
 *
 * Returns null for events that carry no usable start — Google occasionally
 * returns these for malformed entries, and a row with no time cannot be placed.
 */
export function mapEvent(ev: any) {
  const isAllDay = !!ev.start?.date;
  const startsAt = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
  const endsAt = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
  const startDate = ev.start?.date ?? null;
  if (!startsAt && !startDate) return null;

  return {
    providerEventId: ev.id as string,
    icalUid: ev.iCalUID ?? null,
    title: ev.summary ?? '(no title)',
    description: ev.description ?? null,
    location: ev.location ?? null,
    isAllDay,
    startsAt,
    endsAt,
    startDate,
    // Google's all-day end date is EXCLUSIVE; ours is inclusive, so a one-day
    // event would otherwise render as two.
    endDate: ev.end?.date ? shiftDay(ev.end.date, -1) : null,
    timeZone: ev.start?.timeZone ?? null,
    recurrence: ev.recurrence ?? null,
    recurringEventId: ev.recurringEventId ?? null,
    originalStartTime: ev.originalStartTime?.dateTime
      ? new Date(ev.originalStartTime.dateTime)
      : (ev.originalStartTime?.date ? new Date(`${ev.originalStartTime.date}T00:00:00Z`) : null),
    status: ev.status ?? 'confirmed',
    transparency: ev.transparency ?? 'opaque',
    visibility: ev.visibility ?? 'default',
    providerColorId: ev.colorId ?? null,
    eventType: ev.eventType ?? null,
    hangoutLink: ev.hangoutLink ?? null,
    conferenceData: ev.conferenceData ?? null,
    organizerEmail: ev.organizer?.email ?? null,
    providerHtmlLink: ev.htmlLink ?? null,
    etag: ev.etag ?? null,
    /* 0, never null: the column is NOT NULL DEFAULT 0, and an explicit null
     * OVERRIDES the default rather than falling back to it. An event without a
     * sequence therefore failed to insert — and because one failed insert
     * aborts the whole calendar before its sync token advances, a single such
     * event stopped that calendar syncing on every pass thereafter. */
    sequence: typeof ev.sequence === 'number' ? ev.sequence : 0,
    providerCreatedAt: ev.created ? new Date(ev.created) : null,
    providerUpdatedAt: ev.updated ? new Date(ev.updated) : null,
    attendees: (ev.attendees ?? []).map((a: any) => ({
      email: a.email ?? '',
      displayName: a.displayName ?? null,
      responseStatus: a.responseStatus ?? 'needsAction',
      isSelf: !!a.self,
      isOrganizer: !!a.organizer,
      isOptional: !!a.optional,
    })),
  };
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}


/* ══ Writing ═════════════════════════════════════════════════════════════
 *
 * Every mutating call goes through `send`, the counterpart to `get`. One
 * chokepoint each way, so "what can this code do to somebody's calendar" is
 * answerable by reading two functions rather than auditing every call site.
 *
 * These are called ONLY by the mutation service (calendar-mutations.ts), which
 * is what enforces that a write is always preceded by a confirmed proposal.
 */

async function send(accessToken: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string, body?: unknown, params: Record<string, string | undefined> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, v);
  const qs = p.toString();

  let res: Response;
  try {
    res = await fetch(`${API}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new GoogleError(
      `Could not reach Google: ${e instanceof Error ? e.message : String(e)}`, 0, 'network');
  }

  // 204 on DELETE, and 410 meaning "already gone", which is a success for us.
  if (res.status === 204 || res.status === 410) return null;
  const json = await res.json().catch(() => ({})) as any;
  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason;
    throw new GoogleError(json?.error?.message ?? `Google returned ${res.status}`,
      res.status, reason);
  }
  return json;
}

/** One event, fresh from Google. Used to reconcile before a risky update. */
export const getEvent = (accessToken: string, calendarId: string, eventId: string) =>
  get(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {});

export type EventWrite = {
  summary?: string;
  description?: string | null;
  location?: string | null;
  start?: any;
  end?: any;
  attendees?: { email: string; optional?: boolean }[];
  recurrence?: string[] | null;
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] };
  conferenceData?: any;
  transparency?: string;
  visibility?: string;
  extendedProperties?: { private?: Record<string, string> };
  eventType?: string;
};

/**
 * Create an event.
 *
 * `requestId` is Google's own idempotency key for conference creation, and we
 * reuse the Life OS mutation id for it so a retried create cannot produce a
 * second Meet link. Duplicate-event protection itself is ours — see
 * calendar-mutations.ts — because Google has no idempotency key for
 * events.insert.
 */
export const insertEvent = (accessToken: string, calendarId: string, body: EventWrite,
  opts: { sendUpdates?: string; withMeet?: boolean } = {}) =>
  send(accessToken, 'POST', `/calendars/${encodeURIComponent(calendarId)}/events`, body, {
    sendUpdates: opts.sendUpdates ?? 'none',
    conferenceDataVersion: opts.withMeet ? '1' : undefined,
    supportsAttachments: 'false',
  });

/**
 * Update an event, refusing to clobber a newer version.
 *
 * `If-Match` is not available on this endpoint the way it is on some APIs, so
 * concurrency is enforced one level up: the service re-reads the event and
 * compares etags before calling this. PATCH rather than PUT so that fields
 * Life OS does not model — attachments, colours set on a phone — survive.
 */
export const patchEvent = (accessToken: string, calendarId: string, eventId: string,
  body: EventWrite, opts: { sendUpdates?: string; withMeet?: boolean } = {}) =>
  send(accessToken, 'PATCH',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, body, {
      sendUpdates: opts.sendUpdates ?? 'none',
      conferenceDataVersion: opts.withMeet ? '1' : undefined,
    });

export const deleteEvent = (accessToken: string, calendarId: string, eventId: string,
  opts: { sendUpdates?: string } = {}) =>
  send(accessToken, 'DELETE',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    undefined, { sendUpdates: opts.sendUpdates ?? 'none' });

/**
 * One instance of a recurring event.
 *
 * Editing "just this one" means finding the INSTANCE and patching it, not
 * patching the series master — which is the difference between moving one
 * appointment and moving every appointment forever.
 */
export async function listInstances(accessToken: string, calendarId: string, eventId: string,
  opts: { timeMin?: string; timeMax?: string; maxResults?: number } = {}) {
  const page: any = await get(accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}/instances`, {
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      maxResults: String(opts.maxResults ?? 50),
    });
  return (page.items ?? []) as any[];
}

/**
 * Busy intervals across calendars.
 *
 * Returns times only — no titles, no guests. That is the whole reason
 * `calendar.freebusy` is a separate, narrower scope, and the reason conflict
 * checking can look at calendars whose contents Life OS never reads.
 */
export async function freeBusy(accessToken: string, calendarIds: string[],
  timeMin: string, timeMax: string) {
  if (!calendarIds.length) return {} as Record<string, { start: string; end: string }[]>;
  const json = await send(accessToken, 'POST', '/freeBusy', {
    timeMin, timeMax, items: calendarIds.map((id) => ({ id })),
  });
  const out: Record<string, { start: string; end: string }[]> = {};
  for (const [id, v] of Object.entries((json?.calendars ?? {}) as Record<string, any>)) {
    out[id] = (v?.busy ?? []) as { start: string; end: string }[];
  }
  return out;
}

/* ══ Push notifications ══════════════════════════════════════════════════ */

export type WatchChannel = {
  id: string; resourceId: string; resourceUri?: string; expiration?: string;
};

/**
 * Ask Google to tell us when a calendar changes.
 *
 * The `token` travels back on every notification and is how a POST is matched
 * to a workspace. It therefore carries an opaque secret and NOTHING else — no
 * OAuth token, no ids that mean anything to anyone who intercepts it.
 */
export async function watchEvents(accessToken: string, calendarId: string, opts: {
  channelId: string; address: string; token: string; ttlSeconds?: number;
}): Promise<WatchChannel> {
  const json = await send(accessToken, 'POST',
    `/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
      id: opts.channelId,
      type: 'web_hook',
      address: opts.address,
      token: opts.token,
      params: { ttl: String(opts.ttlSeconds ?? 7 * 24 * 3600) },
    });
  return {
    id: json.id, resourceId: json.resourceId,
    resourceUri: json.resourceUri, expiration: json.expiration,
  };
}

/** Politely close a channel. Best effort — an expired one is already closed. */
export async function stopChannel(accessToken: string, channelId: string, resourceId: string) {
  try {
    await stopChannelRaw(accessToken, { id: channelId, resourceId });
    return true;
  } catch { return false; }
}

/** channels.stop lives at the API root, not under /calendars. */
async function stopChannelRaw(accessToken: string, body: unknown) {
  const res = await fetch(`${API}/channels/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 404) throw new GoogleError('channels.stop failed', res.status);
}

/* ══ Mapping, outbound ═══════════════════════════════════════════════════ */

/** Google's time shape: a date for all-day, a dateTime plus zone otherwise. */
export const timePoint = (v: { date?: string | null; dateTime?: string | null; timeZone?: string | null }) =>
  (v.date ? { date: v.date } : { dateTime: v.dateTime, timeZone: v.timeZone ?? undefined });

/** True when Google says this event is one Life OS must not offer to edit. */
export const EVENT_TYPES_READ_ONLY = new Set(['fromGmail', 'birthday', 'workingLocation']);
export const isReadOnlyEventType = (t: string | null | undefined) =>
  !!t && EVENT_TYPES_READ_ONLY.has(t);
