# Life OS — Current System Audit

**Audit date: 2026-07-31 · App version at audit: v239**

This document describes **what the system is today**, not what it should
become. It is written in plain English. Where a technical term is needed, it
is explained on first use.

> Companion documents:
> `data-model-map.md` (objects + fields) · `page-capability-map.md` (page by
> page) · `integration-map.md` (external services) · `technical-debt.md`
> (risks) · `redesign-dependency-map.md` (what order to rebuild).

---

## PART A — How the application is put together

### A1. It is one very large file

The entire application is a single file, `index.html` — about **18,000 lines
and 1.05 MB**. It contains the styling, the page markup, and all the
programme logic together. There is no build step and no framework. Supporting
files are tiny: `sw.js` (offline cache), `server.js` (a ~50-line web server),
`config.js` (Firebase connection settings), `manifest.json`, `icon.svg`, plus
`privacy.html` and `terms.html`.

**What this means in practice:** every change touches the same file, nothing
can be loaded on demand, and the browser must download and parse the whole
1 MB before anything appears.

### A2. All data lives in one object in memory called `S`

`S` holds the user's entire world while the app is open — tasks, habits,
projects, notes, diary, settings, everything. It has **36 top-level fields**.

```
tasks, builds, learning, ideas, notes, customEvents, habits, resources,
reminders, dayNotes, disabledCalendars, aiHistory, soundsEnabled,
aiConfirmMode, workProjects, calendarDefaults, notebook, habitCatchupEnabled,
checkinLevel, morningHabitCatchup, routineLog, routine, faithFocus, mode,
defaultWriteCalendar, aiMemory, weeklyReview, people, peopleTags,
peopleLevelNames, peopleSettings
```

Naming is historical and often does not match the user-facing label:

| In the code | What the user calls it |
|---|---|
| `S.builds` | **Projects** |
| `S.workProjects` | **Areas** (task categories) |
| `S.learning` | dead — merged into habits long ago |
| `S.routineLog` | **the Diary** (plus routine tick-boxes) |
| `S.dayNotes` | nothing — orphaned data, no screen shows it |
| `S.notes` | Brain → "Knowledge" tab |
| `S.ideas` / `S.resources` | Brain → Ideas / Resources tabs |

### A3. Everything is stored in ONE database record

Data is kept in Google Firestore at:

```
users/{your-account-id}/data/{profile-id}
```

Every save writes the **whole of `S`** into that single record. There are no
separate records for individual tasks, notes or projects.

**Consequences:**
- Firestore has a hard limit of **1 MB per record**. Everything shares it.
- Two things grow forever and are never pruned: the **diary** (`routineLog`,
  one entry per day) and the **notebook** (rich text). Nothing measures or
  warns about the size.
- You cannot load part of the data. It is all or nothing.

There is a second small record, `.../data/_index`, listing the profiles, and a
`.../data/presence` record used to detect the same account being open on
another device.

### A4. Saving (rewritten in Step 3, now healthy)

Local memory is the source of truth the moment you act. Saving happens in the
background and never blocks typing.

- Rapid edits are **coalesced** — 50 keystrokes produce one write.
- The app **ignores the database echoing your own writes back**, so a save
  causes no re-draw. (Before Step 3 this caused the "rubber-banding".)
- A genuine change from another device is **held back while you are typing or
  dragging**, then applied when you finish.
- Failures retry with increasing delays and never discard your edits.
- The save indicator stays silent unless writes are genuinely failing.
- The app refuses to write before the first load completes, so an empty screen
  can never overwrite real cloud data.

### A5. Drawing the screen is all-or-nothing

There is one function, `render()`, which redraws **every list on every page**
— tasks, habits, projects, brain, calendar, attention, and more — regardless
of which page you are actually looking at. It even redraws pages that can no
longer be reached. It is called from 22 places. Across the app there are
**163 places that rebuild a whole block of screen at once** by replacing its
HTML.

**Consequence:** redrawing is expensive, and anything the browser was holding
(text selection, a half-finished drag, scroll position inside a list) is
destroyed unless specially protected. Two screens have hand-written
protections against exactly this (the notebook refuses to redraw while a cell
is focused; the sync layer restores the focused field afterwards).

### A6. Navigation

Seven pages are reachable: **Today, Calendar, Projects, Diary, Brain,
Notebook, Settings**. Moving between them shows and hides sections that are
all already present in the page.

**Three more pages still exist in the file but cannot be reached** (no menu
entry, and the router silently redirects them to Today):

| Hidden page | Line | Still has |
|---|---|---|
| `board` — sticky-note wall | 3265 | markup + `rBoard()` renderer |
| `habits` — full habits page | 3338 | markup + `rHabitsFull()` renderer |
| `people` — relationship tracker | 3424 | markup + `rPeople()`, **and its data is still saved** |

`S.people`, `S.peopleTags`, `S.peopleLevelNames` and `S.peopleSettings` are
still written to the database on every save even though nothing can display
them. The onboarding tour still tells new users about "People" and "Habits"
tabs that no longer exist.

### A7. Profiles

The app supports up to **two profiles** (e.g. Personal and Business). Each has
its own database record and its own Google/Outlook connection. Switching
profiles tears down the live connection, clears memory, and reloads.

**Confirmed defect:** the clear-out step misses four fields — `reminders`,
`people`, `peopleTags`, `peopleLevelNames`. The reload step also keeps the old
value whenever the new profile's record does not contain that field. So
switching to a profile that has never had reminders leaves the *previous*
profile's reminders in memory — and the next save writes them into the new
profile's record. See `technical-debt.md` risk **D1**.

### A8. Background activity

Five repeating timers, all every 60 seconds:

| Timer | Purpose |
|---|---|
| `refreshGCalWarn` | show/hide the "calendar not connected" banner |
| `checkNotifSchedule` | fire scheduled daily notifications |
| `_iarMotivationTick` | ask the AI for a motivational nudge |
| `_iarEventTick` | warn about an upcoming calendar event |
| `rUpcom` | refresh the "next events" list |

**Notifications only work while the app is open.** They are produced by
`new Notification(...)` on a timer inside the page. The service worker has no
push handler. Closing the tab stops all reminders.

Two of these timers call the AI on a schedule, which spends API credit in the
background whenever the tab is visible.

### A9. Offline and updates

`sw.js` serves files from a local cache first and only falls back to the
network. It never refreshes the cache in place. New code reaches users only
when the cache name changes, which is why **`APP_VERSION` in `index.html` and
`CACHE` in `sw.js` must be bumped together** on every deploy. Requests to
Firebase, Google and Anthropic bypass the cache entirely.

Firestore's own offline store means the app opens and works without a
connection; writes queue and flush later.

### A10. There is no file, image or attachment support anywhere

Confirmed across the whole codebase: no file picker, no `FileReader`, no
drag-in of files, no image embedding, no Firebase Storage usage. A
`storageBucket` is configured but never used.

This affects the plans for Project documents/images/videos and Library
embedded files — **none of that infrastructure exists today.**

---

---

## PART B — What the system is actually capable of

Beyond what the screens show:

- **It can write to Google Calendar in both directions**, including editing a
  single occurrence, "this and following", or a whole repeating series.
- **It has a complete Outlook implementation** that has never been switched on.
- **The AI can perform 20 different operations** across nearly every object type
  — including creating people and notebook pages — and by default applies most
  of them **with no preview**.
- **It has a presence system** that blocks the app when the same account is open
  on another device.
- **It supports two profiles**, each with its own Google connection.
- **It has three separate voice-dictation implementations.**
- **It keeps a 200-entry AI history and a 50-entry completed-task history.**
- **It has an unused paywall, trial timer and subscription placeholder.**
- **It cannot store a single file, image or attachment.**
- **It has no export or backup of any kind.**

---

## PART C — Current vs future vision

For each system: what exists · what to keep · what to rethink · what to replace ·
what is missing.

### Tasks
- **CURRENT** — one list in four manual buckets, drag to reorder, subtasks,
  priority, category, notes, free-text time. Completed tasks vanish after 1.6 s
  and are pruned past 50.
- **KEEP** — the four-bucket model, drag-and-drop ordering, subtasks with the
  parent lock, the priority set.
- **RETHINK** — buckets vs dates (today they're unrelated); the 14-day "stale"
  rule (uses creation date); free-text `scheduledTime`; completion being
  effectively deletion.
- **REPLACE** — the due-date save path (broken); the dead Daily/General model
  still taught to the AI; desktop-only drag.
- **MISSING** — a real link to projects; recurrence; duration/effort; reminders
  per task; attachments, links and comments; energy *(roadmap)*.

### Today
- **CURRENT** — greeting, week strip, reminders due, four task buckets.
- **KEEP** — the greeting as the hero; the bucket workspaces; the rail beside it.
- **RETHINK** — the week strip is display-only; there is no overall empty state.
- **REPLACE** — four dead render targets still called on every draw.
- **MISSING** — anything actionable from the week strip; a first-run empty state.

### Calendar
- **CURRENT** — Day/3-day/Week/Month × Events/Reminders/Habits. Two-way Google.
- **KEEP** — the month spanning-bar engine (the strongest piece of layout code
  in the app), habit ticking per day, the recurring-edit scope choice.
- **RETHINK** — two orthogonal switches is confusing; the single-month cache.
- **REPLACE** — timezone handling; primary-calendar-only creation; the
  half-finished Outlook path.
- **MISSING** — **tasks on the calendar**, project dates, agenda and timeline
  views, drag-to-reschedule, paging.

### Projects
- **CURRENT** — title, description, status, a 7-stage index, scratch notes, an
  AI-written log.
- **KEEP** — the stage model, the log idea, automatic "gone quiet" detection.
- **RETHINK** — the AI silently rewriting your description; logging requiring an
  API key.
- **REPLACE** — the name collision between Projects and Areas; progress derived
  from a stage index.
- **MISSING** — **almost everything the vision needs**: tasks, start/due dates,
  milestones, dependencies, files, images, links, comments, activity history,
  real progress, Kanban, Gantt, calendar presence.

### Diary
- **CURRENT** — one entry per day, five fixed questions, routine + habit stamps.
- **KEEP** — the book layout, the fixed reflective questions, habit stamps.
- **RETHINK** — questions fixed in code; one entry per day.
- **REPLACE** — **blur-only saving** (loses text); journal and routine ticks
  sharing one object.
- **MISSING** — search, deletion, titles, tags, mood, attachments, ids/timestamps.

### Notebook
- **CURRENT** — sections → pages → 1/2/4 cells of rich text; spread view; voice;
  per-page AI refine.
- **KEEP** — the 3-level structure with ids, the book metaphor, refine, search.
- **RETHINK** — the deprecated editing API; memory-only undo.
- **REPLACE** — destructive layout merging; deleting a section by deleting its
  last page; unsanitised pasted HTML.
- **MISSING** — tables, images, links, checklists, attachments, durable undo.

### Library *(does not exist yet)*
- **CURRENT** — Diary and Notebook are separate and structurally very different:
  the diary is addressed by **date**, the notebook by **place**.
- **KEEP** — build on the **Notebook's** model; it is already a tree with ids.
- **RETHINK** — the diary must have `journal` separated from routine `checks`
  before it can move.
- **REPLACE** — nothing yet.
- **MISSING** — a "book" level above sections; per-book settings; a migration
  plan that also decides the fate of the orphaned `dayNotes`.

### Brain
- **CURRENT** — three flat lists (Ideas, Resources, Knowledge) with substring
  search.
- **KEEP** — the three categories, the single shared editor.
- **RETHINK** — whether it is a separate space at all, or part of the Library.
- **REPLACE** — search that only covers Brain; inconsistent ordering and empty
  states.
- **MISSING** — links between items, tags, semantic search, related-item
  discovery, a relationship graph, and any AI read access (it can only write).

### AI Command Centre
- **CURRENT** — one bar on every page, Do/Ask, page-scoped permissions,
  clarifying questions, an editable review queue, 20 operations.
- **KEEP** — page scoping, strict text matching, the clarification loop, the
  "You decide" escape, the editable preview, the forced review for people.
- **RETHINK** — preview being **off by default** for most changes; the 800-token
  budget for the biggest job; standing facts reaching only 5 of 9 prompts.
- **REPLACE** — non-atomic apply with the calendar running *after* the save; nine
  hard-coded model ids; no in-flight lock.
- **MISSING** — updating or deleting most object types; linking objects; a real
  conversation memory in Do mode; cost/rate limiting; streaming.

### Navigation
- **CURRENT** — seven pages, sliding indicator, command-palette-ready search,
  keyboard support, one-time logo intro *(rebuilt in Step 2)*.
- **KEEP** — all of it.
- **RETHINK** — the palette's reach (no diary, no calendar events).
- **REPLACE** — three unreachable pages still in the file.
- **MISSING** — compact/icon-only modes (tokens are ready), the palette becoming
  a real command surface.

### Settings
- **CURRENT** — eight tabs; most functional.
- **KEEP** — the tab structure, the routine editor, calendar defaults, AI memory.
- **RETHINK** — **theme and all notification settings are device-only**; two
  panes share the "general" label.
- **REPLACE** — the raw browser prompt for the API key; the inert subscription row.
- **MISSING** — **export/backup**, privacy controls, key validation, accessibility
  settings, per-device management.

### Mobile
- **CURRENT** — responsive across 13 breakpoints, drawer navigation, a rail
  drawer, notebook-specific bars, voice.
- **KEEP** — the drawer pattern, safe-area handling, the diagnostic log.
- **RETHINK** — 13 breakpoints is inconsistent; landscape blanks the whole app.
- **REPLACE** — **touch drag-and-drop** (does not exist); the unfinished
  swipe-to-close; the SVG-only icon set.
- **MISSING** — any mobile-specific architecture, offline-first behaviour, push
  notifications, and the planned voice-first interface.

---

*Object and field detail: `data-model-map.md`. Screen detail:
`page-capability-map.md`. External services: `integration-map.md`. Risks:
`technical-debt.md`. Rebuild order: `redesign-dependency-map.md`.*
