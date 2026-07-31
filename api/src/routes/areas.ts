import type { AppInstance, Guards } from '../types.js';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { areas, tasks } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { normaliseAreaName } from '../lib/bootstrap.js';

const AreaBody = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(80),
  color: z.string().trim().max(40).default('slate'),
  icon: z.string().trim().max(40).nullish(),
}).strict();

export function registerAreaRoutes(app: AppInstance, db: Db, guards: Guards) {
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const base = '/api/v1/workspaces/:workspaceId';

  app.get(`${base}/areas`, pre, async (req) => {
    const rows = await db.select().from(areas)
      .where(and(eq(areas.workspaceId, req.workspaceId!), isNull(areas.deletedAt)))
      .orderBy(asc(areas.position), asc(areas.name));
    return { areas: rows };
  });

  app.post(`${base}/areas`, pre, async (req, reply) => {
    const wsId = req.workspaceId!;
    const body = AreaBody.parse(req.body);
    // Duplicate check mirrors the DB index: trim + collapse + case-fold.
    const existing = await db.select().from(areas)
      .where(and(eq(areas.workspaceId, wsId), isNull(areas.deletedAt)));
    if (existing.some((a) => normaliseAreaName(a.name) === normaliseAreaName(body.name))) {
      throw conflict(`An Area called "${body.name}" already exists.`);
    }
    const max = await db.select({ m: sql<number>`coalesce(max(${areas.position}), -1)` })
      .from(areas).where(eq(areas.workspaceId, wsId));
    const row = (await db.insert(areas).values({
      workspaceId: wsId, name: body.name, color: body.color,
      icon: body.icon ?? null, position: Number(max[0]?.m ?? -1) + 1,
    }).returning())[0]!;
    reply.code(201);
    return { area: row };
  });

  app.patch(`${base}/areas/:areaId`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { areaId } = req.params as { areaId: string };
    const body = AreaBody.partial().parse(req.body);
    if (body.name) {
      const others = await db.select().from(areas)
        .where(and(eq(areas.workspaceId, wsId), isNull(areas.deletedAt)));
      if (others.some((a) => a.id !== areaId && normaliseAreaName(a.name) === normaliseAreaName(body.name!))) {
        throw conflict(`An Area called "${body.name}" already exists.`);
      }
    }
    const row = (await db.update(areas).set({ ...body, updatedAt: new Date() })
      .where(and(eq(areas.id, areaId), eq(areas.workspaceId, wsId))).returning())[0];
    if (!row) throw notFound('Area not found.');
    return { area: row };
  });

  /**
   * Removing an Area NEVER deletes the content linked to it. Tasks are
   * reassigned to another Area or to no Area, then the Area is soft-deleted.
   */
  app.delete(`${base}/areas/:areaId`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { areaId } = req.params as { areaId: string };
    const { reassignToAreaId } = z.object({
      reassignToAreaId: z.string().uuid().nullish(),
    }).parse(req.query ?? {});

    const result = await db.transaction(async (tx) => {
      const area = (await tx.select().from(areas)
        .where(and(eq(areas.id, areaId), eq(areas.workspaceId, wsId))).limit(1))[0];
      if (!area) throw notFound('Area not found.');
      if (reassignToAreaId) {
        const target = (await tx.select().from(areas).where(and(
          eq(areas.id, reassignToAreaId), eq(areas.workspaceId, wsId), isNull(areas.deletedAt),
        )).limit(1))[0];
        if (!target) throw notFound('The Area to reassign to does not exist.');
      }
      const moved = await tx.update(tasks)
        .set({ areaId: reassignToAreaId ?? null, updatedAt: new Date() })
        .where(and(eq(tasks.workspaceId, wsId), eq(tasks.areaId, areaId))).returning({ id: tasks.id });
      await tx.update(areas).set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(areas.id, areaId));
      return { reassignedTasks: moved.length, reassignedTo: reassignToAreaId ?? null };
    });
    return result;
  });
}
