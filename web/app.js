/**
 * Life OS v2 — application shell.
 *
 * Talks ONLY to the Railway API. There is no Firestore code here at all.
 *
 * Shell architecture: the sidebar, right rail and composer render ONCE and are
 * never redrawn. A route change replaces `.main-scroll` and moves the nav
 * indicator — nothing else. That is what makes transitions continuous instead
 * of a full-page flash (design-system.md §11).
 */
import { ROUTES, PLACEHOLDERS, ALL_ROUTE_IDS } from './routes.js';
import { initServiceWorker } from './pwa.js';
import { flip, pulse, collapseOut, reducedMotion, afterTransition, settle } from './motion.js';
import { openUtilityMenu, openUtilitySurface, closeUtility,
  utilityTriggerHtml } from './utility-menu.js';
import {
  projectsHeaderHtml, projectsBodyHtml, applyGroups, projectsEmptyHtml,
  projectDetailHeaderHtml, projectDetailBodyHtml, progressText,
  nextActionSlotHtml, nextActionWhy,
  PROJECT_FILTERS, STATUS_LABEL, FOCUS_LABEL,
} from './projects.js';
import { openProjectModal, openChoiceDialog, openTaskPicker } from './project-modal.js';
import { openTaskModal } from './task-modal.js';
import {
  stepsChipHtml, stepsPanelHtml, wireSteps, repaintSteps, readyToFinish, stepCounts,
  currentStep, parentBlockedReason, orderedSteps,
} from './steps.js';
import {
  partition, isStandalone, arrangeStandalone, insertionIndex, orderChanged, localDate,
} from './arrange.js';
import { openHabitModal } from './habit-modal.js';
import { initStars } from './stars.js';
import { initDrag, isDragging } from './drag.js';
import { openEventModal, openAddMenu } from './event-modal.js';
import { initPlanDrag } from './plan-drag.js';
import { openReminderModal } from './reminder-modal.js';
import { openScheduleTaskModal } from './schedule-task-modal.js';
import { remindersViewHtml } from './reminders-view.js';
import { openDetailSheet } from './detail-sheet.js';
import { initHoverPreview, closeHoverPreview } from './hover-preview.js';
import { cal, currentRange, calendarHeaderHtml, calendarBodyHtml, calendarRailHtml,
  planHours, itemsForDay, hoverRender, freeWindowsFor, legendHtml, sourcesPopoverHtml,
  railIsOpen,
  recurrenceWords,
  iso, parseIso, monthGrid, weekOf } from './calendar.js';
import { habitSummaryHtml } from './calendar.js';
import { settingsHtml } from './settings.js';
import {
  initLibrary, renderLibrary, libraryHashChanged, libraryWillLeave,
} from './library-view.js';
import {
  initDiary, renderDiary, diaryHashChanged, diaryWillLeave,
} from './diary-view.js';

const CFG = window.LIFE_OS_CONFIG;
const BUCKETS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This Week' },
  { id: 'month', label: 'This Month' },
  { id: 'future', label: 'Future' },
];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'someday'];
const HISTORY_PAGE = 25;

const state = {
  me: null, prefs: {}, token: null,
  tasks: [], history: [], historyTotal: 0,
  route: 'today', areaFilter: null, menu: null, settingsTab: 'account',
  todayResume: null,   // scroll, filter and focused card, for the way back
  habits: [], habitsLoaded: false, habitsError: null,
  // id -> { id, title, status, focus, nextActionId }, sent with the task list so
  // Today can name a task's project without a second request or a copy of it
  // on every task row.
  projectsById: {},
};

/**
 * Projects state.
 *
 * `resume` is what makes Back honest: leaving the detail page has to restore
 * the filter, the scroll position and the row you came from, or the list you
 * return to is not the list you left.
 */
const pj = {
  filter: 'working',
  cameFromToday: false,   // Back should return to the board, not the overview
  data: null,        // the last successful overview payload — carries EVERY view
  detail: null,      // { project, tasks } when the detail page is open
  openId: null,
  resume: null,      // { filter, scrollTop, rowId }
  saveTimer: null,
};

const root = document.getElementById('root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── API ─────────────────────────────────────────────────────────────── */

/**
 * The signed-in Firebase user, kept so a token can be fetched ON DEMAND.
 *
 * The previous approach refreshed on a 45-minute `setInterval`. A Firebase ID
 * token lives 60 minutes, so that looks safe and is not: browsers throttle
 * background timers and Chrome freezes them outright in a hidden tab. Leave the
 * tab in the background — or shut the laptop — and the refresh never fires, the
 * token expires, and the next thing the user does fails with "Invalid or
 * expired sign-in token."
 *
 * `getIdToken()` already solves this: it returns the cached token and refreshes
 * only when it is expired or close to it. Asking it before each request costs
 * nothing and cannot drift.
 */
let authUser = null;
let devToken = null;

async function authToken(force = false) {
  if (devToken) return devToken;
  if (!authUser) return state.token;
  try {
    state.token = await authUser.getIdToken(force);
  } catch { /* keep whatever we had; the request will report the real failure */ }
  return state.token;
}

async function api(path, opts = {}) {
  const hasBody = opts.body !== undefined;
  const send = (token) => fetch(`${CFG.apiBaseUrl}${path}`, {
    ...opts,
    // Never let a service worker or the HTTP cache answer an API call. Task
    // data is private and must always come from the server.
    cache: 'no-store',
    headers: {
      // Only declare a JSON body when there is one — Fastify rejects an empty
      // body that claims to be JSON, which silently broke every action route.
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });

  let res = await send(await authToken());
  // One forced refresh and one retry. A token that expired while the tab was in
  // the background is not something the user did wrong, and it must not be
  // something they have to fix by reloading. Exactly one retry: if a fresh
  // token is also rejected the session is genuinely gone, and retrying again
  // would only delay saying so.
  if (res.status === 401 && (authUser || devToken)) {
    const fresh = await authToken(true);
    if (fresh) res = await send(fresh);
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Your sign-in has expired. Reload the page to sign in again.');
    }
    throw new Error(data?.error?.message || data?.message || `Request failed (${res.status})`);
  }
  return data;
}
const ws = () => state.me.workspace.id;

/**
 * Sample data for reviewing Projects — TEMPORARY.
 *
 * A console hook rather than a control in the interface: test data does not
 * belong in the product, and a button that seeds fake projects is a button that
 * eventually gets pressed by accident. The real guard is server-side — both
 * endpoints refuse outright when NODE_ENV is production — so this cannot do
 * anything on a deployment where it should not.
 *
 * Delete with api/src/lib/sample-projects.ts once E2 is reviewed.
 */
window.__sample = {
  add: async () => {
    const r = await api(`/api/v1/workspaces/${ws()}/projects/sample`, { method: 'POST' });
    if (state.route === 'projects') { pj.data = null; await loadProjects(); }
    return r;
  },
  remove: async () => {
    const r = await api(`/api/v1/workspaces/${ws()}/projects/sample/remove`, { method: 'POST' });
    if (state.route === 'projects') { pj.data = null; await loadProjects(); }
    return r;
  },
  check: () => api(`/api/v1/workspaces/${ws()}/projects/sample`),
};

/* ── Toast ───────────────────────────────────────────────────────────── */
let toastTimer;
/**
 * @param {string} msg
 * @param {boolean} isError
 * @param {{label: string, onAction: Function}} [action]
 *   An optional single verb — Undo, in practice. Given longer to live than a
 *   plain toast, because a message you are meant to ACT on must not vanish
 *   while you are still reading it.
 */
function toast(msg, isError = false, action = null) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '') + (action ? ' has-action' : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.type = 'button';
    b.textContent = action.label;
    b.onclick = () => { el.remove(); clearTimeout(toastTimer); action.onAction(); };
    el.appendChild(b);
  }
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), action ? 9000 : 3600);
}
const run = async (fn) => { try { await fn(); } catch (e) { toast(e.message, true); } };

/* ── Icons — one system, one stroke weight ───────────────────────────── */
const ICON = {
  today: '<rect x="3" y="4.5" width="14" height="13" rx="2.5"/><path d="M3 8.5h14M7 3v3M13 3v3"/><circle cx="10" cy="13" r="1.6" fill="currentColor" stroke="none"/>',
  calendar: '<rect x="3" y="4.5" width="14" height="13" rx="2.5"/><path d="M3 8.5h14M7 3v3M13 3v3"/>',
  projects: '<path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h3l1.5 2h6.5A1.5 1.5 0 0 1 17 7.5v7A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5v-9Z"/>',
  diary: '<path d="M5.5 3.5h9A1.5 1.5 0 0 1 16 5v10a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 15V5a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M7 3.5v13M9.5 7.5h4M9.5 10.5h4"/>',
  library: '<path d="M4 4h2.6v13H4zM8 4h2.6v13H8z"/><path d="m12.6 4.6 2.5.7-2.8 12-2.5-.7z"/>',
  brain: '<path d="M10 4.4c-1.5-1.4-4.1-.8-4.5 1.3-1.5.4-2.1 2.2-1.2 3.4-.9 1.3-.3 3.1 1.1 3.5.2 1.9 2.4 2.9 3.9 1.8M10 4.4c1.5-1.4 4.1-.8 4.5 1.3 1.5.4 2.1 2.2 1.2 3.4.9 1.3.3 3.1-1.1 3.5-.2 1.9-2.4 2.9-3.9 1.8M10 4.4v11"/>',
  settings: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.6v2M10 15.4v2M17.4 10h-2M4.6 10h-2M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4M15.2 15.2l-1.4-1.4M6.2 6.2 4.8 4.8"/>',
  search: '<circle cx="9" cy="9" r="5.2"/><path d="m13 13 4 4"/>',
  menu: '<path d="M3.5 6h13M3.5 10h13M3.5 14h13"/>',
  sparkle: '<path d="M10 3.5 11.4 8 16 9.4 11.4 10.8 10 15.4 8.6 10.8 4 9.4 8.6 8 10 3.5Z"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  // Three lines, shortest last — the conventional "sort" mark, at the same
  // stroke weight as every other icon in the set.
  sort: '<path d="M4 6h12M4 10h8M4 14h4"/>',
  chevL: '<path d="m12 5-5 5 5 5"/>',
  chevR: '<path d="m8 5 5 5-5 5"/>',
  // Horizontal, matching utilityTriggerHtml. The app had both orientations —
  // task rows and Today's overflow stacked them vertically, Calendar laid them
  // flat — so "the ⋯ button" meant two different glyphs depending on where you
  // were looking. One overflow mark, everywhere.
  dots: '<circle cx="4.5" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10" r="1.4" fill="currentColor" stroke="none"/>',
  grip: '<circle cx="7.5" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="7.5" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="7.5" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="15" r="1.2" fill="currentColor" stroke="none"/>',
  pencil: '<path d="M13.5 3.5 16.5 6.5 7 16H4v-3z"/>',
};
const icon = (name, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`;

/**
 * The Life OS lockup. The gradient is inlined and self-contained rather than
 * referenced from a sprite: a gradient defined inside a `display:none` <symbol>
 * does not paint in Chrome, which is exactly how this logo went invisible once.
 */
const logoMark = (n = 26) => `<svg class="logo-mark" width="${n}" height="${n}" viewBox="0 0 24 24"
    role="img" aria-label="Life OS">
  <defs><linearGradient id="lotus${n}" gradientUnits="userSpaceOnUse" x1="4" y1="21" x2="20" y2="3">
    <stop offset="0" stop-color="#7C4DFF"/><stop offset="1" stop-color="#C28DFF"/></linearGradient></defs>
  <path d="M12 20.4C6.9 17.6 3.4 13.1 3.4 8.5 7.1 9.2 10.1 13 12 20.4Z" fill="url(#lotus${n})" fill-opacity=".82"/>
  <path d="M12 20.4c5.1-2.8 8.6-7.3 8.6-11.9-3.7.7-6.7 4.5-8.6 11.9Z" fill="url(#lotus${n})" fill-opacity=".82"/>
  <path d="M12 2.3C8.6 8 8.6 15 12 20.4 15.4 15 15.4 8 12 2.3Z" fill="url(#lotus${n})"/></svg>`;

/* ── Auth ────────────────────────────────────────────────────────────── */
/**
 * Local development bypass. Only ever against a localhost API, and worthless
 * unless that server was started with DEV_AUTH_BYPASS — which loadEnv() refuses
 * to read in staging or production. The real gate is server-side.
 */
function devBypass() {
  const token = localStorage.getItem('los2_dev_token');
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(CFG.apiBaseUrl);
  return token && local ? token : null;
}

async function initAuth() {
  const dev = devBypass();
  if (dev) {
    devToken = dev;
    state.token = dev;
    window.__signOut = () => { localStorage.removeItem('los2_dev_token'); location.reload(); };
    return run(boot);
  }
  if (!CFG.isConfigured) {
    return renderFatal('Configuration needed',
      'This deployment has no Firebase settings. Set the FIREBASE_* variables on the web service.');
  }
  const [{ initializeApp }, auth] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js'),
  ]);
  const a = auth.getAuth(initializeApp(CFG.firebase));

  auth.onAuthStateChanged(a, async (user) => {
    if (!user) {
      authUser = null;
      return renderSignIn(() => auth.signInWithPopup(a, new auth.GoogleAuthProvider()));
    }
    // Held so api() can ask for a token per request. No interval: a background
    // timer is exactly what stopped firing and let the token expire.
    authUser = user;
    state.token = await user.getIdToken();
    // The token is NOT written to localStorage. Nothing ever read it back, and
    // an ID token on disk outlives the tab that fetched it.
    window.__signOut = () => {
      localStorage.removeItem('los2_token');   // clear any left by an older build
      localStorage.removeItem('los2_ws');
      authUser = null;
      return auth.signOut(a);
    };
    await run(boot);
  });
}

function renderSignIn(onClick) {
  document.body.classList.remove('drawer-open');
  root.innerHTML = `<div style="min-height:100vh;display:grid;place-items:center;padding:24px">
    <div style="max-width:380px;width:100%;text-align:center">
      <div class="intro" style="display:flex;justify-content:center;align-items:center;gap:12px;margin-bottom:24px">
        ${logoMark(40)}<div class="logo-word" style="font-size:30px">Life OS</div>
      </div>
      <p class="sub" style="margin-bottom:26px">Your calm home for everything.</p>
      <button class="btn btn-primary" id="si" style="width:100%;padding:12px">Continue with Google</button>
    </div></div>`;
  document.getElementById('si').onclick = onClick;
}

const renderFatal = (title, body) => {
  root.innerHTML = `<div class="state" style="margin:60px auto;max-width:520px;padding:0 24px">
    <b>${esc(title)}</b>${esc(body)}</div>`;
};

/* ── Boot ────────────────────────────────────────────────────────────── */
async function boot() {
  state.route = routeFromHash();
  const [me, prefsRes] = await Promise.all([
    api('/api/v1/me'),
    api('/api/v1/preferences').catch(() => ({ preferences: {} })),
  ]);
  state.me = me;
  state.prefs = prefsRes.preferences ?? {};
  localStorage.setItem('los2_ws', me.workspace.id);
  applyPreferences();

  /* Library is given the shell's own primitives rather than importing them.
   * It never builds a URL, never opens its own dialog shell, and never decides
   * what an error looks like — one voice for all of that, defined here. */
  const surfaceCtx = {
    api: (path, opts) => api(`/api/v1/workspaces/${ws()}${path}`, opts),
    toast,
    run,
    openSurface: openUtilitySurface,
    closeSurface: closeUtility,
    choose: openChoiceDialog,
  };
  initLibrary(surfaceCtx);
  initDiary(surfaceCtx);

  renderShell();
  await loadRoute();
  // Habits populate the rail as soon as they arrive. Deliberately not awaited:
  // Today must never wait on a secondary system to appear.
  loadHabits().then(renderRail).catch(() => {});
  // Kept in state for the account menu's Completed entry; no longer surfaced
  // on Today, where finished work was competing with what still needs doing.
  api(`/api/v1/workspaces/${ws()}/tasks?status=done&limit=1`)
    .then((r) => { state.historyTotal = r.total; })
    .catch(() => {});
  initStars();
  initHoverPreview(hoverRender);
  // One drag system for mouse, pen and touch. `settled: true` because the
  // placeholder already put the card in its final slot before release.
  // Plan-mode scheduling. Separate from task-board dragging: this one drops
  // work onto a time axis rather than into a list.
  initPlanDrag({
    hours: () => planHours(),
    conflictsAt: (day, startMin, endMin, ignoreBlockId) => {
      const { events, blocks } = itemsForDay(day);
      const clash = [];
      const mins = (d) => { const x = new Date(d); return x.getHours() * 60 + x.getMinutes(); };
      for (const e of events) {
        if (e.isAllDay || !e.startsAt || !e.endsAt) continue;
        if (mins(e.startsAt) < endMin && mins(e.endsAt) > startMin) clash.push(e.title);
      }
      for (const b of blocks) {
        if (b.id === ignoreBlockId) continue;
        if (mins(b.startsAt) < endMin && mins(b.endsAt) > startMin) clash.push(b.title);
      }
      return clash;
    },
    onCreate: (taskId, startsAt, endsAt) => scheduleTask(taskId, startsAt, endsAt),
    onMove: (blockId, startsAt, endsAt) => moveBlock(blockId, startsAt, endsAt),
  });
  initDrag({
    getScrollRoot: () => document.getElementById('main-scroll'),
    // One drag system, two destinations. The project list marks itself
    // `data-bucket="project"`, so a drop there reorders inside the project
    // instead of moving the task between Today buckets.
    onDrop: (id, bucket, anchor) => (bucket === 'project'
      ? reorderProjectTask(id, anchor)
      : moveTask(id, bucket, anchor, { settled: true })),
  });
  initServiceWorker();
}

function applyPreferences() {
  document.documentElement.dataset.motion =
    state.prefs.reducedMotion === 'always' ? 'reduced' : 'system';
}

/* ── Data ────────────────────────────────────────────────────────────── */
async function loadTasks() {
  // Active only. History is fetched separately and paged — after the legacy
  // import it is far longer than any bucket will ever be.
  const r = await api(`/api/v1/workspaces/${ws()}/tasks?includeCompleted=false`);
  state.tasks = r.tasks;
  state.projectsById = r.projects ?? {};
}
async function loadHistory(reset = false) {
  if (reset) { state.history = []; state.historyTotal = 0; }
  const r = await api(`/api/v1/workspaces/${ws()}/tasks`
    + `?status=done&limit=${HISTORY_PAGE}&offset=${state.history.length}`);
  state.history = [...state.history, ...r.tasks];
  state.historyTotal = r.total;
}

/**
 * One bucket's visible tasks, in the order they are drawn.
 *
 * Sorted by `position` — the user's own Today order — and then PARTITIONED so
 * standalone work comes before project work. The partition is a display
 * grouping, not a second sort: within each group, `position` still decides, so
 * a drag that changes `position` still lands where the user dropped it.
 */
const inBucket = (b) => {
  const list = state.tasks
    .filter((t) => t.bucket === b && t.status !== 'done'
      && (!state.areaFilter || t.areaId === state.areaFilter))
    .sort((x, y) => x.position - y.position);
  const { standalone, project } = partition(list, state.projectsById);
  return [...standalone, ...project];
};
const areaName = (id) => state.me.areas.find((a) => a.id === id)?.name || '';
/**
 * A task by id, wherever it is currently mounted.
 *
 * THE COMPLETED-HISTORY BUG LIVED HERE. This used to be
 * `state.tasks.find(...)` — the ACTIVE board only. A completed task is removed
 * from `state.tasks` the moment it is ticked and lives in `state.history`, so
 * clicking one in Completed passed a perfectly valid id to `openTask`, got
 * `undefined` back, and the shared editor's `task ? edit : create` fallback
 * quietly turned "not found" into "new task" — a blank Create Task form.
 *
 * Not a missing id, not a mode flag, not an event-target mismatch: a lookup
 * scoped to a collection that by construction could never hold the answer.
 *
 * Searching every mounted collection also gives §16 its single source: a step
 * ticked on Today and the same step read from Project detail resolve to the
 * SAME object, so there is nothing to keep in sync.
 */
const findTask = (id) => state.tasks.find((t) => t.id === id)
  ?? (pj.detail?.tasks ?? []).find((t) => t.id === id)
  ?? state.history.find((t) => t.id === id)
  ?? null;

/**
 * Redraws every place this task is currently on screen.
 *
 * One record, several mounts. `except` skips the node that already repainted
 * itself, so an inline step tick does not rebuild the row underneath the
 * pointer that triggered it.
 */
function syncTaskEverywhere(id, except = null) {
  const t = findTask(id);
  if (!t) return;
  document.querySelectorAll(`.task[data-id="${id}"]`).forEach((el) => {
    if (el === except) return;
    if (el.closest('#pjd-tasks, .pjd-tasks-done')) patchProjectTaskRow(id);
    else patchCard(id);
  });
  // The next-action slot shows this task's step counts when it is the one.
  const next = pj.detail?.project?.nextAction;
  if (next?.id === id) {
    const { total, done } = stepCounts(t);
    next.steps = total ? { total, done } : null;
    patchNextActionSlot();
  }
}

/* ══ SHELL — rendered once, never redrawn ═══════════════════════════════ */
function renderShell() {
  const initial = (state.me.user.displayName || state.me.user.email || '?').trim()[0].toUpperCase();
  const introSeen = sessionStorage.getItem('los2_intro');

  root.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <a class="logo ${introSeen ? '' : 'intro'}" href="#today" data-route="today" aria-label="Life OS — Today">
          ${logoMark(26)}<span class="logo-word">Life OS</span>
        </a>

        <button class="cmdk" id="cmdk" aria-label="Search and commands">
          ${icon('search', 16)}<span>Search</span><kbd>⌘K</kbd>
        </button>

        <nav class="nav" id="nav" aria-label="Main">
          <div class="nav-pill snap" id="nav-pill" aria-hidden="true"></div>
          ${ROUTES.map((r) => `
            <a href="#${r.id}" data-route="${r.id}"
               ${state.route === r.id ? 'aria-current="page"' : ''}>
              <span class="ico">${icon(r.icon)}</span>
              <span>${r.label}</span>
              ${r.placeholder ? '<span class="soon" title="Coming soon">soon</span>' : '<span></span>'}
            </a>`).join('')}
        </nav>

        <div class="side-foot">
          <!-- One click to Settings. The popover it replaced held four
               unrelated things - Settings, Completed, a build string and Sign
               out - none of which is account management, and all of which were
               a second click away from anywhere. -->
          <button class="who" id="account-btn" data-route="settings">
            <span class="avatar">${esc(initial)}</span>
            <span class="who-text">
              <span class="who-name">${esc(state.me.user.displayName || state.me.user.email)}</span>
              <span class="who-sub">${esc(state.me.workspace.name)} workspace</span>
            </span>
            <span class="who-go" aria-hidden="true">
              <svg viewBox="0 0 20 20"><path d="m8 5 5 5-5 5"/></svg>
            </span>
          </button>
        </div>
      </aside>

      <main class="main">
        <div class="mobile-bar">
          <button class="m-btn" id="drawer-btn" aria-label="Open navigation"
            aria-expanded="false" aria-controls="sidebar">${icon('menu')}</button>
          <span class="m-title">Life OS</span>
          <button class="m-btn" id="cmdk-m" style="margin-left:auto"
            aria-label="Search and commands">${icon('search')}</button>
        </div>
        <!-- Legacy's nested grid: content and rail sit inside the main column,
             separated by a real gutter and capped so a wide screen does not
             stretch the page edge to edge. -->
        <div class="main-wrap">
          <div class="main-col">
            <header class="page-head" id="page-head"></header>
            <div class="main-scroll" id="main-scroll" tabindex="-1"></div>
          </div>
          <aside class="rail" id="rail" aria-label="Context"></aside>
        </div>
      </main>
    </div>

    <div class="composer" id="composer">
      <div class="composer-inner" role="group" aria-disabled="true"
           aria-label="Life OS assistant — not yet connected"
           title="The assistant arrives in a later phase of v2">
        <span class="ico">${icon('sparkle', 18)}</span>
        <span class="composer-text">Ask Life OS or capture a thought</span>
        <span class="composer-badge">Soon</span>
      </div>
    </div>`;

  if (!introSeen) sessionStorage.setItem('los2_intro', '1');
  wireShell();
  renderRail();
  positionPill(true);
}

function wireShell() {
  root.querySelectorAll('[data-route]').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); go(el.dataset.route); });
  });

  const drawerBtn = document.getElementById('drawer-btn');
  const scrim = document.getElementById('drawer-scrim');
  const setDrawer = (open) => {
    document.body.classList.toggle('drawer-open', open);
    drawerBtn?.setAttribute('aria-expanded', String(open));
    if (open) document.querySelector('.nav a')?.focus();
  };
  drawerBtn?.addEventListener('click', () =>
    setDrawer(!document.body.classList.contains('drawer-open')));
  scrim?.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) setDrawer(false);
  });
  window.__closeDrawer = () => setDrawer(false);

  // One click, straight to Settings. No intermediate menu.
  document.getElementById('account-btn')?.addEventListener('click', () => go('settings'));

  const palette = () => toast('The command palette arrives with search in a later phase.');
  document.getElementById('cmdk')?.addEventListener('click', palette);
  document.getElementById('cmdk-m')?.addEventListener('click', palette);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); }
  });

  window.addEventListener('hashchange', () => {
    const r = routeFromHash();
    if (r !== state.route) return go(r);
    // Back/forward within Calendar moves between the calendar and its
    // utilities without a route change, so it is handled here.
    const u = utilityFromHash();
    if (r === 'calendar' && u !== cal.utility) {
      if (u === 'reminders') openRemindersView(false);
      else closeRemindersView(false);
    }
    if (r === 'projects') {
      const id = projectFromHash();
      if (id !== pj.openId) {
        if (id) { pj.openId = id; renderProjectDetail(document.getElementById('main-scroll')); }
        else closeProjectDetail(false);
      }
    }
    // Back and forward INSIDE Library move between the shelf, an item and a
    // page of a book without a route change, so Library resolves it itself.
    if (r === 'library') libraryHashChanged();
    // Diary does the same across dates and its history view.
    if (r === 'diary') diaryHashChanged();
  });
  // The rail reflows between a column and a grid; the pill must follow the nav.
  window.addEventListener('resize', () => { positionPill(true); measureScrollbar(); });
  measureScrollbar();
}

/**
 * Publishes the scrollbar's width as `--sbw`.
 *
 * The Calendar frame centres itself on the window, and the only way to say
 * "the window" in CSS is `100vw` — which INCLUDES the classic scrollbar. On a
 * page long enough to scroll that put the whole calendar half a scrollbar
 * right of centre, which is exactly the kind of small constant error that
 * makes a layout look almost-right. Overlay scrollbars report 0 and the
 * arithmetic collapses to plain 100vw.
 */
function measureScrollbar() {
  // Measured off the root element's own box, not clientWidth: with
  // `scrollbar-gutter:stable` the gutter is reserved whether or not the page
  // scrolls, and clientWidth then reports the full window as if it were not.
  // The root's border box is the width the layout actually gets.
  const w = window.innerWidth - document.documentElement.getBoundingClientRect().width;
  document.documentElement.style.setProperty('--sbw', `${Math.max(0, Math.round(w))}px`);
}

/**
 * Moves the single shared indicator. translateY only, so it composites on the
 * GPU. It snaps into place the first time it is revealed and glides after that
 * — it must never disappear and reappear.
 */
function positionPill(snap = false) {
  const nav = document.getElementById('nav');
  const pill = document.getElementById('nav-pill');
  const active = nav?.querySelector('a[aria-current="page"]');
  if (!nav || !pill) return;
  // History and Settings live outside the nav list, so the indicator has
  // nowhere to sit. It fades rather than jumping to an unrelated item.
  if (!active) { pill.style.opacity = '0'; return; }
  pill.style.opacity = '1';
  pill.style.setProperty('--pill-h', `${active.offsetHeight}px`);
  // `.nav` is position:relative, so it IS the offsetParent — offsetTop is
  // already measured from it. Subtracting nav.offsetTop as well pushed the
  // indicator off the top of the sidebar entirely.
  pill.style.setProperty('--pill-y', `${active.offsetTop}px`);

  if (snap) {
    // Suppress the transition for this one jump, then restore it so every
    // later move glides.
    //
    // setTimeout, not requestAnimationFrame: rAF is suspended entirely while a
    // tab is in the background or otherwise not compositing, which would leave
    // the indicator permanently frozen for anyone who opened Life OS in a
    // background tab. A timer still fires.
    pill.classList.add('snap');
    void pill.offsetHeight;
    setTimeout(() => pill.classList.remove('snap'), 0);
  }
}

// History and Settings are real, bookmarkable routes even though neither
// appears in the primary sidebar.
/**
 * `#calendar/reminders` is a real destination, not a flag on top of Month.
 *
 * That matters for refresh and for the browser's back button: reloading on the
 * reminders URL must open reminders, and Back must leave it — neither of which
 * a piece of in-memory state can do.
 */
const routeFromHash = () => {
  const path = (location.hash || '#today').slice(1).split('?')[0];
  const id = path.split('/')[0];
  return ALL_ROUTE_IDS.includes(id) ? id : 'today';
};

const utilityFromHash = () => {
  const path = (location.hash || '').slice(1).split('?')[0];
  const sub = path.split('/')[1];
  return sub === 'reminders' ? 'reminders' : 'none';
};

/** `#projects/<id>` opens that project directly — refresh included. */
const projectFromHash = () => {
  const path = (location.hash || '').slice(1).split('?')[0];
  const [route, sub] = path.split('/');
  return route === 'projects' && sub ? sub : null;
};

async function go(id) {
  if (state.route === id) { window.__closeDrawer?.(); return; }
  // Leaving Library or Diary while something is being written to must not lose
  // the words. The write is awaited BEFORE the route changes, not alongside it.
  if (state.route === 'library') await libraryWillLeave();
  if (state.route === 'diary') await diaryWillLeave();
  // §7 A utility surface is anchored to a control on the page you are leaving.
  closeUtility();
  state.route = id;
  if (location.hash.slice(1) !== id) location.hash = id;
  document.querySelectorAll('[data-route]').forEach((a) => {
    if (a.dataset.route === id && a.closest('.nav')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  positionPill();
  /* account popover removed */
  window.__closeDrawer?.();
  await loadRoute();
}

/* ── Routes — only the main column changes ───────────────────────────── */
async function loadRoute() {
  // Polling a calendar nobody is looking at is a request that can only cost
  // something. loadCalendar() starts it again on the way back in.
  stopCalendarLive();
  const head = document.getElementById('page-head');
  const scroll = document.getElementById('main-scroll');
  if (!head || !scroll) return;

  const route = ROUTES.find((r) => r.id === state.route);
  // Restart the crossfade without redrawing the shell around it.
  scroll.style.animation = 'none';
  void scroll.offsetHeight;
  scroll.style.animation = '';

  if (state.route === 'today') {
    // A quiet overflow, not a board item. Finished work is for recovery and
    // reflection; putting a running total in the daily flow made it compete
    // with what still needs doing.
    head.innerHTML = `${greetingHtml()}
      <div class="page-actions">
        ${utilityTriggerHtml('today-more', 'More actions')}
      </div>`;
    scroll.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    try {
      await loadTasks();
      scroll.innerHTML = todayHtml();
      wireToday();
      restoreTodayState();
      document.getElementById('today-more')?.addEventListener('click', (e) =>
        openTodayMenu(e.currentTarget));
      renderRail();
      // After the board exists and expansion has been restored — §9 requires
      // the arrangement not to disturb which tasks are open.
      maybeArrangeToday();
    } catch (e) {
      scroll.innerHTML = errorHtml(e.message);
      scroll.querySelector('#retry')?.addEventListener('click', () => loadRoute());
    }
    return;
  }

  if (state.route === 'projects') {
    await loadProjects();
    return;
  }

  if (state.route === 'history') {
    head.innerHTML = `<p class="eyebrow">Today</p><h1>Completed</h1>
      <p class="sub">Everything you have finished, newest first.</p>
      <div class="page-actions">
        <button class="btn btn-ghost" data-route="today">${icon('today', 16)}<span>Back to Today</span></button>
      </div>`;
    head.querySelector('[data-route]').onclick = () => go('today');
    scroll.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    try {
      await loadHistory(true);
      scroll.innerHTML = historyHtml();
      wireHistory();
    } catch (e) {
      scroll.innerHTML = errorHtml(e.message);
      scroll.querySelector('#retry')?.addEventListener('click', () => loadRoute());
    }
    return;
  }

  if (state.route === 'settings') {
    head.innerHTML = `<p class="eyebrow">Life OS</p><h1>Settings</h1>
      <p class="sub">Your account, your workspace, and how the app behaves.</p>`;
    renderSettings();
    return;
  }

  // Calendar is a real section now, so it must branch BEFORE the placeholder
  // header is written — `route` here is the route OBJECT, not its id, which is
  // why an earlier `route === 'calendar'` check never fired.
  if (state.route === 'calendar') return loadCalendar();

  if (state.route === 'library') return renderLibrary();

  if (state.route === 'diary') return renderDiary();

  const ph = PLACEHOLDERS[state.route];
  head.innerHTML = `<p class="eyebrow">Life OS</p><h1>${esc(route.label)}</h1>
    <p class="sub">${esc(ph.tagline)}</p>`;
  scroll.innerHTML = placeholderHtml(route, ph);
}

const errorHtml = (msg) => `<div class="state"><b>That did not load</b>${esc(msg)}
  <div style="margin-top:16px"><button class="btn" id="retry">Try again</button></div></div>`;

function greetingHtml() {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = (state.me.user.displayName || '').split(/\s+/)[0];
  const dateStr = new Date().toLocaleDateString(undefined,
    { weekday: 'long', day: 'numeric', month: 'long' });
  return `<p class="eyebrow">${esc(dateStr)}</p>
    <h1>${greet}${first ? `, <span class="nm">${esc(first)}</span>` : ''}.</h1>
    <p class="sub">Here is what is in front of you.</p>`;
}

/* ── Today ───────────────────────────────────────────────────────────────
 * Rendering rule for this page: the board is built ONCE per route entry.
 * Every mutation after that patches the DOM in place — it never rebuilds
 * `main-scroll`. Rebuilding is what produced the "save flicker": the whole
 * board was destroyed, every card re-entered with the staggered rise, and the
 * eye read a page reload rather than one task changing.
 */
function todayHtml() {
  return `<div class="toolbar">
      <button class="btn btn-primary" id="add">Add task</button>
      <div class="filters" role="group" aria-label="Filter by area">
        <button class="chip" data-area="" aria-pressed="${!state.areaFilter}">All areas</button>
        ${state.me.areas.map((a) => `<button class="chip" data-area="${a.id}"
          aria-pressed="${state.areaFilter === a.id}">${esc(a.name)}</button>`).join('')}
      </div>
    </div>
    <div class="buckets">${BUCKETS.map(bucketHtml).join('')}</div>
`;
}

function bucketHtml(b) {
  const list = inBucket(b.id);
  return `<section class="bucket ${b.id === 'future' ? 'future' : ''}" aria-label="${b.label}">
    <div class="bucket-head"><h2>${b.label}</h2>
      <span class="bucket-count" data-count="${b.id}">${list.length}</span></div>
    <div class="drop${list.length ? '' : ' is-empty'}" data-bucket="${b.id}">
      ${list.length ? bucketInnerHtml(list) : emptyHtml(b)}
    </div></section>`;
}

/**
 * A bucket's contents: standalone work, then project work, with headings only
 * where they earn their place.
 *
 * THE TASKS STAY DIRECT CHILDREN OF THE DROP ZONE. The headings are siblings
 * between them, not wrappers around them.
 *
 * That is not a style choice. `drag.js` finds candidates with
 * `zone.querySelectorAll('.task')` — which matches at any depth — and then
 * calls `zone.insertBefore(placeholder, candidate)`, which requires the
 * candidate to be a DIRECT child. Nesting the rows inside two subsection
 * divs would throw `NotFoundError` on the first drag into the second section.
 * Sibling headings keep the drop zone flat and the drag code untouched.
 *
 * Which heading appears is adaptive, because a divider that separates one
 * thing from nothing is just noise:
 *
 *   both kinds present  ->  TASKS and PROJECTS
 *   standalone only     ->  neither; the bucket is already the container
 *   project only        ->  PROJECTS alone, which still says what this is
 */
function bucketInnerHtml(list) {
  const { standalone, project } = partition(list, state.projectsById);
  const bothKinds = standalone.length > 0 && project.length > 0;
  const out = [];
  if (bothKinds) out.push(subHeadHtml('tasks', 'Tasks'));
  out.push(...standalone.map((t) => taskHtml(t)));
  if (project.length) out.push(subHeadHtml('projects', 'Projects'));
  out.push(...project.map((t) => taskHtml(t)));
  return out.join('');
}

const subHeadHtml = (id, label) =>
  `<div class="sub-head" data-sub="${id}" role="presentation">${label}</div>`;

const emptyHtml = (b) => `<div class="empty">${
  b.id === 'today' ? 'Nothing planned for today' : 'Empty'}</div>`;

/**
 * The card. Metadata sits directly under the title as ONE dot-separated line,
 * so title and context read as a single unit rather than the title floating
 * above an isolated corner label. Nothing empty is rendered — a card with no
 * area, date or steps simply has no second line and is shorter for it.
 */
function taskHtml(t) {
  const steps = t.steps ?? [];
  const done = steps.filter((s) => s.completed).length;
  const bits = [];
  if (t.areaId) bits.push(`<span class="tm-area">${esc(areaName(t.areaId))}</span>`);
  if (t.dueDate) bits.push(`<span class="tm-due">${esc(fmtDate(t.dueDate))}</span>`);
  if (t.scheduledAt) bits.push(`<span>${esc(fmtTime(t.scheduledAt))}</span>`);
  else if (t.legacyScheduledTimeRaw) {
    bits.push(`<span class="tm-legacy" title="Time from the old app, kept as written">${esc(t.legacyScheduledTimeRaw)}</span>`);
  }
  // The chip is a control now, not a label. See steps.js.
  if (steps.length) {
    bits.push(stepsChipHtml(t, expandedSteps.has(t.id)));
    /* Said in the meta line, not only inside the expanded panel.
     *
     * Otherwise a task that had become finishable looked identical to one that
     * had not, and the only way to find out was to expand it. "3/3 steps" is
     * arithmetic; "Ready to finish" is the answer. */
    if (readyToFinish(t)) bits.push('<span class="tm-ready">Ready to finish</span>');
  }

  /* Project context.
   *
   * A NAME and a link, not a colour: colour alone cannot say which project,
   * and a task that belongs to one should be able to take you there. The
   * next-action marker is a word for the same reason. */
  const project = t.projectId ? state.projectsById[t.projectId] : null;
  if (project) {
    // The RESOLVED next action, so the badge appears on inferred next actions
    // too — not only on ones somebody picked by hand.
    const isNext = project.nextActionId === t.id;
    bits.push(`<button class="tm-project" data-open-project="${project.id}"
      title="Open ${esc(project.title)}">${esc(project.title)}</button>`);
    if (isNext) bits.push('<span class="tm-next">Next action</span>');
  } else if (t.projectId) {
    /* It HAS a project; we just could not load it.
     *
     * Saying so is the honest answer. Rendering nothing would make this look
     * like a standalone task, and then the daily arranger — which is not
     * allowed near project work — would happily reorder it. A failed request
     * must not silently change what a task is. */
    bits.push('<span class="tm-project is-missing" title="This task belongs to a project that could not be loaded">Project unavailable</span>');
  }

  /* The steps panel is INSIDE the article, never a sibling.
   *
   * A sibling row sits in the drop zone, and everything in a drop zone is a
   * task as far as the drag code is concerned — it would become an insertion
   * target and could be reordered away from its parent. Nesting is what makes
   * that structurally impossible rather than merely discouraged. */
  /* `data-project` is what tells the drag code which subsection this row
   * belongs to. Read from the record, present whenever the task has a project
   * at all — including one whose metadata failed to load, which is still
   * project work and must not drift into the standalone half. */
  return `<article class="task pri-${t.priority} ${readyToFinish(t) ? 'is-ready' : ''}"
      data-id="${t.id}" ${t.projectId ? `data-project="${t.projectId}"` : ''}
      tabindex="0" aria-label="${esc(t.title)}">
    <div class="t-row">
      ${parentTickHtml(t)}
      <div class="t-main">
        <button class="t-title" data-act="open" title="${esc(t.title)}">${esc(t.title)}</button>
        ${bits.length ? `<div class="t-meta">${bits.join('<span class="tm-sep">·</span>')}</div>` : ''}
      </div>
      <div class="t-actions">
        <button class="t-btn" data-act="back" aria-label="Move to previous bucket" title="Move earlier (Alt ←)">${icon('chevL', 16)}</button>
        <button class="t-btn" data-act="fwd" aria-label="Move to next bucket" title="Move later (Alt →)">${icon('chevR', 16)}</button>
        <button class="t-btn" data-act="menu" aria-label="More actions" title="More (M)">${icon('dots', 16)}</button>
        <span class="t-grip" aria-hidden="true" title="Drag to move">${icon('grip', 16)}</span>
      </div>
    </div>
    ${stepsPanelHtml(t, expandedSteps.has(t.id))}
  </article>`;
}

/**
 * The parent task's completion control.
 *
 * With unfinished steps it is DISABLED and says why. Not "clickable, then an
 * error": letting someone press a control and only then telling them it was
 * never going to work is the pattern this replaces. The reason lives in
 * `aria-label` and `title`, so it is available to a screen reader and on hover
 * rather than only in a colour.
 *
 * The count of remaining steps rides along in the class, so the ring can show
 * progress without the markup carrying a second copy of the numbers.
 */
function parentTickHtml(t) {
  const blocked = parentBlockedReason(t);
  if (!blocked) {
    /* Ready, or no steps at all: the ORDINARY task checkbox.
     *
     * Not a ring showing 3/3 — that still reads as information rather than as
     * something to press. Reaching the end of the steps has to hand back the
     * same control every other task has, or the user is left wondering whether
     * they are allowed to finish. */
    return `<button class="t-tick ${readyToFinish(t) ? 'is-ready' : ''}" data-act="toggle"
      aria-label="${readyToFinish(t) ? 'All steps complete — mark done' : 'Mark done'}"></button>`;
  }

  const { total, done } = stepCounts(t);
  /* Blocked: a progress ring, and NOT a disabled button.
   *
   * A disabled control does nothing when pressed, which is its own small
   * failure — the user gets no answer. This one is pressable, says what it is
   * through `aria-disabled`, and opens the steps so the remaining work is on
   * screen. The count lives in the label rather than inside the ring: 7.5px
   * digits in a 20px circle were not readable, and the `1/3 steps` chip in the
   * meta line already carries the number in a legible size. */
  return `<button class="t-tick is-blocked" data-act="toggle" aria-disabled="true"
    aria-label="${done} of ${total} steps complete. ${esc(blocked)}."
    title="${esc(blocked)}"
    style="--step-frac:${total ? done / total : 0}"></button>`;
}

/**
 * Which tasks currently have their steps showing, by id.
 *
 * Deliberately NOT a property on the task record: it is view state, it must not
 * be sent to the server, and it must survive the record being replaced by a
 * fresh copy from a response. Keyed by id so a row re-rendered anywhere — Today
 * or Project detail — comes back open if it was open.
 */
const expandedSteps = new Set();

const fmtDate = (iso) => new Date(`${iso}T12:00:00`)
  .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtTime = (iso) => new Date(iso)
  .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * Today -> Project, and back to the board you left.
 *
 * The board is a scroll position, an area filter and a focused card. Coming
 * back to a reset version of it is the same complaint as losing your place in
 * a list, so all three are captured on the way out.
 */
function openProjectFromToday(projectId, fromTaskId) {
  state.todayResume = {
    scrollTop: window.scrollY,
    areaFilter: state.areaFilter,
    taskId: fromTaskId ?? null,
  };
  pj.cameFromToday = true;
  go('projects');
  pj.openId = projectId;
  history.replaceState(null, '', `#projects/${projectId}`);
  renderProjectDetail(document.getElementById('main-scroll'));
}

function restoreTodayState() {
  const back = state.todayResume;
  if (!back) return;
  state.todayResume = null;
  requestAnimationFrame(() => {
    window.scrollTo({ top: back.scrollTop, behavior: 'instant' });
    if (back.taskId) {
      document.querySelector(`.task[data-id="${back.taskId}"]`)?.focus({ preventScroll: true });
    }
  });
}

function wireToday() {
  document.getElementById('add').onclick = () => openTask(null);
  document.querySelectorAll('[data-open-project]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      openProjectFromToday(b.dataset.openProject, b.closest('.task')?.dataset.id);
    };
  });
  document.querySelectorAll('[data-area]').forEach((el) => {
    el.onclick = () => setAreaFilter(el.dataset.area || null);
  });
  wireBoard();
}

/**
 * Filtering re-renders the board, but through FLIP — cards that survive the
 * filter glide to their new positions instead of the list blinking.
 */
function setAreaFilter(id) {
  state.areaFilter = id;
  if (state.route !== 'today') { go('today'); return; }
  document.querySelectorAll('.chip[data-area]').forEach((c) => {
    c.setAttribute('aria-pressed', String((c.dataset.area || null) === id));
  });
  flip(document.querySelectorAll('.task'), () => {
    for (const b of BUCKETS) rebuildBucket(b.id);
  });
  wireBoard();
  renderRail();
}

/** Replaces one bucket's rows. Used by filtering and by moves. */
function rebuildBucket(bucketId) {
  const drop = document.querySelector(`.drop[data-bucket="${bucketId}"]`);
  if (!drop) return;
  // Project links are re-wired by wireToday()/wireBoard() after any rebuild.
  const list = inBucket(bucketId);
  drop.classList.toggle('is-empty', list.length === 0);
  drop.innerHTML = list.length
    ? bucketInnerHtml(list)
    : emptyHtml(BUCKETS.find((b) => b.id === bucketId));
  const badge = document.querySelector(`[data-count="${bucketId}"]`);
  if (badge && badge.textContent !== String(list.length)) {
    badge.textContent = String(list.length);
    pulse(badge);
  }
}

function wireBoard() {
  document.querySelectorAll('.task').forEach(wireCard);
  // Drop zones carry no handlers: dragging is pointer-based and owned by
  // drag.js, which shows a live insertion placeholder instead of a target
  // outline. Native HTML5 DnD cannot preview an insertion gap and never fires
  // on touch at all.
}

function wireCard(el) {
  const id = el.dataset.id;
  el.querySelectorAll('[data-act]').forEach((b) => {
    // `steps` is wired by the component itself, which owns the panel it toggles.
    if (b.dataset.act === 'steps') return;
    b.onclick = (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'toggle') return toggleTask(id);
      if (act === 'open') return openTask(id);
      if (act === 'menu') return openTaskMenu(id, b);
      if (act === 'back') return shiftBucket(id, -1);
      if (act === 'fwd') return shiftBucket(id, 1);
    };
  });
  wireCardSteps(el, id);
  el.onkeydown = (e) => {
    // Typing inside a step must not reach the card's shortcuts, or a space in a
    // step name would complete the parent task.
    if (e.target.closest('.t-steps')) return;
    if (e.key === 'Enter') { e.preventDefault(); openTask(id); }
    else if (e.key === ' ') { e.preventDefault(); toggleTask(id); }
    else if (e.key.toLowerCase() === 'm') { e.preventDefault(); openTaskMenu(id, el); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); nudge(id, -1); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); nudge(id, 1); }
    else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); shiftBucket(id, -1); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); shiftBucket(id, 1); }
  };
}

/**
 * Attaches the shared Steps component to one Today card.
 *
 * The step handlers are the SAME `taskStepsCtx` the editor uses, so a step
 * ticked here and a step ticked in the editor take one code path into one
 * record. `onChanged` keeps the expansion set honest and refreshes anything
 * else on screen showing this task.
 */
function wireCardSteps(el, id) {
  const t = findTask(id);
  if (!t || !el.querySelector('.t-steps')) return;
  const chip = el.querySelector('[data-act="steps"]');
  chip?.addEventListener('click', () => {
    // The component flips the panel; this records it so a re-render restores it.
    if (expandedSteps.has(id)) expandedSteps.delete(id); else expandedSteps.add(id);
  }, true);
  // The ctx repaints nothing: `wireSteps` already repaints the panel it owns,
  // and doing both would rebuild the row under the pointer that triggered it.
  wireSteps(el, t, taskStepsCtx(t), {
    // `frameChanged` is true when something outside the panel is now wrong —
    // the chip appearing or vanishing, or the parent tick unblocking.
    onChanged: (frameChanged) => (frameChanged ? patchCard(id) : syncTaskEverywhere(id, el)),
    // A locked step is not a dead end: it opens the task, where the sequence
    // can be overridden on purpose.
    onOpenTask: () => openTask(id),
  });
}

/* ══ Mutations — optimistic, targeted, never a rebuild ═══════════════════
 *
 * Each of these updates local state, patches the affected DOM, fires the API
 * in the background, and rolls back if the server disagrees. `loadRoute` is
 * never called, `main-scroll` is never replaced, and scroll and focus survive.
 */

/** Re-renders ONE card in place, preserving its DOM position. */
function patchCard(id) {
  const el = document.querySelector(`.task[data-id="${id}"]`);
  const t = findTask(id);
  if (!el || !t) return;
  const wasFocused = el.contains(document.activeElement);
  el.outerHTML = taskHtml(t);
  const next = document.querySelector(`.task[data-id="${id}"]`);
  if (next) { wireCard(next); if (wasFocused) next.focus(); }
}

/**
 * Completing a task, in stages, so the act reads as finishing something rather
 * than as a row vanishing:
 *
 *   1. the tick fills immediately — no waiting on the network
 *   2. the title and metadata soften
 *   3. the card collapses out of the flow
 *   4. the neighbours close the gap, then the bucket count ticks over
 *
 * The bucket is NOT rebuilt. Replacing the markup would destroy node identity
 * for every remaining card, which is precisely why the gap used to snap shut
 * instead of closing. Only the completed card's node is removed.
 */
async function toggleTask(id, dirty = null) {
  const t = findTask(id);
  if (!t) return;
  const wasDone = t.status === 'done';
  /*
   * The sequence rule, enforced at the mutation and not only at the control.
   *
   * The checkbox is already disabled, but `Space` on a focused card reaches
   * here too, and so would anything else that learns to call this. Guarding the
   * write means the rule holds regardless of which affordance found it — and
   * it says why rather than failing quietly.
   *
   * Only on the way IN. Reopening a completed task is always allowed; its
   * steps are whatever they were.
   */
  if (!wasDone) {
    const blocked = parentBlockedReason(t);
    if (blocked) {
      // Pressing it is not a mistake to be scolded for — it is a reasonable
      // thing to try. So it answers: the steps open, and the reason is said.
      expandSteps(id);
      return toast(`${blocked}. Open the task to finish it anyway.`);
    }
  }
  // Anything the user had typed but not saved rides along with the completion.
  if (dirty) Object.assign(t, dirty);
  const card = document.querySelector(`.task[data-id="${id}"]`);
  const bucket = t.bucket;
  const index = card ? [...card.parentNode.children].indexOf(card) : -1;
  const parent = card?.parentNode ?? null;

  // Stage 1 + 2: immediate acknowledgement on the card itself.
  if (card && !wasDone) card.classList.add('is-completing');

  const removeNode = () => {
    state.tasks = state.tasks.filter((x) => x.id !== id);
    card?.remove();
    const drop = document.querySelector(`.drop[data-bucket="${bucket}"]`);
    if (drop) drop.classList.toggle('is-empty', !drop.querySelector('.task'));
    syncBucketCounts();
  };

  if (card && !wasDone) {
    // Stage 3: collapse. `collapseOut` is guaranteed by `settle`, so a hidden
    // tab cannot strand the card mid-animation.
    collapseOut(card, removeNode);
  } else {
    removeNode();
    rebuildBucket(bucket);
    wireBoard();
  }

  try {
    const r = await api(
      `/api/v1/workspaces/${ws()}/tasks/${id}/${wasDone ? 'uncomplete' : 'complete'}`,
      { method: 'POST', body: dirty ?? {} });
    Object.assign(t, r.task);
    state.historyTotal += wasDone ? -1 : 1;
    saved(wasDone ? 'Moved back to active' : 'Done');
  } catch (e) {
    // Put it back exactly where it was, visibly.
    state.tasks.push(t);
    if (parent && index >= 0) {
      card?.classList.remove('is-completing');
      if (card) {
        card.style.removeProperty('overflow');
        card.style.removeProperty('height');
        parent.insertBefore(card, parent.children[index] ?? null);
      }
      flip(document.querySelectorAll('.task'), () => { syncBucketCounts(); });
    } else {
      rebuildBucket(bucket); wireBoard();
    }
    toast(e.message, true);
  }
}

/**
 * @param {object} opts  `settled: true` means the DOM already shows the final
 *   arrangement — the drop path, where the placeholder put the card in place
 *   before release. Rebuilding there would destroy node identity and produce
 *   exactly the second reshuffle this phase is meant to remove.
 */
async function moveTask(id, bucket, anchor = {}, opts = {}) {
  const t = findTask(id);
  if (!t) return;
  const before = { bucket: t.bucket, position: t.position };
  const from = t.bucket;

  // Predict the landing position so the optimistic order matches the server's.
  const target = inBucket(bucket).filter((x) => x.id !== id);
  let pos;
  if (anchor.beforeTaskId) {
    const i = target.findIndex((x) => x.id === anchor.beforeTaskId);
    const prev = i > 0 ? target[i - 1].position : 0;
    pos = (prev + (target[i]?.position ?? prev + 2000)) / 2;
  } else if (anchor.afterTaskId) {
    const i = target.findIndex((x) => x.id === anchor.afterTaskId);
    const next = target[i + 1]?.position;
    pos = next ? (target[i].position + next) / 2 : target[i].position + 1000;
  } else {
    pos = (target[target.length - 1]?.position ?? 0) + 1000;
  }

  if (opts.settled) {
    // Only the model moves; the board is already right.
    t.bucket = bucket; t.position = pos;
    syncBucketCounts();
  } else {
    flip(document.querySelectorAll('.task'), () => {
      t.bucket = bucket; t.position = pos;
      rebuildBucket(from);
      if (bucket !== from) rebuildBucket(bucket);
    });
    wireBoard();
    document.querySelector(`.task[data-id="${id}"]`)?.focus();
  }

  try {
    const r = await api(`/api/v1/workspaces/${ws()}/tasks/${id}/move`,
      { method: 'POST', body: { bucket, ...anchor } });
    // Adopt the server's real position without moving anything visually.
    t.position = r.task.position;
    saved('Moved');
  } catch (e) {
    // Rollback is always visual, including after a drop: the user must see the
    // card return rather than silently find it somewhere else later.
    flip(document.querySelectorAll('.task'), () => {
      Object.assign(t, before);
      rebuildBucket(from);
      if (bucket !== from) rebuildBucket(bucket);
    });
    wireBoard();
    toast(e.message, true);
  }
}

/** Keeps the per-bucket tallies honest when the rows moved without a rebuild. */
function syncBucketCounts() {
  for (const b of BUCKETS) {
    const badge = document.querySelector(`[data-count="${b.id}"]`);
    const drop = document.querySelector(`.drop[data-bucket="${b.id}"]`);
    if (!badge || !drop) continue;
    const n = drop.querySelectorAll('.task').length;
    if (badge.textContent !== String(n)) { badge.textContent = String(n); pulse(badge); }
  }
}

function nudge(id, dir) {
  const t = findTask(id);
  const list = inBucket(t.bucket);
  const target = list[list.findIndex((x) => x.id === id) + dir];
  if (!target) return;
  moveTask(id, t.bucket, dir < 0 ? { beforeTaskId: target.id } : { afterTaskId: target.id });
}

/** Reveals a task's step panel and puts the cursor in the add field. */
function expandSteps(id) {
  const el = document.querySelector(`.task[data-id="${id}"]`);
  const panel = el?.querySelector('.t-steps');
  if (!panel) return;
  expandedSteps.add(id);
  panel.hidden = false;
  el.querySelector('[data-act="steps"]')?.setAttribute('aria-expanded', 'true');
  panel.querySelector('[data-step-new]')?.focus();
}

function shiftBucket(id, dir) {
  const t = findTask(id);
  const i = BUCKETS.findIndex((b) => b.id === t.bucket);
  const next = BUCKETS[i + dir];
  if (!next) return;
  moveTask(id, next.id);
}

/** The quiet save indicator — silent by default, only ever a whisper. */
let saveTimer;
function saved(msg = 'Saved') {
  let el = document.getElementById('save-state');
  if (!el) {
    el = document.createElement('div');
    el.id = 'save-state';
    el.className = 'save-state';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => el.classList.remove('is-on'), 1600);
}

/* ── Task overflow menu ──────────────────────────────────────────────── */
function openTaskMenu(id, anchorEl) {
  closeMenu();
  const t = findTask(id);
  const r = anchorEl.getBoundingClientRect();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = `<div class="menu-label">Move to</div>
    ${BUCKETS.map((b) => `<button role="menuitem" data-b="${b.id}" ${b.id === t.bucket ? 'disabled' : ''}>
      <span>${b.label}</span>${b.id === t.bucket ? '<kbd>current</kbd>' : ''}</button>`).join('')}
    <div class="menu-label">Order</div>
    <button role="menuitem" data-n="-1"><span>Move up</span><kbd>Alt ↑</kbd></button>
    <button role="menuitem" data-n="1"><span>Move down</span><kbd>Alt ↓</kbd></button>
    <button role="menuitem" data-o="top"><span>Move to top</span></button>
    <button role="menuitem" data-o="bottom"><span>Move to bottom</span></button>
    <div class="am-sep"></div>
    <button role="menuitem" data-x="steps"><span>Add step</span></button>
    <button role="menuitem" data-x="open"><span>Open task</span><kbd>↵</kbd></button>`;
  document.body.appendChild(m);
  m.style.left = `${Math.max(8, Math.min(r.left - 140, innerWidth - m.offsetWidth - 12))}px`;
  m.style.top = `${Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 12)}px`;

  m.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      closeMenu();
      if (b.dataset.x === 'open') return openTask(id);
      // The way in for a task with no steps yet: there is no chip to click,
      // because a chip on every task would be noise on the ones that have none.
      if (b.dataset.x === 'steps') return expandSteps(id);
      if (b.dataset.b) return moveTask(id, b.dataset.b);
      // Ordering must not be drag-only: keyboard and touch users reorder here.
      if (b.dataset.n) return nudge(id, Number(b.dataset.n));
      const list = inBucket(t.bucket).filter((x) => x.id !== id);
      if (!list.length) return;
      moveTask(id, t.bucket, b.dataset.o === 'top'
        ? { beforeTaskId: list[0].id } : { afterTaskId: list[list.length - 1].id });
    };
  });
  m.querySelector('button:not([disabled])')?.focus();
  state.menu = m;
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() { state.menu?.remove(); state.menu = null; }

/* ── Task modal ──────────────────────────────────────────────────────── */
function openTask(id, prefillTitle = '') {
  const t = id ? findTask(id) : null;
  /*
   * An id that resolves to nothing is a BUG, not a request for a new task.
   *
   * The create path is reached by calling `openTask()` with no id at all.
   * Falling into it because a lookup missed is how Completed history came to
   * open a blank Create Task form for a task that existed the whole time.
   */
  if (id && !t) return openMissingTask(id);
  const ctl = openTaskModal({
    task: t,
    areas: state.me.areas,
    prefillTitle,
    onSave: async (body) => {
      if (t) {
        const before = { ...t };
        Object.assign(t, body);
        const bucketChanged = before.bucket !== body.bucket;
        if (bucketChanged) {
          flip(document.querySelectorAll('.task'), () => {
            rebuildBucket(before.bucket); rebuildBucket(body.bucket);
          });
          wireBoard();
        } else patchCard(t.id);
        renderRail();
        try {
          await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}`, { method: 'PATCH', body });
          saved();
        } catch (e) {
          Object.assign(t, before);
          rebuildBucket(before.bucket); rebuildBucket(body.bucket);
          wireBoard(); renderRail();
          throw e;
        }
      } else {
        const r = await api(`/api/v1/workspaces/${ws()}/tasks`, { method: 'POST', body });
        const created = { ...r.task, steps: [] };
        state.tasks.push(created);
        await placeNewTask(created);
        flip(document.querySelectorAll('.task'), () => rebuildBucket(created.bucket));
        wireBoard(); renderRail();
        saved('Task created');
      }
    },
    // One write carrying both the edits and the completion. See the modal.
    onToggle: (dirty) => toggleTask(t.id, dirty),
    onArchive: async () => {
      const bucket = t.bucket;
      state.tasks = state.tasks.filter((x) => x.id !== t.id);
      rebuildBucket(bucket); wireBoard(); renderRail();
      try {
        await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/archive`, { method: 'POST' });
        saved('Archived');
      } catch (e) { toast(e.message, true); }
    },
    onDelete: async () => {
      const bucket = t.bucket;
      state.tasks = state.tasks.filter((x) => x.id !== t.id);
      rebuildBucket(bucket); wireBoard(); renderRail();
      try {
        await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}`, { method: 'DELETE' });
        saved('Deleted');
      } catch (e) { toast(e.message, true); }
    },
    steps: t ? taskStepsCtx(t, () => syncTaskEverywhere(t.id)) : null,
    onRestore: t ? () => restoreTask(t.id) : null,
  });
}

/**
 * Fetches a task the client does not have in memory, then opens it.
 *
 * The safety net for the case above: rather than guessing, ask the server for
 * the record by id. Reached when a task is opened from a surface whose list
 * has not been loaded — and it fails out loud rather than showing a blank form
 * that looks like a feature.
 */
async function openMissingTask(id) {
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/tasks/${id}`);
    if (!r.task) throw new Error('That task no longer exists.');
    // Parked in history so `findTask` can resolve it from here on.
    if (!state.history.some((x) => x.id === id)) state.history.unshift(r.task);
    openTask(id);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * Step handlers for a task editor, built once for every context that can open
 * one.
 *
 * They used to be written inline in `openTask`, and ONLY there. Both Projects
 * call sites passed no `steps` at all, so `ctx.steps.add(...)` threw
 * "Cannot read properties of undefined" into an unhandled rejection — the step
 * silently never appeared and nothing was logged where a user would see it.
 * Steps were completely dead in Projects. A factory means the next caller
 * cannot forget.
 *
 * `onChanged` repaints whatever surface the editor was opened from — a Today
 * card, a project row — so the `2/4 steps` chip stays true. The editor repaints
 * its own list; it no longer closes and reopens itself to show one new row.
 */
function taskStepsCtx(task, onChanged = () => {}) {
  const url = (sid) => `/api/v1/workspaces/${ws()}/tasks/${task.id}/steps`
    + (sid ? `/${sid}` : '');
  return {
    add: async (title) => {
      const r = await api(url(), { method: 'POST', body: { title } });
      task.steps = [...(task.steps ?? []), r.step];
      onChanged();
      saved('Step added');
    },
    toggle: async (sid, completed) => {
      const s = (task.steps ?? []).find((x) => x.id === sid);
      const before = s?.completed;
      if (s) s.completed = completed;
      onChanged();
      try {
        await api(url(sid), { method: 'PATCH', body: { completed } });
      } catch (e) {
        if (s) s.completed = before;          // put it back, visibly
        onChanged();
        throw e;
      }
    },
    rename: async (sid, title) => {
      const s = (task.steps ?? []).find((x) => x.id === sid);
      const before = s?.title;
      if (s) s.title = title;
      try {
        await api(url(sid), { method: 'PATCH', body: { title } });
        saved();
      } catch (e) {
        if (s) s.title = before;
        onChanged();
        throw e;
      }
    },
    remove: async (sid) => {
      const before = task.steps ?? [];
      task.steps = before.filter((x) => x.id !== sid);
      onChanged();
      try {
        await api(url(sid), { method: 'DELETE' });
        saved('Step removed');
      } catch (e) {
        task.steps = before;
        onChanged();
        throw e;
      }
    },
  };
}

/* ── Right rail ──────────────────────────────────────────────────────────
 * Two things only: what to do next, and today's habits.
 *
 * Quick Capture was removed — "Add task" already exists two feet away, task
 * creation was never the hard part, and the future composer is the real
 * natural-language capture path. A second form was noise.
 *
 * Space below Habits is deliberately left empty. It is where Upcoming
 * (calendar + reminders) lands, and filling it now with something invented
 * would be worse than an honest gap.
 */

/**
 * Up Next was removed in C4.1, deliberately and not as a stopgap.
 *
 * A next-action recommendation is only honest when the system can see what the
 * day actually contains. Life OS cannot yet: there is no Calendar, no
 * Reminders, no scheduled times, no due dates on the imported tasks and no
 * project deadlines. What Up Next produced was therefore a restatement of the
 * first card already visible on the board — the appearance of intelligence
 * without any.
 *
 * ARCHITECTURE NOTE, kept for whoever restores it. A real Up Next should rank
 * against, at minimum:
 *   - calendar events happening now or imminently
 *   - scheduled task times and due dates
 *   - reminders that have fired
 *   - habits still open for the day
 *   - project deadlines
 *   - the user's stated focus
 *   - AI-derived context about the week
 * Restore it only once Calendar and Reminders exist. Until then the rail is
 * intentionally short: an empty column is more honest than a filler card, and
 * the space below Habits is reserved for Upcoming.
 */

function renderRail() {
  const rail = document.getElementById('rail');
  if (!rail || !state.me) return;
  // The rail belongs to the route. Habits are the Today rail; Calendar has its
  // own, which changes by mode. Without this guard the deferred habit load
  // clobbered the Calendar rail a moment after it rendered.
  if (state.route === 'calendar') return renderCalendarRail();
  const now = new Date();
  const hs = state.habits ?? [];
  const due = hs.filter((h) => h.dueToday && !h.archivedAt);
  const doneCount = due.filter((h) => h.completedToday).length;

  rail.innerHTML = `
    <div class="rail-when">
      <span class="rw-day">${now.toLocaleDateString(undefined, { weekday: 'long' })}</span>
      <span class="rw-date">${now.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}</span>
    </div>

    <div class="rail-card habits-card">
      <h3>Habits today${due.length ? ` <span class="hb-count">${doneCount}/${due.length}</span>` : ''}
        <button class="hb-add" id="hb-add" aria-label="Add a habit" title="Add a habit">+</button></h3>
      ${!state.habitsLoaded ? '<p class="rail-quiet">Loading…</p>'
        : state.habitsError ? `<p class="rail-quiet" style="color:var(--danger)">
             Could not load habits.<br><span style="color:var(--muted)">${esc(state.habitsError)}</span>
             <button class="rail-link" id="hb-retry">Try again</button></p>`
        : due.length ? `<div class="hb-list">${due.map(habitRowHtml).join('')}</div>`
        : hs.length ? '<p class="rail-quiet">Nothing due today.</p>'
        : '<p class="rail-quiet">No habits yet. Add one to start building a streak.</p>'}
    </div>`;

  wireRail();
}

/**
 * The habit row: a closed progress ring, the name, the streak.
 *
 * Geometry notes, because all three were wrong before:
 *
 * 1. `pathLength="100"` re-declares the path's length as 100 user units, so
 *    dasharray/dashoffset are exact percentages. The previous code hard-coded
 *    2*PI*13 = 81.68, but a browser draws <circle> as four Bezier arcs whose
 *    real length is 81.155 — every partial fill was off and the seam misjoined.
 * 2. The ring <svg> carries `.hr-svg`, and the CSS targets `.hb-ring>svg.hr-svg`.
 *    The old unscoped `.hb-ring svg` also hit the check icon inside .hr-mark and
 *    forced it to 32px, absolute and rotated -90deg — the "arrow tail".
 * 3. Butt caps. A round cap adds half the stroke width beyond each end, which
 *    overshoots the seam at 100% and paints a floating dot at 0%.
 */
function habitPct(h) {
  const target = Math.max(1, h.targetCount ?? 1);
  if (target > 1) return Math.min(1, (h.todayCount ?? 0) / target);
  return h.completedToday ? 1 : 0;
}

/** Centre content: check when complete, count while partial, nothing at zero. */
function habitCentre(h) {
  const target = Math.max(1, h.targetCount ?? 1);
  if (h.completedToday) return `<span class="hr-mark">${icon('check', 14)}</span>`;
  if (target > 1 && (h.todayCount ?? 0) > 0) {
    return `<span class="hr-count">${h.todayCount}</span>`;
  }
  return '<span class="hr-mark"></span>';
}

function streakHtml(h) {
  const n = h.streak ?? 0;
  return `<span class="hb-streak ${n > 0 ? '' : 'is-zero'}"
    title="${n > 0 ? `${n} day streak` : 'No streak yet — today can start one'}"
    >${n > 0 ? `${n}<span class="hs-unit">d</span>` : '—'}</span>`;
}

function habitRowHtml(h) {
  const pct = habitPct(h);
  const target = Math.max(1, h.targetCount ?? 1);
  const label = h.completedToday ? 'Undo' : (target > 1 ? 'Add one to' : 'Complete');
  return `<div class="hb-row ${h.completedToday ? 'is-done' : ''}" data-habit="${h.id}">
    <button class="hb-ring" data-habit-toggle="${h.id}" aria-pressed="${!!h.completedToday}"
      aria-label="${label} ${esc(h.name)}"
      ${target > 1 ? `aria-valuenow="${h.todayCount ?? 0}" aria-valuemax="${target}"` : ''}>
      <svg class="hr-svg" viewBox="0 0 32 32" aria-hidden="true">
        <circle class="hr-track" cx="16" cy="16" r="13" pathLength="100"/>
        <circle class="hr-fill ${pct === 0 ? 'is-empty' : ''}" cx="16" cy="16" r="13"
          pathLength="100" stroke-dasharray="100"
          stroke-dashoffset="${(100 - pct * 100).toFixed(2)}"/>
      </svg>
      ${habitCentre(h)}
    </button>
    <button class="hb-name" data-habit-open="${h.id}" title="Edit ${esc(h.name)}">${esc(h.name)}</button>
    ${target > 1 ? `<span class="hb-prog">${h.todayCount ?? 0}/${target}</span>` : ''}
    ${streakHtml(h)}
  </div>`;
}

function wireRail() {
  const rail = document.getElementById('rail');
  rail.querySelector('#hb-retry')?.addEventListener('click',
    () => run(async () => { await loadHabits(); renderRail(); }));
  rail.querySelector('#hb-add')?.addEventListener('click', () => editHabit(null));

  rail.querySelectorAll('[data-habit-toggle]').forEach((el) => {
    el.onclick = () => toggleHabit(el.dataset.habitToggle);
  });
  rail.querySelectorAll('[data-habit-open]').forEach((el) => {
    el.onclick = () => editHabit(el.dataset.habitOpen);
  });
}

/* ── Habits ──────────────────────────────────────────────────────────── */
async function loadHabits() {
  state.habitsError = null;
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/habits?includeArchived=true&historyDays=14`);
    state.habits = r.habits ?? [];
  } catch (e) {
    // Must not take Today down — and must NOT masquerade as "no habits".
    state.habits = [];
    state.habitsError = e.message;
    console.error('[habits] load failed:', e);
  }
  state.habitsLoaded = true;
}

/**
 * Updates ONE habit row IN PLACE.
 *
 * Deliberately not `outerHTML =`. Replacing the node gives the browser a brand
 * new <circle> already sitting at its final stroke-dashoffset, so the CSS
 * transition has no start value to interpolate from and the ring snaps instead
 * of filling. Measured: 60ms after a click the offset was already final.
 * Mutating the existing nodes is what makes the fill animate at all.
 */
function patchHabitRow(id) {
  const row = document.querySelector(`.hb-row[data-habit="${id}"]`);
  const h = (state.habits ?? []).find((x) => x.id === id);
  if (!row || !h) return renderRail();

  const target = Math.max(1, h.targetCount ?? 1);
  const pct = habitPct(h);

  row.classList.toggle('is-done', !!h.completedToday);

  const fill = row.querySelector('.hr-fill');
  if (fill) {
    // Toggle emptiness BEFORE the offset so the fade and the sweep run together.
    fill.classList.toggle('is-empty', pct === 0);
    fill.setAttribute('stroke-dashoffset', (100 - pct * 100).toFixed(2));
  }

  const ring = row.querySelector('.hb-ring');
  ring?.setAttribute('aria-pressed', String(!!h.completedToday));
  ring?.setAttribute('aria-label',
    `${h.completedToday ? 'Undo' : (target > 1 ? 'Add one to' : 'Complete')} ${h.name}`);
  if (target > 1) ring?.setAttribute('aria-valuenow', String(h.todayCount ?? 0));

  // Centre content is the only part that genuinely changes shape.
  const centre = row.querySelector('.hr-mark,.hr-count');
  const wanted = habitCentre(h);
  if (centre && centre.outerHTML !== wanted) centre.outerHTML = wanted;

  const prog = row.querySelector('.hb-prog');
  if (prog) prog.textContent = `${h.todayCount ?? 0}/${target}`;

  const streak = row.querySelector('.hb-streak');
  if (streak) streak.outerHTML = streakHtml(h);

  // The header tally stays honest without redrawing the card.
  const due = (state.habits ?? []).filter((x) => x.dueToday && !x.archivedAt);
  const badge = document.querySelector('.hb-count');
  if (badge) {
    const text = `${due.filter((x) => x.completedToday).length}/${due.length}`;
    if (badge.textContent !== text) { badge.textContent = text; pulse(badge); }
  }
}

/**
 * Optimistic tick with rollback. A checkbox must never wait on a round trip.
 *
 * For a target-count habit each press adds one, and only the last one completes
 * it. Pressing a completed habit clears it back to zero — an "undo", not a
 * decrement, which is what the ring's full-to-empty sweep reads as.
 */
async function toggleHabit(id) {
  const h = (state.habits ?? []).find((x) => x.id === id);
  if (!h || h._busy) return;
  const target = Math.max(1, h.targetCount ?? 1);
  const before = {
    todayCount: h.todayCount, completedToday: h.completedToday, streak: h.streak,
  };

  const wasDone = !!h.completedToday;
  const nextCount = wasDone ? 0 : Math.min(target, (h.todayCount ?? 0) + 1);
  const nowDone = nextCount >= target;

  h.todayCount = nextCount;
  h.completedToday = nowDone;
  // The streak only moves when completion itself changes.
  if (nowDone !== wasDone) {
    h.streak = nowDone ? (h.streak ?? 0) + 1 : Math.max(0, (h.streak ?? 1) - 1);
  }
  h._busy = true;
  patchHabitRow(id);
  if (nowDone && !wasDone) celebrateHabit(id);

  try {
    const r = await api(
      `/api/v1/workspaces/${ws()}/habits/${id}/${wasDone ? 'uncheck' : 'check'}`,
      { method: 'POST', body: wasDone ? {} : { count: nextCount } },
    );
    // Adopt the server's numbers; they are the truth.
    h.todayCount = r.completedCount ?? h.todayCount;
    h.completedToday = r.completed ?? h.completedToday;
    if (typeof r.streak === 'number') h.streak = r.streak;
  } catch (e) {
    Object.assign(h, before);
    toast(e.message, true);
  } finally {
    h._busy = false;
    patchHabitRow(id);
  }
}

/**
 * A single restrained response on completion — one soft pulse of the ring.
 * No confetti, no particles, no bounce.
 */
function celebrateHabit(id) {
  if (reducedMotion()) return;
  const ring = document.querySelector(`.hb-row[data-habit="${id}"] .hb-ring`);
  ring?.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.10)' }, { transform: 'scale(1)' }],
    { duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)' },
  );
}

/** Recent-history dots for the habit modal, oldest first. */
function recentDays(h) {
  const done = new Set((h.recentDates ?? []));
  const out = [];
  const d = new Date();
  for (let i = 13; i >= 0; i--) {
    const day = new Date(d);
    day.setDate(d.getDate() - i);
    const iso = day.toISOString().slice(0, 10);
    out.push({
      done: done.has(iso) || (i === 0 && h.completedToday),
      label: day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
    });
  }
  return out;
}

function editHabit(id) {
  const h = id ? (state.habits ?? []).find((x) => x.id === id) : null;
  openHabitModal({
    habit: h,
    areas: state.me.areas,
    recent: h ? recentDays(h) : [],
    onSave: async (body) => {
      if (h) {
        await api(`/api/v1/workspaces/${ws()}/habits/${h.id}`, { method: 'PATCH', body });
      } else {
        await api(`/api/v1/workspaces/${ws()}/habits`, { method: 'POST', body });
      }
      await loadHabits(); renderRail();
      saved(h ? 'Habit saved' : 'Habit added');
    },
    onArchive: async () => {
      await api(`/api/v1/workspaces/${ws()}/habits/${h.id}`, { method: 'DELETE' });
      await loadHabits(); renderRail();
      saved('Archived. Its history was kept.');
    },
    onRestore: async () => {
      await api(`/api/v1/workspaces/${ws()}/habits/${h.id}`,
        { method: 'PATCH', body: { isActive: true } });
      await loadHabits(); renderRail();
      saved('Restored');
    },
    onDelete: async () => {
      await api(`/api/v1/workspaces/${ws()}/habits/${h.id}?permanent=true`, { method: 'DELETE' });
      await loadHabits(); renderRail();
      saved('Deleted');
    },
  });
}

/* ── Placeholders ────────────────────────────────────────────────────── */
const placeholderHtml = (route, ph) => `<div class="placeholder rise">
  <div class="ph-ico">${icon(route.icon, 26)}</div>
  <h2>${esc(route.label)} is coming</h2>
  <p>${esc(ph.body)}</p>
  <p class="ph-note">${esc(ph.note)}</p>
</div>`;

/* ── Settings ────────────────────────────────────────────────────────── */
function wireSettings() {
  document.querySelectorAll('[data-stab]').forEach((el) => {
    el.onclick = () => { state.settingsTab = el.dataset.stab; renderSettings(); };
  });

  document.querySelectorAll('[data-pref]').forEach((el) => {
    el.onclick = () => run(async () => {
      const { pref, value } = el.dataset;
      const r = await api('/api/v1/preferences', { method: 'PUT', body: { [pref]: value } });
      state.prefs = r.preferences;
      applyPreferences();
      renderSettings();
      toast('Saved');
    });
  });

  document.getElementById('sign-out')?.addEventListener('click', () => window.__signOut?.());

  // Areas — rename on blur, remove with confirmation, add inline.
  document.querySelectorAll('[data-area-name]').forEach((el) => {
    const id = el.dataset.areaName;
    const original = el.value;
    const save = () => run(async () => {
      const name = el.value.trim();
      if (!name || name === original) { el.value = original; return; }
      await api(`/api/v1/workspaces/${ws()}/areas/${id}`, { method: 'PATCH', body: { name } });
      state.me = await api('/api/v1/me');
      renderSettings(); renderRail();
      toast('Area renamed');
    });
    el.onblur = save;
    el.onkeydown = (e) => { if (e.key === 'Enter') el.blur(); if (e.key === 'Escape') el.value = original; };
  });

  document.querySelectorAll('[data-area-del]').forEach((el) => {
    el.onclick = () => run(async () => {
      const id = el.dataset.areaDel;
      const area = state.me.areas.find((a) => a.id === id);
      const n = state.tasks.filter((t) => t.areaId === id).length;
      const msg = n
        ? `Remove "${area.name}"? Its ${n} task${n === 1 ? '' : 's'} will stay — they just lose this label.`
        : `Remove "${area.name}"?`;
      if (!confirm(msg)) return;
      await api(`/api/v1/workspaces/${ws()}/areas/${id}`, { method: 'DELETE' });
      state.me = await api('/api/v1/me');
      await loadTasks();
      renderSettings(); renderRail();
      toast('Area removed. Its tasks were kept.');
    });
  });

  const addArea = () => run(async () => {
    const input = document.getElementById('new-area');
    const name = input.value.trim();
    if (!name) return;
    await api(`/api/v1/workspaces/${ws()}/areas`, { method: 'POST', body: { name } });
    state.me = await api('/api/v1/me');
    renderSettings(); renderRail();
    toast('Area added');
  });
  document.getElementById('add-area')?.addEventListener('click', addArea);
  document.getElementById('new-area')?.addEventListener('keydown',
    (e) => { if (e.key === 'Enter') addArea(); });

  // Habits management
  document.querySelectorAll('[data-habit-name]').forEach((el) => {
    const id = el.dataset.habitName;
    const original = el.value;
    el.onblur = () => run(async () => {
      const name = el.value.trim();
      if (!name || name === original) { el.value = original; return; }
      await api(`/api/v1/workspaces/${ws()}/habits/${id}`, { method: 'PATCH', body: { name } });
      await loadHabits(); renderSettings(); renderRail();
      toast('Habit renamed');
    });
    el.onkeydown = (e) => { if (e.key === 'Enter') el.blur(); if (e.key === 'Escape') el.value = original; };
  });
  document.querySelectorAll('[data-habit-freq]').forEach((el) => {
    el.onchange = () => run(async () => {
      await api(`/api/v1/workspaces/${ws()}/habits/${el.dataset.habitFreq}`,
        { method: 'PATCH', body: { frequencyType: el.value } });
      await loadHabits(); renderSettings(); renderRail();
      toast('Schedule updated');
    });
  });
  document.querySelectorAll('[data-habit-archive]').forEach((el) => {
    el.onclick = () => run(async () => {
      const h = (state.habits ?? []).find((x) => x.id === el.dataset.habitArchive);
      if (!confirm(`Archive "${h?.name}"? Its history is kept and it stops appearing on Today.`)) return;
      await api(`/api/v1/workspaces/${ws()}/habits/${el.dataset.habitArchive}`, { method: 'DELETE' });
      await loadHabits(); renderSettings(); renderRail();
      toast('Habit archived. Its history was kept.');
    });
  });
  const addHabit = () => run(async () => {
    const input = document.getElementById('new-habit');
    const name = input.value.trim();
    if (!name) return;
    await api(`/api/v1/workspaces/${ws()}/habits`, { method: 'POST', body: { name } });
    await loadHabits(); renderSettings(); renderRail();
    toast('Habit added');
  });
  document.getElementById('add-habit')?.addEventListener('click', addHabit);
  document.getElementById('new-habit')?.addEventListener('keydown',
    (e) => { if (e.key === 'Enter') addHabit(); });

  document.getElementById('do-install')?.addEventListener('click', () => run(async () => {
    const ok = await window.__promptInstall?.();
    if (ok) { renderSettings(); toast('Life OS installed'); }
  }));
  document.getElementById('check-update')?.addEventListener('click', () => run(async () => {
    const el = document.getElementById('update-status');
    el.textContent = 'Checking…';
    const found = await window.__checkForUpdate?.();
    el.textContent = found ? 'An update is ready — see the prompt.' : 'You are on the latest version.';
  }));
}

function renderSettings() {
  document.getElementById('main-scroll').innerHTML = settingsHtml(state);
  wireSettings();
}

initAuth();

/* ══ Calendar ═══════════════════════════════════════════════════════════
 * Month, Agenda and Plan share one range request — they differ in how they
 * present time, not in what they can see. Layers filter client-side, so
 * toggling one never costs a round trip.
 *
 * All data is synthetic in this phase; no Google account is connected. */
async function loadCalendar() {
  // Restore the last mode once, before anything renders, so the pill is right
  // on the first frame rather than snapping after a flash of Month.
  if (!cal.restored) {
    cal.restored = true;
    const saved_ = localStorage.getItem('los2_cal_mode');
    if (MODE_IDS.includes(saved_)) cal.mode = saved_;
  }
  // The URL is the source of truth for which surface is open, so a refresh on
  // #calendar/reminders opens reminders rather than Month.
  cal.utility = utilityFromHash();
  if (cal.utility === 'reminders' && !cal.reminders) await loadReminders();
  const head = document.getElementById('page-head');
  const scroll = document.getElementById('main-scroll');
  if (head) head.innerHTML = calendarHeaderHtml();
  cal.loading = !cal.data;
  scroll.innerHTML = calendarBodyHtml();
  wireCalendarHeader();

  try {
    const r = currentRange();
    const [range, open, integration] = await Promise.all([
      api(`/api/v1/workspaces/${ws()}/calendar/range?from=${r.from}&to=${r.to}`),
      api(`/api/v1/workspaces/${ws()}/tasks?status=open&limit=50`).catch(() => ({ tasks: [] })),
      api(`/api/v1/workspaces/${ws()}/integrations/google-calendar`)
        .catch(() => ({ configured: false, connection: null })),
    ]);
    range.connection = integration.connection;
    range.googleConfigured = integration.configured;
    cal.areas = state.me?.areas ?? [];
    // The planning queue is tasks with no block in view — Plan's whole purpose.
    const scheduled = new Set(range.blocks.map((b) => b.taskId));
    range.unscheduled = (open.tasks ?? []).filter((t) => !scheduled.has(t.id) && !t.dueDate);
    cal.data = range;
    cal.error = null;
  } catch (e) {
    cal.error = e.message;
  }
  cal.loading = false;
  if (state.route !== 'calendar') return;
  startCalendarLive();
  scroll.innerHTML = cal.utility === 'reminders'
    ? remindersViewHtml(cal.reminders ?? [], cal.reminderFilter, areaName)
    : calendarBodyHtml();
  applyCanvasEnter(scroll);
  if (cal.utility === 'reminders') wireRemindersView(); else wireCalendar();
  renderCalendarRail();

  // Returning from Google: the callback stored the connection and the calendar
  // list, but not the events — a long import must not hold the redirect open.
  // Run that first sync here instead, so connecting produces a calendar with
  // things in it rather than an empty grid and an unexplained "Sync now".
  const back = new URLSearchParams(location.hash.split('?')[1] ?? '');
  if (back.get('calendar') === 'connected' && !cal.firstSyncDone) {
    cal.firstSyncDone = true;
    history.replaceState(null, '', '#calendar');
    await syncGoogle();
  } else if (back.get('calendar') === 'error') {
    history.replaceState(null, '', '#calendar');
    toast(connectErrorMessage(back.get('reason')), true);
  }
}

/* ── Keeping the calendar current ───────────────────────────────────────
 * The Calendar is a window onto data that changes without us: Google events
 * land from other devices, and once this app can create events it will need to
 * see its own writes from a second tab. A view that is only correct at the
 * moment you opened it is not a calendar.
 *
 * Two cadences, deliberately different. The range is cheap and local, so it is
 * re-read often. A Google sync costs an API round trip against a quota, so it
 * runs rarely — and it is incremental, so "rarely" is enough.
 *
 * The hard requirement is that none of this is VISIBLE when nothing changed.
 * A refresh that repaints on a timer makes the page flicker every minute and
 * throws away scroll position, which is worse than being a minute stale. So a
 * refresh compares the new data against the old and repaints only on a real
 * difference. */
const CAL_POLL_MS = 45_000;         // re-read the range while the tab is watched
const CAL_SYNC_MS = 5 * 60_000;     // ask Google what changed
const CAL_STALE_MS = 20_000;        // "you have been away" threshold
let calTimers = [];
let calLastSync = 0;

/**
 * A cheap fingerprint of everything the canvas draws.
 *
 * Deliberately NOT the whole response: `connection.lastSyncedAt` moves on every
 * sync, so hashing the raw payload would report a change every time and repaint
 * for nothing.
 */
function calendarSignature(d) {
  if (!d) return '';
  const part = (list, keys) => (list ?? [])
    .map((x) => keys.map((k) => x[k] ?? '').join('')).join('');
  return [
    part(d.events, ['id', 'title', 'startsAt', 'endsAt', 'startDate', 'endDate',
      'isAllDay', 'calendarId', 'updatedAt']),
    part(d.reminders, ['id', 'title', 'dueDate', 'dueTime', 'status', 'occurrenceDate']),
    part(d.deadlines, ['id', 'title', 'dueDate', 'status']),
    part(d.blocks, ['id', 'taskId', 'startsAt', 'endsAt']),
    part(d.habitDays, ['habitId', 'entryDate', 'status']),
    part(d.calendars, ['id', 'isVisible', 'color']),
  ].join('');
}

/**
 * Re-reads the current range and repaints only if something actually moved.
 *
 * Never shows a loading state: this is a background correction, not a
 * navigation. If the network is down it stays quiet — the data on screen is
 * still the best available answer, and a toast every 45 seconds would be a
 * worse experience than being stale.
 */
async function refreshCalendar() {
  if (state.route !== 'calendar' || cal.utility !== 'none' || !cal.data) return;
  const r = currentRange();
  try {
    const [range, open, integration] = await Promise.all([
      api(`/api/v1/workspaces/${ws()}/calendar/range?from=${r.from}&to=${r.to}`),
      api(`/api/v1/workspaces/${ws()}/tasks?status=open&limit=50`).catch(() => ({ tasks: [] })),
      api(`/api/v1/workspaces/${ws()}/integrations/google-calendar`)
        .catch(() => ({ configured: false, connection: null })),
    ]);
    // The range may have moved under us while the request was in flight.
    const now = currentRange();
    if (state.route !== 'calendar' || now.from !== r.from || now.to !== r.to) return;

    range.connection = integration.connection;
    range.googleConfigured = integration.configured;
    const scheduled = new Set(range.blocks.map((b) => b.taskId));
    range.unscheduled = (open.tasks ?? []).filter((t) => !scheduled.has(t.id) && !t.dueDate);

    const changed = calendarSignature(range) !== calendarSignature(cal.data);
    cal.data = range;
    if (!changed) { renderCalendarRail(); return; }
    const scroller = document.getElementById('main-scroll');
    const top = scroller?.scrollTop ?? 0;
    paintCalendar();
    if (scroller) scroller.scrollTop = top;
  } catch { /* stay quiet and try again on the next tick */ }
}

/** An incremental Google pull, without the toast a manual sync earns. */
async function syncCalendarQuietly() {
  if (!cal.data?.connection || cal.data.connection.status === 'syncing') return;
  if (Date.now() - calLastSync < CAL_SYNC_MS) return;
  calLastSync = Date.now();
  try {
    await api(`/api/v1/workspaces/${ws()}/integrations/google-calendar/sync`, { method: 'POST' });
    await refreshCalendar();
  } catch { /* the next tick will try again */ }
}

function startCalendarLive() {
  stopCalendarLive();
  const tick = () => { if (document.visibilityState === 'visible') refreshCalendar(); };
  const sync = () => { if (document.visibilityState === 'visible') syncCalendarQuietly(); };
  calTimers.push(setInterval(tick, CAL_POLL_MS), setInterval(sync, CAL_SYNC_MS));

  // Coming back to the tab is the moment a stale calendar is most obvious, and
  // the moment a poll is most likely to have been throttled away.
  let leftAt = 0;
  const onVisible = () => {
    if (document.visibilityState !== 'visible') { leftAt = Date.now(); return; }
    if (Date.now() - leftAt > CAL_STALE_MS) { refreshCalendar(); syncCalendarQuietly(); }
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  calTimers.push(() => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
  });
}

function stopCalendarLive() {
  calTimers.forEach((t) => (typeof t === 'function' ? t() : clearInterval(t)));
  calTimers = [];
}

/** Google failures explained in product terms, not error codes. */
function connectErrorMessage(reason) {
  return {
    declined: 'You did not approve access, so nothing was connected.',
    expired_state: 'That took too long. Try connecting again.',
    scope_not_granted: 'Google did not grant calendar read access. Try again and '
      + 'leave the calendar permission ticked.',
    no_lasting_grant: 'Google did not return a lasting grant. Try connecting again.',
    not_configured: 'Google Calendar is not configured on this server yet.',
  }[reason] ?? 'Could not finish connecting to Google Calendar.';
}

/** Re-renders ONLY the calendar canvas — never the whole route. */
function paintCalendar() {
  closeHoverPreview();
  const scroll = document.getElementById('main-scroll');
  const period = document.getElementById('cal-period');
  if (period) period.textContent = periodLabelSafe();
  // Respect the sub-view. Painting only the calendar body here is what made
  // the Reminders button toggle its own state and change nothing else.
  if (cal.utility === 'reminders') {
    scroll.innerHTML = remindersViewHtml(cal.reminders ?? [], cal.reminderFilter, areaName);
    wireRemindersView();
  } else {
    scroll.innerHTML = calendarBodyHtml();
    wireCalendar();
  }
  renderCalendarRail();
}

/**
 * Marks the canvas so it enters from the direction you travelled.
 *
 * The class is applied to the CANVAS, not the scroll region, so the header and
 * rail stay put — only the thing that actually changed moves.
 */
function applyCanvasEnter(scroll) {
  // The mode canvas, not the frame — animating the frame would drag the rail
  // in from the side along with the month.
  const canvas = scroll.querySelector('.cal-canvas')?.firstElementChild;
  if (!canvas || !cal.enter) { cal.enter = null; return; }
  const cls = { next: 'cal-canvas-next', prev: 'cal-canvas-prev', mode: 'cal-canvas-mode' }[cal.enter];
  if (cls) canvas.classList.add(cls);
  cal.enter = null;
}
const periodLabelSafe = () => {
  const el = document.createElement('div');
  el.innerHTML = calendarHeaderHtml();
  return el.querySelector('#cal-period')?.textContent ?? '';
};

/** --d-slow. The structural half of the rail transition. */
const RAIL_MS = 260;

/**
 * Renders the rail and, when its open state changed, animates the frame.
 *
 * §9/§10 The canvas makes room; it does not teleport. Opening: content is put
 * in place invisible, the column widens over one transition, the content fades
 * in behind it. Closing: the content fades FIRST, then the column collapses,
 * and only after that is the markup cleared — clearing it up front is what made
 * the rail vanish and the grid snap.
 *
 * The node identity of #cal-body and #cal-rail-in is preserved throughout, so
 * the transition has something continuous to run on. Rebuilding them here is
 * what would silently turn this back into a jump.
 */
function renderCalendarRail() {
  const open = railIsOpen();
  // On the body, because the header reads it too: the mode selector tracks the
  // canvas centre, and the canvas centre is a function of the rail.
  document.body.classList.toggle('cal-rail-open', open);
  const body = document.getElementById('cal-body');
  const rail = document.getElementById('cal-rail-in');
  if (!body || !rail) return;          // a utility workspace — no frame at all
  const wasOpen = body.classList.contains('has-rail');

  if (!open) {
    if (!wasOpen) { body.classList.remove('rail-shown'); rail.innerHTML = ''; return; }
    body.classList.remove('rail-shown');           // content fades…
    body.classList.remove('has-rail');             // …while the column collapses
    // Cleared only once the column has finished collapsing — otherwise the rail
    // blinks out and the grid is left snapping into the gap.
    afterTransition(body, 'grid-template-columns', RAIL_MS, () => {
      if (!body.isConnected || body.classList.contains('has-rail')) return;
      rail.innerHTML = '';
    });
    return;
  }

  // Only the contextual band is swapped when the mode changes; the context
  // and attention cards keep their nodes, so the rail never flashes.
  const prevMode = rail.querySelector('[data-rail-ctx]')?.dataset.railCtx;
  rail.innerHTML = calendarRailHtml();
  if (!wasOpen) {
    body.classList.add('has-rail');
    // The fade is deliberately a frame behind the structural move, so the eye
    // follows the canvas making room rather than text appearing in mid-air.
    if (reducedMotion()) body.classList.add('rail-shown');
    else requestAnimationFrame(() => requestAnimationFrame(() =>
      body.classList.add('rail-shown')));
  } else {
    body.classList.add('rail-shown');
  }
  const ctx = rail.querySelector('[data-rail-ctx]');
  if (ctx && prevMode && prevMode !== cal.mode && !reducedMotion()) {
    ctx.animate([{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }],
      { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
  rail.querySelectorAll('[data-day]').forEach((el) => {
    el.onclick = () => selectDay(el.dataset.day);
  });
  rail.querySelectorAll('[data-event]').forEach((el) => {
    el.onclick = () => openEvent(el.dataset.event);
  });
  const addDay = rail.querySelector('[data-cal-add-day]');
  addDay?.addEventListener('click', () => calendarAddMenu(addDay, addDay.dataset.calAddDay));

  const srcBtn = rail.querySelector('#cal-sources');
  srcBtn?.addEventListener('click', () => toggleSources(srcBtn));
  rail.querySelector('#cal-sync-retry')?.addEventListener('click', () => syncGoogle());
  // Every insight is clickable — an observation you cannot act on is a stat.
  rail.querySelectorAll('[data-insight]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.insight === 'reminders') return openRemindersView();
      cal.mode = 'plan';
      cal.utility = 'none';
      localStorage.setItem('los2_cal_mode', 'plan');
      loadCalendar();
    };
  });
  rail.querySelectorAll('[data-schedule]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); scheduleFromQueue(b.dataset.schedule); };
  });
  rail.querySelectorAll('[data-habit]').forEach((b) => {
    b.onclick = () => toggleHabitOn(b.dataset.habit, b.dataset.habitDay);
  });
}

/* ── Habits on a chosen day ───────────────────────────────────────────── */

/**
 * Loads the selected day's habits.
 *
 * `date` is passed straight through as the string the grid drew. It is never
 * turned into a Date and back — that round trip is exactly how a tick lands on
 * the previous day for anyone west of UTC.
 *
 * The response is discarded if the selection moved on while it was in flight,
 * so a slow request cannot paint the 3rd's habits into the 4th's card.
 */
async function loadDayHabits(day) {
  if (!day || !cal.layers.habits) { cal.dayHabits = null; return; }
  // Today's list is already loaded for the Today page; everything else needs
  // asking for. Both go through the same endpoint so the shape cannot diverge.
  cal.dayHabits = { date: day, loading: true };
  renderCalendarRail();
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/habits?date=${day}`);
    if (cal.selected !== day) return;
    cal.dayHabits = { date: day, habits: r.habits ?? [] };
  } catch (e) {
    if (cal.selected !== day) return;
    cal.dayHabits = { date: day, error: e.message };
  }
  renderCalendarRail();
}

/**
 * Ticks or unticks a habit on ANY day, not just today.
 *
 * The endpoints already accepted a date; nothing here needed inventing. What
 * was missing was a way to reach them for a past day, which is why a wrong
 * square could be seen and not corrected.
 *
 * Optimistic, then reconciled: the row flips immediately, the month cell's
 * `n/m` is patched from the server's answer, and a failure puts both back.
 */
async function toggleHabitOn(habitId, day) {
  const dh = cal.dayHabits;
  const h = dh?.date === day ? (dh.habits ?? []).find((x) => x.id === habitId) : null;
  if (!h || h._busy) return;
  const wasDone = h.completedToday;
  h._busy = true;

  const before = { todayCount: h.todayCount, completedToday: h.completedToday };
  /*
   * Predict what the SERVER will do, not what a single-count habit would do.
   *
   * This used to set the count straight to the target, so ticking "Water: 3
   * glasses" at 0/3 showed 3/3 and done — then the response came back saying
   * 1/3 and the row snapped backwards. That was the second of the two jumps.
   *
   * `check` increments by one; `uncheck` removes the day's entry entirely.
   * Done means reaching the target, which for a 3-glass habit takes three
   * presses and should look like it does.
   */
  const target = Math.max(1, h.targetCount ?? 1);
  h.todayCount = wasDone ? 0 : Math.min(target, (h.todayCount ?? 0) + 1);
  h.completedToday = !wasDone && h.todayCount >= target;
  patchCalHabitRow(habitId);

  try {
    const verb = wasDone ? 'uncheck' : 'check';
    const r = await api(`/api/v1/workspaces/${ws()}/habits/${habitId}/${verb}`,
      { method: 'POST', body: { date: day } });
    h.todayCount = r.completedCount;
    h.completedToday = r.completed;
    patchCalHabitRow(habitId);
    patchHabitCell(day);
  } catch (e) {
    Object.assign(h, before);
    patchCalHabitRow(habitId);
    toast(e.message, true);
  } finally { h._busy = false; }
}

/**
 * Updates ONE habit row, in place.
 *
 * This used to call `renderCalendarRail()`, twice per tick — once optimistically
 * and once on the response — and that rebuilds `rail.innerHTML` wholesale.
 *
 * Two things followed, and both were visible. The rail visibly restaged itself
 * on every tick. And ticking three habits quickly only registered one or two:
 * the second click landed on a node that a re-render had already replaced, or
 * in the gap between the `innerHTML` swap and the loop that reassigns the
 * handlers — where the button exists but does nothing.
 *
 * Nothing is destroyed here, so a click always lands on a live, wired node and
 * rows can be ticked as fast as they can be pressed.
 */
function patchCalHabitRow(habitId) {
  const dh = cal.dayHabits;
  const h = (dh?.habits ?? []).find((x) => x.id === habitId);
  const row = document.querySelector(`.cs-habit-row[data-habit="${habitId}"]`);
  if (!h || !row) return;

  row.classList.toggle('is-done', !!h.completedToday);
  row.setAttribute('aria-pressed', h.completedToday ? 'true' : 'false');
  row.setAttribute('aria-label', `${h.name}${h.completedToday ? ', done' : ', not done'}`);
  const n = row.querySelector('.cs-habit-n');
  if (n) n.textContent = `${h.todayCount}/${h.targetCount}`;

  // The card's own n/m, recounted from the same list the rows are drawn from.
  const count = document.querySelector('.cs-habits .cs-habit-count');
  if (count) {
    const due = (dh.habits ?? []).filter((x) => x.dueToday);
    count.textContent = `${due.filter((x) => x.completedToday).length}/${due.length}`;
  }
}

/**
 * Re-counts one day's `n/m` chip from the habit list already in memory.
 *
 * A local recount rather than a calendar reload: reloading the range to change
 * two characters would rebuild the whole month, and the month is what the user
 * is currently looking at.
 */
function patchHabitCell(day) {
  const dh = cal.dayHabits;
  if (!dh || dh.date !== day || !cal.data) return;
  const due = (dh.habits ?? []).filter((x) => x.dueToday);
  const done = due.filter((x) => x.completedToday).length;

  cal.data.habitDays = cal.data.habitDays ?? [];
  const row = cal.data.habitDays.find((x) => x.date === day);
  if (row) { row.due = due.length; row.done = done; }
  else if (due.length) cal.data.habitDays.push({ date: day, due: due.length, done });

  const cell = document.querySelector(`.cm-cell[data-day="${day}"] .cm-foot`);
  if (!cell) return;
  cell.querySelector('.cm-habit')?.remove();
  cell.insertAdjacentHTML('beforeend', habitSummaryHtml(
    { due: due.length, done }, day, iso(new Date()),
  ));
  const chip = cell.querySelector('.cm-habit');
  if (chip) pulse(chip);
}

function wireCalendarHeader() {
  const modes = document.querySelector('.cal-modes');
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => {
      if (cal.mode === b.dataset.mode) return;
      // §7 A surface describing Month must not survive into Plan week.
      closeUtility();
      cal.mode = b.dataset.mode;
      localStorage.setItem('los2_cal_mode', cal.mode);
      // The pill glides because only its --mode-i changes; the buttons are
      // never re-rendered, so nothing flashes.
      const i = MODE_IDS.indexOf(cal.mode);
      modes?.style.setProperty('--mode-i', String(i));
      document.querySelectorAll('[data-mode]').forEach((x) => {
        const on = x.dataset.mode === cal.mode;
        x.setAttribute('aria-selected', String(on));
        x.tabIndex = on ? 0 : -1;
      });
      cal.enter = 'mode';
      // Choosing a time view means leaving the reminder list.
      cal.utility = 'none';
      loadCalendar();
    };
    // Arrow keys move between modes, as a tablist should.
    b.onkeydown = (e) => {
      const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const i = (MODE_IDS.indexOf(cal.mode) + d + MODE_IDS.length) % MODE_IDS.length;
      document.querySelector(`[data-mode="${MODE_IDS[i]}"]`)?.click();
      document.querySelector(`[data-mode="${MODE_IDS[i]}"]`)?.focus();
    };
  });
  document.querySelectorAll('[data-cal]').forEach((b) => {
    b.onclick = () => {
      const dir = b.dataset.cal;
      const step = cal.mode === 'plan' ? 7 : 0;
      if (dir === 'today') cal.anchor = new Date();
      else if (cal.mode === 'month') {
        cal.anchor = new Date(cal.anchor.getFullYear(),
          cal.anchor.getMonth() + (dir === 'next' ? 1 : -1), 1);
      } else if (step) {
        cal.anchor = new Date(cal.anchor.getTime()
          + (dir === 'next' ? step : -step) * 86400000);
      }
      // Direction is the message: forward enters from the right.
      cal.enter = dir === 'next' ? 'next' : dir === 'prev' ? 'prev' : 'mode';
      loadCalendar();
    };
  });

  const utilBtn = document.getElementById('cal-util');
  utilBtn?.addEventListener('click', () => openCalendarUtility(utilBtn));

  // The Reminders workspace has its own header, with its own controls.
  document.getElementById('rv-back')?.addEventListener('click', () => closeRemindersView());
  document.getElementById('rv-new')?.addEventListener('click', () => addReminder(null));
  // Layers filter what is already loaded — no round trip, no flash.
  document.querySelectorAll('[data-layer]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.layer;
      cal.layers[id] = !cal.layers[id];
      b.classList.toggle('is-on', cal.layers[id]);
      b.setAttribute('aria-pressed', String(cal.layers[id]));
      paintCalendar();
    };
  });
  const addBtn = document.getElementById('cal-add');
  addBtn?.addEventListener('click', () => calendarAddMenu(addBtn));
  document.getElementById('cal-retry')?.addEventListener('click', () => loadCalendar());
}

function wireCalendar() {
  document.querySelectorAll('.cm-cell').forEach((c) => {
    c.onclick = () => selectDay(c.dataset.day);
    c.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDay(c.dataset.day); }
    };
  });
  document.querySelectorAll('[data-event]').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); openEvent(el.dataset.event); };
  });
  // The checkbox completes; the row opens detail. Clicking a reminder should
  // not silently tick it off.
  document.querySelectorAll('.ag-check[data-reminder]').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); toggleReminder(el.dataset.reminder); };
  });
  document.querySelectorAll('[data-reminder]:not(.ag-check)').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); openReminderDetail(el.dataset.reminder); };
  });
}

/** Selecting a day updates the cell and the rail — never the whole page. */
function selectDay(day) {
  const prev = document.querySelector('.cm-cell.is-selected');
  cal.selected = cal.selected === day ? null : day;
  prev?.classList.remove('is-selected');
  const next = document.querySelector(`.cm-cell[data-day="${day}"]`);
  if (cal.selected && next) { next.classList.add('is-selected'); pulse(next); }
  if (!cal.selected) cal.dayHabits = null;
  renderCalendarRail();
  // Month only. Agenda answers "what is coming" and Plan places work into
  // hours; neither question is about a rhythm you keep.
  if (cal.selected && cal.mode === 'month') loadDayHabits(cal.selected);
}

/**
 * Opens an event.
 *
 * A REAL Google event opens read-only detail, never a form. Life OS cannot
 * write to Google in this phase, and a form with a Save button would promise
 * something that does not exist. Local and synthetic events still open the
 * editor, because those Life OS can actually change.
 */
function openEvent(id, defaultDay = null) {
  const ev = id ? cal.data?.events.find((x) => x.id === id) : null;
  if (id && !ev) return;
  if (ev && ev.syncState === 'synced') return openEventDetail(ev);
  openEventModal({
    event: ev,
    calendars: cal.data?.calendars ?? [],
    defaultDay,
    links: (cal.data?.links ?? []).filter((l) => l.sourceId === id),
    onSave: async (body) => {
      const r = ev
        ? await api(`/api/v1/workspaces/${ws()}/calendar/events/${ev.id}`,
          { method: 'PATCH', body })
        : await api(`/api/v1/workspaces/${ws()}/calendar/events`,
          { method: 'POST', body });
      // Settle the saved event into the calendar without reloading the route.
      const saved_ = r.event;
      const cals = cal.data.calendars;
      const c = cals.find((x) => x.id === saved_.calendarId);
      const merged = { ...saved_, calendarName: c?.name ?? null,
        calendarColor: c?.color ?? null, isReadOnly: c?.isReadOnly ?? false,
        attendees: ev?.attendees ?? [] };
      if (ev) {
        const i = cal.data.events.findIndex((x) => x.id === ev.id);
        if (i > -1) cal.data.events[i] = merged;
      } else {
        cal.data.events.push(merged);
      }
      paintCalendar();
      flashEvent(merged.id);
      saved(ev ? 'Event saved' : 'Event created');
    },
    onDelete: async () => {
      await api(`/api/v1/workspaces/${ws()}/calendar/events/${ev.id}`, { method: 'DELETE' });
      cal.data.events = cal.data.events.filter((x) => x.id !== ev.id);
      paintCalendar();
      saved('Event deleted');
    },
  });
}

/** A brief highlight so a saved event is findable on the canvas. */
function flashEvent(id) {
  if (reducedMotion()) return;
  const el = document.querySelector(`[data-event="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  el.animate([{ background: 'var(--accent-soft)' }, { background: 'transparent' }],
    { duration: 900, easing: 'ease-out' });
}

function calendarAddMenu(anchor, day = null) {
  // §19 Add and the utility menu are both overflows of the same header. Two
  // open menus is two answers to "what did I just click".
  closeUtility();
  anchor.setAttribute('aria-expanded', 'true');
  openAddMenu(anchor, {
    event: () => openEvent(null, day ?? cal.selected ?? undefined),
    reminder: () => addReminder(day ?? cal.selected),
    task: () => openScheduleTask({ day: day ?? cal.selected ?? null }),
    // Habit is deliberately absent. Habits are a Calendar LAYER, not a
    // Calendar creation flow — you review habit history here and manage
    // habits on Today or in Settings. Offering creation just because the
    // layer exists would put the same concept in three places.
  }, () => anchor.setAttribute('aria-expanded', 'false'));
}

/** Reminders are Life OS records, never Google events. */
function addReminder(day, existing = null) {
  openReminderModal({
    reminder: existing,
    areas: state.me?.areas ?? [],
    defaultDay: day ?? cal.selected ?? undefined,
    onSave: async (body) => {
      const r = await api(`/api/v1/workspaces/${ws()}/reminders`, { method: 'POST', body });
      cal.data.reminders.push(r.reminder);
      paintCalendar();
      saved('Reminder added');
    },
  });
}

/* ══ PROJECTS ═══════════════════════════════════════════════════════════
 *
 * The whole controller is arranged around one constraint: a project that
 * changes status or focus MOVES between groups, and the same DOM node has to
 * survive that move or there is nothing to animate. So nothing here re-renders
 * the list from a string after a mutation — `applyGroups` reconciles in place
 * and `flip` animates the result. Rebuilding the list would silently turn every
 * transition into a jump, which is exactly how C4's FLIP became invisible.
 */

/** Loads and paints the overview. Keeps what is on screen while it refreshes. */
async function loadProjects() {
  const head = document.getElementById('page-head');
  const scroll = document.getElementById('main-scroll');
  if (!head || !scroll) return;
  // A refresh on #projects/<id> opens that project, not the list.
  const fromUrl = projectFromHash();
  if (fromUrl && !pj.openId) {
    pj.openId = fromUrl;
    await renderProjectDetail(scroll);
    return;
  }
  pj.detail = null;
  pj.openId = null;

  head.innerHTML = projectsHeaderHtml(pj.filter, pj.data?.available ?? {});
  wireProjectsHeader();
  // A stable frame with row skeletons, never an empty page that then fills.
  if (!pj.data) {
    scroll.innerHTML = `${projectsBodyHtml()}`;
    document.getElementById('pj-list').innerHTML =
      '<div class="pj-skel"></div><div class="pj-skel"></div><div class="pj-skel"></div>';
  } else if (!document.getElementById('pj-list')) {
    scroll.innerHTML = projectsBodyHtml();
  }

  try {
    const data = await api(`/api/v1/workspaces/${ws()}/projects`);
    if (state.route !== 'projects' || pj.openId) return;
    pj.data = data;
    head.innerHTML = projectsHeaderHtml(pj.filter, data.available ?? {});
    wireProjectsHeader();
    paintProjects();
  } catch (e) {
    // An error must never look like "you have no projects".
    scroll.innerHTML = errorHtml(e.message);
    scroll.querySelector('#retry')?.addEventListener('click', () => loadProjects());
  }
}

/**
 * Paints the groups into the existing list, animating whatever moved.
 *
 * `flip` measures every row before the change and animates the deltas after,
 * so a project leaving Now for On hold travels there instead of disappearing
 * from one place and appearing in another.
 */
function paintProjects() {
  const scroll = document.getElementById('main-scroll');
  let list = document.getElementById('pj-list');
  if (!list) { scroll.innerHTML = projectsBodyHtml(); list = document.getElementById('pj-list'); }
  const groups = pj.data?.views?.[pj.filter] ?? pj.data?.groups ?? [];
  const total = groups.reduce((n, g) => n + g.projects.length, 0);

  if (!total) {
    list.innerHTML = projectsEmptyHtml(pj.filter, pj.data?.available ?? {});
    wireProjectRows();
    return;
  }
  list.querySelector('.pj-empty')?.remove();
  list.querySelector('.pj-skel')?.closest('#pj-list') && (list.querySelectorAll('.pj-skel').forEach((s) => s.remove()));

  flip(list.querySelectorAll('.pj-row'), () => {
    applyGroups(list, groups, areaName);
  });
  wireProjectRows();
}

function wireProjectsHeader() {
  document.getElementById('pj-new')?.addEventListener('click', () => newProject());
  document.querySelectorAll('[data-pj-filter]').forEach((b) => {
    b.onclick = () => setProjectFilter(b.dataset.pjFilter);
  });
  document.getElementById('pjd-back')?.addEventListener('click', () => closeProjectDetail());
  document.getElementById('pjd-menu')?.addEventListener('click', (e) =>
    openProjectMenu(e.currentTarget, pj.detail?.project));
}

/**
 * A filter change is instant, then a crossfade.
 *
 * THE BUG THIS REPLACES had three causes stacked on top of each other:
 *
 *  1. The fade-out was `animate([{opacity:1},{opacity:0}])` with the default
 *     `fill: 'none'`, so when it finished the list SNAPPED BACK to full
 *     opacity — showing the old filter's rows again, at full strength.
 *  2. Nothing correct could be rendered until a network round trip returned,
 *     so the old list then sat there visible for the whole request.
 *  3. The response re-rendered the page header, which destroyed and rebuilt
 *     the filter pills, so the active indicator appeared to lag behind the
 *     click that caused it.
 *
 * All three are gone. Every filter's rows arrive in one payload, so the correct
 * set is derived synchronously; the pill is updated in place and never
 * re-created; and the crossfade holds its end state.
 */
function setProjectFilter(filter) {
  if (filter === pj.filter) return;
  pj.filter = filter;

  // The indicator responds to the click, not to the network.
  document.querySelectorAll('[data-pj-filter]').forEach((b) => {
    const on = b.dataset.pjFilter === filter;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  });

  const list = document.getElementById('pj-list');
  if (!list) return;

  const paint = () => {
    // Different rows behind a different filter, so this is a replacement, not
    // a reflow. Pretending they moved would be a lie about what happened.
    list.innerHTML = '';
    paintProjects();
  };

  if (reducedMotion()) { paint(); return; }
  // `fill: 'forwards'` — without it the fade reverts and the OLD content
  // reappears at full opacity, which is exactly what was happening.
  const out = list.animate([{ opacity: 1 }, { opacity: 0 }],
    { duration: 140, easing: 'ease-in', fill: 'forwards' });
  settle(out, 140, () => {
    paint();
    out.cancel();
    list.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
  });
}

function wireProjectRows() {
  document.querySelectorAll('[data-pj-open]').forEach((b) => {
    b.onclick = () => openProjectDetail(b.dataset.pjOpen);
  });
  document.querySelectorAll('[data-pj-menu]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = b.dataset.pjMenu;
      const project = (pj.data?.groups ?? []).flatMap((g) => g.projects).find((p) => p.id === id);
      openProjectMenu(b, project);
    };
  });
  // Keyboard: a row is focusable, and Enter opens it.
  document.querySelectorAll('.pj-row').forEach((row) => {
    row.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      openProjectDetail(row.dataset.id);
    };
  });
  document.getElementById('pj-empty-new')?.addEventListener('click', () => newProject());
}

/** The row and header overflow. One shared component, same as everywhere. */
function openProjectMenu(anchor, project) {
  if (!project) return;
  const archived = !!project.archivedAt;
  const items = archived
    ? [{ id: 'restore', label: 'Restore' }, { id: 'delete', label: 'Delete project' }]
    : [
      { id: 'edit', label: 'Edit project' },
      ...(project.status === 'completed' ? [] : [{ id: 'complete', label: 'Mark complete' }]),
      { id: 'top', label: 'Move to top' },
      { id: 'archive', label: 'Archive' },
      { id: 'delete', label: 'Delete project' },
    ];
  openUtilityMenu(anchor, items, (id) => {
    if (id === 'edit') return editProject(project);
    if (id === 'complete') return completeProject(project);
    if (id === 'archive') return archiveProject(project);
    if (id === 'restore') return restoreProject(project);
    if (id === 'top') return moveProjectToTop(project);
    if (id === 'delete') return deleteProject(project);
    return undefined;
  });
}

/* ── Mutations ───────────────────────────────────────────────────────── */

/** Every project write goes through here, so the failure story is one story. */
async function projectWrite(path, opts, { after = 'overview' } = {}) {
  const r = await api(`/api/v1/workspaces/${ws()}/projects${path}`, opts);
  if (after === 'overview') await refreshProjects();
  return r;
}

/** Re-reads the overview and animates whatever changed. Never repaints blind. */
async function refreshProjects() {
  if (state.route !== 'projects' || pj.openId) return;
  const data = await api(`/api/v1/workspaces/${ws()}/projects`);
  if (state.route !== 'projects' || pj.openId) return;
  pj.data = data;
  // The header is PATCHED, never re-rendered. Rebuilding it destroys the filter
  // pills and re-creates them, which makes the active indicator flicker on
  // every mutation.
  patchFilterCounts(data.available ?? {});
  paintProjects();
}

/** Updates the filter counts in place, leaving the controls themselves alone. */
function patchFilterCounts(available) {
  document.querySelectorAll('[data-pj-filter]').forEach((b) => {
    const id = b.dataset.pjFilter;
    if (id === 'working') return;
    const n = available[id];
    const badge = b.querySelector('.pj-fcount');
    if (n) {
      if (badge) badge.textContent = String(n);
      else b.insertAdjacentHTML('beforeend', `<span class="pj-fcount">${n}</span>`);
    } else if (badge) badge.remove();
  });
}

function newProject() {
  openProjectModal({
    areas: state.me?.areas ?? [],
    onSave: async (body) => {
      const r = await api(`/api/v1/workspaces/${ws()}/projects`, { method: 'POST', body });
      await refreshProjects();
      // A restrained highlight, so the eye finds where it landed.
      requestAnimationFrame(() => {
        const row = document.querySelector(`.pj-row[data-id="${r.project.id}"]`);
        if (row) { row.classList.add('is-new'); setTimeout(() => row.classList.remove('is-new'), 1400); }
      });
      saved('Project created');
    },
  });
}

function editProject(project) {
  openProjectModal({
    project,
    areas: state.me?.areas ?? [],
    onSave: async (body) => {
      // The area is changed through its own endpoint, which asks about tasks.
      const { areaId, focus, ...rest } = body;
      await api(`/api/v1/workspaces/${ws()}/projects/${project.id}`, {
        method: 'PATCH', body: { ...rest, focus, expectedUpdatedAt: project.updatedAt },
      });
      if (areaId && areaId !== project.areaId) await changeProjectArea(project, areaId);
      if (pj.openId === project.id) await reloadProjectDetail(); else await refreshProjects();
      saved('Saved');
    },
    onDelete: async () => { await deleteProject(project, true); },
  });
}

/**
 * Changing a project's area inspects its tasks first and asks.
 *
 * Tasks that merely inherited the old area move with it; a task filed somewhere
 * else on purpose keeps its classification unless the user says otherwise. An
 * explicit choice is how they find things later.
 */
async function changeProjectArea(project, areaId) {
  const preview = await api(
    `/api/v1/workspaces/${ws()}/projects/${project.id}/area-preview?areaId=${areaId}`);
  let taskChoice = 'move_inherited';
  if (preview.total > 0) {
    const parts = [`${preview.total} task${preview.total === 1 ? '' : 's'} in this project.`];
    if (preview.differentlyClassified) {
      parts.push(`${preview.differentlyClassified} ${preview.differentlyClassified === 1
        ? 'is' : 'are'} filed in another area on purpose and will not move either way.`);
    }
    const choice = await openChoiceDialog({
      title: 'Move its tasks too?',
      body: parts.join(' '),
      choices: [
        { id: 'move_inherited',
          label: 'Move the inherited ones',
          detail: `${preview.inherited} task${preview.inherited === 1 ? '' : 's'} took `
            + 'the area from this project.' },
        { id: 'keep_all', label: 'Leave every task where it is' },
      ],
    });
    if (!choice) return;   // dismissed — change nothing at all
    taskChoice = choice;
  }
  const r = await api(`/api/v1/workspaces/${ws()}/projects/${project.id}/area`, {
    method: 'POST', body: { areaId, taskChoice },
  });
  if (r.tasksMoved) saved(`${r.tasksMoved} task${r.tasksMoved === 1 ? '' : 's'} moved`);
}

/** Completion asks about open work rather than fabricating it as finished. */
async function completeProject(project) {
  try {
    await projectWrite(`/${project.id}/complete`, { method: 'POST', body: {} });
    saved('Project completed');
  } catch (e) {
    let detail = null;
    try { detail = JSON.parse(e.message); } catch { /* a real error */ }
    if (detail?.reason !== 'open_tasks') { toast(e.message, true); return; }
    const n = detail.openTasks;
    const choice = await openChoiceDialog({
      title: `${n} task${n === 1 ? ' is' : 's are'} still open`,
      body: 'Completing the project does not finish them. Nothing is ever marked done '
        + 'that was not done.',
      choices: [
        { id: 'leave', label: 'Leave them open',
          detail: 'They keep their dates and stay wherever they already are.' },
        { id: 'cancel', label: 'Cancel them',
          detail: 'You decided not to do them. They are kept, marked cancelled.' },
      ],
    });
    if (!choice) return;   // dismissed — the project stays as it was
    try {
      const r = await projectWrite(`/${project.id}/complete`, {
        method: 'POST', body: { openTasks: choice },
      });
      saved(r.tasksCancelled
        ? `Completed · ${r.tasksCancelled} cancelled`
        : `Completed · ${r.tasksLeftOpen} left open`);
    } catch (e2) { toast(e2.message, true); }
  }
}

/** Archive keeps the lifecycle state, and Undo is offered immediately. */
async function archiveProject(project) {
  try {
    await projectWrite(`/${project.id}/archive`, { method: 'POST', body: {} });
    saved('Archived');
    undoBar('Project archived', async () => {
      await projectWrite(`/${project.id}/restore`, { method: 'POST', body: {} });
      saved('Restored');
    });
  } catch (e) { toast(e.message, true); }
}

async function restoreProject(project) {
  try {
    await projectWrite(`/${project.id}/restore`, { method: 'POST', body: {} });
    requestAnimationFrame(() => {
      const row = document.querySelector(`.pj-row[data-id="${project.id}"]`);
      if (row) { row.classList.add('is-new'); setTimeout(() => row.classList.remove('is-new'), 1400); }
    });
    saved('Restored');
  } catch (e) { toast(e.message, true); }
}

async function moveProjectToTop(project) {
  try { await projectWrite(`/${project.id}/move-to-top`, { method: 'POST', body: {} }); }
  catch (e) { toast(e.message, true); }
}

async function deleteProject(project, silent = false) {
  if (!silent) {
    const choice = await openChoiceDialog({
      title: 'Delete this project?',
      body: 'Its tasks are kept — they simply stop belonging to it.',
      choices: [
        { id: 'delete', label: 'Delete the project', tone: 'danger' },
        { id: 'keep', label: 'Keep it', tone: 'quiet' },
      ],
    });
    if (choice !== 'delete') return;
  }
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/projects/${project.id}`, { method: 'DELETE' });
    if (pj.openId === project.id) { pj.openId = null; await loadProjects(); }
    else await refreshProjects();
    saved(r.tasksKept ? `Deleted · ${r.tasksKept} task${r.tasksKept === 1 ? '' : 's'} kept` : 'Deleted');
  } catch (e) { toast(e.message, true); }
}

/** A short-lived undo surface. Nothing destructive happens without one. */
function undoBar(message, onUndo) {
  document.querySelector('.undo-bar')?.remove();
  const bar = document.createElement('div');
  bar.className = 'undo-bar';
  bar.innerHTML = `<span>${esc(message)}</span><button class="btn btn-sm">Undo</button>`;
  document.body.appendChild(bar);
  if (!reducedMotion()) {
    bar.animate([{ opacity: 0, translate: '0 8px' }, { opacity: 1, translate: '0 0' }],
      { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
  const close = () => bar.remove();
  bar.querySelector('button').onclick = async () => { close(); await onUndo(); };
  setTimeout(close, 8000);
}

/* ── Detail ──────────────────────────────────────────────────────────── */

/**
 * Opens the detail page and remembers exactly where the user was.
 *
 * Losing the list position on Back is the most irritating thing a detail page
 * can do, so the filter, the scroll offset and the row are all captured first.
 */
async function openProjectDetail(id) {
  const scroll = document.getElementById('main-scroll');
  pj.resume = {
    filter: pj.filter,
    scrollTop: window.scrollY,
    rowId: id,
  };
  pj.openId = id;
  history.pushState(null, '', `#projects/${id}`);
  await renderProjectDetail(scroll);
}

async function renderProjectDetail(scroll) {
  const head = document.getElementById('page-head');
  if (!scroll) return;
  if (!reducedMotion()) {
    scroll.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in' });
  }
  try {
    const data = await api(`/api/v1/workspaces/${ws()}/projects/${pj.openId}`);
    if (pj.openId !== data.project.id) return;
    pj.detail = data;
    head.innerHTML = projectDetailHeaderHtml(data.project, areaName);
    scroll.innerHTML = projectDetailBodyHtml(data.project, data.tasks, taskHtml);
    wireProjectsHeader();
    wireProjectDetail();
    assertOneRowPerTask(document.getElementById('pjd-tasks'));
    if (!reducedMotion()) {
      scroll.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
    document.getElementById('pjd-back')?.focus();
  } catch (e) {
    scroll.innerHTML = errorHtml(e.message);
    scroll.querySelector('#retry')?.addEventListener('click', () => renderProjectDetail(scroll));
  }
}

/**
 * A full detail re-render. Refuses while a drag is in flight.
 *
 * The dragged card lives on `document.body` and the list holds its placeholder,
 * so replacing the body mid-gesture strands the card and lets the fresh list
 * render a second node for the same task. drag.js now recovers from that on its
 * own, but not causing it is better than recovering from it.
 */
function reloadProjectDetail() {
  if (isDragging()) return Promise.resolve();
  return renderProjectDetail(document.getElementById('main-scroll'));
}

/**
 * The invariant: exactly one row per task id in the open list.
 *
 * Checked after every reconciliation. Anything that produces a second node for
 * the same task is a correctness bug, not a cosmetic one — it makes the count
 * wrong, the drag anchors ambiguous and the user unsure whether their data was
 * duplicated.
 */
function assertOneRowPerTask(host) {
  if (!host) return true;
  const seen = new Set();
  let ok = true;
  host.querySelectorAll('.task').forEach((row) => {
    const { id } = row.dataset;
    if (seen.has(id)) {
      ok = false;
      // Repair rather than merely complain: the later node is the stray one.
      row.remove();
      console.warn('[projects] duplicate task row removed', id);
    }
    seen.add(id);
  });
  return ok;
}

/** Back restores the list the user left, not a fresh one. */
async function closeProjectDetail(push = true) {
  // Arrived from Today? Go back there, to the board that was left.
  if (pj.cameFromToday) {
    pj.cameFromToday = false;
    pj.openId = null;
    pj.detail = null;
    return go('today');
  }
  const back = pj.resume;
  pj.openId = null;
  pj.detail = null;
  if (back) pj.filter = back.filter;
  if (push) history.pushState(null, '', '#projects');
  await loadProjects();
  if (back) {
    requestAnimationFrame(() => {
      window.scrollTo({ top: back.scrollTop, behavior: 'instant' });
      const row = document.querySelector(`.pj-row[data-id="${back.rowId}"]`);
      row?.focus({ preventScroll: true });
    });
  }
}

function wireProjectDetail() {
  const p = pj.detail?.project;
  if (!p) return;

  document.getElementById('pjd-status')?.addEventListener('change', async (e) => {
    const status = e.target.value;
    try {
      await api(`/api/v1/workspaces/${ws()}/projects/${p.id}`, {
        method: 'PATCH', body: { status, expectedUpdatedAt: p.updatedAt },
      });
      await reloadProjectDetail();
      saved(`Status: ${STATUS_LABEL[status]}`);
    } catch (err) { toast(err.message, true); await reloadProjectDetail(); }
  });

  document.getElementById('pjd-focus')?.addEventListener('change', async (e) => {
    const focus = e.target.value;
    try {
      await api(`/api/v1/workspaces/${ws()}/projects/${p.id}`, {
        method: 'PATCH', body: { focus, expectedUpdatedAt: p.updatedAt },
      });
      await reloadProjectDetail();
      saved(`Focus: ${FOCUS_LABEL[focus]}`);
    } catch (err) { toast(err.message, true); await reloadProjectDetail(); }
  });

  document.getElementById('pjd-add-task')?.addEventListener('click', () => addProjectTask(p));
  document.getElementById('pjd-next-add')?.addEventListener('click', () => addProjectTask(p));
  document.getElementById('pjd-add-existing')?.addEventListener('click', () => addExistingTask(p));
  document.querySelectorAll('[data-pjd-open-task]').forEach((b) => {
    b.onclick = () => openProjectTask(b.dataset.pjdOpenTask);
  });
  // The task row's own overflow, replaced with the project's set of actions.
  document.querySelectorAll('#pjd-tasks .task [data-act="menu"], .pjd-tasks-done .task [data-act="menu"]')
    .forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        openProjectTaskMenu(b, b.closest('.task').dataset.id, p);
      };
    });

  document.getElementById('pjd-next-choose')?.addEventListener('click', () => chooseNextAction(p));

  wireProjectNotes(p);
  wireProjectTaskRows(p);
}

/**
 * Wires the project's task rows.
 *
 * NOT `wireBoard()`. That was the bug behind "completing a task does not update
 * Finished until you leave and come back": wireBoard runs `wireCard` over EVERY
 * `.task` on the page and reassigns `onclick`, so it silently overwrote the
 * project handlers that had been set moments earlier. The tick then called
 * Today's `toggleTask`, which looks the task up in `state.tasks` — the Today
 * board's list. If the task was not on Today it returned immediately and
 * nothing happened at all; if it was, it rebuilt a bucket that does not exist
 * on this page.
 *
 * Same rows, same task records, same editor — a different controller, because
 * the surrounding page is different.
 */
function wireProjectTaskRows(project) {
  document.querySelectorAll('#pjd-tasks .task, .pjd-tasks-done .task').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('[data-act]').forEach((b) => {
      if (b.dataset.act === 'steps') return;   // the component owns this one
      b.onclick = (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'toggle') return completeProjectTask(id);
        if (act === 'open') return openProjectTask(id);
        if (act === 'menu') return openProjectTaskMenu(b, id, project);
        // back/fwd are Today's bucket controls. They are hidden here — the
        // project's own ordering lives in the task menu.
        return undefined;
      };
    });
    row.onkeydown = (e) => {
      if (e.target.closest('.t-steps')) return;   // typing in a step, not the row
      if (e.key !== 'Enter') return;
      e.preventDefault();
      openProjectTask(id);
    };

    /* The SAME steps component Today uses, with the same handlers.
     *
     * Not a project-specific implementation: the row is `taskHtml` in both
     * places and the record is one record, so a step ticked here and a step
     * ticked on Today are the same write against the same object. */
    const t = (pj.detail?.tasks ?? []).find((x) => x.id === id);
    if (t && row.querySelector('.t-steps')) {
      row.querySelector('[data-act="steps"]')?.addEventListener('click', () => {
        if (expandedSteps.has(id)) expandedSteps.delete(id); else expandedSteps.add(id);
      }, true);
      wireSteps(row, t, taskStepsCtx(t), {
        onChanged: (frameChanged) => (frameChanged
          ? patchProjectTaskRow(id) : syncTaskEverywhere(id, row)),
        onOpenTask: () => openProjectTask(id),
      });
    }
  });
}

/**
 * A task created here belongs to the project and inherits its area.
 *
 * The same task EDITOR as Today — `openTaskModal` is one component — with its
 * own controller, because Today's controller rebuilds board buckets that do not
 * exist on this page. Same modal, same API, same task identity; different
 * surroundings.
 */
function addProjectTask(project) {
  openTaskModal({
    task: null,
    areas: state.me?.areas ?? [],
    // Named, so the modal says where the task will land rather than showing an
    // unfinished "Project — arrives with Projects" placeholder.
    project: { title: project.title },
    onSave: async (body) => {
      await api(`/api/v1/workspaces/${ws()}/tasks`, {
        method: 'POST',
        body: {
          ...body,
          projectId: project.id,
          // Inherit the project's area unless the editor was given one.
          areaId: body.areaId ?? project.areaId ?? null,
          // Focus nudges the default, it does not command it. A Now project's
          // tasks start in This week, NOT on Today.
          //
          // They used to start on Today, and the result was the thing this
          // phase exists to fix: adding five tasks to a Now project put five
          // more rows on Today, so Today stopped being a decision about today
          // and became a mirror of every active project. Belonging to a busy
          // project is not the same as being due now.
          bucket: body.bucket ?? (project.focus === 'now' ? 'week' : 'future'),
        },
      });
      await reloadProjectDetail();
      saved('Task created');
    },
  });
}

/* ── Task order inside a project ─────────────────────────────────────── */

/** Guards against two reorder writes racing. One interaction, one write. */
let reorderPending = false;

/**
 * Persists a drop, and puts the row back exactly where it was if it fails.
 *
 * The drag system has already moved the node, so the optimistic state is
 * whatever is on screen. On failure the server's list is authoritative and the
 * task returns to its real position — a reorder that silently did not save is
 * worse than one that visibly refused.
 */
async function reorderProjectTask(taskId, anchor) {
  const project = pj.detail?.project;
  if (!project) return;
  if (reorderPending) return;
  reorderPending = true;
  const body = anchor?.beforeTaskId ? { beforeTaskId: anchor.beforeTaskId } : { to: 'bottom' };
  try {
    const r = await api(
      `/api/v1/workspaces/${ws()}/projects/${project.id}/tasks/${taskId}/reorder`,
      { method: 'POST', body });
    // Settle on the server's answer rather than trusting the optimistic guess.
    pj.detail.tasks = r.tasks;
    pj.detail.project = r.project;
    patchProjectTaskOrder();
  } catch (e) {
    toast(e.message, true);
    await reloadProjectDetail();
  } finally { reorderPending = false; }
}

/**
 * Re-orders the rendered rows to match the data, moving nodes rather than
 * rebuilding them, so the settle animates instead of snapping.
 */
function patchProjectTaskOrder() {
  const host = document.getElementById('pjd-tasks');
  if (!host || !pj.detail) return;
  // Dedupe the DATA before rendering it, so a stale response that repeats a
  // task cannot produce two rows in the first place.
  const seen = new Set();
  const open = pj.detail.tasks.filter((t) => t.status === 'open'
    && !seen.has(t.id) && seen.add(t.id));
  flip(host.querySelectorAll('.task'), () => {
    for (const t of open) {
      const row = host.querySelector(`.task[data-id="${t.id}"]`);
      if (row) host.appendChild(row);   // appendChild MOVES an existing node
    }
  });
  assertOneRowPerTask(host);
  updateProjectDerived();
}

/**
 * Refreshes the numbers AFTER the rows have settled.
 *
 * Progress and the next action are updated separately from the list on purpose:
 * two things changing mid-movement reads as a glitch.
 */
function updateProjectDerived() {
  const p = pj.detail?.project;
  if (!p) return;
  const prog = document.getElementById('pjd-progress');
  if (prog) prog.textContent = progressText(p);
  const count = document.querySelector('.pjd-count');
  if (count) count.textContent = `${p.progress.open} open`;
}

/** Move up / down / top / bottom — the path that is not a drag. */
async function moveProjectTask(taskId, where) {
  const project = pj.detail?.project;
  if (!project || reorderPending) return;
  const open = (pj.detail.tasks ?? []).filter((t) => t.status === 'open');
  const at = open.findIndex((t) => t.id === taskId);
  if (at === -1) return;
  let body = null;
  if (where === 'top') body = { to: 'top' };
  else if (where === 'bottom') body = { to: 'bottom' };
  else if (where === 'up' && at > 0) body = { beforeTaskId: open[at - 1].id };
  else if (where === 'down' && at < open.length - 1) body = { afterTaskId: open[at + 1].id };
  if (!body) return;   // already at the end it was asked to move towards

  reorderPending = true;
  try {
    const r = await api(
      `/api/v1/workspaces/${ws()}/projects/${project.id}/tasks/${taskId}/reorder`,
      { method: 'POST', body });
    pj.detail.tasks = r.tasks;
    pj.detail.project = r.project;
    patchProjectTaskOrder();
    // Announced, because a keyboard user has no drag to watch.
    const now = r.tasks.filter((t) => t.status === 'open').findIndex((t) => t.id === taskId);
    saved(`Moved to ${now + 1} of ${r.tasks.filter((t) => t.status === 'open').length}`);
  } catch (e) {
    toast(e.message, true);
    await reloadProjectDetail();
  } finally { reorderPending = false; }
}

/**
 * A project task's actions.
 *
 * Ordering lives here as well as on the drag handle, because drag cannot be the
 * only way to reorder — it is unavailable to a keyboard and awkward on touch.
 */
function openProjectTaskMenu(anchor, taskId, project) {
  const open = (pj.detail?.tasks ?? []).filter((t) => t.status === 'open');
  const at = open.findIndex((t) => t.id === taskId);
  const isOpen = at !== -1;
  const isNext = project.nextAction?.id === taskId;

  openUtilityMenu(anchor, [
    { id: 'open', label: 'Open task' },
    // The same way in as Today: a task with no steps has no chip to click.
    ...(isOpen ? [{ id: 'steps', label: 'Add step' }] : []),
    ...(isOpen && !isNext ? [{ id: 'next', label: 'Make next action' }] : []),
    ...(isNext ? [{ id: 'unnext', label: 'Stop choosing it explicitly' }] : []),
    ...(isOpen && at > 0 ? [{ id: 'up', label: 'Move up' }] : []),
    ...(isOpen && at < open.length - 1 ? [{ id: 'down', label: 'Move down' }] : []),
    ...(isOpen && at > 0 ? [{ id: 'top', label: 'Move to top' }] : []),
    ...(isOpen && at < open.length - 1 ? [{ id: 'bottom', label: 'Move to bottom' }] : []),
    { id: 'remove', label: 'Remove from project' },
  ], (id) => {
    if (id === 'open') return openProjectTask(taskId);
    if (id === 'steps') return expandSteps(taskId);
    if (id === 'next') return setProjectNextAction(taskId);
    if (id === 'unnext') return setProjectNextAction(null);
    if (id === 'remove') return removeTaskFromProject(taskId);
    return moveProjectTask(taskId, id);
  });
}

/**
 * Choose which task is next.
 *
 * THE DEFECT THIS REPLACES: the button labelled "Choose" was the CLEAR button
 * wearing a second label. It POSTed `taskId: null` — a no-op when the action was
 * already inferred — and then called reloadProjectDetail(), which replaces the
 * whole detail body. That rebuild is what made it look like a page reload, and
 * it is what allowed a duplicated task row: the drag system parks the dragged
 * card on document.body, so replacing the list destroyed the placeholder while
 * the card floated free, and the fresh list then rendered a second node for the
 * same task.
 *
 * Now it opens a real picker and patches ONE slot.
 */
async function chooseNextAction(project) {
  if (nextActionSaving) return;
  const open = (pj.detail?.tasks ?? []).filter((t) => t.status === 'open');
  if (!open.length) { addProjectTask(project); return; }

  const currentId = project.nextAction?.explicit ? project.nextAction.id : null;
  const chosen = await openTaskPicker({
    title: 'Next action',
    hint: 'Pick one to keep it as the next action until it is done, removed or '
      + 'cleared. Automatic follows due date, then priority, then the order below.',
    tasks: open,
    areaName,
    currentId,
    autoOption: {
      label: 'Automatic',
      detail: 'Due date, then priority, then order',
    },
  });
  if (chosen === null) return;                       // cancelled — change nothing
  await setProjectNextAction(chosen === '__auto' ? null : chosen);
}

/** Guards a second submission while one next-action write is in flight. */
let nextActionSaving = false;

/**
 * One write, and only the slot is touched.
 *
 * The task list is deliberately NOT re-rendered: it is the thing a drag holds
 * references into, and rebuilding it while anything is mid-gesture is what
 * produced the ghost row.
 */
async function setProjectNextAction(taskId) {
  const project = pj.detail?.project;
  if (!project || nextActionSaving) return;
  nextActionSaving = true;
  const slot = document.getElementById('pjd-next');
  const before = slot?.innerHTML;
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/projects/${project.id}/next-action`,
      { method: 'POST', body: { taskId } });
    pj.detail.project = r.project;
    // The bucket is not drawn in this list, so there is nothing to re-render —
    // only the local record to keep truthful.
    if (r.surfaced) {
      const t = pj.detail.tasks.find((x) => x.id === taskId);
      if (t) t.bucket = 'today';
    }
    patchNextActionSlot();
    saved(
      !taskId ? 'Back to automatic'
        : r.surfaced ? 'Next action set — and put on Today'
          : 'Next action set',
    );
  } catch (e) {
    // Nothing was committed, so nothing is changed on screen either.
    if (slot && before != null) slot.innerHTML = before;
    wireNextActionSlot();
    toast(e.message, true);
  } finally { nextActionSaving = false; }
}

/** Crossfades the slot in place. No height jump, no list rebuild. */
function patchNextActionSlot() {
  const p = pj.detail?.project;
  const slot = document.getElementById('pjd-next');
  if (!p || !slot) return;
  const why = document.getElementById('pjd-next-why');
  const apply = () => {
    slot.innerHTML = nextActionSlotHtml(p);
    slot.classList.toggle('is-empty', !p.nextAction);
    if (why) why.textContent = nextActionWhy(p);
    wireNextActionSlot();
  };
  if (reducedMotion()) { apply(); return; }
  const out = slot.animate([{ opacity: 1 }, { opacity: 0 }],
    { duration: 140, easing: 'ease-in', fill: 'forwards' });
  settle(out, 140, () => {
    apply();
    out.cancel();
    slot.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
  });
}

function wireNextActionSlot() {
  const p = pj.detail?.project;
  if (!p) return;
  document.getElementById('pjd-next-choose')?.addEventListener('click', () => chooseNextAction(p));
  document.getElementById('pjd-next-add')?.addEventListener('click', () => addProjectTask(p));
  document.querySelectorAll('#pjd-next [data-pjd-open-task]').forEach((b) => {
    b.onclick = () => openProjectTask(b.dataset.pjdOpenTask);
  });
}

/** Opens a project task in the shared editor, with its project named. */
function openProjectTask(taskId) {
  const task = (pj.detail?.tasks ?? []).find((t) => t.id === taskId);
  const project = pj.detail?.project;
  if (!task) return;
  openTaskModal({
    task,
    areas: state.me?.areas ?? [],
    project: project ? { title: project.title } : null,
    onSave: async (body) => {
      await api(`/api/v1/workspaces/${ws()}/tasks/${task.id}`, { method: 'PATCH', body });
      await reloadProjectDetail();
      saved();
    },
    // The tick goes through the same path as the row's own tick, so unsaved
    // edits are carried into the completion and the Completed section updates
    // in place rather than on the next visit.
    onToggle: (dirty) => completeProjectTask(task.id, dirty),
    // Steps work here. They did not before: this call site passed no `steps`
    // at all, so every add, tick and rename threw into a swallowed rejection.
    steps: taskStepsCtx(task, () => patchProjectTaskRow(task.id)),
  });
}

/**
 * Repaints one project task row from the record behind it.
 *
 * The row markup is `taskHtml`, the same function Today uses, so the `2/4
 * steps` chip updates here exactly as it does there. Only this row is touched —
 * re-rendering the list would drop the drag references and the Completed
 * section along with it.
 */
function patchProjectTaskRow(taskId) {
  const task = (pj.detail?.tasks ?? []).find((t) => t.id === taskId);
  const row = document.querySelector(
    `#pjd-tasks .task[data-id="${taskId}"], .pjd-tasks-done .task[data-id="${taskId}"]`,
  );
  if (!task || !row) return;
  row.outerHTML = taskHtml(task);
  // The replacement is a new node, so it needs the project's wiring — not the
  // board's. See wireProjectTaskRows.
  const project = pj.detail?.project;
  if (project) wireProjectTaskRows(project);

  // The slot's step counts come from the server. Recompute them locally for
  // the one task that just changed, so the slot and the row agree before the
  // next read rather than after it.
  const next = project?.nextAction;
  if (next?.id === taskId) {
    const steps = task.steps ?? [];
    next.steps = steps.length
      ? { total: steps.length, done: steps.filter((s) => s.completed).length }
      : null;
  }
  patchNextActionSlot();
}

/**
 * Completes a project task, moving the SAME NODE into the Completed section.
 *
 * This was the standing known limitation: completion reloaded the whole detail
 * body, so the row vanished and reappeared somewhere else and the notes field
 * was recreated underneath whatever the user had typed.
 *
 * The order matters and is the same order Today uses. The row acknowledges the
 * click first, then it moves, and only then do the numbers change — two things
 * changing during the movement reads as a glitch.
 */
async function completeProjectTask(taskId, dirty = null) {
  const project = pj.detail?.project;
  const task = (pj.detail?.tasks ?? []).find((t) => t.id === taskId);
  if (!project || !task || task._busy) return;
  const wasDone = task.status === 'done';
  // The same rule in Project detail: the row is the same row, so it obeys the
  // same sequence. The override lives in the editor, in both places.
  if (!wasDone) {
    const blocked = parentBlockedReason(task);
    if (blocked) return toast(`${blocked}. Open the task to finish it anyway.`, true);
  }
  const row = document.querySelector(`#pjd-tasks .task[data-id="${taskId}"], .pjd-tasks-done .task[data-id="${taskId}"]`);
  task._busy = true;

  // Stage 1: the card acknowledges immediately — the same class Today uses.
  if (row && !wasDone) row.classList.add('is-completing');

  try {
    // The same single write Today uses: unsaved edits travel with the
    // completion, inside one transaction.
    const r = await api(
      `/api/v1/workspaces/${ws()}/tasks/${taskId}/${wasDone ? 'uncomplete' : 'complete'}`,
      { method: 'POST', body: dirty ?? {} });
    Object.assign(task, r.task);
    // Stage 2: the same node moves into (or out of) the Completed section.
    moveTaskNodeToSection(row, !wasDone);
    // Stage 3: the numbers, after the movement.
    const fresh = await api(`/api/v1/workspaces/${ws()}/projects/${project.id}`);
    if (pj.openId !== project.id) return;
    pj.detail.project = fresh.project;
    pj.detail.tasks = fresh.tasks;
    updateProjectDerived();
    patchNextActionSlot();
  } catch (e) {
    row?.classList.remove('is-completing');
    toast(e.message, true);
  } finally { task._busy = false; }
}

/**
 * Moves one task row between the open list and the Completed section.
 *
 * Creates the Completed section if it is not there yet, and removes it when it
 * empties — the same "only when it has something to say" rule the rest of the
 * app follows. The node itself is never re-created.
 */
function moveTaskNodeToSection(row, toDone) {
  if (!row) return;
  const openHost = document.getElementById('pjd-tasks');
  const section = openHost?.closest('.pjd-sec');
  if (!openHost || !section) return;

  let done = section.querySelector('.pjd-done');
  if (toDone && !done) {
    done = document.createElement('details');
    done.className = 'pjd-done';
    done.innerHTML = '<summary>0 finished</summary><div class="pjd-tasks pjd-tasks-done"></div>';
    section.appendChild(done);
  }
  const target = toDone ? done?.querySelector('.pjd-tasks-done') : openHost;
  if (!target) return;

  flip([...openHost.querySelectorAll('.task'), ...(done?.querySelectorAll('.task') ?? [])], () => {
    row.classList.remove('is-completing');
    row.classList.toggle('done', toDone);
    target.appendChild(row);            // MOVES the node — never a new one
    openHost.classList.toggle('is-empty', !openHost.querySelector('.task'));
    const n = done?.querySelectorAll('.task').length ?? 0;
    const summary = done?.querySelector('summary');
    if (summary) summary.textContent = `${n} finished`;
    if (done && n === 0) done.remove();
  });
  assertOneRowPerTask(openHost);
}

/**
 * Removes a task from its project. It is not a delete, and the label says so.
 *
 * Everything about the task survives — area, bucket, due date, schedule, steps,
 * priority. Only the relationship goes.
 */
async function removeTaskFromProject(taskId) {
  const project = pj.detail?.project;
  if (!project) return;
  const row = document.querySelector(`#pjd-tasks .task[data-id="${taskId}"]`);
  try {
    await api(`/api/v1/workspaces/${ws()}/projects/${project.id}/tasks/${taskId}`,
      { method: 'DELETE' });
    if (row && !reducedMotion()) collapseOut(row, () => {});
    await reloadProjectDetail();
    saved('Removed from project');
    undoBar('Task removed from project', async () => {
      await api(`/api/v1/workspaces/${ws()}/projects/${project.id}/tasks`,
        { method: 'POST', body: { taskId, areaChoice: 'keep' } });
      await reloadProjectDetail();
      saved('Put back');
    });
  } catch (e) { toast(e.message, true); await reloadProjectDetail(); }
}

/**
 * Adds a task that already exists.
 *
 * Only tasks belonging to NO project are offered. Moving a task out of another
 * project is a different decision with a different consequence, and it is not
 * something a search list should do quietly — so it is not offered here at all
 * rather than offered and then confirmed away.
 */
async function addExistingTask(project) {
  let candidates = [];
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/tasks?status=open&limit=200`);
    candidates = (r.tasks ?? []).filter((t) => !t.projectId);
  } catch (e) { toast(e.message, true); return; }

  if (!candidates.length) {
    toast('Every open task already belongs to a project.');
    return;
  }
  const chosen = await openTaskPicker({
    title: 'Add an existing task',
    tasks: candidates,
    areaName,
  });
  if (!chosen) return;
  try {
    await api(`/api/v1/workspaces/${ws()}/projects/${project.id}/tasks`,
      { method: 'POST', body: { taskId: chosen } });
    await reloadProjectDetail();
    saved('Task added');
  } catch (e) {
    let detail = null;
    try { detail = JSON.parse(e.message); } catch { /* a real error */ }
    if (detail?.reason !== 'area_mismatch') { toast(e.message, true); return; }
    // The same area contract as everywhere else: never reclassify silently.
    const task = candidates.find((t) => t.id === chosen);
    const choice = await openChoiceDialog({
      title: 'That task is in a different area',
      body: `"${task?.title ?? 'The task'}" is filed under `
        + `${areaName(detail.taskAreaId)}, and this project is `
        + `${areaName(detail.projectAreaId)}.`,
      choices: [
        { id: 'keep', label: `Keep it in ${areaName(detail.taskAreaId)}` },
        { id: 'move', label: `Move it to ${areaName(detail.projectAreaId)}` },
      ],
    });
    if (!choice) return;
    try {
      await api(`/api/v1/workspaces/${ws()}/projects/${project.id}/tasks`,
        { method: 'POST', body: { taskId: chosen, areaChoice: choice } });
      await reloadProjectDetail();
      saved('Task added');
    } catch (e2) { toast(e2.message, true); }
  }
}

/**
 * Notes.
 *
 * Explicit save state, no AI rewrite, and the user's text is never discarded:
 * a failed save leaves the content in the editor and offers a retry, because
 * the editor is the only copy.
 */
function wireProjectNotes(project) {
  const ta = document.getElementById('pjd-notes');
  const badge = document.getElementById('pjd-save');
  if (!ta || !badge) return;
  let lastSaved = ta.value;

  const setState = (s, text) => { badge.dataset.state = s; badge.textContent = text; };

  const save = async () => {
    const value = ta.value;
    if (value === lastSaved) { setState('idle', ''); return; }
    setState('saving', 'Saving…');
    try {
      await api(`/api/v1/workspaces/${ws()}/projects/${project.id}`, {
        method: 'PATCH', body: { notes: value },
      });
      lastSaved = value;
      setState('saved', 'Saved');
      setTimeout(() => { if (badge.dataset.state === 'saved') setState('idle', ''); }, 2000);
    } catch (e) {
      // Never a false "Saved", and never a wipe.
      setState('error', 'Not saved — retry');
      badge.onclick = () => save();
    }
  };

  ta.addEventListener('input', () => {
    setState('dirty', 'Unsaved');
    clearTimeout(pj.saveTimer);
    pj.saveTimer = setTimeout(save, 1200);
  });
  ta.addEventListener('blur', () => { clearTimeout(pj.saveTimer); save(); });

  // Leaving with unsaved text warns rather than losing it.
  window.addEventListener('beforeunload', (e) => {
    if (badge.dataset.state === 'dirty' || badge.dataset.state === 'error') {
      e.preventDefault(); e.returnValue = '';
    }
  });
}

/* ── Google Calendar connection ─────────────────────────────────────────
 * The browser never sees a token. It asks the API for an authorize URL and
 * follows it; everything else happens server-side. */
async function connectGoogle(btn) {
  btn.classList.add('is-busy');
  btn.textContent = 'Opening Google…';
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/integrations/google-calendar/connect`,
      { method: 'POST' });
    window.location.href = r.authorizeUrl;
  } catch (e) {
    btn.classList.remove('is-busy');
    btn.textContent = 'Connect Google Calendar';
    toast(e.message, true);
  }
}

async function syncGoogle() {
  if (cal.data?.connection) cal.data.connection.status = 'syncing';
  renderCalendarRail();
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/integrations/google-calendar/sync`,
      { method: 'POST' });
    await loadCalendar();
    saved(r.created || r.updated
      ? `Synced ${r.created + r.updated} event${r.created + r.updated === 1 ? '' : 's'}`
      : 'Up to date');
  } catch (e) {
    if (cal.data?.connection) {
      cal.data.connection.status = 'error';
      cal.data.connection.lastError = e.message;
    }
    renderCalendarRail();
    toast(e.message, true);
  }
}

async function disconnectGoogle() {
  if (!confirm('Disconnect Google Calendar? Your Google events will be removed '
    + 'from Life OS. Nothing in Google Calendar itself is changed.')) return;
  try {
    await api(`/api/v1/workspaces/${ws()}/integrations/google-calendar/disconnect`,
      { method: 'POST' });
    cal.data = null;
    await loadCalendar();
    saved('Disconnected');
  } catch (e) { toast(e.message, true); }
}

async function setCalendarVisible(id, visible) {
  const c = cal.data?.calendars.find((x) => x.id === id);
  if (c) c.isVisible = visible;
  paintCalendar();
  try {
    await api(`/api/v1/workspaces/${ws()}/calendars/${id}`,
      { method: 'PATCH', body: { isVisible: visible } });
  } catch (e) {
    if (c) c.isVisible = !visible;
    paintCalendar();
    toast(e.message, true);
  }
}

/** Schedules a queued task without dragging — keyboard and touch path. */
async function scheduleFromQueue(taskId) {
  const hrs = planHours();
  const week = weekOf(cal.anchor).map(iso);
  // First free window of at least an hour, from today onward.
  for (const day of week) {
    if (day < iso(new Date())) continue;
    for (const [from, to] of freeWindowsFor(day)) {
      if (to - from < 60) continue;
      const mk = (min) => {
        const [y, m, d] = day.split('-').map(Number);
        return new Date(y, m - 1, d, Math.floor(min / 60), min % 60).toISOString();
      };
      return scheduleTask(taskId, mk(from), mk(from + 60));
    }
  }
  toast('No free hour left this week. Try another week.', true);
}

/** Drops a task into a time slot. One write, after the drop. */
async function scheduleTask(taskId, startsAt, endsAt) {
  const task = (cal.data?.unscheduled ?? []).find((t) => t.id === taskId)
    ?? (cal.data?.deadlines ?? []).find((t) => t.id === taskId);
  const optimistic = {
    id: `tmp-${taskId}`, taskId, startsAt, endsAt,
    title: task?.title ?? 'Task', priority: task?.priority ?? 'medium',
    areaId: task?.areaId ?? null, dueDate: task?.dueDate ?? null,
  };
  cal.data.blocks.push(optimistic);
  paintCalendar();
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/calendar/blocks`,
      { method: 'POST', body: { taskId, startsAt, endsAt } });
    // Adopt the real id without moving anything visually.
    const i = cal.data.blocks.findIndex((b) => b.id === optimistic.id);
    if (i > -1) cal.data.blocks[i] = { ...optimistic, id: r.block.id };
    paintCalendar();
    saved('Scheduled');
  } catch (e) {
    cal.data.blocks = cal.data.blocks.filter((b) => b.id !== optimistic.id);
    paintCalendar();
    toast(e.message, true);
  }
}

/** Moves or resizes a block. Rolls back to the original slot on failure. */
async function moveBlock(blockId, startsAt, endsAt) {
  const b = cal.data?.blocks.find((x) => x.id === blockId);
  if (!b) return;
  const before = { startsAt: b.startsAt, endsAt: b.endsAt };
  b.startsAt = startsAt; b.endsAt = endsAt;
  paintCalendar();
  try {
    await api(`/api/v1/workspaces/${ws()}/calendar/blocks/${blockId}`,
      { method: 'PATCH', body: { startsAt, endsAt } });
    saved('Moved');
  } catch (e) {
    Object.assign(b, before);
    paintCalendar();
    toast(e.message, true);
  }
}

const MODE_IDS = ['month', 'agenda', 'plan'];

/**
 * The legend popover.
 *
 * Deliberately a popover and not a permanent panel: a legend that is always on
 * screen is an admission that the interface needs a manual. This is here for
 * the first week and for the one indicator you cannot place.
 */
const toggleLegend = (btn) => openCalendarSurface(btn, 'key');

/**
 * Opens the scheduling flow. Reached from + Add, from a clicked Plan slot, and
 * from a queue card's Schedule button — all three land here so the conflict
 * check and the one-write-on-confirm rule cannot diverge between them.
 */
function openScheduleTask({ day = null, time = null, taskId = null } = {}) {
  const scheduled = new Set((cal.data?.blocks ?? []).map((b) => b.taskId));
  const pool = [
    ...(cal.data?.deadlines ?? []),
    ...(cal.data?.unscheduled ?? []),
  ].filter((t) => !scheduled.has(t.id));
  // De-duplicate: a task with a due date can appear in both collections.
  const seen = new Set();
  let tasks = pool.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
  if (taskId) tasks = [...tasks].sort((a, b) => (a.id === taskId ? -1 : b.id === taskId ? 1 : 0));

  openScheduleTaskModal({
    tasks,
    day,
    time,
    areaName: (id) => (state.me?.areas ?? []).find((a) => a.id === id)?.name ?? null,
    conflictsAt: (dayIso, startMin, endMin) => {
      const { events, blocks } = itemsForDay(dayIso);
      const mins = (d) => { const x = new Date(d); return x.getHours() * 60 + x.getMinutes(); };
      const out = [];
      for (const e of events) {
        if (e.isAllDay || !e.startsAt || !e.endsAt) continue;
        // Respect Google's free/busy: an event marked free does not block time.
        if (e.transparency === 'transparent') continue;
        if (mins(e.startsAt) < endMin && mins(e.endsAt) > startMin) out.push(e.title);
      }
      for (const b of blocks) {
        if (mins(b.startsAt) < endMin && mins(b.endsAt) > startMin) out.push(b.title);
      }
      return out;
    },
    onSchedule: (id, startsAt, endsAt) => scheduleTask(id, startsAt, endsAt),
    onOpenTasks: () => go('today'),
  });
}

/** Read-only detail for a synced Google event. No Save, no Edit. */
function openEventDetail(ev) {
  const when = ev.isAllDay
    ? (ev.endDate && ev.endDate !== ev.startDate
      ? `All day · ${prettyDay(ev.startDate)} – ${prettyDay(ev.endDate)}`
      : `All day · ${prettyDay(ev.startDate)}`)
    : `${new Date(ev.startsAt).toLocaleDateString(undefined,
      { weekday: 'long', day: 'numeric', month: 'long' })}
`
      + `${hhmmOf(ev.startsAt)} – ${hhmmOf(ev.endsAt)}`;
  const going = (ev.attendees ?? []).filter((a) => a.responseStatus === 'accepted').length;
  const links = (cal.data?.links ?? []).filter((l) => l.sourceId === ev.id);

  openDetailSheet({
    title: ev.title,
    accent: ev.calendarColor,
    rows: [
      ['When', when],
      ['Calendar', ev.calendarName],
      ev.location ? ['Where', ev.location] : null,
      ev.recurrence ? ['Repeats', 'Yes'] : null,
      ev.attendees?.length ? ['Guests', `${going} of ${ev.attendees.length} going`] : null,
      ev.transparency === 'transparent' ? ['Shows as', 'Free'] : null,
      ev.visibility && ev.visibility !== 'default' ? ['Visibility', ev.visibility] : null,
      ev.description ? ['Details', ev.description] : null,
      links.length ? ['Life OS', `${links.length} linked item${links.length > 1 ? 's' : ''}`] : null,
    ].filter(Boolean),
    meetLink: ev.hangoutLink ?? null,
    externalLink: ev.providerHtmlLink ?? null,
    // Stated plainly rather than implied by a missing button.
    note: 'This event lives in Google Calendar. Life OS can read it but not change it.',
  });
}

const prettyDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined,
  { weekday: 'short', day: 'numeric', month: 'short' });
const hhmmOf = (t) => new Date(t).toLocaleTimeString(undefined,
  { hour: '2-digit', minute: '2-digit' });

/**
 * Source management as a popover.
 *
 * It used to occupy the whole Agenda rail, which meant the mode least
 * concerned with plumbing showed the most of it. Connection state stays
 * visible in the rail context card; the controls appear when asked for.
 */
const toggleSources = (btn) => openCalendarSurface(btn, 'sources');

/* ══ Reminders ══════════════════════════════════════════════════════════ */

/**
 * Reminder detail — a Life OS record, so it gets a Life OS surface.
 *
 * Never the Event editor: a reminder has no duration, no attendees and no
 * calendar, and pouring it into an event form would imply all three.
 */
function openReminderDetail(id, from = null) {
  const r = (from ?? cal.data?.reminders ?? []).find((x) => x.id === id);
  if (!r) return;
  const words = recurrenceWords(r.recurrence);
  const done = r.status === 'done';
  const overdue = !done && r.dueDate < iso(new Date());

  openDetailSheet({
    title: r.title,
    accent: 'var(--warn)',
    rows: [
      ['When', `${prettyDay(r.dueDate)}${r.dueTime ? ` at ${r.dueTime}` : ''}`],
      words ? ['Repeats', words[0].toUpperCase() + words.slice(1)] : null,
      r.leadDays ? ['Notify', `${r.leadDays} day${r.leadDays > 1 ? 's' : ''} before`] : null,
      r.areaId ? ['Area', areaName(r.areaId)] : null,
      r.notes ? ['Notes', r.notes] : null,
      ['Status', done ? 'Done' : overdue ? 'Overdue' : 'Open'],
    ].filter(Boolean),
    actions: [
      { label: done ? 'Mark not done' : 'Mark done', primary: !done,
        onClick: () => toggleReminder(id) },
      { label: 'Edit', onClick: () => editReminder(id) },
    ],
  });
}

function editReminder(id, from = null) {
  const r = (from ?? cal.data?.reminders ?? []).find((x) => x.id === id);
  if (!r) return;
  openReminderModal({
    reminder: r,
    areas: state.me?.areas ?? [],
    onSave: async (body) => {
      const res = await api(`/api/v1/workspaces/${ws()}/reminders/${id}`,
        { method: 'PATCH', body });
      const i = cal.data.reminders.findIndex((x) => x.id === id);
      if (i > -1) cal.data.reminders[i] = res.reminder;
      paintCalendar();
      saved('Reminder saved');
    },
    onDelete: async () => {
      if (!confirm(`Delete "${r.title}"? This cannot be undone.`)) return;
      await api(`/api/v1/workspaces/${ws()}/reminders/${id}`, { method: 'DELETE' });
      cal.data.reminders = cal.data.reminders.filter((x) => x.id !== id);
      paintCalendar();
      saved('Reminder deleted');
    },
  });
}


/**
 * Ticking a reminder.
 *
 * A recurring reminder ADVANCES rather than closing — the server works out the
 * next occurrence, because the recurrence rule lives there and duplicating the
 * date maths in the client is how the two drift apart.
 *
 * This function had been deleted by an earlier refactor while two call sites
 * still referenced it, so the Agenda checkbox was throwing on click.
 */
async function toggleReminder(id) {
  const r = cal.data?.reminders.find((x) => x.id === id);
  if (!r || r._busy) return;
  const before = { status: r.status, dueDate: r.dueDate, completedAt: r.completedAt };
  const wasDone = r.status === 'done';

  r._busy = true;
  r.status = wasDone ? 'open' : 'done';
  patchReminderRow(id);

  try {
    const res = await api(
      `/api/v1/workspaces/${ws()}/reminders/${id}/${wasDone ? 'reopen' : 'complete'}`,
      { method: 'POST' });
    Object.assign(r, res.reminder);
    if (res.advancedTo) {
      saved(`Done — next on ${prettyDay(res.advancedTo)}`);
      collapseReminder(id, () => paintCalendar());
    } else if (!wasDone) {
      saved('Done');
      collapseReminder(id, () => paintCalendar());
    } else {
      saved('Reopened');
      paintCalendar();
    }
  } catch (e) {
    Object.assign(r, before);
    patchReminderRow(id);
    toast(e.message, true);
  } finally {
    r._busy = false;
  }
}

/** Patches every rendering of ONE reminder without rebuilding the canvas. */
function patchReminderRow(id) {
  const r = cal.data?.reminders.find((x) => x.id === id);
  if (!r) return;
  document.querySelectorAll(`[data-reminder="${id}"]`).forEach((el) => {
    const row = el.closest('.ag-reminder') ?? el;
    row.classList.toggle('is-done', r.status === 'done');
    if (el.classList.contains('ag-check')) {
      el.setAttribute('aria-pressed', String(r.status === 'done'));
    }
  });
}

/**
 * Collapses every rendering of a reminder before the repaint.
 *
 * A reminder can be on screen three times at once — a Month cell, the Agenda
 * stream and the Plan strip — so completion has to collapse all of them or the
 * repaint yanks the survivors away with no transition.
 */
function collapseReminder(id, done) {
  const rows = [...document.querySelectorAll(`[data-reminder="${id}"]`)]
    .map((el) => el.closest('.ag-reminder') ?? el)
    .filter((el, i, a) => a.indexOf(el) === i);
  if (!rows.length || reducedMotion()) return done();
  let pending = rows.length;
  const finish = () => { if (--pending <= 0) done(); };
  for (const row of rows) collapseOut(row, finish);
}

/* ══ Reminders workspace ════════════════════════════════════════════════ */

/** Loads the RULES, not a date window — the overview is about what you own. */
async function loadReminders() {
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/reminders`);
    cal.reminders = r.reminders ?? [];
  } catch (e) {
    cal.reminders = [];
    toast(e.message, true);
  }
}

/**
 * Enters the Reminders workspace.
 *
 * Snapshots the calendar position first. Without that, leaving reminders
 * rebuilt Month from whatever `cal.anchor` happened to be — and since the
 * period controls were still live behind the workspace, that was often not
 * where the user left.
 */
async function openRemindersView(push = true) {
  cal.resume = { mode: cal.mode, anchor: new Date(cal.anchor), selected: cal.selected };
  cal.utility = 'reminders';
  // A utility has no selected day; leaving one behind is what leaked the
  // Month rail into the reminder list.
  cal.selected = null;
  cal.enter = 'mode';
  if (push) history.pushState(null, '', '#calendar/reminders');
  await loadReminders();
  if (state.route !== 'calendar') return;
  renderCalendarHeader();
  paintCalendar();
}

function closeRemindersView(push = true) {
  const back = cal.resume;
  cal.utility = 'none';
  cal.resume = null;
  if (back) {
    cal.mode = back.mode;
    cal.anchor = back.anchor;
    cal.selected = back.selected;
  }
  cal.enter = 'mode';
  if (push) history.pushState(null, '', '#calendar');
  renderCalendarHeader();
  // Reload rather than repaint: the range for the restored period may not be
  // the one currently in memory.
  loadCalendar();
}

/** Redraws the header in place, so the mode pill never flashes. */
function renderCalendarHeader() {
  const head = document.getElementById('page-head');
  if (head) head.innerHTML = calendarHeaderHtml();
  wireCalendarHeader();
}

/**
 * The Calendar utility menu — the same component Today uses.
 *
 * Plain labels, no unexplained icons, and the same trigger, anchor, motion and
 * close behaviour as every other overflow in the app.
 */
function openCalendarUtility(anchor) {
  openUtilityMenu(anchor, [
    { id: 'reminders', label: 'Manage reminders' },
    { id: 'sources', label: 'Calendar sources' },
    { id: 'key', label: 'Calendar key' },
  ], (id) => {
    if (id === 'reminders') return openRemindersView();
    return openCalendarSurface(anchor, id);
  });
}

/**
 * Calendar sources and the Calendar key, in ONE shell.
 *
 * They used to be two floating panels of different widths that opened in
 * different directions from different triggers. They answer questions of the
 * same kind — "what am I looking at" and "where is it coming from" — so they
 * are the same object with different contents.
 */
function openCalendarSurface(anchor, kind) {
  openUtilitySurface(anchor, {
    kind,
    label: kind === 'sources' ? 'Calendar sources' : 'Calendar key',
    html: kind === 'sources' ? sourcesPopoverHtml() : legendHtml(),
    wire: (el) => (kind === 'sources' ? wireSources(el) : null),
  });
}

/** The source controls, wired wherever the shared shell put them. */
function wireSources(el) {
  const connect = el.querySelector('#cal-connect');
  connect?.addEventListener('click', () => connectGoogle(connect));
  el.querySelector('#cal-sync')?.addEventListener('click', () => { closeUtility(); syncGoogle(); });
  el.querySelector('#cal-disconnect')?.addEventListener('click',
    () => { closeUtility(); disconnectGoogle(); });
  el.querySelectorAll('[data-calendar]').forEach((cb) => {
    cb.onchange = () => setCalendarVisible(cb.dataset.calendar, cb.checked);
  });
}

function wireRemindersView() {
  document.querySelectorAll('[data-rv-filter]').forEach((b) => {
    b.onclick = () => {
      cal.reminderFilter = b.dataset.rvFilter;
      paintCalendar();
    };
  });
  document.getElementById('rv-add')?.addEventListener('click', () => addReminder(null));
  document.querySelectorAll('[data-rv-open]').forEach((b) => {
    b.onclick = () => openReminderDetail(b.dataset.rvOpen, cal.reminders);
  });
  document.querySelectorAll('[data-rv-edit]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); editReminder(b.dataset.rvEdit, cal.reminders); };
  });
  document.querySelectorAll('[data-rv-toggle]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); toggleReminderInView(b.dataset.rvToggle); };
  });
  document.querySelectorAll('[data-rv-pause]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); pauseReminder(b.dataset.rvPause); };
  });
}

/** Completion from the overview, where the row shows a rule not a date. */
async function toggleReminderInView(id) {
  const r = cal.reminders?.find((x) => x.id === id);
  if (!r || r._busy) return;
  const before = { ...r };
  const wasDone = r.status === 'done';
  r._busy = true;
  try {
    const res = await api(
      `/api/v1/workspaces/${ws()}/reminders/${id}/${wasDone ? 'reopen' : 'complete'}`,
      { method: 'POST' });
    Object.assign(r, res.reminder);
    await loadReminders();
    paintCalendar();
    saved(res.advancedTo ? `Done — next on ${prettyDay(res.advancedTo)}`
      : wasDone ? 'Reopened' : 'Done');
  } catch (e) {
    Object.assign(r, before);
    paintCalendar();
    toast(e.message, true);
  } finally { r._busy = false; }
}

/** Pause keeps the rule and its history but stops it appearing on the canvas. */
async function pauseReminder(id) {
  const r = cal.reminders?.find((x) => x.id === id);
  if (!r) return;
  const paused = r.status === 'paused';
  try {
    await api(`/api/v1/workspaces/${ws()}/reminders/${id}/${paused ? 'resume' : 'pause'}`,
      { method: 'POST' });
    await loadReminders();
    paintCalendar();
    saved(paused ? 'Resumed' : 'Paused');
  } catch (e) { toast(e.message, true); }
}

/* ══ Completed history ══════════════════════════════════════════════════
 *
 * This renderer, and wireHistory below, were deleted by an earlier block
 * replacement while the route still called them — so opening Completed threw
 * "historyHtml is not defined". Same failure mode as toggleReminder: a
 * refactor that removed a definition and left the call sites behind.
 *
 * History is for recovery and reflection, not a daily destination, so it is
 * plain: what it was, when you finished it, and a way to put it back.
 */
function historyHtml() {
  if (!state.history.length) {
    return `<div class="state"><b>Nothing completed yet</b>
      Finished tasks collect here, newest first.</div>`;
  }
  const more = state.history.length < state.historyTotal;
  return `<div class="hist-list">
      ${state.history.map(historyRowHtml).join('')}
    </div>
    ${more ? `<button class="btn hist-more" id="hist-more">
      Show more (${state.historyTotal - state.history.length} left)</button>`
    : `<p class="hist-end">That is all ${state.historyTotal} of them.</p>`}`;
}

function historyRowHtml(t) {
  const when = t.completedAt
    ? new Date(t.completedAt).toLocaleDateString(undefined,
      { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const area = t.areaId ? areaName(t.areaId) : null;
  return `<div class="hist-row" data-hist="${t.id}">
    <span class="hist-tick">${icon('check', 14)}</span>
    <span class="hist-title">${esc(t.title)}</span>
    <span class="hist-meta">
      ${area ? `<span class="tm-area">${esc(area)}</span>` : ''}
      <span class="hist-when ${when ? '' : 'unknown'}">${esc(when ?? 'date unknown')}</span>
      <button class="hist-restore" data-restore="${t.id}">Restore</button>
    </span>
  </div>`;
}

function wireHistory() {
  document.getElementById('hist-more')?.addEventListener('click', () => run(async () => {
    await loadHistory();
    document.getElementById('main-scroll').innerHTML = historyHtml();
    wireHistory();
  }));
  document.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); restoreTask(b.dataset.restore); };
  });
  document.querySelectorAll('[data-hist]').forEach((row) => {
    row.onclick = () => openTask(row.dataset.hist);
  });
}

/**
 * Puts a completed task back on the board.
 *
 * The SAME record, uncompleted. Not a copy, not a re-creation: `/uncomplete`
 * clears `status` and `completedAt` and touches nothing else, so title, notes,
 * steps and their individual completed states, area, project, priority, dates
 * and the bucket it was in all survive untouched. Restoring a task you
 * finished with two of four steps ticked gives you back exactly that.
 *
 * It lands in whatever bucket it already had — the bucket was never cleared on
 * completion, so the original is still there and still valid.
 */
async function restoreTask(id) {
  const t = findTask(id);
  if (!t) return;
  const row = document.querySelector(`[data-hist="${id}"]`);
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/tasks/${id}/uncomplete`, { method: 'POST' });
    // The server's record wins, but the steps ride along locally: /uncomplete
    // returns the task row, and the step list is not part of it.
    const restored = { ...r.task, steps: t.steps ?? [] };

    state.history = state.history.filter((x) => x.id !== id);
    state.historyTotal = Math.max(0, state.historyTotal - 1);
    if (!state.tasks.some((x) => x.id === id)) state.tasks.push(restored);

    // Project detail, if this task belongs to a project that is open.
    const inProject = (pj.detail?.tasks ?? []).find((x) => x.id === id);
    if (inProject) Object.assign(inProject, restored);

    if (row) {
      collapseOut(row, () => {
        document.getElementById('main-scroll').innerHTML = historyHtml();
        wireHistory();
      });
    }
    // Wherever it now belongs, it appears there immediately and says so.
    if (state.route === 'today') {
      rebuildBucket(restored.bucket);
      wireBoard();
      const card = document.querySelector(`.task[data-id="${id}"]`);
      if (card) pulse(card);
    }
    if (inProject) await reloadProjectDetail();
    saved(`Back in ${bucketLabel(restored.bucket)}`);
  } catch (e) { toast(e.message, true); }
}

/** The bucket's own name, so the toast can say where the task went. */
const bucketLabel = (id) => BUCKETS.find((b) => b.id === id)?.label ?? 'your board';

/** Today's overflow: secondary actions that should not sit in the board. */
function openTodayMenu(anchor) {
  openUtilityMenu(anchor, [
    // In the overflow, not the toolbar. It is a way to re-run a rule that
    // normally runs itself — useful, and not something to look at all day.
    { id: 'arrange', label: 'Arrange today', icon: icon('sort', 16) },
    { id: 'history', label: 'View completed tasks', icon: icon('check', 16),
      count: state.historyTotal },
  ], (id) => {
    if (id === 'history') return go('history');
    if (id === 'arrange') return arrangeToday({ manual: true });
    return undefined;
  });
}

/* ══ Today's daily arrangement ═══════════════════════════════════════════
 *
 * Once per local calendar day, on first open, standalone tasks are put into a
 * recommended order. Project tasks are never touched — see arrange.js.
 */

/**
 * Slots a newly created standalone task into a sensible place.
 *
 * The task arrives at the END of its bucket, because that is where the API puts
 * it. If Today has already been arranged for the day, dropping an urgent
 * scheduled task at the bottom contradicts the order the user was just given —
 * but re-sorting the bucket would throw away every manual move they have made
 * since. §14's answer: find where it belongs and insert it ONCE. One task
 * moves. Everything else stays exactly where the user left it.
 *
 * Project tasks are skipped entirely. They are not the arranger's business,
 * and a new project task simply lands at the end of the project group.
 */
async function placeNewTask(task) {
  if (!isStandalone(task)) return;
  const { standalone } = partition(inBucket(task.bucket), state.projectsById);
  const others = standalone.filter((t) => t.id !== task.id);
  if (!others.length) return;

  const at = insertionIndex(others, task);
  if (at >= others.length) return;                 // the end is already correct

  // Midpoint between its new neighbours, so ONE row is written.
  const before = others[at - 1]?.position ?? (others[at].position - GAP_STEP * 2);
  const after = others[at].position;
  task.position = Math.round((before + after) / 2);
  try {
    await api(`/api/v1/workspaces/${ws()}/tasks/reorder`,
      { method: 'POST', body: { positions: [{ id: task.id, position: task.position }] } });
  } catch {
    // It stays at the end. A new task in the wrong place is a small annoyance;
    // a failed write that silently rewrote the board is not.
  }
}

/** Matches the API's sparse spacing, so midpoints never collide. */
const GAP_STEP = 1000;

/** The order before the last arrangement, per bucket, so Undo is real. */
let arrangeUndo = null;

/**
 * Runs the arrangement at most once per local day, across tabs and devices.
 *
 * The guard is a server-side conditional UPDATE, not a localStorage flag: two
 * tabs open at 08:00 both ask, Postgres serialises them, and exactly one gets
 * `claimed: true`. localStorage would let each tab decide for itself, and two
 * devices would each arrange the same morning.
 */
async function maybeArrangeToday() {
  const today = localDate();
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/today/arrange-claim`,
      { method: 'POST', body: { localDate: today } });
    if (!r.claimed) return;              // already done today, or another tab won
    await arrangeToday({ manual: false, claimedDate: today });
  } catch {
    // A failed claim means no arrangement, which is the safe direction: the
    // board simply stays in the order the user left it.
  }
}

/**
 * Puts each bucket's standalone tasks into the recommended order.
 *
 * Partitioned first, sorted second — never sorted whole and re-split, which
 * would move project rows relative to each other even though none of them
 * ended up in the standalone list.
 */
async function arrangeToday({ manual = false, claimedDate = null } = {}) {
  const now = new Date();
  const before = new Map();
  const writes = [];

  for (const b of BUCKETS) {
    const list = inBucket(b.id);
    const { standalone } = partition(list, state.projectsById);
    if (standalone.length < 2) continue;

    const sorted = arrangeStandalone(standalone, now);
    if (!orderChanged(standalone, sorted)) continue;

    // Exact positions, so Undo restores values rather than guessing an order.
    before.set(b.id, standalone.map((t) => ({ id: t.id, position: t.position })));
    // Renumber only within the positions these tasks already occupied, so
    // project rows in the same bucket keep the slots they had.
    const slots = standalone.map((t) => t.position).sort((x, y) => x - y);
    sorted.forEach((t, i) => { t.position = slots[i]; });
    writes.push(...sorted.map((t) => ({ id: t.id, position: t.position, bucket: b.id })));
  }

  if (!writes.length) {
    if (manual) toast('Today is already in the recommended order.');
    return;
  }

  // Move the SAME nodes, one coordinated FLIP, before anything is persisted —
  // the user sees the result immediately and the write catches up.
  flip(document.querySelectorAll('.task'), () => {
    for (const b of before.keys()) rebuildBucket(b);
    wireBoard();
  });

  try {
    await api(`/api/v1/workspaces/${ws()}/tasks/reorder`, {
      method: 'POST',
      body: { positions: writes.map(({ id, position }) => ({ id, position })) },
    });
    arrangeUndo = { before, at: Date.now(), localDate: claimedDate ?? localDate() };
    toast('Today was arranged by time and priority.', false, {
      label: 'Undo', onAction: undoArrange,
    });
  } catch (e) {
    // Put every position back and redraw: showing an order the server rejected
    // is worse than showing none, because the next reload contradicts it.
    for (const [bucketId, rows] of before) {
      for (const { id, position } of rows) {
        const t = findTask(id);
        if (t) t.position = position;
      }
      rebuildBucket(bucketId);
    }
    wireBoard();
    arrangeUndo = null;
    toast(`Could not arrange Today: ${e.message}`, true);
  }
}

/** Restores the exact positions every affected bucket had before. */
async function undoArrange() {
  const undo = arrangeUndo;
  if (!undo) return;
  arrangeUndo = null;

  const writes = [];
  for (const [bucketId, rows] of undo.before) {
    for (const { id, position } of rows) {
      const t = findTask(id);
      if (t) { t.position = position; writes.push({ id, position }); }
    }
    void bucketId;
  }

  flip(document.querySelectorAll('.task'), () => {
    for (const bucketId of undo.before.keys()) rebuildBucket(bucketId);
    wireBoard();
  });

  try {
    await api(`/api/v1/workspaces/${ws()}/tasks/reorder`,
      { method: 'POST', body: { positions: writes } });
    // The day is given back: an arrangement the user rejected should not also
    // cost them tomorrow's offer.
    await api(`/api/v1/workspaces/${ws()}/today/arrange-release`,
      { method: 'POST', body: { localDate: undo.localDate } }).catch(() => {});
    saved('Order restored');
  } catch (e) {
    toast(`Could not undo: ${e.message}`, true);
  }
}
