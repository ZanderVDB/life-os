/**
 * Read-only detail sheet.
 *
 * Used for things Life OS can show but not change — currently Google Calendar
 * events. It looks deliberately unlike the editors: no input shells, no Save,
 * no footer full of actions. The absence of a form is the message.
 *
 * A greyed-out Edit button would be worse than none. It suggests the
 * capability exists and is merely unavailable right now, when in fact Life OS
 * holds read-only access by design and asking for more requires your consent.
 */
import { reducedMotion, settle } from './motion.js';

const RISE_IN = [{ opacity: 0, translate: '0 10px', scale: '0.985' },
  { opacity: 1, translate: '0 0', scale: '1' }];
const RISE_OUT = [{ opacity: 1, translate: '0 0', scale: '1' },
  { opacity: 0, translate: '0 6px', scale: '0.99' }];

const FOCUSABLE = 'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {object} ctx
 *   title, accent, rows [[label, value]], meetLink, externalLink, note
 */
export function openDetailSheet(ctx) {
  const opener = document.activeElement;
  document.querySelector('.modal-scrim')?.remove();

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  const dlg = document.createElement('div');
  dlg.className = 'modal modal-detail';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', ctx.title || 'Details');

  dlg.innerHTML = `
    <div class="m-head dt-head">
      <span class="dt-accent" style="background:${esc(ctx.accent || 'var(--accent)')}"></span>
      <h2 class="dt-title">${esc(ctx.title)}</h2>
      <button class="m-close" id="dt-close" aria-label="Close">&times;</button>
    </div>

    <div class="m-body dt-body">
      <dl class="dt-rows">
        ${(ctx.rows ?? []).map(([label, value]) => `
          <div class="dt-row">
            <dt>${esc(label)}</dt>
            <dd>${esc(value).replace(/\n/g, '<br>')}</dd>
          </div>`).join('')}
      </dl>
      ${ctx.note ? `<p class="dt-note">${esc(ctx.note)}</p>` : ''}
      <!-- What this is connected to. A type and an id, nothing more: app.js
           fills it, so a sheet does not need to know the relationship layer
           exists in order to show one. -->
      ${ctx.relatedHost ? `<div class="rel-host" data-rel-host="${esc(ctx.relatedHost)}"></div>` : ''}
    </div>

    <div class="m-foot dt-foot">
      ${ctx.meetLink ? `<a class="btn dt-meet" href="${esc(ctx.meetLink)}"
        target="_blank" rel="noopener">Join Google Meet</a>` : ''}
      ${ctx.externalLink ? `<a class="btn btn-ghost" href="${esc(ctx.externalLink)}"
        target="_blank" rel="noopener">Open in Google Calendar</a>` : ''}
      ${(ctx.actions ?? []).map((a, i) => `<button
        class="btn ${a.primary ? 'btn-primary' : ''}" data-dt-action="${i}">${esc(a.label)}</button>`).join('')}
      <button class="btn ${(ctx.actions ?? []).length ? '' : 'btn-primary'}" id="dt-done">Close</button>
    </div>`;

  document.body.append(scrim, dlg);
  document.body.classList.add('modal-open');
  if (!reducedMotion()) {
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    dlg.animate(RISE_IN, { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('modal-open');
    const done = () => { scrim.remove(); dlg.remove(); };
    if (reducedMotion()) done();
    else {
      scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in' });
      settle(dlg.animate(RISE_OUT, { duration: 160, easing: 'cubic-bezier(.4,0,.9,.4)' }), 160, done);
    }
    // Focus returns to the event that opened this, so the calendar keeps its place.
    if (opener?.isConnected) opener.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
    if (e.key !== 'Tab') return;
    const items = [...dlg.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const [first, last] = [items[0], items[items.length - 1]];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKey, true);
  scrim.onclick = close;
  dlg.querySelector('#dt-close').onclick = close;
  dlg.querySelector('#dt-done').onclick = close;
  /* Actions are for records the app CAN change — Life OS records, and now
   * Google events on writable calendars.
   *
   * `onSelect` is accepted alongside `onClick` because a caller passing the
   * wrong one of two plausible names got silence: the button rendered, the
   * click ran `undefined()`, and Edit and Delete simply did nothing. A handler
   * that is missing is worth a console error, not a shrug. */
  dlg.querySelectorAll('[data-dt-action]').forEach((b) => {
    b.onclick = () => {
      const action = ctx.actions[Number(b.dataset.dtAction)];
      const run = action?.onSelect ?? action?.onClick;
      close();
      if (typeof run !== 'function') {
        console.error('detail sheet action has no handler', action);
        return;
      }
      run();
    };
  });
  dlg.querySelector('#dt-done').focus();

  return { close };
}
