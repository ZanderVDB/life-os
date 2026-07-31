import type { AppInstance } from '../types.js';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users, workspaces, areas } from '../db/schema.js';

export function registerMeRoutes(app: AppInstance, db: Db, guards: { authenticate: any }) {
  /**
   * Who am I, and which workspace am I in? v2 returns exactly ONE workspace —
   * there is no switcher and no profile concept.
   */
  app.get('/api/v1/me', { preHandler: [guards.authenticate] }, async (req) => {
    const p = req.principal!;
    const user = (await db.select().from(users).where(eq(users.id, p.userId)).limit(1))[0]!;
    const ws = (await db.select().from(workspaces).where(eq(workspaces.id, p.workspaceId)).limit(1))[0]!;
    const areaRows = await db.select().from(areas)
      .where(and(eq(areas.workspaceId, ws.id), isNull(areas.deletedAt)))
      .orderBy(asc(areas.position), asc(areas.name));
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      workspace: { id: ws.id, name: ws.name, kind: ws.kind, role: p.role },
      areas: areaRows.map((a) => ({
        id: a.id, name: a.name, color: a.color, position: a.position, isSystem: a.isSystem,
      })),
    };
  });
}
