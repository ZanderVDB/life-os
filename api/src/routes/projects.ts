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
  projects, tasks, taskSteps, areas, projectBooks, libraryBooks, libraryItems, itemLinks,
  PROJECT_STATUSES, PROJECT_FOCUSES,
  type ProjectStatus,
} from '../db/schema.js';
import { ensureProjectBook, PAGE_TARGET } from '../lib/book-links.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { updateProject } from '../lib/actions/projects.js';
import { cleanupLinksFor } from '../lib/relationships.js';
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
  if (explicit) return { task: explicit, explicit: true, reason: 'chosen' as const, staleOverride: false };

  const sorted = [...openTasks].sort((a, b) => {
    // Due first — a date is a commitment, and priority is an opinion.
    const ad = a.dueDate ?? '9999-12-31';
    const bd = b.dueDate ?? '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const ap = PRIORITY_RANK[a.priority] ?? 9;
    const bp = PRIORITY_RANK[b.priority] ?? 9;
    if (ap !== bp) return ap - bp;
    // Only here does manual order decide. Reported, so the interface can say
    // which rule actually applied rather than always claiming the first one.
    return a.projectPosition - b.projectPosition;
  });
  const inferred = sorted[0];
  let reason: 'due' | 'priority' | 'order' | null = null;
  if (inferred) {
    const rival = sorted[1];
    if (!rival) reason = 'order';
    else if ((inferred.dueDate ?? '9999-12-31') !== (rival.dueDate ?? '9999-12-31')) reason = 'due';
    else if ((PRIORITY_RANK[inferred.priority] ?? 9) !== (PRIORITY_RANK[rival.priority] ?? 9)) reason = 'priority';
    else reason = 'order';
  }
  return {
    task: inferred ?? null,
    explicit: false,
    reason,
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
    // The same facts the task row carries. A next action that reported less
    // than the list did made the same Task look like a lesser object.
    nextAction: next.task
      ? {
        id: next.task.id,
        title: next.task.title,
        dueDate: next.task.dueDate,
        priority: next.task.priority,
        bucket: next.task.bucket,
        scheduledAt: next.task.scheduledAt,
        explicit: next.explicit,
        reason: next.reason,
        /* Step progress, when the caller passed tasks that carry steps.
         *
         * The next action is the one task a project is asking you to do, and
         * "4 steps, 2 done" is the most useful thing that can be said about it
         * — it is the difference between not started and nearly finished. The
         * row below it already showed this; the slot above it did not.
         *
         * `steps` is absent on the internal callers that only need ordering, so
         * this reports null rather than a confident 0/0. */
        steps: 'steps' in next.task && Array.isArray((next.task as any).steps)
          ? {
            total: (next.task as any).steps.length,
            done: (next.task as any).steps.filter((s: any) => s.completed).length,
          }
          : null,
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

  /**
   * A project's tasks, in the project's own order.
   *
   * `project_position`, not `position` — `position` orders a task inside its
   * Today bucket, and reusing it would mean reordering here silently reshuffled
   * the Today board. `created_at` breaks ties, so tasks that have never been
   * ordered (all zero) still come back stably rather than arbitrarily.
   */
  const tasksOf = (ws: string, id: string) => db.select().from(tasks)
    .where(and(eq(tasks.workspaceId, ws), eq(tasks.projectId, id)))
    .orderBy(asc(tasks.projectPosition), asc(tasks.createdAt));

  /**
   * The same tasks, WITH their steps.
   *
   * A project task and a Today task are one record, and the row that draws them
   * is one function — so if the project endpoint omits `steps`, the identical
   * task shows "2/4 steps" on Today and nothing at all inside its own project.
   * That is not a rendering difference, it is the same row telling two stories.
   *
   * `tasksOf` stays as it is for the internal callers that only need ordering
   * and status; this is the shape that goes out to the client.
   */
  async function tasksWithSteps(ws: string, id: string) {
    const rows = await tasksOf(ws, id);
    if (!rows.length) return rows.map((t) => ({ ...t, steps: [] as any[] }));
    const steps = await db.select().from(taskSteps)
      .where(and(
        eq(taskSteps.workspaceId, ws),
        inArray(taskSteps.taskId, rows.map((t) => t.id)),
      ))
      .orderBy(asc(taskSteps.position), asc(taskSteps.createdAt));
    const byTask = new Map<string, typeof steps>();
    for (const s of steps) {
      const list = byTask.get(s.taskId) ?? [];
      list.push(s); byTask.set(s.taskId, list);
    }
    return rows.map((t) => ({ ...t, steps: byTask.get(t.id) ?? [] }));
  }

  /**
   * The next free slot at the bottom of the Today bucket.
   *
   * A task brought to Today lands underneath what is already there. Inserting
   * it at the top would let a project reorder the user's day.
   */
  async function endOfToday(ws: string): Promise<number> {
    const [r] = await db.select({ max: sql<number>`coalesce(max(${tasks.position}), 0)` })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, ws), eq(tasks.bucket, 'today'), isNull(tasks.archivedAt)));
    return (r?.max ?? 0) + 1000;
  }

  /**
   * Gives a project's tasks sparse, distinct order values.
   *
   * Everything starts at 0, so the first reorder needs real numbers to insert
   * between. Done once per project, in one statement per task, preserving the
   * order they were already being displayed in.
   */
  async function ensureOrdered(tx: any, ws: string, projectId: string) {
    const rows = await tx.select({ id: tasks.id, pos: tasks.projectPosition })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, ws), eq(tasks.projectId, projectId)))
      .orderBy(asc(tasks.projectPosition), asc(tasks.createdAt));
    const distinct = new Set(rows.map((r: any) => r.pos));
    if (rows.length === distinct.size && !distinct.has(0)) return rows;
    let n = 0;
    for (const r of rows) {
      n += GAP;
      await tx.update(tasks).set({ projectPosition: n }).where(eq(tasks.id, r.id));
      r.pos = n;
    }
    return rows;
  }

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
   * GET …/projects
   *
   * Returns EVERY filter's view in one payload, not just the requested one.
   *
   * That is the fix for the filter flash. Switching filters used to await a
   * round trip before it could render anything correct, so the sequence the
   * user saw was: fade the old list, snap it back to full opacity when the
   * fade finished, wait for the network, then replace. Six views over a dozen
   * projects costs nothing to build and lets the browser switch synchronously.
   *
   * The grouping still happens HERE, so "which group is this project in" keeps
   * exactly one answer rather than being reimplemented in the client.
   */
  app.get(`${base}/projects`, pre, async (req) => {
    const q = z.object({
      filter: z.enum(['working', 'planning', 'someday', 'on_hold', 'completed', 'archived'])
        .default('working'),
    }).safeParse(req.query);
    if (!q.success) throw badRequest('Unknown filter.');
    const ws = wsId(req);

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
    /* Every Project's Book, in one query. The overview is where the "Open Book"
     * affordance lives, so the id has to be here — going and asking per row
     * would be one request per project on the busiest screen in the app. */
    const bookRows = await db.select({
      projectId: projectBooks.projectId, bookId: projectBooks.bookId,
      itemId: libraryBooks.libraryItemId,
    }).from(projectBooks)
      .innerJoin(libraryBooks, eq(libraryBooks.id, projectBooks.bookId))
      .where(and(eq(projectBooks.workspaceId, ws), eq(projectBooks.role, 'primary')));
    const bookByProject = new Map(bookRows.map((b) => [b.projectId, b]));

    const shaped = all.map((p) => ({
      ...shape(p, byProject.get(p.id) ?? [], today),
      book: bookByProject.get(p.id) ?? null,
    }));
    const live = shaped.filter((p) => !p.archivedAt);
    const nonEmpty = (groups: any[]) => groups.filter((g) => g.projects.length > 0);

    /* Working — the default.
     *
     * STATUS decides the lifecycle group; focus only decides how loudly a
     * project asks. An on-hold project focused Now stays on hold: the focus is
     * stored exactly as chosen and surfacing is suppressed, but showing it
     * under "Now" would contradict the status the user just set. Checking
     * focus first is what put it there before.
     *
     * A project appears exactly ONCE. Anything with a health signal is lifted
     * into Needs attention and removed from its normal group, because seeing
     * the same project twice makes the list untrustworthy. */
    const working = live.filter((p) => p.status !== 'completed' && p.focus !== 'someday');
    const attention = working.filter((p) => p.health.length > 0);
    const attentionIds = new Set(attention.map((p) => p.id));
    const rest = working.filter((p) => !attentionIds.has(p.id));
    const onHold = rest.filter((p) => p.status === 'on_hold');
    const notHeld = rest.filter((p) => p.status !== 'on_hold');

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const recentlyCompleted = live.filter((p) => p.status === 'completed'
      && p.completedAt && new Date(p.completedAt) >= thirtyDaysAgo);

    const views = {
      working: nonEmpty([
        { id: 'attention', label: 'Needs attention', projects: attention },
        { id: 'now', label: 'Now', projects: notHeld.filter((p) => p.focus === 'now') },
        { id: 'upcoming', label: 'Upcoming', projects: notHeld.filter((p) => p.focus === 'upcoming') },
        { id: 'on_hold', label: 'On hold', projects: onHold },
        { id: 'recent', label: 'Recently completed', projects: recentlyCompleted },
      ]),
      planning: nonEmpty([{ id: 'planning', label: 'Planning', projects: live.filter((p) => p.status === 'planning') }]),
      someday: nonEmpty([{ id: 'someday', label: 'Someday', projects: live.filter((p) => p.focus === 'someday' && p.status !== 'completed') }]),
      on_hold: nonEmpty([{ id: 'on_hold', label: 'On hold', projects: live.filter((p) => p.status === 'on_hold') }]),
      completed: nonEmpty([{ id: 'completed', label: 'Completed', projects: live.filter((p) => p.status === 'completed') }]),
      archived: nonEmpty([{ id: 'archived', label: 'Archived', projects: shaped.filter((p) => !!p.archivedAt) }]),
    };

    return {
      filter: q.data.filter,
      views,
      // The requested filter, so an older client keeps working unchanged.
      groups: views[q.data.filter],
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

  /**
   * POST …/projects/:id/book — the Book for a Project that has none.
   *
   * The safety net behind the migration backfill. A Project can reach this
   * state two ways: it was imported by a path that predates §6, or the backfill
   * has not run against this database yet. Rather than have every read quietly
   * create rows, the client asks explicitly and once.
   *
   * Idempotent: a Project that already has a Book gets the one it has.
   */
  app.post(`${base}/projects/:id/book`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const project = await load(ws, id);
    const made = await db.transaction((tx) => ensureProjectBook(tx, ws, project));
    return { book: await bookFor(ws, id), created: made.created };
  });

  /**
   * The Project's Primary Book, as much of it as a caller needs to open it.
   *
   * Returns null rather than creating one. Creation belongs to the places that
   * own it — project creation, the migration backfill, and the explicit route
   * above — so a plain read can never have the side effect of writing a Book.
   */
  async function bookFor(ws: string, projectId: string) {
    const [row] = await db.select({
      bookId: projectBooks.bookId, role: projectBooks.role,
      itemId: libraryBooks.libraryItemId, title: libraryItems.title,
    }).from(projectBooks)
      .innerJoin(libraryBooks, eq(libraryBooks.id, projectBooks.bookId))
      .innerJoin(libraryItems, eq(libraryItems.id, libraryBooks.libraryItemId))
      .where(and(eq(projectBooks.workspaceId, ws), eq(projectBooks.projectId, projectId),
        eq(projectBooks.role, 'primary')))
      .limit(1);
    return row ?? null;
  }

  /**
   * Which of these Tasks have Book context, and where it points.
   *
   * One query for the whole list rather than one per Task. The Project screen
   * shows a "linked context" line on any Task that has one, and a request per
   * row would make that line cost more than the rest of the page.
   */
  async function pageLinksFor(ws: string, taskIds: string[]) {
    if (!taskIds.length) return new Map<string, any[]>();
    const links = await db.select().from(itemLinks).where(and(
      eq(itemLinks.workspaceId, ws),
      eq(itemLinks.sourceType, 'task'),
      inArray(itemLinks.sourceId, taskIds),
      eq(itemLinks.targetType, PAGE_TARGET),
    ));
    const byTask = new Map<string, any[]>();
    for (const l of links) {
      const list = byTask.get(l.sourceId) ?? [];
      list.push({
        id: l.id, pageId: l.targetId, kind: l.kind,
        bookId: (l.metadata as any)?.bookId ?? null,
        blockId: (l.metadata as any)?.blockId ?? null,
      });
      byTask.set(l.sourceId, list);
    }
    return byTask;
  }

  app.get(`${base}/projects/:id`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const project = await load(ws, id);
    const list = await tasksWithSteps(ws, id);
    const links = await pageLinksFor(ws, list.map((t: any) => t.id));
    const book = await bookFor(ws, id);
    return {
      /* ON the project, not beside it. The overview already shapes it this way
       * and the detail header reads `p.book` — returning it as a sibling here
       * meant the Book existed, was linked, and rendered its rail, while the
       * Project screen showed no way to reach it. One shape, both routes. */
      project: { ...shape(project, list), book },
      tasks: list.map((t: any) => ({ ...t, pageLinks: links.get(t.id) ?? [] })),
      book,
    };
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
          projectPosition: GAP,
          // Focus decides whether project context surfaces work; a task the
          // user just typed into a Now project belongs in view. Anything else
          // starts in the backlog rather than jumping onto Today.
          bucket: body.focus === 'now' ? 'today' : 'future',
          position: Number(maxPos) + GAP,
        });
      }

      /* Every Project gets a Book, at the moment it is created and in the same
       * transaction (§6). Not lazily on first open: a Project whose Book only
       * exists once somebody looks for it is a Project that AI cannot be told
       * about, and half the point of this model is that the relationship is
       * always there to be asked about. */
      await ensureProjectBook(tx, ws, project!);
      return project!;
    });

    const list = await tasksWithSteps(ws, created.id);
    reply.code(201);
    return { project: shape(created, list), tasks: list, book: await bookFor(ws, created.id) };
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
    const row = await updateProject(db, ws, id, parsed.data);
    const list = await tasksOf(ws, id);
    return { project: shape(row, list) };
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
    const project = await load(ws, id);
    let surfaced = false;

    if (body.data.taskId) {
      const [task] = await db.select().from(tasks)
        .where(and(eq(tasks.workspaceId, ws), eq(tasks.id, body.data.taskId))).limit(1);
      if (!task) throw notFound('That task does not exist.');
      if (task.projectId !== id) throw badRequest('That task is not in this project.');
      if (task.status !== 'open') throw badRequest('The next action has to be an open task.');

      // The ONE case where a project may put a task on Today, and it takes a
      // deliberate act to trigger: someone chose this task, by name, as the
      // single next thing, on a project they have marked Now.
      //
      // Membership does not do this. Focus alone does not do this. Inference
      // does not do this — an inferred next action changes whenever a due date
      // moves, and Today must not reshuffle itself behind the user's back.
      if (project.focus === 'now' && task.bucket !== 'today') {
        await db.update(tasks)
          .set({ bucket: 'today', position: await endOfToday(ws), updatedAt: new Date() })
          .where(and(eq(tasks.workspaceId, ws), eq(tasks.id, task.id)));
        surfaced = true;
      }
    }
    const [row] = await touch(ws, id, { nextTaskId: body.data.taskId });
    const list = await tasksOf(ws, id);
    // `surfaced` is reported so the interface can say what it did. A task that
    // silently appears somewhere else is indistinguishable from a bug.
    return { project: shape(row!, list), surfaced };
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

  /* ── Task order inside a project ───────────────────────────────────── */

  /**
   * POST …/projects/:id/tasks/:taskId/reorder
   * Body: { beforeTaskId } | { afterTaskId } | { to: 'top' | 'bottom' }
   *
   * ONE write. The client sends where the task landed, not a whole array — an
   * array would let a stale client overwrite an order it never saw, and would
   * rewrite every row for a one-row move.
   *
   * Scoped to the project in both directions: the task must be in it, and so
   * must the neighbour. Ordering across projects is not a thing that can be
   * expressed here.
   */
  app.post(`${base}/projects/:id/tasks/:taskId/reorder`, pre, async (req) => {
    const { id, taskId } = z.object({ id: uuid, taskId: uuid }).parse(req.params);
    const body = z.object({
      beforeTaskId: uuid.nullish(),
      afterTaskId: uuid.nullish(),
      to: z.enum(['top', 'bottom']).nullish(),
    }).strict().safeParse(req.body ?? {});
    if (!body.success) throw badRequest('Send { beforeTaskId } , { afterTaskId } or { to }.');
    const ws = wsId(req);
    await load(ws, id);

    const moved = await db.transaction(async (tx) => {
      const rows = await ensureOrdered(tx, ws, id);
      const me = rows.find((r: any) => r.id === taskId);
      if (!me) throw notFound('That task is not in this project.');

      const siblings = rows.filter((r: any) => r.id !== taskId);
      const first = siblings[0]?.pos ?? GAP;
      const last = siblings[siblings.length - 1]?.pos ?? GAP;

      let next: number;
      if (body.data.to === 'top') {
        next = first - GAP;
      } else if (body.data.to === 'bottom') {
        next = last + GAP;
      } else {
        const anchorId = body.data.beforeTaskId ?? body.data.afterTaskId;
        const at = siblings.findIndex((r: any) => r.id === anchorId);
        // A neighbour that is not in this project cannot be an anchor — that is
        // how a cross-project reorder would sneak in.
        if (at === -1) throw badRequest('That task is not in this project.');
        const anchor = siblings[at]!.pos;
        if (body.data.beforeTaskId) {
          const above = siblings[at - 1]?.pos ?? anchor - 2 * GAP;
          next = Math.round((above + anchor) / 2);
        } else {
          const below = siblings[at + 1]?.pos ?? anchor + 2 * GAP;
          next = Math.round((anchor + below) / 2);
        }
      }

      const [row] = await tx.update(tasks)
        .set({ projectPosition: next, updatedAt: new Date() })
        .where(and(eq(tasks.workspaceId, ws), eq(tasks.id, taskId), eq(tasks.projectId, id)))
        .returning();
      return row;
    });

    const list = await tasksWithSteps(ws, id);
    // The whole ordered list comes back, so the client can settle on the
    // server's answer rather than trusting its own optimistic guess.
    return { task: moved, tasks: list, project: shape(await load(ws, id), list) };
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
  /**
   * Deleting a Project keeps everything that is not the Project.
   *
   * Tasks are orphaned rather than destroyed — that rule predates this phase —
   * and the Book now follows the same principle for the same reason. Deleting a
   * project is a statement about the PLAN; the notes, research and payment
   * details written in its Book are not part of the plan, and they are usually
   * the part nobody can reconstruct.
   *
   * So the default is `keep`: the join row goes with the project (it cascades),
   * the Book stays in Library as an ordinary Book, and its Project shelf
   * membership simply stops applying. `archive` and `delete` are available for
   * a caller that means it, but no path in the UI chooses them silently.
   */
  app.delete(`${base}/projects/:id`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ws = wsId(req);
    const q = z.object({
      book: z.enum(['keep', 'archive', 'delete']).default('keep'),
      /* What happens to the work.
       *
       * `keep` orphans them, which was the only behaviour and is still the
       * default — it never destroys anything. But orphaning is not free: an
       * orphaned task keeps its BUCKET, so deleting a project full of Today
       * tasks empties them onto Today as loose work you did not put there.
       * Deleting ten sample projects did exactly that.
       *
       * So the caller says. `delete` removes the tasks that belonged ONLY to
       * this project; anything the user had also dated or scheduled is kept,
       * because a commitment outlives the plan that produced it. */
      tasks: z.enum(['keep', 'delete']).default('keep'),
    }).parse(req.query ?? {});
    await load(ws, id);
    const book = await bookFor(ws, id);

    let orphaned: { id: string }[] = [];
    let removed: { id: string }[] = [];
    if (q.tasks === 'delete') {
      removed = await db.delete(tasks)
        .where(and(eq(tasks.workspaceId, ws), eq(tasks.projectId, id),
          isNull(tasks.dueDate), isNull(tasks.scheduledAt), isNull(tasks.completedAt)))
        .returning({ id: tasks.id });
    }
    // Whatever is left — dated, scheduled or already finished — is kept.
    orphaned = await db.update(tasks)
      .set({ projectId: null, updatedAt: new Date() })
      .where(and(eq(tasks.workspaceId, ws), eq(tasks.projectId, id)))
      .returning({ id: tasks.id });

    if (book && q.book !== 'keep') {
      await db.update(libraryItems).set({
        ...(q.book === 'archive'
          ? { archivedAt: new Date(), status: 'archived' }
          : {}),
        updatedAt: new Date(),
      }).where(eq(libraryItems.id, book.itemId));
      // `delete` removes the item; library_books and its sections cascade.
      if (q.book === 'delete') {
        await db.delete(libraryItems).where(and(eq(libraryItems.workspaceId, ws),
          eq(libraryItems.id, book.itemId)));
      }
    }

    await db.delete(projects).where(and(eq(projects.workspaceId, ws), eq(projects.id, id)));
    /* Edges only, and only the project's own. A task that was deleted with the
       project cleaned up its own above; a task that was merely ORPHANED keeps
       every link it had, because it still exists and those links are still
       true. */
    await cleanupLinksFor(db, ws, 'project', id);
    for (const t of removed) await cleanupLinksFor(db, ws, 'task', t.id);
    return {
      deleted: true,
      tasksKept: orphaned.length,
      tasksDeleted: removed.length,
      book: book ? { itemId: book.itemId, disposition: q.book } : null,
    };
  });
}
