/**
 * Shared date and time pickers.
 *
 * Extracted so the Event editor and the Reminder editor cannot drift apart:
 * two hand-rolled date pickers in one product is how you end up with two
 * different ideas of what a week starts on.
 *
 * Both are custom because the native controls were explicitly ruled out — a
 * three-part day/month/year field, a stark white browser calendar popup, and
 * an unstyleable time spinner are all things the design cannot absorb.
 * Keyboard operation is preserved: arrows move by day and week, PageUp/Down by
 * month, Enter picks, Escape closes.
 */

const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  + `-${String(d.getDate()).padStart(2, '0')}`;
const parseIso = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };

function grid(year, month, selected) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;      // Monday-first, like the Month view
  const todayIso = iso(new Date());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - lead + i);
    const v = iso(d);
    cells.push(`<button type="button" class="dp-day${d.getMonth() !== month ? ' is-out' : ''}`
      + `${v === selected ? ' is-sel' : ''}${v === todayIso ? ' is-today' : ''}"`
      + ` data-date="${v}" tabindex="${v === selected ? 0 : -1}">${d.getDate()}</button>`);
  }
  return cells.join('');
}

/** Anchors a popover to a control, clamped inside the dialog. */
function anchor(pop, dlg, btn) {
  const b = btn.getBoundingClientRect();
  const d = dlg.getBoundingClientRect();
  pop.hidden = false;
  const left = Math.max(8, Math.min(b.left - d.left, d.width - pop.offsetWidth - 12));
  const below = b.bottom - d.top + 6;
  // Flip above the control when there is no room below.
  const top = below + pop.offsetHeight > d.height - 8
    ? Math.max(8, b.top - d.top - pop.offsetHeight - 6)
    : below;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

/**
 * @param {HTMLElement} pop   the popover host
 * @param {HTMLElement} dlg   the dialog, used to clamp position
 * @param {HTMLElement} btn   the control that opened it
 * @param {string} value      current 'YYYY-MM-DD'
 * @param {(v: string) => void} onPick
 */
export function datePickerPopover(pop, dlg, btn, value, onPick) {
  const d = value ? parseIso(value) : new Date();
  let year = d.getFullYear();
  let month = d.getMonth();

  const paint = () => {
    pop.innerHTML = `<div class="dp" role="application" aria-label="Choose a date">
      <div class="dp-head">
        <button type="button" class="dp-nav" data-dp="prev" aria-label="Previous month">‹</button>
        <span class="dp-label">${MONTHS[month]} ${year}</span>
        <button type="button" class="dp-nav" data-dp="next" aria-label="Next month">›</button>
      </div>
      <div class="dp-dow">${DOW.map((x) => `<span>${x}</span>`).join('')}</div>
      <div class="dp-grid">${grid(year, month, value)}</div>
      <button type="button" class="dp-today" data-date="${iso(new Date())}">Today</button>
    </div>`;
    wire();
  };

  const step = (delta) => {
    month += delta;
    if (month < 0) { month = 11; year--; } else if (month > 11) { month = 0; year++; }
    paint();
  };

  function wire() {
    pop.querySelectorAll('[data-date]').forEach((el) => {
      el.onclick = () => onPick(el.dataset.date);
    });
    pop.querySelectorAll('[data-dp]').forEach((el) => {
      el.onclick = () => step(el.dataset.dp === 'next' ? 1 : -1);
    });
    // Arrow keys move by day and week, so the grid is usable without a mouse.
    pop.querySelector('.dp-grid').onkeydown = (e) => {
      const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (e.key === 'PageUp') { e.preventDefault(); return step(-1); }
      if (e.key === 'PageDown') { e.preventDefault(); return step(1); }
      const delta = moves[e.key];
      if (!delta) return;
      e.preventDefault();
      const from = e.target.dataset.date ? parseIso(e.target.dataset.date) : new Date();
      from.setDate(from.getDate() + delta);
      const next = pop.querySelector(`[data-date="${iso(from)}"]`);
      if (next) { next.tabIndex = 0; next.focus(); }
      else { step(delta > 0 ? 1 : -1); pop.querySelector(`[data-date="${iso(from)}"]`)?.focus(); }
    };
  }

  paint();
  anchor(pop, dlg, btn);
  pop.querySelector('.dp-day.is-sel,.dp-day.is-today')?.focus();
}

/**
 * @param {object} [opts] { allowClear, clearLabel, step }
 */
export function timePickerPopover(pop, dlg, btn, value, onPick, opts = {}) {
  const step = opts.step ?? 15;
  const rows = [];
  if (opts.allowClear) {
    rows.push(`<button type="button" class="tp-opt tp-clear${!value ? ' is-sel' : ''}"
      data-time="">${opts.clearLabel ?? 'None'}</button>`);
  }
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += step) {
      const v = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      rows.push(`<button type="button" class="tp-opt${v === value ? ' is-sel' : ''}"
        data-time="${v}">${v}</button>`);
    }
  }
  pop.innerHTML = `<div class="tp" role="listbox" aria-label="Choose a time">${rows.join('')}</div>`;
  anchor(pop, dlg, btn);
  pop.querySelectorAll('[data-time]').forEach((o) => {
    o.onclick = () => onPick(o.dataset.time);
  });
  pop.querySelector('.tp-opt.is-sel')?.scrollIntoView({ block: 'center' });
}

export { iso as isoDate, parseIso as parseIsoDate, MONTHS };
