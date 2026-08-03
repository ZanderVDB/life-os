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
