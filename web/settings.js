/**
 * Settings — ported from the Legacy structure, not reinvented.
 *
 * Legacy used a tab strip (`.settings-tabs`) over grouped `.setting-row` cards:
 * label + description on the left, control on the right. That is the approved
 * shape and it is what this restores. Only the CONTENT differs, because some
 * Legacy settings belonged to systems that no longer exist.
 *
 * Every previous setting was classified. See docs/legacy-v2-visual-parity-audit.md.
 */
import { installState } from './pwa.js';

export const SETTINGS_TABS = [
  { id: 'account', label: 'Account' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'areas', label: 'Areas' },
  { id: 'habits', label: 'Habits' },
  { id: 'app', label: 'App' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'data', label: 'Privacy & data' },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Legacy's setting-row: label + description left, control right. */
const row = (label, desc, control = '') => `<div class="setting-row">
  <div class="setting-label-wrap">
    <div class="setting-label">${label}</div>
    ${desc ? `<div class="setting-desc">${desc}</div>` : ''}
  </div>
  ${control ? `<div class="setting-right">${control}</div>` : ''}
</div>`;

const segment = (key, current, options) => `<div class="seg" role="group" aria-label="${key}">
  ${options.map(([v, label]) => `<button data-pref="${key}" data-value="${v}"
    aria-pressed="${current === v}">${label}</button>`).join('')}</div>`;

/** A control that exists visually but cannot act yet. Never a fake state. */
const pending = (text) => `<span class="setting-pending">${text}</span>`;

export function settingsHtml(state) {
  const tab = state.settingsTab || 'account';
  const p = state.prefs;
  const install = installState();

  const panels = {
    account: () => `
      ${row('Signed in as', esc(state.me.user.email))}
      ${row('Name', esc(state.me.user.displayName || 'Not set'))}
      ${row('Workspace', `${esc(state.me.workspace.name)} · ${esc(state.me.workspace.role)}`)}
      ${row('One workspace', 'Life OS keeps everything in a single workspace. '
        + 'Areas divide your life inside it, so nothing is split in half.')}
      ${row('Sign out', 'Ends the session on this device.',
        '<button class="btn btn-danger" id="sign-out">Sign out</button>')}
      ${row('Version', 'Useful when reporting a problem.',
        `<code class="set-build">${esc(window.LIFE_OS_BUILD ?? 'unknown')}</code>`)}`,

    appearance: () => `
      ${row('Theme', 'Life OS is designed dark.',
        segment('appearance', p.appearance ?? 'system', [['system', 'System'], ['dark', 'Always dark']]))}
      ${row('Motion', 'Following the system also respects your device’s reduce-motion setting.',
        segment('reducedMotion', p.reducedMotion ?? 'system', [['system', 'Follow system'], ['always', 'Reduce']]))}
      ${row('Sounds', 'Subtle feedback for completing work.',
        segment('sounds', p.sounds ?? 'off', [['off', 'Off'], ['on', 'On']]))}
      <div class="setting-preview">
        <span class="sp-label">Preview</span>
        <div class="sp-demo">
          <span class="sp-swatch sp-brand"></span>
          <span class="sp-swatch sp-surface"></span>
          <span class="sp-swatch sp-ok"></span>
          <span class="sp-swatch sp-danger"></span>
          <span class="sp-text">Purple leads. Green means done. Red means stop.</span>
        </div>
      </div>`,

    areas: () => `
      <p class="setting-intro">Areas are the parts of your life. Every task belongs
        to one. Removing an Area never deletes the work inside it — those tasks
        simply lose their label.</p>
      <div class="area-list">
        ${state.me.areas.map((a) => `<div class="area-row" data-area-row="${a.id}">
          <span class="area-dot"></span>
          <input class="area-input" value="${esc(a.name)}" data-area-name="${a.id}"
            aria-label="Area name">
          <span class="area-meta">${state.tasks.filter((t) => t.areaId === a.id).length} active</span>
          ${a.isSystem
            ? '<span class="area-lock" title="Built-in Areas cannot be removed">built in</span>'
            : `<button class="icon-btn" data-area-del="${a.id}" aria-label="Remove ${esc(a.name)}">×</button>`}
        </div>`).join('')}
      </div>
      <div class="area-add">
        <input class="input" id="new-area" placeholder="New area name">
        <button class="btn" id="add-area">Add area</button>
      </div>`,

    habits: () => {
      const hs = state.habits ?? [];
      const active = hs.filter((h) => !h.archivedAt);
      const archived = hs.filter((h) => h.archivedAt);
      return `
      <p class="setting-intro">Habits are recurring intentions, kept separately from
        tasks and from your diary. Tick them from the rail on Today.</p>
      ${row('Count writing in Diary as a daily habit',
    'Adds <b>Write in Diary</b> to Today and to your Habit history, completed '
    + 'automatically on any day that holds a diary entry. It is worked out from '
    + 'what you have written, so turning it off changes nothing in your Diary — '
    + 'and turning it back on brings the whole history with it.',
    segment('diaryHabit', p.diaryHabit ?? 'on', [['on', 'On'], ['off', 'Off']]))}
      ${active.length ? `<div class="habit-list">
        ${active.map((h) => `<div class="habit-row" data-habit-row="${h.id}">
          <span class="habit-dot" style="--hc:var(--ok)"></span>
          <input class="area-input" value="${esc(h.name)}" data-habit-name="${h.id}"
            aria-label="Habit name">
          <select class="qc-sel habit-freq" data-habit-freq="${h.id}" aria-label="Frequency">
            <option value="daily" ${h.frequencyType === 'daily' ? 'selected' : ''}>Every day</option>
            <option value="weekly" ${h.frequencyType === 'weekly' ? 'selected' : ''}>Weekly</option>
            <option value="times_per_week" ${h.frequencyType === 'times_per_week' ? 'selected' : ''}>Some days</option>
          </select>
          <span class="area-meta">${h.streak > 0 ? `${h.streak}d streak` : 'no streak yet'}</span>
          <button class="icon-btn" data-habit-archive="${h.id}"
            aria-label="Archive ${esc(h.name)}" title="Archive">&#8595;</button>
        </div>`).join('')}
      </div>` : '<p class="rail-quiet">No habits yet. Add your first below.</p>'}
      <div class="area-add">
        <input class="input" id="new-habit" placeholder="New habit, e.g. Read for 20 minutes">
        <button class="btn" id="add-habit">Add habit</button>
      </div>
      ${archived.length ? `<div class="setting-help" style="margin-top:16px">
        <b>Archived (${archived.length})</b>
        Archived habits keep their history and stop appearing on Today.
      </div>` : ''}`;
    },

    app: () => `
      ${row('Version', `<span id="build-id">${esc(window.LIFE_OS_BUILD || 'unknown')}</span>`)}
      ${row('Installation', `<span id="install-status">${esc(install.label)}</span>`,
        install.canInstall
          ? '<button class="btn btn-primary" id="do-install">Install Life OS</button>'
          : install.installed ? '<span class="setting-ok">Installed</span>' : '')}
      ${install.canInstall || install.installed ? '' : `
        <div class="setting-help">
          <b>How to install</b>
          <ul>
            <li><b>Chrome / Edge, desktop</b> — the install icon at the right of the address bar,
              or ⋮ → Cast, save and share → Install page as app.</li>
            <li><b>Chrome, Android</b> — ⋮ → Add to Home screen.</li>
            <li><b>Safari, iPhone or iPad</b> — Share → Add to Home Screen.</li>
          </ul>
        </div>`}
      ${row('Updates', '<span id="update-status">Life OS checks for updates automatically.</span>',
        '<button class="btn" id="check-update">Check now</button>')}
      ${row('Removing the app', 'Remove it the way you would any installed app — from your '
        + 'home screen, dock, or your browser’s app list. A website cannot uninstall itself.')}`,

    integrations: () => `
      <p class="setting-intro">Connections to other services. Only what genuinely
        exists is listed here.</p>
      ${row('Google', 'Used to sign in.', '<span class="setting-ok">Connected</span>')}
      ${row('Calendar', 'Arrives with the Calendar section.', pending('Soon'))}
      ${row('Assistant', 'Arrives with the Life OS assistant.', pending('Soon'))}`,

    data: () => `
      <p class="setting-intro">Your data lives in your own Life OS workspace and is
        never shared.</p>
      ${row('Where your data lives', 'A private database in your Life OS workspace. '
        + 'Nothing is stored on this device beyond your sign-in.')}
      ${row('Offline', 'Life OS does not keep your tasks on this device, so they cannot '
        + 'be read from it. That also means it needs a connection to work.')}
      ${row('Backup', 'A full export you can download and keep.', pending('Soon'))}`,
  };

  return `<div class="settings">
    <div class="settings-tabs" role="tablist">
      ${SETTINGS_TABS.map((t) => `<button role="tab" class="stab" data-stab="${t.id}"
        aria-selected="${tab === t.id}">${t.label}</button>`).join('')}
    </div>
    <div class="settings-panel" role="tabpanel">${panels[tab]()}</div>
  </div>`;
}
