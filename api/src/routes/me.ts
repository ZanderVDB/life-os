import type { AppInstance } from '../types.js';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users, workspaces, areas } from '../db/schema.js';
import { adminIdentity } from '../admin/authz.js';
import { usageSummary } from '../usage/summary.js';

export function registerMeRoutes(app: AppInstance, db: Db, guards: { authenticate: any }) {
  /**
   * Who am I, and which workspace am I in? v2 returns exactly ONE workspace —
   * there is no switcher and no profile concept.
   *
   * ── Why the account shape is here ────────────────────────────────────
   *
   * The shell has to know whether to show an Admin entry, whether to show a
   * BETA badge, whether the beta introduction still has to be acknowledged,
   * and roughly where this person stands on their allowance. All four are
   * decided by the SERVER and sent here; the browser renders the answer.
   *
   * `isAdmin` in this payload is for RENDERING only. Every admin endpoint
   * checks authorisation again for itself, so a client that lied about this
   * would get a menu entry leading to a series of 403s.
   */
  app.get('/api/v1/me', { preHandler: [guards.authenticate] }, async (req) => {
    const p = req.principal!;
    const user = (await db.select().from(users).where(eq(users.id, p.userId)).limit(1))[0]!;
    const ws = (await db.select().from(workspaces).where(eq(workspaces.id, p.workspaceId)).limit(1))[0]!;
    const areaRows = await db.select().from(areas)
      .where(and(eq(areas.workspaceId, ws.id), isNull(areas.deletedAt)))
      .orderBy(asc(areas.position), asc(areas.name));

    /* Last seen. Written on the one request every session makes, rather than
       on a heartbeat nobody would trust. Fire-and-forget: knowing when
       somebody last used Life OS is not worth failing their sign-in over. */
    void db.update(users).set({ lastActiveAt: new Date() })
      .where(eq(users.id, p.userId)).catch(() => {});

    const who = adminIdentity(user as any);
    const usage = await usageSummary(db, p.userId, ws.id).catch(() => null);

    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      workspace: { id: ws.id, name: ws.name, kind: ws.kind, role: p.role },
      account: {
        role: user.role,
        /* Rendering only. Authorisation is re-checked on every admin route. */
        isAdmin: who.isAdmin,
        accountType: user.accountType,
        isBeta: user.accountType === 'beta' || user.accountType === 'tester',
        betaStartAt: user.betaStartAt,
        betaEndAt: user.betaEndAt,
        /* Server-held, so clearing browser storage cannot skip the beta
           introduction and a new device does not ask for it again. */
        introAcceptedAt: user.introAcceptedAt,
        introRequired: !user.introAcceptedAt,
      },
      /* Enough to render the badge and the warning without a second call. */
      usage: usage ? {
        status: usage.status,
        fraction: usage.fraction,
        allowanceUsd: usage.allowanceUsd,
        usedUsd: usage.usedUsd,
        remainingUsd: usage.remainingUsd,
        zar: usage.zar,
        message: usage.message,
        periodEnd: usage.periodEnd,
      } : null,
      areas: areaRows.map((a) => ({
        id: a.id, name: a.name, color: a.color, position: a.position, isSystem: a.isSystem,
      })),
    };
  });

  /**
   * "I have read the beta introduction."
   *
   * Recorded server-side and only ever set forward — there is no way to
   * un-acknowledge, because there is no reason to and an endpoint that could
   * would be one more thing to get wrong. Idempotent: a second call keeps the
   * first timestamp, so a double-tap does not rewrite when somebody agreed.
   */
  app.post('/api/v1/me/intro-accepted', { preHandler: [guards.authenticate] }, async (req) => {
    const p = req.principal!;
    const [before] = await db.select({ at: users.introAcceptedAt })
      .from(users).where(eq(users.id, p.userId)).limit(1);
    if (before?.at) return { introAcceptedAt: before.at, changed: false };
    const at = new Date();
    await db.update(users).set({ introAcceptedAt: at, updatedAt: at })
      .where(eq(users.id, p.userId));
    return { introAcceptedAt: at, changed: true };
  });
}
