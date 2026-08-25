/**
 * The Life OS dropdown.
 *
 * A native <select> draws its option list with the OPERATING SYSTEM. No CSS
 * reaches it — `color-scheme: dark` restyles the closed control and nothing
 * else — so every native menu in a dark app opens as a bright white sheet with
 * text that is barely readable. That is not a Calendar problem; it is true
 * wherever one appears.
 *
 * So this is the rule now: if Life OS owns the dropdown UI, it uses this
 * component. It began life inside the Calendar's field library, which is why
 * the class prefix is still `cf-`; the behaviour was never Calendar-specific.
 *
 * It gives back what a native select gives for free and what a naive div does
 * not: roles and aria-selected, arrow keys, Home/End, type-ahead, Escape,
 * Enter/Space, focus return to the trigger, and the chosen option scrolled
 * into view.
 *
 * SCOPE: the second argument is the element the panel is positioned inside and
 * clamped to — a dialog in the Calendar, a page region in Settings. It must be
 * `position: relative` (or fixed), and it owns exactly one popover host, so
 * two controls can never both believe they are open.
 */
import { anchor } from './pickers.js';
import { isPhone, openSheet } from './mobile.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The one floating surface per dialog, shared by the date picker, the time
 * picker and every dropdown.
 *
 * One host means one set of placement rules and one stacking context to get
 * right — and it makes "two menus open at once" impossible rather than merely
 * unlikely. It is appended to the DIALOG, not to the scrolling body, so a
 * panel can never be clipped by the modal's own overflow.
 */
export function popoverHost(dlg) {
  let pop = dlg.querySelector('[data-cf-pop]');
  if (pop) return pop;
  pop = document.createElement('div');
  pop.className = 'cf-pop';
  pop.dataset.cfPop = '';
  pop.hidden = true;
  /* Clicks inside the popover never reach the dialog.
   *
   * The pickers re-render themselves on every choice, which DETACHES the
   * element that was clicked. By the time the click bubbles up, the
   * outside-click check sees a node the popover no longer contains and closes
   * it — so choosing an hour dismissed the picker before a minute could be
   * chosen, and nothing was ever committed. */
  pop.addEventListener('click', (e) => e.stopPropagation());
  /* WHO has it open lives on the host, not in each wiring's own closure.
   *
   * wireDateTime and wireMenus share this element. When each kept its own
   * `openFor`, closing a dropdown left the date picker still believing it was
   * open — so the next click on the date field was read as "click the thing
   * that is already open", which closes it, and the picker appeared dead until
   * you clicked a second time. One owner, one truth. */
  pop.__owner = null;
  dlg.appendChild(pop);
  return pop;
}


/** Closes whatever the shared popover is showing, whoever opened it. */
export function closePopover(dlg) {
  const pop = dlg.querySelector('[data-cf-pop]');
  if (!pop) return;
  pop.hidden = true;
  pop.innerHTML = '';
  if (pop.__owner) pop.__owner.setAttribute?.('aria-expanded', 'false');
  pop.__owner = null;
}


export const selectField = (id, options, value, label) => {
  const chosen = options.find((o) => (o.id ?? o.value ?? '') === (value ?? '')) ?? options[0];
  return `<button type="button" class="cf-ctl cf-menu-btn" id="${id}" data-cf-menu
    data-value="${esc(chosen?.id ?? chosen?.value ?? '')}"
    data-options="${esc(JSON.stringify(options))}"
    aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label ?? '')}">
    ${chosen?.mark ? `<i class="cf-menu-mark" style="background:${esc(chosen.mark)}"></i>` : ''}
    <span class="cf-menu-text" data-cf-menu-text>${esc(chosen?.label ?? '')}</span>
    <i class="cf-chev" aria-hidden="true"></i>
  </button>`;
};


/**
 * Wires every shared dropdown inside `root`.
 *
 * `onChange(id, value)` fires only when the value actually changes — a menu
 * that reports a change for re-picking what was already chosen makes every
 * listener defensive.
 */
export function wireMenus(root, dlg, onChange) {
  const pop = popoverHost(dlg);

  const close = (focusBack = false) => {
    const owner = pop.__owner;
    closePopover(dlg);
    if (focusBack && owner) owner.focus();
  };

  const choose = (btn, opt) => {
    const before = btn.dataset.value;
    btn.dataset.value = opt.id ?? opt.value ?? '';
    const text = btn.querySelector('[data-cf-menu-text]');
    if (text) text.textContent = opt.label ?? '';
    const mark = btn.querySelector('.cf-menu-mark');
    if (mark && opt.mark) mark.style.background = opt.mark;
    close(true);
    if (before === btn.dataset.value) return;
    onChange?.(btn.id, btn.dataset.value, opt);
    /* Also announce it as a real DOM event.
     *
     * A single `onChange` belongs to whoever wired the control first, and
     * wiring is idempotent — so the recurrence builder, wired second, never
     * heard about its own dropdowns and left its sentence describing the
     * previous choice. An event has no owner and any number of listeners. */
    btn.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const open = (btn) => {
    if (pop.__owner === btn) return close();
    close();

    let options = [];
    try { options = JSON.parse(btn.dataset.options || '[]'); } catch { options = []; }
    const current = btn.dataset.value;

    /* ── On a phone, a dropdown is a sheet ────────────────────────────────
     *
     * §38 asks for ONE dropdown grammar. On a phone that grammar is already
     * the sheet: More is a sheet, Quick add is a sheet, editing a proposal's
     * field is a sheet. A menu anchored to its control would be a second one.
     *
     * It also removes the whole class of clipping problems by construction.
     * An anchored popover has to be measured against the dialog, the
     * viewport, and — once a software keyboard is up — a visual viewport
     * that is a different size again. A sheet is attached to the bottom of
     * the screen and there is nothing left to get wrong. */
    if (isPhone()) {
      btn.setAttribute('aria-expanded', 'true');
      openSheet({
        title: btn.getAttribute('aria-label') || 'Choose',
        body: options.map((o, i) => {
          const v = o.id ?? o.value ?? '';
          const on = v === current;
          return `<button type="button" class="msheet-row cf-sheet-opt" data-i="${i}"
            ${o.disabled ? 'disabled' : ''} ${on ? 'aria-current="page"' : ''}>
            ${o.mark ? `<i class="cf-menu-mark" style="background:${esc(o.mark)}"></i>` : ''}
            <span><span class="msheet-label">${esc(o.label ?? '')}</span>
              ${o.hint ? `<span class="msheet-row-desc">${esc(o.hint)}</span>` : ''}</span>
            ${on ? '<span class="msheet-r cf-menu-tick" aria-hidden="true"></span>' : ''}
          </button>`;
        }).join(''),
        onClose: () => btn.setAttribute('aria-expanded', 'false'),
        onMount: (rootEl, closeSheetFn) => {
          rootEl.querySelectorAll('[data-i]').forEach((el) => {
            el.onclick = () => {
              const opt = options[Number(el.dataset.i)];
              closeSheetFn();
              // `choose` closes the anchored popover, which is not open here;
              // that is a no-op, and the value write and the change event are
              // the same ones the desktop path takes.
              choose(btn, opt);
            };
          });
        },
      });
      return undefined;
    }

    pop.__owner = btn;
    btn.setAttribute('aria-expanded', 'true');

    pop.innerHTML = `<div class="cf-menu" role="listbox" tabindex="-1"
      aria-label="${esc(btn.getAttribute('aria-label') ?? '')}">
      ${options.map((o, i) => {
    const v = o.id ?? o.value ?? '';
    const on = v === current;
    return `<button type="button" role="option" class="cf-menu-opt${on ? ' is-on' : ''}"
          data-i="${i}" aria-selected="${on}"${o.disabled ? ' disabled aria-disabled="true"' : ''}>
          ${o.mark ? `<i class="cf-menu-mark" style="background:${esc(o.mark)}"></i>` : ''}
          <span class="cf-menu-l">${esc(o.label ?? '')}</span>
          ${o.hint ? `<span class="cf-menu-h">${esc(o.hint)}</span>` : ''}
          ${on ? '<i class="cf-menu-tick" aria-hidden="true"></i>' : ''}
        </button>`;
  }).join('')}
    </div>`;
    pop.hidden = false;
    anchor(pop, dlg, btn);

    const panel = pop.querySelector('.cf-menu');
    const opts = [...panel.querySelectorAll('.cf-menu-opt:not([disabled])')];
    let at = Math.max(0, opts.findIndex((o) => o.classList.contains('is-on')));

    const focusAt = (i) => {
      at = Math.max(0, Math.min(opts.length - 1, i));
      opts[at]?.focus();
    };

    panel.addEventListener('click', (e) => {
      const b = e.target.closest('.cf-menu-opt');
      if (!b || b.disabled) return;
      choose(btn, options[Number(b.dataset.i)]);
    });
    panel.addEventListener('keydown', (e) => {
      const keys = {
        ArrowDown: () => focusAt(at + 1),
        ArrowUp: () => focusAt(at - 1),
        Home: () => focusAt(0),
        End: () => focusAt(opts.length - 1),
      };
      if (keys[e.key]) { e.preventDefault(); keys[e.key](); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const b = document.activeElement.closest?.('.cf-menu-opt');
        if (b && !b.disabled) choose(btn, options[Number(b.dataset.i)]);
        return;
      }
      // Type-ahead, which a native select gives for free.
      if (e.key.length === 1 && /\S/.test(e.key)) {
        const from = opts.findIndex((o, i) => i > at
          && o.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase()));
        const wrap = opts.findIndex((o) => o.textContent.trim().toLowerCase()
          .startsWith(e.key.toLowerCase()));
        const next = from > -1 ? from : wrap;
        if (next > -1) { e.preventDefault(); focusAt(next); }
      }
    });
    // Keep the chosen option in view without moving the modal behind it.
    const on = panel.querySelector('.is-on');
    if (on) panel.scrollTop = Math.max(0, on.offsetTop - panel.clientHeight / 2 + 16);
    focusAt(at);
  };

  root.querySelectorAll('[data-cf-menu]').forEach((btn) => {
    /* Wire each control ONCE, however many times this is called.
     *
     * The recurrence builder is rendered with the composer and wired again by
     * wireRecurrence when it appears, so its dropdowns ended up with two
     * handlers: the first opened the panel and the second immediately saw
     * "this one is already open" and closed it. The control looked completely
     * dead. Calling a wiring function twice should be harmless, not silently
     * destructive. */
    if (btn.dataset.cfWired) return;
    btn.dataset.cfWired = '1';
    btn.addEventListener('click', (e) => { e.stopPropagation(); open(btn); });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(btn);
      }
    });
  });

  dlg.addEventListener('click', (e) => {
    if (pop.__owner && !e.target.closest('[data-cf-menu]')) close();
  });

  return {
    close,
    valueOf: (id) => root.querySelector(`#${id}`)?.dataset.value ?? '',
    setOptions: (id, options, value) => {
      const btn = root.querySelector(`#${id}`);
      if (!btn) return;
      btn.dataset.options = JSON.stringify(options);
      const chosen = options.find((o) => (o.id ?? o.value ?? '') === value) ?? options[0];
      if (chosen) choose(btn, chosen);
    },
  };
}
