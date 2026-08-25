/**
 * Settings — one workspace, not seven unrelated pages.
 *
 * The old shape was a strip of small tabs over a column of cards, each card a
 * label and a control, all of it in a 760px gutter with the Habits rail taking
 * a third of the screen beside it. Every section looked like a different
 * product because each had grown its own controls.
 *
 * The structure now is a category column and one panel, the way an
 * administrative surface is normally arranged, and there is exactly one
 * vocabulary for the parts:
 *
 *   set-sec      a titled group. The title sits ABOVE the card, never inside
 *                another card — a card within a card is just noise.
 *   set-card     the group's surface. Rows are divided by a hairline, so a
 *                list of five settings reads as one object, not five.
 *   set-row      label + description on the left, the control on the right.
 *   set-row-full the same row when the content needs the whole width.
 *   set-badge    real state only: on, attention, off, later.
 *
 * Nothing here is decorative. A control that cannot act is not drawn as a
 * control, and a status is never shown unless something actually reports it.
 */
import { installState } from './pwa.js';
import { selectField } from './menu.js';

export const SETTINGS_TABS = [
  { id: 'account', label: 'Account', blurb: 'Who you are signed in as, and the workspace you are in.' },
  { id: 'appearance', label: 'Appearance', blurb: 'How Life OS looks and how much it moves.' },
  { id: 'areas', label: 'Areas', blurb: 'The parts of your life. Every task belongs to one.' },
  { id: 'habits', label: 'Habits', blurb: 'Manage the habits themselves. Ticking them off happens on Today.' },
  { id: 'integrations', label: 'Integrations', blurb: 'The services Life OS is connected to.' },
  { id: 'app', label: 'App', blurb: 'This installation, on this device.' },
  { id: 'data', label: 'Privacy & data', blurb: 'Where your data lives and what leaves it.' },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ══ The grammar ═════════════════════════════════════════════════════════ */

const sec = (title, body, note = '') => `<section class="set-sec">
  ${title ? `<h3 class="set-sec-h">${title}</h3>` : ''}
  <div class="set-card">${body}</div>
  ${note ? `<p class="set-sec-note">${note}</p>` : ''}
</section>`;

const row = (label, desc, control = '') => `<div class="set-row">
  <div class="set-row-text">
    <span class="set-label">${label}</span>
    ${desc ? `<span class="set-desc">${desc}</span>` : ''}
  </div>
  ${control ? `<div class="set-ctl">${control}</div>` : ''}
</div>`;

/** A row whose content is the width of the card — lists, prose, key/value pairs. */
const rowFull = (inner) => `<div class="set-row set-row-full">${inner}</div>`;

/** A read-only fact. Not an input: nothing here can be typed into. */
const fact = (label, value) => `<div class="set-fact">
  <span class="set-fact-k">${label}</span>
  <span class="set-fact-v">${value}</span>
</div>`;

const segment = (key, current, options) => `<div class="seg" role="group" aria-label="${key}">
  ${options.map(([v, label]) => `<button data-pref="${key}" data-value="${v}"
    aria-pressed="${current === v}">${label}</button>`).join('')}</div>`;

/** on | attention | off | later — and never a state nothing reported. */
const badge = (tone, text) => `<span class="set-badge is-${tone}">${esc(text)}</span>`;

const when = (iso, prefix = '') => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const rel = mins < 1 ? 'just now'
    : mins < 60 ? `${mins} minute${mins === 1 ? '' : 's'} ago`
      : mins < 60 * 24 ? `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? '' : 's'} ago`
        : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${prefix}${rel}`;
};

/* ══ Panels ══════════════════════════════════════════════════════════════ */

function accountPanel(state) {
  const u = state.me.user;
  const w = state.me.workspace;
  return `
    ${sec('Signed in', `
      ${rowFull(`<div class="set-facts">
        ${fact('Email', esc(u.email))}
        ${fact('Name', esc(u.displayName || 'Not set'))}
        ${fact('Workspace', `${esc(w.name)} <span class="set-role">${esc(w.role)}</span>`)}
      </div>`)}
      ${row('One workspace, always',
    'Life OS deliberately keeps everything in a single workspace. Areas divide '
    + 'your life inside it, so a task, a note and a habit about the same thing '
    + 'are never split across two places.')}`)}

    ${sec('Session', row('Sign out',
    'Ends the session on this device only. Nothing is deleted, and signing back '
    + 'in brings everything with it.',
    '<button class="btn" id="sign-out">Sign out</button>'))}`;
}

function appearancePanel(state) {
  const p = state.prefs;
  return `
    ${sec('Appearance', `
      ${row('Theme',
    'Life OS is designed dark. <b>System</b> follows your device in case that '
    + 'ever changes; <b>Always dark</b> ignores it.',
    segment('appearance', p.appearance ?? 'system',
      [['system', 'System'], ['dark', 'Always dark']]))}
      ${row('Motion',
    'Panels slide, ticks settle, the calendar eases between weeks. '
    + '<b>Reduce</b> cuts that to near-instant — and <b>Follow system</b> already '
    + 'does so if your device asks for reduced motion.',
    segment('reducedMotion', p.reducedMotion ?? 'system',
      [['system', 'Follow system'], ['always', 'Reduce']]))}
      ${row('Sounds',
    'A short, quiet confirmation when you complete something. Off everywhere else.',
    segment('sounds', p.sounds ?? 'off', [['off', 'Off'], ['on', 'On']]))}`)}

    ${sec('What the colours mean', rowFull(`<div class="set-legend">
      ${[['brand', 'Purple', 'The thing you are doing now, and anything you can act on'],
    ['ok', 'Green', 'Done, connected, healthy'],
    ['warn', 'Amber', 'Needs your attention, but nothing is broken'],
    ['danger', 'Red', 'Stop — this removes or disconnects something']]
    .map(([k, name, meaning]) => `<div class="set-legend-row">
        <span class="set-sw set-sw-${k}"></span>
        <span class="set-legend-n">${name}</span>
        <span class="set-legend-m">${meaning}</span>
      </div>`).join('')}
    </div>`),
  'These are fixed. Life OS uses one colour language everywhere so a green tick '
  + 'never means two different things.')}`;
}

function areasPanel(state) {
  const areas = state.me.areas ?? [];
  /* Say nothing until the tasks are actually here. "0 tasks" while the list is
   * still loading is not a neutral placeholder — it is a wrong number. */
  const count = (id) => (state.tasksLoaded
    ? (state.tasks ?? []).filter((t) => t.areaId === id).length : null);
  return `
    ${sec('Your areas', `
      ${areas.map((a) => {
    const n = count(a.id);
    return `<div class="set-row set-item" data-area-row="${a.id}">
        <span class="set-item-dot"></span>
        <input class="set-item-name" value="${esc(a.name)}" data-area-name="${a.id}"
          aria-label="Name of the ${esc(a.name)} area">
        <span class="set-item-meta">${n === null ? '' : `${n} ${n === 1 ? 'task' : 'tasks'}`}</span>
        ${a.isSystem
    ? `${badge('off', 'Built in')}`
    : `<button class="set-item-x" data-area-del="${a.id}"
             aria-label="Remove the ${esc(a.name)} area">Remove</button>`}
      </div>`;
  }).join('')}
      ${rowFull(`<div class="set-add">
        <input class="input" id="new-area" placeholder="New area, e.g. Health"
          aria-label="Name of the new area">
        <button class="btn" id="add-area">Add area</button>
      </div>`)}`,
  'Removing an area never deletes the work inside it — those tasks stay exactly '
  + 'where they are and simply lose the label. Built-in areas are part of how '
  + 'Life OS files things and cannot be removed.')}`;
}

const HABIT_FREQ = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekly', label: 'Once a week' },
  { id: 'times_per_week', label: 'A few days a week' },
];

function habitsPanel(state) {
  const p = state.prefs;
  const hs = state.habits ?? [];
  const active = hs.filter((h) => !h.archivedAt);
  const archived = hs.filter((h) => h.archivedAt);
  return `
    ${sec('Diary', row('Count writing in Diary as a daily habit',
    'Adds <b>Write in Diary</b> to Today and to your habit history, completed '
    + 'automatically on any day that holds a diary entry. It is worked out from '
    + 'what you have written, so turning it off changes nothing in your Diary — '
    + 'and turning it back on brings the whole history with it.',
    segment('diaryHabit', p.diaryHabit ?? 'on', [['on', 'On'], ['off', 'Off']])))}

    ${sec('Your habits', `
      ${active.length ? active.map((h) => `<div class="set-row set-item" data-habit-row="${h.id}">
        <span class="set-item-dot set-item-dot-ok"></span>
        <input class="set-item-name" value="${esc(h.name)}" data-habit-name="${h.id}"
          aria-label="Name of the habit ${esc(h.name)}">
        ${selectField(`habit-freq-${h.id}`, HABIT_FREQ, h.frequencyType, 'How often')}
        <span class="set-item-meta">${h.streak > 0
    ? `${h.streak} day${h.streak === 1 ? '' : 's'} running` : 'No streak yet'}</span>
        <button class="set-item-x" data-habit-archive="${h.id}"
          aria-label="Archive the habit ${esc(h.name)}">Archive</button>
      </div>`).join('')
    : rowFull('<p class="set-empty">No habits yet. The first one you add appears '
      + 'on Today tomorrow morning.</p>')}
      ${rowFull(`<div class="set-add">
        <input class="input" id="new-habit" aria-label="Name of the new habit"
          placeholder="New habit, e.g. Read for 20 minutes">
        <button class="btn" id="add-habit">Add habit</button>
      </div>`)}`,
  'Archiving keeps a habit’s whole history and stops it appearing on Today. '
  + 'It is not a delete.')}

    ${archived.length ? sec('Archived',
    rowFull(`<p class="set-empty">${archived.length} archived habit${archived.length === 1 ? '' : 's'}
      — ${archived.map((h) => esc(h.name)).join(', ')}. Their history is kept.</p>`)) : ''}`;
}

/* ── Integrations ──────────────────────────────────────────────────────────
 * Everything on this page is read from the connection the server actually
 * holds. There is no hard-coded "Connected", and no control is drawn for
 * something the grant cannot do. */
function integrationsPanel(state) {
  const g = state.integration;
  const u = state.me.user;

  const googleAccount = sec('Google account', `
    ${row('Signed in with Google', esc(u.email),
    badge('on', 'Connected'))}
    ${row('What Life OS uses it for',
    'Signing you in. Life OS never sees or stores your Google password.')}`);

  if (g === undefined) {
    return `${googleAccount}
      ${sec('Google Calendar', rowFull('<p class="set-empty">Checking the connection…</p>'))}
      ${assistantSection()}`;
  }

  if (g.unreachable) {
    return `${googleAccount}
      ${sec('Google Calendar', row('Google Calendar',
    'Life OS could not reach its own server to check this. It is a connection '
    + 'problem here, not a problem with your Google account.',
    badge('warn', 'Could not check')))}
      ${assistantSection()}`;
  }

  if (!g?.configured) {
    return `${googleAccount}
      ${sec('Google Calendar', row('Google Calendar',
    'This Life OS server has no Google Calendar credentials configured, so the '
    + 'connection cannot be made from here.', badge('off', 'Unavailable')))}
      ${assistantSection()}`;
  }

  const c = g.connection;
  if (!c) {
    return `${googleAccount}
      ${sec('Google Calendar', `
        ${row('Google Calendar',
    'Link a Google account to see your real calendar in Life OS, and to create, '
    + 'change and delete events from here.',
    `${badge('off', 'Disconnected')}
     <button class="btn btn-primary" id="gc-connect">Connect</button>`)}`)}
      ${assistantSection()}`;
  }

  const needsAttention = c.status !== 'active' || !c.canWrite || c.failureCount > 0;
  /* Amber, not grey, for a revoked grant. Grey reads as "switched off on
   * purpose"; this is something the person has to go and fix. */
  const tone = c.status === 'active' && c.canWrite && !c.failureCount ? 'on' : 'warn';
  const label = c.status === 'revoked' ? 'Reconnection needed'
    : !c.canWrite ? 'Read only'
      : c.failureCount > 0 ? 'Syncing is failing'
        : 'Connected';

  const lastSync = when(c.lastSyncedAt) ?? 'Not yet';
  const nextSync = c.syncing ? 'Syncing now' : (when(c.nextSyncAt, '') ?? null);

  return `${googleAccount}

    ${sec('Google Calendar', `
      ${row('Connection', esc(c.accountEmail ?? 'Linked'), badge(tone, label))}
      ${row('Permission', c.canWrite
    ? 'Life OS can read your calendar, and create, change and delete events — '
      + 'each one only after you confirm it.'
    : 'Life OS can read your calendar but cannot change it. Reconnect to grant '
      + 'permission to create and edit events.',
    badge(c.canWrite ? 'on' : 'warn', c.canWrite ? 'Read and write' : 'Read only'))}
      ${row('Last sync', c.autoSync
    ? 'Life OS syncs in the background and when Google tells it something changed.'
    : 'Automatic syncing is paused until the connection is repaired.',
    `<span class="set-stamp">${esc(lastSync)}</span>
     <button class="btn" id="gc-sync" data-sync-state="idle">
       <span data-sync-label>Sync now</span></button>`)}
      ${needsAttention ? row('Repair the connection',
    c.lastError
      ? 'Google is refusing something. Reconnecting grants permission again; the '
        + 'exact message is under Technical details below.'
      : 'Sends you back to Google to grant permission again. Your events are not touched.',
    '<button class="btn btn-primary" id="gc-reconnect">Reconnect</button>') : ''}
      ${row('Disconnect',
    'Removes Google’s events from Life OS and ends the connection. Nothing in '
    + 'Google Calendar itself is changed, and your Life OS tasks, reminders and '
    + 'diary are untouched.',
    '<button class="btn btn-danger" id="gc-disconnect">Disconnect</button>')}
      ${rowFull(`<details class="set-diag">
        <summary>Technical details</summary>
        <div class="set-diag-body">
          ${fact('Status', esc(c.status))}
          ${nextSync ? fact('Next scheduled sync', esc(nextSync)) : ''}
          ${fact('Recent failures', String(c.failureCount ?? 0))}
          ${c.lastError ? fact('Last error', esc(c.lastError)) : ''}
          ${fact('Granted access', esc((c.scopes ?? []).map((s) => s.split('/').pop()).join(', ') || 'unknown'))}
        </div>
      </details>`)}`)}

    ${assistantSection()}`;
}

const assistantSection = () => sec('Assistant', row('Life OS assistant',
  'The assistant that will read your week and suggest what to do with it. It is '
  + 'not built yet, and nothing here is listening.',
  badge('later', 'Coming later')));

function appPanel() {
  const install = installState();
  return `
    ${sec('This installation', `
      ${row('Version',
    'Quote this when something looks wrong and it says exactly which build you are on.',
    `<code class="set-build" id="build-id">${esc(window.LIFE_OS_BUILD ?? 'unknown')}</code>`)}
      ${row('Installed as an app', esc(install.label),
    install.canInstall
      ? '<button class="btn btn-primary" id="do-install">Install Life OS</button>'
      : install.installed ? badge('on', 'Installed') : badge('off', 'In a browser tab'))}
      ${row('Updates',
    '<span id="update-status">Life OS updates itself in the background and asks '
    + 'before switching over, so it never changes under you mid-sentence.</span>',
    '<button class="btn" id="check-update">Check now</button>')}`)}

    ${install.canInstall || install.installed ? '' : sec('Installing', rowFull(`
      <div class="set-prose">
        <p>Installing gives Life OS its own window and its own icon. It is the
          same app either way.</p>
        <ul>
          <li><b>Chrome or Edge, desktop</b> — the install icon at the right of the
            address bar, or ⋮ → Cast, save and share → Install page as app.</li>
          <li><b>Chrome, Android</b> — ⋮ → Add to Home screen.</li>
          <li><b>Safari, iPhone or iPad</b> — Share → Add to Home Screen.</li>
        </ul>
      </div>`))}

    ${sec('Removing it', rowFull(`<p class="set-empty">Remove Life OS the way you
      would any installed app — from your home screen, your dock, or your
      browser’s list of installed apps. A website cannot uninstall itself, and
      removing it deletes nothing: everything is in your workspace, not on the
      device.</p>`))}`;
}

function dataPanel() {
  return `
    ${sec('Where your data lives', `
      ${row('Your workspace',
    'A private database belonging to your Life OS workspace. It is not shared '
    + 'with anyone and it is not sold, mined or used to train anything.')}
      ${row('On this device',
    'Only your sign-in. Tasks, notes, habits and diary entries are never written '
    + 'to this device — which is also why Life OS needs a connection to work, and '
    + 'why nothing can be read off a lost laptop.')}`)}

    ${sec('Getting your data out', `
      ${row('Export',
    'A single file with everything in it, to download and keep. It is not built '
    + 'yet — when it is, it will appear here.', badge('later', 'Not built yet'))}
      ${row('Deleting everything',
    'There is no self-serve delete yet. Ask and it is done by hand, properly, '
    + 'including the Google connection.', badge('later', 'By request'))}`)}

    ${sec('What leaves Life OS', row('Google Calendar',
    'If you connect it, calendar data moves both ways with Google — and Life OS '
    + 'keeps its own copy of those events, including who is invited, so the '
    + 'calendar loads instantly and can tell you when something clashes. '
    + 'Disconnecting removes that copy.',
    '<button class="btn" id="go-integrations">Open Integrations</button>'))}

    ${sec('The written version', `
      ${row('Privacy Policy',
    'What is stored, where it is kept, and exactly what happens to anything '
    + 'Google gives Life OS access to.',
    '<a class="btn" href="./privacy.html" target="_blank" rel="noopener">Read</a>')}
      ${row('Terms of Service',
    'What Life OS promises, what it does not, and how to end it.',
    '<a class="btn" href="./terms.html" target="_blank" rel="noopener">Read</a>')}`,
  'These describe the software as it actually behaves. If you find a line that '
  + 'does not match what Life OS does, the page is the thing that is wrong — '
  + 'please say so.')}`;
}

/* ══ The shell ═══════════════════════════════════════════════════════════ */

export function settingsHtml(state, phone = false) {
  const tab = state.settingsTab || (phone ? null : 'account');
  const current = SETTINGS_TABS.find((t) => t.id === tab) ?? SETTINGS_TABS[0];

  const panels = {
    account: accountPanel,
    appearance: appearancePanel,
    areas: areasPanel,
    habits: habitsPanel,
    integrations: integrationsPanel,
    app: appPanel,
    data: dataPanel,
  };

  /* ── On a phone, Settings is a list of pages ──────────────────────────
   *
   * §37. A secondary navigation column beside the content works on a desktop
   * because there is a desktop's worth of width for two columns. On a phone
   * it is either a 110px column of clipped labels or a horizontal scroller
   * hiding half the sections — and in both cases the panel that is open gets
   * whatever is left.
   *
   * So the index IS a page, and a section IS a page. `tab === null` is the
   * index, which is a state the desktop never enters. Nothing is removed:
   * every section, and every control inside it, is one tap away. */
  if (phone && !tab) {
    return `<div class="set-page set-index">
      ${SETTINGS_TABS.map((t) => `<button type="button" class="set-idx" data-stab="${t.id}">
        <span class="set-idx-t">
          <span class="set-idx-l">${t.label}</span>
          <span class="set-idx-b">${esc(t.blurb)}</span>
        </span>
        <span class="set-idx-chev" aria-hidden="true"></span>
      </button>`).join('')}
    </div>`;
  }
  if (phone) {
    return `<div class="set-page set-sub">
      <div class="set-main">
        <header class="set-head set-sub-head">
          <button type="button" class="set-back" data-stab-back>
            <span class="set-back-chev" aria-hidden="true"></span><span>Settings</span>
          </button>
          <h2>${current.label}</h2>
          <p>${current.blurb}</p>
        </header>
        ${panels[tab](state)}
      </div>
    </div>`;
  }

  return `<div class="set-page">
    <nav class="set-nav" aria-label="Settings sections">
      ${SETTINGS_TABS.map((t) => `<button class="set-nav-item" data-stab="${t.id}"
        ${tab === t.id ? 'aria-current="page"' : ''}>${t.label}</button>`).join('')}
    </nav>

    <div class="set-main">
      <header class="set-head">
        <h2>${current.label}</h2>
        <p>${current.blurb}</p>
      </header>
      ${panels[tab](state)}
    </div>
  </div>`;
}
