/**
 * Authentication + workspace ownership, enforced as middleware so a handler
 * cannot forget it.
 *
 *   authenticate     → verifies the token, maps it to an internal user, and
 *                      guarantees one primary workspace.
 *   resolveWorkspace → confirms the :workspaceId in the path is one the caller
 *                      is actually a member of. 403 otherwise.
 *
 * The user id is NEVER taken from the request body or query — only from the
 * verified token.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { bearerFrom, verifyIdentityToken, type VerifiedIdentity } from './firebase.js';
import { ensureUserAndWorkspace, type Principal } from '../lib/bootstrap.js';
import { workspaceMemberships } from '../db/schema.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { Db } from '../db/client.js';
import type { AppEnv } from '../env.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    workspaceId?: string;
  }
}

export function makeAuth(db: Db, env: AppEnv) {
  async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
    const token = bearerFrom(req.headers.authorization);

    let identity: VerifiedIdentity;
    // Local/test escape hatch. loadEnv() refuses to boot with this set in
    // staging or production, so it can never be live.
    if (env.DEV_AUTH_BYPASS && token === env.DEV_AUTH_BYPASS) {
      const email = String(req.headers['x-dev-email'] ?? 'dev@example.com');
      identity = { externalUid: `dev:${email}`, email, displayName: 'Dev User' };
    } else {
      identity = await verifyIdentityToken(token, env.FIREBASE_PROJECT_ID);
    }

    req.principal = await ensureUserAndWorkspace(db, identity);
  }

  async function resolveWorkspace(req: FastifyRequest, _reply: FastifyReply) {
    const p = req.principal;
    if (!p) throw unauthorized();
    const { workspaceId } = req.params as { workspaceId?: string };
    if (!workspaceId) throw forbidden('No workspace specified.');

    // Fast path: the caller's own primary workspace.
    if (workspaceId === p.workspaceId) { req.workspaceId = workspaceId; return; }

    // Otherwise it must be a workspace they are a member of. (v2 creates only
    // one, but the check is written for the shared-workspace future.)
    const member = (await db.select().from(workspaceMemberships).where(and(
      eq(workspaceMemberships.workspaceId, workspaceId),
      eq(workspaceMemberships.userId, p.userId),
    )).limit(1))[0];
    if (!member) throw forbidden();
    req.workspaceId = workspaceId;
  }

  return { authenticate, resolveWorkspace };
}
