/**
 * Keep and Send lost everything the engine had not settled.
 *
 * ── The bug ─────────────────────────────────────────────────────────────
 *
 * Speak a sentence on desktop, press Keep, and the composer stayed empty. It
 * looked like Keep was running the Cancel path. It was not: Keep merged base +
 * segment exactly as designed, and the SEGMENT was empty, because by the time
 * anything asked the recogniser what it had heard, the words were gone.
 *
 * `VoiceInput` only ever persisted FINAL results. Interim text lived as a
 * local inside `onresult`, was handed to the display, and was dropped -- the
 * handler deliberately put `committed` back afterwards. A recogniser that
 * ended without promoting its phrase to a final therefore threw away every
 * word of it, and `stop()` called mid-phrase does exactly that.
 *
 * So these test at the level the loss happened: a recogniser that never
 * finalises. Everything above it was already correct.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const web = (f: string) => pathToFileURL(join(process.cwd(), '..', 'web', f)).href;
const read = (f: string) => readFileSync(join('..', 'web', f), 'utf8');
const strip = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const wait = () => new Promise((r) => { setTimeout(r, 0); });

class MockRecognition {
  static made: MockRecognition[] = [];
  continuous = false; interimResults = false; lang = ''; maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onresult: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  started = false; stopped = false; aborted = false;
  constructor() { MockRecognition.made.push(this); }
  start() { if (this.started) throw new Error('InvalidStateError'); this.started = true; this.onstart?.(); }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }
  say(results: { transcript: string; isFinal: boolean }[]) {
    this.onresult?.({
      resultIndex: 0,
      results: Object.assign(
        results.map((r) => Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })),
        { length: results.length },
      ),
    });
  }
  end() { this.onend?.(); }
}

/**
 * The desktop composer's wiring, without the DOM.
 *
 * `field` stands in for the textarea. Every method below is the body of the
 * identically-named function in assistant-panel.js, including the rule that
 * nothing reaches the field until the session settles.
 */
async function desktop(startingText = '') {
  const g = globalThis as any;
  MockRecognition.made = [];
  g.window = { SpeechRecognition: MockRecognition };
  Object.defineProperty(g, 'navigator', {
    value: { language: 'en-GB' }, configurable: true, writable: true,
  });
  const { VoiceInput } = await import(`${web('voice-input.js')}?t=${Math.random()}`) as any;
  const { ComposerVoice } = await import(`${web('composer-voice.js')}?t=${Math.random()}`) as any;

  const state = { field: startingText, sent: [] as string[] };
  const cv = new ComposerVoice();
  const v = new VoiceInput({
    autoStop: false,
    onTranscript: ({ spoken, isFinal }: any) => {
      if (!cv.active) return;
      cv.hear(spoken);
      if (isFinal && cv.state === 'finishing') applyFinish(spoken);
    },
  });

  function applyFinish(finalText: string | null) {
    const out = cv.settle(finalText);
    if (!out) return;
    state.field = out.text;
    if (out.send) { state.sent.push(state.field); state.field = ''; }
  }

  return {
    state, cv, v,
    get rec() { return MockRecognition.made[MockRecognition.made.length - 1]!; },
    mic() {                                   // enterVoice
      if (!cv.begin(state.field)) return;
      v.start(cv.base);
    },
    async press(action: 'keep' | 'send') {    // finishVoice
      if (!cv.finish(action)) return;
      v.stop();
      await wait();
      /* The grace timeout, brought forward: the real one waits 1500ms for a
         final that may never come, and settling is idempotent either way. */
      applyFinish(null);
    },
    async cancel() {                          // cancelVoice
      const restored = cv.cancel();
      if (restored === null) return;
      v.cancel();
      await wait();
      state.field = restored;
    },
  };
}

/* ══ The root cause, at the level it happened ════════════════════════════ */

test('voice: a recogniser that never finalises still yields what it heard', async () => {
  const d = await desktop();
  d.mic();
  /* Interim only -- the engine is still guessing at the phrase. */
  d.rec.say([{ transcript: 'Remind me to phone Oscar on Friday', isFinal: false }]);
  assert.equal(d.cv.segment, 'Remind me to phone Oscar on Friday',
    'the words were not even reaching the model');

  /* Now the recording ends without the phrase ever being settled. */
  d.v.stop();
  d.rec.end();
  await wait();

  assert.equal(d.cv.segment, 'Remind me to phone Oscar on Friday',
    'the unsettled words were dropped when the recogniser ended -- THE BUG');
});

test('voice: a restart mid-sentence does not drop the unsettled words', async () => {
  /* Desktop runs autoStop:false and restarts the recogniser across a pause.
     Each restart is a recogniser ending, so it hit the same loss. */
  const d = await desktop();
  d.mic();
  d.rec.say([{ transcript: 'Tomorrow I need to phone', isFinal: false }]);
  d.rec.end();                       // the browser ends it; VoiceInput restarts
  await wait();
  d.rec.say([{ transcript: 'Oscar about the invoice', isFinal: true }]);
  await wait();
  assert.match(d.cv.segment, /Tomorrow I need to phone/,
    'the first half was lost at the restart');
  assert.match(d.cv.segment, /Oscar about the invoice/);
});

/* ══ The contract the brief sets out ═════════════════════════════════════ */

test('keep does not behave like cancel, and writes the merged text', async () => {
  const d = await desktop();                       // CASE A
  d.mic();
  d.rec.say([{ transcript: 'Remind me to phone Oscar on Friday', isFinal: false }]);
  await d.press('keep');
  assert.equal(d.state.field, 'Remind me to phone Oscar on Friday');
  assert.deepEqual(d.state.sent, [], 'Keep sent something');
});

test('send does not behave like cancel, and posts the merged text once', async () => {
  const d = await desktop();                       // CASE B
  d.mic();
  d.rec.say([{ transcript: 'Add milk to my list', isFinal: false }]);
  await d.press('send');
  assert.deepEqual(d.state.sent, ['Add milk to my list']);
  assert.equal(d.state.field, '', 'the composer did not clear after sending');
  /* Settling twice must not send twice -- the grace timer and a late final
     both land here. */
  await d.press('send');
  assert.deepEqual(d.state.sent, ['Add milk to my list'], 'sent twice');
});

test('existing text merges with speech on keep', async () => {
  const d = await desktop('Tomorrow I need to');   // CASE C
  d.mic();
  d.rec.say([{ transcript: 'phone Oscar', isFinal: false }]);
  await d.press('keep');
  assert.equal(d.state.field, 'Tomorrow I need to phone Oscar');
});

test('existing text merges with speech on send, as one message', async () => {
  const d = await desktop('Tomorrow I need to phone Oscar');   // CASE D
  d.mic();
  d.rec.say([{ transcript: 'and send the invoice', isFinal: false }]);
  await d.press('send');
  assert.deepEqual(d.state.sent, ['Tomorrow I need to phone Oscar and send the invoice']);
});

test('cancel still restores the base and keeps nothing', async () => {
  const d = await desktop('Tomorrow I need to phone Oscar');   // CASE E
  d.mic();
  d.rec.say([{ transcript: 'and send the invoice', isFinal: false }]);
  await d.cancel();
  assert.equal(d.state.field, 'Tomorrow I need to phone Oscar');
  assert.deepEqual(d.state.sent, []);
});

test('a second recording cancelled keeps the first', async () => {
  const d = await desktop();
  d.mic();
  d.rec.say([{ transcript: 'Phone Oscar', isFinal: false }]);
  await d.press('keep');
  assert.equal(d.state.field, 'Phone Oscar');

  d.mic();
  d.rec.say([{ transcript: 'and send the invoice', isFinal: false }]);
  await d.cancel();
  assert.equal(d.state.field, 'Phone Oscar', 'the committed recording was destroyed');
});

/* ══ Pressing the moment the last word is said ═══════════════════════════ */

test('quick keep: the final word survives being pressed on', async () => {
  const d = await desktop();
  d.mic();
  d.rec.say([{ transcript: 'Remind me to phone Oscar on', isFinal: false }]);
  /* The button is pressed while the last word is still inside the engine,
     which then delivers it after the stop. */
  const pressed = d.press('keep');
  d.rec.say([{ transcript: 'Remind me to phone Oscar on Friday', isFinal: true }]);
  d.rec.end();
  await pressed;
  assert.equal(d.state.field, 'Remind me to phone Oscar on Friday',
    'the word delivered after the press was lost');
});

test('quick send: the final word survives, and is sent once', async () => {
  const d = await desktop();
  d.mic();
  d.rec.say([{ transcript: 'Add milk to my', isFinal: false }]);
  const pressed = d.press('send');
  d.rec.say([{ transcript: 'Add milk to my list', isFinal: true }]);
  d.rec.end();
  await pressed;
  assert.deepEqual(d.state.sent, ['Add milk to my list']);
});

test('quick press: nothing arrives after the stop, and the words still survive', async () => {
  /* The harsher version: the engine delivers NOTHING after stop() and simply
     ends. Only the grace timeout settles the session. */
  const d = await desktop();
  d.mic();
  d.rec.say([{ transcript: 'Book the vehicle in for its service', isFinal: false }]);
  const pressed = d.press('keep');
  d.rec.end();
  await pressed;
  assert.equal(d.state.field, 'Book the vehicle in for its service');
});

/* ══ Unsettled words must not double up ══════════════════════════════════ */

test('voice: keeping the unsettled tail never duplicates a settled phrase', async () => {
  const d = await desktop();
  d.mic();
  d.rec.say([{ transcript: 'Phone Oscar', isFinal: false }]);
  /* The same words then settle -- the interim fallback must stand down. */
  d.rec.say([{ transcript: 'Phone Oscar', isFinal: true }]);
  await d.press('keep');
  assert.equal(d.state.field, 'Phone Oscar', 'the phrase was kept twice');
});

test('voice: a restart that re-reports the tail does not stutter', async () => {
  const d = await desktop();
  d.mic();
  d.rec.say([{ transcript: 'Phone Oscar', isFinal: false }]);
  d.rec.end();                                   // unsettled tail folded in
  await wait();
  /* Chrome commonly re-reports the tail of the previous recogniser. */
  d.rec.say([{ transcript: 'Phone Oscar about the invoice', isFinal: true }]);
  await d.press('keep');
  assert.equal(d.state.field, 'Phone Oscar about the invoice');
});

/* ══ The waveform: slower travel, identical response ═════════════════════ */

async function waveform(level: number) {
  const { VoiceWave } = await import(`${web('voice-wave.js')}?t=${Math.random()}`) as any;
  /* A canvas whose context is null, so draw() returns immediately -- this
     measures pacing, not rendering. */
  const w = new VoiceWave({ getContext: () => null, clientWidth: 600, clientHeight: 40 });
  w.mic = { read: () => level };
  return w;
}

test('waveform: amplitude still rises on the very first frame', async () => {
  const w = await waveform(1);
  assert.equal(w.level, 0);
  w.sample();
  /* ATTACK is per-frame and untouched: one frame of a loud voice takes the
     strip most of the way up. Nothing about the slower travel delays this. */
  assert.ok(w.level > 0.4, `a loud voice moved the strip only to ${w.level}`);
  const first = w.level;
  w.sample();
  assert.ok(w.level > first, 'the level stopped climbing');
});

test('waveform: the leading bar tracks the level between commits', async () => {
  const w = await waveform(1);
  const now = Date.now;
  let t = 1_000_000;
  (Date as any).now = () => t;
  try {
    w.sample();                       // commits the first bar
    const bars = w.history.length;
    t += 8;                           // half a frame later, no new bar is due
    w.sample();
    assert.equal(w.history.length, bars, 'a bar was committed too early');
    assert.equal(w.history[w.history.length - 1], w.level,
      'the visible leading bar is stale between commits');
  } finally { (Date as any).now = now; }
});

test('waveform: the strip travels at well under one bar per frame', async () => {
  const w = await waveform(0.6);
  const now = Date.now;
  let t = 2_000_000;
  (Date as any).now = () => t;
  try {
    /* One second of a 60fps loop. */
    for (let i = 0; i < 60; i += 1) { w.sample(); t += 16; }
    const bars = w.history.length;
    /* It used to commit one bar per frame -- 60 a second, 360px of travel on
       a 6px pitch, which is what read as frantic. */
    assert.ok(bars < 60 * 0.6, `still travelling at ${bars} bars/sec`);
    assert.ok(bars > 60 * 0.3, `now too slow to read as live: ${bars} bars/sec`);
  } finally { (Date as any).now = now; }
});

test('waveform: reduced motion is unchanged, and keeps no travel at all', async () => {
  const w = await waveform(0.6);
  w.calm = true;
  for (let i = 0; i < 10; i += 1) w.sample();
  assert.equal(w.history.length, 0, 'reduced motion started scrolling');
  assert.ok(w.level > 0, 'reduced motion stopped responding to the microphone');
});

/* ══ The source underneath ═══════════════════════════════════════════════ */

test('voice-input: unsettled words are held on the instance, not in a local', () => {
  const src = strip(read('voice-input.js'));
  assert.match(src, /this\.sessionLive = interim/,
    'the interim is still only a local, so it dies with the recogniser');
  const harvest = src.slice(src.indexOf('  harvest()'), src.indexOf('  settle()'));
  assert.match(harvest, /this\.sessionFinal\}\$\{this\.sessionLive\}/,
    'harvest keeps finals only');
  assert.match(harvest, /trimOverlap/, 'the seam is no longer trimmed');
  /* Cancel must still throw away everything, unsettled words included. */
  const cancel = src.slice(src.indexOf('  cancel()'));
  assert.match(cancel, /this\.sessionLive = ''/, 'cancel keeps the unsettled words');
});

test('voice-wave: travel is a separate constant from the attack', () => {
  const src = strip(read('voice-wave.js'));
  assert.match(src, /const TRAVEL_MS = \d+/, 'travel is not separated out');
  assert.match(src, /const ATTACK = 0\.45/, 'the microphone attack was changed');
  assert.match(src, /const DECAY = 0\.12/, 'the decay was changed');
  assert.match(src, /const BAR_W = 3/, 'the waveform style changed');
  assert.match(src, /const GAP = 3/, 'the waveform style changed');
  /* The microphone is still read every frame: only the commit is paced. */
  assert.match(src, /requestAnimationFrame\(frame\)/);
});

test('desktop: the composer wiring itself is unchanged', () => {
  const panel = strip(read('assistant-panel.js'));
  assert.match(panel, /if \(!cv\.finish\(action\)\) return/);
  assert.match(panel, /const out = cv\.settle\(finalText\)/);
  assert.match(panel, /if \(out\.send\) \{ submitComposer\(\); return; \}/);
  /* Keep and Send must not share the discard path. */
  const finish = panel.slice(panel.indexOf('function finishVoice'), panel.indexOf('function applyFinish'));
  assert.ok(!/cv\.cancel\(\)|voice\?\.cancel\(\)/.test(finish),
    'the finishing path reaches for cancel');
  assert.match(finish, /voice\?\.stop\(\)/);
});
