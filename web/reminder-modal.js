/**
 * Reminder editor.
 *
 * This exists because reminder creation was a `window.prompt`. A browser prompt
 * is not a design decision, it is the absence of one: unstyled, unbranded,
 * single-field, no validation, no keyboard affordances beyond OK/Cancel, and
 * impossible to make accessible.
 *
 * A reminder is NOT a Google event and must never become one. It asks for
 * attention on or before a date; it does not occupy time, has no attendees and
 * has no duration. Keeping the two models apart is why `reminders` is its own
 * table rather than a zero-length event.
 *
 * Fast path first: title and date are the whole form. Recurrence, notification
 * timing, area and notes live behind "More options".
 */
import { reducedMotion, settle } from './motion.js';
import { datePickerPopover, timePickerPopover } from './pickers.js';

const RISE_IN = [{ opacity: 0, translate: '0 10px', scale: '0.985' },
  { opacity: 1, translate: '0 0', scale: '1' }];
const RISE_OUT = [{ opacity: 1, translate: '0 0', scale: '1' },
  { opacity: 0, translate: '0 6px', scale: '0.99' }];

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),'
  + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const REPEAT = [
  ['', 'Does not repeat'],
  ['daily', 'Every day'],
  ['weekly', 'Every week'],
  ['monthly', 'Every month'],
  ['yearly', 'Every year'],
];

/** Lead time is "remind me N days before", which is what a reminder is for. */
const LEAD = [
  [0, 'On the day'],
  [1, '1 day before'],
  [3, '3 days before'],
  [7, '1 week before'],
  [14, '2 weeks before'],
];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  + `-${String(d.getDate()).padStart(2, '0')}`;
const parseIso = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const prettyDate = (s) => parseIso(s).toLocaleDateString(undefined,
  { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/**
 * @param {object} ctx { reminder, areas, defaultDay, onSave, onDelete }
 */
export function openReminderModal(ctx) {
  const { reminder: r = null, areas = [], defaultDay = null } = ctx;
  const opener = document.activeElement;
  document.querySelector('.modal-scrim')?.remove();

  const f = {
    title: r?.title ?? '',
    dueDate: r?.dueDate ?? defaultDay ?? iso(new Date()),
    dueTime: r?.dueTime ?? '',
    repeat: r?.recurrence ?? '',
    leadDays: r?.leadDays ?? 0,
    areaId: r?.areaId ?? '',
    notes: r?.notes ?? '',
  };

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  const dlg = document.createElement('div');
  dlg.className = 'modal modal-reminder';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', r ? 'Edit reminder' : 'New reminder');

  dlg.innerHTML = `
    <div class="m-head">
      <span class="rm-mark" aria-hidden="true"></span>
      <textarea id="rm-title" class="m-title" rows="1" placeholder="Remind me to…"
        aria-label="Reminder">${esc(f.title)}</textarea>
      <button class="m-close" id="rm-close" aria-label="Close">&times;</button>
    </div>

    <div class="m-body ev-body">
      <div class="ev-row">
        <span class="ev-lab">When</span>
        <button type="button" class="ev-ctl" id="rm-date" data-picker="date"
          data-target="dueDate">${esc(prettyDate(f.dueDate))}</button>
        <button type="button" class="ev-ctl ev-time" id="rm-time" data-picker="time"
          data-target="dueTime">${f.dueTime ? esc(f.dueTime) : 'Any time'}</button>
      </div>

      <button type="button" class="ev-more" id="rm-more" aria-expanded="false">
        <i class="ev-chev"></i> More options</button>

      <div class="ev-adv" id="rm-adv" hidden>
        <div class="ev-row">
          <span class="ev-lab">Repeat</span>
          <div class="ev-ctl ev-select">
            <select id="rm-repeat">
              ${REPEAT.map(([v, l]) => `<option value="${v}"
                ${v === f.repeat ? 'selected' : ''}>${l}</option>`).join('')}
            </select><i class="ev-chev"></i></div>
        </div>
        <div class="ev-row">
          <span class="ev-lab">Notify</span>
          <div class="ev-ctl ev-select">
            <select id="rm-lead">
              ${LEAD.map(([v, l]) => `<option value="${v}"
                ${v === f.leadDays ? 'selected' : ''}>${l}</option>`).join('')}
            </select><i class="ev-chev"></i></div>
        </div>
        <div class="ev-row">
          <span class="ev-lab">Area</span>
          <div class="ev-ctl ev-select">
            <select id="rm-area"><option value="">No area</option>
              ${areas.map((a) => `<option value="${a.id}"
                ${a.id === f.areaId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
            </select><i class="ev-chev"></i></div>
        </div>
        <div class="ev-row ev-row-top">
          <span class="ev-lab">Notes</span>
          <textarea id="rm-notes" class="ev-ctl ev-input ev-textarea"
            placeholder="Anything worth remembering">${esc(f.notes)}</textarea>
        </div>
      </div>
    </div>

    <div class="m-foot">
      ${r ? '<button class="btn btn-ghost m-danger" id="rm-del">Delete</button>' : ''}
      <span class="m-save-state" id="rm-state" role="status"></span>
      <button class="btn" id="rm-cancel">Cancel</button>
      <button class="btn btn-primary" id="rm-save">${r ? 'Save' : 'Add reminder'}</button>
    </div>

    <div class="ev-pop" id="rm-pop" hidden></div>`;

  document.body.append(scrim, dlg);
  document.body.classList.add('modal-open');
  if (!reducedMotion()) {
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    dlg.animate(RISE_IN, { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  const $ = (sel) => dlg.querySelector(sel);
  const title = $('#rm-title');
  const grow = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
  title.addEventListener('input', grow); grow();
  title.focus();
  title.setSelectionRange(title.value.length, title.value.length);

  const read = () => ({
    title: title.value.trim(), dueDate: f.dueDate, dueTime: f.dueTime,
    repeat: $('#rm-repeat').value, leadDays: Number($('#rm-lead').value),
    areaId: $('#rm-area').value, notes: $('#rm-notes').value,
  });
  const initial = JSON.stringify(read());
  const isDirty = () => JSON.stringify(read()) !== initial;

  $('#rm-more').onclick = () => {
    const adv = $('#rm-adv');
    const open = adv.hidden;
    adv.hidden = !open;
    $('#rm-more').setAttribute('aria-expanded', String(open));
    $('#rm-more').classList.toggle('is-open', open);
    if (open && !reducedMotion()) {
      adv.animate([{ opacity: 0, translate: '0 -6px' }, { opacity: 1, translate: '0 0' }],
        { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  };

  /* Shared pickers — the same custom controls the event editor uses, so the
     two modals cannot drift apart visually. */
  const pop = $('#rm-pop');
  let popFor = null;
  const closePop = () => { pop.hidden = true; pop.innerHTML = ''; popFor = null; };

  dlg.querySelectorAll('[data-picker]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const target = btn.dataset.target;
      if (popFor === target) return closePop();
      popFor = target;
      if (btn.dataset.picker === 'date') {
        datePickerPopover(pop, dlg, btn, f[target], (v) => {
          f[target] = v; btn.textContent = prettyDate(v); closePop();
        });
      } else {
        timePickerPopover(pop, dlg, btn, f[target], (v) => {
          f[target] = v; btn.textContent = v || 'Any time'; closePop();
        }, { allowClear: true, clearLabel: 'Any time' });
      }
    };
  });
  dlg.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-picker]')) closePop();
  });

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
  $('#rm-close').onclick = () => close();
  $('#rm-cancel').onclick = () => close();

  const state = $('#rm-state');
  $('#rm-save').onclick = async () => {
    const v = read();
    if (!v.title) { title.focus(); state.textContent = 'What should you be reminded about?'; return; }
    const btn = $('#rm-save');
    btn.classList.add('is-busy');
    state.textContent = 'Saving…';
    try {
      await ctx.onSave({
        title: v.title,
        dueDate: v.dueDate,
        dueTime: v.dueTime || null,
        leadDays: v.leadDays,
        areaId: v.areaId || null,
        notes: v.notes || null,
        recurrence: v.repeat || null,
      });
      close(true);
    } catch (e) {
      btn.classList.remove('is-busy');
      state.textContent = e.message;
    }
  };

  $('#rm-del')?.addEventListener('click', async () => {
    state.textContent = 'Deleting…';
    try { await ctx.onDelete(); close(true); }
    catch (e) { state.textContent = e.message; }
  });

  return { close };
}
