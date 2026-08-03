# Projects — migration plan (proposal)

**Not executed in E1.** This is the plan to approve, not a record of a run.

The Tasks and Habits imports established the pattern this follows: preview
writes nothing, execute demands the approved counts back plus a typed phrase,
and every run leaves an audit row. Nothing here departs from that.

---

## What is actually being migrated

Less than it looks. A Legacy Project is a title, a description, freeform notes,
a dated log, a stage and a recency label. There are **no tasks, no dates, no
areas, no files and no links** to reconcile — see the data audit.

That makes this a small, low-risk import with one genuinely hard decision in it
(status), and one thing that must not be invented (Area).

---

## Field mapping

| Legacy | v2 | Rule |
|---|---|---|
| `id` | `legacy_id` | Unique per workspace. Makes the import idempotent. |
| `title` | `title` | Trimmed. Empty → skipped, reported. |
| `desc` | `description` | Verbatim. |
| `notes` | `notes` | Verbatim. Never re-run through AI. |
| `log[]` | `notes` (appended) or `project_activity` | See below. |
| `entries[]` | — | Already folded into `notes` by Legacy's own migration. Ignored; counted. |
| `stage` | `status` | The real lifecycle. See below. |
| `status` | — | **Not imported.** See below. |
| `lastTouched` | `updated_at` | Preserves "last worked" so the stalled signal is right on day one. |
| `date` | `created_at` | |
| `priority`, `done`, `order`, `prevTouched`, `auto` | — | Not imported. Counted and reported. |
| — | `area_id` | **Left null.** Legacy has no Area on a project; inferring one from the title would be a guess presented as data. |
| — | `outcome` | **Left null.** The field that makes a Project a Project cannot be invented. The UI prompts for it once per project. |

### Status: the one hard decision

Legacy has two overlapping systems, and only `stage` is chosen by the user:

```
stage       Idea  Planning  Building  Testing  Launch  Live  Done
v2 status   Planning ──────  Active ─────────────────────    Completed
```

- `Idea`, `Planning` → **Planning**
- `Building`, `Testing`, `Launch`, `Live` → **Active**
- `Done` → **Completed**

`status` (`active`/`future`/`background`) is **not imported**, because for every
project with `auto !== false` it was computed from recency and never chosen. The
audit reports how many were pinned by hand; if that number is non-zero the user
decides those individually rather than the importer guessing.

**A project last touched 30+ days ago is imported as On hold, not Active**, when
its stage maps to Active. Importing a dormant project as Active would fill the
"what am I working on" list on the first screen the user ever sees.

### The log

Two options, decided before execution:

- **A (recommended):** append to `notes` as `[date] content`, exactly as
  Legacy's own `migrateProjects()` already does for `entries`. Zero new schema,
  nothing lost, and it lands where the user already reads notes.
- **B:** a `project_activity` table. Correct long-term, but the activity feed is
  not in the first release, so it would import data into a table nothing reads.

Recommend A now, B when Activity ships. The log content is preserved either way.

---

## Exclusions

- **The TriFusion/Business profile is not migrated.** Its projects are counted
  and reported, never read. Same rule as the Tasks import.
- **Empty projects** (title only, no description, notes or log) are imported
  only if the user opts in. The audit gives the count first. A project with
  nothing in it is a name you once typed.
- **Duplicate titles** are imported as-is and reported. Merging is a judgement
  the importer must not make.

---

## Execution

1. **Audit** — `POST …/import/legacy/projects/audit`. Writes nothing. Shipped
   in E1 and safe to run today.
2. **Preview** — `POST …/import/legacy/projects/preview`. Returns the exact
   planned rows: which map to which status, which are skipped and why, which
   already exist by `legacy_id`. Writes nothing. *(Built in E2.)*
3. **Execute** — `POST …/import/legacy/projects/execute`. Requires:
   - the approved counts echoed back;
   - the typed phrase `IMPORT <n> LEGACY PROJECTS`, naming the number, so a
     confirmation typed for one preview cannot approve a different one;
   - a source fingerprint matching the audited export.

   Any disagreement stops before the first write.

### Idempotency

`projects.legacy_id` is unique per workspace. A second run finds every row and
writes nothing. The response distinguishes *created* from *already present* —
"12 imported" and "0 imported, 12 already there" must never look the same.

### Audit record

One `migration_runs` row per execution: step `projects`, source fingerprint,
counts, and the outcome. Same table the Tasks and Habits imports use.

### Rollback

Every imported row carries `legacy_id`. Rollback deletes exactly the rows from
one `migration_runs` id — never "all projects". Tasks are untouched by this
import, so rollback cannot orphan anything.

### Verification

After execution: count matches the approved number; every `legacy_id` present
exactly once; no project has an `area_id` (nothing was inferred); no task's
`project_id` changed (this import does not touch Tasks); the excluded profile
contributed nothing.

---

## What this migration explicitly does not do

- link any Task to any Project — there is no source data for it;
- assign Areas;
- invent outcomes, target dates or progress;
- touch Legacy;
- touch Google;
- run in production.
