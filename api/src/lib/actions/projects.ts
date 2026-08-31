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
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { projects, PROJECT_STATUSES, PROJECT_FOCUSES } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../errors.js';

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
