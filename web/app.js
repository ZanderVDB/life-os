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
  habits: [], habitsLoaded: false,
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
  // Just the count, for the Completed button beside the Today heading.
  api(`/api/v1/workspaces/${ws()}/tasks?status=done&limit=1`)
    .then((r) => { state.historyTotal = r.total; if (state.route === 'today') wireHeaderCount(); })
    .catch(() => {});
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
      wireHeader();
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
    wireHeader();
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

function todayHeaderActions() {
  // History lives beside Today, not in the sidebar: finished work is content
  // history, not a section of your life.
  return `<div class="page-actions">
    <button class="btn btn-ghost" data-route="history">
      ${icon('check', 16)}<span>Completed</span>
      ${state.historyTotal ? `<span class="pa-count">${state.historyTotal}</span>` : ''}
    </button>
  </div>`;
}

function greetingHtml() {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = (state.me.user.displayName || '').split(/\s+/)[0];
  const dateStr = new Date().toLocaleDateString(undefined,
    { weekday: 'long', day: 'numeric', month: 'long' });
  return `<p class="eyebrow">${esc(dateStr)}</p>
    <h1>${greet}${first ? `, <span class="nm">${esc(first)}</span>` : ''}.</h1>
    <p class="sub">Here is what is in front of you.</p>
    ${todayHeaderActions()}`;
}

/* ── Today ───────────────────────────────────────────────────────────── */
function todayHtml() {
  return `<div class="toolbar">
      <button class="btn btn-primary" id="add">Add task</button>
      <button class="chip" data-area="" aria-pressed="${!state.areaFilter}">All areas</button>
      ${state.me.areas.map((a) => `<button class="chip" data-area="${a.id}"
        aria-pressed="${state.areaFilter === a.id}">${esc(a.name)}</button>`).join('')}
    </div>
    <div class="buckets">${BUCKETS.map(bucketHtml).join('')}</div>`;
}

function bucketHtml(b) {
  const list = inBucket(b.id);
  return `<section class="bucket ${b.id === 'future' ? 'future' : ''}" aria-label="${b.label}">
    <div class="bucket-head"><h2>${b.label}</h2><span class="bucket-count">${list.length}</span></div>
    <div class="drop stagger${list.length ? '' : ' is-empty'}" data-bucket="${b.id}">
      ${list.length ? list.map(taskHtml).join('')
        : `<div class="empty">${b.id === 'today' ? 'Nothing planned for today' : 'Empty'}</div>`}
    </div></section>`;
}

function taskHtml(t, i) {
  const steps = t.steps || [];
  const doneSteps = steps.filter((s) => s.completed).length;
  return `<article class="task p-${t.priority}" data-id="${t.id}" draggable="true" tabindex="0"
      style="--i:${i}" aria-label="${esc(t.title)}">
    <button class="tick" data-act="toggle" aria-label="Mark done">${icon('check', 13)}</button>
    <div class="t-body">
      <button class="t-title" data-act="open" title="${esc(t.title)}">${esc(t.title)}</button>
      <div class="t-meta">
        ${t.dueDate ? `<span>${esc(fmtDate(t.dueDate))}</span>` : ''}
        ${steps.length ? `<span>${doneSteps}/${steps.length} steps</span>` : ''}
        ${t.areaId ? `<span class="t-area">${esc(areaName(t.areaId))}</span>` : ''}
      </div>
    </div>
    <div class="t-actions">
      <button class="icon-btn" data-act="menu" aria-label="Move task" title="Move (M)">⇄</button>
      <button class="icon-btn" data-act="open" aria-label="Open task" title="Open (Enter)">✎</button>
    </div>
    <span class="grip" aria-hidden="true">⠿</span>
  </article>`;
}
const fmtDate = (iso) => new Date(`${iso}T12:00:00`)
  .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function wireHeaderCount() {
  const btn = document.querySelector('.page-actions [data-route="history"]');
  if (!btn || !state.historyTotal) return;
  if (!btn.querySelector('.pa-count')) {
    const b = document.createElement('span');
    b.className = 'pa-count';
    b.textContent = String(state.historyTotal);
    btn.appendChild(b);
  }
}

function wireHeader() {
  document.querySelectorAll('.page-actions [data-route]').forEach((el) => {
    el.onclick = () => go(el.dataset.route);
  });
}

function wireToday() {
  document.getElementById('add').onclick = () => openDetail(null);
  document.querySelectorAll('[data-area]').forEach((el) => {
    el.onclick = () => { setAreaFilter(el.dataset.area || null); };
  });
  wireTaskCards();
}

function setAreaFilter(id) {
  state.areaFilter = id;
  if (state.route !== 'today') { go('today'); return; }
  document.getElementById('main-scroll').innerHTML = todayHtml();
  wireToday();
  renderRail();
}

function wireTaskCards() {
  document.querySelectorAll('.task').forEach((el) => {
    const id = el.dataset.id;
    el.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'toggle') return run(() => toggleTask(id));
        if (act === 'open') return openDetail(id);
        if (act === 'menu') return openMoveMenu(id, b);
      };
    });
    el.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); openDetail(id); }
      else if (e.key === ' ') { e.preventDefault(); run(() => toggleTask(id)); }
      else if (e.key.toLowerCase() === 'm') { e.preventDefault(); openMoveMenu(id, el); }
      else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); run(() => nudge(id, -1)); }
      else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); run(() => nudge(id, 1)); }
      else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); run(() => shiftBucket(id, -1)); }
      else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); run(() => shiftBucket(id, 1)); }
    };
    el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', id); el.classList.add('dragging'); };
    el.ondragend = () => el.classList.remove('dragging');
  });

  document.querySelectorAll('.drop').forEach((zone) => {
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => {
      e.preventDefault(); zone.classList.remove('over');
      const id = e.dataTransfer.getData('text/plain'); if (!id) return;
      const after = [...zone.querySelectorAll('.task:not(.dragging)')]
        .find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
      run(() => moveTask(id, zone.dataset.bucket, after ? { beforeTaskId: after.dataset.id } : {}));
    };
  });
}

/** Every movement path converges here: drag, menu, keyboard, touch. */
async function moveTask(id, bucket, anchor = {}) {
  await api(`/api/v1/workspaces/${ws()}/tasks/${id}/move`,
    { method: 'POST', body: { bucket, ...anchor } });
  await refreshToday();
  document.querySelector(`.task[data-id="${id}"]`)?.focus();
}
async function toggleTask(id) {
  const t = findTask(id);
  const wasDone = t.status === 'done';
  await api(`/api/v1/workspaces/${ws()}/tasks/${id}/${wasDone ? 'uncomplete' : 'complete'}`,
    { method: 'POST' });
  await refreshToday();
  toast(wasDone ? 'Moved back to active' : 'Done — moved to History');
}
async function nudge(id, dir) {
  const t = findTask(id);
  const list = inBucket(t.bucket);
  const target = list[list.findIndex((x) => x.id === id) + dir];
  if (!target) return;
  await moveTask(id, t.bucket, dir < 0 ? { beforeTaskId: target.id } : { afterTaskId: target.id });
}
async function shiftBucket(id, dir) {
  const t = findTask(id);
  const next = BUCKETS[BUCKETS.findIndex((b) => b.id === t.bucket) + dir];
  if (!next) return;
  await moveTask(id, next.id);
  toast(`Moved to ${next.label}`);
}
async function refreshToday() {
  await loadTasks();
  if (state.route === 'today') {
    document.getElementById('main-scroll').innerHTML = todayHtml();
    wireToday();
  }
  renderRail();
}

/* ── Move menu: the path that never needs drag ───────────────────────── */
function openMoveMenu(id, anchorEl) {
  closeMenu();
  const t = findTask(id);
  const r = anchorEl.getBoundingClientRect();
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = `<div class="menu-label">Move to</div>
    ${BUCKETS.map((b) => `<button role="menuitem" data-b="${b.id}" ${b.id === t.bucket ? 'disabled' : ''}>
      <span>${b.label}</span>${b.id === t.bucket ? '<kbd>current</kbd>' : ''}</button>`).join('')}
    <div class="menu-label">Order</div>
    <button role="menuitem" data-o="top"><span>Move to top</span><kbd>Alt ↑</kbd></button>
    <button role="menuitem" data-o="bottom"><span>Move to bottom</span><kbd>Alt ↓</kbd></button>`;
  document.body.appendChild(m);
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 12))}px`;
  m.style.top = `${Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 12)}px`;

  m.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      closeMenu();
      if (b.dataset.b) return run(() => moveTask(id, b.dataset.b));
      const list = inBucket(t.bucket).filter((x) => x.id !== id);
      if (!list.length) return;
      run(() => moveTask(id, t.bucket, b.dataset.o === 'top'
        ? { beforeTaskId: list[0].id } : { afterTaskId: list[list.length - 1].id }));
    };
  });
  m.querySelector('button:not([disabled])')?.focus();
  state.menu = m;
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() { state.menu?.remove(); state.menu = null; }

/* ── History ─────────────────────────────────────────────────────────── */
function historyHtml() {
  const shown = state.history.length;
  const more = shown < state.historyTotal;
  const rows = state.history.map((t, i) => {
    const when = t.completedAt
      ? new Date(t.completedAt).toLocaleDateString(undefined,
        { day: 'numeric', month: 'short', year: 'numeric' })
      : 'date unknown';
    const steps = t.steps || [];
    return `<div class="hist-row" data-id="${t.id}" tabindex="0" role="button"
        style="--i:${i}" aria-label="${esc(t.title)}">
      <span class="hist-tick" aria-hidden="true">${icon('check', 13)}</span>
      <span class="hist-title">${esc(t.title)}</span>
      <span class="hist-meta">
        ${steps.length ? `<span>${steps.filter((s) => s.completed).length}/${steps.length} steps</span>` : ''}
        ${t.areaId ? `<span class="t-area">${esc(areaName(t.areaId))}</span>` : ''}
        <span class="hist-when${t.completedAt ? '' : ' unknown'}">${esc(when)}</span>
      </span></div>`;
  }).join('');

  return `<section class="history">
    <div class="bucket-head"><h2>Completed</h2><span class="bucket-count">${state.historyTotal}</span></div>
    ${shown ? `<div class="hist-list stagger">${rows}</div>`
      : '<div class="empty"><b>Nothing completed yet</b>Finished work collects here.</div>'}
    ${more ? `<button class="btn" id="hist-more" style="margin-top:14px">
        Show ${Math.min(HISTORY_PAGE, state.historyTotal - shown)} more
        <span style="color:var(--muted)"> · ${shown} of ${state.historyTotal}</span></button>`
      : shown ? `<p class="hist-end">That is all ${state.historyTotal}.</p>` : ''}
  </section>`;
}

function wireHistory() {
  document.getElementById('hist-more')?.addEventListener('click', () => run(async () => {
    await loadHistory();
    document.getElementById('main-scroll').innerHTML = historyHtml();
    wireHistory();
  }));
  document.querySelectorAll('.hist-row').forEach((el) => {
    const open = () => openDetail(el.dataset.id, true);
    el.onclick = open;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
}

/* ── Right rail ──────────────────────────────────────────────────────────
 * One question: what needs my attention next, and what can I act on quickly?
 *
 * Not a dashboard. Counts already visible in Today are not repeated here — a
 * number earns a card only if it changes a decision.
 */

/**
 * Deterministic and explainable. Every branch returns WHY it was chosen, so the
 * card can say so rather than looking arbitrary.
 */
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
  const due = hs.filter((h) => h.dueToday);
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
          ${next.task.areaId ? `<span class="t-area">${esc(areaName(next.task.areaId))}</span>` : ''}
          ${next.task.priority !== 'medium'
            ? `<span class="un-pri pri-${next.task.priority}">${esc(next.task.priority)}</span>` : ''}
          ${next.task.legacyScheduledTimeRaw
            ? `<span class="un-legacy" title="Kept exactly as written in the old app">${esc(next.task.legacyScheduledTimeRaw)}</span>`
            : ''}
        </div>
        <div class="un-actions">
          <button class="btn btn-primary" data-un-done="${next.task.id}">Mark done</button>
          <button class="btn" data-un-defer="${next.task.id}">Later</button>
        </div>`
      : '<p class="rail-quiet">Nothing open. Enjoy it.</p>'}
    </div>

    <div class="rail-card habits-card">
      <h3>Habits today${due.length ? ` <span class="hb-count">${doneCount}/${due.length}</span>` : ''}</h3>
      ${!state.habitsLoaded ? '<p class="rail-quiet">Loading…</p>'
        : due.length ? `<div class="hb-list">${due.map(habitRowHtml).join('')}</div>`
        : `<p class="rail-quiet">No habits yet.
             <button class="rail-link" data-rail-nav="settings">Add one in Settings →</button></p>`}
    </div>

    <div class="rail-card qc-card">
      <h3>Quick capture</h3>
      <form class="qc-form" id="qc-form" autocomplete="off">
        <input class="qc-input" id="qc-title" placeholder="What needs doing?" aria-label="Task title">
        <div class="qc-row">
          <select class="qc-sel" id="qc-bucket" aria-label="When">
            ${BUCKETS.map((b) => `<option value="${b.id}">${b.label}</option>`).join('')}
          </select>
          <select class="qc-sel" id="qc-area" aria-label="Area">
            <option value="">No area</option>
            ${state.me.areas.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}
          </select>
        </div>
        <div class="qc-actions">
          <button class="btn btn-primary" type="submit">Add task</button>
          <button class="btn btn-ghost" type="button" id="qc-full">More detail…</button>
        </div>
      </form>
    </div>`;

  wireRail();
}

const habitRowHtml = (h) => `<div class="hb-row ${h.completedToday ? 'is-done' : ''}" data-habit="${h.id}">
  <button class="hb-tick" data-habit-toggle="${h.id}" aria-pressed="${h.completedToday}"
    aria-label="${h.completedToday ? 'Undo' : 'Complete'} ${esc(h.name)}">${h.completedToday ? icon('check', 13) : ''}</button>
  <span class="hb-name">${esc(h.name)}</span>
  ${h.targetCount > 1 ? `<span class="hb-prog">${h.todayCount}/${h.targetCount}</span>` : ''}
  ${h.streak > 1 ? `<span class="hb-streak" title="${h.streak} day streak">${h.streak}d</span>` : ''}
</div>`;

function wireRail() {
  const rail = document.getElementById('rail');
  rail.querySelectorAll('[data-rail-nav]').forEach((el) => { el.onclick = () => go(el.dataset.railNav); });
  rail.querySelector('[data-un-open]')?.addEventListener('click',
    (e) => openDetail(e.currentTarget.dataset.unOpen));
  rail.querySelector('[data-un-done]')?.addEventListener('click',
    (e) => run(() => toggleTask(e.currentTarget.dataset.unDone)));
  rail.querySelector('[data-un-defer]')?.addEventListener('click',
    (e) => run(() => shiftBucket(e.currentTarget.dataset.unDefer, 1)));

  rail.querySelectorAll('[data-habit-toggle]').forEach((el) => {
    el.onclick = () => toggleHabit(el.dataset.habitToggle);
  });

  rail.querySelector('#qc-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => {
      const input = rail.querySelector('#qc-title');
      const title = input.value.trim();
      if (!title) return;
      await api(`/api/v1/workspaces/${ws()}/tasks`, {
        method: 'POST',
        body: {
          title,
          bucket: rail.querySelector('#qc-bucket').value,
          areaId: rail.querySelector('#qc-area').value || null,
        },
      });
      await refreshToday();
      document.getElementById('qc-title')?.focus();
      toast('Task added');
    });
  });
  rail.querySelector('#qc-full')?.addEventListener('click', () => {
    openDetail(null, false, rail.querySelector('#qc-title').value.trim());
  });
}

/* ── Habits ──────────────────────────────────────────────────────────── */
async function loadHabits() {
  try {
    const r = await api(`/api/v1/workspaces/${ws()}/habits`);
    state.habits = r.habits;
  } catch {
    state.habits = [];   // A habits failure must never take Today down with it.
  }
  state.habitsLoaded = true;
}

/**
 * Optimistic: the tick flips immediately and rolls back if the server
 * disagrees. Waiting on a round-trip for a checkbox feels broken.
 */
async function toggleHabit(id) {
  const h = (state.habits ?? []).find((x) => x.id === id);
  if (!h) return;
  const before = { todayCount: h.todayCount, completedToday: h.completedToday, streak: h.streak };
  const goingDone = !h.completedToday;
  h.completedToday = goingDone;
  h.todayCount = goingDone ? h.targetCount : 0;
  h.streak = goingDone ? (h.streak ?? 0) + 1 : Math.max(0, (h.streak ?? 1) - 1);
  renderRail();

  try {
    const r = await api(`/api/v1/workspaces/${ws()}/habits/${id}/${goingDone ? 'check' : 'uncheck'}`,
      { method: 'POST', body: goingDone ? { count: h.targetCount } : {} });
    h.todayCount = r.completedCount;
    h.completedToday = r.completed;
    renderRail();
  } catch (e) {
    Object.assign(h, before);
    renderRail();
    toast(e.message, true);
  }
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

/* ── Task detail ─────────────────────────────────────────────────────── */
function openDetail(id, fromHistory = false, prefillTitle = '') {
  const t = id ? (fromHistory ? state.history.find((x) => x.id === id) : findTask(id)) : null;
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  const p = document.createElement('aside');
  p.className = 'panel'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-modal', 'true');
  p.innerHTML = `
    <h3>${t ? 'Task' : 'New task'}</h3>
    <div class="field"><label for="d-title">Title</label>
      <input id="d-title" class="input" value="${esc(t?.title || prefillTitle)}" placeholder="What needs doing?"></div>
    <div class="row">
      <div class="field"><label for="d-bucket">When</label>
        <select id="d-bucket" class="sel">${BUCKETS.map((b) =>
          `<option value="${b.id}" ${t?.bucket === b.id ? 'selected' : ''}>${b.label}</option>`).join('')}</select></div>
      <div class="field"><label for="d-priority">Priority</label>
        <select id="d-priority" class="sel">${PRIORITIES.map((x) =>
          `<option value="${x}" ${(t?.priority || 'medium') === x ? 'selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></div>
    </div>
    <div class="row">
      <div class="field"><label for="d-area">Area</label>
        <select id="d-area" class="sel"><option value="">No area</option>
          ${state.me.areas.map((a) => `<option value="${a.id}" ${t?.areaId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="d-due">Due date</label>
        <input id="d-due" class="input" type="date" value="${t?.dueDate || ''}"></div>
    </div>
    <div class="field"><label for="d-notes">Notes</label>
      <textarea id="d-notes" class="ta" placeholder="Anything worth remembering">${esc(t?.notes || '')}</textarea></div>
    ${t?.legacyScheduledTimeRaw ? `<div class="field"><label>Legacy time</label>
      <div class="input" style="color:var(--text-2)">${esc(t.legacyScheduledTimeRaw)}
        <span style="color:var(--muted);font-size:11px"> · kept exactly as written</span></div></div>` : ''}
    ${t ? `<div class="field"><label>Steps</label>
      <div class="steps" id="d-steps">${(t.steps || []).map(stepHtml).join('')
        || '<div class="empty" style="padding:8px">No steps yet.</div>'}</div>
      <div class="row"><input id="d-step" class="input" placeholder="Add a step…"><button class="btn" id="d-step-add">Add</button></div>
    </div>` : ''}
    <div class="panel-foot">
      <button class="btn btn-primary" id="d-save">${t ? 'Save' : 'Create task'}</button>
      ${t ? `<button class="btn" id="d-archive">Archive</button>
        <button class="btn btn-danger" id="d-del" style="margin-left:auto">Delete</button>` : ''}
    </div>`;

  document.body.append(scrim, p);
  function onEsc(e) { if (e.key === 'Escape') close(); }
  const close = () => { scrim.remove(); p.remove(); document.removeEventListener('keydown', onEsc); };
  scrim.onclick = close;
  document.addEventListener('keydown', onEsc);
  p.querySelector('#d-title').focus();

  const after = async () => {
    close();
    if (state.route === 'history') {
      await loadHistory(true);
      document.getElementById('main-scroll').innerHTML = historyHtml();
      wireHistory();
      await loadTasks(); renderRail();
    } else {
      await refreshToday();
    }
  };

  p.querySelector('#d-save').onclick = () => run(async () => {
    const body = {
      title: p.querySelector('#d-title').value.trim(),
      bucket: p.querySelector('#d-bucket').value,
      priority: p.querySelector('#d-priority').value,
      areaId: p.querySelector('#d-area').value || null,
      dueDate: p.querySelector('#d-due').value || null,
      notes: p.querySelector('#d-notes').value || null,
    };
    if (!body.title) return toast('A title is needed.', true);
    if (t) await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}`, { method: 'PATCH', body });
    else await api(`/api/v1/workspaces/${ws()}/tasks`, { method: 'POST', body });
    await after();
    toast(t ? 'Saved' : 'Task created');
  });

  if (t) {
    p.querySelector('#d-archive').onclick = () => run(async () => {
      await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/archive`, { method: 'POST' });
      await after(); toast('Archived');
    });
    p.querySelector('#d-del').onclick = () => run(async () => {
      if (!confirm('Delete this task permanently?')) return;
      await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}`, { method: 'DELETE' });
      await after(); toast('Deleted');
    });
    const reopen = async () => { const wasHistory = fromHistory; await after(); openDetail(t.id, wasHistory); };
    const addStep = () => run(async () => {
      const input = p.querySelector('#d-step');
      const title = input.value.trim(); if (!title) return;
      await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/steps`, { method: 'POST', body: { title } });
      await reopen();
    });
    p.querySelector('#d-step-add').onclick = addStep;
    p.querySelector('#d-step').onkeydown = (e) => { if (e.key === 'Enter') addStep(); };
    p.querySelectorAll('.step').forEach((rowEl) => {
      const sid = rowEl.dataset.id;
      rowEl.querySelector('input').onchange = (e) => run(async () => {
        await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/steps/${sid}`,
          { method: 'PATCH', body: { completed: e.target.checked } });
        await reopen();
      });
      rowEl.querySelector('button').onclick = () => run(async () => {
        await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/steps/${sid}`, { method: 'DELETE' });
        await reopen();
      });
    });
  }
}
const stepHtml = (s) => `<div class="step ${s.completed ? 'done' : ''}" data-id="${s.id}">
  <input type="checkbox" ${s.completed ? 'checked' : ''} aria-label="Step done">
  <span>${esc(s.title)}</span><button aria-label="Delete step">×</button></div>`;

initAuth();
