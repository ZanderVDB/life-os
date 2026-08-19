/**
 * Google push notifications: opening them, renewing them, closing them.
 *
 * ── What a notification actually is ─────────────────────────────────────
 *
 * Google does NOT send the changed event. It sends "something on the resource
 * you asked about changed" — a channel id, a resource id, and a token we chose
 * ourselves. Everything else has to be looked up locally and then fetched
 * incrementally. That shapes the whole design: the webhook's job is to map a
 * near-empty POST to a workspace, safely, and hand off to the sync that
 * already exists.
 *
 * ── Why they expire, and why that matters ───────────────────────────────
 *
 * Channels last days, not forever. A calendar whose watch quietly lapsed keeps
 * looking connected and stops being current — the same silent, permanent stop
 * as the disconnect bug, wearing a different hat. So renewal is a scheduled
 * job with a margin, not a hope.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { calendarConnections, calendars, calendarWatchChannels } from '../db/schema.js';
import { redactTokens } from './token-crypto.js';
import * as G from './google-calendar.js';
import { accessTokenFor } from './calendar-sync.js';
import type { SyncLogger } from './calendar-sync.js';

/** How long a channel is requested for, and how early it is replaced. */
export const CHANNEL_TTL_SECONDS = 7 * 24 * 3600;
export const RENEW_MARGIN_MS = 24 * 3600 * 1000;

/**
 * Where Google should POST.
 *
 * Derived from the OAuth redirect URI by default, because that is already
 * configured, already points at this API, and is already HTTPS in every
 * deployment where watches could work at all. Asking for the same origin twice
 * would be a second thing to get wrong, and the failure mode — watches
 * silently never opening — is invisible.
 *
 * The explicit variable still wins, for the case where Google should reach the
 * API by a different route than the browser does.
 */
export function webhookUrl(): string {
  const explicit = process.env.GOOGLE_CALENDAR_WEBHOOK_URL;
  if (explicit) return explicit;
  const redirect = process.env.GOOGLE_CALENDAR_REDIRECT_URI ?? '';
  try {
    const u = new URL(redirect);
    if (u.protocol !== 'https:') return '';     // Google refuses anything else
    return `${u.origin}/api/v1/integrations/google-calendar/notifications`;
  } catch { return ''; }
}

/**
 * The public address must be HTTPS and must be reachable by Google.
 *
 * A watch registered against a localhost URL is not merely useless; Google
 * refuses it, and the failure is worth reporting rather than retrying forever.
 */
export const webhookConfigured = () => /^https:\/\/[^/]+\//.test(webhookUrl());

/**
 * Open a watch on every visible calendar that does not already have a live one.
 *
 * Idempotent, because it is called after connecting, after reconnecting, and
 * from the renewal sweep — and opening a second channel for the same calendar
 * would double every notification for as long as both survived.
 */
export async function ensureWatches(db: Db, workspaceId: string, log: SyncLogger) {
  if (!webhookConfigured()) return { opened: 0, skipped: 'no webhook url' as const };

  const [conn] = await db.select().from(calendarConnections).where(and(
    eq(calendarConnections.workspaceId, workspaceId),
    eq(calendarConnections.provider, 'google'),
  ));
  if (!conn || conn.status === 'revoked') return { opened: 0, skipped: 'not connected' as const };

  const cals = await db.select().from(calendars).where(and(
    eq(calendars.workspaceId, workspaceId),
    eq(calendars.connectionId, conn.id),
    eq(calendars.isVisible, true),
    eq(calendars.isSynthetic, false),
  ));

  /* "Has this calendar got a live channel at all?" — NOT "is it comfortably
   * far from expiry", which is renewWatches's question. Asking the same
   * question in both places made them both replace the same expiring channel,
   * doubling every notification until one lapsed. One job each. */
  const now = new Date();
  let opened = 0;
  for (const cal of cals) {
    const [live] = await db.select().from(calendarWatchChannels).where(and(
      eq(calendarWatchChannels.calendarId, cal.id),
      eq(calendarWatchChannels.status, 'active'),
      sql`${calendarWatchChannels.expiresAt} > ${now}`,
    )).limit(1);
    if (live) continue;
    if (await openWatch(db, conn, cal, log)) opened++;
  }
  return { opened, skipped: null };
}

/** One channel, recorded before Google is called so a crash cannot orphan it. */
async function openWatch(db: Db, conn: typeof calendarConnections.$inferSelect,
  cal: typeof calendars.$inferSelect, log: SyncLogger): Promise<boolean> {
  /* The channel id is ours and random; the token is a separate random secret.
   * Neither encodes anything — not the workspace, not the calendar, and
   * certainly not a credential — so a notification that leaks tells an
   * observer nothing, and a forged one matches no row. */
  const channelId = `los-${randomBytes(16).toString('hex')}`;
  const verificationToken = randomBytes(24).toString('base64url');

  const [row] = await db.insert(calendarWatchChannels).values({
    workspaceId: conn.workspaceId,
    connectionId: conn.id,
    calendarId: cal.id,
    channelId,
    verificationToken,
    status: 'failed',            // promoted only once Google has agreed
  }).returning();

  try {
    const token = await accessTokenFor(db, conn.id);
    const channel = await G.watchEvents(token, cal.providerCalendarId, {
      channelId,
      address: webhookUrl(),
      token: verificationToken,
      ttlSeconds: CHANNEL_TTL_SECONDS,
    });
    await db.update(calendarWatchChannels).set({
      resourceId: channel.resourceId,
      resourceUri: channel.resourceUri ?? null,
      expiresAt: channel.expiration ? new Date(Number(channel.expiration)) : null,
      status: 'active',
      lastError: null,
      updatedAt: new Date(),
    }).where(eq(calendarWatchChannels.id, row!.id));
    return true;
  } catch (e) {
    await db.update(calendarWatchChannels).set({
      status: 'failed',
      lastError: String((e as any)?.message ?? e).slice(0, 300),
      updatedAt: new Date(),
    }).where(eq(calendarWatchChannels.id, row!.id));
    log.warn({ calendar: cal.name, err: redactTokens(e) }, 'calendar watch failed');
    return false;
  }
}

/**
 * Replace channels that are close to expiring, and tidy up dead ones.
 *
 * Google has no renew operation — a channel is replaced, not extended. So this
 * opens a new one and stops the old one, in that order: overlapping duplicate
 * notifications for a few seconds is harmless, whereas a gap is exactly the
 * silence this job exists to prevent.
 */
export async function renewWatches(db: Db, log: SyncLogger) {
  if (!webhookConfigured()) return { renewed: 0, retired: 0, opened: 0 };

  /* Open watches for connections that have none.
   *
   * They used to be opened only by the OAuth callback, so every account
   * connected before push existed had no channels and no way to get any short
   * of disconnecting and reconnecting — for a capability they never knew was
   * missing. A connection with no live channel is a connection falling back to
   * the five-minute poll, silently, forever.
   *
   * Idempotent, so this costs one indexed query per pass once everyone is
   * watched. */
  let opened = 0;
  const live = await db.select().from(calendarConnections)
    .where(ne(calendarConnections.status, 'revoked'));
  for (const conn of live) {
    const r = await ensureWatches(db, conn.workspaceId, log).catch(() => ({ opened: 0 }));
    opened += r.opened ?? 0;
  }

  const now = new Date();
  const soon = new Date(now.getTime() + RENEW_MARGIN_MS);

  const due = await db.select().from(calendarWatchChannels).where(and(
    eq(calendarWatchChannels.status, 'active'),
    or(sql`${calendarWatchChannels.expiresAt} IS NULL`, lte(calendarWatchChannels.expiresAt, soon)),
  )).limit(25);

  let renewed = 0;
  let retired = 0;
  for (const ch of due) {
    const [conn] = await db.select().from(calendarConnections)
      .where(eq(calendarConnections.id, ch.connectionId));
    const [cal] = await db.select().from(calendars).where(eq(calendars.id, ch.calendarId));
    if (!conn || !cal || conn.status === 'revoked' || !cal.isVisible) {
      await retire(db, ch, conn ?? null);
      retired++;
      continue;
    }
    // New first, then close the old: a brief overlap beats a gap.
    if (await openWatch(db, conn, cal, log)) renewed++;
    await retire(db, ch, conn);
  }
  return { renewed, retired, opened };
}

/** Close a channel with Google where possible, and stop tracking it. */
async function retire(db: Db, ch: typeof calendarWatchChannels.$inferSelect,
  conn: typeof calendarConnections.$inferSelect | null) {
  if (conn && ch.resourceId && conn.status !== 'revoked') {
    try {
      const token = await accessTokenFor(db, conn.id);
      await G.stopChannel(token, ch.channelId, ch.resourceId);
    } catch { /* an expired channel is already closed */ }
  }
  await db.update(calendarWatchChannels)
    .set({ status: 'stopped', updatedAt: new Date() })
    .where(eq(calendarWatchChannels.id, ch.id));
}

/**
 * Every channel for a workspace, closed. Called on disconnect.
 *
 * Without this, Google keeps POSTing about an account Life OS no longer has a
 * token for, and the rows pile up as permanent dead weight.
 */
export async function stopAllWatches(db: Db, workspaceId: string) {
  const rows = await db.select().from(calendarWatchChannels).where(and(
    eq(calendarWatchChannels.workspaceId, workspaceId),
    eq(calendarWatchChannels.status, 'active'),
  ));
  for (const ch of rows) {
    const [conn] = await db.select().from(calendarConnections)
      .where(eq(calendarConnections.id, ch.connectionId));
    await retire(db, ch, conn ?? null);
  }
  // Dead rows are not history worth keeping.
  await db.delete(calendarWatchChannels)
    .where(eq(calendarWatchChannels.workspaceId, workspaceId));
  return rows.length;
}

/**
 * Match a notification to a workspace, or refuse it.
 *
 * This is the security boundary. An arbitrary POST must not be able to make
 * Life OS do anything on behalf of a workspace it has no relationship with, so
 * all three of the channel id, the resource id and the token must agree with a
 * row we wrote ourselves. Nothing in the request is parsed for meaning.
 */
export async function resolveChannel(db: Db, headers: {
  channelId?: string; resourceId?: string; token?: string;
}) {
  if (!headers.channelId || !headers.token) return null;
  const [ch] = await db.select().from(calendarWatchChannels)
    .where(eq(calendarWatchChannels.channelId, headers.channelId));
  if (!ch) return null;
  if (ch.verificationToken !== headers.token) return null;
  // Google sends the resource id on every notification; a mismatch is a forgery
  // or a stale channel, and neither should reach the sync.
  if (ch.resourceId && headers.resourceId && ch.resourceId !== headers.resourceId) return null;
  if (ch.status !== 'active') return null;
  return ch;
}

/** Marks that a channel is alive and being used. Cheap, and answers "is it working?" */
export async function noteNotification(db: Db, channelRowId: string) {
  await db.update(calendarWatchChannels).set({
    lastNotifiedAt: new Date(),
    notifyCount: sql`${calendarWatchChannels.notifyCount} + 1`,
    updatedAt: new Date(),
  }).where(eq(calendarWatchChannels.id, channelRowId));
}
