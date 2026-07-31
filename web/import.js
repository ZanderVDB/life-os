/**
 * Import preview — dry run only.
 *
 * The export file is parsed in the browser. Only the parsed JSON is posted to
 * the user's own API, which returns counts. No write path exists yet.
 */
const CFG = window.LIFE_OS_CONFIG;
const out = document.getElementById('out');
const drop = document.getElementById('drop');
const file = document.getElementById('file');

try { document.getElementById('apihost').textContent = new URL(CFG.apiBaseUrl).host; } catch { /* leave default */ }

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
    const res = await fetch(`${CFG.apiBaseUrl}/api/v1/workspaces/${workspaceId}/import/legacy/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ export: json }),
    });
    const data = await res.json();
    if (!res.ok) return fail(esc(data?.error?.message || `Request failed (${res.status})`));
    render(data.preview, f.name);
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
      <b>Nothing was imported.</b> The write path is deliberately not built yet.
      Check these numbers against what you expect to see; if they look right,
      that is the green light to build the real import.
    </div>`;
}
