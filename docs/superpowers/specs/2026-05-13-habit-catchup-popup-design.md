# Habit catch-up popup — design spec

**Date:** 2026-05-13
**Status:** Approved for implementation
**Target version:** v151 (ships alongside People tab)
**Codebase:** `index.html`

A one-shot popup that fires the first time the user opens the app each day, showing yesterday's habits with checkboxes pre-filled to reflect their current state. The user ticks anything they actually did but didn't log, then dismisses. Designed as a low-friction nudge — not a wall the user has to fight through.

## Why

Habits live or die on the consistency of the log. Users routinely forget to tick a habit they actually completed because the act of opening the app, navigating to Habits, and tapping the row introduces friction. A daily nudge that says "you ticked 3/5 yesterday — want to fix any of those?" catches the gaps before they accumulate. Users who do everything correctly the previous day can dismiss instantly with no penalty.

## Trigger logic

On every successful app load (post auth + post initial sync), check:

1. `localStorage.los_habit_catchup_lastShown` — if this equals today's local-date ISO string, **skip** (already shown today)
2. `S.habits.length > 0` — if zero, **skip** (nothing to ask about)
3. At least one habit has `createdAt <= yesterday` — if every habit was created today, **skip** (yesterday they didn't exist yet)
4. `S.habitCatchupEnabled !== false` — user can disable in Settings; default is enabled, so the check is "not explicitly off"

If all four pass: show the popup, **and immediately set** `localStorage.los_habit_catchup_lastShown = today` (before the user interacts), so closing the tab or accidentally dismissing doesn't cause a re-fire later in the day.

### Where the check runs

In the existing `handleSnapshot` server-confirmed path, after `_initialSyncDone = true` is set and the initial `render()` call has fired. Specifically: at the end of the `else` branch where `render(); loadDailyNote(); loadTip(false);` already run (currently around line 4190). One line added: `maybeShowHabitCatchup();`.

For the cache-fallback acceptance path (the 3-second timer), also call `maybeShowHabitCatchup()` after the catch-up render. This way users on slow networks still get the prompt.

The check is fast (one localStorage read, one array length check, one date compare) so it has negligible cold-start cost.

## "Yesterday" definition

Local-time yesterday using the existing `yest()` helper (`index.html:4615`). If the user opens the app at 1am on Wednesday, "yesterday" is Tuesday — exactly what they want for a catch-up review.

If they open at 11:55pm on Tuesday for the first time today, "yesterday" is Monday. That's correct — they haven't yet reviewed Monday for today's session. The next day at 12:30am Wednesday the popup fires again because `los_habit_catchup_lastShown` is now stamped Tuesday-the-ISO-date, which doesn't equal Wednesday-the-ISO-date.

## UI

Reuses the existing `openHabitDayModal()` machinery (`index.html:6286-6328`) with two small additions:

1. The modal's `<h3>` title is prefixed with "Habit catch-up · " when invoked from the popup path, so the user knows this is the daily nudge vs a normal day modal opened from the calendar.
2. A single-line subtitle below the title: "Tick anything you actually did. Already-ticked items are pre-filled." Only shown in the catch-up path.

Functionally identical to the existing modal:

- Habits split into three sections (Done / Not done / Rest day), with done items already ticked
- Tap a row to toggle — saves immediately via `toggleHabitDate()` + existing in-place re-render (no flicker)
- "Close" button bottom-left
- "Open in Day view" button bottom-right (already exists, useful if user wants more context)
- Tap the modal backdrop (`.modal-bd`) closes the modal

### Implementation

Add a new function `openHabitCatchupModal()`:

```js
function openHabitCatchupModal(){
  const y = yest();
  const [yy, ym, yd] = y.split('-').map(Number);
  // Reuse the existing modal but flag it as catch-up so the title /
  // subtitle can be adjusted.
  openHabitDayModal(yy, ym-1, yd, {catchup: true});
}
```

Modify `openHabitDayModal` to accept an optional `opts` argument with `catchup: boolean`. When set:

- Title becomes `Habit catch-up · ${date.toLocaleDateString('en-ZA',{weekday:'long',day:'numeric',month:'long'})}`
- A `<div class="hab-modal-sub">Tick anything you actually did. Already-ticked items are pre-filled.</div>` is inserted after the title

**Side-fix:** the existing `openHabitDayModal` (lines 6286-6328) only renders the title and any sub-elements on first creation, in the `if(!overlay)` branch. When called again for a different day, the title stays stuck on whatever day the modal was first opened for — a pre-existing bug. As part of this change, refresh the title (and any catchup sub-line) on every call so the catch-up path can override it cleanly. Move the title and sub-line render into a small helper that runs both on creation and on subsequent calls; the body re-render via `renderHabitDayModalBody` already runs on every call.

`maybeShowHabitCatchup()` wraps the trigger logic:

```js
function maybeShowHabitCatchup(){
  if(S.habitCatchupEnabled === false) return;
  const today = tod();
  let last = null;
  try { last = localStorage.getItem('los_habit_catchup_lastShown'); } catch(_){}
  if(last === today) return;
  if(!S.habits || S.habits.length === 0) return;
  const ydayIso = yest();
  // At least one habit must have existed yesterday
  const eligible = S.habits.some(h => (h.createdAt || tod()) <= ydayIso);
  if(!eligible) return;
  try { localStorage.setItem('los_habit_catchup_lastShown', today); } catch(_){}
  openHabitCatchupModal();
}
```

## Settings toggle

New row in Settings → Habits (or Settings → General if Habits subsection doesn't exist yet). Renders a labelled switch:

```
Daily habit catch-up
Show yesterday's habits the first time you open the app each day.
[switch — on by default]
```

State stored as `S.habitCatchupEnabled: boolean`. Defaults to `true` if undefined or missing. Persisted to Firestore via `_buildSavePayload`. Type-guarded on load (must be boolean, otherwise treat as `true`).

Why Firestore-synced, not localStorage-only: the user explicitly said the popup should appear on phone. The setting should travel with them — disabling on laptop should disable on phone too. The `los_habit_catchup_lastShown` flag stays in localStorage (it's a per-device "have I shown the popup today" tracker — different devices opening on the same day each get the prompt, which is fine and probably desired).

## Edge cases

- **No habits yet:** popup never fires (`S.habits.length === 0`).
- **All habits created today:** popup skipped — nothing to catch up on. The next day it'll fire normally.
- **User had zero habits yesterday but added one today:** popup skipped. First fire is the day after the habit exists.
- **User opens the app late at night and dismisses, then opens again past midnight:** the localStorage stamp is yesterday's ISO date now, today's ISO date differs, popup fires once for yesterday's habits.
- **Cross-device same day:** user opens on laptop in the morning (popup fires + dismisses), opens on phone after lunch (`los_habit_catchup_lastShown` not set on phone, popup fires again). Acceptable — they can re-confirm or just dismiss.
- **User signs out then back in mid-day:** localStorage stamp persists across sign-out (it's not per-user, it's per-device). Popup doesn't re-fire.
- **User clears site data:** localStorage stamp gone → popup fires next load. Acceptable.
- **Popup fires while another modal is open:** the catch-up popup just opens on top. Since both use the same `.modal` shell, the topmost one (catch-up) takes focus. Acceptable for v1 — chance of collision is low (popup only fires once at app load).
- **The user opened the app via a hash anchor (`#calendar`):** popup still fires after route restore. The route is independent of the catch-up modal.
- **Yesterday was a rest day for every habit:** popup still fires — user can confirm with one tap on "Close" since rest-day habits don't require action.

## Settings panel placement

The existing settings render lives in `rSettings()`. Add a new row in the appropriate section (probably "Behaviour" or "Notifications" — whichever section already exists for similar one-line toggles). Pattern: copy an existing toggle row, swap labels and the bound variable.

## Out of scope

- Showing more than one day at a time (e.g. "you missed 3 days — review them all")
- Smart suppression (e.g. skip if user ticked all habits yesterday) — user explicitly said the popup should still appear in that case
- Sounds / haptics on popup fire — out of taste, easy to add later
- Showing the catch-up button in the nav permanently for users who dismissed today's

## Implementation surface

Tiny. Touchpoints in `index.html`:

1. `S` initial state: add `habitCatchupEnabled: true` (~line 4393)
2. `_buildSavePayload`: persist `S.habitCatchupEnabled` (~4214)
3. `handleSnapshot`: read + type-guard the field; call `maybeShowHabitCatchup()` at the right spot (~4190)
4. Cache-fallback path: also call `maybeShowHabitCatchup()` (~4178)
5. New functions: `maybeShowHabitCatchup()`, `openHabitCatchupModal()`
6. Modify `openHabitDayModal()` signature to take optional `opts.catchup`
7. New CSS rule: `.hab-modal-sub { font-size: 11px; color: var(--muted); margin-bottom: 10px; }`
8. `rSettings()`: add the toggle row in the appropriate section

Approximate LOC: ~50 added, no significant deletes.
