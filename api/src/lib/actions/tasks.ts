/**
 * Task application services.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * These rules used to live inside route handlers, which means they applied to
 * callers who happened to arrive over HTTP and to nobody else. The assistant
 * is not such a caller. Calendar already learned this lesson — see the note at
 * the top of `routes/calendar-write.ts`: "a rule enforced in a route handler is
 * a rule that only applies to callers who happen to use that route".
 *
 * So the route handlers now parse, authorise and hand over; the rules live
 * here. The human UI and the assistant call the same functions and therefore
 * cannot drift apart — a validation added for one is added for both.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────
 *
 * `reorder` and the Today arrangement claim. Both are a pointer dragging a row
 * against a rendered list; no sentence maps onto "put this between those two",
 * and extracting them would be motion without a caller.
 *
 * Steps ARE here, because "add a step to book the venue" is an ordinary thing
 * to say, and so is `archive` and moving between buckets.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import {
  tasks, taskSteps, taskActivity, areas, projects, BUCKETS, PRIORITIES,
} from '../../db/schema.js';
import { badRequest, notFound } from '../errors.js';

/** Sparse spacing so a single move rewrites one row, not the whole bucket. */
const GAP = 1000;

export const TaskCreateInput = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(500),
  notes: z.string().max(20000).nullish(),
  bucket: z.enum(BUCKETS).default('today'),
  priority: z.enum(PRIORITIES).default('medium'),
  areaId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
  /** The deadline. NOT when you intend to do it — see `scheduledAt`. */
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').nullish(),
  /** When you intend to do it. NOT the deadline — see `dueDate`. */
  scheduledAt: z.string().datetime({ offset: true }).nullish(),
  estimatedMinutes: z.number().int().positive().max(10080).nullish(),
}).strict();

export const TaskUpdateInput = TaskCreateInput.partial().extend({
  status: z.enum(['open', 'done', 'cancelled']).optional(),
}).strict();

export type TaskCreate = z.infer<typeof TaskCreateInput>;
export type TaskUpdate = z.infer<typeof TaskUpdateInput>;

/** Who did it. Every mutation records one; there is no anonymous write. */
export type Actor = { userId: string };

const logActivity = (
  tx: any, wsId: string, taskId: string, userId: string, action: string, changes?: unknown,
) => tx.insert(taskActivity).values({
  workspaceId: wsId, taskId, userId, action, changes: changes ?? null,
});

async function endPosition(tx: any, wsId: string, bucket: string): Promise<number> {
  const r = await tx.select({ max: sql<number>`coalesce(max(${tasks.position}), 0)` })
    .from(tasks).where(and(
      eq(tasks.workspaceId, wsId), eq(tasks.bucket, bucket), isNull(tasks.archivedAt),
    ));
  return Number(r[0]?.max ?? 0) + GAP;
}

/**
 * An Area and a Project named in an input must exist IN THIS WORKSPACE.
 *
 * Checked rather than assumed because the id can come from anywhere — a stale
 * client, an import, or a model that produced a plausible-looking uuid. A
 * foreign key would reject a genuinely foreign id but would happily accept one
 * belonging to somebody else's workspace.
 */
async function assertRefs(db: Db, wsId: string, input: { areaId?: string | null; projectId?: string | null }) {
  if (input.areaId) {
    const [a] = await db.select({ id: areas.id }).from(areas).where(and(
      eq(areas.id, input.areaId), eq(areas.workspaceId, wsId), isNull(areas.deletedAt),
    )).limit(1);
    if (!a) throw badRequest('That Area does not exist in this workspace.');
  }
  if (input.projectId) {
    const [p] = await db.select({ id: projects.id }).from(projects).where(and(
      eq(projects.id, input.projectId), eq(projects.workspaceId, wsId),
    )).limit(1);
    if (!p) throw badRequest('That project does not exist in this workspace.');
  }
}

export async function createTask(db: Db, wsId: string, actor: Actor, input: TaskCreate) {
  await assertRefs(db, wsId, input);
  return db.transaction(async (tx) => {
    const position = await endPosition(tx, wsId, input.bucket);
    const created = (await tx.insert(tasks).values({
      workspaceId: wsId,
      title: input.title,
      notes: input.notes ?? null,
      bucket: input.bucket,
      priority: input.priority,
      areaId: input.areaId ?? null,
      projectId: input.projectId ?? null,
      dueDate: input.dueDate ?? null,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      estimatedMinutes: input.estimatedMinutes ?? null,
      position,
    }).returning())[0]!;
    await logActivity(tx, wsId, created.id, actor.userId, 'created');
    return created;
  });
}

/**
 * Turns an update into a column patch.
 *
 * `undefined` means "not mentioned" and `null` means "clear it" — collapsing
 * the two is how an edit that touches one field silently erases three others.
 */
function patchFrom(edits: TaskUpdate) {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (edits.title !== undefined) patch['title'] = edits.title;
  if (edits.notes !== undefined) patch['notes'] = edits.notes ?? null;
  if (edits.priority !== undefined) patch['priority'] = edits.priority;
  if (edits.areaId !== undefined) patch['areaId'] = edits.areaId ?? null;
  /* `bucket` and `projectId` are NOT here, deliberately.
   *
   * Changing bucket also has to reposition the task, which needs the row it is
   * moving from — `updateTask` does it below, where that row is in hand.
   *
   * Project membership belongs to `POST /projects/:id/tasks`, which maintains
   * `projectPosition` — a SECOND ordering, so dragging inside a project does
   * not reshuffle Today. Setting `project_id` from here would attach a task
   * with no position in the project it just joined. */
  /* dueDate and scheduledAt are separate facts and are patched separately.
     "Due Friday" and "I will do it Wednesday" are different statements, and a
     service that wrote one from the other would make both untrustworthy. */
  if (edits.dueDate !== undefined) patch['dueDate'] = edits.dueDate ?? null;
  if (edits.scheduledAt !== undefined) {
    patch['scheduledAt'] = edits.scheduledAt ? new Date(edits.scheduledAt) : null;
  }
  if (edits.estimatedMinutes !== undefined) {
    patch['estimatedMinutes'] = edits.estimatedMinutes ?? null;
  }
  return patch;
}

export async function updateTask(db: Db, wsId: string, actor: Actor, taskId: string, edits: TaskUpdate) {
  await assertRefs(db, wsId, edits);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).limit(1);
    if (!existing) throw notFound('Task not found.');

    const patch = patchFrom(edits);
    /* A task arriving in a bucket goes to the END of it. Without a fresh
       position it keeps the one it held in the bucket it left, and lands in an
       arbitrary place in the middle of the new one. */
    if (edits.bucket !== undefined && edits.bucket !== existing.bucket) {
      patch['bucket'] = edits.bucket;
      patch['position'] = await endPosition(tx, wsId, edits.bucket);
    }
    if (edits.status !== undefined) {
      patch['status'] = edits.status;
      patch['completedAt'] = edits.status === 'done' ? new Date() : null;
    }
    const [row] = await tx.update(tasks).set(patch)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).returning();
    if (!row) throw notFound('Task not found.');
    await logActivity(tx, wsId, taskId, actor.userId, 'edited', { fields: Object.keys(edits) });
    return row;
  });
}

/**
 * Complete or reopen, with any unsaved edits applied in the SAME transaction.
 *
 * The obvious alternative — patch the edits, then post the completion — is two
 * writes: the first can succeed and the second fail, leaving a task that looks
 * saved but is not done, and if they race the completion's `updatedAt` can
 * land before the edit's.
 *
 * `bucket` is not accepted: a task being completed is leaving the board, and
 * moving it between buckets on the way out rewrites a position for a row
 * nothing is going to show.
 */
export async function setTaskDone(
  db: Db, wsId: string, actor: Actor, taskId: string, done: boolean,
  edits: Omit<TaskUpdate, 'status' | 'bucket'> = {},
) {
  await assertRefs(db, wsId, edits);
  return db.transaction(async (tx) => {
    const patch = patchFrom(edits as TaskUpdate);
    delete patch['bucket'];
    patch['status'] = done ? 'done' : 'open';
    patch['completedAt'] = done ? new Date() : null;

    const [row] = await tx.update(tasks).set(patch)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).returning();
    if (!row) throw notFound('Task not found.');
    const fields = Object.keys(edits);
    if (fields.length) await logActivity(tx, wsId, taskId, actor.userId, 'edited', { fields });
    await logActivity(tx, wsId, taskId, actor.userId, done ? 'completed' : 'reopened');
    return row;
  });
}

/**
 * Set the time a task is INTENDED to be worked on.
 *
 * Its own function rather than a corner of `updateTask`, because it is the one
 * a natural-language request most often means and the one most easily confused
 * with a deadline. Setting `scheduledAt` never touches `dueDate`, and this
 * does NOT create a calendar event: putting an hour in Google is a separate,
 * external, confirmed action. See docs/ai-system.md §16.
 */
export async function scheduleTask(
  db: Db, wsId: string, actor: Actor, taskId: string, scheduledAt: string | null,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(tasks)
      .set({ scheduledAt: scheduledAt ? new Date(scheduledAt) : null, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).returning();
    if (!row) throw notFound('Task not found.');
    await logActivity(tx, wsId, taskId, actor.userId, 'edited', { fields: ['scheduledAt'] });
    return row;
  });
}

/* ══ Steps ═══════════════════════════════════════════════════════════════
 *
 * Ordered sub-items with their own completion. Strictly sequential in the UI —
 * current / next / later — which is why a new one goes at the END rather than
 * anywhere a caller fancies: inserting into the middle would change which step
 * is "current" without anybody asking for that.
 */

export const StepAddInput = z.object({
  taskId: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
}).strict();

export const StepUpdateInput = z.object({
  stepId: z.string().uuid(),
  title: z.string().trim().min(1).max(300).optional(),
  completed: z.boolean().optional(),
}).strict();

export async function addStep(db: Db, wsId: string, input: z.infer<typeof StepAddInput>) {
  const [t] = await db.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, wsId))).limit(1);
  if (!t) throw notFound('Task not found.');
  const [max] = await db.select({ m: sql<number>`coalesce(max(${taskSteps.position}), -1)` })
    .from(taskSteps).where(eq(taskSteps.taskId, input.taskId));
  const [row] = await db.insert(taskSteps).values({
    taskId: input.taskId, workspaceId: wsId, title: input.title,
    position: Number(max?.m ?? -1) + 1,
  }).returning();
  return row!;
}

export async function updateStep(db: Db, wsId: string, input: z.infer<typeof StepUpdateInput>) {
  const { stepId, ...patch } = input;
  if (!Object.keys(patch).length) throw badRequest('No fields to update.');
  const [row] = await db.update(taskSteps).set({ ...patch, updatedAt: new Date() })
    .where(and(eq(taskSteps.id, stepId), eq(taskSteps.workspaceId, wsId))).returning();
  if (!row) throw notFound('Step not found.');
  return row;
}

export async function removeStep(db: Db, wsId: string, stepId: string) {
  const [row] = await db.delete(taskSteps)
    .where(and(eq(taskSteps.id, stepId), eq(taskSteps.workspaceId, wsId))).returning();
  if (!row) throw notFound('Step not found.');
  return row;
}

/* ══ Archive ═════════════════════════════════════════════════════════════ */

/**
 * Off the board, history kept.
 *
 * Not a delete, and the distinction matters to an assistant: "get rid of that"
 * almost always means "stop showing it to me", and archiving is the reading
 * that can be undone.
 */
export async function archiveTask(db: Db, wsId: string, actor: Actor, taskId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(tasks)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, wsId))).returning();
    if (!row) throw notFound('Task not found.');
    await logActivity(tx, wsId, taskId, actor.userId, 'archived');
    return row;
  });
}

/* ══ Buckets ═════════════════════════════════════════════════════════════ */

export const TaskMoveInput = z.object({
  id: z.string().uuid(),
  bucket: z.enum(BUCKETS),
}).strict();

/**
 * Move a task between Today / This week / This month / Future.
 *
 * A bucket is where a task sits on the board. It is NOT a due date and it is
 * not a schedule: moving something to "this week" says nothing about when it
 * is due, and a caller that wanted a deadline wants `dueDate`.
 *
 * Delegates to `updateTask` so the repositioning rule lives in exactly one
 * place — a task arriving in a bucket goes to the end of it.
 */
export async function moveTask(
  db: Db, wsId: string, actor: Actor, input: z.infer<typeof TaskMoveInput>,
) {
  return updateTask(db, wsId, actor, input.id, { bucket: input.bucket });
}
