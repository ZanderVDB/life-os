/**
 * Creating, editing and deleting Google Calendar events.
 *
 * ── Nothing is written until it is confirmed ────────────────────────────
 *
 * The form does not write. Filling it in produces a PROPOSAL — the server
 * prepares the change, checks availability and describes what will happen —
 * and only the confirmation screen executes it. Two round trips instead of
 * one, on purpose: it is what makes "Add to Google Calendar?" a question with
 * a truthful answer, and it is the same path the assistant will use later.
 *
 * ── The draft survives everything ───────────────────────────────────────
 *
 * If Google is unreachable, or the grant cannot write, or the event was
 * changed on a phone while the form was open, the composer stays open with
 * every field intact. Losing what someone typed to explain a problem they did
 * not cause is its own bug.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const uid = () => (crypto?.randomUUID?.() ?? `r${Date.now()}${Math.random()}`).slice(0, 60);

/** The browser's own zone, which is the honest default for a new event. */
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** A local date + time, as an instant with an offset Google can read. */
function toInstant(day, time) {
  const [h, m] = String(time || '00:00').split(':').map(Number);
  const d = new Date(`${day}T00:00:00`);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.toISOString();
}

const addMinutes = (day, time, mins) => {
  const [h, m] = String(time || '09:00').split(':').map(Number);
  const d = new Date(`${day}T00:00:00`);
  d.setHours(h || 0, (m || 0) + mins, 0, 0);
  return { day: isoDay(d), time: hhmm(d) };
};

let ctx = null;
/** Wired once by app.js: `api`, `toast`, and a way to refresh the calendar. */
export function initEventComposer(c) { ctx = c; }

/* ══ The shell ═══════════════════════════════════════════════════════════ */

function modal({ title, body, actions, onMount }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    const dlg = document.createElement('div');
    dlg.className = 'modal ev-modal';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', title);
    dlg.innerHTML = `<div class="m-head"><h2>${esc(title)}</h2></div>
      <div class="m-body ev-body">${body}</div>
      <div class="m-foot ev-foot">${actions}</div>`;
    document.body.append(scrim, dlg);
    document.body.classList.add('modal-open');

    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      scrim.remove();
      dlg.remove();
      document.body.classList.remove('modal-open');
      opener?.focus?.();
      resolve(value);
    };
    scrim.addEventListener('click', () => close(null));
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
    dlg.querySelectorAll('[data-close]').forEach((b) => {
      b.addEventListener('click', () => close(b.dataset.close === 'ok' ? true : null));
    });
    onMount?.(dlg, close);
    dlg.querySelector('input, select, textarea, button')?.focus();
  });
}

/** Buttons the whole flow shares, so Cancel is always in the same place. */
const foot = (confirmLabel, tone = 'primary') =>
  `<button class="btn btn-ghost" data-close="cancel">Cancel</button>
   <button class="btn btn-${tone}" data-go>${esc(confirmLabel)}</button>`;

/* ══ Connection ══════════════════════════════════════════════════════════ */

/**
 * Asked before the form opens, not after it is filled in.
 *
 * A grant made before write support existed looks perfectly healthy and cannot
 * create anything. Finding that out at the end — after someone has typed a
 * title, picked a time and pressed the button — is the worst possible moment.
 */
async function writeState() {
  try { return await ctx.api('/calendar/write-state'); } catch { return null; }
}

async function blockedByConnection(state) {
  await modal({
    title: 'Google Calendar connection required',
    body: `<p class="ev-note">${esc(state?.reason
      ?? 'Connect Google Calendar to create events.')}</p>
      <p class="ev-sub">A real event lives in Google Calendar. Life OS will not
      pretend to have made one.</p>`,
    actions: `<button class="btn btn-ghost" data-close="cancel">Not now</button>
      <button class="btn btn-primary" data-go>Reconnect Google Calendar</button>`,
    onMount: (dlg, close) => {
      dlg.querySelector('[data-go]').addEventListener('click', () => {
        close(null);
        ctx.connectGoogle?.();
      });
    },
  });
}

/* ══ Composer ════════════════════════════════════════════════════════════ */

const DURATIONS = [
  { m: 15, label: '15 min' },
  { m: 30, label: '30 min' },
  { m: 45, label: '45 min' },
  { m: 60, label: '1 hr' },
  { m: 90, label: '1 hr 30' },
  { m: 120, label: '2 hr' },
  { m: 180, label: '3 hr' },
];
const REPEATS = [
  { id: '', label: 'Does not repeat' },
  { id: 'RRULE:FREQ=DAILY', label: 'Every day' },
  { id: 'RRULE:FREQ=WEEKLY', label: 'Every week' },
  { id: 'RRULE:FREQ=MONTHLY', label: 'Every month' },
  { id: 'RRULE:FREQ=YEARLY', label: 'Every year' },
];
const REMINDERS = [
  { m: null, label: 'Default' },
  { m: 0, label: 'At the time' },
  { m: 10, label: '10 min before' },
  { m: 30, label: '30 min before' },
  { m: 60, label: '1 hr before' },
  { m: 1440, label: '1 day before' },
];

/* ── The time field ──────────────────────────────────────────────────────
 *
 * `<input type="time">` is a different control in every browser, none of them
 * matching the app, and on desktop it is a fiddly three-part spinner for a
 * value people already know. This is a text field with a list: type "9", "930"
 * or "14:30" and it understands; or pick from quarter hours, which is what
 * almost every event actually starts on.
 *
 * Deliberately not a clock face. The keyboard is the fast path and must stay
 * the fast path.
 */
const QUARTERS = Array.from({ length: 24 * 4 }, (_, i) =>
  `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`);

/** "9", "9.30", "930", "14:30", "2:30pm" → "09:30" / "14:30". Anything else: null. */
export function parseTime(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return null;
  const pm = /p/.test(t);
  const am = /a/.test(t);
  const digits = t.replace(/[^0-9:.]/g, '').replace('.', ':');
  let h; let m = 0;
  if (digits.includes(':')) {
    const [a, b] = digits.split(':');
    h = Number(a); m = Number(b ?? 0);
  } else if (digits.length <= 2) {
    h = Number(digits);
  } else {
    h = Number(digits.slice(0, digits.length - 2));
    m = Number(digits.slice(-2));
  }
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

const timeFieldHtml = (id, value, label) => `<div class="ev-time-f" data-timefield>
    <label for="${id}">${esc(label)}</label>
    <input id="${id}" class="ev-time-in" value="${esc(value)}" inputmode="numeric"
      autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list">
    <div class="ev-time-list" data-time-list hidden role="listbox"></div>
  </div>`;

/** Wires one time field: a list on focus, typing accepted, keyboard first. */
function wireTimeField(root, onChange) {
  const input = root.querySelector('.ev-time-in');
  const list = root.querySelector('[data-time-list]');
  let open = false;

  const render = () => {
    const current = parseTime(input.value) ?? '09:00';
    list.innerHTML = QUARTERS.map((t) => `<button type="button" role="option" data-t="${t}"
      class="${t === current ? 'is-on' : ''}" aria-selected="${t === current}">${t}</button>`).join('');
    // Bring the current time into view rather than making them scroll to it.
    const on = list.querySelector('.is-on');
    if (on) list.scrollTop = Math.max(0, on.offsetTop - 62);
  };
  const show = () => { if (open) return; open = true; list.hidden = false; input.setAttribute('aria-expanded', 'true'); render(); };
  const hide = () => { open = false; list.hidden = true; input.setAttribute('aria-expanded', 'false'); };

  const commit = (value) => {
    const t = parseTime(value);
    if (t) input.value = t;
    hide();
    onChange?.(t ?? parseTime(input.value));
  };

  input.addEventListener('focus', show);
  input.addEventListener('click', show);
  input.addEventListener('blur', () => setTimeout(() => { commit(input.value); }, 120));
  input.addEventListener('input', () => { if (!open) show(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) { e.stopPropagation(); hide(); return; }
    if (e.key === 'Enter') { e.preventDefault(); commit(input.value); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    // Arrows step by a quarter hour, which is the whole point of the list.
    e.preventDefault();
    show();
    const now = parseTime(input.value) ?? '09:00';
    const i = QUARTERS.indexOf(now);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = i === -1
      ? QUARTERS.findIndex((t) => t > now)
      : Math.min(QUARTERS.length - 1, Math.max(0, i + step));
    input.value = QUARTERS[next < 0 ? 0 : next];
    render();
    onChange?.(input.value);
  });
  list.addEventListener('mousedown', (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    e.preventDefault();
    input.value = b.dataset.t;
    commit(b.dataset.t);
  });
}

/**
 * The composer, arranged by what the person is deciding rather than by what
 * the API happens to accept.
 *
 * What → When → Where → Details, with everything else behind More. The first
 * three answer "is this the right event"; the rest are refinements, and a form
 * that shows nine fields at once makes the two-field case feel like work.
 */
function composerHtml(state, d) {
  const cals = state.writable ?? [];
  const end = addMinutes(d.day, d.time, d.duration);
  return `<div class="ev-what">
      <input id="ev-title" value="${esc(d.title ?? '')}" placeholder="What is it?"
        maxlength="500" autocomplete="off" aria-label="Title">
    </div>

    <section class="ev-group ev-when">
      <div class="ev-when-row">
        <div class="ev-time-f">
          <label for="ev-date">Date</label>
          <input type="date" id="ev-date" value="${esc(d.day)}">
        </div>
        <div class="ev-time-slot" ${d.isAllDay ? 'hidden' : ''}>
          ${timeFieldHtml('ev-start', d.time, 'Start')}
        </div>
      </div>

      <div class="ev-durs" ${d.isAllDay ? 'hidden' : ''} role="group" aria-label="Duration">
        ${DURATIONS.map((x) => `<button type="button" class="ev-dur${x.m === d.duration ? ' is-on' : ''}"
          data-dur="${x.m}" aria-pressed="${x.m === d.duration}">${esc(x.label)}</button>`).join('')}
      </div>
      <p class="ev-ends" data-ends ${d.isAllDay ? 'hidden' : ''}>Ends ${esc(end.time)}</p>

      <label class="ev-check">
        <input type="checkbox" id="ev-allday"${d.isAllDay ? ' checked' : ''}>
        <span>All day</span>
      </label>
    </section>

    <div class="ev-f">
      <span>Where <i>optional</i></span>
      <input id="ev-loc" value="${esc(d.location ?? '')}" maxlength="500"
        placeholder="Add a place">
    </div>

    <div class="ev-f">
      <span>Details <i>optional</i></span>
      <textarea id="ev-desc" rows="2" maxlength="8000"
        placeholder="Anything worth remembering">${esc(d.description ?? '')}</textarea>
    </div>

    <details class="ev-more">
      <summary>More options</summary>

      <div class="ev-f">
        <span>Calendar</span>
        <select id="ev-cal">
          ${cals.map((c) => `<option value="${c.id}"${c.id === d.calendarId ? ' selected' : ''}
            >${esc(c.name)}</option>`).join('')}
        </select>
      </div>

      <div class="ev-f">
        <span>Guests <i>comma-separated</i></span>
        <input id="ev-guests" value="${esc((d.attendees ?? []).join(', '))}"
          placeholder="someone@example.com">
      </div>
      <label class="ev-check">
        <input type="checkbox" id="ev-notify">
        <span>Email the guests when this is added</span>
      </label>

      <div class="ev-row-2">
        <div class="ev-f">
          <span>Repeats</span>
          <select id="ev-repeat">
            ${REPEATS.map((r) => `<option value="${esc(r.id)}"${r.id === (d.repeat ?? '') ? ' selected' : ''}
              >${esc(r.label)}</option>`).join('')}
          </select>
        </div>
        <div class="ev-f">
          <span>Reminder</span>
          <select id="ev-remind">
            ${REMINDERS.map((r) => `<option value="${r.m ?? ''}">${esc(r.label)}</option>`).join('')}
          </select>
        </div>
      </div>

      <label class="ev-check">
        <input type="checkbox" id="ev-meet">
        <span>Add a Google Meet link</span>
      </label>
      <p class="ev-zone">Times are ${esc(localZone())}.</p>
    </details>`;
}

/**
 * Wires the shared composer body. Used by New and Edit, so the two cannot
 * drift into behaving differently.
 */
function wireComposer(dlg, d) {
  const state = { duration: d.duration ?? 60 };
  const ends = dlg.querySelector('[data-ends]');
  const startField = dlg.querySelector('[data-timefield]');

  const showEnd = () => {
    const time = parseTime(dlg.querySelector('#ev-start')?.value) ?? d.time;
    const day = dlg.querySelector('#ev-date')?.value ?? d.day;
    const e = addMinutes(day, time, state.duration);
    if (ends) ends.textContent = `Ends ${e.time}${e.day !== day ? ' next day' : ''}`;
  };

  if (startField) wireTimeField(startField, showEnd);
  dlg.querySelector('#ev-date')?.addEventListener('change', showEnd);

  dlg.querySelectorAll('[data-dur]').forEach((b) => {
    b.addEventListener('click', () => {
      state.duration = Number(b.dataset.dur);
      dlg.querySelectorAll('[data-dur]').forEach((x) => {
        const on = x === b;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-pressed', String(on));
      });
      showEnd();
    });
  });

  const allDay = dlg.querySelector('#ev-allday');
  allDay?.addEventListener('change', () => {
    dlg.querySelectorAll('.ev-time-slot, .ev-durs, [data-ends]').forEach((el) => {
      el.hidden = allDay.checked;
    });
  });

  showEnd();
  return state;
}

function readComposer(dlg, ui) {
  const v = (id) => dlg.querySelector(`#${id}`)?.value ?? '';
  const on = (id) => !!dlg.querySelector(`#${id}`)?.checked;
  const day = v('ev-date');
  const time = parseTime(v('ev-start')) ?? '09:00';
  const mins = ui?.duration ?? 60;
  const end = addMinutes(day, time, mins);
  const isAllDay = on('ev-allday');
  const repeat = v('ev-repeat');
  const remind = v('ev-remind');
  return {
    calendarId: v('ev-cal'),
    duration: mins,
    draft: {
      title: v('ev-title').trim(),
      description: v('ev-desc').trim() || null,
      location: v('ev-loc').trim() || null,
      isAllDay,
      ...(isAllDay
        ? { startDate: day, endDate: day }
        : { startsAt: toInstant(day, time), endsAt: toInstant(end.day, end.time) }),
      timeZone: localZone(),
      attendees: v('ev-guests').split(',').map((x) => x.trim()).filter(Boolean),
      notifyGuests: on('ev-notify'),
      ...(repeat ? { recurrence: [repeat] } : {}),
      ...(on('ev-meet') ? { withMeet: true } : {}),
      ...(remind !== '' ? { useDefaultReminders: false, reminders: [{ minutes: Number(remind) }] } : {}),
    },
  };
}

/**
 * Open the composer.
 *
 * `prefill` lets a day cell, a time slot or a Task supply context without any
 * of them knowing how an event is made.
 */
export async function openEventComposer(prefill = {}) {
  const state = await writeState();
  if (!state) { ctx.toast('Could not reach Life OS.', true); return null; }
  if (!state.canWrite) { await blockedByConnection(state); return null; }
  if (!state.writable?.length) {
    ctx.toast('None of your Google calendars accept new events.', true);
    return null;
  }

  const now = new Date();
  const start = prefill.startsAt ? new Date(prefill.startsAt) : now;
  if (!prefill.startsAt && !prefill.day) start.setMinutes(start.getMinutes() < 30 ? 30 : 60, 0, 0);

  const d = {
    title: prefill.title ?? '',
    calendarId: prefill.calendarId ?? state.defaultCalendarId ?? state.writable[0].id,
    day: prefill.day ?? isoDay(start),
    time: prefill.time ?? hhmm(start),
    duration: prefill.duration ?? 60,
    isAllDay: !!prefill.isAllDay,
    location: prefill.location ?? '',
    description: prefill.description ?? '',
    attendees: prefill.attendees ?? [],
  };

  /* The loop is the point: a failed proposal returns to the composer with
   * everything the person typed still in it. */
  let carry = d;
  for (;;) {
    const input = await modal({
      title: prefill.taskId ? 'Add this task to your calendar' : 'New event',
      body: composerHtml(state, carry),
      actions: foot('Continue'),
      onMount: (dlg, close) => {
        const ui = wireComposer(dlg, carry);
        dlg.querySelector('[data-go]').addEventListener('click', () => {
          const read = readComposer(dlg, ui);
          if (!read.draft.title) {
            dlg.querySelector('#ev-title')?.focus();
            return;
          }
          close(read);
        });
      },
    });
    if (!input) return null;
    carry = { ...carry, ...backToForm(input) };

    let proposal;
    try {
      const r = await ctx.api('/calendar/events/propose-create', {
        method: 'POST',
        body: { requestId: uid(), calendarId: input.calendarId, draft: input.draft },
      });
      proposal = r.proposal;
    } catch (e) {
      ctx.toast(e.message, true);
      continue;                          // straight back to the form, intact
    }

    const done = await confirmProposal(proposal, {
      confirmLabel: 'Add to Google Calendar',
      taskId: prefill.taskId,
    });
    if (done === 'back') continue;
    return done;
  }
}

/** Turns what was submitted back into form state, so nothing is lost. */
function backToForm(input) {
  const d = input.draft;
  if (d.isAllDay) {
    return { title: d.title, calendarId: input.calendarId, day: d.startDate, isAllDay: true,
      location: d.location ?? '', description: d.description ?? '', attendees: d.attendees };
  }
  const s = new Date(d.startsAt);
  const e = new Date(d.endsAt);
  return {
    title: d.title,
    calendarId: input.calendarId,
    day: isoDay(s),
    time: hhmm(s),
    duration: Math.max(15, Math.round((e - s) / 60000)),
    isAllDay: false,
    location: d.location ?? '',
    description: d.description ?? '',
    attendees: d.attendees,
  };
}

/**
 * The one-line composer, for a slot you just clicked.
 *
 * Most events are a name and a time, and the time is already known from where
 * the pointer landed. Making someone open a nine-field form to write "Gym" is
 * the kind of friction that stops a calendar being used at all.
 *
 * It still goes through the same proposal and the same confirmation: quick
 * means fewer fields, not fewer safeguards.
 */
export async function openQuickComposer({ day, time, duration = 60 }) {
  const state = await writeState();
  if (!state) { ctx.toast('Could not reach Life OS.', true); return null; }
  if (!state.canWrite) { await blockedByConnection(state); return null; }
  if (!state.writable?.length) {
    ctx.toast('None of your Google calendars accept new events.', true);
    return null;
  }

  const end = addMinutes(day, time, duration);
  const calendarId = state.defaultCalendarId ?? state.writable[0].id;

  const input = await modal({
    title: `${time} – ${end.time}`,
    body: `<input id="qc-title" class="qc-title" placeholder="What is this?"
        maxlength="500" autocomplete="off">
      <p class="qc-when">${esc(new Date(`${day}T00:00:00`).toLocaleDateString(undefined,
    { weekday: 'long', day: 'numeric', month: 'long' }))}
        · ${esc(time)}–${esc(end.time)}
        · ${esc(state.writable.find((c) => c.id === calendarId)?.name ?? 'Calendar')}</p>`,
    actions: `<button class="btn btn-ghost" data-close="cancel">Cancel</button>
      <button class="btn btn-ghost" data-more>More details</button>
      <button class="btn btn-primary" data-go>Continue</button>`,
    onMount: (dlg, close) => {
      const field = dlg.querySelector('#qc-title');
      const go = () => {
        const title = field.value.trim();
        if (!title) { field.focus(); return; }
        close({ title });
      };
      // Enter is the whole point of a quick composer.
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); go(); }
      });
      dlg.querySelector('[data-go]').addEventListener('click', go);
      dlg.querySelector('[data-more]').addEventListener('click',
        () => close({ more: true, title: field.value.trim() }));
      setTimeout(() => field.focus(), 40);
    },
  });
  if (!input) return null;

  // "More details" hands the same slot to the full composer, nothing lost.
  if (input.more) {
    return openEventComposer({ day, time, duration, title: input.title });
  }

  const draft = {
    title: input.title,
    isAllDay: false,
    startsAt: toInstant(day, time),
    endsAt: toInstant(end.day, end.time),
    timeZone: localZone(),
    attendees: [],
    notifyGuests: false,
  };
  try {
    const r = await ctx.api('/calendar/events/propose-create', {
      method: 'POST', body: { requestId: uid(), calendarId, draft },
    });
    const done = await confirmProposal(r.proposal, { confirmLabel: 'Add to Google Calendar' });
    // A clash sends them to the full composer rather than a dead end.
    if (done === 'back') return openEventComposer({ day, time, duration, title: input.title });
    return done;
  } catch (e) {
    ctx.toast(e.message, true);
    return openEventComposer({ day, time, duration, title: input.title });
  }
}

/* ══ Confirmation ════════════════════════════════════════════════════════ */

const conflictHtml = (conflicts) => (!conflicts?.length ? '' : `
  <div class="ev-clash">
    <b>You already have something at this time</b>
    ${conflicts.slice(0, 3).map((c) => `<span>${esc(c.title ?? 'Busy')} · ${
  esc(new Date(c.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}–${
  esc(new Date(c.end).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</span>`).join('')}
    <i>Google allows this. It is your call.</i>
  </div>`);

/**
 * The screen that turns a proposal into a change.
 *
 * It renders the summary the SERVER built. If this screen assembled its own
 * description, what the user agreed to and what executed could drift apart —
 * which is the exact failure a confirmation exists to prevent.
 */
export async function confirmProposal(proposal, opts = {}) {
  const s = proposal.summary ?? {};
  const rows = [
    ['When', s.when],
    ['Calendar', s.calendar],
    s.location ? ['Where', s.location] : null,
    s.attendees?.length ? ['Guests', s.attendees.join(', ')] : null,
    s.recurrence ? ['Repeats', s.recurrence] : null,
  ].filter(Boolean);

  const changes = (s.changes ?? []).map((c) => `<div class="ev-change">
      <span class="ev-change-f">${esc(c.field)}</span>
      <span class="ev-change-o">${esc(c.from)}</span>
      <span class="ev-change-a">→</span>
      <span class="ev-change-n">${esc(c.to)}</span>
    </div>`).join('');

  const title = proposal.kind === 'calendar.create' ? 'Add to Google Calendar?'
    : proposal.kind === 'calendar.update' ? 'Update Google Calendar?'
      : 'Delete from Google Calendar?';

  const ok = await modal({
    title,
    body: `<p class="ev-name">${esc(s.title)}</p>
      ${changes ? `<div class="ev-changes">${changes}</div>` : ''}
      <dl class="ev-rows">${rows.map(([k, v]) =>
    `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${(s.warnings ?? []).map((w) => `<p class="ev-warn">${esc(w)}</p>`).join('')}
      ${conflictHtml(proposal.conflicts)}`,
    actions: `<button class="btn btn-ghost" data-close="cancel">${
      proposal.conflicts?.length ? 'Choose another time' : 'Cancel'}</button>
      <button class="btn btn-${proposal.kind === 'calendar.delete' ? 'danger' : 'primary'}"
        data-go>${esc(opts.confirmLabel ?? 'Confirm')}</button>`,
    onMount: (dlg, close) => {
      dlg.querySelector('[data-go]').addEventListener('click', async () => {
        const btn = dlg.querySelector('[data-go]');
        btn.disabled = true;
        btn.textContent = proposal.kind === 'calendar.delete'
          ? 'Removing from Google Calendar…' : 'Saving to Google Calendar…';
        try {
          const r = await ctx.api(`/calendar/mutations/${proposal.requestId}/confirm`, {
            method: 'POST',
            body: opts.taskId ? { taskId: opts.taskId } : {},
          });
          close(r);
        } catch (e) {
          btn.disabled = false;
          btn.textContent = opts.confirmLabel ?? 'Confirm';
          ctx.toast(e.message, true);
        }
      });
    },
  });

  if (!ok) {
    // A cancel is recorded, so a proposal cannot be confirmed later by accident.
    void ctx.api(`/calendar/mutations/${proposal.requestId}/cancel`, { method: 'POST' })
      .catch(() => {});
    return proposal.conflicts?.length ? 'back' : null;
  }
  ctx.toast(proposal.kind === 'calendar.delete' ? 'Removed from Google Calendar'
    : proposal.kind === 'calendar.update' ? 'Updated in Google Calendar'
      : 'Added to Google Calendar');
  await ctx.refresh?.();
  return ok;
}

/**
 * A birthday, using Google's own birthday event type.
 *
 * Deliberately not "an all-day event that repeats yearly and happens to be
 * called a birthday". Google has a real type for this: it does not consume
 * time in free/busy, it renders as a birthday in every other Google client,
 * and it stays a birthday when something else reads the calendar.
 *
 * Which is also why the form is short. Location, guests and Meet are not
 * offered because Google will not accept them on this type, and a field that
 * exists only to be rejected is worse than no field.
 */
export async function openBirthdayComposer(prefill = {}) {
  const state = await writeState();
  if (!state) { ctx.toast('Could not reach Life OS.', true); return null; }
  if (!state.canWrite) { await blockedByConnection(state); return null; }
  if (!state.writable?.length) {
    ctx.toast('None of your Google calendars accept new events.', true);
    return null;
  }

  let carry = {
    name: prefill.name ?? '',
    day: prefill.day ?? isoDay(new Date()),
    calendarId: state.defaultCalendarId ?? state.writable[0].id,
    remind: '1440',
  };

  for (;;) {
    const input = await modal({
      title: 'Add a birthday',
      body: `<div class="ev-what">
          <input id="bd-name" value="${esc(carry.name)}" placeholder="Whose birthday?"
            maxlength="200" autocomplete="off" aria-label="Name">
        </div>
        <section class="ev-group">
          <div class="ev-when-row">
            <div class="ev-time-f">
              <label for="bd-date">Date</label>
              <input type="date" id="bd-date" value="${esc(carry.day)}">
            </div>
            <div class="ev-time-f">
              <label for="bd-remind">Remind me</label>
              <select id="bd-remind">
                <option value="">No reminder</option>
                <option value="0">On the day</option>
                <option value="1440" selected>1 day before</option>
                <option value="10080">1 week before</option>
              </select>
            </div>
          </div>
          <p class="ev-ends">Repeats every year · all day</p>
        </section>
        <div class="ev-f">
          <span>Calendar</span>
          <select id="bd-cal">
            ${state.writable.map((c) => `<option value="${c.id}"${c.id === carry.calendarId ? ' selected' : ''}
              >${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <p class="ev-sub">Saved as a Google birthday, so it does not take up
          time in your day and shows as a birthday everywhere else.</p>`,
      actions: foot('Continue'),
      onMount: (dlg, close) => {
        dlg.querySelector('[data-go]').addEventListener('click', () => {
          const name = dlg.querySelector('#bd-name').value.trim();
          if (!name) { dlg.querySelector('#bd-name').focus(); return; }
          close({
            name,
            day: dlg.querySelector('#bd-date').value,
            calendarId: dlg.querySelector('#bd-cal').value,
            remind: dlg.querySelector('#bd-remind').value,
          });
        });
        setTimeout(() => dlg.querySelector('#bd-name')?.focus(), 40);
      },
    });
    if (!input) return null;
    carry = input;

    const draft = {
      title: `${input.name}’s birthday`,
      isAllDay: true,
      startDate: input.day,
      endDate: input.day,
      // Google's rules for the type, not decoration.
      eventType: 'birthday',
      recurrence: ['RRULE:FREQ=YEARLY'],
      transparency: 'transparent',
      visibility: 'private',
      attendees: [],
      notifyGuests: false,
      ...(input.remind !== ''
        ? { useDefaultReminders: false, reminders: [{ minutes: Number(input.remind) }] }
        : {}),
    };

    try {
      const r = await ctx.api('/calendar/events/propose-create', {
        method: 'POST', body: { requestId: uid(), calendarId: input.calendarId, draft },
      });
      const done = await confirmProposal(r.proposal, { confirmLabel: 'Add birthday' });
      if (done === 'back') continue;
      return done;
    } catch (e) {
      ctx.toast(e.message, true);
      continue;
    }
  }
}

/* ══ Edit and delete ═════════════════════════════════════════════════════ */

/** Which occurrences a change to a repeating event should touch. */
async function askScope(verb) {
  const pick = await modal({
    title: 'This event repeats',
    body: `<p class="ev-sub">${esc(verb)} just this one, or the whole series?</p>`,
    actions: `<button class="btn btn-ghost" data-close="cancel">Cancel</button>
      <button class="btn" data-scope="series">Every event</button>
      <button class="btn btn-primary" data-scope="instance">Only this one</button>`,
    onMount: (dlg, close) => {
      dlg.querySelectorAll('[data-scope]').forEach((b) => {
        b.addEventListener('click', () => close(b.dataset.scope));
      });
    },
  });
  return pick === true ? 'instance' : pick;
}

export async function openEventEditor(ev) {
  const state = await writeState();
  if (!state) { ctx.toast('Could not reach Life OS.', true); return null; }
  if (!state.canWrite) { await blockedByConnection(state); return null; }

  const scope = ev.recurringEventId || ev.recurrence ? await askScope('Change') : 'single';
  if (!scope) return null;

  const start = ev.startsAt ? new Date(ev.startsAt) : new Date();
  const end = ev.endsAt ? new Date(ev.endsAt) : new Date(start.getTime() + 3600000);
  let carry = {
    title: ev.title ?? '',
    calendarId: state.writable.find((c) => c.name === ev.calendarName)?.id
      ?? state.defaultCalendarId,
    day: ev.isAllDay ? (ev.startDate ?? isoDay(start)) : isoDay(start),
    time: hhmm(start),
    duration: Math.max(15, Math.round((end - start) / 60000)),
    isAllDay: !!ev.isAllDay,
    location: ev.location ?? '',
    description: ev.description ?? '',
    attendees: (ev.attendees ?? []).map((a) => a.email).filter(Boolean),
  };

  for (;;) {
    const input = await modal({
      title: 'Edit event',
      body: composerHtml(state, carry),
      actions: foot('Review change'),
      onMount: (dlg, close) => {
        // The calendar cannot move in this pass; Google treats that as a move.
        const sel = dlg.querySelector('#ev-cal');
        if (sel) { sel.disabled = true; sel.title = 'Moving an event between calendars is not supported yet.'; }
        const ui = wireComposer(dlg, carry);
        dlg.querySelector('[data-go]').addEventListener('click', () => {
          const read = readComposer(dlg, ui);
          if (!read.draft.title) { dlg.querySelector('#ev-title')?.focus(); return; }
          close(read);
        });
      },
    });
    if (!input) return null;
    carry = { ...carry, ...backToForm(input) };

    let proposal;
    try {
      const r = await ctx.api(`/calendar/events/${ev.id}/propose-update`, {
        method: 'POST',
        body: { requestId: uid(), draft: input.draft, scope },
      });
      proposal = r.proposal;
    } catch (e) {
      ctx.toast(e.message, true);
      continue;
    }
    const done = await confirmProposal(proposal, { confirmLabel: 'Update event' });
    if (done === 'back') continue;
    return done;
  }
}

export async function deleteCalendarEvent(ev) {
  const state = await writeState();
  if (!state) { ctx.toast('Could not reach Life OS.', true); return null; }
  if (!state.canWrite) { await blockedByConnection(state); return null; }

  const scope = ev.recurringEventId || ev.recurrence ? await askScope('Delete') : 'single';
  if (!scope) return null;

  try {
    const r = await ctx.api(`/calendar/events/${ev.id}/propose-delete`, {
      method: 'POST', body: { requestId: uid(), scope },
    });
    return confirmProposal(r.proposal, { confirmLabel: 'Delete event' });
  } catch (e) {
    ctx.toast(e.message, true);
    return null;
  }
}

/**
 * Schedule a Task.
 *
 * The Task stays a Task. This creates an event and LINKS them — it does not
 * convert one into the other, which is why completing the task later does not
 * erase the hour it took, and cancelling the event does not mean the work is
 * done.
 */
export async function addTaskToCalendar(task, project = null) {
  const day = task.scheduledAt ? isoDay(new Date(task.scheduledAt))
    : task.dueDate ? String(task.dueDate).slice(0, 10) : undefined;
  return openEventComposer({
    title: task.title,
    day,
    duration: task.estimatedMinutes && task.estimatedMinutes >= 15
      ? Math.min(180, task.estimatedMinutes) : 60,
    description: project ? `Project: ${project.title}` : undefined,
    taskId: task.id,
  });
}
