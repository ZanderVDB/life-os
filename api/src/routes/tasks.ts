/**
 * Task API. REST for resources, RPC-style verbs for actions.
 *
 * Movement is deliberately API-first: :move and :reorder are ordinary POSTs, so
 * drag, a non-drag Move menu, keyboard shortcuts and touch all drive the SAME
 * endpoint. Nothing about ordering depends on HTML5 drag-and-drop — the reason
 * task management is impossible on a phone in the legacy app.
 */
import type { AppInstance, Guards } from '../types.js';
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  tasks, taskSteps, taskActivity, areas, projects, workspaceMemberships,
  BUCKETS, PRIORITIES,
} from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { cleanupLinksFor } from '../lib/relationships.js';
// The next action is resolved with the SAME function the Projects page uses.
// Two implementations of "which task is next" would disagree, and the badge on
// Today would point at a different task than the project itself does.
import { nextActionFor } from './projects.js';
/* The rules for creating, editing and completing a task live in one place, so
 * the assistant and this route cannot drift apart. See lib/actions/tasks.ts. */
import {
  createTask, updateTask, setTaskDone, archiveTask,
  addStep, updateStep, removeStep,
} from '../lib/actions/tasks.js';

/** Sparse spacing so a single move rewrites one row, not the whole bucket. */
const GAP = 1000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    /* The projects these tasks belong to, so Today can name them.
     *
     * A compact map rather than an embedded copy on each task: the task row is
     * still one Task record, and duplicating project fields onto it is how a
     * second source of truth starts. It is also one query for the whole board
     * rather than one per task.
     *
     * `nextActionId` is the RESOLVED next action, not the stored override.
     *
     * It used to be `nextTaskId`, and that was wrong in the common case: most
     * projects have no override, so `nextTaskId` is null and Today marked
     * nothing at all — the badge only ever appeared on projects where someone
     * had picked a task by hand. Resolving it here means Today marks the same
     * task the project page calls the next action, whether it was chosen or
     * inferred. One rule, one answer, in both places.
     *
     * Resolution needs each project's FULL task list, not just the rows on this
     * board — the next action is frequently a task that is not on Today. That
     * is one extra query for the whole board, not one per row. */
    const projectIds = [...new Set(rows.map((r) => r.projectId).filter(Boolean))] as string[];
    const projectRows = projectIds.length
      ? await db.select().from(projects)
        .where(and(eq(projects.workspaceId, wsId), inArray(projects.id, projectIds)))
      : [];
    const siblings = projectIds.length
      ? await db.select().from(tasks)
        .where(and(eq(tasks.workspaceId, wsId), inArray(tasks.projectId, projectIds)))
      : [];

    return {
      tasks: rows.map((t) => ({ ...t, steps: byTask.get(t.id) ?? [] })),
      total,
      projects: Object.fromEntries(projectRows.map((p) => [p.id, {
        id: p.id, title: p.title, status: p.status, focus: p.focus,
        /* Whether the project is filed away. The board holds back the tasks of
         * projects that are not being worked on — archived, on hold, someday —
         * and it needs this to know. Read-time only: nothing about the task is
         * written, so un-filing restores the board exactly. */
        archived: !!p.archivedAt,
        nextActionId: nextActionFor(p, siblings.filter((t) => t.projectId === p.id)).task?.id ?? null,
      }])),
    };
  });

  // ── create ──────────────────────────────────────────────────────────
  app.post(`${base}/tasks`, pre, async (req, reply) => {
    const wsId = req.workspaceId!;
    const body = TaskCreate.parse(req.body);
    const row = await createTask(db, wsId, { userId: req.principal!.userId }, body);
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

    const updated = await updateTask(db, wsId, { userId: req.principal!.userId }, taskId, body);
    return { task: updated };
  });

  /**
   * POST …/tasks/reorder  { positions: [{ id, position }] }
   *
   * Many positions, ONE transaction.
   *
   * The daily arrangement rewrites a whole bucket at once, and doing that as N
   * separate `/move` calls would leave the board half-sorted whenever the
   * network dropped in the middle — an order nobody chose and nothing would
   * ever correct. All of them or none.
   *
   * Position ONLY. Not bucket, not project, not due date. This endpoint exists
   * to reorder rows the user can already see; letting it move a task between
   * buckets would make a display concern into a data migration.
   */
  app.post(`${base}/tasks/reorder`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { positions } = z.object({
      positions: z.array(z.object({
        id: z.string().uuid(),
        position: z.number().int(),
      }).strict()).min(1).max(500),
    }).strict().parse(req.body ?? {});

    const ids = positions.map((p) => p.id);
    if (new Set(ids).size !== ids.length) throw badRequest('Duplicate task in the reorder.');

    const updated = await db.transaction(async (tx) => {
      // Every id must be a live task in THIS workspace before anything moves.
      // Checking inside the transaction is what makes a bad id a clean 404
      // rather than a partial reorder.
      const found = await tx.select({ id: tasks.id }).from(tasks)
        .where(and(eq(tasks.workspaceId, wsId), inArray(tasks.id, ids)));
      if (found.length !== ids.length) throw notFound('Some of those tasks no longer exist.');

      for (const p of positions) {
        await tx.update(tasks).set({ position: p.position, updatedAt: new Date() })
          .where(and(eq(tasks.id, p.id), eq(tasks.workspaceId, wsId)));
      }
      return positions.length;
    });
    return { updated };
  });

  /* ── Today's once-a-day arrangement ─────────────────────────────────────
   *
   * POST …/today/arrange-claim  { localDate: 'YYYY-MM-DD' }
   *   -> { claimed: boolean, lastArrangedOn: string | null }
   *
   * Claims the right to arrange Today for one local calendar day, ONCE.
   *
   * The whole guard is the WHERE clause: the update only matches when the
   * stored date differs from the one being claimed, so Postgres serialises two
   * tabs and exactly one of them gets a row back. The loser is told `claimed:
   * false` and does nothing. No advisory locks, no leader election, no
   * assuming a single tab — one conditional UPDATE.
   *
   * The date comes from the CLIENT, deliberately. "Once per local calendar
   * day" means the user's local day; the server does not know the user's
   * timezone and inventing one from the request would be worse than trusting
   * the browser that is about to render the result. The value is validated as
   * a real ISO date and is only ever compared, never used for arithmetic.
   */
  app.post(`${base}/today/arrange-claim`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const userId = req.principal!.userId;
    const { localDate } = z.object({
      localDate: z.string().regex(ISO_DATE, 'localDate must be YYYY-MM-DD'),
    }).strict().parse(req.body ?? {});

    const [row] = await db.select({ on: workspaceMemberships.lastTodayArrangedOn })
      .from(workspaceMemberships)
      .where(and(eq(workspaceMemberships.workspaceId, wsId),
        eq(workspaceMemberships.userId, userId)))
      .limit(1);
    const previous = row?.on ?? null;

    const claimed = await db.update(workspaceMemberships)
      .set({ lastTodayArrangedOn: localDate })
      .where(and(
        eq(workspaceMemberships.workspaceId, wsId),
        eq(workspaceMemberships.userId, userId),
        // The guard. Absent or different means this caller wins; equal matches
        // nothing, so a second tab on the same day gets an empty array.
        or(isNull(workspaceMemberships.lastTodayArrangedOn),
          ne(workspaceMemberships.lastTodayArrangedOn, localDate)),
      ))
      .returning({ id: workspaceMemberships.id });

    return { claimed: claimed.length > 0, lastArrangedOn: previous };
  });

  /**
   * POST …/today/arrange-release  { localDate }
   *
   * Gives the day back. Used when an arrangement fails before it writes
   * anything, and by Undo — after undoing, the day has effectively not been
   * arranged, so the next open may offer it again rather than the user having
   * to wait until tomorrow for a rule they just rejected.
   */
  app.post(`${base}/today/arrange-release`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const userId = req.principal!.userId;
    const { localDate } = z.object({
      localDate: z.string().regex(ISO_DATE),
    }).strict().parse(req.body ?? {});
    await db.update(workspaceMemberships)
      .set({ lastTodayArrangedOn: null })
      .where(and(
        eq(workspaceMemberships.workspaceId, wsId),
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.lastTodayArrangedOn, localDate),
      ));
    return { released: true };
  });

  // ── complete / uncomplete ───────────────────────────────────────────
  //
  // The body is optional and carries any edits the user had made but not yet
  // saved when they ticked the box — typically a note typed seconds earlier.
  //
  // Applied in the SAME transaction as the completion, deliberately. The
  // obvious alternative, "PATCH the edits then POST the completion", is two
  // writes: the first can succeed and the second fail, leaving a task that
  // looks saved but is not done, and if they race, the completion's own
  // `updatedAt` can land before the edit's. One transaction, or the edit is
  // not really attached to the completion at all.
  for (const [verb, done] of [['complete', true], ['uncomplete', false]] as const) {
    app.post(`${base}/tasks/:taskId/${verb}`, pre, async (req) => {
      const wsId = req.workspaceId!;
      const { taskId } = req.params as { taskId: string };
      // `.strict()`, so an unexpected field is a 400 rather than a silent drop.
      // `status` is not accepted because the verb already decided it, and
      // `bucket` is not accepted because a task being completed is leaving the
      // board — a caller that thinks it is also moving the task should be told
      // it is not.
      const edits = TaskUpdate.omit({ status: true, bucket: true }).strict()
        .parse(req.body ?? {});

      const row = await setTaskDone(
        db, wsId, { userId: req.principal!.userId }, taskId, done, edits,
      );
      return { task: row };
    });
  }

  // ── archive (soft) + hard delete ────────────────────────────────────
  app.post(`${base}/tasks/:taskId/archive`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { taskId } = req.params as { taskId: string };
    const row = await archiveTask(db, wsId, { userId: req.principal!.userId }, taskId);
    return { task: row };
  });

  app.delete(`${base}/tasks/:taskId`, pre, async (req, reply) => {
    const wsId = req.workspaceId!;
    const { taskId } = req.params as { taskId: string };
    const r = (await db.delete(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).returning())[0];
    /* `item_links` is polymorphic, so it has no foreign key to a task and
       nothing in the database will tidy up after one. Edges only — whatever
       sat at the other end is somebody else's row and is left alone. */
    if (r) await cleanupLinksFor(db, wsId, 'task', taskId);
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
    const row = await addStep(db, wsId, { taskId, title: body.title });
    reply.code(201);
    return { step: row };
  });

  app.patch(`${base}/tasks/:taskId/steps/:stepId`, pre, async (req) => {
    const wsId = req.workspaceId!;
    const { stepId } = req.params as { stepId: string };
    const body = StepUpdate.parse(req.body);
    return { step: await updateStep(db, wsId, { stepId, ...body }) };
  });

  app.delete(`${base}/tasks/:taskId/steps/:stepId`, pre, async (req, reply) => {
    const wsId = req.workspaceId!;
    const { stepId } = req.params as { stepId: string };
    await removeStep(db, wsId, stepId);
    reply.code(204);
    return null;
  });
}
