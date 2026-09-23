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
import { icon, logoMark } from './icons.js';
import * as api from './assistant-api.js';
import {
  actionCardHtml, sourcesHtml, clarificationHtml, resultsHtml,
} from './assistant-cards.js';
import { proseHtml } from './assistant-prose.js';
import { VoiceInput, voiceSupported } from './voice-input.js';
import { ComposerVoice } from './composer-voice.js';
import { VoiceWave } from './voice-wave.js';

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
 * The bar at the bottom — a proper multiline composer, not a search field.
 *
 * It began as a one-line `<input>`, which is why a long thought scrolled
 * sideways out of sight instead of wrapping. It is a `<textarea>` that starts
 * one line high, grows as you write, and stops growing at MAX_ROWS so it can
 * never march up the screen and swallow the page behind it.
 */
export function composerHtml() {
  return `<div class="composer" id="composer">
    <div class="asstp" id="asstp" hidden></div>
    <form class="composer-inner asstp-form" id="composer-form" autocomplete="off">
      <span class="ico">${icon('sparkle', 18)}</span>
      <textarea class="composer-input" id="composer-input" rows="1" enterkeyhint="send"
        placeholder="Ask Life OS or capture a thought"
        aria-label="Ask Life OS or capture a thought"></textarea>
      ${/* ── The lotus, not a microphone ──────────────────────────────
            A microphone glyph is the icon for "there is a microphone here".
            What somebody actually needs to know at this size is whether Life
            OS is LISTENING RIGHT NOW, and the mark that already means Life OS
            is the lotus. Muted and still when idle; full colour and breathing
            while it hears you. Same identity, two states, no second symbol. */ ''}
      <button type="button" class="composer-mic" id="composer-mic"
        aria-label="Start voice input" aria-pressed="false" hidden>
        ${logoMark(22)}</button>
      <button type="submit" class="composer-go" id="composer-go" aria-label="Send">
        ${icon('chevR', 16)}</button>
    </form>

    ${/* ── Voice mode ────────────────────────────────────────────────
          The SAME composer, expanded — not a modal over it. A dialog would
          make speaking a place you go, and it is an input method, not a
          destination. It is a sibling of the form rather than inside it so
          that no control in here can ever submit by accident. */ ''}
    <div class="cmp-voice" id="composer-voice" hidden role="group"
      aria-label="Voice recording">
      <div class="cmp-voice-row">
        <span class="cmp-voice-state" id="composer-voice-state" role="status"
          aria-live="polite"><i class="cmp-voice-dot" aria-hidden="true"></i>Listening…</span>
        <canvas class="cmp-wave" id="composer-wave" aria-hidden="true"></canvas>
      </div>
      <div class="cmp-voice-acts">
        <button type="button" class="cmp-vbtn" id="voice-cancel"
          aria-label="Cancel recording"><span class="cmp-vglyph" aria-hidden="true">&times;</span>Cancel</button>
        <button type="button" class="cmp-vbtn" id="voice-keep"
          aria-label="Keep transcript"><span class="cmp-vstop" aria-hidden="true"></span>Keep</button>
        <button type="button" class="cmp-vbtn is-send" id="voice-send"
          aria-label="Send message">${icon('chevR', 14)}Send</button>
      </div>
    </div>
  </div>`;
}

/** Growth stops here; past it the field scrolls inside itself. */
const MAX_ROWS = 7;

/**
 * How long to wait for the recogniser's last words after Keep or Send.
 *
 * Browsers deliver a final result slightly AFTER `stop()`, and some never fire
 * `end` at all — `VoiceInput` already settles itself at 1200ms, so this sits
 * just beyond that. Bounded either way: a button press must always produce an
 * action, even from a recogniser that has stopped answering.
 */
const GRACE_MS = 1500;

/** A microphone nobody came back to. Minutes, not seconds — see below. */
const SAFETY_MS = 5 * 60 * 1000;

let shell = null;
let input = null;
/** The rules for base-vs-segment live in composer-voice.js, DOM-free. */
const cv = new ComposerVoice();
let wave = null;
let graceTimer = null;
let safetyTimer = null;

export function wireComposer(root) {
  shell = root;
  const form = root.querySelector('#composer-form');
  input = root.querySelector('#composer-input');
  panel = root.querySelector('#asstp');
  if (!form || !input || !panel) return;

  autoGrow();
  input.addEventListener('input', autoGrow);
  form.addEventListener('submit', (e) => { e.preventDefault(); submitComposer(); });

  input.addEventListener('keydown', (e) => {
    /* Escape closes the panel without discarding: a pending proposal survives,
       because closing a window is not the same as saying no. */
    if (e.key === 'Escape' && state.open) { e.preventDefault(); close(); return; }
    if (e.key !== 'Enter') return;
    /* An open IME composition is choosing a candidate, not sending. Both
       signals, because older IMEs report only the keyCode. */
    if (e.isComposing || e.keyCode === 229) return;
    if (e.shiftKey) return;            // Shift+Enter is a newline, natively
    e.preventDefault();
    submitComposer();
  });

  wireMic(root);
  wireVoiceControls(root);
}

/**
 * One line, then as many as the text needs, then a scrollbar.
 *
 * Measured from the field's own line-height rather than a magic pixel number,
 * so it still holds when the type scale changes.
 */
function autoGrow() {
  if (!input) return;
  input.style.height = 'auto';
  const line = parseFloat(getComputedStyle(input).lineHeight) || 20;
  const max = Math.round(line * MAX_ROWS);
  const next = Math.min(input.scrollHeight, max);
  input.style.height = `${next}px`;
  input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden';
}

function submitComposer() {
  const text = input.value.trim();
  if (!text || state.busy) return;
  input.value = '';
  autoGrow();
  void send(text);
}

/* ── Voice ────────────────────────────────────────────────────────────────
 *
 * Speech is an INPUT METHOD, not a mode of the assistant. It fills the same
 * field typing fills and submits nothing on its own.
 *
 * ── Why the transcript is not shown while you speak ──────────────────────
 *
 * It used to be: every `onTranscript` wrote straight into the field, so the
 * browser's running guesses were visible — words appearing, being rewritten,
 * briefly turning into numbers and back. The recogniser is right by the end
 * and unstable throughout, and showing the unstable middle made a working
 * system look broken.
 *
 * So recognition continues privately in the session buffer, and the composer
 * shows that it is LISTENING instead. The words arrive once, settled, when
 * Keep or Send says so.
 */
let voice = null;

function wireMic(root) {
  /* The shell can be rendered again — a layout switch redraws the composer —
     and the previous controller would go on holding a recogniser behind a
     button that no longer exists. */
  voice?.destroy();
  voice = null;

  const btn = root.querySelector('#composer-mic');
  if (!btn) return;
  /* Hidden where the browser has no recogniser, rather than shown and then
     apologising. Firefox has none, and an inert button is worse than none. */
  if (!voiceSupported()) return;
  btn.hidden = false;

  voice = new VoiceInput({
    /* THE DESKTOP DIFFERENCE. A pause is somebody thinking mid-sentence, so
       the session ends on a button and nothing else. Mobile keeps its own
       pause-to-finish behaviour, which is right for a phone. */
    autoStop: false,
    onState: (st) => {
      /* The engine gave up while the person was still speaking. Keep the words
         and let them choose — a browser `end` is not a press of Keep. */
      if (st === 'idle' && cv.state === 'listening') markStalled();
    },
    onTranscript: ({ spoken, isFinal }) => {
      /* Deliberately NOT written to the field. */
      if (!cv.active) return;          // a stale recogniser cannot reach back
      cv.hear(spoken);
      if (isFinal && cv.state === 'finishing') applyFinish(spoken);
    },
    onError: ({ message }) => failVoice(message),
  });

  btn.addEventListener('click', () => enterVoice());
  /* Leaving the page must not leave a recogniser or a microphone stream
     running — the browser goes on showing the recording dot over whatever the
     person opened next. */
  window.addEventListener('pagehide', () => { voice?.destroy(); wave?.stop(); });
}

function wireVoiceControls(root) {
  root.querySelector('#voice-cancel')?.addEventListener('click', cancelVoice);
  root.querySelector('#voice-keep')?.addEventListener('click', () => finishVoice('keep'));
  root.querySelector('#voice-send')?.addEventListener('click', () => finishVoice('send'));
}

function enterVoice() {
  if (cv.active || !voice || !input) return;
  /* The snapshot is taken from the field RIGHT NOW, every time, which is what
     makes an edit between two recordings become the new base. */
  if (!cv.begin(input.value)) return;
  showVoice(true);
  /* Recognition first, synchronously inside the click — iOS spends the user
     gesture on the first await — and the microphone analyser only after it, so
     the recogniser claims the microphone before anything else opens a stream.
     See voice-wave.js. */
  if (!voice.start(cv.base)) { cv.cancel(); showVoice(false); return; }
  void startWave();
  clearTimeout(safetyTimer);
  /* Minutes. A forgotten microphone should not record for ever, but a pause
     while thinking must never trip this — so it keeps what was heard rather
     than sending it. */
  safetyTimer = setTimeout(() => finishVoice('keep'), SAFETY_MS);
}

async function startWave() {
  const canvas = shell?.querySelector('#composer-wave');
  if (!canvas) return;
  wave?.stop();
  wave = new VoiceWave(canvas);
  /* A refused or missing microphone stream is a still waveform and a working
     recording. It must never be the reason a recording fails. */
  await wave.start();
}

/**
 * Keep or Send: stop listening, let the last words land, then act once.
 *
 * The press only records the INTENT. Nothing is merged until the recogniser
 * has delivered its final result or the grace period runs out, because the
 * last word or two is usually still inside the engine at the moment somebody
 * reaches for the button.
 */
function finishVoice(action) {
  if (!cv.finish(action)) return;      // wrong state, or a second press
  clearTimeout(safetyTimer);
  setVoiceState(action === 'send' ? 'Sending…' : 'Finishing…', true);
  shell?.querySelectorAll('.cmp-vbtn').forEach((b) => { b.disabled = true; });
  voice?.stop();
  clearTimeout(graceTimer);
  graceTimer = setTimeout(() => applyFinish(null), GRACE_MS);
}

/** The one place a voice session turns into composer text. Runs exactly once. */
function applyFinish(finalText) {
  clearTimeout(graceTimer);
  const out = cv.settle(finalText);
  if (!out) return;                    // already settled — no double send
  wave?.stop();
  showVoice(false);
  if (!input) return;
  input.value = out.text;
  autoGrow();
  if (out.send) { submitComposer(); return; }
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** Discard THIS recording and put the draft back exactly as it was. */
function cancelVoice() {
  const restored = cv.cancel();
  if (restored === null) return;
  clearTimeout(safetyTimer);
  clearTimeout(graceTimer);
  voice?.cancel();
  wave?.stop();
  showVoice(false);
  if (!input) return;
  input.value = restored;
  autoGrow();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** A recognition failure keeps the draft. Losing somebody's words is worse. */
function failVoice(message) {
  if (cv.active) cancelVoice();
  ctx?.toast?.(message, true);
}

/** The engine stopped by itself. Say so, and leave the choice where it was. */
function markStalled() {
  setVoiceState('Listening stopped — keep or cancel', false);
}

function setVoiceState(text, busy) {
  const el = shell?.querySelector('#composer-voice-state');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-busy', Boolean(busy));
  if (!busy) el.insertAdjacentHTML('afterbegin', '<i class="cmp-voice-dot" aria-hidden="true"></i>');
}

function showVoice(on) {
  const box = shell?.querySelector('#composer-voice');
  if (box) box.hidden = !on;
  shell?.querySelector('#composer')?.classList.toggle('is-voice', on);
  const mic = shell?.querySelector('#composer-mic');
  mic?.classList.toggle('is-listening', on);
  mic?.setAttribute('aria-pressed', on ? 'true' : 'false');
  mic?.setAttribute('aria-label', on ? 'Recording' : 'Start voice input');
  if (on) setVoiceState('Listening…', false);
  else shell?.querySelectorAll('.cmp-vbtn').forEach((b) => { b.disabled = false; });
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
      ${/* The user's own words are shown exactly as typed — escaped, never
            interpreted. Only the assistant's half is rendered, and only over
            the small subset in assistant-prose.js. */ ''}
      ${state.history.map((h) => (h.role === 'los'
    ? `<div class="asstp-line is-los">${proseHtml(h.text)}</div>`
    : `<p class="asstp-line is-${h.role}">${esc(h.text)}</p>`)).join('')}
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
