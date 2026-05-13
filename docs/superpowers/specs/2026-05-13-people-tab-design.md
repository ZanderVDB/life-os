# People tab — design spec

**Date:** 2026-05-13
**Status:** Approved for implementation
**Target version:** v151
**Codebase:** `index.html` (single-file PWA), `sw.js`

A new top-level tab that tracks the humans you care about. Each person has a card on a grid; the card shows their name, where you met, the most pressing thing you've promised to do with them, and a "last seen" badge. Tapping a card opens a detail modal with phone/email, a paddle-style friendship level, free-form notes, a list of promises (each independently link-to-task-able), and a single "last did together" memory slot. Birthdays are read-only from Google Calendar. The AI bar can create people and add promises through the standard review queue.

## Why

There used to be a side-effect "people" feature where names mentioned in the AI bar got cards. The user wants to replace that with an intentional, explicit tab. The primary use case is **"who did I say I'd do something with, and when?"** — the grid surfaces upcoming commitments and lets the user convert any of them into a concrete Daily task that, when ticked, completes the promise and updates the person card in one motion.

## Data model

### `S.people` (array, persisted to Firestore, type-guarded on load)

```js
{
  id: 'uid',                         // required, generated via uid()
  name: 'Nigel Smith',               // required, free text
  metAt: "Hennie's wedding · 2024",  // optional free text
  phone: '+27 82 555 5555',          // optional
  email: 'nigel@example.com',        // optional
  notes: 'Engineer, loves fishing.', // optional free-form
  level: { major: 4, minor: 3 },     // 1-5 / 1-5; defaults to {major:1,minor:1}
  tagIds: ['tag-uid-1', 'tag-uid-2'],// references S.peopleTags[].id
  pinned: true,                       // omitted when not pinned (default)
  promises: [                         // array, ordered as user added
    {
      id: 'uid',
      text: 'Go for coffee',
      date: '2026-05-20',             // optional YYYY-MM-DD
      addedAt: '2026-05-13',
      linkedTaskId: 'task-uid'        // optional; set when "Link to task" is used
    }
  ],
  lastTogether: {                     // single slot, overwritten on each new completion
    text: 'Drinks at Aandwind',
    doneAt: '2026-05-08'
  } | null,
  createdAt: '2026-05-13'
}
```

### `S.peopleTags` (array, persisted)

```js
{
  id: 'uid',
  name: 'Family friend',
  color: 'pink' | 'blue' | 'green' | 'gold' | 'lavender' | 'sage' | 'peach' | 'red'
}
```

Color palette reuses the existing CSS-var palette (`var(--pink)` / `var(--blue)` etc.) so themes stay consistent. New tags get the next-unused palette colour by default.

### `S.peopleLevelNames` (array of 5 strings, persisted)

Defaults: `['Acquaintance','Casual friend','Friend','Close friend','Inner circle']`. User can rename in Settings → People. Renaming does not change the underlying L1-L5 ordering.

### `S.peopleSettings` (object, persisted)

```js
{
  defaultSort: 'promise' | 'level' | 'lastSeen' | 'name' | 'recent',
  // Filter is in-memory only, not persisted (UI state)
}
```

### Task augmentation

When a promise is linked to a task, the existing task object gets two new optional fields:

```js
{
  ...existingTaskFields,
  linkedPersonId: 'person-uid',
  linkedPromiseId: 'promise-uid'
}
```

These are written on link-create, read on tick to know which person + promise to update, and dropped automatically when the task is deleted (no cascade needed).

### Schema migration

Bump `SCHEMA_VERSION` from 1 to 2. Migration ensures `S.people = []`, `S.peopleTags = []`, `S.peopleLevelNames = defaults`, `S.peopleSettings = { defaultSort: 'promise' }` are present on existing docs. No data transformation — these are pure additions.

## Navigation placement

Add `'people'` to the `ROUTES` array and `ROUTE_TITLES` map (currently in `index.html:2957-2958`). Add nav drawer links wherever the other routes are listed (lines 2188-2226). Slot order: `today, calendar, projects, habits, people, notebook, brain, settings` — people sits between habits and notebook because the user reaches for it most after habits-style routine views.

The route renders `<div class="route" data-route="people">` with a top toolbar (filter chips + sort chips + "+ Add person") and the card grid below.

## Card grid

CSS grid: `grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px`.

On phones (≤ 460px viewport) the minmax floor drops to `150px` so two cards fit per row. On very narrow phones, `auto-fill` naturally collapses to one column.

### Card contents

Anatomy (top to bottom, with overlay icons in corners):

- **Top-left overlay:** 📌 pin icon, only when `pinned === true`
- **Top-right overlay:** `L4.3` level badge (formatted as `L{major}.{minor}`)
- **Name** — large, bold, ~15px
- **Where you met** — small, muted, ~11px
- **Tags** — up to 2 visible tag chips coloured by tag.color; if more, show "+N"
- **Next-due promise** — single chip showing 🤝 icon + truncated promise text, green left-border; if more promises exist, a "+N more promises" line below
- **Bottom-right overlay:** last-seen badge — formatted per the rules below

If no promises: show "— no promises" in muted italic.

### Last-seen badge

Computed from `lastTogether.doneAt`:

| Days since | Display |
| --- | --- |
| null (never) | `—` |
| 0-6 | `Nd` |
| 7-29 | `Nw` |
| 30-179 | `NMo` |
| 180+ | `Ny` |

If days since > 90, the card gets a soft red tint (`background: #fef5f3` in soft theme, equivalent in studio theme) and the badge text colour shifts to red + bold. Recently-met people (>= 7 days) get no special tint regardless.

### Card click

Tap anywhere on the card → opens the person detail modal. The promise chip's "→ Link" button stops event propagation so tapping it doesn't open the modal.

## Sort and filter

### Tag filter chips

Above the card grid. First chip is "All" (selected by default). One chip per entry in `S.peopleTags`. Single-select: clicking a tag chip filters the grid to only people with that tag; clicking the active tag chip or "All" clears the filter. Filter state is UI-only (not persisted).

### Sort chips

Right of the tag filter row. One active at a time:

- **Promise date ↑** (default): people sorted by their earliest-dated promise (ascending). People whose promises have no date sort after those with dates, ordered by `promises[].addedAt` ascending (oldest-promised first). People with zero promises go to the bottom.
- **Level ↓** — highest `(major * 5 + minor)` first.
- **Last seen ↑** — longest-ago-or-never first.
- **Name A–Z** — `name.localeCompare`.
- **Recently added** — `createdAt` desc.

**Pinned people always sort to the very top** regardless of selected sort. Within the pinned group they follow the selected sort order. Active sort is persisted to `S.peopleSettings.defaultSort`.

## Person detail modal

Reuses the existing `.modal` / `.modal-bd` / `.modal-body` shell (matches habit/task modals). Sections from top to bottom:

### Header

- Name (large) + metAt (muted small subtitle) on the left
- Pin toggle on the right (📌 Pinned in gold when on, "📌 Pin" muted when off)
- Close button (×) top-right of the modal shell

### Contact rows

Three rows, each only rendered if its field has a value, with an inline "+ Add" prompt when empty:

- 📱 Phone — tappable on mobile (`tel:` link)
- ✉️ Email — tappable (`mailto:` link)
- 🎂 Birthday — see "Birthday from GCal" below

Each row has an inline pencil to edit (turns the value into an input + save/cancel).

### Tags

Section heading "Tags." Below it, a flex row of tag chips coloured per tag, plus a dashed "+ Tag" pill at the end. Tapping the + pill opens a popover with the current tags as selectable chips (multi-select) plus a "Create new tag" input at the bottom. Selecting toggles a tag on/off for this person. Creating a new tag adds it to `S.peopleTags` with the next-unused palette colour.

### Friendship level widget

Layout:
```
┌──────────────────────────────────────────────┐
│ L4.3 · Close friend (3/5)        [▼] [▲]    │
│ ──────────────────────────────────────────── │
│ [▓▓▓▓▓][▓▓▓▓▓][▓▓▓▓▓][▓▓▓░░][░░░░░]         │
│   L1    L2    L3    L4    L5                │
│ ──────────────────────────────────────────── │
│ [L1 · Acq.] [L2 · Casual] [L3 · Friend]      │
│ [L4 · Close]* [L5 · Inner]                   │
└──────────────────────────────────────────────┘
```

Components:

- **Display row** — `L{major}.{minor} · {peopleLevelNames[major-1]} ({minor}/5)` on the left, ▼ and ▲ buttons on the right
- **25-slot bar** — five blocks of five slots each, separated by a thin gap. All slots at or below the current position are filled in gold; slots in below-current levels are slightly darker gold than the current level's filled slots (so you can see which level you're in). Slots above are empty.
- **Level picker** — 5 tappable pills, one per named level. Tapping pill X jumps to `{major: X, minor: 3}` (middle of that level). The current major level pill is highlighted.

### Arrow nudge behaviour

- ▲ at `{major: M, minor: m}`:
  - If `m < 5`: `{M, m+1}`
  - If `m === 5 && M < 5`: `{M+1, 1}` (cross level boundary upward)
  - If `M === 5 && m === 5`: disabled
- ▼ at `{major: M, minor: m}`:
  - If `m > 1`: `{M, m-1}`
  - If `m === 1 && M > 1`: `{M-1, 5}` (cross level boundary downward)
  - If `M === 1 && m === 1`: disabled

### Notes

Free-form textarea, autosaves on blur (debounced via existing `svAll`).

### Promises list

Section heading "Promises / things said · N active". Each promise renders as a row:

```
🤝 [Go for coffee]            [→ Link] [✎] [🗑]
   on 20 May (if date present)
```

Right-side controls per row:

- **Link** (if no `linkedTaskId`) — creates a Daily task and stamps the promise with `linkedTaskId`. Pill changes to "🔗 Linked" (green badge).
- **🔗 Linked badge** (if `linkedTaskId` is set) — tappable to unlink: confirms ("Unlink this task? The task on Daily will be deleted."), then clears `promise.linkedTaskId` and deletes the linked task from `S.tasks`. The promise itself stays on the person card.
- **Pencil** — turns row into inline editor: text input + optional date picker + Save / Cancel. Date is optional; clearing it removes the date. Editing the text of a *linked* promise leaves the task on Daily unchanged — the task's text is a one-way derivative captured at link time.
- **Trash** — confirm-and-delete: "Delete this promise? Any linked task will also be removed." If the promise was linked, also delete the linked task; either way, remove the promise from `person.promises`.

Below the list: dashed "+ Add another promise" button. Opens an inline editor row identical to the pencil-edit state.

### Last did together

Read-only section. Renders only if `lastTogether !== null`:

```
🍻 Drinks at Aandwind — 5 days ago
```

Below the box, a small "Forget this" link that nulls `lastTogether` (confirmed). No edit — once recorded, the only allowed operation is forgetting.

### Delete person

Bottom of the modal, after a divider. "Delete person" button (red text). Confirms with a modal:

> Delete Nigel? This also deletes their 3 linked tasks. This cannot be undone.

If confirmed: removes the person from `S.people`, also removes any tasks in `S.tasks` whose `linkedPersonId === person.id`, `svAll()`, close modal.

## Promise → task → tick flow

### When the user clicks "→ Link" on a promise

1. Create a task object:
   ```js
   {
     id: uid(),
     text: `${person.name}: ${promise.text}`,
     area: 'personal',
     project: 'gen',
     priority: 'med',
     scheduledTime: '',
     daily: true,                    // ← lands on Daily list
     dailyDate: tod(),
     done: false,
     date: tod(),
     linkedPersonId: person.id,
     linkedPromiseId: promise.id
   }
   ```
2. Push to `S.tasks`
3. Set `promise.linkedTaskId = task.id`
4. `svAll()` + re-render

### When the linked task is ticked

This happens via the existing tick handler in the Tasks renderer. We intercept the tick:

1. Detect `task.linkedPersonId && task.linkedPromiseId` at tick time
2. Find the person; find the promise inside `person.promises`
3. Set `person.lastTogether = { text: promise.text, doneAt: tod() }` (overwrites any prior entry — no history per user spec)
4. Remove the promise from `person.promises` array
5. **Delete the task** from `S.tasks` (not just mark done — keeps the Daily list clean; the promise itself is the record)
6. `svAll()` + re-render

### When the linked task is deleted (not ticked)

1. Clear `promise.linkedTaskId` (find the promise via `task.linkedPersonId` + `task.linkedPromiseId`)
2. Leave the promise on the person — user can re-link later
3. `svAll()` + re-render

### When the promise itself is deleted (from the person modal)

1. If `promise.linkedTaskId`: also remove that task from `S.tasks`
2. Remove the promise from `person.promises`
3. `svAll()` + re-render

### When the linked task's text is edited manually

The promise text does not update. The user has to edit it from the person modal if they want both in sync. This is by design — the task is a one-way derivative.

## Birthday from GCal

Reuses the existing `isBirthdayEv()` helper and the name-extraction regex `^(.+?)(?:'s)?\s*(?:birthday|bday)\b/i` already used in the morning-brief flow.

### Lookup

When rendering the detail modal:

1. Fetch the current GCal event pool (already cached in `gcCache.events`)
2. Filter to `isBirthdayEv(e) === true`
3. Extract the bday name from each event using the existing regex
4. Find any event whose extracted name case-insensitive matches `person.name` (full match, or first word of person.name matches the bday name — covers "Nigel Smith" matching a "Nigel" birthday event)
5. If found: display `{Month Day} — from Google Calendar` in the birthday row
6. If not found: display "+ Add birthday" link

### "+ Add birthday" action

Opens the existing new-event modal (the one used by the manual calendar UI) with prefilled:

```js
{
  title: `${person.name}'s birthday`,
  date: tod(),
  allDay: true,
  repeat: 'yearly',
  reminderMin: S.calendarDefaults.birthdayReminders || [1440, 0],
  timeZone: 'Africa/Johannesburg'
}
```

After the user picks a date and saves, the next render of the person modal picks the new event up via the lookup above. No data is stored on the person object itself — the GCal event is the single source of truth, matching the user's explicit ask.

## Settings → People panel

New panel in the existing Settings route, after the Habits / Calendar / AI sections. Three sub-sections:

### Tags

List of all `S.peopleTags`. Each row:

```
[●] Family friend     3 people · ✎ 🗑
```

- Coloured dot reflects `tag.color`
- "N people" count is informational
- ✎ opens inline rename + colour picker
- 🗑 confirms then deletes; also removes the tag's id from every `person.tagIds` array

Below the list: "+ Add tag" — inline form for name + colour.

### Level names

Five rows, one per major level (L1-L5). Each shows the current name with a pencil to inline-rename. Below: "Reset to defaults" button (confirms, then writes the canonical defaults back to `S.peopleLevelNames`).

### Defaults

Single row: "Default sort" with a select matching the sort chips. Changing this writes `S.peopleSettings.defaultSort` and the People grid uses it on first render.

## AI integration

Two new ops join the existing AI schema (in the same JSON shape returned by `_aiTurn`):

### `addPerson`

```json
{
  "name": "Jack Smith",
  "metAt": "University 2019",
  "phone": "+27 82 555 5555",
  "email": "jack@example.com",
  "notes": "Free-form description",
  "tags": ["Uni"],
  "level": { "major": 3, "minor": 3 }
}
```

All fields except `name` are optional. Tags are referenced by name; if a tag doesn't exist, it's auto-created with the next-unused palette colour.

### `addPromise`

```json
{
  "person": "Jack",
  "text": "go for coffee",
  "date": "2026-05-20"
}
```

`person` is matched via the v149 `_aiFindStrict` helper (exact → startsWith → constrained-needle). `date` is optional.

### Wiring

Both ops:

- Appear in the AI review queue (via the existing `AIC_TYPES`, `AIC_DEFAULTS`, `AIC_CANONICAL_TEXT`, summary case, and editor form / reader machinery)
- Are included in `formatAIChangesDetailed` so the "Confirm before applying" gate fires for people-only changes (same family as the v148 reminders fix)
- Have prompt guidance in the system prompt explaining when to use each: `addPerson` for new contacts, `addPromise` for plans you mentioned with an existing person, `addPromise` with date when an explicit date is mentioned

## Edge cases

- **Empty grid:** if `S.people.length === 0`, the route shows a friendly empty state: "Track the people you care about. + Add your first person."
- **Deleting a person with linked tasks:** confirmation message names how many tasks will also be deleted.
- **Deleting a tag that has people:** confirmation message names how many people will lose it.
- **AI tries to add a promise to a person who doesn't exist:** `_aiFindStrict` returns null → the op is silently dropped with a `console.warn`. The "n changes silently skipped" surface from the audit's improvements list could later cover this.
- **Two people with identical names:** allowed — they're separate IDs. The AI's `addPromise` match will hit the first one; user can disambiguate by editing through the UI.
- **GCal birthday name collision (two people named Jack with one Jack birthday event):** both Jacks will show the same birthday row. Acceptable for v1 — the user can disambiguate by tweaking the birthday event title (e.g., "Jack S birthday") so it stops matching the other Jack.
- **Tag colour collisions:** new tags pick the next palette colour by walking through `['blue','green','pink','gold','lavender','sage','peach','red']` and selecting the first not currently in use. If all 8 are used, defaults to blue with a console warning.
- **Person renamed after promise linked:** task text doesn't update automatically (would require listening on every person mutation; YAGNI for v1).

## Out of scope (per user)

- XP / auto-gamified leveling
- Photos on cards
- Drag-to-reorder cards (pin handles the same need)
- Promise history (only `lastTogether` retained, single slot)
- Birthday surface on Daily (already covered by morning brief)
- Per-person interaction history / timeline

## Implementation surface

Single-file change to `index.html`. Touchpoints, roughly in order:

1. Add data fields to `S` initial state (~ line 4393) + `_buildSavePayload` (~4214)
2. Type-guard in `handleSnapshot` (~4089)
3. Schema migration: bump `SCHEMA_VERSION` to 2 + migrateHabits sibling `migratePeople`
4. `ROUTES` / `ROUTE_TITLES` (~2957-2958)
5. Add nav drawer entries (rail at ~2188, drawer at ~2224)
6. Add `<div class="route" data-route="people">` to the route container
7. New CSS block: card grid, card chrome, level widget, tag chips
8. New JS section: `rPeople`, `openPersonModal`, `_personMkCard`, level widget logic, promise CRUD, link-to-task, tag CRUD
9. Hook into the existing task-tick handler to detect `linkedPersonId` and trigger the completion path
10. Settings → People panel — extend `rSettings`
11. AI schema: extend prompt at ~8813, add ops to `applyChanges` (~10086), AIC machinery (~9095, ~9135, ~9260, etc.), `formatAIChangesDetailed` REMINDERS-style section

Approximate LOC: ~700-900 added, no significant deletes.
