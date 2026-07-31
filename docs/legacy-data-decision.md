# Life OS — Legacy Data Decisions

**Created 2026-07-31 · Phase A2 · app version v243**

> **NOTHING IS APPROVED FOR DELETION.** Every recommendation below is
> **preliminary**, derived from a code audit plus a structure-only inspection.
> No legacy dataset may be deleted, migrated or cleaned until Zander approves
> it explicitly, dataset by dataset.
>
> **Rollback floor in place:** a VERIFIED export exists (v242 — 2 profiles,
> 4 documents, 3 verified, 98.9 KB). See `firestore-export-restore.md`.

## Update 2026-07-31 — the export is now the v2 input

With the [clean relaunch](v2-relaunch-plan.md), the verified v242 export stops
being only a rollback floor and becomes the **source for v2's first import**.

What the import mapper does, all enforced by tests in `api/tests/import.test.ts`:

- **Reads the Personal profile only**, selected by name. A test proves Business
  is excluded even when it is listed first in the file, so nothing depends on
  ordering.
- **Refuses an unverified export.** Both the browser page and the API check
  `verification.ok` before doing anything.
- **Preserves `legacy_id`**, unique per workspace, so a real import can run
  twice without duplicating anything.
- **Drops retired fields** rather than inventing homes for them
  (`linkedPersonId`, `linkedPromiseId`, `daily`, `dailyDate`, `dailySince`,
  `lastCheckedAt`).
- **Maps `task.project` → Area**, collapsing names that differ only by case or
  surrounding whitespace.
- **Keeps unparseable `scheduledTime` verbatim** in
  `legacy_scheduled_time_raw` instead of guessing or discarding it.
- **Reports counts only.** No task title, note or free-text field appears in the
  response — a test asserts the serialised payload contains none of the source
  text.

**There is no import write path in the code.** The preview is a dry run. Nothing
is deleted from Firestore, and the legacy app is untouched.

---

## ⛔ Profile decision (locked 2026-07-31)

Life OS v2 = **one primary workspace per user**. Personal/Business profile
switching is retired; life categories move to **Areas**.

| Profile | Verdict |
|---|---|
| **Personal** (`main`) | **AUTHORITATIVE.** Its Tasks, Reminders, Habits, Diary, Notebook, Projects, Brain data and settings are migration candidates. |
| **Business** (`p_x9zxkv4`) | **LEGACY — NOT MIGRATED.** Archived in the verified v242 export only. Recorded as *"legacy profile — not migrated."* |

**Inspection evidence of contamination:** 10 reminders and 4 byte-identical
People records exist in **both** profiles — the pre-v240 switching-bug
signature. Because Business is not authoritative, this needs **no
record-by-record ownership review**: Personal wins, Business copies are
excluded.

**Nothing is deleted from Firestore.** Business data is preserved until the
migration and rollback period end.

---

## How to read this

| Verdict | Meaning |
|---|---|
| **KEEP** | Live data. Do not touch. |
| **MIGRATE** | Has a destination in the v2 model. |
| **ARCHIVE** | Not needed live; preserve a copy, then remove from the active product. |
| **EXPORT THEN DELETE** | Superseded; keep a copy for safety, then drop. |
| **DELETE** | Safe to drop outright. *(Nothing is currently marked this.)* |
| **NEEDS CONTENT REVIEW** | Structure alone cannot decide. A separate, explicitly-approved content review is required. |

**Deleting an unused page and deleting its data are separate decisions.**

---

## Summary table

| Dataset | Live UI? | AI can write? | Preliminary verdict |
|---|---|---|---|
| `tasks` | ✅ Today | ✅ | **KEEP** |
| `habits` | ✅ rail + calendar | ✅ | **KEEP** |
| `reminders` | ✅ Today + calendar | ✅ | **KEEP** |
| `routineLog` (diary + routine ticks) | ✅ Diary | ✅ (routine only) | **KEEP** — but must be *split* |
| `builds` (Projects) | ✅ Projects | ✅ | **KEEP** |
| `ideas` / `resources` / `notes` (Brain) | ✅ Brain | ✅ (create only) | **KEEP** |
| `notebook` | ✅ Notebook | ✅ (append page) | **KEEP** |
| **`dayNotes`** | ❌ none | ❌ | **EXCLUDED FROM v2** — empty in both profiles |
| **`people`** | ❌ unreachable | ❌ **FROZEN v244** | **ARCHIVE once, from Personal — not migrated to v2** |
| `peopleTags` / `peopleLevelNames` / `peopleSettings` | ⚠️ Settings only | indirect | **ARCHIVE** (with people) |
| Promises (inside `people`) | ❌ | ✅ | **ARCHIVE** |
| Task→People links (`linkedPersonId`, `linkedPromiseId`) | ❌ | indirect | **ARCHIVE** |
| **`learning`** | ❌ none | ❌ | **EXPORT THEN DELETE** |
| **`customEvents`** | ❌ (force-emptied) | ❌ | **EXCLUDED FROM v2** — empty in both profiles |
| **Board page** | ❌ unreachable | indirect | **DELETE (page only)** — no unique data |
| **Habits page** (`rHabitsFull`) | ❌ unreachable | — | **DELETE (page only)** — habit data untouched |
| Dead task fields (`dailyDate`, `dailySince`, `daily`) | ❌ | ✅ AI still sets `dailyDate` | **EXPORT THEN DELETE** (field-level) |

---

## Dataset detail

### `dayNotes` — **EXCLUDED FROM v2** ✅ *(resolved 2026-07-31)*

**The live inspector confirmed: Personal count 0, Business count 0.** There is
no hidden historical data — the risk that made this the highest-priority
unknown does not exist. **No content review is needed.**

- **Not migrated to v2.**
- The field may be retired during final legacy cleanup, **after** migration
  validation and rollback approval.
- **Not deleted or rewritten now.** The verified v242 export remains the
  historical rollback copy.

*Original analysis retained below for provenance.*
- **Reads:** `loadDailyNote()` runs at boot but **no-ops** — its target `#dn-ta`
  is not in the DOM. `searchNotebook()` has zero callers.
- **Writes:** `saveDN()`, `saveDvNote()`, `navNotebook()` — **all zero callers**.
- **AI:** no operation touches it. **UI:** none — every consumer was removed.
- **Still loaded, still saved, still fingerprinted** on every write.
- **Why it is dangerous:** it may hold years of day notes that no screen shows,
  and its name closely resembles the *live* Notebook (`S.notebook`) — making it
  very easy to migrate or delete the wrong one.
- **Structure alone cannot decide.** The inspector reports entry count, byte
  size, key format, date range and how many entries are structurally empty.
  If populated entries exist, a **separately-approved** content review is
  required before any verdict.
- **Possible destination:** a Library book (`kind: diary` or `notes`).

### `people` (+ tags, level names, settings, promises) — **ARCHIVE**
- **Page unreachable**, but **data is still persisted on every save**, and the
  **AI can still create people and promises** (`addPerson`, `addPromise`).
- Real personal data about third parties → deletion is not reversible in any
  meaningful sense.
- **Known bug:** `lastTogether` is written as an object but read as a date
  string, so the "haven't seen X" nudge silently stopped working.
- **AI writes FROZEN in v244** — `addPerson` and `addPromise` are blocked at
  three layers (schema, scope filter, apply guard). Existing records are
  untouched and still readable. Reversible via one flag.
- **Recommendation:** archive **once, from Personal** (the 4 Business copies are
  duplicates and are ignored), then remove from the active product — **and
  disable `addPerson`/`addPromise` first**, otherwise the dataset keeps growing
  while undecided.
- **Not migrated into Life OS v2.**
- **No v2 destination is planned.** `profile_memberships` in the Postgres model
  is about *account sharing*, not this.

### `learning` — **EXPORT THEN DELETE**
- Merged into `S.habits` long ago by `migrateHabits()` (run-once,
  version-gated), which **empties it**. Still written to Firestore every save.
- **AI:** `logLearning` writes to **habits**, not here.
- If the inspection shows `count: 0` in both profiles, this is the cleanest
  removal in the whole list.

### `customEvents` — **EXCLUDED FROM v2** ✅ *(resolved 2026-07-31)*

**The live inspector confirmed: Personal count 0, Business count 0.**

- **Not migrated to v2.**
- The **destructive clear-on-load behaviour must be retired** when the related
  legacy calendar code is removed — it should not keep running indefinitely.
- **Do not recreate a local-event system under this historic name.**
- **Not deleted now**; no further destructive changes.

*Original analysis retained below for provenance.*
- **Force-emptied on every snapshot** (`S.customEvents=[]`) and then **written
  back as `[]` on every save**. This is an *ongoing, one-way erasure* of legacy
  entries — it has been running since the ghost-event fix.
- Any legacy entries that existed have very likely **already been destroyed**
  in Firestore.
- **The only place they could survive is the VERIFIED export** — and only if it
  was taken before/while entries still existed (unlikely, given how long the
  clear has been running).
- **Do not make further destructive changes.** Confirm current counts (expected
  `0`), then decide whether to stop writing the field at all.

### Board page — **DELETE (page only)**
- **Confirmed: Board has no persisted field of its own.** `rBoard()` renders
  `S.tasks` filtered by `t.dailyDate`; `boardAddSticky()` just opens the task
  modal with `daily: true`.
- Removing the page removes **no unique data and no unique functionality** —
  the bucket model replaced Daily/General.
- The `dailyDate` field on tasks is a *separate* decision (below).

### Old Habits page — **DELETE (page only)**
- `rHabitsFull()` renders into `#learn` inside the unreachable `habits` route,
  yet **still runs on every `rHabits()` call**.
- **Habit data is live and must remain** — only the dead renderer and markup go.
- Its rest-day picker, tier badges and stats are dead UI; if any of that is
  worth keeping, it should be rebuilt in the rail/detail view, not revived.

### Dead task fields — **EXPORT THEN DELETE** (field-level)
- `dailyDate`, `dailySince`, `daily` are remnants of the removed Daily/General
  split. **The AI still sets `dailyDate`** via `addTasks {daily:true}`, and the
  AI prompt still teaches the old model — so this must be fixed in the AI
  schema *before* the fields are dropped.
- `linkedPersonId` / `linkedPromiseId` follow the People decision.
- `dueDate` is **not** dead — it is a real field that simply cannot be saved
  (`technical-debt.md` D2). It must be *fixed*, not removed.

### `routineLog` — **KEEP, but must be split**
- This **is** the live Diary. It holds `journal` (the five answers) **and**
  `checks` (routine ticks) in one object per day.
- Before any Library merge, `journal` must be separated from `checks`
  (Postgres: `diary_entries` + `routine_completions`).
- **Do not modify the entangled structure during inspection.**

### `learning` vs `habits` vs `routine` vs `routineLog` — the relationship
| Object | Status |
|---|---|
| `habits` | **ACTIVE** — the live habit system (`checkedDates` is the source of truth) |
| `routine` | **ACTIVE** — the user-editable routine template (Settings) |
| `routineLog` | **ACTIVE** — per-day routine ticks **and** diary journal answers |
| `learning` | **LEGACY** — merged into `habits`, emptied, still persisted |
| Habits *page* | **DEAD UI** over live habit data |
| Diary routine ticks | the `checks` half of `routineLog` — same object as the journal |

**No duplication of habit data exists.** The only duplication is the dead
`learning` array and the dead Habits page renderer.

---

## Cross-profile contamination (pre-v240 bug)

The inspector compares record ids across both profiles for `reminders`,
`people`, `peopleTags`, `tasks`, `habits`, `builds`, `ideas`, `resources` and
`notes`, reporting duplicate-id counts, how many are byte-identical, and which
datasets were in the pre-v240 reset gap.

**Interpretation:** ids are 7 random base-36 characters, so an accidental
collision between two small profiles is effectively impossible. **Any shared id
is strong evidence of contamination** from the pre-v240 profile-switch bug.

**Confirmed by inspection:** 10 reminders and 4 byte-identical People records
are present in both profiles.

**No de-duplication work is needed.** Because Business is excluded from
migration wholesale, the duplicates simply do not travel. Personal is
authoritative. Nothing is removed from Firestore — the duplicates stay there,
and in the export, until the rollback period ends.

---

## Open questions that structure cannot answer

1. **`dayNotes`** — are the populated entries real notes, or generated/empty
   scaffolding? Needs an approved content review.
2. **`customEvents`** — did any legacy entries survive, in the export or
   anywhere? Probably not.
3. **People** — is there anything worth keeping before archiving?
4. **Contamination** — if duplicates exist, which profile is the original?
   (`createdAt` on the profile catalogue and per-record dates may help.)

---

## Status

- Phase A1 (profile isolation) ✅ · A3 (verified export) ✅ · **A2 inspection
  RUN ✅** · profile model decision **LOCKED** ✅
- **No migration has run. Firestore remains the source of truth.**
- **No legacy dataset is approved for deletion.**


---

## Area seeding rule *(locked 2026-07-31)*

Areas replace Personal/Business profiles as the life-classification.

**On migration**
- Migrate **existing valid Areas from the authoritative Personal profile**.
- Guarantee **Personal** and **Work** exist as the two default Areas.
- **Do not auto-seed** Church, Health, Finance, Family, Learning or any other
  optional Area for every user.

**Suggestions, not defaults**
- Optional Areas may later be offered through onboarding or Settings as
  **one-click additions** — never forced defaults.
- **Not built now.** The model and schema simply must support it.

**Integrity**
- Prevent duplicates where names differ only by **case or trivial spacing**
  (normalise: trim, collapse internal whitespace, case-insensitive compare).
- Areas remain **editable and removable**.

**Removal is never destructive**
- Removing an Area **must never delete** the Tasks, Projects, Calendar items,
  Books or Brain items linked to it.
- Linked content is **reassigned to no Area, or to another chosen Area**.
- In the schema this is `ON DELETE SET NULL` on every `area_id`, plus an API
  reassignment step — an Area is a label, never an owner.

---

## Phase A status: **COMPLETE** *(2026-07-31)*

| Step | Status |
|---|---|
| A1 profile contamination fix | ✅ v240 |
| A2 legacy-data inspection + decisions | ✅ v243, decided v244 |
| A3 protected export + verification | ✅ v242 — VERIFIED, the rollback floor |
| A4 Firebase security rules | ⚠️ **still outstanding** — not in this repo |
| A5 data census | ✅ delivered by the A2 inspector |

**No user data has been migrated, deleted or modified at any point.**
