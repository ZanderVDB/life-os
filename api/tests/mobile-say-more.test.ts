/**
 * Mobile "Say more": cancelling a new recording must not destroy the old one.
 *
 * ── What was wrong ──────────────────────────────────────────────────────
 *
 * One `cancelListening` served two states. During a recording Cancel means
 * "forget what I just said"; in review it means "forget all of this". Both ran
 * `reset()`, which clears the transcript — so saying a second sentence and
 * changing your mind threw the first one away too.
 *
 * Desktop already keeps this invariant. This is the same rule on the phone,
 * with no change to the layout, the pause-to-review flow or the orb.
 *
 * ── How these test a DOM-heavy surface ──────────────────────────────────
 *
 * `assistant.js` cannot be imported outside a browser. So the RULE is tested
 * directly — `ComposerVoice` is the model the orb now uses for base-vs-segment
 * — through a harness that performs exactly the steps assistant.js performs,
 * and the wiring itself is pinned against the source underneath. The harness
 * can drift from the real thing; the source assertions are what catch it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const web = (f: string) => pathToFileURL(join(process.cwd(), '..', 'web', f)).href;
const read = (f: string) => readFileSync(join('..', 'web', f), 'utf8');
const code = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const assistant = code(read('assistant.js'));

/**
 * The orb surface, reduced to the state it keeps.
 *
 * Each method does what the identically-named path in assistant.js does, and
 * nothing else — no DOM, no recogniser, no orb.
 */
async function orb() {
  const { ComposerVoice } = await import(`${web('composer-voice.js')}?t=${Math.random()}`) as any;
  const { joinSegment } = await import(`${web('voice-input.js')}?t=${Math.random()}`) as any;
  const s = {
    transcript: '',
    state: 'idle' as string,
    cv: new ComposerVoice(),
  };
  return {
    s,
    /** Tapping the orb, or Say more, from review. `resumeListening`. */
    sayMore() {
      s.cv.reset();
      s.cv.begin(s.transcript);       // the exact committed text is the base
      s.state = 'listening';
    },
    /** A fresh session. `startListening` after `reset`. */
    listen() {
      s.transcript = '';
      s.cv.reset();
      s.cv.begin('');
      s.state = 'listening';
    },
    /** `onTranscript`: the display shows everything, the model keeps the new. */
    hear(spoken: string) {
      s.cv.hear(spoken);
      s.transcript = joinSegment(s.cv.base.trim(), spoken);
    },
    /** Done, or a pause. `endListening`. */
    done() {
      s.cv.reset();
      s.state = s.transcript.trim() ? 'heard' : 'idle';
    },
    /** Typing a correction in review. `openTypeSheet` → `paintTranscript`. */
    edit(text: string) { s.transcript = text; },
    /** `cancelListening`. */
    cancel() {
      const recording = s.state === 'listening' || s.state === 'paused';
      const base = s.cv.active ? s.cv.cancel() : null;
      if (recording && base !== null && base.trim()) {
        s.transcript = base;
        s.state = 'heard';
        return;
      }
      s.transcript = '';
      s.state = 'idle';
    },
    /** `sendHeard`. */
    send() { return s.transcript.trim(); },
  };
}

/* ══ The contract ════════════════════════════════════════════════════════ */

test('say more: cancelling the second recording keeps the first', async () => {
  const m = await orb();
  m.listen();
  m.hear('I need to phone Oscar');
  m.done();
  assert.equal(m.s.transcript, 'I need to phone Oscar');

  m.sayMore();
  m.hear('and send him the invoice');
  m.cancel();

  assert.equal(m.s.transcript, 'I need to phone Oscar',
    'cancelling a new recording destroyed the committed one');
  /* And it returns to review rather than closing the whole session — there is
     still something there to send. */
  assert.equal(m.s.state, 'heard');
});

test('say more: finishing the second recording keeps both', async () => {
  const m = await orb();
  m.listen();
  m.hear('I need to phone Oscar');
  m.done();

  m.sayMore();
  m.hear('and send him the invoice');
  m.done();

  assert.equal(m.s.transcript, 'I need to phone Oscar and send him the invoice');
  assert.equal(m.s.state, 'heard');
});

test('say more: a manual edit becomes the base the next Cancel restores', async () => {
  const m = await orb();
  m.listen();
  m.hear('Call Oscar tomorrow');
  m.done();

  m.edit('Call Oscar on Friday');          // corrected by hand in review

  m.sayMore();
  m.hear('and send the quote');
  m.cancel();

  assert.equal(m.s.transcript, 'Call Oscar on Friday',
    'the pre-edit value came back, or the edit was lost');
});

test('say more: several sessions accumulate', async () => {
  const m = await orb();
  m.listen();
  m.hear('Phone Oscar');
  m.done();

  m.sayMore();
  m.hear('send the invoice');
  m.done();

  m.sayMore();
  m.hear('and book the vehicle in');
  m.done();

  assert.equal(m.s.transcript, 'Phone Oscar send the invoice and book the vehicle in');
});

test('say more: cancelling the third keeps the first and the second', async () => {
  const m = await orb();
  m.listen();
  m.hear('Phone Oscar');
  m.done();
  m.sayMore();
  m.hear('and send the invoice');
  m.done();
  const committed = m.s.transcript;
  assert.equal(committed, 'Phone Oscar and send the invoice');

  m.sayMore();
  m.hear('and cancel the order');
  m.cancel();

  assert.equal(m.s.transcript, committed, 'a third recording took the first two with it');
  assert.ok(!m.s.transcript.includes('cancel the order'), 'the discarded words came back');
});

test('say more: Send posts everything committed plus the newest segment, once', async () => {
  const m = await orb();
  m.listen();
  m.hear('Phone Oscar');
  m.done();
  m.sayMore();
  m.hear('and send him the invoice');
  m.done();

  assert.equal(m.send(), 'Phone Oscar and send him the invoice');
  /* Nothing is still owned by a recording, so a trailing result from a dead
     recogniser cannot append itself to what was sent. */
  assert.equal(m.s.cv.active, false);
  assert.equal(m.s.cv.hear('stray trailing words'), false);
  assert.equal(m.send(), 'Phone Oscar and send him the invoice');
});

test('say more: cancelling the FIRST recording still closes the session', async () => {
  /* Unchanged behaviour, and it must stay unchanged: with nothing committed
     there is nothing to preserve, and Cancel means the same as it always did. */
  const m = await orb();
  m.listen();
  m.hear('something I did not mean');
  m.cancel();
  assert.equal(m.s.transcript, '');
  assert.equal(m.s.state, 'idle');
});

/* ══ The wiring in the real file ═════════════════════════════════════════ */

test('mobile: the orb session uses the shared base-vs-segment model', () => {
  assert.match(assistant, /import \{ ComposerVoice \} from '\.\/composer-voice\.js'/,
    'mobile keeps a second, separate idea of what a recording owns');
  assert.match(assistant, /cv: new ComposerVoice\(\)/, 'the session has no model');
  // Say more snapshots the committed text before a word is heard.
  const resume = assistant.slice(assistant.indexOf('function resumeListening'),
    assistant.indexOf('function startSpeech'));
  assert.match(resume, /session\.cv\.begin\(session\.transcript\)/,
    'Say more does not snapshot what is already in review');
  // The new words are tracked on their own, while the display still shows all.
  assert.match(assistant, /session\.cv\.hear\(spoken\)/);
  assert.match(assistant, /paintTranscript\(full\)/, 'the review display changed');
});

test('mobile: Cancel restores rather than resetting, and only while recording', () => {
  const fn = assistant.slice(assistant.indexOf('function cancelListening'),
    assistant.indexOf('function stopCapture'));
  assert.match(fn, /const recording = session\.state === 'listening' \|\| session\.state === 'paused'/,
    'Cancel cannot tell a recording from a review');
  assert.match(fn, /session\.cv\?\.active \? session\.cv\.cancel\(\) : null/);
  assert.match(fn, /paintTranscript\(base\)/, 'the committed text is not restored');
  assert.match(fn, /setState\('heard'\)/, 'cancelling a recording closes the session');
  /* In review, Cancel still means "forget all of this" — that behaviour is
     deliberate and must survive. */
  assert.match(fn, /reset\(\);\s*\}/);
});

test('mobile: cancelling discards the recogniser rather than stopping it', () => {
  /* `stop` lets the engine deliver a final a moment later, and that final
     would paint itself over the restored text — the discarded recording
     coming back a second after it was thrown away. */
  const fn = assistant.slice(assistant.indexOf('function stopCapture'),
    assistant.indexOf('function endListening'));
  assert.match(fn, /function stopCapture\(discard = false\)/);
  assert.match(fn, /if \(discard\) session\.voice\?\.cancel\(\); else session\.voice\?\.stop\(\)/);
  assert.match(assistant, /stopCapture\(recording\)/, 'Cancel does not ask for a discard');
});

test('mobile: nothing about the layout, the review flow or the orb changed', () => {
  /* The correction is state only. These are the things the brief said not to
     touch, each pinned to something that would break if it had been. */
  assert.match(assistant, /id="asst-more">Say more<\/button>/, 'the Say more button changed');
  assert.match(assistant, /id="asst-cancel">Cancel<\/button>/, 'the Cancel button changed');
  assert.match(assistant, /box\.querySelector\('#asst-more'\)\.onclick = \(\) => resumeListening\(\)/);
  // Pause-to-review: the controller still finishes a mobile message on silence.
  assert.ok(!/autoStop: false/.test(assistant), 'mobile picked up the desktop pause behaviour');
  assert.match(assistant, /setState\(session\.transcript\.trim\(\) \? 'heard' : 'idle'\)/,
    'the pause-to-review transition changed');
  // And the desktop surface is not involved in any of this.
  const panel = code(read('assistant-panel.js'));
  assert.ok(!/session\.cv|resumeListening/.test(panel), 'the desktop composer was touched');
});
