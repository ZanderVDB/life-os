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
import {
  row, section, moreOptions, wireMoreOptions, dateField, timeField, wireDateTime,
  selectField, wireMenus, fieldError,
} from './calendar-fields.js';

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
    repeat: ({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly',
      YEARLY: 'yearly' })[r?.recurrence?.frequency] ?? '',
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
      <h2 class="m-title">${r ? 'Edit reminder' : 'New reminder'}</h2>
      <button class="m-close" id="rm-close" aria-label="Close">&times;</button>
    </div>

    <div class="m-body cf-body">
      <!-- The name goes where Event and Birthday put theirs: the first field
           in the body, not the dialog's heading. The heading says which of the
           four things you are making; the field is what you are making. -->
      <div class="cf-title">
        <textarea id="rm-title" rows="1" placeholder="Remind me to…"
          aria-label="Reminder">${esc(f.title)}</textarea>
      </div>

      ${section(`
        ${row('When', `${dateField('rm-date', f.dueDate, { label: 'Date' })}
          ${timeField('rm-time', f.dueTime, { label: 'Time', allowClear: true })}`)}
        <p class="cf-note">A Life OS reminder — it stays here and never becomes
          a Google event.</p>`)}

      ${moreOptions(`
        ${row('Repeat', selectField('rm-repeat',
    REPEAT.map(([v, l]) => ({ id: v, label: l })), f.repeat, 'Repeat'))}
        ${row('Notify', selectField('rm-lead',
    LEAD.map(([v, l]) => ({ id: String(v), label: l })), String(f.leadDays), 'Notify'))}
        ${row('Area', selectField('rm-area',
    [{ id: '', label: 'No area' }, ...areas.map((a) => ({ id: a.id, label: a.name }))],
    f.areaId ?? '', 'Area'))}
        ${row('Notes', `<textarea id="rm-notes" class="cf-ctl cf-input cf-textarea"
          placeholder="Anything worth remembering">${esc(f.notes)}</textarea>`, { top: true })}`)}

      <!-- A reminder is the one Calendar object that is entirely ours, which
           makes it the safest thing in the app to attach context to. Outside
           "More options" on purpose: what a reminder is FOR is not an advanced
           setting, and burying it is how the event editor's links went unread
           for a whole phase. Only on an existing reminder — there is nothing
           to link to a record that has not been saved yet. -->
      ${r ? `<div class="rel-host" data-rel-host="reminder:${esc(r.id)}"></div>` : ''}
    </div>

    <div class="m-foot">
      ${r ? '<button class="btn btn-ghost m-danger" id="rm-del">Delete</button>' : ''}
      <span class="m-save-state" id="rm-state" role="status"></span>
      <button class="btn" id="rm-cancel">Cancel</button>
      <button class="btn btn-primary" id="rm-save">${r ? 'Save' : 'Add reminder'}</button>
    </div>

`;   // The popover host is created by wireDateTime, once per dialog.

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
    title: title.value.trim(),
    dueDate: dlg.querySelector('#rm-date')?.dataset.value || f.dueDate,
    dueTime: dlg.querySelector('#rm-time')?.dataset.value || '',
    repeat: $('#rm-repeat').dataset.value,
    leadDays: Number($('#rm-lead').dataset.value),
    areaId: $('#rm-area').dataset.value, notes: $('#rm-notes').value,
  });
  const initial = JSON.stringify(read());
  const isDirty = () => JSON.stringify(read()) !== initial;

  /* Shared controls. The Reminder does not implement a date field, a time
   * field or a disclosure — it composes them, so an improvement to any of the
   * three arrives here for free. */
  wireMoreOptions(dlg);
  // Repeat, Notify and Area are the shared dark dropdown, not OS menus.
  wireMenus(dlg, dlg);
  const dt = wireDateTime(dlg, dlg, (kind, value) => {
    if (kind === 'date') f.dueDate = value; else f.dueTime = value;
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
    /* Beside the field, not in the footer. A message at the bottom of the
     * dialog makes the reader hunt for which control it is about. */
    if (!v.title) { fieldError(title, 'What should you be reminded about?'); return; }
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
        // The API stores a structured rule, not a word, so it can work out the
        // next occurrence without re-parsing a string every time.
        recurrence: v.repeat ? {
          frequency: { daily: 'DAILY', weekly: 'WEEKLY',
            monthly: 'MONTHLY', yearly: 'YEARLY' }[v.repeat],
          interval: 1,
          ...(v.repeat === 'weekly' ? { byWeekday: [parseIso(v.dueDate).getDay()] } : {}),
          ...(v.repeat === 'monthly' ? { byMonthDay: [parseIso(v.dueDate).getDate()] } : {}),
        } : null,
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
