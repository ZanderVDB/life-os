import type { AppInstance, Guards } from '../types.js';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { areas, tasks } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import {
  createArea, updateArea, deleteArea,
} from '../lib/actions/areas.js';
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
    const body = AreaBody.parse(req.body);
    const row = await createArea(db, req.workspaceId!, body);
    reply.code(201);
    return { area: row };
  });

  app.patch(`${base}/areas/:areaId`, pre, async (req) => {
    const { areaId } = req.params as { areaId: string };
    const body = AreaBody.partial().parse(req.body);
    return { area: await updateArea(db, req.workspaceId!, areaId, body) };
  });

  /**
   * Removing an Area NEVER deletes the content linked to it. Tasks are
   * reassigned to another Area or to no Area, then the Area is soft-deleted.
   */
  app.delete(`${base}/areas/:areaId`, pre, async (req) => {
    const { areaId } = req.params as { areaId: string };
    const { reassignToAreaId } = z.object({
      reassignToAreaId: z.string().uuid().nullish(),
    }).parse(req.query ?? {});
    return deleteArea(db, req.workspaceId!, areaId, reassignToAreaId ?? null);
  });
}
