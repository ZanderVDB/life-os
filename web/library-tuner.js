/**
 * THE BOOK TUNER — a staging-only live tuning panel (S2.1).
 *
 * S2 parameterised the resting Book. This makes those parameters adjustable
 * without a deployment between adjustments: move a slider, watch the REAL
 * Library shelf change, keep going until it looks right, copy the numbers out.
 *
 * ── What it is ───────────────────────────────────────────────────────────
 *
 * A handful of `<input type=range>` controls that each write ONE custom property
 * onto `document.documentElement`. That is the whole mechanism. The tokens are
 * declared on `:root` in the stylesheet, so an inline style on the same element
 * wins, and every rule that consumes them updates on the next frame without any
 * JavaScript touching the shelf.
 *
 * ── What it is not ───────────────────────────────────────────────────────
 *
 * It is not a preview. It drives the real `#library` — the real Diary Book, the
 * real Books, the real Documents beside them, real hover, real pull, real turn.
 * Choosing the direction was what the design lab was for; this is for judging
 * the implementation on the display it will actually be seen on.
 *
 * It writes nothing. No request, no database, no localStorage, no settings. A
 * reload returns to the committed defaults, and that is the intended behaviour:
 * the values that survive are the ones the user sends back to be committed.
 */

/** The controls. `css` is the property each one drives. */
const CONTROLS = [
  { key: 'gap', css: '--lib-book-gap', label: 'Gap', unit: 'px',
    min: 0, max: 14, step: 1, def: 0, group: 'primary' },
  { key: 'lean', css: '--lib-book-lean', label: 'Lean  ← →', unit: 'deg',
    min: -6, max: 6, step: 0.5, def: 0, group: 'primary' },
  /* Negative tips the Book FORWARD instead of back, showing its tail rather
   * than its head — the other side of the same control. */
  { key: 'tilt', css: '--lib-book-top-tilt', label: 'Tilt  ↑ ↓', unit: 'deg',
    min: -10, max: 10, step: 0.5, def: -4, group: 'primary' },
  /* The one that swings the back edge round toward you. */
  { key: 'yaw', css: '--lib-book-yaw', label: 'Turn out  ↻', unit: 'deg',
    min: -12, max: 12, step: 0.5, def: -6, group: 'primary' },
  { key: 'depth', css: '--lib-book-depth', label: 'Book depth', unit: 'px',
    min: 0, max: 16, step: 1, def: 0, group: 'primary' },
  { key: 'grain', css: '--lib-page-grain', label: 'Page grain', unit: 'deg',
    min: 0, max: 90, step: 90, def: 90, group: 'advanced' },
  { key: 'hover', css: '--lib-book-hover', label: 'Hover lift', unit: 'px',
    min: 0, max: 14, step: 1, def: 8, group: 'advanced' },
  { key: 'pull', css: '--lib-book-pull', label: 'Pull distance', unit: 'px',
    min: 20, max: 48, step: 2, def: 32, group: 'advanced' },
  { key: 'turn', css: '--d-turn', label: 'Turn duration', unit: 'ms',
    min: 250, max: 650, step: 25, def: 400, group: 'advanced' },
  { key: 'neighbours', css: '--lib-book-neighbour', label: 'Neighbour clearance', unit: 'px',
    min: 0, max: 28, step: 2, def: 16, group: 'advanced' },
];

/** Starting points, not recommendations (§12). Advanced values are untouched. */
const PRESETS = {
  Subtle: { gap: 4, lean: 1, tilt: 2, yaw: 0, depth: 4 },
  Current: { gap: 0, lean: 0, tilt: -4, yaw: -6, depth: 0 },
  Physical: { gap: 7, lean: 3, tilt: 6, yaw: 4, depth: 9 },
};

const value = {};
CONTROLS.forEach((c) => { value[c.key] = c.def; });

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Writes one token. This is the only thing that touches the page.
 *
 * Note what it does NOT do: it never re-renders a shelf, never re-reads the
 * Library, never touches an object. A slider drag repaints the Books because
 * CSS recomputed, not because anything was rebuilt (§7).
 */
function apply(key) {
  const c = CONTROLS.find((x) => x.key === key);
  document.documentElement.style.setProperty(c.css, `${value[key]}${c.unit}`);
}
const applyAll = () => CONTROLS.forEach((c) => apply(c.key));

/** `gap 5px, lean 2deg, …` — the line the user sends back. */
const summaryLine = () => CONTROLS
  .map((c) => `${c.key} ${value[c.key]}${c.unit}`).join(', ');

/** The same thing as declarations, ready to paste into the token block. */
const cssLines = () => CONTROLS
  .map((c) => `${c.css}: ${value[c.key]}${c.unit};`).join('\n');

/**
 * Observations, not judgements (§23). Shown only when they apply, so the panel
 * is quiet while the numbers are ordinary.
 */
function notes() {
  const out = [];
  if (value.hover >= value.pull) out.push('Hover is currently as strong as Pull.');
  if (value.tilt >= 8) out.push('High tilt may soften spine text.');
  if (value.gap >= 11) out.push('This may read more like a display than a shelf.');
  if (value.depth === 0) out.push('Book will appear flatter.');
  if (Math.abs(value.yaw) >= 9) out.push('At this turn the spine title foreshortens sharply.');
  if (value.neighbours === 0) out.push('Neighbours will not make room for a pulled Book.');
  return out;
}

const row = (c) => `<label class="tn-row" data-row="${c.key}">
    <span class="tn-name">${esc(c.label)}</span>
    <input type="range" class="tn-slide" data-tune="${c.key}"
      min="${c.min}" max="${c.max}" step="${c.step}" value="${c.def}"
      aria-label="${esc(c.label)}">
    <span class="tn-num">
      <input type="number" class="tn-input" data-tune-num="${c.key}"
        min="${c.min}" max="${c.max}" step="${c.step}" value="${c.def}"
        aria-label="${esc(c.label)} value">
      <em>${c.unit}</em>
    </span>
  </label>`;

const panelHtml = () => `<div class="tn-head">
    <b>Book Tuner</b>
    <span class="tn-tag">staging</span>
    <button type="button" class="tn-x" data-tune-collapse
      aria-expanded="true" aria-label="Collapse the Book Tuner">–</button>
  </div>
  <div class="tn-body" id="tn-body">
    <div class="tn-presets">
      ${Object.keys(PRESETS).map((p) => `<button type="button" class="tn-preset"
        data-preset="${esc(p)}">${esc(p)}</button>`).join('')}
    </div>
    ${CONTROLS.filter((c) => c.group === 'primary').map(row).join('')}
    <details class="tn-adv">
      <summary>Advanced</summary>
      ${CONTROLS.filter((c) => c.group === 'advanced').map(row).join('')}
    </details>
    <p class="tn-note" id="tn-notes"></p>
    <p class="tn-help">Hover a Book to test hover · click once to pull and turn ·
      press Escape to put it back.</p>
    <div class="tn-out">
      <b>Current configuration</b>
      <textarea class="tn-copy" id="tn-copy" rows="2" readonly
        aria-label="Current configuration"></textarea>
      <pre class="tn-css" id="tn-css"></pre>
      <div class="tn-acts">
        <button type="button" class="tn-btn" data-tune-copy>Copy configuration</button>
        <button type="button" class="tn-btn" data-tune-reset>Reset</button>
      </div>
      <span class="tn-said" id="tn-said" role="status"></span>
    </div>
  </div>`;

let panel = null;
let teardown = null;

/** Refreshes only the readouts — never the controls the user is dragging. */
function paintOut() {
  const copy = panel.querySelector('#tn-copy');
  if (copy) copy.value = summaryLine();
  const css = panel.querySelector('#tn-css');
  if (css) css.textContent = cssLines();
  const n = panel.querySelector('#tn-notes');
  if (n) { const list = notes(); n.textContent = list.join(' '); n.hidden = !list.length; }
}

/** Puts both controls for one key in step, without either fighting the other. */
function sync(key, { slider = true, number = true } = {}) {
  if (slider) {
    const s = panel.querySelector(`[data-tune="${key}"]`);
    if (s && Number(s.value) !== value[key]) s.value = String(value[key]);
  }
  if (number) {
    const n = panel.querySelector(`[data-tune-num="${key}"]`);
    if (n && Number(n.value) !== value[key]) n.value = String(value[key]);
  }
}

function set(key, raw, from) {
  const c = CONTROLS.find((x) => x.key === key);
  let v = Number(raw);
  if (!Number.isFinite(v)) return;
  v = Math.min(c.max, Math.max(c.min, v));
  value[key] = v;
  apply(key);
  sync(key, { slider: from !== 'slider', number: from !== 'number' });
  paintOut();
}

/**
 * Mounts the panel. Idempotent: called again, it does nothing, so a Library
 * re-render cannot end up with two of them.
 */
export function mountTuner() {
  if (panel?.isConnected) return;
  panel = document.createElement('aside');
  panel.className = 'tn';
  panel.id = 'book-tuner';
  panel.setAttribute('aria-label', 'Book Tuner, staging only');
  panel.innerHTML = panelHtml();
  document.body.appendChild(panel);
  applyAll();
  paintOut();

  const onInput = (e) => {
    const s = e.target.closest('[data-tune]');
    if (s) { set(s.dataset.tune, s.value, 'slider'); return; }
    const n = e.target.closest('[data-tune-num]');
    if (n) set(n.dataset.tuneNum, n.value, 'number');
  };

  const onClick = (e) => {
    const col = e.target.closest('[data-tune-collapse]');
    if (col) {
      const open = panel.classList.toggle('is-shut');
      col.setAttribute('aria-expanded', String(!open));
      col.textContent = open ? '+' : '–';
      return;
    }
    const pre = e.target.closest('[data-preset]');
    if (pre) {
      const p = PRESETS[pre.dataset.preset];
      Object.entries(p).forEach(([k, v]) => set(k, v));
      return;
    }
    if (e.target.closest('[data-tune-reset]')) {
      CONTROLS.forEach((c) => set(c.key, c.def));
      say('Reset to the committed defaults');
      return;
    }
    if (e.target.closest('[data-tune-copy]')) {
      const box = panel.querySelector('#tn-copy');
      box.select();
      /* Clipboard access can be refused; selecting the text is the fallback that
       * always works, and it is why the value lives in a textarea rather than a
       * span (§10). Either way the user never needs DevTools. */
      navigator.clipboard?.writeText(`${summaryLine()}\n\n${cssLines()}`)
        .then(() => say('Copied'))
        .catch(() => say('Select the text above and copy'));
    }
  };

  const say = (msg) => {
    const el = panel.querySelector('#tn-said');
    if (el) el.textContent = msg;
  };

  panel.addEventListener('input', onInput);
  panel.addEventListener('click', onClick);
  teardown = () => {
    panel.removeEventListener('input', onInput);
    panel.removeEventListener('click', onClick);
  };
}

/** Removes the panel and every override it made, so nothing outlives it. */
export function unmountTuner() {
  teardown?.(); teardown = null;
  CONTROLS.forEach((c) => document.documentElement.style.removeProperty(c.css));
  panel?.remove();
  panel = null;
}

export const tunerOpen = () => Boolean(panel?.isConnected);
export { CONTROLS, PRESETS, summaryLine, cssLines, notes, value as __value };
