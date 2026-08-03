/**
 * Project API.
 *
 * Three ideas run through the whole file, and everything else follows from
 * them.
 *
 * 1. STATUS AND FOCUS ARE INDEPENDENT. `status` says where the work is;
 *    `focus` says how loudly it should ask. Legacy fused them and then
 *    recomputed the result from recency, so the user's answer was overwritten
 *    by how recently they had opened it. Nothing here ever derives one from
 *    the other, and nothing derives either from activity.
 *
 * 2. PROGRESS AND NEXT ACTION ARE DERIVED, NEVER STORED. A stored percentage
 *    is a second source of truth that drifts the moment a task changes. The
 *    one exception is the explicit next-action override, which is a user
 *    CHOICE — and it is validated on every read rather than trusted.
 *
 * 3. A PROJECT NEVER SILENTLY CHANGES TASKS. Not on completion, not on archive,
 *    not on a focus change, not on an area change. Every bulk effect is
 *    previewed and chosen. The project is context; the tasks are the work.
 */
import type { AppInstance, Guards } from '../types.js';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  projects, tasks, areas, PROJECT_STATUSES, PROJECT_FOCUSES,
  type ProjectStatus,
} from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
// TEMPORARY — sample data for E2 review. Delete with src/lib/sample-projects.ts.
import {
  seedSampleProjects, removeSampleProjects, sampleFootprint, isSampleAllowed,
} from '../lib/sample-projects.js';

/** Sparse spacing, so one move rewrites one row rather than a whole group. */
const GAP = 1000;

/** Priority order for next-action inference. Written down so it is predictable. */
const PRIORITY_RANK: Record<string, number> = {
  urgent: 0, high: 1, medium: 2, low: 3, someday: 4,
};

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

const ProjectCreate = z.object({
  title: z.string().trim().min(1, 'A title is required.').max(300),
  // Required by the API even though the column is nullable: the column is
  // nullable so the Legacy migration can land rows it cannot invent an outcome
  // for. A project created here has no such excuse.
  outcome: z.string({ required_error: 'An outcome is required — what is true when this is done?' })
    .trim().min(1, 'An outcome is required — what is true when this is done?').max(500),
  areaId: uuid,
  focus: z.enum(PROJECT_FOCUSES),
  description: z.string().max(20000).nullish(),
  targetDate: isoDate.nullish(),
  /** Optional first task. Its presence is what makes the project Active. */
  firstTask: z.object({
    title: z.string().trim().min(1).max(500),
  }).strict().nullish(),
}).strict();

const ProjectUpdate = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  outcome: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(20000).nullish(),
  notes: z.string().max(100000).nullish(),
  targetDate: isoDate.nullish(),
  status: z.enum(PROJECT_STATUSES).optional(),
  focus: z.enum(PROJECT_FOCUSES).optional(),
  /** Optimistic concurrency. See `assertFresh`. */
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

/* ── Derived values ──────────────────────────────────────────────────── */

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/**
 * done / (open + done), with cancelled excluded from both sides.
 *
 * A task you decided not to do is not incomplete work, and counting it as
 * such makes a finished project look unfinished forever.
 */
export function progressFor(list: TaskRow[]) {
  const open = list.filter((t) => t.status === 'open').length;
  const done = list.filter((t) => t.status === 'done').length;
  const cancelled = list.filter((t) => t.status === 'cancelled').length;
  const total = open + done;
  return {
    open, done, cancelled, total,
    // null, not 0. "0%" claims a measurement; no tasks means nothing has been
    // measured, and the interface says "Nothing planned yet" instead.
    percent: total === 0 ? null : Math.round((done / total) * 100),
  };
}

/**
 * The next action.
 *
 * The explicit override wins only while it is still valid — open, in this
 * project, in this workspace. A pinned action that survives its own completion
 * is how these go stale, so it is re-checked on every read rather than cleaned
 * up by whatever happened to touch the task.
 */
export function nextActionFor(project: ProjectRow, list: TaskRow[]) {
  const openTasks = list.filter((t) => t.status === 'open');
  const explicit = project.nextTaskId
    ? openTasks.find((t) => t.id === project.nextTaskId
        && t.projectId === project.id
        && t.workspaceId === project.workspaceId)
    : undefined;
  if (explicit) return { task: explicit, explicit: true, staleOverride: false };

  const inferred = [...openTasks].sort((a, b) => {
    // Due first — a date is a commitment, and priority is an opinion.
    const ad = a.dueDate ?? '9999-12-31';
    const bd = b.dueDate ?? '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const ap = PRIORITY_RANK[a.priority] ?? 9;
    const bp = PRIORITY_RANK[b.priority] ?? 9;
    if (ap !== bp) return ap - bp;
    return a.position - b.position;
  })[0];
  return {
    task: inferred ?? null,
    explicit: false,
    // The override pointed at something that is no longer eligible.
    staleOverride: !!project.nextTaskId,
  };
}

/**
 * Health — evidence, not opinion, and only where it changes what you do.
 *
 * "Stalled" is deliberately absent: `updated_at` moves when notes or metadata
 * change, so a recency signal would call a project stalled while you were
 * reading it, and unstalled because you fixed a typo.
 */
export function healthFor(project: ProjectRow, list: TaskRow[], today: string) {
  const out: { id: string; label: string; why: string }[] = [];
  if (project.archivedAt || project.status === 'completed') return out;
  const openTasks = list.filter((t) => t.status === 'open');

  // Planning with nothing to do is normal — that is what planning is.
  if (project.status === 'active' && openTasks.length === 0) {
    out.push({
      id: 'no_next_action',
      label: 'No next action',
      why: 'This project is active but has nothing open to do.',
    });
  }
  if (project.targetDate && project.targetDate < today && openTasks.length > 0) {
    out.push({
      id: 'overdue',
      label: 'Past its target date',
      why: `Target was ${project.targetDate} and ${openTasks.length} task`
        + `${openTasks.length === 1 ? ' is' : 's are'} still open.`,
    });
  }
  return out;
}

/**
 * Whether a project's context should push its work forward on its own.
 *
 * This is the ONLY thing focus does. It never moves a task, never changes a
 * bucket and never touches a date — a task with an explicit due date or a
 * schedule shows up because of that date, whatever its project says.
 */
export function surfacesAutomatically(project: ProjectRow): boolean {
  if (project.archivedAt) return false;
  // On hold and Completed suppress regardless of focus. "On hold + now" is a
  // contradiction, and the status is the one the user just chose.
  if (project.status === 'on_hold' || project.status === 'completed') return false;
  return project.focus === 'now';
}

const todayIso = () => new Date().toISOString().slice(0, 10);

function shape(project: ProjectRow, list: TaskRow[], today = todayIso()) {
  const next = nextActionFor(project, list);
  return {
    ...project,
    progress: progressFor(list),
    nextAction: next.task
      ? {
        id: next.task.id, title: next.task.title, dueDate: next.task.dueDate,
        priority: next.task.priority, explicit: next.explicit,
      }
      : null,
    nextActionOverrideStale: next.staleOverride && !next.explicit,
    health: healthFor(project, list, today),
    surfacesAutomatically: surfacesAutomatically(project),
    taskCount: list.length,
  };
}

export function registerProjectRoutes(
  app: AppInstance, db: Db, guards: Guards, env: { NODE_ENV: string },
) {
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const base = '/api/v1/workspaces/:workspaceId';
  const wsId = (req: any) => req.workspaceId as string;

  /** Loads a project or 404s. Never crosses a workspace. */
  async function load(ws: string, id: string) {
    const [row] = await db.select().from(projects)
      .where(and(eq(projects.workspaceId, ws), eq(projects.id, id))).limit(1);
    if (!row) throw notFound('That project does not exist.');
    return row;
  }

  const tasksOf = (ws: string, id: string) => db.select().from(tasks)
    .where(and(eq(tasks.workspaceId, ws), eq(tasks.projectId, id)))
    .orderBy(asc(tasks.position));

  /**
   * Optimistic concurrency, single-user multi-tab flavour.
   *
   * Not a collaborative editor: the only question is whether the row changed
   * since the tab last read it. If the caller says what it expected and the
   * row disagrees, the write is rejected and the caller re-reads. Silently
   * overwriting the other tab is the failure this exists to prevent.
   */
  function assertFresh(row: ProjectRow, expected?: string) {
    if (!expected) return;
    const actual = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt);
    if (new Date(actual).getTime() !== new Date(expected).getTime()) {
      throw conflict('This project changed somewhere else. Reload to see the current version.');
    }
  }

  async function assertArea(ws: string, areaId: string) {
    const [area] = await db.select().from(areas)
      .where(and(eq(areas.workspaceId, ws), eq(areas.id, areaId), isNull(areas.deletedAt))).limit(1);
    if (!area) throw badRequest('That area does not exist in this workspace.');
    return area;
  }

  const touch = (ws: string, id: string, set: Record<string, unknown>) => db.update(projects)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(projects.workspaceId, ws), eq(projects.id, id)))
    .returning();

  /* ── List ──────────────────────────────────────────────────────────── */

  /**
   * GET …/projects?filter=working|planning|someday|on_hold|completed|archived
   *
   * One request returns everything the overview needs, already shaped. The
   * grouping is decided here rather than in the browser so that "which group
   * is this project in" has exactly one answer.
   */
  app.get(`${base}/projects`, pre, async (req) => {
    const q = z.object({
      filter: z.enum(['working', 'planning', 'someday', 'on_hold', 'completed', 'archived'])
        .default('working'),
    }).safeParse(req.query);
    if (!q.success) throw badRequest('Unknown filter.');
    const ws = wsId(req);
    const filter = q.data.filter;

    const all = await db.select().from(projects)
      .where(eq(projects.workspaceId, ws))
      .orderBy(asc(projects.position), asc(projects.createdAt));

    // One query for every project's tasks, then grouped in memory. A per-project
    // query would be N+1 on the page that lists every project.
    const ids = all.map((p) => p.id);
    const allTasks = ids.length
      ? await db.select().from(tasks)
        .where(and(eq(tasks.workspaceId, ws), inArray(tasks.projectId, ids)))
      : [];
    const byProject = new Map<string, TaskRow[]>();
    for (const t of allTasks) {
      if (!t.projectId) continue;
      const bucket = byProject.get(t.projectId) ?? [];
      bucket.push(t);
      byProject.set(t.projectId, bucket);
    }

    const today = todayIso();
    const shaped = all.map((p) => shape(p, byProject.get(p.id) ?? [], today));

    const live = shaped.filter((p) => !p.archivedAt);
    const pick = (fn: (p: typeof shaped[number]) => boolean) => shaped.filter(fn);

    if (filter === 'archived') {
      return { filter, groups: [{ id: 'archived', label: 'Archived', projects: pick((p) => !!p.archivedAt) }] };
    }
    if (filter === 'completed') {
      const done = live.filter((p) => p.status === 'completed');
      return { filter, groups: [{ id: 'completed', label: 'Completed', projects: done }] };
    }
    if (filter === 'on_hold') {
      return { filter, groups: [{ id: 'on_hold', label: 'On hold', projects: live.filter((p) => p.status === 'on_hold') }] };
    }
    if (filter === 'planning') {
      return { filter, groups: [{ id: 'planning', label: 'Planning', projects: live.filter((p) => p.status === 'planning') }] };
    }
    if (filter === 'someday') {
      return { filter, groups: [{ id: 'someday', label: 'Someday', projects: live.filter((p) => p.focus === 'someday' && p.status !== 'completed') }] };
    }

    /* Working — the default. A project appears exactly ONCE: anything with a
     * health signal is lifted into Needs attention and removed from its normal
     * group, because seeing the same project twice makes the list untrustworthy
     * and the count meaningless. */
    const working = live.filter((p) => p.status !== 'completed' && p.focus !== 'someday');
    const attention = working.filter((p) => p.health.length > 0);
    const attentionIds = new Set(attention.map((p) => p.id));
    const rest = working.filter((p) => !attentionIds.has(p.id));

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const recentlyCompleted = live.filter((p) => p.status === 'completed'
      && p.completedAt && new Date(p.completedAt) >= thirtyDaysAgo);

    return {
      filter,
      groups: [
        { id: 'attention', label: 'Needs attention', projects: attention },
        { id: 'now', label: 'Now', projects: rest.filter((p) => p.focus === 'now') },
        { id: 'upcoming', label: 'Upcoming', projects: rest.filter((p) => p.focus === 'upcoming') },
        { id: 'on_hold', label: 'On hold', projects: rest.filter((p) => p.status === 'on_hold' && p.focus !== 'now' && p.focus !== 'upcoming') },
        { id: 'recent', label: 'Recently completed', projects: recentlyCompleted },
      ].filter((g) => g.projects.length > 0),
      // Counts that support a decision — "is there anything behind this
      // filter?" — rather than counts for their own sake.
      available: {
        planning: live.filter((p) => p.status === 'planning').length,
        someday: live.filter((p) => p.focus === 'someday' && p.status !== 'completed').length,
        on_hold: live.filter((p) => p.status === 'on_hold').length,
        completed: live.filter((p) => p.status === 'completed').length,
        archived: shaped.filter((p) => !!p.archivedAt).length,
      },
    };
  });

  /* ── Read ──────────────────────────────────────────────────────────── */

  app.get(`${base}/projects/:id`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const project = await load(ws, id);
    const list = await tasksOf(ws, id);
    return { project: shape(project, list), tasks: list };
  });

  /* ── Create ────────────────────────────────────────────────────────── */

  /**
   * POST …/projects
   *
   * The initial status is decided by whether there is work, not by asking.
   * A project you create IN ORDER TO do something should not need a second
   * click to admit it is active; a project created as an intention should not
   * start competing for attention.
   */
  app.post(`${base}/projects`, pre, async (req, reply) => {
    const parsed = ProjectCreate.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid project.');
    const ws = wsId(req);
    const body = parsed.data;
    await assertArea(ws, body.areaId);

    const status: ProjectStatus = body.firstTask ? 'active' : 'planning';

    const maxRow = await db.select({
      max: sql<number>`coalesce(max(${projects.position}), 0)`,
    }).from(projects).where(eq(projects.workspaceId, ws));
    const max = maxRow[0]?.max ?? 0;

    const created = await db.transaction(async (tx) => {
      const [project] = await tx.insert(projects).values({
        workspaceId: ws,
        areaId: body.areaId,
        title: body.title,
        outcome: body.outcome,
        description: body.description ?? null,
        targetDate: body.targetDate ?? null,
        status,
        focus: body.focus,
        position: Number(max) + GAP,
      }).returning();

      if (body.firstTask) {
        // The first task inherits the project's area. It is being created
        // inside the project, so there is no prior classification to respect.
        const posRow = await tx.select({
          maxPos: sql<number>`coalesce(max(${tasks.position}), 0)`,
        }).from(tasks).where(eq(tasks.workspaceId, ws));
        const maxPos = posRow[0]?.maxPos ?? 0;
        await tx.insert(tasks).values({
          workspaceId: ws,
          projectId: project!.id,
          areaId: body.areaId,
          title: body.firstTask.title,
          // Focus decides whether project context surfaces work; a task the
          // user just typed into a Now project belongs in view. Anything else
          // starts in the backlog rather than jumping onto Today.
          bucket: body.focus === 'now' ? 'today' : 'future',
          position: Number(maxPos) + GAP,
        });
      }
      return project!;
    });

    const list = await tasksOf(ws, created.id);
    reply.code(201);
    return { project: shape(created, list), tasks: list };
  });

  /* ── Update ────────────────────────────────────────────────────────── */

  /**
   * PATCH …/projects/:id
   *
   * Status and focus can be set here, and setting one NEVER derives the other.
   * Completion is not available through this route — it has consequences for
   * open tasks and gets its own endpoint that asks about them.
   */
  app.patch(`${base}/projects/:id`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const parsed = ProjectUpdate.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid change.');
    const ws = wsId(req);
    const current = await load(ws, id);
    assertFresh(current, parsed.data.expectedUpdatedAt);

    const { expectedUpdatedAt, ...body } = parsed.data;
    if (body.status === 'completed') {
      throw badRequest('Use POST …/complete — completing a project has to ask about open tasks.');
    }
    if (current.archivedAt && Object.keys(body).length > 0) {
      throw conflict('This project is archived. Restore it before changing it.');
    }

    const set: Record<string, unknown> = { ...body };
    // Leaving Completed means it is no longer completed. The timestamp is a
    // fact about a state the project is no longer in. (`body.status` cannot be
    // 'completed' here — that path threw above.)
    if (body.status && current.status === 'completed') set.completedAt = null;
    const [row] = await touch(ws, id, set);
    const list = await tasksOf(ws, id);
    return { project: shape(row!, list) };
  });

  /* ── Next action ───────────────────────────────────────────────────── */

  /**
   * POST …/projects/:id/next-action  { taskId | null }
   *
   * An explicit choice. Validated here AND on every read, because the task can
   * stop being eligible without anything calling this endpoint.
   */
  app.post(`${base}/projects/:id/next-action`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ taskId: uuid.nullable() }).strict().safeParse(req.body);
    if (!body.success) throw badRequest('Send { "taskId": "<uuid>" } or { "taskId": null }.');
    const ws = wsId(req);
    await load(ws, id);

    if (body.data.taskId) {
      const [task] = await db.select().from(tasks)
        .where(and(eq(tasks.workspaceId, ws), eq(tasks.id, body.data.taskId))).limit(1);
      if (!task) throw notFound('That task does not exist.');
      if (task.projectId !== id) throw badRequest('That task is not in this project.');
      if (task.status !== 'open') throw badRequest('The next action has to be an open task.');
    }
    const [row] = await touch(ws, id, { nextTaskId: body.data.taskId });
    const list = await tasksOf(ws, id);
    return { project: shape(row!, list) };
  });

  /* ── Task assignment ───────────────────────────────────────────────── */

  /**
   * POST …/projects/:id/tasks  { taskId, areaChoice? }
   *
   * The area contract, in full:
   *   task has no area          → adopt the project's
   *   task area === project's   → assign
   *   task area differs         → 409 with both options, and the caller
   *                               re-sends with an explicit choice
   *
   * An explicitly chosen area is how the user finds things later. Changing it
   * because a task was filed somewhere is a silent reclassification, and the
   * only honest response is to ask.
   */
  app.post(`${base}/projects/:id/tasks`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({
      taskId: uuid,
      areaChoice: z.enum(['keep', 'move']).optional(),
    }).strict().safeParse(req.body);
    if (!body.success) throw badRequest('Send { "taskId": "<uuid>" }.');
    const ws = wsId(req);
    const project = await load(ws, id);
    if (project.archivedAt) throw conflict('This project is archived. Restore it first.');

    const [task] = await db.select().from(tasks)
      .where(and(eq(tasks.workspaceId, ws), eq(tasks.id, body.data.taskId))).limit(1);
    if (!task) throw notFound('That task does not exist.');
    if (task.projectId === id) return { task, project: shape(project, await tasksOf(ws, id)) };

    let areaId = task.areaId;
    if (!task.areaId) {
      areaId = project.areaId;
    } else if (task.areaId !== project.areaId) {
      if (!body.data.areaChoice) {
        throw conflict(JSON.stringify({
          reason: 'area_mismatch',
          message: 'That task is in a different area from this project.',
          taskAreaId: task.areaId,
          projectAreaId: project.areaId,
          choices: ['keep', 'move'],
        }));
      }
      if (body.data.areaChoice === 'move') areaId = project.areaId;
    }

    const [updated] = await db.update(tasks)
      .set({ projectId: id, areaId, updatedAt: new Date() })
      .where(and(eq(tasks.workspaceId, ws), eq(tasks.id, task.id)))
      .returning();
    return { task: updated, project: shape(project, await tasksOf(ws, id)) };
  });

  /**
   * DELETE …/projects/:id/tasks/:taskId
   *
   * Removes the relationship and nothing else. The task keeps its area,
   * bucket, due date, schedule and steps — it was never owned by the project.
   */
  app.delete(`${base}/projects/:id/tasks/:taskId`, pre, async (req) => {
    const { id, taskId } = z.object({ id: uuid, taskId: uuid }).parse(req.params);
    const ws = wsId(req);
    const project = await load(ws, id);
    const [updated] = await db.update(tasks)
      .set({ projectId: null, updatedAt: new Date() })
      .where(and(eq(tasks.workspaceId, ws), eq(tasks.id, taskId), eq(tasks.projectId, id)))
      .returning();
    if (!updated) throw notFound('That task is not in this project.');
    // The next action cannot point outside the project.
    if (project.nextTaskId === taskId) await touch(ws, id, { nextTaskId: null });
    return { task: updated, project: shape(await load(ws, id), await tasksOf(ws, id)) };
  });

  /* ── Area change ───────────────────────────────────────────────────── */

  /**
   * GET …/projects/:id/area-preview?areaId=…
   *
   * What would happen, before it happens. Separates tasks that merely inherited
   * the old area from those classified differently on purpose — only the first
   * group is safe to move without asking again.
   */
  app.get(`${base}/projects/:id/area-preview`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z.object({ areaId: uuid }).safeParse(req.query);
    if (!q.success) throw badRequest('Send ?areaId=<uuid>.');
    const ws = wsId(req);
    const project = await load(ws, id);
    await assertArea(ws, q.data.areaId);
    const list = await tasksOf(ws, id);

    const inherited = list.filter((t) => t.areaId === project.areaId);
    const different = list.filter((t) => t.areaId && t.areaId !== project.areaId);
    const none = list.filter((t) => !t.areaId);
    return {
      total: list.length,
      inherited: inherited.length,
      differentlyClassified: different.length,
      withoutArea: none.length,
      choices: ['move_inherited', 'keep_all'],
    };
  });

  app.post(`${base}/projects/:id/area`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({
      areaId: uuid,
      taskChoice: z.enum(['move_inherited', 'keep_all']),
      expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
    }).strict().safeParse(req.body);
    if (!body.success) throw badRequest('Send { areaId, taskChoice }.');
    const ws = wsId(req);
    const project = await load(ws, id);
    assertFresh(project, body.data.expectedUpdatedAt);
    await assertArea(ws, body.data.areaId);

    let moved = 0;
    await db.transaction(async (tx) => {
      if (body.data.taskChoice === 'move_inherited' && project.areaId) {
        // Only the ones that inherited. A task filed elsewhere on purpose keeps
        // its classification — that is the entire point of asking.
        const rows = await tx.update(tasks)
          .set({ areaId: body.data.areaId, updatedAt: new Date() })
          .where(and(eq(tasks.workspaceId, ws), eq(tasks.projectId, id),
            eq(tasks.areaId, project.areaId)))
          .returning({ id: tasks.id });
        moved = rows.length;
      }
      await tx.update(projects)
        .set({ areaId: body.data.areaId, updatedAt: new Date() })
        .where(and(eq(projects.workspaceId, ws), eq(projects.id, id)));
    });

    const list = await tasksOf(ws, id);
    return { project: shape(await load(ws, id), list), tasksMoved: moved };
  });

  /* ── Completion ────────────────────────────────────────────────────── */

  /**
   * POST …/projects/:id/complete  { openTasks?: 'leave' | 'cancel' }
   *
   * With open tasks and no decision, this refuses and reports the count. It
   * never marks work done that was not done — a completed project full of
   * fabricated completions is worse than an honest one with loose ends.
   */
  app.post(`${base}/projects/:id/complete`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({
      openTasks: z.enum(['leave', 'cancel']).optional(),
      expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
    }).strict().safeParse(req.body ?? {});
    if (!body.success) throw badRequest('Send { "openTasks": "leave" | "cancel" }.');
    const ws = wsId(req);
    const project = await load(ws, id);
    assertFresh(project, body.data.expectedUpdatedAt);
    if (project.archivedAt) throw conflict('This project is archived. Restore it first.');

    const list = await tasksOf(ws, id);
    const open = list.filter((t) => t.status === 'open');

    if (open.length > 0 && !body.data.openTasks) {
      throw conflict(JSON.stringify({
        reason: 'open_tasks',
        message: `${open.length} task${open.length === 1 ? '' : 's'} still open.`,
        openTasks: open.length,
        choices: ['leave', 'cancel'],
      }));
    }

    let cancelled = 0;
    await db.transaction(async (tx) => {
      if (open.length > 0 && body.data.openTasks === 'cancel') {
        const rows = await tx.update(tasks)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(and(eq(tasks.workspaceId, ws), eq(tasks.projectId, id), eq(tasks.status, 'open')))
          .returning({ id: tasks.id });
        cancelled = rows.length;
      }
      await tx.update(projects).set({
        status: 'completed',
        completedAt: new Date(),
        // A completed project has no next action to point at.
        nextTaskId: null,
        updatedAt: new Date(),
      }).where(and(eq(projects.workspaceId, ws), eq(projects.id, id)));
    });

    const after = await tasksOf(ws, id);
    return {
      project: shape(await load(ws, id), after),
      tasksCancelled: cancelled,
      tasksLeftOpen: body.data.openTasks === 'leave' ? open.length : 0,
    };
  });

  /* ── Archive / restore ─────────────────────────────────────────────── */

  /**
   * Archive is an overlay, not a status. The project keeps the lifecycle state
   * it had, so restoring does not have to guess — and a project archived while
   * completed does not come back as active.
   */
  app.post(`${base}/projects/:id/archive`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ws = wsId(req);
    const project = await load(ws, id);
    // Idempotent: archiving twice is the same as archiving once, which matters
    // when a double click produces two requests.
    if (project.archivedAt) return { project: shape(project, await tasksOf(ws, id)) };
    const [row] = await touch(ws, id, {
      archivedAt: new Date(), preArchiveStatus: project.status,
    });
    return { project: shape(row!, await tasksOf(ws, id)) };
  });

  app.post(`${base}/projects/:id/restore`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ws = wsId(req);
    const project = await load(ws, id);
    if (!project.archivedAt) return { project: shape(project, await tasksOf(ws, id)) };
    const [row] = await touch(ws, id, {
      archivedAt: null,
      preArchiveStatus: null,
      status: project.preArchiveStatus ?? project.status,
    });
    return { project: shape(row!, await tasksOf(ws, id)) };
  });

  /* ── Order ─────────────────────────────────────────────────────────── */

  /** Move to top. The non-drag path, and the only one E2 ships. */
  app.post(`${base}/projects/:id/move-to-top`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ws = wsId(req);
    await load(ws, id);
    const minRow = await db.select({
      min: sql<number>`coalesce(min(${projects.position}), 0)`,
    }).from(projects).where(eq(projects.workspaceId, ws));
    const min = minRow[0]?.min ?? 0;
    const [row] = await touch(ws, id, { position: Number(min) - GAP });
    return { project: shape(row!, await tasksOf(ws, id)) };
  });

  /* ── Sample data — TEMPORARY, staging only ─────────────────────────────
   * Delete this block and src/lib/sample-projects.ts once E2 is reviewed. */

  /** What the sample set is, without creating or removing anything. */
  app.get(`${base}/projects/sample`, pre, async (req) => {
    const ws = wsId(req);
    return { ...(await sampleFootprint(db, ws)), allowed: isSampleAllowed(env.NODE_ENV) };
  });

  app.post(`${base}/projects/sample`, pre, async (req) => {
    if (!isSampleAllowed(env.NODE_ENV)) {
      throw forbidden('Sample data is not available in production.');
    }
    const ws = wsId(req);
    const rows = await db.select().from(areas)
      .where(and(eq(areas.workspaceId, ws), isNull(areas.deletedAt)));
    const byName = new Map(rows.map((a) => [a.name, a.id]));
    const result = await seedSampleProjects(db, ws, byName);
    return { ...result, removeWith: 'POST …/projects/sample/remove' };
  });

  /**
   * Removes the sample set and nothing else — matched only by the
   * `sample:e2:` marker, never by title, date or "created recently".
   */
  app.post(`${base}/projects/sample/remove`, pre, async (req) => {
    if (!isSampleAllowed(env.NODE_ENV)) {
      throw forbidden('Sample data is not available in production.');
    }
    const ws = wsId(req);
    const before = await sampleFootprint(db, ws);
    const removed = await removeSampleProjects(db, ws);
    return { removed, expected: { projects: before.projects, tasks: before.tasks } };
  });

  /* ── Delete ────────────────────────────────────────────────────────── */

  /**
   * Deleting a project deletes the project. The foreign key is
   * `on delete set null`, so its tasks survive with everything intact and
   * simply stop belonging to it.
   */
  app.delete(`${base}/projects/:id`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ws = wsId(req);
    await load(ws, id);
    const orphaned = await db.update(tasks)
      .set({ projectId: null, updatedAt: new Date() })
      .where(and(eq(tasks.workspaceId, ws), eq(tasks.projectId, id)))
      .returning({ id: tasks.id });
    await db.delete(projects).where(and(eq(projects.workspaceId, ws), eq(projects.id, id)));
    return { deleted: true, tasksKept: orphaned.length };
  });
}
