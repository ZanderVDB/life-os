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

/**
 * Anchors a popover to a control, clamped inside the dialog.
 *
 * Exported because every Calendar dropdown now uses it: one placement rule
 * means a menu never appears somewhere unrelated, and never covers the trigger
 * that opened it unless there is genuinely no room below.
 */
export function anchor(pop, dlg, btn) {
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

/* ══ Time ════════════════════════════════════════════════════════════════
 *
 * Hours and minutes as two short columns, not one list of every quarter hour
 * in the day. The list version was 96 rows deep: finding 14:30 in it meant
 * scrolling past ninety other times that were not 14:30, and every one of them
 * looked identical.
 *
 * Minutes go in fives, which is finer than the old quarter hours and still
 * only twelve options. Typing stays supported for anything else.
 */

/** 12- or 24-hour, from the locale, decided once so nothing disagrees. */
export const uses12Hour = (() => {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' })
      .resolvedOptions().hour12 ?? false;
  } catch { return false; }
})();

/** The one way a time is written in this app. */
export function formatTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  if (!uses12Hour) return `${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m || 0).padStart(2, '0')} ${suffix}`;
}

/** "9", "930", "9:30", "2:30pm", "14:30" → "14:30". Anything else: null. */
export function parseTime(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return null;
  const pm = /p/.test(t);
  const am = /a/.test(t);
  const digits = t.replace(/[^0-9:.]/g, '').replace('.', ':');
  if (!digits) return null;
  let h; let m = 0;
  if (digits.includes(':')) {
    const [a, b] = digits.split(':');
    h = Number(a); m = Number(b || 0);
  } else if (digits.length <= 2) {
    h = Number(digits);
  } else {
    h = Number(digits.slice(0, digits.length - 2));
    m = Number(digits.slice(-2));
  }
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

/**
 * @param {object} [opts] { allowClear, clearLabel }
 */
export function timePickerPopover(pop, dlg, btn, value, onPick, opts = {}) {
  const current = parseTime(value);
  let h = current ? Number(current.slice(0, 2)) : 9;
  let m = current ? Number(current.slice(3, 5)) : 0;

  const hours = uses12Hour
    ? Array.from({ length: 12 }, (_, i) => (i === 0 ? 12 : i))
    : Array.from({ length: 24 }, (_, i) => i);

  const commit = () => onPick(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  const displayHour = () => (uses12Hour ? (h % 12 === 0 ? 12 : h % 12) : h);
  const isPm = () => h >= 12;

  const paint = () => {
    pop.innerHTML = `<div class="tp" role="application" aria-label="Choose a time">
      <div class="tp-typed">
        <input class="tp-in" value="${formatTime(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)}"
          aria-label="Time" inputmode="numeric" autocomplete="off">
      </div>
      <div class="tp-cols">
        <div class="tp-col" role="listbox" aria-label="Hour" data-col="h">
          ${hours.map((x) => `<button type="button" role="option" data-h="${x}"
            aria-selected="${x === displayHour()}"
            class="tp-opt${x === displayHour() ? ' is-sel' : ''}"
            >${String(x).padStart(2, '0')}</button>`).join('')}
        </div>
        <div class="tp-col" role="listbox" aria-label="Minute" data-col="m">
          ${MINUTES.map((x) => `<button type="button" role="option" data-m="${x}"
            aria-selected="${x === m}"
            class="tp-opt${x === m ? ' is-sel' : ''}"
            >${String(x).padStart(2, '0')}</button>`).join('')}
        </div>
        ${uses12Hour ? `<div class="tp-col tp-mer" role="listbox" aria-label="AM or PM">
          ${['am', 'pm'].map((x) => `<button type="button" role="option" data-mer="${x}"
            aria-selected="${(x === 'pm') === isPm()}"
            class="tp-opt${(x === 'pm') === isPm() ? ' is-sel' : ''}">${x.toUpperCase()}</button>`).join('')}
        </div>` : ''}
      </div>
      <div class="tp-foot">
        ${opts.allowClear ? `<button type="button" class="tp-clear" data-clear
          >${opts.clearLabel ?? 'Any time'}</button>` : '<span></span>'}
        <button type="button" class="tp-done" data-done>Done</button>
      </div>
    </div>`;
    wire();
  };

  function wire() {
    pop.querySelectorAll('[data-h]').forEach((b) => {
      b.onclick = () => {
        const picked = Number(b.dataset.h);
        h = uses12Hour
          ? (isPm() ? (picked % 12) + 12 : picked % 12)
          : picked;
        paint();
      };
    });
    pop.querySelectorAll('[data-m]').forEach((b) => {
      b.onclick = () => { m = Number(b.dataset.m); paint(); };
    });
    pop.querySelectorAll('[data-mer]').forEach((b) => {
      b.onclick = () => {
        const wantPm = b.dataset.mer === 'pm';
        if (wantPm !== isPm()) h = wantPm ? h + 12 : h - 12;
        paint();
      };
    });
    pop.querySelector('[data-clear]')?.addEventListener('click', () => onPick(''));
    pop.querySelector('[data-done]')?.addEventListener('click', commit);

    // Typing wins over clicking: it is faster for anyone who knows the time.
    const input = pop.querySelector('.tp-in');
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const parsed = parseTime(input.value);
      if (!parsed) { input.classList.add('is-bad'); return; }
      onPick(parsed);
    });
    input.addEventListener('input', () => input.classList.remove('is-bad'));

    // Keep the chosen option in view without scrolling the whole dialog.
    pop.querySelectorAll('.tp-col').forEach((col) => {
      const sel = col.querySelector('.is-sel');
      if (sel) col.scrollTop = Math.max(0, sel.offsetTop - col.clientHeight / 2 + 14);
    });
  }

  paint();
  anchor(pop, dlg, btn);
  pop.querySelector('.tp-in')?.focus();
  pop.querySelector('.tp-in')?.select();
}

export { iso as isoDate, parseIso as parseIsoDate, MONTHS };
