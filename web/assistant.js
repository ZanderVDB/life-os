/**
 * The mobile assistant surface.
 *
 * ── What is being built here, precisely ──────────────────────────────────
 *
 * The INTERACTION, not the intelligence. There is no model behind this, no
 * API key, no embeddings and no AI tables. What exists is the surface a
 * person will use — listening, transcript, understanding, proposal, edit,
 * confirm — built against `assistant-contract.js` so the day a real provider
 * arrives, `assistant-mock.js` is deleted and nothing else moves.
 *
 * Doing it in this order is a decision, not an accident of scheduling. The
 * hard questions about an assistant that can move your meetings are questions
 * about consent and correction, and those are answered in the interface. A
 * model behind a bad interface is a faster way to get the wrong thing done.
 *
 * ── The rule the surface exists to enforce ───────────────────────────────
 *
 *   Voice never writes. Voice PROPOSES.
 *
 * Every path through this file ends at a list of changes with a button that
 * counts them. There is no branch where speaking causes a write.
 */

import { icon, logoMark } from './icons.js';
import { Orb, MicLevel, VARIANTS, DEFAULT_VARIANT, synthLevel } from './assistant-orb.js';
import { openSheet, closeSheet } from './mobile.js';
/* Fixed transcripts stand in for a MICROPHONE, not for the assistant: speech
   recognition does not exist in Firefox and differs between Chrome and Safari.
   What they produce goes to the same server turn a spoken sentence would. */
import { MOCK_TRANSCRIPTS } from './assistant-mock.js';
/* What Life OS can do comes from the SERVER. This client keeps no
   authoritative capability list of its own — see assistant-api.js. */
import * as api from './assistant-api.js';
import {
  actionCardHtml, sourcesHtml, clarificationHtml, resultsHtml,
} from './assistant-cards.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Development controls — the A/B/C selector and the mock transcripts. */
export const devTools = () => Boolean(window.LIFE_OS_CONFIG?.devTools)
  || (() => { try { return localStorage.getItem('los2_dev') === '1'; } catch { return false; } })();

const VARIANT_KEY = 'los2_orb_variant';
export const currentVariant = () => {
  try {
    const v = localStorage.getItem(VARIANT_KEY);
    return VARIANTS.some((x) => x.id === v) ? v : DEFAULT_VARIANT;
  } catch { return DEFAULT_VARIANT; }
};
const setVariant = (v) => { try { localStorage.setItem(VARIANT_KEY, v); } catch { /* private mode */ } };

/* ── State copy ──────────────────────────────────────────────────────────
 * One line per state, and no personality. "Making sense of that" is a
 * description of what is happening; "Hmm, let me think about that! 🤔" is a
 * character the app does not have and cannot sustain. */
const COPY = {
  idle: { say: 'Tell Life OS what’s going on', sub: 'Tap to speak, or type it instead' },
  starting: { say: 'Getting the microphone…', sub: '' },
  listening: { say: 'Listening…', sub: 'Tap when you’re done' },
  paused: { say: 'Still listening', sub: 'Tap when you’re done' },
  processing: { say: 'Making sense of that…', sub: '' },
  proposal: { say: '', sub: '' },
  denied: { say: 'The microphone is blocked', sub: 'Type it instead, or allow the microphone in your browser' },
};

/* ══════════════════════════════════════════════════════════════════════
   THE SESSION
   One live assistant at a time. Held at module scope because the
   microphone, the recogniser and the animation loop are all resources
   that must be released when the route changes, and a stray second
   session would keep a microphone open behind a page nobody is looking at.
   ══════════════════════════════════════════════════════════════════════ */
let session = null;

function endSession() {
  if (!session) return;
  session.orb?.destroy();
  session.mic?.stop();
  try { session.rec?.stop(); } catch { /* not started */ }
  clearInterval(session.tick);
  clearTimeout(session.mockTimer);
  session = null;
}

/** Called by the router on leaving. */
export const leaveAssistant = endSession;

/* ── The orb block ──────────────────────────────────────────────────────
 * Used twice: at the centre of the assistant surface, and as the invitation
 * on mobile Today. Same component, same variant, so a person who has chosen
 * a listening style sees it in both places. */
export function orbHtml({ size = 'lg', id = 'orb' } = {}) {
  return `<div class="orb orb-${size}" id="${id}" data-variant="${currentVariant()}">
    <canvas class="orb-canvas" aria-hidden="true"></canvas>
    <span class="orb-mark" aria-hidden="true">${logoMark(size === 'lg' ? 46 : 30)}</span>
  </div>`;
}

/**
 * Today's invitation.
 *
 * NOT a chat box. §5 is explicit that the mobile home must not open as a
 * blank assistant — what matters now comes first, and the orb sits under it
 * as the way to say something about it.
 */
export function assistantInviteHtml() {
  return `<button type="button" class="ai-invite" id="ai-invite"
      aria-label="Talk to Life OS">
    ${orbHtml({ size: 'md', id: 'orb-today' })}
    <span class="ai-invite-t">
      <span class="ai-invite-say">${COPY.idle.say}</span>
      <!-- The button is NAMED, not drawn: a glyph standing in for a control
           reads as a font that failed to load, and there is no character in
           any font that means "the round one in the middle of the bar".
           "below" rather than "the centre button" because the longer phrase
           wrapped to two lines at 360 and 390, and the only thing below is
           the bar this refers to. -->
      <span class="ai-invite-sub">Tap to speak · hold below for Quick add</span>
    </span>
  </button>`;
}

/** Starts the Today orb breathing. Returns a teardown. */
export function mountInviteOrb(rootEl) {
  const el = rootEl.querySelector('#orb-today canvas');
  if (!el) return () => {};
  const orb = new Orb(el, { variant: currentVariant() });
  orb.setState('idle');
  orb.start();
  /* A phone in a pocket must not be animating. `visibilitychange` covers the
   * tab; the orb stops entirely rather than throttling, because an idle
   * breathing loop has nothing worth keeping warm. */
  const vis = () => (document.hidden ? orb.stop() : orb.start());
  document.addEventListener('visibilitychange', vis);
  return () => { document.removeEventListener('visibilitychange', vis); orb.destroy(); };
}

/* ══════════════════════════════════════════════════════════════════════
   THE SURFACE
   ══════════════════════════════════════════════════════════════════════ */

/**
 * @param {HTMLElement} head   the page header
 * @param {HTMLElement} scroll the page body
 * @param {object} ctx         a read-only view of the workspace, plus actions
 */
export function renderAssistant(head, scroll, ctx) {
  endSession();

  head.innerHTML = `<p class="eyebrow">Life OS</p><h1>Assistant</h1>
    <p class="sub">Say what is going on. Life OS proposes the changes; you confirm them.</p>`;

  scroll.innerHTML = `<div class="asst" id="asst" data-state="idle">
    <!-- One line, and only when there is something to say. The prototype
         warning was true for two phases and is not any more; what remains is
         the case where no model is configured, which the person genuinely
         needs to know before they speak into a void. -->
    <p class="asst-note" id="asst-note" hidden><span class="asst-dot" aria-hidden="true"></span>
      <span id="asst-note-t"></span></p>

    <p class="asst-src" id="asst-src" hidden></p>
    <div class="asst-script" id="asst-script" role="log" aria-live="polite"></div>

    <div class="asst-stage">
      ${orbHtml({ size: 'lg', id: 'orb-main' })}
      <p class="asst-say" id="asst-say">${COPY.idle.say}</p>
      <p class="asst-sub" id="asst-sub">${COPY.idle.sub}</p>
    </div>

    <div class="asst-actions" id="asst-actions"></div>
    <div class="asst-review" id="asst-review" hidden></div>
    ${devTools() ? devPanelHtml() : ''}
  </div>`;

  const el = scroll.querySelector('#asst');
  const orb = new Orb(el.querySelector('#orb-main canvas'), { variant: currentVariant() });
  orb.start();

  session = {
    el, orb, ctx, state: 'idle', transcript: '',
    /* The server holds the proposal. These are the handle to it — an id and
       the version the person is looking at — and a local copy for rendering. */
    turnId: null, version: 0, actions: [], answer: null, understood: '', note: null,
    sources: [], clarification: null, conversationId: null, report: null,
    unavailable: new Set(),
    mic: null, rec: null, tick: null, mockTimer: null, source: null,
  };

  /* Said once, on arrival, and only when true. */
  void showConnectionNote(el);

  renderActions();
  wireDevPanel(el);

  el.querySelector('#orb-main').addEventListener('click', () => {
    if (session.state === 'listening' || session.state === 'paused') finishListening();
    else if (session.state === 'idle' || session.state === 'denied') startListening();
  });

  const vis = () => (document.hidden ? orb.stop() : orb.start());
  document.addEventListener('visibilitychange', vis);
  session.teardown = () => document.removeEventListener('visibilitychange', vis);
}

function setState(s) {
  if (!session) return;
  session.state = s;
  session.el.dataset.state = s;
  session.orb.setState(s === 'denied' ? 'idle' : s);
  const c = COPY[s] ?? COPY.idle;
  session.el.querySelector('#asst-say').textContent = c.say;
  session.el.querySelector('#asst-sub').textContent = c.sub;
  renderActions();
}

/**
 * The buttons under the orb.
 *
 * Speech is one route in, never the only one (§14). Typing is always there,
 * and on a browser with no speech recognition at all it is the primary — a
 * surface whose main control does nothing on Firefox is not a surface.
 */
function renderActions() {
  const box = session?.el.querySelector('#asst-actions');
  if (!box) return;
  const s = session.state;

  if (s === 'listening' || s === 'paused') {
    /* Typing is offered WHILE listening, not only instead of it. Somebody who
     * realises the room is too loud should not have to cancel, work out that
     * the button they want is the one that was there a moment ago, and start
     * again — the way out of speaking is a way into typing. */
    box.innerHTML = `<button type="button" class="btn btn-primary asst-big" id="asst-done">
        ${icon('check', 18)}<span>Done</span></button>
      <button type="button" class="btn btn-ghost" id="asst-type">Type instead</button>
      <button type="button" class="btn btn-ghost" id="asst-cancel">Cancel</button>`;
    box.querySelector('#asst-done').onclick = finishListening;
    box.querySelector('#asst-cancel').onclick = cancelListening;
    box.querySelector('#asst-type').onclick = () => { stopCapture(); setState('idle'); openTypeSheet(); };
    return;
  }
  if (s === 'processing') { box.innerHTML = ''; return; }
  if (s === 'proposal') {
    box.innerHTML = `<button type="button" class="btn btn-ghost" id="asst-again">
      ${icon('sparkle', 16)}<span>Say something else</span></button>`;
    box.querySelector('#asst-again').onclick = () => { reset(); startListening(); };
    return;
  }

  box.innerHTML = `<button type="button" class="btn btn-primary asst-big" id="asst-speak">
      ${icon('sparkle', 18)}<span>Speak</span></button>
    <button type="button" class="btn btn-ghost" id="asst-type">Type instead</button>
    <button type="button" class="btn btn-ghost" id="asst-quick">Quick add</button>`;
  box.querySelector('#asst-speak').onclick = startListening;
  box.querySelector('#asst-type').onclick = openTypeSheet;
  box.querySelector('#asst-quick').onclick = () => session.ctx.quickAdd?.();
}

async function showConnectionNote(el) {
  const note = el.querySelector('#asst-note');
  if (!note) return;
  try {
    if (await api.plannerReady()) { note.hidden = true; return; }
    const c = await api.capabilities();
    el.querySelector('#asst-note-t').textContent = c.planner?.reason
      ?? 'The assistant is not connected to a model yet.';
    note.hidden = false;
  } catch {
    /* Offline, or not signed in. Silence is right: the note is for a
       configuration problem, not for a network blip the app already reports. */
    note.hidden = true;
  }
}

function reset() {
  if (!session) return;
  session.transcript = '';
  session.turnId = null;
  session.version = 0;
  session.actions = [];
  session.answer = null;
  session.understood = '';
  session.sources = [];
  session.clarification = null;
  session.note = null;
  session.report = null;
  session.unavailable = new Set();
  session.el.querySelector('#asst-script').innerHTML = '';
  const src = session.el.querySelector('#asst-src');
  if (src) { src.textContent = ''; src.hidden = true; }
  session.el.classList.remove('has-script');
  const review = session.el.querySelector('#asst-review');
  review.hidden = true;
  review.innerHTML = '';
  setState('idle');
}

/* ── Listening ─────────────────────────────────────────────────────────── */

async function startListening() {
  if (!session) return;
  reset();
  setState('starting');

  const mic = new MicLevel();
  const got = await mic.start();
  if (!session) { mic.stop(); return; }

  if (got === 'ok') {
    session.mic = mic;
    session.source = 'mic';
    session.tick = setInterval(() => {
      session.orb.setLevel(mic.read());
      if (currentVariant() === 'c') session.orb.setBins(mic.bins());
    }, 50);
    startRecognition();
    setState('listening');
    return;
  }

  /* No microphone, or it was refused. The interaction is still testable —
   * §10 — and the surface says which source it is using rather than
   * pretending a synthetic level is a voice. */
  session.source = got === 'denied' ? 'denied' : 'unsupported';
  if (got === 'denied') { setState('denied'); showSourceNote(); return; }
  runMockCapture(MOCK_TRANSCRIPTS[0]);
}

/**
 * Browser speech recognition, where it exists.
 *
 * Chrome and Safari implement it under a prefix and behave differently;
 * Firefox does not implement it at all. So it is treated as an enhancement
 * on top of a transcript that has a development source — never as the thing
 * the interaction depends on.
 */
function startRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showSourceNote('No speech recognition in this browser — type, or use a demo transcript.'); return; }
  try {
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    let settled = '';
    rec.onresult = (e) => {
      if (!session) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i];
        if (r.isFinal) settled += `${r[0].transcript} `;
        else interim += r[0].transcript;
      }
      paintTranscript(`${settled}${interim}`.trim());
    };
    rec.onerror = () => showSourceNote('Speech recognition stopped — you can type it instead.');
    rec.start();
    session.rec = rec;
  } catch {
    showSourceNote('Speech recognition is unavailable here — you can type it instead.');
  }
}

/**
 * The development transcript.
 *
 * Plays a fixed sentence at speaking pace and drives the orb from a
 * speech-shaped envelope, so the whole interaction can be walked on a
 * machine with no microphone. Labelled on screen the entire time.
 */
function runMockCapture(script) {
  if (!session) return;
  session.source = 'mock';
  showSourceNote(`Demo transcript — “${script.label}”. The orb is being driven by a synthetic voice.`);
  setState('listening');

  const words = script.text.split(' ');
  let i = 0;
  const t0 = performance.now();
  session.tick = setInterval(() => {
    if (!session) return;
    session.orb.setLevel(synthLevel(performance.now() - t0));
  }, 50);

  const step = () => {
    if (!session || session.state !== 'listening') return;
    i += 1;
    paintTranscript(words.slice(0, i).join(' '));
    if (i < words.length) session.mockTimer = setTimeout(step, script.pace);
    else session.mockTimer = setTimeout(() => finishListening(), 700);
  };
  session.mockTimer = setTimeout(step, 260);
}

function paintTranscript(text) {
  if (!session) return;
  session.transcript = text;
  const box = session.el.querySelector('#asst-script');
  box.innerHTML = `<p class="asst-line">${esc(text)}</p>`;
  /* The orb moves DOWN once words exist, opening the space above it (§10).
   * A class rather than a measurement, so it is one composited transform and
   * it reverses cleanly. */
  session.el.classList.add('has-script');
  box.scrollTop = box.scrollHeight;
}

/**
 * Where the words on screen came from.
 *
 * Its own element, deliberately, and NOT inside the transcript: the
 * transcript is rewritten on every word, so a note put in there is wiped by
 * the first thing the recogniser hears. Which is exactly what happened — the
 * label saying "this is a demo transcript" survived for about 200ms.
 */
function showSourceNote(msg) {
  if (!session) return;
  const el = session.el.querySelector('#asst-src');
  const text = msg ?? (session.source === 'denied'
    ? 'The microphone is blocked in this browser. You can type instead.'
    : '');
  if (!el || !text) return;
  el.textContent = text;
  el.hidden = false;
}

function cancelListening() {
  stopCapture();
  reset();
}

function stopCapture() {
  if (!session) return;
  clearInterval(session.tick); session.tick = null;
  clearTimeout(session.mockTimer); session.mockTimer = null;
  try { session.rec?.stop(); } catch { /* never started */ }
  session.rec = null;
  session.mic?.stop();
  session.mic = null;
  session.orb.setLevel(0);
}

async function finishListening() {
  if (!session) return;
  const text = session.transcript.trim();
  stopCapture();
  if (!text) { reset(); return; }
  await propose(text);
}

/* ── A turn ────────────────────────────────────────────────────────────── */

/**
 * Say it, and render what came back.
 *
 * The whole turn happens on the server: retrieval, ranking, memory, planning,
 * calendar preview. What arrives is a proposal set that already exists in the
 * database, so a refresh does not lose it and a confirmation cannot run
 * anything the planner did not write.
 */
/** One turn onto the session. Two entry points, one shape, no drift. */
function applyTurn(r) {
  session.turnId = r.turnId;
  session.conversationId = r.conversationId;
  session.version = r.version;
  session.actions = r.actions ?? [];
  session.answer = r.answer ?? null;
  session.understood = r.understood ?? '';
  session.sources = r.sources ?? [];
  session.clarification = r.clarification ?? null;
  session.note = r.note ?? null;
  session.report = null;
}

async function propose(text) {
  if (!session) return;
  setState('processing');
  try {
    const r = await api.turn({
      text,
      conversationId: session.conversationId,
      surface: session.ctx.surface?.() ?? null,
    });
    if (!session) return;
    applyTurn(r);
    await markUnavailable();
    renderReview();
    setState('proposal');
  } catch (e) {
    if (!session) return;
    setState('idle');
    /* The server says what went wrong — no model configured, timed out,
       rate limited. Repeating its sentence beats "something went wrong". */
    session.ctx.toast?.(e.message, true);
  }
}

/**
 * The user picked one of the options.
 *
 * A continuation of the SAME turn, resolved server-side to a stable id. If the
 * option named no entity - "leave them open" is a real choice and not a thing -
 * the server falls back to continuing with the chosen words, which is the old
 * behaviour correctly reserved for the case where there is nothing to name.
 */
async function answerQuestion(optionId) {
  if (!session?.turnId) return;
  setState('processing');
  try {
    const r = await api.clarifyTurn(session.turnId, optionId);
    if (!session) return;
    applyTurn(r);
    await markUnavailable();
    renderReview();
    setState('proposal');
  } catch (e) {
    if (!session) return;
    setState('proposal');
    session.ctx.toast?.(e.message, true);
  }
}

/**
 * A proposal can outlive the thing it needs.
 *
 * Google disconnects, a module is removed. The card still shows what was
 * meant; it is marked unrunnable rather than offering a button that fails.
 */
async function markUnavailable() {
  session.unavailable = new Set();
  session.unavailableWhy = new Map();
  try {
    const c = await api.capabilities({ force: true });
    const have = new Set((c.capabilities ?? []).map((x) => x.id));
    /* Why each missing one is missing, said in the server's own words. A
       module that is off and a module that can be read but not written are
       different situations and deserve different sentences. */
    const why = new Map();
    for (const m of c.readOnly ?? []) why.set(m.id, m.reason);
    for (const m of c.unavailable ?? []) why.set(m.id, m.reason);
    for (const a of session.actions) {
      if (have.has(a.capability)) continue;
      session.unavailable.add(a.id);
      const reason = why.get(a.module);
      if (reason) session.unavailableWhy.set(a.id, reason);
    }
  } catch { /* leave everything enabled rather than disabling on a blip */ }
}

/* ── The proposal ──────────────────────────────────────────────────────── */

/** Is this just the request again? Compared on words, not punctuation. */
function echoes(request, understood) {
  if (!understood) return true;
  const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return norm(request) === norm(understood);
}

function renderReview() {
  const box = session.el.querySelector('#asst-review');
  const list = session.actions;
  const runnable = list.filter((a) => a.enabled && !session.unavailable.has(a.id));
  const n = runnable.length;

  box.hidden = false;
  box.innerHTML = `
    ${/* An "understood" that only restates the request reads as a stutter: the
          transcript is directly above it. It earns its place when it says
          something the user did not. */ ''}
    ${session.understood && !echoes(session.transcript, session.understood)
    ? `<h2 class="asst-h">${esc(session.understood)}</h2>` : ''}
    ${session.answer ? `<p class="asst-reply">${esc(session.answer)}</p>` : ''}
    ${session.answer ? sourcesHtml(session.sources) : ''}
    ${session.note ? `<p class="asst-note-line">${esc(session.note)}</p>` : ''}
    ${clarificationHtml(session.clarification)}
    ${session.report ? resultsHtml(session.report) : ''}
    ${!session.report ? list.map((a) => actionCardHtml(a, {
    unavailable: session.unavailable.has(a.id),
    reason: session.unavailableWhy?.get(a.id) ?? null,
  })).join('') : ''}
    ${!session.report && !list.length && !session.answer && !session.clarification
    ? '<p class="asst-empty">Nothing to change.</p>' : ''}
    ${!session.report && n ? `<div class="asst-confirm">
      <button type="button" class="btn btn-ghost" id="asst-discard">Discard</button>
      <button type="button" class="btn btn-primary" id="asst-commit">
        Confirm ${n} change${n === 1 ? '' : 's'}</button>
    </div>` : ''}`;

  wireReview(box);
}

function wireReview(box) {
  box.querySelectorAll('[data-toggle]').forEach((el) => {
    el.onchange = () => void edit(el.dataset.toggle, { enabled: el.checked });
  });
  box.querySelectorAll('[data-field]').forEach((el) => {
    el.onclick = () => editField(el.dataset.field, el.dataset.key);
  });
  box.querySelectorAll('[data-clarify]').forEach((el) => {
    /* The button carries an OPTION ID, not its label. The server holds what
       each option stands for, so the original request continues with the exact
       entity the assistant was already looking at. Sending the label back as a
       fresh sentence - which is what this used to do - threw that away and
       asked the planner to work it out again from less. */
    el.onclick = () => void answerQuestion(el.dataset.clarify);
  });
  box.querySelectorAll('[data-src-id]').forEach((el) => {
    el.onclick = () => session.ctx.openEntity?.({
      type: el.dataset.srcType, id: el.dataset.srcId,
    });
  });
  box.querySelector('#asst-discard')?.addEventListener('click', () => void discard());
  box.querySelector('#asst-commit')?.addEventListener('click', () => void commit());
}

/** Push one edit to the authoritative proposal and re-render what came back. */
async function edit(actionId, change) {
  if (!session?.turnId) return;
  try {
    const r = await api.editTurn(session.turnId, session.version, [{ actionId, ...change }]);
    session.version = r.version;
    session.actions = r.actions;
    renderReview();
  } catch (e) {
    session.ctx.toast?.(e.message, true);
    /* The server refused. Re-read rather than leaving the screen showing a
       change that did not happen. */
    void refresh();
  }
}

async function refresh() {
  if (!session?.turnId) return;
  const r = await api.readTurn(session.turnId).catch(() => null);
  if (!r || !session) return;
  session.version = r.version;
  session.actions = r.actions ?? [];
  renderReview();
}

function editField(actionId, key) {
  const action = session.actions.find((x) => x.id === actionId);
  const f = action?.editable?.find((x) => x.key === key);
  if (!f) return;

  openSheet({
    title: f.label,
    body: `<div class="msheet-pad">
      <input class="m-input" id="ap-edit" data-autofocus value="${esc(f.value ?? '')}"
        ${f.type === 'date' ? 'type="date"' : f.type === 'time' ? 'type="time"' : 'type="text"'}></div>`,
    foot: '<button type="button" class="btn btn-primary" id="ap-save">Save</button>',
    onMount: (rootEl, close) => {
      const input = rootEl.querySelector('#ap-edit');
      const save = async () => {
        close();
        await edit(actionId, { fields: { [key]: input.value } });
      };
      rootEl.querySelector('#ap-save').onclick = () => void save();
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } };
    },
  });
}

/**
 * Confirmation.
 *
 * The count goes with it and the server checks it. Important actions are
 * accepted individually, in a sheet that names them — the batch confirmation
 * does not cover a meeting other people were invited to.
 */
async function commit() {
  const runnable = session.actions.filter((a) => a.enabled && !session.unavailable.has(a.id));
  const n = runnable.length;
  const important = runnable.filter((a) => a.important);

  if (important.length) {
    const ok = await confirmImportant(important);
    if (!ok) return;
  }
  await run(n, important.map((a) => a.id));
}

function confirmImportant(list) {
  return new Promise((resolve) => {
    let settled = false;
    openSheet({
      title: list.length === 1 ? 'Confirm this change' : `Confirm ${list.length} changes`,
      body: `<div class="msheet-pad">
        <p class="msheet-p">${list.length === 1 ? 'This one is' : 'These are'} harder to undo,
        so ${list.length === 1 ? 'it needs' : 'they need'} a separate yes.</p>
        <ul class="msheet-list">${list.map((a) => `<li>${esc(a.title)}</li>`).join('')}</ul>
      </div>`,
      foot: `<button type="button" class="btn btn-ghost" data-no>Back</button>
        <button type="button" class="btn btn-primary" data-yes>Yes, do ${
  list.length === 1 ? 'it' : 'them'}</button>`,
      onMount: (rootEl, close) => {
        rootEl.querySelector('[data-yes]').onclick = () => {
          settled = true; close(); resolve(true);
        };
        rootEl.querySelector('[data-no]').onclick = () => { settled = true; close(); resolve(false); };
      },
      onClose: () => { if (!settled) resolve(false); },
    });
  });
}

async function run(count, importantAccepted) {
  try {
    const report = await api.confirmTurn(
      session.turnId, session.version, count, importantAccepted,
    );
    if (!session) return;
    session.report = report;
    renderReview();
    /* The board behind this is now wrong. Refreshing it is the difference
       between "it says it did it" and "it did it". */
    session.ctx.afterChanges?.();
  } catch (e) {
    session.ctx.toast?.(e.message, true);
    void refresh();
  }
}

async function discard() {
  if (session?.turnId) await api.discardTurn(session.turnId).catch(() => {});
  reset();
}

/* ── Typing ───────────────────────────────────────────────────────────── */

function openTypeSheet() {
  openSheet({
    title: 'Tell Life OS',
    body: `<div class="msheet-pad">
      <textarea class="m-input asst-ta" id="asst-text" data-autofocus rows="4"
        placeholder="I finished the website changes, I need a haircut tomorrow…"></textarea>
      ${devTools() ? `<div class="asst-demos">
        <span class="asst-demos-h">Demo sentences</span>
        ${MOCK_TRANSCRIPTS.map((m) => `<button type="button" class="chip"
          data-demo="${esc(m.id)}">${esc(m.label)}</button>`).join('')}
      </div>` : ''}
    </div>`,
    foot: `<button type="button" class="btn btn-ghost asst-mic" id="asst-tomic"
        aria-label="Speak instead">${icon('sparkle', 18)}<span>Speak</span></button>
      <button type="button" class="btn btn-primary" id="asst-send">Send</button>`,
    onMount: (rootEl, close) => {
      const ta = rootEl.querySelector('#asst-text');
      // The way back to the microphone, from inside the typing sheet (§15).
      rootEl.querySelector('#asst-tomic').onclick = () => { close(); startListening(); };
      rootEl.querySelectorAll('[data-demo]').forEach((b) => {
        b.onclick = () => { ta.value = MOCK_TRANSCRIPTS.find((m) => m.id === b.dataset.demo).text; };
      });
      rootEl.querySelector('#asst-send').onclick = () => {
        const v = ta.value.trim();
        close();
        if (!v) return;
        paintTranscript(v);
        propose(v);
      };
    },
  });
}

/* ══════════════════════════════════════════════════════════════════════
   DEVELOPMENT CONTROLS
   The A/B/C selector and the demo transcripts. Not a user setting — one
   of these three will be chosen and the other two deleted, and a
   preference nobody is meant to keep does not belong in Settings.
   ══════════════════════════════════════════════════════════════════════ */
function devPanelHtml() {
  const v = currentVariant();
  return `<section class="asst-dev">
    <h2>Development</h2>
    <p class="asst-dev-p">Listening style — pick one to compare. This is not a
      user setting; it disappears when the style is chosen.</p>
    <div class="asst-dev-row" role="radiogroup" aria-label="Listening style">
      ${VARIANTS.map((x) => `<button type="button" class="chip ${x.id === v ? 'on' : ''}"
        role="radio" aria-checked="${x.id === v}" data-variant="${x.id}">
        ${x.id.toUpperCase()} · ${esc(x.label)}</button>`).join('')}
    </div>
    <p class="asst-dev-hint" id="asst-dev-hint">${
  esc(VARIANTS.find((x) => x.id === v)?.hint ?? '')}</p>
    <div class="asst-dev-row">
      ${MOCK_TRANSCRIPTS.map((m) => `<button type="button" class="chip"
        data-mock="${esc(m.id)}">Play “${esc(m.label)}”</button>`).join('')}
    </div>
  </section>`;
}

function wireDevPanel(el) {
  /* Scoped to the panel. `[data-variant]` also matches the ORB, which carries
   * the chosen variant as an attribute — an unscoped selector wired it as a
   * fourth radio button and put a click handler on the thing being previewed. */
  el.querySelectorAll('.asst-dev [data-variant]').forEach((b) => {
    b.onclick = () => {
      setVariant(b.dataset.variant);
      session.orb.setVariant(b.dataset.variant);
      el.querySelectorAll('#orb-main,[id^="orb-"]').forEach((o) => {
        o.dataset.variant = b.dataset.variant;
      });
      el.querySelectorAll('.asst-dev [data-variant]').forEach((x) => {
        const on = x.dataset.variant === b.dataset.variant;
        x.classList.toggle('on', on);
        x.setAttribute('aria-checked', String(on));
      });
      const hint = el.querySelector('#asst-dev-hint');
      if (hint) hint.textContent = VARIANTS.find((x) => x.id === b.dataset.variant)?.hint ?? '';
    };
  });
  el.querySelectorAll('[data-mock]').forEach((b) => {
    b.onclick = () => {
      reset();
      stopCapture();
      runMockCapture(MOCK_TRANSCRIPTS.find((m) => m.id === b.dataset.mock));
    };
  });
}

export { closeSheet };
