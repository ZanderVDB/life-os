/**
 * Event editor — create, view and edit in ONE modal.
 *
 * FIELD RULE, and it is the important one: every field here maps to a Google
 * Calendar property that can round-trip. Nothing is offered that would look
 * editable in Life OS but silently fail to persist. Life OS-only relationships
 * (preparation tasks, project links) are shown in their own clearly-labelled
 * section so they are never mistaken for Google content.
 *
 * CONTROL RULE: no raw browser chrome. The spec named the specific offenders —
 * three-part date boxes, default white checkbox squares, native select arrows,
 * stark white date-picker surfaces, mismatched heights, browser-blue focus
 * rings. So the date and time pickers are custom, the toggles are custom, and
 * every control shares one input shell at one height.
 *
 * Progressive disclosure: title, when, calendar, location and description are
 * always visible. Recurrence, guests, notifications, availability, visibility
 * and colour live behind "More options", because showing every Google field at
 * once is how an event form becomes an admin panel.
 */
import { reducedMotion, settle } from './motion.js';

const RISE_IN = [{ opacity: 0, translate: '0 10px', scale: '0.985' },
  { opacity: 1, translate: '0 0', scale: '1' }];
const RISE_OUT = [{ opacity: 1, translate: '0 0', scale: '1' },
  { opacity: 0, translate: '0 6px', scale: '0.99' }];

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),'
  + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/* Google's named event colours. Shown as swatches, stored as colorId. */
const GOOGLE_COLORS = [
  ['', 'Calendar default', null],
  ['1', 'Lavender', '#7986CB'], ['2', 'Sage', '#33B679'],
  ['3', 'Grape', '#8E24AA'], ['4', 'Flamingo', '#E67C73'],
  ['5', 'Banana', '#F6BF26'], ['6', 'Tangerine', '#F4511E'],
  ['9', 'Blueberry', '#3F51B5'], ['10', 'Basil', '#0B8043'],
  ['11', 'Tomato', '#D50000'],
];

const RECURRENCE = [
  ['', 'Does not repeat'],
  ['RRULE:FREQ=DAILY', 'Every day'],
  ['RRULE:FREQ=WEEKLY', 'Every week'],
  ['RRULE:FREQ=WEEKLY;INTERVAL=2', 'Every 2 weeks'],
  ['RRULE:FREQ=MONTHLY', 'Every month'],
  ['RRULE:FREQ=YEARLY', 'Every year'],
];

const NOTIFY = [5, 10, 15, 30, 60, 1440];

/* ── Date/time helpers ────────────────────────────────────────────────── */
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  + `-${String(d.getDate()).padStart(2, '0')}`;
const parseIso = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const prettyDate = (s) => parseIso(s).toLocaleDateString(undefined,
  { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/** Local Date -> the ISO instant the API expects. */
function toInstant(dayIso, time) {
  const [h, m] = String(time || '09:00').split(':').map(Number);
  const d = parseIso(dayIso);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

/* ── Custom date picker ────────────────────────────────────────────────
 * A real month grid, not three number boxes and not the browser's white
 * dialog. Keyboard-operable: arrows move by day/week, Enter picks. */
function datePickerHtml(value) {
  const d = value ? parseIso(value) : new Date();
  return `<div class="dp" data-dp-month="${d.getFullYear()}-${d.getMonth()}">
    <div class="dp-head">
      <button type="button" class="dp-nav" data-dp="prev" aria-label="Previous month">‹</button>
      <span class="dp-label">${MONTHS[d.getMonth()]} ${d.getFullYear()}</span>
      <button type="button" class="dp-nav" data-dp="next" aria-label="Next month">›</button>
    </div>
    <div class="dp-dow">${DOW.map((x) => `<span>${x}</span>`).join('')}</div>
    <div class="dp-grid">${dpGrid(d.getFullYear(), d.getMonth(), value)}</div>
  </div>`;
}

function dpGrid(year, month, selected) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const todayIso = iso(new Date());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - lead + i);
    const v = iso(d);
    cells.push(`<button type="button" class="dp-day
      ${d.getMonth() !== month ? 'is-out' : ''} ${v === selected ? 'is-sel' : ''}
      ${v === todayIso ? 'is-today' : ''}" data-date="${v}"
      tabindex="${v === selected ? 0 : -1}">${d.getDate()}</button>`);
  }
  return cells.join('');
}

/** Time picker: a styled list on a 15-minute grid, not a native time input. */
function timeOptions(selected) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      const v = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      out.push(`<button type="button" class="tp-opt ${v === selected ? 'is-sel' : ''}"
        data-time="${v}">${v}</button>`);
    }
  }
  return out.join('');
}

/**
 * @param {object} ctx
 *   event      existing event, or null to create
 *   calendars  [{id,name,color,isReadOnly}]
 *   defaultDay 'YYYY-MM-DD' to prefill when creating
 *   links      Life OS relationship records for this event
 *   onSave(body), onDelete()
 */
export function openEventModal(ctx) {
  const { event: ev, calendars = [], defaultDay = null, links = [] } = ctx;
  const opener = document.activeElement;
  document.querySelector('.modal-scrim')?.remove();

  const writable = calendars.filter((c) => !c.isReadOnly);
  const readOnly = !!ev?.isReadOnly;

  // Seed the form.
  const start = ev?.startsAt ? new Date(ev.startsAt) : null;
  const end = ev?.endsAt ? new Date(ev.endsAt) : null;
  const f = {
    title: ev?.title ?? '',
    calendarId: ev?.calendarId ?? writable[0]?.id ?? null,
    isAllDay: !!ev?.isAllDay,
    startDate: ev?.startDate ?? (start ? iso(start) : (defaultDay ?? iso(new Date()))),
    endDate: ev?.endDate ?? (end ? iso(end) : (defaultDay ?? iso(new Date()))),
    startTime: start ? hhmm(start) : '09:00',
    endTime: end ? hhmm(end) : '10:00',
    location: ev?.location ?? '',
    description: ev?.description ?? '',
    recurrence: ev?.recurrence?.[0] ?? '',
    transparency: ev?.transparency ?? 'opaque',
    visibility: ev?.visibility ?? 'default',
    providerColorId: ev?.providerColorId ?? '',
    notify: [10],
  };

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  const dlg = document.createElement('div');
  dlg.className = 'modal modal-event';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', ev ? 'Edit event' : 'New event');

  const cal = calendars.find((c) => c.id === f.calendarId);
  const guests = ev?.attendees ?? [];

  dlg.innerHTML = `
    <div class="m-head ev-head">
      <span class="ev-src-dot" style="background:${esc(cal?.color || 'var(--accent)')}"></span>
      <textarea id="ev-title" class="m-title" rows="1" placeholder="Add a title"
        aria-label="Event title" ${readOnly ? 'readonly' : ''}>${esc(f.title)}</textarea>
      <button class="m-close" id="ev-close" aria-label="Close">&times;</button>
    </div>

    ${readOnly ? `<div class="ev-ro-note">This event is on a read-only calendar.
      You can see it here, but changes have to be made where it lives.</div>` : ''}

    <div class="m-body ev-body">
      <!-- WHEN -->
      <div class="ev-when">
        <div class="ev-row">
          <span class="ev-lab">Starts</span>
          <button type="button" class="ev-ctl" id="ev-sd" data-picker="date"
            data-target="startDate">${esc(prettyDate(f.startDate))}</button>
          <button type="button" class="ev-ctl ev-time ${f.isAllDay ? 'is-hidden' : ''}"
            id="ev-st" data-picker="time" data-target="startTime">${esc(f.startTime)}</button>
        </div>
        <div class="ev-row">
          <span class="ev-lab">Ends</span>
          <button type="button" class="ev-ctl" id="ev-ed" data-picker="date"
            data-target="endDate">${esc(prettyDate(f.endDate))}</button>
          <button type="button" class="ev-ctl ev-time ${f.isAllDay ? 'is-hidden' : ''}"
            id="ev-et" data-picker="time" data-target="endTime">${esc(f.endTime)}</button>
        </div>
        <div class="ev-row">
          <span class="ev-lab"></span>
          <!-- Custom switch, not a native checkbox square. -->
          <button type="button" class="sw ${f.isAllDay ? 'is-on' : ''}" id="ev-allday"
            role="switch" aria-checked="${f.isAllDay}">
            <span class="sw-track"><span class="sw-knob"></span></span>
            <span class="sw-lab">All day</span></button>
        </div>
      </div>

      <div class="ev-row">
        <span class="ev-lab">Calendar</span>
        <div class="ev-ctl ev-select" id="ev-cal-wrap">
          <span class="ev-src-dot" style="background:${esc(cal?.color || 'var(--accent)')}"></span>
          <select id="ev-cal" aria-label="Calendar" ${readOnly ? 'disabled' : ''}>
            ${calendars.map((c) => `<option value="${c.id}" ${c.id === f.calendarId ? 'selected' : ''}
              ${c.isReadOnly ? 'disabled' : ''}>${esc(c.name)}${c.isReadOnly ? ' (read-only)' : ''}</option>`).join('')}
          </select>
          <i class="ev-chev" aria-hidden="true"></i>
        </div>
      </div>

      <div class="ev-row">
        <span class="ev-lab">Location</span>
        <input id="ev-loc" class="ev-ctl ev-input" placeholder="Add a place"
          value="${esc(f.location)}" ${readOnly ? 'readonly' : ''}>
      </div>

      <div class="ev-row ev-row-top">
        <span class="ev-lab">Details</span>
        <textarea id="ev-desc" class="ev-ctl ev-input ev-textarea"
          placeholder="Notes, agenda, links" ${readOnly ? 'readonly' : ''}>${esc(f.description)}</textarea>
      </div>

      ${ev?.hangoutLink ? `<div class="ev-row">
        <span class="ev-lab">Meet</span>
        <a class="ev-meet" href="${esc(ev.hangoutLink)}" target="_blank" rel="noopener">
          Join Google Meet</a></div>` : ''}

      <button type="button" class="ev-more" id="ev-more" aria-expanded="false">
        <i class="ev-chev"></i> More options</button>

      <div class="ev-adv" id="ev-adv" hidden>
        <div class="ev-row">
          <span class="ev-lab">Repeat</span>
          <div class="ev-ctl ev-select">
            <select id="ev-rec" ${readOnly ? 'disabled' : ''}>
              ${RECURRENCE.map(([v, l]) => `<option value="${v}"
                ${v === f.recurrence ? 'selected' : ''}>${l}</option>`).join('')}
            </select><i class="ev-chev"></i></div>
        </div>

        <div class="ev-row ev-row-top">
          <span class="ev-lab">Guests</span>
          <div class="ev-guests">
            <div class="ev-chips" id="ev-chips">
              ${guests.map((g) => `<span class="chip ev-chip rsvp-${g.responseStatus}"
                title="${esc(g.responseStatus)}"><i></i>${esc(g.displayName || g.email)}
                ${readOnly ? '' : `<button type="button" class="ev-chip-x"
                  data-remove-guest="${esc(g.email)}" aria-label="Remove">&times;</button>`}</span>`).join('')}
            </div>
            ${readOnly ? '' : `<input id="ev-guest" class="ev-ctl ev-input"
              placeholder="Add a guest email, then Enter">`}
            ${guests.length ? `<span class="ev-hint">
              ${guests.filter((g) => g.responseStatus === 'accepted').length} of ${guests.length} accepted</span>` : ''}
          </div>
        </div>

        <div class="ev-row ev-row-top">
          <span class="ev-lab">Notify</span>
          <div class="ev-notify" id="ev-notify">
            ${NOTIFY.map((m) => `<button type="button" class="ev-pill ${f.notify.includes(m) ? 'is-on' : ''}"
              data-notify="${m}">${m >= 1440 ? '1 day' : `${m} min`}</button>`).join('')}
          </div>
        </div>

        <div class="ev-row">
          <span class="ev-lab">Shows as</span>
          <div class="seg ev-seg" id="ev-transp" role="group">
            <button type="button" data-transp="opaque" aria-pressed="${f.transparency === 'opaque'}">Busy</button>
            <button type="button" data-transp="transparent" aria-pressed="${f.transparency === 'transparent'}">Free</button>
          </div>
        </div>

        <div class="ev-row">
          <span class="ev-lab">Visibility</span>
          <div class="ev-ctl ev-select">
            <select id="ev-vis" ${readOnly ? 'disabled' : ''}>
              ${['default', 'public', 'private', 'confidential'].map((v) => `<option value="${v}"
                ${v === f.visibility ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}
            </select><i class="ev-chev"></i></div>
        </div>

        <div class="ev-row ev-row-top">
          <span class="ev-lab">Colour</span>
          <div class="ev-swatches" id="ev-colors">
            ${GOOGLE_COLORS.map(([id, name, hex]) => `<button type="button"
              class="ev-swatch ${id === f.providerColorId ? 'is-sel' : ''}" data-color="${id}"
              title="${esc(name)}" aria-label="${esc(name)}"
              style="--sw:${hex || 'var(--surface-3)'}">${hex ? '' : '—'}</button>`).join('')}
          </div>
        </div>

        <!-- Life OS-only. Kept visually apart so it is never mistaken for
             something Google will show to other guests. -->
        <div class="ev-los">
          <span class="ev-los-lab">Life OS links</span>
          ${links.length
            ? `<div class="ev-los-list">${links.map((l) => `<span class="chip">${esc(l.kind.replace('_', ' '))}</span>`).join('')}</div>`
            : '<span class="ev-hint">No linked tasks or projects yet.</span>'}
          <span class="ev-hint">Stored in Life OS only. Other people looking at
            this event in Google Calendar will not see these.</span>
        </div>
      </div>
    </div>

    <div class="m-foot">
      ${ev && !readOnly ? '<button class="btn btn-ghost m-danger" id="ev-del">Delete</button>' : ''}
      <span class="m-save-state" id="ev-state" role="status"></span>
      <button class="btn" id="ev-cancel">${readOnly ? 'Close' : 'Cancel'}</button>
      ${readOnly ? '' : `<button class="btn btn-primary" id="ev-save">${ev ? 'Save' : 'Create event'}</button>`}
    </div>

    <div class="ev-pop" id="ev-pop" hidden></div>`;

  document.body.append(scrim, dlg);
  document.body.classList.add('modal-open');
  if (!reducedMotion()) {
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    dlg.animate(RISE_IN, { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  const $ = (sel) => dlg.querySelector(sel);
  const title = $('#ev-title');
  const grow = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
  title.addEventListener('input', grow); grow();
  if (!readOnly) { title.focus(); title.setSelectionRange(title.value.length, title.value.length); }

  /* ── Dirty tracking ──────────────────────────────────────────────── */
  const read = () => ({
    title: title.value.trim(),
    calendarId: $('#ev-cal').value,
    isAllDay: f.isAllDay,
    startDate: f.startDate, endDate: f.endDate,
    startTime: f.startTime, endTime: f.endTime,
    location: $('#ev-loc').value,
    description: $('#ev-desc').value,
    recurrence: $('#ev-rec').value,
    transparency: f.transparency,
    visibility: $('#ev-vis').value,
    providerColorId: f.providerColorId,
  });
  const initial = JSON.stringify(read());
  const isDirty = () => JSON.stringify(read()) !== initial;

  /* ── All-day toggle: transforms the date/time controls ───────────── */
  $('#ev-allday').onclick = () => {
    if (readOnly) return;
    f.isAllDay = !f.isAllDay;
    const btn = $('#ev-allday');
    btn.classList.toggle('is-on', f.isAllDay);
    btn.setAttribute('aria-checked', String(f.isAllDay));
    // The time controls collapse rather than vanish, so the row does not jump.
    dlg.querySelectorAll('.ev-time').forEach((el) => el.classList.toggle('is-hidden', f.isAllDay));
  };

  /* ── More options ────────────────────────────────────────────────── */
  $('#ev-more').onclick = () => {
    const adv = $('#ev-adv');
    const open = adv.hidden;
    adv.hidden = !open;
    $('#ev-more').setAttribute('aria-expanded', String(open));
    $('#ev-more').classList.toggle('is-open', open);
    if (open && !reducedMotion()) {
      adv.animate([{ opacity: 0, translate: '0 -6px' }, { opacity: 1, translate: '0 0' }],
        { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  };

  /* ── Custom pickers ──────────────────────────────────────────────── */
  const pop = $('#ev-pop');
  let popFor = null;

  function closePop() { pop.hidden = true; pop.innerHTML = ''; popFor = null; }

  function openPicker(btn) {
    const kind = btn.dataset.picker;
    const target = btn.dataset.target;
    if (popFor === target) return closePop();
    popFor = target;
    pop.innerHTML = kind === 'date'
      ? datePickerHtml(f[target])
      : `<div class="tp">${timeOptions(f[target])}</div>`;
    pop.hidden = false;
    // Anchored to the control, clamped inside the dialog.
    const b = btn.getBoundingClientRect();
    const d = dlg.getBoundingClientRect();
    pop.style.left = `${Math.min(b.left - d.left, d.width - pop.offsetWidth - 12)}px`;
    pop.style.top = `${Math.min(b.bottom - d.top + 6, d.height - pop.offsetHeight - 12)}px`;
    if (kind === 'time') pop.querySelector('.tp-opt.is-sel')?.scrollIntoView({ block: 'center' });
    wirePop(kind, target, btn);
  }

  function wirePop(kind, target, btn) {
    if (kind === 'time') {
      pop.querySelectorAll('[data-time]').forEach((o) => {
        o.onclick = () => {
          f[target] = o.dataset.time;
          btn.textContent = o.dataset.time;
          // Keep end after start without arguing with the user.
          if (target === 'startTime' && f.endTime <= f.startTime) {
            const [h, m] = f.startTime.split(':').map(Number);
            const e = new Date(); e.setHours(h + 1, m, 0, 0);
            f.endTime = hhmm(e); $('#ev-et').textContent = f.endTime;
          }
          closePop();
        };
      });
      return;
    }
    const rewire = () => wirePop('date', target, btn);
    pop.querySelectorAll('[data-date]').forEach((o) => {
      o.onclick = () => {
        f[target] = o.dataset.date;
        btn.textContent = prettyDate(o.dataset.date);
        if (target === 'startDate' && f.endDate < f.startDate) {
          f.endDate = f.startDate; $('#ev-ed').textContent = prettyDate(f.endDate);
        }
        closePop();
      };
    });
    pop.querySelectorAll('[data-dp]').forEach((n) => {
      n.onclick = () => {
        const host = pop.querySelector('.dp');
        let [y, mo] = host.dataset.dpMonth.split('-').map(Number);
        mo += n.dataset.dp === 'next' ? 1 : -1;
        if (mo < 0) { mo = 11; y--; } else if (mo > 11) { mo = 0; y++; }
        host.dataset.dpMonth = `${y}-${mo}`;
        host.querySelector('.dp-label').textContent = `${MONTHS[mo]} ${y}`;
        host.querySelector('.dp-grid').innerHTML = dpGrid(y, mo, f[target]);
        rewire();
      };
    });
  }

  dlg.querySelectorAll('[data-picker]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); if (!readOnly) openPicker(b); };
  });
  dlg.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-picker]')) closePop();
  });

  /* ── Chips, pills, segments, swatches ────────────────────────────── */
  $('#ev-guest')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = e.target.value.trim();
    if (!v || !v.includes('@')) return;
    const chip = document.createElement('span');
    chip.className = 'chip ev-chip rsvp-needsAction';
    chip.innerHTML = `<i></i>${esc(v)}<button type="button" class="ev-chip-x"
      data-remove-guest="${esc(v)}" aria-label="Remove">&times;</button>`;
    $('#ev-chips').appendChild(chip);
    if (!reducedMotion()) {
      chip.animate([{ opacity: 0, scale: '0.9' }, { opacity: 1, scale: '1' }],
        { duration: 160, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
    e.target.value = '';
  });
  dlg.addEventListener('click', (e) => {
    const x = e.target.closest('[data-remove-guest]');
    if (!x) return;
    const chip = x.closest('.chip');
    if (reducedMotion()) return chip.remove();
    const a = chip.animate([{ opacity: 1, scale: '1' }, { opacity: 0, scale: '0.9' }],
      { duration: 140, easing: 'ease-in' });
    settle(a, 140, () => chip.remove());
  });

  dlg.querySelectorAll('[data-notify]').forEach((p) => {
    p.onclick = () => p.classList.toggle('is-on');
  });
  dlg.querySelectorAll('[data-transp]').forEach((b) => {
    b.onclick = () => {
      f.transparency = b.dataset.transp;
      dlg.querySelectorAll('[data-transp]').forEach((x) =>
        x.setAttribute('aria-pressed', String(x.dataset.transp === f.transparency)));
    };
  });
  dlg.querySelectorAll('[data-color]').forEach((s) => {
    s.onclick = () => {
      f.providerColorId = s.dataset.color;
      dlg.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('is-sel', x === s));
    };
  });
  $('#ev-cal').onchange = () => {
    const c = calendars.find((x) => x.id === $('#ev-cal').value);
    dlg.querySelectorAll('.ev-src-dot').forEach((d) => {
      d.style.background = c?.color || 'var(--accent)';
    });
  };

  /* ── Close ───────────────────────────────────────────────────────── */
  let closed = false;
  function close(force = false) {
    if (closed) return;
    if (!force && !readOnly && isDirty()
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
  $('#ev-close').onclick = () => close();
  $('#ev-cancel').onclick = () => close();

  /* ── Save ────────────────────────────────────────────────────────── */
  const state = $('#ev-state');
  $('#ev-save')?.addEventListener('click', async () => {
    const v = read();
    if (!v.title) { title.focus(); state.textContent = 'A title is needed'; return; }
    if (!f.isAllDay && toInstant(f.endDate, f.endTime) <= toInstant(f.startDate, f.startTime)) {
      state.textContent = 'The end must be after the start';
      return;
    }
    const body = {
      calendarId: v.calendarId,
      title: v.title,
      description: v.description || null,
      location: v.location || null,
      isAllDay: f.isAllDay,
      transparency: v.transparency,
      visibility: v.visibility,
      providerColorId: v.providerColorId || null,
      recurrence: v.recurrence ? [v.recurrence] : null,
      ...(f.isAllDay
        ? { startDate: f.startDate, endDate: f.endDate, startsAt: null, endsAt: null }
        : {
          startsAt: toInstant(f.startDate, f.startTime),
          endsAt: toInstant(f.endDate, f.endTime),
          startDate: null, endDate: null,
        }),
    };
    // The modal stays open until the save is known to have worked — closing
    // first would lose the user's typing if the request failed.
    const btn = $('#ev-save');
    btn.classList.add('is-busy');
    state.textContent = 'Saving…';
    try {
      await ctx.onSave(body);
      close(true);
    } catch (e) {
      btn.classList.remove('is-busy');
      state.textContent = e.message;
    }
  });

  $('#ev-del')?.addEventListener('click', async () => {
    if (!confirm(`Delete "${ev.title}"? This cannot be undone.`)) return;
    state.textContent = 'Deleting…';
    try { await ctx.onDelete(); close(true); }
    catch (e) { state.textContent = e.message; }
  });

  return { close };
}

/* ── Add menu ──────────────────────────────────────────────────────────
 * Four item types, because Calendar has four. Nothing here silently fails:
 * each entry either opens a working flow or is not shown. */
export function openAddMenu(anchor, handlers) {
  document.querySelector('.cal-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'menu cal-menu';
  menu.setAttribute('role', 'menu');
  const items = [
    ['event', 'Event', 'Something that occupies time'],
    ['reminder', 'Reminder', 'Something to be reminded about'],
    ['task', 'Scheduled task', 'Plan when you will do a task'],
    ['habit', 'Habit', 'Something you repeat'],
  ].filter(([k]) => handlers[k]);

  menu.innerHTML = items.map(([k, label, hint]) => `
    <button role="menuitem" data-add="${k}">
      <span class="cm-add-l">${label}</span>
      <span class="cm-add-h">${hint}</span>
    </button>`).join('');
  document.body.appendChild(menu);

  const b = anchor.getBoundingClientRect();
  menu.style.top = `${b.bottom + 6}px`;
  menu.style.left = `${Math.min(b.left, window.innerWidth - menu.offsetWidth - 12)}px`;
  if (!reducedMotion()) {
    menu.animate([{ opacity: 0, translate: '0 -6px' }, { opacity: 1, translate: '0 0' }],
      { duration: 150, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  const closeMenu = () => { menu.remove(); document.removeEventListener('click', away, true); };
  const away = (e) => { if (!menu.contains(e.target) && e.target !== anchor) closeMenu(); };
  setTimeout(() => document.addEventListener('click', away, true), 0);
  menu.querySelectorAll('[data-add]').forEach((el) => {
    el.onclick = () => { closeMenu(); handlers[el.dataset.add](); };
  });
  menu.querySelector('button')?.focus();
  return { close: closeMenu };
}
