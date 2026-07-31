/**
 * Habit editor — reachable directly from the rail.
 *
 * Editing a habit should not require navigating into Settings. The rail is
 * where habits are used every day, so it is also where they are adjusted.
 * Settings keeps the full list for bulk work; this is the focused path.
 */
import { reducedMotion, settle } from './motion.js';

/**
 * Entrance/exit keyframes for a dialog.
 *
 * These animate the INDEPENDENT `translate` and `scale` properties, never
 * `transform`. Centring lives in `transform: translate(-50%,-50%)` on desktop
 * and is dropped entirely for the mobile bottom sheet; an animation that touched
 * `transform` would override whichever one applied and throw the dialog off the
 * screen. The independent properties compose with `transform` instead of
 * replacing it, so the same keyframes are correct at every breakpoint.
 */
const RISE_IN = [{ opacity: 0, translate: '0 10px', scale: '0.985' },
  { opacity: 1, translate: '0 0', scale: '1' }];
const RISE_OUT = [{ opacity: 1, translate: '0 0', scale: '1' },
  { opacity: 0, translate: '0 6px', scale: '0.99' }];

const FREQ = [
  { id: 'daily', label: 'Every day' },
  { id: 'specific_days', label: 'Certain days' },
  { id: 'times_per_week', label: 'A few times a week' },
  { id: 'weekly', label: 'Once a week' },
];
const DAYS = [['1', 'M'], ['2', 'T'], ['3', 'W'], ['4', 'T'], ['5', 'F'], ['6', 'S'], ['0', 'S']];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),'
  + 'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * @param {object} ctx { habit, areas, recent, onSave, onArchive, onRestore, onDelete }
 *        recent: [{ entryDate, completedCount }] most-recent-first
 */
export function openHabitModal(ctx) {
  const { habit: h, areas, recent = [] } = ctx;
  const opener = document.activeElement;
  document.querySelector('.modal-scrim')?.remove();

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  const dlg = document.createElement('div');
  dlg.className = 'modal modal-narrow';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', h ? 'Edit habit' : 'New habit');

  const cfgDays = Array.isArray(h?.frequencyConfig?.days)
    ? h.frequencyConfig.days.map(String) : [];

  dlg.innerHTML = `
    <div class="m-head">
      <textarea id="h-name" class="m-title" rows="1" placeholder="What is the habit?"
        aria-label="Habit name">${esc(h?.name ?? '')}</textarea>
      <button class="m-close" id="h-close" aria-label="Close">&times;</button>
    </div>

    <div class="m-body">
      ${h ? `<div class="h-stats">
        <div class="h-stat"><span class="n">${h.streak ?? 0}</span><span class="l">day streak</span></div>
        <div class="h-stat"><span class="n">${h.historyCount ?? 0}</span><span class="l">recent completions</span></div>
      </div>` : ''}

      <label class="m-field"><span>How often</span>
        <select id="h-freq" class="m-input">
          ${FREQ.map((f) => `<option value="${f.id}" ${(h?.frequencyType ?? 'daily') === f.id ? 'selected' : ''}>${f.label}</option>`).join('')}
        </select></label>

      <div class="m-field h-days ${(h?.frequencyType ?? 'daily') === 'specific_days' ? '' : 'is-hidden'}" id="h-days-field">
        <span>Which days</span>
        <div class="h-day-row" role="group" aria-label="Days of the week">
          ${DAYS.map(([v, l]) => `<button type="button" class="h-day" data-day="${v}"
            aria-pressed="${cfgDays.includes(v)}" aria-label="${l}">${l}</button>`).join('')}
        </div>
      </div>

      <div class="m-grid">
        <label class="m-field"><span>Times per day</span>
          <input id="h-target" type="number" min="1" max="20" class="m-input"
            value="${h?.targetCount ?? 1}"></label>
        <label class="m-field"><span>Area</span>
          <select id="h-area" class="m-input"><option value="">No area</option>
            ${areas.map((a) => `<option value="${a.id}" ${h?.areaId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
          </select></label>
      </div>

      ${h && recent.length ? `<div class="h-recent">
        <span class="h-recent-label">Recent history</span>
        <div class="h-recent-row">
          ${recent.slice(0, 14).map((d) => `<span class="h-dot ${d.done ? 'is-done' : ''}"
            title="${esc(d.label)}"></span>`).join('')}
        </div>
        <span class="h-recent-note">last 14 days · oldest left</span>
      </div>` : ''}
    </div>

    <div class="m-foot">
      ${h ? (h.archivedAt
        ? '<button class="btn btn-ghost" id="h-restore">Restore</button>'
        : '<button class="btn btn-ghost" id="h-archive">Archive</button>')
        + '<button class="btn btn-ghost m-danger" id="h-delete">Delete</button>' : ''}
      <span class="m-save-state" id="h-state" role="status"></span>
      <button class="btn" id="h-cancel">Cancel</button>
      <button class="btn btn-primary" id="h-save">${h ? 'Save' : 'Add habit'}</button>
    </div>`;

  document.body.append(scrim, dlg);
  document.body.classList.add('modal-open');
  if (!reducedMotion()) {
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    dlg.animate(RISE_IN, { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  const name = dlg.querySelector('#h-name');
  const grow = () => { name.style.height = 'auto'; name.style.height = `${name.scrollHeight}px`; };
  name.addEventListener('input', grow); grow();
  name.focus();
  name.setSelectionRange(name.value.length, name.value.length);

  // "Certain days" is the only frequency that needs a day picker; showing it
  // otherwise is a control that does nothing.
  const freq = dlg.querySelector('#h-freq');
  freq.onchange = () => {
    dlg.querySelector('#h-days-field').classList.toggle('is-hidden', freq.value !== 'specific_days');
  };
  dlg.querySelectorAll('.h-day').forEach((b) => {
    b.onclick = () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('modal-open');
    const done = () => { scrim.remove(); dlg.remove(); };
    if (reducedMotion()) done();
    else {
      scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in' });
      const a = dlg.animate(RISE_OUT,
        { duration: 160, easing: 'cubic-bezier(.4,0,.9,.4)' });
      // A stalled animation must not leave the dialog on screen blocking
      // the page — `settle` guarantees the teardown either way.
      settle(a, 160, done);
    }
    if (opener?.isConnected) opener.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...dlg.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const [first, last] = [items[0], items[items.length - 1]];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKey, true);
  scrim.onclick = close;
  dlg.querySelector('#h-close').onclick = close;
  dlg.querySelector('#h-cancel').onclick = close;

  const state = dlg.querySelector('#h-state');
  dlg.querySelector('#h-save').onclick = async () => {
    const body = {
      name: name.value.trim(),
      frequencyType: freq.value,
      targetCount: Math.max(1, Number(dlg.querySelector('#h-target').value) || 1),
      areaId: dlg.querySelector('#h-area').value || null,
    };
    if (body.frequencyType === 'specific_days') {
      body.frequencyConfig = {
        days: [...dlg.querySelectorAll('.h-day[aria-pressed="true"]')].map((b) => Number(b.dataset.day)),
      };
    }
    if (!body.name) { name.focus(); state.textContent = 'A name is needed'; return; }
    state.textContent = 'Saving…';
    try { await ctx.onSave(body); close(); }
    catch (e) { state.textContent = e.message; }
  };

  dlg.querySelector('#h-archive')?.addEventListener('click', async () => {
    // Archiving is safe and reversible, so it does not need a confirmation —
    // the copy says what happens to the history.
    await ctx.onArchive(); close();
  });
  dlg.querySelector('#h-restore')?.addEventListener('click', async () => { await ctx.onRestore(); close(); });
  dlg.querySelector('#h-delete')?.addEventListener('click', async () => {
    if (!confirm(`Delete "${h.name}" and its entire completion history? `
      + 'This cannot be undone. Archive instead if you only want it off Today.')) return;
    await ctx.onDelete(); close();
  });

  return { close };
}
