/**
 * The Area inspector.
 *
 * Areas were the one linkable thing with nowhere to look. Settings lists them
 * for bulk work — rename, add, remove — and a list is the wrong place to show
 * what a single area is connected to: seven areas each with their own Related
 * section turns a settings screen into a relationship browser, which is
 * exactly what it must not become.
 *
 * So this is the smallest surface that makes one area inspectable: what it is
 * called, how much lives in it, and what it is connected to. Deliberately NOT
 * a page — an area is a label rather than a place, and giving it a route would
 * create a second Today filtered by one tag.
 */
import { reducedMotion, settle } from './motion.js';

const RISE_IN = [{ opacity: 0, translate: '0 10px', scale: '0.985' },
  { opacity: 1, translate: '0 0', scale: '1' }];
const RISE_OUT = [{ opacity: 1, translate: '0 0', scale: '1' },
  { opacity: 0, translate: '0 6px', scale: '0.99' }];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),'
  + 'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** One stat, or nothing at all when the number is not known yet. */
const stat = (n, one, many) => (n === null || n === undefined ? '' : `
  <div class="h-stat"><span class="n">${n}</span>
    <span class="l">${n === 1 ? one : many}</span></div>`);

/**
 * @param {object} ctx { area, counts, onSave, onDelete }
 *   counts: { tasks, projects, habits, reminders } — any may be null when the
 *   list behind it has not loaded, and a null is shown as nothing rather than
 *   as a zero. "0 tasks" while the tasks are still arriving is a wrong number,
 *   not a neutral placeholder.
 */
export function openAreaModal(ctx) {
  const { area: a, counts = {} } = ctx;
  const opener = document.activeElement;
  document.querySelector('.modal-scrim')?.remove();

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  const dlg = document.createElement('div');
  dlg.className = 'modal modal-narrow';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', `Area: ${a.name}`);

  const stats = stat(counts.tasks, 'task', 'tasks')
    + stat(counts.projects, 'project', 'projects')
    + stat(counts.habits, 'habit', 'habits')
    + stat(counts.reminders, 'reminder', 'reminders');

  dlg.innerHTML = `
    <div class="m-head">
      <textarea id="ar-name" class="m-title" rows="1" aria-label="Area name"
        ${a.isSystem ? 'readonly' : ''}>${esc(a.name)}</textarea>
      <button class="m-close" id="ar-close" aria-label="Close">&times;</button>
    </div>

    <div class="m-body">
      ${stats ? `<div class="h-stats">${stats}</div>` : ''}

      <p class="m-note">${a.isSystem
    ? 'A built-in area. Life OS files things into it, so its name is fixed.'
    : 'Renaming an area never moves the work inside it.'}</p>

      <!-- The point of this surface. An area is a label, and what a label is
           connected to is the only thing about it worth inspecting. -->
      <div class="rel-host" data-rel-host="area:${esc(a.id)}"></div>
    </div>

    <div class="m-foot">
      ${a.isSystem ? '' : '<button class="btn btn-ghost m-danger" id="ar-del">Remove</button>'}
      <span class="m-save-state" id="ar-state" role="status"></span>
      <button class="btn" id="ar-cancel">Close</button>
      ${a.isSystem ? '' : '<button class="btn btn-primary" id="ar-save">Save</button>'}
    </div>`;

  document.body.append(scrim, dlg);
  document.body.classList.add('modal-open');
  if (!reducedMotion()) {
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    dlg.animate(RISE_IN, { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  const name = dlg.querySelector('#ar-name');
  const grow = () => { name.style.height = 'auto'; name.style.height = `${name.scrollHeight}px`; };
  name.addEventListener('input', grow); grow();

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
    return undefined;
  }
  document.addEventListener('keydown', onKey, true);
  scrim.onclick = close;
  dlg.querySelector('#ar-close').onclick = close;
  dlg.querySelector('#ar-cancel').onclick = close;

  const state = dlg.querySelector('#ar-state');
  dlg.querySelector('#ar-save')?.addEventListener('click', async () => {
    const next = name.value.trim();
    if (!next) { name.focus(); state.textContent = 'A name is needed'; return; }
    if (next === a.name) { close(); return; }
    state.textContent = 'Saving…';
    try { await ctx.onSave({ name: next }); close(); }
    catch (e) { state.textContent = e.message; }
  });

  dlg.querySelector('#ar-del')?.addEventListener('click', async () => {
    await ctx.onDelete?.();
    close();
  });

  return { close };
}
