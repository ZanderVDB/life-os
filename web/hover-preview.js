/**
 * Month hover previews.
 *
 * Native `title` tooltips are not used anywhere: they are unstyled, appear
 * after an OS-controlled delay nobody can tune, cannot show structure, and are
 * invisible to keyboard users. This is a real popover with the same content on
 * hover and on focus, so a keyboard user gets exactly what a mouse user gets.
 *
 * Placement rule: never cover the thing being previewed. The popover prefers
 * the space to the right of the target, flips left when it would overflow, and
 * clamps vertically inside the viewport. Touch never triggers it — on a touch
 * device tapping a day opens the real selected-day rail, which is the actual
 * affordance.
 */
import { reducedMotion, settle } from './motion.js';

const OPEN_DELAY = 320;    // long enough that scanning the grid does not flicker
const CLOSE_DELAY = 140;   // short, but survives crossing a 1px gap
const GAP = 10;

let el = null;
let openTimer = null;
let closeTimer = null;
let current = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ensure() {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'hov';
  el.setAttribute('role', 'tooltip');
  el.id = 'cal-hover';
  el.hidden = true;
  document.body.appendChild(el);
  // Moving the pointer into the popover keeps it open, so it can hold content
  // worth reading rather than vanishing the moment you look at it.
  el.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  el.addEventListener('pointerleave', () => scheduleClose());
  return el;
}

function place(target) {
  const t = target.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;

  // Prefer the right of the target; flip left if it would overflow.
  let left = t.right + GAP;
  if (left + w > window.innerWidth - 8) left = t.left - w - GAP;
  // Still no room either side (narrow window): sit below and centre.
  if (left < 8) left = Math.max(8, Math.min(t.left, window.innerWidth - w - 8));

  let top = t.top + t.height / 2 - h / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function show(target, html) {
  ensure();
  el.innerHTML = html;
  el.hidden = false;
  place(target);
  target.setAttribute('aria-describedby', 'cal-hover');
  current = target;
  if (!reducedMotion()) {
    el.animate([{ opacity: 0, translate: '0 4px' }, { opacity: 1, translate: '0 0' }],
      { duration: 160, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
}

function hide() {
  if (!el || el.hidden) return;
  current?.removeAttribute('aria-describedby');
  current = null;
  const done = () => { el.hidden = true; el.innerHTML = ''; };
  if (reducedMotion()) return done();
  settle(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in' }),
    120, done);
}

function scheduleClose() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  closeTimer = setTimeout(hide, CLOSE_DELAY);
}

/**
 * @param {object} render
 *   day(dayIso)   -> html for a populated day, or null to skip
 *   event(id)     -> html for one event
 */
export function initHoverPreview(render) {
  const openFor = (target, html, delay = OPEN_DELAY) => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (!html) return;
    openTimer = setTimeout(() => show(target, html), delay);
  };

  document.addEventListener('pointerover', (e) => {
    // Touch and pen do not get hover previews — tapping a day opens the rail.
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const ev = e.target.closest?.('[data-event][data-hover="event"]');
    if (ev) return openFor(ev, render.event(ev.dataset.event));
    const day = e.target.closest?.('.cm-cell');
    if (day) return openFor(day, render.day(day.dataset.day));
  }, true);

  document.addEventListener('pointerout', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    if (e.relatedTarget && el?.contains(e.relatedTarget)) return;
    if (e.target.closest?.('.cm-cell,[data-hover="event"]')) scheduleClose();
  }, true);

  // Keyboard parity: focusing a day shows the same preview, immediately.
  document.addEventListener('focusin', (e) => {
    const day = e.target.closest?.('.cm-cell');
    if (day) openFor(day, render.day(day.dataset.day), 0);
    else if (current) hide();
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.closest?.('.cm-cell')) scheduleClose();
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  // Any scroll or resize invalidates the anchor, so close rather than drift.
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}

/** Closes immediately — used when the canvas is about to be replaced. */
export function closeHoverPreview() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  if (el) { el.hidden = true; el.innerHTML = ''; current = null; }
}

export { esc as hovEsc };
