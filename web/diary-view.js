/**
 * Diary — the route controller.
 *
 * Two modes behind one route: writing a day, and looking back over many. An
 * explicit control moves between them and only one is ever at full scale, so
 * "what am I doing right now" is never a question (§23).
 *
 * ── The rendering rule, inherited from the Book ──────────────────────────
 *
 * The history view rebuilds freely. The ENTRY does not: while a day is on
 * screen its editor element is never replaced, because replacing a
 * contenteditable destroys the selection, the caret and the browser's undo
 * history. The sheet is rebuilt only when the DATE changes — never in response
 * to typing, and never in response to a save completing.
 */

import {
  dia, initDiaryApi, localToday, localZone, isValidDate, addDays, addMonths,
  loadDay, loadMonth, loadRecent, adjacentEntry, searchDiary,
  archiveEntry, restoreEntry, formatLong, relativeDay,
  sampleCheck, sampleAdd, sampleRemove,
} from './diary-api.js';
import {
  headerHtml, entryHtml, loadingHtml, errorHtml, esc,
} from './diary-entry.js';
import { historyHtml } from './diary-history.js';
import { docToHtml, htmlToDoc, docToText } from './editor-doc.js';
import {
  handleEnter, handleBackspace, applyBlockStyle, currentStyleId, BLOCK_STYLES,
} from './editor-blocks.js';
import {
  trackDate, queueSave, flush, flushAll, hasUnsaved, retry, statusOf, entryOf,
  forgetAll, onSaveStatus, onEntryCreated,
  resolveKeepMine, resolveTakeTheirs, STATUS_LABEL,
} from './diary-save.js';
import { reducedMotion } from './motion.js';

/** Injected once by app.js: the API caller, the toast, the error wrapper. */
let ctx = null;
export function initDiary(c) {
  ctx = c;
  initDiaryApi(c.api);
  installSampleHooks();
  installGlobals();
}

/* ── Routing (§14) ───────────────────────────────────────────────────────
 *
 * #diary               today, in the browser's own reckoning
 * #diary/2026-08-05    that day
 * #diary/history       the month grid, recent entries and search
 *
 * A date that is not a real day falls back to today rather than erroring: a
 * mistyped URL should open the diary, not a stack trace.
 */
export function parseDiaryHash(hash = location.hash, today = localToday()) {
  const path = hash.replace(/^#/, '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'diary') return null;
  if (parts[1] === 'history') return { mode: 'history', date: null };
  if (parts[1] && isValidDate(parts[1])) return { mode: 'entry', date: parts[1] };
  return { mode: 'entry', date: today };
}

let suppressHash = false;
function setHash(next) {
  if (location.hash === next) return;
  suppressHash = true;
  location.hash = next;
  setTimeout(() => { suppressHash = false; }, 0);
}

/* ── Entry point ─────────────────────────────────────────────────────── */

export async function renderDiary() {
  const head = document.getElementById('page-head');
  const scroll = document.getElementById('main-scroll');
  if (!head || !scroll) return;

  const route = parseDiaryHash() ?? { mode: 'entry', date: localToday() };
  dia.mode = route.mode;
  if (route.mode === 'history') return renderHistory(head, scroll);

  dia.date = route.date;
  return renderEntry(head, scroll);
}

/* ── Entry mode ──────────────────────────────────────────────────────── */

async function renderEntry(head, scroll, { animate = null } = {}) {
  head.innerHTML = headerHtml();
  wireHead(head);

  scroll.innerHTML = loadingHtml();
  try {
    await loadDay(dia.date);
  } catch (e) {
    scroll.innerHTML = errorHtml(e.message);
    scroll.querySelector('#dia-retry')?.addEventListener('click', () => void renderDiary());
    return;
  }

  head.innerHTML = headerHtml();
  wireHead(head);
  paintSheet(scroll, animate);
  setHash(`#diary/${dia.date}`);
}

/**
 * Draws the day and wires it.
 *
 * The ONLY place the editor element is created. Everything else patches around
 * it — see the rendering rule at the top of this file.
 */
function paintSheet(scroll = document.getElementById('main-scroll'), animate = null) {
  stopSaveWatch?.();
  scroll.innerHTML = `<div class="dia">${entryHtml()}</div>`;
  wireSheet(scroll);
  if (animate && !reducedMotion()) {
    const sheet = scroll.querySelector('.dia-sheet');
    sheet?.classList.add(animate === 'next' ? 'enter-next' : 'enter-prev');
  }
  // Registered while the entry is still exactly what the server holds.
  trackDate(dia.date, dia.entry);
}

let stopSaveWatch = null;

function wireHead(head) {
  head.querySelector('#dia-history')?.addEventListener('click', () => void goHistory());
  head.querySelector('#dia-today')?.addEventListener('click', () => void goToDate(localToday()));
}

function wireSheet(scroll) {
  const editor = scroll.querySelector('#dia-editor');

  if (editor) {
    editor.addEventListener('input', () => {
      const doc = htmlToDoc(editor);
      queueSave(dia.date, doc);
      paintPlaceholder(editor);
    });

    editor.addEventListener('keydown', (e) => {
      /* Enter and Backspace decide what the DOCUMENT becomes, so they are
       * handled before the browser gets them — the same shared rules the Book
       * uses, from editor-blocks.js. */
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        if (handleEnter(editor)) {
          e.preventDefault();
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          paintToolbar();
        }
        return;
      }
      if (e.key === 'Backspace') {
        if (handleBackspace(editor)) {
          e.preventDefault();
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          paintToolbar();
        }
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); exec('bold'); }
      else if (k === 'i') { e.preventDefault(); exec('italic'); }
      else if (k === 'u') { e.preventDefault(); exec('underline'); }
      else if (k === 'k') { e.preventDefault(); void addLink(); }
      else if (k === 's') { e.preventDefault(); void flush(dia.date); }
    });

    /* Paste arrives as whatever was copied — frequently a whole styled
     * document. Taking the plain text and letting the grammar re-block it is
     * the only way to be sure nothing enters that the model cannot describe. */
    editor.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
    });
    editor.addEventListener('keyup', paintToolbar);
    editor.addEventListener('mouseup', paintToolbar);
    editor.addEventListener('focus', paintToolbar);
    paintPlaceholder(editor);
  }

  scroll.querySelector('#dia-title')?.addEventListener('input', (e) => {
    queueSave(dia.date, undefined, { title: e.target.value });
  });

  scroll.querySelectorAll('[data-field]').forEach((el) => {
    const evt = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      // An empty control means "not recorded", which is null, not "".
      queueSave(dia.date, undefined, { [el.dataset.field]: el.value.trim() || null });
    });
  });

  scroll.querySelector('#dia-context-toggle')?.addEventListener('click', (e) => {
    dia.contextOpen = !dia.contextOpen;
    const body = scroll.querySelector('#dia-context-body');
    const wrap = e.currentTarget.closest('.dia-context');
    body.hidden = !dia.contextOpen;
    wrap.classList.toggle('is-open', dia.contextOpen);
    e.currentTarget.setAttribute('aria-expanded', String(dia.contextOpen));
    e.currentTarget.querySelector('span').textContent =
      dia.contextOpen ? 'Day context' : 'Add context';
  });

  scroll.querySelectorAll('[data-go]').forEach((b) => {
    b.addEventListener('click', () => void navigate(b.dataset.go));
  });
  scroll.querySelector('#dia-date')?.addEventListener('change', (e) => {
    if (isValidDate(e.target.value)) void goToDate(e.target.value);
  });

  scroll.querySelector('#dia-archive')?.addEventListener('click', () => void archiveToday());
  scroll.querySelector('#dia-restore')?.addEventListener('click', () => void restoreToday());

  wireToolbar(scroll);
  stopSaveWatch = wireSaveStatus(scroll);
}

/**
 * The blank-page prompt.
 *
 * A CSS `:empty` selector cannot do this: a contenteditable is never empty, it
 * holds `<p><br></p>`. So the class is set from the same text test the server
 * uses to decide whether a day is worth a row.
 */
function paintPlaceholder(editor) {
  const empty = !docToText(htmlToDoc(editor)).trim();
  editor.classList.toggle('is-empty', empty);
}

/* ── Formatting ──────────────────────────────────────────────────────── */

function exec(cmd, value = null) {
  document.execCommand(cmd, false, value);
  paintToolbar();
  document.activeElement?.dispatchEvent(new Event('input', { bubbles: true }));
}

function wireToolbar(scroll) {
  scroll.querySelectorAll('.dia-tb[data-cmd]').forEach((b) => {
    // mousedown + preventDefault, so pressing a button never takes the
    // selection out of the editor it is about to act on.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      if (b.dataset.cmd === 'link') return void addLink();
      exec(b.dataset.cmd);
    });
  });
  const style = scroll.querySelector('.dia-tb-style');
  style?.addEventListener('mousedown', (e) => e.stopPropagation());
  style?.addEventListener('change', () => {
    const ed = document.getElementById('dia-editor');
    if (!ed) return;
    applyBlockStyle(ed, style.value);
    paintToolbar();
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function paintToolbar() {
  const bar = document.querySelector('.dia-toolbar');
  const ed = document.getElementById('dia-editor');
  if (!bar || !ed) return;
  for (const b of bar.querySelectorAll('.dia-tb[data-cmd]')) {
    const cmd = b.dataset.cmd;
    if (['bold', 'italic', 'underline', 'strikeThrough',
      'insertUnorderedList', 'insertOrderedList'].includes(cmd)) {
      let on = false;
      try { on = document.queryCommandState(cmd); } catch { on = false; }
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  const style = bar.querySelector('.dia-tb-style');
  if (style && ed.contains(document.activeElement) || style && document.activeElement === ed) {
    const id = currentStyleId(ed);
    style.value = id;
    style.setAttribute('aria-label', `Text style: ${
      BLOCK_STYLES.find((s) => s.id === id)?.label ?? 'Body'}`);
  }
}

/** A small inline prompt. Never window.prompt — it cannot be styled or escaped. */
function promptLink() {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'bk-linkbox';
    box.innerHTML = `<label>Link address
      <input type="url" placeholder="https://" aria-label="Link address"></label>
      <div class="bk-linkbox-acts">
        <button type="button" data-c="no" class="btn btn-sm">Cancel</button>
        <button type="button" data-c="yes" class="btn btn-sm btn-primary">Add link</button>
      </div>`;
    const input = box.querySelector('input');
    const done = (v) => { box.remove(); resolve(v); };
    box.querySelector('[data-c="no"]').onclick = () => done(null);
    box.querySelector('[data-c="yes"]').onclick = () => done(input.value.trim() || null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    document.body.appendChild(box);
    input.focus();
  });
}

async function addLink() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const href = await promptLink();
  if (href) exec('createLink', href);
}

/* ── Save status ─────────────────────────────────────────────────────── */

function wireSaveStatus(scroll) {
  const el = scroll.querySelector('#dia-save');
  if (!el) return () => {};
  const paint = () => {
    const status = statusOf(dia.date);
    el.dataset.state = status;
    el.innerHTML = status === 'failed'
      ? `${STATUS_LABEL.failed} <button type="button" class="bk-retry" id="dia-retry-save">Retry</button>`
      : STATUS_LABEL[status];
    const hint = scroll.querySelector('.dia-hint');
    // The "nothing is saved yet" line stops being true the moment it is.
    if (hint && dia.entry) hint.textContent = '';
  };
  paint();
  el.addEventListener('click', (e) => {
    if (e.target.id === 'dia-retry-save') void ctx.run(() => retry(dia.date));
  });
  return onSaveStatus(paint);
}

/* ── Navigation (§13) ────────────────────────────────────────────────── */

async function navigate(what) {
  if (what === 'prev-day') return goToDate(addDays(dia.date, -1), 'prev');
  if (what === 'next-day') return goToDate(addDays(dia.date, 1), 'next');

  // Entry steps have to ASK — the client cannot know where the gaps are.
  const direction = what === 'prev-entry' ? 'prev' : 'next';
  await ctx.run(async () => {
    const r = await adjacentEntry(dia.date, direction);
    if (!r.date) {
      ctx.toast(direction === 'prev'
        ? 'Nothing written before this day yet.'
        : 'Nothing written after this day yet.');
      return;
    }
    await goToDate(r.date, direction === 'prev' ? 'prev' : 'next');
  });
}

/**
 * Moves to a date.
 *
 * §16: the flush happens BEFORE the date changes, not alongside it. If the
 * write cannot complete the move is abandoned and the words stay on screen —
 * losing a day's writing to a navigation is the one outcome that is never
 * acceptable.
 */
export async function goToDate(date, direction = null) {
  if (date === dia.date && dia.mode === 'entry') return;
  const ok = await flushAll();
  if (!ok && hasUnsaved()) {
    ctx.toast('That did not save yet — staying here so nothing is lost.', true);
    return;
  }
  forgetAll();
  dia.date = date;
  dia.mode = 'entry';
  dia.entry = null;
  const scroll = document.getElementById('main-scroll');
  const head = document.getElementById('page-head');
  if (direction && !reducedMotion()) {
    const sheet = scroll?.querySelector('.dia-sheet');
    if (sheet) {
      sheet.classList.add(direction === 'next' ? 'leave-next' : 'leave-prev');
      await afterAnimation(sheet, 200);
    }
  }
  await renderEntry(head, scroll, { animate: direction });
  announce(`Showing ${formatLong(date)}`);
}

function afterAnimation(el, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('animationend', finish);
      resolve();
    };
    el.addEventListener('animationend', finish);
    setTimeout(finish, ms + 60);
  });
}

/** Says the date out loud for a screen reader, without stealing focus. */
function announce(msg) {
  let live = document.getElementById('dia-live');
  if (!live) {
    live = document.createElement('div');
    live.id = 'dia-live';
    live.className = 'sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
  }
  live.textContent = msg;
}

/* ── History mode (§15, §23) ─────────────────────────────────────────── */

async function goHistory() {
  const ok = await flushAll();
  if (!ok && hasUnsaved()) {
    ctx.toast('That did not save yet — staying here so nothing is lost.', true);
    return;
  }
  dia.mode = 'history';
  dia.month = dia.month ?? dia.date;
  setHash('#diary/history');
  await renderHistory();
}

async function renderHistory(
  head = document.getElementById('page-head'),
  scroll = document.getElementById('main-scroll'),
) {
  dia.mode = 'history';
  dia.date = dia.date ?? localToday();
  dia.month = dia.month ?? dia.date;

  head.innerHTML = `<p class="eyebrow dia-page">Life OS · Diary</p>
    <h1>History</h1>
    <p class="sub">Where you have written, and what you said.</p>
    <div class="page-actions">
      <button class="btn btn-ghost btn-sm" id="dia-back">Back to writing</button>
    </div>`;
  head.querySelector('#dia-back').addEventListener('click', () => void goToDate(dia.date));

  scroll.innerHTML = '<div class="skeleton" style="height:320px;border-radius:16px"></div>';
  try {
    await Promise.all([loadMonth(dia.month), loadRecent()]);
  } catch (e) {
    scroll.innerHTML = errorHtml(e.message);
    scroll.querySelector('#dia-retry')?.addEventListener('click', () => void renderHistory());
    return;
  }
  paintHistory(scroll);
  setHash('#diary/history');
}

function paintHistory(scroll = document.getElementById('main-scroll')) {
  scroll.innerHTML = historyHtml();
  wireHistory(scroll);
}

function wireHistory(scroll) {
  scroll.querySelectorAll('[data-month]').forEach((b) => {
    b.addEventListener('click', () => void ctx.run(async () => {
      dia.month = addMonths(dia.month ?? dia.date, Number(b.dataset.month));
      await loadMonth(dia.month);
      paintHistory(scroll);
    }));
  });

  scroll.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => {
      const match = b.dataset.match ?? null;
      void goToDate(b.dataset.open).then(() => { if (match) highlight(match); });
    });
  });

  // Arrow keys walk the grid, so the calendar is usable without a mouse (§26).
  scroll.querySelector('.dia-grid')?.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step) return;
    e.preventDefault();
    const cells = [...scroll.querySelectorAll('.dia-day-cell')];
    const at = cells.indexOf(document.activeElement);
    const next = cells[Math.max(0, Math.min(cells.length - 1, at + step))];
    if (next) { next.tabIndex = 0; next.focus(); if (at > -1) cells[at].tabIndex = -1; }
  });

  const q = scroll.querySelector('#dia-q');
  if (q) {
    let timer;
    q.addEventListener('input', () => {
      dia.query = q.value;
      clearTimeout(timer);
      const term = q.value.trim();
      timer = setTimeout(() => void ctx.run(async () => {
        if (term.length < 2) { dia.results = null; paintHistory(scroll); return; }
        // Guarded by the query it was issued for: a slow answer to an older
        // term must never replace the results for what is in the box now.
        const r = await searchDiary(term);
        if (dia.query.trim() !== term) return;
        dia.results = r.results;
        paintHistory(scroll);
        scroll.querySelector('#dia-q')?.focus();
      }), 240);
    });
  }
  scroll.querySelector('#dia-clear-q')?.addEventListener('click', () => {
    dia.query = ''; dia.results = null;
    paintHistory(scroll);
  });
}

/** Briefly marks the searched words in the opened day. */
function highlight(term) {
  const ed = document.getElementById('dia-editor');
  if (!ed || !term) return;
  ed.classList.add('is-found');
  setTimeout(() => ed.classList.remove('is-found'), 1400);
  announce(`Opened ${formatLong(dia.date)}, matching ${term}`);
}

/* ── Archive and restore (§20) ───────────────────────────────────────── */

async function archiveToday() {
  if (!dia.entry) return;
  const choice = await ctx.choose({
    title: 'Archive this day?',
    body: 'It leaves your history and search. Nothing is deleted, and you can '
      + 'restore it from this date at any time.',
    choices: [
      { id: 'yes', label: 'Archive it', detail: 'Reversible' },
      { id: 'no', label: 'Keep it' },
    ],
  });
  if (choice !== 'yes') return;
  await ctx.run(async () => {
    await flushAll();
    const id = dia.entry.id;
    await archiveEntry(id);
    forgetAll();
    await loadDay(dia.date);
    paintSheet();
    ctx.toast('Archived.', false, {
      label: 'Undo',
      onAction: () => void ctx.run(async () => {
        await restoreEntry(id);
        await loadDay(dia.date);
        paintSheet();
      }),
    });
  });
}

async function restoreToday() {
  const entry = dia.archivedEntry;
  if (!entry) return;
  await ctx.run(async () => {
    await restoreEntry(entry.id);
    forgetAll();
    await loadDay(dia.date);
    paintSheet();
    ctx.toast('Restored.');
  });
}

/* ── Conflicts (§12) ─────────────────────────────────────────────────── */

let conflictShown = null;

export async function showConflict(date) {
  const entry = entryOf(date);
  if (!entry) return;

  const choice = await ctx.choose({
    title: 'This day changed somewhere else',
    body: 'Another tab or device saved this entry while you were writing. '
      + 'Nothing you typed has been lost — choose what to keep.',
    choices: [
      { id: 'mine', label: 'Keep what I wrote', detail: 'Overwrites the other version' },
      { id: 'theirs', label: 'Load the newer version', detail: 'Your writing is copied first' },
      { id: 'copy', label: 'Copy my writing', detail: 'Puts it on the clipboard, changes nothing' },
    ],
  });
  if (!choice) return;

  const fresh = await loadDay(date);
  const server = fresh.entry;
  if (!server) { ctx.toast('That entry no longer exists.', true); return; }

  if (choice === 'copy') {
    await copyText(entry.pending ?? entry.committed);
    ctx.toast('Your writing is on the clipboard.');
    return;
  }
  if (choice === 'mine') {
    await ctx.run(() => resolveKeepMine(date, server));
    ctx.toast('Your version was saved.');
    return;
  }
  // Taking theirs: copy first, then load. In that order, deliberately.
  await copyText(resolveTakeTheirs(date, server) ?? entry.committed);
  paintSheet();
  ctx.toast('Newer version loaded. Your writing is on the clipboard.');
}

async function copyText(doc) {
  const text = docToText(doc);
  try { await navigator.clipboard.writeText(text); } catch { /* clipboard denied */ }
  return text;
}

/* ── Leaving ─────────────────────────────────────────────────────────── */

/** Called by app.js when the route changes away from Diary. */
export async function diaryWillLeave() {
  if (!dia.date) return true;
  await flushAll();
  forgetAll();
  return true;
}

export function diaryHashChanged() {
  if (suppressHash) return;
  void renderDiary();
}

/* ── Global wiring ───────────────────────────────────────────────────── */

function installGlobals() {
  /* A day that becomes a real entry: the footer hint and the Archive control
   * change, and neither may disturb the editor the caret is in.
   *
   * This must NOT touch the version token. The coordinator sets it from the
   * write's own result, and moving it here first made `e.version !==
   * sentVersion` true — its staleness guard then correctly concluded the
   * response was for a version already passed, returned early, and left the
   * status on "Saving…" forever while the row sat happily in the database. */
  onEntryCreated((entry) => {
    const foot = document.querySelector('.dia-foot');
    if (!foot || foot.querySelector('#dia-archive')) return;
    foot.querySelector('.dia-hint').textContent = '';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dia-archive';
    b.id = 'dia-archive';
    b.textContent = 'Archive';
    b.setAttribute('aria-label', 'Archive this entry');
    b.addEventListener('click', () => void archiveToday());
    foot.appendChild(b);
  });

  onSaveStatus((date, status) => {
    if (status !== 'conflict') { if (conflictShown === date) conflictShown = null; return; }
    if (conflictShown === date) return;
    conflictShown = date;
    void showConflict(date);
  });

  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsaved()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  /* Crossing midnight with the tab open. Diary is the one screen where the
   * date on screen can silently become yesterday, so it is checked — and only
   * ANNOUNCED, never switched underneath someone who is mid-sentence. */
  setInterval(() => {
    if (dia.mode !== 'entry' || !midnightWatch) return;
    const today = localToday();
    if (today !== midnightWatch) {
      midnightWatch = today;
      if (dia.date !== today) {
        ctx.toast('It is a new day. Open today?', false, {
          label: 'Open today',
          onAction: () => void goToDate(today),
        });
      }
    }
  }, 60000);
  midnightWatch = localToday();
}
let midnightWatch = null;

/* ── Sample hooks (§29) ──────────────────────────────────────────────── */

function installSampleHooks() {
  window.__sampleDiary = {
    check: () => sampleCheck(),
    add: async () => {
      const r = await sampleAdd();
      await renderDiary();
      return r;
    },
    remove: async () => {
      const r = await sampleRemove();
      await renderDiary();
      return r;
    },
  };
}

export { dia, localToday, addDays };
