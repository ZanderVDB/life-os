# Life OS — Technical Risk & Debt

**Audit date 2026-07-31 · version v239.**

> **Architecture decision (2026-07-31):** Life OS v2 will move toward a
> **Railway-hosted backend** with **Railway PostgreSQL** for structured data and
> **Cloudflare R2** for binary files and exports. **Firebase Auth and Firestore
> may remain temporarily** during a controlled, reversible migration.
> **The migration has not started. Firestore has not been removed.**
> Several risks below are *addressed by* that architecture — they are not fixed
> yet. See `backend-architecture-v2.md`, `postgres-data-model-v2.md`,
> `r2-storage-architecture.md`, `storage-migration-plan.md`.

Ordered by severity. Each entry says what it is, where it is, what breaks,
whether the redesign will expose it, and whether it must be fixed first.

**Severity:** 🔴 critical · 🟠 high · 🟡 medium · ⚪ low

---

## ✅ D1 — Profile switching can copy one profile's data into another — **FIXED (v240)**

> **Resolved 2026-07-31 in Phase A1.** One authoritative `defaultProfileState()`
> factory (39 fields) now drives both reset and hydration; every hydration branch
> assigns, so an absent field lands on its default instead of the previous
> profile's value. A `_profileSwitching` barrier plus `flushPendingSaves()`
> stops any write landing in the wrong document mid-switch. 24 regression tests.
> **Existing contamination (if any) is NOT cleaned up — that needs A2 inspection.**
>
> Original description follows.

**What:** Switching profiles clears memory before loading the new profile — but
the clear-out **misses four fields**: `reminders`, `people`, `peopleTags`,
`peopleLevelNames`. The loader then *keeps the existing value* whenever the new
profile's record doesn't contain that field.

**Result:** switch from Personal to Business, and if Business has never had
reminders, **Personal's reminders are still in memory** — and the next save
writes them into Business's record. Silent cross-contamination.

**Breaks:** data integrity across profiles. Silent; no error.
**Exposed by redesign?** Yes — any new object added to `S` inherits the same bug.
**Fix first?** **Yes.** Small, contained, and it corrupts real data.

---

## 🔴 D2 — Due dates cannot be saved

**What:** The task modal renders a due-date picker. The **only** code that reads
it (`saveTask`) is **never called** — the real save path reads just four fields
(text, time, category, notes). The new-task builder also omits `dueDate`.

**Result:** setting a due date does nothing. Every downstream feature —
date→bucket clamping, the "move it later" popup, the due chip — is inert on any
task created since the feature shipped (v233).

**Breaks:** a shipped feature that appears to work.
**Exposed by redesign?** Directly — Step 4/5 is exactly this screen.
**Fix first?** Fix **as part of** the Task redesign; do not fix twice.

---

## 🔴 D3 — Everything is in one database record with a 1 MB ceiling

**What:** All of a profile's data is one Firestore record, rewritten in full on
every change. Firestore's hard limit is 1 MB.

**Growing without limit:** the **notebook** (rich HTML), the **diary**
(one entry per day, never pruned), **AI history** (200 entries, each with an
uncapped detail field), and `dayNotes`. Bounded: completed tasks (50), AI
memory (50).

**What breaks at the limit:** every save fails. The retry logic would surface it
as a permanent *"Offline — changes kept on this device"* — i.e. it looks like a
network problem, not a size problem. **There is no size guard, warning or
telemetry.** Data would then only exist on that device.

**Exposed by redesign?** Yes — richer projects, a Library and attachments all
increase the payload.
**Fix first?** The **decision** must be made early (split storage or not), even
if the work happens later. Building 12 screens against the wrong storage shape
is the expensive outcome.

---

## 🟠 D4 — Task management is impossible on a phone

**What:** Both drag-and-drop implementations (task buckets, area reordering)
use the HTML5 drag API, which **does not work on touch devices**. There is no
long-press fallback, no library, and no alternative "move to bucket" control.

**Visible symptom:** on a phone the empty bucket says *"Drop tasks here"* and
shows grab handles for a gesture that cannot be performed.

**Breaks:** the single most-used feature, on the most likely device.
**Fix first?** The **interaction decision** belongs in Step 4/5. Do not design
another desktop-only drag and retrofit touch at Step 15.

---

## 🟠 D5 — AI changes are not atomic, and the calendar step runs after saving

**What:** Applying AI changes mutates data one operation at a time with no
transaction and no rollback. Individual failures are silent. Then the **local
save happens**, and only **after that** do calendar operations run over the
network.

**Result:** declining the calendar confirmation still leaves every non-calendar
change permanently saved. A partly-failed batch reports success.

**Exposed by redesign?** Yes — Step 12 rebuilds this.
**Fix first?** No, but it must not be inherited by the new command centre.

---

## 🟡 D6 — Orphaned data that is still being saved — **DECIDED (v244)**

> **Resolved by decision 2026-07-31.** Live inspection: `dayNotes` **0/0** and
> `customEvents` **0/0** — both empty in both profiles, both **excluded from
> v2**, no content review needed. `learning` is superseded. `people` is
> archived-once-from-Personal and its **AI writes are frozen (v244)**.
> **Nothing is deleted yet** — fields are retired during final legacy cleanup,
> after migration validation and rollback approval.
>
> Original description follows.

| Data | State |
|---|---|
| `S.dayNotes` | Every screen that displayed it is gone. **CONFIRMED EMPTY (0/0)** — the feared hidden history does not exist. Excluded from v2. |
| `S.people` + tags + level names + settings | Page unreachable, data still saved. **AI writes FROZEN in v244** — the dataset can no longer grow. |
| `S.learning` | Merged into habits long ago; still written on every save |
| `S.customEvents` | Force-emptied on load and **written back empty** — an ongoing destructive cleanup |

**Risk:** a migration could silently destroy real user data — especially
`dayNotes`, whose naming closely resembles the live Notebook, making it easy to
migrate the wrong thing.
**Fix first?** **Decide** (keep / migrate / delete) before any storage change.

---

## 🟠 D7 — Three unreachable pages still in the codebase

`board`, `habits` and `people` have full markup and renderers but no navigation,
and the router silently sends them to Today. The full Habits renderer still runs
on **every** habit update. Search results and the onboarding tour still point at
them, dumping the user on Today with no explanation.

---

## 🟡 D8 — Redrawing is global

One function redraws **every list on every page**, including unreachable ones,
from 22 call sites; 163 places replace a whole block of HTML at once.

**Breaks:** performance as data grows, and any browser state not explicitly
protected (caret, selection, in-progress drag). Two screens already carry
hand-written guards against exactly this.
**Exposed by redesign?** Yes — every new screen inherits it.

---

## 🟡 D9 — Timezone handling is inconsistent

- Google event times display in the **event's own** timezone, unconverted.
- Outlook times are fetched in **UTC** and displayed unconverted (visibly wrong).
- New events are written with a hard-coded **`Africa/Johannesburg`** default;
  the browser's actual timezone is never read.
- Locale is hard-coded `en-ZA` in ~20 places.

Fine for one user in one country; wrong the moment anyone travels or shares.

---

## 🟡 D10 — The API key is stored in plain text in two places

The Anthropic key is entered through a raw browser prompt (no validation) and
saved **both** in browser storage **and** in the database record, then
re-hydrated onto any device. Calls go directly from the browser.

Also: Google/Outlook access tokens sit in plain browser storage.
**Note:** Firestore **security rules are not in this repository** and could not
be audited — they are the only thing protecting this data server-side.

---

## 🟡 D11 — Diary text is lost unless the field loses focus

The diary saves **only on blur**. There is no keystroke save and no save when
leaving the page or closing the tab. Type an entry, close the laptop, lose it.
Diary entries also **cannot be deleted** and **cannot be searched**.

---

## 🟡 D12 — The AI has full write power on the Diary page

Pages restrict what the AI may touch. **"Diary" was never added to that table**,
so the code falls back to the most permissive scope — on the Diary page the AI
can modify tasks, calendar, projects, habits, people and the notebook.

---

## 🟡 D13 — Notebook content is unsanitised and undoable only in memory

Content is raw HTML from a **deprecated** browser editing API. Only *AI* output
is sanitised — anything **you** type or paste is stored as-is. Undo is 40 steps
in memory with no redo, lost on reload. Changing a layout merges cells
destructively, and deleting a section's last page deletes the whole section.

---

## 🟡 D14 — Notifications only work while the app is open

All three notification systems are page timers. No push, no service-worker
notifications. Closing the tab silences everything — a significant gap for a
tool meant to remind you of things.

---

## ⚪ D15 — Background timers are never stopped

Several 60-second timers (including one that **calls the paid AI API**) are
never cleared on sign-out or profile switch and keep running against the new
session.

---

## ⚪ D16 — Duplicated implementations

Two notebook toolbars · two notebook search implementations · two voice-dictation
engines · three renderings of the diary questions · two date-navigation cursors ·
two task editors for the same object in the AI review queue · two "project"
namespaces with confusingly similar names (`builds` = Projects,
`workProjects` = Areas).

---

## ⚪ D17 — Significant dead code

A ~180-line previous task renderer; six unused calendar view builders; seven CSS
blocks for removed view modes; six orphaned Brain save/delete functions; a
complete unused project "touch" function; several render targets that no longer
exist but are still called on every draw. The retired Design Mode block also
still ships (it returns immediately).

---

## ⚪ D18 — Smaller correctness bugs

- Deleting your account tries to delete the presence record at the **wrong path**.
- The birthday-reminder default has **no matching option**, so it silently never applies.
- `lastTogether` is written as an object and read as a date, permanently
  disabling the "haven't seen X" nudge once used.
- Month-view bars beyond 4–6 rows **vanish with no "+N more"** in Events mode.
- The conflict check scans one cached month, missing cross-month clashes.
- New Google events ignore the calendar picker.
- Swipe-to-close on the right rail was never finished.
- The web manifest says `orientation: any` while the app blocks landscape.
- Task ids are 7 random characters — collisions are possible.
- Ctrl/Cmd+K fires even while typing in a text field.

---

## Summary — what must be fixed before redesigning

| Must fix first | Fix during the relevant step | Can wait |
|---|---|---|
| **D1** profile data leak | D2 due dates (Step 4/5) | D8, D9, D13, D15, D16, D17, D18 |
| **D6** decide orphaned data | D4 touch interactions (Step 4/5) | D14 (needs a push service) |
| **D3** *decide* storage model | D5 atomicity (Step 12) · D12 AI scope | D10 (audit rules separately) |

---

## How the v2 architecture affects these risks

**Resolved by the move** (once built and migrated — *not yet*):

| Risk | Resolution |
|---|---|
| **D3** 1 MB record ceiling | Real relational tables; no document limit |
| **D5** AI not atomic | `:apply` executes reviewed operations in one DB transaction |
| **D10** keys in plain text | Anthropic key and OAuth tokens move server-side; tokens encrypted at rest |
| **D1** profile leak *(structurally)* | Ownership enforced in middleware; rows physically separated by `profile_id`. **Still must be fixed in the current app first** — otherwise contaminated data migrates as truth. |
| **D6** orphaned data | An explicit, reviewed mapping decides keep/migrate/delete |
| **D8** global re-render | The client fetches only what a screen needs, instead of holding all state |
| No export | A first-class export feature (JSON / Markdown / CSV / attachments) |
| No file support | R2 + the `attachments` table |

**Unaffected — still client/product work:** D2 (due dates), D4 (touch drag),
D9 (timezones — though the schema now *stores* timezones properly), D11 (diary
blur-save), D13 (notebook sanitisation), D14 (notifications when closed).

**New risks introduced by the migration** — see
`storage-migration-plan.md` § *Risks specific to this migration*: dual-write
divergence, calendar re-consent, notebook cell mangling, free-text
`scheduledTime` parsing, and partial-run recovery.

## Google Calendar token encryption — key rotation (D4.1)

Refresh tokens are encrypted at rest with AES-256-GCM using a single key from
`GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY`. The stored format carries a `v1.` prefix
so a future scheme is distinguishable, but there is currently **no key id and no
rotation path**: changing the key invalidates every stored token and every user
must reconnect.

Acceptable now (staging, one user). Before production this needs a key id in the
prefix and a decrypt-with-old / re-encrypt-with-new migration.

## OAuth pending-state storage (D4.1)

In-flight PKCE verifiers live in an in-process `Map`, deliberately: they are
valid for seconds and must not survive a restart. This is correct for a
single-instance deployment and **breaks on horizontal scale** — a callback
landing on a different instance than the one that issued the state would be
rejected as expired. Needs shared storage (Redis or a short-lived table) before
running more than one API instance.

## Month loading: no caching, prefetch or skeletons (D4.5 → D4.7)

Changing month clears the canvas and refetches the whole range. There is no
in-memory cache of an already-loaded month, no prefetch of the adjacent ones and
no skeleton — so navigation flashes empty and then fills.

Deferred deliberately three phases running (D4.5 §20, D4.6 §20, D4.7 §22),
because it is a data-layer change and every one of those phases was about visual
structure. It is the last known Calendar shortfall and should be the first thing
done if Calendar is reopened.

What it needs: keep the last N ranges keyed by from/to, render from cache
immediately while revalidating, prefetch previous/next on idle, and show a grid
skeleton only when there is genuinely nothing to show. The range endpoint is
already shaped for this — `/calendar/range?from=&to=` is pure and cacheable —
but the response contains private event titles, so it must stay in memory and
never reach the service worker cache.

## Today's rail renders on Completed (D4.7 §15, deferred)

The Completed page is a Today sub-route, so it inherits Today's rail and shows
"Habits Today" beside a list of finished tasks. Ticking a habit there is not
wrong, but the rail is answering a question the page did not ask.

Not changed in D4.7: the phase was scoped to Calendar, and the fix belongs to a
Today pass — the rail should be contextual per route, the same principle D4.6
applied to Calendar (a rail kept for symmetry is an empty column with a border).
Deliberately not a one-off `if (route === 'history')`; that is how the Calendar
rail ended up with five special cases before D4.6 removed them.

## Calendar frozen — outstanding items (recorded 2026-08-03)

Calendar is the working read-only foundation as of D4.7 and is not expanded
further without an explicit request. Three items remain **incomplete** and are
not to be reported otherwise:

1. **Month caching** — switching month clears the canvas and refetches.
   See "Month loading" above for the full note.
2. **Adjacent-month prefetch** — previous/next are never fetched on idle, so
   every navigation is a cold request.
3. **Cache-miss skeletons** — there is no skeleton state, so a cold month shows
   an empty grid rather than a shape that is obviously loading.

D4.7 added live refresh (45s range re-read, 5-minute incremental Google pull,
refresh on tab focus). That is a *different* problem — keeping the current view
current — and it does not address any of the three above. The refresh path is
change-detected and repaints only on a real difference, so it does not make the
caching gap worse.

Not to be implemented during Phase E unless a regression blocks normal use.

## Projects: `calendar_item_links` is misnamed (E1)

The polymorphic link table already carries `targetType: task | project |
library | diary`, which is exactly right, but it lives under a calendar name.
The moment Projects links to Library material, the app will be writing
"calendar item links" that have nothing to do with the calendar.

Cheap to fix in the E2 migration (rename to `item_links`, or add a sibling and
leave the calendar one alone). Expensive after Projects ships against it.

## Projects — known gaps (E2)

**Drag reordering is not built.** `projects.position` exists and "Move to top"
uses it, but drag needs pointer + touch handling, a live gap, one write on drop
and a rollback to the exact prior position. Shipping a half-reliable version
because the column exists is how a list stops being trusted.

**Task completion inside Project detail reloads the task list.** The task row
and its completion animation are reused from Today, but the "same node moves
into the Completed subsection" choreography is not built. Visible as a small
repaint rather than a movement.

**No "stalled" health signal.** Specified, deliberately not built: `updated_at`
moves when notes or metadata change, so the signal would call a project stalled
while you were reading it. Needs a real activity timestamp (last task
completed / added) before it can be honest.

**`calendar_item_links` is still misnamed.** Decision recorded in
[projects-v2-future-architecture.md](projects-v2-future-architecture.md): rename
to `item_links` in the same migration as the first non-calendar link, not
speculatively now. E2 writes no links, so the rename would be churn in frozen
Calendar code for no gain.

**The overview refetches on every mutation.** `refreshProjects()` re-reads the
whole filter after each change. Correct and simple at ~12 projects; it is the
same class of problem as the Calendar's month caching and should be solved the
same way if either becomes noticeable.

## Sample Projects data — TEMPORARY, remove after the E2 review

Added so Projects can be reviewed with something in it. It is deliberately
confined to **one module and one route block** so removing it is one commit:

- `api/src/lib/sample-projects.ts`
- the "Sample data — TEMPORARY" block in `api/src/routes/projects.ts`
- `window.__sample` in `web/app.js`
- `api/tests/projects-sample.test.ts`

Safety, following the D4.3 lesson (real reminders were nearly deleted because
synthetic rows shared a flag with real ones): every sample row carries
`legacy_id` beginning `sample:e2:`, and cleanup matches **only** that prefix —
never a title, a date, or "created recently", each of which can also describe a
real record. Legacy ids are `uid()` strings and cannot contain a colon, so an
imported project can never collide.

Both endpoints refuse when `NODE_ENV` is production. A real task filed into a
sample project survives cleanup and simply loses the assignment, because the
foreign key is `on delete set null`.

**E2.4 — the seed now demonstrates the surfacing rule rather than breaking it.**
It used to put four tasks in the `today` bucket, including two from one project
with no due date and no next-action claim, which is precisely the "Today mirrors
the project" behaviour E2.4 exists to prevent. A seed that contradicts the rule
it is meant to illustrate teaches the reviewer the wrong thing.

Now: `Reconcile against the bank` is on Today because it is **overdue**, `Pay the
deposit` because it is the **chosen next action** of a Now project, and the
active Now project `Life OS Projects review` keeps all three of its open tasks
**off** Today — that project is the demonstration. A test asserts that every
`bucket: 'today'` line in the seed carries either a `dueDate` or `next: true`.

## E2.4 — the verification harness

`api/tests/live-server.ts` boots the real Fastify app on port 8080 against
PGlite, seeds the sample projects and a habit history, and enables the dev-auth
bypass the web client already supports for localhost. It is how E2.4's defects
were reproduced and the fixes demonstrated in a browser rather than inferred
from source.

It is **not a test** and is never run by `npm test`. It is also not shipped: it
lives in `tests/`, it is excluded from the build, and it uses PGlite, so it
cannot reach a real database. Keep it — the alternative is verifying UI claims
by reading code, which is how the `wireBoard()` overwrite survived three phases.

## Projects E2.1 — remaining gaps

**~~Task completion inside Project detail still reloads the list.~~ CLOSED in
E2.3, and properly finished in E2.4.** E2.3 replaced the reload with a same-node
move into the Completed section. E2.4 found the remaining half: the handlers
doing the moving were being overwritten moments after they were set, because
`wireProjectDetail()` ended with `wireBoard()` — which reassigns `onclick` on
every `.task` on the page. The tick reached Today's `toggleTask`, which looks the
task up in `state.tasks` and returns silently for a task that is not on Today.
Verified in a browser: same node object through complete and reopen, one row per
id, unsaved notes intact.

**Overview reconciliation is partial.** A mutation applies to the server, then
`refreshProjects()` re-reads and reconciles through `applyGroups`, so rows keep
their identity and the header is patched rather than re-rendered — but it is
still a full re-read rather than a local patch plus background verification.
Correct and flicker-free at a dozen projects; the same class of debt as the
Calendar's month caching.

**Drag has no auto-scroll inside the project list** beyond what the shared drag
system provides for the page, and no long-list virtualisation. Fine at this
size.

## Projects E2.2 — the duplicated task row, recorded

Worth keeping because the mechanism is not obvious and the same shape can
recur anywhere a drag coexists with a re-render.

The drag parks the dragged card on `document.body` and leaves a placeholder in
the list. Anything that replaces the list's `innerHTML` mid-drag therefore
destroys the placeholder while the card floats free — and the rebuilt list
renders a fresh row for the same task. Two nodes, one id.

The half-fix is to detect a detached placeholder at drop time. That is not
enough: the very next `pointermove` re-inserts the placeholder into the NEW
list, so by the drop it is connected again and the dragged card lands beside
its own twin. The complete fix is `strayTwin()` — at drop, any OTHER live node
claiming the same task id is removed, whichever way the placeholder resolved.

Duplication was **DOM only**. Verified against the database: six interleaved
next-action and reorder writes leave exactly two task records.

Remaining: the drag still cannot survive a rebuild *usefully* — it abandons the
gesture rather than re-deriving the drop target against the new list. Correct
and safe; just not clever.

## Today project grouping — badge first, clusters deferred (E2.3)

E2.3 shipped the smaller first version the brief allowed: every Today task that
belongs to a project shows the **project name as a link** plus a **Next action**
marker, rather than tasks being visually clustered under a project header.

The reason is drag. A cluster header is a non-task node inside a `.drop` zone,
and the drag placeholder is inserted *relative to task siblings* — so a header
can end up on the wrong side of the insertion point. Worse, grouping reorders
tasks visually by project while `position` still orders them for real, so
"drop between these two" stops meaning what it looks like.

Doing it properly needs the drop zone to understand groups: insertion indices
derived from the grouped order, and a stored order that agrees with the visual
one. That is a Today architecture change, not a Projects one, and it belongs in
a Today phase rather than being forced in here.

The badge covers the actual need — knowing which project a task belongs to and
getting there in one click — at none of that risk.

## E2.5 — known limitations

**The next-action slot shows counts, not an expandable step list.** §5 allowed
either; counts were chosen because the slot sits above the task list and an
expandable panel there would push the list off the first screen for a task whose
steps are already one scroll away. Opening the next action reaches the same Task
and the same Steps. If the slot ever needs the panel, it reuses `wireSteps` —
the component takes a row element and a task, and the slot can supply both.

**Step REORDERING is still the remaining limitation — but the order itself is
real.** E2.6 corrected a mis-statement here: `task_steps.position` is not
"creation order" by accident, it is a stored incrementing column assigned
`max + 1` on create and used for every read. The sequence Today guides you
through is that column, and it is authoritative.

What is missing is a way to *change* it. Steps can only be appended, so a step
added late cannot be moved earlier. Deferred deliberately: reordering belongs in
the full editor (never inline on Today, where a drag inside a drag would fight
the board's own), it needs its own one-write reorder endpoint shape, and nobody
has yet needed it. Documented rather than pretended away — the order is
designed, the ability to rearrange it is not built.

**Step names are `<input>` elements, so `innerText` does not include them.** Not
a defect — it matches how the task editor has always rendered them — but it is
worth knowing when writing a test that reads a row's text.

**The Browser pane would not composite during E2.5 verification**, so every
functional check was made through the DOM, computed styles and the API rather
than from a screenshot. Structure, layout values, ARIA state and persistence
were all verified directly; the visual judgement of the inline step styling is
the one thing left for the user.

**`state.history` is a partial list.** It holds whatever pages have been loaded.
`findTask` resolves from it, so a completed task from an unloaded page falls
through to `openMissingTask`, which fetches by id. That path is correct but does
one extra request; loading history is the common case and it is already there.

## E2.6 — known limitations

**No inline Step reordering, and none planned for Today.** See above. A step
added in the wrong place has to be deleted and re-added, or its text edited.

**"N more steps" is a count, not a list.** Pressing it opens the full editor
rather than expanding in place. That keeps the card short and keeps exactly one
step actionable, which is the point of the sequence — but it does mean a
five-step task cannot be read end to end without opening it.

**The next-action slot has no completion control at all.** That is how §10's
"do not allow parent completion from the compact slot while Steps remain" is
held: rather than a control that is sometimes available, there is none. Opening
the task is the way to complete it. Simple, and possibly too blunt if the slot
later wants to finish a step-free task.

**Undo is limited to one step back.** Correcting a mistake three steps ago means
opening the editor. Deliberate — see the ordered-step model — but it is a real
extra click for a real mistake.

**The Browser pane would not composite for a screenshot during E2.6 either.**
Every functional claim was verified through the DOM, computed styles and the
API. The visual judgement of the Current/Next hierarchy is the user's.

## E2.7 — known limitations

**The Add-step field's box sits on the text column; its placeholder does not.**
The field is a bordered input with 8px of its own padding, so its placeholder
begins 9px right of where step text begins. Aligning the placeholder instead
would outdent the box 9px left of everything else, which looks worse. The box
edge framing the column is the correct reading for a bordered control under bare
text — but it is a deliberate choice, not an oversight.

**Editor control measurements in the Browser pane read ~0.3px small.** The modal
has a scale-in animation, and this pane never advances animations — computed
values are frozen start frames (the same limitation found in D4.7). The
*declared* width is 18px in both contexts, which is the thing that matters; the
17.73px reading is the frozen frame, not a real difference.

**No screenshot was possible for E2.7 either.** The Browser pane would not
composite. Everything was verified through bounding boxes, computed styles, glyph
positions measured with Ranges, and the API. The remaining judgement — whether
the 22px ring reads as progress rather than as a broken checkbox, and whether the
completed step's green is restrained enough — is the user's.

**The module-integrity test covers `steps.js` only.** It works by importing the
module and rendering, which is possible because `steps.js` touches no DOM at
module scope. `task-modal.js` and `app.js` cannot be imported in Node without a
DOM, so the same class of bug could still hide there. A jsdom harness would close
that; it has not been added because it is a test-infrastructure change and this
was a corrective phase.

## E2.8 — known limitations

**No per-project grouping on Today.** Declined deliberately (see
`today-v2-product-model.md`). If it is wanted later, it needs a drag partition
per project — the mechanism already exists in `sectionOf`, but every partition
has to stay correct as tasks are added, completed and reassigned, and that is a
phase of its own rather than a rendering change.

**The daily claim is per workspace membership, and the timezone is the
browser's.** There is no stored user timezone yet. A user who travels will get
their arrangement on their *device's* local day, which is almost certainly what
they want — but if a workspace timezone becomes configurable, the client should
send that instead of `localDate()`.

**A tab left open across midnight does not arrange until it is re-opened.**
Deliberate: §5 requires that midnight alone must not move visible tasks while
someone is using the page. The next navigation to Today picks it up.

**`Arrange today` states the rule in a toast rather than previewing it.** §12
allows either ("preview or clearly state the rule"). A preview would need a
diff surface, which is more UI than a corrective action deserves.

**New-task insertion writes one row via midpoint positioning.** If a bucket is
reordered enough times without a renumber, midpoints could eventually collide.
The sparse GAP of 1000 makes that many hundreds of insertions away, and the
daily arrangement renumbers cleanly, but there is no compaction pass.

**No screenshot again — the Browser pane still would not composite.** Everything
was verified through the DOM, computed values, real pointer events and the API.
The visual judgement of the subsection headings is the user's.

## F1 — what is built and what is not

**Built:** the Legacy book audit, the Library schema and migration, the
`item_links` rename, the full Library API (items, books, sections, pages,
search, archive/restore), the page document model and validator, and the
staging sample tooling. 37 Library tests, 755 overall.

**NOT built in F1 — the client.** The Library overview, the Book component, the
page editor, autosave wiring, the Add menu and the `__sampleLibrary` console
hooks do not exist yet. The API they will call is complete and tested; the phase
ran out of room before the UI.

That means several F1 sections are specified and documented but not implemented:

| Section | Status |
|---|---|
| §10 Library overview | not built |
| §11 item cards | not built |
| §12 Add menu | not built (rules recorded) |
| §13–14 cover and spread | not built (geometry captured in the audit) |
| §15 editor | model built and tested; the editor itself is not |
| §16 autosave | server contract built (`expectedUpdatedAt`, 409); client not |
| §17–18 sections and page creation | API built; navigation UI not |
| §19 search | API built and tested; UI not |
| §20 motion | rules recorded; nothing to animate yet |
| §22 responsive | rules recorded; nothing to lay out yet |
| §23 accessibility | requirements recorded; nothing rendered yet |

Nothing half-built was shipped and no route exists without an endpoint behind
it — the specific failure the brief warns about ("no fake buttons") cannot occur,
because there is no Library UI at all.

**Uploads are not built.** The columns exist; the storage integration does not.
The Add menu, when built, shows only New Book, New Document and Save Link.

**No screenshots.** There is no Library UI to photograph, and the Browser pane
has not been compositing for several phases in any case.

**`content_text` search is `LIKE`, not full text.** Honest at this scale and
upgradeable to a `tsvector` without changing the API.

**Permanent deletion is unexposed on purpose.** It cannot be designed before
`item_links` has real Library edges and uploads have real bytes — the questions
it has to answer are listed in library-v2-product-model.md.

## Diary (D1)

**Read-only day context is deferred.** Showing the selected date's completed
Tasks, Calendar events and Habit ticks beside the entry is designed in
`diary-v2-product-model.md` and not built. It reads three existing services,
each with its own shape and its own empty state, and a panel that half-duplicates
Today is worse than no panel. Writing and history were the mandatory half of D1;
this is the first candidate for D2.

**Cross-system links are not built.** `item_links` (F1) is the path, and Diary
is a valid future source and target — the entry `id` is stable for exactly this.
No linking UI exists, and no Diary-specific link table was created, because a
second general link table would give the codebase two answers to "what relates
to what".

**Search is `LIKE` over `document_text`.** Honest at this scale, upgradeable to
`tsvector` without changing the API. The same note applies to Library.

**The mobile keyboard is untested with a real keyboard.** The harness browser
has none. Layout, touch targets and composer clearance were measured at 390px;
the behaviour of iOS or Android resizing the visual viewport mid-edit was not
exercised. Worth one pass on a real device.

**Midnight is announced, not applied.** With the tab open across midnight, Diary
offers "It is a new day. Open today?" rather than switching the date underneath
someone mid-sentence. The check polls once a minute; it is not a timer aligned
to the boundary, so the offer can appear up to a minute late.

**No screenshots from the harness.** The Browser pane has not composited frames
for several phases, so every visual claim in D1 is a measurement, not a picture.

## D2.1 — what was specified and NOT built

The phase listed nine items in priority order. Items 1 and 2 shipped; item 3
shipped in half. Everything below is outstanding and was not started.

**Prefetch and cache (§5).** No adjacent-day, adjacent-spread or adjacent-month
prefetch, and no cache layer. The no-blank rule was implemented without one —
existing content simply stays until its replacement arrives — which removes the
empty frame but does not make the next day feel instant.

**The page-turn illusion during a fetch (§4)** and **measured transition latency
(§19).** Not built, not measured.

**The Diary system Habit (§14).** `Write in Diary` as a pinned computed habit in
Today, with completion derived from whether the day has a meaningful entry, is
designed in the prompt and not implemented. The streak line is still on the
Diary right page.

**Diary toolbar removal (§7)**, **guided-prompt field redesign (§8)**,
**growing spread (§9)**, **right-page visual hierarchy (§10-13)**. The Diary
still has its permanent toolbar and its thin underline prompt fields.

**History density (§15-17).** The month still requires scrolling on a desktop
viewport, and day cells still show only a dot.

These are independent of each other and of the two fixes that shipped. The
navigation guard and the partition fix were the ones with correctness at stake.

## D2.1 — still outstanding after the completion pass

Items 1-6 of the completion prompt shipped. Items 7-9 did not.

**History density (§11-13).** The month still uses tall cells and needs
scrolling on a desktop viewport, and day cells still show only a dot — no title,
no feeling, no excerpt, no mood ambience.

**Transition framework (§14).** The no-blank rule holds in Diary and Library —
known content is never cleared before its replacement is ready — but there is no
directional paper transition, and Calendar month changes were not touched.

**Prefetch, cache and latency (§15-16).** Not built and not measured. No
adjacent-day, adjacent-spread or adjacent-month prefetch exists, so a cold
navigation is exactly as fast as its request. **No performance claim is made.**

**Right-page visual grouping (§6-7).** The check-in still renders as one flat
column of chip rows. The emotional ambience wash, the grouped modules and the
transition between fine-feeling sets were not built. The interactions
themselves — selection, expansion, deselection, right-page-only repaint — work
and were verified in D2.

**Contextual selection toolbar.** Deliberately omitted. The prompt said omitting
it is preferable to another distracting toolbar, and nothing about new diary
writing needs it.

---

## Phase D2.2 — what was cleared, and what remains

### Cleared

The D2.1 items above are now built, and the entries above them are superseded:

- **History density (§11-13)** — the month is a compact six-week grid at 60px
  per cell, and a written day shows a context line, the broad feeling as a word
  and a restrained tint. See `diary-v2-history.md`.
- **Right-page grouping and ambience (§6-7)** — four grouped surfaces, an
  energy meter, a social battery, moment tiles, and a day tint scoped to the
  check-in.
- **The directional day transition** — it had silently not been running since
  D2 (it targeted `.dia-sheet`, which stopped existing). Fixed, and both the
  leave and the entrance now have guaranteed teardown.

### Still not built

**Prefetch, cache and latency.** Unchanged from D2.1: not built and not
measured. No adjacent-day, adjacent-spread or adjacent-month prefetch exists, so
a cold navigation is exactly as fast as its request. **No performance claim is
made.**

**Calendar month transitions.** §14 asked that Calendar month changes retain
structure. They do — the frame and rail never redraw — but no directional
transition was added there, and Calendar was otherwise untouched.

**`One word for today` (§11-F).** Declined for this phase, not rejected. It fits
the validated reflection structure without a migration (`checkin.oneWord`), and
it would be genuinely useful in History and in search. It was left out because
§11 asked for two or three interactive ideas, not all six, and three were
already chosen. Worth building.

**The feeling constellation and the page-wide day colour (§11-A, §11-D).**
Declined on merit: both compete with the writing across the gutter. The tint
that *was* built is scoped to the check-in for that reason.

**History at 720px viewport height.** The month column is 539px and needs about
23px of scroll below a 765px viewport. Fits at every ordinary desktop height.

**Contextual selection toolbar.** Still deliberately omitted.

**Screenshots.** The harness browser has not composited for screenshots for
several phases, so every visual claim in D2.2 is backed by measured geometry and
computed styles rather than by an image. Visual judgement remains a user check.

---

## Phase D2.3

### Cleared

- **The Diary rubber-band** and **the habit ring's seam** — both root-caused and
  measured, not patched.
- **The directional day transition** now genuinely runs, as two layers.

### Still not built

**Adjacent-day prefetch.** Measured and **declined on the numbers**: the whole
navigation is ~26ms against a local API and the three requests are already
parallel. Over a real network one round trip would dominate, and that is the
case a prefetch could help — but there is no measurement of the user's own
latency to staging, and building a cache against an unmeasured number is how
caches become correctness bugs. **The measurement to take is: click→paint on
staging over the user's connection.** The design already makes latency harmless
(date and hash correct in ~3ms regardless), so this is an optimisation, not a
fix.

**`Customize daily check-in` (§16).** Documented in
`diary-v2-daily-checkin.md`, deliberately not built: enable/disable trackers,
reorder them, add dimensions, and **deliberately** link one to a habit. There is
no `+ Add habit` beside a Diary tracker and there must not be.

**History at short viewports.** The month column ends at 751px against a
composer top of 836px at 1280×900 — it fits. Below roughly 840px of viewport
height it needs a little scroll.

**Screenshots.** The harness browser still does not composite for screenshots,
so every visual claim in D2.3 is measured geometry, computed style or rasterised
pixel coverage rather than an image. Visual judgement remains a user check.

**Right-page density on a phone.** The four rhythm rows are inline
label-plus-chips, sized for a ~310px page. Verified not to overflow at 375px in
D2.2's layout, but the rhythm rows are new and were measured at desktop width
only. Worth a look on a real phone.

---

## D2.4

### Resolved

- **Fixed-width label column in Daily Rhythm.** `flex: 0 0 66px` with
  `overflow: visible` painted `Nourishment` 24.3px over the first chip. Replaced
  by one shared grid with `display: contents` rows, which cannot have the
  problem for any label.
- **`.filters` had no CSS rule.** The Today Area pills spaced themselves on
  inline whitespace. Now `gap: var(--chip-gap)`.
- **Truncated chip labels** after the 5/5/5 change — sixteen of them at 11px.
  Resolved at 10px with tighter padding; zero truncate at any verified width.

### Carried, with the reason

- **`SLEEP_ALIAS` is permanent, not a migration step.** `sleep: great` days are
  normalised to `rested` on read, in both the server validator and the client.
  Nothing rewrites stored rows. This is deliberate — a migration would rewrite
  history to match a UI decision, and the alias costs one map lookup. Anything
  that later reads `reflection.checkin.sleep` **must** go through the alias;
  there is no database guarantee that only the four current ids appear.
- **The core rows wrap to two lines at 1024px.** Five 52px chips do not fit a
  266px track. This is §9's compact-row response and is verified to truncate
  nothing, but it does mean the check-in is taller at 1024 than at 1280.
- **Sample History data is staging-only and cannot be exercised in production.**
  `POST /diary/sample/history` is refused unless `NODE_ENV` allows it, so the
  seeding path has no production coverage by construction. That is the intended
  trade.

### Measurement notes worth not relearning

- **A `display: contents` element returns a zero `getBoundingClientRect()`.** An
  overflow check written against a chip row's immediate parent reports overflow
  for every row, always. Measure against the real box, and cross-check
  `scrollWidth - clientWidth`.
- **A geometry reading taken on a scrolled page is worthless.** Reset `scrollY`
  and the scroll container, then measure. One "it fits" reading in this phase was
  wrong for exactly this reason and hid a 24px overflow.
- **`requestAnimationFrame` never fires while the harness browser pane is
  hidden.** Any measurement that awaits rAF hangs until the tool times out. Use
  `setTimeout` (throttled to ~1s, but it does fire) or a `MutationObserver`.

---

## L3

### Found and recorded, not fixed

- **`library_items.size_bytes` is an `integer`.** The largest size it can hold
  is 2,147,483,647, so a 3 GB file cannot be recorded — the L3 sample hit this
  and the value was reduced to 1.8 GB. No real row can reach it today because
  uploads are not built. Widening it is a schema change that belongs to whoever
  builds uploads, alongside the rest of that work.

### Carried, with the reason

- **`last_opened_at` is deliberately not backfilled.** NULL means "not opened
  since L3", which is true. Anything that orders by it must fall back to
  `updated_at`, and anything that DISPLAYS it must say "Edited" when it is using
  that fallback — `recencyLabel()` is the one place that decides.
- **The overview repaints with `innerHTML` on every filter change.** 23.5 ms for
  45 objects. It is the largest single cost in the Library and the first thing
  to fix if the collection grows, ahead of virtualising the rails.
- **No virtualisation, on purpose.** See `library-v2-performance.md` for the
  measurements and the trigger to revisit (~200+ objects, or a repaint over
  100 ms). Adding it now would cost measured item sizes, a scroll-position
  mapping, keyboard order surviving recycling, and `markReturn` having to find
  an object that may not be in the DOM.
- **The on-screen keyboard on a real phone is still unverified.** Geometry only;
  the harness browser has no keyboard. Unchanged since D1.

### Measurement notes worth not relearning

- **CSS transitions do not advance while the Browser pane is not compositing.**
  `getComputedStyle` returns the transition's START value, so a correct
  `.is-prominent` rule reads back as `matrix(1,0,0,1,0,0)`. Insert
  `*{transition:none!important}` before reading geometry, or every polish
  measurement in a phase like this one is wrong in the same direction.
- **`requestAnimationFrame` never fires, and neither do scroll events**, in a
  non-rendering pane. Anything rAF-coalesced cannot be driven by a real scroll;
  call the geometry function directly instead.
- **A dynamic `import('/module.js?v=2')` is a DIFFERENT module instance.** The
  cache-buster gives you a fresh copy with fresh state, so probing app state
  through it reads an empty object. Import the exact specifier the app used.
- **`.lib-rail` is deliberately 4px wider than its section on each side**, so an
  overflow check against its parent reports overflow on every shelf, always.
  Check `document.documentElement.scrollWidth` instead.
