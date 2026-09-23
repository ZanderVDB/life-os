/**
 * The sound a phone makes while mobile voice keeps listening.
 *
 * ── What it is not ──────────────────────────────────────────────────────
 *
 * It is not ours. Life OS contains no audio playback of any kind -- no
 * `Audio`, no media element, no oscillator, no notification sound -- which
 * the first test here asserts across the whole web directory.
 *
 * ── What it is ──────────────────────────────────────────────────────────
 *
 * A phone's speech engine ends a recognition after a pause whatever
 * `continuous` says. Mobile voice no longer ends on silence, so the
 * controller restarts the engine and the logical session carries on. The
 * platform plays its own earcon around a recognition, and JavaScript cannot
 * suppress it. What we CAN control is how many native transitions each
 * restart asks for -- and it was asking for two.
 *
 * `teardown()` aborted the outgoing recogniser unconditionally, including on
 * the restart path, where the recogniser had already ended: `onend` is the
 * reason the restart is happening. These tests count the calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const webDir = join('..', 'web');
const web = (f: string) => pathToFileURL(join(process.cwd(), '..', 'web', f)).href;
const read = (f: string) => readFileSync(join(webDir, f), 'utf8');
const strip = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
const wait = () => new Promise((r) => { setTimeout(r, 0); });

/** Every call the engine receives, in order, across all instances. */
const calls: string[] = [];

class MockRecognition {
  static made: MockRecognition[] = [];
  continuous = false; interimResults = false; lang = ''; maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onresult: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  started = false; live = false;
  constructor() { MockRecognition.made.push(this); }
  start() {
    if (this.started) throw new Error('InvalidStateError');
    this.started = true; this.live = true;
    calls.push('start');
    this.onstart?.();
  }
  stop() { calls.push('stop'); this.live = false; }
  abort() { calls.push('abort'); this.live = false; }
  say(results: { transcript: string; isFinal: boolean }[]) {
    this.onresult?.({
      resultIndex: 0,
      results: Object.assign(
        results.map((r) => Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })),
        { length: results.length },
      ),
    });
  }
  /** The engine giving up by itself, which is what a pause produces. */
  end() { this.live = false; this.onend?.(); }
  err(code: string) { this.onerror?.({ error: code }); }
}

async function voice(opts: any = {}) {
  const g = globalThis as any;
  MockRecognition.made = [];
  calls.length = 0;
  g.window = { SpeechRecognition: MockRecognition };
  Object.defineProperty(g, 'navigator', {
    value: { language: 'en-GB' }, configurable: true, writable: true,
  });
  const { VoiceInput } = await import(`${web('voice-input.js')}?t=${Math.random()}`) as any;
  const heard: any[] = [];
  const v = new VoiceInput({
    autoStop: false, onTranscript: (t: any) => heard.push(t), ...opts,
  });
  return { v, heard, made: MockRecognition.made, calls };
}

/* ══ It is not our sound ═════════════════════════════════════════════════ */

test('cue: the app plays no audio anywhere', () => {
  const banned = [
    /new Audio\b/, /<audio\b/, /createOscillator/, /createBufferSource/,
    /\.play\(\)/, /new Notification\b/,
  ];
  const files = readdirSync(webDir).filter((f) => /\.(js|html|css)$/.test(f));
  assert.ok(files.length > 10, 'the web directory was not scanned');
  for (const f of files) {
    const src = strip(read(f));
    for (const bad of banned) {
      assert.ok(!bad.test(src), `${f} plays audio: ${bad}`);
    }
  }
});

test('cue: nothing in the voice path connects to the speakers', () => {
  /* The orb's analyser reads the microphone. It must never route anything
     back OUT -- connecting to `destination` would make the phone play what it
     hears. */
  for (const f of ['voice-input.js', 'assistant-orb.js', 'voice-wave.js', 'assistant.js']) {
    assert.ok(!/\.destination\b/.test(strip(read(f))), `${f} connects to the speakers`);
  }
});

/* ══ One restart, one transition ═════════════════════════════════════════ */

test('restart: an engine that ended by itself is not aborted again', async () => {
  const { v, made, calls: c } = await voice();
  v.start('');
  assert.deepEqual(c, ['start']);

  made[0]!.end();                    // the phone ends the recognition on a pause
  await wait();

  /* One transition, not two. The outgoing recogniser had already ended, so
     aborting it asked the platform for a second one that bought nothing. */
  assert.deepEqual(c, ['start', 'start'],
    `a restart asked the platform for: ${c.join(' → ')}`);
  assert.equal(made.length, 2, 'more than one recogniser was created');
});

test('restart: ten pauses cost ten transitions, not twenty', async () => {
  const { v, made, calls: c } = await voice();
  v.start('');
  for (let i = 0; i < 10; i += 1) {
    made[made.length - 1]!.end();
    await wait();
  }
  assert.equal(c.filter((x) => x === 'abort').length, 0, 'redundant aborts are back');
  assert.equal(c.filter((x) => x === 'start').length, 11, 'the restart count changed');
});

test('restart: a no-speech pause still costs exactly one transition', async () => {
  /* The commonest mobile cycle: start, nothing said, `no-speech`, end. */
  const { v, made, calls: c } = await voice();
  v.start('');
  made[0]!.err('no-speech');
  await wait();
  assert.deepEqual(c, ['start'], 'the error itself triggered a transition');
  made[0]!.end();
  await wait();
  assert.deepEqual(c, ['start', 'start']);
});

test('restart: exactly one restart per end, even if end fires twice', async () => {
  const { v, made, calls: c } = await voice();
  v.start('');
  const first = made[0]!;
  first.end();
  await wait();
  first.end();                       // a stale recogniser firing again
  await wait();
  assert.equal(c.filter((x) => x === 'start').length, 2, 'one end produced two restarts');
  assert.equal(made.length, 2);
});

test('cancel still aborts for real — the recogniser is alive there', async () => {
  const { v, calls: c } = await voice();
  v.start('');
  v.cancel();
  assert.ok(c.includes('abort'), 'cancel stopped aborting; the microphone stays open');
});

test('stop uses stop, never abort — the last words must be delivered', async () => {
  const { v, calls: c } = await voice();
  v.start('');
  v.stop();
  assert.ok(c.includes('stop'));
  assert.ok(!c.includes('abort'), 'stopping threw the last phrase away');
});

/* ══ Nothing about listening changed ═════════════════════════════════════ */

test('mobile still listens across a long pause', async () => {
  const { v, made } = await voice();
  v.start('');
  made[0]!.say([{ transcript: 'Tomorrow I need to', isFinal: true }]);
  v.lastResultAt = Date.now() - 60_000;
  made[0]!.end();
  await wait();
  assert.equal(v.wanted, true, 'the session ended on a pause');
  assert.equal(v.state, 'listening');
});

test('speech continues after a restart, with no duplicated words', async () => {
  const { v, made, heard } = await voice();
  v.start('');
  made[0]!.say([{ transcript: 'Tomorrow I need to', isFinal: true }]);
  made[0]!.end();
  await wait();
  /* The new recogniser re-reports the tail, which phones routinely do. */
  made[1]!.say([{ transcript: 'Tomorrow I need to phone Oscar', isFinal: true }]);
  v.stop();
  made[1]!.end();
  await wait();
  const last = heard[heard.length - 1]!;
  assert.equal(last.spoken, 'Tomorrow I need to phone Oscar',
    `the seam duplicated: ${JSON.stringify(last.spoken)}`);
});

test('unsettled words still survive a restart', async () => {
  const { v, made, heard } = await voice();
  v.start('');
  made[0]!.say([{ transcript: 'Book the vehicle in', isFinal: false }]);
  made[0]!.end();                    // nothing was ever settled
  await wait();
  v.stop();
  made[1]!.end();
  await wait();
  assert.match(heard[heard.length - 1]!.spoken, /Book the vehicle in/);
});

test('only one recogniser is ever live', async () => {
  const { v, made } = await voice();
  v.start('');
  for (let i = 0; i < 5; i += 1) { made[made.length - 1]!.end(); await wait(); }
  assert.equal(made.filter((r) => r.live).length, 1, 'more than one engine is running');
});

/* ══ The source ══════════════════════════════════════════════════════════ */

test('source: the restart path no longer asks for a redundant abort', () => {
  const src = strip(read('voice-input.js'));
  const td = src.slice(src.indexOf('  teardown()'), src.indexOf('  destroy()'));
  assert.match(td, /if \(rec\.dead\) return;/, 'teardown aborts unconditionally again');
  assert.match(src, /rec\.dead = true;/, 'nothing marks a finished recogniser');
  /* Set before the stale guard, so a replaced recogniser is marked too. */
  const end = src.slice(src.indexOf('rec.onend = () =>'));
  assert.ok(end.indexOf('rec.dead = true') < end.indexOf('if (rec !== this.rec) return;'),
    'a stale recogniser is never marked, so it can still be aborted later');
});

test('source: continuous is asked for, and the watchdog is off for mobile', () => {
  const src = strip(read('voice-input.js'));
  assert.match(src, /rec\.continuous = true/, 'continuous recognition is not requested');
  const watch = src.slice(src.indexOf('  watchSilence()'), src.indexOf('  open(SR)'));
  assert.match(watch, /if \(!this\.autoStop\) return;/,
    'the silence watchdog runs on mobile again and would end the session');
  /* The only app-driven end is the safety timeout, minutes away. */
  const assistant = strip(read('assistant.js'));
  assert.match(assistant, /autoStop: false/);
  assert.match(assistant, /const SAFETY_MS = 5 \* 60 \* 1000/);
});

test('source: the trace records the whole engine lifecycle', () => {
  const src = read('voice-input.js');
  for (const e of ['audiostart', 'audioend', 'speechstart', 'speechend',
    'soundstart', 'soundend', 'onstart', 'onend', 'onerror']) {
    assert.ok(src.includes(`'${e}'`), `${e} is not traced`);
  }
  /* And how long each recogniser lasted, which is the restart cadence. */
  assert.match(src, /aliveMs: this\.startedAt \? Date\.now\(\) - this\.startedAt : null/);
});

test('desktop voice is untouched', () => {
  const panel = strip(read('assistant-panel.js'));
  assert.match(panel, /autoStop: false/);
  assert.match(panel, /new VoiceWave\(canvas\)/);
  assert.match(panel, /id="voice-keep"/);
  assert.match(panel, /const out = cv\.settle\(finalText\)/);
});
