/**
 * Who may administer Life OS.
 *
 * ── Two ideas, deliberately not one ──────────────────────────────────────
 *
 *   role         may this person administer Life OS?  user | admin
 *   account_type what kind of account is this?        beta | tester | standard
 *
 * An admin is also a beta user. A paid plan must never be able to grant
 * administrative access. Collapsing these into one field would make that
 * confusion expressible, so they are separate columns and this file only ever
 * reads the first one.
 *
 * ── No second login ──────────────────────────────────────────────────────
 *
 * There is no admin password, no admin account, no separate sign-in. The
 * identity is the same verified Google/Firebase identity every other request
 * uses; being an admin is a property of that identity. A homemade credential
 * beside a working identity provider is a second thing to get wrong and the
 * only one an attacker would bother with.
 *
 * ── The bootstrap, and why it is not persisted ───────────────────────────
 *
 * Somebody has to be the first admin. `ADMIN_EMAILS` is that: an explicit
 * allowlist with NO default, so a deployment that forgets it has no admins at
 * all rather than an accidental one.
 *
 * It is evaluated live and never written to the `role` column. That matters:
 * if it were persisted, removing an address from the variable would leave the
 * access behind, and the operator would believe they had revoked something
 * they had not. Explicit promotions DO write the column, because those are
 * decisions somebody made rather than configuration.
 *
 * ── Where authorisation is NOT decided ───────────────────────────────────
 *
 * The URL. A page called /admin. A display name. Anything the browser sends.
 * Every admin route runs `requireAdmin` server-side, and a normal user who
 * types the address or calls the API by hand gets 403 and no data.
 */
import { eq } from 'drizzle-orm';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export const ADMIN_ENV = 'ADMIN_EMAILS';

/** The bootstrap allowlist. Empty by default — a missing value grants nobody. */
export function adminAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    String(env[ADMIN_ENV] ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export type AdminIdentity = {
  userId: string;
  email: string;
  role: string;
  isAdmin: boolean;
  /** True when the grant comes from configuration rather than a decision. */
  viaAllowlist: boolean;
};

export function adminIdentity(
  user: { id: string; email: string; role?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): AdminIdentity {
  const viaAllowlist = adminAllowlist(env).has(String(user.email ?? '').toLowerCase());
  const granted = user.role === 'admin';
  return {
    userId: user.id,
    email: user.email,
    role: user.role ?? 'user',
    isAdmin: granted || viaAllowlist,
    viaAllowlist: viaAllowlist && !granted,
  };
}

/** Read the row and decide. Never trusts anything from the request body. */
export async function adminFor(
  db: Db, userId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<AdminIdentity | null> {
  const [row] = await db.select({
    id: users.id, email: users.email, role: users.role,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row) return null;
  return adminIdentity(row as any, env);
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminIdentity;
  }
}

/**
 * The guard every admin route runs.
 *
 * Placed AFTER `authenticate`, so the identity is already verified; this only
 * answers the second question. The answer is a plain 403 with no detail —
 * telling somebody why they were refused is telling them what exists.
 */
export function makeAdminGuard(db: Db, env: NodeJS.ProcessEnv = process.env) {
  return async function requireAdmin(req: FastifyRequest, _reply: FastifyReply) {
    const p = req.principal;
    if (!p) throw unauthorized();
    const who = await adminFor(db, p.userId, env);
    if (!who?.isAdmin) throw forbidden('Not available.');
    req.admin = who;
  };
}

/** What an operator has to set. Reported rather than guessed at. */
export const ADMIN_SETUP = {
  variable: ADMIN_ENV,
  example: 'someone@example.com,someone-else@example.com',
  note: 'Comma-separated, case-insensitive, on the API service. There is no '
    + 'default: until it is set, no account can reach Admin. Removing an '
    + 'address revokes access immediately, because the allowlist is read live '
    + 'rather than copied into the database.',
} as const;
