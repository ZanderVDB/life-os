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
