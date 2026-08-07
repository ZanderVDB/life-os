# Life OS — Build Progress

Chronological record of completed work, so any future session can understand
the project's state instantly.

**Read order for a new session:** `../design-system.md` (the constitution) →
this file (where we are) → `design-ideas.md` (captured, not built).

**Audit documents (created 2026-07-31, before Step 4):**
`current-system-audit.md` · `data-model-map.md` · `page-capability-map.md` ·
`integration-map.md` · `technical-debt.md` · `redesign-dependency-map.md`

---

## Current state

| | |
|---|---|
| **Version** | v244 |
| **Rebuild step** | 3 of 17 · audit done · platform v2 designed · **PHASE A COMPLETE** |
| **Next step** | **Phase B — backend + Postgres in staging** (awaiting approval; not started) |
| **Data platform** | Firestore = source of truth · Postgres + R2 **planned, not started** |
| **Tests** | `npm test` — 135 passing |
| **Live** | life-os.web-anchor.com (Railway) |
| **Repo** | `ZanderVDB/life-os` · single-file `index.html` + `sw.js` |

### Rebuild order & status
1. ✅ Global Design System
2. ✅ Navigation & Sidebar
3. ✅ Design Tokens & Animations
4. ⬜ Today Dashboard ← **next**
5. ⬜ Task Detail View
6. ⬜ Calendar
7. ⬜ Projects (full redesign)
8. ⬜ Project Detail Workspace
9. ⬜ Gantt View
10. ⬜ Library (Diary + Notebook merge)
11. ⬜ Brain
12. ⬜ AI Command Centre
13. ⬜ Right Sidebar Widgets
14. ⬜ Settings
15. ⬜ Mobile Experience
16. ⬜ Performance Optimisation
17. ⬜ Final Polish

---

## Log

### 2026-07-30 — V2 design reset
User declared a complete design refresh: forget prior decisions, treat
`design-system.md` as the permanent source of truth, rebuild each area in a
fixed order without skipping ahead, and **challenge** rather than blindly
implement.

---

### Step 1 — Global Design System ✅
**Deliverable:** `design-system.md` (the constitution).

Codified philosophy ("an operating system for your life", the One Rule),
colour, typography, radius, shadows, spacing, animation, interaction and
accessibility rules, the component library, navigation philosophy, and an
explicit *"things we intentionally avoid"* list.

**Decisions locked:**
- **Colour** — one accent system. Purple = interaction/focus/progress/selection/
  primary. Green = success only. Red = destructive/error/urgent only. Greys =
  inactive/secondary/disabled. Brand colours (e.g. Google blue) only inside
  logos/integration marks. **Cyan, amber, gold, decorative blue eliminated.**
  Differentiate via type/space/icon/shape/hierarchy *before* colour.
- **Wordmark** — "Life OS" in Playfair Display, the *only* serif in the app;
  lotus + wordmark = one logo lockup; Inter everywhere else.
- **Library** — premium digital library, no skeuomorphic page-curls.

---

### Step 2 — Navigation & Sidebar ✅ (v238)
- **Sliding active indicator** — a *single* shared purple pill that physically
  glides between nav items (`translateY` only, macOS-style). Never
  disappears/reappears; snaps on first reveal (via `ResizeObserver`, surviving
  the post-sign-in `display:none` flip), glides thereafter.
- **One nav interaction system** — hover brightens + nudges the glyph 1px;
  selected **gains weight** rather than shouting brighter; no pop, no bounce
  (removed `navPop`). Quieter default label weight.
- **Continuous page transitions** — shell persists, main column crossfades.
- **Layout tokens** — `--sidebar-w` / `--rail-w` (future Expanded / Compact /
  Icon-only / Drawer modes).
- **Search** re-architected as a command-palette entry point (not redesigned).
- **Logo** — replaced the looping shimmer with a **one-time** load intro
  (lotus settles → Playfair wordmark eases in), then calm.
- **Accessibility** — restored a visible keyboard focus ring (fixing an earlier
  `outline:none`), arrow/Home/End navigation, Escape closes drawer/rail,
  ARIA labels + `aria-current`, `role="dialog"` on the drawer.

---

### Step 3 — Design Tokens & Motion System ✅ (v239)
Foundation only — no page redesigns, layouts, colours or typography touched.

**Global motion system.** One animation language for the whole app, replacing
the ad-hoc "MOTION LAYER".
- Duration tokens `--d-instant|fast|base|slow|slower` (90/140/200/260/320ms)
- Easing tokens `--e-out` (default), `--e-in`, `--e-inout`, `--e-linear`
- Primitives `--m-lift/-press/-rise/-slide`; composites `--t-hover/-press/
  -focus/-select/-move/-fade`; utilities `.m-enter/.m-fade/.m-scale/.m-stagger/
  .m-spin/.m-skeleton/.m-loading/.m-progress-fill/.m-error-nudge`
- Covers all 21 requested categories (hover → error states)
- **All overshoot easings removed app-wide** — deleted `navPop`, `tabPop`,
  `ckPop` (scaled to 1.2), bouncy `pillIn`, and every
  `cubic-bezier(.34,1.56,…)`. Verified: **0 overshoot curves remain** in any
  stylesheet rule.
- Press standardised `.93 → .97`; hover lift standardised to `-2px`
- Reduced-motion path keeps meaning (short fade) rather than going instant

**Autosave architecture — rubber-banding fixed.**
Root cause found: `handleSnapshot` never checked `snap.metadata.hasPendingWrites`.
Firestore echoed every one of our own writes back — once locally, once on
server ack (twice, because `updatedAt` is a `serverTimestamp()` sentinel that
resolves twice) — and each echo overwrote `S` and forced a **full `render()`**.
That is what stole the caret and jumped the UI backwards.
- Local echoes dropped outright; server echoes skipped via a **stable,
  recursively key-sorted state fingerprint** (`_stateFp`) → **a save now
  causes zero re-renders**
- Genuine *remote* changes are **deferred while the user is typing/dragging**
  (`_isUserBusy()`), applied on `focusout`/`dragend`
- **Coalescing write loop** — 50 rapid edits produce 1 write, with the latest
  payload; edits arriving mid-flight are never lost
- **Failures never revert local state** — exponential backoff (max 6, capped
  30s), resumes on `online`
- **Silent on success**; the pill only speaks on genuine failure
  ("Reconnecting…" / "Offline — changes kept on this device")
- Still refuses to write before initial sync (protects cloud data)
- `is-dragging` flag wired into the task drag handlers

**Verification:** 18/18 extracted-logic tests pass (coalescing, mid-flight
edits, retry/recovery, permanent-failure, re-entrancy, fingerprint stability);
live DOM checks confirm tokens resolve, 0 overshoot curves, save-state machine
behaviour, and busy-detection for typing + dragging. No console errors.

**Docs created:** `design-ideas.md` (roadmap capture) and `build-progress.md`
(this file).

---

### 2026-07-31 — Discovery: full system audit ✅ (no code changed)
A complete read-only audit of the existing product, run before Step 4 so the
redesign can proceed from first principles without losing working behaviour.
Six parallel deep-dives (tasks, calendar/integrations, AI, projects/brain,
diary/notebook, auth/settings/mobile) plus direct structural analysis.

**Produced:** `current-system-audit.md`, `data-model-map.md`,
`page-capability-map.md`, `integration-map.md`, `technical-debt.md`,
`redesign-dependency-map.md`.

**Most consequential findings**
1. **Tasks cannot be linked to Projects.** `task.project` points at an *Area*,
   never at a project — the planned Project Workspace has no foundation.
2. **Due dates cannot be saved** (v233 feature is inert): the only code reading
   the date picker is never called.
3. **Profile switching leaks data** — 4 fields aren't cleared and are retained
   when absent from the new profile, then written into it.
4. **All data is one Firestore record** with a hard 1 MB ceiling; the diary,
   notebook and AI history grow without limit and there is no size guard.
5. **The Diary is not `S.dayNotes`** — it lives in `S.routineLog[date].journal`,
   entangled with routine ticks. `S.dayNotes` is orphaned data still being saved.
6. **Drag-and-drop is desktop-only** — task management is impossible on a phone.
7. **No file/image/attachment capability exists anywhere.**
8. Three pages (Board, Habits, People) are unreachable but still in the file,
   and People data is still saved.
9. The AI has **full write power on the Diary page** (missing from the scope
   table) and applies most changes **with no preview** by default.
10. AI changes are **not atomic**; calendar operations run *after* the local save.

**Also captured to the roadmap:** Task Energy, Focus Mode.

---

### 2026-07-31 — Architecture direction: platform v2 ✅ (design only, no code)

**Decision recorded:** *Life OS v2 will move toward a Railway-hosted backend
with Railway PostgreSQL for structured data and Cloudflare R2 for binary files
and exports. Firebase Auth and Firestore may remain temporarily during a
controlled, reversible migration.*

**Migration status: NOT STARTED. Firestore has NOT been removed. No
infrastructure provisioned. No user data touched.**

**Deployment description corrected.** GitHub + Railway were already in use. The
misleading part was calling Railway a "backend": `server.js` is only a ~50-line
**static file server** with no routes, no database access and no secrets. There
is **no application backend today**. The real change is introducing that tier
and moving trust out of the browser.

**Produced:** `backend-architecture-v2.md`, `postgres-data-model-v2.md`,
`r2-storage-architecture.md`, `storage-migration-plan.md`.
**Updated:** `redesign-dependency-map.md` (new Phase 0.5),
`technical-debt.md` (decision + which risks the move resolves),
`integration-map.md` (deployment clarification), `design-ideas.md`.

**Key decisions**
- **Railway PostgreSQL over Cloudflare D1** — chosen for backend proximity, real
  transactions (AI batches must be atomic) and recursive CTEs (dependency/Gantt
  queries). Not chosen by default; D1 was compared on 11 criteria.
- **Node + TypeScript + Fastify**, one modular service — no microservices.
- **Hybrid API**: REST for resources, RPC-style for actions.
- **Transitional auth**: Firebase ID token verified server-side, mapped to an
  internal `users.id` UUID, so Firebase can be replaced later without touching
  the data model.
- **UUID primary keys** replace today's 7-character random ids.
- **Legacy vocabulary retired**: `builds`→`projects`, `workProjects`→`areas`,
  `task.project`→`tasks.area_id`, and a genuine new `tasks.project_id`.
- **R2 is never the primary database** — Postgres holds metadata + object keys.
- **Backups and user exports are separate features**, deliberately.

**New capability the schema unlocks:** task↔project links, task recurrence,
milestones, dependencies (Gantt), a searchable diary, brain relationships,
attachments, and a real export.

---

### 2026-07-31 — Phase A1: profile-contamination fix ✅ (v240)

**First code change of the v2 programme.** Architecture decisions locked
(Drizzle-only, TypeScript accepted, 5 GB/100 MB quotas, hybrid R2 delivery,
deferred malware scanning, mobile first-class, system-by-system migration) —
see `backend-architecture-v2.md` § LOCKED DECISIONS.

**Root cause.** Reset and hydration each kept their own hand-maintained field
list. `resetStateForNewUser()` omitted `reminders`, `people`, `peopleTags`,
`peopleLevelNames`; the snapshot hydrator used *"if the field is absent from
the document, keep whatever is already in memory"*. Switching to a profile that
had never stored those fields therefore kept the previous profile's values —
and the next save wrote them into the new profile's document. Three more fields
(`notebook`, `calendarDefaults`, `aiConfirmMode`) had the same "keep old"
shape. Separately, `switchProfile` changed `_activeProfileId` **before**
draining pending writes, so an in-flight or debounced save could land the
outgoing profile's state in the incoming profile's document.

**Fix.**
- `defaultProfileState()` — one authoritative factory, **39 profile fields**.
- `PROFILE_STATE_KEYS` / `GLOBAL_STATE_KEYS` — explicit scope separation
  (`soundsEnabled` is device-global and survives a switch).
- `resetProfileState()` — wipes every declared field; `undefined` defaults are
  **deleted** so `'x' in S` stays false.
- `hydrateProfileState(S, d)` — replaced 87 lines of inline hydration.
  **Every branch assigns**; absent ⇒ declared default, never the previous value.
  DOM-free so it is unit-testable.
- `flushPendingSaves()` + `_profileSwitching` barrier — writes are drained to
  the outgoing profile *before* `_activeProfileId` moves, then blocked until the
  target profile has hydrated.

**Tests:** `tests/profile-state.test.js` (`npm test`) — **24 passing**. They
extract the real functions from `index.html` rather than re-implementing them,
and include structural guards so a future field added to the save payload but
omitted from the factory fails the build.

**Not done (deliberately):** no UI redesign, no data migration, no PostgreSQL/R2
provisioning, no Firebase removal, no legacy data deleted.

---

### 2026-07-31 — Phase A3: protected Firestore export ✅ (v241)

**A rollback floor before any legacy-data inspection or migration.**
Read-only, verified, downloaded to the user's device only.

**Added** (all in `index.html`, plus tests):
- `_exportSerializeValue` / `_exportDeserializeValue` — reversible boxing of
  Timestamps, Dates, `undefined`, NaN/Infinity, BigInt, GeoPoint, refs, bytes,
  circular refs. **Unknown/legacy fields are preserved verbatim.**
- `_exportStableString` / `_exportCountFields` / `_exportSha256` — canonical
  form, field counts, real SHA-256 fingerprints.
- `_exportVerify` — 11 checks, including a **second independent server read**
  compared fingerprint-for-fingerprint.
- `buildFirestoreExport` — reads the **entire `data` subcollection** from the
  server (`get({source:'server'})`), so `_index`, every profile, presence and
  any unknown document are captured.
- `losExport()` + a `?export=1` guarded panel. Not in the normal product UI.
- `.gitignore` created — export filename patterns can never be committed.

**Read-only guarantees** (asserted by tests against the shipped code): no
`set`/`update`/`delete`/`add`, no `FieldValue`, no `svAll`, no hydration into
live state, no `localStorage` write, no network transmission.

**Privacy:** stays on device · no content in console output or the summary ·
filename carries a SHA-256 fingerprint, never the email or raw uid · never sent
to any AI service · git-ignored.

**Tests:** `tests/export-serialization.test.js` — **33 passing**, synthetic data
only. Total suite now **57 passing** (`npm test`).

**Docs:** `firestore-export-restore.md` — format spec, restore procedures
(all / one profile / test project), overwrite-vs-merge, cross-user guards,
schema-version handling, rollback procedure, honest limitations.

**Status: no migration has run · Firestore remains the source of truth ·
legacy-data inspection (A2) still pending · the export is a rollback asset,
not the future storage architecture.**

**Still to run:** the user must perform one real export on live data. The tool
is verified against its own code path with synthetic documents; it has not yet
been exercised against a live Firestore account.

---

### 2026-07-31 — A3 follow-up: export verification failure diagnosed ✅ (v242)

**The first live export ran and reported FAILED** (2 profiles, 4 documents,
95.1 KB). Diagnosed as a **false failure caused by a verifier design flaw** —
not a data-integrity problem.

**Root cause.** The `presence` document (`users/{uid}/data/presence`) is
rewritten **every 10 seconds** by `_presenceHeart`, with a `serverTimestamp()` —
including by the very tab running the export. The verifier compared two
consecutive server reads and required *every* document's checksum to match, so
a heartbeat landing between the reads failed `fingerprints_match_second_read`.
Applying a point-in-time integrity check to a continuously-rewritten document
was the bug. (A second, rarer path existed too: `_migrateTaskBuckets()` runs
inside `rTasksV2()` and can call `svAll()`, so the app could write to its own
profile document mid-export.)

**Presence policy — option B.** Volatile documents are now exported as
**informational metadata only** (path, role, field names, count, size), content
deliberately omitted and recorded as such (`contentOmitted`, `omissionReason`,
plus a top-level `volatileDocuments` list), excluded from verification and
marked `restorable: false`. **Unrecognised documents are NOT treated as
volatile** — they are captured and verified in full so anything new fails loudly.

**Also added**
- **Concurrent-write detection**: if a document's checksum changes *and* its
  `updatedAt` advances, that is a genuine write → `FAILED — CONCURRENT CHANGE
  DETECTED` (retryable). If the checksum changes but `updatedAt` does *not*,
  that is `FAILED — DATA MISMATCH` (genuinely concerning). The old verifier
  could not tell these apart.
- **Six explicit statuses**: VERIFIED · DATA MISMATCH · INCOMPLETE EXPORT ·
  CONCURRENT CHANGE DETECTED · SERIALISATION ERROR · UNKNOWN.
- **Failure reporting**: every failed check now shows category, affected
  document path, expected vs actual, and a plain explanation — counts, paths,
  truncated hashes and field names only, **never content**.
- **Quiescence + retry**: waits for pending saves to settle before reading, and
  retries up to 2 extra times **only** for concurrent-change failures. Never
  declares success after mismatched reads.
- **Document-set stability** and **orphaned-document** checks (new).
- **Local diagnostic reader** (`?export=1` → *Inspect a saved export…*): reads a
  downloaded file from disk entirely in-browser — no uploads, no network, no
  Firestore, no writes, nothing retained, no content shown.

**Verifier not weakened.** The only check removed is the one measuring
volatile, non-restorable metadata. Every integrity check on real user data is
unchanged, and three new checks were added.

**Tests:** 51 passing in the export suite (was 33), including a direct
reproduction of the live failure. Full suite **75 passing** (`npm test`).

**The earlier failed export is superseded** — it should be replaced by a fresh
run on v242, not relied on as a rollback floor.

---

### 2026-07-31 — Phase A2: legacy data inspector ✅ (v243)

**Read-only, structure-only.** Answers "what legacy data exists and is it safe
to retire?" without ever revealing what any of it says.

**Added** (`index.html`): `_inspHash`, `_inspBytes`, `_inspShape`,
`_inspScanDates`, `_inspDataset`, `LEGACY_REGISTRY` (static provenance from
the audit), `LEGACY_TASK_FIELDS`, `buildLegacyInspection()`, `losInspect()`
+ `_download`, `_maybeShowInspectPanel()` (`?inspect=1`).

**Reports:** per-profile size, % of the 1 MB ceiling, field counts, schema
version, populated/empty/unknown top-level fields, date ranges; per-dataset
counts, bytes, date ranges, value shapes, structurally-empty counts, code paths
that still read/write it, AI writability, reachable UI, migration destination,
deletion risk and a **preliminary** recommendation; plus a cross-profile
contamination check.

**Confirmed by code inspection:** the **Board page has no persisted field of
its own** — it renders `S.tasks` filtered by `t.dailyDate`, so removing the
page removes no unique data.

**Privacy:** structure only — field names, counts, bytes, date ranges, shapes,
hashed ids, classifications. Never task titles, diary text, notebook text,
names, notes, reminders or descriptions. Tests assert that synthetic records
containing obvious secret markers produce a report containing none of them.

**Read-only guarantees** (static analysis, comment/string-stripped): no
Firestore writes, no autosave, no hydration, no migrations, no `render()`,
no network, no localStorage writes, server reads only, volatile documents
excluded.

**Tests:** `tests/legacy-inspector.test.js` — **35 passing**, synthetic data
only. Full suite **110 passing**.

**Docs:** `legacy-data-decision.md` — per-dataset verdicts, all **preliminary**.
**Nothing is approved for deletion.**

---

### 2026-07-31 — Architecture decision: ONE WORKSPACE PER USER ✅ (docs only)

**A2 inspection was run.** It confirmed the pre-v240 contamination signature:
**10 reminders** and **4 byte-identical People records** present in *both*
profiles.

**Decision locked:**

> *"Each signed-in user has one primary Life OS workspace. Personal, business,
> church, health, finance and other parts of life coexist inside the same
> workspace. They are separated through Areas, Projects, tags, calendars,
> Library books, filters and saved views — not through profile switching."*

**Why:** Life OS exists to connect a whole life, not split it in half. The
two-profile model divided it *and* leaked data between the halves.

**Model (four separate concepts):** authentication = who is signed in ·
workspace = which body of data · **area = which part of life** · project =
which outcome. Never use auth or workspaces to organise personal vs work.

**Schema changes (design only):**
- `profiles` → **`workspaces`** (`kind: primary|shared`; unique primary per
  user), `profile_memberships` → **`workspace_memberships`**
- **`profile_id` → `workspace_id`** across all 30+ tables
- `profiles.mode` (personal/business) **removed** — AI context now comes from
  the item's Area, not a global mode flag
- **`areas`** promoted to the life-classification, carried by every
  classifiable table; Areas never gate access and never cascade-delete content
- API routes `/profiles/:profileId` → **`/workspaces/:workspaceId`**;
  `resolveProfile` → `resolveWorkspace`

**Migration rule:** **Personal (`main`) is authoritative and migrates.
Business (`p_x9zxkv4`) is legacy and is NOT migrated** — archived in the
verified v242 export only, recorded as *"legacy profile — not migrated."*
The contaminated duplicates therefore need no record-by-record review: they
simply do not travel.

**Future collaboration stays possible** (company/team/family/client
workspaces) but ships no switcher in v2.

**Nothing changed in the app.** The live switcher is untouched; no data was
deleted, migrated or modified. Profile switching retires at v2 cutover.

---

### 2026-07-31 — Phase A closeout ✅ (v244) — **PHASE A COMPLETE**

**Legacy decisions finalised from the live inspection:**
- **`dayNotes` — EXCLUDED from v2.** Confirmed **0 entries in both profiles**.
  The feared years of invisible notes do not exist, so **no content review is
  needed**. Field retired at final cleanup only; not deleted now.
- **`customEvents` — EXCLUDED from v2.** Confirmed **0 in both profiles**. The
  destructive clear-on-load must be retired with the legacy calendar code, and
  a local-event system must never be recreated under this name.

**CODE — legacy People/Promise AI writes FROZEN.**
The People dataset is excluded from v2 but the AI could still grow it. Now
blocked at **three layers**:
1. **Schema** — `_allowedOps()` removes `addPerson`/`addPromise` from every
   scope, so the model is never told they exist (Today: 20 → 18 ops).
2. **Scope filter** — `_scopeFilterCh()` strips them from any change set.
3. **Apply guard** — `_stripFrozenPeopleOps()` runs at the top of
   `applyChanges()`, before any mutation or save; a People-only request returns
   early **without saving**.

Existing records are **untouched and still readable**; nothing is deleted,
rewritten, or redirected into another system. Every unrelated operation
(tasks, reminders, habits, projects, notes, events, routine, notebook) is
unaffected. **Reversible via one flag:** `LEGACY_PEOPLE_FROZEN = false`.

**User-facing message:** *"The People feature has been retired and is no longer
accepting new records. Your existing entries are unchanged."* — shown alone for
a People-only request, appended when other changes did apply, and recorded in
AI history as `blocked — People retired`.

**Area seeding rule locked:** migrate existing Areas from Personal; guarantee
**Personal** and **Work**; **no auto-seeding** of optional Areas (one-click
suggestions later); case/whitespace duplicate prevention; **removing an Area
never deletes linked content** — it reassigns it (`ON DELETE SET NULL`).

**Business profile rule unchanged:** legacy, excluded entirely, preserved in
the verified v242 export and Firestore rollback period. Not deleted.

**Tests:** `tests/people-freeze.test.js` — **25 passing**. Full suite **135**.

### Phase A status: COMPLETE
| Step | Status |
|---|---|
| A1 profile contamination fix | ✅ v240 |
| A2 legacy-data inspection + decisions | ✅ v243 / v244 |
| A3 protected export + verification | ✅ v242 VERIFIED — the rollback floor |
| A4 Firebase security rules | ⚠️ **outstanding** — carried into Phase B |
| A5 data census | ✅ delivered by the A2 inspector |

**No user data has been migrated, deleted or modified at any point.**
**Phase B is NOT started.**

---

## Known issues / debt
- Some labels still sit below the 11px type floor (design-system §3) — fix as
  each screen is rebuilt.
- Semantic colours (cyan/amber/gold) are eliminated *by policy* but still
  appear in some unrebuilt screens; they retire as each step lands.
- `_stateFp()` stringifies render-relevant state per snapshot — cheap versus a
  full re-render, but revisit if state grows very large (step 16).

## Deploy
Bump `APP_VERSION` (index.html) **and** `CACHE` (sw.js) together, then:
```
railway up --detach --service life-os
git push origin HEAD:main
```

---

# v2 CLEAN RELAUNCH — baseline delivered

**Decision (2026-07-31):** stop migrating the legacy app system-by-system.
Build a clean v2 baseline on Railway and relaunch from it. The legacy app keeps
running untouched. Full reasoning in [v2-relaunch-plan.md](v2-relaunch-plan.md).

This supersedes the phased in-place migration described earlier in this file.
Phases A1/A2/A3 still stand — the verified v242 export is the input to v2.

## Delivered

### Backend — `/api`
Node + TypeScript + Fastify + Zod + Drizzle + Pino, as locked in Phase 0.5.

- **9 tables**, one generated migration `api/drizzle/0000_baseline.sql`:
  `users`, `workspaces`, `workspace_memberships`, `areas`, `tasks`,
  `task_steps`, `task_activity`, `user_preferences`, `migration_runs`
- **Auth:** Firebase ID tokens verified against Google's public JWKS.
  **No service-account key exists or is needed.**
- **Endpoints:** `/health`, `/ready`, `/health/version`, `/api/v1/me`,
  Areas CRUD, Tasks CRUD + `/complete` `/uncomplete` `/archive` `/move`,
  task steps, and `POST …/import/legacy/preview` (counts only, writes nothing)
- **Local dev:** `npm run dev:local` runs the whole API on PGlite. No database
  to provision, no Docker, no cloud account. In-memory, discarded on exit.

### Web — `/web`
- `index.html` — Today shell: four buckets, task cards, detail panel, Move menu
- `app.js` — all API calls; **no Firestore code exists in v2**
- `import.html` / `import.js` — dry-run preview of a verified v242 export
- `config.js` — ships with `FILL_ME_IN` placeholders and fails loudly

### Tests — 55 passing, real Postgres via PGlite
| File | Tests | Covers |
|---|---|---|
| `api/tests/schema.test.ts` | 15 | constraints, isolation, cascade rules |
| `api/tests/api.test.ts` | 14 | routes, auth, validation, ordering |
| `api/tests/import.test.ts` | 19 | mapping, Business exclusion, idempotency |
| `api/tests/web-contract.test.ts` | 7 | the exact fields `/web` reads |

`web-contract.test.ts` exists because the web app is plain JS and never imports
a type from the API — nothing else would catch a rename. It earned its keep
immediately: it caught the import page rendering four fields the API has never
returned.

## Bugs found and fixed during browser verification

1. **Empty body + JSON content-type → 400.** `api()` sent
   `Content-Type: application/json` on every request including the ones with no
   body. Fastify rejected those before routing, silently breaking `/complete`,
   `/uncomplete`, `/archive` and every DELETE. The `inject()`-based tests never
   reproduced it because they don't set that header.
   Fixed on both sides: the client only sends the header when there is a body,
   and the server now parses an empty JSON body as `{}` instead of erroring.
2. **Fastify 4xx reported as 500.** The error handler only special-cased
   `ZodError` and `ApiError`; everything else became a 500. Framework errors
   that already carry a correct 4xx now keep it.
3. **`animation-fill-mode: both` beat `.task.done`.** An animation's applied
   value outranks a normal declaration, so `to{opacity:1}` permanently won over
   `.task.done{opacity:.55}` — completed tasks stopped looking dim once the
   entry animation finished. All fill modes changed to `backwards`.
4. **Move button was hover-gated on touch.** `@media (hover:none)` alone misses
   tablets that report `hover: hover`. Now also keyed on `pointer: coarse` and
   viewport width, with 44px tap targets — the non-drag path must never be
   unreachable.

## Verified end-to-end in a browser against the live API
Create with due date / priority / area, add step, complete (persisted with
`completed_at`), delete, `Alt+↓` reorder (position 2000 → 4000), Move menu
between buckets, `Alt+←` bucket shift, mobile layout at 375px with no
horizontal scroll.

## NOT done — needs your account
**No Railway resources were created.** No service, no database, no variable.
Every remaining step is in [staging-setup.md](staging-setup.md).

## NOT built — deliberately
Calendar, Projects, Library, Brain, AI, file uploads, and the import **write**
path. Preview only, by instruction.

---

# STAGING PROVISIONED AND VERIFIED — 2026-07-31

Deployed commit: `dfda653` (+ `8e4e585`, `b4873dd`, `e5e75db`, `0ba1bd0`,
`b127e04`, `5285bbb`, `a7b564e`).

## Railway resources created

All inside project `life-os`, environment **`v2-staging`**. Legacy's
`production` environment and its `life-os` service were not touched.

| Service | Purpose |
|---|---|
| `life-os-v2-postgres-staging` | Postgres. 9 tables, 29 indexes. |
| `life-os-v2-api-staging` | Fastify API, root dir `api`, Railpack, Node 22. |
| `life-os-v2-web-staging` | Static shell, root dir `web`, runtime config. |

- API: `https://life-os-v2-api-staging-v2-staging.up.railway.app`
- Web: `https://life-os-v2-web-staging-v2-staging.up.railway.app`

Variables (names only): API — `NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`
(Railway reference, never copied), `FIREBASE_PROJECT_ID`,
`CORS_ALLOWED_ORIGINS`. Web — `API_BASE_URL`, `FIREBASE_API_KEY`,
`FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`.
`PORT` and `DEV_AUTH_BYPASS` deliberately absent.

## Problems found before provisioning, all fixed

1. **`rootDir: "."`** made tsc emit `dist/src/index.js`, so the start command
   `node dist/index.js` had nothing to run. Found by simulating the Railway
   build locally rather than discovering it on the first deploy.
2. **The migration ran through `tsx`**, a devDependency. Railpack ships a
   production-only runtime layer, so it would have been absent. Now compiled JS.
3. **`npm run typecheck` excluded the tests**, and `tsx --test` only strips
   types — nothing type-checked them at all. Added `tsconfig.test.json`; it
   immediately found two real errors.
4. **TLS was forced on every non-localhost host.** Railway's `DATABASE_URL`
   points at `postgres.railway.internal`, which does not serve TLS, so this
   would have failed to connect. Verified against both real URL shapes.
5. **`iat` and `auth_time` were never validated.** jose does not check either
   by default, but Firebase's spec requires both to be in the past.
6. **Logs could leak private content** — redaction covered credentials but not
   task titles, notes, emails or export bodies.
7. **Cold-boot race**: Railway's private network needs a moment, and the
   migration runs immediately. Now retries connection errors only.

## End-to-end results

Verified against real Railway Postgres from a real browser session.

| Check | Result |
|---|---|
| Web loads, no console errors | PASS |
| Google sign-in | PASS |
| Token accepted by the API | PASS |
| `/health`, `/ready`, `/health/version` | PASS — `database: ok`, Node v22.23.1 |
| `/api/v1/me` | PASS |
| Exactly one user / workspace / owner membership | PASS — 1 / 1 / 1 |
| Personal + Work seeded | PASS |
| Refresh and repeat sign-in create no duplicates | PASS — counts unchanged |
| Task create, edit, steps | PASS |
| Due date saves and renders | PASS — stored `2026-08-14`, renders `Fri Aug 14 2026` |
| Bucket movement via the Move button | PASS — three `moved_bucket` entries |
| No Firestore code in the client | PASS — imports only `firebase-app` and `firebase-auth` |
| Legacy still online | PASS — HTTP 200, still `v244` |
| Rows created by anything other than authenticated requests | NONE |

Not exercised on staging: uncompletion, reorder-within-bucket, keyboard
movement and the touch-viewport Move menu. All are covered by the automated
suite and were verified in a browser against the local API.

**A PGlite-vs-postgres-js difference was specifically checked**: `date` columns
come back as `YYYY-MM-DD` strings through Drizzle on real Postgres, matching the
test environment. Had they returned `Date` objects, every due date would have
rendered "Invalid Date" and no test would have caught it.

## Import preview — RUN, NOT IMPORTED

Source: the verified v242 export. **Nothing was written. `migration_runs` = 0.
Every task in staging has `legacy_id = null`.**

| | |
|---|---|
| Profile chosen | Personal |
| Profile ignored | **Trifusion** (28 records) — never read |
| Tasks | 71 · today 53, week 5, month 6, future 7 |
| Priorities | medium 26, high 20, urgent 15, low 7, someday 3 |
| Areas | 2, none merging into the defaults |
| Steps | 20 |
| Already completed | 50 |
| With a due date | **0** |
| Time kept verbatim | 15 |
| Duplicate legacy ids | 0 |
| Skipped | none |

Deferred systems present but not imported: reminders 10, habits 5, diary 50,
notebook 3, projects 12, brain ideas 2, brain notes 1, people 4.

Retired fields dropped: `dailySince` 37, `dailyDate` 36, `lastCheckedAt` 6,
`prevCheckedAt` 6. No task carries `linkedPersonId` or `linkedPromiseId`.

### Two findings worth recording

- **The second profile is named "Trifusion", not "Business".** Every earlier
  document said Business. Selection was never affected — `chooseProfile()`
  identifies Personal positively and excludes everything else, so the name of
  the excluded profile is irrelevant. Tests now assert this across several
  names, including a "Personal Admin" decoy.
- **Zero tasks have a due date.** Investigated rather than assumed: legacy has
  exactly one write site, `t.dueDate = v` from an `<input type="date">`, whose
  value is always `YYYY-MM-DD` — precisely what the importer accepts. There is
  no format mismatch, so the zero is real.
- Both profiles hold identical People and reminder counts, consistent with the
  cross-profile contamination found in Phase A2. Both are excluded regardless.

---

# IMPORT WRITER BUILT AND DEPLOYED TO STAGING — 2026-07-31

Preview approved: Personal authoritative, Trifusion excluded, 71 tasks (21
active / 50 completed), 20 steps, 2 Areas, 0 duplicates, 0 due dates, 15
scheduled-time values kept verbatim.

**The real import has NOT been run.** The writer is deployed and waiting at the
confirmation screen.

## What was built

- `api/src/lib/import-writer.ts` — transactional writer, source fingerprint,
  approved-count gate, position assignment, staging-only cleanup.
- `api/src/routes/import.ts` — `/import/legacy/execute`, `/import/legacy/runs`,
  `/staging/cleanup/preview`, `/staging/cleanup`.
- `api/src/routes/tasks.ts` — `status` filter, pagination and a `total`, so the
  History view can page rather than loading everything.
- `web/app.js` — buckets show ACTIVE work only; a History view, paged 25 at a
  time, newest-first.
- `web/import.js` — final confirmation screen requiring the typed phrase
  `IMPORT 71 TASKS`, plus a result screen.

## Completed-task handling (as approved)

All 50 completed tasks import as history. `completed_at` comes from legacy
`doneAt` where present. **Where `doneAt` is missing, `completed_at` is left
NULL** — a stand-in date would be invented precision. Those rows show "date
unknown" in History and sort last. Completed tasks never appear in the four
active buckets and never count toward a bucket badge.

## Idempotency and rollback

One transaction covers Areas, tasks, steps, activity and the `migration_runs`
row, so a failure leaves the database exactly as it was and a retry cannot
duplicate. A SHA-256 fingerprint of the export (header + Personal document only,
so an ignored profile cannot make an imported file look new) is recorded; the
same file is refused on a second attempt. A refused import is written to
`migration_runs` outside the transaction, so the audit trail survives.

## Staging cleanup — deliberately not a reset

Tasks only, named explicitly by the caller, never rows carrying a `legacy_id`,
never in production, and requiring the typed phrase `DELETE N STAGING TASKS`.
Users, workspaces, memberships and Areas are unreachable through it.

## Bugs found while building this

1. **`z.coerce.boolean()` made `?includeCompleted=false` mean TRUE.** Zod's
   coercion is `Boolean(value)`, and the string `"false"` is truthy — so that
   filter had never worked. Replaced with a parser that reads query strings.
2. **JS was served with a 5-minute cache.** Filenames carry no content hash, so
   after a redeploy a browser would keep running the old `app.js` against the
   new API for up to five minutes. HTML, JS and JSON are now `no-cache`. This
   was found because it bit the local verification first.

## Verified locally, end to end

A synthetic export with the same proportions as the real one (71 tasks, 50
completed, 21 active, 2 Areas, buckets 53/5/6/7, 15 unparseable times) was run
through the whole browser flow: preview, confirmation screen, typed-phrase gate
(four wrong variants stayed disabled, the exact phrase enabled), import, result
screen, buckets, History pagination and re-import refusal.

- Buckets: 7 + 1 + 6 + 7 = **21 active**, zero completed cards.
- History: 50 total, 25 per page, newest first, unknown dates marked and last.
- Re-import: 409 `IMPORT_REFUSED`, `wroteAnything: false`, still 71 tasks.

96 tests passing.

---

# PHASE C1 — APPLICATION SHELL AND PWA RESTORED — 2026-07-31

**The v2 baseline UI was a temporary functional prototype, not the product.**
It proved the API and the data; it was never the Life OS experience. The full
shell is now restored around it, inside the locked design system.

## What was restored

| Element | State |
|---|---|
| Left sidebar | Logo lockup, command-palette entry, 8 destinations, sliding indicator, account footer |
| Main content region | Persistent header + crossfading content column |
| Right rail | 6 cards, first-class on desktop, reflows below content on tablet/mobile |
| Global AI composer | Position and treatment restored, visibly **disabled** |
| Settings | New route: appearance, motion, sounds, account, workspace, Areas, app/version/updates |
| Placeholder routes | Calendar, Projects, Diary, Library, Brain |
| Mobile shell | Drawer navigation, 44px targets, no horizontal overflow |
| PWA | Manifest, icons, service worker, install prompt, update flow |

## Shell architecture

The sidebar, rail and composer render **once**. A route change replaces only
`.main-scroll` and moves the nav indicator — a test asserts `loadRoute` never
touches `root.innerHTML` or calls `renderShell`. That is what makes transitions
continuous rather than a full-page flash.

The indicator is a single element moved with `translate3d` on the Y axis only,
transitioning `transform` at 200ms — the locked timing. It snaps on first
reveal and glides after.

## Right rail contents

Date · active-work counts · Area filters with live counts · quick-add. Habits
and Up-next are present but explicitly marked **not connected**, with copy
saying the data is safe in the legacy export. **No card shows invented data.**

## Settings persistence boundaries

| Scope | Where | What |
|---|---|---|
| Account | `user_preferences` via `/api/v1/preferences` | appearance, motion, sounds |
| Device | `localStorage` / `sessionStorage` | API override, dev token, update postponement, rail state |

Preference keys are allow-listed server-side; an unknown key or an invalid value
is a 400 rather than a silently stored row.

## Bugs found and fixed during this phase

1. **The nav indicator was positioned off-screen.** `offsetTop` is already
   measured from the positioned `.nav`, so also subtracting `nav.offsetTop`
   pushed the pill to −122px. Found by measuring, not by looking.
2. **The indicator could freeze permanently.** Releasing the no-transition class
   used `requestAnimationFrame`, which is suspended entirely while a tab is in
   the background — anyone opening Life OS in a background tab would have got a
   pill that never moved again. Now a timer, which still fires.
3. **CORS blocked every preference write.** The allowed-methods list was
   `GET, POST, PATCH, DELETE, OPTIONS` — **`PUT` was missing**, so Settings
   failed at the preflight. Invisible to server-side tests; only a real browser
   shows it. Now tested for every verb the client uses.
4. **Touch targets under 44px** across nav, chips, the tick, task titles, rail
   filters, and the mobile bar buttons — which flex had squeezed to 32px wide.
   Where a 44px control would wreck the layout, the visible size is kept and the
   hit area extended with a transparent overlay.

## PWA

Full lifecycle documented in [pwa-v2.md](pwa-v2.md). The essentials: the cache
name is **derived from the build id, never hand-typed** — which is what caused
the legacy stale-cache problem — the worker never activates itself, and the
user is asked before any reload.

**Nothing from the API is ever cached.** Enforced in three independent places.
Offline shows an honest message rather than an empty app, because caching task
text would write private content to disk in plaintext.

Verified across two successive builds: install → wait → prompt → Later → Update
→ single reload → old cache deleted, with no reload loop.

## Boundaries respected

No Firestore read or write. No Trifusion access. No new legacy system imported.
No task data altered. Legacy untouched. 116 tests passing.

---

# PHASE C2 — LEGACY VISUAL PARITY — 2026-07-31

**Root cause of the C1 regression: the shell was reconstructed from
`design-system.md` instead of ported from the Legacy stylesheet.**

The design system carries principles. It does not carry the numbers — a 56px
gutter, a 380px rail, a 2200px ceiling, a 1544px composer. Rebuilding from
principles produced something that satisfied every written rule and still
looked nothing like the approved product.

Full measurements in [legacy-v2-visual-parity-audit.md](legacy-v2-visual-parity-audit.md).

## The single biggest error

Legacy nests the content and rail inside the main column:

```css
.app       { grid-template-columns: var(--sidebar-w) 1fr; }
.main-wrap { grid-template-columns: minmax(0,1fr) var(--rail-w);
             gap:56px; padding:32px 32px 140px 44px;
             max-width:2200px; margin:0 auto; }
```

C1 flattened that into one three-column grid with no gutter and no max-width.
That one omission produced the dead centre, the detached rail, the compressed
buckets and the "admin dashboard" feel. **Every reported symptom traces to it.**

## Ported from Legacy verbatim

Sidebar 232 · rail 380 · gutter 56 · content max 2200 · padding 32/32/140/44 ·
section gap 28 · rail gap 14, sticky at 22 · buckets 3×`minmax(0,1fr)` gap 20 ·
bucket radius 16, padding 15/14/13 · row gap 7 · count chip border · empty
states 12px italic · dashed empty drop zones · h1 34px/−1px · sub 13px muted ·
page header a baseline row with actions right · nav gap 5, items 44px, icon box
22 · indicator fixed 44px with its OWN gradient `#7C4DFF→#9A67FF` · composer
`left:232 right:0`, capped 1544 centred, `#17161F` + blur + `1px #353046`
border, full opacity.

**The task row was already at parity** — `#282431`, radius 12, padding
11/14/11/16, 13px title, 4px stripe. It looked small because the container was
wrong, not the type.

## Right rail — reworked

Was: five cards, two of them reading "not connected" and "safe in the legacy
export". That is staging status, not a product.

Now: **Today** (date + next-up task), **Your day** (counts), **Areas** (live
filters), **Recently finished** (last three, links to History), quick add. No
migration commentary anywhere in the everyday UI — a test now enforces that.

## Settings — restored to Legacy's tabbed structure

Six tabs over Legacy `.setting-row` cards: Account · Appearance · Areas · App ·
Integrations · Privacy & data. Appearance has a live swatch preview. Areas can
now be **renamed and removed**, with removal explaining that tasks are kept.
App gives browser-specific install steps. Integrations lists only what exists.

## App icon — new, versioned

A compact application mark: the lotus alone on a graphite tile with a purple
halo. No wordmark — it is unreadable at 32px. The maskable variant is a separate
drawing, not the same art rescaled, because Android crops to a circle.

Seven PNGs, all `.v2.` filenames so no cached old icon can be served:
192, 256, 512, maskable 192, maskable 512, apple-touch 180, favicon 32.

## Bugs found in C2

1. **CRLF defeated the test comment-stripper.** `//.*$` never matched because of
   the trailing `\r`, so the service-worker test read its own
   "Deliberately NOT skipWaiting()" comment as the call it forbids.
2. Two shell tests still asserted the C1 layout and copy, and one directly
   contradicted the new no-staging-language rule.

121 tests passing. Task data untouched. Legacy untouched.

---

# PHASE C3 — TODAY, RIGHT RAIL AND HABITS — 2026-07-31

The shell geometry from C2 is the foundation; this phase improves on Legacy
rather than copying it further.

## Navigation

Primary sidebar is now six destinations: **Today · Calendar · Projects · Diary
· Library · Brain.**

- **Completed** left the sidebar. Finished work is content history, not a
  section of a life. It is reached from a quiet button beside the Today heading
  (with a count) and from the account menu, and `#history` remains a real
  bookmarkable route.
- **Settings** left the sidebar. It is account-level, so it lives behind the
  account block at the bottom-left — a proper menu with arrow-key, Home/End and
  Escape support, outside-click dismissal, and a confirmed sign-out placed last
  behind a divider.
- Unfinished sections now carry **one 5px dot**, not five repetitions of the
  word "soon".

## Right rail — rebuilt around a question

"What needs my attention next, and what can I act on quickly?"

Removed: the oversized date card, generic activity statistics, the full Area
dashboard and the completed-task summary — all of it repeated what Today
already showed on screen.

Now: a one-line date, **Up next**, **Habits today**, **Quick capture**.

**Upcoming is deliberately absent.** There is no calendar yet and every
imported task has zero due dates, so the card would have been a permanently
empty panel. Quality over filling a slot.

### Up next
Deterministic and explainable — each branch returns the reason, which the card
displays: scheduled → urgent today → high today → first in Today → first this
week → first open. Raw legacy time strings show as italic legacy text, never
dressed up as a real timestamp.

## Habits — a real v2 system

Two tables, `habits` and `habit_entries`, migration `0001_habits`.

**Deliberately not tasks, and deliberately not entangled with the diary.** The
legacy app kept habit checks inside `routineLog` next to journal text, which
made both impossible to reason about.

`habit_entries` is unique on `(habit_id, entry_date)` — ticking twice updates a
count rather than inserting a row, which is also what makes the import
idempotent. Undo deletes the row rather than storing a zero, because an absent
entry and a zero entry would otherwise both mean "not done".

Deleting a habit **archives** by default: a habit's value is its history.

## Habits import — preview built, NOT run

History comes from each habit's own `checkedDates` — explicit and unambiguous.

**`routineLog` is never mined for completions.** Its `checks` are routine items
that cannot be matched to a habit, so they are counted and reported. Its
`journal` is diary writing and is never opened. A test asserts diary text
cannot reach the plan, the summary or the database.

## Priority — calmed

The full red ring on every urgent task made an ordinary board look like a page
of errors. Red outlines are now reserved for genuine errors and destructive
confirmations. Urgent keeps a red stripe and the faintest tint; high gets a
quiet warm stripe; **medium — the default and most of the board — adds no
colour at all**, because a colour every row shares communicates nothing.

## Large screens

Fluid tokens above **1600px** only, with every `clamp()` floor set to the value
that already shipped. Verified: 1440px is byte-identical to before (h1 34px,
task 13px, rail 380, gutter 40). At 2560px: h1 46px, nav 16px, task 15.5px,
rail 460, gutter 75, composer 61px, buttons 43px. No `zoom` anywhere.

## Composer

Taller (52→66px fluid), full opacity, a real hover state, brand-purple mark
instead of a grey glyph, and honest copy: "Ask Life OS or capture a thought"
with a quiet "Soon". The softening is expressed as a **colour**, not opacity —
translucency is what made it read as broken.

147 tests passing. Task data untouched. Legacy untouched.

## Phase D1-D2 — Calendar foundation (2026-07-31)

Product model and PostgreSQL foundation for Calendar. **No UI yet** and the
real Google Calendar is NOT connected.

- Locked Month / Agenda / Plan as the only modes; removed Day, 3 Day, Week,
  Bars/Expanded Month and the Events/Reminders/Habits tabs. See
  [calendar-v2-product-model.md](calendar-v2-product-model.md).
- One timeline with independently filterable layers, not several calendar
  apps sharing a page.
- 11 Calendar tables, migration `0002_calendar.sql`, purely additive —
  no existing table is altered, so imported Task and Habit data cannot move.
- 19 new schema tests against real Postgres (PGlite). 220 pass, 0 fail.
- Still to do: D3 (Calendar UI on synthetic data) and D4 (approval).

## Phase D4.6-D4.7 — Calendar frozen (2026-08-03)

State model split from utilities, reminder filters cut to Active/Paused,
contextual rail, and then the composition work: one Calendar frame centred on
the window, one shared utility trigger/menu/surface across Today and Calendar,
animated rail, and live refresh.

The header centring bug is worth recording because three phases reported it
fixed. A stale `align-items:start`, left behind when D4.2 changed the header
from grid to column flex, made every header row shrink to max-content — the
selector was perfectly centred *inside a row that had gone to sit on the left*.
Measuring the row always returned zero. Measured at 2560: row 860px inside a
1520px header, selector 330px off. The rule now recorded: **alignment is judged
against the composition the user sees, never against the box you just centred
something inside.**

426 tests passing. Calendar frozen; month caching still outstanding.

## Phase E1 — Projects audit (2026-08-03)

Discovery only. **No Projects UI, no schema, no migration.**

- Legacy Projects are the `builds` collection: title, description, freeform
  notes, a dated log, a 7-step `stage`, and a `status` that Legacy **recomputes
  from recency** unless pinned. No tasks, areas, dates, files, people or
  calendar links exist on a Legacy Project.
- `tasks.project_id` in v2 is null for every row — and correctly so. Legacy's
  `task.project` field held a *workProject id*, which is an **Area**, not a
  Project. There was never a task→project relationship to carry over.
- Shipped one read-only endpoint,
  `POST …/import/legacy/projects/audit`, which reports structure — statuses,
  stages, content presence and length, duplicates, excluded-profile counts —
  and never returns description, notes or log text.
- Proposed the product model: Projects as finite outcomes with a four-state
  lifecycle, derived progress with counts rather than bare percentages, an
  inferred-but-overridable next action, and no right rail.

440 tests passing. Calendar unchanged, Google read-only, Legacy untouched.

## Phase E2 — Projects (2026-08-03)

Projects is a real section: schema, API, overview, detail, creation. No Legacy
migration, no Boards, no Library, no AI, no Google write.

**The design decision that shaped everything:** lifecycle and focus are two
fields, not one. `status` says where the work is (planning/active/on_hold/
completed); `focus` says how loudly it should ask (now/upcoming/someday). One
field cannot express "genuinely active, deliberately quiet", and Legacy is the
cautionary tale — it had a single `status` and then recomputed it from recency,
so the user's answer was overwritten by how recently they had opened the thing.

Focus governs **defaults only**: a task created in a Now project starts in Today,
anywhere else in the backlog. It never moves an existing task, never changes a
bucket, never clears a date. That line is what stops Projects becoming a second,
competing task-bucket system, and it is asserted by test.

Archive is an overlay (`archived_at` + `pre_archive_status`), not a fifth status,
so a project archived while On hold comes back On hold.

**Motion was built first, not last.** `applyGroups()` reconciles the list in
place — finds the row by id, patches its contents, and `appendChild`s it into its
new group, which moves the node rather than copying it. Measured in a browser: a
project changing status keeps the same DOM node, travels 148px into its new
group, updates its label, no duplicates. A single `innerHTML =` after a mutation
would have silently turned every transition into a jump, which is exactly how
C4's FLIP became invisible; there is a test against it.

Two things caught while building: browser `confirm()` was used for the
area-change and completion decisions and has been replaced with a real choice
surface that can show the counts the decision turns on; and `.page-head` had to
become a block for Projects, the same flex-item sizing trap that cost D4.7 a
phase on Calendar.

Not built, deliberately: drag reordering (Move to top ships instead), a
"stalled" health signal (`updated_at` moves when notes change, so it would be
unreliable), and every Boards/Library/AI placeholder.

525 tests passing. Calendar unchanged, Google read-only, Legacy untouched, every
existing task still projectless.

## Phase E2.3 — task identity and Today integration (2026-08-03)

Finished the relationship between Projects, Project Tasks, Next actions and
Today. The rule that drove it: **one Task record shown in several places**;
next action is prominence, not a different kind of task.

Closed the standing known limitation. Completing a task in Project detail used
to reload the whole detail body — so the row vanished and reappeared, and the
notes field was recreated underneath whatever the user had typed. It now moves
the SAME node into the Completed section, verified in a browser: same node
through complete and reopen, unsaved notes text intact, empty Completed section
removed, no duplicates, scroll unchanged.

Today now names a task's project as a link with a Next action marker, and
returning restores scroll, area filter and focused card. The task list endpoint
carries a compact project map rather than copying project fields onto every
task — the row is still one Task record.

Next action reports which rule chose it (chosen / due date / priority / order)
and shows what the task row shows, since a next action saying less than the list
made the same Task look like a lesser object.

Today project CLUSTERS were deliberately not built. A cluster header is a
non-task node inside the drop zone, and the drag placeholder is inserted
relative to task siblings, so a header can land on the wrong side of the
insertion point — and grouping reorders tasks visually while position still
orders them for real. The badge covers the actual need at none of that risk.
Recorded in technical-debt.md.

581 tests passing.

## Phase E2.4 — task consistency, Today surfacing, save integrity, habit history

Four defects, two of them data integrity, all reproduced and fixed against a
real API in a real browser rather than by reading source.

**Notes were being discarded on completion, on Today as well as in Projects.**
The shared editor's tick called `onToggle()` — status only, form never read —
then `close(true)`, a force close that skipped the dirty check. The edits now
travel with the completion in one transaction. Verified: typed a note, pressed
the tick without saving, note present on the server with `status: done`.

**Completing a project task appeared to do nothing until you left and came
back.** `wireProjectDetail()` ended with `wireBoard()`, which reassigns `onclick`
on every `.task` on the page — silently overwriting the project handlers with
Today's. Today's `toggleTask` looks the task up in `state.tasks`; for a task not
on Today it returned immediately. `wireProjectTaskRows()` now owns those rows.
Verified: same node object moves into Completed and back, one row per id, empty
section removed, notes intact through both directions.

**Today was mirroring active projects.** New tasks in a Now project defaulted to
the `today` bucket, so a five-task project put five rows on Today. The default is
now `week`. Membership surfaces nothing; only a bucket, a date, a schedule, or an
explicitly chosen next action on a Now project does — and that last one is
reported so the interface can say it happened. Verified: Today went from a full
board to exactly two project tasks, one overdue and one chosen, with an active
three-task Now project contributing none.

**The Next action badge almost never appeared.** Today keyed off `nextTaskId`,
the stored override, which is null unless someone hand-picked a task. It now
receives the resolved `nextActionId`, computed with the same function the project
page uses. Verified with the override cleared: `explicit: false`, `reason: due`,
same id in both places, badge on screen.

**Steps were missing from Project detail.** `GET …/projects/:id` returned tasks
without them, so the same task read `2/4 steps` on Today and nothing in its own
project. Fixed, and the next-action slot now reports `2 of 4 steps`. Project
progress still counts tasks only — asserted with ten completed steps on one open
task moving progress by nothing.

**Calendar habit history.** Month cells show `3/5`, and the selected day lists
every habit due that day, tickable. Historical correction was the point: the
endpoints already took a date, but nothing could reach them for a past day.
`habit-history.ts` computes due-and-done once for both Calendar and the habits
endpoint — Calendar's old version counted any entry as done against a flat habit
total, so a Monday habit counted against every Sunday. An existing entry always
counts, so a habit created today can still be ticked for last week. Verified in
browser: ticking 2026-07-30 moved that cell 0/3 → 1/3 and nothing else; a habit
created today, ticked 12 days back, moved that day alone.

This restored a habit mark to the Month cell, which **D4.2 had deliberately
removed**. That removal was right about the old mark — an unlabelled arc repeated
in every square. `3/5` is a number with a denominator and says what it means
without a legend. The test that enforced the removal was rewritten to enforce the
new rule rather than deleted.

611 tests passing.

### E2.4a — steps were dead, and habit ticking dropped clicks

Three reported problems, four root causes.

**Steps did nothing in Projects.** Both Projects call sites opened the shared
editor without `ctx.steps`, so `ctx.steps.add(...)` threw "Cannot read
properties of undefined" straight into an unhandled rejection. The block
rendered, looked complete, and was entirely inert — and because the rejection
was never surfaced, nothing anywhere said so.

The handlers now come from one `taskStepsCtx(task, onChanged)` factory used by
every context that can open a task, and the modal **throws** if it renders a
steps block without them. A silent no-op is the single outcome that hides a
wiring mistake, which is how this survived being written, reviewed and shipped.

**Steps were lossy on Today.** The only way to commit one was pressing Enter.
Nothing said so, so typing a step and clicking Save discarded it silently — the
same class of defect as the notes loss fixed earlier in E2.4, and in the same
file. There is now an Add button, and Enter, the button, blur, Save and the
completion tick all commit. A failed add puts the text back. Closing on top of a
half-typed step asks first.

Saving does not rely on blur having fired: blur ordering differs between a mouse
click, a keyboard Enter and a tap, and "your step survives only if you clicked in
the right order" is not a rule anyone should have to learn.

**Ticking habits quickly dropped clicks.** `toggleHabitOn` called
`renderCalendarRail()` — which replaces `rail.innerHTML` wholesale — twice per
tick. A second click could land on a node a re-render had already replaced, or
in the window between the swap and the loop that reassigns handlers, where the
button exists but does nothing. Three quick ticks registered one or two. It now
patches a single row; verified with three clicks fired with zero delay, all
three landing in the DOM, the card count, the month cell and the database.

**And the count jumped.** The optimistic update set the count straight to the
target, so ticking a 3-glass habit showed 3/3 and done, then snapped back to 1/3
when the response arrived. It now predicts what `check` actually does — increment
by one — and the optimistic and settled frames are identical at every step.

**The tick mark was a crucifix.** Two crossing CSS gradients, meeting off-centre.
Replaced with the checkmark glyph the task editor's step ticks already use;
verified as the same path data, 11×8, wider than tall.

620 tests passing.

## Phase E2.5 — inline Steps, completed-task restoration and Today ordering

A corrective phase. Every defect was reproduced in a browser against a real API
before any code changed.

**Steps were reachable only through the editor.** The card showed `2/4 steps` as
an inert label with no way to act on it. There is now one shared component,
`web/steps.js`, used by both the Today board and Project detail: the chip is a
button, it expands the steps beneath the task, and tick, untick, add, rename and
delete all work inline. Expanding does not open the editor. A task with no steps
gains its first through *Add step* in the task menu, because a chip on every
card would be noise on the majority that have none.

The panel renders **inside** the task's `<article>`. A sibling row would sit in
the drop zone, where the drag code treats everything as a task, and could be
dragged away from its parent. `drag.js` additionally refuses to start a drag
from inside `.t-steps`.

**Completing every step no longer implies completing the task.** The parent
stays visible, project progress does not move, and a restrained line reads "All
steps complete — ready to finish". Only the parent's own checkbox completes it,
and unticking any step clears the state at once. The converse holds too: a task
may be completed with steps unfinished, and those states are preserved in
history.

**Clicking a completed task opened a blank Create Task form.** Root cause:
`findTask` was `state.tasks.find(...)` — the active board only. A completed task
is removed from `state.tasks` on completion and lives in `state.history`, so a
valid id resolved to `undefined` and the editor's `task ? edit : create`
fallback turned "not found" into "new task". Not a missing id, not a mode flag,
not an event-target mismatch: a lookup scoped to a collection that by
construction could never hold the answer.

Fixed twice over, because either alone leaves the trap armed: `findTask` now
searches every mounted collection, and `openTask` treats an unresolvable id as a
bug rather than a request for a new task — fetching the record by id and failing
out loud if that fails too.

**The editor has three states now**, and the difference is visible: New task,
Edit task, Completed task. A completed one carries `Completed 4 August 2026` and
a Restore action alongside the full record.

**Restore is the same record, uncompleted.** Verified: same id, notes intact,
all four step states intact including the unfinished one, bucket, priority,
area and project preserved, exactly one row with that title afterwards.

**Today ordering** was verified with real pointer drags: one placeholder during
the drag, the task landing once, no duplicates. Dragging an expanded task
collapses its steps before measuring — 226px expanded, 71px during the drag,
placeholder matching at 71px — and restores expansion on drop. `Move up`,
`Move down`, `Move to top` and `Move to bottom` are in both task menus, so drag
is not the only way to reorder.

**Order isolation** confirmed in both directions: a Today drag left project order
untouched, and a project reorder left the Today bucket order identical in both
the server list and the DOM.

**Failure safety** was exercised by intercepting the writes. A failed add hands
the typed text back and names the error; a failed tick rolls the row back and
the server is unchanged. That last one caught a real bug of my own: the error
was appended to the panel and then wiped by the repaint that followed, so the
rollback was correct and completely invisible. Repaint first, then report.

651 tests passing. Boards remain planned and unbuilt; the mobile redesign
remains deferred.

## Phase E2.6 — ordered Steps and controlled parent completion

E2.5 shipped inline Steps as a flat checklist. That was the wrong product: Steps
are a sequence, and Today should guide you through it. Both defects were
reproduced in a browser before any code changed.

**Reproduced first.** Step 3 could be ticked while 1 and 2 were open. The parent
could be completed straight from Today with three of four steps unfinished — no
prompt, no block, task gone from the board. The exact paths: `.t-tick` →
`wireCard` → `toggleTask`, which never inspected steps; and `.ts-tick` →
`wireSteps` → `ctx.toggle`, which accepted any step in any order.

**The sequence is data, not a guess.** `task_steps.position` already existed as a
stored incrementing column, assigned `max + 1` on create and used for every read,
so E2.6 reads it rather than inventing an order from creation time.

**Today now guides.** Current is the first incomplete step and the only one
freely actionable; Next is a preview with no checkbox at all; the rest collapse
to `N more steps`. Pressing a locked step or that count opens the full task — it
never silently does nothing. Verified walking a four-step task end to end: each
completion promoted the next step, the parent stayed blocked throughout, and
ready-to-finish appeared only at 4/4.

**The editor overrides.** Every step is freely tickable there, and completing one
ahead of the current step says so once. Verified: ticked step 3 in the editor
while step 1 was current, returned to Today, and step 1 was still Current with
step 3 keeping its override and step 2 *not* promoted.

**The parent checkbox is unavailable while steps remain** — disabled, with
"Complete the remaining 2 steps first" in `aria-label` and `title`, and a small
progress ring showing `1/3`. Not clickable-then-an-error. The rule is also
enforced inside `toggleTask` and `completeProjectTask`, because `Space` on a
focused card reaches the mutation directly and a rule that lives only on a
control has a hole in it.

**Completing a parent early is a decision.** The editor shows a real choice —
"2 steps are still unfinished" with *Complete task and mark all steps complete*
or *Go back*. Verified: the confirmation appeared, the task stayed open until
approval, and afterwards every step was complete with text and order intact, one
record, moved once.

**Undo is bounded.** Only the step immediately before the current one can be
undone inline; undoing it makes it current again. Verified: with Alpha✓ Beta✓
Gamma current, only Beta was undoable and Alpha's tick was disabled pointing at
the editor. That is what stops Today producing "step 1 incomplete, step 2
complete, step 3 current".

**Adding a step to a ready task** appends it, makes it Current, clears
ready-to-finish and returns the parent to a progress ring. Verified in that
order.

**One defect of my own, caught by the browser.** A block replacement deleted
`readyHtml` while rewriting the render, so completing the *final* step threw
`ReferenceError` inside the repaint — the write succeeded, the DOM silently
stopped updating, and the step appeared not to advance. Restored, plus a check
that every helper the module calls is actually declared in it.

**And one regression caught by an existing test.** I gave `.modal`
`position:relative` so the confirmation could be absolutely positioned inside it
— which silently overrode `position:fixed` and threw the dialog 310px off
centre. That exact regression had been guarded since C4. The overlay is now
`position:fixed` and needs no containing block.

679 tests passing. Boards remain planned and unbuilt; the mobile redesign
remains deferred.

## Phase E2.7 — step control alignment and parent completion state

Two reported problems, and the measurements said something different from what
either of us assumed.

**"Step controls are off-centre" was a horizontal defect, not a vertical one.**
Measured before touching anything: every control was centred against its text
box to the pixel, `offCentre = 0` in all four contexts. But there were **four
different controls** — 15px, 16px, 15px on Today and 16.7px in the editor — and
because each row laid out its text with flexbox after the control, a control one
pixel wider pushed its text one pixel right. Rows that should have shared a left
edge were ragged. Vertical nudging would never have fixed it.

One control now, `stepTickHtml()`, sized from tokens and placed by a grid with a
fixed control column. Measured after: every step text, both group labels and the
"N more steps" line begin at exactly x=366, in every state, in both contexts.
The glyph is 61% of the box rather than 66% of a smaller one, so a completed
step reads as a ticked control rather than a green block.

**The parent control genuinely did not update.** §7 asked me to verify it, and
it failed: at 5/5 the chip said `5/5 steps` and the panel said "All steps
complete", while the control still showed a ring labelled "Complete the
remaining 1 step first". The cause was mine, from E2.6: I had changed the
blocked control from `disabled` to `aria-disabled` so that pressing it could
open the steps rather than doing nothing — and left the detector in
`repaintSteps` reading `.disabled`, which is now always false. The comparison
never fired, so the row was never re-rendered. It reads the class now.

The blocked control is a 22px progress arc with a 44px hit area and no number
inside it — 7.5px digits in a 20px circle were unreadable, and the `1/3 steps`
chip already carries the count legibly. At all-steps-complete it becomes the
same 20px checkbox a task with no steps has. Collapsed cards read
`5/5 steps · Ready to finish`.

**And a second helper lost to a block replacement.** Rewriting the editor's step
row deleted `confirmOverride`, so the entire parent-completion override would
have thrown the moment it was pressed. That is the same mistake that deleted
`readyHtml` in E2.6. Both parsed cleanly; both were invisible to tests that
assert the source *contains* something, because the deleted function was simply
never mentioned again.

There is now a test that imports `steps.js` and renders every panel state,
including all-complete. Verified it catches the real thing: deleting `readyHtml`
again makes it fail with `ReferenceError: readyHtml is not defined`.

681 tests passing.

## Phase E2.8 — Today task separation and daily arrangement

Two features, and one design decision that shaped both.

**Separation.** Each bucket now draws standalone work and project work as two
runs of cards under adaptive headings — both when both exist, `PROJECTS` alone
when there is no standalone work, and neither when there is no project work,
because a divider that separates one thing from nothing is noise.

The cards stay **direct children of the drop zone**. That is structural, not
stylistic: `drag.js` finds candidates with `querySelectorAll('.task')` (any
depth) and then calls `zone.insertBefore(placeholder, candidate)`, which
requires a direct child. Wrapping each subsection would have thrown
`NotFoundError` on the first drag into the second section. Sibling headings keep
the drop zone flat and the drag code untouched.

**Per-project grouping was offered and declined**, using the fallback §3
explicitly provides. Grouping needs a drag partition per project so a task
cannot appear to move between them; two partitions can be reasoned about and
tested completely, one-plus-N cannot. Each project row keeps its linked project
name, which is what identifies it anyway.

**Drag is confined to its own kind.** Filtering the candidates rather than
rejecting the drop means the placeholder stops at the boundary, so the gap shows
where the task can actually go. Verified by dragging a standalone card well past
the project rows: the placeholder stayed above the first project row and the
task landed at the end of the standalone run.

**The daily arrangement** runs once per local calendar day on first open, over
standalone tasks only. The comparator: scheduled time, then due date/time, then
overdue (oldest first), then priority, then the previous manual position as a
stable tie-break. A due date is deliberately **not** treated as a scheduled
start.

Verified in a browser with a deliberately wrong starting order — the result was
`Scheduled 14:00 Low`, `Scheduled 16:00 Urgent`, `Due today Medium`, `Overdue`,
`Undated High`. 14:00 before 16:00 despite Low against Urgent, which is the rule
working.

**Project rows kept positions 5000 and 9000 throughout.** The list is partitioned
first and only the standalone half sorted, reusing the exact slots those tasks
already held — not sorted whole and re-split, which would still move project rows
relative to one another.

**Once per day is guarded server-side**, by one conditional UPDATE on
`workspace_memberships.last_today_arranged_on`. The `WHERE` clause is the entire
mechanism: two tabs both ask, Postgres serialises them, one gets a row back. A
test fires six concurrent claims and asserts exactly one winner. The date comes
from the client because "local calendar day" means the user's day, and it is
computed with local getters — `toISOString()` would give the UTC date, which in
Johannesburg is yesterday until 02:00.

**Manual order survives.** Verified: shuffled by hand, reloaded, and the board
came back exactly as left with no re-sort. Releasing the day and re-opening
applied the arrangement again, which is the next-day behaviour.

**Undo is real.** The exact prior positions are recorded and written back;
verified restoring an order character for character, with project rows unmoved.
It also releases the day, so an arrangement the user rejected does not cost them
tomorrow's offer.

`POST …/tasks/reorder` applies many positions in one transaction — all or none.
A half-applied reorder would leave an order nobody chose and nothing would ever
correct.

718 tests passing. The Growth/Skills model is recorded in
`brain-v2-future-model.md` with no code and no placeholder UI.

## Phase F1 — Library foundation and Legacy book extraction

Delivered: the audit, the schema, the link-model decision, the API, the document
model and the sample tooling. **The Library web UI and the Book component are
not built** — see below and technical-debt.md.

**The audit came first, from source.** The identity of the Legacy book is almost
entirely CSS: the A4 210/297 ratio, the 420/297 spread, a 6px gutter, page
padding of 28/32/18/58, a margin stripe at `left:46px`, a coloured `inset 3px`
outer edge mirrored on the right page, and a ruled-line gradient whose repeat
cycle equals the line-height with `background-attachment: local`. All of it
carries across.

The JavaScript cannot, for six specific reasons — chief among them that
`nbSwapBook` does `book.innerHTML = html` on every render, destroying the
contenteditable along with its selection and undo history, and that autosave is
`setTimeout(() => svAll(), 1200)`, which writes the entire application state with
no ordering, no failure path and no status. That is the defect class E2.4 spent a
phase removing from Tasks.

**One link model.** `calendar_item_links` → `item_links`. The shape was already
polymorphic and its own comment already named `library` as a future target; only
the name said Calendar, and a name that lies about scope is how a second link
table gets created beside it. Every use was traced first — one select, one
insert, two test files — and the API response field stays `links`, so Calendar
behaviour is unchanged.

**The page grammar is the phase's most consequential decision.** A page is a
validated structured document, never HTML. That kills the Legacy defect at the
root, makes sanitisation unnecessary (there is no HTML to sanitise), and leaves
room for images, Library references, Task references and AI proposals as *nodes*
rather than invented syntax.

**Safety rules with teeth:** a book cannot be created through the generic item
route; the last section of a book and the last page of a section refuse to
archive; there is no DELETE route at all; page saves take `expectedUpdatedAt`
and 409 on a stale write.

**Sample cleanup cannot reach real content.** Sections and pages carry no
marker; they go by FK cascade from an item matching the exact `sample:f1:`
prefix. Verified by a test that creates real content deliberately named "Life OS
Field Notes" and confirms it survives cleanup.

One bug found by running it rather than reading it: `coalesce(max(x), -${GAP})`
interpolates GAP as an untyped bind parameter and Postgres cannot resolve
`- $1` — *operator is not unique: - unknown*. The arithmetic moved to JS.

755 tests passing. No Legacy data was read or migrated; Legacy was not modified.

---

## D1 — Diary foundation and chronological writing (2026-08-05)

Diary is a real route. One entry per workspace per **local calendar day**, with
the Library editor and none of the Book's furniture.

**Diary is not Library.** A diary entry is not a `library_items` row and never
becomes one; the two share the editor and the document grammar and nothing else.
Asserted by a test that writes a diary day and confirms the Library shelf and
Library search stay empty.

**The civil date belongs to the person.** The client sends the date it is
showing; the server validates it as a real day, compares it, and never derives
one. All arithmetic — both sides — happens at noon UTC so no offset can shift a
computed day. `localToday()` uses local getters; `toISOString()` appears nowhere
in Diary.

**Nothing exists until somebody writes it.** Opening a date creates no row. An
entry is meaningful when it has document text, a title, a mood, an energy, a
weather note, a location note or a day summary — one rule, in one function, used
by the write path and by history so they cannot disagree.

**An archived entry keeps its date.** The unique index covers archived rows
deliberately: a vacated date would let a second entry be written on top of the
first and orphan it. Writing on an archived date is a 409 with a restore offer.

**The editor was extracted, not forked.** `library-doc.js` and
`library-blocks.js` had nothing Library-specific in them and were renamed to
`editor-doc.js` and `editor-blocks.js`. `library-save.js` did, so it became a
`createSaveCoordinator({ write })` factory — a factory rather than a singleton
because each surface needs its own entries, or one surface's `forgetAll()` would
clear the other's pending write. Library's behavioural save tests passed through
the extraction unmodified, which is the proof it did not change.

Two bugs found by running it. `onEntryCreated` called `adopt()`, moving the
version token before the coordinator set it from the write's own result — its
staleness guard then fired on its own success and left the status on "Saving…"
for ever while the row sat in the database. And the sample marker lived on
`day_summary`, which is displayed: it appeared on screen as "sample:d1: An
ordinary Tuesday" in the history list, and moved to `timezone`.

907 tests passing. No Legacy Diary content was read, previewed or migrated;
Legacy was not modified.

---

## D2.1 (partial) — navigation reliability and the Today partition (2026-08-06)

Two reported defects, both fixed and verified. The phase specified nine work
items in an explicit priority order with "reliability comes before decorative
polish"; items 1 and 2 are done, item 3 is half done, and items 4-9 are NOT
started. See technical-debt.md for exactly what remains.

**The navigation race.** Inside a Library Book, clicking Projects, Calendar and
Today in quick succession could land you back in Library. Root cause: `go()`
awaits the leave-flush BEFORE changing the route, so during that wait
`state.route` was still the old one and every subsequent click took the same
branch. Three concurrent navigations; whichever finished last painted last. And
because Library and Diary call `setHash()` when they render, a stale render
rewrote the URL rather than merely repainting.

Fixed with one monotonic token in `web/nav.js`, claimed before any await and
checked before anything is drawn or the hash is written. A trap inside the fix:
`go()`'s own `location.hash` write fires `hashchange`, and bumping there
invalidated the navigation that had just written it — Today loaded its tasks and
then refused to paint them. The handler now recognises its own write.

Saves are not navigations. A 409 for a page or a day nobody is looking at no
longer opens a dialog over whatever is on screen.

**The Today partition.** A standalone Task dragged into a project-only bucket
landed at the bottom of PROJECTS. `updateInsertion` filters candidates to the
dragged card's kind, which is what keeps the boundary — but with no candidates
it fell through to `zone.appendChild`. The bucket where the boundary matters
most was the one where it was not applied. Fixed in the insertion model:
`partitionAnchor` gives an empty partition a home, the drag previews the heading
its drop would create, and `syncBucketHeads` reconciles dividers after the drop
without re-sorting rows.

**No blank frame,** partially: known content is no longer cleared before its
replacement is ready, in Diary and in Library. Prefetch and the page-turn
illusion were not reached.

919 tests pass, 12 new.

---

## Phase D2.2 — Library regression, Diary size, the habit joins the system

Three defects reported from authenticated staging, and one thing joined them:
**something knew the right answer and something else was allowed to overrule
it.**

### 1. Library was broken (release-blocking)

`#library` opened, showed `Opening…` above a large permanent skeleton, and never
rendered the shelf.

**Root cause.** Three modules wrote `location.hash` and each kept a private flag
saying "that one was mine" — `app.js`'s `ownHashWrite`, and a `suppressHash` in
each of `library-view.js` and `diary-view.js`. The shell's `hashchange` handler
could only see app.js's. So every hash Library wrote *about where the person
already was* — opening a Book, turning a page — was counted as a navigation,
bumped the D2.1 token, and invalidated the render that had just written it.
`loadBook` returned, found itself stale, and left the shell up for ever.

**Fix.** `nav.js` owns the token *and* the record of what was written.
`setHash` writes and remembers; `hashWasOurs()` answers once and consumes. The
shell asks at the top of the handler and passes the answer down. Nobody keeps a
private flag. It also fixed deep links across a route change: `go(id)` no longer
flattens `#diary/2026-08-05` to `#diary`.

**Lifecycle.** Every loading shell arms a watchdog; every path to a real screen
disarms it. The three legitimate ends are overview, empty and error-with-retry.
The 60vh grey slab is replaced by card- and book-shaped skeletons, and the Book
header carries its real title while it loads.

### 2. The Diary spread was too tall

D2's `min-height: calc((100vw - 460px) * 297/420)` read the window to size an
element inside a column. The rule is now

    height = max(approvedBaseHeight, leftRequired, rightRequired)

with all three terms in CSS — an `aspect-ratio` pseudo-element for the base and
`align-items: stretch` for the pages. Nothing is measured, no inline height is
written, nothing animates it.

**Measured at 1280×720:** blank day **569 = base exactly**; twenty paragraphs
1021, both pages equal; deleted again **569**; four Moment tiles open 631, closed
**569**. No inline `style` at any point.

Three prompts rest open (five empty fields cost 411px), at a 40px resting
height.

### 3. `Write in Diary` was a picture, not a member

Today said `0/5` with the row visibly complete: the total was `due.length` and
the computed row is not in `due`.

`api/src/lib/diary-habit.ts` is now the one provider — Today's totals, the
Calendar month cells, the Calendar day sheet, the history series and
`/diary/streak` all come through it. `habitTotals` is the only place the two
kinds are added together. The row is visually identical to an ordinary habit
(46px, 32×32 ring, shared `streakHtml`), first inside `.hb-list`, with the
`SYSTEM` badge gone. A `diaryHabit` preference, default on, removes it from
every total without touching a single diary entry.

### 4. The right page, and History

Four grouped surfaces; an energy meter, a social battery and a check-in-scoped
day tint; Moment tiles that open into one line each. Every selection patches one
`<section>` and the left caret never moves.

History is a compact six-week grid at 60px per cell, and a written day shows one
line of context (chosen and cut on the server) plus the broad feeling as a word.
Rough and Low are muted warm rose; Good is soft green; Great is lilac; Steady is
the plain surface. Never `--danger`.

### 5. The animation house rule

Two more animations were found owning a final state, one of them by measurement:
a **200ms entrance still `running` at six seconds with the whole spread at
opacity 0**. Both the leave and the entrance now take their class off on a
timer. Written down in `docs/animation-house-rules.md`:

> Animations illustrate state changes; DOM and CSS own the final state.

The Diary transition also turned out never to have run since D2 — it targeted
`.dia-sheet`, an element the spread replaced.

**976 tests pass, 41 new.** TypeScript clean, including three pre-existing test
typecheck errors cleared on the way past.

---

## Phase D2.3 — tap-only right page, daily pulse, History snapshots, two regressions

The product rule this phase locks:

    LEFT PAGE  = THINGS YOU WRITE.
    RIGHT PAGE = THINGS YOU TAP.

### The two regressions

**The habit ring's seam.** `pathLength="100"` with `stroke-dasharray="100"`
makes the dash exactly one full turn, so its flat `butt` end lands on its own
start — two abutting caps, not a join. Each antialiases alone and the coverage
where they meet sums to less than a pixel of paint. Rasterised at four device
pixel ratios, coverage at the seam as a fraction of the surrounding stroke:
**46.5% / 34.5% / 21.5% / 0.6%** at DPR 1 / 1.25 / 1.5 / 2. At DPR 2 it is a
hole, which is why it showed on a retina screenshot. A complete ring now has no
dash at all, so the stroke is a continuous closed circle: **93.1 / 88.4 / 93.2 /
94.0%**, which is ordinary curve antialiasing. One `ringSvg` component for
ordinary and Diary habits alike.

*(A first attempt to measure this found nothing — a 3×3 neighbourhood maximum
washed the sub-pixel dip out, and the control passed too. A measurement whose
control passes is not a measurement.)*

**The Diary rubber-band.** Reproduced before changing anything: Next, Next,
Previous, Next showed 8 Aug, then **7 Aug**, then 8 Aug, settling after **3.6
seconds**, with four requests for three days. Three causes — `loadDay` set
`dia.date` itself so a late response made an abandoned day current again;
nothing distinguished a render belonging to the newest press from one three
presses old; and the target was computed from a date not committed until after
the save flush.

Fixed with a **date-navigation transaction**: a monotonic day token beside the
route token, the date committed before anything is awaited, and the flush for
the day being left continuing in the background where it can update its own
record but not the screen. Measured after: heading and hash correct in **~3ms**,
paper painted at **24–28ms**, one request each. With 1.2s of injected latency
the visible date goes straight to the requested day and never shows the old one.

### The right page

Every text input is gone. Four groups on quiet surfaces — Overall feeling (five
faces from one drawn system), Energy, Social battery, Day rhythm — plus a **Day
Pulse** of three bars that is explicitly a snapshot and not a grade: no total,
no percentage, no average, no judgement.

**The social battery's geometry was wrong and is now proven.** Cells replaced by
one continuous fill: shell **30×13 in every state**, fill 0 / 7.91 / 16.08 /
24px, steps of 7.91 / 8.17 / 7.92 — even to a quarter-pixel.

**Four passive dimensions** — Nourishment, Movement, Outside, Sleep. They
describe the day and **never write a habit**; asserted against the database.
Gym is deliberately absent because it is an intentional activity.

Measured at 1280×900: the right page went 734 → **542px** and the whole spread
780 → **631px**, fitting above the composer with 69px to spare. The rhythm block
alone went 305 → **114px** once the rows went inline and two labels were
shortened (§7 permits it; measurement required it).

### The left page

The writing region is **seven ruled lines**, not half an empty page — the editor
stopped absorbing spare space, which now sits below the prompts. The four
Moment text fields moved here as prompts, and only on days that already hold
one.

### History

The month cell draws the right page's own indicators, from the same components:
feeling face, energy meter, social battery, plus four passive marks whose glyph
says which dimension and whose opacity says roughly how much. Exact values live
in the tooltip and the accessible name. 72px cells, six rows, fits above the
composer at 1280×900.

**1002 tests pass, 25 new.** TypeScript clean.
