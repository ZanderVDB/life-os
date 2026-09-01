/**
 * Voice input — the shared controller, against a scripted browser.
 *
 * The bug this was written for: on mobile the orb reacted to the voice and
 * nothing was ever transcribed. Two independent causes, both reproduced here:
 *
 *   · the browser ends a recognition after a pause whatever `continuous`
 *     says, and nothing restarted it or even noticed;
 *   · `start()` was called after `await getUserMedia`, which spends the user
 *     gesture iOS Safari requires.
 *
 * The mock is a faithful nuisance rather than a helpful one: it ends sessions
 * unprompted, re-reports finals with refined text, and refuses a second
 * `start()` — because those are the behaviours that broke the real thing.
 *
 * A passing test here is NOT evidence that a physical microphone works. It is
 * evidence that the state machine survives what browsers actually do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const url = `file://${join(process.cwd(), '..', 'web', 'voice-input.js')}`;

/* ── A scripted SpeechRecognition ────────────────────────────────────── */

type Result = { transcript: string; isFinal: boolean };

class MockRecognition {
  static made: MockRecognition[] = [];
  static failStart: string | null = null;

  continuous = false;
  interimResults = false;
  lang = '';
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onresult: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  aborted = false;
  stopped = false;
  results: Result[] = [];

  constructor() { MockRecognition.made.push(this); }

  start() {
    if (this.started) throw new Error('InvalidStateError');
    if (MockRecognition.failStart) throw new Error(MockRecognition.failStart);
    this.started = true;
    this.onstart?.();
  }

  stop() { this.stopped = true; }

  abort() { this.aborted = true; }

  /** The engine reports everything it has, every time. Chrome does this. */
  say(results: Result[]) {
    this.results = results;
    this.onresult?.({
      resultIndex: 0,
      results: Object.assign(
        results.map((r) => Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })),
        { length: results.length },
      ),
    });
  }

  err(code: string) { this.onerror?.({ error: code }); }

  end() { this.onend?.(); }
}

function browser(opts: { supported?: boolean } = {}) {
  const g = globalThis as any;
  MockRecognition.made = [];
  MockRecognition.failStart = null;
  g.window = opts.supported === false ? {} : { SpeechRecognition: MockRecognition };
  /* Node defines `navigator` with a getter only, so plain assignment throws. */
  Object.defineProperty(g, 'navigator', {
    value: { language: 'en-GB' }, configurable: true, writable: true,
  });
  return MockRecognition;
}

const load = async () => {
  const mod = await import(`${url}?t=${Math.random()}`);
  return mod as any;
};

/** The controller plus a log of everything it told the UI. */
async function make(extra: Record<string, unknown> = {}) {
  const { VoiceInput } = await load();
  const states: string[] = [];
  const texts: any[] = [];
  const errors: any[] = [];
  const v = new VoiceInput({
    onState: (s: string) => states.push(s),
    onTranscript: (t: any) => texts.push(t),
    onError: (e: any) => errors.push(e),
    ...extra,
  });
  return { v, states, texts, errors, last: () => texts[texts.length - 1] };
}

/* ══ Starting ════════════════════════════════════════════════════════════ */

test('voice: an unsupported browser says so and never pretends', async () => {
  browser({ supported: false });
  const { v, states, errors } = await make();
  assert.equal(v.start(''), false);
  assert.equal(v.state, 'unavailable');
  assert.deepEqual(states, ['unavailable']);
  assert.match(errors[0].message, /isn’t supported by this browser/);
});

test('voice: start is synchronous, so the user gesture is still valid', async () => {
  const M = browser();
  const { v } = await make();
  /* No await anywhere in start(). On iOS the previous code awaited
     getUserMedia first and recognition silently never began. */
  const returned = v.start('');
  assert.equal(returned, true);
  assert.equal(M.made.length, 1);
  assert.equal(M.made[0]!.started, true);
  assert.equal(typeof (v.start as any), 'function');
  assert.ok(!(returned as any)?.then, 'start() must not be a promise');
});

test('voice: a second start while listening is a no-op, not a throw', async () => {
  const M = browser();
  const { v } = await make();
  v.start('');
  assert.equal(v.start(''), true, 'tapping again means "yes, still listening"');
  assert.equal(M.made.length, 1, 'and does not build a second recogniser');
});

test('voice: it asks for the browser’s own language', async () => {
  const M = browser();
  const { v } = await make();
  v.start('');
  assert.equal(M.made[0]!.lang, 'en-GB');
});

/* ══ Hearing ═════════════════════════════════════════════════════════════ */

test('voice: interim words show, and the final replaces them exactly once', async () => {
  const M = browser();
  const { v, last } = await make();
  v.start('');
  const rec = M.made[0]!;
  rec.say([{ transcript: 'remind me fri', isFinal: false }]);
  assert.equal(last().full, 'remind me fri');
  assert.equal(last().isFinal, false);

  rec.say([{ transcript: 'Remind me Friday', isFinal: true }]);
  assert.equal(last().full, 'Remind me Friday');

  /* Chrome re-reports a final whose text it has refined. Appending made the
     composer say the phrase twice; rebuilding from the list cannot. */
  rec.say([{ transcript: 'Remind me Friday.', isFinal: true }]);
  assert.equal(last().full, 'Remind me Friday.');
});

test('voice: an existing draft is preserved and spoken words are added to it', async () => {
  const M = browser();
  const { v, last } = await make();
  v.start('Remind me');
  M.made[0]!.say([{ transcript: 'Friday to phone Oscar', isFinal: true }]);
  assert.equal(last().base, 'Remind me');
  assert.equal(last().spoken, 'Friday to phone Oscar');
  assert.equal(last().full, 'Remind me Friday to phone Oscar');
});

test('voice: a draft ending in a space does not gain a second one', async () => {
  const M = browser();
  const { v, last } = await make();
  v.start('Remind me ');
  M.made[0]!.say([{ transcript: 'Friday', isFinal: true }]);
  assert.equal(last().full, 'Remind me Friday');
});

/* ══ The mobile bug ══════════════════════════════════════════════════════ */

test('voice: the browser ending a session does not end listening', async () => {
  const M = browser();
  const { v, last } = await make();
  v.start('');
  M.made[0]!.say([{ transcript: 'Remind me Friday', isFinal: true }]);
  /* Mobile does this after a pause, with no error, whatever `continuous`
     says. Before this fix, everything after here was lost in silence while
     the level meter went on reacting to the voice. */
  M.made[0]!.startedAt = 0;
  M.made[0]!.end();

  assert.equal(M.made.length, 2, 'it starts listening again');
  assert.equal(v.state, 'listening');
  M.made[1]!.say([{ transcript: 'to phone Oscar', isFinal: true }]);
  assert.equal(last().full, 'Remind me Friday to phone Oscar',
    'and the first phrase was not lost, nor repeated');
});

test('voice: a session that keeps ending instantly gives up rather than spinning', async () => {
  const M = browser();
  const { v, errors } = await make();
  v.start('');
  for (let i = 0; i < 60 && v.state === 'listening'; i += 1) {
    M.made[M.made.length - 1]!.end();       // immediate: no time passes here
  }
  assert.ok(M.made.length < 50, `stopped after ${M.made.length} attempts`);
  assert.equal(v.state, 'error');
  assert.match(errors[0].message, /stopped unexpectedly/);
});

test('voice: a restart storm still keeps whatever was actually heard', async () => {
  const M = browser();
  const { v, last } = await make();
  v.start('');
  M.made[0]!.say([{ transcript: 'Buy milk', isFinal: true }]);
  for (let i = 0; i < 60 && v.state === 'listening'; i += 1) {
    M.made[M.made.length - 1]!.end();
  }
  assert.equal(v.state, 'idle', 'settled rather than errored');
  assert.equal(last().full, 'Buy milk');
});

/* ══ Stopping ════════════════════════════════════════════════════════════ */

test('voice: stop keeps the transcript and releases the recogniser', async () => {
  const M = browser();
  const { v, states, last } = await make();
  v.start('');
  const rec = M.made[0]!;
  rec.say([{ transcript: 'Buy milk', isFinal: true }]);
  v.stop();
  assert.equal(rec.stopped, true, 'stop, not abort — the last words still arrive');
  rec.end();
  assert.equal(v.state, 'idle');
  assert.equal(last().isFinal, true);
  assert.equal(last().full, 'Buy milk');
  assert.ok(states.includes('stopping'));
  assert.equal(v.rec, null, 'nothing is left holding the microphone');
});

test('voice: cancel discards what was heard', async () => {
  const M = browser();
  const { v, states, last } = await make();
  v.start('Remind me');
  M.made[0]!.say([{ transcript: 'Friday', isFinal: true }]);
  v.cancel();
  assert.ok(states.includes('cancelled'));
  assert.equal(v.state, 'idle');
  assert.equal(last().spoken, '', 'the spoken part is gone');
  assert.equal(last().full, 'Remind me', 'and the typed draft is not');
  assert.equal(M.made[0]!.aborted, true);
});

test('voice: a browser that never fires end after stop still settles', async () => {
  const M = browser();
  const { v, last } = await make();
  v.start('');
  M.made[0]!.say([{ transcript: 'Buy milk', isFinal: true }]);
  v.stop();
  assert.equal(v.state, 'stopping');
  await new Promise((r) => { setTimeout(r, 1400); });
  assert.equal(v.state, 'idle', 'the timeout settles it rather than sticking');
  assert.equal(last().full, 'Buy milk');
});

test('voice: destroy releases everything, for unmount and navigation', async () => {
  const M = browser();
  const { v } = await make();
  v.start('');
  v.destroy();
  assert.equal(M.made[0]!.aborted, true);
  assert.equal(M.made[0]!.onresult, null, 'handlers detached, so a late event is inert');
  assert.equal(v.rec, null);
  /* And a late end() from the browser cannot restart it. */
  assert.equal(M.made.length, 1);
});

/* ══ Errors ══════════════════════════════════════════════════════════════ */

test('voice: a blocked microphone says what to do about it', async () => {
  const M = browser();
  const { v, errors } = await make();
  v.start('');
  M.made[0]!.err('not-allowed');
  assert.equal(v.state, 'error');
  assert.match(errors[0].message, /Microphone access is blocked/);
  assert.equal(errors[0].code, 'not-allowed', 'the raw code is logged, never shown');
  assert.equal(v.rec, null, 'and the microphone is released');
});

test('voice: a pause is not a failure', async () => {
  const M = browser();
  const { v, errors } = await make();
  v.start('');
  /* `no-speech` arrives every time somebody draws breath. Ending the session
     on it would stop listening mid-sentence. */
  M.made[0]!.err('no-speech');
  assert.equal(errors.length, 0);
  M.made[0]!.end();
  assert.equal(v.state, 'listening', 'still going');
});

test('voice: a network failure does not leave the UI stuck listening', async () => {
  const M = browser();
  const { v, errors } = await make();
  v.start('');
  M.made[0]!.err('network');
  assert.equal(v.state, 'error');
  assert.match(errors[0].message, /stopped unexpectedly/);
  assert.notEqual(v.state, 'listening');
});

test('voice: no raw browser code ever reaches the person', async () => {
  const { VOICE_MESSAGES } = await load();
  for (const msg of Object.values(VOICE_MESSAGES) as string[]) {
    assert.doesNotMatch(msg, /not-allowed|audio-capture|no-speech|aborted|InvalidState/);
    assert.doesNotMatch(msg, /Something went wrong/i);
  }
});

/* ══ Repeat sessions ═════════════════════════════════════════════════════ */

test('voice: a second session does not repeat the first one', async () => {
  const M = browser();
  const { v, last } = await make();
  v.start('');
  M.made[0]!.say([{ transcript: 'Buy milk', isFinal: true }]);
  v.stop();
  M.made[0]!.end();
  assert.equal(last().full, 'Buy milk');

  v.start('');
  M.made[1]!.say([{ transcript: 'Call Oscar', isFinal: true }]);
  assert.equal(last().full, 'Call Oscar', 'the previous transcript is not appended again');
});

/* ══ Stopping on a pause ═════════════════════════════════════════════════
 *
 * Two complaints, one cause. Desktop listened for ever until it was clicked
 * again; mobile chimed over and over at an empty room, because Chrome plays a
 * tone on every `start()` and every restart into silence bought nothing.
 */

test('voice: a pause after speech ends the session on its own', async () => {
  const M = browser();
  const { v, last } = await make({ silenceMs: 200 });
  v.start('');
  M.made[0]!.say([{ transcript: 'Buy milk', isFinal: true }]);
  assert.equal(v.state, 'listening');

  await new Promise((r) => { setTimeout(r, 500); });
  assert.notEqual(v.state, 'listening', 'it stopped without being told to');
  M.made[0]!.end();
  assert.equal(v.state, 'idle');
  assert.equal(last().full, 'Buy milk', 'and kept what was said');
});

test('voice: a silence BEFORE anything is said waits much longer', async () => {
  const M = browser();
  const { v } = await make({ silenceMs: 150 });
  v.start('');
  /* Nobody has spoken yet — they are still deciding what to say, and cutting
     them off after a moment would be rude. The long window applies until the
     first word arrives. */
  await new Promise((r) => { setTimeout(r, 500); });
  assert.equal(v.state, 'listening');
  assert.equal(M.made.length, 1);
});

test('voice: ending in silence does not restart, so it cannot chime forever', async () => {
  const M = browser();
  const { v } = await make({ silenceMs: 60 });
  v.start('');
  M.made[0]!.say([{ transcript: 'Buy milk', isFinal: true }]);
  await new Promise((r) => { setTimeout(r, 200); });
  const count = M.made.length;
  M.made[M.made.length - 1]!.end();
  await new Promise((r) => { setTimeout(r, 150); });
  assert.equal(M.made.length, count, 'no new recogniser, so no new tone');
  assert.notEqual(v.state, 'listening');
});

test('voice: a pause MID-sentence still restarts, because it is not the end', async () => {
  const M = browser();
  const { v, last } = await make({ silenceMs: 5000 });
  v.start('');
  M.made[0]!.say([{ transcript: 'Remind me Friday', isFinal: true }]);
  M.made[0]!.startedAt = 0;
  M.made[0]!.end();                       // the browser gives up; we do not
  assert.equal(M.made.length, 2);
  assert.equal(v.state, 'listening');
  M.made[1]!.say([{ transcript: 'to phone Oscar', isFinal: true }]);
  assert.equal(last().full, 'Remind me Friday to phone Oscar');
});

test('voice: auto-stop can be switched off for a surface that wants a button', async () => {
  const M = browser();
  const { v } = await make({ silenceMs: 60, autoStop: false });
  v.start('');
  M.made[0]!.say([{ transcript: 'Buy milk', isFinal: true }]);
  await new Promise((r) => { setTimeout(r, 250); });
  assert.equal(v.state, 'listening', 'it waits to be told');
});

/* ══ The orb's signal ════════════════════════════════════════════════════ */

test('voice: activity follows WORDS, not loudness', async () => {
  const M = browser();
  const { v } = await make({ silenceMs: 5000 });
  assert.equal(v.activity, 0, 'nothing heard yet, nothing to draw');

  v.start('');
  assert.equal(v.activity, 0, 'starting is not hearing');

  M.made[0]!.say([{ transcript: 'hello', isFinal: false }]);
  assert.ok(v.activity > 0.9, 'a result drives it');

  await new Promise((r) => { setTimeout(r, 500); });
  const decayed = v.activity;
  assert.ok(decayed < 0.6 && decayed > 0, `it decays between words (${decayed})`);

  M.made[0]!.say([{ transcript: 'hello there', isFinal: false }]);
  assert.ok(v.activity > 0.9, 'and comes back on the next one');
});

test('voice: the timer is released on every exit', async () => {
  const M = browser();
  for (const finish of ['stop', 'cancel', 'destroy'] as const) {
    const { v } = await make({ silenceMs: 5000 });
    v.start('');
    assert.ok(v.silenceTimer, `${finish}: a watchdog is running`);
    v[finish]();
    /* Node keeps the process alive for a stray interval; a leaked one here
       is a leaked microphone in a browser. */
    assert.equal(v.wanted, false, `${finish}: no longer wanted`);
    if (finish !== 'stop') assert.equal(v.rec, null, `${finish}: recogniser released`);
  }
  assert.ok(M.made.length >= 3);
});

/* ══ Both surfaces use it ════════════════════════════════════════════════ */

test('voice: desktop and mobile both go through this one controller', () => {
  const read = (f: string) => readFileSync(join('..', 'web', f), 'utf8');
  const panel = read('assistant-panel.js');
  const orb = read('assistant.js');

  for (const [name, src] of [['desktop', panel], ['mobile', orb]] as const) {
    assert.match(src, /from '\.\/voice-input\.js'/, `${name} imports the shared controller`);
    assert.doesNotMatch(src, /webkitSpeechRecognition/,
      `${name} does not build its own recogniser`);
  }
});
