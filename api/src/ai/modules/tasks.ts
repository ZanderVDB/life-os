/**
 * Tasks, as the assistant sees them.
 *
 * Every mutation here is three lines that call `lib/actions/tasks.ts`. That is
 * the correct size for an adapter: if it grows a rule, the rule has escaped
 * the domain and now applies to the assistant and not to the person using the
 * app.
 */
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { tasks, projects, BUCKETS, PRIORITIES } from '../../db/schema.js';
import {
  createTask, updateTask, setTaskDone, scheduleTask,
  TaskCreateInput, TaskUpdateInput,
} from '../../lib/actions/tasks.js';
import type { AiModule, Capability, CapabilityCtx } from '../registry.js';
import type { ContextSource } from '../types.js';

const uuid = z.string().uuid();

/** One task, as a source: enough to reason with, never the whole row. */
function source(row: typeof tasks.$inferSelect, projectTitle?: string | null, level: 1 | 2 | 3 = 2): ContextSource {
  return {
    ref: { type: 'task', id: row.id },
    module: 'tasks',
    title: row.title,
    summary: [row.status !== 'open' ? row.status : null, projectTitle].filter(Boolean).join(' · ') || null,
    data: {
      status: row.status,
      bucket: row.bucket,
      priority: row.priority,
      /* Both, always, and never merged. "Due Friday" and "I'll do it
         Wednesday" are different statements, and a planner given one under the
         other's name will confidently reschedule the wrong thing. */
      dueDate: row.dueDate,
      scheduledAt: row.scheduledAt,
      estimatedMinutes: row.estimatedMinutes,
      projectId: row.projectId,
      areaId: row.areaId,
    },
    via: 'direct',
    level,
  };
}

const searchCap: Capability = {
  id: 'task.search',
  module: 'tasks',
  kind: 'search',
  label: 'Find tasks',
  description: 'Find tasks by words in their title. Returns status, bucket, priority, '
    + 'dueDate (the deadline) and scheduledAt (when it is intended to be done) — these are separate facts.',
  input: z.object({
    query: z.string().trim().min(2).max(200),
    includeCompleted: z.boolean().default(false),
    limit: z.number().int().min(1).max(25).default(10),
  }).strict(),
  risk: 'safe',
  async run(ctx: CapabilityCtx, input: { query: string; includeCompleted: boolean; limit: number }) {
    const ws = ctx.request.workspaceId;
    const rows = await ctx.db.select().from(tasks).where(and(
      eq(tasks.workspaceId, ws),
      isNull(tasks.archivedAt),
      ilike(tasks.title, `%${input.query}%`),
      ...(input.includeCompleted ? [] : [eq(tasks.status, 'open')]),
    )).orderBy(desc(tasks.updatedAt)).limit(input.limit);
    const titles = new Map<string, string>();
    const ids = rows.map((r) => r.projectId).filter(Boolean) as string[];
    if (ids.length) {
      for (const p of await ctx.db.select({ id: projects.id, title: projects.title })
        .from(projects).where(and(eq(projects.workspaceId, ws), sql`${projects.id} = any(${ids})`))) {
        titles.set(p.id, p.title);
      }
    }
    return rows.map((r) => source(r, r.projectId ? titles.get(r.projectId) : null));
  },
};

const readCap: Capability = {
  id: 'task.read',
  module: 'tasks',
  kind: 'read',
  label: 'Read a task',
  description: 'Load one task in full by id.',
  input: z.object({ id: uuid }).strict(),
  risk: 'safe',
  async run(ctx, input: { id: string }) {
    const [row] = await ctx.db.select().from(tasks).where(and(
      eq(tasks.workspaceId, ctx.request.workspaceId), eq(tasks.id, input.id),
    )).limit(1);
    return row ? [source(row, null, 1)] : [];
  },
};

const createCap: Capability = {
  id: 'task.create',
  module: 'tasks',
  kind: 'mutate',
  label: 'Create task',
  description: 'Create one task. Set dueDate ONLY for a stated deadline and scheduledAt ONLY '
    + 'for a stated intention to work on it. Creating a task never creates a calendar event.',
  input: TaskCreateInput,
  risk: 'confirm',
  async execute(ctx, input) {
    const row = await createTask(ctx.db, ctx.request.workspaceId, { userId: ctx.request.userId }, input as any);
    return { status: 'done', ref: { type: 'task', id: row.id }, message: `Added “${row.title}”.` };
  },
};

const updateCap: Capability = {
  id: 'task.update',
  module: 'tasks',
  kind: 'mutate',
  label: 'Update task',
  description: 'Change fields on an existing task. Omitted fields are left alone; null clears one.',
  input: z.object({ id: uuid, changes: TaskUpdateInput }).strict(),
  risk: 'confirm',
  async execute(ctx, input: { id: string; changes: z.infer<typeof TaskUpdateInput> }) {
    const row = await updateTask(
      ctx.db, ctx.request.workspaceId, { userId: ctx.request.userId }, input.id, input.changes,
    );
    return { status: 'done', ref: { type: 'task', id: row.id }, message: `Updated “${row.title}”.` };
  },
};

const completeCap: Capability = {
  id: 'task.complete',
  module: 'tasks',
  kind: 'mutate',
  label: 'Complete task',
  description: 'Mark a task done, or reopen one. Completing does not archive it.',
  input: z.object({ id: uuid, done: z.boolean().default(true) }).strict(),
  risk: 'important',
  async execute(ctx, input: { id: string; done: boolean }) {
    const row = await setTaskDone(
      ctx.db, ctx.request.workspaceId, { userId: ctx.request.userId }, input.id, input.done,
    );
    return {
      status: 'done',
      ref: { type: 'task', id: row.id },
      message: input.done ? `Completed “${row.title}”.` : `Reopened “${row.title}”.`,
    };
  },
};

const scheduleCap: Capability = {
  id: 'task.schedule',
  module: 'tasks',
  kind: 'mutate',
  label: 'Schedule task',
  description: 'Set WHEN a task is intended to be worked on. This is not its deadline and it '
    + 'does not put anything in the calendar — use event.create for that, separately.',
  input: z.object({
    id: uuid,
    scheduledAt: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
  risk: 'confirm',
  async execute(ctx, input: { id: string; scheduledAt: string | null }) {
    const row = await scheduleTask(
      ctx.db, ctx.request.workspaceId, { userId: ctx.request.userId }, input.id, input.scheduledAt,
    );
    return {
      status: 'done',
      ref: { type: 'task', id: row.id },
      message: input.scheduledAt ? `Set time for “${row.title}”.` : `Cleared the time on “${row.title}”.`,
    };
  },
};

export const tasksModule: AiModule = {
  id: 'tasks',
  name: 'Tasks',
  entities: ['task'],
  rules: [
    'dueDate is the deadline. scheduledAt is when the user intends to do it. They are '
      + 'different facts and must never be written from one another.',
    'A task is one action. Anything needing several is a project.',
    'Setting a due date does NOT create a calendar event.',
    'bucket (today/week/month/future) is where a task sits on the board, not when it is due.',
  ],
  available: () => ({ enabled: true }),
  capabilities: [searchCap, readCap, createCap, updateCap, completeCap, scheduleCap],
};

export { BUCKETS, PRIORITIES };
