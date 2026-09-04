/**
 * Every admin mutation, with what it was and what it became.
 *
 * An admin who can change somebody's allowance without leaving a trace is an
 * admin nobody can check — including themselves, six weeks later, trying to
 * work out why a tester's numbers look wrong. "Zander changed User A's
 * allowance from R100 to R200" is the whole point; "the allowance is R200" is
 * not enough to reconstruct anything.
 *
 * The actor's email is COPIED into the row rather than joined at read time.
 * A row that says who did it must go on saying so after the account is renamed
 * or removed — a join would quietly turn history into "unknown".
 */
import { desc, eq, and } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { adminAuditLog, users } from '../db/schema.js';
import type { AdminIdentity } from './authz.js';

export type AuditEntry = {
  actor: AdminIdentity;
  targetUserId?: string | null;
  targetEmail?: string | null;
  action: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  note?: string | null;
};

/**
 * Write one entry.
 *
 * Deliberately not wrapped in the caller's transaction: a mutation that
 * succeeded must not be rolled back because its audit row failed, and an audit
 * row for a mutation that did not happen is worse than none. Callers write the
 * change first and record it after.
 */
export async function recordAdminAction(db: Db, entry: AuditEntry) {
  await db.insert(adminAuditLog).values({
    actorUserId: entry.actor.userId,
    actorEmail: entry.actor.email,
    targetUserId: entry.targetUserId ?? null,
    targetEmail: entry.targetEmail ?? null,
    action: entry.action,
    before: (entry.before ?? {}) as Record<string, unknown>,
    after: (entry.after ?? {}) as Record<string, unknown>,
    note: entry.note ?? null,
  });
}

export async function readAuditLog(
  db: Db, opts: { targetUserId?: string | null; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.targetUserId
    ? and(eq(adminAuditLog.targetUserId, opts.targetUserId))
    : undefined;
  const rows = await db.select().from(adminAuditLog)
    .where(where)
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(limit);
  return rows;
}

/** Only what changed. An entry listing forty unchanged fields says nothing. */
export function diff(
  before: Record<string, unknown>, after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const wasV = before[key];
    const isV = after[key];
    const same = wasV instanceof Date && isV instanceof Date
      ? wasV.getTime() === isV.getTime()
      : JSON.stringify(wasV ?? null) === JSON.stringify(isV ?? null);
    if (same) continue;
    b[key] = wasV instanceof Date ? wasV.toISOString() : wasV ?? null;
    a[key] = isV instanceof Date ? isV.toISOString() : isV ?? null;
  }
  return { before: b, after: a };
}

/** The target's email, for the copy that has to survive them. */
export async function emailOf(db: Db, userId: string): Promise<string | null> {
  const [row] = await db.select({ email: users.email })
    .from(users).where(eq(users.id, userId)).limit(1);
  return row?.email ?? null;
}
