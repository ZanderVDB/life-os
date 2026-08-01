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
 * One workspace, two filters. See the note on FILTERS for why the other three
 * were removed rather than kept for completeness.
 */
/*
 * Two filters, not five.
 *
 * "Recurring" was a tab that repeated what every card already says on its own
 * face. "Completed" was misleading: ticking one occurrence of a monthly
 * reminder does not complete the rule, so a Completed tab implied an ending
 * that had not happened. "Overdue" is a state of an active occurrence, not a
 * kind of reminder — it belongs as a badge inside Active.
 *
 * What is left is the only distinction that changes what a reminder DOES:
 * whether it is still firing.
 */
const FILTERS = [
  { id: 'active', label: 'Active' },
  { id: 'paused', label: 'Paused' },
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
  if (filter === 'paused') return list.filter((r) => r.status === 'paused');
  // Active = every rule still firing. A completed one-off drops out; a
  // recurring rule whose occurrence you ticked stays, because the rule did not
  // end when the occurrence did.
  return list.filter((r) => r.status !== 'paused' && !(r.status === 'done' && !r.recurrence))
    .sort((a, b) => {
      // Overdue first — it is the only thing here that needs acting on today.
      if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
      return (a.nextOccurrence ?? '9999').localeCompare(b.nextOccurrence ?? '9999');
    });
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
        <span class="rv-rule">${esc(r.recurrenceText ?? 'Once')}</span>
        ${r.nextOccurrence && !done ? `<span class="rv-next">
          Next: ${esc(prettyFull(r.nextOccurrence))}${rel ? ` · ${esc(rel)}` : ''}</span>` : ''}
        ${r.dueTime ? `<span class="rv-time">${esc(r.dueTime)}</span>` : ''}
        ${area ? `<span class="rv-area">${esc(area)}</span>` : ''}
        ${r.isOverdue ? `<span class="rv-badge">Overdue${r.nextOccurrence
          ? ` · ${esc(prettyFull(r.dueDate))}` : ''}</span>` : ''}
        ${paused ? '<span class="rv-status">Paused</span>' : ''}
      </span>
    </button>

    <div class="rv-actions">
      ${!done ? `<button class="rv-act" data-rv-pause="${r.id}"
        title="${paused ? 'Resume' : 'Pause'}">${paused ? 'Resume' : 'Pause'}</button>` : ''}
      <button class="rv-act" data-rv-edit="${r.id}">Edit</button>
    </div>
  </div>`;
}

const emptyTitle = (f) => (f === 'paused' ? 'Nothing paused' : 'No reminders yet');
const emptyBody = (f) => (f === 'paused'
  ? 'A paused reminder keeps its rule and its history but stops appearing on the calendar.'
  : 'Add one and it will show its rule and its next date here.');

export { FILTERS as REMINDER_FILTERS, filterReminders };
