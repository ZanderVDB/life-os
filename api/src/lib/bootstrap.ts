/**
 * First-sight provisioning: map a verified identity to an internal user, and
 * guarantee exactly ONE primary workspace with exactly the two default Areas.
 *
 * Locked rules (/docs/legacy-data-decision.md):
 *  • one primary workspace per user — no profile switching
 *  • seed Personal and Work ONLY. Church/Health/Finance/Family/Learning are
 *    suggestions for later, never forced defaults.
 *  • Area names are unique per workspace after trim + case-fold.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users, workspaces, workspaceMemberships, areas } from '../db/schema.js';
import type { VerifiedIdentity } from '../auth/firebase.js';

export const DEFAULT_AREAS = [
  { name: 'Personal', color: 'sage', position: 0 },
  { name: 'Work', color: 'blue', position: 1 },
] as const;

/** Trim + collapse internal whitespace + case-fold — the duplicate-prevention key. */
export function normaliseAreaName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface Principal {
  userId: string;
  email: string;
  workspaceId: string;
  role: string;
}

/**
 * Idempotent. Safe to call on every request: existing users take the fast path
 * and nothing is duplicated.
 */
export async function ensureUserAndWorkspace(db: Db, identity: VerifiedIdentity): Promise<Principal> {
  return db.transaction(async (tx) => {
    // 1. User — match on firebase uid first, then email (so an identity
    //    provider change does not orphan an existing account).
    let user = (await tx.select().from(users).where(eq(users.firebaseUid, identity.externalUid)).limit(1))[0];
    if (!user) {
      const byEmail = (await tx.select().from(users).where(eq(users.email, identity.email)).limit(1))[0];
      if (byEmail) {
        user = (await tx.update(users)
          .set({ firebaseUid: identity.externalUid, updatedAt: new Date() })
          .where(eq(users.id, byEmail.id)).returning())[0];
      }
    }
    if (!user) {
      user = (await tx.insert(users).values({
        firebaseUid: identity.externalUid,
        email: identity.email,
        displayName: identity.displayName,
      }).returning())[0];
    }
    if (!user) throw new Error('Failed to provision user.');

    // 2. Exactly one live primary workspace.
    let ws = (await tx.select().from(workspaces).where(and(
      eq(workspaces.ownerUserId, user.id),
      eq(workspaces.kind, 'primary'),
      isNull(workspaces.deletedAt),
    )).limit(1))[0];

    if (!ws) {
      const wsName = identity.displayName?.split(/\s+/)[0] || 'Life OS';
      ws = (await tx.insert(workspaces).values({
        ownerUserId: user.id,
        name: wsName,
        kind: 'primary',
      }).returning())[0];
      if (!ws) throw new Error('Failed to provision workspace.');

      await tx.insert(workspaceMemberships).values({
        workspaceId: ws.id, userId: user.id, role: 'owner',
      }).onConflictDoNothing();

      // Seed EXACTLY Personal + Work.
      await tx.insert(areas).values(
        DEFAULT_AREAS.map((a) => ({
          workspaceId: ws!.id, name: a.name, color: a.color,
          position: a.position, isSystem: true,
        })),
      ).onConflictDoNothing();
    } else {
      // Repair path: a workspace with no membership row would lock the owner out.
      const member = (await tx.select().from(workspaceMemberships).where(and(
        eq(workspaceMemberships.workspaceId, ws.id),
        eq(workspaceMemberships.userId, user.id),
      )).limit(1))[0];
      if (!member) {
        await tx.insert(workspaceMemberships).values({
          workspaceId: ws.id, userId: user.id, role: 'owner',
        }).onConflictDoNothing();
      }
    }

    return { userId: user.id, email: user.email, workspaceId: ws.id, role: 'owner' };
  });
}
