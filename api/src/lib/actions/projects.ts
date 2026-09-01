/**
 * Project application services.
 *
 * ── The distinction this file exists to protect ──────────────────────────
 *
 * `status` is where the work IS: planning · active · on_hold · completed.
 * `focus` is how loudly it should ASK: now · upcoming · someday.
 *
 * They are independent, and keeping them independent is the point. A project
 * can be genuinely Active and deliberately quiet. Legacy collapsed them into
 * one field and recomputed it from recency, which overwrote the user's own
 * choice every time they went a week without touching something.
 *
 * Nothing here derives one from the other, and nothing here derives either
 * from activity. If a caller wants a project to go quiet it says so.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import {
  projects, tasks, areas, PROJECT_STATUSES, PROJECT_FOCUSES,
} from '../../db/schema.js';
import { ensureProjectBook } from '../book-links.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isNull } from 'drizzle-orm';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const ProjectUpdateInput = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  outcome: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(20000).nullish(),
  notes: z.string().max(100000).nullish(),
  targetDate: isoDate.nullish(),
  status: z.enum(PROJECT_STATUSES).optional(),
  focus: z.enum(PROJECT_FOCUSES).optional(),
  /** Optimistic concurrency. A mismatch is a 409 and the caller re-reads. */
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type ProjectUpdate = z.infer<typeof ProjectUpdateInput>;

export async function loadProject(db: Db, wsId: string, id: string) {
  const [row] = await db.select().from(projects)
    .where(and(eq(projects.workspaceId, wsId), eq(projects.id, id))).limit(1);
  if (!row) throw notFound('That project does not exist.');
  return row;
}

/**
 * Refuses to write over a version the caller has not seen.
 *
 * Only when an expectation was stated: a caller that did not read first is not
 * claiming to know the current version, and demanding one would make every
 * simple update a two-step.
 */
export function assertFresh(row: { updatedAt: unknown }, expected?: string) {
  if (!expected) return;
  const actual = row.updatedAt instanceof Date
    ? row.updatedAt.toISOString() : String(row.updatedAt);
  if (new Date(actual).getTime() !== new Date(expected).getTime()) {
    throw conflict('This project changed somewhere else. Reload to see the current version.');
  }
}

export const touchProject = (db: Db, wsId: string, id: string, set: Record<string, unknown>) =>
  db.update(projects).set({ ...set, updatedAt: new Date() })
    .where(and(eq(projects.workspaceId, wsId), eq(projects.id, id)))
    .returning();

export async function updateProject(db: Db, wsId: string, id: string, input: ProjectUpdate) {
  const current = await loadProject(db, wsId, id);
  assertFresh(current, input.expectedUpdatedAt);

  const { expectedUpdatedAt, ...body } = input;
  /* Completing has to ask about open tasks, which is a conversation and not a
     field change. Allowing it here would let a caller finish a project and
     silently strand the work inside it. */
  if (body.status === 'completed') {
    throw badRequest('Use POST …/complete — completing a project has to ask about open tasks.');
  }
  if (current.archivedAt && Object.keys(body).length > 0) {
    throw conflict('This project is archived. Restore it before changing it.');
  }

  const set: Record<string, unknown> = { ...body };
  /* Leaving Completed means it is no longer completed: the timestamp is a fact
     about a state the project is no longer in. `body.status` cannot be
     'completed' here — that path threw above. */
  if (body.status && current.status === 'completed') set['completedAt'] = null;

  const [row] = await touchProject(db, wsId, id, set);
  return row!;
}

/* ══ Creating ════════════════════════════════════════════════════════════ */

/** Sparse spacing so one move rewrites one row. Matches routes/projects.ts. */
const GAP = 1000;

export const ProjectCreateInput = z.object({
  title: z.string().trim().min(1, 'A title is required.').max(300),
  /* Required even though the column is nullable. The column is nullable so the
     Legacy migration can land rows it cannot invent an outcome for; a project
     created here has no such excuse. */
  outcome: z.string().trim().min(1, 'An outcome is required - what is true when this is done?')
    .max(500),
  areaId: z.string().uuid(),
  focus: z.enum(PROJECT_FOCUSES),
  description: z.string().max(20000).nullish(),
  targetDate: isoDate.nullish(),
  /** Optional first task. Its presence is what makes the project Active. */
  firstTask: z.object({ title: z.string().trim().min(1).max(500) }).strict().nullish(),
}).strict();

export async function createProject(
  db: Db, wsId: string, input: z.infer<typeof ProjectCreateInput>,
) {
  const [area] = await db.select({ id: areas.id }).from(areas).where(and(
    eq(areas.workspaceId, wsId), eq(areas.id, input.areaId), isNull(areas.deletedAt),
  )).limit(1);
  if (!area) throw badRequest('That area does not exist in this workspace.');

  /* A project with a first task is being worked on; one without is being
     thought about. Status follows from that, and focus is whatever was asked
     for — the two are set independently and neither is derived from the other. */
  const status = input.firstTask ? 'active' : 'planning';

  const [maxRow] = await db.select({ max: sql<number>`coalesce(max(${projects.position}), 0)` })
    .from(projects).where(eq(projects.workspaceId, wsId));

  return db.transaction(async (tx) => {
    const [project] = await tx.insert(projects).values({
      workspaceId: wsId,
      areaId: input.areaId,
      title: input.title,
      outcome: input.outcome,
      description: input.description ?? null,
      targetDate: input.targetDate ?? null,
      status,
      focus: input.focus,
      position: Number(maxRow?.max ?? 0) + GAP,
    }).returning();

    if (input.firstTask) {
      const [posRow] = await tx.select({ maxPos: sql<number>`coalesce(max(${tasks.position}), 0)` })
        .from(tasks).where(eq(tasks.workspaceId, wsId));
      await tx.insert(tasks).values({
        workspaceId: wsId,
        projectId: project!.id,
        // The first task inherits the project's area: it is being created
        // inside the project, so there is no prior classification to respect.
        areaId: input.areaId,
        title: input.firstTask.title,
        projectPosition: GAP,
        /* Focus decides whether project context surfaces work. A task typed
           into a Now project belongs in view; anything else starts in the
           backlog rather than jumping onto Today. */
        bucket: input.focus === 'now' ? 'today' : 'future',
        position: Number(posRow?.maxPos ?? 0) + GAP,
      });
    }

    /* Every project gets a Book, at creation and in the same transaction. Not
       lazily on first open: a project whose Book exists only once somebody
       looks for it is a project the assistant cannot be told about. */
    await ensureProjectBook(tx, wsId, project!);
    return project!;
  });
}

/* ══ Completing ══════════════════════════════════════════════════════════ */

export class OpenTasksRemain extends Error {
  constructor(readonly openTasks: number) {
    super(`${openTasks} task${openTasks === 1 ? '' : 's'} still open.`);
    this.name = 'OpenTasksRemain';
  }
}

export const ProjectCompleteInput = z.object({
  id: z.string().uuid(),
  /**
   * What to do about work that is not finished.
   *
   * There is no default, on purpose. A project completed with open tasks is
   * either "those were dropped" or "those carry on elsewhere", and guessing
   * either way writes a claim about the user's work that they did not make.
   */
  openTasks: z.enum(['leave', 'cancel']).optional(),
}).strict();

/**
 * Finish a project.
 *
 * @throws OpenTasksRemain when work is unfinished and no decision was given.
 * The caller turns that into a question — for the assistant, a clarification
 * with two options rather than a guess.
 */
export async function completeProject(
  db: Db, wsId: string, input: z.infer<typeof ProjectCompleteInput>,
) {
  const project = await loadProject(db, wsId, input.id);
  if (project.archivedAt) throw conflict('This project is archived. Restore it first.');

  const list = await db.select().from(tasks)
    .where(and(eq(tasks.workspaceId, wsId), eq(tasks.projectId, input.id)));
  const open = list.filter((t) => t.status === 'open');

  if (open.length > 0 && !input.openTasks) throw new OpenTasksRemain(open.length);

  let cancelled = 0;
  await db.transaction(async (tx) => {
    if (open.length > 0 && input.openTasks === 'cancel') {
      const rows = await tx.update(tasks)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(
          eq(tasks.workspaceId, wsId), eq(tasks.projectId, input.id), eq(tasks.status, 'open'),
        )).returning({ id: tasks.id });
      cancelled = rows.length;
    }
    await tx.update(projects).set({
      status: 'completed',
      completedAt: new Date(),
      // A completed project has no next action to point at.
      nextTaskId: null,
      updatedAt: new Date(),
    }).where(and(eq(projects.workspaceId, wsId), eq(projects.id, input.id)));
  });

  return {
    project: await loadProject(db, wsId, input.id),
    tasksCancelled: cancelled,
    tasksLeftOpen: input.openTasks === 'leave' ? open.length : 0,
  };
}

/* ══ Archive ═════════════════════════════════════════════════════════════ */

/**
 * Archive is an OVERLAY, not a status.
 *
 * The project keeps the lifecycle state it had in `preArchiveStatus`, so
 * restoring does not have to guess and a project archived while completed does
 * not come back as active. Idempotent, which matters when a double click
 * produces two requests.
 */
export async function archiveProject(db: Db, wsId: string, id: string) {
  const project = await loadProject(db, wsId, id);
  if (project.archivedAt) return project;
  const [row] = await touchProject(db, wsId, id, {
    archivedAt: new Date(), preArchiveStatus: project.status,
  });
  return row!;
}
