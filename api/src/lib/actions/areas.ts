/**
 * Area application services.
 *
 * An area is a label on a part of a life, not a container. Everything that
 * carries one carries at most one, and losing an area never loses the work
 * inside it — deletion reassigns and then soft-deletes, in that order and in
 * one transaction.
 *
 * ── Built-in areas ───────────────────────────────────────────────────────
 *
 * Settings has always told the user "built-in areas are part of how Life OS
 * files things and cannot be removed", and has always enforced that by hiding
 * the button. The API did not, which meant the promise held for anyone using
 * the screen and not for anyone else — and the assistant is exactly the
 * "anyone else" that gap was waiting for. The rule now lives here, so both
 * callers keep the same promise.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { areas, tasks } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../errors.js';

/** Trim, collapse and case-fold — the same comparison the DB index makes. */
export const normaliseAreaName = (s: string) =>
  s.trim().replace(/\s+/g, ' ').toLowerCase();

export const AreaCreateInput = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(80),
  color: z.string().trim().max(40).default('slate'),
  icon: z.string().trim().max(40).nullish(),
}).strict();

export const AreaUpdateInput = AreaCreateInput.partial().strict();

export const listAreas = (db: Db, wsId: string) => db.select().from(areas)
  .where(and(eq(areas.workspaceId, wsId), isNull(areas.deletedAt)))
  .orderBy(asc(areas.position), asc(areas.name));

export async function createArea(
  db: Db, wsId: string, input: z.infer<typeof AreaCreateInput>,
) {
  const existing = await listAreas(db, wsId);
  if (existing.some((a) => normaliseAreaName(a.name) === normaliseAreaName(input.name))) {
    throw conflict(`An Area called "${input.name}" already exists.`);
  }
  const [max] = await db.select({ m: sql<number>`coalesce(max(${areas.position}), -1)` })
    .from(areas).where(eq(areas.workspaceId, wsId));
  const [row] = await db.insert(areas).values([{
    workspaceId: wsId,
    name: input.name,
    color: input.color,
    icon: input.icon ?? null,
    position: Number(max?.m ?? -1) + 1,
  }]).returning();
  return row!;
}

export async function updateArea(
  db: Db, wsId: string, areaId: string, input: z.infer<typeof AreaUpdateInput>,
) {
  if (input.name) {
    const others = await listAreas(db, wsId);
    if (others.some((a) => a.id !== areaId
      && normaliseAreaName(a.name) === normaliseAreaName(input.name!))) {
      throw conflict(`An Area called "${input.name}" already exists.`);
    }
  }
  const [row] = await db.update(areas).set({ ...input, updatedAt: new Date() })
    .where(and(eq(areas.id, areaId), eq(areas.workspaceId, wsId))).returning();
  if (!row) throw notFound('Area not found.');
  return row;
}

/**
 * Remove an area, keeping everything filed under it.
 *
 * Tasks are reassigned first and the area is soft-deleted second, in one
 * transaction: the other order would leave work pointing at something that no
 * longer exists if the second statement failed.
 */
export async function deleteArea(
  db: Db, wsId: string, areaId: string, reassignToAreaId?: string | null,
) {
  return db.transaction(async (tx) => {
    const [area] = await tx.select().from(areas)
      .where(and(eq(areas.id, areaId), eq(areas.workspaceId, wsId))).limit(1);
    if (!area) throw notFound('Area not found.');
    if (area.isSystem) {
      throw badRequest('Built-in areas are part of how Life OS files things and cannot be removed.');
    }
    if (reassignToAreaId) {
      const [target] = await tx.select().from(areas).where(and(
        eq(areas.id, reassignToAreaId), eq(areas.workspaceId, wsId), isNull(areas.deletedAt),
      )).limit(1);
      if (!target) throw notFound('The Area to reassign to does not exist.');
    }
    const moved = await tx.update(tasks)
      .set({ areaId: reassignToAreaId ?? null, updatedAt: new Date() })
      .where(and(eq(tasks.workspaceId, wsId), eq(tasks.areaId, areaId)))
      .returning({ id: tasks.id });
    await tx.update(areas).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(areas.id, areaId));
    return { reassignedTasks: moved.length, reassignedTo: reassignToAreaId ?? null };
  });
}
