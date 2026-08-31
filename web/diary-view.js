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
  dia, initDiaryApi, localToday, isValidDate, addDays, addMonths,
  loadDay, loadMonth, loadRecent, loadStreak, searchDiary,
  archiveEntry, restoreEntry, formatLong,
  beginDayNav, dayNavToken, dayNavStale,
  sampleCheck, sampleAdd, sampleHistory, sampleRemove,
} from './diary-api.js';
import {
  headerHtml, spreadHtml, jumpHtml, loadingHtml, errorHtml, esc,
} from './diary-entry.js';
import {
  autosize, checkinHtml, promptsHtml, FEELINGS, PASSIVE,
} from './diary-checkin.js';

/** The four passive dimensions, by storage key. They behave as one family. */
const PASSIVE_KEYS = PASSIVE.map((p) => p.key);
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
import { navToken, navStale, setHash } from './nav.js';

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

/* `setHash` comes from nav.js. Diary kept its own `suppressHash` flag, which
 * the shell's hashchange handler could not see — the same defect that broke
 * Library in D2.2. One writer, one record. See nav.js. */

/* ── Entry point ─────────────────────────────────────────────────────── */

export async function renderDiary(nav = navToken()) {
  const head = document.getElementById('page-head');
  const scroll = document.getElementById('main-scroll');
  if (!head || !scroll) return;

  const route = parseDiaryHash() ?? { mode: 'entry', date: localToday() };
  dia.mode = route.mode;
  if (route.mode === 'history') return renderHistory(head, scroll, nav);

  /* Back, Forward, a pasted URL and the first entry into Diary are all real
   * date navigations (§20), so each claims a token. Without this a render
   * started by Back carried whatever token the last button press had, and the
   * first in-flight day change would silently cancel it. */
  const day = beginDayNav(route.date);
  return renderEntry(head, scroll, { nav, day });
}

/* ── Entry mode ──────────────────────────────────────────────────────── */

/**
 * Draws one day.
 *
 * Guarded by TWO tokens, because there are two ways to become stale and they
 * are genuinely different questions:
 *
 *   `nav`  did the person leave Diary altogether? (the shell's route token)
 *   `day`  did the person ask for a different DATE? (D2.3 §18)
 *
 * The route token cannot answer the second: moving between days does not
 * change the route, so `navStale` was false for every date press and every
 * stale render was free to paint. That was the rubber-band.
 */
async function renderEntry(
  head, scroll,
  { animate = null, nav = navToken(), day = dayNavToken() } = {},
) {
  const date = dia.date;
  const stale = () => navStale(nav) || dayNavStale(day);

  head.innerHTML = headerHtml();
  wireHead(head);

  /* The live layer becomes the REQUESTED day immediately — its heading, its
   * paper, its ruled lines — while the outgoing day leaves as a ghost above
   * it. The no-blank rule is still honoured: nothing is ever cleared to
   * nothing, and on a slow connection what remains is the day you asked for
   * rather than the one you left (§21). */
  if (animate || !scroll.querySelector('.dia-book')) {
    scroll.innerHTML = loadingHtml(date);
  }
  try {
    /* The day, the streak and the month are fetched together: the streak sits
     * on the right page and the month fills the date-jump grid, and loading
     * them after the paint would make both pop in a beat late.
     *
     * The month is given the token so a slow preload cannot move `dia.month`
     * — §19 forbids a History or month preload changing the selected day. */
    await Promise.all([
      loadDay(date),
      loadStreak().catch(() => null),
      loadMonth(dia.month ?? date, day).catch(() => null),
    ]);
  } catch (e) {
    if (stale()) return;
    scroll.innerHTML = errorHtml(e.message);
    scroll.querySelector('#dia-retry')?.addEventListener('click', () => void renderDiary());
    return;
  }

  /* The person navigated away, or asked for another day, while this was in
   * flight. Painting now would replace what they actually asked for, and
   * `setHash` would put the URL back — which is how a stale load reclaimed
   * the screen in both D2.1 and D2.3. */
  if (stale()) return;

  head.innerHTML = headerHtml();
  wireHead(head);
  paintSheet(scroll, animate);
  setHash(`#diary/${date}`);
  endTurn(scroll);
}

/**
 * Draws the day and wires it.
 *
 * The ONLY place the editor element is created. Everything else patches around
 * it — see the rendering rule at the top of this file.
 */
function paintSheet(scroll = document.getElementById('main-scroll'), animate = null) {
  stopSaveWatch?.();
  scroll.innerHTML = `<div class="dia">${spreadHtml()}</div>`;
  window.__mountRelated?.(scroll);
  wireSheet(scroll);
  if (animate && !reducedMotion()) {
    const book = scroll.querySelector('.dia-book');
    if (book) enterOnce(book, animate === 'next' ? 'enter-next' : 'enter-prev', 200);
  }
  // Registered while the entry is still exactly what the server holds.
  trackDate(dia.date, dia.entry);
}

/**
 * Redraws ONLY the right page.
 *
 * A chip tap changes the check-in and must not touch the left page — the caret
 * may be sitting in the editor, and rebuilding a contenteditable destroys the
 * selection and the undo history. Same rule as the Book, applied across the
 * gutter instead of across a save.
 *
 * §12 goes further: "update only its local component". `paintGroup` below
 * replaces one <section> and leaves the other three.
 */
function paintCheckin() {
  const right = document.querySelector('.dia-right .dia-scroll');
  if (!right) return;
  const top = right.scrollTop;
  right.innerHTML = checkinHtml(dia.entry, dia.reflection);
  right.scrollTop = top;
  wireCheckin(right);
}

/**
 * Repaints ONE check-in group.
 *
 * Selecting an energy must not rebuild the Moments beneath it, and it must
 * certainly not rebuild the group holding the caret. The whole right page is
 * still rebuilt when the shape changes — choosing a broad feeling adds a row of
 * finer ones — because that is a change to what the group IS.
 */
function paintGroup(id) {
  const right = document.querySelector('.dia-right .dia-scroll');
  const old = right?.querySelector(`.dia-ci-group[data-group-id="${id}"]`);
  if (!old) { paintCheckin(); return; }
  const holder = document.createElement('div');
  holder.innerHTML = checkinHtml(dia.entry, dia.reflection);
  const next = holder.querySelector(`.dia-ci-group[data-group-id="${id}"]`);
  if (!next) { paintCheckin(); return; }
  old.replaceWith(next);
  /* The tone lives on the container, so it is set here rather than being lost
   * with the group that was replaced. */
  const box = right.querySelector('.dia-checkin');
  const feeling = dia.reflection?.checkin?.feeling;
  if (box) {
    if (feeling) box.dataset.tone = feeling; else delete box.dataset.tone;
  }
  // The replaced subtree ONLY. See the note on wireCheckin.
  wireCheckin(next);
}

let stopSaveWatch = null;

function wireHead(head) {
  head.querySelector('#dia-history')?.addEventListener('click', () => void goHistory());
  head.querySelectorAll('[data-go]').forEach((b) => {
    b.addEventListener('click', () => void navigate(b.dataset.go));
  });
  head.querySelector('#dia-jump')?.addEventListener('click', (e) => openJump(e.currentTarget));
}

/**
 * The date jump: a month grid in the app's own surface.
 *
 * Not `<input type="date">`. The native control cannot be styled, opens an
 * operating-system panel in the middle of a journal, and looks like a form
 * field — which is the impression this phase exists to remove. The grid also
 * shows which days already hold writing, which a date input never could.
 */
function openJump(anchor) {
  let month = dia.month ?? dia.date;
  const render = (el) => {
    el.querySelector('.us-body').innerHTML = jumpHtml(month);
    el.querySelectorAll('[data-jump-month]').forEach((b) => {
      b.addEventListener('click', () => void ctx.run(async () => {
        month = addMonths(month, Number(b.dataset.jumpMonth));
        await loadMonth(month);
        render(el);
      }));
    });
    el.querySelectorAll('[data-jump-to]').forEach((b) => {
      b.addEventListener('click', () => {
        ctx.closeSurface();
        void goToDate(b.dataset.jumpTo);
      });
    });
  };
  ctx.openSurface(anchor, {
    kind: 'diary-jump',
    label: 'Jump to a date',
    html: jumpHtml(month),
    wire: render,
  });
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

  wirePrompts(scroll);

  wireCheckin(scroll);

  scroll.querySelectorAll('[data-go]').forEach((b) => {
    b.addEventListener('click', () => void navigate(b.dataset.go));
  });

  scroll.querySelector('#dia-archive')?.addEventListener('click', () => void archiveToday());
  scroll.querySelector('#dia-restore')?.addEventListener('click', () => void restoreToday());

  wireToolbar(scroll);
  stopSaveWatch = wireSaveStatus(scroll);
}

/**
 * The guided prompts, beneath the writing on the left page.
 *
 * Only `.dia-prompts` is ever replaced. It is a SIBLING of the editor inside
 * the same scroller, so swapping it leaves the contenteditable — and therefore
 * the caret, the selection and the undo history — completely untouched.
 */
function wirePrompts(root) {
  root.querySelectorAll('[data-prompt]').forEach((el) => {
    autosize(el);
    el.addEventListener('input', () => {
      autosize(el);
      setPrompt(el.dataset.prompt, el.value, el.dataset.store);
    });
  });
  /* No disclosure control to wire: D2.4 §7 shows all five prompts. The
   * `paintPrompts` repaint below stays, because a prompt still needs
   * re-rendering when a day loads with answers already in it. */
}

function paintPrompts() {
  const old = document.querySelector('.dia-prompts');
  if (!old) return;
  const holder = document.createElement('div');
  holder.innerHTML = promptsHtml(dia.reflection);
  const next = holder.firstElementChild;
  old.replaceWith(next);
  // The replaced subtree ONLY — the same rule `wireCheckin` lives by. Wiring
  // the whole scroller would eventually bind a second listener to something
  // that had not been replaced.
  wirePrompts(next);
  // The first newly revealed prompt takes focus: the press asked for it.
  next.querySelectorAll('[data-prompt]')[3]?.focus();
}

/* -- The right page ------------------------------------------------------ */

/**
 * Wires the check-in, within `root` and nowhere else.
 *
 * Rebound after every right-page repaint, because tapping a broad feeling adds
 * a whole row of finer ones and there is nothing to bind until it exists.
 *
 * ── Why the scope matters ────────────────────────────────────────────────
 *
 * `root` is the subtree that was just REPLACED, never the whole page. Calling
 * this on `#main-scroll` after a single-group repaint bound a second listener
 * to every group that had not been replaced — and a chip with two listeners
 * selects itself and then immediately deselects itself, so nothing happens at
 * all. Fresh nodes only; then a node can never carry two.
 */
function wireCheckin(root) {
  root.querySelectorAll('.dia-chips[data-group]').forEach((group) => {
    const name = group.dataset.group;
    group.querySelectorAll('[data-choice]').forEach((chip) => {
      chip.addEventListener('click', () => onChip(name, chip.dataset.choice));
    });
    /* Arrow keys move within the group, which is what makes a radiogroup a
     * single tab stop rather than five. */
    group.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const chips = [...group.querySelectorAll('[data-choice]')];
      const at = chips.indexOf(document.activeElement);
      const next = chips[(at + step + chips.length) % chips.length];
      next?.focus();
      if (group.getAttribute('role') === 'radiogroup') next?.click();
    });
  });

  /* There is nothing else to wire. The right page is TAP-ONLY (D2.3 §3): no
   * textarea, no input, nothing that opens a keyboard. If a `[data-note]`
   * listener ever needs to come back here, the product rule has been broken. */
}

/**
 * A chip was tapped.
 *
 * Tapping the chosen one again clears it. Every one of these is optional, and a
 * control you cannot un-choose has trapped you into an answer you did not mean.
 */
function onChip(group, id) {
  if (group === 'energy') {
    const next = dia.entry?.energy === id ? null : id;
    // Energy keeps its own column: history and search already read it.
    if (dia.entry) dia.entry.energy = next;
    else dia.entry = { energy: next };
    queueSave(dia.date, undefined, { energy: next });
    paintGroup('energy');
    return;
  }

  const c = { ...(dia.reflection.checkin ?? {}) };
  if (group === 'feeling') {
    if (c.feeling === id) { delete c.feeling; delete c.feelingDetail; }
    else {
      c.feeling = id;
      /* The finer words belong to the broad one. Changing the broad answer
       * keeps whatever detail still exists beneath it and drops the rest. */
      const allowed = new Set(FEELINGS.find((f) => f.id === id)?.detail ?? []);
      const kept = (c.feelingDetail ?? []).filter((d) => allowed.has(d));
      if (kept.length) c.feelingDetail = kept; else delete c.feelingDetail;
    }
  } else if (group === 'feelingDetail') {
    const set = new Set(c.feelingDetail ?? []);
    if (set.has(id)) set.delete(id); else set.add(id);
    if (set.size) c.feelingDetail = [...set]; else delete c.feelingDetail;
  } else if (group === 'social' || PASSIVE_KEYS.includes(group)) {
    /* Social and the four passive dimensions behave identically: one id from
     * one ordered scale, and tapping the chosen one clears it. They are stored
     * side by side in `checkin` because they are all observations of the day —
     * and NONE of them writes a habit. See diary-v2-daily-checkin.md. */
    if (c[group] === id) delete c[group]; else c[group] = id;
  }
  writeReflection({ ...dia.reflection, checkin: c });
  /* Feeling and feelingDetail both redraw the FEELING group — choosing a broad
   * word adds or removes the finer row beneath it, which is a change to the
   * group's shape and not just its selection. The four passive dimensions all
   * live in one `rhythm` group; everything else redraws its own. */
  paintGroup(PASSIVE_KEYS.includes(group) ? 'rhythm'
    : (group === 'social' ? 'social' : 'feeling'));
  /* The chosen chip keeps the focus it just took. Without this a keyboard user
   * choosing with the arrow keys would be returned to the top of the page by
   * the very control they were operating. */
  document.querySelector(`[data-group="${group}"] [data-choice="${id}"]`)?.focus();
}

/**
 * A guided prompt on the left page.
 *
 * `store` says which half of the reflection it belongs in. The five standing
 * prompts live under `prompts`; the four retired Moment lines keep their
 * original `checkin` keys so that a day already holding one needs no migration
 * — see `MOMENT_PROMPTS`. One field, one storage location, decided by the
 * prompt rather than by which page it happens to be drawn on.
 */
function setPrompt(id, value, store = 'prompts') {
  const t = value.trim();
  if (store === 'checkin') {
    const c = { ...(dia.reflection.checkin ?? {}) };
    if (t) c[id] = t; else delete c[id];
    writeReflection({ ...dia.reflection, checkin: c });
    return;
  }
  const prompts = { ...(dia.reflection.prompts ?? {}) };
  if (t) prompts[id] = t; else delete prompts[id];
  writeReflection({ ...dia.reflection, prompts });
}

/**
 * Stores a reflection locally and queues the write.
 *
 * The local copy is updated FIRST and is authoritative until the server
 * answers, so the right page repaints from it immediately. Waiting for the
 * round trip would make every chip tap take a beat to appear.
 */
function writeReflection(next) {
  const clean = { ...next };
  if (clean.checkin && !Object.keys(clean.checkin).length) delete clean.checkin;
  if (clean.prompts && !Object.keys(clean.prompts).length) delete clean.prompts;
  dia.reflection = clean;
  queueSave(dia.date, undefined, { reflection: clean });
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
  if (what === 'today') return goToDate(localToday());
  if (what === 'prev-day') return goToDate(addDays(dia.date, -1), 'prev');
  if (what === 'next-day') return goToDate(addDays(dia.date, 1), 'next');
}

/**
 * Moves to a date. THE DATE-NAVIGATION TRANSACTION (D2.3 §18, §19).
 *
 * ── What this replaces, and why ──────────────────────────────────────────
 *
 * The old order was: flush, wait, THEN change the date, then fetch, then
 * paint. Two consequences, both measured before the rewrite:
 *
 *   The date on screen did not move for two seconds. `dia.date` was committed
 *   only after the network agreed, so a second press computed its target from
 *   the date still showing — and pressing Next, Next, Previous, Next produced
 *   four requests for three different days.
 *
 *   Nothing said which press a render belonged to. Whichever finished LAST
 *   painted last, so the visible date went 8 Aug → 7 Aug → 8 Aug and settled
 *   after 3.6 seconds. That is the rubber-band.
 *
 * ── The new order ────────────────────────────────────────────────────────
 *
 * 1. Claim the navigation and COMMIT THE DATE, before anything is awaited.
 *    The heading, the day controls and the hash are correct in the first
 *    frame, so the next press computes from the right base.
 * 2. Start the outgoing layer moving.
 * 3. Let the flush for the day being LEFT continue in the background. It
 *    updates that day's record and its coordinator; §18 is explicit that it
 *    may not hold the screen or restore the day visually. Nothing is lost:
 *    the coordinator is keyed by date, and `beforeunload` still guards the
 *    tab.
 * 4. Fetch, and paint only if this is still the newest navigation.
 */
export async function goToDate(date, direction = null) {
  if (date === dia.date && dia.mode === 'entry') return;

  /* Claimed and committed BEFORE any await. Everything after this point is
   * allowed to touch the screen only while `day` is still current. */
  const day = beginDayNav(date);
  dia.mode = 'entry';
  dia.entry = null;
  dia.archivedEntry = null;
  dia.reflection = {};

  const scroll = document.getElementById('main-scroll');
  const head = document.getElementById('page-head');

  /* The heading and the controls, immediately and from the target date. §19:
   * never set the selected date back to the source while awaiting data. */
  if (head) { head.innerHTML = headerHtml(); wireHead(head); }
  setHash(`#diary/${date}`);
  announce(`Showing ${formatLong(date)}`);
  beginTurn(scroll, direction);

  /* The day being left finishes writing on its own time. It cannot repaint:
   * the coordinator writes by date, and both `dia.entry` and `onEntryCreated`
   * are guarded by "is this date still open". */
  void flushAll();

  await renderEntry(head, scroll, { animate: direction, day });
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

/**
 * Plays an entrance, then takes the class off.
 *
 * ── Measured, not theorised (D2.2 §14) ───────────────────────────────────
 *
 * `diaEnterPrev` starts at `opacity: 0`. Its fill-mode is `none`, so the
 * moment it FINISHES the element returns to its computed style — which is why
 * this looked safe. It is not: an animation that never finishes never returns
 * anything. Sampled in a browser with a throttled timeline, a 200ms entrance
 * was still `running` at six seconds with the whole spread at opacity 0 — the
 * day was there, laid out correctly, and invisible.
 *
 * The class comes off on a timer, so the final state belongs to the stylesheet
 * whatever the timeline does. The same fix the Today drag needed, and the same
 * one `settle()` gives a Web Animation.
 */
function enterOnce(el, cls, ms) {
  el.classList.add(cls);
  const off = () => el.classList.remove(cls);
  el.addEventListener('animationend', off, { once: true });
  setTimeout(off, ms + 120);
}

/* ── The day turn (D2.3 §21) ─────────────────────────────────────────────
 *
 * A real outgoing layer, not a wait.
 *
 * D2.2's `leaveSpread` AWAITED the leave animation before the fetch even
 * started, which added 200ms to every day change and — worse — meant the old
 * day was still the only thing on screen while it played. The book frame, the
 * gutter and the coloured edges stay exactly where they are; only the CONTENT
 * moves, and the incoming day arrives over the outgoing one.
 *
 * The outgoing layer is a detached clone. It is inert: no ids, no listeners,
 * `aria-hidden`, `inert`, and it cannot be typed into. Cloning rather than
 * keeping the live node is what lets `paintSheet` rebuild the real spread
 * immediately, whenever the data arrives, without waiting for theatre.
 *
 * ANIMATIONS ILLUSTRATE STATE CHANGES; DOM AND CSS OWN THE FINAL STATE. The
 * clone removes itself on a timer as well as on `animationend`, so a throttled
 * timeline cannot leave a ghost day sitting over the real one.
 */
const TURN_MS = 260;

function beginTurn(scroll, direction) {
  endTurn(scroll);
  if (!direction || !scroll || reducedMotion()) return;
  const book = scroll.querySelector('.dia-book');
  if (!book) return;

  const host = book.parentElement;
  if (!host) return;

  const ghost = book.cloneNode(true);
  ghost.classList.add('dia-ghost');
  ghost.classList.add(direction === 'next' ? 'leave-next' : 'leave-prev');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  // Ids must not exist twice in one document, even for 260ms.
  ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  ghost.querySelectorAll('[contenteditable]').forEach((el) => {
    el.setAttribute('contenteditable', 'false');
  });

  /* Pinned to exactly where the book is, so the two layers overlap precisely
   * and the frame appears not to move. Measured once, on an element that is
   * about to be replaced, and written only onto a node that deletes itself —
   * the house rule forbids an animation owning a FINAL state, and this one's
   * final state is "gone". */
  const a = book.getBoundingClientRect();
  const b = host.getBoundingClientRect();
  ghost.style.left = `${Math.round(a.left - b.left)}px`;
  ghost.style.top = `${Math.round(a.top - b.top)}px`;
  ghost.style.width = `${Math.round(a.width)}px`;
  ghost.style.height = `${Math.round(a.height)}px`;
  host.appendChild(ghost);

  const drop = () => ghost.remove();
  ghost.addEventListener('animationend', drop, { once: true });
  setTimeout(drop, TURN_MS + 120);
}

/** Belt and braces: no ghost outlives the paint that replaced its day. */
function endTurn(scroll = document.getElementById('main-scroll')) {
  scroll?.querySelectorAll('.dia-ghost').forEach((g) => g.remove());
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
  nav = navToken(),
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

  if (!scroll.querySelector('.dia-history')) {
    scroll.innerHTML = '<div class="skeleton" style="height:320px;border-radius:16px"></div>';
  }
  try {
    await Promise.all([loadMonth(dia.month), loadRecent()]);
  } catch (e) {
    if (navStale(nav)) return;
    scroll.innerHTML = errorHtml(e.message);
    scroll.querySelector('#dia-retry')?.addEventListener('click', () => void renderHistory());
    return;
  }
  if (navStale(nav)) return;
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
  // A conflict on a day nobody is looking at is resolved when they come back.
  if (dia.mode !== 'entry' || dia.date !== date) return;

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

/** `ours` is decided by the shell, once, from nav.js's record of what it wrote. */
export function diaryHashChanged(ours = false) {
  if (ours) return;
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
  onEntryCreated((entry, created, date) => {
    /* A save may land after the person has left — the route, or the DAY. It
     * updates its own record and its own coordinator; it must not touch a
     * screen that is no longer showing the day it belongs to (D2.3 §18). */
    if (date && date !== dia.date) return;
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
    /* A month of varied days for reviewing History (D2.4 §19). Same marker as
     * `add`, so `remove` clears both — there is one sample system, not two. */
    history: async () => {
      const r = await sampleHistory();
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
