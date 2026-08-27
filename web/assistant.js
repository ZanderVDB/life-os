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
import { mockProvider, MOCK_TRANSCRIPTS } from './assistant-mock.js';
import {
  normalise, changeCount, setEnabled, setItemEnabled, setField,
  isImportant, isMutation, KINDS, summarise, assertConfirmable,
} from './assistant-contract.js';
import { openSheet, closeSheet } from './mobile.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* The provider. One line to change when the real one exists. */
const provider = mockProvider;

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
    <!-- One line. It was a full amber panel, which is the right weight for a
         warning about losing data and the wrong weight for a standing fact —
         it drew the eye before the orb did, every single time the screen
         opened. The full explanation is still given at the moment it matters,
         on the confirmation. -->
    <p class="asst-note"><span class="asst-dot" aria-hidden="true"></span>
      Prototype · nothing will be saved</p>

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
    el, orb, ctx, state: 'idle', transcript: '', proposals: [], response: null,
    mic: null, rec: null, tick: null, mockTimer: null, source: null,
  };

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

function reset() {
  if (!session) return;
  session.transcript = '';
  session.proposals = [];
  session.response = null;
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

/* ── Understanding ─────────────────────────────────────────────────────── */

async function propose(text) {
  if (!session) return;
  setState('processing');
  const ctx = session.ctx;
  let raw;
  try {
    raw = await provider.propose({
      text,
      /* Read-only, and no credentials. The provider is told what exists so
       * its proposals can name real projects and real areas; it is given no
       * way to reach any of them. */
      context: {
        now: Date.now(),
        areas: ctx.areas ?? [],
        projects: ctx.projects ?? [],
        counts: ctx.counts ?? {},
        next: ctx.next ?? null,
      },
    });
  } catch (e) {
    if (!session) return;
    setState('idle');
    ctx.toast?.(e.message, true);
    return;
  }
  if (!session) return;

  const res = normalise({ transcript: text, ...raw });
  session.response = res;
  session.proposals = res.proposals;
  renderReview();
  setState('proposal');
}

/* ── The proposal ──────────────────────────────────────────────────────── */

function renderReview() {
  const box = session.el.querySelector('#asst-review');
  const res = session.response;
  const list = session.proposals;
  const n = changeCount(list);

  box.hidden = false;
  box.innerHTML = `
    <h2 class="asst-h">${esc(res.understood)}</h2>
    ${res.reply ? `<p class="asst-reply">${esc(res.reply)}</p>` : ''}
    ${list.length ? list.map(cardHtml).join('') : '<p class="asst-empty">Nothing to change.</p>'}
    ${res.dropped.length ? `<p class="asst-empty">${res.dropped.length} suggestion${
  res.dropped.length === 1 ? '' : 's'} could not be shown and ${
  res.dropped.length === 1 ? 'was' : 'were'} dropped.</p>` : ''}
    ${n ? `<div class="asst-confirm">
      <button type="button" class="btn btn-ghost" id="asst-discard">Discard</button>
      <button type="button" class="btn btn-primary" id="asst-commit">
        Confirm ${n} change${n === 1 ? '' : 's'}</button>
    </div>` : ''}`;

  wireReview(box);
}

function cardHtml(p) {
  const meta = KINDS[p.kind] ?? {};
  const off = !p.enabled;
  return `<article class="ap ${off ? 'is-off' : ''} ${isImportant(p.kind) ? 'is-important' : ''}"
      data-p="${esc(p.id)}">
    <header class="ap-head">
      <span class="ap-kind">${esc(meta.label ?? p.kind)}</span>
      ${isImportant(p.kind) ? '<span class="ap-flag">Needs your confirmation</span>' : ''}
      ${isMutation(p.kind) ? `<label class="ap-on">
        <input type="checkbox" ${p.enabled ? 'checked' : ''} data-toggle="${esc(p.id)}">
        <span class="sr-only">Include this change</span></label>` : ''}
    </header>
    <p class="ap-title">${esc(p.title)}</p>
    ${p.summary || summarise(p) ? `<p class="ap-sum">${esc(p.summary || summarise(p))}</p>` : ''}
    ${p.context ? `<p class="ap-ctx">${esc(p.context)}</p>` : ''}
    ${p.items.length ? `<ul class="ap-items">${p.items.map((i) => `<li>
      <label class="ap-item">
        <input type="checkbox" ${i.enabled ? 'checked' : ''}
          data-item="${esc(p.id)}" data-item-id="${esc(i.id)}">
        <span>${esc(i.label)}</span></label></li>`).join('')}</ul>` : ''}
    ${p.fields.length ? `<div class="ap-fields">${p.fields.map((f) => `
      <button type="button" class="ap-field" data-field="${esc(p.id)}" data-key="${esc(f.key)}">
        <span class="ap-flabel">${esc(f.label)}</span>
        <span class="ap-fvalue">${esc(f.value ?? '—')}</span>
        ${icon('pencil', 14)}
      </button>`).join('')}</div>` : ''}
  </article>`;
}

function wireReview(box) {
  box.querySelectorAll('[data-toggle]').forEach((el) => {
    el.onchange = () => {
      session.proposals = setEnabled(session.proposals, el.dataset.toggle, el.checked);
      renderReview();
    };
  });
  box.querySelectorAll('[data-item]').forEach((el) => {
    el.onchange = () => {
      session.proposals = setItemEnabled(session.proposals,
        el.dataset.item, el.dataset.itemId, el.checked);
      renderReview();
    };
  });
  box.querySelectorAll('[data-field]').forEach((el) => {
    el.onclick = () => editField(el.dataset.field, el.dataset.key);
  });
  box.querySelector('#asst-discard')?.addEventListener('click', () => reset());
  box.querySelector('#asst-commit')?.addEventListener('click', commit);
}

/**
 * Editing one field of one proposal.
 *
 * §13: a misheard item is corrected here. Nothing about this asks the person
 * to say it all again, which is the failure mode that makes voice assistants
 * unusable the moment they get one word wrong.
 */
function editField(pid, key) {
  const p = session.proposals.find((x) => x.id === pid);
  const f = p?.fields.find((x) => x.key === key);
  if (!f) return;

  if (f.type === 'choice') {
    openSheet({
      title: f.label,
      body: (f.options ?? []).map((o) => `<button type="button" class="msheet-row"
        data-opt="${esc(o)}" ${o === f.value ? 'aria-current="page"' : ''}>
        <span>${esc(o)}</span>
        ${o === f.value ? `<span class="msheet-r">${icon('check', 16)}</span>` : ''}</button>`).join(''),
      onMount: (rootEl, close) => {
        rootEl.querySelectorAll('[data-opt]').forEach((el) => {
          el.onclick = () => {
            session.proposals = setField(session.proposals, pid, key, el.dataset.opt);
            close();
            renderReview();
          };
        });
      },
    });
    return;
  }

  openSheet({
    title: f.label,
    body: `<div class="msheet-pad">
      <input class="m-input" id="ap-edit" data-autofocus value="${esc(f.value ?? '')}"
        ${f.type === 'date' ? 'type="date"' : f.type === 'time' ? 'type="time"' : 'type="text"'}></div>`,
    foot: '<button type="button" class="btn btn-primary" id="ap-save">Save</button>',
    onMount: (rootEl, close) => {
      const input = rootEl.querySelector('#ap-edit');
      const save = () => {
        session.proposals = setField(session.proposals, pid, key, input.value);
        close();
        renderReview();
      };
      rootEl.querySelector('#ap-save').onclick = save;
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
    },
  });
}

/**
 * Confirmation.
 *
 * The gate runs for real — `assertConfirmable` is the same function the
 * executor will call, and it is exercised here so the contract is tested by
 * the prototype rather than merely described by it.
 *
 * Then it stops, and says so. This is where a fake would write rows and look
 * like a working assistant; §11 and §54 are explicit that it must not, and a
 * prototype that lies about having done the work cannot tell you whether the
 * interaction was right.
 */
function commit() {
  const list = session.proposals;
  const n = changeCount(list);
  try {
    assertConfirmable(list, { confirmed: true, count: n });
  } catch (e) {
    session.ctx.toast?.(e.message, true);
    return;
  }
  openSheet({
    title: 'Not connected yet',
    body: `<div class="msheet-pad">
      <p class="msheet-p">You confirmed <b>${n} change${n === 1 ? '' : 's'}</b>, and this is
      exactly where the assistant will hand them to Life OS to carry out.</p>
      <p class="msheet-p">That layer is not built yet, so <b>nothing has been saved</b>.
      Everything you did here — what it understood, what you switched off, what you
      corrected — is the interaction being tested.</p>
      <ul class="msheet-list">${list.filter((p) => p.enabled && isMutation(p.kind))
    .map((p) => `<li>${esc(KINDS[p.kind]?.label ?? p.kind)} · ${esc(p.title)}${
      p.items.length ? ` (${p.items.filter((i) => i.enabled).length})` : ''}</li>`).join('')}</ul>
    </div>`,
    foot: '<button type="button" class="btn btn-primary" data-sheet-close>Close</button>',
    onMount: (rootEl, close) => {
      rootEl.querySelectorAll('[data-sheet-close]').forEach((b) => { b.onclick = () => close(); });
    },
  });
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
