/**
 * Steps — the inline checklist inside a Task.
 *
 * ONE component, used by the Today board and by Project detail. Not two
 * implementations that look alike: a task row is the same row in both places,
 * and the moment the two are written separately they start disagreeing about
 * what "2 of 4" means.
 *
 * ── What a Step is, and is not ──────────────────────────────────────────
 *
 * A Step is a small item required to finish ONE Task. It belongs only to its
 * parent. It is never a Today task in its own right, never counts toward
 * Project progress on its own, and never carries a Project, Area, date or
 * schedule. Those all belong to the Task.
 *
 * Which is why Steps are rendered INSIDE the task article, not as siblings:
 * a sibling row is a drop target, and a drop target is a task. The nesting is
 * the guarantee, not a convention.
 *
 * ── Completing every Step does not complete the Task ─────────────────────
 *
 * The last Step turning green means the work is *ready to be finished*, not
 * that it is finished. Auto-completing here would take the decision away at
 * exactly the moment it matters, and would be wrong whenever a task has a step
 * the user never intends to tick. The parent's own checkbox stays the only way
 * to finish it, and `readyToFinish` exists purely to say so.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Counts, from the record. Never stored, never copied onto a row. */
export function stepCounts(task) {
  const steps = task?.steps ?? [];
  return { total: steps.length, done: steps.filter((s) => s.completed).length };
}

/** Every step ticked, and there is at least one. */
export function readyToFinish(task) {
  const { total, done } = stepCounts(task);
  return total > 0 && done === total;
}

/* ── The sequence ────────────────────────────────────────────────────────
 *
 * Steps are ORDERED. `task_steps.position` is a real, incrementing column —
 * assigned `max + 1` on create and used for every read — so the order is
 * stored, not inferred from creation time. Everything below reads it and
 * nothing writes it.
 *
 * Today guides you through the sequence: one step is actionable, the next is
 * a preview, and the rest wait. The full editor is where that guidance can be
 * deliberately overridden — see `task-modal.js`.
 */

/** Steps in their stored order. A copy, so callers cannot sort the record. */
export function orderedSteps(task) {
  return [...(task?.steps ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/**
 * The step to do now: the FIRST incomplete step by stored order.
 *
 * Completed steps after it stay completed — someone ticked them deliberately
 * in the editor, and Today has no business undoing that. It simply carries on
 * guiding from the earliest thing that is still open.
 */
export function currentStep(task) {
  return orderedSteps(task).find((s) => !s.completed) ?? null;
}

/** The preview: the first incomplete step AFTER the current one. */
export function nextStep(task) {
  const list = orderedSteps(task).filter((s) => !s.completed);
  return list[1] ?? null;
}

/** Everything still waiting behind the preview. */
export function laterSteps(task) {
  return orderedSteps(task).filter((s) => !s.completed).slice(2);
}

/**
 * The one completed step Today may safely undo: the one immediately before
 * the current step.
 *
 * "Most recently completed" in a guided sequence means the step you just
 * finished, and undoing it simply makes it current again — the sequence stays
 * possible. Undoing an EARLIER one would leave a gap behind the current step,
 * which is the impossible state §6 forbids Today from producing.
 *
 * With every step complete there is no current step, so the last one is the
 * one you just finished.
 */
export function undoableStep(task) {
  const list = orderedSteps(task);
  const currentAt = list.findIndex((s) => !s.completed);
  const before = currentAt === -1 ? list[list.length - 1] : list[currentAt - 1];
  return before?.completed ? before : null;
}

/**
 * Why the parent's checkbox is unavailable, or null when it is available.
 *
 * A sentence, not a flag: it goes straight into `aria-label` and the title, so
 * the reason is available to a screen reader and on hover without a tooltip
 * being the only way to find out.
 */
export function parentBlockedReason(task) {
  const remaining = orderedSteps(task).filter((s) => !s.completed).length;
  if (!remaining) return null;
  return `Complete the remaining ${remaining} step${remaining === 1 ? '' : 's'} first`;
}

/**
 * The summary chip that lives in the task's meta line.
 *
 * A button, because it expands — the chip already said "2/4 steps" and there
 * was no way to act on it, so the only route to a Step was opening the whole
 * editor. `aria-expanded` carries the state; the caret is decoration.
 */
export function stepsChipHtml(task, expanded) {
  const { total, done } = stepCounts(task);
  if (!total) return '';
  return `<button class="tm-steps ${done === total ? 'is-all' : ''}"
    data-act="steps" aria-expanded="${expanded ? 'true' : 'false'}"
    aria-controls="steps-${task.id}"
    aria-label="${done} of ${total} steps${expanded ? ', collapse' : ', expand'}"
    title="${expanded ? 'Hide steps' : 'Show steps'}">${done}/${total} steps<i
    class="tm-steps-caret" aria-hidden="true"></i></button>`;
}

/**
 * The expanded panel: the steps themselves, plus a way to add one.
 *
 * `hidden` rather than absent when collapsed, so expanding does not have to
 * build DOM and the panel keeps its identity across a step mutation.
 */
export function stepsPanelHtml(task, expanded) {
  return `<div class="t-steps" id="steps-${task.id}" ${expanded ? '' : 'hidden'}>${
    stepsPanelInnerHtml(task)}</div>`;
}

/**
 * The panel's contents, separately, so a repaint can replace them in place.
 *
 * Rendered even when there are no steps yet: it is hidden, it costs nothing,
 * and it is what "Add step" in the task menu reveals. Without it a task with
 * zero steps would have no inline way to gain its first one, and the editor
 * would be the only route — which is the complaint this phase started from.
 */
export function stepsPanelInnerHtml(task) {
  const done = orderedSteps(task).filter((s) => s.completed);
  const current = currentStep(task);
  const next = nextStep(task);
  const later = laterSteps(task);
  const undoable = undoableStep(task);

  return `${done.length ? `<ul class="ts-list ts-done-list" role="list">
      ${done.map((s) => stepRowHtml(s, {
    state: 'done',
    // Only the step you just finished can be undone from here. Undoing an
    // earlier one would leave a gap behind the current step.
    undoable: s.id === undoable?.id,
  })).join('')}
    </ul>` : ''}

    ${current ? `<div class="ts-group ts-group-current">
      <span class="ts-label">Current</span>
      <ul class="ts-list" role="list">${stepRowHtml(current, { state: 'current' })}</ul>
    </div>` : ''}

    ${next ? `<div class="ts-group ts-group-next">
      <span class="ts-label">Next</span>
      <ul class="ts-list" role="list">${stepRowHtml(next, { state: 'next' })}</ul>
    </div>` : ''}

    ${later.length ? `<button type="button" class="ts-more" data-step-later
      aria-label="${later.length} more step${later.length === 1 ? '' : 's'} — open the task to see them all"
      >${later.length} more step${later.length === 1 ? '' : 's'}</button>` : ''}

    <div class="ts-add">
      <input class="ts-new" data-step-new placeholder="Add a step…"
        aria-label="Add a step to ${esc(task.title)}">
      <button class="ts-add-btn" data-step-add type="button">Add</button>
    </div>
    ${readyToFinish(task) ? readyHtml() : ''}`;
}

/**
 * "All steps complete — ready to finish."
 *
 * Restrained on purpose: it is a note, not a celebration and not a prompt. The
 * task is still open, still on the board, and still needs a decision — the
 * only thing that changed is that the parent's checkbox is now available.
 */
const readyHtml = () => '<p class="ts-ready" role="status">All steps complete — ready to finish</p>';

/**
 * One step row, in one of four states.
 *
 *   done     finished; quieter, and tickable back only if it is the last one
 *   current  the thing to do now; the only freely actionable row on Today
 *   next     a preview; readable, not tickable, opens the editor if pressed
 *   plain    the editor's flat list, where every step is equally actionable
 *
 * A locked row is a BUTTON with a real sentence behind it, never a grey box
 * with a padlock. "Not now" has to be legible without decoding an icon, and
 * pressing it has to do something — it opens the full task, where the sequence
 * can be overridden deliberately.
 */
function stepRowHtml(s, { state = 'plain', undoable = false } = {}) {
  const locked = state === 'next';
  const tickable = state === 'current' || state === 'plain' || (state === 'done' && undoable);

  const tick = locked
    ? `<span class="ts-tick is-locked" aria-hidden="true"></span>`
    : `<button class="ts-tick" data-step-toggle type="button" ${tickable ? '' : 'disabled'}
        aria-pressed="${s.completed ? 'true' : 'false'}"
        aria-label="${s.completed
    ? (undoable ? `Undo: ${esc(s.title)}` : `Completed: ${esc(s.title)}`)
    : `Mark done: ${esc(s.title)}`}"
        ${!tickable && s.completed
    ? 'title="Open the task to change an earlier step"' : ''}>
        <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor"
          stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg></button>`;

  // A locked step's NAME is a button too, so a keyboard reaches the override.
  const name = locked
    ? `<button type="button" class="ts-name ts-name-locked" data-step-open
        aria-label="${esc(s.title)} — not yet; open the task to do it out of order"
        >${esc(s.title)}</button>`
    : `<input class="ts-name" value="${esc(s.title)}" data-step-name
        data-original="${esc(s.title)}" aria-label="Step name">`;

  return `<li class="ts-row ts-${state} ${s.completed ? 'is-done' : ''}" data-step="${s.id}">
    ${tick}
    ${name}
    ${state === 'plain' || state === 'current' ? `<button class="ts-del" data-step-del type="button"
      aria-label="Delete step: ${esc(s.title)}">${'×'}</button>` : ''}
  </li>`;
}

/**
 * Repaints one task's step panel in place.
 *
 * The panel node is reused, so expansion survives a step mutation and the
 * caller never has to rebuild the row — let alone the board.
 */
export function repaintSteps(rowEl, task) {
  const panel = rowEl.querySelector('.t-steps');
  if (!panel) return false;
  const expanded = !panel.hidden;
  // Whether the parent's checkbox was blocked BEFORE this repaint. Finishing
  // the last step, or adding one to a ready task, changes it — and the tick
  // lives in the task row, which this function does not own.
  const wasBlocked = !!rowEl.querySelector('.t-tick')?.disabled;
  // The panel NODE is kept and only its contents replaced, so expansion state,
  // scroll position and the listeners bound to it all survive a step change.
  panel.innerHTML = stepsPanelInnerHtml(task);
  panel.hidden = !expanded;

  // The chip lives outside the panel, in the meta line.
  const chip = rowEl.querySelector('[data-act="steps"]');
  const { total, done } = stepCounts(task);
  if (chip && total) {
    chip.firstChild.textContent = `${done}/${total} steps`;
    chip.classList.toggle('is-all', done === total);
    chip.setAttribute('aria-label',
      `${done} of ${total} steps${expanded ? ', collapse' : ', expand'}`);
  }
  rowEl.classList.toggle('is-ready', readyToFinish(task));

  /* Whether the parent tick's availability is now wrong. Same reasoning as the
   * chip below: this function owns the panel, not the row around it. */
  if (wasBlocked !== !!parentBlockedReason(task)) return true;

  /* Whether the chip's PRESENCE is now wrong.
   *
   * The chip lives in the meta line, which this function does not own — adding
   * the very first step, or deleting the last one, changes whether it should
   * exist at all. Rather than reach outside its panel, it reports the mismatch
   * and lets the caller re-render the row it does own. */
  return !!chip !== (total > 0);
}

/**
 * Wires one task row's steps.
 *
 * `ctx` is the same `{add, toggle, rename, remove}` shape the task editor
 * takes, built by `taskStepsCtx` — so a step changed here and a step changed
 * in the editor travel the identical path and land in the identical record.
 *
 * Every handler repaints from the record AFTER the shared context has updated
 * it, so the row never renders a guess of its own.
 */
export function wireSteps(rowEl, task, ctx, { onChanged, onOpenTask } = {}) {
  const after = () => onChanged?.(repaintSteps(rowEl, task));
  const panel = rowEl.querySelector('.t-steps');
  const chip = rowEl.querySelector('[data-act="steps"]');
  if (!panel) return;

  chip?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    chip.title = open ? 'Hide steps' : 'Show steps';
    // Expanding must NOT open the editor. They are different intentions and
    // the chip is the only control that means "show me the steps".
  });

  let adding = false;
  const commit = async () => {
    const input = panel.querySelector('[data-step-new]');
    const v = input?.value.trim();
    if (!v || adding) return;
    adding = true;
    input.value = '';
    try {
      await ctx.add(v);
      after();
      // The field is rebuilt by the repaint, so focus is restored deliberately
      // — adding several steps in a row is the normal case.
      panel.querySelector('[data-step-new]')?.focus();
    } catch (err) {
      const box = panel.querySelector('[data-step-new]');
      if (box) box.value = v;             // hand the text back, never eat it
      fail(rowEl, err.message);
    } finally { adding = false; }
  };

  panel.addEventListener('click', async (e) => {
    if (e.target.closest('[data-step-add]')) { e.stopPropagation(); return commit(); }
    // "N more steps" and a locked step's name both lead to the same place: the
    // full task, which is the override surface. Neither silently does nothing.
    if (e.target.closest('[data-step-later], [data-step-open]')) {
      e.stopPropagation();
      return onOpenTask?.();
    }
    const li = e.target.closest('[data-step]');
    if (!li) return;
    e.stopPropagation();
    const id = li.dataset.step;
    try {
      if (e.target.closest('[data-step-del]')) await ctx.remove(id);
      else if (e.target.closest('[data-step-toggle]')) {
        await ctx.toggle(id, !li.classList.contains('is-done'));
      } else return;
      after();
    } catch (err) {
      /* Repaint FIRST, then report.
       *
       * `after()` replaces the panel's contents, so appending the error before
       * it silently threw the message away: the rollback was correct and
       * completely invisible, which is worse than a visible failure. Measured
       * in a browser — the tick reverted and nothing said why. */
      after();
      fail(rowEl, err.message);
    }
  });

  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.matches('[data-step-new]')) { e.preventDefault(); return commit(); }
    if (e.target.matches('[data-step-name]')) { e.preventDefault(); e.target.blur(); }
  });

  // Leaving the new-step box commits it. Text typed into a visible field is
  // not a draft to be discarded because focus moved.
  panel.addEventListener('blur', async (e) => {
    if (e.target.matches?.('[data-step-new]')) return commit();
    const input = e.target.closest?.('[data-step-name]');
    if (!input) return;
    const v = input.value.trim();
    if (!v || v === input.dataset.original) { input.value = input.dataset.original; return; }
    try {
      await ctx.rename(input.closest('[data-step]').dataset.step, v);
      input.dataset.original = v;
      after();
    } catch (err) {
      input.value = input.dataset.original;
      after();
      fail(rowEl, err.message);
    }
  }, true);

  /* Note: the guard that stops a drag starting inside this panel is in
   * drag.js, not here. Its pointerdown listener is registered on `document`
   * in the CAPTURE phase, so it runs before anything bound to the panel —
   * stopping propagation here would have looked right and done nothing. */
}

/** An error the user can actually see, next to the thing that failed. */
function fail(rowEl, message) {
  const panel = rowEl.querySelector('.t-steps');
  if (!panel) return;
  let box = panel.querySelector('.ts-error');
  if (!box) {
    box = document.createElement('p');
    box.className = 'ts-error';
    box.setAttribute('role', 'alert');
    panel.appendChild(box);
  }
  box.textContent = message;
}

export { stepRowHtml };
