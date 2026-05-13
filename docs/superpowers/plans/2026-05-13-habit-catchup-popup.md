# Habit Catch-up Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show yesterday's habits in a modal the first time the user opens the app each day, so they can quick-tick anything they forgot to log. Single-tap dismiss; auto-fires once per device per day; respects a Settings toggle.

**Architecture:** Reuses the existing `openHabitDayModal()` from `index.html` with a `catchup: true` option that adds a title prefix and a sub-line. Trigger logic runs from `handleSnapshot` after initial sync completes, gated by a localStorage day-stamp + a Firestore-synced enable flag. Includes a small side-fix to `openHabitDayModal()` so its title refreshes on subsequent opens for different days (a pre-existing bug surfaced by this feature).

**Tech Stack:** Vanilla JS, Firebase Firestore, localStorage.

**Source spec:** `docs/superpowers/specs/2026-05-13-habit-catchup-popup-design.md`

**Pre-flight:** Read the spec end-to-end before starting. Each task references it implicitly. Ships alongside the People tab plan as part of v151 — but each plan's final commit is independent; whichever ships first bumps APP_VERSION, the second one just commits without re-bumping.

**Codebase conventions:** Same as the People plan — single-file `index.html`, manual browser verification, local commits per task, final task pushes.

---

## Task 1: Side-fix — refresh `openHabitDayModal` title on every call

**Files:**
- Modify: `index.html` (`openHabitDayModal` ~line 6286)

This is a pre-existing bug: when `openHabitDayModal` is opened for day A, then re-opened later for day B, the title in the `<h3>` stays stuck on day A because it's only rendered in the `if(!overlay)` branch. The catch-up popup will set a catchup-mode title prefix, so we need the title to refresh on every call regardless.

- [ ] **Step 1: Extract the title rendering into a small helper**

Find `function openHabitDayModal(cy,cm,cd){`. Add this helper function just above it:

```js
// Update the modal's title and (optional) subtitle on every call so they
// reflect the currently-viewed day. Pre-existing openHabitDayModal only
// set these in the `if(!overlay)` branch — opening for a different day
// later left the title stuck on the first day's heading.
function _renderHabitDayModalChrome(overlay,date,opts){
  const titleEl=overlay.querySelector('h3.hab-modal-title');
  const subEl=overlay.querySelector('.hab-modal-sub');
  const dayLabel=date.toLocaleDateString('en-ZA',{weekday:'long',day:'numeric',month:'long'});
  if(titleEl){
    titleEl.textContent=opts&&opts.catchup?`Habit catch-up · ${dayLabel}`:dayLabel;
  }
  if(opts&&opts.catchup){
    if(!subEl){
      const newSub=document.createElement('div');
      newSub.className='hab-modal-sub';
      newSub.textContent='Tick anything you actually did. Already-ticked items are pre-filled.';
      titleEl.parentNode.insertBefore(newSub,titleEl.nextSibling);
    }
  } else if(subEl){
    subEl.remove();
  }
}
```

- [ ] **Step 2: Update `openHabitDayModal` to take optional opts and call the helper**

Replace the function signature line + the `<h3>` line + the body-update line.

Original (around lines 6286-6328):

```js
function openHabitDayModal(cy,cm,cd){
  ...
  if(!overlay){
    overlay=document.createElement('div');
    overlay.className='modal';overlay.style.display='flex';overlay.id='habit-day-modal';
    overlay.innerHTML=`<div class="modal-bd"></div>
      <div class="modal-body" style="max-width:440px">
        <h3>${date.toLocaleDateString('en-ZA',{weekday:'long',day:'numeric',month:'long'})}</h3>
        <div class="hab-modal-stat"></div>
        ...
      </div>`;
    ...
  }
  ...
  renderHabitDayModalBody(overlay,cy,cm,cd);
}
```

Change to:

```js
function openHabitDayModal(cy,cm,cd,opts){
  // Kill any queued/visible hover preview so we don't get the modal
  // AND the popover on screen at the same time.
  clearTimeout(_mcwHoverTimer);hideMcwPopover();
  const date=new Date(cy,cm,cd);
  let overlay=document.getElementById('habit-day-modal');
  let body=overlay?overlay.querySelector('.hab-modal-body'):null;
  let stat=overlay?overlay.querySelector('.hab-modal-stat'):null;
  if(!overlay){
    overlay=document.createElement('div');
    overlay.className='modal';overlay.style.display='flex';overlay.id='habit-day-modal';
    overlay.innerHTML=`<div class="modal-bd"></div>
      <div class="modal-body" style="max-width:440px">
        <h3 class="hab-modal-title"></h3>
        <div class="hab-modal-stat"></div>
        <div class="hab-modal-body"></div>
        <div class="modal-actions" style="margin-top:14px">
          <button class="btn btn-sm" data-action="close">Close</button>
          <div class="spacer"></div>
          <button class="btn btn-primary btn-sm" data-action="open">Open in Day view</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);_syncBodyLock();
    body=overlay.querySelector('.hab-modal-body');
    stat=overlay.querySelector('.hab-modal-stat');
    overlay.addEventListener('click',e=>{
      const act=e.target.dataset?.action;
      if(act==='close'||e.target.closest('.modal-bd')){overlay.remove();_syncBodyLock();return;}
      if(act==='open'){overlay.remove();_syncBodyLock();UI.calDate=date;UI.calView='day';rCal();return;}
      const tap=e.target.closest('.hab-modal-tap');
      if(tap){
        const hid=tap.dataset.toggleId;
        toggleHabitDate(hid,overlay.dataset.ds);
        renderHabitDayModalBody(overlay,cy,cm,cd);
      }
    });
  }
  overlay.dataset.ds=`${cy}-${String(cm+1).padStart(2,'0')}-${String(cd).padStart(2,'0')}`;
  _renderHabitDayModalChrome(overlay,date,opts);
  renderHabitDayModalBody(overlay,cy,cm,cd);
}
```

Notes on the diff: the only HTML change inside the `<div class="modal-body">` is that the `<h3>` now has class `hab-modal-title` and no text content (filled by `_renderHabitDayModalChrome`). Everything else is preserved.

- [ ] **Step 3: Add CSS for `.hab-modal-sub`**

Add anywhere in the existing habit-modal CSS region:

```css
.hab-modal-sub{font-size:11px;color:var(--muted);margin-top:-6px;margin-bottom:10px;font-style:italic}
```

- [ ] **Step 4: Manual verification of the side-fix**

1. Open the calendar in habits mode. Tap day A (e.g., Tuesday). Modal opens with title "Tuesday 12 May" (or your locale equivalent).
2. Close the modal. Tap day B (e.g., Friday). Modal opens with title "Friday 15 May" — NOT stuck on Tuesday.
3. Tap a habit row to toggle. The modal stays open; the body updates; the title remains "Friday 15 May".

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "fix(habits): refresh openHabitDayModal title on every call (pre-existing bug surfaced by catch-up popup)"
```

---

## Task 2: Add `habitCatchupEnabled` to state + persistence + Settings toggle

**Files:**
- Modify: `index.html` (S init, `_buildSavePayload`, `handleSnapshot`, `rSettings`)

- [ ] **Step 1: Add `habitCatchupEnabled: true` to the S initial state**

Find the `const S={...}` declaration. Add `habitCatchupEnabled:true` to the object literal alongside the other top-level fields. (If you've also done People Task 1, add it to that same line. If not, add it now.) The full line:

```js
const S={tasks:[],builds:[],learning:[],ideas:[],notes:[],customEvents:[],habits:[],resources:[],reminders:[],dayNotes:{},disabledCalendars:[],aiHistory:[],soundsEnabled:false,aiConfirmMode:'calendar',workProjects:[],calendarDefaults:{timedReminders:[60,10],allDayReminders:[0],birthdayReminders:[1440,0]},notebook:{sections:[]},habitCatchupEnabled:true};
```

(If People schema is already there, keep its fields too.)

- [ ] **Step 2: Persist in `_buildSavePayload`**

Add to the body of `_buildSavePayload`, just before the schema-version line:

```js
  payload.habitCatchupEnabled=typeof S.habitCatchupEnabled==='boolean'?S.habitCatchupEnabled:true;
```

- [ ] **Step 3: Type-guard in `handleSnapshot`**

Find the section in `handleSnapshot` where other scalar fields are loaded (search anchor: `S.lifeRhythm=d.lifeRhythm||'';` or similar). Add:

```js
    S.habitCatchupEnabled=typeof d.habitCatchupEnabled==='boolean'?d.habitCatchupEnabled:true;
```

- [ ] **Step 4: Add a toggle in Settings**

Find `function rSettings()` (search anchor: `function rSettings`). Locate where the Habits or "Behaviour" section is rendered. Add this row in the most-relevant section:

```js
  html += `
    <div class="setting-row">
      <div class="setting-label">Daily habit catch-up</div>
      <div class="setting-desc">Show yesterday's habits the first time you open the app each day.</div>
      <label class="setting-toggle"><input type="checkbox" data-setting="habitCatchupEnabled" ${S.habitCatchupEnabled!==false?'checked':''}> <span class="setting-toggle-track"></span></label>
    </div>
  `;
```

(Adapt to match the existing toggle row markup in the codebase — there's a pattern already in use for `soundsEnabled` etc. If the existing toggle pattern is different, mirror it.)

- [ ] **Step 5: Wire up the toggle change handler**

Find where existing settings toggles are bound (usually a `change` listener at the end of `rSettings()`). Add a handler for `data-setting="habitCatchupEnabled"`:

```js
  // Habit catch-up toggle
  const cb=document.querySelector('[data-setting="habitCatchupEnabled"]');
  if(cb&&!cb.dataset.bound){
    cb.dataset.bound='1';
    cb.addEventListener('change',()=>{
      S.habitCatchupEnabled=cb.checked;
      svAll();
    });
  }
```

- [ ] **Step 6: Manual verification**

1. Open Settings. Verify the "Daily habit catch-up" toggle appears with a label and description. It's ON by default.
2. Click the toggle. Refresh the page. Toggle is now OFF (synced via Firestore).
3. Click again to turn back ON.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat(habit-popup): add habitCatchupEnabled state + Settings toggle"
```

---

## Task 3: Implement `openHabitCatchupModal` and `maybeShowHabitCatchup`

**Files:**
- Modify: `index.html` (new functions, wire into `handleSnapshot`)

- [ ] **Step 1: Add the two new functions**

Place these near `openHabitDayModal` (search anchor: `function openHabitDayModal`):

```js
// Open the catch-up variant of the day modal for yesterday. Reuses
// openHabitDayModal with opts.catchup so the title and sub-line show
// the "Habit catch-up" framing.
function openHabitCatchupModal(){
  const y=yest();
  const [yy,ym,yd]=y.split('-').map(Number);
  openHabitDayModal(yy,ym-1,yd,{catchup:true});
}
// Fires once per device per day to surface yesterday's habits. Gated by:
//   - S.habitCatchupEnabled !== false (user can disable in Settings)
//   - localStorage day-stamp (prevents re-fire after dismiss)
//   - at least one habit exists AND was created on or before yesterday
function maybeShowHabitCatchup(){
  if(S.habitCatchupEnabled===false)return;
  const today=tod();
  let last=null;
  try{last=localStorage.getItem('los_habit_catchup_lastShown');}catch(_){}
  if(last===today)return;
  if(!S.habits||S.habits.length===0)return;
  const ydayIso=yest();
  const eligible=S.habits.some(h=>(h.createdAt||tod())<=ydayIso);
  if(!eligible)return;
  // Stamp BEFORE opening so a tab-close / accidental dismiss doesn't re-fire
  try{localStorage.setItem('los_habit_catchup_lastShown',today);}catch(_){}
  openHabitCatchupModal();
}
```

- [ ] **Step 2: Wire `maybeShowHabitCatchup()` into `handleSnapshot` — server-confirmed path**

Find the section in `handleSnapshot` where the initial server-confirmed snapshot completes. Search anchor: `_initialSyncDone=true;` followed by `setSplashStage(100,'Ready');`. Find the LATER occurrence (the one outside the cache-fallback branch — should be at around line 4188 in v150). The block looks like:

```js
      _initialSyncDone=true;
      setSplashStage(100,'Ready');setTimeout(hideSplash,250);
      render();loadDailyNote();loadTip(false);
      if(!getKey())promptKey();
```

Add `maybeShowHabitCatchup();` after the `if(!getKey())promptKey();` line:

```js
      _initialSyncDone=true;
      setSplashStage(100,'Ready');setTimeout(hideSplash,250);
      render();loadDailyNote();loadTip(false);
      if(!getKey())promptKey();
      maybeShowHabitCatchup();
```

- [ ] **Step 3: Wire `maybeShowHabitCatchup()` into the cache-fallback path**

In the same function, find the cache-fallback timer block (search anchor: `'[sync] no server snapshot in '+(delay/1000)+'s — accepting cache'`). Inside that block, after the existing `try{render();loadDailyNote();loadTip(false);if(!getKey())promptKey();}catch(_){}` line, modify to:

```js
              try{render();loadDailyNote();loadTip(false);if(!getKey())promptKey();maybeShowHabitCatchup();}catch(_){}
```

- [ ] **Step 4: Manual verification**

1. Make sure you have at least one habit that was created at least a day ago.
2. Open the JS console:
   ```js
   localStorage.removeItem('los_habit_catchup_lastShown');
   location.reload();
   ```
3. App loads. After splash, the catch-up modal should appear with title "Habit catch-up · [Yesterday's day name] [date]" and the subtitle "Tick anything you actually did. Already-ticked items are pre-filled."
4. Yesterday's habits appear split into Done / Not done / Rest day sections.
5. Tick / untick a habit. State updates in place.
6. Click Close. Modal goes away.
7. Reload the page WITHOUT clearing localStorage. Modal does NOT re-appear (already shown today).
8. Clear localStorage again, then in Settings turn the toggle OFF. Reload. Modal does NOT appear (disabled).
9. Re-enable the toggle. Clear localStorage. Reload. Modal appears again.

- [ ] **Step 5: Edge-case verification**

1. With ZERO habits in `S.habits`: clear `los_habit_catchup_lastShown` and reload. Modal does NOT appear.
2. Add a habit RIGHT NOW (today). Clear `los_habit_catchup_lastShown` and reload. Modal does NOT appear (no eligible habit had createdAt <= yesterday).
3. Wait 24+ hours (or manually edit a habit's `createdAt` in console to yesterday's date + `svAll()`), clear stamp, reload. Modal appears.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(habit-popup): openHabitCatchupModal + maybeShowHabitCatchup trigger"
```

---

## Task 4: Version bump + push (if shipping standalone)

**Files:**
- Modify: `index.html` (APP_VERSION), `sw.js` (CACHE)

NOTE: If the People tab plan is shipping in the same release (v151), do NOT do this task — let that plan handle the bump + push. The features can share a single version bump. If shipping the habit popup standalone, proceed.

- [ ] **Step 1: Bump APP_VERSION**

```js
const APP_VERSION='v151';
```

- [ ] **Step 2: Bump sw.js cache**

```js
const CACHE = 'lifeos-v151';
```

- [ ] **Step 3: Full-feature smoke test**

1. Clear localStorage stamp + reload — popup fires
2. Dismiss with Close — doesn't re-fire on reload
3. Tap outside — doesn't re-fire
4. Toggle off in Settings — doesn't fire even after clearing stamp
5. Toggle on — fires after clearing stamp + reload
6. Open habits month view, tap a different day — that modal works normally with the correct day's title (regression check on Task 1's side-fix)

- [ ] **Step 4: Commit + push**

```bash
git add index.html sw.js
git commit -m "v151: Daily habit catch-up popup"
git push origin HEAD:main
```

- [ ] **Step 5: Post-deploy verification**

1. Wait ~30 seconds for Cloudflare Pages
2. Open the live URL in a fresh tab — auto-reloads to v151
3. On phone: clear app data (or use Incognito) — the catch-up popup should appear on first daily open
4. Verify Settings toggle works on phone too

---

## Out of scope (per spec)

- Multi-day catch-up ("you missed 3 days, review them all")
- Smart suppression when all habits were already ticked
- Sounds / haptics on popup fire

End of plan.
