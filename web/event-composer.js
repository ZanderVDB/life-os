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

const DURATIONS = [15, 30, 45, 60, 90, 120, 180];
const REPEATS = [
  { id: '', label: 'Does not repeat' },
  { id: 'RRULE:FREQ=DAILY', label: 'Every day' },
  { id: 'RRULE:FREQ=WEEKLY', label: 'Every week' },
  { id: 'RRULE:FREQ=MONTHLY', label: 'Every month' },
  { id: 'RRULE:FREQ=YEARLY', label: 'Every year' },
];

function composerHtml(state, d) {
  const cals = state.writable ?? [];
  return `<label class="ev-f">
      <span>Title</span>
      <input id="ev-title" value="${esc(d.title ?? '')}" placeholder="What is it?"
        maxlength="500" autocomplete="off">
    </label>

    <label class="ev-f">
      <span>Calendar</span>
      <select id="ev-cal">
        ${cals.map((c) => `<option value="${c.id}"${c.id === d.calendarId ? ' selected' : ''}
          >${esc(c.name)}</option>`).join('')}
      </select>
    </label>
    ${(state.calendars ?? []).some((c) => c.isReadOnly) ? `<p class="ev-sub">
      Read-only calendars are not listed — Google will not accept events on them.</p>` : ''}

    <div class="ev-row">
      <label class="ev-f">
        <span>Date</span>
        <input type="date" id="ev-date" value="${esc(d.day)}">
      </label>
      <label class="ev-f ev-time" ${d.isAllDay ? 'hidden' : ''}>
        <span>Start</span>
        <input type="time" id="ev-start" value="${esc(d.time)}">
      </label>
      <label class="ev-f ev-time" ${d.isAllDay ? 'hidden' : ''}>
        <span>For</span>
        <select id="ev-dur">
          ${DURATIONS.map((m) => `<option value="${m}"${m === d.duration ? ' selected' : ''}
            >${m < 60 ? `${m} min` : `${m / 60} hr${m > 60 ? 's' : ''}`}</option>`).join('')}
        </select>
      </label>
    </div>

    <label class="ev-check">
      <input type="checkbox" id="ev-allday"${d.isAllDay ? ' checked' : ''}>
      <span>All day</span>
    </label>

    <label class="ev-f">
      <span>Where <i>optional</i></span>
      <input id="ev-loc" value="${esc(d.location ?? '')}" maxlength="500">
    </label>

    <label class="ev-f">
      <span>Details <i>optional</i></span>
      <textarea id="ev-desc" rows="2" maxlength="8000">${esc(d.description ?? '')}</textarea>
    </label>

    <details class="ev-more">
      <summary>More</summary>
      <label class="ev-f">
        <span>Guests <i>comma-separated email addresses</i></span>
        <input id="ev-guests" value="${esc((d.attendees ?? []).join(', '))}"
          placeholder="someone@example.com">
      </label>
      <label class="ev-check">
        <input type="checkbox" id="ev-notify">
        <span>Email the guests when this is added</span>
      </label>
      <label class="ev-f">
        <span>Repeats</span>
        <select id="ev-repeat">
          ${REPEATS.map((r) => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('')}
        </select>
      </label>
      <label class="ev-check">
        <input type="checkbox" id="ev-meet">
        <span>Add a Google Meet link</span>
      </label>
    </details>

    <p class="ev-zone">Times are ${esc(localZone())}.</p>`;
}

function readComposer(dlg) {
  const v = (id) => dlg.querySelector(`#${id}`)?.value ?? '';
  const on = (id) => !!dlg.querySelector(`#${id}`)?.checked;
  const day = v('ev-date');
  const time = v('ev-start');
  const mins = Number(v('ev-dur') || 60);
  const end = addMinutes(day, time, mins);
  const isAllDay = on('ev-allday');
  const repeat = v('ev-repeat');
  return {
    calendarId: v('ev-cal'),
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
        const allDay = dlg.querySelector('#ev-allday');
        const times = dlg.querySelectorAll('.ev-time');
        allDay.addEventListener('change', () => {
          times.forEach((t) => { t.hidden = allDay.checked; });
        });
        dlg.querySelector('[data-go]').addEventListener('click', () => {
          const read = readComposer(dlg);
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
        const allDay = dlg.querySelector('#ev-allday');
        const times = dlg.querySelectorAll('.ev-time');
        allDay.addEventListener('change', () => times.forEach((t) => { t.hidden = allDay.checked; }));
        dlg.querySelector('[data-go]').addEventListener('click', () => {
          const read = readComposer(dlg);
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
