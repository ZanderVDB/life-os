/**
 * Projects — overview and detail.
 *
 * The architecture is shaped by one requirement: a project that changes status
 * or focus must MOVE, and the same DOM node has to survive the move or there is
 * nothing to animate. So this module never rebuilds the list from a template
 * string after an ordinary mutation. `applyGroups` reconciles — it finds the
 * existing row, patches its contents in place, and moves the node into its new
 * group. That is what makes the FLIP in app.js possible, and it is the lesson
 * from C4, where a FLIP was written after the list already rebuilt itself and
 * ran on nodes that no longer existed.
 *
 * Rendering rules that are not negotiable:
 *   · No count is shown unless it supports a decision.
 *   · No dot or colour is unlabelled.
 *   · An empty state says what is missing and what to do, never "Nothing here".
 */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The filter model. Small enough to read, not a matrix of every combination. */
export const PROJECT_FILTERS = [
  { id: 'working', label: 'Working' },
  { id: 'planning', label: 'Planning' },
  { id: 'someday', label: 'Someday' },
  { id: 'on_hold', label: 'On hold' },
  { id: 'completed', label: 'Completed' },
  { id: 'archived', label: 'Archived' },
];

export const STATUS_LABEL = {
  planning: 'Planning', active: 'Active', on_hold: 'On hold', completed: 'Completed',
};
export const FOCUS_LABEL = { now: 'Now', upcoming: 'Upcoming', someday: 'Someday' };

const fmtDate = (iso) => (iso
  ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  : '');

/**
 * Progress, in words first.
 *
 * "4 of 9 done" rather than 44%: a percentage alone hides whether it is 4/9 or
 * 400/900, and those are different situations. No tasks reports nothing planned
 * rather than 0% — 0% claims a measurement that has not been made.
 */
export function progressText(p) {
  const g = p.progress ?? { total: 0, done: 0, cancelled: 0 };
  if (p.status === 'completed') {
    const bits = [`${g.done} completed`];
    if (g.cancelled) bits.push(`${g.cancelled} cancelled`);
    return `Completed ${fmtDate(String(p.completedAt ?? '').slice(0, 10))} · ${bits.join(' · ')}`;
  }
  if (g.total === 0) return 'Nothing planned yet';
  return `${g.done} of ${g.total} done`;
}

/* ── Overview ─────────────────────────────────────────────────────────── */

export function projectsHeaderHtml(filter, available = {}) {
  return `<div class="pj-head">
    <div class="pj-head-row">
      <h1>Projects</h1>
      <div class="pj-head-side">
        <button class="cal-add" id="pj-new" aria-haspopup="dialog">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg>
          <span>New project</span>
        </button>
      </div>
    </div>
    <div class="pj-filters" role="tablist" aria-label="Project filters">
      ${PROJECT_FILTERS.map((f) => {
    // The count is here to answer "is there anything behind this filter?" —
    // a decision — not to report a total for its own sake.
    const n = f.id === 'working' ? null : available[f.id];
    return `<button role="tab" class="pj-filter ${f.id === filter ? 'is-on' : ''}"
          data-pj-filter="${f.id}" aria-selected="${f.id === filter}">
          ${f.label}${n ? `<span class="pj-fcount">${n}</span>` : ''}
        </button>`;
  }).join('')}
    </div>
  </div>`;
}

export const projectsBodyHtml = () => '<div class="pj-list" id="pj-list"></div>';

/**
 * One row.
 *
 * Priority of information, top to bottom: what it is, what to do next, what it
 * is for. Metadata never outranks the next action — the next action is the
 * reason you are reading the row.
 */
export function projectRowHtml(p, areaName) {
  const health = p.health?.[0] ?? null;
  const area = p.areaId ? areaName(p.areaId) : null;
  const next = p.nextAction;

  return `<article class="pj-row" data-id="${p.id}" tabindex="0"
      aria-label="${esc(p.title)}">
    <div class="pj-main">
      <div class="pj-title-row">
        <button class="pj-title" data-pj-open="${p.id}">${esc(p.title)}</button>
        ${health ? `<span class="pj-health" title="${esc(health.why)}">${esc(health.label)}</span>` : ''}
      </div>
      ${p.outcome ? `<p class="pj-outcome">${esc(p.outcome)}</p>` : ''}
      <div class="pj-next">
        ${next
    ? `<span class="pj-next-lbl">Next</span><span class="pj-next-t">${esc(next.title)}</span>`
    : '<span class="pj-next-none">No next action — add one</span>'}
      </div>
    </div>
    <div class="pj-side">
      <span class="pj-progress">${esc(progressText(p))}</span>
      <div class="pj-marks">
        ${area ? `<span class="pj-area">${esc(area)}</span>` : ''}
        <span class="pj-state">${esc(STATUS_LABEL[p.status] ?? p.status)}</span>
        ${p.status !== 'completed'
    ? `<span class="pj-focus">${esc(FOCUS_LABEL[p.focus] ?? p.focus)}</span>` : ''}
        ${p.targetDate && p.status !== 'completed'
    ? `<span class="pj-target">by ${esc(fmtDate(p.targetDate))}</span>` : ''}
      </div>
      <button class="util-btn pj-more" data-pj-menu="${p.id}" aria-haspopup="menu"
        aria-expanded="false" aria-label="Actions for ${esc(p.title)}">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/>
          <circle cx="15.5" cy="10" r="1.5"/></svg>
      </button>
    </div>
  </article>`;
}

/**
 * Reconciles the rendered list against new data WITHOUT rebuilding it.
 *
 * Rows are looked up by id across the whole list, so a project that moved from
 * Now to On hold keeps its node and can be animated from one group to the
 * other. Groups are created and removed as they become non-empty and empty —
 * "Needs attention" exists only when it has something to say.
 *
 * Returns nothing; the caller wraps it in flip() to animate the result.
 */
export function applyGroups(container, groups, areaName) {
  const existing = new Map();
  container.querySelectorAll('.pj-row').forEach((el) => existing.set(el.dataset.id, el));
  const seen = new Set();
  const host = document.createElement('div');

  for (const g of groups) {
    if (!g.projects.length) continue;
    let section = container.querySelector(`.pj-group[data-group="${g.id}"]`);
    if (!section) {
      section = document.createElement('section');
      section.className = 'pj-group';
      section.dataset.group = g.id;
      section.innerHTML = `<h2 class="pj-group-h">${esc(g.label)}</h2>`
        + '<div class="pj-group-rows"></div>';
    }
    container.appendChild(section);
    const rows = section.querySelector('.pj-group-rows');

    for (const p of g.projects) {
      seen.add(p.id);
      let row = existing.get(p.id);
      if (row) {
        // Patch in place. Replacing innerHTML on the ROW is fine — the row
        // itself is what has to survive for the move to animate.
        host.innerHTML = projectRowHtml(p, areaName);
        const fresh = host.firstElementChild;
        row.className = fresh.className;
        row.innerHTML = fresh.innerHTML;
        row.setAttribute('aria-label', fresh.getAttribute('aria-label'));
      } else {
        host.innerHTML = projectRowHtml(p, areaName);
        row = host.firstElementChild;
        row.classList.add('is-entering');
      }
      // appendChild MOVES an existing node rather than copying it.
      rows.appendChild(row);
    }
  }

  // Anything the new data no longer contains.
  for (const [id, el] of existing) if (!seen.has(id)) el.remove();
  // Groups that emptied out.
  container.querySelectorAll('.pj-group').forEach((s) => {
    if (!s.querySelector('.pj-row')) s.remove();
  });
}

/**
 * The empty states. Each one says what is missing and offers the way out —
 * "Nothing here" when the system knows exactly why is a shrug.
 */
export function projectsEmptyHtml(filter, available = {}) {
  if (filter === 'working') {
    const elsewhere = (available.someday ?? 0) + (available.planning ?? 0)
      + (available.on_hold ?? 0) + (available.completed ?? 0);
    if (elsewhere > 0) {
      return `<div class="pj-empty">
        <span class="pj-empty-t">Nothing active right now</span>
        <span class="pj-empty-s">You have ${elsewhere} project${elsewhere === 1 ? '' : 's'}
          filed under another filter — planning, someday, on hold or completed.</span>
        <button class="btn" data-pj-filter="planning">See them</button>
      </div>`;
    }
    return `<div class="pj-empty">
      <span class="pj-empty-t">No projects yet</span>
      <span class="pj-empty-s">A project is a finite outcome that needs more than one
        action, and enough context that you would lose the thread without somewhere
        to keep it. If you would not need to re-read anything after three weeks away,
        it is probably a task.</span>
      <button class="btn btn-primary" id="pj-empty-new">Create a project</button>
    </div>`;
  }
  const words = {
    planning: 'Nothing in planning', someday: 'Nothing filed for someday',
    on_hold: 'Nothing on hold', completed: 'Nothing completed yet',
    archived: 'Nothing archived',
  };
  return `<div class="pj-empty">
    <span class="pj-empty-t">${esc(words[filter] ?? 'Nothing here')}</span>
    <button class="btn" data-pj-filter="working">Back to working</button>
  </div>`;
}

/* ── Detail ───────────────────────────────────────────────────────────── */

export function projectDetailHeaderHtml(p, areaName) {
  const area = p.areaId ? areaName(p.areaId) : null;
  return `<div class="pj-head pjd-head">
    <div class="pj-head-row">
      <div class="pjd-left">
        <button class="rv-back" id="pjd-back">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5-5 5 5 5"/></svg>
          <span>Projects</span>
        </button>
        <h1>${esc(p.title)}</h1>
      </div>
      <div class="pj-head-side">
        <button class="util-btn" id="pjd-menu" aria-haspopup="menu" aria-expanded="false"
          aria-label="Project actions">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="4.5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/>
            <circle cx="15.5" cy="10" r="1.5"/></svg>
        </button>
      </div>
    </div>
    ${p.outcome ? `<p class="pjd-outcome">${esc(p.outcome)}</p>` : ''}
    <div class="pjd-meta">
      ${area ? `<span class="pj-area">${esc(area)}</span>` : ''}
      <label class="pjd-sel"><span class="sr-only">Status</span>
        <select id="pjd-status">
          ${['planning', 'active', 'on_hold'].map((s) => `<option value="${s}"
            ${p.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}
          ${p.status === 'completed' ? '<option value="completed" selected>Completed</option>' : ''}
        </select></label>
      <label class="pjd-sel"><span class="sr-only">Focus</span>
        <select id="pjd-focus">
          ${Object.entries(FOCUS_LABEL).map(([v, l]) => `<option value="${v}"
            ${p.focus === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      ${p.targetDate ? `<span class="pj-target">Target ${esc(fmtDate(p.targetDate))}</span>` : ''}
      <span class="pj-progress" id="pjd-progress">${esc(progressText(p))}</span>
    </div>
    ${p.health?.length ? `<div class="pjd-health">
      ${p.health.map((h) => `<span class="pj-health" title="${esc(h.why)}">${esc(h.label)}</span>
        <span class="pjd-health-why">${esc(h.why)}</span>`).join('')}
    </div>` : ''}
  </div>`;
}

/**
 * The body: next action, tasks, notes. Nothing else.
 *
 * No empty Boards, Resources, Timeline, Calendar or History sections. A section
 * that exists to promise a feature is a section the app cannot honour.
 */
export function projectDetailBodyHtml(p, tasks, taskHtml) {
  const open = tasks.filter((t) => t.status === 'open');
  const closed = tasks.filter((t) => t.status !== 'open');
  const next = p.nextAction;

  return `<div class="pjd-body">
    <section class="pjd-sec pjd-next-sec">
      <h2 class="pjd-sec-h">Next action</h2>
      <div class="pjd-next" id="pjd-next">
        ${next
    ? `<span class="pjd-next-t">${esc(next.title)}</span>
           ${next.explicit ? '<span class="pjd-next-tag">chosen</span>' : ''}
           <button class="btn btn-ghost btn-sm" id="pjd-next-clear">
             ${next.explicit ? 'Use the automatic one' : 'Choose a different one'}</button>`
    : `<span class="pj-next-none">No next action — add one</span>
           <button class="btn btn-sm" id="pjd-next-add">Add a task</button>`}
      </div>
    </section>

    <section class="pjd-sec">
      <div class="pjd-sec-head">
        <h2 class="pjd-sec-h">Tasks</h2>
        <button class="btn btn-sm" id="pjd-add-task">Add task</button>
      </div>
      <div class="pjd-tasks" id="pjd-tasks">
        ${open.length
    ? open.map((t) => taskHtml(t)).join('')
    : '<div class="pj-empty pj-empty-inline"><span class="pj-empty-t">Nothing planned yet</span>'
      + '<span class="pj-empty-s">Add the first thing that has to happen.</span></div>'}
      </div>
      ${closed.length ? `<details class="pjd-done">
        <summary>${closed.length} finished</summary>
        <div class="pjd-tasks">${closed.map((t) => taskHtml(t)).join('')}</div>
      </details>` : ''}
    </section>

    <section class="pjd-sec">
      <div class="pjd-sec-head">
        <h2 class="pjd-sec-h">Notes</h2>
        <span class="pjd-save" id="pjd-save" data-state="idle"></span>
      </div>
      <textarea class="pjd-notes" id="pjd-notes" rows="8"
        placeholder="Context you would need after three weeks away.">${esc(p.notes ?? '')}</textarea>
    </section>
  </div>`;
}
