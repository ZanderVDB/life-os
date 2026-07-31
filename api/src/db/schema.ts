/**
 * Life OS v2 — PostgreSQL schema (first baseline).
 *
 * Design rules (locked, see /docs/postgres-data-model-v2.md):
 *  • ONE primary workspace per user. Personal/Business profile switching is
 *    retired; life categories are AREAS inside one workspace.
 *  • Every content row carries workspace_id — the single ownership boundary.
 *  • area_id CLASSIFIES, it never owns: deleting an Area must never delete
 *    content, so every area_id is ON DELETE SET NULL.
 *  • project_id exists now as a nullable placeholder so Projects can arrive
 *    later without reopening the task model. Projects are NOT built yet.
 *  • UUID primary keys — the legacy 7-char random ids were collision-prone.
 */
import {
  pgTable, uuid, text, boolean, integer, timestamp, date, jsonb,
  index, uniqueIndex, check,
} from 'drizzle-orm/pg-core';
import { sql, relations } from 'drizzle-orm';

/* ── users ───────────────────────────────────────────────────────────────
 * One row per human. `firebase_uid` is the ONLY Firebase-specific column —
 * everything else references users.id, so Firebase Auth can be replaced later
 * without touching the data model. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  firebaseUid: text('firebase_uid').unique(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  isOwner: boolean('is_owner').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailLower: uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
}));

/* ── workspaces ──────────────────────────────────────────────────────────
 * A body of data. The ownership boundary. v2 creates exactly one `primary`
 * per user and exposes no switcher; `shared` exists only so genuine
 * collaboration needs no schema change later. */
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('primary'),
  legacyFirestoreDocId: text('legacy_firestore_doc_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  kindCheck: check('workspaces_kind_check', sql`${t.kind} in ('primary','shared')`),
  // Exactly one live primary workspace per user.
  onePrimary: uniqueIndex('workspaces_one_primary_idx')
    .on(t.ownerUserId)
    .where(sql`${t.kind} = 'primary' and ${t.deletedAt} is null`),
}));

/* ── workspace_memberships ───────────────────────────────────────────────
 * Who may access a workspace. v2 = one `owner` row per user. */
export const workspaceMemberships = pgTable('workspace_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('owner'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueMember: uniqueIndex('workspace_memberships_unique').on(t.workspaceId, t.userId),
  byUser: index('workspace_memberships_user_idx').on(t.userId), // auth hot path
  roleCheck: check('workspace_memberships_role_check',
    sql`${t.role} in ('owner','admin','editor','viewer')`),
}));

/* ── areas ───────────────────────────────────────────────────────────────
 * WHICH PART OF LIFE an item belongs to. This is what replaces the old
 * Personal/Business profiles. Seeded with exactly Personal + Work. */
export const areas = pgTable('areas', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('slate'),
  icon: text('icon'),
  isSystem: boolean('is_system').notNull().default(false),
  position: integer('position').notNull().default(0),
  legacyId: text('legacy_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  // Unique after trim + case-fold, so "Work", "work" and "  Work " cannot coexist.
  uniqueName: uniqueIndex('areas_workspace_name_idx')
    .on(t.workspaceId, sql`lower(btrim(${t.name}))`)
    .where(sql`${t.deletedAt} is null`),
  byPosition: index('areas_workspace_position_idx').on(t.workspaceId, t.position),
  legacyMap: uniqueIndex('areas_legacy_idx').on(t.workspaceId, t.legacyId)
    .where(sql`${t.legacyId} is not null`),
}));

/* ── tasks ───────────────────────────────────────────────────────────────
 * The central object. Retired legacy fields (dailyDate, dailySince, daily,
 * task.project-meaning-Area, People links) are deliberately NOT carried over. */
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  areaId: uuid('area_id').references(() => areas.id, { onDelete: 'set null' }),
  // Placeholder for the future Project relationship. Projects are NOT built.
  projectId: uuid('project_id'),
  title: text('title').notNull(),
  notes: text('notes'),
  status: text('status').notNull().default('open'),
  bucket: text('bucket').notNull().default('today'),
  priority: text('priority').notNull().default('medium'),
  dueDate: date('due_date'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  estimatedMinutes: integer('estimated_minutes'),
  position: integer('position').notNull().default(0),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  // Import provenance. `legacyScheduledTimeRaw` preserves an unparseable
  // legacy scheduledTime string rather than silently discarding it.
  legacyId: text('legacy_id'),
  legacyScheduledTimeRaw: text('legacy_scheduled_time_raw'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusCheck: check('tasks_status_check', sql`${t.status} in ('open','done','cancelled')`),
  bucketCheck: check('tasks_bucket_check', sql`${t.bucket} in ('today','week','month','future')`),
  priorityCheck: check('tasks_priority_check',
    sql`${t.priority} in ('urgent','high','medium','low','someday')`),
  // Bucket ordering — the Today board's main query.
  bucketOrder: index('tasks_bucket_order_idx')
    .on(t.workspaceId, t.bucket, t.position)
    .where(sql`${t.archivedAt} is null`),
  byDue: index('tasks_due_idx').on(t.workspaceId, t.dueDate)
    .where(sql`${t.archivedAt} is null and ${t.status} = 'open'`),
  byCompleted: index('tasks_completed_idx').on(t.workspaceId, t.completedAt)
    .where(sql`${t.status} = 'done'`),
  byArea: index('tasks_area_idx').on(t.workspaceId, t.areaId),
  byProject: index('tasks_project_idx').on(t.workspaceId, t.projectId),
  legacyMap: uniqueIndex('tasks_legacy_idx').on(t.workspaceId, t.legacyId)
    .where(sql`${t.legacyId} is not null`),
}));

/* ── task_steps ──────────────────────────────────────────────────────────
 * Subtasks. Unlike the legacy model these are individually addressable and
 * renameable. */
export const taskSteps = pgTable('task_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byTask: index('task_steps_task_position_idx').on(t.taskId, t.position),
  byWorkspace: index('task_steps_workspace_idx').on(t.workspaceId),
}));

/* ── task_activity ───────────────────────────────────────────────────────
 * What happened to a task. An event log, not row versioning. */
export const taskActivity = pgTable('task_activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  actorType: text('actor_type').notNull().default('user'),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  changes: jsonb('changes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byTask: index('task_activity_task_idx').on(t.taskId, t.createdAt),
  byWorkspace: index('task_activity_workspace_idx').on(t.workspaceId, t.createdAt),
  actorCheck: check('task_activity_actor_check',
    sql`${t.actorType} in ('user','ai','system','import')`),
}));

/* ── user_preferences ────────────────────────────────────────────────────
 * Key/value so a new setting never needs a migration. `scope` decides whether
 * a preference follows the user, the workspace, or stays on one device —
 * fixing the legacy split where theme and notifications never synced. */
export const userPreferences = pgTable('user_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  deviceId: text('device_id'),
  scope: text('scope').notNull().default('user'),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniquePref: uniqueIndex('user_preferences_unique').on(
    sql`coalesce(${t.userId}::text,'')`,
    sql`coalesce(${t.workspaceId}::text,'')`,
    sql`coalesce(${t.deviceId},'')`,
    t.key,
  ),
  scopeCheck: check('user_preferences_scope_check',
    sql`${t.scope} in ('user','workspace','device')`),
}));

/* ── migration_runs ──────────────────────────────────────────────────────
 * Makes the legacy import idempotent, restartable and auditable. */
export const migrationRuns = pgTable('migration_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  phase: text('phase').notNull(),
  step: text('step').notNull(),
  status: text('status').notNull().default('pending'),
  dryRun: boolean('dry_run').notNull().default(true),
  sourceRef: text('source_ref'),
  counts: jsonb('counts'),
  validation: jsonb('validation'),
  error: jsonb('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => ({
  byWorkspace: index('migration_runs_workspace_idx').on(t.workspaceId, t.step, t.status),
  statusCheck: check('migration_runs_status_check',
    sql`${t.status} in ('pending','running','succeeded','failed','rolled_back')`),
}));

/* ── relations ───────────────────────────────────────────────────────── */
export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(workspaceMemberships),
  ownedWorkspaces: many(workspaces),
}));
export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  owner: one(users, { fields: [workspaces.ownerUserId], references: [users.id] }),
  memberships: many(workspaceMemberships),
  areas: many(areas),
  tasks: many(tasks),
}));
export const areasRelations = relations(areas, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [areas.workspaceId], references: [workspaces.id] }),
  tasks: many(tasks),
}));
export const tasksRelations = relations(tasks, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [tasks.workspaceId], references: [workspaces.id] }),
  area: one(areas, { fields: [tasks.areaId], references: [areas.id] }),
  steps: many(taskSteps),
  activity: many(taskActivity),
}));
export const taskStepsRelations = relations(taskSteps, ({ one }) => ({
  task: one(tasks, { fields: [taskSteps.taskId], references: [tasks.id] }),
}));

export const BUCKETS = ['today', 'week', 'month', 'future'] as const;
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'someday'] as const;
export const STATUSES = ['open', 'done', 'cancelled'] as const;
export type Bucket = (typeof BUCKETS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Status = (typeof STATUSES)[number];
