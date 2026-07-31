/**
 * Google Calendar — READ-ONLY client and sync engine.
 *
 * Scope is `calendar.readonly` and nothing else. There is deliberately no
 * insert, patch or delete function anywhere in this file: a write path that
 * does not exist cannot be called by accident, which is a stronger guarantee
 * than a permission check someone might later remove.
 *
 * Two token systems live in this app and must never be confused:
 *   - Firebase ID tokens answer "who is signed into Life OS?"
 *   - These Google tokens answer "whose calendar may Life OS read?"
 * They have different lifetimes, different audiences and different storage.
 */
import { createHash, randomBytes } from 'node:crypto';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
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

async function tokenRequest(body: URLSearchParams): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    // The error description is safe to surface; the token payload never is.
    const desc = typeof json.error_description === 'string' ? json.error_description
      : typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
    throw new Error(`Google rejected the request: ${desc}`);
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
  const res = await fetch(`${API}${path}?${p.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
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
    sequence: typeof ev.sequence === 'number' ? ev.sequence : null,
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
