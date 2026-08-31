/**
 * Projects, as the assistant sees them.
 *
 * The distinction this module exists to defend: `status` is where the work IS,
 * `focus` is how loudly it should ASK, and they are independent. Legacy
 * collapsed them and recomputed the result from recency, which silently
 * overwrote what the user had chosen. The rule is stated to the planner and
 * enforced by the service underneath.
 */
import { and, desc, eq, ilike } from 'drizzle-orm';
import { z } from 'zod';
import { projects, tasks } from '../../db/schema.js';
import { updateProject, ProjectUpdateInput } from '../../lib/actions/projects.js';
import type { AiModule } from '../registry.js';
import type { ContextSource } from '../types.js';

const uuid = z.string().uuid();

const source = (row: typeof projects.$inferSelect, level: 1 | 2 | 3 = 2): ContextSource => ({
  ref: { type: 'project', id: row.id },
  module: 'projects',
  title: row.title,
  summary: row.outcome,
  data: {
    /* Both, separately, always. A planner handed one merged "state" field will
       cheerfully quieten a project because it looks stale. */
    status: row.status,
    focus: row.focus,
    outcome: row.outcome,
    targetDate: row.targetDate,
    areaId: row.areaId,
    archived: Boolean(row.archivedAt),
  },
  via: 'direct',
  level,
});

export const projectsModule: AiModule = {
  id: 'projects',
  name: 'Projects',
  entities: ['project'],
  rules: [
    'status (planning/active/on_hold/completed) and focus (now/upcoming/someday) are '
      + 'INDEPENDENT. A project can be genuinely active and deliberately quiet. Never derive '
      + 'one from the other, and never derive either from how recently it was touched.',
    'Archive is an overlay, not a status: archivedAt plus preArchiveStatus, so restoring does '
      + 'not have to guess.',
    'Completing a project is not a field change - it has to ask about open tasks - so it is '
      + 'not offered here.',
    'Creating a project is not offered: there is no application service for it yet.',
  ],
  available: () => ({ enabled: true }),
  capabilities: [
    {
      id: 'project.search',
      module: 'projects',
      kind: 'search',
      label: 'Find projects',
      description: 'Find projects by words in their title. Returns status and focus separately.',
      input: z.object({
        query: z.string().trim().min(2).max(200),
        limit: z.number().int().min(1).max(25).default(10),
      }).strict(),
      risk: 'safe',
      async run(ctx, input: { query: string; limit: number }) {
        const rows = await ctx.db.select().from(projects).where(and(
          eq(projects.workspaceId, ctx.request.workspaceId),
          ilike(projects.title, `%${input.query}%`),
        )).orderBy(desc(projects.updatedAt)).limit(input.limit);
        return rows.map((r) => source(r));
      },
    },
    {
      id: 'project.read',
      module: 'projects',
      kind: 'read',
      label: 'Read a project',
      description: 'Load one project with its open tasks.',
      input: z.object({ id: uuid }).strict(),
      risk: 'safe',
      async run(ctx, input: { id: string }) {
        const ws = ctx.request.workspaceId;
        const [row] = await ctx.db.select().from(projects)
          .where(and(eq(projects.workspaceId, ws), eq(projects.id, input.id))).limit(1);
        if (!row) return [];
        const list = await ctx.db.select().from(tasks)
          .where(and(eq(tasks.workspaceId, ws), eq(tasks.projectId, input.id)));
        const out: ContextSource[] = [source(row, 1)];
        /* Its tasks arrive as STRUCTURAL neighbours, not as search hits. The
           path is recorded so an answer can say how it got here. */
        for (const t of list.filter((x) => x.status === 'open').slice(0, 20)) {
          out.push({
            ref: { type: 'task', id: t.id },
            module: 'tasks',
            title: t.title,
            summary: `in ${row.title}`,
            data: { status: t.status, dueDate: t.dueDate, scheduledAt: t.scheduledAt },
            via: 'relationship',
            path: [{ from: { type: 'project', id: row.id }, kind: 'structural', label: 'Task of' }],
            level: 2,
          });
        }
        return out;
      },
    },
    {
      id: 'project.update',
      module: 'projects',
      kind: 'mutate',
      label: 'Update project',
      description: 'Change a title, outcome, notes, target date, status or focus. status and '
        + 'focus are independent - set only the one that was actually asked for. Cannot complete '
        + 'a project.',
      input: z.object({ id: uuid, changes: ProjectUpdateInput }).strict(),
      risk: 'important',
      async execute(ctx, input: { id: string; changes: z.infer<typeof ProjectUpdateInput> }) {
        const row = await updateProject(ctx.db, ctx.request.workspaceId, input.id, input.changes);
        return {
          status: 'done' as const,
          ref: { type: 'project' as const, id: row.id },
          message: `Updated "${row.title}".`,
        };
      },
    },
  ],
};
