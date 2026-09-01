/**
 * Tasks, as the assistant sees them.
 *
 * Every mutation here is three lines that call `lib/actions/tasks.ts`. That is
 * the correct size for an adapter: if it grows a rule, the rule has escaped
 * the domain and now applies to the assistant and not to the person using the
 * app.
 */
import { and, asc, desc, eq, ilike, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { tasks, taskSteps, projects, BUCKETS, PRIORITIES } from '../../db/schema.js';
import {
  createTask, updateTask, setTaskDone, scheduleTask, archiveTask, moveTask,
  addStep, updateStep, removeStep,
  TaskCreateInput, TaskUpdateInput, StepAddInput, StepUpdateInput, TaskMoveInput,
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
      /* `inArray`, not a raw `= any(...)`: the raw form binds a JS array in a
         way PGlite rejects, and the throw was being swallowed by the context
         engine's per-capability catch — so task search silently returned
         nothing for every task that belonged to a project. */
      for (const p of await ctx.db.select({ id: projects.id, title: projects.title })
        .from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, ids)))) {
        titles.set(p.id, p.title);
      }
    }
    return rows.map((r) => source(r, r.projectId ? titles.get(r.projectId) : null));
  },
};

/**
 * The board, without a search term.
 *
 * "What is on my Today board?" contains no word that appears in any title, so
 * every search returned nothing and the assistant answered "I cannot see your
 * Today board" — about the most ordinary question a command centre gets.
 * Search answers "which of these is X"; this answers "what is there", and they
 * are not the same question.
 *
 * It accepts an EMPTY input on purpose. That is what makes it reachable from
 * the context engine's broad pass, which is where a request with no usable
 * search term ends up.
 */
const listCap: Capability = {
  id: 'task.list',
  module: 'tasks',
  kind: 'read',
  label: 'The board',
  description: 'The open tasks, newest board first. With no arguments this is what the user '
    + 'would see on Today, This week, This month and Future. Use it for "what is on today", '
    + '"what is due", "what am I working on" - anything that names no particular task.',
  input: z.object({
    bucket: z.enum(BUCKETS).optional(),
    includeCompleted: z.boolean().default(false),
    limit: z.number().int().min(1).max(60).default(30),
  }).strict(),
  risk: 'safe',
  async run(ctx: CapabilityCtx, input: { bucket?: string; includeCompleted: boolean; limit: number }) {
    const ws = ctx.request.workspaceId;
    const rows = await ctx.db.select().from(tasks).where(and(
      eq(tasks.workspaceId, ws),
      isNull(tasks.archivedAt),
      ...(input.bucket ? [eq(tasks.bucket, input.bucket)] : []),
      ...(input.includeCompleted ? [] : [eq(tasks.status, 'open')]),
    )).orderBy(asc(tasks.position)).limit(input.limit);
    if (!rows.length) return [];
    const titles = new Map<string, string>();
    const ids = [...new Set(rows.map((r) => r.projectId).filter(Boolean))] as string[];
    if (ids.length) {
      for (const p of await ctx.db.select({ id: projects.id, title: projects.title })
        .from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, ids)))) {
        titles.set(p.id, p.title);
      }
    }
    return rows.map((r) => {
      const src = source(r, r.projectId ? titles.get(r.projectId) : null);
      /* The bucket is part of the answer here in a way it is not in a search
         result: "what is on today" is a question ABOUT the bucket. */
      return { ...src, summary: [r.bucket, src.summary].filter(Boolean).join(' · ') };
    });
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
    if (!row) return [];
    /* Steps come with the task, with their ids. Without them a request to
       tick "the second step" has no id to name and the plan cannot be made. */
    const steps = await ctx.db.select().from(taskSteps)
      .where(eq(taskSteps.taskId, row.id)).orderBy(asc(taskSteps.position));
    const s = source(row, null, 1);
    return [{
      ...s,
      data: {
        ...s.data,
        steps: steps.map((x) => ({ id: x.id, title: x.title, completed: x.completed })),
      },
    }];
  },
};

const createCap: Capability = {
  id: 'task.create',
  module: 'tasks',
  kind: 'mutate',
  label: 'Create task',
  description: 'Create one task. Set dueDate ONLY when the request says it must be FINISHED '
    + 'by then, and scheduledAt ONLY when it says when they intend to DO it. If the request '
    + 'says neither, set neither and ask which is meant. Creating a task never creates a '
    + 'calendar event.',
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

const archiveCap: Capability = {
  id: 'task.archive',
  module: 'tasks',
  kind: 'mutate',
  label: 'Archive task',
  description: 'Take a task off the board, keeping its history. This is what "get rid of it" '
    + 'usually means and it can be undone; there is no delete.',
  input: z.object({ id: uuid }).strict(),
  risk: 'important',
  async execute(ctx, input: { id: string }) {
    const row = await archiveTask(
      ctx.db, ctx.request.workspaceId, { userId: ctx.request.userId }, input.id,
    );
    return {
      status: 'done' as const,
      ref: { type: 'task' as const, id: row.id },
      message: `Archived "${row.title}".`,
    };
  },
};

const moveCap: Capability = {
  id: 'task.move',
  module: 'tasks',
  kind: 'mutate',
  label: 'Move task',
  description: 'Move a task between Today, This week, This month and Future. A bucket is where '
    + 'a task sits on the board - it is NOT a due date and NOT a scheduled time.',
  input: TaskMoveInput,
  risk: 'confirm',
  async execute(ctx, input) {
    const row = await moveTask(
      ctx.db, ctx.request.workspaceId, { userId: ctx.request.userId }, input as any,
    );
    return {
      status: 'done' as const,
      ref: { type: 'task' as const, id: row.id },
      message: `Moved "${row.title}".`,
    };
  },
};

const addStepCap: Capability = {
  id: 'task.addStep',
  module: 'tasks',
  kind: 'mutate',
  label: 'Add a step',
  description: 'Add a sub-item to a task. Steps are strictly sequential, so a new one goes at '
    + 'the end.',
  input: StepAddInput,
  risk: 'confirm',
  async execute(ctx, input) {
    const row = await addStep(ctx.db, ctx.request.workspaceId, input as any);
    return {
      status: 'done' as const,
      ref: { type: 'task' as const, id: row.taskId },
      message: `Added step "${row.title}".`,
    };
  },
};

const updateStepCap: Capability = {
  id: 'task.updateStep',
  module: 'tasks',
  kind: 'mutate',
  label: 'Change a step',
  description: 'Rename a step or mark it done. Needs the step id, which comes from reading the '
    + 'task.',
  input: StepUpdateInput,
  risk: 'confirm',
  async execute(ctx, input) {
    const row = await updateStep(ctx.db, ctx.request.workspaceId, input as any);
    return {
      status: 'done' as const,
      ref: { type: 'task' as const, id: row.taskId },
      message: row.completed ? `Step done: "${row.title}".` : `Updated step "${row.title}".`,
    };
  },
};

const removeStepCap: Capability = {
  id: 'task.removeStep',
  module: 'tasks',
  kind: 'mutate',
  label: 'Remove a step',
  description: 'Delete a step from a task. A step has no history, so this really removes it.',
  input: z.object({ stepId: uuid }).strict(),
  risk: 'important',
  async execute(ctx, input: { stepId: string }) {
    const row = await removeStep(ctx.db, ctx.request.workspaceId, input.stepId);
    return {
      status: 'done' as const,
      ref: { type: 'task' as const, id: row.taskId },
      message: `Removed step "${row.title}".`,
    };
  },
};

export const tasksModule: AiModule = {
  id: 'tasks',
  name: 'Tasks',
  entities: ['task'],
  rules: [
    'dueDate is the deadline - when it must be FINISHED. scheduledAt is when the user '
      + 'intends to DO it. They are different facts and must never be written from one '
      + 'another, nor chosen between on the user\u2019s behalf when the request says neither.',
    'A date with no wording saying which it is - "I need a haircut Saturday" - is ambiguous. '
      + 'Ask which is meant; a wrong deadline nags early and a wrong plan goes silently past.',
    'A task is one action. Anything needing several is a project.',
    'Setting a due date does NOT create a calendar event.',
    'bucket (today/week/month/future) is where a task sits on the board, not when it is due.',
    'Archiving takes a task off the board and keeps it. There is no delete, because "get rid '
      + 'of it" almost always means the reversible one.',
    'Steps are strictly sequential. To change one you need its id, which comes from task.read.',
  ],
  available: () => ({ enabled: true }),
  capabilities: [
    searchCap, listCap, readCap, createCap, updateCap, completeCap, scheduleCap,
    archiveCap, moveCap, addStepCap, updateStepCap, removeStepCap,
  ],
};

export { BUCKETS, PRIORITIES };
