# Life OS — PostgreSQL Data Model v2

**Status: DEPLOYED TO STAGING.** Migration `0000_baseline` is applied to
`life-os-v2-postgres-staging`; all 9 tables and 29 indexes verified present.
No legacy data has been imported — every table was empty until a real
sign-in, and `migration_runs` is still 0.

The authoritative schema now lives in `api/src/db/schema.ts`, with the generated
migration at `api/drizzle/0000_baseline.sql` (9 tables). It is exercised by 55
tests against genuine Postgres (PGlite locally, real Railway Postgres in staging). **Where this document and the code
disagree, the code wins** — treat this file as the reasoning behind the schema,
not the schema itself.

**Created 2026-07-31 · updated 2026-07-31.** Destination: **Railway PostgreSQL**
(reasoning in `backend-architecture-v2.md` §2). Provisioning steps that need
Zander's account are in [staging-setup.md](staging-setup.md).

---

## §0. LOCKED: one workspace per user (2026-07-31)

> **"Each signed-in user has one primary Life OS workspace. Personal, business,
> church, health, finance and other parts of life coexist inside the same
> workspace. They are separated through Areas, Projects, tags, calendars,
> Library books, filters and saved views — not through profile switching."**

**Why this changed.** The Firestore model gave one user two switchable
profiles (Personal / Business). That divided a life into disconnected halves —
the opposite of what Life OS is for — and it caused real harm: the pre-v240
switching bug copied data between them (confirmed: 10 reminders and 4
byte-identical People records duplicated across both profiles).

**The four concepts, kept separate:**

| Concept | Answers | Table |
|---|---|---|
| **Authentication** | Who is signed in? | `users` |
| **Workspace** | Which body of data may they access? | `workspaces` + `workspace_memberships` |
| **Area** | Which part of life is this item? | `areas` → `area_id` |
| **Project** | What outcome is this item part of? | `projects` → `project_id` |

**Never use authentication or workspaces to organise personal vs work
content.** That is what Areas are for.

**Future workspaces stay possible** — the schema supports shared company,
team, family and client workspaces — but v2 creates exactly **one primary
workspace per user** and **exposes no switcher**. Multi-workspace UI must never
become Personal/Business switching under a new name.

---

## Conventions

- **Identifiers:** `uuid` primary keys, default `gen_random_uuid()` (pgcrypto).
  This replaces today's 7-character random ids, which are collision-prone.
  Where a client must generate an id offline, use **UUIDv7** so ids stay
  time-sortable.
- **Naming:** `snake_case`, plural tables. **Explicit names only** — the legacy
  vocabulary is retired:

  | Legacy (confusing) | v2 name |
  |---|---|
  | `builds` | **`projects`** |
  | `workProjects` | **`areas`** |
  | `task.project` (actually an Area) | **`tasks.area_id`** |
  | `routineLog[date].journal` | **`diary_entries`** |
| Firestore *profile* | **`workspaces`** (one primary per user) |
| Personal / Business profiles | **`areas`** inside one workspace |
  | `notebook.sections` | **`books` → `book_sections` → `book_pages`** |
  | `notes` (Brain) | **`brain_items.kind = 'knowledge'`** |
  | `learning` | *dropped* |

- **Ownership:** every user-data table carries `workspace_id`. This is the single
  ownership boundary; the API filters on it in middleware.
  **Areas** (`area_id`) classify *within* a workspace — they are not an
  ownership boundary and never gate access.
- **Timestamps:** `created_at`, `updated_at` (`timestamptz`, UTC). Dates the user
  reasons about locally (a due date, a diary day) are `date`, not `timestamptz`.
- **Soft delete:** `deleted_at timestamptz NULL` on tables where accidental loss
  hurts (tasks, projects, books, pages, diary, brain, attachments). Hard delete
  on high-volume join/log tables. Partial indexes exclude soft-deleted rows.
- **Concurrency:** `version integer` on user-editable rows for optimistic
  locking (`409` on mismatch).
- **Ordering:** `sort_order` uses a *sparse* integer or a fractional-index
  string, so reordering touches one row instead of renumbering a whole bucket.

---

## 1. `users`
**Purpose:** one row per human. The anchor the whole schema references.

| Column | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid PK | ● | referenced by everything |
| `firebase_uid` | text UNIQUE | ○ | **removable** when Firebase Auth is replaced |
| `email` | citext UNIQUE | ● | |
| `display_name` | text | ○ | |
| `is_owner` | boolean | ● | replaces the hardcoded owner-email list |
| `created_at`,`updated_at` | timestamptz | ● | |

**Indexes:** `firebase_uid`, `email`. **Delete:** restrict — never cascade from
a user; account deletion is a deliberate job. **Growth:** tiny.

## 2. `workspaces`
**Purpose:** a body of data. **The ownership boundary.**
Replaces the Firestore *profile*. See §0 — v2 gives each user **one primary
workspace**; Personal/Business separation moves to **Areas**.

| Column | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid PK | ● | referenced by every user-data table as `workspace_id` |
| `owner_user_id` | uuid FK→users | ● | `ON DELETE RESTRICT` |
| `name` | text | ● | e.g. "Zander" |
| `kind` | text | ● | `primary` \| `shared` — **only `primary` is created in v2** |
| `legacy_firestore_doc_id` | text | ○ | migration provenance (e.g. `main`) |
| `created_at`,`updated_at`,`deleted_at` | | | soft delete |

**`mode` is deliberately gone.** The old `personal`/`business` flag biased AI
framing per profile. In v2 that context comes from the item's **Area**, so the
AI can reason about work and personal life in one place instead of being
switched between two blind halves.

**Constraint:** exactly one `kind='primary'` workspace per user —
`UNIQUE (owner_user_id) WHERE kind='primary' AND deleted_at IS NULL`.
**Growth:** 1 row/user in v2.

## 3. `workspace_memberships`
**Purpose:** who may access a workspace. In v2 there is exactly one row per
user (`owner`). The table exists so **future collaboration needs no data-model
change** — it is *not* a re-creation of profile switching.

`id` uuid PK · `workspace_id` FK→workspaces (cascade) · `user_id` FK→users
(cascade) · `role` text (`owner`|`admin`|`editor`|`viewer`) · `created_at`
**Unique:** `(workspace_id, user_id)`. **Index:** `(user_id)` — the auth
middleware's hot path.

> **Do not expose workspace switching in the v2 UI.** The schema supports it;
> the product does not. Future use is genuine multi-party collaboration
> (a company, a family, a client), never "my work life vs my personal life".

## 4. `areas`
**Purpose:** **which part of life** an item belongs to. This is what replaces
Personal/Business profiles. (Legacy name: `workProjects`.) **Not projects.**

`id` uuid PK · `workspace_id` FK (cascade) · `name` text ● · `color` text ●
· `sort_order` integer ● · `is_system` boolean (Personal/Work) · `icon` text ○ ·
`created_at`,`updated_at`,`deleted_at`
**Index:** `(workspace_id, sort_order)`. **Delete:** soft; the API reassigns
affected items (today's only referential clean-up — keep that behaviour).

**Seeding rule (locked 2026-07-31).** Migrate the user's **existing valid Areas
from the authoritative Personal profile**, and guarantee **Personal** and
**Work** exist. **Do not auto-seed** Church, Health, Finance, Family, Learning
or any other optional Area — those may later be offered as **one-click
suggestions** in onboarding or Settings, never as forced defaults.

**Duplicate prevention:** normalise on write — trim, collapse internal
whitespace, compare case-insensitively — so "Work", "work" and "  Work " cannot
coexist. Enforced by `UNIQUE (workspace_id, lower(btrim(name))) WHERE deleted_at IS NULL`.

**Removal is never destructive.** Deleting an Area must **never** delete the
tasks, projects, calendar items, books or brain items linked to it. Every
`area_id` is `ON DELETE SET NULL`, and the API reassigns affected content to
**no Area or another chosen Area**. An Area is a label, never an owner.

**Areas are usable across** tasks, projects, calendar items, reminders, Library
books/entries, Brain items, AI commands, and saved views/filters — so every
table that can be classified carries a nullable `area_id`.

| Question | Answered by |
|---|---|
| Who is signed in? | **authentication** (`users`) |
| Which body of data may they access? | **workspace** (`workspaces` + memberships) |
| Which part of life is this item? | **area** (`areas.area_id`) |
| What outcome is it part of? | **project** (`projects.project_id`) |

## 5. `projects`
**Purpose:** real projects. Gains everything the vision needs.

| Column | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid PK | ● | |
| `workspace_id` | uuid FK | ● | cascade |
| `area_id` | uuid FK→areas | ○ | `ON DELETE SET NULL` |
| `title` | text | ● | |
| `description` | text | ○ | |
| `status` | text | ● | `active`\|`paused`\|`background`\|`done`\|`archived` |
| `priority` | text | ○ | same vocabulary as tasks |
| `stage` | text | ○ | replaces the fixed 0–6 integer |
| `start_date` | date | ○ | **new — required for Gantt** |
| `due_date` | date | ○ | **new — required for Gantt** |
| `progress_mode` | text | ● | `auto` (from tasks) \| `manual` |
| `progress_percent` | smallint | ○ | used when `manual` |
| `auto_status` | boolean | ● | keep the "gone quiet" behaviour |
| `last_activity_at` | timestamptz | ○ | |
| `notes` | text | ○ | scratch |
| `version`,`created_at`,`updated_at`,`deleted_at` | | | |

**Indexes:** `(workspace_id, status)`, `(workspace_id, due_date)`,
`(workspace_id, area_id)`. **Growth:** low (tens–hundreds).

## 6. `project_milestones`
**Purpose:** dated checkpoints — **do not exist today**, required for Gantt.

`id` uuid PK · `project_id` FK (cascade) · `workspace_id` FK (denormalised for
ownership filtering) · `title` ● · `due_date` date ● · `completed_at`
timestamptz ○ · `sort_order` · timestamps
**Index:** `(project_id, due_date)`.

## 7. `project_dependencies`
**Purpose:** "project B cannot start until A finishes".

`id` uuid PK · `workspace_id` · `predecessor_project_id` FK · `successor_project_id`
FK · `dependency_type` text (`finish_start`|`start_start`|`finish_finish`|
`start_finish`) · `lag_days` integer default 0 · `created_at`
**Unique:** `(predecessor_project_id, successor_project_id)`.
**Check:** predecessor ≠ successor. **Cycles are rejected in the API** using a
recursive CTE — the reason Postgres was chosen.

## 8. `tasks`
**Purpose:** the central object.

| Column | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid PK | ● | |
| `workspace_id` | uuid FK | ● | cascade |
| `area_id` | uuid FK→areas | ○ | **the honest name** for today's `task.project` |
| `project_id` | uuid FK→projects | ○ | **NEW — the link that does not exist today** (`ON DELETE SET NULL`) |
| `parent_task_id` | uuid FK→tasks | ○ | optional nesting (distinct from `task_steps`) |
| `title` | text | ● | |
| `notes` | text | ○ | |
| `status` | text | ● | `open`\|`done`\|`cancelled` — replaces the boolean |
| `priority` | text | ● | `urgent`\|`high`\|`medium`\|`low`\|`someday` |
| `bucket` | text | ● | `today`\|`week`\|`month`\|`future` — **kept: it is manual and it works** |
| `sort_order` | text/int | ● | sparse; position within the bucket |
| `due_date` | date | ○ | **must actually save this time** (audit D2) |
| `scheduled_start` | timestamptz | ○ | replaces free-text `scheduledTime` |
| `scheduled_end` | timestamptz | ○ | enables calendar display + Gantt |
| `duration_minutes` | integer | ○ | **new** |
| `energy` | text | ○ | **roadmap only — nullable, unused** (`design-ideas.md` §12) |
| `completed_at` | timestamptz | ○ | |
| `recurrence_rule_id` | uuid FK | ○ | **new — tasks cannot recur today** |
| `source` | text | ● | `user`\|`ai`\|`import` — provenance |
| `version`,`created_at`,`updated_at`,`deleted_at` | | | |

**Indexes:** `(workspace_id, bucket, sort_order) WHERE deleted_at IS NULL` ·
`(workspace_id, status)` · `(workspace_id, due_date)` · `(project_id)` ·
`(workspace_id, updated_at DESC)`.
**Delete:** soft — fixes today's behaviour where completing effectively deletes
(only 50 completed tasks are retained).
**Growth:** the largest user table; thousands per profile over years. Fine.

## 9. `task_steps`
**Purpose:** subtasks (today's inline `steps`).

`id` uuid PK · `task_id` FK (cascade) · `workspace_id` · `title` ● ·
`is_done` boolean ● · `completed_at` ○ · `sort_order` ● · timestamps
**Index:** `(task_id, sort_order)`. **Gains over today:** steps become
**renameable** (currently add/delete only) and individually addressable.

## 10. `task_dependencies`
Same shape as `project_dependencies`, between tasks. Cycle-checked in the API.
**Unique:** `(predecessor_task_id, successor_task_id)`.

## 11. `task_recurrence_rules`
**Purpose:** repeating tasks — **completely absent today**.

`id` uuid PK · `workspace_id` · `freq` text (`daily`|`weekly`|`monthly`|`yearly`)
· `interval` integer default 1 · `by_weekday` smallint[] · `by_month_day`
smallint[] · `by_month` smallint · `starts_on` date · `ends_on` date ○ ·
`count` integer ○ · `timezone` text ● (**store the zone — audit D9**) ·
`next_occurrence_date` date · timestamps

Deliberately RRULE-shaped so it can serialise to iCalendar later. `reminders`
reuses this table.

## 12. `task_activity`
**Purpose:** an audit trail — "what happened to this task".

`id` uuid PK (UUIDv7) · `task_id` FK (cascade) · `workspace_id` · `actor_type`
text (`user`|`ai`|`system`) · `actor_user_id` FK ○ · `action` text
(`created`|`completed`|`moved_bucket`|`edited`|`linked_project`…) ·
`changes` jsonb (before/after of changed fields only) · `ai_command_id` FK ○ ·
`created_at`
**Index:** `(task_id, created_at DESC)`, `(workspace_id, created_at DESC)`.
**Delete:** hard, with a retention job (e.g. 12 months). **Growth:** high —
the fastest-growing table. Consider monthly partitioning later.
**Not versioning** — it records events, it does not reconstruct old rows.

## 13. `project_activity`
Same shape, keyed to `project_id`. Absorbs today's AI-written project "log"
(`log[]`), which becomes `action='note'` with the text in `changes`. **This
finally allows manual log entries without an API key** (today the flow is
AI-only).

## 14. `habits`
`id` uuid PK · `workspace_id` FK · `name` ● · `description` ○ ·
`rest_weekdays` smallint[] (0–6) · `started_on` date ● · `archived_at` ○ ·
`sort_order` · timestamps
**Note:** streaks/tiers are **computed, never stored** — persisting them once
caused habits to auto-tick (audit). Keep that discipline.

## 15. `habit_entries`
**Purpose:** one row per habit per completed day. Replaces `checkedDates[]`.

`id` uuid PK · `habit_id` FK (cascade) · `workspace_id` · `entry_date` date ● ·
`source` text (`user`|`ai`|`catchup`) · `created_at`
**Unique:** `(habit_id, entry_date)` — makes double-ticking impossible and
back-fill idempotent. **Index:** `(workspace_id, entry_date)`.
**Growth:** ~365 × habits per year. Trivial for Postgres, and far better than a
growing array inside one document.

## 16. `reminders`
`id` uuid PK · `workspace_id` · `text` ● · `recurrence_rule_id` FK ○ ·
`next_due_on` date · `last_completed_on` date ○ · `is_active` boolean ·
timestamps · `deleted_at`
**Index:** `(workspace_id, next_due_on) WHERE is_active`.

## 17. `books`
**Purpose:** the Library. **The 4th level the Notebook lacks today.**

`id` uuid PK · `workspace_id` · `title` ● · `kind` text
(`notebook`|`diary`|`research`|`recipes`|`travel`|`meetings`|`other`) ·
`color` · `cover_attachment_id` FK→attachments ○ · `sort_order` ·
timestamps · `deleted_at`

The Diary becomes **a book of kind `diary`**, exactly as the vision describes.

## 18. `book_sections`
`id` uuid PK · `book_id` FK (cascade) · `workspace_id` · `title` ● · `color` ·
`sort_order` · timestamps · `deleted_at`

## 19. `book_pages`
`id` uuid PK · `section_id` FK (cascade) · `workspace_id` · `title` ○
(**pages have no title today**) · `layout` text (`single`|`half`|`quad`) ·
`content` jsonb ● · `content_format` text (`html_cells`|`richtext_v2`) ·
`entry_date` date ○ (set for diary pages) · `version` · timestamps ·
`deleted_at`

**`content` is `jsonb`, not a text blob**, so cells stay addressable and the
format can evolve. `content_format` makes migration safe: today's mixed
plain-text/HTML cells import as `html_cells` and can be upgraded later without
guessing.
**Index:** `(section_id, sort_order)`, `(workspace_id, entry_date)`,
plus a GIN full-text index for search — **notebook and diary become searchable**
(the diary is unsearchable today).

## 20. `diary_entries`
**Purpose:** the day-keyed journal, **finally separated from routine ticks**
(audit D5 — today `journal` and `checks` share one object).

`id` uuid PK · `workspace_id` · `entry_date` date ● · `book_page_id` FK ○
(links the entry to its Library page) · `answers` jsonb (the five prompts,
keyed by prompt id) · `mood` text ○ (**new**) · `created_at`,`updated_at`,
`deleted_at`
**Unique:** `(workspace_id, entry_date)`.

A separate small table `routine_completions`
(`workspace_id, entry_date, routine_item_id, is_done`) takes over the `checks`
half, keeping the two concerns apart permanently.

## 21. `brain_items`
`id` uuid PK · `workspace_id` · `kind` text (`idea`|`resource`|`knowledge`) ● ·
`title` ● · `body` text ○ · `url` text ○ · `tag` text ○ · `source` text ·
`version` · timestamps · `deleted_at`

One table with a `kind` discriminator replaces three near-identical arrays and
the `desc`/`body` field-name inconsistency.
**Index:** `(workspace_id, kind)`, GIN full-text on `title || body`.

## 22. `brain_links`
**Purpose:** relationships between knowledge — **do not exist today**; the
foundation for the planned graph.

`id` uuid PK · `workspace_id` · `from_item_id` FK→brain_items (cascade) ·
`to_item_id` FK→brain_items (cascade) · `relation` text
(`relates_to`|`supports`|`contradicts`|`derived_from`) · `created_by` text
(`user`|`ai`) · `created_at`
**Unique:** `(from_item_id, to_item_id, relation)`. Check: from ≠ to.

Deliberately generic so it can later link brain items to tasks/projects/pages
(add nullable `to_task_id`/`to_project_id`, or a polymorphic `entity_links`
table if breadth is needed).

## 23. `calendar_connections`
**Purpose:** one row per connected external calendar account, **per profile**
(today each profile already keeps its own token, in browser storage).

`id` uuid PK · `workspace_id` · `provider` text (`google`|`microsoft`) ·
`external_account_email` · `scopes` text[] · `access_token_encrypted` bytea ·
`refresh_token_encrypted` bytea · `token_expires_at` timestamptz ·
`status` text (`active`|`needs_reauth`|`revoked`) · `last_synced_at` ·
timestamps
**Unique:** `(workspace_id, provider, external_account_email)`.
**Tokens are encrypted at rest** (AES-256-GCM, key from
`TOKEN_ENCRYPTION_KEY`) and **never returned to the client** — a direct fix for
tokens sitting in plain browser storage today.

## 24. `external_calendar_items`
**Purpose:** sync mapping between Life OS objects and provider events.
**Events themselves are still owned by the provider** — this table stores the
mapping and just enough cache to render without a round-trip.

`id` uuid PK · `workspace_id` · `connection_id` FK · `provider_event_id` ● ·
`provider_calendar_id` ● · `recurring_event_id` ○ · `etag` ○ ·
`linked_task_id` FK ○ · `linked_project_id` FK ○ ·
`linked_milestone_id` FK ○ · `title_cache` · `starts_at` timestamptz ·
`ends_at` timestamptz · `is_all_day` boolean · `timezone` text ●
(**store it — audit D9**) · `last_seen_at` · `deleted_at`
**Unique:** `(connection_id, provider_event_id)`.
**Index:** `(workspace_id, starts_at)`.

**This is what finally lets tasks appear on the calendar** — the audit found
tasks and the calendar are completely disconnected today.

## 25. `ai_commands`
**Purpose:** one row per AI request — the **preview** record.

`id` uuid PK · `workspace_id` · `user_id` FK · `prompt` text ● · `mode` text
(`do`|`ask`) · `scope` text (the page) · `model` text · `status` text
(`pending`|`awaiting_review`|`applied`|`cancelled`|`failed`) ·
`clarifications` jsonb · `assistant_message` text · `input_tokens`,
`output_tokens` integer · `error` jsonb ○ · `created_at`,`applied_at`
**Index:** `(workspace_id, created_at DESC)`.
Replaces `aiHistory` (capped at 200 inside the document today) with unbounded,
queryable history.

## 26. `ai_command_operations`
**Purpose:** the individual proposed changes — what the review UI edits, and
what `:apply` executes **inside one transaction**.

`id` uuid PK · `ai_command_id` FK (cascade) · `workspace_id` · `seq` integer ● ·
`op_type` text ● (`create_task`, `complete_habit`, `update_event`…) ·
`payload` jsonb ● (**edited in place** when the user edits the preview) ·
`status` text (`proposed`|`accepted`|`rejected`|`applied`|`failed`) ·
`target_table` text ○ · `target_id` uuid ○ (filled after apply) ·
`error` jsonb ○ · `created_at`
**Index:** `(ai_command_id, seq)`.

This makes preview-first **structural** rather than a UI convention, and gives
each operation an individual outcome — fixing today's silent partial failures.

## 27. `ai_memory`
`id` uuid PK · `workspace_id` · `fact` text ● · `sort_order` · `created_at`
Replaces the 50-item array. Cap becomes a policy check, not a `slice()`.

## 28. `user_preferences`
**Purpose:** settings — and a fix for today's split brain, where **theme and all
notification settings are device-only and never sync**.

`id` uuid PK · `user_id` FK ○ · `workspace_id` FK ○ · `scope` text
(`user`|`profile`|`device`) · `device_id` text ○ · `key` text ● ·
`value` jsonb ● · `updated_at`
**Unique:** `(COALESCE(user_id,…), COALESCE(workspace_id,…), COALESCE(device_id,''), key)`.

Key–value rather than wide columns, because preferences change often and this
avoids a migration per toggle. Genuinely device-local things (notebook zoom)
keep `scope='device'`; **theme and notification settings become `user` scope so
they finally sync.**

## 29. `integration_credentials`
**Purpose:** non-calendar third-party secrets (e.g. a per-user Anthropic key, if
that model is kept).

`id` uuid PK · `user_id` FK · `provider` text · `credential_encrypted` bytea ·
`last_four` text (for display) · `status` · timestamps
**Never returned to the client** — only `last_four`.
**Note:** if the server uses one platform-wide Anthropic key from an env var,
this table may hold nothing for AI and exist only for future integrations.

## 30. `attachments`
**Purpose:** metadata for every R2 object. **PostgreSQL is the index; R2 holds
the bytes.**

| Column | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid PK | ● | |
| `workspace_id` | uuid FK | ● | ownership |
| `uploaded_by_user_id` | uuid FK | ● | |
| `r2_object_key` | text UNIQUE | ● | see `r2-storage-architecture.md` |
| `original_filename` | text | ● | |
| `content_type` | text | ● | validated server-side |
| `byte_size` | bigint | ● | |
| `checksum_sha256` | text | ● | duplicate detection |
| `status` | text | ● | `pending`→`ready`→`failed`/`orphaned` |
| `entity_type` | text | ○ | `task`\|`project`\|`book_page`\|`diary_entry`\|`brain_item`\|`export` |
| `entity_id` | uuid | ○ | polymorphic — **not** a real FK |
| `thumbnail_key` | text | ○ | |
| `metadata` | jsonb | ○ | width/height/duration |
| `created_at`,`updated_at`,`deleted_at` | | | |

**Indexes:** `(workspace_id, entity_type, entity_id)`,
`(workspace_id, checksum_sha256)`, `(status) WHERE status <> 'ready'`.
**Delete:** soft first; a cleanup job removes the R2 object afterwards, so a
mistaken delete is recoverable.
**Polymorphic caveat:** `entity_id` cannot have a foreign key, so orphans are
possible — a nightly job reconciles both directions (see the R2 doc).

## 31. `migration_runs`
**Purpose:** make the Firestore→Postgres migration idempotent, restartable and
auditable.

`id` uuid PK · `workspace_id` FK ○ (null = global) · `phase` text (`A`…`F`) ·
`step` text (e.g. `tasks`) · `status` text
(`pending`|`running`|`succeeded`|`failed`|`rolled_back`) · `dry_run` boolean ·
`source_snapshot_ref` text (the Firestore export used) · `backup_ref` text
(the pre-run DB backup) · `counts` jsonb (`{read, written, skipped, failed}`) ·
`validation` jsonb (post-run comparison) · `error` jsonb ○ ·
`started_at`,`finished_at`
**Index:** `(workspace_id, step, status)`.

Plus **`migration_id_map`** — the safety net that makes re-running safe:
`legacy_id` text · `legacy_kind` text · `new_id` uuid · `workspace_id` ·
`migration_run_id` FK. **Unique:** `(workspace_id, legacy_kind, legacy_id)`.
Re-running a step finds the existing mapping and **updates instead of
duplicating**.

## 32. `schema_migrations`
Standard tooling table: `version`, `name`, `applied_at`, `checksum`.

---

## Ownership and deletion summary

```
users ──< workspaces ──< workspace_memberships     (v2: exactly ONE primary)
             │
             ├──< areas ····> classify items (label, never an owner)
             │
             ├──< tasks >── projects ──< project_milestones
             │                │                └─< project_dependencies
             │                ├──< task_steps
             │                ├──< task_dependencies
             │                ├──< task_activity
             │                └──> task_recurrence_rules
             ├──< habits ──< habit_entries
             ├──< reminders
             ├──< books ──< book_sections ──< book_pages
             ├──< diary_entries          routine_completions
             ├──< brain_items ──< brain_links
             ├──< calendar_connections ──< external_calendar_items
             ├──< ai_commands ──< ai_command_operations
             ├──< ai_memory
             ├──< attachments
             └──< user_preferences
```

- **Cascade** from `workspace` downward (deleting a workspace removes its data).
- **Restrict** from `users` — account deletion is an explicit, logged job.
- **SET NULL** for optional cross-links (`tasks.project_id`, `tasks.area_id`,
  `projects.area_id`) so deleting a project or Area never destroys tasks.
- **Areas never cascade-delete content.** Removing an Area reclassifies items,
  it does not remove them — an Area is a label, not an owner.
- **Soft delete** on user-visible content; hard delete on activity/log tables
  with retention.

## Growth expectations (single user, multi-year)

| Table | Order of magnitude |
|---|---|
| `task_activity` | 10⁴–10⁵ ← largest; retention/partitioning candidate |
| `habit_entries` | 10³–10⁴ |
| `tasks` | 10³–10⁴ |
| `book_pages`, `brain_items`, `ai_command_operations` | 10²–10³ |
| `external_calendar_items` | 10³ (cache; prunable) |
| `attachments` | 10²–10³ rows; bytes live in R2 |
| everything else | 10⁰–10² |

Trivially within a small Postgres instance — and unconstrained by the **1 MB
document ceiling that today's architecture will eventually hit** (audit D3).

## Versioning / history

- **Full row versioning is deliberately not implemented.** It doubles write
  volume and complexity.
- `task_activity` / `project_activity` record *what changed* — enough to answer
  "what happened", which is the actual requirement.
- `version` columns give optimistic locking, not history.
- `book_pages` is the one place where true revisions may be worth adding later
  (a `book_page_revisions` table), because long-form writing is where losing
  work hurts most. **Not in v1.**

---

## Applied to staging — 2026-07-31

Migration `0000_baseline` applied to `life-os-v2-postgres-staging`
(`drizzle.__drizzle_migrations` count = 1). Verified present: all 9 tables and
29 indexes, including the constraints that carry the design decisions —
`workspaces_one_primary_idx` (one primary workspace per user),
`areas_workspace_name_idx` (Area names unique per workspace, case- and
whitespace-folded), `tasks_legacy_idx` and `areas_legacy_idx` (legacy ids unique
per workspace, which is what makes a re-run of the real import idempotent),
`users_email_lower_idx` and `workspace_memberships_unique`.

**Driver note.** Tests run on PGlite; staging runs postgres-js. These can differ
in how column types are returned, so it was checked explicitly: `date` columns
come back as `'YYYY-MM-DD'` strings through Drizzle on both. The web shell does
`new Date(dueDate + 'T12:00:00')`, so a `Date` object here would have rendered
"Invalid Date" on every dated card with no test failing.

**Connection.** Railway exposes `DATABASE_URL` (private,
`postgres.railway.internal`, no TLS) and `DATABASE_PUBLIC_URL` (public proxy,
TLS required). `sslModeFor()` picks per host; an explicit `?sslmode=` overrides.
Pool: 10 per instance, `idle_timeout` 30s, `connect_timeout` 10s.
