/**
 * Task modal — create, edit and detail in ONE component.
 *
 * Replaces the right-side drawer, which covered the rail, compressed the
 * workspace and read as an admin form. A centred dialog keeps the board
 * visible behind it, so editing a task never feels like leaving Today.
 *
 * Mobile is a bottom sheet, not this dialog squeezed narrow — a 460px form in a
 * 375px viewport is how desktop layouts get called "responsive" while being
 * unusable.
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

const BUCKETS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This Week' },
  { id: 'month', label: 'This Month' },
  { id: 'future', label: 'Future' },
];
const PRIORITIES = [
  { id: 'urgent', label: 'Urgent' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
  { id: 'someday', label: 'Someday' },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),'
  + 'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * @param {object} ctx  { task, areas, prefillTitle, onSave, onDelete, onArchive,
 *                        onToggle, steps: {add,rename,toggle,remove} }
 */
export function openTaskModal(ctx) {
  const { task: t, areas, prefillTitle = '', project = null } = ctx;
  const opener = document.activeElement;
  document.querySelector('.modal-scrim')?.remove();

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';

  const dlg = document.createElement('div');
  dlg.className = 'modal';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', t ? 'Edit task' : 'New task');

  const steps = t?.steps ?? [];
  const doneSteps = steps.filter((s) => s.completed).length;

  dlg.innerHTML = `
    <div class="m-head">
      ${t ? `<button class="m-tick ${t.status === 'done' ? 'is-done' : ''}" id="m-toggle"
        aria-pressed="${t.status === 'done'}"
        aria-label="${t.status === 'done' ? 'Mark not done' : 'Mark done'}">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor"
          stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg></button>` : ''}
      <textarea id="m-title" class="m-title" rows="1" placeholder="What needs doing?"
        aria-label="Task title">${esc(t?.title ?? prefillTitle)}</textarea>
      <button class="m-close" id="m-close" aria-label="Close">&times;</button>
    </div>

    <div class="m-body">
      <div class="m-grid">
        <label class="m-field"><span>When</span>
          <select id="m-bucket" class="m-input">
            ${BUCKETS.map((b) => `<option value="${b.id}" ${t?.bucket === b.id ? 'selected' : ''}>${b.label}</option>`).join('')}
          </select></label>
        <label class="m-field"><span>Priority</span>
          <select id="m-priority" class="m-input pri-select" data-pri="${t?.priority ?? 'medium'}">
            ${PRIORITIES.map((p) => `<option value="${p.id}" ${(t?.priority ?? 'medium') === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
          </select></label>
        <label class="m-field"><span>Area</span>
          <select id="m-area" class="m-input"><option value="">No area</option>
            ${areas.map((a) => `<option value="${a.id}" ${t?.areaId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
          </select></label>
        <label class="m-field"><span>Due date</span>
          <input id="m-due" type="date" class="m-input" value="${t?.dueDate ?? ''}"></label>
      </div>

      ${t?.legacyScheduledTimeRaw ? `<div class="m-legacy">
        <span class="m-legacy-label">Time from the old app</span>
        <span class="m-legacy-value">${esc(t.legacyScheduledTimeRaw)}</span>
        <span class="m-legacy-note">kept exactly as written</span>
      </div>` : ''}

      ${t ? `<div class="m-steps-block">
        <div class="m-steps-head">
          <span>Steps</span>
          ${steps.length ? `<span class="m-steps-count">${doneSteps}/${steps.length}</span>` : ''}
        </div>
        <div class="m-steps" id="m-steps">${steps.map(stepRow).join('')}</div>
        <div class="m-step-add">
          <input id="m-step-new" class="m-input" placeholder="Add a step…">
        </div>
      </div>` : ''}

      <label class="m-field m-notes-field"><span>Notes</span>
        <textarea id="m-notes" class="m-input m-notes" placeholder="Anything worth remembering">${esc(t?.notes ?? '')}</textarea></label>

      <!-- Shown only when the task actually belongs to a project. Naming the
           field with a "coming soon" tag made every task editor carry a
           permanent reminder of something unfinished; a task with no project
           simply has no project line. -->
      ${project ? `<div class="m-project">
        <span class="m-project-lbl">Project</span>
        <span class="m-project-name">${esc(project.title)}</span>
      </div>` : ''}
    </div>

    <div class="m-foot">
      ${t ? `<button class="btn btn-ghost m-danger" id="m-delete">Delete</button>
             <button class="btn btn-ghost" id="m-archive">Archive</button>` : ''}
      <span class="m-save-state" id="m-save-state" role="status"></span>
      <button class="btn" id="m-cancel">${t ? 'Close' : 'Cancel'}</button>
      <button class="btn btn-primary" id="m-save">${t ? 'Save' : 'Create task'}</button>
    </div>`;

  document.body.append(scrim, dlg);
  document.body.classList.add('modal-open');

  if (!reducedMotion()) {
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    dlg.animate(RISE_IN, { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  /* ── Unsaved-change tracking ──────────────────────────────────────── */
  const read = () => ({
    title: dlg.querySelector('#m-title').value.trim(),
    bucket: dlg.querySelector('#m-bucket').value,
    priority: dlg.querySelector('#m-priority').value,
    areaId: dlg.querySelector('#m-area').value || null,
    dueDate: dlg.querySelector('#m-due').value || null,
    notes: dlg.querySelector('#m-notes').value || null,
  });
  const initial = JSON.stringify(read());
  const isDirty = () => JSON.stringify(read()) !== initial;

  /* ── Close, with focus returned to whatever opened it ─────────────── */
  let closed = false;
  function close(force = false) {
    if (closed) return;
    if (!force && isDirty()
      && !confirm('You have unsaved changes. Close without saving?')) return;
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
    // Focus goes back where it came from, so keyboard users are not dumped at
    // the top of the document.
    if (opener?.isConnected) opener.focus();
    else document.querySelector('.nav a[aria-current="page"]')?.focus();
  }
  ctx.close = close;

  /* ── Focus trap ───────────────────────────────────────────────────── */
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...dlg.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKey, true);

  // Backdrop closes only when there is nothing to lose.
  scrim.addEventListener('click', () => close());
  dlg.querySelector('#m-close').onclick = () => close();
  dlg.querySelector('#m-cancel').onclick = () => close();

  /* ── Title: auto-grow, and Enter saves rather than adding a line ──── */
  const title = dlg.querySelector('#m-title');
  const grow = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
  title.addEventListener('input', grow);
  grow();
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dlg.querySelector('#m-save').click(); }
  });
  title.focus();
  title.setSelectionRange(title.value.length, title.value.length);

  // The priority select carries its own colour, so the control looks like what
  // it sets rather than being a neutral dropdown next to a coloured card.
  const pri = dlg.querySelector('#m-priority');
  pri.addEventListener('change', () => { pri.dataset.pri = pri.value; });

  /* ── Actions ──────────────────────────────────────────────────────── */
  const state = dlg.querySelector('#m-save-state');
  const saying = (msg) => { state.textContent = msg; };

  dlg.querySelector('#m-save').onclick = async () => {
    const body = read();
    if (!body.title) { title.focus(); saying('A title is needed'); return; }
    saying('Saving…');
    try {
      await ctx.onSave(body);
      close(true);
    } catch (e) {
      saying(e.message);
    }
  };

  if (t) {
    dlg.querySelector('#m-toggle').onclick = async () => {
      await ctx.onToggle();
      close(true);
    };
    dlg.querySelector('#m-archive').onclick = async () => {
      await ctx.onArchive();
      close(true);
    };
    dlg.querySelector('#m-delete').onclick = async () => {
      if (!confirm(`Delete "${t.title}" permanently? This cannot be undone.`)) return;
      await ctx.onDelete();
      close(true);
    };

    const newStep = dlg.querySelector('#m-step-new');
    newStep.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const v = newStep.value.trim();
      if (!v) return;
      newStep.value = '';
      await ctx.steps.add(v);
    });

    dlg.querySelector('#m-steps').addEventListener('click', async (e) => {
      const row = e.target.closest('[data-step]');
      if (!row) return;
      const id = row.dataset.step;
      if (e.target.closest('[data-step-del]')) return ctx.steps.remove(id);
      if (e.target.closest('.ms-tick')) return ctx.steps.toggle(id, !row.classList.contains('is-done'));
    });
    dlg.querySelector('#m-steps').addEventListener('keydown', (e) => {
      const input = e.target.closest('[data-step-name]');
      if (input && e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
    dlg.querySelector('#m-steps').addEventListener('blur', (e) => {
      const input = e.target.closest?.('[data-step-name]');
      if (!input) return;
      const v = input.value.trim();
      if (v && v !== input.dataset.original) ctx.steps.rename(input.closest('[data-step]').dataset.step, v);
      else input.value = input.dataset.original;
    }, true);
  }

  return { close, element: dlg };
}

const stepRow = (s) => `<div class="m-step ${s.completed ? 'is-done' : ''}" data-step="${s.id}">
  <button class="ms-tick" aria-pressed="${s.completed}" aria-label="${s.completed ? 'Undo' : 'Complete'} step">
    <svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor"
      stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg></button>
  <input class="ms-name" value="${esc(s.title)}" data-step-name data-original="${esc(s.title)}"
    aria-label="Step name">
  <button class="ms-del" data-step-del aria-label="Delete step">&times;</button>
</div>`;

export { stepRow };
