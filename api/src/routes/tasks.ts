/**
 * Task API. REST for resources, RPC-style verbs for actions.
 *
 * Movement is deliberately API-first: :move and :reorder are ordinary POSTs, so
 * drag, a non-drag Move menu, keyboard shortcuts and touch all drive the SAME
 * endpoint. Nothing about ordering depends on HTML5 drag-and-drop — the reason
 * task management is impossible on a phone in the legacy app.
 */
import type { AppInstance, Guards } from '../types.js';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { tasks, taskSteps, taskActivity, areas, projects, BUCKETS, PRIORITIES } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';

/** Sparse spacing so a single move rewrites one row, not the whole bucket. */
const GAP = 1000;

/**
 * Query-string boolean.
 *
 * NOT `z.coerce.boolean()` — that is `Boolean(value)`, so the string "false"
 * becomes **true** and `?includeCompleted=false` silently does nothing. Query
 * parameters are always strings, so they need a parser that reads them.
 */
const queryBool = (def: boolean) => z.preprocess((v) => {
  if (v === undefined || v === '') return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  return def;
}, z.boolean());

const TaskCreate = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(500),
  notes: z.string().max(20000).nullish(),
  bucket: z.enum(BUCKETS).default('today'),
  priority: z.enum(PRIORITIES).default('medium'),
  areaId: z.string().uuid().nullish(),
  // A task belongs to zero or one Project. Set when a task is created inside a
  // project, so the relationship is one atomic write rather than a create
  // followed by an assign that can fail and leave the task loose.
  projectId: z.string().uuid().nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').nullish(),
  scheduledAt: z.string().datetime({ offset: true }).nullish(),
  estimatedMinutes: z.number().int().positive().max(10080).nullish(),
}).strict();

const TaskUpdate = TaskCreate.partial().extend({
  status: z.enum(['open', 'done', 'cancelled']).optional(),
}).strict();

const MoveBody = z.object({
  bucket: z.enum(BUCKETS),
  beforeTaskId: z.string().uuid().nullish(),
  afterTaskId: z.string().uuid().nullish(),
}).strict();

export function registerTaskRoutes(app: AppInstance, db: Db, guards: Guards) {
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const base = '/api/v1/workspaces/:workspaceId';

  const logActivity = (tx: any, wsId: string, taskId: string, userId: string, action: string, changes?: unknown) =>
    tx.insert(taskActivity).values({
      taskId, workspaceId: wsId, actorType: 'user', actorUserId: userId, action,
      changes: changes ?? null,
    });

  /** Next position at the end of a bucket. */
  async function endPosition(tx: any, wsId: string, bucket: string): Promise<number> {
    const r = await tx.select({ max: sql<number>`coalesce(max(${tasks.position}), 0)` })
      .from(tasks).where(and(eq(tasks.workspaceId, wsId), eq(tasks.bucket, bucket), isNull(tasks.archivedAt)));
    return Number(r[0]?.max ?? 0) + GAP;
  }

  // ── list ────────────────────────────────────────────────────────────
  app.get(`${base}/tasks`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const q = z.object({
      bucket: z.enum(BUCKETS).optional(),
      areaId: z.string().uuid().optional(),
      includeArchived: queryBool(false),
      includeCompleted: queryBool(true),
      /** Exactly one status — how the History view asks for completed only. */
      status: z.enum(['open', 'done', 'cancelled']).optional(),
      /** History can be long; the buckets never are. */
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query ?? {});

    const where = [eq(tasks.workspaceId, wsId)];
    if (q.bucket) where.push(eq(tasks.bucket, q.bucket));
    if (q.areaId) where.push(eq(tasks.areaId, q.areaId));
    if (!q.includeArchived) where.push(isNull(tasks.archivedAt));
    if (q.status) where.push(eq(tasks.status, q.status));
    else if (!q.includeCompleted) where.push(eq(tasks.status, 'open'));

    // History reads newest-first by completion time; buckets read by position.
    // `completed_at` can be null for an imported task whose legacy record had
    // no doneAt, so those sort last rather than jumping to the top.
    const order = q.status === 'done'
      ? [sql`${tasks.completedAt} desc nulls last`, desc(tasks.createdAt)]
      : [asc(tasks.bucket), asc(tasks.position), asc(tasks.createdAt)];

    let query = db.select().from(tasks).where(and(...where)).orderBy(...order).$dynamic();
    if (q.limit !== undefined) query = query.limit(q.limit).offset(q.offset);
    const rows = await query;

    const [totalRow] = await db.select({ n: sql<number>`count(*)::int` })
      .from(tasks).where(and(...where));
    const total = totalRow?.n ?? rows.length;
    const ids = rows.map((r) => r.id);
    const steps = ids.length
      ? await db.select().from(taskSteps)
          .where(and(eq(taskSteps.workspaceId, wsId), sql`${taskSteps.taskId} = any(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]`)})`))
          .orderBy(asc(taskSteps.position))
      : [];
    const byTask = new Map<string, typeof steps>();
    for (const s of steps) {
      const list = byTask.get(s.taskId) ?? [];
      list.push(s); byTask.set(s.taskId, list);
    }
    return { tasks: rows.map((t) => ({ ...t, steps: byTask.get(t.id) ?? [] })), total };
  });

  // ── create ──────────────────────────────────────────────────────────
  app.post(`${base}/tasks`, pre, async (req, reply) => {
    const wsId = req.workspaceId!;
    const body = TaskCreate.parse(req.body);
    if (body.areaId) {
      const a = (await db.select().from(areas)
        .where(and(eq(areas.id, body.areaId), eq(areas.workspaceId, wsId), isNull(areas.deletedAt))).limit(1))[0];
      if (!a) throw badRequest('That Area does not exist in this workspace.');
    }
    if (body.projectId) {
      const p = (await db.select().from(projects)
        .where(and(eq(projects.id, body.projectId), eq(projects.workspaceId, wsId))).limit(1))[0];
      if (!p) throw badRequest('That project does not exist in this workspace.');
    }
    const row = await db.transaction(async (tx) => {
      const position = await endPosition(tx, wsId, body.bucket);
      const created = (await tx.insert(tasks).values({
        workspaceId: wsId, title: body.title, notes: body.notes ?? null,
        bucket: body.bucket, priority: body.priority, areaId: body.areaId ?? null,
        projectId: body.projectId ?? null,
        dueDate: body.dueDate ?? null,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
        estimatedMinutes: body.estimatedMinutes ?? null,
        position,
      }).returning())[0]!;
      await logActivity(tx, wsId, created.id, req.principal!.userId, 'created');
      return created;
    });
    reply.code(201);
    return { task: { ...row, steps: [] } };
  });

  // ── read ────────────────────────────────────────────────────────────
  app.get(`${base}/tasks/:taskId`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { taskId } = req.params as { taskId: string };
    const t = (await db.select().from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).limit(1))[0];
    if (!t) throw notFound('Task not found.');
    const steps = await db.select().from(taskSteps)
      .where(eq(taskSteps.taskId, taskId)).orderBy(asc(taskSteps.position));
    return { task: { ...t, steps } };
  });

  // ── update ──────────────────────────────────────────────────────────
  app.patch(`${base}/tasks/:taskId`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { taskId } = req.params as { taskId: string };
    const body = TaskUpdate.parse(req.body);
    if (Object.keys(body).length === 0) throw badRequest('No fields to update.');

    const updated = await db.transaction(async (tx) => {
      const existing = (await tx.select().from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).limit(1))[0];
      if (!existing) throw notFound('Task not found.');

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.title !== undefined) patch['title'] = body.title;
      if (body.notes !== undefined) patch['notes'] = body.notes ?? null;
      if (body.priority !== undefined) patch['priority'] = body.priority;
      if (body.areaId !== undefined) patch['areaId'] = body.areaId ?? null;
      if (body.dueDate !== undefined) patch['dueDate'] = body.dueDate ?? null;
      if (body.scheduledAt !== undefined) patch['scheduledAt'] = body.scheduledAt ? new Date(body.scheduledAt) : null;
      if (body.estimatedMinutes !== undefined) patch['estimatedMinutes'] = body.estimatedMinutes ?? null;
      if (body.bucket !== undefined && body.bucket !== existing.bucket) {
        patch['bucket'] = body.bucket;
        patch['position'] = await endPosition(tx, wsId, body.bucket);
      }
      if (body.status !== undefined) {
        patch['status'] = body.status;
        patch['completedAt'] = body.status === 'done' ? new Date() : null;
      }
      const row = (await tx.update(tasks).set(patch)
        .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).returning())[0]!;
      await logActivity(tx, wsId, taskId, req.principal!.userId, 'edited', { fields: Object.keys(body) });
      return row;
    });
    return { task: updated };
  });

  // ── complete / uncomplete ───────────────────────────────────────────
  for (const [verb, done] of [['complete', true], ['uncomplete', false]] as const) {
    app.post(`${base}/tasks/:taskId/${verb}`, pre, async (req) => {
      const wsId = req.workspaceId!;
      const { taskId } = req.params as { taskId: string };
      const row = await db.transaction(async (tx) => {
        const r = (await tx.update(tasks).set({
          status: done ? 'done' : 'open',
          completedAt: done ? new Date() : null,
          updatedAt: new Date(),
        }).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).returning())[0];
        if (!r) throw notFound('Task not found.');
        await logActivity(tx, wsId, taskId, req.principal!.userId, done ? 'completed' : 'reopened');
        return r;
      });
      return { task: row };
    });
  }

  // ── archive (soft) + hard delete ────────────────────────────────────
  app.post(`${base}/tasks/:taskId/archive`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { taskId } = req.params as { taskId: string };
    const row = await db.transaction(async (tx) => {
      const r = (await tx.update(tasks).set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).returning())[0];
      if (!r) throw notFound('Task not found.');
      await logActivity(tx, wsId, taskId, req.principal!.userId, 'archived');
      return r;
    });
    return { task: row };
  });

  app.delete(`${base}/tasks/:taskId`, pre, async (req, reply) => {
    const wsId = req.workspaceId!;
    const { taskId } = req.params as { taskId: string };
    const r = (await db.delete(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).returning())[0];
    if (!r) throw notFound('Task not found.');
    reply.code(204);
    return null;
  });

  // ── move / reorder ──────────────────────────────────────────────────
  // ONE endpoint behind drag, the Move menu, keyboard and touch.
  app.post(`${base}/tasks/:taskId/move`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { taskId } = req.params as { taskId: string };
    const body = MoveBody.parse(req.body);
    if (body.beforeTaskId && body.afterTaskId) {
      throw badRequest('Provide beforeTaskId or afterTaskId, not both.');
    }

    const row = await db.transaction(async (tx) => {
      const existing = (await tx.select().from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).limit(1))[0];
      if (!existing) throw notFound('Task not found.');

      const siblings = (await tx.select().from(tasks).where(and(
        eq(tasks.workspaceId, wsId), eq(tasks.bucket, body.bucket), isNull(tasks.archivedAt),
      )).orderBy(asc(tasks.position))).filter((s) => s.id !== taskId);

      let position: number;
      const anchorId = body.beforeTaskId ?? body.afterTaskId ?? null;
      if (!anchorId) {
        position = (siblings.at(-1)?.position ?? 0) + GAP;      // end of bucket
      } else {
        const idx = siblings.findIndex((s) => s.id === anchorId);
        if (idx === -1) throw badRequest('The anchor task is not in that bucket.');
        if (body.beforeTaskId) {
          const prev = idx > 0 ? siblings[idx - 1]!.position : 0;
          position = Math.floor((prev + siblings[idx]!.position) / 2);
          if (position <= prev) position = prev + 1;            // gap exhausted
        } else {
          const next = idx < siblings.length - 1 ? siblings[idx + 1]!.position : siblings[idx]!.position + GAP * 2;
          position = Math.floor((siblings[idx]!.position + next) / 2);
          if (position <= siblings[idx]!.position) position = siblings[idx]!.position + 1;
        }
      }

      const updated = (await tx.update(tasks).set({
        bucket: body.bucket, position, updatedAt: new Date(),
      }).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).returning())[0]!;

      await logActivity(tx, wsId, taskId, req.principal!.userId,
        existing.bucket === body.bucket ? 'reordered' : 'moved_bucket',
        { from: existing.bucket, to: body.bucket });
      return updated;
    });
    return { task: row };
  });

  // ── steps ───────────────────────────────────────────────────────────
  const StepCreate = z.object({ title: z.string().trim().min(1).max(500) }).strict();
  const StepUpdate = z.object({
    title: z.string().trim().min(1).max(500).optional(),
    completed: z.boolean().optional(),
  }).strict();

  app.post(`${base}/tasks/:taskId/steps`, pre, async (req, reply) => {
    const wsId = req.workspaceId!;
    const { taskId } = req.params as { taskId: string };
    const body = StepCreate.parse(req.body);
    const t = (await db.select().from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).limit(1))[0];
    if (!t) throw notFound('Task not found.');
    const max = await db.select({ m: sql<number>`coalesce(max(${taskSteps.position}), -1)` })
      .from(taskSteps).where(eq(taskSteps.taskId, taskId));
    const row = (await db.insert(taskSteps).values({
      taskId, workspaceId: wsId, title: body.title, position: Number(max[0]?.m ?? -1) + 1,
    }).returning())[0]!;
    reply.code(201);
    return { step: row };
  });

  app.patch(`${base}/tasks/:taskId/steps/:stepId`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { stepId } = req.params as { stepId: string };
    const body = StepUpdate.parse(req.body);
    if (Object.keys(body).length === 0) throw badRequest('No fields to update.');
    const row = (await db.update(taskSteps).set({ ...body, updatedAt: new Date() })
      .where(and(eq(taskSteps.id, stepId), eq(taskSteps.workspaceId, wsId))).returning())[0];
    if (!row) throw notFound('Step not found.');
    return { step: row };
  });

  app.delete(`${base}/tasks/:taskId/steps/:stepId`, pre, async (req, reply) => {
    const wsId = req.workspaceId!;
    const { stepId } = req.params as { stepId: string };
    const row = (await db.delete(taskSteps)
      .where(and(eq(taskSteps.id, stepId), eq(taskSteps.workspaceId, wsId))).returning())[0];
    if (!row) throw notFound('Step not found.');
    reply.code(204);
    return null;
  });
}
