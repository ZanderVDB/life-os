/**
 * The desktop assistant — a panel above the composer, not a page.
 *
 * ── Why not a page ───────────────────────────────────────────────────────
 *
 * Because the assistant's job is to act on what you are looking at. "Move this
 * to Friday" needs the project still on screen; navigating away to a chat
 * transcript throws away the one piece of context that makes the sentence
 * answerable, and turns a command centre into a website with a chatbot in it.
 *
 * So the composer stays where it always was, and the conversation grows
 * upwards from it over the page you are on. The surface is sent with every
 * turn — that is level 1 of the context engine.
 *
 * ── One renderer, two surfaces ───────────────────────────────────────────
 *
 * The cards are `assistant-cards.js`, the same module the phone uses. The
 * panel is the frame around them and nothing more.
 */
import { icon } from './icons.js';
import * as api from './assistant-api.js';
import {
  actionCardHtml, sourcesHtml, clarificationHtml, resultsHtml,
} from './assistant-cards.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** One panel at a time, for the life of the page. */
let panel = null;
let ctx = null;

/** @param c { toast, openEntity, afterChanges, surface } */
export function initAssistantPanel(c) { ctx = c; }

const state = {
  open: false,
  busy: false,
  conversationId: null,
  turnId: null,
  version: 0,
  /** Every exchange so far, so a follow-up has something visible above it. */
  history: [],
  actions: [],
  answer: null,
  understood: '',
  sources: [],
  clarification: null,
  note: null,
  report: null,
  unavailable: new Set(),
  /** Action id → the server's sentence for why it cannot run. */
  unavailableWhy: new Map(),
};

/* ── The composer ─────────────────────────────────────────────────────── */

/**
 * The bar at the bottom. It was a disabled placeholder saying "Soon"; it is
 * now the way in.
 */
export function composerHtml() {
  return `<div class="composer" id="composer">
    <div class="asstp" id="asstp" hidden></div>
    <form class="composer-inner asstp-form" id="composer-form" autocomplete="off">
      <span class="ico">${icon('sparkle', 18)}</span>
      <input class="composer-input" id="composer-input" type="text"
        placeholder="Ask Life OS or capture a thought"
        aria-label="Ask Life OS or capture a thought">
      <button type="submit" class="composer-go" id="composer-go" aria-label="Send">
        ${icon('chevR', 16)}</button>
    </form>
  </div>`;
}

export function wireComposer(root) {
  const form = root.querySelector('#composer-form');
  const input = root.querySelector('#composer-input');
  panel = root.querySelector('#asstp');
  if (!form || !input || !panel) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || state.busy) return;
    input.value = '';
    void send(text);
  });

  /* Escape closes the panel without discarding: a pending proposal survives,
     because closing a window is not the same as saying no. */
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open) { e.preventDefault(); close(); }
  });
}

/* ── A turn ───────────────────────────────────────────────────────────── */

/** One turn onto the panel state. Three entry points, one shape, no drift. */
function applyTurn(r) {
  state.conversationId = r.conversationId;
  state.turnId = r.turnId;
  state.version = r.version;
  state.actions = r.actions ?? [];
  state.answer = r.answer ?? null;
  state.understood = r.understood ?? '';
  state.sources = r.sources ?? [];
  state.clarification = r.clarification ?? null;
  state.note = r.note ?? null;
  state.report = null;
}

/** Is this just the request again? Compared on words, not punctuation. */
function echoes(request, understood) {
  if (!understood) return true;
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return norm(request) === norm(understood);
}

async function send(text) {
  state.busy = true;
  state.history.push({ role: 'you', text });
  open();
  render();
  try {
    const r = await api.turn({
      text,
      conversationId: state.conversationId,
      surface: ctx?.surface?.() ?? null,
    });
    applyTurn(r);
    await markUnavailable();
    /* An `understood` that is only a restatement of the request reads as a
       stutter: the same sentence twice, once from each of you. It earns its
       place when it says something the user did not — "Mark the pricing task
       done, create a haircut task" — and not otherwise. */
    const said = r.answer ?? (echoes(text, r.understood) ? '' : r.understood ?? '');
    if (said) state.history.push({ role: 'los', text: said });
  } catch (e) {
    /* The server knows what went wrong — no model, a timeout, a rate limit.
       Its sentence goes on screen; "something went wrong" would not. */
    state.history.push({ role: 'error', text: e.message });
  } finally {
    state.busy = false;
    render();
  }
}

/**
 * The user picked one of the options the assistant offered.
 *
 * Continues the ORIGINAL request with the entity that option stands for. The
 * choice was exact when it was offered; sending its label back to be
 * re-interpreted is how an exact choice becomes an approximate one.
 */
async function answerQuestion(optionId, label) {
  if (!state.turnId || state.busy) return;
  state.busy = true;
  state.history.push({ role: 'you', text: label || 'That one' });
  state.clarification = null;
  render();
  try {
    const r = await api.clarifyTurn(state.turnId, optionId);
    applyTurn(r);
    await markUnavailable();
    const said = r.answer ?? (echoes(label, r.understood) ? '' : r.understood ?? '');
    if (said) state.history.push({ role: 'los', text: said });
  } catch (e) {
    state.history.push({ role: 'error', text: e.message });
  } finally {
    state.busy = false;
    render();
  }
}

async function markUnavailable() {
  state.unavailable = new Set();
  state.unavailableWhy = new Map();
  try {
    const c = await api.capabilities({ force: true });
    const have = new Set((c.capabilities ?? []).map((x) => x.id));
    /* Why each missing one is missing, said in the server's own words. A
       module that is off and a module that can be read but not written are
       different situations and deserve different sentences. */
    const why = new Map();
    for (const m of c.readOnly ?? []) why.set(m.id, m.reason);
    for (const m of c.unavailable ?? []) why.set(m.id, m.reason);
    for (const a of state.actions) {
      if (have.has(a.capability)) continue;
      state.unavailable.add(a.id);
      const reason = why.get(a.module);
      if (reason) state.unavailableWhy.set(a.id, reason);
    }
  } catch { /* a blip must not disable a proposal */ }
}

/* ── Rendering ────────────────────────────────────────────────────────── */

const open = () => { state.open = true; if (panel) panel.hidden = false; };

export function close() {
  state.open = false;
  if (panel) { panel.hidden = true; panel.innerHTML = ''; }
}

/** Forget the thread. The proposal, if any, is discarded on the server too. */
async function clear() {
  if (state.turnId && !state.report) await api.discardTurn(state.turnId).catch(() => {});
  Object.assign(state, {
    conversationId: null, turnId: null, version: 0, history: [], actions: [],
    answer: null, understood: '', sources: [], clarification: null, note: null, report: null,
    unavailable: new Set(), unavailableWhy: new Map(),
  });
  close();
}

function render() {
  if (!panel || !state.open) return;
  const runnable = state.actions.filter((a) => a.enabled && !state.unavailable.has(a.id));
  const n = runnable.length;

  panel.innerHTML = `
    <div class="asstp-head">
      <span class="asstp-t">${icon('sparkle', 14)} Life OS</span>
      <button type="button" class="asstp-x" id="asstp-clear" aria-label="Clear conversation">
        Clear</button>
      <button type="button" class="asstp-x" id="asstp-close" aria-label="Close">
        ${icon('chevR', 14)}</button>
    </div>

    <div class="asstp-body" id="asstp-body">
      ${state.history.map((h) => `<p class="asstp-line is-${h.role}">${esc(h.text)}</p>`).join('')}
      ${state.busy ? '<p class="asstp-line is-busy">Thinking…</p>' : ''}

      ${!state.busy && state.answer ? sourcesHtml(state.sources) : ''}
      ${state.note && !state.busy ? `<p class="asst-note-line">${esc(state.note)}</p>` : ''}
      ${!state.busy ? clarificationHtml(state.clarification) : ''}
      ${state.report ? resultsHtml(state.report) : ''}
      ${!state.report && !state.busy
    ? state.actions.map((a) => actionCardHtml(a, {
      unavailable: state.unavailable.has(a.id),
      reason: state.unavailableWhy?.get(a.id) ?? null,
    })).join('') : ''}
    </div>

    ${!state.report && n ? `<div class="asstp-foot">
      <button type="button" class="btn btn-ghost" id="asstp-discard">Discard</button>
      <button type="button" class="btn btn-primary" id="asstp-commit">
        Confirm ${n} change${n === 1 ? '' : 's'}</button>
    </div>` : ''}`;

  wire();
  const body = panel.querySelector('#asstp-body');
  if (body) body.scrollTop = body.scrollHeight;
}

function wire() {
  panel.querySelector('#asstp-close').onclick = close;
  panel.querySelector('#asstp-clear').onclick = () => void clear();
  panel.querySelector('#asstp-discard')?.addEventListener('click', () => void clear());
  panel.querySelector('#asstp-commit')?.addEventListener('click', () => void commit());

  panel.querySelectorAll('[data-toggle]').forEach((el) => {
    el.onchange = () => void edit(el.dataset.toggle, { enabled: el.checked });
  });
  panel.querySelectorAll('[data-field]').forEach((el) => {
    el.onclick = () => openFieldEditor(el);
  });
  panel.querySelectorAll('[data-clarify]').forEach((el) => {
    /* An OPTION ID, not a label. See assistant-cards.js. */
    el.onclick = () => void answerQuestion(
      el.dataset.clarify, el.querySelector('.ap-ask-l')?.textContent.trim() ?? '',
    );
  });
  panel.querySelectorAll('[data-src-id]').forEach((el) => {
    el.onclick = () => ctx?.openEntity?.({ type: el.dataset.srcType, id: el.dataset.srcId });
  });
}

/**
 * Editing one field, in place.
 *
 * The control replaces the value it is editing rather than opening a dialog:
 * a proposal card is small and the thing being corrected is usually one word,
 * and a modal over a list of four cards hides the other three.
 */
function openFieldEditor(button) {
  const actionId = button.dataset.field;
  const key = button.dataset.key;
  const action = state.actions.find((a) => a.id === actionId);
  const field = action?.editable?.find((f) => f.key === key);
  if (!field) return;

  const type = field.type === 'date' ? 'date' : field.type === 'time' ? 'time' : 'text';
  button.outerHTML = `<span class="ap-field is-editing">
    <span class="ap-flabel">${esc(field.label)}</span>
    <input class="ap-finput" type="${type}" value="${esc(field.value ?? '')}"
      data-editing="${esc(actionId)}" data-key="${esc(key)}">
  </span>`;

  const input = panel.querySelector('[data-editing]');
  input.focus();
  if (type === 'text') input.select();
  const commitEdit = () => void edit(actionId, { fields: { [key]: input.value } });
  input.addEventListener('blur', commitEdit, { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); input.removeEventListener('blur', commitEdit); render(); }
  });
}

async function edit(actionId, change) {
  if (!state.turnId) return;
  try {
    const r = await api.editTurn(state.turnId, state.version, [{ actionId, ...change }]);
    state.version = r.version;
    state.actions = r.actions;
  } catch (e) {
    ctx?.toast?.(e.message, true);
    const fresh = await api.readTurn(state.turnId).catch(() => null);
    if (fresh) { state.version = fresh.version; state.actions = fresh.actions ?? []; }
  }
  render();
}

/* ── Confirming ───────────────────────────────────────────────────────── */

async function commit() {
  const runnable = state.actions.filter((a) => a.enabled && !state.unavailable.has(a.id));
  const important = runnable.filter((a) => a.important);
  /* The batch confirmation does not cover the ones that are hard to undo. A
     browser confirm is blunt, and blunt is right here — it names them. */
  if (important.length) {
    const list = important.map((a) => `• ${a.title}`).join('\n');
    const ok = window.confirm(
      `${important.length === 1 ? 'This change is' : 'These changes are'} hard to undo:\n\n${list}\n\n`
      + `Go ahead?`,
    );
    if (!ok) return;
  }
  try {
    state.report = await api.confirmTurn(
      state.turnId, state.version, runnable.length, important.map((a) => a.id),
    );
    /* The results block already carries the headline, in larger type with the
       list under it. Pushing it into the transcript as well says the same
       sentence twice a line apart. */
    /* The screen behind the panel is now out of date. Refreshing it is the
       difference between saying it happened and it having happened. */
    ctx?.afterChanges?.();
  } catch (e) {
    ctx?.toast?.(e.message, true);
    const fresh = await api.readTurn(state.turnId).catch(() => null);
    if (fresh) { state.version = fresh.version; state.actions = fresh.actions ?? []; }
  }
  render();
}

/** Used by the shell to send a request from somewhere other than the bar. */
export const ask = (text) => send(text);
