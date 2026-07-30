# Life OS — Design Ideas & Roadmap

**The capture file.** Every future feature or design idea that is *not* being
built right now lands here.

> **Rule: never build from this file automatically.** Items here are captured,
> not committed. They graduate only when explicitly picked up.
> `design-system.md` = what IS. This file = what MIGHT BE.

---

## 1. Calendar *(rebuild step 6)*
Current score 7/10 — needs a complete rethink. Everything should live together
naturally in one surface:
- Views: **Week · Month · Agenda · Timeline**
- Project **deadlines** and **milestones** on the calendar
- **Gantt integration**
- Habits, events, reminders unified with Google Calendar
- Open question: one calendar with view modes, vs distinct tools sharing a data layer

## 2. Projects *(steps 7–8)* — flagship
Current implementation is temporary. Each project becomes **its own workspace**
(Notion page × Linear issue tracking × Apple polish):
- Overview · description · status · priority · due date
- Milestones · subtasks · **dependencies**
- Notes · documents · images · videos · links
- **AI summaries** · meeting notes · pinned information
- Progress · activity history · comments
- Timeline · **Kanban** · **Gantt** · calendar integration
- Resource allocation

## 3. Gantt View *(step 9)*
A dedicated project timeline visualising projects, milestones, subtasks,
deadlines, dependencies and calendar overlap. **Eventually: drag tasks directly
on the timeline.**

## 4. Library — Diary + Notebook merge *(step 10)*
Merge Diary and Notebook into one feature ("Library" / "Books"). The diary is
simply one book; business, personal, research, recipes, travel, meeting notes
are others — all books in a personal library.
- **Locked (2026-07-30):** a *premium digital library*, **not** a realistic
  bookshelf. Depth/shadow/motion only — no skeuomorphic textures, **no page
  curls**. Books rest on elegant shelves, ease forward on hover, and open by the
  cover expanding into the workspace with contents fading in. Page navigation =
  fast horizontal slides / subtle crossfades. "Handling a beautiful notebook,"
  not simulating paper.
- Inside each book: rich text · images · links · embedded files · AI summaries ·
  drawings · checklists · tables.
- Intended as a **signature feature**.

## 5. Brain *(step 11)* — knowledge system
Currently too empty. Should separate: **Ideas · Knowledge · Resources ·
Bookmarks · Quotes · Learning · Research**.
- AI constantly connects related ideas
- Eventually **graph relationships** between ideas

## 6. AI Command Centre *(step 12)* — the main feature
Treat the AI input bar as the command centre.
- Type **or speak** naturally; AI understands intent
- **Preview every change → allow editing → then commit** across tasks,
  calendar, projects, diary, library, brain, habits — everything
- On mobile this becomes the *primary* interface: voice-first, minimal UI,
  almost conversational

## 7. Right Sidebar Widgets *(step 13)*
Keep it — it's one of the strongest parts of the app. Improve spacing,
typography, interactions. **Needs Attention / Next Events / Daily Habits should
become intelligent widgets rather than static lists.**

## 8. Settings *(step 14)*
Layout is clean; needs better visual hierarchy. Should feel like **macOS
Settings** — less flat, better grouping, spacing, and toggles.

## 9. Today Dashboard *(step 4)*
Current score 8.5/10. Keep horizontal drag-and-drop columns (**do not** convert
to one long vertical list). Needs: more breathing room · less spreadsheet
feeling · more intentional cards · sections as independent workspaces ·
**improved empty states** · improved drag animation.

## 10. Navigation — future modes
The sidebar width is already a token (`--sidebar-w`) to support:
- **Expanded · Compact · Icon-only · Mobile drawer**
- Command palette grows out of the search field (Raycast/Spotlight/Linear):
  search + AI + quick actions + navigation + commands

## 11. Mobile *(step 15)*
Sidebar → slide-out drawer. Voice-first AI as the primary interface.
No desktop-only assumptions anywhere.

---

## 12. Task Energy *(captured 2026-07-31 — do not implement)*
- An **optional** "energy required" attribute on a task.
- The AI may later factor in **energy, calendar load, time of day and recent
  activity** when recommending what to work on.
- **Do not implement yet.**

## 13. Focus Mode *(captured 2026-07-31 — do not implement)*
- A **distraction-free workspace centred on a single task**.
- Unrelated interface elements fade into the background.
- Exiting returns to the normal Life OS interface.
- **Do not implement yet.**

---

## 14. Unlocked by the v2 platform *(designed, not built)*

The Railway + PostgreSQL + R2 architecture makes these possible for the first
time. They are captured here, **not scheduled** — each still needs its own
design pass in its own step.

- **Attachments everywhere** — files, images, video and audio on projects,
  Library pages, tasks and brain items (impossible today: no file storage exists).
- **Task recurrence** — repeating tasks (only reminders and calendar events can
  repeat today).
- **Task ↔ project links, milestones and dependencies** — the foundation of the
  planned Gantt view.
- **A searchable diary** — diary content is invisible to search today.
- **Brain relationships** — `brain_links` is the seed of the knowledge graph.
- **Real exports** — JSON, Markdown/HTML for Library content, CSV, attachment
  bundles. The app has no export at all today.
- **Server-side AI** — preview-first as a structural guarantee, plus rate limits
  and a token budget.
- **Cross-device settings** — theme and notification preferences currently do
  not sync; `user_preferences` fixes that.
- **Future sharing / collaboration** — `profile_memberships` exists so this
  needs no data-model change later. **Explicitly not a v2 goal.**

---

## Unresolved questions
- **Greeting vs one-hero rule:** resolved as *greeting is the hero of Today +
  the brand identity moment*; every other screen gets its own single hero.
  Revisit if it should literally persist on every page.
- **UI font:** Inter today; **Geist** floated as a possible future swap.
  (Playfair stays locked to the "Life OS" wordmark only.)
- **Gradient status dots for AI features** — motif idea from the polish pass;
  location not yet decided (composer? Brain? AI command bar?).
- Whether habit rings should also appear outside the right rail.

---

## Captured & already decided (see design-system.md)
- One-accent colour system (purple + green + red) — **locked**
- Playfair wordmark as the only serif — **locked**
- Library without page-curls — **locked**
