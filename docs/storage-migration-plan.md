# Life OS — Storage Migration Plan

**Status: PLAN ONLY. No migration has run. No infrastructure exists.**
**Created 2026-07-31 · approach LOCKED 2026-07-31.**

> **Locked:** system-by-system migration through *define model → create schema
> → import → validate → dual-write → switch reads → stop legacy writes → retain
> rollback data until approval*. **The Today and Task Detail UI is built against
> the new Task API — never shipped against the old Firestore object and
> rewritten later.** Legacy data decisions are provisional; **nothing is
> deleted**.

> **Destination:** Railway backend → **Railway PostgreSQL** (structured data) +
> **Cloudflare R2** (files/exports). **Firebase Auth stays temporarily.**
> **Firestore stays temporarily** as the legacy source and rollback copy.
> Firestore has **not** been removed, and must not be until final cutover.

---

## Non-negotiable rules

1. **Do not lift-and-shift.** The single Firestore record must **not** be
   dropped into one PostgreSQL `jsonb` column. That would carry every existing
   problem across and gain nothing. Data is **reshaped** into real tables.
2. **System by system**, not all at once.
3. **Profile by profile.** One profile is migrated and validated before the next.
4. **Idempotent.** Re-running any step must update, never duplicate — enforced
   by `migration_id_map` (`legacy_id → new uuid`, unique per profile+kind).
5. **Restartable.** Every step is chunked and records progress in
   `migration_runs`; a crash resumes rather than restarting.
6. **Backed up.** A pre-run backup is taken and referenced before every step.
7. **Validated.** Counts and spot-checks must pass or the step is marked failed.
8. **Logged.** Every run records reads/writes/skips/failures.
9. **Reversible until final cutover.** Firestore stays authoritative until
   Phase F, and writes continue there during the dual-write window.
10. **Dry-run first, always.** `MIGRATION_DRY_RUN=true` is the default.

---

## Cutover model

For each system:

```
1. READ-ONLY IMPORT   Postgres is populated from Firestore. The app still
                      reads and writes Firestore. Zero user impact.
2. VALIDATE           Automated comparison + a manual look at the real data.
3. DUAL-WRITE         The app writes to BOTH via the API. Firestore stays
                      authoritative for reads. Divergence is logged.
4. READ SWITCH        Reads move to Postgres. Firestore still written.
                      ← this is the reversible point; flip back instantly
5. STOP LEGACY WRITE  Only after approval, per system.
```

Firestore becomes **read-only** at the end of Phase F, and is retained for a
defined rollback period afterwards.

---

## Phase A — Safety (before anything is built)

**Nothing here touches the new stack. All of it protects existing data.**

| Step | Why |
|---|---|
| **A1. Fix the profile-contamination bug** | `technical-debt.md` **D1** — switching profiles can copy one profile's reminders/people into another *and then save them there*. Migrating contaminated data would make it permanent. **This must be fixed first.** |
| **A2. Inspect the orphaned data** | Decide keep/migrate/delete for `dayNotes` (invisible but still saved — may hold years of notes), `people`/`peopleTags`/`peopleLevelNames` (unreachable page, still saved), `learning` (dead), `customEvents` (being actively emptied). **A decision, not a guess.** |
| **A3. Protected Firestore export** | Full export of every profile document to `life-os-backups`, write-once, retained through the entire migration. This is the rollback floor. |
| **A4. Verify Firebase security rules** | **They are not in this repository** and could not be audited. They are currently the only server-side protection. Confirm a user cannot read another user's documents *before* building anything that assumes that. |
| **A5. Record a data census** | Per profile: counts of tasks, habits, habit-tick dates, notebook sections/pages, diary days, brain items, reminders, AI history, plus the **document size in bytes** (how close to the 1 MB ceiling). This census is the baseline every later validation compares against. |

**Exit criteria:** D1 fixed and deployed · orphan decisions written down ·
export verified restorable · rules confirmed · census recorded.

---

## Phase B — Platform foundation (no user data yet)

| Step | Notes |
|---|---|
| **B1. Create the backend service** | Second Railway service from the same repo (`api`), Node + TypeScript + Fastify |
| **B2. Provision PostgreSQL** | Railway add-on; **staging first**, then production |
| **B3. Schema migrations** | Versioned SQL, applied on boot inside an advisory lock |
| **B4. Firebase token verification** | Admin SDK; map `firebase_uid` → internal `users.id`; ownership middleware |
| **B5. Private R2 buckets** | `prod`, `exports`, `backups` + scoped token + lifecycle rules |
| **B6. Health checks + staging** | `/health`, `/health/ready`, `/health/version`; a full staging environment |
| **B7. Backup + restore rehearsal** | Prove a `pg_dump` can be restored into staging **before** trusting it |

**Exit criteria:** an authenticated `GET /api/v1/me` returns the right user
from Postgres in staging; a restore has actually been performed.

---

## Phase C — Task model (the first real data)

Tasks are first because they are the most-used system and Steps 4–5 of the
redesign are blocked on them.

| Step | Notes |
|---|---|
| **C1. Finalise the redesigned Task object** | Must resolve: the **broken due-date save** (D2), the **task→project link that does not exist** (D1 in the dependency map), recurrence, duration, and **touch-friendly reordering** (D4) |
| **C2. Create the task tables** | `tasks`, `task_steps`, `task_dependencies`, `task_recurrence_rules`, `task_activity`, plus `areas` |
| **C3. Build the mapping** | See below |
| **C4. Migrate ONE test profile** | Dry-run → inspect → real run |
| **C5. Validate** | counts · bucket membership · **order within each bucket** · subtask counts and done-state · completed tasks and timestamps · notes preserved · area assignment |
| **C6. Build Today + Task Detail against the new API** | This is redesign Steps 4–5, now on real foundations |

### Mapping `S.tasks[]` → `tasks`

| Legacy | New | Rule |
|---|---|---|
| `id` (7 chars) | `id` uuid | new uuid; **old id recorded in `migration_id_map`** |
| `text` | `title` | trim; skip if empty |
| `done` + `doneAt` | `status` + `completed_at` | `done→'done'` else `'open'` |
| `bucket` | `bucket` | unchanged; default `today` if invalid |
| `ord` | `sort_order` | re-spaced (×1000) so future inserts need no renumber |
| `project` | **`area_id`** | resolve via `migration_id_map` for areas; `'gen'`→null |
| `area` | — | **dropped**; folded into `area_id` (the personal/work built-ins become real `areas` rows) |
| `priority` | `priority` | `hi→high`, `lo→low`, `med→medium` |
| `steps[]` | `task_steps` | new uuids, `sort_order` from array index |
| `notes` | `notes` | verbatim |
| `scheduledTime` (free text) | `scheduled_start` | **best-effort parse** ("3:30pm"); on failure keep the raw string in `notes` and log it — **never silently discard** |
| `dueDate` | `due_date` | present only on legacy data (the field has been unsaveable since v233) |
| `date` | `created_at` | local date → timestamptz at local noon |
| `lastCheckedAt` | `task_activity` row | becomes an event, not a column |
| `dailyDate`,`dailySince`,`daily` | — | **dropped** (dead Daily/General model) |
| `linkedPersonId/PromiseId` | — | depends on the A2 People decision |
| — | `project_id` | **null for everything** — no legacy link exists to migrate |

---

## Phase D — Time and Projects

| Step | Notes |
|---|---|
| **D1. Reminders** | `S.reminders[]` → `reminders` + `task_recurrence_rules`; recompute `next_due_on` |
| **D2. Calendar connections** | Move Google/Outlook tokens from **browser localStorage into `calendar_connections`, encrypted**. Requires a one-time re-consent per profile — plan the user-facing prompt. |
| **D3. Sync mappings** | Create `external_calendar_items`; **this is what finally lets tasks appear on the calendar** |
| **D4. Redesign Projects** | Add start/due dates, real status, milestones, dependencies, progress |
| **D5. Migrate `S.builds` → `projects`** | `title`, `desc→description`, `status` (`future→paused`), `stage` int → text, `notes`; **`log[]` → `project_activity`** rows (which finally allows manual log entries without an API key) |
| **D6. Add task↔project relationships** | New capability. Optionally offer an assisted pass to link existing tasks — **never guess automatically.** |
| **D7. Gantt data** | Milestones + dependencies; cycle detection via recursive CTE |

---

## Phase E — Library and knowledge

| Step | Notes |
|---|---|
| **E1. Split the Diary** | `routineLog[date]` currently holds `journal` **and** routine `checks` in one object. Split into `diary_entries` and `routine_completions`. **Must happen before any Library merge.** |
| **E2. Notebook → books/sections/pages** | `S.notebook.sections[]` → one `books` row (kind `notebook`) + `book_sections` + `book_pages`. Cells → `content` jsonb with `content_format='html_cells'`. **Do not attempt to normalise the mixed plain-text/HTML cells during migration** — the legacy converter only runs at render time, so a blind conversion would mangle untouched cells. Preserve exactly, convert later. |
| **E3. Diary as a book** | Create a `books` row of kind `diary`; link `diary_entries.book_page_id` |
| **E4. `dayNotes`** | Per the A2 decision. If kept, import as a distinct book so nothing is silently lost. |
| **E5. Brain** | `ideas`/`resources`/`notes` → `brain_items` with `kind`; note `notes.body` vs `ideas.desc` field-name difference. `brain_links` starts empty. |
| **E6. Extract embedded images** | Scan page content for `data:image`; extract to R2, replace with attachment references, report counts |
| **E7. Full-text search** | Build GIN indexes — **the diary becomes searchable for the first time** |

---

## Phase F — AI and final cutover

| Step | Notes |
|---|---|
| **F1. Move Anthropic calls server-side** | The key leaves the browser (and leaves the Firestore record). One model constant replaces nine hardcoded copies. |
| **F2. Preview-first AI** | `ai_commands` + `ai_command_operations`; **apply runs in one transaction** (fixes D5). Calendar side-effects run before commit or record a compensating action. |
| **F3. Rate limits + token budget** | Neither exists today; there is also a timer that calls the AI automatically |
| **F4. Migrate `aiHistory` + `aiMemory`** | Into `ai_commands` and `ai_memory` |
| **F5. Full validation** | Re-run the Phase A census against Postgres; every count must reconcile or be explained |
| **F6. Firestore read-only** | Stop all writes; keep reads available |
| **F7. Rollback window** | Minimum **30 days** with Firestore intact and the export retained |
| **F8. Remove legacy writes** | **Only with explicit approval.** Do not delete Firestore data at cutover — retire it separately, later. |

---

## Validation strategy

Every step produces a record in `migration_runs`:

```json
{ "counts":     { "read": 412, "written": 412, "skipped": 0, "failed": 0 },
  "validation": { "count_match": true,
                  "checksum_sample": "20 random records compared field-by-field",
                  "order_preserved": true,
                  "anomalies": [] } }
```

- **Count reconciliation** — source vs destination, per collection.
- **Sampled deep comparison** — 20 random records compared field by field.
- **Invariant checks** — no orphaned foreign keys; no duplicate
  `(habit_id, entry_date)`; bucket ordering preserved; no task lost.
- **Manual review** — the user opens a migrated test profile and confirms it
  *looks right*. Automated checks cannot catch "this feels wrong".

A failed validation marks the run `failed` and **blocks the next step**.

---

## Risks specific to this migration

| Risk | Mitigation |
|---|---|
| **Profile contamination migrates as truth** | Phase A1 fixes it first |
| **Orphaned data silently dropped** (`dayNotes` especially — its name closely resembles the live Notebook) | Phase A2 decides explicitly; A3 exports everything first |
| **Notebook cells mangled** by converting mixed plain-text/HTML | E2 preserves bytes exactly; convert in a later, separate step |
| **`scheduledTime` is free text** and may not parse | Keep the raw value in notes; log every failure; never discard |
| **Calendar tokens cannot be moved** without re-consent | D2 plans an explicit re-connect prompt |
| **Dual-write divergence** | Log every mismatch; a divergence rate above threshold blocks the read switch |
| **1 MB ceiling reached mid-migration** | The Phase A census measures headroom; if a profile is near the limit, prioritise it |
| **A partial run leaves half-migrated data** | `migration_id_map` + chunked, restartable steps |
| **Rollback needed after the read switch** | Firestore keeps being written until Phase F8 |

---

## What is explicitly NOT in this phase

- No infrastructure provisioned.
- No production data read, written, moved or deleted.
- No Firebase removal.
- No Today-page or Task-UI work.
- No schema created in a real database.

**This document is a plan awaiting approval.**
