/**
 * Project editor.
 *
 * Four required fields and three optional ones. The required set is not
 * negotiable and each one earns its place:
 *
 *   title    — what you would call it out loud
 *   outcome  — what is true when this is done. THE field that separates a
 *              project from a folder, which is why it is required and why its
 *              placeholder is a sentence rather than a word
 *   area     — where it belongs, and what its tasks inherit
 *   focus    — how loudly it should ask
 *
 * Lifecycle status is deliberately NOT asked. It is decided by whether there is
 * work: a project you create in order to do something is Active; one created as
 * an intention is Planning. Asking would make the user choose between two words
 * whose difference the form cannot explain.
 *
 * Nothing here offers milestones, phases, priority, start dates, people, files,
 * boards, calendar writes or AI. A short form that finishes is worth more than
 * a complete one that is abandoned.
 */
import { reducedMotion, settle } from './motion.js';
import { datePickerPopover } from './pickers.js';

const RISE_IN = [{ opacity: 0, translate: '0 10px', scale: '0.985' },
  { opacity: 1, translate: '0 0', scale: '1' }];
const RISE_OUT = [{ opacity: 1, translate: '0 0', scale: '1' },
  { opacity: 0, translate: '0 6px', scale: '0.99' }];

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),'
  + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FOCUS_OPTIONS = [
  ['now', 'Now — I am working on this'],
  ['upcoming', 'Upcoming — soon, but not yet'],
  ['someday', 'Someday — keep it, quietly'],
];

const parseIso = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const prettyDate = (s) => parseIso(s).toLocaleDateString(undefined,
  { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * A decision that has consequences, asked properly.
 *
 * Not `confirm()`. A browser confirm is not a design decision, it is the
 * absence of one: it cannot show the counts the decision turns on, it cannot
 * offer three options, it cannot be styled, and it cannot say what each choice
 * will do. Completing a project with open work and moving a project between
 * areas are both exactly that kind of decision.
 *
 * @param {object} ctx { title, body, choices: [{id,label,detail,tone}] }
 * @returns {Promise<string|null>} the chosen id, or null if dismissed
 */
export function openChoiceDialog({ title, body = '', choices }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    const dlg = document.createElement('div');
    dlg.className = 'modal modal-choice';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', title);
    dlg.innerHTML = `
      <div class="m-head"><h2 class="ch-title">${esc(title)}</h2></div>
      ${body ? `<div class="m-body ch-body">${esc(body)}</div>` : ''}
      <div class="ch-choices">
        ${choices.map((c) => `<button class="ch-choice ${c.tone ? `is-${c.tone}` : ''}"
          data-choice="${c.id}">
          <span class="ch-choice-l">${esc(c.label)}</span>
          ${c.detail ? `<span class="ch-choice-d">${esc(c.detail)}</span>` : ''}
        </button>`).join('')}
      </div>`;
    document.body.append(scrim, dlg);
    document.body.classList.add('modal-open');
    if (!reducedMotion()) {
      scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
      dlg.animate(RISE_IN, { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('modal-open');
      const remove = () => { scrim.remove(); dlg.remove(); };
      if (reducedMotion()) remove();
      else {
        scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in' });
        settle(dlg.animate(RISE_OUT, { duration: 160, easing: 'cubic-bezier(.4,0,.9,.4)' }), 160, remove);
      }
      if (opener?.isConnected) opener.focus();
      resolve(value);
    };

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); return finish(null); }
      if (e.key !== 'Tab') return;
      const items = [...dlg.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const [first, last] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    scrim.onclick = () => finish(null);
    dlg.querySelectorAll('[data-choice]').forEach((b) => {
      b.onclick = () => finish(b.dataset.choice);
    });
    dlg.querySelector('.ch-choice')?.focus();
  });
}

/**
 * @param {object} ctx { project, areas, onSave, onDelete }
 */
export function openProjectModal(ctx) {
  const { project: p = null, areas = [] } = ctx;
  const editing = !!p;
  const opener = document.activeElement;
  document.querySelector('.modal-scrim')?.remove();

  const f = {
    title: p?.title ?? '',
    outcome: p?.outcome ?? '',
    // Default focus is Upcoming, never Now. A project should have to be
    // claimed as current rather than arriving that way.
    focus: p?.focus ?? 'upcoming',
    areaId: p?.areaId ?? areas[0]?.id ?? '',
    description: p?.description ?? '',
    targetDate: p?.targetDate ?? '',
    firstTask: '',
  };

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  const dlg = document.createElement('div');
  dlg.className = 'modal modal-project';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', editing ? 'Edit project' : 'New project');

  dlg.innerHTML = `
    <div class="m-head">
      <textarea id="pm-title" class="m-title" rows="1" placeholder="What is the project?"
        aria-label="Project name">${esc(f.title)}</textarea>
      <button class="m-close" id="pm-close" aria-label="Close">&times;</button>
    </div>

    <div class="m-body ev-body">
      <div class="ev-row ev-row-top">
        <span class="ev-lab">Outcome</span>
        <textarea id="pm-outcome" class="ev-ctl ev-input ev-textarea pm-outcome" rows="2"
          placeholder="What is true when this is done?">${esc(f.outcome)}</textarea>
      </div>

      <div class="ev-row">
        <span class="ev-lab">Area</span>
        <div class="ev-ctl ev-select">
          <select id="pm-area">
            ${areas.map((a) => `<option value="${a.id}"
              ${a.id === f.areaId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
          </select><i class="ev-chev"></i></div>
      </div>

      <div class="ev-row">
        <span class="ev-lab">Focus</span>
        <div class="ev-ctl ev-select">
          <select id="pm-focus">
            ${FOCUS_OPTIONS.map(([v, l]) => `<option value="${v}"
              ${v === f.focus ? 'selected' : ''}>${l}</option>`).join('')}
          </select><i class="ev-chev"></i></div>
      </div>

      <button type="button" class="ev-more" id="pm-more" aria-expanded="false">
        <i class="ev-chev"></i> More options</button>

      <div class="ev-adv" id="pm-adv" hidden>
        <div class="ev-row">
          <span class="ev-lab">Target</span>
          <button type="button" class="ev-ctl" id="pm-target" data-picker="date"
            data-target="targetDate">${f.targetDate ? esc(prettyDate(f.targetDate)) : 'No target date'}</button>
        </div>
        <div class="ev-row ev-row-top">
          <span class="ev-lab">Context</span>
          <textarea id="pm-desc" class="ev-ctl ev-input ev-textarea"
            placeholder="What would you need to read after three weeks away?">${esc(f.description)}</textarea>
        </div>
        ${editing ? '' : `<div class="ev-row">
          <span class="ev-lab">First task</span>
          <input id="pm-first" class="ev-ctl ev-input" placeholder="Optional — makes it active">
        </div>`}
      </div>
    </div>

    <div class="m-foot">
      ${editing ? '<button class="btn btn-ghost m-danger" id="pm-del">Delete</button>' : ''}
      <span class="m-save-state" id="pm-state" role="status"></span>
      <button class="btn" id="pm-cancel">Cancel</button>
      <button class="btn btn-primary" id="pm-save">${editing ? 'Save' : 'Create project'}</button>
    </div>

    <div class="ev-pop" id="pm-pop" hidden></div>`;

  document.body.append(scrim, dlg);
  document.body.classList.add('modal-open');
  if (!reducedMotion()) {
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    dlg.animate(RISE_IN, { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  const $ = (sel) => dlg.querySelector(sel);
  const title = $('#pm-title');
  const grow = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
  title.addEventListener('input', grow); grow();
  title.focus();
  title.setSelectionRange(title.value.length, title.value.length);

  const read = () => ({
    title: title.value.trim(),
    outcome: $('#pm-outcome').value.trim(),
    areaId: $('#pm-area').value,
    focus: $('#pm-focus').value,
    description: $('#pm-desc').value,
    targetDate: f.targetDate,
    firstTask: $('#pm-first')?.value.trim() ?? '',
  });
  const initial = JSON.stringify(read());
  const isDirty = () => JSON.stringify(read()) !== initial;

  $('#pm-more').onclick = () => {
    const adv = $('#pm-adv');
    const open = adv.hidden;
    adv.hidden = !open;
    $('#pm-more').setAttribute('aria-expanded', String(open));
    $('#pm-more').classList.toggle('is-open', open);
    if (open && !reducedMotion()) {
      adv.animate([{ opacity: 0, translate: '0 -6px' }, { opacity: 1, translate: '0 0' }],
        { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  };

  const pop = $('#pm-pop');
  let popFor = null;
  const closePop = () => { pop.hidden = true; pop.innerHTML = ''; popFor = null; };
  $('#pm-target').onclick = (e) => {
    e.stopPropagation();
    if (popFor === 'targetDate') return closePop();
    popFor = 'targetDate';
    datePickerPopover(pop, dlg, $('#pm-target'), f.targetDate || undefined, (v) => {
      f.targetDate = v; $('#pm-target').textContent = prettyDate(v); closePop();
    });
  };
  dlg.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-picker]')) closePop();
  });

  let closed = false;
  function close(force = false) {
    if (closed) return;
    // The user's typing is never thrown away without being asked.
    if (!force && isDirty()
      && !confirm('You have unsaved changes. Close without saving?')) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('modal-open');
    const done = () => { scrim.remove(); dlg.remove(); };
    if (reducedMotion()) done();
    else {
      scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in' });
      settle(dlg.animate(RISE_OUT, { duration: 160, easing: 'cubic-bezier(.4,0,.9,.4)' }), 160, done);
    }
    if (opener?.isConnected) opener.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (!pop.hidden) return closePop();
      return close();
    }
    if (e.key !== 'Tab') return;
    const items = [...dlg.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const [first, last] = [items[0], items[items.length - 1]];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKey, true);
  scrim.onclick = () => close();
  $('#pm-close').onclick = () => close();
  $('#pm-cancel').onclick = () => close();

  const state = $('#pm-state');
  let saving = false;
  $('#pm-save').onclick = async () => {
    // One authoritative mutation per interaction. A double click must not
    // create two projects.
    if (saving) return;
    const v = read();
    if (!v.title) { title.focus(); state.textContent = 'What is the project called?'; return; }
    if (!v.outcome) {
      $('#pm-outcome').focus();
      state.textContent = 'What is true when this is done?';
      $('#pm-more').click();
      return;
    }
    if (!v.areaId) { state.textContent = 'Choose an area.'; return; }

    saving = true;
    const btn = $('#pm-save');
    btn.classList.add('is-busy');
    btn.disabled = true;
    state.textContent = 'Saving…';
    try {
      await ctx.onSave({
        title: v.title,
        outcome: v.outcome,
        areaId: v.areaId,
        focus: v.focus,
        description: v.description || null,
        targetDate: v.targetDate || null,
        ...(editing || !v.firstTask ? {} : { firstTask: { title: v.firstTask } }),
      });
      // Closes only after the save actually succeeded. A modal that closes
      // optimistically and then fails has nowhere to put the error and nothing
      // to put the user's text back into.
      close(true);
    } catch (e) {
      saving = false;
      btn.classList.remove('is-busy');
      btn.disabled = false;
      state.textContent = e.message;
    }
  };

  $('#pm-del')?.addEventListener('click', async () => {
    state.textContent = 'Deleting…';
    try { await ctx.onDelete(); close(true); }
    catch (e) { state.textContent = e.message; }
  });

  return { close };
}
