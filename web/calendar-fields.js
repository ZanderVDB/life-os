/**
 * The shared vocabulary every Calendar creation flow speaks.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * Event, Reminder, Schedule Task and Birthday had each grown their own date
 * field, their own time control, their own More Options disclosure and their
 * own idea of how a row is spaced. They did not look like four views of one
 * product; they looked like four products. Worse, improving one of them
 * improved exactly one of them.
 *
 * Everything here is markup plus a wiring function. A flow composes the
 * controls it needs and gets the same behaviour, the same keyboard handling
 * and the same look — and when one is improved, all four inherit it.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────
 *
 * Anything that would make the flows identical. A Reminder is not an Event
 * with fewer fields: it has no duration, no guests and no calendar, and this
 * module makes it easy to build a small form, not compulsory to build a big
 * one.
 */
import {
  datePickerPopover, timePickerPopover, anchor, formatTime, parseTime, isoDate, parseIsoDate,
} from './pickers.js';

export { formatTime, parseTime, isoDate, parseIsoDate };

/* The dropdown is not a Calendar control — it is THE Life OS dropdown, and it
 * lives in menu.js so Settings and everything after it use the same one. */
import { popoverHost, closePopover, selectField, wireMenus } from './menu.js';

export { popoverHost, closePopover, selectField, wireMenus };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pad = (n) => String(n).padStart(2, '0');

/** One way a date is written, everywhere. */
export function formatDate(v) {
  if (!v) return 'Pick a date';
  const d = parseIsoDate(v);
  const today = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (same(d, today)) return 'Today';
  if (same(d, tomorrow)) return 'Tomorrow';
  return d.toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/* ══ Rows and sections ═══════════════════════════════════════════════════ */

/** A labelled row. The label column is fixed so every modal lines up. */
export const row = (label, control, opts = {}) => `<div class="cf-row${
  opts.top ? ' cf-row-top' : ''}${opts.full ? ' cf-row-full' : ''}">
  ${label ? `<span class="cf-lab">${esc(label)}</span>` : ''}
  <div class="cf-ctl-wrap">${control}</div>
</div>`;

/** A group of rows that answer one question together. */
export const section = (inner, opts = {}) => `<section class="cf-group${
  opts.quiet ? ' is-quiet' : ''}">${inner}</section>`;

/**
 * The disclosure, identical in every modal.
 *
 * It used to be a differently-sized, differently-placed control in each one —
 * above the label here, cramped into a control there. One implementation, one
 * position: full width, chevron hard right.
 */
export const moreOptions = (inner, opts = {}) => `<div class="cf-more">
  <button type="button" class="cf-more-btn" data-cf-more aria-expanded="false">
    <span>${esc(opts.label ?? 'More options')}</span>
    <i class="cf-chev" aria-hidden="true"></i>
  </button>
  <div class="cf-more-body" data-cf-more-body hidden>${inner}</div>
</div>`;

export function wireMoreOptions(root) {
  const btn = root.querySelector('[data-cf-more]');
  const body = root.querySelector('[data-cf-more-body]');
  if (!btn || !body) return;
  btn.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('is-open', open);
  });
}

/* ══ Validation ══════════════════════════════════════════════════════════ */

/**
 * Says what is wrong, where it is wrong.
 *
 * Blocking the action and moving focus is a hint, not an explanation: pressing
 * Continue and watching nothing happen reads as a broken button, not as "this
 * field is required". The message goes next to the field, and clears the
 * moment the person starts fixing it rather than staying to nag.
 */
export function fieldError(el, message) {
  if (!el) return;
  const holder = el.closest('.cf-row, .cf-title, .cf-group') ?? el.parentElement;
  clearFieldError(holder);
  el.setAttribute('aria-invalid', 'true');
  el.classList.add('is-invalid');
  const note = document.createElement('p');
  note.className = 'cf-err';
  note.dataset.cfErr = '';
  note.setAttribute('role', 'alert');
  note.textContent = message;
  (el.closest('.cf-ctl-wrap') ?? holder).appendChild(note);
  el.focus?.();

  const clear = () => {
    el.removeAttribute('aria-invalid');
    el.classList.remove('is-invalid');
    note.remove();
    el.removeEventListener('input', clear);
    el.removeEventListener('change', clear);
  };
  el.addEventListener('input', clear);
  el.addEventListener('change', clear);
}

export function clearFieldError(root) {
  root?.querySelectorAll?.('[data-cf-err]').forEach((n) => n.remove());
  root?.querySelectorAll?.('.is-invalid').forEach((n) => {
    n.classList.remove('is-invalid');
    n.removeAttribute('aria-invalid');
  });
}

/* ══ Date and time ═══════════════════════════════════════════════════════ */

export const dateField = (id, value, opts = {}) => `<button type="button"
  class="cf-ctl cf-date" id="${id}" data-cf-date data-value="${esc(value ?? '')}"
  aria-label="${esc(opts.label ?? 'Date')}">
  <i class="cf-ico cf-ico-date" aria-hidden="true"></i>
  <span data-cf-text>${esc(formatDate(value))}</span>
</button>`;

export const timeField = (id, value, opts = {}) => `<button type="button"
  class="cf-ctl cf-time" id="${id}" data-cf-time data-value="${esc(value ?? '')}"
  data-clear="${opts.allowClear ? '1' : ''}"
  data-clear-label="${esc(opts.clearLabel ?? 'Any time')}"
  aria-label="${esc(opts.label ?? 'Time')}">
  <i class="cf-ico cf-ico-time" aria-hidden="true"></i>
  <span data-cf-text>${value ? esc(formatTime(value)) : esc(opts.clearLabel ?? 'Any time')}</span>
</button>`;

/**
 * Wires every date and time control inside `root`.
 *
 * One popover host per dialog, so two open pickers can never fight over the
 * same corner. `onChange` is called with (kind, value) after any pick.
 */


export function wireDateTime(root, dlg, onChange) {
  const pop = popoverHost(dlg);
  const close = () => closePopover(dlg);

  const set = (btn, value, kind, keepOpen) => {
    btn.dataset.value = value ?? '';
    const text = btn.querySelector('[data-cf-text]');
    if (kind === 'date') text.textContent = formatDate(value);
    else text.textContent = value ? formatTime(value) : (btn.dataset.clearLabel || 'Any time');
    if (!keepOpen) close();
    onChange?.(kind, value, btn);
  };

  root.querySelectorAll('[data-cf-date],[data-cf-time]').forEach((btn) => {
    if (btn.dataset.cfWired) return;
    btn.dataset.cfWired = '1';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pop.__owner === btn) return close();
      close();
      pop.__owner = btn;
      if (btn.hasAttribute('data-cf-date')) {
        datePickerPopover(pop, dlg, btn, btn.dataset.value, (v) => set(btn, v, 'date'));
      } else {
        timePickerPopover(pop, dlg, btn, btn.dataset.value, (v) => set(btn, v, 'time'), {
          allowClear: btn.dataset.clear === '1',
          clearLabel: btn.dataset.clearLabel,
          /* Choosing an hour has to mean something on its own. Only `Done`
           * used to commit, so picking 9, then 30, then clicking away threw
           * both away — while the date picker beside it committed on click.
           * Now every click writes through; `Done` only closes. */
          onLive: (v) => set(btn, v, 'time', true),
        });
      }
    });
  });

  dlg.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target)
      && !e.target.closest('[data-cf-date],[data-cf-time]')) close();
  });
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { e.stopPropagation(); close(); } });

  return {
    close,
    valueOf: (id) => root.querySelector(`#${id}`)?.dataset.value ?? '',
    setValue: (id, v) => {
      const btn = root.querySelector(`#${id}`);
      if (btn) set(btn, v, btn.hasAttribute('data-cf-date') ? 'date' : 'time');
    },
  };
}

/* ══ Duration ════════════════════════════════════════════════════════════ */

export const DURATIONS = [
  { m: 15, label: '15 min' },
  { m: 30, label: '30 min' },
  { m: 45, label: '45 min' },
  { m: 60, label: '1 hr' },
  { m: 90, label: '1 hr 30' },
  { m: 120, label: '2 hr' },
  { m: 180, label: '3 hr' },
];

export const durationField = (minutes) => `<div class="cf-durs" data-cf-durs
  role="group" aria-label="Duration">
  ${DURATIONS.map((d) => `<button type="button" class="cf-pill${d.m === minutes ? ' is-on' : ''}"
    data-cf-dur="${d.m}" aria-pressed="${d.m === minutes}">${esc(d.label)}</button>`).join('')}
  <button type="button" class="cf-pill cf-pill-more" data-cf-dur-custom>Custom…</button>
</div>
<p class="cf-ends" data-cf-ends></p>`;

/** Adds minutes to a wall-clock time, wrapping past midnight. */
export function addMinutes(day, time, mins) {
  const [h, m] = String(time || '09:00').split(':').map(Number);
  const d = parseIsoDate(day);
  d.setHours(h || 0, (m || 0) + mins, 0, 0);
  return { day: isoDate(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

/**
 * Wires duration. `read()` supplies the current day and start so the end time
 * can be stated — "For 1 hr" means nothing without "15:30 → 16:30" beside it.
 */
export function wireDuration(root, read, initial = 60) {
  const state = { minutes: initial };
  const ends = root.querySelector('[data-cf-ends]');

  const show = () => {
    if (!ends) return;
    const { day, time, allDay } = read();
    if (allDay || !time) { ends.textContent = ''; return; }
    const e = addMinutes(day, time, state.minutes);
    ends.textContent = `${formatTime(time)} → ${formatTime(e.time)}${
      e.day !== day ? ' next day' : ''}`;
  };

  const select = (mins, custom = false) => {
    state.minutes = mins;
    root.querySelectorAll('[data-cf-dur]').forEach((b) => {
      const on = !custom && Number(b.dataset.cfDur) === mins;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const btn = root.querySelector('[data-cf-dur-custom]');
    if (btn) {
      btn.classList.toggle('is-on', custom);
      btn.textContent = custom ? `${mins} min` : 'Custom…';
    }
    show();
  };

  root.querySelectorAll('[data-cf-dur]').forEach((b) => {
    b.addEventListener('click', () => select(Number(b.dataset.cfDur)));
  });
  root.querySelector('[data-cf-dur-custom]')?.addEventListener('click', (e) => {
    /* An inline number, not a prompt: this app does not use native dialogs,
     * and a preset list that cannot be escaped is a preset list that forces
     * people to lie about how long something takes. */
    const btn = e.currentTarget;
    const wrap = btn.parentElement;
    if (wrap.querySelector('[data-cf-dur-in]')) return;
    const input = document.createElement('input');
    input.className = 'cf-dur-in';
    input.dataset.cfDurIn = '';
    input.type = 'number';
    input.min = '5';
    input.max = '1440';
    input.step = '5';
    input.value = String(state.minutes);
    input.setAttribute('aria-label', 'Minutes');
    wrap.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
      const n = Math.max(5, Math.min(1440, Number(input.value) || state.minutes));
      input.remove();
      select(n, !DURATIONS.some((d) => d.m === n));
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') { ev.stopPropagation(); input.remove(); }
    });
    input.addEventListener('blur', commit);
  });

  select(initial, !DURATIONS.some((d) => d.m === initial));
  return { get minutes() { return state.minutes; }, refresh: show };
}

/* ══ Google reminders ════════════════════════════════════════════════════ */

/**
 * Google allows several reminder overrides per event, in minutes before it.
 *
 * The presets are phrased the way people say them; the minutes are an
 * implementation detail that only appears if somebody asks for Custom. All-day
 * events get day-based options, because "30 minutes before" an all-day event
 * is not a thing anyone means.
 */
export const REMINDER_PRESETS = [
  { m: 0, label: 'At the time' },
  { m: 5, label: '5 minutes before' },
  { m: 10, label: '10 minutes before' },
  { m: 15, label: '15 minutes before' },
  { m: 30, label: '30 minutes before' },
  { m: 60, label: '1 hour before' },
  { m: 120, label: '2 hours before' },
  { m: 1440, label: '1 day before' },
  { m: 2880, label: '2 days before' },
  { m: 10080, label: '1 week before' },
];

export const ALL_DAY_PRESETS = [
  { m: 0, label: 'On the day' },
  { m: 540, label: 'On the day, 9am' },
  { m: 1440, label: '1 day before' },
  { m: 2880, label: '2 days before' },
  { m: 10080, label: '1 week before' },
];

/** Google's own ceiling: 5 overrides, and at most 4 weeks before. */
export const MAX_REMINDERS = 5;
export const MAX_REMINDER_MINUTES = 40320;

export const reminderWord = (m) => REMINDER_PRESETS.concat(ALL_DAY_PRESETS)
  .find((p) => p.m === m)?.label
  ?? (m % 1440 === 0 ? `${m / 1440} day${m / 1440 === 1 ? '' : 's'} before`
    : m % 60 === 0 ? `${m / 60} hour${m / 60 === 1 ? '' : 's'} before`
      : `${m} minutes before`);

export const remindersField = (values, opts = {}) => `<div class="cf-rems" data-cf-rems
  data-all-day="${opts.allDay ? '1' : ''}">
  <div class="cf-rem-list" data-cf-rem-list>${(values ?? []).map(remChip).join('')}</div>
  <button type="button" class="cf-pill cf-pill-add" data-cf-rem-add>+ Add reminder</button>
  <p class="cf-rem-note" data-cf-rem-note hidden></p>
</div>`;

const remChip = (m) => `<span class="cf-rem" data-cf-rem="${m}">
  ${esc(reminderWord(m))}
  <button type="button" class="cf-rem-x" data-cf-rem-del aria-label="Remove this reminder">×</button>
</span>`;

export function wireReminders(root, opts = {}) {
  const host = root.querySelector('[data-cf-rems]');
  if (!host) return { get values() { return []; } };
  const list = host.querySelector('[data-cf-rem-list]');
  const note = host.querySelector('[data-cf-rem-note]');
  const addBtn = host.querySelector('[data-cf-rem-add]');

  const values = () => [...list.querySelectorAll('[data-cf-rem]')]
    .map((el) => Number(el.dataset.cfRem));

  const say = (msg) => {
    if (!note) return;
    note.textContent = msg ?? '';
    note.hidden = !msg;
  };

  const add = (m) => {
    const have = values();
    /* Google rejects both of these, so the UI must not offer them — refusing
     * at confirmation time would be a wasted trip and an opaque error. */
    if (have.length >= MAX_REMINDERS) {
      say(`Google allows ${MAX_REMINDERS} reminders on one event.`);
      return;
    }
    if (have.includes(m)) { say('That reminder is already set.'); return; }
    if (m > MAX_REMINDER_MINUTES) { say('Google cannot remind you more than 4 weeks ahead.'); return; }
    say('');
    list.insertAdjacentHTML('beforeend', remChip(m));
    addBtn.hidden = values().length >= MAX_REMINDERS;
  };

  list.addEventListener('click', (e) => {
    const x = e.target.closest('[data-cf-rem-del]');
    if (!x) return;
    x.closest('[data-cf-rem]').remove();
    addBtn.hidden = false;
    say('');
  });

  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    /* Into the SHARED popover host, not into the field.
     *
     * Absolutely positioned inside `.cf-rems`, this menu was a child of the
     * modal's scrolling body — so `overflow: auto` cut it off partway down,
     * and the later presets simply could not be reached. Anything that floats
     * has to escape the box it floats out of. */
    const dlg = host.closest('.modal') ?? document.body;
    const pop = popoverHost(dlg);
    if (pop.__owner === addBtn) { closePopover(dlg); return; }
    closePopover(dlg);
    pop.__owner = addBtn;

    const presets = host.dataset.allDay === '1' ? ALL_DAY_PRESETS : REMINDER_PRESETS;
    pop.innerHTML = `<div class="cf-menu" role="listbox" aria-label="When to remind you">
      ${presets.map((x) => `<button type="button" role="option" class="cf-menu-opt"
        data-m="${x.m}"><span class="cf-menu-l">${esc(x.label)}</span></button>`).join('')}
      <button type="button" role="option" class="cf-menu-opt" data-custom>
        <span class="cf-menu-l">Custom…</span></button>
    </div>`;
    pop.hidden = false;
    anchor(pop, dlg, addBtn);

    const menu = pop.querySelector('.cf-menu');
    menu.querySelectorAll('[data-m]').forEach((b) => {
      b.onclick = () => { add(Number(b.dataset.m)); closePopover(dlg); };
    });
    menu.querySelector('[data-custom]').onclick = () => {
      menu.innerHTML = `<div class="cf-rem-custom">
        <input type="number" min="0" max="${MAX_REMINDER_MINUTES}" step="5" value="45"
          aria-label="Minutes before">
        <span>minutes before</span>
        <button type="button" data-ok>Add</button></div>`;
      const input = menu.querySelector('input');
      input.focus();
      input.select();
      const ok = () => {
        const n = Number(input.value);
        if (!Number.isFinite(n) || n < 0 || n > MAX_REMINDER_MINUTES) {
          say(`A reminder must be between 0 and ${MAX_REMINDER_MINUTES} minutes before.`);
          return;
        }
        add(n);
        closePopover(dlg);
      };
      menu.querySelector('[data-ok]').onclick = ok;
      input.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ok(); } };
    };
    const away = (ev) => {
      if (pop.contains(ev.target) || ev.target === addBtn) return;
      closePopover(dlg);
      document.removeEventListener('click', away, true);
    };
    setTimeout(() => document.addEventListener('click', away, true), 0);
  });

  addBtn.hidden = values().length >= MAX_REMINDERS;
  return { get values() { return values(); } };
}

/* ══ Recurrence ══════════════════════════════════════════════════════════ */

const WEEKDAYS = [
  { id: 'MO', label: 'Mon' }, { id: 'TU', label: 'Tue' }, { id: 'WE', label: 'Wed' },
  { id: 'TH', label: 'Thu' }, { id: 'FR', label: 'Fri' }, { id: 'SA', label: 'Sat' },
  { id: 'SU', label: 'Sun' },
];
const ORDINALS = [
  { v: '1', label: 'first' }, { v: '2', label: 'second' }, { v: '3', label: 'third' },
  { v: '4', label: 'fourth' }, { v: '-1', label: 'last' },
];
const DAY_NAME = {
  MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday',
  FR: 'Friday', SA: 'Saturday', SU: 'Sunday',
};

export const REPEATS = [
  { id: '', label: 'Does not repeat' },
  { id: 'RRULE:FREQ=DAILY', label: 'Every day' },
  { id: 'RRULE:FREQ=WEEKLY', label: 'Every week' },
  { id: 'RRULE:FREQ=MONTHLY', label: 'Every month' },
  { id: 'RRULE:FREQ=YEARLY', label: 'Every year' },
  { id: 'custom', label: 'Custom…' },
];

/** RRULE → a sentence. Nobody should ever have to read the rule itself. */
export function describeRecurrence(rule) {
  if (!rule) return '';
  const body = String(rule).replace(/^RRULE:/, '');
  const get = (k) => new RegExp(`${k}=([^;]+)`).exec(body)?.[1];
  const freq = get('FREQ');
  const interval = Number(get('INTERVAL') || 1);
  const byday = get('BYDAY');
  const bymonthday = get('BYMONTHDAY');
  const count = get('COUNT');
  const until = get('UNTIL');
  if (!freq) return '';

  const every = (unit) => (interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`);
  let core;
  if (freq === 'DAILY') core = `Repeats ${every('day')}`;
  else if (freq === 'WEEKLY') {
    const days = (byday ?? '').split(',').filter(Boolean).map((d) => DAY_NAME[d]).filter(Boolean);
    core = days.length
      ? `Repeats ${interval === 1 ? 'every' : `every ${interval} weeks on`} ${listWords(days)}`
      : `Repeats ${every('week')}`;
  } else if (freq === 'MONTHLY') {
    if (byday && /^-?\d/.test(byday)) {
      const ord = ORDINALS.find((o) => byday.startsWith(o.v))?.label ?? '';
      const day = DAY_NAME[byday.slice(-2)] ?? '';
      core = `Repeats on the ${ord} ${day} of ${interval === 1 ? 'every month' : `every ${interval} months`}`;
    } else if (bymonthday) {
      core = `Repeats on day ${bymonthday} of ${interval === 1 ? 'every month' : `every ${interval} months`}`;
    } else core = `Repeats ${every('month')}`;
  } else if (freq === 'YEARLY') core = `Repeats ${every('year')}`;
  else core = 'Repeats';

  if (count) return `${core}, ${count} times`;
  if (until) {
    const y = until.slice(0, 4); const m = until.slice(4, 6); const d = until.slice(6, 8);
    return `${core}, until ${formatDate(`${y}-${m}-${d}`)}`;
  }
  return core;
}

const listWords = (xs) => (xs.length <= 1 ? (xs[0] ?? '')
  : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/* "On the ___" should open on the date you are already looking at. It used to
 * default to the first Monday of the month whatever the event's date was, so
 * an event on Thursday the 20th proposed "first Monday" and had to be
 * corrected by hand every time. */
const nthOf = (day) => {
  const d = day ? parseIsoDate(day) : new Date();
  return { ord: String(Math.min(4, Math.ceil(d.getDate() / 7))),
    wd: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getDay()] };
};

export const recurrenceBuilder = (day) => `<div class="cf-rec" data-cf-rec data-day="${esc(day)}">
  <div class="cf-rec-row">
    <span>Every</span>
    <input type="number" min="1" max="52" value="1" data-rec-interval aria-label="Interval">
    ${selectField('cf-rec-freq', [
    { id: 'DAILY', label: 'day' }, { id: 'WEEKLY', label: 'week' },
    { id: 'MONTHLY', label: 'month' }, { id: 'YEARLY', label: 'year' },
  ], 'WEEKLY', 'Unit')}
  </div>

  <div class="cf-rec-days" data-rec-days>
    ${WEEKDAYS.map((d) => `<button type="button" class="cf-day" data-rec-day="${d.id}"
      aria-pressed="false">${d.label}</button>`).join('')}
  </div>

  <div class="cf-rec-month" data-rec-month hidden>
    <label><input type="radio" name="cf-rec-mode" value="day" checked>
      <span data-rec-onday>on day —</span></label>
    <label><input type="radio" name="cf-rec-mode" value="nth">
      <span>on the
        ${selectField('cf-rec-ord', ORDINALS.map((o) => ({ id: o.v, label: o.label })),
    nthOf(day).ord, 'Which one')}
        ${selectField('cf-rec-nthday', WEEKDAYS.map((d) => ({ id: d.id, label: DAY_NAME[d.id] })),
    nthOf(day).wd, 'Which day')}
      </span></label>
  </div>

  <div class="cf-rec-row">
    <span>Ends</span>
    ${selectField('cf-rec-end', [
    { id: 'never', label: 'Never' }, { id: 'on', label: 'On a date' },
    { id: 'after', label: 'After' },
  ], 'never', 'When it ends')}
    <input type="date" data-rec-until hidden aria-label="Until">
    <span data-rec-count-wrap hidden>
      <input type="number" min="1" max="500" value="10" data-rec-count aria-label="Occurrences">
      <span>times</span>
    </span>
  </div>

  <p class="cf-rec-say" data-rec-say></p>
</div>`;

/** Reads the builder and produces an RRULE plus its sentence. */
export function wireRecurrence(root, onChange) {
  const host = root.querySelector('[data-cf-rec]');
  if (!host) return { get rule() { return ''; } };
  const q = (sel) => host.querySelector(sel);
  const day = host.dataset.day;

  const val = (id) => root.querySelector(`#${id}`)?.dataset.value ?? '';

  const build = () => {
    const freq = val('cf-rec-freq');
    const interval = Math.max(1, Number(q('[data-rec-interval]').value) || 1);
    const parts = [`FREQ=${freq}`];
    if (interval > 1) parts.push(`INTERVAL=${interval}`);

    if (freq === 'WEEKLY') {
      const days = [...host.querySelectorAll('[data-rec-day][aria-pressed="true"]')]
        .map((b) => b.dataset.recDay);
      if (days.length) parts.push(`BYDAY=${days.join(',')}`);
    }
    if (freq === 'MONTHLY') {
      const mode = host.querySelector('[name="cf-rec-mode"]:checked')?.value ?? 'day';
      if (mode === 'nth') {
        parts.push(`BYDAY=${val('cf-rec-ord')}${val('cf-rec-nthday')}`);
      } else if (day) {
        parts.push(`BYMONTHDAY=${parseIsoDate(day).getDate()}`);
      }
    }

    const end = val('cf-rec-end');
    if (end === 'on' && q('[data-rec-until]').value) {
      parts.push(`UNTIL=${q('[data-rec-until]').value.replace(/-/g, '')}T235959Z`);
    } else if (end === 'after') {
      parts.push(`COUNT=${Math.max(1, Number(q('[data-rec-count]').value) || 1)}`);
    }
    return `RRULE:${parts.join(';')}`;
  };

  const refresh = () => {
    const freq = val('cf-rec-freq');
    host.querySelector('[data-rec-days]').hidden = freq !== 'WEEKLY';
    host.querySelector('[data-rec-month]').hidden = freq !== 'MONTHLY';
    if (day) q('[data-rec-onday]').textContent = `on day ${parseIsoDate(day).getDate()}`;
    const end = val('cf-rec-end');
    q('[data-rec-until]').hidden = end !== 'on';
    host.querySelector('[data-rec-count-wrap]').hidden = end !== 'after';
    const rule = build();
    q('[data-rec-say]').textContent = describeRecurrence(rule);
    onChange?.(rule);
  };

  host.addEventListener('change', refresh);
  host.addEventListener('input', refresh);
  /* The builder's own dropdowns are the shared component too — a recurrence
   * panel with three white OS menus inside a dark one would be the same bug
   * in a smaller box. */
  wireMenus(host, root.closest('.modal') ?? root, refresh);
  host.querySelectorAll('[data-rec-day]').forEach((b) => {
    b.addEventListener('click', () => {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      refresh();
    });
  });
  // Start on the event's own weekday, which is what "every week" already means.
  if (day) {
    const wd = WEEKDAYS[(parseIsoDate(day).getDay() + 6) % 7];
    host.querySelector(`[data-rec-day="${wd.id}"]`)?.setAttribute('aria-pressed', 'true');
  }
  refresh();
  return { get rule() { return build(); }, refresh };
}

/* ══ Selects ═════════════════════════════════════════════════════════════ */

/* ══ Choosing one of a list ══════════════════════════════════════════════
 *
 * A native `<select>` renders its option list with the OPERATING SYSTEM, not
 * with the page. `color-scheme: dark` restyles the closed control and does
 * nothing whatever to the menu, so Calendar, Repeat, Notify and Area all
 * opened as bright white sheets in the middle of a dark app while the time
 * picker beside them was correctly dark. There is no CSS that fixes that; the
 * control has to be ours.
 *
 * So this is a button plus a panel, drawn into the SAME popover host the date
 * and time pickers use — which is how it inherits their placement (below when
 * there is room, deliberately above when there is not), their layering, and
 * their immunity to being clipped by the modal's own scroll box.
 *
 * Keyboard behaviour is the part a native select gives away for free and a
 * custom one has to earn: arrows move, Home/End jump, Enter and Space choose,
 * Escape closes without changing anything, and typing a letter jumps to it.
 */


/** Calendars carry their colour, so the menu says which one without reading. */
export const calendarSelect = (id, calendars, value) => selectField(
  id,
  calendars.map((c) => ({
    id: c.id,
    label: c.name,
    hint: c.accountEmail ?? undefined,
    mark: c.color || undefined,
  })),
  value,
  'Calendar',
);

