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
import { flip, pulse, collapseOut, reducedMotion } from './motion.js';
import { openTaskModal } from './task-modal.js';
import { openHabitModal } from './habit-modal.js';
import { initStars } from './stars.js';
import { settingsHtml } from './settings.js';

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
  habits: [], habitsLoaded: false, habitsError: null,
};

const root = document.getElementById('root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── API ─────────────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const hasBody = opts.body !== undefined;
  const res = await fetch(`${CFG.apiBaseUrl}${path}`, {
    ...opts,
    // Never let a service worker or the HTTP cache answer an API call. Task
    // data is private and must always come from the server.
    cache: 'no-store',
    headers: {
      // Only declare a JSON body when there is one — Fastify rejects an empty
      // body that claims to be JSON, which silently broke every action route.
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(opts.headers || {}),
    },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.message || `Request failed (${res.status})`);
  }
  return data;
}
const ws = () => state.me.workspace.id;

/* ── Toast ───────────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg, isError = false) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3600);
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
  chevL: '<path d="m12 5-5 5 5 5"/>',
  chevR: '<path d="m8 5 5 5-5 5"/>',
  dots: '<circle cx="10" cy="4.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="15.5" r="1.4" fill="currentColor" stroke="none"/>',
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
    if (!user) return renderSignIn(() => auth.signInWithPopup(a, new auth.GoogleAuthProvider()));
    state.token = await user.getIdToken();
    setInterval(async () => {
      state.token = await user.getIdToken(true);
      localStorage.setItem('los2_token', state.token);
    }, 45 * 60 * 1000);
    localStorage.setItem('los2_token', state.token);
    window.__signOut = () => {
      // A token must never outlive the session in storage.
      localStorage.removeItem('los2_token'); localStorage.removeItem('los2_ws');
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
  const { tasks } = await api(`/api/v1/workspaces/${ws()}/tasks?includeCompleted=false`);
  state.tasks = tasks;
}
async function loadHistory(reset = false) {
  if (reset) { state.history = []; state.historyTotal = 0; }
  const r = await api(`/api/v1/workspaces/${ws()}/tasks`
    + `?status=done&limit=${HISTORY_PAGE}&offset=${state.history.length}`);
  state.history = [...state.history, ...r.tasks];
  state.historyTotal = r.total;
}

const inBucket = (b) => state.tasks
  .filter((t) => t.bucket === b && t.status !== 'done'
    && (!state.areaFilter || t.areaId === state.areaFilter))
  .sort((x, y) => x.position - y.position);
const areaName = (id) => state.me.areas.find((a) => a.id === id)?.name || '';
const findTask = (id) => state.tasks.find((t) => t.id === id);

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
          <button class="who" id="account-btn" aria-haspopup="menu" aria-expanded="false"
            aria-controls="account-menu">
            <span class="avatar">${esc(initial)}</span>
            <span class="who-text">
              <span class="who-name">${esc(state.me.user.displayName || state.me.user.email)}</span>
              <span class="who-sub">${esc(state.me.workspace.name)} workspace</span>
            </span>
            <span class="who-chev" aria-hidden="true">⌃</span>
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

  const accountBtn = document.getElementById('account-btn');
  accountBtn?.addEventListener('click', (e) => { e.stopPropagation(); openAccountMenu(); });
  accountBtn?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); openAccountMenu();
    }
  });

  const palette = () => toast('The command palette arrives with search in a later phase.');
  document.getElementById('cmdk')?.addEventListener('click', palette);
  document.getElementById('cmdk-m')?.addEventListener('click', palette);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); }
  });

  window.addEventListener('hashchange', () => {
    const r = routeFromHash();
    if (r !== state.route) go(r);
  });
  // The rail reflows between a column and a grid; the pill must follow the nav.
  window.addEventListener('resize', () => positionPill(true));
}

/* ── Account menu ────────────────────────────────────────────────────────
 * Settings is account-level, not a content section, so it is reached from the
 * person — not from a seventh item in the primary list.
 *
 * Sign out sits at the bottom behind a divider and is never the first thing
 * focus lands on: it is the one irreversible action in the menu.
 */
function openAccountMenu() {
  if (document.getElementById('account-menu')) return closeAccountMenu();
  const btn = document.getElementById('account-btn');
  const r = btn.getBoundingClientRect();

  const m = document.createElement('div');
  m.className = 'menu account-menu';
  m.id = 'account-menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = `
    <div class="am-head">
      <div class="am-name">${esc(state.me.user.displayName || 'Life OS')}</div>
      <div class="am-mail">${esc(state.me.user.email)}</div>
      <div class="am-ws">${esc(state.me.workspace.name)} workspace</div>
    </div>
    <button role="menuitem" data-am="settings">${icon('settings', 17)}<span>Settings</span></button>
    <button role="menuitem" data-am="history">${icon('check', 17)}<span>Completed</span></button>
    <div class="am-sep"></div>
    <div class="am-meta" id="am-update">Version ${esc(window.LIFE_OS_BUILD || 'unknown')}</div>
    <button role="menuitem" data-am="signout" class="am-danger">Sign out</button>`;
  document.body.appendChild(m);

  m.style.left = `${Math.max(8, r.left)}px`;
  m.style.bottom = `${Math.max(8, innerHeight - r.top + 8)}px`;
  btn.setAttribute('aria-expanded', 'true');

  const items = [...m.querySelectorAll('[role="menuitem"]')];
  items[0]?.focus();

  m.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeAccountMenu(); btn.focus(); }
    else if (e.key === 'Tab') closeAccountMenu();
  });

  m.querySelectorAll('[data-am]').forEach((el) => {
    el.onclick = () => {
      const what = el.dataset.am;
      closeAccountMenu();
      if (what === 'signout') {
        // Confirmed, because it is the only destructive item here.
        if (confirm('Sign out of Life OS on this device?')) window.__signOut?.();
        return;
      }
      go(what);
    };
  });

  setTimeout(() => document.addEventListener('click', onOutsideAccount), 0);
  window.__refreshUpdateLine?.();
}

function onOutsideAccount(e) {
  const m = document.getElementById('account-menu');
  if (!m) return;
  if (m.contains(e.target) || document.getElementById('account-btn')?.contains(e.target)) return;
  closeAccountMenu();
}

function closeAccountMenu() {
  document.getElementById('account-menu')?.remove();
  document.getElementById('account-btn')?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onOutsideAccount);
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
const routeFromHash = () => {
  const id = (location.hash || '#today').slice(1).split('?')[0];
  return ALL_ROUTE_IDS.includes(id) ? id : 'today';
};

async function go(id) {
  if (state.route === id) { window.__closeDrawer?.(); return; }
  state.route = id;
  if (location.hash.slice(1) !== id) location.hash = id;
  document.querySelectorAll('[data-route]').forEach((a) => {
    if (a.dataset.route === id && a.closest('.nav')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  positionPill();
  closeAccountMenu();
  window.__closeDrawer?.();
  await loadRoute();
}

/* ── Routes — only the main column changes ───────────────────────────── */
async function loadRoute() {
  const head = document.getElementById('page-head');
  const scroll = document.getElementById('main-scroll');
  if (!head || !scroll) return;

  const route = ROUTES.find((r) => r.id === state.route);
  // Restart the crossfade without redrawing the shell around it.
  scroll.style.animation = 'none';
  void scroll.offsetHeight;
  scroll.style.animation = '';

  if (state.route === 'today') {
    head.innerHTML = greetingHtml();
    scroll.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    try {
      await loadTasks();
      scroll.innerHTML = todayHtml();
      wireToday();
      renderRail();
    } catch (e) {
      scroll.innerHTML = errorHtml(e.message);
      scroll.querySelector('#retry')?.addEventListener('click', () => loadRoute());
    }
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
    <div class="buckets">${BUCKETS.map(bucketHtml).join('')}</div>`;
}

function bucketHtml(b) {
  const list = inBucket(b.id);
  return `<section class="bucket ${b.id === 'future' ? 'future' : ''}" aria-label="${b.label}">
    <div class="bucket-head"><h2>${b.label}</h2>
      <span class="bucket-count" data-count="${b.id}">${list.length}</span></div>
    <div class="drop${list.length ? '' : ' is-empty'}" data-bucket="${b.id}">
      ${list.length ? list.map((t) => taskHtml(t)).join('') : emptyHtml(b)}
    </div></section>`;
}

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
  if (steps.length) {
    bits.push(`<span class="tm-steps ${done === steps.length ? 'is-all' : ''}">${done}/${steps.length} steps</span>`);
  }

  return `<article class="task pri-${t.priority}" data-id="${t.id}" draggable="true" tabindex="0"
      aria-label="${esc(t.title)}">
    <button class="t-tick" data-act="toggle" aria-label="Mark done"></button>
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
  </article>`;
}

const fmtDate = (iso) => new Date(`${iso}T12:00:00`)
  .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtTime = (iso) => new Date(iso)
  .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function wireToday() {
  document.getElementById('add').onclick = () => openTask(null);
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
  const list = inBucket(bucketId);
  drop.classList.toggle('is-empty', list.length === 0);
  drop.innerHTML = list.length
    ? list.map((t) => taskHtml(t)).join('')
    : emptyHtml(BUCKETS.find((b) => b.id === bucketId));
  const badge = document.querySelector(`[data-count="${bucketId}"]`);
  if (badge && badge.textContent !== String(list.length)) {
    badge.textContent = String(list.length);
    pulse(badge);
  }
}

function wireBoard() {
  document.querySelectorAll('.task').forEach(wireCard);
  document.querySelectorAll('.drop').forEach((zone) => {
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => {
      e.preventDefault(); zone.classList.remove('over');
      const id = e.dataTransfer.getData('text/plain');
      if (!id) return;
      const after = [...zone.querySelectorAll('.task:not(.dragging)')]
        .find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
      moveTask(id, zone.dataset.bucket, after ? { beforeTaskId: after.dataset.id } : {});
    };
  });
}

function wireCard(el) {
  const id = el.dataset.id;
  el.querySelectorAll('[data-act]').forEach((b) => {
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
  el.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); openTask(id); }
    else if (e.key === ' ') { e.preventDefault(); toggleTask(id); }
    else if (e.key.toLowerCase() === 'm') { e.preventDefault(); openTaskMenu(id, el); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); nudge(id, -1); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); nudge(id, 1); }
    else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); shiftBucket(id, -1); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); shiftBucket(id, 1); }
  };
  el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', id); el.classList.add('dragging'); };
  el.ondragend = () => el.classList.remove('dragging');
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

async function toggleTask(id) {
  const t = findTask(id);
  if (!t) return;
  const wasDone = t.status === 'done';
  const card = document.querySelector(`.task[data-id="${id}"]`);
  const bucket = t.bucket;

  // Completing removes it from the board — collapse the row so the cards
  // below close the gap rather than jumping.
  const apply = () => {
    state.tasks = state.tasks.filter((x) => x.id !== id);
    rebuildBucket(bucket);
    wireBoard();
    renderRail();
  };
  if (card && !wasDone) collapseOut(card, apply); else apply();

  try {
    await api(`/api/v1/workspaces/${ws()}/tasks/${id}/${wasDone ? 'uncomplete' : 'complete'}`,
      { method: 'POST' });
    state.historyTotal += wasDone ? -1 : 1;
    saved(wasDone ? 'Moved back to active' : 'Done');
  } catch (e) {
    // Put it back exactly where it was.
    state.tasks.push(t);
    flip(document.querySelectorAll('.task'), () => { rebuildBucket(bucket); });
    wireBoard(); renderRail();
    toast(e.message, true);
  }
}

async function moveTask(id, bucket, anchor = {}) {
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

  flip(document.querySelectorAll('.task'), () => {
    t.bucket = bucket; t.position = pos;
    rebuildBucket(from);
    if (bucket !== from) rebuildBucket(bucket);
  });
  wireBoard(); renderRail();
  document.querySelector(`.task[data-id="${id}"]`)?.focus();

  try {
    const r = await api(`/api/v1/workspaces/${ws()}/tasks/${id}/move`,
      { method: 'POST', body: { bucket, ...anchor } });
    // Adopt the server's real position without moving anything visually.
    t.position = r.task.position;
    saved('Moved');
  } catch (e) {
    flip(document.querySelectorAll('.task'), () => {
      Object.assign(t, before);
      rebuildBucket(from);
      if (bucket !== from) rebuildBucket(bucket);
    });
    wireBoard(); renderRail();
    toast(e.message, true);
  }
}

function nudge(id, dir) {
  const t = findTask(id);
  const list = inBucket(t.bucket);
  const target = list[list.findIndex((x) => x.id === id) + dir];
  if (!target) return;
  moveTask(id, t.bucket, dir < 0 ? { beforeTaskId: target.id } : { afterTaskId: target.id });
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
    <button role="menuitem" data-o="top"><span>Move to top</span><kbd>Alt ↑</kbd></button>
    <button role="menuitem" data-o="bottom"><span>Move to bottom</span><kbd>Alt ↓</kbd></button>
    <div class="am-sep"></div>
    <button role="menuitem" data-x="open"><span>Open task</span><kbd>↵</kbd></button>`;
  document.body.appendChild(m);
  m.style.left = `${Math.max(8, Math.min(r.left - 140, innerWidth - m.offsetWidth - 12))}px`;
  m.style.top = `${Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 12)}px`;

  m.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      closeMenu();
      if (b.dataset.x === 'open') return openTask(id);
      if (b.dataset.b) return moveTask(id, b.dataset.b);
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
        state.tasks.push({ ...r.task, steps: [] });
        flip(document.querySelectorAll('.task'), () => rebuildBucket(body.bucket));
        wireBoard(); renderRail();
        saved('Task created');
      }
    },
    onToggle: () => toggleTask(t.id),
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
    steps: {
      add: async (title) => {
        const r = await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/steps`,
          { method: 'POST', body: { title } });
        t.steps = [...(t.steps ?? []), r.step ?? { id: r.id, title, completed: false }];
        ctl.close(true); patchCard(t.id); openTask(t.id);
      },
      toggle: async (sid, completed) => {
        const s = t.steps.find((x) => x.id === sid);
        if (s) s.completed = completed;
        ctl.close(true); patchCard(t.id); openTask(t.id);
        await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/steps/${sid}`,
          { method: 'PATCH', body: { completed } });
        saved();
      },
      rename: async (sid, title) => {
        const s = t.steps.find((x) => x.id === sid);
        if (s) s.title = title;
        await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/steps/${sid}`,
          { method: 'PATCH', body: { title } });
        saved();
      },
      remove: async (sid) => {
        t.steps = t.steps.filter((x) => x.id !== sid);
        ctl.close(true); patchCard(t.id); openTask(t.id);
        await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/steps/${sid}`, { method: 'DELETE' });
        saved();
      },
    },
  });
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

/** Deterministic and explainable — each branch returns the reason it chose. */
export function pickUpNext(tasks) {
  const active = tasks.filter((t) => t.status !== 'done');
  if (!active.length) return null;
  const rank = { urgent: 0, high: 1, medium: 2, low: 3, someday: 4 };
  const byOrder = (a, b) => a.position - b.position;
  const inB = (b) => active.filter((t) => t.bucket === b).sort(byOrder);

  const scheduled = active.filter((t) => t.scheduledAt)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  if (scheduled.length) return { task: scheduled[0], why: 'Next scheduled' };

  const today = inB('today');
  const urgent = today.filter((t) => t.priority === 'urgent');
  if (urgent.length) return { task: urgent[0], why: 'Urgent today' };
  const high = today.filter((t) => t.priority === 'high');
  if (high.length) return { task: high[0], why: 'High priority today' };
  if (today.length) return { task: today[0], why: 'First in Today' };

  const week = inB('week');
  if (week.length) return { task: week[0], why: 'First this week' };

  const rest = [...active].sort((a, b) => (rank[a.priority] - rank[b.priority]) || byOrder(a, b));
  return rest.length ? { task: rest[0], why: 'Next open task' } : null;
}

function renderRail() {
  const rail = document.getElementById('rail');
  if (!rail || !state.me) return;
  const now = new Date();
  const next = pickUpNext(state.tasks);
  const hs = state.habits ?? [];
  const due = hs.filter((h) => h.dueToday && !h.archivedAt);
  const doneCount = due.filter((h) => h.completedToday).length;

  rail.innerHTML = `
    <div class="rail-when">
      <span class="rw-day">${now.toLocaleDateString(undefined, { weekday: 'long' })}</span>
      <span class="rw-date">${now.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}</span>
    </div>

    <div class="rail-card up-next">
      <h3>Up next</h3>
      ${next ? `
        <div class="un-why">${esc(next.why)}</div>
        <button class="un-title" data-un-open="${next.task.id}">${esc(next.task.title)}</button>
        <div class="un-meta">
          ${next.task.areaId ? `<span class="tm-area">${esc(areaName(next.task.areaId))}</span>` : ''}
          ${next.task.priority !== 'medium'
            ? `<span class="un-pri pri-${next.task.priority}">${esc(next.task.priority)}</span>` : ''}
          ${next.task.legacyScheduledTimeRaw
            ? `<span class="tm-legacy" title="Time from the old app, kept as written">${esc(next.task.legacyScheduledTimeRaw)}</span>`
            : ''}
        </div>
        <div class="un-actions">
          <button class="btn btn-primary" data-un-done="${next.task.id}">Mark done</button>
          <button class="btn" data-un-defer="${next.task.id}">Later</button>
        </div>`
      : '<p class="rail-quiet">Nothing open. Enjoy it.</p>'}
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
 * The habit row: an animated ring, the name, and the streak.
 *
 * The ring is an SVG circle whose stroke-dashoffset carries the progress, so a
 * multi-count habit shows partial fill rather than an all-or-nothing tick. The
 * circumference is computed once (2πr for r=13) and lives in a CSS variable.
 */
const RING_C = 81.68;   // 2 * PI * 13

function habitRowHtml(h) {
  const pct = h.targetCount > 1 ? Math.min(1, (h.todayCount ?? 0) / h.targetCount)
    : (h.completedToday ? 1 : 0);
  const offset = RING_C * (1 - pct);
  return `<div class="hb-row ${h.completedToday ? 'is-done' : ''}" data-habit="${h.id}">
    <button class="hb-ring" data-habit-toggle="${h.id}" aria-pressed="${h.completedToday}"
      aria-label="${h.completedToday ? 'Undo' : 'Complete'} ${esc(h.name)}">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle class="hr-track" cx="16" cy="16" r="13"/>
        <circle class="hr-fill" cx="16" cy="16" r="13"
          style="stroke-dasharray:${RING_C};stroke-dashoffset:${offset.toFixed(2)}"/>
      </svg>
      <span class="hr-mark">${icon('check', 13)}</span>
    </button>
    <button class="hb-name" data-habit-open="${h.id}" title="Edit ${esc(h.name)}">${esc(h.name)}</button>
    ${h.targetCount > 1 ? `<span class="hb-prog">${h.todayCount ?? 0}/${h.targetCount}</span>` : ''}
    <span class="hb-streak ${h.streak > 0 ? 'is-live' : ''}"
      title="${h.streak > 0 ? `${h.streak} day streak` : 'No streak yet — today can start one'}">
      ${h.streak > 0 ? `${h.streak}<span class="hs-unit">d</span>` : '—'}</span>
  </div>`;
}

function wireRail() {
  const rail = document.getElementById('rail');
  rail.querySelector('[data-un-open]')?.addEventListener('click',
    (e) => openTask(e.currentTarget.dataset.unOpen));
  rail.querySelector('[data-un-done]')?.addEventListener('click',
    (e) => toggleTask(e.currentTarget.dataset.unDone));
  rail.querySelector('[data-un-defer]')?.addEventListener('click',
    (e) => shiftBucket(e.currentTarget.dataset.unDefer, 1));

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

/** Patches ONE habit row rather than re-rendering the rail. */
function patchHabitRow(id) {
  const row = document.querySelector(`.hb-row[data-habit="${id}"]`);
  const h = (state.habits ?? []).find((x) => x.id === id);
  if (!row || !h) return renderRail();
  const keepFocus = row.contains(document.activeElement);
  row.outerHTML = habitRowHtml(h);
  const next = document.querySelector(`.hb-row[data-habit="${id}"]`);
  next?.querySelector('[data-habit-toggle]')?.addEventListener('click', () => toggleHabit(id));
  next?.querySelector('[data-habit-open]')?.addEventListener('click', () => editHabit(id));
  if (keepFocus) next?.querySelector('[data-habit-toggle]')?.focus();
  // Keep the header tally honest without redrawing the card.
  const due = (state.habits ?? []).filter((x) => x.dueToday && !x.archivedAt);
  const badge = document.querySelector('.hb-count');
  if (badge) {
    const text = `${due.filter((x) => x.completedToday).length}/${due.length}`;
    if (badge.textContent !== text) { badge.textContent = text; pulse(badge); }
  }
}

/** Optimistic tick with rollback. A checkbox must never wait on a round trip. */
async function toggleHabit(id) {
  const h = (state.habits ?? []).find((x) => x.id === id);
  if (!h) return;
  const before = { todayCount: h.todayCount, completedToday: h.completedToday, streak: h.streak };
  const goingDone = !h.completedToday;
  h.completedToday = goingDone;
  h.todayCount = goingDone ? h.targetCount : 0;
  h.streak = goingDone ? (h.streak ?? 0) + 1 : Math.max(0, (h.streak ?? 1) - 1);
  patchHabitRow(id);
  if (goingDone) celebrateHabit(id);

  try {
    const r = await api(`/api/v1/workspaces/${ws()}/habits/${id}/${goingDone ? 'check' : 'uncheck'}`,
      { method: 'POST', body: goingDone ? { count: h.targetCount } : {} });
    h.todayCount = r.completedCount;
    h.completedToday = r.completed;
    patchHabitRow(id);
  } catch (e) {
    Object.assign(h, before);
    patchHabitRow(id);
    toast(e.message, true);
  }
}

/** A single restrained pulse on completion. No confetti, no bounce. */
function celebrateHabit(id) {
  if (reducedMotion()) return;
  const ring = document.querySelector(`.hb-row[data-habit="${id}"] .hb-ring`);
  ring?.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
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
