/**
 * Life OS v2 — Today shell.
 *
 * Talks ONLY to the Railway API. There is no Firestore code here at all.
 *
 * Movement architecture: drag, the Move menu and the keyboard all call the same
 * `POST /tasks/:id/move` endpoint. Drag is an enhancement, never the only way —
 * which is why this works on a phone, unlike the legacy app.
 */
const CFG = window.LIFE_OS_CONFIG;
const BUCKETS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This Week' },
  { id: 'month', label: 'This Month' },
  { id: 'future', label: 'Future' },
];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'someday'];

const state = { me: null, tasks: [], areaFilter: null, token: null, openTaskId: null, menu: null };
const root = document.getElementById('root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── API ─────────────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const hasBody = opts.body !== undefined;
  const res = await fetch(`${CFG.apiBaseUrl}${path}`, {
    ...opts,
    headers: {
      // Only declare a JSON body when there actually is one. Sending this
      // header with an empty body makes Fastify reject the request with a 400
      // before it reaches the route — which silently broke /complete,
      // /uncomplete, /archive and every DELETE.
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(opts.headers || {}),
    },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Our own errors are { error: { message } }; Fastify's built-in 400s are
    // flat { message }. Read both so the toast is never a bare status code.
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
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3400);
}
const run = async (fn) => { try { await fn(); } catch (e) { toast(e.message, true); } };

/* ── Auth ────────────────────────────────────────────────────────────── */
/**
 * Local development bypass.
 *
 * Only ever engages against a localhost API. Even then the token is worthless
 * unless the server was started with DEV_AUTH_BYPASS, which loadEnv() refuses
 * to read when NODE_ENV is staging or production. The real gate is server-side;
 * this is just a convenience so /web can run before Firebase is configured.
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
    return run(loadAll);
  }
  if (!CFG.isConfigured) {
    root.innerHTML = `<div class="card"><h2>Configuration needed</h2>
      <p>Fill in <code>web/config.js</code> with the Firebase web config from the
      legacy app's <code>/config.js</code>, and point <code>apiBaseUrl</code> at
      your staging API.</p></div>`;
    return;
  }
  const [{ initializeApp }, auth] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js'),
  ]);
  const app = initializeApp(CFG.firebase);
  const a = auth.getAuth(app);

  auth.onAuthStateChanged(a, async (user) => {
    if (!user) return renderSignIn(() => auth.signInWithPopup(a, new auth.GoogleAuthProvider()));
    state.token = await user.getIdToken();
    // Keep the token fresh; the API rejects an expired one.
    setInterval(async () => { state.token = await user.getIdToken(true); setToken(state.token); }, 45 * 60 * 1000);
    setToken(state.token);
    window.__signOut = () => {
      localStorage.removeItem('los2_token'); localStorage.removeItem('los2_ws');
      return auth.signOut(a);
    };
    await run(loadAll);
  });
}

function renderSignIn(onClick) {
  root.className = 'center';
  root.innerHTML = `<div class="card">${logoSvg(40)}
    <h2>Life OS</h2><p>Your calm home for everything.</p>
    <button class="btn btn-primary" id="si" style="width:100%">Continue with Google</button></div>`;
  document.getElementById('si').onclick = onClick;
}

const logoSvg = (n = 22) => `<svg width="${n}" height="${n}" viewBox="0 0 24 24" aria-hidden="true">
  <defs><linearGradient id="lg${n}" gradientUnits="userSpaceOnUse" x1="4" y1="21" x2="20" y2="3">
    <stop offset="0" stop-color="#7C4DFF"/><stop offset="1" stop-color="#C28DFF"/></linearGradient></defs>
  <path d="M12 20.4C6.9 17.6 3.4 13.1 3.4 8.5 7.1 9.2 10.1 13 12 20.4Z" fill="url(#lg${n})" fill-opacity=".82"/>
  <path d="M12 20.4c5.1-2.8 8.6-7.3 8.6-11.9-3.7.7-6.7 4.5-8.6 11.9Z" fill="url(#lg${n})" fill-opacity=".82"/>
  <path d="M12 2.3C8.6 8 8.6 15 12 20.4 15.4 15 15.4 8 12 2.3Z" fill="url(#lg${n})"/></svg>`;

/* ── Data ────────────────────────────────────────────────────────────── */
/** The import-preview page runs standalone, so it reads these two values from here. */
const setToken = (t) => localStorage.setItem('los2_token', t);

async function loadAll() {
  state.me = await api('/api/v1/me');
  localStorage.setItem('los2_ws', state.me.workspace.id);
  await loadTasks();
  renderApp();
}
async function loadTasks() {
  const { tasks } = await api(`/api/v1/workspaces/${ws()}/tasks`);
  state.tasks = tasks;
}
const inBucket = (b) => state.tasks
  .filter((t) => t.bucket === b && (!state.areaFilter || t.areaId === state.areaFilter))
  .sort((x, y) => x.position - y.position);
const areaName = (id) => state.me.areas.find((a) => a.id === id)?.name || '';
const findTask = (id) => state.tasks.find((t) => t.id === id);

/* ── Render ──────────────────────────────────────────────────────────── */
function renderApp() {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = (state.me.user.displayName || '').split(/\s+/)[0];
  const dateStr = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  root.className = 'app';
  root.innerHTML = `
    <aside class="sidebar">
      <div class="logo">${logoSvg(22)}<div class="logo-word">Life OS</div></div>
      <nav class="nav">
        <a href="#today" class="active"><span aria-hidden="true">◎</span><span>Today</span></a>
        <a aria-disabled="true"><span aria-hidden="true">▤</span><span>Calendar</span><span class="nav-soon">soon</span></a>
        <a aria-disabled="true"><span aria-hidden="true">▦</span><span>Projects</span><span class="nav-soon">soon</span></a>
        <a aria-disabled="true"><span aria-hidden="true">▧</span><span>Library</span><span class="nav-soon">soon</span></a>
        <a aria-disabled="true"><span aria-hidden="true">◈</span><span>Brain</span><span class="nav-soon">soon</span></a>
      </nav>
      <div class="side-foot">
        <a href="./import.html" style="color:var(--text-2);font-size:12px;text-decoration:none">Import preview →</a>
        <div>${esc(state.me.user.email)}</div>
        <button onclick="window.__signOut&&window.__signOut()">Sign out</button>
      </div>
    </aside>
    <main class="main">
      <div class="page-head rise">
        <h1>${greet}${first ? `, <span class="nm">${esc(first)}</span>` : ''}.</h1>
        <p class="sub">${esc(dateStr)}</p>
      </div>
      <div class="toolbar">
        <button class="btn btn-primary" id="add">+ Add task</button>
        <button class="chip ${!state.areaFilter ? 'on' : ''}" data-area="">All areas</button>
        ${state.me.areas.map((a) => `<button class="chip ${state.areaFilter === a.id ? 'on' : ''}" data-area="${a.id}">${esc(a.name)}</button>`).join('')}
      </div>
      <div class="buckets">
        ${BUCKETS.map((b) => bucketHtml(b)).join('')}
      </div>
    </main>`;

  document.getElementById('add').onclick = () => openDetail(null);
  root.querySelectorAll('[data-area]').forEach((el) => {
    el.onclick = () => { state.areaFilter = el.dataset.area || null; renderApp(); };
  });
  wireTasks();
}

function bucketHtml(b) {
  const list = inBucket(b.id);
  return `<section class="bucket ${b.id === 'future' ? 'future' : ''}">
    <div class="bucket-head"><h2>${b.label}</h2><span class="bucket-count">${list.length}</span></div>
    <div class="drop stagger" data-bucket="${b.id}">
      ${list.length ? list.map((t, i) => taskHtml(t, i)).join('')
        : `<div class="empty"><b>Nothing here yet</b>${b.id === 'today' ? 'Add what matters most today.' : 'Move a task here when you are ready.'}</div>`}
    </div></section>`;
}

function taskHtml(t, i) {
  const steps = t.steps || [];
  const doneSteps = steps.filter((s) => s.completed).length;
  return `<article class="task p-${t.priority} ${t.status === 'done' ? 'done' : ''}"
      data-id="${t.id}" draggable="true" tabindex="0" style="--i:${i}"
      aria-label="${esc(t.title)}">
    <button class="tick" data-act="toggle" aria-label="${t.status === 'done' ? 'Mark not done' : 'Mark done'}">✓</button>
    <div class="t-body">
      <div class="t-title" data-act="open" title="${esc(t.title)}">${esc(t.title)}</div>
      <div class="t-meta">
        ${t.dueDate ? `<span>${esc(fmtDate(t.dueDate))}</span>` : ''}
        ${steps.length ? `<span class="t-steps">${doneSteps}/${steps.length} steps</span>` : ''}
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
const fmtDate = (iso) => {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/* ── Interactions ────────────────────────────────────────────────────── */
function wireTasks() {
  root.querySelectorAll('.task').forEach((el) => {
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
    // Keyboard: Enter opens, Space completes, M moves, arrows re-order.
    el.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); openDetail(id); }
      else if (e.key === ' ') { e.preventDefault(); run(() => toggleTask(id)); }
      else if (e.key.toLowerCase() === 'm') { e.preventDefault(); openMoveMenu(id, el); }
      else if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); run(() => nudge(id, -1)); }
      else if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); run(() => nudge(id, 1)); }
      else if (e.key === 'ArrowLeft' && e.altKey) { e.preventDefault(); run(() => shiftBucket(id, -1)); }
      else if (e.key === 'ArrowRight' && e.altKey) { e.preventDefault(); run(() => shiftBucket(id, 1)); }
    };
    el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', id); el.classList.add('dragging'); };
    el.ondragend = () => el.classList.remove('dragging');
  });

  root.querySelectorAll('.drop').forEach((zone) => {
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

/* All movement paths converge here. */
async function moveTask(id, bucket, anchor = {}) {
  await api(`/api/v1/workspaces/${ws()}/tasks/${id}/move`, { method: 'POST', body: { bucket, ...anchor } });
  await loadTasks(); renderApp();
  document.querySelector(`.task[data-id="${id}"]`)?.focus();
}
async function toggleTask(id) {
  const t = findTask(id);
  await api(`/api/v1/workspaces/${ws()}/tasks/${id}/${t.status === 'done' ? 'uncomplete' : 'complete'}`, { method: 'POST' });
  await loadTasks(); renderApp();
}
async function nudge(id, dir) {
  const t = findTask(id);
  const list = inBucket(t.bucket);
  const i = list.findIndex((x) => x.id === id);
  const target = list[i + dir];
  if (!target) return;
  await moveTask(id, t.bucket, dir < 0 ? { beforeTaskId: target.id } : { afterTaskId: target.id });
}
async function shiftBucket(id, dir) {
  const t = findTask(id);
  const i = BUCKETS.findIndex((b) => b.id === t.bucket);
  const next = BUCKETS[i + dir];
  if (!next) return;
  await moveTask(id, next.id);
  toast(`Moved to ${next.label}`);
}

/* ── Move menu: the touch/keyboard path that never needs drag ────────── */
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
  m.style.left = `${Math.min(r.left, innerWidth - m.offsetWidth - 12)}px`;
  m.style.top = `${Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 12)}px`;

  m.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      closeMenu();
      if (b.dataset.b) return run(() => moveTask(id, b.dataset.b));
      const list = inBucket(t.bucket).filter((x) => x.id !== id);
      if (!list.length) return;
      const anchor = b.dataset.o === 'top'
        ? { beforeTaskId: list[0].id } : { afterTaskId: list[list.length - 1].id };
      run(() => moveTask(id, t.bucket, anchor));
    };
  });
  m.querySelector('button:not([disabled])')?.focus();
  state.menu = m;
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() { state.menu?.remove(); state.menu = null; }

/* ── Task detail — part of the baseline, not a bolted-on modal ───────── */
function openDetail(id) {
  const t = id ? findTask(id) : null;
  state.openTaskId = id;
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  const p = document.createElement('aside');
  p.className = 'panel'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-modal', 'true');
  p.innerHTML = `
    <h3>${t ? 'Task' : 'New task'}</h3>
    <div class="field"><label for="d-title">Title</label>
      <input id="d-title" class="input" value="${esc(t?.title || '')}" placeholder="What needs doing?"></div>
    <div class="row">
      <div class="field"><label for="d-bucket">When</label>
        <select id="d-bucket" class="sel">${BUCKETS.map((b) => `<option value="${b.id}" ${t?.bucket === b.id ? 'selected' : ''}>${b.label}</option>`).join('')}</select></div>
      <div class="field"><label for="d-priority">Priority</label>
        <select id="d-priority" class="sel">${PRIORITIES.map((x) => `<option value="${x}" ${(t?.priority || 'medium') === x ? 'selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></div>
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
    ${t ? `<div class="field"><label>Steps</label>
      <div class="steps" id="d-steps">${(t.steps || []).map(stepHtml).join('') || '<div class="empty" style="padding:8px">No steps yet.</div>'}</div>
      <div class="row"><input id="d-step" class="input" placeholder="Add a step…"><button class="btn" id="d-step-add">Add</button></div>
    </div>` : ''}
    <div class="panel-foot">
      <button class="btn btn-primary" id="d-save">${t ? 'Save' : 'Create task'}</button>
      ${t ? '<button class="btn" id="d-archive">Archive</button><button class="btn btn-ghost" id="d-del" style="margin-left:auto;color:#FF646E">Delete</button>' : ''}
    </div>`;

  document.body.append(scrim, p);
  const close = () => { scrim.remove(); p.remove(); state.openTaskId = null; };
  scrim.onclick = close;
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });
  p.querySelector('#d-title').focus();

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
    close(); await loadTasks(); renderApp();
    toast(t ? 'Saved' : 'Task created');
  });

  if (t) {
    p.querySelector('#d-archive').onclick = () => run(async () => {
      await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/archive`, { method: 'POST' });
      close(); await loadTasks(); renderApp(); toast('Archived');
    });
    p.querySelector('#d-del').onclick = () => run(async () => {
      if (!confirm('Delete this task permanently?')) return;
      await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}`, { method: 'DELETE' });
      close(); await loadTasks(); renderApp(); toast('Deleted');
    });
    const addStep = () => run(async () => {
      const input = p.querySelector('#d-step');
      const title = input.value.trim(); if (!title) return;
      await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/steps`, { method: 'POST', body: { title } });
      input.value = ''; await loadTasks(); close(); openDetail(t.id);
    });
    p.querySelector('#d-step-add').onclick = addStep;
    p.querySelector('#d-step').onkeydown = (e) => { if (e.key === 'Enter') addStep(); };
    p.querySelectorAll('.step').forEach((row) => {
      const sid = row.dataset.id;
      row.querySelector('input').onchange = (e) => run(async () => {
        await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/steps/${sid}`, {
          method: 'PATCH', body: { completed: e.target.checked },
        });
        await loadTasks(); close(); openDetail(t.id);
      });
      row.querySelector('button').onclick = () => run(async () => {
        await api(`/api/v1/workspaces/${ws()}/tasks/${t.id}/steps/${sid}`, { method: 'DELETE' });
        await loadTasks(); close(); openDetail(t.id);
      });
    });
  }
}
const stepHtml = (s) => `<div class="step ${s.completed ? 'done' : ''}" data-id="${s.id}">
  <input type="checkbox" ${s.completed ? 'checked' : ''} aria-label="Step done">
  <span>${esc(s.title)}</span><button aria-label="Delete step">×</button></div>`;

initAuth();
