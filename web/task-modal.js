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
  /* Three states, and the difference matters.
   *
   * A completed task is NOT a new task, and it is not an ordinary open one
   * either. Conflating "task not found" with "create a task" is precisely what
   * made Completed history open a blank form. */
  const isDone = t?.status === 'done';
  dlg.setAttribute('aria-label', !t ? 'New task' : isDone ? 'Completed task' : 'Edit task');
  if (isDone) dlg.classList.add('is-completed');

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

    ${isDone ? `<div class="m-done-bar">
      <span class="m-done-when">Completed${t.completedAt
    ? ` ${esc(new Date(t.completedAt).toLocaleDateString(undefined,
      { day: 'numeric', month: 'long', year: 'numeric' }))}` : ''}</span>
      <button class="btn btn-sm" id="m-restore" type="button">Restore</button>
    </div>` : ''}

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
          <button type="button" class="btn btn-sm" id="m-step-add">Add</button>
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
  /**
   * Whether there is anything to lose.
   *
   * Includes a half-typed step: it is text the user entered into a visible
   * field, so closing on top of it must ask, not shrug.
   */
  const isDirty = () => JSON.stringify(read()) !== initial
    || !!dlg.querySelector('#m-step-new')?.value.trim();

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

  /**
   * Commits a half-typed step, if there is one.
   *
   * Assigned by the steps block below; a no-op for a task that has none yet.
   * Saving must not depend on the new-step field having been blurred first —
   * blur ordering differs between a mouse click, a keyboard Enter and a tap,
   * and "your step survives only if you clicked in the right order" is not a
   * rule anyone should have to know.
   */
  let flushStep = async () => {};

  dlg.querySelector('#m-save').onclick = async () => {
    await flushStep();
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
    /**
     * Complete.
     *
     * THE BUG THIS FIXES, and it was in the shared editor, so it lost notes on
     * Today as well as in Projects: this used to call `onToggle()` — which
     * sends only the status — and then `close(true)`, a FORCE close that skips
     * the dirty check. Type a note, tick the box, and the note was silently
     * discarded with no warning that anything had been thrown away.
     *
     * The dirty fields now travel WITH the completion, as one write. Not "save
     * then complete": two writes can half-succeed, and the second can arrive
     * before the first.
     */
    // Restore is the completed task's own verb. Same record, same id — it is
    // the inverse of completion, not a new task and not a copy.
    dlg.querySelector('#m-restore')?.addEventListener('click', async () => {
      saying('Restoring…');
      try {
        await ctx.onRestore();
        close(true);
      } catch (e) { saying(e.message); }
    });

    let busy = false;
    dlg.querySelector('#m-toggle').onclick = async () => {
      if (busy) return;             // one completion per click
      busy = true;
      try {
        await flushStep();               // a typed step is kept, like a note

        /* THE OVERRIDE.
         *
         * Today refuses to complete a task with unfinished steps; this is the
         * surface where that can be overridden, and overriding has to be a
         * decision rather than a side effect. So: say how many are unfinished,
         * say what will happen to them, and let the user back out.
         *
         * There is deliberately no "complete the task but leave the steps
         * open" option. A finished task with unfinished steps is a record that
         * contradicts itself, and every later screen would have to decide what
         * it meant. */
        const open = (ctx.task?.steps ?? []).filter((x) => !x.completed);
        if (!isDone && open.length) {
          busy = false;
          const go = await confirmOverride(dlg, open.length);
          if (!go) return;
          busy = true;
          saying('Completing steps…');
          // Every remaining step, then the parent. Text and order are
          // untouched — they are marked complete, never discarded.
          for (const st of open) await ctx.steps.toggle(st.id, true);
        }

        saying('Saving…');
        await ctx.onToggle(isDirty() ? read() : null);
        close(true);
      } catch (e) {
        // The editor stays open with everything the user typed still in it.
        busy = false;
        saying(e.message);
      }
    };
    dlg.querySelector('#m-archive').onclick = async () => {
      // Archiving keeps the record, so unsaved edits must not be lost either.
      if (isDirty()) await ctx.onSave(read());
      await ctx.onArchive();
      close(true);
    };
    dlg.querySelector('#m-delete').onclick = async () => {
      if (!confirm(`Delete "${t.title}" permanently? This cannot be undone.`)) return;
      await ctx.onDelete();
      close(true);
    };

    /* ── Steps ──────────────────────────────────────────────────────────
     *
     * A caller that renders the steps block must supply handlers for it. This
     * was not enforced, and both Projects call sites passed nothing — so every
     * step action threw "Cannot read properties of undefined" into an
     * unhandled rejection. Steps looked present and were entirely dead.
     *
     * Failing loudly here is the point: a missing handler is a wiring mistake,
     * and a silent no-op is the one outcome that hides it. */
    const stepsBox = dlg.querySelector('#m-steps');
    const newStep = dlg.querySelector('#m-step-new');
    if (!ctx.steps) {
      throw new Error('openTaskModal: a task editor with steps needs ctx.steps.');
    }

    /** Repaints the list and its count from the record the handlers mutate. */
    const paintSteps = () => {
      const list = ctx.task?.steps ?? [];
      stepsBox.innerHTML = list.map(stepRow).join('');
      const head = dlg.querySelector('.m-steps-head');
      let count = head.querySelector('.m-steps-count');
      if (!list.length) { count?.remove(); return; }
      if (!count) {
        count = document.createElement('span');
        count.className = 'm-steps-count';
        head.appendChild(count);
      }
      count.textContent = `${list.filter((x) => x.completed).length}/${list.length}`;
    };

    /**
     * Commits whatever is in the new-step box.
     *
     * Called from Enter, from the Add button, AND when the box loses focus —
     * because the only way to add a step used to be pressing Enter, nothing
     * said so, and typing a step then clicking Save threw the text away
     * without a word. Text a user typed into a visible field is not a draft to
     * be discarded on the way out.
     */
    let adding = false;
    const commitStep = async () => {
      const v = newStep.value.trim();
      if (!v || adding) return;
      adding = true;
      newStep.value = '';
      try {
        await ctx.steps.add(v);
        paintSteps();
      } catch (e) {
        newStep.value = v;                 // give it back rather than lose it
        saying(e.message);
      } finally { adding = false; }
    };

    flushStep = commitStep;

    newStep.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();                  // never submit the form instead
      commitStep();
    });
    dlg.querySelector('#m-step-add').onclick = () => commitStep();
    // Leaving the field commits too. `close()` reads the box first, below.
    newStep.addEventListener('blur', () => commitStep());

    stepsBox.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-step]');
      if (!row) return;
      const id = row.dataset.step;
      try {
        if (e.target.closest('[data-step-del]')) await ctx.steps.remove(id);
        else if (e.target.closest('.ms-tick')) {
          const turningOn = !row.classList.contains('is-done');
          /* Out-of-order is ALLOWED here — this is the override surface — but
           * it should not be a surprise. Said once, before the write, so the
           * user knows Today will still start them from the earliest open
           * step rather than jumping to wherever they just ticked. */
          const ahead = turningOn && (ctx.task?.steps ?? [])
            .some((x) => !x.completed && (x.position ?? 0) < (findStep(ctx.task, id)?.position ?? 0));
          await ctx.steps.toggle(id, turningOn);
          if (ahead) {
            saying('Completed out of order — Today still guides from the earliest unfinished step.');
          }
        } else return;
        paintSteps();
      } catch (err) { saying(err.message); paintSteps(); }
    });
    stepsBox.addEventListener('keydown', (e) => {
      const input = e.target.closest('[data-step-name]');
      if (input && e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
    stepsBox.addEventListener('blur', async (e) => {
      const input = e.target.closest?.('[data-step-name]');
      if (!input) return;
      const v = input.value.trim();
      if (!v || v === input.dataset.original) { input.value = input.dataset.original; return; }
      try {
        await ctx.steps.rename(input.closest('[data-step]').dataset.step, v);
        input.dataset.original = v;
      } catch (err) { input.value = input.dataset.original; saying(err.message); }
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

/**
 * "2 steps are still unfinished." — a choice, not a browser confirm().
 *
 * Rendered inside the editor rather than over it, so the task you are deciding
 * about stays visible behind the question. Escape and Go back both mean no;
 * there is no way to answer it by accident.
 */
/** One step of a task, by id. */
const findStep = (task, id) => (task?.steps ?? []).find((s) => s.id === id) ?? null;

function confirmOverride(dlg, count) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'm-confirm';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Complete task with unfinished steps');
    box.innerHTML = `<div class="m-confirm-card">
      <h3>Complete task?</h3>
      <p>${count} step${count === 1 ? ' is' : 's are'} still unfinished.</p>
      <div class="m-confirm-acts">
        <button type="button" class="btn" data-c="no">Go back</button>
        <button type="button" class="btn btn-primary" data-c="yes">
          Complete task and mark all steps complete</button>
      </div>
    </div>`;
    const done = (v) => { box.remove(); document.removeEventListener('keydown', esc, true); resolve(v); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    box.querySelector('[data-c="no"]').onclick = () => done(false);
    box.querySelector('[data-c="yes"]').onclick = () => done(true);
    document.addEventListener('keydown', esc, true);
    dlg.appendChild(box);
    box.querySelector('[data-c="yes"]').focus();
  });
}

export { stepRow };
