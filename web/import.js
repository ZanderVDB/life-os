/**
 * Import preview — dry run only.
 *
 * The export file is parsed in the browser. Only the parsed JSON is posted to
 * the user's own API, which returns counts. No write path exists yet.
 */
const CFG = window.LIFE_OS_CONFIG;
const out = document.getElementById('out');
let lastPreview = null;   // { preview, fingerprint, exportJson, token, workspaceId }
/** 'tasks' | 'habits' — which system this preview is for. */
let mode = 'tasks';
const drop = document.getElementById('drop');
const file = document.getElementById('file');

try { document.getElementById('apihost').textContent = new URL(CFG.apiBaseUrl).host; } catch { /* leave default */ }

document.querySelectorAll('[data-mode]').forEach((el) => {
  el.onclick = () => {
    mode = el.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach((b) =>
      b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    document.getElementById('page-h1').textContent =
      mode === 'habits' ? 'Habits import preview' : 'Legacy import preview';
    out.innerHTML = '';
    lastPreview = null;
  };
});

document.getElementById('pick').onclick = () => file.click();
file.onchange = () => file.files[0] && handle(file.files[0]);
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) handle(f);
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Returns a token that is valid right now, from the live Firebase session.
 *
 * Reading the value the Today page happened to leave in localStorage is not
 * good enough: ID tokens last an hour, and this page is usually opened long
 * after signing in. Asking Firebase directly also means the sign-in state shown
 * here can never disagree with the real one.
 */
async function freshToken() {
  // Same local-development bypass as the Today page: only ever against a
  // localhost API, and only useful if that server was started with
  // DEV_AUTH_BYPASS — which loadEnv() refuses to read in staging or production.
  const dev = localStorage.getItem('los2_dev_token');
  if (dev && /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(CFG.apiBaseUrl)) return dev;

  if (!CFG.isConfigured) throw new Error('This deployment is not configured — no Firebase settings.');
  const [{ initializeApp, getApps }, auth] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js'),
  ]);
  const app = getApps().length ? getApps()[0] : initializeApp(CFG.firebase);
  const a = auth.getAuth(app);

  const user = await new Promise((resolve) => {
    const stop = auth.onAuthStateChanged(a, (u) => { stop(); resolve(u); });
  });
  if (!user) {
    throw new Error('You are not signed in. Open Today, sign in, then come back to this page.');
  }
  return user.getIdToken(/* forceRefresh */ true);
}

async function handle(f) {
  out.innerHTML = `<div class="card">Reading <b>${esc(f.name)}</b>…</div>`;
  let json;
  try {
    json = JSON.parse(await f.text());
  } catch {
    return fail('That file is not valid JSON. Choose the export produced by the v242 exporter.');
  }

  // Refuse an unverified export here too, so the user sees why before any network call.
  if (json?.verification?.ok !== true) {
    return fail('This export is not verified. Only a verified v242 export can be used as an import source. '
      + 'Re-run the exporter until verification passes.');
  }

  // Mint a FRESH token rather than trusting localStorage. Firebase ID tokens
  // expire after an hour, and the stored one is whatever the Today page last
  // wrote — very likely stale by the time someone opens this page.
  let token;
  try {
    token = await freshToken();
  } catch (e) {
    return fail(esc(e.message));
  }
  const workspaceId = localStorage.getItem('los2_ws');
  if (!workspaceId) {
    return fail('Open <a href="./index.html">Today</a> once so the workspace is known, then come back.');
  }

  out.innerHTML = '<div class="card">Building the plan…</div>';
  try {
    const endpoint = mode === 'habits' ? 'import/habits/preview' : 'import/legacy/preview';
    const res = await fetch(`${CFG.apiBaseUrl}/api/v1/workspaces/${workspaceId}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ export: json }),
    });
    const data = await res.json();
    if (!res.ok) return fail(esc(data?.error?.message || `Request failed (${res.status})`));
    lastPreview = { preview: data.preview, fingerprint: data.fingerprint,
      exportJson: json, token, workspaceId, filename: f.name, mode };
    if (mode === 'habits') renderHabits(data.preview, f.name, data.confirmPhrase);
    else render(data.preview, f.name);
  } catch (e) {
    fail(`Could not reach the API at <code>${esc(CFG.apiBaseUrl)}</code>. ${esc(e.message)}`);
  }
}

const fail = (html) => { out.innerHTML = `<div class="card"><span class="pill err">Cannot preview</span>
  <p style="margin:12px 0 0;line-height:1.65;color:var(--text-2);font-size:13.5px">${html}</p></div>`; };

const countRows = (obj) => Object.entries(obj || {})
  .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('');

function render(p, filename) {
  const s = p.source || {};
  const skipped = p.tasks.skipped || [];
  const excluded = p.excluded || [];
  const problems = [...(p.errors || []).map((m) => ['err', m]), ...(p.warnings || []).map((m) => ['warn', m])];

  out.innerHTML = `
    ${p.ok ? '' : `<div class="card"><span class="pill err">Plan not usable</span>
      <p style="margin:12px 0 0;font-size:13.5px;line-height:1.65;color:var(--text-2)">
        This export cannot be imported as-is. See the problems below.</p></div>`}

    <h2>Source</h2>
    <div class="card">
      <table><tbody>
        <tr><td>File</td><td>${esc(filename)}</td></tr>
        <tr><td>Export format</td><td>${esc(s.format || '—')}${s.exportVersion ? ` v${esc(s.exportVersion)}` : ''}</td></tr>
        <tr><td>Created by app</td><td>${esc(s.appVersion || '—')}${s.createdAt ? ` · ${esc(s.createdAt)}` : ''}</td></tr>
        <tr><td>Verification</td><td>${s.verified
          ? '<span class="pill ok">verified</span>'
          : `<span class="pill err">${esc(s.verificationStatus || 'not verified')}</span>`}</td></tr>
        <tr><td>Profile chosen</td><td><b>${esc(p.profileChosen?.name || p.profileChosen?.id || '—')}</b>
          <span class="pill ok">only this one</span></td></tr>
        <tr><td>Profiles ignored</td><td>${(p.profilesIgnored || []).length
          ? `${esc(p.profilesIgnored.map((x) => x.name || x.id).join(', '))} <span class="pill skip">never read</span>`
          : '<span class="pill skip">none</span>'}</td></tr>
        <tr><td>Would write</td><td><span class="pill skip">no — dry run</span></td></tr>
      </tbody></table>
    </div>

    <h2>Would create</h2>
    <div class="grid">
      <div class="stat"><div class="n">${p.areas.total}</div><div class="l">Areas</div></div>
      <div class="stat"><div class="n">${p.areas.mappedToDefaults}</div><div class="l">Merged into defaults</div></div>
      <div class="stat"><div class="n">${p.tasks.total}</div><div class="l">Tasks</div></div>
      <div class="stat"><div class="n">${p.steps}</div><div class="l">Steps</div></div>
    </div>
    <div class="grid" style="margin-top:12px">
      <div class="stat"><div class="n">${p.tasks.completed}</div><div class="l">Already completed</div></div>
      <div class="stat"><div class="n">${p.tasks.withDueDate}</div><div class="l">With a due date</div></div>
      <div class="stat"><div class="n">${p.tasks.withUnparseableTime}</div><div class="l">Time kept verbatim</div></div>
    </div>

    <h2>By bucket</h2>
    <div class="card"><table>
      <thead><tr><th>Bucket</th><th>Tasks</th></tr></thead>
      <tbody>${countRows(p.tasks.byBucket)}</tbody></table></div>

    <h2>By priority</h2>
    <div class="card"><table>
      <thead><tr><th>Priority</th><th>Tasks</th></tr></thead>
      <tbody>${countRows(p.tasks.byPriority)}</tbody></table></div>

    ${skipped.length ? `<h2>Skipped</h2><div class="card"><table>
      <thead><tr><th>Reason</th><th>Count</th></tr></thead>
      <tbody>${skipped.map((r) => `<tr><td>${esc(r.reason)}</td><td>${r.count}</td></tr>`).join('')}</tbody>
    </table></div>` : ''}

    ${excluded.length ? `<h2>Not in this baseline</h2>
    <div class="card">
      <p style="margin:0 0 14px;color:var(--text-2);font-size:13px;line-height:1.65">
        These exist in the export but Life OS v2 has nowhere to put them yet. They stay
        untouched in the legacy export and can be imported once each system is built.</p>
      <table>
        <thead><tr><th>Collection</th><th>Records</th><th>Reason</th></tr></thead>
        <tbody>${excluded.map((r) => `<tr><td>${esc(r.collection)}</td><td>${r.count}</td>
          <td><span class="pill warn">${esc(r.reason)}</span></td></tr>`).join('')}</tbody>
      </table>
    </div>` : ''}

    ${(p.excludedProfiles || []).length ? `<h2>Excluded profiles — never read</h2>
    <div class="card">
      <p style="margin:0 0 14px;color:var(--text-2);font-size:13px;line-height:1.65">
        Record counts only. The contents of these profiles are not opened, not
        parsed and not sent anywhere — this is here so you can see the size of
        what is being left behind, not what it says.</p>
      ${p.excludedProfiles.map((prof) => `
        <div style="margin-bottom:14px">
          <div style="font-size:13px;margin-bottom:6px"><b>${esc(prof.name || prof.id)}</b>
            <span class="pill skip">excluded</span>
            <span style="color:var(--muted)">·
              ${prof.collections.reduce((n, c) => n + c.count, 0)} records total</span></div>
          <table><thead><tr><th>Collection</th><th>Records</th></tr></thead>
            <tbody>${prof.collections.map((c) =>
              `<tr><td>${esc(c.collection)}</td><td>${c.count}</td></tr>`).join('')}</tbody></table>
        </div>`).join('')}
    </div>` : ''}

    ${Object.keys(p.retiredFields || {}).length ? `<h2>Retired fields dropped</h2>
    <div class="card">
      <p style="margin:0 0 14px;color:var(--text-2);font-size:13px;line-height:1.65">
        These fields belonged to features that no longer exist. The count is how
        many tasks in the file carry a value that this import will not bring across.</p>
      <table><thead><tr><th>Field</th><th>Tasks affected</th></tr></thead>
        <tbody>${countRows(p.retiredFields)}</tbody></table>
    </div>` : ''}

    ${p.duplicateRisk ? `<h2>Duplicate risk</h2>
    <div class="card">
      <table><tbody>
        <tr><td>Duplicate legacy ids inside the file</td>
            <td>${p.duplicateRisk.duplicateLegacyIdsInFile}
            ${p.duplicateRisk.duplicateLegacyIdsInFile ? '<span class="pill warn">skipped, first kept</span>' : '<span class="pill ok">none</span>'}</td></tr>
        <tr><td>Tasks carrying a legacy id</td><td>${p.duplicateRisk.tasksCarryingLegacyId}
            <span class="pill ok">protected by a unique index</span></td></tr>
        <tr><td>Areas carrying a legacy id</td><td>${p.duplicateRisk.areasCarryingLegacyId}
            <span class="pill ok">protected by a unique index</span></td></tr>
      </tbody></table>
      <p style="margin:14px 0 0;color:var(--text-2);font-size:13px;line-height:1.65">
        Every imported record keeps its legacy id, and that id is unique per
        workspace in the database. Running a real import twice therefore updates
        the same rows rather than creating a second copy.</p>
    </div>` : ''}

    ${problems.length ? `<h2>Problems</h2><div class="card"><table><tbody>
      ${problems.map(([kind, m]) => `<tr><td style="width:90px"><span class="pill ${kind}">${
        kind === 'err' ? 'error' : 'warning'}</span></td><td>${esc(m)}</td></tr>`).join('')}
    </tbody></table></div>` : ''}

    <div class="note" style="margin-top:24px;border-left-color:var(--ok);background:rgba(0,217,163,.06)">
      <b>Nothing has been imported.</b> Everything above is a dry run.
    </div>

    <h2>Import</h2>
    <div class="card">
      <p style="margin:0 0 16px;color:var(--text-2);font-size:13.5px;line-height:1.7">
        Review the confirmation on the next screen. It is the last step before
        anything is written, and it cannot be undone from this page.</p>
      <button class="btn btn-primary" id="go-confirm">Continue to confirmation…</button>
    </div>`;

  document.getElementById('go-confirm')?.addEventListener('click', () => renderConfirm());
}

/* ══ Final confirmation — the last screen before anything is written ══ */

/**
 * Deliberately NOT a single "Continue" button.
 *
 * The phrase has to be typed and it contains the task count, so a confirmation
 * meant for one file cannot be clicked through against another. The API
 * re-checks the same counts and refuses if they have moved.
 */
async function renderConfirm() {
  if (!lastPreview) return;
  const p = lastPreview.preview;
  const active = p.tasks.total - p.tasks.completed;
  const approved = {
    tasks: p.tasks.total, steps: p.steps, areas: p.areas.total,
    duplicateLegacyIds: (p.tasks.skipped || []).find((s) => s.reason === 'duplicate legacy id')?.count ?? 0,
  };
  const phrase = `IMPORT ${approved.tasks} TASKS`;

  // What is sitting in staging that did NOT come from an import.
  let cleanup = { count: 0, candidates: [] };
  try {
    const r = await fetch(`${CFG.apiBaseUrl}/api/v1/workspaces/${lastPreview.workspaceId}/staging/cleanup/preview`,
      { headers: { Authorization: `Bearer ${lastPreview.token}` } });
    if (r.ok) cleanup = await r.json();
  } catch { /* optional context, never a blocker */ }

  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  out.innerHTML = `
    <h2>Confirm import</h2>
    <div class="note" style="border-left-color:var(--danger);background:rgba(255,100,110,.07)">
      <b>This writes to the staging database.</b> It is the first irreversible
      action in the v2 relaunch. Legacy and Firestore are not touched by it.
    </div>

    <div class="card"><table><tbody>
      ${row('Source file', esc(lastPreview.filename))}
      ${row('Source app version', esc(p.source?.appVersion || '—'))}
      ${row('Source profile', `<b>${esc(p.profileChosen?.name || '—')}</b>`)}
      ${row('Excluded profile', (p.profilesIgnored || []).length
        ? `${esc(p.profilesIgnored.map((x) => x.name || x.id).join(', '))} <span class="pill skip">never read</span>`
        : '<span class="pill skip">none</span>')}
      ${row('Verification', p.source?.verified
        ? '<span class="pill ok">verified</span>' : '<span class="pill err">NOT VERIFIED</span>')}
    </tbody></table></div>

    <h2>What will be written</h2>
    <div class="grid">
      <div class="stat"><div class="n">${approved.tasks}</div><div class="l">Tasks</div></div>
      <div class="stat"><div class="n">${active}</div><div class="l">Active</div></div>
      <div class="stat"><div class="n">${p.tasks.completed}</div><div class="l">Completed history</div></div>
      <div class="stat"><div class="n">${approved.steps}</div><div class="l">Task steps</div></div>
      <div class="stat"><div class="n">${approved.areas}</div><div class="l">Areas</div></div>
      <div class="stat"><div class="n">${p.tasks.withUnparseableTime}</div><div class="l">Times kept as raw text</div></div>
    </div>

    <h2>Estimated resulting database</h2>
    <div class="card"><table><tbody>
      ${row('Tasks', `${approved.tasks} imported${cleanup.count ? ` (+ ${cleanup.count} staging test record(s) unless removed)` : ''}`)}
      ${row('Active in buckets', active)}
      ${row('In Completed history', p.tasks.completed)}
      ${row('Areas', `${approved.areas} imported + Personal and Work already present`)}
      ${row('Task steps', approved.steps)}
    </tbody></table></div>

    ${cleanup.count ? `<h2>Staging test records</h2>
    <div class="card">
      <p style="margin:0 0 14px;color:var(--text-2);font-size:13px;line-height:1.65">
        ${cleanup.count} task(s) in staging did not come from an import. Removing
        them keeps the imported set clean. Imported records can never be deleted
        by this action.</p>
      <table><thead><tr><th>Title</th><th>Bucket</th><th>Status</th></tr></thead><tbody>
        ${cleanup.candidates.map((c) => `<tr><td>${esc(c.title)}</td><td>${esc(c.bucket)}</td><td>${esc(c.status)}</td></tr>`).join('')}
      </tbody></table>
      <label style="display:flex;gap:9px;align-items:center;margin-top:14px;font-size:13px;cursor:pointer">
        <input type="checkbox" id="do-clean" checked style="accent-color:#8A5DFF;width:15px;height:15px">
        Remove these ${cleanup.count} test record(s) first
      </label>
    </div>` : ''}

    ${(p.warnings || []).length ? `<h2>Warnings</h2><div class="card"><table><tbody>
      ${p.warnings.map((w) => `<tr><td><span class="pill warn">warning</span></td><td>${esc(w)}</td></tr>`).join('')}
    </tbody></table></div>` : ''}

    <h2>Excluded — not part of this import</h2>
    <div class="card"><table><tbody>
      ${row('Reminders, habits, diary, notebook, projects, Brain', '<span class="pill skip">deferred systems</span>')}
      ${row('People and related settings', '<span class="pill skip">retired</span>')}
      ${row('dayNotes, customEvents', '<span class="pill skip">confirmed empty</span>')}
      ${row('Retired task fields', '<span class="pill skip">dropped</span>')}
      ${row('project_id', '<span class="pill skip">null on every task</span>')}
    </tbody></table></div>

    <h2>Type to confirm</h2>
    <div class="card">
      <p style="margin:0 0 14px;color:var(--text-2);font-size:13.5px;line-height:1.7">
        Type <code>${esc(phrase)}</code> exactly to enable the import button.</p>
      <input id="confirm-text" placeholder="${esc(phrase)}" autocomplete="off" spellcheck="false"
        style="width:100%;background:var(--surface-2);border:1px solid transparent;border-radius:10px;padding:11px 13px;font-size:14px;color:var(--text);font-family:inherit">
      <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
        <button class="btn btn-primary" id="do-import" disabled
          style="opacity:.45;pointer-events:none">Import ${approved.tasks} tasks</button>
        <button class="btn" id="cancel-import">Cancel</button>
      </div>
    </div>`;

  const input = document.getElementById('confirm-text');
  const go = document.getElementById('do-import');
  input.addEventListener('input', () => {
    const ok = input.value.trim() === phrase;
    go.disabled = !ok;
    go.style.opacity = ok ? '1' : '.45';
    go.style.pointerEvents = ok ? 'auto' : 'none';
  });
  document.getElementById('cancel-import').onclick = () => render(p, lastPreview.filename);
  go.onclick = () => doImport(approved, phrase, cleanup);
}

async function doImport(approved, phrase, cleanup) {
  const { workspaceId, token, exportJson } = lastPreview;
  const wantsClean = document.getElementById('do-clean')?.checked;
  out.innerHTML = '<div class="card">Importing… do not close this page.</div>';
  try {
    // Cleanup first, so a failure there stops before anything is imported.
    if (wantsClean && cleanup.count) {
      const ids = cleanup.candidates.map((c) => c.id);
      const r = await fetch(`${CFG.apiBaseUrl}/api/v1/workspaces/${workspaceId}/staging/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ taskIds: ids, confirm: `DELETE ${ids.length} STAGING TASKS` }),
      });
      const cd = await r.json();
      if (!r.ok) return fail(`Staging cleanup failed, so the import did not run. ${esc(cd?.error?.message || '')}`);
    }

    const res = await fetch(`${CFG.apiBaseUrl}/api/v1/workspaces/${workspaceId}/import/legacy/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ export: exportJson, approved, confirm: phrase }),
    });
    const data = await res.json();
    if (!res.ok) {
      const d = data?.error?.details;
      const diff = d?.mismatches?.length
        ? `<table style="margin-top:12px"><thead><tr><th>Field</th><th>Approved</th><th>Found</th></tr></thead>
           <tbody>${d.mismatches.map((m) => `<tr><td>${esc(m.field)}</td><td>${m.approved}</td><td>${m.found}</td></tr>`).join('')}</tbody></table>`
        : '';
      return fail(`${esc(data?.error?.message || 'The import was refused.')} <b>Nothing was written.</b>${diff}`);
    }
    renderResult(data);
  } catch (e) {
    fail(`The import could not complete: ${esc(e.message)}. A retry is safe — the
      same file cannot be imported twice, so nothing can be duplicated.`);
  }
}

function renderResult(r) {
  const d = r.detail;
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  out.innerHTML = `
    <h2>Import complete</h2>
    <div class="note" style="border-left-color:var(--ok);background:rgba(0,217,163,.06)">
      <b>Imported successfully.</b> Run id <code>${esc(r.runId)}</code>.
      Re-running the same file is now blocked, so this cannot be duplicated.
    </div>
    <div class="grid">
      <div class="stat"><div class="n">${r.written.tasks}</div><div class="l">Tasks</div></div>
      <div class="stat"><div class="n">${d.activeTasks}</div><div class="l">Active</div></div>
      <div class="stat"><div class="n">${d.completedTasks}</div><div class="l">Completed</div></div>
      <div class="stat"><div class="n">${r.written.steps}</div><div class="l">Steps</div></div>
      <div class="stat"><div class="n">${d.areasCreated}</div><div class="l">Areas created</div></div>
    </div>
    <h2>Detail</h2>
    <div class="card"><table><tbody>
      ${row('Completed with a known date', d.completedWithTimestamp)}
      ${row('Completed with an unknown date', d.completedWithoutTimestamp)}
      ${row('Times parsed into scheduled_at', d.scheduledAtParsed)}
      ${row('Times kept as raw legacy text', d.scheduledTimeKeptRaw)}
      ${row('Created dates taken from legacy', d.createdAtFromLegacyDate)}
      ${row('Existing Areas reused', d.areasReusedExisting)}
      ${row('Tasks with no Area', d.tasksWithNoArea)}
      ${row('Unmapped Area keys', d.unknownAreaKeys.length
        ? `<span class="pill warn">${esc(d.unknownAreaKeys.join(', '))}</span>` : '<span class="pill ok">none</span>')}
    </tbody></table></div>
    <p style="margin-top:22px"><a href="./index.html">Open Today →</a></p>`;
}

/* ══ Habits preview ═══════════════════════════════════════════════════════
 * Counts only. Habit names never appear here — the summary from the API does
 * not contain them, and this screen renders only what it is given.
 */
function renderHabits(p, filename, confirmPhrase) {
  const s = p.source || {};
  const ni = p.notImported || {};
  const skipped = p.habits.skipped || [];

  out.innerHTML = `
    ${p.ok ? '' : `<div class="card"><span class="pill err">Plan not usable</span>
      <p style="margin:12px 0 0;font-size:13.5px;line-height:1.65;color:var(--text-2)">
        ${esc((p.errors || [])[0] || 'This export cannot be imported as-is.')}</p></div>`}

    <h2>Source</h2>
    <div class="card"><table><tbody>
      <tr><td>File</td><td>${esc(filename)}</td></tr>
      <tr><td>Created by app</td><td>${esc(s.appVersion || '—')}</td></tr>
      <tr><td>Verification</td><td>${s.verified
        ? '<span class="pill ok">verified</span>'
        : `<span class="pill err">${esc(s.verificationStatus || 'not verified')}</span>`}</td></tr>
      <tr><td>Profile chosen</td><td><b>${esc(p.profileChosen?.name || '—')}</b>
        <span class="pill ok">only this one</span></td></tr>
      <tr><td>Profiles ignored</td><td>${(p.profilesIgnored || []).length
        ? `${esc(p.profilesIgnored.map((x) => x.name || x.id).join(', '))} <span class="pill skip">never read</span>`
        : '<span class="pill skip">none</span>'}</td></tr>
      <tr><td>Would write</td><td><span class="pill skip">no — dry run</span></td></tr>
    </tbody></table></div>

    <h2>Would create</h2>
    <div class="grid">
      <div class="stat"><div class="n">${p.habits.total}</div><div class="l">Habits</div></div>
      <div class="stat"><div class="n">${p.entries.total}</div><div class="l">History entries</div></div>
      <div class="stat"><div class="n">${p.entries.duplicatesCollapsed}</div><div class="l">Duplicate days merged</div></div>
      <div class="stat"><div class="n">${p.entries.invalidDates}</div><div class="l">Unreadable dates</div></div>
    </div>

    <h2>History range</h2>
    <div class="card"><table><tbody>
      <tr><td>Earliest completion</td><td>${esc(p.entries.earliest || 'none')}</td></tr>
      <tr><td>Latest completion</td><td>${esc(p.entries.latest || 'none')}</td></tr>
    </tbody></table></div>

    ${skipped.length ? `<h2>Skipped</h2><div class="card"><table>
      <thead><tr><th>Reason</th><th>Count</th></tr></thead>
      <tbody>${skipped.map((r) => `<tr><td>${esc(r.reason)}</td><td>${r.count}</td></tr>`).join('')}</tbody>
    </table></div>` : ''}

    <h2>Deliberately not imported</h2>
    <div class="card">
      <p style="margin:0 0 14px;color:var(--text-2);font-size:13px;line-height:1.65">
        Legacy kept routine checks and diary writing in the same place. Only a
        habit's own completion list is read. Everything below is counted and
        left alone.</p>
      <table><thead><tr><th>What</th><th>Amount</th><th>Why</th></tr></thead><tbody>
        <tr><td>Routine check marks</td><td>${ni.routineCheckMarks ?? 0}</td>
          <td><span class="pill warn">cannot be matched to a habit</span></td></tr>
        <tr><td>Days with routine checks</td><td>${ni.routineCheckDays ?? 0}</td>
          <td><span class="pill warn">ambiguous</span></td></tr>
        <tr><td>Days of diary writing</td><td>${ni.journalDays ?? 0}</td>
          <td><span class="pill skip">never opened — diary arrives with its own system</span></td></tr>
      </tbody></table>
    </div>

    ${(p.warnings || []).length ? `<h2>Warnings</h2><div class="card"><table><tbody>
      ${p.warnings.map((w) => `<tr><td style="width:90px"><span class="pill warn">warning</span></td>
        <td>${esc(w)}</td></tr>`).join('')}
    </tbody></table></div>` : ''}

    <div class="note" style="margin-top:24px;border-left-color:var(--ok);background:rgba(0,217,163,.06)">
      <b>Nothing has been imported.</b> Everything above is a dry run.
    </div>

    ${p.ok ? `<h2>Import</h2>
    <div class="card">
      <p style="margin:0 0 14px;color:var(--text-2);font-size:13.5px;line-height:1.7">
        Type <code>${esc(confirmPhrase)}</code> exactly to enable the import button.</p>
      <input id="hb-confirm" placeholder="${esc(confirmPhrase)}" autocomplete="off" spellcheck="false"
        style="width:100%;background:var(--surface-2);border:1px solid transparent;border-radius:10px;
               padding:11px 13px;font-size:14px;color:var(--text);font-family:inherit">
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="btn btn-primary" id="hb-go" disabled style="opacity:.45;pointer-events:none">
          Import ${p.habits.total} habits</button>
      </div>
    </div>` : ''}`;

  if (!p.ok) return;
  const input = document.getElementById('hb-confirm');
  const go = document.getElementById('hb-go');
  input.addEventListener('input', () => {
    const ok = input.value.trim() === confirmPhrase;
    go.disabled = !ok;
    go.style.opacity = ok ? '1' : '.45';
    go.style.pointerEvents = ok ? 'auto' : 'none';
  });
  go.onclick = () => doHabitImport(p, confirmPhrase);
}

async function doHabitImport(p, phrase) {
  const { workspaceId, token, exportJson } = lastPreview;
  out.innerHTML = '<div class="card">Importing habits… do not close this page.</div>';
  try {
    const res = await fetch(`${CFG.apiBaseUrl}/api/v1/workspaces/${workspaceId}/import/habits/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        export: exportJson,
        approved: { habits: p.habits.total, entries: p.entries.total },
        confirm: phrase,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return fail(`${esc(data?.error?.message || 'The import was refused.')} <b>Nothing was written.</b>`);
    }
    out.innerHTML = `
      <h2>Habits imported</h2>
      <div class="note" style="border-left-color:var(--ok);background:rgba(0,217,163,.06)">
        <b>Imported successfully.</b> Run id <code>${esc(data.runId)}</code>.
        Re-running the same file is now blocked.
      </div>
      <div class="grid">
        <div class="stat"><div class="n">${data.written.habits}</div><div class="l">Habits</div></div>
        <div class="stat"><div class="n">${data.written.entries}</div><div class="l">History entries</div></div>
      </div>
      <p style="margin-top:22px"><a href="./index.html">Open Today →</a></p>`;
  } catch (e) {
    fail(`The import could not complete: ${esc(e.message)}. A retry is safe — the same file
      cannot be imported twice.`);
  }
}
