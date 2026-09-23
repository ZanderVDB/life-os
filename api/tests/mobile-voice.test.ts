/**
 * Mobile voice: the desktop contract, around the large orb.
 *
 * ── What this replaces ──────────────────────────────────────────────────
 *
 * The old flow was: listening -> two seconds of silence -> "Is that right?"
 * -> Send / Edit / Say more / Cancel. Two things in it were wrong. Silence
 * ended recordings somebody was still thinking through, and the transcript
 * was painted as it was heard -- so the engine's constant revising of interim
 * results read as unreliable even when the final transcript was perfect.
 *
 * Both are gone. A mobile recording now ends only when the person chooses
 * Cancel, Keep or Send, and nothing is shown until they choose.
 *
 * (This file supersedes mobile-say-more.test.ts, which pinned the flow above.
 * Its invariant -- cancelling a new recording must not destroy committed
 * content -- is covered here, through the new entry points.)
 *
 * ── How a DOM-heavy surface is tested ───────────────────────────────────
 *
 * `assistant.js` cannot be imported outside a browser, so the RULES are
 * driven directly through `ComposerVoice` and the real `VoiceInput`, in a
 * harness that performs exactly the steps assistant.js performs -- and the
 * wiring itself is pinned against the source underneath. The harness can
 * drift; the source assertions are what catch it.
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

const assistant = strip(read('assistant.js'));
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
 * The mobile orb surface, reduced to the state it keeps.
 *
 * `composer` stands in for the editable composer that Keep opens. `shown` is
 * what is on screen DURING a recording -- it must stay empty.
 */
async function orb() {
  const g = globalThis as any;
  MockRecognition.made = [];
  g.window = { SpeechRecognition: MockRecognition };
  Object.defineProperty(g, 'navigator', {
    value: { language: 'en-GB' }, configurable: true, writable: true,
  });
  const { VoiceInput } = await import(`${web('voice-input.js')}?t=${Math.random()}`) as any;
  const { ComposerVoice } = await import(`${web('composer-voice.js')}?t=${Math.random()}`) as any;

  const s = {
    state: 'idle' as string,
    composer: '',            // what the editable composer holds
    shown: '' as string,     // what is painted on the listening screen
    sent: [] as string[],
    cv: new ComposerVoice(),
    voice: null as any,
  };

  function applyFinish(finalText: string | null) {
    const out = s.cv.settle(finalText);
    if (!out) return;
    s.composer = out.text;
    if (out.send) {
      const say = out.text.trim();
      if (!say) { s.composer = ''; s.state = 'idle'; return; }
      s.sent.push(say);
      s.composer = '';
      s.state = 'idle';
      return;
    }
    s.state = 'idle';
  }

  return {
    s,
    get rec() { return MockRecognition.made[MockRecognition.made.length - 1]!; },
    /** startListening(committed) -- tapping the orb, or the mic in the sheet. */
    listen(committed = '') {
      s.composer = String(committed ?? '');
      s.shown = '';
      s.cv.reset();
      s.cv.begin(s.composer);
      s.state = 'starting';
      s.voice = new VoiceInput({
        autoStop: false,
        onState: (st: string) => {
          if (st === 'listening' && s.state !== 'finishing' && s.state !== 'sending') {
            s.state = 'listening';
          }
        },
        onTranscript: ({ spoken, isFinal }: any) => {
          if (!s.cv.active) return;
          s.cv.hear(spoken);
          /* Deliberately nothing painted -- see the file header. */
          if (isFinal && s.cv.state === 'finishing') applyFinish(spoken);
        },
      });
      s.voice.start(s.composer.trim());
    },
    /** finishListening(action). */
    async press(action: 'keep' | 'send') {
      if (!s.cv.finish(action)) return;
      s.state = action === 'send' ? 'sending' : 'finishing';
      s.voice.stop();
      await wait();
      applyFinish(null);            // the bounded grace, brought forward
    },
    /** cancelListening(). */
    async cancel() {
      const base = s.cv.active ? s.cv.cancel() : null;
      s.voice.cancel();
      await wait();
      s.composer = base ?? '';
      s.state = 'idle';
    },
    /** Editing in the composer between recordings. */
    edit(text: string) { s.composer = text; },
  };
}

/* ══ Silence no longer ends anything ═════════════════════════════════════ */

test('mobile: a long silence does not finish the recording', async () => {
  const m = await orb();
  m.listen();
  m.rec.say([{ transcript: 'Tomorrow I need to', isFinal: true }]);
  /* Far past any silence window the old flow would have fired on. */
  m.s.voice.lastResultAt = Date.now() - 60_000;
  m.rec.end();
  await wait();
  assert.equal(m.s.state, 'listening', 'silence ended the recording');
  assert.ok(m.s.cv.active, 'the logical session was closed by a pause');
  /* And it carries on hearing afterwards. */
  m.rec.say([{ transcript: 'phone Oscar', isFinal: true }]);
  await wait();
  assert.match(m.s.cv.segment, /phone Oscar/);
});

test('mobile: the browser ending recognition restarts it, keeping the words', async () => {
  const m = await orb();
  m.listen();
  const first = m.rec;
  m.rec.say([{ transcript: 'Tomorrow I need to', isFinal: true }]);
  m.rec.end();                      // the browser gives up; the session does not
  await wait();
  assert.notEqual(m.rec, first, 'recognition was not restarted');
  m.rec.say([{ transcript: 'phone Oscar', isFinal: true }]);
  await m.press('keep');
  assert.equal(m.s.composer, 'Tomorrow I need to phone Oscar',
    'the words from before the restart were lost');
});

test('mobile: nothing is shown while listening', async () => {
  const m = await orb();
  m.listen();
  m.rec.say([{ transcript: 'Remind me to', isFinal: false }]);
  m.rec.say([{ transcript: 'Remind me to phone Oscar', isFinal: false }]);
  assert.equal(m.s.shown, '', 'the live transcript is on screen again');
  assert.equal(m.s.composer, '', 'the composer is being written to while listening');
  /* It is being heard, though -- privately. */
  assert.equal(m.s.cv.segment, 'Remind me to phone Oscar');
  await m.press('keep');
  assert.equal(m.s.composer, 'Remind me to phone Oscar',
    'the words did not appear when Keep was chosen');
});

/* ══ Cancel ══════════════════════════════════════════════════════════════ */

test('mobile: cancelling the first recording exits cleanly', async () => {
  const m = await orb();
  m.listen();
  m.rec.say([{ transcript: 'something I did not mean', isFinal: true }]);
  await m.cancel();
  assert.equal(m.s.composer, '');
  assert.equal(m.s.state, 'idle');
  assert.deepEqual(m.s.sent, []);
});

test('mobile: cancelling a later recording preserves the committed base', async () => {
  const m = await orb();
  m.listen();
  m.rec.say([{ transcript: 'Remind me to phone Oscar', isFinal: true }]);
  await m.press('keep');

  m.listen(m.s.composer);
  m.rec.say([{ transcript: 'and send him the invoice', isFinal: true }]);
  await m.cancel();
  assert.equal(m.s.composer, 'Remind me to phone Oscar');
});

test('mobile: a stale recogniser cannot reinsert cancelled speech', async () => {
  const m = await orb();
  m.listen();
  m.rec.say([{ transcript: 'Phone Oscar', isFinal: true }]);
  await m.press('keep');

  m.listen(m.s.composer);
  const doomed = m.rec;
  m.rec.say([{ transcript: 'and cancel the order', isFinal: false }]);
  await m.cancel();
  /* The engine delivers a late final for the recording that was thrown away. */
  doomed.say([{ transcript: 'and cancel the order', isFinal: true }]);
  doomed.end();
  await wait();
  assert.equal(m.s.composer, 'Phone Oscar', 'discarded speech came back');
  assert.ok(!m.s.composer.includes('cancel the order'));
});

/* ══ Keep and Send ═══════════════════════════════════════════════════════ */

test('mobile: Keep exposes the full merged text and sends nothing', async () => {
  const m = await orb();
  m.listen('Tomorrow I need to');
  m.rec.say([{ transcript: 'phone Oscar', isFinal: true }]);
  await m.press('keep');
  assert.equal(m.s.composer, 'Tomorrow I need to phone Oscar');
  assert.deepEqual(m.s.sent, [], 'Keep sent something');
});

test('mobile: Send sends the whole merged message, exactly once', async () => {
  const m = await orb();
  m.listen('Tomorrow I need to phone Oscar');
  m.rec.say([{ transcript: 'and send the invoice', isFinal: true }]);
  await m.press('send');
  assert.deepEqual(m.s.sent, ['Tomorrow I need to phone Oscar and send the invoice']);
  /* A second settle -- the grace timer and a late final both land there. */
  await m.press('send');
  assert.deepEqual(m.s.sent, ['Tomorrow I need to phone Oscar and send the invoice']);
});

test('mobile: an empty Send does not make a turn', async () => {
  const m = await orb();
  m.listen();
  await m.press('send');
  assert.deepEqual(m.s.sent, [], 'an empty turn was sent');
  assert.equal(m.s.state, 'idle');
});

/* ══ The full sequence from the brief ════════════════════════════════════ */

test('mobile: four recordings, one of them cancelled, one message at the end', async () => {
  const m = await orb();

  m.listen();                                            // VOICE 1
  m.rec.say([{ transcript: 'Tomorrow I need to phone Oscar', isFinal: true }]);
  await m.press('keep');
  assert.equal(m.s.composer, 'Tomorrow I need to phone Oscar');

  m.listen(m.s.composer);                                // VOICE 2 — cancelled
  m.rec.say([{ transcript: 'and send the quote', isFinal: true }]);
  await m.cancel();
  assert.equal(m.s.composer, 'Tomorrow I need to phone Oscar');

  m.listen(m.s.composer);                                // VOICE 3
  m.rec.say([{ transcript: 'and send the invoice', isFinal: true }]);
  await m.press('keep');
  assert.equal(m.s.composer, 'Tomorrow I need to phone Oscar and send the invoice');

  // Corrected by hand in the composer.
  m.edit('Tomorrow I need to phone Oscar on Friday and send the invoice');

  m.listen(m.s.composer);                                // VOICE 4 — sent
  m.rec.say([{ transcript: 'before lunch', isFinal: true }]);
  await m.press('send');

  assert.deepEqual(m.s.sent, [
    'Tomorrow I need to phone Oscar on Friday and send the invoice before lunch',
  ]);
  assert.ok(!m.s.sent[0]!.includes('the quote'), 'the cancelled recording contaminated the message');
});

test('mobile: a manual edit becomes the next recording base', async () => {
  const m = await orb();
  m.listen();
  m.rec.say([{ transcript: 'Call Oscar tomorrow', isFinal: true }]);
  await m.press('keep');
  m.edit('Call Oscar on Friday');
  m.listen(m.s.composer);
  m.rec.say([{ transcript: 'and send the quote', isFinal: true }]);
  await m.cancel();
  assert.equal(m.s.composer, 'Call Oscar on Friday', 'the edit was lost');
});

/* ══ Pressing on the last word ═══════════════════════════════════════════ */

test('mobile: quick Keep preserves the final word', async () => {
  const m = await orb();
  m.listen();
  m.rec.say([{ transcript: 'Remind me to phone Oscar on', isFinal: false }]);
  const pressed = m.press('keep');
  m.rec.say([{ transcript: 'Remind me to phone Oscar on Friday', isFinal: true }]);
  m.rec.end();
  await pressed;
  assert.equal(m.s.composer, 'Remind me to phone Oscar on Friday');
});

test('mobile: quick Send preserves the final word, and sends once', async () => {
  const m = await orb();
  m.listen();
  m.rec.say([{ transcript: 'Add milk to my', isFinal: false }]);
  const pressed = m.press('send');
  m.rec.say([{ transcript: 'Add milk to my list', isFinal: true }]);
  m.rec.end();
  await pressed;
  assert.deepEqual(m.s.sent, ['Add milk to my list']);
});

test('mobile: a recording that never finalises still keeps its words', async () => {
  const m = await orb();
  m.listen();
  m.rec.say([{ transcript: 'Book the vehicle in for its service', isFinal: false }]);
  const pressed = m.press('keep');
  m.rec.end();                       // nothing settled, ever
  await pressed;
  assert.equal(m.s.composer, 'Book the vehicle in for its service');
});

/* ══ The wiring in the real file ═════════════════════════════════════════ */

test('mobile source: a pause cannot end the session', () => {
  assert.match(assistant, /autoStop: false/, 'the recogniser still stops itself on silence');
  assert.match(assistant, /const SAFETY_MS = 5 \* 60 \* 1000/, 'there is no emergency stop');
  assert.match(assistant, /setTimeout\(\(\) => finishListening\('keep'\), SAFETY_MS\)/,
    'the safety timeout sends rather than keeps');
  /* Silence now changes one line of copy and nothing else. */
  assert.match(assistant, /const QUIET_MS = 2500/);
  assert.match(assistant, /setSub\(quiet \? COPY\.paused\.sub : COPY\.listening\.sub\)/);
});

test('mobile source: the removed review flow is really gone', () => {
  for (const dead of ['endListening', 'sendHeard', 'resumeListening', 'asst-done', 'asst-more']) {
    assert.ok(!assistant.includes(dead), `${dead} is still here`);
  }
  assert.ok(!/'heard'/.test(assistant), 'the review state survived');
  assert.ok(!/Is that right\?/.test(assistant), 'the review question survived');
});

test('mobile source: the three controls, labelled', () => {
  assert.match(assistant, /id="asst-cancel"\s*\n?\s*aria-label="Cancel recording"/);
  assert.match(assistant, /id="asst-keep"\s*\n?\s*aria-label="Keep transcript"/);
  assert.match(assistant, /id="asst-send-voice"\s*\n?\s*aria-label="Send message"/);
  assert.match(assistant, /#asst-keep'\)\.onclick = \(\) => finishListening\('keep'\)/);
  assert.match(assistant, /#asst-send-voice'\)\.onclick = \(\) => finishListening\('send'\)/);
  assert.match(assistant, /#asst-cancel'\)\.onclick = cancelListening/);
});

test('mobile source: the orb stays, and keeps the safe audio path', () => {
  /* The large central orb is the point of the mobile surface. */
  assert.match(assistant, /orbHtml\(\{ size: 'lg', id: 'orb-main' \}\)/, 'the large orb went');
  assert.match(assistant, /session\.orb\.setLevel\(level\)/, 'the orb stopped reacting');
  /* And it is still driven by recognition energy. A second getUserMedia took
     the microphone away from the recogniser on a real phone -- the bug this
     file was written for -- so the decorative amplitude is not worth it. */
  const tick = assistant.slice(assistant.indexOf('function startTick'),
    assistant.indexOf('function setSub'));
  assert.match(tick, /session\.voice\.activity/);
  assert.ok(!/getUserMedia|MicLevel|VoiceWave/.test(tick),
    'a second microphone consumer opened during recognition');
});

test('mobile source: Cancel discards, and the finishing path never does', () => {
  const cancel = assistant.slice(assistant.indexOf('function cancelListening'),
    assistant.indexOf('function stopCapture'));
  assert.match(cancel, /session\.cv\?\.active \? session\.cv\.cancel\(\) : null/);
  assert.match(cancel, /stopCapture\(true\)/, 'a late final can still repaint over the restore');

  const finish = assistant.slice(assistant.indexOf('function finishListening'),
    assistant.indexOf('function applyFinish'));
  assert.ok(!/cancel\(\)/.test(finish), 'the finishing path reaches for cancel');
  assert.match(finish, /session\.graceTimer = setTimeout\(\(\) => applyFinish\(null\), GRACE_MS\)/);
  assert.match(assistant, /const GRACE_MS = 1500/);
});

test('mobile source: Keep opens the ordinary composer, and the mic carries it back', () => {
  const apply = assistant.slice(assistant.indexOf('function applyFinish'),
    assistant.indexOf('async function sendVoice'));
  assert.match(apply, /if \(out\.send\) \{ void sendVoice\(out\.text\); return; \}/);
  assert.match(apply, /openCompose\(out\.text\)/, 'Keep does not reveal the text');
  /* IN THE PAGE, under the buttons -- not a sheet sliding over the surface
     the words came from. */
  assert.match(assistant, /<div class="asst-compose" id="asst-compose" hidden>/);
  assert.ok(!/openTypeSheet|openSheet\(\{\s*title: 'Tell Life OS'/.test(assistant),
    'the typing sheet is back');
  /* Speak carries what is written. It sits directly above the composer now,
     so starting fresh would silently destroy the text beneath it. */
  assert.match(assistant, /#asst-speak'\)\.onclick = \(\) => startListening\(composeText\(\)\)/);
  /* And Type instead reveals it without emptying it. */
  assert.match(assistant, /#asst-type'\)\.onclick = \(\) => focusCompose\(\)/);
  assert.match(assistant, /function focusCompose\(\)[\s\S]{0,120}openCompose\(composeText\(\)\)/);
  assert.match(assistant, /function startListening\(committed = ''\)/);
  assert.match(assistant, /session\.cv\.begin\(session\.transcript\)/);
});

test('mobile source: no handler is handed the click event as its text', () => {
  /* `onclick = startListening` passes the PointerEvent into the first
     argument, so the composer opened holding "[object PointerEvent]". It was
     already true of the typing button before either took an argument, and it
     shipped that way -- tapping "Type instead" prefilled the box with it. */
  const bare = assistant.match(/onclick = ([a-zA-Z_$][\w$]*);/g) ?? [];
  assert.ok(bare.length, 'nothing is bound this way any more -- drop this guard');
  for (const b of bare) {
    const name = b.slice('onclick = '.length, -1);
    const at = assistant.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `${name} is bound bare but is not a plain function`);
    const params = assistant.slice(at + `function ${name}(`.length,
      assistant.indexOf(')', at));
    assert.equal(params.trim(), '',
      `${name} takes an argument and is bound bare -- the event lands in it`);
  }
  assert.match(assistant, /#asst-speak'\)\.onclick = \(\) => startListening\(/);
  assert.match(assistant, /#asst-type'\)\.onclick = \(\) => focusCompose\(\)/);
});

test('mobile source: nothing on this screen can silently empty the composer', () => {
  /* The composer is now on the SAME screen as Speak and Type instead. Both
     used to start from nothing, which was harmless while the composer was a
     sheet you had to dismiss first -- and destroys the text sitting directly
     beneath them now. */
  assert.match(assistant, /function composeText\(\)/, 'nothing can read what is written');
  const read = assistant.slice(assistant.indexOf('function composeText'),
    assistant.indexOf('function focusCompose'));
  assert.match(read, /if \(!box \|\| box\.hidden\) return '';/,
    'a hidden composer reports stale text as the base');

  /* Type instead reveals, it does not replace. */
  const focus = assistant.slice(assistant.indexOf('function focusCompose'),
    assistant.indexOf('function openCompose'));
  assert.match(focus, /openCompose\(composeText\(\)\)/, 'Type instead empties the composer');

  /* And there is ONE Speak, not two doing the same thing a thumb apart. */
  assert.ok(!/id="asst-tomic"/.test(assistant), 'the duplicate Speak button is back');
  assert.equal((assistant.match(/id="asst-speak"/g) ?? []).length, 1);
});

test('desktop: none of this reached the composer', () => {
  const panel = strip(read('assistant-panel.js'));
  assert.match(panel, /autoStop: false/);
  assert.match(panel, /<textarea class="composer-input"/, 'the multiline composer went');
  assert.match(panel, /id="voice-cancel"/);
  assert.match(panel, /id="voice-keep"/);
  assert.match(panel, /id="voice-send"/);
  assert.match(panel, /new VoiceWave\(canvas\)/, 'the horizontal amplitude visual went');
  assert.ok(!/asst-keep|finishListening|openTypeSheet/.test(panel),
    'the mobile flow leaked into the desktop composer');
});
