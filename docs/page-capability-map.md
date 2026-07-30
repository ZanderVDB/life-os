# Life OS — Page Capability Map

**Audit date 2026-07-31 · version v239.** What each screen can actually do.

**Reachable pages (7):** Today · Calendar · Projects · Diary · Brain ·
Notebook · Settings
**Present in the file but unreachable (3):** Board · Habits · People

Two surfaces appear on every page: the **right rail** and the **AI bar**.

---

## 1. TODAY

**Intent:** the landing screen — what matters now.

**Contains:** greeting · "This week" 7-day strip · Reminders-due (hidden when
empty) · Tasks in four buckets · a weekly-review card (Sun/Mon only).

| | |
|---|---|
| **Reads** | tasks, habits, reminders, Google events + Google Tasks (live), routine log |
| **Creates** | tasks (modal), reminders |
| **Edits** | task text/category/time/notes/priority/steps; bucket + order by drag |
| **Deletes** | tasks (confirm); completed tasks auto-pruned past 50 |
| **Autosaves** | everything; ticking writes immediately, the rest after 300 ms |
| **Confirms** | deleting a task; moving a dated task too late |
| **On leaving** | closes the task modal, resets the week strip's centring, scrolls to top |

**Unfinished / limited**
- **The due-date field in the task modal never saves** (see `technical-debt.md` D2).
- Drag-and-drop is **mouse-only**; the empty state still says "Drop tasks here"
  on a phone, where that gesture is impossible.
- No overall empty state — an empty board shows four empty drop zones.
- The "This week" strip is display-only; you cannot act on a day from it.
- Dropping a card outside a bucket still commits the last hovered position;
  there is no drag-cancel.

**Looks simple, is not:** buckets are *manual* statuses, not date ranges; a due
date only limits how *late* a task may sit. A migration runs on every render
and can trigger a save from inside drawing.

**Dead code behind it:** the previous Daily/General renderer (~180 lines), a
`saveTask` that nothing calls, `taskMoveTo`, and four render targets that no
longer exist in the page (morning brief, journal prompt, focus card, routine
box) which are still called on every draw and silently do nothing.

---

## 2. CALENDAR

**Intent:** one place for events, reminders and habits.

**Two independent switches:** view = Day / 3-day / Week / Month · mode =
Events / Reminders / Habits. (There is **no agenda or timeline view**.)

| | |
|---|---|
| **Reads** | Google Calendar, Outlook (if configured), Google Tasks, `S.reminders`, `S.habits` |
| **Creates** | Google events, Google Tasks, Life OS reminders |
| **Edits** | events (incl. recurring, with a this/following/all choice), reminders, habit ticks |
| **Deletes** | events, reminders |
| **Autosaves** | reminders and habit ticks locally; events write straight to Google |
| **Confirms** | overlapping events; recurring scope; deletions |

**Unfinished / limited**
- **Tasks never appear on the calendar.**
- **Projects never appear** — they have no dates at all.
- New Google events always land on the **primary** calendar, ignoring the picker.
- **Outlook is built but dormant** — needs a client id; and an Outlook-only user
  cannot create or edit anything, yet still sees a permanent "Google not
  connected" banner.
- Outlook times display in **UTC**; Google times display in the **event's own**
  timezone. Neither is converted to the viewer's.
- Writing recurrence supports only 5 simple rules — no interval, count or end date.
- Month bars beyond 4–6 rows are **silently dropped** in Events mode (Habits and
  Reminders modes do show "+N more").
- The overlap check only scans **one cached month**, so it misses conflicts
  across month boundaries.

**Fragile:** the event cache holds a single month; the calendar compensates with
an extra fetch and a de-duplication pass. Six view-builder functions and seven
blocks of CSS exist for view modes that were removed.

---

## 3. PROJECTS

**Intent:** a place to keep and revisit projects.

**Two views:** a card list, and a detail view.

| | |
|---|---|
| **Reads** | `S.builds` |
| **Creates** | projects (name, status, description) |
| **Edits** | title, description, "next", stage, scratch notes, phase |
| **Deletes** | projects (confirm), individual log entries |
| **Autosaves** | on blur for text fields; immediately for stage/status |
| **Confirms** | delete; an AI-suggested stage change |

**Unfinished / limited**
- **No tasks.** A project cannot contain or reference a task.
- **No dates** — no start, no due, no milestones, no dependencies. Only a
  creation stamp and a "last touched" time.
- **No files, images, videos, links, comments, or activity feed** beyond the log.
- Adding a progress log **requires an API key** — the flow is AI-only; without a
  key you cannot log progress at all.
- The AI **overwrites your description** when you log progress, with no preview.
- Progress is either a stage-index percentage or a recency badge; nothing is
  based on real work completed.
- A complete "mark as worked on today" function exists but nothing calls it.

---

## 4. DIARY

**Intent:** a daily journal, laid out like a book.

Left page: five fixed questions. Right page: today's routine checklist and
habit stamps.

| | |
|---|---|
| **Reads** | `S.routineLog`, `S.routine`, `S.habits` |
| **Creates** | a day entry on first write |
| **Edits** | the five answers; routine ticks; habit ticks |
| **Deletes** | **nothing — entries cannot be deleted** |
| **Autosaves** | **on blur only** |
| **Confirms** | nothing |

**Unfinished / limited**
- **Text typed and never blurred is lost** (no keystroke save, no save on exit).
- **No search** anywhere — diary content is invisible to the global search.
- No title, tags, mood, attachments, or multiple entries per day.
- The five questions are fixed in code and cannot be edited (unlike the routine).
- Journal text and routine ticks share one object, which blocks a clean move
  into a future Library.
- The same five questions are rendered by **three** different pieces of code.
- **The AI bar has full app-wide write power here**, because "diary" was never
  added to the page-permission table.

---

## 5. NOTEBOOK

**Intent:** free-form thinking space, presented as a book.

| | |
|---|---|
| **Reads** | `S.notebook` |
| **Creates** | sections, pages |
| **Edits** | rich text per cell; layout; section name/colour |
| **Deletes** | pages and sections (confirm when non-empty) |
| **Autosaves** | 1.2 s after typing stops; immediately for structural changes |
| **Confirms** | deleting non-empty pages/sections |

**Formatting available:** bold, italic, underline, strikethrough, heading,
bullets, numbers, highlight, clear. **Not available: tables, images, links,
checklists, code.**

**Unfinished / limited**
- Uses a **deprecated browser editing API**; content is stored as raw HTML, and
  nothing sanitises what *you* type or paste (only AI output is sanitised).
- **Undo is memory-only** (40 steps, no redo) — lost on reload.
- Changing a page layout **merges cells and loses their boundaries**.
- Deleting the last page of a section deletes the **whole section**.
- Dictation **overwrites formatting** in the target cell.
- Two identical toolbars and two search implementations are maintained separately.
- Spread and font choices are per-device and never sync.

**Genuinely good:** page ids, `updatedAt`, a 3-level tree, and a small set of
access helpers make this the **best foundation for a future Library**.

---

## 6. BRAIN

**Intent:** ideas, resources and knowledge.

Three tabs — Ideas · Resources · **Knowledge** (stored as `notes`).

| | |
|---|---|
| **Reads/Creates/Edits/Deletes** | the three lists, through one shared modal |
| **Autosaves** | on blur/change |
| **Confirms** | delete |

**Unfinished / limited**
- It is **three plain lists**. No links between items, no tags (beyond one
  resource tag), no embeddings, no semantic search, no graph.
- Search covers **Brain only**, and is a plain substring match.
- Notes render oldest-first while the other two render newest-first; only Ideas
  has a designed empty state.
- Six save/delete functions are orphaned; leaving the page clears the search box
  but not the filtered list.
- The AI can create items but only ever sees their **titles** — it cannot read,
  edit or delete them.

---

## 7. SETTINGS

Eight tabs: General · Notifications · Calendar · AI · Routine · People ·
History · Account.

**Functional and synced:** AI confirm mode, API key, life rhythm, AI memory,
calendar defaults, default write calendar, calendar visibility, Areas, routine
editor, faith focus, habit catch-up, morning check-in, people settings, sounds.

**Functional but device-only (do not sync):** **theme**, AI Do/Ask mode, *all
three notification systems*, notebook spread/font, last-open tab.

**Inert / placeholder:** the subscription row (billing is an `alert()`
placeholder; the paywall is switched off).

**Notable gaps**
- **No export or backup of any kind.** No way to get your data out.
- No privacy or analytics controls beyond the legal links.
- The API key is stored **in plain text in both the browser and the database**,
  entered through a raw browser prompt with no validation.
- Two panes are both labelled "general", so the About block shows alongside
  Appearance.
- The People tab configures a feature whose page cannot be reached.
- Deleting all data leaves the sign-in identity, one presence record (wrong
  path), and a non-`los_`-prefixed cache key behind.

---

## 8. RIGHT RAIL (every page)

Three cards: **Needs attention** · **Next events** · **Daily habits**.

- Needs attention: urgent tasks, tasks older than 14 days (by creation date),
  plus project and people nudges. Capped at 8. Clicking a task scrolls to the
  list but no longer highlights it.
- Next events: refreshes every 60 s from Google.
- Daily habits: progress rings, rest-day label, edit pencil.
- On phones the rail becomes a drawer. **Swipe-to-open works; swipe-to-close is
  a no-op** (the handler was never finished).

---

## 9. AI COMMAND BAR (every page)

Present on every screen including Settings. Two modes: **Do** (writes) and
**Ask** (read-only). See `integration-map.md` for the full journey.

- **What it can do:** create tasks/events/habits/reminders/projects/brain
  items/notebook pages/people; complete tasks, habits, reminders, routine
  items; delete tasks and events; update events.
- **What it cannot do:** delete habits, projects, brain items, people or
  notebook pages; un-complete anything; edit most objects.
- **Preview:** only when confirm-mode is "all" **or** the change touches people.
  By default, task/habit/note changes apply with **no preview at all**.
- **Not atomic:** changes are applied one by one with no rollback. Local changes
  are saved *before* the calendar step, so declining the calendar confirmation
  still leaves everything else written.
- Asks up to **two rounds** of clarifying questions, then commits on round three.

---

## 10. SEARCH / COMMAND PALETTE (Ctrl/Cmd+K)

Searches: actions, routes, profiles, open tasks, projects, people, habits,
reminders, notebook pages, brain items, AI history. Whole-word substring
matching, max 5 results per group.

**Does not search:** calendar events, **the diary**, routine items, settings.
Some results (Habits, People) navigate to unreachable pages and land the user on
Today instead. The shortcut fires even while typing in a text field.

---

## 11. AUTHENTICATION & ONBOARDING

**Google sign-in only** (no email/password), with popup→redirect fallback.
Sessions persist locally. A six-step coach-mark tour runs once, and still
describes "People" and "Habits" tabs that no longer exist.

A **presence system** blocks the app with a full-screen overlay when the same
account is active on another device within the last 45 seconds ("Use this
device" to take over).

Trial/paywall scaffolding exists but is disabled — nobody is gated.

---

## 12. MOBILE

Responsive down to phone size via **13 breakpoints**. Sidebar → drawer, rail →
drawer, dedicated notebook bars, safe-area padding.

**What breaks:**
- **Task drag-and-drop does not work at all** (HTML5 drag has no touch support,
  and there is no alternative move control) — *task management is effectively
  impossible on a phone.* The same applies to reordering Areas.
- **Landscape blanks the entire app** on any phone/tablet, showing a "rotate"
  screen. The web manifest still declares `orientation: any`.
- Pinch-zoom is disabled globally; only the notebook re-implements it.
- Install support is degraded on Android (SVG-only icon, no PNG sizes).
- Notifications only fire while the app is open.

Voice input exists in three separate implementations (AI bar, single field,
notebook), all using the browser's speech API.

---

## 13. UNREACHABLE PAGES (still in the file)

| Page | State |
|---|---|
| **Board** (sticky-note wall) | full markup + renderer; reads tasks by the dead `dailyDate` field |
| **Habits** (full page) | full markup + renderer, tier badges, stats, rest-day picker — its renderer still runs on every habit draw |
| **People** | full markup + renderer; **its data is still saved on every write**, and the AI can still create people |

All three are redirected to Today by the router.
