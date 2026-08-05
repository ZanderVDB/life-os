/**
 * The Library create/rename form.
 *
 * One small modal for all three creatable types, because they differ only in
 * which fields they ask for. Nothing here is a native dialog — §24 rules those
 * out, and a `window.prompt` cannot be styled, cannot be cancelled with focus
 * restored, and blocks the page while it is open.
 */

import { reducedMotion, settle } from './motion.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const RISE_IN = [{ opacity: 0, transform: 'translate(-50%,-46%) scale(.97)' },
  { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }];
const RISE_OUT = [{ opacity: 1, transform: 'translate(-50%,-50%) scale(1)' },
  { opacity: 0, transform: 'translate(-50%,-48%) scale(.98)' }];

const SHAPES = {
  book: {
    title: 'New Book',
    hint: 'A book arrives with a first section and two pages, so you can start writing.',
    fields: [
      { k: 'title', label: 'Title', required: true, placeholder: 'Field Notes' },
      { k: 'subtitle', label: 'Subtitle', placeholder: 'Optional' },
      { k: 'firstSection', label: 'First section', placeholder: 'Notes' },
    ],
    submit: 'Create book',
  },
  document: {
    title: 'New Document',
    hint: 'Durable written information that does not need a whole book.',
    fields: [
      { k: 'title', label: 'Title', required: true, placeholder: 'Insurance policy notes' },
      { k: 'description', label: 'Description', placeholder: 'Optional', multiline: true },
    ],
    submit: 'Create document',
  },
  link: {
    title: 'Save Link',
    hint: 'A URL worth keeping, so everything else can point at it.',
    fields: [
      { k: 'sourceUrl', label: 'Address', required: true, placeholder: 'https://', type: 'url' },
      { k: 'title', label: 'Title', required: true, placeholder: 'What this is' },
      { k: 'description', label: 'Description', placeholder: 'Optional', multiline: true },
    ],
    submit: 'Save link',
  },
  rename: {
    title: 'Rename',
    hint: '',
    fields: [
      { k: 'title', label: 'Title', required: true },
      { k: 'description', label: 'Description', placeholder: 'Optional', multiline: true },
    ],
    submit: 'Save',
  },
  section: {
    title: 'New section',
    hint: 'A section is a run of pages with its own tab and colour. It arrives '
      + 'with two pages, so the spread is a spread.',
    fields: [{ k: 'title', label: 'Section name', required: true, placeholder: 'Research' }],
    submit: 'Add section',
  },
};

/**
 * @param {'book'|'document'|'link'|'rename'} kind
 * @param {object} [initial] existing values, for rename
 * @returns {Promise<object|null>} the values, or null if cancelled
 */
export function openLibraryForm(kind, initial = {}) {
  const shape = SHAPES[kind];
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    const dlg = document.createElement('div');
    dlg.className = 'modal modal-narrow modal-libform';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', shape.title);
    dlg.innerHTML = `
      <div class="m-head"><h2 class="lf-title">${esc(shape.title)}</h2></div>
      <div class="m-body lf-body">
        ${shape.hint ? `<p class="lf-hint">${esc(shape.hint)}</p>` : ''}
        ${shape.fields.map((f) => `<label class="m-field">
          <span>${esc(f.label)}${f.required ? '' : ' · optional'}</span>
          ${f.multiline
    ? `<textarea class="m-input lf-area" data-k="${f.k}" rows="3"
              placeholder="${esc(f.placeholder ?? '')}">${esc(initial[f.k] ?? '')}</textarea>`
    : `<input class="m-input" data-k="${f.k}" type="${f.type ?? 'text'}"
              value="${esc(initial[f.k] ?? '')}" placeholder="${esc(f.placeholder ?? '')}">`}
        </label>`).join('')}
        <p class="lf-err" id="lf-err" role="alert" hidden></p>
      </div>
      <div class="m-foot">
        <button type="button" class="btn btn-ghost" data-c="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-c="ok">${esc(shape.submit)}</button>
      </div>`;
    document.body.append(scrim, dlg);
    document.body.classList.add('modal-open');
    if (!reducedMotion()) {
      scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
      dlg.animate(RISE_IN, { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('modal-open');
      const remove = () => { scrim.remove(); dlg.remove(); };
      if (reducedMotion()) remove();
      else {
        scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in' });
        settle(dlg.animate(RISE_OUT, { duration: 160, easing: 'cubic-bezier(.4,0,.9,.4)' }),
          160, remove);
      }
      if (opener?.isConnected) opener.focus();
      resolve(value);
    };

    const err = dlg.querySelector('#lf-err');
    const submit = () => {
      const out = {};
      for (const f of shape.fields) {
        const el = dlg.querySelector(`[data-k="${f.k}"]`);
        const v = el.value.trim();
        if (f.required && !v) {
          // Said next to the form, not in an alert. The field keeps focus so
          // the fix is one keystroke away.
          err.textContent = `${f.label} is required.`;
          err.hidden = false;
          el.focus();
          return;
        }
        if (f.type === 'url' && v && !/^https?:\/\//i.test(v)) {
          err.textContent = 'A link address must start with http:// or https://';
          err.hidden = false;
          el.focus();
          return;
        }
        if (v) out[f.k] = v;
      }
      finish(out);
    };

    dlg.querySelector('[data-c="cancel"]').onclick = () => finish(null);
    dlg.querySelector('[data-c="ok"]').onclick = submit;
    scrim.onclick = () => finish(null);

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      // Enter submits from a single-line field; a textarea keeps its newlines.
      if (e.key === 'Enter' && !e.shiftKey
        && e.target.tagName !== 'TEXTAREA' && dlg.contains(e.target)) {
        e.preventDefault();
        submit();
      }
    };
    document.addEventListener('keydown', onKey, true);
    dlg.querySelector('.m-input')?.focus();
  });
}
