/**
 * Sample Projects for testing — TEMPORARY.
 *
 * This whole file is meant to be deleted once E2 has been reviewed. It is one
 * module and two endpoints precisely so that deleting it is one commit.
 *
 * SAFETY. D4.3 nearly deleted real reminders because synthetic rows were
 * identified by a flag that had also been set on real ones. The rule that came
 * out of it: sample data must be identifiable by something a real record could
 * never have, and cleanup must match that and nothing else.
 *
 * Here that marker is `legacy_id` beginning `sample:e2:`. Legacy ids are
 * client-generated `uid()` strings and cannot contain a colon, so a real
 * imported project can never collide. Cleanup matches the prefix exactly; it
 * never matches on title, date, or "created recently".
 *
 * Real tasks are never touched. A real task that happened to be assigned to a
 * sample project simply loses the assignment — the foreign key is
 * `on delete set null`, so the work survives intact.
 */
import { and, eq, like, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, tasks } from '../db/schema.js';

/** The one thing that identifies sample data. Nothing else is used. */
export const SAMPLE_PREFIX = 'sample:e2:';

export const isSampleAllowed = (nodeEnv: string): boolean => nodeEnv !== 'production';

const GAP = 1000;
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

type SampleTask = {
  title: string;
  status?: 'open' | 'done' | 'cancelled';
  bucket?: 'today' | 'week' | 'month' | 'future';
  priority?: 'urgent' | 'high' | 'medium' | 'low' | 'someday';
  dueDate?: string;
};
type SampleProject = {
  key: string;
  title: string;
  outcome: string;
  description?: string;
  status: 'planning' | 'active' | 'on_hold' | 'completed';
  focus: 'now' | 'upcoming' | 'someday';
  area: 'Work' | 'Personal';
  targetDate?: string;
  completedDaysAgo?: number;
  archived?: boolean;
  tasks?: SampleTask[];
};

/**
 * One project per state the overview can be in, so every group, filter, health
 * signal and progress wording is reachable without inventing data by hand.
 */
const SAMPLE: SampleProject[] = [
  {
    key: 'attention-no-next',
    title: 'WebAnchor client handover',
    outcome: 'Every client has logins, docs and a support contact',
    description: 'The last stretch of the handover. Everything written down is done; '
      + 'what remains is deciding whether anything else is owed.',
    status: 'active', focus: 'now', area: 'Work',
    // Active with nothing open → Needs attention: "No next action".
    tasks: [
      { title: 'Write the handover doc', status: 'done' },
      { title: 'Send logins to each client', status: 'done' },
      { title: 'Record the support number', status: 'done' },
    ],
  },
  {
    key: 'attention-overdue',
    title: 'TriFusion annual returns',
    outcome: 'Filed and confirmed, with nothing outstanding',
    status: 'active', focus: 'now', area: 'Work',
    // A passed target with open work → Needs attention: "Past its target date".
    targetDate: day(-9),
    tasks: [
      { title: 'Collect the invoices', status: 'done' },
      { title: 'Reconcile against the bank', bucket: 'today', priority: 'urgent', dueDate: day(-2) },
      { title: 'File the return', bucket: 'week', priority: 'high' },
    ],
  },
  {
    key: 'now-moving',
    title: 'Rage 2026 planning',
    outcome: 'Tickets booked, accommodation paid, the group confirmed',
    description: 'Everyone is in, the dates are fixed. What is left is money and logistics.',
    status: 'active', focus: 'now', area: 'Personal',
    targetDate: day(46),
    tasks: [
      { title: 'Confirm who is actually coming', status: 'done' },
      { title: 'Book the accommodation', status: 'done' },
      { title: 'Pay the deposit', bucket: 'today', priority: 'high', dueDate: day(3) },
      { title: 'Work out the travel split', bucket: 'week' },
      { title: 'Book the tickets', bucket: 'month', priority: 'medium' },
      { title: 'Look at a second venue', status: 'cancelled' },
    ],
  },
  {
    key: 'now-early',
    title: 'Life OS Projects review',
    outcome: 'The Projects section is approved and Legacy projects are migrated',
    status: 'active', focus: 'now', area: 'Work',
    tasks: [
      { title: 'Walk through the overview', bucket: 'today', priority: 'high' },
      { title: 'Check the motion on a status change', bucket: 'today' },
      { title: 'Decide on the log-into-notes question', bucket: 'week', priority: 'medium' },
    ],
  },
  {
    key: 'upcoming-planning',
    title: 'Learn how SA tax works',
    outcome: 'I can file my own return without an accountant',
    description: 'Not urgent, but it comes round every year and costs money every year.',
    // Planning with no tasks → "Nothing planned yet", and NOT flagged as
    // attention, because that is what planning is.
    status: 'planning', focus: 'upcoming', area: 'Personal',
    targetDate: day(120),
  },
  {
    key: 'upcoming-active',
    title: 'Replace the studio laptop',
    outcome: 'A machine that can run the whole stack without fans screaming',
    status: 'active', focus: 'upcoming', area: 'Work',
    tasks: [
      { title: 'Write down what it actually has to do', bucket: 'future' },
      { title: 'Price three options', bucket: 'future' },
    ],
  },
  {
    key: 'someday',
    title: 'Public speaking course',
    outcome: 'I can present to a room without reading from the slides',
    status: 'planning', focus: 'someday', area: 'Personal',
    tasks: [{ title: 'Find out what is available in Cape Town', bucket: 'future' }],
  },
  {
    key: 'on-hold',
    title: 'BergRoute rebuild',
    outcome: 'The site runs on the new stack with no manual deploys',
    description: 'Paused while the client decides on budget. Everything here is still true.',
    status: 'on_hold', focus: 'now', area: 'Work',
    // on_hold + now — the contradictory pair. Stored exactly as chosen, and
    // surfacing is suppressed by the status rather than by editing the focus.
    tasks: [
      { title: 'Migrate the content', status: 'done' },
      { title: 'Set up the deploy pipeline', bucket: 'month' },
    ],
  },
  {
    key: 'completed',
    title: 'Move the office',
    outcome: 'Everything out of the old space, deposit back',
    status: 'completed', focus: 'now', area: 'Work',
    completedDaysAgo: 11,
    tasks: [
      { title: 'Book the movers', status: 'done' },
      { title: 'Clear the storeroom', status: 'done' },
      { title: 'Final inspection', status: 'done' },
      { title: 'Chase the deposit', status: 'done' },
      { title: 'Repaint the wall', status: 'cancelled' },
    ],
  },
  {
    key: 'archived',
    title: 'Soccer app side project',
    outcome: 'A working fixture tracker for the Sunday league',
    status: 'on_hold', focus: 'someday', area: 'Personal',
    // Archived FROM on_hold — restore must bring it back to on_hold, not active.
    archived: true,
    tasks: [{ title: 'Sketch the fixture model', status: 'done' }],
  },
];

export type SampleResult = {
  projectsCreated: number;
  tasksCreated: number;
  alreadyPresent: number;
};

/**
 * Creates the sample set. Idempotent: every row carries a stable
 * `sample:e2:<key>` id, so running it twice adds nothing.
 */
export async function seedSampleProjects(
  db: Db, workspaceId: string, areaByName: Map<string, string>,
): Promise<SampleResult> {
  const existing = await db.select({ legacyId: projects.legacyId }).from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), like(projects.legacyId, `${SAMPLE_PREFIX}%`)));
  const have = new Set(existing.map((r) => r.legacyId));

  const posRow = await db.select({ max: sql<number>`coalesce(max(${projects.position}), 0)` })
    .from(projects).where(eq(projects.workspaceId, workspaceId));
  let position = Number(posRow[0]?.max ?? 0);

  const taskPosRow = await db.select({ max: sql<number>`coalesce(max(${tasks.position}), 0)` })
    .from(tasks).where(eq(tasks.workspaceId, workspaceId));
  let taskPosition = Number(taskPosRow[0]?.max ?? 0);

  let projectsCreated = 0;
  let tasksCreated = 0;
  let alreadyPresent = 0;

  for (const s of SAMPLE) {
    const legacyId = `${SAMPLE_PREFIX}${s.key}`;
    if (have.has(legacyId)) { alreadyPresent++; continue; }
    const areaId = areaByName.get(s.area) ?? null;
    position += GAP;

    const completedAt = s.completedDaysAgo != null
      ? new Date(Date.now() - s.completedDaysAgo * 86400000) : null;

    const [project] = await db.insert(projects).values({
      workspaceId,
      areaId,
      title: s.title,
      outcome: s.outcome,
      description: s.description ?? null,
      status: s.status,
      focus: s.focus,
      targetDate: s.targetDate ?? null,
      position,
      completedAt,
      // Archive is an overlay: keep the lifecycle status and remember it.
      archivedAt: s.archived ? new Date() : null,
      preArchiveStatus: s.archived ? s.status : null,
      legacyId,
    }).returning();
    projectsCreated++;

    for (const t of s.tasks ?? []) {
      taskPosition += GAP;
      await db.insert(tasks).values({
        workspaceId,
        projectId: project!.id,
        areaId,
        title: t.title,
        status: t.status ?? 'open',
        bucket: t.bucket ?? 'future',
        priority: t.priority ?? 'medium',
        dueDate: t.dueDate ?? null,
        position: taskPosition,
        completedAt: t.status === 'done' ? new Date() : null,
        // The same marker, so cleanup can find them without guessing.
        legacyId: `${SAMPLE_PREFIX}${s.key}:${tasksCreated}`,
      });
      tasksCreated++;
    }
  }
  return { projectsCreated, tasksCreated, alreadyPresent };
}

/** What cleanup would remove. Counts only — run it before deleting anything. */
export async function sampleFootprint(db: Db, workspaceId: string) {
  const p = await db.select({ id: projects.id, title: projects.title }).from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), like(projects.legacyId, `${SAMPLE_PREFIX}%`)));
  const t = await db.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), like(tasks.legacyId, `${SAMPLE_PREFIX}%`)));
  return { projects: p.length, tasks: t.length, titles: p.map((x) => x.title) };
}

/**
 * Removes the sample set and nothing else.
 *
 * Matches ONLY on the `sample:e2:` prefix. Never on title, never on date,
 * never on "recently created". A real task that was assigned to a sample
 * project keeps everything and simply loses the assignment, because the foreign
 * key is `on delete set null`.
 */
export async function removeSampleProjects(db: Db, workspaceId: string) {
  const deletedTasks = await db.delete(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), like(tasks.legacyId, `${SAMPLE_PREFIX}%`)))
    .returning({ id: tasks.id });
  const deletedProjects = await db.delete(projects)
    .where(and(eq(projects.workspaceId, workspaceId), like(projects.legacyId, `${SAMPLE_PREFIX}%`)))
    .returning({ id: projects.id });
  return { projects: deletedProjects.length, tasks: deletedTasks.length };
}
