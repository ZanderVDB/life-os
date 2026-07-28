# Life OS — UI Redesign Decision Log

> **Purpose:** this file is the single source of truth for the layered UI
> redesign. Every choice gets written here the moment it's made, so that by
> the time we reach the innermost layers we haven't forgotten what was
> decided at the outermost ones. **Read this file before proposing or
> building any redesign work.**

Started: 2026-07-22 · App version at start: **v197**

---

## The protocol

We work **outside-in**: the whole-site look first, then one layer deeper,
repeatedly, until every surface has been redesigned.

For each layer I present **templates** (design options, usually referencing
real products). For each template Zander responds with one of:

| Response | Meaning |
|---|---|
| **Yes** | Lock it in. Recorded below, we move to the next layer. |
| **Expand** | Show more detail / variations of that one template. |
| **None** | Discard all; generate a fresh set. |
| **Combine A+B(+C)** | Merge named templates → I return **5 new variations** of the merge. |

**Rule:** if we add a new feature/surface at any point during this process,
it gets appended to the Layer Checklist below and must be designed too.

---

## Layer checklist

Status: ⬜ not started · 🟡 in progress · ✅ decided · ⏸ deferred

| # | Layer | Status | Decision |
|---|---|---|---|
| 0 | **Global shell** — nav, chrome, typography, colour, density, motion | ✅ | Skin = **Apricot** (light); serif headings + sans body + hand stickies |
| 1 | **Home** = merged Tasks (one list) + Habits, landing surface | ⬜ | |
| 2 | **Tasks** as the sticky Board (make stickies look good) | ⬜ | |
| 3 | **Calendar** — unified events+reminders+habits; week + day only | ✅ | W2 lane-week + DV1 timeline-day |
| 4 | **Projects** — fully reinvented, revisit-worthy | ⬜ | |
| 5 | ~~Habits tab~~ → absorbed into Home | ✅ | Remove tab; habits live on Home + Calendar |
| 6 | **Diary / routine** — moved off home, made fun | ⬜ | |
| 7 | ~~People~~ | ✅ | **REMOVE entirely** |
| 8 | Notebook | ⬜ | keep |
| 9 | ~~Brain~~ | ⬜ | cut or fold into Notebook (TBD) |
| 10 | AI bar · Ask mode · review queue | ⬜ | |
| 11 | Modals (task, event, project) | ⬜ | |
| 12 | Command palette / universal search | ⬜ | |
| 13 | ~~Morning brief · Today's plan~~ | ✅ | **REMOVE both** (never used) |
| 14 | Settings | ⬜ | |
| 15 | Login / splash / onboarding tour | ⬜ | |
| 16 | Cross-cutting: empty states, mobile, dark theme, icons, sounds | ⬜ | |
| 17 | **Calendar reliability** — stop the disconnect (blocking) | ⬜ | top priority — undermines a would-be-used feature |

---

## ⭐ NORTH STAR — the chosen visual skin

**"Apricot" (light) — chosen 2026-07-27.** Warm peach ground, burnt-orange
accent, teal counterpoint. This is the locked skin every surface is built in.
Light only (a dark twin comes later); "not too light" — the desk/wall carries
real tone, cards + stickies sit lighter on top for depth.

**Palette tokens:**
| token | hex | role |
|---|---|---|
| `pg` | `#F3D8C2` | page behind app |
| `bg` | `#FCE8D8` | app surface / wall |
| `panel` | `#FFFBF6` | cards |
| `soft` | `#FBEEE2` | rails, ask-bar, secondary surfaces |
| `ink` | `#3A2A22` | primary text (also sticky text) |
| `muted` | `#9A8574` | secondary text |
| `line` | `#F0DBC8` | borders |
| `acc` | `#D2662F` | primary accent (burnt orange) |
| `acc2` | `#2E8C8C` | secondary accent (teal) |
| `ok` | `#5E8A5A` | habit-done green |
| `navBg` | `#F7DFCC` | left nav rail |

**Sticky notes (bg / tape):** coral-aqua set —
`#FFD9C2`/`#F0A97F`, `#BFE6DE`/`#8CC7BB`, `#FCE3A0`/`#E7C766`,
`#CFE0EE`/`#9BBFD8`, `#F3CBD3`/`#DC9BA6` (cycling). Washi tape, slight tilt,
soft shadow, handwritten type.

- **Type:** serif headings (Georgia-ish), clean sans body, handwritten
  (cursive) on stickies.
- **Superseded:** the earlier north-star pick #25 "Dusk (plum synthwave)" is
  **dropped** — it was never applied to a real surface, and every approved
  mockup used a warm-light skin. Apricot is the direct descendant of that
  warm-light direction, chosen from a 20-scheme light-only comparison on the
  real home wall.

---

## 🔑 USAGE AUDIT — what Zander actually uses (2026-07-22)

The most important input in this whole process. **Every redesign decision
must serve this reality.** Verbatim intent captured below.

**What he actually opens the app for:** basically only **Tasks** and
**Habits**. Everything else is aspirational or unused.

| Section | Verdict | What to do |
|---|---|---|
| **Tasks** | Core. Open app → wants to see these first. | Show on landing. **MERGE Daily + General into ONE list** — the split "hasn't been functional." One task surface only. |
| **Habits** | **Most-used feature.** | Surface on the **main page** (which ones done today, which not, streaks) → can then **remove the Habits tab**. |
| **Board (sticky notes)** | Loves the idea. | Keep — but the stickies "look trash," make them look much better. Strong candidate for the task view. Not scripture; can try alternatives too. |
| **Calendar** | Uses it a lot — mainly to **tick/adjust habits per day** (esp. back-filling Saturdays he's out for). | Keep. **#1 reliability fix: stop it disconnecting.** Week view = useful (keep). **3-day view = remove** (never used). **Day view = reinvent** (potential, never used). **Merge events + reminders + habits into ONE calendar** (wants ideas on how). |
| **Projects** | Useful as a *capture* spot, but **never revisits** after adding. Stages / daily-log / scratch-notes (v195) **did NOT make him engage.** | **Willing to fully redo.** Even scrap stages/log entirely. Must be creative + revisit-worthy, not "boring." |
| **Notebook** | Still likes it. Underused only because it's not open when he's note-taking (grabs a physical book). | Keep. Will use more if he lives in the app more. |
| **Daily routine** | Wants it prominent but **has never used it.** | Make it **fun/creative**, and probably **move it OFF the main page** to somewhere else. |
| **People** | **Never used once.** | **REMOVE entirely.** |
| **Brain** | **Never used once.** | Make it fun, fold it in, or cut it. (Leaning cut/fold.) |
| **Morning brief** | "Never used, really thought it'd be useful." | **REMOVE.** |
| **Today's plan (AI)** | Never used once. | **REMOVE.** |
| **Needs attention** | Neutral — "neither here nor there." | Keep or cut, don't care. Likely fold into home or drop. |

**Unified-calendar wish:** events + reminders + habits in one calendar, not
three. Habits especially should be tickable per-day in the calendar (his
real workflow). Day view + week view only.

---

## Standing directives from Zander

Things stated up front that constrain every layer. **Do not violate these.**

1. **One task view only.** Today there are two (the list on Today + the
   sticky Board). The redesign must consolidate to a single task surface.
2. **Daily diary as a book.** A book that opens to a notebook page with the
   journal questions, **habits at the bottom** (did / didn't), and you can
   **flip back through previous days**.
3. **Calendar gets its own dedicated section.**
4. Information/data captured today is good — this is a **purely visual /
   interaction** redesign, not a feature cull.
5. Use **real products as reference points** when generating templates.

---

## Decisions

*(append-only; newest at the bottom. Record the layer, the chosen template,
the reasoning, and anything explicitly rejected.)*

### Layer 1 — Home (tasks + habits)
- **2026-07-22:** Zander chose **H1 "The wall"** — the sticky-note board IS
  the home for tasks (merged one list), with habits below. The separate
  Board tab folds into this. Stickies must look good (washi tape, tilt,
  soft shadow — not the current "trash" ones).
- **Refinement requested:** habits need **more detail** — current streak,
  best streak, week trail, tap-to-tick. Choosing the habit-panel treatment
  (foot cards / right rail / expandable ribbon).
- **2026-07-22:** habit-detail treatment = **B (right rail)** — habits on a
  right-hand column with full detail each: streak ring, 🔥 current streak,
  best-ever, and a tappable 7-day trail (back-fill days right there).
- **Decision:** ✅ **Home = sticky wall (tasks) + habits right rail.** Locked.

### Layer 4 — Projects (reinvention — "surprise me")
- Problem to solve: Zander captures a project then **never revisits**.
  Stages / daily-log / scratch-notes (v195) did NOT fix it. Willing to fully
  scrap them. Must be creative + revisit-worthy.
- **2026-07-22:** Zander chose **#6 "Streak keeper"** — projects get a
  check-in streak exactly like habits (his most-used feature). Reward = keep
  the streak alive; broken ones show "Revive." **Scrap the v195 stages /
  daily-log / scratch-notes.** ✅ locked.
- Nice emergent coherence: Brain "sparks" can graduate into Projects (which
  are streaks). Consider that pipeline when designing Brain.

### Layer 9 — Brain (make it fun, keep it)
- Kept as a tab (not folded). Must become something Zander wants to dump
  into. Reinventions presented as mockups.
- **2026-07-22:** Zander chose **#1 "Spark → fire"** — everything dumped is
  a spark; good ideas get a "🔥 fan → project" button that graduates them
  into the Streak-keeper Projects. **Brain + Projects are one pipeline.**
  ✅ locked. (Likely pair with voice-dump capture — revisit later.)

### Layer 6 — Diary (routine + journal, off Home, made fun)
- Routine: never used → make fun. Journal: wants to use, never prompted.
  Habits stamped at the bottom (his original "book" vision). Flip through
  days. **Status:** book-tab vs calendar-day-view presented as mockups.
- **2026-07-22:** Zander chose **D1 → B1 "Classic journal"** — two-page book
  spread: handwriting journal (his real questions) on the left, light
  routine checklist + habit stamps on the right, ribbon marks today, flip
  through past days. ✅ **Diary = the book (B1).** Locked.
- Consider layering B6's rotating-prompt + journaling-streak onto B1 later
  (he responds to streaks) — parked, not decided.

### Layer 3 — Calendar (unified · week + day)
- Keep week view. **Remove 3-day view.** Reinvent day view (potential,
  unused). **Merge events + reminders + habits into ONE calendar.** Core
  workflow = tick/back-fill habits per day (esp. missed Saturdays).
- Separate hard requirement: **fix the disconnect** (reliability), tracked
  in Layer 17. **Status:** unified week + day concepts presented as mockups.
- **2026-07-22:** Week view = **W2 "Lanes"** — rows are Events / Reminders /
  one lane per habit, across the 7 days; habit rows are a tap-to-fill tick
  grid (perfect for back-filling missed days). 3-day view removed. ✅ week
  view locked.
- **2026-07-27:** Day view = **DV1 "Timeline"** — the day down the hours;
  events + reminders sit at their real times, with a right-hand dock showing
  today's habits (tickable) + a one-line reflection. ✅ day view locked.
  (DV3 back-fill behaviour is preserved by the W2 week grid — you back-fill a
  missed Saturday from the week lanes; the day view is the "what's today"
  drop-in.)
- **Decision:** ✅ **Calendar = W2 lane-week + DV1 timeline-day, one unified
  surface (events + reminders + habits).** Layer complete.

### Layer 0 — Global shell
- **2026-07-22:** presented 15 product-style templates → Zander found them
  "too basic," asked for 30 bolder aesthetic *worlds* instead.
- **2026-07-22:** presented 30 north-star worlds in 3 families.
  **Zander chose #25 "Dusk gradient (soft synthwave)."** ✅ locked as the
  north star (see top of file).
- **Next:** "expand 25" — 5 calibration variations (how bold, dark-only vs
  light option) to fix the exact shell, then move to Layer 1 (Today page).
- **Decision:** direction locked (#25); precise calibration pending.

---

## 🏗️ CONSOLIDATED BUILD PLAN (2026-07-27)

All core surfaces are designed. This is the single spec to build against.

### The new information architecture

**Kept surfaces (redesigned):** Home · Calendar · Projects · Brain · Diary ·
Notebook.
**Removed entirely:** People · Morning Brief · Today's Plan · Habits tab ·
Needs-attention · Calendar 3-day view · Projects stages/daily-log/scratch
(v195).

New primary nav (order): **Home · Calendar · Projects · Brain · Diary ·
Notebook**, plus persistent AI bar + Settings.

### Locked design per surface

1. **Home — "the wall."** Landing surface. The sticky-note board IS the task
   view. **One merged task list** (Daily + General collapsed into one). Stickies
   restyled properly: washi-tape corner, slight tilt, soft shadow, hand feel —
   not the current "trash" look. **Habits on a right rail** with full detail
   each: streak ring, 🔥 current streak, best-ever, tappable 7-day trail
   (back-fill right there). The old Board tab folds into this.

2. **Calendar — own section, unified.** One surface for **events + reminders +
   habits** together.
   - **Week = W2 "Lanes":** rows are Events / Reminders / one lane per habit
     across the 7 days; habit rows are a tap-to-fill tick grid → this is where
     you back-fill missed Saturdays.
   - **Day = DV1 "Timeline":** the day down the hours; events + reminders at
     their real times, right-hand dock with today's habits (tickable) + a
     one-line reflection.
   - **3-day view removed.**
   - **Reliability:** fixing the Google Calendar disconnect is the #1 build
     task (see below) — it undermines the one calendar workflow you rely on.

3. **Projects — "Streak keeper."** Projects get a habit-style check-in streak;
   keep it alive to keep the streak; broken ones show **"Revive."** Scrap v195
   stages / daily-log / scratch-notes.

4. **Brain — "Spark → fire."** Everything dumped is a spark; good sparks get a
   **"🔥 fan → project"** button that graduates them into a Streak-keeper
   project. Brain + Projects = one pipeline.

5. **Diary — "Classic journal" (B1).** Two-page book spread: handwriting
   journal (your real questions) on the left; light routine checklist + habit
   stamps on the right; ribbon marks today; flip back through past days. Lives
   in its own section, off Home. (Routine lives here — made fun — not on Home.)

6. **Notebook — keep.** Light-touch restyle to the new skin; no structural
   change.

### Secondary surfaces (inherit the shell, no separate exploration needed)

These weren't given bespoke mockups — they adopt the chosen skin and get a
straightforward restyle during build, unless a specific idea is wanted:
AI bar / Ask mode / review queue · task/event/project modals · command
palette + universal search · Settings · Login / splash / onboarding.

### Skin — RESOLVED

- **2026-07-27:** ✅ **"Apricot" (light)** chosen from a 20-scheme light-only
  comparison rendered on the real home wall. Tokens + sticky set recorded in
  the North Star section above. Dusk dropped. **No blocking design decisions
  remain — ready to build.**

### Build order (once skin is chosen)

1. **Calendar reliability fix** — stop the Google Calendar disconnect (blocking;
   pure logic, can start immediately, independent of skin).
2. Shell / skin: tokens, nav, typography, motion.
3. Home (wall + habit rail) → Calendar (W2 + DV1) → Projects (streak) →
   Brain (spark→fire) → Diary (book) → Notebook.
4. Secondary surfaces restyle.
5. Cross-cutting: mobile, dark theme, empty states, icons, sounds.

---

## 🔨 BUILD LOG (implementation in index.html — worktree, not shipped)

### 2026-07-27 — Increment 1: reliability + skin + nav relabel
- **Calendar reliability (Layer 17):** implemented in the GIS token layer.
  - Cache Google email as a GIS `hint` (`los_google_email`) → silent refresh
    no longer trips the account picker (the reason on-load refresh was
    disabled). Passed on both silent (`prompt:''`) and consent requests.
  - Track token expiry (`los_gate_<pid>`) via new `_storeGTok()`; wired into
    the GIS callback + all Firebase-popup/redirect token paths.
  - `ensureFreshGCalToken()` — proactive refresh when token is missing/expired/
    within 10 min. Called on app open (`probeGCalLive`), on tab re-focus
    (visibilitychange), and init now schedules off the *real* expiry.
  - Reactive 401 handlers kept as backstop. **Needs a real device test** (can't
    repro live Google OAuth here). If it still drops, next escalation is a
    server-side refresh-token flow.
- **Apricot skin (Layer 0):** remapped `:root,[data-theme="soft"]` to Apricot
  tokens (bg `#fce8d8`, accent `#d2662f`, teal `--accent-2 #2e8c8c`, etc.).
  Verified live in a local preview: body bg peach, accent burnt orange, no
  console errors. Dark theme (`studio`) accent warmed for the eventual twin.
  Type system (Inter/Playfair/Kalam) already matched — no change needed.
- **Nav/IA (Layer 0):** added `#i-home` icon; relabeled route `today`→**Home**
  (route KEY kept as `today` to avoid rippling the router); **removed People**
  from both desktop + mobile nav. Board/Habits still in nav pending their fold
  into Home. Diary nav pending its surface build.

### 2026-07-27 — Increment 2 (v199): Home = the wall + habit rail
- Rebuilt the `today` route as **Home**: a two-column grid — the sticky **wall**
  (left) + the **habit rail** (right).
- **Wall** (`rHomeWall`): shows EVERY open task (Daily + General merged into one
  surface). Reuses the board sticky markup so `boardComplete` / `boardToggleStep`
  / `openTaskModal` work unchanged. Stickies restyled — softer Apricot colours,
  **washi tape** instead of the red pushpin, gentler shadow, warm surface.
- **Habit rail** (`rHomeHabits` + `_habRing`): a card per habit — streak **ring**
  (current in centre, fraction = progress to best), 🔥 current + best-ever, and a
  tappable **7-day trail** (each dot → `toggleHabitDate` for back-fill).
- Removed from Home: Morning brief, Today's plan (tip card), This week, Daily
  routine, Daily/General tabs. Their render fns guard on missing els → safe no-op.
- **Global right rail hidden on Home** (`body[data-route="today"]`): Home owns its
  own habit rail now, so the needs-attention/next-events/daily-habits rail + its
  mobile bolt button are hidden here; wall takes full width. Rail stays on other
  routes for now.
- Verified in local preview (desktop + mobile): renders, no console errors,
  stickies + rings + trails correct.
- **Transitional:** Board + Habits tabs still in nav (Board now duplicates the
  wall; Habits tab still hosts full habit management — rest days, descriptions).
  Fold/remove once the rail gains management. **Morning journal prompt is paused**
  — it returns when Diary is built (next).

### 2026-07-27 — Increment 3 (v200): Diary = classic journal book
- New **`diary`** route (added to ROUTES/ROUTE_TITLES + desktop & mobile nav with
  the `#i-learn` book icon). Placed Home · … · Brain · **Diary** · Notebook.
- **`rDiary()`** renders a two-page book over `S.routineLog[iso]`:
  - **Left page = Journal:** the 5 `ROUTINE_JOURNAL` questions as handwriting
    (Kalam) fields on ruled paper, each with a mic (`fieldMic`); saved via the
    existing `saveJournalFor(iso,…)`.
  - **Right page = Routine + Habit stamps:** `_routineBlocks(iso)` checklist
    (`diaryToggleRoutine`) + a habit stamp per `S.habits` (tap = `toggleHabitDate`).
  - Book chrome: ruled-paper gradient, centre-spine shadow, burnt-orange **ribbon**
    on today, prev/next day (future disabled) + Today. Own cursor `UI.diaryDate`.
  - Global right rail hidden on this route too (full-width book).
- Wired into `setRoute('diary')`, `render()`, and `toggleHabitDate` (stamp refresh).
- Verified in preview (desktop): book renders, journal values persist, routine
  checks + habit stamps toggle, ribbon on today, no console errors. Mobile stacks
  via `@media(max-width:800px)`.
- **Journaling is restored** (it was paused when Home was rebuilt). Follow-up idea:
  a small "How did yesterday go? →" nudge on Home that opens Diary to yesterday
  (the old proactive prompt) — parked, offer to Zander.

### 2026-07-27 — Increment 4 (v201): Calendar — unified W2 lanes + DV1 timeline
- **Unified** the calendar: removed the events/reminders/habits **mode toggle**
  and the **3-day + month** views. Week + Day only now.
- **Week = `buildWeekLanes()`** (W2): a CSS-grid `112px + 7×1fr` with rows —
  **Events** (GCal non-task via `evChip`), **Reminders** (local `S.reminders`
  that `reminderFiresOn` + Google tasks), then **one lane per habit** as a
  tap-to-fill tick grid (`toggleHabitDate`) with today highlight, rest-day fade,
  future-day lockout. This is the back-fill grid.
- **Day = `buildDayTimeline()`** (DV1): all-day/reminder band on top, a 7am–10pm
  hour spine with timed events (`evChip`, tap empty slot → `openNewEvent` at that
  hour), and a right **dock** with today's habits (tickable) + a jump to the
  journal for that day.
- `rCal` coerces any legacy view to week/day and dispatches to the two builders;
  old builders remain defined but unused. Reminders management panel
  (`#cal-reminders`) + coming-up kept below the grid.
- Global right rail hidden on the calendar route too (full-width grid).
- Verified in preview (mobile + desktop): week lanes render with event/reminder
  chips + habit tick grid (today highlight, rest-day fade); day timeline has the
  hour spine + band + habit dock. No console errors. Event/reminder editing works
  via the existing `evChip` delegate + `openReminderModal`.

### 2026-07-27 — Increment 5 (v202): Projects streak-keeper + Brain spark→fire
- **Projects = streak keepers.** New `b.checkins` (array of ds) + `_projStreak(b)`
  (current streak, `broken` when lapsed, `checkedToday`) + `projCheckIn(id)`.
  - Card (`rBuilds`) now leads with 🔥 streak + a **Check in / Revive / ✓ Checked
    in** button (stopPropagation so the card still opens on tap). Dropped the
    stage tag, stagebar and log-count from the card.
  - Detail (`renderProjectDetail`): streak row + check-in under the title;
    **removed the stage stepper and the daily-progress-log card** (the v195
    scrap). Kept description, scratch notes, phase (auto) controls.
- **Brain = spark → fire.** Ideas tab relabelled **✦ Sparks**; each spark gets a
  **🔥 Fan → project** button (`fanIdeaToProject`) that moves it out of Brain into
  a new streak-keeper project (starts today's check-in) and drops you on it.
  Brain + Projects are one pipeline.
- Verified in preview: streak math correct (3-day live / lapsed→Revive /
  not-started), fan button present. No console errors. (Dev note: preview now
  runs on an auto-assigned port — `autoPort:true` in launch.json — because
  another local app holds :3000.)

### 2026-07-27 — Increment 6 (v203): IA cleanup — fold Board + Habits into Home
- **Removed Board + Habits from the nav** (desktop + mobile). Nav is now exactly
  the target IA: **Home · Calendar · Projects · Brain · Diary · Notebook** (+
  Settings). Routes/containers/render fns kept (hash-reachable, harmless) but
  unlinked; dropped from the command-palette "Go to" actions too (with People).
- **Habit management folded into the Home rail:** tapping a habit's name opens
  `openHabitModal(id)` — the full management modal (description, rest days,
  delete). The rail already did daily ticking + streaks + back-fill. Board was
  already a duplicate of the Home wall.
- Verified: nav = the 6 intended entries, rail name opens the management modal
  with rest days + description intact, no console errors.
- **Redesign core is complete.** Remaining = optional polish: dark twin of
  Apricot, Home→Diary "how did yesterday go?" nudge, Notebook/Settings/login
  cosmetic passes, empty-state copy.

### 2026-07-27 — Increment 7 (v204): feedback round 1
- **Habit trail day numbers:** each trail dot now shows its weekday letter + day
  number so you can see exactly which days are filled.
- **Sticky wall reworked** (`UI.homeView`, persisted): **Wall** = a free-form
  board — stickies are absolutely positioned in an organic scatter and are
  **draggable** (position saved per task in `t.wx/t.wy`); **List** = a clean
  structured list for focus / sharing. Toggle in the wall header. Fixes the
  "rows sized to the tallest note" gripe.
- **Calendar month view restored** (per user request — it was removed in the
  redesign). Toggle is now Week · Day · Month; `rCal` dispatches month to the
  existing `buildMonthView`.
- **Diary restyled to match the Notebook:** dropped the ruled-lines/hard-spine
  look; now cream `--paper` A4 sheets with 14px corners, `--shadow-lift`, accent
  spine + red margin stripe — same visual family as `.nb-page`.
- **Calendar disconnect — two fixes + diagnostics:**
  - **Root-cause guard:** the GIS callback no longer nukes the cached token when
    a *proactive* silent refresh fails but the token is still valid (`_gtokMsLeft()>0`).
    In an installed PWA the silent refresh routinely fails even mid-session; the
    v198 proactive refresh was then clearing a good token → "disconnecting the
    whole time." Now only a genuinely-expired token (or a reactive 401) clears it.
  - **Diagnostics:** the disconnect banner now appends the real reason
    (`_humanGisError(_gisLastError)`) so the failure mode is visible.
  - **Still open:** the >1hr-closed PWA reopen case is a platform limit (Firebase
    doesn't expose the refresh token; GIS silent refresh can't reach Google's
    cookies in a standalone PWA). The real fix = server-side auth-code flow with a
    stored refresh token — proposed to Zander (needs client secret + a service
    account on Railway). Tracked in task #12.
- Verified in preview: numbers show, wall drag + list toggle + persistence work,
  month grid renders (35 cells), diary matches notebook paper. No console errors.

### 2026-07-27 — Increment 8 (v205): sticky wall v2 (Zander's vision)
- **Smooth drag:** the clunk was the Firestore save-echo re-rendering the wall
  mid-move. Fixed: `rHomeWall` now (a) never rebuilds while `_wallDrag` is set,
  and (b) when the note SET is unchanged, refreshes content **in place**
  (`_wallUpdateInPlace`) instead of `innerHTML=`. Drag saves stay debounced (300ms).
- **Category → colour:** new `S.categories` (`[{id,name,color}]`, defaults Personal
  + Work, persisted). Each task has `t.category`; sticky colour = category colour
  (light tint bg + colour tape + colour dot). Legend above the board; a category
  **picker** on each note's dot, and a **manage** popover (add / rename / recolour /
  delete). New categories (e.g. company names) via prompt.
- **Star rating (0–5)** on the card, click to set (`t.stars`); shown in List view too.
- **Four visual regions** (Today / This week / This month / Future) as labelled
  columns on a **1200px canvas**. **Purely visual** — only `t.wx/t.wy` is stored; a
  note's region is just where it sits. **daily/general split dropped from the wall.**
- **Zoom** (60–130%, persisted) via CSS `zoom`; drag math is zoom-aware.
- **Per-region "Arrange"** stacks that column's notes by stars (importance).
- Persistence: `categories` added to save payload + snapshot loader. Verified:
  category colours, stars, 4 regions, zoom, arrange-by-importance, List view dots
  + stars. No console errors. (Drag *feel* needs a real device test.)

### 2026-07-27 — Increment 9 (v206): sticky wall v3 (feedback round 3)
- **Text no longer highlights on drag** — `user-select:none` on the board + notes.
- **Colour ← area, stars ← priority** (both real task fields; scrapped the separate
  `t.category`/`t.stars`). `_taskAreaColor` (from `getOrderedAreaList`),
  `_taskStars` (`PRI_STARS` urgent=5…someday=1). Card stars set the real priority
  via `STARS_PRI`; the area dot opens the task modal. Legend now shows AREAS.
- **Layout = 3 top regions (Today / This week / This month) + full-width Future
  below** (`WALL_REGIONS` with x/y/w/h). Bigger notes (186px), roomier.
- **Pan-and-zoom canvas, no scrollbars:** transform = `translate(pan) scale(zoom)`.
  Drag empty space to **pan**; **Ctrl/Cmd+wheel** to zoom; +/− buttons zoom to
  centre. Zoom **capped at 100%**, down to 35% ("shouldn't increase size"). Pan +
  zoom persisted. Note-drag math is zoom-aware; region membership for Arrange is by
  where the note sits.
- **Zoomed-out hover-enlarge:** `<0.72` adds `.zoomed`; hovering a note pops it to
  1.9× so it's readable, shrinking back on leave.
- **Pushpin instead of tape** (`.wb-pin2`) that **lifts out while carried** and
  drops back on release; plus a subtle **carry wobble** animation while dragging.
- Verified: area colours, priority stars (+ star→priority), 3+1 regions, transform
  pan/zoom, zoom clamp 0.35–1, zoomed class, pushpin, no text-select. No errors.
  (Live drag/pan feel + animations need a real device.)

### 2026-07-27 — Increment 10 (v207): wall v3.1 (feedback round 4)
- **Pushpin stem extends** when a note is picked up (`::before` height 11→26px,
  transitioned) so it reads as pulled out, not just floating.
- **Sections fill the screen; big canvas + small notes.** Canvas is now
  2460×1600 with three large top regions + full-width Future; notes shrunk to
  152px so a section holds ~25–30. Min zoom is **dynamic = "all four sections
  fit"** (`_wallMinZoom`), and that's the floor — you can't zoom out past the
  sections. Default zoom = fit. Zoom **in** up to 1.6.
- **Contain-clamp pan** — centres when the canvas is smaller than the viewport,
  no empty space past the sections otherwise.
- **Floating region badge** (`#wall-region-badge`): when zoomed in past the fit
  view, a pill shows "▸ <region> · Arrange" for whichever region the viewport
  centre is over (`_wallCurrentRegion`), so you always know which block you're in
  and can arrange it without seeing its header.
- Reset the persisted zoom/pan keys (`los_wall_z2/p2`) since the canvas geometry
  changed. Verified: fit-default, min=fit, 152px notes, zoom-in, badge tracks the
  region. No errors.

### 2026-07-27 — Increment 11 (v208): full-screen board
- **"⛶ Full screen" button** on the wall header. `toggleWallFullscreen()` moves
  the `.home-wall-col` to `<body>` (the `.route` has a transform that would trap
  `position:fixed`), applies a fixed-overlay class, and best-effort requests the
  real Fullscreen API. Exit via the button, Esc (`fullscreenchange`), or by
  navigating away (`setRoute` guard). Restores the col to its grid slot on exit.
- CSS `.home-wall-col.wall-fs` = fixed inset:0 flex column; board flexes to fill.
  Verified: fills viewport (720px), restores to grid, no errors.

### Architecture notes (for the surface rebuilds)
- Routing: `ROUTES` + `ROUTE_TITLES` arrays (line ~4009); `setRoute()` toggles
  `.active` on `<div class="route" data-route="X">` containers + nav links.
  Global `render()` (~16338) re-renders everything (rTasks, rHabits, rCal, …).
- Route containers live at: today 2794 · board 2857 · calendar 2867 ·
  projects 2915 · habits 2930 · brain 2942 · notebook 2966 · people 2999 ·
  settings 3011.
- Render fns: rBoard 7112 · rHabits 10053 · rPeople 15679 · rTasks/rCal/rFocus
  via render(). Home rebuild = merge rTasks + rBoard (stickies) + rHabits
  (rail) into the `today` container.

## Open questions / parked ideas

- Dark twin of Apricot — build after the light skin ships.
- B6 diary extras (rotating prompt + journaling streak) — parked, layer onto B1
  later.
