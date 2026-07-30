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
| **Version** | v239 |
| **Rebuild step** | 3 of 17 complete · **system audit done** |
| **Next step** | 4 — Today Dashboard (**awaiting approval**) |
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
