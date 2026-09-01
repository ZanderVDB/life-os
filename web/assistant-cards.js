/**
 * Proposal cards — one renderer, both surfaces.
 *
 * Desktop and phone show the same cards because they are the same decision:
 * what is about to change, what was assumed on your behalf, and what you can
 * correct before agreeing. Two implementations would drift, and the one that
 * drifted would be the one somebody trusted.
 *
 * ── The presentation table is not a capability list ──────────────────────
 *
 * `PRESENTATION` says how to draw a card for kinds this client knows well. It
 * is NOT authoritative about what exists — `GET /ai/capabilities` is — and
 * anything absent from it renders from the server's own label. That is what
 * keeps a new module usable the day it registers, without a client release.
 */
import { icon } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * How a card is titled, per capability this client draws specially.
 *
 * Presentation only. Adding a row here makes a card prettier; leaving one out
 * costs nothing but a generic heading.
 */
const PRESENTATION = {
  'task.create': { label: 'Create task', glyph: 'check' },
  'task.update': { label: 'Update task', glyph: 'pencil' },
  'task.complete': { label: 'Complete', glyph: 'check' },
  'task.schedule': { label: 'Schedule', glyph: 'calendar' },
  'task.move': { label: 'Move task', glyph: 'pencil' },
  'task.archive': { label: 'Archive task', glyph: 'pencil' },
  'task.addStep': { label: 'Add step', glyph: 'check' },
  'task.updateStep': { label: 'Change step', glyph: 'pencil' },
  'task.removeStep': { label: 'Remove step', glyph: 'pencil' },
  'project.create': { label: 'New project', glyph: 'projects' },
  'project.update': { label: 'Project', glyph: 'projects' },
  'project.complete': { label: 'Complete project', glyph: 'projects' },
  'project.archive': { label: 'Archive project', glyph: 'projects' },
  'event.create': { label: 'Calendar', glyph: 'calendar' },
  'event.update': { label: 'Move event', glyph: 'calendar' },
  'event.delete': { label: 'Delete event', glyph: 'calendar' },
  'reminder.create': { label: 'Reminder', glyph: 'calendar' },
  'reminder.update': { label: 'Reminder', glyph: 'calendar' },
  'reminder.complete': { label: 'Reminder done', glyph: 'check' },
  'reminder.setPaused': { label: 'Reminder', glyph: 'calendar' },
  'reminder.delete': { label: 'Delete reminder', glyph: 'calendar' },
  'habit.check': { label: 'Habit', glyph: 'check' },
  'habit.create': { label: 'New habit', glyph: 'check' },
  'habit.update': { label: 'Habit', glyph: 'pencil' },
  'habit.archive': { label: 'Archive habit', glyph: 'pencil' },
  'diary.append': { label: 'Write in Diary', glyph: 'library' },
  'diary.checkIn': { label: 'Diary check-in', glyph: 'library' },
  'library.appendPage': { label: 'Write to Book', glyph: 'library' },
  'library.createPage': { label: 'New page', glyph: 'library' },
  'area.create': { label: 'New area', glyph: 'projects' },
  'area.update': { label: 'Area', glyph: 'pencil' },
  'area.delete': { label: 'Remove area', glyph: 'pencil' },
  'link.create': { label: 'Link', glyph: 'sparkle' },
  'link.remove': { label: 'Unlink', glyph: 'sparkle' },
};

/** The heading for a card, falling back to the module when the kind is new. */
export function cardLabel(action) {
  return PRESENTATION[action.capability]?.label
    ?? `${action.module.charAt(0).toUpperCase()}${action.module.slice(1)}`;
}

const glyphFor = (action) => PRESENTATION[action.capability]?.glyph ?? 'sparkle';

/**
 * One proposal, as a card.
 *
 * `unavailable` is passed when the capability has gone away since the plan was
 * made — a disconnected Google account, a removed module. The card still shows
 * what was meant; it just cannot be run, and says so instead of offering a
 * button that would fail.
 */
export function actionCardHtml(action, { unavailable = false, reason = null } = {}) {
  const off = !action.enabled || unavailable;
  return `<article class="ap ${off ? 'is-off' : ''} ${action.important ? 'is-important' : ''}"
      data-action="${esc(action.id)}">
    <header class="ap-head">
      <span class="ap-kind">${icon(glyphFor(action), 13)} ${esc(cardLabel(action))}</span>
      ${action.important && !unavailable
    ? '<span class="ap-flag">Needs your confirmation</span>' : ''}
      ${unavailable
    ? '<span class="ap-flag ap-gone">Not available now</span>'
    : `<label class="ap-on">
        <input type="checkbox" ${action.enabled ? 'checked' : ''} data-toggle="${esc(action.id)}">
        <span class="sr-only">Include this change</span></label>`}
    </header>

    <p class="ap-title">${esc(action.title)}</p>
    ${action.summary ? `<p class="ap-sum">${esc(action.summary)}</p>` : ''}
    ${/* Why, not just no. "Capability unavailable" tells nobody anything;
          "I can see that meeting, but calendar changes aren't available right
          now" is the same fact and is actionable. The sentence comes from the
          SERVER, which is the only thing that knows whether Life OS never had
          this, the account is disconnected, or the grant cannot write. */ ''}
    ${unavailable && reason ? `<p class="ap-gone-why">${esc(reason)}</p>` : ''}

    ${action.editable?.length ? `<div class="ap-fields">${action.editable.map((f) => `
      <button type="button" class="ap-field" data-field="${esc(action.id)}" data-key="${esc(f.key)}">
        <span class="ap-flabel">${esc(f.label)}</span>
        <span class="ap-fvalue">${esc(f.value ?? '—')}</span>
        ${icon('pencil', 14)}
      </button>`).join('')}</div>` : ''}

    ${/* An interpretation made on the user's behalf, in plain words, on the
          card where it can be corrected. This is what lets a medium-confidence
          reading be a proposal instead of a question. */ ''}
    ${action.assumptions?.length ? `<ul class="ap-assume">${action.assumptions
    .map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}

    ${action.warnings?.length ? `<ul class="ap-warn">${action.warnings
    .map((w) => `<li>${icon('sparkle', 13)} ${esc(w)}</li>`).join('')}</ul>` : ''}
  </article>`;
}

/**
 * The sources an answer used.
 *
 * Quiet by default and clickable. An answer that cannot say what it read is an
 * answer nobody can check — but a citation report under every sentence is
 * noise, so this is one line of chips.
 */
export function sourcesHtml(sources = [], { limit = 5 } = {}) {
  const list = sources.slice(0, limit);
  if (!list.length) return '';
  return `<div class="ap-src">
    <span class="ap-src-l">Used</span>
    ${list.map((s) => `<button type="button" class="ap-src-i"
      data-src-type="${esc(s.ref.type)}" data-src-id="${esc(s.ref.id)}">
      ${esc(s.title)}</button>`).join('')}
    ${sources.length > limit ? `<span class="ap-src-more">+${sources.length - limit}</span>` : ''}
  </div>`;
}

/**
 * The one genuinely necessary question.
 *
 * Shown INSTEAD of guessing, and only when the server said so — several
 * meetings match and moving the wrong one is not recoverable. Everything
 * unambiguous in the same request is still proposed alongside it.
 *
 * ── The id, not the label ────────────────────────────────────────────────
 *
 * `data-clarify` carries the OPTION ID. The server holds what each option
 * stands for, so choosing one continues the original request with an exact
 * entity. It used to carry the label, which was then sent back as a fresh
 * sentence for the planner to re-interpret — asking a model to work out a
 * second time something that was known precisely the first time, and losing
 * the answer in the round trip.
 *
 * The line under each label is what tells two things called "Invoice" apart.
 * It is built from what was already retrieved, so it costs nothing.
 */
export function clarificationHtml(clarification) {
  if (!clarification) return '';
  return `<div class="ap-ask">
    <p class="ap-ask-q">${esc(clarification.question)}</p>
    <div class="ap-ask-opts">
      ${clarification.options.map((o) => `<button type="button" class="btn btn-ghost ap-ask-o"
        data-clarify="${esc(o.id)}"${o.ref ? ` data-clarify-type="${esc(o.ref.type)}"` : ''}>
        <span class="ap-ask-l">${esc(o.label)}</span>
        ${o.detail ? `<span class="ap-ask-d">${esc(o.detail)}</span>` : ''}
      </button>`).join('')}
    </div>
  </div>`;
}

/**
 * What actually happened, in the same language the cards used.
 *
 * Three of four succeeding is three things that happened. It is never reported
 * as a failure, and a failure is never reported as a success.
 */
export function resultsHtml(report) {
  const rows = (report.results ?? []).filter((r) => r.status !== 'skipped');
  return `<div class="ap-done ${report.failed ? 'has-fail' : ''}">
    <p class="ap-done-h">${esc(report.headline ?? 'Done')}</p>
    <ul class="ap-done-l">
      ${rows.map((r) => `<li class="${r.status === 'done' ? 'ok' : 'bad'}">
        ${icon(r.status === 'done' ? 'check' : 'sparkle', 14)}
        <span>${esc(r.message)}</span></li>`).join('')}
    </ul>
  </div>`;
}

export { esc };
