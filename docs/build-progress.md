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
