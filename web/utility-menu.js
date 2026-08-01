/**
 * The utility menu and the contextual surfaces it opens.
 *
 * One component, used by Today and by Calendar. Before this there were four
 * near-identical implementations — Today's overflow, Calendar's overflow, the
 * calendar-sources popover and the calendar key — each with its own trigger
 * geometry, its own anchoring rule and its own close handling. They drifted:
 * one opened left-aligned under its button and another right-aligned, one was
 * 296px wide and another 300px, and none of them knew about the others, so two
 * could sit open at once.
 *
 * The rule this file exists to enforce: a surface's SHELL is a property of the
 * app, not of the feature that opened it. Only the content differs.
 */
import { reducedMotion } from './motion.js';

const GAP = 6;          // trigger → surface
const EDGE = 12;        // surface → viewport edge
const OPEN_MS = 150;

/** The one open utility surface. There is never a second. */
let open = null;

/**
 * The trigger markup, so the two pages cannot drift apart again.
 *
 * They already had: Today drew three dots stacked VERTICALLY and Calendar drew
 * them horizontally, from two hand-written SVGs sitting 2000 lines apart. The
 * shared class made them the same size and the same shape and left them looking
 * like different controls. Horizontal is the one — it is the overflow glyph the
 * rest of the app uses.
 */
export const utilityTriggerHtml = (id, label) => `<button class="util-btn" id="${id}"
  aria-haspopup="menu" aria-expanded="false" aria-label="${label}">
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="4.5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/>
    <circle cx="15.5" cy="10" r="1.5"/></svg>
</button>`;

export const isUtilityOpen = () => !!open;
export const openUtilityKind = () => open?.kind ?? null;

/**
 * Closes whatever utility surface is open.
 *
 * Called by the app on mode change and on navigation as well as by the surface
 * itself — a popover that outlives the thing it described is worse than no
 * popover, because it now describes something else.
 */
export function closeUtility({ focus = false } = {}) {
  if (!open) return;
  const { el, anchor, detach } = open;
  open = null;
  detach();
  el.remove();
  if (anchor?.isConnected) {
    anchor.setAttribute('aria-expanded', 'false');
    if (focus) anchor.focus();
  }
}

/**
 * Places a surface under its trigger.
 *
 * One direction everywhere: below the trigger, right edges aligned. Both
 * triggers live at the upper-right of the page, so a right-aligned surface
 * grows inward, where there is room. The viewport clamps are a fallback for
 * small screens, not a second placement rule.
 */
function place(anchor, el) {
  const b = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.min(Math.max(EDGE, b.right - w), window.innerWidth - w - EDGE);
  const top = Math.min(b.bottom + GAP, Math.max(EDGE, window.innerHeight - h - EDGE));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function entrance(el) {
  if (reducedMotion()) return;
  el.animate([{ opacity: 0, translate: '0 -6px' }, { opacity: 1, translate: '0 0' }],
    { duration: OPEN_MS, easing: 'cubic-bezier(.2,.7,.2,1)' });
}

/** Wires the close behaviour every utility surface shares. */
function attach(anchor, el, kind) {
  const away = (e) => {
    if (el.contains(e.target) || anchor.contains(e.target)) return;
    closeUtility();
  };
  const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeUtility({ focus: true }); } };
  const reflow = () => { if (open?.el === el) place(anchor, el); };
  const detach = () => {
    document.removeEventListener('click', away, true);
    document.removeEventListener('keydown', esc, true);
    window.removeEventListener('resize', reflow);
    window.removeEventListener('scroll', reflow, true);
  };
  // Deferred: the click that opened this must not immediately close it.
  setTimeout(() => {
    document.addEventListener('click', away, true);
    document.addEventListener('keydown', esc, true);
  }, 0);
  window.addEventListener('resize', reflow);
  window.addEventListener('scroll', reflow, true);
  open = { el, anchor, detach, kind };
  anchor.setAttribute('aria-expanded', 'true');
}

/**
 * The overflow menu.
 *
 * @param {Element} anchor the `.util-btn` that opened it
 * @param {{id:string,label:string,icon?:string,count?:number|string}[]} items
 * @param {(id:string) => void} onSelect
 */
export function openUtilityMenu(anchor, items, onSelect) {
  if (open?.anchor === anchor && open.kind === 'menu') { closeUtility({ focus: true }); return; }
  closeUtility();

  const el = document.createElement('div');
  el.className = 'menu util-menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = items.map((it) => `<button role="menuitem" data-util="${it.id}">
    ${it.icon ?? ''}<span>${it.label}</span>
    ${it.count ? `<span class="tm-count">${it.count}</span>` : ''}</button>`).join('');
  document.body.appendChild(el);

  place(anchor, el);
  entrance(el);
  attach(anchor, el, 'menu');

  el.querySelectorAll('[data-util]').forEach((b) => {
    b.onclick = () => {
      const { util } = b.dataset;
      closeUtility();
      onSelect(util);
    };
  });
  el.querySelector('button')?.focus();
}

/**
 * The contextual surface — Calendar sources, Calendar key, anything later.
 *
 * Opening a second kind while one is showing replaces the CONTENT inside the
 * existing shell rather than closing a box here and opening a differently
 * shaped box somewhere else. The shell keeps its top edge and eases to the new
 * height, so switching reads as one surface changing its mind.
 *
 * @param {Element} anchor
 * @param {{kind:string, label:string, html:string, wire?:(el:Element) => void}} content
 */
export function openUtilitySurface(anchor, { kind, label, html, wire }) {
  if (open?.kind === kind) { closeUtility({ focus: true }); return; }

  // Switching between kinds: same shell, new contents.
  if (open && open.el.classList.contains('util-surface')) {
    return swapSurface(open.el, { kind, label, html, wire });
  }

  closeUtility();
  const el = document.createElement('div');
  el.className = 'util-surface';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', label);
  el.dataset.surface = kind;
  el.innerHTML = `<div class="us-body">${html}</div>`;
  document.body.appendChild(el);

  place(anchor, el);
  entrance(el);
  attach(anchor, el, kind);
  wire?.(el);
  el.querySelector('button, input, [tabindex]')?.focus();
  return el;
}

/** Content crossfade inside a shell that keeps its position. */
function swapSurface(el, { kind, label, html, wire }) {
  const from = el.offsetHeight;
  const oldBody = el.querySelector('.us-body');
  const next = document.createElement('div');
  next.className = 'us-body';
  next.innerHTML = html;

  el.setAttribute('aria-label', label);
  el.dataset.surface = kind;
  if (open) open.kind = kind;

  if (reducedMotion()) {
    oldBody.replaceWith(next);
    wire?.(el);
    return el;
  }

  // Measure the new height before committing to it, so the shell can ease
  // rather than jump when the two surfaces are different lengths.
  oldBody.replaceWith(next);
  const to = el.offsetHeight;
  wire?.(el);
  if (from !== to) {
    el.animate([{ height: `${from}px` }, { height: `${to}px` }],
      { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
  next.animate([{ opacity: 0 }, { opacity: 1 }],
    { duration: 160, easing: 'cubic-bezier(.2,.7,.2,1)' });
  return el;
}
