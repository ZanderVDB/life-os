/**
 * The desktop composer: multiline text, and a voice session you control.
 *
 * ── What was wrong ──────────────────────────────────────────────────────
 *
 * The composer wrote every recogniser event straight into the field, so the
 * browser's running guesses were on screen: words appearing, being rewritten,
 * briefly becoming numbers. The engine is right by the end and unstable
 * throughout, and showing the unstable middle made a working recogniser look
 * broken. There was also no way to abandon one recording without losing
 * everything typed before it.
 *
 * ── Why these are real tests and not assertions about markup ────────────
 *
 * The promise people care about — "the words I already had are still there" —
 * is a state machine, so it lives in `composer-voice.js` with no DOM in it and
 * is driven directly here. The browser-shaped parts (a textarea, Enter, the
 * IME guard) are checked against the source, because that is all they are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const web = (f: string) => pathToFileURL(join(process.cwd(), '..', 'web', f)).href;
const read = (f: string) => readFileSync(join('..', 'web', f), 'utf8');
/* Prose explains the bugs, and prose must not satisfy an assertion about
   code. Every source check below reads the stripped file. */
const code = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const panel = code(read('assistant-panel.js'));
const css = read('app.css');

const load = async () => {
  const cv = await import(`${web('composer-voice.js')}?t=${Math.random()}`) as any;
  const vi = await import(`${web('voice-input.js')}?t=${Math.random()}`) as any;
  return { ComposerVoice: cv.ComposerVoice, joinSegment: vi.joinSegment };
};

/* ══ The seam ════════════════════════════════════════════════════════════ */

test('merge: only the boundary is touched, never the words', async () => {
  const { joinSegment } = await load();
  assert.equal(joinSegment('Remind me tomorrow to', 'phone Oscar'),
    'Remind me tomorrow to phone Oscar');
  assert.equal(joinSegment('Call Oscar.', 'Then send the invoice.'),
    'Call Oscar. Then send the invoice.');
  // A draft that already ends in a space does not gain a second one.
  assert.equal(joinSegment('Call Oscar ', 'then David'), 'Call Oscar then David');
  assert.equal(joinSegment('', 'phone Oscar'), 'phone Oscar');
  assert.equal(joinSegment('Only this', ''), 'Only this');
  /* NOT re-punctuated and NOT re-trimmed. A trailing space can be deliberate
     mid-sentence, and tidying somebody's own words is a worse fault than a
     plain join. */
  assert.equal(joinSegment('i said  hello', 'there'), 'i said  hello there');
});

/* ══ One recording ═══════════════════════════════════════════════════════ */

test('voice: starting snapshots the draft that is there right now', async () => {
  const { ComposerVoice } = await load();
  const cv = new ComposerVoice();
  assert.equal(cv.begin('Tomorrow I need to'), true);
  assert.equal(cv.base, 'Tomorrow I need to');
  assert.equal(cv.segment, '');
  // A second begin while active is refused rather than resetting the snapshot.
  assert.equal(cv.begin('something else'), false);
  assert.equal(cv.base, 'Tomorrow I need to');
});

test('voice: Cancel restores the draft exactly, to the character', async () => {
  const { ComposerVoice } = await load();
  const cv = new ComposerVoice();
  cv.begin('Tomorrow I need to phone Oscar');
  cv.hear('and send the quote to David');
  assert.equal(cv.cancel(), 'Tomorrow I need to phone Oscar');
  assert.equal(cv.active, false);
  /* The recording is gone, not the composer — the reported fear was that X
     wiped everything. The segment is discarded and the base is handed back. */
  assert.equal(cv.segment, '');
  assert.equal(cv.cancel(), null, 'cancelling twice restored something a second time');
});

test('voice: Keep folds the segment in and sends nothing', async () => {
  const { ComposerVoice } = await load();
  const cv = new ComposerVoice();
  cv.begin('Tomorrow I need to');
  cv.hear('phone Oscar about the invoice');
  assert.equal(cv.finish('keep'), true);
  const out = cv.settle();
  assert.deepEqual(out, { text: 'Tomorrow I need to phone Oscar about the invoice', send: false });
});

test('voice: Send submits the WHOLE message, not just the new recording', async () => {
  const { ComposerVoice } = await load();
  const cv = new ComposerVoice();
  cv.begin('Tomorrow I need to phone Oscar');
  cv.hear('and send the invoice');
  cv.finish('send');
  const out = cv.settle();
  assert.equal(out.text, 'Tomorrow I need to phone Oscar and send the invoice');
  assert.equal(out.send, true);
});

/* ══ The flow that was asked for, exactly ════════════════════════════════ */

test('voice: type, keep, edit, cancel, send — one message at the end', async () => {
  const { ComposerVoice } = await load();
  const cv = new ComposerVoice();
  let composer = 'Tomorrow I need to';

  // Session 1 — Keep.
  cv.begin(composer);
  cv.hear('phone Oscar about the invoice');
  cv.finish('keep');
  composer = cv.settle().text;
  assert.equal(composer, 'Tomorrow I need to phone Oscar about the invoice');

  // Typed by hand, between recordings.
  composer += ', check the quote';
  assert.equal(composer, 'Tomorrow I need to phone Oscar about the invoice, check the quote');

  // Session 2 — Cancel. Everything above must survive untouched.
  cv.begin(composer);
  cv.hear('and send it to David');
  composer = cv.cancel();
  assert.equal(composer, 'Tomorrow I need to phone Oscar about the invoice, check the quote',
    'cancelling the second recording destroyed the first');

  // Session 3 — Send.
  cv.begin(composer);
  cv.hear('and check the installation sheet');
  cv.finish('send');
  const out = cv.settle();
  assert.equal(out.send, true);
  assert.equal(out.text,
    'Tomorrow I need to phone Oscar about the invoice, check the quote '
    + 'and check the installation sheet');
  // Nothing from the cancelled session may appear anywhere in it.
  assert.ok(!out.text.includes('David'), 'a cancelled recording came back');
});

test('voice: an edit between recordings becomes the next base', async () => {
  const { ComposerVoice } = await load();
  const cv = new ComposerVoice();
  cv.begin('');
  cv.hear('Call Oscar tomorrow');
  cv.finish('keep');
  let composer = cv.settle().text;
  assert.equal(composer, 'Call Oscar tomorrow');

  composer = 'Call Oscar on Friday';          // edited by hand
  cv.begin(composer);
  assert.equal(cv.base, 'Call Oscar on Friday', 'the pre-edit value came back');
  cv.hear('and send the quote');
  cv.finish('keep');
  assert.equal(cv.settle().text, 'Call Oscar on Friday and send the quote');
});

/* ══ Finishing, exactly once ═════════════════════════════════════════════ */

test('voice: the last words still land when Keep is pressed immediately', async () => {
  const { ComposerVoice } = await load();
  const cv = new ComposerVoice();
  cv.begin('Tomorrow');
  cv.hear('I need to phone');
  cv.finish('keep');
  /* The engine delivers its final a moment AFTER stop(). That result is
     authoritative and replaces the partial reading. */
  const out = cv.settle('I need to phone Oscar about the invoice');
  assert.equal(out.text, 'Tomorrow I need to phone Oscar about the invoice');
});

test('voice: a second press cannot send twice', async () => {
  const { ComposerVoice } = await load();
  const cv = new ComposerVoice();
  cv.begin('Send this');
  cv.hear('please');
  assert.equal(cv.finish('send'), true);
  assert.equal(cv.finish('send'), false, 'a second press was accepted');
  assert.equal(cv.finish('keep'), false, 'Keep was accepted after Send');
  assert.ok(cv.settle());
  assert.equal(cv.settle(), null, 'settling twice produced a second action');
});

test('voice: a stale recogniser cannot rewrite a settled composer', async () => {
  const { ComposerVoice } = await load();
  const cv = new ComposerVoice();
  cv.begin('Base');
  cv.hear('one');
  cv.finish('keep');
  const settled = cv.settle().text;
  // The dead recogniser delivers one more trailing result.
  assert.equal(cv.hear('something else entirely'), false);
  assert.equal(cv.text, settled, 'a stale result changed the composer');
});

test('voice: a grace-period timeout still produces exactly one action', async () => {
  const { ComposerVoice } = await load();
  const cv = new ComposerVoice();
  cv.begin('Base');
  cv.hear('heard this much');
  cv.finish('send');
  /* No final ever arrives — the engine stopped answering. The most recent
     reading stands rather than the press doing nothing at all. */
  const out = cv.settle(null);
  assert.equal(out.text, 'Base heard this much');
  assert.equal(out.send, true);
});

/* ══ Nothing said ════════════════════════════════════════════════════════ */

test('voice: silence then Cancel or Keep leaves the draft exactly as it was', async () => {
  const { ComposerVoice } = await load();
  const cv = new ComposerVoice();

  cv.begin('My draft');
  assert.equal(cv.cancel(), 'My draft');

  cv.begin('My draft');
  cv.finish('keep');
  assert.deepEqual(cv.settle(), { text: 'My draft', send: false });
});

test('voice: Send with nothing anywhere does not send an empty turn', async () => {
  const { ComposerVoice } = await load();
  const cv = new ComposerVoice();

  // Nothing typed, nothing heard.
  cv.begin('');
  cv.finish('send');
  assert.deepEqual(cv.settle(), { text: '', send: false });

  // Whitespace only is still nothing.
  const cv2 = new ComposerVoice();
  cv2.begin('   ');
  cv2.finish('send');
  assert.equal(cv2.settle().send, false);

  /* But an existing draft with nothing heard IS sendable — that is the same
     thing as pressing Send without speaking at all. */
  const cv3 = new ComposerVoice();
  cv3.begin('Just the typed part');
  cv3.finish('send');
  assert.deepEqual(cv3.settle(), { text: 'Just the typed part', send: true });
});

/* ══ The recogniser, against a browser that misbehaves ═══════════════════ */

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

async function desktopVoice() {
  const g = globalThis as any;
  MockRecognition.made = [];
  g.window = { SpeechRecognition: MockRecognition };
  Object.defineProperty(g, 'navigator', {
    value: { language: 'en-GB' }, configurable: true, writable: true,
  });
  const { VoiceInput } = await import(`${web('voice-input.js')}?t=${Math.random()}`) as any;
  const texts: any[] = [];
  /* Exactly how the desktop composer builds it. */
  const v = new VoiceInput({ autoStop: false, onTranscript: (t: any) => texts.push(t) });
  return { v, texts, made: MockRecognition.made };
}

test('desktop: a long pause does not end the recording', async () => {
  const { v, made } = await desktopVoice();
  v.start('Tomorrow I need to');
  made[0]!.say([{ transcript: 'phone Oscar', isFinal: true }]);

  /* The browser ends the recognition by itself during the silence — which on
     desktop happens constantly. The logical session must survive it, because
     a pause here is somebody thinking mid-sentence. */
  v.lastResultAt = Date.now() - 60_000;        // long past any silence window
  made[0]!.end();

  assert.equal(v.wanted, true, 'a pause ended the desktop recording');
  assert.equal(made.length, 2, 'the recogniser was not restarted');
  assert.equal(v.state !== 'idle', true);
  v.destroy();
});

test('desktop: a restart keeps the words already heard, once', async () => {
  const { v, texts, made } = await desktopVoice();
  v.start('');
  made[0]!.say([{ transcript: 'phone Oscar', isFinal: true }]);
  v.lastResultAt = Date.now() - 60_000;
  made[0]!.end();                               // restarts
  made[1]!.say([{ transcript: 'and David', isFinal: true }]);
  const last = texts[texts.length - 1];
  assert.equal(last.spoken, 'phone Oscar and David');
  assert.equal((last.spoken.match(/Oscar/g) ?? []).length, 1, 'a restart repeated itself');
  v.destroy();
});

test('desktop: the browser ending is never treated as pressing Keep', async () => {
  const { v, texts, made } = await desktopVoice();
  v.start('Base');
  made[0]!.say([{ transcript: 'some words', isFinal: true }]);
  v.lastResultAt = Date.now() - 60_000;
  made[0]!.end();
  /* Nothing final may be emitted by a restart: a final is the signal the
     composer uses to commit, and the person has not chosen anything yet. */
  assert.equal(texts.some((t) => t.isFinal), false, 'a restart committed the transcript');
  v.destroy();
});

test('mobile keeps its pause-to-finish behaviour', async () => {
  const g = globalThis as any;
  MockRecognition.made = [];
  g.window = { SpeechRecognition: MockRecognition };
  Object.defineProperty(g, 'navigator', {
    value: { language: 'en-GB' }, configurable: true, writable: true,
  });
  const { VoiceInput } = await import(`${web('voice-input.js')}?t=${Math.random()}`) as any;
  const v = new VoiceInput({});                 // the default: auto-stop ON
  v.start('');
  const rec = MockRecognition.made[0]!;
  rec.say([{ transcript: 'hello', isFinal: true }]);
  v.lastResultAt = Date.now() - 60_000;
  rec.end();
  assert.equal(v.wanted, false, 'the phone stopped ending a message on a pause');
  v.destroy();
});

/* ══ The field itself ════════════════════════════════════════════════════ */

test('composer: it is a textarea that wraps and grows, with a ceiling', () => {
  assert.match(panel, /<textarea class="composer-input" id="composer-input" rows="1"/,
    'the composer is still a single-line input');
  assert.ok(!/<input class="composer-input"/.test(panel), 'the old input is back');
  // Grows from its own content, and stops.
  assert.match(panel, /input\.style\.height = 'auto'/);
  assert.match(panel, /Math\.min\(input\.scrollHeight, max\)/);
  assert.match(panel, /input\.style\.overflowY = input\.scrollHeight > max \? 'auto' : 'hidden'/,
    'past the ceiling it does not scroll inside itself');
  const rows = Number(panel.match(/const MAX_ROWS = (\d+)/)![1]);
  assert.ok(rows >= 5 && rows <= 7, `${rows} rows is outside the 5-7 the brief asks for`);
  /* The cap is repeated in CSS so a failed measurement still cannot let the
     bar march up the screen. */
  assert.match(css, /\.composer-input\{[\s\S]{0,320}?max-height:calc\(1\.45em \* 7\)/);
  assert.match(css, /\.composer-input\{[\s\S]{0,320}?resize:none/);
});

test('composer: Enter sends, Shift+Enter is a newline, and IME is safe', () => {
  assert.match(panel, /if \(e\.isComposing \|\| e\.keyCode === 229\) return;/,
    'an open IME composition would be treated as Send');
  assert.match(panel, /if \(e\.shiftKey\) return;/, 'Shift+Enter no longer makes a newline');
  assert.match(panel, /e\.preventDefault\(\);\s*submitComposer\(\);/);
});

/* ══ What voice mode shows, and does not ════════════════════════════════ */

test('voice mode: the live transcript is never written into the field', () => {
  /* THE ROOT CAUSE. `onTranscript` used to do `input.value = full` on every
     event, so the browser's interim guesses were on screen being rewritten. */
  assert.ok(!/input\.value = full/.test(panel), 'the interim transcript is back in the field');
  const cb = panel.slice(panel.indexOf('onTranscript:'), panel.indexOf('onError:'));
  assert.ok(!/input\.value/.test(cb), 'onTranscript writes to the field');
  assert.match(cb, /cv\.hear\(spoken\)/, 'the words are not kept in the session buffer');
  // Committing happens only on a final, and only while finishing.
  assert.match(cb, /isFinal && cv\.state === 'finishing'/);
});

test('voice mode: it expands the composer rather than opening a dialog', () => {
  assert.match(panel, /id="composer-voice"/);
  assert.ok(!/role="dialog"/.test(panel.slice(panel.indexOf('composer-voice'),
    panel.indexOf('cmp-voice-acts'))), 'voice mode became a modal');
  assert.match(css, /\.composer\.is-voice \.composer-inner\{display:none\}/,
    'the text row is covered rather than replaced');
  assert.match(panel, /<canvas class="cmp-wave"/, 'there is no waveform');
  assert.match(panel, /Listening…/);
});

test('voice mode: the strip is real amplitude, not recognised words', () => {
  const wave = code(read('voice-wave.js'));
  assert.match(wave, /import \{ MicLevel \}/, 'it does not read the microphone');
  assert.match(wave, /this\.mic\.read\(\)/);
  assert.ok(!/activity|transcript|spoken/.test(wave), 'the picture is driven by words');
  // Attack fast, decay slow — a meter that falls as fast as it rises flickers.
  const attack = Number(wave.match(/const ATTACK = ([\d.]+)/)![1]);
  const decay = Number(wave.match(/const DECAY = ([\d.]+)/)![1]);
  assert.ok(attack > decay, 'attack and decay are the wrong way round');
  assert.match(wave, /reducedMotion\(\)/, 'the waveform ignores reduced motion');
});

test('desktop: the session ends on a button, never on a pause', () => {
  assert.match(panel, /autoStop: false/, 'the desktop composer auto-stops on silence');
  const safety = Number(panel.match(/const SAFETY_MS = (\d+) \* 60 \* 1000/)![1]);
  assert.ok(safety >= 2, `a ${safety}-minute safety timeout is not "several minutes"`);
  // And the safety net keeps the words rather than sending them.
  assert.match(panel, /safetyTimer = setTimeout\(\(\) => finishVoice\('keep'\), SAFETY_MS\)/);
});

test('voice mode: a failure keeps the draft, and the controls are reachable', () => {
  // A recognition error or a refused microphone restores, never wipes.
  assert.match(panel, /function failVoice\(message\)[\s\S]{0,120}?cancelVoice\(\)/);
  for (const label of ['Cancel recording', 'Keep transcript', 'Send message']) {
    assert.ok(panel.includes(`aria-label="${label}"`), `${label} has no accessible name`);
  }
  // The state is a word, not only a colour.
  assert.match(panel, /role="status"[\s\S]{0,40}?aria-live="polite"/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\s*\.cmp-voice-dot\{animation:none/);
  /* The microphone stream is opened only AFTER recognition has claimed it —
     a second getUserMedia is what took the microphone away on a real phone. */
  const enter = panel.slice(panel.indexOf('function enterVoice'), panel.indexOf('async function startWave'));
  assert.ok(enter.indexOf('voice.start(') < enter.indexOf('startWave()'),
    'the analyser opens before recognition does');
});

test('mobile: the state contract is shared, the layout is not', () => {
  /* Mobile USED to show its transcript as it was heard and finish on a pause.
     Both were removed deliberately: the interim rewriting read as unreliable,
     and the pause kept ending sentences somebody was still thinking through.
     Mobile now runs the same base-vs-segment contract as the composer -- and
     keeps its own layout, around the large orb. */
  const assistant = code(read('assistant.js'));
  assert.match(assistant, /autoStop: false/, 'a pause still ends the mobile recording');
  assert.ok(!/paintTranscript\(full\)/.test(assistant),
    'mobile is painting the live transcript again');
  assert.match(assistant, /ComposerVoice/, 'mobile has its own idea of a recording again');
  const mobile = code(read('mobile.js'));
  assert.ok(!/composer-voice|cmp-vbtn|cmp-wave/.test(mobile),
    'the desktop voice UI leaked into mobile');
  /* The desktop horizontal waveform must not turn up on the phone. */
  assert.ok(!/VoiceWave/.test(assistant), 'the desktop waveform replaced the orb');
});
