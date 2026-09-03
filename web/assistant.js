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
import { Orb, MicLevel, synthLevel } from './assistant-orb.js';
import { VoiceInput, VoiceTrace } from './voice-input.js';
import {
  PRESETS, PARAMS, currentConfig, saveConfig, clearConfig,
} from './orb-lab.js';
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
import { proseHtml } from './assistant-prose.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Development controls — the A/B/C selector and the mock transcripts. */
export const devTools = () => Boolean(window.LIFE_OS_CONFIG?.devTools)
  || (() => { try { return localStorage.getItem('los2_dev') === '1'; } catch { return false; } })();


/* ── State copy ──────────────────────────────────────────────────────────
 * One line per state, and no personality. "Making sense of that" is a
 * description of what is happening; "Hmm, let me think about that! 🤔" is a
 * character the app does not have and cannot sustain. */
const COPY = {
  idle: { say: 'Tell Life OS what’s going on', sub: 'Tap to speak, or type it instead' },
  starting: { say: 'Getting the microphone…', sub: '' },
  listening: { say: 'Listening…', sub: 'Tap Done when you’ve finished' },
  paused: { say: 'Still listening', sub: 'Tap when you’re done' },
  /* Reached by stopping on a pause rather than by a tap. It stops LISTENING
     and nothing else: sending a half-finished sentence because somebody drew
     breath is worse than one more tap. */
  heard: { say: 'Is that right?', sub: 'Edit it, say more, or send it' },
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
  window.__losBusy = null;
  session.orb?.destroy();
  session.mic?.stop();
  /* `destroy`, not `stop`: leaving the route is not "finish the sentence",
     and a recogniser left running holds the microphone behind a page nobody
     is looking at — the browser goes on showing the recording dot. */
  session.voice?.destroy();
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
  return `<div class="orb orb-${size}" id="${id}">
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
  const orb = new Orb(el);
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
  const orb = new Orb(el.querySelector('#orb-main canvas'));
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
    if (session.state === 'listening' || session.state === 'paused') { endListening(); return; }
    /* Tapping the orb after it has heard something CARRIES ON, keeping what
       is there. Having to find "Say more" to add a sentence — when the orb
       is the thing you just tapped to start — is a rule nobody should have
       to learn. */
    if (session.state === 'heard') { resumeListening(); return; }
    if (session.state === 'idle' || session.state === 'denied') startListening();
  });

  const vis = () => (document.hidden ? orb.stop() : orb.start());
  document.addEventListener('visibilitychange', vis);
  session.teardown = () => document.removeEventListener('visibilitychange', vis);
}

/** States a reload would destroy something in. Read by `pwa.js`. */
const BUSY_STATES = new Set(['starting', 'listening', 'paused', 'heard', 'processing']);

function setState(s) {
  if (!session) return;
  session.state = s;
  session.el.dataset.state = s;
  /* A service worker update must not reload the page out from under a
     sentence. `processing` matters as much as `listening`: the request is in
     flight and a reload loses the answer somebody is waiting for. */
  window.__losBusy = () => BUSY_STATES.has(session?.state ?? 'idle');
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
    box.querySelector('#asst-done').onclick = endListening;
    box.querySelector('#asst-cancel').onclick = cancelListening;
    box.querySelector('#asst-type').onclick = () => { stopCapture(); setState('idle'); openTypeSheet(); };
    return;
  }
  if (s === 'heard') {
    /* NOT `#asst-send` — the typing sheet already owns that id, and two
       elements answering to one name is how a click ends up on the wrong
       button. */
    box.innerHTML = `<button type="button" class="btn btn-primary asst-big" id="asst-send-heard">
        ${icon('check', 18)}<span>Send</span></button>
      <button type="button" class="btn btn-ghost" id="asst-edit">Edit</button>
      <button type="button" class="btn btn-ghost" id="asst-more">Say more</button>
      <button type="button" class="btn btn-ghost" id="asst-cancel">Cancel</button>`;
    box.querySelector('#asst-send-heard').onclick = sendHeard;
    box.querySelector('#asst-cancel').onclick = cancelListening;
    /* Carries on from what is already there rather than starting over. */
    box.querySelector('#asst-more').onclick = () => resumeListening();
    /* The same typing sheet, holding what was heard. Correcting a word is
       the commonest thing somebody wants here, and it should not mean
       saying the whole sentence again. */
    box.querySelector('#asst-edit').onclick = () => {
      const heard = session.transcript.trim();
      stopCapture();
      setState('idle');
      openTypeSheet(heard);
    };
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
    /* `??` only catches null and undefined. The server returns an EMPTY
       STRING when it has no particular reason, which sailed through and left
       an amber bar containing a dot and nothing else — a warning with no
       words, which is worse than no warning. */
    const reason = String(c.planner?.reason ?? '').trim();
    el.querySelector('#asst-note-t').textContent = reason
      || 'The assistant is not connected to a model yet, so it cannot answer.';
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

/**
 * Start listening.
 *
 * ── Recognition owns the microphone ──────────────────────────────────────
 *
 * There used to be TWO microphone consumers here: `getUserMedia`, feeding the
 * orb's waveform, and the speech recogniser. On a phone they fight, and
 * `getUserMedia` wins — it takes the microphone first and holds it, and the
 * recogniser starts, hears nothing, and ends. Chrome plays its start tone on
 * every attempt, which is why an empty room produced bing after bing while
 * the waves danced and not one word ever arrived.
 *
 * Desktop never had the problem because desktop never opened a second stream.
 * That was the difference between the surface that worked and the one that
 * did not.
 *
 * So there is one consumer now. The orb is driven by RESULTS instead of by
 * loudness, which is also the honest picture: the waves move when words are
 * being heard, and go still when they are not. A waveform that dances to a
 * passing lorry while transcription is dead is exactly the lie this whole
 * pass exists to remove.
 *
 * The level meter survives for the one case that still needs it — no
 * recogniser in this browser — where there are no words to draw from.
 *
 * NOT async, so the user's tap is still live when `start()` is called: iOS
 * Safari refuses to begin recognition once the activation has been spent.
 */
function startListening() {
  if (!session) return;
  reset();
  setState('starting');

  if (startSpeech()) {
    /* The orb, from the words. Same 50ms tick the meter used. */
    session.tick = setInterval(() => {
      if (!session?.voice) return;
      const level = session.voice.activity;
      session.orb.setLevel(level);
      paintMeter(level);
    }, 50);
    return;
  }

  /* No recogniser at all. Nothing can be transcribed here, so the meter is
     the only honest thing left to show — and it is labelled. */
  void startLevelOnly();
}

/**
 * Carry on after a pause, keeping what was already said.
 *
 * A fresh `start()` would clear the transcript, which is precisely what
 * somebody adding a second sentence does not want.
 */
function resumeListening() {
  if (!session) return;
  const sofar = session.transcript.trim();
  clearInterval(session.tick);
  if (startSpeech(sofar)) {
    session.tick = setInterval(() => {
      if (!session?.voice) return;
      const level = session.voice.activity;
      session.orb.setLevel(level);
      paintMeter(level);
    }, 50);
  }
}

/**
 * The event trace, in development only.
 *
 * One per surface rather than one per session, so a trace covers the whole
 * visit and a stale recogniser from an earlier session is still visible in
 * it — which is exactly the sort of thing we are looking for.
 */
let trace = null;
export const voiceTrace = () => trace;

/** Speech recognition, through the shared controller. Synchronous. */
function startSpeech(base = '') {
  /* A previous controller would go on holding the microphone. */
  session.voice?.destroy();
  if (devTools() && !trace) trace = new VoiceTrace();
  session.voice = new VoiceInput({
    trace,
    onState: (st) => {
      if (!session) return;
      if (st === 'listening') setState('listening');
      /* The engine stopped on its own, on a pause long enough to be the end
         of a sentence. It stops LISTENING and waits: a pause mid-thought is
         common, and sending on one would act on half a sentence. */
      if (st === 'idle' && (session.state === 'listening' || session.state === 'starting')) {
        /* The controller settled itself, so nothing else will clear the
           animation tick — it would go on polling a signal that is now
           permanently zero. */
        clearInterval(session.tick); session.tick = null;
        session.orb.setLevel(0);
        setState(session.transcript.trim() ? 'heard' : 'idle');
        refreshTraceCount();
      }
    },
    onTranscript: ({ full }) => {
      if (!session) return;
      session.source = 'mic';
      paintTranscript(full);
    },
    onError: ({ kind, message }) => {
      if (!session) return;
      if (kind === 'denied') { session.source = 'denied'; setState('denied'); }
      else if (session.state === 'listening' || session.state === 'starting') {
        setState('idle');
      }
      showSourceNote(message);
    },
  });
  return session.voice.start(base);
}

/** The development meter, so the signal driving the picture is visible. */
function paintMeter(level) {
  const el = document.querySelector('#asst-meter');
  if (el) el.style.width = `${Math.round(clamp01(level) * 100)}%`;
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * The waveform, for a browser with no speech recognition.
 *
 * The only path that still opens a microphone stream, and it can afford to:
 * there is no recogniser for it to compete with.
 */
async function startLevelOnly() {
  const mic = new MicLevel();
  const got = await mic.start();
  if (!session) { mic.stop(); return; }

  if (got === 'ok') {
    session.mic = mic;
    session.source = 'mic';
    session.tick = setInterval(() => {
      if (!session) return;
      session.orb.setLevel(mic.read());
    }, 50);
    setState('listening');
    showSourceNote('This browser cannot turn speech into text — the orb is '
      + 'following your voice, but nothing is being transcribed. Type it instead.');
    return;
  }

  if (got === 'denied') {
    session.source = 'denied';
    setState('denied');
    showSourceNote();
    return;
  }
  session.source = 'unsupported';
  runMockCapture(MOCK_TRANSCRIPTS[0]);
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
    else session.mockTimer = setTimeout(() => endListening(), 700);
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
  /* `stop`, not `cancel`: the last thing somebody said is usually the thing
     they most want kept, and stop lets the engine deliver it. */
  session.voice?.stop();
  session.mic?.stop();
  session.mic = null;
  session.orb.setLevel(0);
}

/**
 * Stop listening. Do NOT send.
 *
 * ── The one rule ─────────────────────────────────────────────────────────
 *
 * VOICE NEVER AUTO-SUBMITS. Finishing transcription means the words are ready
 * to be read, not that a request has been made. Every way of ending a
 * listening session — tapping Done, or two seconds of silence — arrives here,
 * and all of them land in review.
 *
 * Speech recognition is not reliable enough to act on unseen, and a request
 * the assistant acts on is a request somebody should have read first. Typing
 * has always worked this way: you see the words before you press send.
 */
function endListening() {
  if (!session) return;
  stopCapture();
  const text = session.transcript.trim();
  setState(text ? 'heard' : 'idle');
}

/** The ONLY path from voice to the assistant, and it takes a deliberate tap. */
async function sendHeard() {
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
    ${session.answer ? `<div class="asst-reply">${proseHtml(session.answer)}</div>` : ''}
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

function openTypeSheet(prefill = '') {
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
      if (prefill) {
        ta.value = prefill;
        /* Caret at the end, not over the text: this is a correction, and
           selecting the lot means the first keystroke destroys it. */
        ta.setSelectionRange(prefill.length, prefill.length);
      }
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
  /* COLLAPSED by default, and the diagnostics come FIRST.
     It was a tall block of style comparisons with the one control I actually
     needed buried underneath it — on a phone that control was below the fold
     of a page that also scrolled sideways, which is why it could not be
     found. A testing panel must not be the biggest thing on the screen. */
  return `<details class="asst-dev" id="asst-dev">
    <summary class="asst-dev-sum">Development</summary>
    <div class="asst-dev-body">
      <p class="asst-dev-p">Voice diagnostics record what the BROWSER reported —
        events, indexes and the recognised words. No audio is captured, and
        nothing leaves this device until you copy it.</p>
      <div class="asst-dev-row">
        <button type="button" class="chip chip-lead" id="asst-copy-trace">
          Copy voice diagnostics</button>
        <button type="button" class="chip" id="asst-clear-trace">Clear</button>
      </div>
      <p class="asst-dev-hint" id="asst-trace-note"></p>
      <p class="asst-dev-p">Live signal — what the waveform is being driven by.
        This is speech arrival rate, not microphone loudness.</p>
      <div class="asst-meter"><span class="asst-meter-fill" id="asst-meter"></span></div>

      <p class="asst-dev-p">Listening visual — twenty starting points, then every
        number below is live. Speak while adjusting. This is a design
        instrument, not a user setting.</p>
      <div class="asst-dev-row" id="asst-presets">
        ${PRESETS.map((pr, i) => `<button type="button" class="chip"
          data-preset="${i}">${esc(pr.name)}</button>`).join('')}
      </div>
      <div class="asst-lab" id="asst-lab"></div>
      <div class="asst-dev-row">
        <button type="button" class="chip" id="asst-lab-copy">Copy this config</button>
        <button type="button" class="chip" id="asst-lab-reset">Reset</button>
      </div>

      <div class="asst-dev-row">
        ${MOCK_TRANSCRIPTS.map((m) => `<button type="button" class="chip"
          data-mock="${esc(m.id)}">Play “${esc(m.label)}”</button>`).join('')}
      </div>
    </div>
  </details>`;
}

/** Says how much there is to copy, without needing the panel to be open. */
function refreshTraceCount() {
  const btn = document.querySelector('#asst-copy-trace');
  if (!btn) return;
  const n = voiceTrace()?.rows.length ?? 0;
  btn.textContent = n ? `Copy voice diagnostics (${n})` : 'Copy voice diagnostics';
  btn.classList.toggle('chip-ready', n > 0);
  const sum = document.querySelector('#asst-dev .asst-dev-sum');
  if (sum) sum.dataset.count = n ? String(n) : '';
}

function wireDevPanel(el) {
  /* Scoped to the panel. `[data-variant]` also matches the ORB, which carries
   * the chosen variant as an attribute — an unscoped selector wired it as a
   * fourth radio button and put a click handler on the thing being previewed. */
  const note = (m) => {
    const n = el.querySelector('#asst-trace-note');
    if (n) n.textContent = m;
  };
  const copyBtn = el.querySelector('#asst-copy-trace');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const t = voiceTrace();
      if (!t || !t.rows.length) { note('No voice trace captured yet.'); return; }
      const text = t.text();
      try {
        await navigator.clipboard.writeText(text);
        note(`Copied ${t?.rows.length ?? 0} events.`);
      } catch {
        /* Clipboard access is refused in plenty of mobile contexts. Falling
           back to a selectable box beats telling somebody it failed when the
           thing they wanted is right there. */
        const box = document.createElement('textarea');
        box.className = 'asst-trace-box';
        box.readOnly = true;
        box.value = text;
        el.querySelector('.asst-dev')?.appendChild(box);
        box.select();
        note('Could not reach the clipboard — select the text below and copy it.');
      }
    };
  }
  refreshTraceCount();
  const clearBtn = el.querySelector('#asst-clear-trace');
  if (clearBtn) {
    clearBtn.onclick = () => {
      voiceTrace()?.clear();
      el.querySelector('.asst-trace-box')?.remove();
      note('Cleared. Speak, then copy.');
    };
  }

  /* ── The listening-visual lab ──────────────────────────────────
     Presets are starting points; the sliders are the actual instrument.
     Everything applies on the next frame, so it can be adjusted WHILE
     speaking — which is the only way to judge a reaction speed. */
  const labBox = el.querySelector('#asst-lab');
  const apply = (cfg) => {
    saveConfig(cfg);
    session?.orb?.setConfig(cfg);
    renderLab(cfg);
  };
  function renderLab(cfg) {
    if (!labBox) return;
    labBox.innerHTML = [
      `<label class="asst-lab-row"><span>Family</span>
        <select id="lab-mode">
          ${['ribbon', 'body', 'both'].map((m) => `<option value="${m}"
            ${m === cfg.mode ? 'selected' : ''}>${m}</option>`).join('')}
        </select></label>`,
      `<label class="asst-lab-row"><span>Symmetrical</span>
        <input type="checkbox" id="lab-even" ${cfg.even !== false ? 'checked' : ''}></label>`,
      `<label class="asst-lab-row"><span>Beyond colour</span>
        <input type="color" id="lab-beyond" value="${esc(cfg.beyond)}"></label>`,
      ...PARAMS.map((pm) => `<label class="asst-lab-row"><span>${esc(pm.label)}</span>
        <input type="range" data-p="${pm.key}" min="${pm.min}" max="${pm.max}"
          step="${pm.step}" value="${cfg[pm.key] ?? pm.min}">
        <b>${Number(cfg[pm.key] ?? pm.min)}</b></label>`),
    ].join('');

    labBox.querySelectorAll('input[type=range]').forEach((inp) => {
      inp.oninput = () => {
        const next = { ...currentConfig(), [inp.dataset.p]: Number(inp.value) };
        inp.nextElementSibling.textContent = inp.value;
        saveConfig(next);
        session?.orb?.setConfig(next);
      };
    });
    labBox.querySelector('#lab-mode').onchange = (ev) =>
      apply({ ...currentConfig(), mode: ev.target.value });
    labBox.querySelector('#lab-even').onchange = (ev) =>
      apply({ ...currentConfig(), even: ev.target.checked });
    labBox.querySelector('#lab-beyond').oninput = (ev) => {
      const next = { ...currentConfig(), beyond: ev.target.value };
      saveConfig(next);
      session?.orb?.setConfig(next);
    };
  }
  renderLab(currentConfig());

  el.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => {
      apply({ ...PRESETS[Number(b.dataset.preset)] });
      el.querySelectorAll('[data-preset]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    };
  });
  const labCopy = el.querySelector('#asst-lab-copy');
  if (labCopy) {
    labCopy.onclick = async () => {
      const text = JSON.stringify(currentConfig(), null, 2);
      try { await navigator.clipboard.writeText(text); note('Config copied.'); }
      catch { note(text); }
    };
  }
  const labReset = el.querySelector('#asst-lab-reset');
  if (labReset) {
    labReset.onclick = () => { clearConfig(); apply(currentConfig()); note('Reset.'); };
  }

  el.querySelectorAll('[data-mock]').forEach((b) => {
    b.onclick = () => {
      reset();
      stopCapture();
      runMockCapture(MOCK_TRANSCRIPTS.find((m) => m.id === b.dataset.mock));
    };
  });
}

export { closeSheet };
