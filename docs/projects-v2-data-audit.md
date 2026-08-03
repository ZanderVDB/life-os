# Projects — data audit (Phase E1)

Two halves: what the Legacy implementation actually is, and what the v2
foundation actually has. Both read from source, not from memory of how it was
designed.

**Legacy was not modified.** Nothing in this phase writes anywhere.

---

## Part 1 — Legacy Projects: the implementation

Legacy calls Projects **`builds`**. There is no separate collection, no
task→project key, and no project→area key. Everything lives in the single
profile document `users/{uid}/data/{profileId}`, in the `builds` array.

### The record

Read from `index.html` (`openProjectModal`, `renderProjectDetail`, `rBuilds`,
`saveProjectHead`, `saveProjectNotes`, `projectTouch`, `migrateProjects`):

| Field | Type | What it is |
|---|---|---|
| `id` | string | Client-generated. |
| `title` | string | Project name. |
| `desc` | string | "What this is" — one paragraph. |
| `notes` | string | Freeform scratch notes. An AI action can rewrite this field wholesale. |
| `status` | `active` \| `future` \| `background` | Shown as "Building now" / "Future" / "Background". |
| `auto` | boolean | Default true. When true, `status` is **recomputed from recency**. |
| `stage` | number | Index into `['Idea','Planning','Building','Testing','Launch','Live','Done']`. |
| `lastTouched` | ms | Set by editing, logging, or tapping "worked on today". |
| `prevTouched` | ms | Undo buffer for the "worked on today" toggle. |
| `date` | `YYYY-MM-DD` | Creation date. |
| `log[]` | `{id,date,content}` | Dated progress entries. |
| `entries[]` | `{date,content}` | Pre-`notes` progress entries; folded into `notes` by `migrateProjects()`. |
| `priority`, `done`, `order`, `createdAt` | mixed | Present in code paths but barely used. |

### Two status systems, and only one is real

`status` is **not a lifecycle**. Unless the user pinned it, Legacy overwrites it
on every render:

```
worked on within  7 days → active
                  7–30   → future
                  30+    → background
```

So `status` is a **recency label**, and `stage` is the actual lifecycle. This is
the most important finding for migration: **importing `status` as a Life OS
status would import a value the user never chose**, for every project where
`auto !== false`. The audit reports the two populations separately for exactly
this reason.

### What Legacy Projects do not have

Checked for, and absent:

- **No link to Tasks.** Nothing anywhere associates a task with a build.
- **No Area.** A build is not classified by workProject.
- **No target date, no start date, no milestones, no progress field.**
- **No people, files, attachments or links.**
- **No calendar relationship.**
- **No archive.** Deletion is permanent and confirmed with `confirm()`.
- **No filtering or search within Projects** (global search finds them; the
  Projects page itself has neither).
- **No completion state** — "Done" is the last `stage`, not a status.

### Behaviour

- **Overview** (`rBuilds`): every project as a card, sorted active → future →
  background. Card shows stage name, title, truncated description, a stage
  progress bar (`stage / 6`), "Last worked N ago", and a log count.
- **Detail** (`renderProjectDetail`): title, description, a 7-step stage
  stepper, status row with an Auto toggle, "Next" line, scratch notes with an
  "✨ Structure with AI" action, and a dated progress log.
- **Creation**: title, status, description. Three fields.
- **AI**: one action — reorganise `notes` into markdown sections via a direct
  browser call to the Anthropic API with a user-supplied key. It **overwrites
  `notes`**. Nothing else in Projects is AI-driven.
- **Mobile**: same cards, single column. No separate treatment.
- **Progress**: `stage / 6` only. Not derived from work, because there is no
  work attached.

### Assessment

Legacy Projects is a **journal of things you are building**, not a project
system. It answers "what am I working on lately" through recency and "how far
along" through a self-declared stage. It cannot answer "what should I do next",
"what work remains" or "what belongs to this", because no work is attached.

That is the gap v2 exists to close, and it is why the Legacy design is not the
target.

---

## Part 2 — Legacy Project data

**The numbers are not in this document, and that is deliberate.** The repo has
no Legacy export (`life-os-export_test.json` is a 17-byte placeholder), and the
data lives in Firestore behind the user's own credentials. Guessing the counts
would be the exact failure mode this project has already been burned by twice.

Instead E1 ships the tooling that produces them:

**`POST /api/v1/workspaces/{ws}/import/legacy/projects/audit`**
Body: `{ "export": <parsed export JSON> }`. Writes nothing. Returns:

- total count, and every project's title, stored status, whether that status was
  derived or pinned, stage, whether it has a description / notes / log, the
  *length* of those fields, last-touched and created dates;
- summary: counts by status, counts by stage, how many have real content, how
  many are empty, duplicate titles, missing ids, unrecognised fields;
- **excluded profile counts** — how many Projects are in the TriFusion/Business
  profile that v2 does not migrate, as a count, never as content;
- **task linkage**: whether any legacy `task.project` value points at a build id
  rather than a workProject id.

### Privacy

The audit returns **titles**, because the user cannot decide what to migrate
without them. It returns **presence and length** for descriptions, notes and log
entries — never their text. This is asserted by a test that plants a marker
string in every body field and fails if it appears anywhere in the output.

The excluded profile is **counted, never read**. `countProfileRecords` touches
array lengths only.

### To produce the numbers

1. Legacy → Settings → export. The file is `life-os-export_<stamp>_…json`.
2. POST it to the audit endpoint on v2 staging with a Firebase ID token.
3. The response is the data audit. It writes nothing and can be run repeatedly.

---

## Part 3 — the v2 foundation

### What exists

| | State |
|---|---|
| `projects` table | **Does not exist.** |
| `tasks.project_id` | **Exists**, `uuid`, nullable, no FK, indexed `(workspace_id, project_id)`. |
| Projects API routes | None. |
| Projects UI | Sidebar item + "Coming soon" placeholder (`routes.js`). |
| Areas | `areas` table, workspace-scoped, unique case-folded name, `legacy_id` map. |
| Task→Area | `tasks.area_id` → `areas.id`, `on delete set null`. |
| Task→schedule | `task_blocks` (task, start, end) — already project-agnostic. |
| Polymorphic links | `calendar_item_links` with `targetType: task \| project \| library \| diary`. |
| Migrations | Drizzle, applied on boot. |
| Tests | 426 passing before this phase. |

### Does any v2 Task retain a Project from Legacy?

**No — and it never could have.** Two separate reasons, both verified:

1. `import-writer.ts` sets `projectId: null` explicitly, with the comment
   *"Projects do not exist. Never infer a relationship that never existed."*
2. More fundamentally, **there was no relationship to carry.** Legacy's
   `task.project` field holds a **workProject id — an Area, not a Project** —
   and `legacy-import.ts` maps it to `area_id`. Legacy tasks were never
   associated with builds at all.

So `tasks.project_id` is null for every row, and that is correct rather than a
gap in the import. Nothing was dropped.

### What is missing

- the `projects` table and its FK from `tasks.project_id`
- CRUD routes, validation, workspace scoping for Projects
- ordering, status transitions, archive/restore
- the derived progress and next-action queries
- a general `item_links` table (or a rename of `calendar_item_links`) for
  Library and Diary relationships

### Isolation

Every table Projects will touch is `workspace_id NOT NULL` with
`on delete cascade`, asserted by test. Projects must follow the same shape;
there is no cross-workspace surface to get wrong yet, and this is the moment to
keep it that way.
