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
  /* The local calendar date Today was last automatically arranged for.
   *
   * A `date`, not a timestamp: the rule is "once per local calendar day" and
   * the local day belongs to the client. Storing an instant would mean
   * re-deriving a date from it in a timezone the server does not reliably
   * know. Claiming it is a conditional UPDATE, which is what makes two tabs
   * safe — see the arrange-claim route. */
  lastTodayArrangedOn: date('last_today_arranged_on'),
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
  // E2: a real relationship. `on delete set null` — deleting a Project must
  // never delete work; the task keeps its area, bucket, dates and steps and
  // simply stops belonging to a project.
  projectId: uuid('project_id').references((): any => projects.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  notes: text('notes'),
  status: text('status').notNull().default('open'),
  bucket: text('bucket').notNull().default('today'),
  priority: text('priority').notNull().default('medium'),
  dueDate: date('due_date'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  estimatedMinutes: integer('estimated_minutes'),
  position: integer('position').notNull().default(0),
  /* Order INSIDE a project — a separate ordering from `position`, which orders
   * the task within its Today bucket. One column for both would mean dragging
   * a task in a project silently reshuffled the Today board. */
  projectPosition: integer('project_position').notNull().default(0),
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
  // Every Project query asks for open tasks in order. Partial, because most
  // tasks belong to no project.
  byProjectOpen: index('tasks_project_open_idx').on(t.projectId, t.status, t.position)
    .where(sql`${t.projectId} is not null`),
  byProjectOrder: index('tasks_project_order_idx')
    .on(t.projectId, t.status, t.projectPosition)
    .where(sql`${t.projectId} is not null`),
  legacyMap: uniqueIndex('tasks_legacy_idx').on(t.workspaceId, t.legacyId)
    .where(sql`${t.legacyId} is not null`),
}));

/* ── projects ────────────────────────────────────────────────────────────
 * A finite outcome that needs more than one action, and enough context that
 * you would lose the thread without somewhere to keep it.
 *
 * TWO INDEPENDENT DIMENSIONS, and keeping them independent is the whole point:
 *
 *   status — where the work IS       (planning / active / on_hold / completed)
 *   focus  — how loudly it should ASK (now / upcoming / someday)
 *
 * Legacy collapsed these into one field and then recomputed it from recency,
 * so the user's chosen state was overwritten by how recently they had opened
 * it. A project can be genuinely Active and deliberately quiet; a project can
 * be Planning and the next thing you intend to start.
 *
 * ARCHIVE IS NOT A STATUS. It is an overlay: `archived_at` plus the status to
 * return to. A completed project and an abandoned project must not read the
 * same, and restore must not guess. */
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  areaId: uuid('area_id').references(() => areas.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  /* Nullable at the database level ONLY so the Legacy migration can land rows
   * it cannot invent an outcome for. The API requires it on every new project:
   * it is the field that makes a Project a Project. */
  outcome: text('outcome'),
  description: text('description'),
  notes: text('notes'),
  status: text('status').notNull().default('planning'),
  focus: text('focus').notNull().default('upcoming'),
  targetDate: date('target_date'),
  /* Explicit next action. Cleared automatically when it stops being valid —
   * see nextActionFor(). */
  nextTaskId: uuid('next_task_id').references((): any => tasks.id, { onDelete: 'set null' }),
  position: integer('position').notNull().default(0),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  preArchiveStatus: text('pre_archive_status'),
  legacyId: text('legacy_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusCheck: check('projects_status_check',
    sql`${t.status} in ('planning','active','on_hold','completed')`),
  focusCheck: check('projects_focus_check',
    sql`${t.focus} in ('now','upcoming','someday')`),
  preArchiveCheck: check('projects_pre_archive_status_check',
    sql`${t.preArchiveStatus} is null or ${t.preArchiveStatus} in ('planning','active','on_hold','completed')`),
  // An archived project must remember where to go back to.
  archivePairCheck: check('projects_archive_pair_check',
    sql`(${t.archivedAt} is null and ${t.preArchiveStatus} is null)
        or (${t.archivedAt} is not null and ${t.preArchiveStatus} is not null)`),
  byStatus: index('projects_ws_status_idx').on(t.workspaceId, t.status, t.position),
  byFocus: index('projects_ws_focus_idx').on(t.workspaceId, t.focus, t.position),
  live: index('projects_live_idx').on(t.workspaceId, t.position)
    .where(sql`${t.archivedAt} is null`),
  byArea: index('projects_area_idx').on(t.workspaceId, t.areaId),
  legacyMap: uniqueIndex('projects_legacy_idx').on(t.workspaceId, t.legacyId)
    .where(sql`${t.legacyId} is not null`),
}));

export const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed'] as const;
export const PROJECT_FOCUSES = ['now', 'upcoming', 'someday'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectFocus = (typeof PROJECT_FOCUSES)[number];

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
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  steps: many(taskSteps),
  activity: many(taskActivity),
}));
export const projectsRelations = relations(projects, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [projects.workspaceId], references: [workspaces.id] }),
  area: one(areas, { fields: [projects.areaId], references: [areas.id] }),
  tasks: many(tasks),
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

/* ── habits ──────────────────────────────────────────────────────────────
 * A habit is a recurring intention, NOT a task. Keeping them in separate
 * tables is deliberate: the legacy app blurred habits into `routineLog`
 * alongside diary journal text, which made it impossible to reason about
 * either one. Here a habit has a schedule and a completion history; a diary
 * entry is writing. They never share a row.
 */
export const habits = pgTable('habits', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  // Classifies only — losing an Area must never lose the habit.
  areaId: uuid('area_id').references(() => areas.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  /** daily | weekly | specific_days | times_per_week */
  frequencyType: text('frequency_type').notNull().default('daily'),
  /** Shape depends on frequencyType, e.g. { days: [1,3,5] } for specific_days. */
  frequencyConfig: jsonb('frequency_config'),
  /** How many completions make a day "done". 1 for a simple yes/no habit. */
  targetCount: integer('target_count').notNull().default(1),
  color: text('color').notNull().default('sage'),
  position: integer('position').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  legacyId: text('legacy_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => ({
  byWorkspace: index('habits_workspace_position_idx').on(t.workspaceId, t.position),
  byActive: index('habits_active_idx').on(t.workspaceId, t.isActive),
  legacyUnique: uniqueIndex('habits_legacy_idx').on(t.workspaceId, t.legacyId)
    .where(sql`${t.legacyId} is not null`),
  freqCheck: check('habits_frequency_check',
    sql`${t.frequencyType} in ('daily','weekly','specific_days','times_per_week')`),
  targetCheck: check('habits_target_check', sql`${t.targetCount} >= 1`),
}));

export const habitEntries = pgTable('habit_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  habitId: uuid('habit_id').notNull().references(() => habits.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  /** The DAY this counts for, in the user's own reckoning — a date, not a timestamp. */
  entryDate: date('entry_date').notNull(),
  completedCount: integer('completed_count').notNull().default(1),
  /** When it was actually ticked. Null for imported history with no timestamp. */
  completedAt: timestamp('completed_at', { withTimezone: true }),
  /** user | import | system — provenance, so imported history is never mistaken for a live tick. */
  source: text('source').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // One row per habit per day. Ticking twice updates the count; it never
  // creates a second row, which is what makes the import idempotent.
  uniquePerDay: uniqueIndex('habit_entries_unique_day').on(t.habitId, t.entryDate),
  byWorkspaceDate: index('habit_entries_workspace_date_idx').on(t.workspaceId, t.entryDate),
  countCheck: check('habit_entries_count_check', sql`${t.completedCount} >= 0`),
  sourceCheck: check('habit_entries_source_check', sql`${t.source} in ('user','import','system')`),
}));

export const habitsRelations = relations(habits, ({ many, one }) => ({
  entries: many(habitEntries),
  area: one(areas, { fields: [habits.areaId], references: [areas.id] }),
}));
export const habitEntriesRelations = relations(habitEntries, ({ one }) => ({
  habit: one(habits, { fields: [habitEntries.habitId], references: [habits.id] }),
}));

export const FREQUENCY_TYPES = ['daily', 'weekly', 'specific_days', 'times_per_week'] as const;
export const ENTRY_SOURCES = ['user', 'import', 'system'] as const;
export type FrequencyType = (typeof FREQUENCY_TYPES)[number];

/* ═══════════════════════════════════════════════════════════════════════
   CALENDAR (Phase D2) — see /docs/calendar-v2-data-model.md

   Kept in this file rather than its own module because drizzle-kit bundles as
   CJS and cannot resolve the ESM './schema-calendar.js' specifier; habits are
   inline here for the same reason.

   Design rules, locked in /docs/calendar-v2-product-model.md:
    • Events, Reminders, Tasks and Habits are DIFFERENT THINGS. Reminders and
      task blocks are Life OS records in their own tables. They never
      masquerade as Google events, and are never pushed to Google as events
      merely to make them appear on a calendar canvas.
    • Google is authoritative for EVENTS only. Every column mirroring a Google
      field is named after it, so a reader can tell at a glance what
      round-trips and what does not.
    • Life OS-only relationships live in calendar_item_links, never overloaded
      onto a Google event field.
    • OAuth tokens are NEVER stored here. The token columns hold references
      into encrypted storage plus non-secret metadata.
   ═══════════════════════════════════════════════════════════════════════ */

export const CALENDAR_PROVIDERS = ['google', 'synthetic'] as const;
export const CONNECTION_STATUSES = ['active', 'needs_reauth', 'revoked', 'error'] as const;
export const ACCESS_ROLES = ['owner', 'writer', 'reader', 'freeBusyReader'] as const;
export const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;
export const TRANSPARENCY = ['opaque', 'transparent'] as const;   // busy | free
export const VISIBILITY = ['default', 'public', 'private', 'confidential'] as const;
export const SYNC_STATES = ['synced', 'pending_push', 'push_failed', 'local_only'] as const;
export const ATTENDEE_RESPONSES = ['needsAction', 'declined', 'tentative', 'accepted'] as const;
export const REMINDER_STATUSES = ['open', 'done', 'dismissed'] as const;
export const LINK_KINDS = [
  'preparation', 'follow_up', 'scheduled_block', 'project', 'library', 'diary',
] as const;

const EMPTY_JSON_ARRAY = sql`'[]'::jsonb`;

/* ── calendar_connections ────────────────────────────────────────────────
 * One row per connected provider account. `accessTokenRef`/`refreshTokenRef`
 * are POINTERS into encrypted storage, never the tokens themselves — a token
 * must never be readable from a database dump or a log line. */
export const calendarConnections = pgTable('calendar_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('google'),
  providerAccountId: text('provider_account_id').notNull(),
  accountEmail: text('account_email'),
  status: text('status').notNull().default('active'),
  // Encrypted-store references, plus the scopes actually GRANTED — which can
  // be narrower than the scopes requested. Write paths must check these
  // rather than assuming the request succeeded in full.
  accessTokenRef: text('access_token_ref'),
  refreshTokenRef: text('refresh_token_ref'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  grantedScopes: jsonb('granted_scopes').$type<string[]>().notNull().default(EMPTY_JSON_ARRAY),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastError: text('last_error'),
  disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWorkspace: index('cal_conn_ws_idx').on(t.workspaceId),
  uniqueAccount: uniqueIndex('cal_conn_account_idx')
    .on(t.workspaceId, t.provider, t.providerAccountId),
  statusCheck: check('cal_conn_status',
    sql`${t.status} IN ('active','needs_reauth','revoked','error')`),
}));

/* ── calendars ───────────────────────────────────────────────────────────
 * A calendar the connection can see. `accessRole` is Google's, and it decides
 * whether Life OS may offer editing at all — never assume write access. */
export const calendars = pgTable('calendars', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id')
    .references(() => calendarConnections.id, { onDelete: 'cascade' }),
  providerCalendarId: text('provider_calendar_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color'),
  timeZone: text('time_zone'),
  accessRole: text('access_role').notNull().default('reader'),
  isPrimary: boolean('is_primary').notNull().default(false),
  isVisible: boolean('is_visible').notNull().default(true),
  // Derived from accessRole and stored, so the UI never re-derives it and
  // never accidentally offers an edit control on a read-only calendar.
  isReadOnly: boolean('is_read_only').notNull().default(true),
  isSynthetic: boolean('is_synthetic').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWorkspace: index('calendars_ws_idx').on(t.workspaceId),
  uniquePerWorkspace: uniqueIndex('calendars_provider_idx')
    .on(t.workspaceId, t.providerCalendarId),
  roleCheck: check('calendars_role',
    sql`${t.accessRole} IN ('owner','writer','reader','freeBusyReader')`),
}));

/* ── calendar_sync_states ────────────────────────────────────────────────
 * One row per calendar. The sync token is the whole point: Google returns it
 * after a full sync and it makes every later sync incremental.
 *
 * When Google invalidates it (410 GONE), `tokenInvalidatedAt` is stamped and a
 * controlled FULL resync runs for that calendar only. Never a guess at what
 * changed in between, and never a delete of Life OS-only data. */
export const calendarSyncStates = pgTable('calendar_sync_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  calendarId: uuid('calendar_id').notNull()
    .references(() => calendars.id, { onDelete: 'cascade' }),
  syncToken: text('sync_token'),
  nextPageToken: text('next_page_token'),
  fullSyncCompletedAt: timestamp('full_sync_completed_at', { withTimezone: true }),
  lastIncrementalAt: timestamp('last_incremental_at', { withTimezone: true }),
  tokenInvalidatedAt: timestamp('token_invalidated_at', { withTimezone: true }),
  isSyncing: boolean('is_syncing').notNull().default(false),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniquePerCalendar: uniqueIndex('cal_sync_calendar_idx').on(t.calendarId),
  byWorkspace: index('cal_sync_ws_idx').on(t.workspaceId),
}));

/* ── calendar_events ─────────────────────────────────────────────────────
 * Mirrors a Google event. The identity columns matter more than they look:
 *
 *   providerEventId   — the id to write back to
 *   icalUid           — stable across copies of an invitation
 *   recurringEventId  — the SERIES this instance belongs to
 *   originalStartTime — which occurrence an exception replaces
 *   etag + sequence   — optimistic concurrency, so a stale write is rejected
 *
 * Without all five, editing one occurrence of a recurring event corrupts the
 * series. That is the failure mode this table is shaped against. */
export const calendarEvents = pgTable('calendar_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  calendarId: uuid('calendar_id').notNull()
    .references(() => calendars.id, { onDelete: 'cascade' }),

  providerEventId: text('provider_event_id'),
  icalUid: text('ical_uid'),
  recurringEventId: text('recurring_event_id'),
  originalStartTime: timestamp('original_start_time', { withTimezone: true }),

  title: text('title'),
  description: text('description'),
  location: text('location'),

  isAllDay: boolean('is_all_day').notNull().default(false),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  // An all-day event is a DATE, not an instant — storing it only as a
  // timestamp shifts it across time zones. Both forms are kept, and the
  // all-day flag says which one is authoritative.
  startDate: date('start_date'),
  endDate: date('end_date'),
  timeZone: text('time_zone'),

  recurrence: jsonb('recurrence').$type<string[]>(),
  status: text('status').notNull().default('confirmed'),
  transparency: text('transparency').notNull().default('opaque'),
  visibility: text('visibility').notNull().default('default'),
  providerColorId: text('provider_color_id'),
  eventType: text('event_type'),
  conferenceData: jsonb('conference_data'),
  hangoutLink: text('hangout_link'),
  organizerEmail: text('organizer_email'),
  organizerName: text('organizer_name'),
  providerHtmlLink: text('provider_html_link'),
  sourceUrl: text('source_url'),

  etag: text('etag'),
  sequence: integer('sequence').notNull().default(0),
  providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }),
  providerUpdatedAt: timestamp('provider_updated_at', { withTimezone: true }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  syncState: text('sync_state').notNull().default('local_only'),
  isSynthetic: boolean('is_synthetic').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWorkspace: index('cal_events_ws_idx').on(t.workspaceId),
  byRange: index('cal_events_range_idx').on(t.workspaceId, t.startsAt, t.endsAt),
  byCalendar: index('cal_events_calendar_idx').on(t.calendarId),
  bySeries: index('cal_events_series_idx').on(t.workspaceId, t.recurringEventId),
  // Idempotent upserts depend on this: a re-delivered change must UPDATE the
  // same row rather than insert a duplicate. Partial, because synthetic and
  // local-only events legitimately have no provider id.
  uniqueProviderEvent: uniqueIndex('cal_events_provider_idx')
    .on(t.calendarId, t.providerEventId)
    .where(sql`${t.providerEventId} IS NOT NULL`),
  statusCheck: check('cal_events_status',
    sql`${t.status} IN ('confirmed','tentative','cancelled')`),
  transparencyCheck: check('cal_events_transparency',
    sql`${t.transparency} IN ('opaque','transparent')`),
  syncStateCheck: check('cal_events_sync_state',
    sql`${t.syncState} IN ('synced','pending_push','push_failed','local_only')`),
}));

/* ── calendar_event_attendees ────────────────────────────────────────────
 * `responseStatus` is READ-ONLY from Life OS in this phase: changing another
 * person's RSVP is not ours to do. */
export const calendarEventAttendees = pgTable('calendar_event_attendees', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id').notNull()
    .references(() => calendarEvents.id, { onDelete: 'cascade' }),
  email: text('email'),
  displayName: text('display_name'),
  responseStatus: text('response_status').notNull().default('needsAction'),
  isOptional: boolean('is_optional').notNull().default(false),
  isOrganizer: boolean('is_organizer').notNull().default(false),
  isSelf: boolean('is_self').notNull().default(false),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byEvent: index('cal_attendees_event_idx').on(t.eventId),
  uniquePerEvent: uniqueIndex('cal_attendees_unique_idx').on(t.eventId, t.email)
    .where(sql`${t.email} IS NOT NULL`),
}));

/* ── calendar_event_reminders ────────────────────────────────────────────
 * Google's per-event notification overrides — "notify me 10 minutes before
 * this event". NOT the same concept as a Life OS Reminder, which is its own
 * item type with its own table below. The names are Google's, kept as-is so
 * the mapping stays obvious. */
export const calendarEventReminders = pgTable('calendar_event_reminders', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id').notNull()
    .references(() => calendarEvents.id, { onDelete: 'cascade' }),
  method: text('method').notNull().default('popup'),
  minutesBefore: integer('minutes_before').notNull(),
  usesDefault: boolean('uses_default').notNull().default(false),
}, (t) => ({ byEvent: index('cal_ev_reminders_event_idx').on(t.eventId) }));

/* ── calendar_event_attachments ──────────────────────────────────────────
 * Google Drive attachment METADATA only. Life OS does not copy the file, and
 * must not imply it holds one. */
export const calendarEventAttachments = pgTable('calendar_event_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id').notNull()
    .references(() => calendarEvents.id, { onDelete: 'cascade' }),
  fileId: text('file_id'),
  fileUrl: text('file_url'),
  title: text('title'),
  mimeType: text('mime_type'),
  iconLink: text('icon_link'),
}, (t) => ({ byEvent: index('cal_ev_attach_event_idx').on(t.eventId) }));

/* ── reminders ───────────────────────────────────────────────────────────
 * A Life OS record, permanently. A reminder asks for attention ON OR BEFORE a
 * date and does not occupy a duration, so it is not an event and must never be
 * pushed to Google as one. */
export const reminders = pgTable('reminders', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  areaId: uuid('area_id').references(() => areas.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  notes: text('notes'),
  dueDate: date('due_date'),
  dueTime: text('due_time'),          // 'HH:MM' local; null means all-day
  timeZone: text('time_zone'),
  status: text('status').notNull().default('open'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // Deferral is a first-class action rather than an edit of the due date:
  // the original intent is worth keeping.
  deferredTo: date('deferred_to'),
  // How many days early this should start asking for attention.
  leadDays: integer('lead_days').notNull().default(0),
  isSynthetic: boolean('is_synthetic').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWorkspace: index('reminders_ws_idx').on(t.workspaceId),
  byDue: index('reminders_due_idx').on(t.workspaceId, t.dueDate),
  statusCheck: check('reminders_status',
    sql`${t.status} IN ('open','done','dismissed')`),
}));

/* ── reminder_recurrence_rules ───────────────────────────────────────────
 * RRULE-shaped, so a later move to full iCal semantics is mechanical rather
 * than a rewrite. */
export const reminderRecurrenceRules = pgTable('reminder_recurrence_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  reminderId: uuid('reminder_id').notNull()
    .references(() => reminders.id, { onDelete: 'cascade' }),
  frequency: text('frequency').notNull(),          // DAILY|WEEKLY|MONTHLY|YEARLY
  interval: integer('interval').notNull().default(1),
  byWeekday: jsonb('by_weekday').$type<number[]>(),
  byMonthDay: jsonb('by_month_day').$type<number[]>(),
  until: date('until'),
  count: integer('count'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniquePerReminder: uniqueIndex('reminder_rrule_idx').on(t.reminderId),
  freqCheck: check('reminder_rrule_freq',
    sql`${t.frequency} IN ('DAILY','WEEKLY','MONTHLY','YEARLY')`),
}));

/* ── task_schedule_blocks ────────────────────────────────────────────────
 * "I will do this task at this time."
 *
 * DELIBERATELY separate from tasks.due_date. A task due Friday that you plan
 * to do on Wednesday morning has both, and they mean different things.
 * Collapsing them is exactly the mistake this table exists to prevent.
 *
 * Nothing here touches project_id or Area semantics. */
export const taskScheduleBlocks = pgTable('task_schedule_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  timeZone: text('time_zone'),
  // Set only if the user chose to mirror this block onto a real calendar.
  // Null is the normal case: planning time is private to Life OS.
  mirroredEventId: uuid('mirrored_event_id')
    .references(() => calendarEvents.id, { onDelete: 'set null' }),
  isSynthetic: boolean('is_synthetic').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWorkspace: index('task_blocks_ws_idx').on(t.workspaceId),
  byRange: index('task_blocks_range_idx').on(t.workspaceId, t.startsAt),
  byTask: index('task_blocks_task_idx').on(t.taskId),
}));

/* ── item_links ──────────────────────────────────────────────────────────
 * Life OS-ONLY relationships. ONE polymorphic edge for the whole application.
 *
 * Renamed from `calendar_item_links` in F1. The shape was already general —
 * source_type/source_id, target_type/target_id — and the original comment
 * already named `library` as a future target. Only the NAME said Calendar, and
 * a name that lies about scope is exactly how a second link table gets created
 * beside it. There is one relationship model, and this is it.
 *
 * Current and planned edges:
 *   source: event | reminder | task | habit | library | book_page
 *   target: task | project | library | diary | brain | board
 *
 * These are never written into Google event fields. If a link is ever mirrored
 * to Google it goes into a PRIVATE extended property, and the user is told
 * plainly that other Google Calendar users will not see it. */
export const itemLinks = pgTable('item_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  sourceType: text('source_type').notNull(),   // event | reminder | task | habit
  sourceId: uuid('source_id').notNull(),
  targetType: text('target_type').notNull(),   // task | project | library | diary
  targetId: uuid('target_id').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWorkspace: index('item_links_ws_idx').on(t.workspaceId),
  bySource: index('item_links_source_idx').on(t.workspaceId, t.sourceType, t.sourceId),
  byTarget: index('item_links_target_idx').on(t.workspaceId, t.targetType, t.targetId),
  uniqueEdge: uniqueIndex('item_links_unique_idx')
    .on(t.sourceType, t.sourceId, t.targetType, t.targetId, t.kind),
}));

/* ── Library ─────────────────────────────────────────────────────────────
 *
 * The durable home for information. One row per resource in `library_items`,
 * whatever kind it is; Books get a second row carrying what only a book has.
 *
 * The TYPE is stored, never inferred from a MIME string. "This is a Book" is a
 * product decision — a Document and a File can share `text/plain` while being
 * entirely different things to the person who saved them. */
export const LIBRARY_TYPES = ['book', 'document', 'image', 'video', 'link', 'file'] as const;
export const SECTION_ACCENTS = ['peach', 'sage', 'lavender', 'gold', 'blue', 'rose'] as const;

export const libraryItems = pgTable('library_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('active'),
  sourceUrl: text('source_url'),
  storageKey: text('storage_key'),
  mimeType: text('mime_type'),
  sizeBytes: integer('size_bytes'),
  thumbnailKey: text('thumbnail_key'),
  /* Type-specific facts that do not deserve a column: image dimensions, video
   * duration, a link's resolved domain. Never used for filtering or sorting —
   * the moment something is queried, it earns a column. */
  metadata: jsonb('metadata'),
  legacyId: text('legacy_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => ({
  byWorkspace: index('library_items_ws_idx').on(t.workspaceId, t.type, t.updatedAt),
  live: index('library_items_live_idx').on(t.workspaceId, t.updatedAt)
    .where(sql`${t.archivedAt} is null`),
  legacy: uniqueIndex('library_items_legacy_idx').on(t.workspaceId, t.legacyId)
    .where(sql`${t.legacyId} is not null`),
  typeCheck: check('library_items_type_check',
    sql`${t.type} in ('book','document','image','video','link','file')`),
  statusCheck: check('library_items_status_check',
    sql`${t.status} in ('active','archived')`),
}));

export const libraryBooks = pgTable('library_books', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /* CASCADE: deleting the library item IS deleting the book. There is no state
   * in which a book should outlive the item that represents it. */
  libraryItemId: uuid('library_item_id').notNull().unique()
    .references(() => libraryItems.id, { onDelete: 'cascade' }),
  subtitle: text('subtitle'),
  authorLabel: text('author_label'),
  coverStyle: text('cover_style').notNull().default('classic'),
  pageStyle: text('page_style').notNull().default('ruled'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  coverCheck: check('library_books_cover_check', sql`${t.coverStyle} in ('classic','plain')`),
  pageCheck: check('library_books_page_check', sql`${t.pageStyle} in ('ruled','plain')`),
}));

export const bookSections = pgTable('book_sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  bookId: uuid('book_id').notNull()
    .references(() => libraryBooks.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /* A token, never a hex value. The palette follows the theme; a stored #hex
   * cannot. These are the six Legacy section colours. */
  accent: text('accent').notNull().default('peach'),
  position: integer('position').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byBook: index('book_sections_book_idx').on(t.bookId, t.position),
  accentCheck: check('book_sections_accent_check',
    sql`${t.accent} in ('peach','sage','lavender','gold','blue','rose')`),
}));

export const bookPages = pgTable('book_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  sectionId: uuid('section_id').notNull()
    .references(() => bookSections.id, { onDelete: 'cascade' }),
  title: text('title'),
  /* A structured document, NOT HTML. Storing generated HTML means storing
   * whatever the browser's editor happened to produce — which is how Legacy
   * ended up with font-colour wrappers that made text invisible on a dark
   * theme, worked around with !important. */
  content: jsonb('content').notNull().default({ type: 'doc', content: [] }),
  /* The plain text of `content`, maintained on write, so search is one indexed
   * query rather than parsing every document in the workspace. */
  contentText: text('content_text').notNull().default(''),
  position: integer('position').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bySection: index('book_pages_section_idx').on(t.sectionId, t.position),
  byWorkspace: index('book_pages_ws_idx').on(t.workspaceId),
}));

/* ── relations ───────────────────────────────────────────────────────── */
export const calendarConnectionsRelations = relations(calendarConnections, ({ many }) => ({
  calendars: many(calendars),
}));
export const calendarsRelations = relations(calendars, ({ one, many }) => ({
  connection: one(calendarConnections, {
    fields: [calendars.connectionId], references: [calendarConnections.id],
  }),
  events: many(calendarEvents),
}));
export const calendarEventsRelations = relations(calendarEvents, ({ one, many }) => ({
  calendar: one(calendars, {
    fields: [calendarEvents.calendarId], references: [calendars.id],
  }),
  attendees: many(calendarEventAttendees),
  eventReminders: many(calendarEventReminders),
  attachments: many(calendarEventAttachments),
}));
export const remindersRelations = relations(reminders, ({ one }) => ({
  area: one(areas, { fields: [reminders.areaId], references: [areas.id] }),
}));
export const taskScheduleBlocksRelations = relations(taskScheduleBlocks, ({ one }) => ({
  task: one(tasks, { fields: [taskScheduleBlocks.taskId], references: [tasks.id] }),
}));

export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];
export type AccessRole = (typeof ACCESS_ROLES)[number];
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type SyncState = (typeof SYNC_STATES)[number];
