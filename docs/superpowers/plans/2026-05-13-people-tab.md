# People Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new top-level "People" tab that lets the user track humans they care about — each person has a card with name, where you met, multiple promises (each link-to-task-able), a paddle-style friendship level, GCal-sourced birthday, tags, and a pin button. Ships to v151.

**Architecture:** Single-file PWA, vanilla HTML/CSS/JS in `index.html`. All new state lives on the global `S` object alongside existing arrays (`S.tasks`, `S.habits`, etc.), persisted to Firestore via the existing `svAll` / `_buildSavePayload` plumbing. New route `'people'` joins the existing `ROUTES` array. Person cards render in a CSS grid; detail view is a `.modal`-class overlay matching existing modals. The promise → task link reuses the task-tick handler to detect a back-link and complete the promise.

**Tech Stack:** Vanilla JS, Firebase Firestore, Google Calendar API, existing CSS-var theme palette (`--gold`, `--pink`, `--blue` etc.).

**Source spec:** `docs/superpowers/specs/2026-05-13-people-tab-design.md`

**Pre-flight:** Read the spec end-to-end before starting. Every task references it implicitly. Final commit bumps `APP_VERSION` to `'v151'` and `CACHE` to `'lifeos-v151'`.

**Codebase conventions:**
- Single-file: every code change lands in `index.html`. Line numbers in this plan reflect v150 state and may drift by ±20 lines as tasks accumulate; use Grep to find the anchor strings.
- Commit style: short imperative, no body unless complex; each task ends with one local commit (no push until final task).
- IDs: generated via existing `uid()` helper.
- "Today" date: existing `tod()` helper returns `YYYY-MM-DD` local-time.

**Manual verification model:** This codebase has no automated test framework. Every task ends with a manual browser verification step — open `index.html` in a browser, do the listed actions, confirm the listed outcomes. If verification fails, do not commit; debug and re-verify.

---

## Task 1: Add People schema to state + persistence

**Files:**
- Modify: `index.html` (S initial state ~line 4393, `_buildSavePayload` ~line 4204, `handleSnapshot` ~line 4089, `SCHEMA_VERSION` constant ~line 4420)

- [ ] **Step 1: Extend the `S` initial state with people fields**

Find the line that defines `S` (search anchor: `const S={tasks:[]`). Add the new fields to the object literal so the final line looks like this — keep all existing fields in place:

```js
const S={tasks:[],builds:[],learning:[],ideas:[],notes:[],customEvents:[],habits:[],resources:[],reminders:[],dayNotes:{},disabledCalendars:[],aiHistory:[],soundsEnabled:false,aiConfirmMode:'calendar',workProjects:[],calendarDefaults:{timedReminders:[60,10],allDayReminders:[0],birthdayReminders:[1440,0]},notebook:{sections:[]},people:[],peopleTags:[],peopleLevelNames:['Acquaintance','Casual friend','Friend','Close friend','Inner circle'],peopleSettings:{defaultSort:'promise'}};
```

- [ ] **Step 2: Persist the new fields in `_buildSavePayload`**

Find `function _buildSavePayload()` (search anchor: `function _buildSavePayload`). Just before the existing line `if(typeof S._schemaVersion==='number')payload._schemaVersion=S._schemaVersion;`, add four lines:

```js
  payload.people=Array.isArray(S.people)?S.people:[];
  payload.peopleTags=Array.isArray(S.peopleTags)?S.peopleTags:[];
  payload.peopleLevelNames=Array.isArray(S.peopleLevelNames)&&S.peopleLevelNames.length===5?S.peopleLevelNames:['Acquaintance','Casual friend','Friend','Close friend','Inner circle'];
  payload.peopleSettings=S.peopleSettings&&typeof S.peopleSettings==='object'?S.peopleSettings:{defaultSort:'promise'};
```

- [ ] **Step 3: Type-guard the new fields in `handleSnapshot`**

Find the array-coerce block (search anchor: `['tasks','builds','learning','ideas','notes','habits','resources','reminders'].forEach`). Add `'people','peopleTags','peopleLevelNames'` to the array so it reads:

```js
    ['tasks','builds','learning','ideas','notes','habits','resources','reminders','people','peopleTags','peopleLevelNames'].forEach(k=>{
      if(d[k]===undefined)return;
      if(Array.isArray(d[k]))S[k]=d[k];
      else{console.warn('[snapshot] expected array for',k,'got',typeof d[k],'— coerced to []');S[k]=[];}
    });
```

Then below the existing `S.disabledCalendars=...` line, add the peopleSettings load (search anchor: `S.disabledCalendars=Array.isArray`):

```js
    S.peopleSettings=d.peopleSettings&&typeof d.peopleSettings==='object'?d.peopleSettings:{defaultSort:'promise'};
    // peopleLevelNames default if missing or malformed
    if(!Array.isArray(S.peopleLevelNames)||S.peopleLevelNames.length!==5){
      S.peopleLevelNames=['Acquaintance','Casual friend','Friend','Close friend','Inner circle'];
    }
```

- [ ] **Step 4: Bump `SCHEMA_VERSION` from 1 to 2**

Find `const SCHEMA_VERSION=1;` and change to:

```js
const SCHEMA_VERSION=2;
```

- [ ] **Step 5: Add `migratePeople()` function and call it from the migration block**

Find `function migrateProjects()` and add this function just below it:

```js
// v1 → v2 migration. People is a brand-new feature; this just guarantees
// the field shapes are present so render code doesn't have to defensively
// check on every read. No data transformation needed for existing users.
function migratePeople(){
  if(!Array.isArray(S.people))S.people=[];
  if(!Array.isArray(S.peopleTags))S.peopleTags=[];
  if(!Array.isArray(S.peopleLevelNames)||S.peopleLevelNames.length!==5){
    S.peopleLevelNames=['Acquaintance','Casual friend','Friend','Close friend','Inner circle'];
  }
  if(!S.peopleSettings||typeof S.peopleSettings!=='object'){
    S.peopleSettings={defaultSort:'promise'};
  }
  if(!['promise','level','lastSeen','name','recent'].includes(S.peopleSettings.defaultSort)){
    S.peopleSettings.defaultSort='promise';
  }
}
```

Find the migration block in `handleSnapshot` (search anchor: `if(docSchemaVersion<SCHEMA_VERSION||window.__forceMigrate){`). Add `migratePeople();` right after `migrateProjects();`:

```js
      migrateHabits();
      migrateProjects();
      migratePeople();
      S._schemaVersion=SCHEMA_VERSION;
```

- [ ] **Step 6: Manual verification**

1. Open `index.html` in a browser. The app loads as before.
2. Open the JS console: type `S.people` — expect `[]`. Type `S.peopleTags` — expect `[]`. Type `S.peopleLevelNames` — expect `['Acquaintance','Casual friend','Friend','Close friend','Inner circle']`. Type `S.peopleSettings` — expect `{defaultSort:'promise'}`.
3. Refresh the page. Same values still present (Firestore round-trip).
4. In console: type `S._schemaVersion` — expect `2`.
5. Add a junk task (any way you normally do) and refresh. Confirm no existing data was harmed.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat(people): add S.people / peopleTags / peopleLevelNames schema + migration"
```

---

## Task 2: Register `people` route + nav drawer entries + empty state

**Files:**
- Modify: `index.html` (`ROUTES` ~line 2957, `ROUTE_TITLES` ~line 2958, sidebar nav ~line 2188, mobile drawer ~line 2224, route container near line 2486)

- [ ] **Step 1: Add `'people'` to `ROUTES` and `ROUTE_TITLES`**

Find `const ROUTES=['today',...]` and change to:

```js
const ROUTES=['today','calendar','projects','habits','people','notebook','brain','settings'];
const ROUTE_TITLES={today:'Today',calendar:'Calendar',projects:'Projects',habits:'Habits',people:'People',notebook:'Notebook',brain:'Brain',settings:'Settings'};
```

- [ ] **Step 2: Add sidebar nav entry**

Find the line `<a href="#habits" data-route-link="habits">...` in the sidebar `<nav class="s-nav">`. Add this line right after it:

```html
        <a href="#people" data-route-link="people"><span class="ic"><svg width="17" height="17"><use href="#i-today"/></svg></span><span class="label">People</span><span class="dot"></span></a>
```

(Reusing `#i-today` as a placeholder icon; visual polish later if needed.)

- [ ] **Step 3: Add mobile drawer entry**

Find the line `<a href="#habits" data-route-link="habits" onclick="closeDrawer()" class="s-nav-a">...` in the mobile drawer. Add this line right after it:

```html
      <a href="#people" data-route-link="people" onclick="closeDrawer()" class="s-nav-a"><span class="ic"><svg width="17" height="17"><use href="#i-today"/></svg></span><span>People</span></a>
```

- [ ] **Step 4: Add the route container with an empty-state**

Find `<!-- SETTINGS -->` and `<div class="route" data-route="settings">` and add this block immediately before it (so People sits between Brain and Settings in DOM order, although nav order has it earlier — DOM order only affects fallback hash routing, the data-route attribute does the actual show/hide):

```html
      <!-- PEOPLE -->
      <div class="route" data-route="people">
        <div class="page-hdr">
          <div class="page-title">People</div>
          <div class="page-actions">
            <button class="btn btn-primary btn-sm" onclick="openPersonModal()">+ Add person</button>
          </div>
        </div>
        <div id="people-toolbar"></div>
        <div id="people-grid"></div>
      </div>
```

- [ ] **Step 5: Add a stub `rPeople()` function**

Find `function rTasks(){` or another route renderer and add this stub above the existing `function render(){` declaration (search anchor: `function render(){`):

```js
function rPeople(){
  const grid=document.getElementById('people-grid');if(!grid)return;
  const list=S.people||[];
  if(!list.length){
    grid.innerHTML=`<div class="no-t">Track the people you care about. <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="openPersonModal()">+ Add your first person</button></div>`;
    return;
  }
  grid.innerHTML=list.map(p=>`<div class="people-card-stub" style="padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px"><b>${esc(p.name||'(no name)')}</b><br><small>${esc(p.metAt||'')}</small></div>`).join('');
}
function openPersonModal(idOrNull){
  // Placeholder — full implementation lands in Task 3.
  alert('Coming in Task 3');
}
```

- [ ] **Step 6: Wire `rPeople()` into `render()`**

Find `function render(){`. Inside it, where other renderers like `rTasks()`, `rHabits()`, etc. are called, add `rPeople();` to the sequence. If there's a route-specific check like `if(currentRoute==='habits')rHabits();`, mirror it: `if(currentRoute==='people')rPeople();`. Otherwise just append a call inside the body.

- [ ] **Step 7: Manual verification**

1. Open the app. Click the "People" nav entry in the sidebar (desktop) — verify the URL hash becomes `#people` and the route container shows.
2. The empty-state should appear: "Track the people you care about. + Add your first person".
3. Click "+ Add your first person" — alert appears saying "Coming in Task 3".
4. Open the mobile drawer (hamburger menu) — verify People appears there too.
5. The top bar title should read "People" when on the route.

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat(people): register route, nav entries, empty state stub"
```

---

## Task 3: Person add / edit / delete modal + basic CRUD

**Files:**
- Modify: `index.html` (replace stub `openPersonModal`, update `rPeople()`)

- [ ] **Step 1: Replace the stub `openPersonModal()` with the real implementation**

Replace the placeholder `function openPersonModal(idOrNull){...alert...}` with this complete function:

```js
function openPersonModal(idOrNull){
  const id=idOrNull||null;
  const editing=!!id;
  const p=editing?(S.people||[]).find(x=>x.id===id):null;
  if(editing&&!p)return;
  const old=document.getElementById('person-modal');if(old)old.remove();
  const m=document.createElement('div');
  m.className='modal';m.id='person-modal';m.style.display='flex';
  m.innerHTML=`<div class="modal-bd"></div>
    <div class="modal-body" style="max-width:440px">
      <h3 style="margin-bottom:12px">${editing?'Edit person':'Add person'}</h3>
      <div class="aic-edit-field"><label>Name</label><input id="pm-name" value="${esc(p?.name||'')}" placeholder="Full name"></div>
      <div class="aic-edit-field"><label>Where you met</label><input id="pm-met" value="${esc(p?.metAt||'')}" placeholder="e.g. University, Gym, Hennie's wedding"></div>
      <div class="aic-edit-row">
        <div class="aic-edit-field"><label>Phone</label><input id="pm-phone" value="${esc(p?.phone||'')}" placeholder="Optional"></div>
        <div class="aic-edit-field"><label>Email</label><input id="pm-email" value="${esc(p?.email||'')}" placeholder="Optional"></div>
      </div>
      <div class="aic-edit-field"><label>Notes</label><textarea id="pm-notes" rows="3" placeholder="Anything worth remembering — context, shared interests, etc.">${esc(p?.notes||'')}</textarea></div>
      <div class="modal-actions" style="margin-top:14px">
        ${editing?`<button class="btn btn-ghost btn-sm" data-action="delete" style="color:var(--red,#c46a6a)">Delete</button>`:''}
        <div class="spacer"></div>
        <button class="btn btn-sm" data-action="cancel">Cancel</button>
        <button class="btn btn-primary btn-sm" data-action="save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(m);_syncBodyLock();
  setTimeout(()=>{const n=document.getElementById('pm-name');if(n)n.focus();},10);
  m.addEventListener('click',e=>{
    const a=e.target.dataset?.action;
    if(a==='cancel'||e.target.closest('.modal-bd')){m.remove();_syncBodyLock();return;}
    if(a==='save'){
      const name=document.getElementById('pm-name').value.trim();
      if(!name){alert('Name is required.');return;}
      const data={
        name,
        metAt:document.getElementById('pm-met').value.trim(),
        phone:document.getElementById('pm-phone').value.trim(),
        email:document.getElementById('pm-email').value.trim(),
        notes:document.getElementById('pm-notes').value.trim()
      };
      if(editing){
        Object.assign(p,data);
      } else {
        S.people=S.people||[];
        S.people.push({
          id:uid(),
          ...data,
          level:{major:1,minor:1},
          tagIds:[],
          promises:[],
          lastTogether:null,
          createdAt:tod()
        });
      }
      svAll();rPeople();
      m.remove();_syncBodyLock();
      return;
    }
    if(a==='delete'){
      // Confirm-and-delete is implemented in Task 14 (it needs to cascade
      // linked tasks). For now: simple confirm + remove the person.
      if(!confirm(`Delete ${p.name}?`))return;
      S.people=(S.people||[]).filter(x=>x.id!==p.id);
      svAll();rPeople();
      m.remove();_syncBodyLock();
    }
  });
}
```

- [ ] **Step 2: Update `rPeople()` to make cards clickable**

Replace the existing `rPeople()` body (the one with `.people-card-stub`) with:

```js
function rPeople(){
  const grid=document.getElementById('people-grid');if(!grid)return;
  const list=S.people||[];
  if(!list.length){
    grid.innerHTML=`<div class="no-t">Track the people you care about. <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="openPersonModal()">+ Add your first person</button></div>`;
    return;
  }
  grid.innerHTML=list.map(p=>`<div class="people-card-stub" style="padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer" onclick="openPersonModal('${p.id}')"><b>${esc(p.name||'(no name)')}</b>${p.metAt?`<br><small style="color:var(--muted)">${esc(p.metAt)}</small>`:''}</div>`).join('');
}
```

- [ ] **Step 3: Manual verification**

1. Open the People route. Click "+ Add your first person". Modal opens.
2. Type name "Jack", "where you met" = "University 2019", leave the rest blank. Click Save. Card appears in the grid with "Jack" + "University 2019".
3. Click the Jack card. Modal opens pre-filled with his data. Change "where you met" to "Uni 2019". Click Save. Card updates.
4. Open Jack again. Click Delete. Confirm. Card disappears. Empty state returns.
5. Add two more people: Andrew (Gym, 2023) and Nigel (Hennie's wedding). Refresh the page. Both reappear from Firestore.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(people): add/edit/delete person modal + basic card render"
```

---

## Task 4: Real card layout — name, metAt, level badge, last-seen badge, CSS grid

**Files:**
- Modify: `index.html` (replace `rPeople()` body, add new CSS block)

- [ ] **Step 1: Add CSS for the people grid + card**

Find a CSS-heavy region (search anchor: `.hab-bar{` for a nearby anchor in the habits CSS). Add this CSS block above or below an existing block (placement doesn't matter for correctness, but adjacent to habit-card CSS makes maintenance easier):

```css
/* People tab — card grid. CSS grid with auto-fill so cards reflow to
   1/2/3/4 columns based on viewport. Cards reuse the existing
   --surface / --border palette so themes work without overrides. */
.people-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
@media (max-width:460px){.people-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
.people-card{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:13px 14px;cursor:pointer;transition:border-color .15s,background .15s}
.people-card:hover{border-color:var(--border-strong)}
.people-card.overdue{background:#fef5f3}
[data-theme="studio"] .people-card.overdue{background:#3a2826}
.people-card .pc-pin{position:absolute;top:8px;left:10px;font-size:11px;color:var(--gold)}
.people-card .pc-lvl{position:absolute;top:8px;right:10px;font-size:9.5px;font-weight:700;letter-spacing:.05em;background:var(--gold-bg);color:var(--gold);padding:2px 7px;border-radius:6px}
.people-card .pc-name{font-size:15px;font-weight:700;margin-bottom:3px;padding:0 60px 0 0;color:var(--text)}
.people-card.has-pin .pc-name{padding-left:18px}
.people-card .pc-met{font-size:11px;color:var(--muted);margin-bottom:8px}
.people-card.has-pin .pc-met{padding-left:18px}
.people-card .pc-last{position:absolute;bottom:8px;right:11px;font-size:9.5px;color:var(--muted);font-weight:500}
.people-card.overdue .pc-last{color:#c46a6a;font-weight:700}
.people-card .pc-promise{font-size:11.5px;background:var(--surface-2);border-left:3px solid var(--sage,#7fa186);padding:5px 9px;border-radius:5px;display:flex;align-items:center;gap:5px;margin-top:4px;color:var(--text)}
.people-card .pc-promise-empty{font-size:11px;color:var(--muted);font-style:italic;padding:4px 0}
.people-card .pc-promise-more{font-size:10px;color:var(--muted);text-align:right;margin-top:3px;padding-right:4px}
```

- [ ] **Step 2: Add helper functions for level formatting and last-seen formatting**

Place these next to other `S.people` helpers (or just before `rPeople()`):

```js
// Format the level object as a compact "L4.3" string for the badge.
function _peopleLevelLabel(level){
  const M=(level&&level.major)||1;
  const m=(level&&level.minor)||1;
  return `L${M}.${m}`;
}
// Format the last-seen badge from lastTogether.doneAt.
function _peopleLastSeen(person){
  if(!person.lastTogether||!person.lastTogether.doneAt)return {label:'—',days:null};
  const today=new Date();today.setHours(0,0,0,0);
  const [y,m,d]=person.lastTogether.doneAt.split('-').map(Number);
  const then=new Date(y,m-1,d);then.setHours(0,0,0,0);
  const days=Math.round((today-then)/86400000);
  if(days<=0)return{label:'today',days:0};
  if(days<7)return{label:`${days}d`,days};
  if(days<30)return{label:`${Math.round(days/7)}w`,days};
  if(days<180)return{label:`${Math.round(days/30)}mo`,days};
  return{label:`${Math.round(days/365)}y`,days};
}
```

- [ ] **Step 3: Replace `rPeople()` with the real card layout**

```js
function rPeople(){
  const grid=document.getElementById('people-grid');if(!grid)return;
  const list=S.people||[];
  if(!list.length){
    grid.innerHTML=`<div class="no-t">Track the people you care about. <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="openPersonModal()">+ Add your first person</button></div>`;
    grid.className='';
    return;
  }
  grid.className='people-grid';
  grid.innerHTML=list.map(p=>{
    const ls=_peopleLastSeen(p);
    const overdue=ls.days!==null&&ls.days>90;
    const hasPin=!!p.pinned;
    const promises=Array.isArray(p.promises)?p.promises:[];
    const topPromise=promises[0];
    const more=promises.length-1;
    return `<div class="people-card${overdue?' overdue':''}${hasPin?' has-pin':''}" onclick="openPersonModal('${p.id}')">
      ${hasPin?`<div class="pc-pin">📌</div>`:''}
      <div class="pc-lvl">${_peopleLevelLabel(p.level)}</div>
      <div class="pc-name">${esc(p.name||'(no name)')}</div>
      ${p.metAt?`<div class="pc-met">${esc(p.metAt)}</div>`:''}
      ${topPromise?`<div class="pc-promise"><span>🤝</span> ${esc(topPromise.text||'')}</div>`:`<div class="pc-promise-empty">— no promises</div>`}
      ${more>0?`<div class="pc-promise-more">+ ${more} more promise${more===1?'':'s'}</div>`:''}
      <div class="pc-last">${esc(ls.label)}</div>
    </div>`;
  }).join('');
}
```

- [ ] **Step 4: Manual verification**

1. Open the People route. With at least 3 people from Task 3, verify they render as cards in a grid.
2. Resize the browser window — verify the grid reflows from 4 cols → 3 → 2 → 1 as width decreases.
3. Each card shows: name (large), where you met (small grey), an "L1.1" badge top-right, "— no promises" (grey italic).
4. The last-seen badge bottom-right shows "—".
5. On mobile (DevTools responsive mode at 375px width): cards collapse to 2 columns.
6. Open the JS console and set a person's `lastTogether` manually:
   ```js
   S.people[0].lastTogether={text:'Coffee',doneAt:'2025-02-01'};
   rPeople();
   ```
   The first card should now show "Xmo" or "Xy" depending on today's date relative to that, and get a soft red tint (assuming the date is >90 days ago).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(people): card grid layout, last-seen badge, overdue tint"
```

---

## Task 5: Person detail modal — full chrome with sections, replacing the simple edit modal

**Files:**
- Modify: `index.html` (rewrite `openPersonModal` to be the detail view; promote the simple add flow to `openAddPersonModal`)

- [ ] **Step 1: Split the modal into two — simple Add + rich Detail**

Replace the entire `openPersonModal` function with these TWO functions:

```js
// Compact modal for ADDING a new person — just name + metAt + an opt-in
// "add more details" hook that opens the full detail modal.
function openAddPersonModal(){
  const old=document.getElementById('person-modal');if(old)old.remove();
  const m=document.createElement('div');
  m.className='modal';m.id='person-modal';m.style.display='flex';
  m.innerHTML=`<div class="modal-bd"></div>
    <div class="modal-body" style="max-width:380px">
      <h3 style="margin-bottom:12px">Add person</h3>
      <div class="aic-edit-field"><label>Name</label><input id="pm-name" placeholder="Full name"></div>
      <div class="aic-edit-field"><label>Where you met</label><input id="pm-met" placeholder="e.g. University, Hennie's wedding"></div>
      <div class="modal-actions" style="margin-top:14px">
        <button class="btn btn-sm" data-action="cancel">Cancel</button>
        <div class="spacer"></div>
        <button class="btn btn-primary btn-sm" data-action="save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(m);_syncBodyLock();
  setTimeout(()=>{const n=document.getElementById('pm-name');if(n)n.focus();},10);
  m.addEventListener('click',e=>{
    const a=e.target.dataset?.action;
    if(a==='cancel'||e.target.closest('.modal-bd')){m.remove();_syncBodyLock();return;}
    if(a==='save'){
      const name=document.getElementById('pm-name').value.trim();
      if(!name){alert('Name is required.');return;}
      const newP={
        id:uid(),
        name,
        metAt:document.getElementById('pm-met').value.trim(),
        phone:'',email:'',notes:'',
        level:{major:1,minor:1},
        tagIds:[],
        promises:[],
        lastTogether:null,
        createdAt:tod()
      };
      S.people=S.people||[];
      S.people.push(newP);
      svAll();rPeople();
      m.remove();_syncBodyLock();
      // Open the detail modal so the user can fill in the rest if they want
      openPersonModal(newP.id);
    }
  });
}

// Rich detail modal — all sections from the spec. Renders into a single
// modal-body that's tall enough to scroll on mobile.
function openPersonModal(id){
  const p=(S.people||[]).find(x=>x.id===id);
  if(!p)return;
  const old=document.getElementById('person-modal');if(old)old.remove();
  const m=document.createElement('div');
  m.className='modal';m.id='person-modal';m.style.display='flex';
  m.innerHTML=`<div class="modal-bd"></div>
    <div class="modal-body" style="max-width:440px;max-height:90vh;overflow-y:auto">
      <div id="pm-body"></div>
    </div>`;
  document.body.appendChild(m);_syncBodyLock();
  m.addEventListener('click',e=>{
    if(e.target.closest('.modal-bd')){m.remove();_syncBodyLock();return;}
  });
  renderPersonModalBody(p);
}

// Renders the inner body of the detail modal. Called on open and after any
// inline mutation so the view stays in sync without closing/reopening.
function renderPersonModalBody(p){
  const body=document.getElementById('pm-body');if(!body)return;
  const pinned=!!p.pinned;
  body.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:18px;font-weight:700">${esc(p.name||'')}</div>
        ${p.metAt?`<div style="font-size:11px;color:var(--muted)">Met at: ${esc(p.metAt)}</div>`:''}
      </div>
      <button class="btn btn-ghost btn-sm" data-pm-action="toggle-pin" style="color:${pinned?'var(--gold)':'var(--muted)'};font-weight:${pinned?'600':'400'}">${pinned?'📌 Pinned':'📌 Pin'}</button>
    </div>

    <div class="pm-section">
      <div class="pm-row" data-field="phone">${p.phone?`<span class="pm-icon">📱</span> <span class="pm-val">${esc(p.phone)}</span>`:`<button class="pm-add" data-pm-edit="phone">+ Add phone</button>`}</div>
      <div class="pm-row" data-field="email">${p.email?`<span class="pm-icon">✉️</span> <span class="pm-val">${esc(p.email)}</span>`:`<button class="pm-add" data-pm-edit="email">+ Add email</button>`}</div>
    </div>

    <div class="pm-section">
      <div class="pm-sec-lbl">Notes</div>
      <textarea class="pm-notes" data-pm-field="notes" rows="3" placeholder="Anything worth remembering">${esc(p.notes||'')}</textarea>
    </div>

    <div class="pm-section" style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px">
      <button class="btn btn-ghost btn-sm" data-pm-action="delete" style="color:var(--red,#c46a6a)">Delete person</button>
    </div>
  `;
  attachPersonModalHandlers(p);
}

function attachPersonModalHandlers(p){
  const body=document.getElementById('pm-body');if(!body)return;
  body.onclick=e=>{
    const a=e.target.dataset?.pmAction;
    if(a==='toggle-pin'){
      p.pinned=!p.pinned||undefined;
      if(p.pinned===false)delete p.pinned;
      svAll();rPeople();renderPersonModalBody(p);return;
    }
    if(a==='delete'){
      if(!confirm(`Delete ${p.name}?`))return;
      S.people=(S.people||[]).filter(x=>x.id!==p.id);
      svAll();rPeople();
      document.getElementById('person-modal')?.remove();_syncBodyLock();return;
    }
    const editField=e.target.dataset?.pmEdit;
    if(editField){
      const cur=p[editField]||'';
      const val=prompt(editField==='phone'?'Phone number':'Email address',cur);
      if(val===null)return;
      p[editField]=val.trim();
      svAll();rPeople();renderPersonModalBody(p);
    }
  };
  // Notes autosave on blur
  const notes=body.querySelector('[data-pm-field="notes"]');
  if(notes){
    notes.addEventListener('blur',()=>{
      const v=notes.value;
      if(v===p.notes)return;
      p.notes=v;svAll();
    });
  }
  // Inline edit for existing phone / email — tapping the value lets you edit
  body.querySelectorAll('.pm-row[data-field]').forEach(row=>{
    const field=row.dataset.field;
    const val=row.querySelector('.pm-val');
    if(!val)return;
    val.style.cursor='text';
    val.onclick=()=>{
      const newVal=prompt(field==='phone'?'Phone number':'Email address',p[field]||'');
      if(newVal===null)return;
      p[field]=newVal.trim();
      svAll();rPeople();renderPersonModalBody(p);
    };
  });
}
```

- [ ] **Step 2: Update the route's "+ Add person" button + `rPeople()` empty-state button to call `openAddPersonModal()`**

Find the route header HTML you added in Task 2 and change `onclick="openPersonModal()"` to `onclick="openAddPersonModal()"`. Then find the empty-state HTML inside `rPeople()` and update its button's onclick the same way.

- [ ] **Step 3: Add CSS for the new modal classes**

Add this CSS to the same block as the people-card CSS:

```css
.pm-section{margin:0 0 14px 0}
.pm-sec-lbl{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
.pm-row{display:flex;align-items:center;gap:6px;font-size:12.5px;margin-bottom:6px;color:var(--text-2)}
.pm-icon{width:14px;color:var(--muted);flex-shrink:0}
.pm-add{font-size:11px;color:var(--muted);background:transparent;border:1px dashed var(--border-strong);padding:5px 10px;border-radius:5px;cursor:pointer}
.pm-add:hover{color:var(--text);border-color:var(--gold)}
.pm-notes{width:100%;min-height:60px;font-family:inherit;font-size:13px;padding:9px 11px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);box-sizing:border-box;resize:vertical}
```

- [ ] **Step 4: Manual verification**

1. Click "+ Add person" — compact Add modal opens. Add a person "Mia" with metAt "Coffee shop". After Save, the detail modal auto-opens with Mia loaded.
2. Click "+ Add phone" → prompt appears → type a phone number → save. The row now shows 📱 + the number.
3. Click the phone value → prompt with current value → change it → save. Row updates.
4. Edit the Notes textarea. Tab away (blur). Refresh the page. Notes persisted.
5. Click "📌 Pin" → button becomes "📌 Pinned" in gold. The card on the grid behind shows the pin icon.
6. Click "Delete person" → confirm → modal closes, card disappears.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(people): detail modal with phone/email/notes/pin/delete sections"
```

---

## Task 6: Sort chips + pinned-always-on-top

**Files:**
- Modify: `index.html` (update `rPeople()` to render toolbar + apply sort)

- [ ] **Step 1: Add a `_peopleSort(list)` helper**

Place above `rPeople()`:

```js
// Sort the people array per S.peopleSettings.defaultSort. Pinned people
// always float to the top, regardless of selected sort. Within pinned and
// within unpinned, the chosen sort order applies.
function _peopleSort(list){
  const sort=S.peopleSettings?.defaultSort||'promise';
  const pinScore=p=>p.pinned?0:1;
  const earliestPromise=p=>{
    const proms=Array.isArray(p.promises)?p.promises:[];
    if(!proms.length)return {dateRank:Infinity,addedRank:Infinity};
    // Dated promises sort first by date; undated sort second by addedAt
    const dated=proms.filter(x=>x.date).map(x=>x.date).sort();
    const undated=proms.filter(x=>!x.date).map(x=>x.addedAt||'9999').sort();
    if(dated.length)return {dateRank:dated[0],addedRank:undated[0]||'9999'};
    return {dateRank:'~',addedRank:undated[0]||'9999'};
  };
  const cmp={
    promise:(a,b)=>{
      const pa=earliestPromise(a),pb=earliestPromise(b);
      if(pa.dateRank!==pb.dateRank)return String(pa.dateRank).localeCompare(String(pb.dateRank));
      return String(pa.addedRank).localeCompare(String(pb.addedRank));
    },
    level:(a,b)=>{
      const score=p=>(p.level?.major||1)*5+(p.level?.minor||1);
      return score(b)-score(a);
    },
    lastSeen:(a,b)=>{
      const days=p=>{
        if(!p.lastTogether?.doneAt)return Infinity;
        const [y,m,d]=p.lastTogether.doneAt.split('-').map(Number);
        const then=new Date(y,m-1,d);
        return (Date.now()-then.getTime())/86400000;
      };
      return days(b)-days(a);
    },
    name:(a,b)=>(a.name||'').localeCompare(b.name||''),
    recent:(a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')
  };
  return [...list].sort((a,b)=>{
    const ps=pinScore(a)-pinScore(b);
    if(ps!==0)return ps;
    return (cmp[sort]||cmp.promise)(a,b);
  });
}
```

- [ ] **Step 2: Update `rPeople()` to render a sort-chips toolbar + apply sort**

Replace `rPeople()` with:

```js
function rPeople(){
  const grid=document.getElementById('people-grid');if(!grid)return;
  const toolbar=document.getElementById('people-toolbar');
  const list=S.people||[];
  if(toolbar){
    if(!list.length){
      toolbar.innerHTML='';
    } else {
      const sort=S.peopleSettings?.defaultSort||'promise';
      const opts=[
        ['promise','Promise date ↑'],
        ['level','Level ↓'],
        ['lastSeen','Last seen ↑'],
        ['name','Name A–Z'],
        ['recent','Recently added']
      ];
      toolbar.innerHTML=`<div class="people-sort-row">${opts.map(([k,lbl])=>`<button class="people-sort-chip${sort===k?' on':''}" data-sort="${k}">${esc(lbl)}</button>`).join('')}</div>`;
      toolbar.onclick=e=>{
        const s=e.target.dataset.sort;
        if(!s)return;
        S.peopleSettings=S.peopleSettings||{};
        S.peopleSettings.defaultSort=s;
        svAll();rPeople();
      };
    }
  }
  if(!list.length){
    grid.innerHTML=`<div class="no-t">Track the people you care about. <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="openAddPersonModal()">+ Add your first person</button></div>`;
    grid.className='';
    return;
  }
  grid.className='people-grid';
  const sorted=_peopleSort(list);
  grid.innerHTML=sorted.map(p=>{
    const ls=_peopleLastSeen(p);
    const overdue=ls.days!==null&&ls.days>90;
    const hasPin=!!p.pinned;
    const promises=Array.isArray(p.promises)?p.promises:[];
    const topPromise=promises[0];
    const more=promises.length-1;
    return `<div class="people-card${overdue?' overdue':''}${hasPin?' has-pin':''}" onclick="openPersonModal('${p.id}')">
      ${hasPin?`<div class="pc-pin">📌</div>`:''}
      <div class="pc-lvl">${_peopleLevelLabel(p.level)}</div>
      <div class="pc-name">${esc(p.name||'(no name)')}</div>
      ${p.metAt?`<div class="pc-met">${esc(p.metAt)}</div>`:''}
      ${topPromise?`<div class="pc-promise"><span>🤝</span> ${esc(topPromise.text||'')}</div>`:`<div class="pc-promise-empty">— no promises</div>`}
      ${more>0?`<div class="pc-promise-more">+ ${more} more promise${more===1?'':'s'}</div>`:''}
      <div class="pc-last">${esc(ls.label)}</div>
    </div>`;
  }).join('');
}
```

- [ ] **Step 3: Add CSS for the sort chips**

```css
.people-sort-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.people-sort-chip{font-size:11px;padding:4px 9px;border-radius:5px;background:var(--surface);border:1px solid var(--border);color:var(--text-2);cursor:pointer;font-family:inherit}
.people-sort-chip:hover{border-color:var(--border-strong)}
.people-sort-chip.on{background:var(--gold);color:#fff;border-color:var(--gold)}
```

- [ ] **Step 4: Manual verification**

1. With 3+ people, verify sort chips render above the grid. "Promise date ↑" is active (gold).
2. Click each chip in turn and verify the active state changes. Refresh the page — the last-selected sort persists (Firestore).
3. Pin one person via their detail modal. Switch to "Name A–Z" sort. Verify the pinned person sorts to the top regardless of alphabet.
4. Add a person with `lastTogether` set via console: `S.people[0].lastTogether={text:'x',doneAt:'2024-01-01'};svAll();rPeople();`. Switch to "Last seen ↑" — verify that person sorts to the top (longest ago).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(people): sort chips + pinned-always-top"
```

---

## Task 7: Tag data model + tag picker in detail modal

**Files:**
- Modify: `index.html` (`renderPersonModalBody` to include tags section, add helper `_peopleTagById`, `_peopleNextTagColor`)

- [ ] **Step 1: Add tag helpers**

Place near the other `_people*` helpers:

```js
const PEOPLE_TAG_COLORS=['blue','green','pink','gold','lavender','sage','peach','red'];
function _peopleTagById(id){return (S.peopleTags||[]).find(t=>t.id===id);}
function _peopleNextTagColor(){
  const used=new Set((S.peopleTags||[]).map(t=>t.color));
  return PEOPLE_TAG_COLORS.find(c=>!used.has(c))||'blue';
}
function _peopleCreateTag(name,color){
  const tag={id:uid(),name:name.trim(),color:color||_peopleNextTagColor()};
  S.peopleTags=S.peopleTags||[];
  S.peopleTags.push(tag);
  return tag;
}
```

- [ ] **Step 2: Add a Tags section to the detail modal body**

Find `renderPersonModalBody(p)` and insert a new section between the contact rows and the Notes section. The new section HTML:

```js
    <div class="pm-section">
      <div class="pm-sec-lbl">Tags</div>
      <div class="pm-tags-row">
        ${(p.tagIds||[]).map(tid=>{const t=_peopleTagById(tid);if(!t)return '';return `<span class="pm-tag pm-tag-${esc(t.color)}" data-pm-remove-tag="${t.id}" title="Click to remove">${esc(t.name)} ✕</span>`;}).join('')}
        <button class="pm-tag-add" data-pm-action="add-tag">+ Tag</button>
      </div>
    </div>
```

Insert this right after the contact rows section in the template literal.

- [ ] **Step 3: Add CSS for tags**

```css
.pm-tags-row{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.pm-tag{font-size:10.5px;font-weight:600;padding:3px 9px;border-radius:5px;cursor:pointer}
.pm-tag-blue{background:var(--blue-bg);color:var(--blue)}
.pm-tag-green,.pm-tag-sage{background:var(--sage-bg,var(--emerald-bg));color:var(--sage,var(--emerald))}
.pm-tag-pink{background:var(--pink-bg);color:var(--pink)}
.pm-tag-gold{background:var(--gold-bg);color:var(--gold)}
.pm-tag-lavender{background:var(--lavender-bg);color:var(--lavender)}
.pm-tag-peach{background:var(--peach-bg);color:var(--peach)}
.pm-tag-red{background:var(--red-bg,#fee0db);color:var(--red,#c46a6a)}
.pm-tag-add{font-size:11px;color:var(--muted);background:transparent;border:1px dashed var(--border-strong);padding:3px 9px;border-radius:5px;cursor:pointer}
.pm-tag-add:hover{color:var(--text);border-color:var(--gold)}
.people-card .pc-tags{display:flex;flex-wrap:wrap;gap:3px;margin:3px 0 6px 0;padding-right:60px}
.people-card.has-pin .pc-tags{padding-left:18px}
.people-card .pc-tag{font-size:9px;font-weight:600;padding:1px 5px;border-radius:3px}
```

- [ ] **Step 4: Extend `attachPersonModalHandlers` to handle tag interactions**

Add this handler logic inside `attachPersonModalHandlers(p)` — extend the existing `body.onclick = e => { ... }`:

```js
    // Tag remove
    const tagRemoveId=e.target.dataset?.pmRemoveTag;
    if(tagRemoveId){
      p.tagIds=(p.tagIds||[]).filter(id=>id!==tagRemoveId);
      svAll();rPeople();renderPersonModalBody(p);
      return;
    }
    // Tag add popover
    if(a==='add-tag'){
      openTagPicker(p,e.target);
      return;
    }
```

Then add a new function for the tag picker:

```js
function openTagPicker(p,anchorBtn){
  const existing=S.peopleTags||[];
  const old=document.getElementById('tag-picker');if(old)old.remove();
  const pop=document.createElement('div');
  pop.id='tag-picker';pop.className='tag-picker-pop';
  pop.innerHTML=`
    <div class="tp-hdr">Tag this person</div>
    <div class="tp-list">
      ${existing.map(t=>{
        const on=(p.tagIds||[]).includes(t.id);
        return `<div class="tp-row${on?' on':''}" data-tp-id="${t.id}"><span class="pm-tag pm-tag-${esc(t.color)}" style="cursor:pointer">${esc(t.name)}</span><span class="tp-check">${on?'✓':''}</span></div>`;
      }).join('')||'<div class="tp-empty">No tags yet — create one below.</div>'}
    </div>
    <div class="tp-create">
      <input id="tp-new" placeholder="New tag name…" maxlength="30">
      <button data-tp-action="create">+</button>
    </div>
    <div class="tp-foot"><button data-tp-action="close">Close</button></div>
  `;
  document.body.appendChild(pop);
  // Position the popover near the clicked button. Fall back to center if off-screen.
  const r=anchorBtn?.getBoundingClientRect();
  if(r){pop.style.position='fixed';pop.style.top=Math.min(window.innerHeight-380,r.bottom+8)+'px';pop.style.left=Math.max(8,Math.min(window.innerWidth-260,r.left))+'px';}
  pop.addEventListener('click',e=>{
    const id=e.target.closest('[data-tp-id]')?.dataset.tpId;
    if(id){
      p.tagIds=p.tagIds||[];
      if(p.tagIds.includes(id))p.tagIds=p.tagIds.filter(x=>x!==id);
      else p.tagIds.push(id);
      svAll();rPeople();renderPersonModalBody(p);
      pop.remove();return;
    }
    const a=e.target.dataset?.tpAction;
    if(a==='close'){pop.remove();return;}
    if(a==='create'){
      const inp=document.getElementById('tp-new');
      const name=inp.value.trim();
      if(!name){inp.focus();return;}
      const t=_peopleCreateTag(name);
      p.tagIds=p.tagIds||[];
      p.tagIds.push(t.id);
      svAll();rPeople();renderPersonModalBody(p);
      pop.remove();
    }
  });
  // Close on outside click
  setTimeout(()=>{document.addEventListener('click',function once(e){if(!pop.contains(e.target)&&!anchorBtn?.contains(e.target)){pop.remove();document.removeEventListener('click',once);}},{once:false});},10);
}
```

- [ ] **Step 5: Add CSS for the tag picker**

```css
.tag-picker-pop{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px;width:260px;max-height:380px;overflow-y:auto;box-shadow:0 8px 20px rgba(0,0,0,.18);z-index:200;font-family:Inter,sans-serif}
.tp-hdr{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:8px}
.tp-list{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.tp-row{display:flex;justify-content:space-between;align-items:center;padding:4px 6px;border-radius:4px;cursor:pointer}
.tp-row:hover{background:var(--surface-2)}
.tp-row.on{background:var(--surface-2)}
.tp-empty{font-size:11px;color:var(--muted);font-style:italic;padding:4px 6px}
.tp-check{font-size:13px;color:var(--gold);min-width:14px;text-align:right}
.tp-create{display:flex;gap:4px;margin-bottom:8px}
.tp-create input{flex:1;font-size:12px;padding:5px 8px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text)}
.tp-create button{background:var(--gold);color:#fff;border:none;width:28px;font-weight:700;border-radius:4px;cursor:pointer}
.tp-foot{display:flex;justify-content:flex-end}
.tp-foot button{font-size:11px;background:transparent;border:none;color:var(--muted);cursor:pointer}
```

- [ ] **Step 6: Surface tag chips on the card**

In `rPeople()`, modify the card template to include tag chips between metAt and the promise. Replace this part of the card template:

```js
      ${p.metAt?`<div class="pc-met">${esc(p.metAt)}</div>`:''}
      ${topPromise?
```

With:

```js
      ${p.metAt?`<div class="pc-met">${esc(p.metAt)}</div>`:''}
      ${(p.tagIds||[]).length?`<div class="pc-tags">${(p.tagIds||[]).slice(0,2).map(tid=>{const t=_peopleTagById(tid);return t?`<span class="pc-tag pm-tag-${esc(t.color)}">${esc(t.name)}</span>`:'';}).join('')}${(p.tagIds||[]).length>2?`<span class="pc-tag" style="background:var(--surface-2);color:var(--muted)">+${(p.tagIds||[]).length-2}</span>`:''}</div>`:''}
      ${topPromise?
```

- [ ] **Step 7: Manual verification**

1. Open a person's detail modal. Click "+ Tag". Picker appears.
2. Type "Uni" in the input, click "+". New tag created and applied to the person.
3. Close the picker. Card on the grid shows the "Uni" tag chip.
4. Open the same person, click "+ Tag" again. The "Uni" tag now appears in the list (with a checkmark since this person has it). Click it to toggle it off. Card chip disappears.
5. Click "+ Tag" again, add 3 new tags: "Family", "Work", "Friends". Card shows the first 2 + "+1".
6. Each new tag should have a different color from `PEOPLE_TAG_COLORS`.

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat(people): tags model + inline tag picker + card chips"
```

---

## Task 8: Tag filter chips above the grid

**Files:**
- Modify: `index.html` (extend `rPeople()` toolbar + filter logic)

- [ ] **Step 1: Add a UI state for active filter (transient, in-memory only)**

Find `const UI={` near the top of the script section. Add `peopleFilterTag:null` to the object. So the line becomes (keeping all existing fields):

```js
const UI={calView:'week',calDate:new Date(),brainTab:'ideas',calMode:'events',monthDetail:false,taskTab:'daily',peopleFilterTag:null};
```

- [ ] **Step 2: Update `rPeople()` to render a tag filter row and apply it**

Update the toolbar block within `rPeople()`. Replace the existing toolbar section with:

```js
  if(toolbar){
    if(!list.length){
      toolbar.innerHTML='';
    } else {
      const sort=S.peopleSettings?.defaultSort||'promise';
      const sortOpts=[
        ['promise','Promise date ↑'],
        ['level','Level ↓'],
        ['lastSeen','Last seen ↑'],
        ['name','Name A–Z'],
        ['recent','Recently added']
      ];
      const tags=S.peopleTags||[];
      const activeTag=UI.peopleFilterTag;
      const tagRow=tags.length?`<div class="people-tag-row">
        <button class="people-tag-chip${!activeTag?' on':''}" data-filter-tag="">All</button>
        ${tags.map(t=>`<button class="people-tag-chip pm-tag-${esc(t.color)}${activeTag===t.id?' on':''}" data-filter-tag="${t.id}">${esc(t.name)}</button>`).join('')}
      </div>`:'';
      toolbar.innerHTML=tagRow+`<div class="people-sort-row">${sortOpts.map(([k,lbl])=>`<button class="people-sort-chip${sort===k?' on':''}" data-sort="${k}">${esc(lbl)}</button>`).join('')}</div>`;
      toolbar.onclick=e=>{
        const s=e.target.dataset.sort;
        if(s){
          S.peopleSettings=S.peopleSettings||{};
          S.peopleSettings.defaultSort=s;
          svAll();rPeople();return;
        }
        const tgt=e.target.dataset.filterTag;
        if(tgt!==undefined){
          UI.peopleFilterTag=tgt||null;
          rPeople();return;
        }
      };
    }
  }
```

- [ ] **Step 3: Apply the filter before rendering cards**

In `rPeople()`, replace:

```js
  grid.className='people-grid';
  const sorted=_peopleSort(list);
```

With:

```js
  grid.className='people-grid';
  const filtered=UI.peopleFilterTag?list.filter(p=>(p.tagIds||[]).includes(UI.peopleFilterTag)):list;
  if(!filtered.length){
    grid.innerHTML=`<div class="no-t" style="grid-column:1/-1">No people match this filter.</div>`;
    return;
  }
  const sorted=_peopleSort(filtered);
```

- [ ] **Step 4: Add CSS for filter chips**

```css
.people-tag-row{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.people-tag-chip{font-size:10.5px;padding:4px 9px;border-radius:5px;border:1px solid var(--border);background:var(--surface);color:var(--text-2);cursor:pointer;font-family:inherit;font-weight:500}
.people-tag-chip.on{outline:2px solid var(--gold);outline-offset:-2px}
.people-tag-chip.pm-tag-blue.on,.people-tag-chip.pm-tag-green.on,.people-tag-chip.pm-tag-pink.on,.people-tag-chip.pm-tag-gold.on,.people-tag-chip.pm-tag-lavender.on,.people-tag-chip.pm-tag-sage.on,.people-tag-chip.pm-tag-peach.on,.people-tag-chip.pm-tag-red.on{outline:2px solid var(--text);outline-offset:-2px}
```

- [ ] **Step 5: Manual verification**

1. With multiple tags created from Task 7 and people tagged with various combos, verify the tag filter row appears above the sort chips.
2. Click a tag — grid shows only people with that tag. The active chip gets a visual outline.
3. Click "All" — full grid returns.
4. Click the same active tag again — should toggle off (UI.peopleFilterTag=null) since `tgt||null` is `null` for empty string but `t.id||null` re-clicks the same id. Actually re-clicking the active tag does NOT toggle off in this implementation — instead the user clicks "All". This is per-spec.
5. Filter to a tag that no one has — empty-state message "No people match this filter." renders.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(people): tag filter chips above grid"
```

---

## Task 9: Friendship level widget (display, arrows, picker)

**Files:**
- Modify: `index.html` (extend `renderPersonModalBody` + handlers)

- [ ] **Step 1: Add the level widget HTML to `renderPersonModalBody`**

Insert this section between the Tags section and the Notes section:

```js
    <div class="pm-section">
      <div class="pm-sec-lbl">Friendship level</div>
      ${_peopleLevelWidget(p)}
    </div>
```

- [ ] **Step 2: Add the `_peopleLevelWidget` function**

Place near other people helpers:

```js
function _peopleLevelWidget(p){
  const M=(p.level?.major)||1;
  const m=(p.level?.minor)||1;
  const names=S.peopleLevelNames||['Acquaintance','Casual friend','Friend','Close friend','Inner circle'];
  const upDisabled=M===5&&m===5;
  const downDisabled=M===1&&m===1;
  // 25-slot bar
  let bar='';
  for(let lv=1;lv<=5;lv++){
    let block='';
    for(let s=1;s<=5;s++){
      const fill=(lv<M)?'below':(lv===M&&s<=m)?'on':'';
      block+=`<div class="pm-lvl-slot ${fill}"></div>`;
    }
    bar+=`<div class="pm-lvl-block">${block}</div>`;
  }
  // Picker pills
  const picker=names.map((n,i)=>{
    const cur=(i+1)===M;
    return `<button class="pm-lvl-pick${cur?' cur':''}" data-pm-lvl-jump="${i+1}"><span class="pm-lvl-pick-n">L${i+1}</span><span class="pm-lvl-pick-name">${esc(n)}</span></button>`;
  }).join('');
  return `
    <div class="pm-lvl-widget">
      <div class="pm-lvl-top">
        <div class="pm-lvl-label">L${M}.${m} <span class="pm-lvl-name">· ${esc(names[M-1])} (${m}/5)</span></div>
        <div class="pm-lvl-arrows">
          <button data-pm-action="lvl-down" ${downDisabled?'disabled':''}>▼</button>
          <button data-pm-action="lvl-up" ${upDisabled?'disabled':''}>▲</button>
        </div>
      </div>
      <div class="pm-lvl-bar">${bar}</div>
      <div class="pm-lvl-axis"><span>L1</span><span>L2</span><span>L3</span><span>L4</span><span>L5</span></div>
      <div class="pm-lvl-picker">${picker}</div>
    </div>`;
}
```

- [ ] **Step 3: Wire up the level actions in `attachPersonModalHandlers`**

Inside the existing `body.onclick = e => { ... }`, add these branches:

```js
    if(a==='lvl-up'){
      const M=p.level?.major||1, m=p.level?.minor||1;
      if(M===5&&m===5)return;
      if(m<5)p.level={major:M,minor:m+1};
      else p.level={major:M+1,minor:1};
      svAll();rPeople();renderPersonModalBody(p);return;
    }
    if(a==='lvl-down'){
      const M=p.level?.major||1, m=p.level?.minor||1;
      if(M===1&&m===1)return;
      if(m>1)p.level={major:M,minor:m-1};
      else p.level={major:M-1,minor:5};
      svAll();rPeople();renderPersonModalBody(p);return;
    }
    const jump=parseInt(e.target.closest('[data-pm-lvl-jump]')?.dataset.pmLvlJump||'');
    if(!isNaN(jump)&&jump>=1&&jump<=5){
      p.level={major:jump,minor:3};
      svAll();rPeople();renderPersonModalBody(p);return;
    }
```

- [ ] **Step 4: Add CSS for the level widget**

```css
.pm-lvl-widget{background:var(--surface-2);border-radius:8px;padding:10px 12px;margin-top:4px}
.pm-lvl-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.pm-lvl-label{font-size:13px;font-weight:700;color:var(--text)}
.pm-lvl-name{font-size:11px;color:var(--muted);font-weight:500;margin-left:4px}
.pm-lvl-arrows{display:flex;gap:4px}
.pm-lvl-arrows button{width:24px;height:22px;border:1px solid var(--gold);background:var(--surface);color:var(--gold);border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit}
.pm-lvl-arrows button:disabled{opacity:.35;cursor:default}
.pm-lvl-bar{display:flex;gap:3px;margin-bottom:3px}
.pm-lvl-block{display:flex;gap:1px;flex:1}
.pm-lvl-slot{flex:1;height:9px;background:var(--border);border-radius:1px}
.pm-lvl-slot.below{background:var(--gold-bg)}
.pm-lvl-slot.on{background:var(--gold)}
.pm-lvl-axis{display:flex;justify-content:space-between;font-size:8px;color:var(--muted);font-weight:600;margin-bottom:8px;padding:0 2px}
.pm-lvl-picker{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.pm-lvl-pick{background:var(--surface);border:1px solid var(--border);padding:5px 8px;border-radius:5px;cursor:pointer;font-size:11px;font-family:inherit;display:flex;justify-content:space-between;align-items:center;gap:6px;color:var(--text)}
.pm-lvl-pick:hover{border-color:var(--gold)}
.pm-lvl-pick.cur{background:var(--gold-bg);border-color:var(--gold);color:var(--text)}
.pm-lvl-pick-n{font-weight:700}
.pm-lvl-pick-name{color:var(--muted);font-size:10px}
```

- [ ] **Step 5: Manual verification**

1. Open a person's detail modal. The level widget renders with "L1.1 · Acquaintance (1/5)".
2. Click ▲. Becomes L1.2. Click ▲ 3 more times. Becomes L1.5.
3. Click ▲ once more. Becomes L2.1 (crossed level boundary).
4. Click ▼ once. Back to L1.5.
5. Click ▼ at L1.1 — arrow is disabled.
6. Click the "L4 · Close friend" picker pill. Jumps to L4.3 (middle).
7. Verify the 25-slot bar fills correctly at each position. At L4.3: levels 1-3 are dim gold, level 4 slots 1-3 are full gold, level 4 slots 4-5 and level 5 are empty.
8. The card on the grid shows the level badge updated to "L4.3".

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(people): friendship level widget — 25-slot bar, arrows, picker"
```

---

## Task 10: Promises list — add, edit, delete (NO task linking yet)

**Files:**
- Modify: `index.html` (extend `renderPersonModalBody` + handlers)

- [ ] **Step 1: Add the Promises section to `renderPersonModalBody`**

Insert this section after the Friendship level section:

```js
    <div class="pm-section">
      <div class="pm-sec-lbl"><span>Promises / things said</span><span style="font-size:10px;color:var(--muted);font-weight:500;text-transform:none">${(p.promises||[]).length} active</span></div>
      <div class="pm-promises">
        ${(p.promises||[]).map((pr,i)=>_peoplePromiseRow(pr,i)).join('')}
      </div>
      <button class="pm-add-promise" data-pm-action="add-promise">+ Add another promise</button>
    </div>

    <div class="pm-section" id="pm-last-section">
      ${p.lastTogether?`<div class="pm-sec-lbl">Last did together</div><div class="pm-last-box">🍻 ${esc(p.lastTogether.text||'')} — <span class="pm-last-when">${_peoplePastWhen(p.lastTogether.doneAt)}</span></div><button class="btn btn-ghost btn-sm" data-pm-action="forget-last" style="font-size:10.5px;margin-top:4px;color:var(--muted)">Forget this</button>`:''}
    </div>
```

- [ ] **Step 2: Add the row helper + a "when" helper**

```js
function _peoplePromiseRow(pr,i){
  return `<div class="pm-promise-row" data-pi="${i}">
    <div class="pm-promise-text">🤝 <span class="pm-promise-label">${esc(pr.text||'')}</span>${pr.date?`<span class="pm-promise-date">· ${esc(pr.date)}</span>`:''}</div>
    <div class="pm-promise-ctrls">
      <button class="pm-icon-btn" data-pm-action="edit-promise" data-pi="${i}" title="Edit">✎</button>
      <button class="pm-icon-btn" data-pm-action="delete-promise" data-pi="${i}" title="Delete">🗑</button>
    </div>
  </div>`;
}
function _peoplePastWhen(iso){
  if(!iso)return '';
  const today=new Date();today.setHours(0,0,0,0);
  const [y,m,d]=iso.split('-').map(Number);
  const then=new Date(y,m-1,d);then.setHours(0,0,0,0);
  const days=Math.round((today-then)/86400000);
  if(days===0)return 'today';
  if(days===1)return 'yesterday';
  if(days<7)return `${days} days ago`;
  if(days<30)return `${Math.round(days/7)} week${Math.round(days/7)===1?'':'s'} ago`;
  if(days<365)return `${Math.round(days/30)} month${Math.round(days/30)===1?'':'s'} ago`;
  return `${Math.round(days/365)} year${Math.round(days/365)===1?'':'s'} ago`;
}
```

- [ ] **Step 3: Wire promise actions into `attachPersonModalHandlers`**

Add these branches inside the `body.onclick` handler:

```js
    if(a==='add-promise'){
      const text=prompt('What did you promise?');
      if(!text||!text.trim())return;
      const date=prompt('Optional date (YYYY-MM-DD, leave blank for none):','');
      const newP={id:uid(),text:text.trim(),addedAt:tod()};
      if(date&&/^\d{4}-\d{2}-\d{2}$/.test(date.trim()))newP.date=date.trim();
      p.promises=p.promises||[];p.promises.push(newP);
      svAll();rPeople();renderPersonModalBody(p);return;
    }
    if(a==='edit-promise'){
      const i=parseInt(e.target.dataset.pi);
      const pr=p.promises[i];if(!pr)return;
      const text=prompt('Edit promise:',pr.text||'');
      if(text===null)return;
      pr.text=text.trim();
      const date=prompt('Edit date (YYYY-MM-DD or blank to clear):',pr.date||'');
      if(date===null){/* keep existing */}
      else if(date.trim()==='')delete pr.date;
      else if(/^\d{4}-\d{2}-\d{2}$/.test(date.trim()))pr.date=date.trim();
      svAll();rPeople();renderPersonModalBody(p);return;
    }
    if(a==='delete-promise'){
      const i=parseInt(e.target.dataset.pi);
      const pr=p.promises[i];if(!pr)return;
      if(!confirm(`Delete this promise? "${pr.text}"`))return;
      // Task-link cascade lands in Task 11. For now just remove the promise.
      p.promises.splice(i,1);
      svAll();rPeople();renderPersonModalBody(p);return;
    }
    if(a==='forget-last'){
      if(!confirm('Forget the last thing you did together?'))return;
      p.lastTogether=null;
      svAll();rPeople();renderPersonModalBody(p);return;
    }
```

- [ ] **Step 4: Add CSS for promise rows + last-together box**

```css
.pm-promises{display:flex;flex-direction:column;gap:4px;margin-bottom:6px}
.pm-promise-row{display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--surface-2);border-left:3px solid var(--sage,#7fa186);padding:6px 9px;border-radius:5px;font-size:12px}
.pm-promise-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.pm-promise-label{font-weight:500}
.pm-promise-date{font-size:10.5px;color:var(--muted);margin-left:4px}
.pm-promise-ctrls{display:flex;gap:3px;flex-shrink:0}
.pm-icon-btn{background:transparent;border:none;font-size:11px;color:var(--muted);cursor:pointer;padding:2px 5px;border-radius:3px}
.pm-icon-btn:hover{background:var(--surface);color:var(--text)}
.pm-add-promise{font-size:11px;color:var(--sage,#7fa186);background:transparent;border:1px dashed var(--sage,#7fa186);padding:6px 10px;border-radius:5px;cursor:pointer;width:100%;margin-top:3px;font-weight:600;font-family:inherit}
.pm-last-box{background:var(--surface-2);padding:7px 10px;border-radius:5px;font-size:11.5px;color:var(--text-2);font-style:italic}
.pm-last-when{font-style:normal;color:var(--muted);font-size:10.5px}
```

- [ ] **Step 5: Manual verification**

1. Open a person's detail modal. Click "+ Add another promise". Prompt: "Go for coffee". Skip the date. Promise appears in the list.
2. Add 2 more promises. Verify card shows the first plus "+ 2 more promises".
3. Click ✎ on a promise. Edit text. Promise updates.
4. Click ✎ again, in the date prompt type "2026-06-01". Promise now shows the date.
5. Click 🗑 on a promise. Confirm. Removed from list. Card count updates.
6. In the console: `S.people[0].lastTogether={text:'Coffee at Truth',doneAt:'2026-05-08'};svAll();rPeople();`. Re-open the modal. "Last did together" section shows. Click "Forget this". Section disappears.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(people): promise CRUD list + last-together display"
```

---

## Task 11: Promise → task linking (link/unlink, tick cascade, delete cascade)

**Files:**
- Modify: `index.html` (extend `_peoplePromiseRow`, handlers, hook into task tick path, find existing task tick code)

- [ ] **Step 1: Find the existing task tick handler**

Search anchor: `function toggleTask(` or `t.done=!t.done` or `function tickTask(`. Identify where a task's `done` flag is flipped. The function is typically named `toggleTask` or invoked from `onclick="toggleTask(id)"` in a checkbox handler. Capture the function name — call it `TOGGLE_FN` in your notes (will refer to it below as `toggleTask` for the example).

- [ ] **Step 2: Add the cascade helper**

Place near the other people helpers:

```js
// Called when a linked task is ticked. Finds the person + promise via the
// task's back-link fields, moves the promise's text into lastTogether (the
// single "last did together" slot — no history per spec), and removes the
// promise from the person's list. Returns true if a link was found and
// processed, so the caller can also delete the task from S.tasks.
function _peopleHandleTaskTick(task){
  if(!task||!task.linkedPersonId||!task.linkedPromiseId)return false;
  const p=(S.people||[]).find(x=>x.id===task.linkedPersonId);
  if(!p)return false;
  const i=(p.promises||[]).findIndex(pr=>pr.id===task.linkedPromiseId);
  if(i<0)return false;
  const promise=p.promises[i];
  p.lastTogether={text:promise.text,doneAt:tod()};
  p.promises.splice(i,1);
  return true;
}
// Called when a linked task is deleted (without being ticked). Clears the
// linkedTaskId on the promise so the user can re-link it. Promise itself
// stays.
function _peopleHandleTaskDelete(task){
  if(!task||!task.linkedPersonId||!task.linkedPromiseId)return false;
  const p=(S.people||[]).find(x=>x.id===task.linkedPersonId);
  if(!p)return false;
  const promise=(p.promises||[]).find(pr=>pr.id===task.linkedPromiseId);
  if(!promise)return false;
  delete promise.linkedTaskId;
  return true;
}
```

- [ ] **Step 3: Hook into the existing task tick path**

In the task tick function (e.g., `toggleTask`), after the line that sets `t.done=true` (or the equivalent), add:

```js
  // If this task was linked to a person's promise, complete the promise
  // and delete the task entirely (no history — keeps Daily clean).
  if(t.done&&_peopleHandleTaskTick(t)){
    S.tasks=S.tasks.filter(x=>x.id!==t.id);
  }
```

Place this AFTER the existing `t.done = ...` flip but BEFORE any `svAll()` or `rTasks()` call so the deletion is included in the same save.

- [ ] **Step 4: Hook into the existing task delete path**

Find the task delete function (search anchor: `S.tasks=S.tasks.filter` or `function delTask` or similar). Before the filter, add:

```js
  const _delTask=S.tasks.find(x=>x.id===id);
  if(_delTask)_peopleHandleTaskDelete(_delTask);
```

(The variable name `id` here corresponds to the task ID parameter of whatever function is doing the delete. Adjust to match the local var.)

- [ ] **Step 5: Update `_peoplePromiseRow` to show a Link button or Linked badge**

Replace the function:

```js
function _peoplePromiseRow(pr,i){
  const linked=!!pr.linkedTaskId;
  return `<div class="pm-promise-row" data-pi="${i}">
    <div class="pm-promise-text">🤝 <span class="pm-promise-label">${esc(pr.text||'')}</span>${pr.date?`<span class="pm-promise-date">· ${esc(pr.date)}</span>`:''}</div>
    <div class="pm-promise-ctrls">
      ${linked?`<button class="pm-link-badge" data-pm-action="unlink-promise" data-pi="${i}" title="Unlink and delete the task">🔗 Linked</button>`:`<button class="pm-link-btn" data-pm-action="link-promise" data-pi="${i}" title="Create a task on Daily">→ Link</button>`}
      <button class="pm-icon-btn" data-pm-action="edit-promise" data-pi="${i}" title="Edit">✎</button>
      <button class="pm-icon-btn" data-pm-action="delete-promise" data-pi="${i}" title="Delete">🗑</button>
    </div>
  </div>`;
}
```

- [ ] **Step 6: Add the Link / Unlink handlers in `attachPersonModalHandlers`**

Add inside `body.onclick`:

```js
    if(a==='link-promise'){
      const i=parseInt(e.target.dataset.pi);
      const pr=p.promises[i];if(!pr)return;
      if(pr.linkedTaskId)return; // double-click guard
      const task={
        id:uid(),
        text:`${p.name}: ${pr.text}`,
        area:'personal',
        project:'gen',
        priority:'med',
        scheduledTime:'',
        daily:true,
        dailyDate:tod(),
        done:false,
        date:tod(),
        linkedPersonId:p.id,
        linkedPromiseId:pr.id
      };
      S.tasks=S.tasks||[];S.tasks.push(task);
      pr.linkedTaskId=task.id;
      svAll();rPeople();renderPersonModalBody(p);
      // Also re-render tasks if user is on Today view
      if(typeof rTasks==='function')rTasks();
      return;
    }
    if(a==='unlink-promise'){
      const i=parseInt(e.target.dataset.pi);
      const pr=p.promises[i];if(!pr||!pr.linkedTaskId)return;
      if(!confirm('Unlink this task? The task on Daily will be deleted.'))return;
      S.tasks=(S.tasks||[]).filter(x=>x.id!==pr.linkedTaskId);
      delete pr.linkedTaskId;
      svAll();rPeople();renderPersonModalBody(p);
      if(typeof rTasks==='function')rTasks();
      return;
    }
```

- [ ] **Step 7: Update the delete-promise handler to cascade**

Replace the existing `delete-promise` branch with:

```js
    if(a==='delete-promise'){
      const i=parseInt(e.target.dataset.pi);
      const pr=p.promises[i];if(!pr)return;
      const linkedNote=pr.linkedTaskId?' Any linked task will also be removed.':'';
      if(!confirm(`Delete this promise? "${pr.text}".${linkedNote}`))return;
      if(pr.linkedTaskId){
        S.tasks=(S.tasks||[]).filter(x=>x.id!==pr.linkedTaskId);
        if(typeof rTasks==='function')rTasks();
      }
      p.promises.splice(i,1);
      svAll();rPeople();renderPersonModalBody(p);return;
    }
```

- [ ] **Step 8: Update the person delete (Task 5 had a stub for this) to cascade linked tasks**

Find the existing `if(a==='delete')` branch (in `attachPersonModalHandlers`, the one that deletes the whole person). Replace with:

```js
    if(a==='delete'){
      const linkedCount=(p.promises||[]).filter(pr=>pr.linkedTaskId).length;
      const note=linkedCount?` This also deletes ${linkedCount} linked task${linkedCount===1?'':'s'}.`:'';
      if(!confirm(`Delete ${p.name}?${note} This cannot be undone.`))return;
      // Cascade: remove any tasks linked to this person's promises
      const taskIds=new Set((p.promises||[]).map(pr=>pr.linkedTaskId).filter(Boolean));
      if(taskIds.size){
        S.tasks=(S.tasks||[]).filter(x=>!taskIds.has(x.id));
        if(typeof rTasks==='function')rTasks();
      }
      S.people=(S.people||[]).filter(x=>x.id!==p.id);
      svAll();rPeople();
      document.getElementById('person-modal')?.remove();_syncBodyLock();return;
    }
```

- [ ] **Step 9: Add CSS for the new button states**

```css
.pm-link-btn{font-size:10.5px;background:transparent;border:1px solid var(--gold);color:var(--gold);padding:2px 7px;border-radius:4px;font-weight:600;cursor:pointer;font-family:inherit}
.pm-link-btn:hover{background:var(--gold-bg)}
.pm-link-badge{font-size:10.5px;background:var(--sage,#7fa186);color:#fff;padding:2px 7px;border-radius:4px;font-weight:600;cursor:pointer;border:none;font-family:inherit}
.pm-link-badge:hover{filter:brightness(.95)}
```

- [ ] **Step 10: Manual verification**

1. Open a person's detail modal. They have at least one promise. Click "→ Link" on that promise. Button changes to "🔗 Linked".
2. Navigate to Today / Daily tab. A new task appears in the Daily list: "[PersonName]: [promise text]".
3. Tick the task's checkbox. Task disappears from Daily. Re-open the person's detail modal — the promise is gone from the list, and a new "Last did together" section appears with the promise text + "today".
4. Add another promise, link it, then in Daily view manually delete the task (use whatever delete affordance exists — e.g. swipe / button). Re-open person modal: the promise still exists but the "🔗 Linked" badge is gone (replaced with "→ Link" again).
5. Add another promise, link it, then click "🔗 Linked" — confirm — both the linked task and the linked badge clear (promise stays).
6. Add a promise WITHOUT linking. Click 🗑. Confirm. Promise removed. No task involved.
7. Add 2 promises, link both. Click "Delete person" — confirmation should mention "This also deletes 2 linked tasks." Confirm. Both tasks gone from Daily.

- [ ] **Step 11: Commit**

```bash
git add index.html
git commit -m "feat(people): promise → task linking with tick/unlink/delete cascades"
```

---

## Task 12: Birthday from GCal (read-only + "+ Add birthday" CTA)

**Files:**
- Modify: `index.html` (`renderPersonModalBody` to include birthday row, helpers)

- [ ] **Step 1: Add a birthday lookup helper**

Place near other people helpers:

```js
// Find a Google Calendar event whose title looks like a birthday for this
// person. Uses the existing isBirthdayEv() helper + the same regex used
// in the morning brief flow. Returns {date, eventTitle} or null.
function _peopleFindBirthday(person){
  if(!person.name)return null;
  const pool=(gcCache.events||[]).filter(e=>isBirthdayEv(e));
  if(!pool.length)return null;
  const needle=person.name.toLowerCase().trim();
  const firstWord=needle.split(/\s+/)[0];
  for(const e of pool){
    const m=(e.title||'').match(/^(.+?)(?:'s)?\s*(?:birthday|bday)\b/i);
    if(!m)continue;
    const bdayName=m[1].toLowerCase().trim();
    if(bdayName===needle||bdayName===firstWord||needle.startsWith(bdayName)){
      return {date:e.date,eventTitle:e.title};
    }
  }
  return null;
}
function _peopleFmtBirthday(iso){
  if(!iso)return '';
  const [y,m,d]=iso.split('-').map(Number);
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m-1]} ${d}`;
}
```

- [ ] **Step 2: Update `renderPersonModalBody` to include the birthday row**

In the contact rows section (where Phone and Email are), add a third row for Birthday. Replace this:

```js
    <div class="pm-section">
      <div class="pm-row" data-field="phone">${p.phone?`<span class="pm-icon">📱</span> <span class="pm-val">${esc(p.phone)}</span>`:`<button class="pm-add" data-pm-edit="phone">+ Add phone</button>`}</div>
      <div class="pm-row" data-field="email">${p.email?`<span class="pm-icon">✉️</span> <span class="pm-val">${esc(p.email)}</span>`:`<button class="pm-add" data-pm-edit="email">+ Add email</button>`}</div>
    </div>
```

With:

```js
    <div class="pm-section">
      <div class="pm-row" data-field="phone">${p.phone?`<span class="pm-icon">📱</span> <span class="pm-val">${esc(p.phone)}</span>`:`<button class="pm-add" data-pm-edit="phone">+ Add phone</button>`}</div>
      <div class="pm-row" data-field="email">${p.email?`<span class="pm-icon">✉️</span> <span class="pm-val">${esc(p.email)}</span>`:`<button class="pm-add" data-pm-edit="email">+ Add email</button>`}</div>
      ${(() => {
        const bday=_peopleFindBirthday(p);
        if(bday){
          return `<div class="pm-row"><span class="pm-icon">🎂</span> <span class="pm-val pm-bday">${esc(_peopleFmtBirthday(bday.date))}</span> <span style="font-size:10px;color:var(--muted);margin-left:4px">from Google Calendar</span></div>`;
        }
        return `<div class="pm-row"><button class="pm-add" data-pm-action="add-bday">🎂 + Add birthday</button></div>`;
      })()}
    </div>
```

- [ ] **Step 3: Add the "+ Add birthday" handler**

Find the existing call to whatever opens the manual event-create modal. Common names: `openNewEvent`, `openEventModal({date,...})`. Search anchor: `openNewEvent(` to confirm.

Inside `attachPersonModalHandlers`, add:

```js
    if(a==='add-bday'){
      // Reuse the existing event create modal with birthday-shaped defaults
      const opts={
        title:`${p.name}'s birthday`,
        date:tod(),
        allDay:true,
        repeat:'yearly',
        reminderMin:(S.calendarDefaults?.birthdayReminders)||[1440,0]
      };
      if(typeof openNewEvent==='function')openNewEvent(opts);
      else alert('Birthday creation needs the calendar modal. Open the Calendar tab and add a yearly all-day event titled "'+p.name+'\'s birthday".');
      return;
    }
```

(If `openNewEvent` doesn't accept all those keys, the implementer may need to adapt — but check the signature first; v150's calendar modal already accepts these.)

- [ ] **Step 4: Add CSS for the birthday pill**

```css
.pm-bday{background:var(--pink-bg);color:var(--pink);padding:2px 8px;border-radius:5px;font-size:11.5px;font-weight:600}
```

- [ ] **Step 5: Manual verification**

1. Add a birthday to your own Google Calendar named "Test Person's birthday" — all-day, yearly recurrence (or use an existing birthday event for someone you've added).
2. Open the Calendar tab to populate `gcCache.events` (this is necessary because `_peopleFindBirthday` reads the cache).
3. Open the People tab. Open "Test Person" detail modal. The 🎂 row should show "Jul 15 — from Google Calendar" (or whatever date is on the event).
4. For a person with no matching GCal birthday: the row shows "🎂 + Add birthday". Click it. The calendar event-create modal opens prefilled with their name + yearly. Save it. Re-open the person modal — birthday row should now show the date.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(people): birthday read from GCal + Add birthday opens calendar modal"
```

---

## Task 13: Settings → People panel (tags + level names + default sort)

**Files:**
- Modify: `index.html` (extend the settings render function `rSettings`)

- [ ] **Step 1: Find `rSettings()` and add a new People section**

Find the `rSettings()` function (search anchor: `function rSettings(`). Identify where it composes HTML for existing settings sub-sections (Habits, Calendar, AI, etc.) and add a new section after the most-similar one (probably between Habits and AI). The exact section header pattern in this codebase is something like:

```js
  html += `<div class="setting-group"><div class="setting-group-title">People</div> ... </div>`;
```

Inspect the existing pattern and mirror it. The People section content:

```js
  // PEOPLE settings
  const tags=S.peopleTags||[];
  const levelNames=S.peopleLevelNames||['Acquaintance','Casual friend','Friend','Close friend','Inner circle'];
  const defaultSort=S.peopleSettings?.defaultSort||'promise';
  html += `
    <div class="setting-group">
      <div class="setting-group-title">People</div>
      <div class="setting-row">
        <div class="setting-label">Tags</div>
        <div class="setting-desc">Used to group people on the People tab.</div>
        <div class="people-settings-tags">
          ${tags.length?tags.map(t=>{
            const count=(S.people||[]).filter(p=>(p.tagIds||[]).includes(t.id)).length;
            return `<div class="ps-tag-row"><span class="pm-tag pm-tag-${esc(t.color)}">${esc(t.name)}</span><span class="ps-tag-count">${count} ${count===1?'person':'people'}</span><button class="pm-icon-btn" data-ps-action="rename-tag" data-tid="${t.id}" title="Rename">✎</button><button class="pm-icon-btn" data-ps-action="recolor-tag" data-tid="${t.id}" title="Recolor">🎨</button><button class="pm-icon-btn" data-ps-action="delete-tag" data-tid="${t.id}" title="Delete">🗑</button></div>`;
          }).join(''):'<div class="ps-empty">No tags yet.</div>'}
          <button class="pm-add-promise" data-ps-action="add-tag" style="border-color:var(--gold);color:var(--gold)">+ Add tag</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">Level names</div>
        <div class="setting-desc">Rename the 5 friendship levels (L1-L5).</div>
        <div class="people-settings-levels">
          ${levelNames.map((n,i)=>`<div class="ps-level-row"><span class="ps-level-n">L${i+1}</span><span class="ps-level-name">${esc(n)}</span><button class="pm-icon-btn" data-ps-action="rename-level" data-li="${i}">✎</button></div>`).join('')}
          <button class="pm-add-promise" data-ps-action="reset-levels" style="border-color:var(--muted);color:var(--muted)">Reset to defaults</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">Default sort</div>
        <div class="setting-desc">Which order people are listed in by default.</div>
        <select data-ps-action="set-sort">
          <option value="promise" ${defaultSort==='promise'?'selected':''}>Promise date ↑</option>
          <option value="level" ${defaultSort==='level'?'selected':''}>Level ↓</option>
          <option value="lastSeen" ${defaultSort==='lastSeen'?'selected':''}>Last seen ↑</option>
          <option value="name" ${defaultSort==='name'?'selected':''}>Name A–Z</option>
          <option value="recent" ${defaultSort==='recent'?'selected':''}>Recently added</option>
        </select>
      </div>
    </div>
  `;
```

- [ ] **Step 2: Attach People settings handlers**

At the end of `rSettings()` (after the innerHTML is set), bind click + change handlers for the new section. Find a logical place to add this — usually the function ends with some `setTimeout(()=>{...handlers...})` block. Add:

```js
  // People settings handlers
  const root=document.querySelector('.route[data-route="settings"]');
  if(root){
    root.addEventListener('click',e=>{
      const a=e.target.dataset?.psAction;
      if(!a)return;
      if(a==='add-tag'){
        const name=prompt('Tag name:');
        if(!name||!name.trim())return;
        _peopleCreateTag(name);
        svAll();rSettings();
        return;
      }
      if(a==='rename-tag'){
        const tid=e.target.dataset.tid;
        const t=_peopleTagById(tid);if(!t)return;
        const name=prompt('Rename tag:',t.name);
        if(name===null||!name.trim())return;
        t.name=name.trim();svAll();rSettings();rPeople();return;
      }
      if(a==='recolor-tag'){
        const tid=e.target.dataset.tid;
        const t=_peopleTagById(tid);if(!t)return;
        const c=prompt(`Pick a color: ${PEOPLE_TAG_COLORS.join(', ')}`,t.color);
        if(!c||!PEOPLE_TAG_COLORS.includes(c.trim()))return;
        t.color=c.trim();svAll();rSettings();rPeople();return;
      }
      if(a==='delete-tag'){
        const tid=e.target.dataset.tid;
        const t=_peopleTagById(tid);if(!t)return;
        const using=(S.people||[]).filter(p=>(p.tagIds||[]).includes(tid)).length;
        if(!confirm(`Delete tag "${t.name}"?${using?` ${using} people will lose this tag.`:''}`))return;
        S.peopleTags=(S.peopleTags||[]).filter(x=>x.id!==tid);
        (S.people||[]).forEach(p=>{if(p.tagIds)p.tagIds=p.tagIds.filter(x=>x!==tid);});
        // Clear the filter if it was set to this tag
        if(UI.peopleFilterTag===tid)UI.peopleFilterTag=null;
        svAll();rSettings();rPeople();return;
      }
      if(a==='rename-level'){
        const li=parseInt(e.target.dataset.li);
        const cur=(S.peopleLevelNames||[])[li]||'';
        const name=prompt(`Rename Level ${li+1}:`,cur);
        if(name===null||!name.trim())return;
        S.peopleLevelNames=Array.isArray(S.peopleLevelNames)?S.peopleLevelNames:['Acquaintance','Casual friend','Friend','Close friend','Inner circle'];
        S.peopleLevelNames[li]=name.trim();
        svAll();rSettings();rPeople();return;
      }
      if(a==='reset-levels'){
        if(!confirm('Reset all level names to defaults?'))return;
        S.peopleLevelNames=['Acquaintance','Casual friend','Friend','Close friend','Inner circle'];
        svAll();rSettings();rPeople();return;
      }
    });
    root.addEventListener('change',e=>{
      if(e.target.dataset?.psAction==='set-sort'){
        S.peopleSettings=S.peopleSettings||{};
        S.peopleSettings.defaultSort=e.target.value;
        svAll();rPeople();
      }
    });
  }
```

NOTE: Be careful not to add the listener twice on every rSettings() call. The cleanest approach is to ensure the listener is bound only once. If `rSettings()` is re-rendered, use `root.onclick = ...` and `root.onchange = ...` instead of `addEventListener` to avoid stacking. Use this pattern instead:

```js
  // People settings handlers — use onclick/onchange to replace prior handler
  const root=document.querySelector('.route[data-route="settings"]');
  if(root){
    root._psClick=e=>{ /* … same body as above */ };
    root.addEventListener('click',root._psClick); // bind once
  }
```

Actually, since `rSettings()` may rerun, simplest is to delegate from `document.body` once at app boot, OR to scope the handler with a `[data-ps-handler-bound]` attribute check. Implementer's choice. The safest pattern: check for an attribute marker at the root:

```js
  const root=document.querySelector('.route[data-route="settings"]');
  if(root&&!root.dataset.psHandlersBound){
    root.dataset.psHandlersBound='1';
    root.addEventListener('click',e=>{ /* same body */ });
    root.addEventListener('change',e=>{ /* same body */ });
  }
```

- [ ] **Step 3: Add CSS for the people-settings rows**

```css
.people-settings-tags,.people-settings-levels{display:flex;flex-direction:column;gap:5px}
.ps-tag-row,.ps-level-row{display:flex;align-items:center;gap:8px;padding:6px 9px;background:var(--surface-2);border-radius:5px;font-size:12px}
.ps-tag-count{font-size:10.5px;color:var(--muted);margin-left:auto}
.ps-level-n{font-size:11px;font-weight:700;color:var(--gold);min-width:24px}
.ps-level-name{flex:1}
.ps-empty{font-size:11px;color:var(--muted);font-style:italic;padding:4px 6px}
```

- [ ] **Step 4: Manual verification**

1. Open Settings. Scroll to the People section. Verify three sub-sections: Tags, Level names, Default sort.
2. Click "+ Add tag" → name "Test tag" → it appears in the Tags list with a color.
3. Click ✎ on Test tag → rename → confirmed.
4. Click 🎨 → enter "green" → tag color changes.
5. Click 🗑 → if no one uses it, simple confirm; if someone uses it, the confirmation mentions count. Confirm → tag gone everywhere.
6. Click ✎ on L3 → rename to "Buddies" → name updates here AND in the level picker on a person modal.
7. Click "Reset to defaults" → all 5 names back to defaults.
8. Change "Default sort" → switch to People tab → sort chips reflect the new default.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(people): Settings panel — tags, level names, default sort"
```

---

## Task 14: AI `addPerson` op

**Files:**
- Modify: `index.html` (AI prompt schema, applyChanges, AIC machinery, formatAIChangesDetailed)

- [ ] **Step 1: Extend the AI prompt schema**

Find the schema JSON in the prompt (search anchor: `"addReminders":[{"text":"...`). Add `addPerson` to the schema. Insert just after `addReminders`:

```
,"addPerson":[{"name":"...","metAt":"optional where you met","phone":"optional","email":"optional","notes":"optional","tags":["optional tag names"],"level":{"major":1-5,"minor":1-5}}]
```

- [ ] **Step 2: Add guidance to the prompt**

Find the section "REMINDERS vs TASKS vs EVENTS" and add a new paragraph just below it:

```
PEOPLE — when the user mentions a NEW person they want to remember (not someone already in state.people), use addPerson. Required: name. Everything else is optional. Tags are referenced by name; unknown tag names auto-create. level defaults to {major:1,minor:1}. Don't infer a level unless the user is explicit ("she's a close friend" → {major:4,minor:3}).
```

- [ ] **Step 3: Add `applyChanges` handler for `addPerson`**

Find the existing `if(ch.addReminders?.length)` block in `applyChanges`. Add this immediately after it:

```js
  // AI-proposed new people. Validate the shape, auto-create any unknown
  // tags by name, then push to S.people.
  if(ch.addPerson?.length)ch.addPerson.forEach(pp=>{
    if(!pp||!pp.name||!String(pp.name).trim())return;
    const tagIds=[];
    if(Array.isArray(pp.tags)){
      pp.tags.forEach(tn=>{
        const norm=String(tn||'').trim().toLowerCase();
        if(!norm)return;
        let tag=(S.peopleTags||[]).find(t=>(t.name||'').toLowerCase()===norm);
        if(!tag)tag=_peopleCreateTag(String(tn).trim());
        if(!tagIds.includes(tag.id))tagIds.push(tag.id);
      });
    }
    const level=pp.level&&typeof pp.level==='object'?{
      major:Math.max(1,Math.min(5,Number(pp.level.major)||1)),
      minor:Math.max(1,Math.min(5,Number(pp.level.minor)||1))
    }:{major:1,minor:1};
    const newP={
      id:uid(),
      name:String(pp.name).trim(),
      metAt:String(pp.metAt||'').trim(),
      phone:String(pp.phone||'').trim(),
      email:String(pp.email||'').trim(),
      notes:String(pp.notes||'').trim(),
      level,
      tagIds,
      promises:[],
      lastTogether:null,
      createdAt:tod()
    };
    S.people=S.people||[];S.people.push(newP);
  });
```

- [ ] **Step 4: Add to `formatAIChangesDetailed`**

Find the REMINDERS section in `formatAIChangesDetailed` (search anchor: `(ch.addReminders||[]).forEach`). Add a new section right after it:

```js
  // PEOPLE — surface so the confirm gate fires for people-only changes.
  const peopleLines=[];
  (ch.addPerson||[]).forEach(pp=>{
    const bits=[];
    if(pp.metAt)bits.push('met at '+pp.metAt);
    if(Array.isArray(pp.tags)&&pp.tags.length)bits.push('tags: '+pp.tags.join(', '));
    peopleLines.push(`  • Add person "${pp.name||'(untitled)'}"${bits.length?' — '+bits.join(', '):''}`);
  });
  if(peopleLines.length)sections.push('PEOPLE\n'+peopleLines.join('\n'));
```

- [ ] **Step 5: Add `addPerson` to AIC_TYPES, AIC_DEFAULTS, AIC_CANONICAL_TEXT, _aicSummary, build-section**

Find `addReminders:{icon:'⏰',label:'Reminder'}` in `AIC_TYPES` and add right after:

```js
  addPerson:{icon:'👤',label:'Person'},
```

Find `addReminders:t=>({...})` in `AIC_DEFAULTS` and add right after:

```js
  addPerson:t=>({name:t,metAt:'',phone:'',email:'',notes:'',tags:[],level:{major:1,minor:1}}),
```

Find `addReminders:r=>r.text||''` in `AIC_CANONICAL_TEXT` and add right after:

```js
  addPerson:p=>p.name||'',
```

Find the `case 'addReminders':` in `_aicSummary` and add a new case:

```js
    case 'addPerson':{
      title=`Add person "${esc(item.name||'(untitled)')}"`;
      if(item.metAt)meta.push('met at '+esc(item.metAt));
      if(Array.isArray(item.tags)&&item.tags.length)meta.push('tags: '+esc(item.tags.join(', ')));
      if(item.level)meta.push(`L${item.level.major||1}.${item.level.minor||1}`);
      break;
    }
```

Find the `remKeys=['addReminders']` block and add a new buildSection for people. Look for `buildSection('Reminders',remKeys);` and add right after:

```js
  const peopleKeys=['addPerson'];
  buildSection('People',peopleKeys);
```

Find the editor form builder switch (search anchor: `case 'addReminders':{` in `_aicBuildForm`). Add a new case:

```js
    case 'addPerson':{
      return `
        <div class="aic-edit-field"><label>Name</label><input data-f="name" value="${v(it.name)}"></div>
        <div class="aic-edit-field"><label>Where you met</label><input data-f="metAt" value="${v(it.metAt)}" placeholder="Optional"></div>
        <div class="aic-edit-row">
          <div class="aic-edit-field"><label>Phone</label><input data-f="phone" value="${v(it.phone)}" placeholder="Optional"></div>
          <div class="aic-edit-field"><label>Email</label><input data-f="email" value="${v(it.email)}" placeholder="Optional"></div>
        </div>
        <div class="aic-edit-field"><label>Tags (comma-separated)</label><input data-f="tags" value="${v(Array.isArray(it.tags)?it.tags.join(', '):'')}" placeholder="e.g. Uni, Family friend"></div>
        <div class="aic-edit-field"><label>Notes</label><textarea data-f="notes" rows="3" placeholder="Optional">${v(it.notes)}</textarea></div>`;
    }
```

Find the reader switch (search anchor: `case 'addReminders':{` in `_aicReadForm`). Add a new case:

```js
    case 'addPerson':{
      const tagsRaw=trim(get('tags'));
      const tags=tagsRaw?tagsRaw.split(',').map(s=>s.trim()).filter(Boolean):[];
      return {...orig,name:trim(get('name')),metAt:trim(get('metAt')),phone:trim(get('phone')),email:trim(get('email')),notes:trim(get('notes')),tags};
    }
```

- [ ] **Step 6: Manual verification**

1. In the AI bar, type: "Add Jack Smith — met at uni, his number is 0825555555, tag him as Uni."
2. The confirm modal (if `aiConfirmMode === 'all'`) should pop with a PEOPLE section: "Add person 'Jack Smith' — met at uni, tags: Uni".
3. Click apply. Open People tab. Jack appears as a card with the right metAt, the Uni tag (auto-created), and L1.1.
4. Open Jack's modal — phone field shows 0825555555.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat(people): AI addPerson op with review queue + confirm gate"
```

---

## Task 15: AI `addPromise` op

**Files:**
- Modify: `index.html` (same machinery as Task 14)

- [ ] **Step 1: Extend the AI prompt schema**

In the schema JSON, after `addPerson`, add:

```
,"addPromise":[{"person":"partial name of an existing person","text":"what you said you'd do","date":"YYYY-MM-DD|optional"}]
```

- [ ] **Step 2: Extend the prompt guidance**

Add to the PEOPLE paragraph:

```
For addPromise: "person" is matched STRICTLY against state.people by name (exact, then startsWith). If the person doesn't exist, prefer addPerson first. The "text" is the action verb-phrase ("go for coffee", "play paddle"). Date is optional — use only when explicit.
```

- [ ] **Step 3: Add applyChanges handler**

Right after the `addPerson` handler:

```js
  if(ch.addPromise?.length)ch.addPromise.forEach(pr=>{
    if(!pr||!pr.text||!String(pr.text).trim())return;
    const p=_aiFindStrict(S.people,x=>x.name,pr.person);
    if(!p){console.warn('[ai-promise] no match for person',pr.person);return;}
    p.promises=p.promises||[];
    const newPr={id:uid(),text:String(pr.text).trim(),addedAt:tod()};
    if(pr.date&&/^\d{4}-\d{2}-\d{2}$/.test(String(pr.date).trim()))newPr.date=String(pr.date).trim();
    p.promises.push(newPr);
  });
```

- [ ] **Step 4: Add to `formatAIChangesDetailed`**

In the PEOPLE section block, add promise lines:

```js
  (ch.addPromise||[]).forEach(pr=>{
    peopleLines.push(`  • Promise on "${pr.person||'?'}": "${pr.text||''}"${pr.date?' on '+pr.date:''}`);
  });
```

- [ ] **Step 5: AIC machinery**

In `AIC_TYPES`, after `addPerson`:

```js
  addPromise:{icon:'🤝',label:'Promise'},
```

In `AIC_DEFAULTS`, after `addPerson`:

```js
  addPromise:t=>({person:'',text:t,date:''}),
```

In `AIC_CANONICAL_TEXT`, after `addPerson`:

```js
  addPromise:p=>p.text||'',
```

In `_aicSummary`, after `case 'addPerson'`:

```js
    case 'addPromise':{
      title=`Promise on "${esc(item.person||'?')}"`;
      meta.push(esc(item.text||''));
      if(item.date)meta.push('on '+esc(item.date));
      break;
    }
```

In `peopleKeys` array from Task 14, change:

```js
  const peopleKeys=['addPerson','addPromise'];
```

In `_aicBuildForm`, after `case 'addPerson':{...}`:

```js
    case 'addPromise':{
      return `
        <div class="aic-edit-field"><label>Person (existing name)</label><input data-f="person" value="${v(it.person)}" placeholder="Jack"></div>
        <div class="aic-edit-field"><label>Promise</label><input data-f="text" value="${v(it.text)}" placeholder="go for coffee"></div>
        <div class="aic-edit-field"><label>Date (YYYY-MM-DD, optional)</label><input data-f="date" value="${v(it.date)}" placeholder="2026-05-20"></div>`;
    }
```

In `_aicReadForm`:

```js
    case 'addPromise':{
      return {...orig,person:trim(get('person')),text:trim(get('text')),date:trim(get('date'))};
    }
```

- [ ] **Step 6: Manual verification**

1. With Jack already in the People tab, type in the AI bar: "Jack and I said we'd grab coffee next week."
2. Confirm modal: PEOPLE section should show "Promise on 'Jack': 'grab coffee'" (date optional based on AI's interpretation).
3. Apply. Open Jack's detail modal — new promise appears in the list.
4. Try with non-existent person: "Add a promise to Sebastian to play golf." → applyChanges silently drops it (per spec) with a console warn. Optionally, AI should `addPerson` first then `addPromise`.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat(people): AI addPromise op with strict person matching"
```

---

## Task 16: Polish + version bump + push

**Files:**
- Modify: `index.html` (APP_VERSION), `sw.js` (CACHE)

- [ ] **Step 1: Bump APP_VERSION**

Find `const APP_VERSION='v150';` and change to:

```js
const APP_VERSION='v151';
```

- [ ] **Step 2: Bump sw.js cache**

In `sw.js`, change `const CACHE = 'lifeos-v150';` to:

```js
const CACHE = 'lifeos-v151';
```

- [ ] **Step 3: Full-feature smoke test**

Open the app in a fresh browser tab. Go through this checklist:

1. People tab renders, empty-state visible
2. Add person → simple modal → save → detail modal opens
3. Fill phone, email, notes — all persist after reload
4. Pin the person → grid shows pin → unpin again
5. Bump level via arrows, then jump via picker — card badge updates
6. Add 3 promises — card shows top + count
7. Link one promise → task appears in Daily
8. Tick the task → task gone, promise gone, "Last did together" shown
9. Add a tag inline → card shows it
10. Create a 2nd tag in Settings → People → Tags
11. Filter the grid by tag — both tagged people show
12. Change sort order — persists across reload
13. AI bar: "Add Sarah, met at hiking, tag her as Outdoors" → review modal shows PEOPLE section → apply → card appears with auto-created Outdoors tag
14. AI bar: "Sarah and I said we'd hike Lion's Head on Saturday" → review modal shows promise → apply → Sarah's card shows the promise

If any step fails, fix it in a separate commit and re-verify.

- [ ] **Step 4: Commit + push**

```bash
git add index.html sw.js
git commit -m "v151: People tab — cards, promises, levels, tags, pin, AI hooks"
git push origin HEAD:main
```

- [ ] **Step 5: Post-deploy verification**

1. Wait ~30 seconds for Cloudflare Pages deploy
2. Open the production URL in a fresh tab — should auto-reload to v151
3. Verify the People tab is visible and working on the live site
4. Check on phone (mobile Safari / Chrome) — pin, drawer entry, card grid all working

---

## Out of scope for this plan (per spec)

- XP / auto-gamified leveling
- Photos
- Drag-to-reorder cards
- Promise history
- Birthday surface on Daily
- Per-person interaction timeline

## Self-review notes (for the implementer)

If you hit any of these symptoms mid-task, treat them as bugs to fix, not features to defer:

- **Save listener stacking** (Task 13): if you see Settings actions firing multiple times per click, the click handler is being bound on every `rSettings()` call. Use the `[data-ps-handlers-bound]` attribute guard pattern.
- **Stale modal data** (Tasks 5+): if the detail modal shows old data after a mutation, you forgot to call `renderPersonModalBody(p)` after `svAll()`.
- **Card not updating after detail edits** (Tasks 5+): same — call `rPeople()` after mutations.
- **AI ops bypass confirm modal** (Tasks 14-15): if applying an AI people-change skips the confirm modal even when `aiConfirmMode === 'all'`, you didn't add the new ops to `formatAIChangesDetailed`. The gate at the top of `applyChanges` checks that function's output.
- **`linkedTaskId` ghosts** (Task 11): if a promise shows "🔗 Linked" but the linked task doesn't exist, the cascade in `_peopleHandleTaskDelete` didn't fire. Verify the hook is in the right delete path.

End of plan.
