/**
 * The Reminders workspace.
 *
 * Exists because of the discoverability rule locked in D4.5: no feature is
 * complete unless there is an obvious place to find it, understand it, review
 * it and manage it. Reminders were visible on the dates they fell on and
 * nowhere else — you could see an occurrence but never the rule behind it, and
 * there was no answer to "what reminders do I actually have?".
 *
 * This is about RULES, not dates. "Monthly on the 28th" is the thing the user
 * owns; the date it next lands on is a consequence.
 *
 * One workspace with filters, not five pages. Upcoming, Recurring, Overdue,
 * Completed and Paused are views of one list, because they are the same
 * records asked about differently.
 */
const FILTERS = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'recurring', label: 'Recurring' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'paused', label: 'Paused' },
  { id: 'completed', label: 'Completed' },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const parseIso = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const prettyFull = (s) => (s ? parseIso(s).toLocaleDateString(undefined,
  { day: 'numeric', month: 'long', year: 'numeric' }) : null);

/** Relative wording, because "in 3 days" is easier to act on than a date. */
function relativeWords(iso) {
  if (!iso) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((parseIso(iso) - today) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days < 7) return `In ${days} days`;
  return null;
}

export function remindersViewHtml(list, filter, areaName) {
  const shown = filterReminders(list, filter);
  const counts = Object.fromEntries(FILTERS.map((f) =>
    [f.id, filterReminders(list, f.id).length]));

  return `<div class="rv">
    <div class="rv-head">
      <div class="rv-filters" role="tablist" aria-label="Reminder filters">
        ${FILTERS.map((f) => `<button role="tab" class="rv-filter ${f.id === filter ? 'is-on' : ''}"
          data-rv-filter="${f.id}" aria-selected="${f.id === filter}">
          ${f.label}${counts[f.id] ? `<span class="rv-count">${counts[f.id]}</span>` : ''}
        </button>`).join('')}
      </div>
      <button class="btn btn-primary rv-add" id="rv-add">New reminder</button>
    </div>

    ${shown.length ? `<div class="rv-list" role="list">
      ${shown.map((r) => reminderCardHtml(r, areaName)).join('')}
    </div>` : `<div class="rv-empty">
      <span class="rv-empty-t">${esc(emptyTitle(filter))}</span>
      <span class="rv-empty-s">${esc(emptyBody(filter))}</span>
    </div>`}
  </div>`;
}

function filterReminders(list, filter) {
  const today = new Date().toISOString().slice(0, 10);
  switch (filter) {
    case 'recurring': return list.filter((r) => r.recurrence && r.status !== 'done');
    case 'overdue': return list.filter((r) => r.isOverdue);
    case 'paused': return list.filter((r) => r.status === 'paused');
    case 'completed': return list.filter((r) => r.status === 'done');
    default:
      // Upcoming excludes finished and paused: it is a list of things that
      // are actually going to happen.
      return list.filter((r) => r.status !== 'done' && r.status !== 'paused')
        .sort((a, b) => (a.nextOccurrence ?? '9999').localeCompare(b.nextOccurrence ?? '9999'));
  }
}

/**
 * One reminder, expressed as its RULE.
 *
 * "Every Wednesday · Next: 12 August" tells you what you own and when it next
 * lands. Showing only the date would tell you about one occurrence and leave
 * the rule invisible, which is how reminders came to feel untrackable.
 */
function reminderCardHtml(r, areaName) {
  const rel = relativeWords(r.nextOccurrence);
  const area = r.areaId ? areaName(r.areaId) : null;
  const done = r.status === 'done';
  const paused = r.status === 'paused';

  return `<div class="rv-card ${r.isOverdue ? 'is-overdue' : ''} ${done ? 'is-done' : ''}
      ${paused ? 'is-paused' : ''}" role="listitem" data-rv-card="${r.id}">
    <button class="rv-check" data-rv-toggle="${r.id}" aria-pressed="${done}"
      aria-label="${done ? 'Reopen' : 'Complete'} ${esc(r.title)}"></button>

    <button class="rv-body" data-rv-open="${r.id}">
      <span class="rv-title">${esc(r.title)}</span>
      <span class="rv-meta">
        ${r.recurrenceText ? `<span class="rv-rule">${esc(r.recurrenceText)}</span>` : ''}
        ${r.nextOccurrence && !done ? `<span class="rv-next">
          Next: ${esc(prettyFull(r.nextOccurrence))}${rel ? ` · ${esc(rel)}` : ''}</span>` : ''}
        ${r.dueTime ? `<span class="rv-time">${esc(r.dueTime)}</span>` : ''}
        ${area ? `<span class="rv-area">${esc(area)}</span>` : ''}
        <span class="rv-status">${paused ? 'Paused' : done ? 'Completed'
          : r.isOverdue ? 'Overdue' : 'Active'}</span>
      </span>
    </button>

    <div class="rv-actions">
      ${!done ? `<button class="rv-act" data-rv-pause="${r.id}"
        title="${paused ? 'Resume' : 'Pause'}">${paused ? 'Resume' : 'Pause'}</button>` : ''}
      <button class="rv-act" data-rv-edit="${r.id}">Edit</button>
    </div>
  </div>`;
}

const emptyTitle = (f) => ({
  upcoming: 'No reminders coming up',
  recurring: 'Nothing repeats yet',
  overdue: 'Nothing overdue',
  paused: 'Nothing paused',
  completed: 'Nothing completed yet',
}[f] ?? 'Nothing here');

const emptyBody = (f) => ({
  upcoming: 'Add a reminder and it will appear here with its next date.',
  recurring: 'A reminder that repeats will show its rule here.',
  overdue: 'Everything is on schedule.',
  paused: 'Paused reminders keep their history but stop appearing on the calendar.',
  completed: 'Reminders you finish will be listed here.',
}[f] ?? '');

export { FILTERS as REMINDER_FILTERS, filterReminders };
