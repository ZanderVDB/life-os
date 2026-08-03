# Projects — data model (Phase E2, applied)

Migration `0003_projects.sql`. Purely additive apart from one constraint on
`tasks.project_id`, a column that has existed since the baseline and is null on
every row — so the foreign key could not fail on existing data and could not
move any work.

---

## `projects`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` | uuid not null | → `workspaces`, **cascade** |
| `area_id` | uuid | → `areas`, **set null**. Losing an area must not lose the project. |
| `title` | text not null | |
| `outcome` | text | **Nullable in the database, required by the API.** See below. |
| `description` | text | |
| `notes` | text | |
| `status` | text not null, default `planning` | check: `planning \| active \| on_hold \| completed` |
| `focus` | text not null, default `upcoming` | check: `now \| upcoming \| someday` |
| `target_date` | date | A Life OS date. Never a Google event. |
| `next_task_id` | uuid | → `tasks`, **set null**. Explicit override only. |
| `position` | integer not null | Sparse (gap 1000), so one move rewrites one row. |
| `completed_at` | timestamptz | |
| `archived_at` | timestamptz | |
| `pre_archive_status` | text | The status to restore to. |
| `legacy_id` | text | Import provenance. |
| `created_at` / `updated_at` | timestamptz not null | `updated_at` is the concurrency token. |

### Why `outcome` is nullable in the database and required in the API

The Legacy migration (E3) will land ~12 projects that have no outcome, and one
cannot be invented for them — a fabricated outcome is worse than a missing one.
So the column permits null. Every project created through the API must supply
one, because the outcome is what separates a project from a folder.

This is a deliberate split between what the *store* allows and what the
*product* requires, and it is the only one in the schema.

### Constraints

- `projects_status_check`, `projects_focus_check` — the enums.
- `projects_pre_archive_status_check` — a restore target must be a real status.
- **`projects_archive_pair_check`** — `archived_at` and `pre_archive_status` are
  both null or both set. An archived project that does not remember where to go
  back to makes restore a guess.

### Indexes

| Index | For |
|---|---|
| `projects_ws_status_idx (workspace_id, status, position)` | the overview's group queries |
| `projects_ws_focus_idx (workspace_id, focus, position)` | the focus groups |
| `projects_live_idx (workspace_id, position) WHERE archived_at is null` | partial — the default view excludes archived |
| `projects_area_idx (workspace_id, area_id)` | area change and filtering |
| `projects_legacy_idx (workspace_id, legacy_id) WHERE legacy_id is not null` | unique; makes the E3 import idempotent |

### What is deliberately absent

**No `progress` column.** Progress is derived from tasks on read. A stored
percentage is a second source of truth that drifts the moment a task changes.

**No `is_blocked`.** Blocked is a derived health condition, not a state. As a
stored flag it goes stale within days and nobody clears it.

**No `priority`, `start_date`, milestones, members or attachments.** Each is
either duplicated information (priority lives on tasks) or a feature with real
UI and no data yet.

---

## `tasks.project_id`

```sql
ALTER TABLE tasks ADD CONSTRAINT tasks_project_id_fk
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
```

**`set null`, never `cascade`.** Deleting a project must never delete work. The
task survives with its area, bucket, due date, schedule and steps intact and
simply stops belonging to a project. This is asserted by test.

New index `tasks_project_open_idx (project_id, status, position) WHERE project_id
is not null` — partial, because most tasks belong to no project, and
status-aware because every project query asks for open tasks first.

**Every existing task is still `project_id = null`.** E2 assigns nothing. A task
acquires a project only when someone assigns it or creates it inside one.

---

## Status × Focus: the full matrix

`status` is where the work is. `focus` is how loudly it should ask. They are
independent, and nothing derives one from the other.

| status | focus | Surfaces automatically? | Where it appears |
|---|---|---|---|
| planning | now | **yes** | Now |
| planning | upcoming | no | Upcoming |
| planning | someday | no | Someday filter |
| active | now | **yes** | Now |
| active | upcoming | no | Upcoming |
| active | someday | no | Someday filter |
| on_hold | now | **no** — status vetoes | On hold |
| on_hold | upcoming | no | On hold |
| on_hold | someday | no | Someday filter |
| completed | any | **no** | Recently completed (30 days), then the Completed filter |
| *archived* | any | **no** | Archived filter only |

**"On hold + now" is contradictory, and the resolution is to suppress surfacing
rather than to edit the user's answer.** Both values are stored exactly as
chosen; `surfacesAutomatically()` returns false because the status is the thing
the user most recently decided. Rewriting the focus would be the app quietly
disagreeing with an instruction it was given.

A project with a health signal is lifted into **Needs attention** and removed
from its normal group, so it is listed exactly once.

---

## What "surfaces automatically" does and does not mean

It governs **defaults only**:

- a task created inside a **Now** project starts in `today`;
- a task created inside any other project starts in `future`.

It never moves an existing task, never changes a bucket, never clears a date and
never touches a schedule. A task with an explicit due date or a scheduled block
appears because of that date — whatever its project says. Changing focus or
status therefore has **zero** effect on existing task rows, which is asserted by
test.

---

## Derived values

**Progress** — `done / (open + done)`, cancelled excluded from both sides.
Returned as counts plus a percent, and the percent is `null` when there are no
tasks. The interface never renders a bare percentage and never renders 0% for an
empty project.

**Next action** — the explicit `next_task_id` if it is still open, still in this
project and still in this workspace; otherwise the first open task by
`(due_date, priority, position)`. Validated on **every read**, so an override
that stops being eligible falls back without needing a cleanup job. The response
carries `nextActionOverrideStale` when that happens.

**Health** — evidence only:
- `no_next_action` — status is `active` and nothing is open. Planning with
  nothing open is normal and is never flagged.
- `overdue` — `target_date` has passed **and** work is still open. Past its date
  with everything done is a project waiting to be marked complete, not an
  overdue one.

Stalled is deliberately not implemented: `updated_at` moves when notes or
metadata change, so a recency signal would call a project stalled while you were
reading it.

---

## Concurrency

`updated_at` is the version token. Mutations accept `expectedUpdatedAt`; if the
row disagrees the write is rejected with 409 and the caller re-reads. This is
single-user multi-tab safety, not collaborative editing — the only question is
whether the row changed since this tab last saw it.

Archive and restore are **idempotent**, so a double click cannot overwrite the
remembered pre-archive status.

## E2.3 — what the task list carries

`GET …/tasks` returns an extra `projects` map: `{ id: { id, title, status,
focus, nextTaskId } }`, covering only the projects the returned tasks actually
belong to.

A **map, not embedded fields**. Copying `projectTitle` onto every task row would
make the task record a second place project data lives, and the two would
disagree the first time a project was renamed. `nextTaskId` rides along so Today
can mark a project's next action without a query per row.

`nextAction` on a project now reports `reason`: `chosen | due | priority |
order` — which of the four rules actually decided — plus `bucket` and
`scheduledAt`, so the slot can show what the task row shows.

`tasks.project_position` remains isolated from `tasks.position`. Verified:
completing and reopening a task disturbs neither ordering, and re-adding a
removed task does not reshuffle the tasks that never moved.
