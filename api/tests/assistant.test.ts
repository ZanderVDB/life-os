/**
 * The assistant client, after the model arrived.
 *
 * ── What changed, and why these tests changed with it ────────────────────
 *
 * The interface was built before the intelligence, on purpose: the hard
 * questions about an assistant that can move your meetings are questions about
 * consent and correction, and those are answered in the interface. That
 * interface was driven by a MOCK PROVIDER in the browser, and these tests
 * exercised it.
 *
 * Both are gone. The provider is real, it runs on the server, and the proposal
 * it produces is stored there — so the rules those tests protected are now
 * enforced by `ai-turn.test.ts` against the real thing, and what is left here
 * is what is still the client's job:
 *
 *   · it keeps NO authoritative idea of what Life OS can do;
 *   · it never talks to a model;
 *   · speech is an enhancement and never the only way in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');

const assistant = read('assistant.js');
const clientApi = read('assistant-api.js');
const cards = read('assistant-cards.js');
const panel = read('assistant-panel.js');

/* ── The client is not the authority ─────────────────────────────────── */

test('what Life OS can do comes from the server, not from a map in the browser', () => {
  assert.match(clientApi, /\/ai\/capabilities/, 'the client never asks what is available');
  /* A presentation table is fine and a capability list is not. The difference
     is written down in the file, because the next person to add a row needs to
     know which one they are adding to. */
  assert.match(cards, /PRESENTATION/);
  assert.match(cards, /NOT authoritative/);
  // A capability the client has never seen still renders.
  assert.match(cards, /\?\?\s*`\$\{action\.module/, 'an unknown capability has no fallback label');
});

test('a proposal naming something now unavailable degrades instead of failing', () => {
  /* Google disconnects between the plan and the confirmation. The card still
     says what was meant; it stops offering a button that would fail. */
  for (const [name, src] of [['assistant.js', assistant], ['assistant-panel.js', panel]] as const) {
    assert.match(src, /markUnavailable/, `${name} does not check availability`);
  }
  assert.match(cards, /unavailable/, 'the card has no unavailable state');
  assert.match(cards, /Not available now/);
});

/* ── The browser talks to Life OS, never to a model ──────────────────── */

test('no model provider is reachable from the browser', () => {
  const bundle = assistant + clientApi + cards + panel + read('app.js');
  assert.ok(!/anthropic|openai|x-api-key|sk-ant/i.test(bundle),
    'the browser references a model provider');
  /* A key in a browser is a public key. Everything goes through the Life OS
     API, which holds it. */
  assert.ok(!/fetch\(\s*['"`]https?:/.test(bundle),
    'the client calls an external URL directly');
});

test('the mock provider is gone, and what remains is a microphone substitute', () => {
  const mockFile = read('assistant-mock.js');
  assert.ok(!/mockProvider/.test(mockFile), 'the fake assistant is still there');
  assert.ok(!/propose\s*\(/.test(mockFile), 'the fake assistant still has a propose method');
  // The transcripts stay: speech recognition does not exist in Firefox.
  assert.match(mockFile, /MOCK_TRANSCRIPTS/);
  assert.match(mockFile, /substitute for a MICROPHONE/i,
    'nothing records what this file is for now');
});

/* ── Consent is still the shape of the interface ─────────────────────── */

test('the button counts, and the count is what is sent', () => {
  /* The count is part of the agreement and the SERVER checks it. The client's
     job is to send the same number it drew. */
  assert.match(clientApi, /export const changeCount/);
  assert.match(clientApi, /filter\(\(a\) => a\.enabled\)/);
  for (const [name, src] of [['assistant.js', assistant], ['assistant-panel.js', panel]] as const) {
    assert.match(src, /Confirm \$\{n\} change/, `${name} does not count on the button`);
    assert.match(src, /runnable\.length/, `${name} sends a count it did not draw`);
  }
});

test('an important change is confirmed on its own, not by the batch', () => {
  for (const [name, src] of [['assistant.js', assistant], ['assistant-panel.js', panel]] as const) {
    assert.match(src, /important/, `${name} does not separate important changes`);
    assert.match(src, /importantAccepted|important\.map/,
      `${name} does not send individual acceptances`);
  }
});

test('an edit goes to the server, which validates it before it counts', () => {
  /* The client cannot decide a value is acceptable. It sends the edit and
     renders whatever comes back — including a refusal. */
  assert.match(clientApi, /export const editTurn/);
  assert.match(assistant, /api\.editTurn\(/);
  assert.match(panel, /api\.editTurn\(/);
});

test('speech recognition is an enhancement, never the thing it depends on', () => {
  /* §10. Chrome and Safari implement it under a prefix and behave
   * differently; Firefox does not implement it at all. Blocking the work on
   * it would mean the interaction could only be tested in one browser.
   *
   * The rule has not changed. The compatibility wrapper moved: it belongs to
   * the shared controller now, because desktop needs the same answer and two
   * copies of a browser check is how two surfaces come to disagree about
   * which browsers work. */
  const voice = read('voice-input.js');
  assert.match(voice, /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/);

  const surface = read('assistant.js');
  assert.match(surface, /new VoiceInput\(/, 'the surface goes through the shared controller');
  assert.match(surface, /runMockCapture/, 'there is no development transcript');
  assert.match(surface, /openTypeSheet/, 'there is no way to type instead');
  // And the surface says which source it used rather than passing a
  // synthetic level off as a voice.
  assert.match(surface, /Demo transcript/, 'the development transcript is unlabelled');
});

test('the microphone drives a picture and is released on the way out', () => {
  const orb = read('assistant-orb.js');
  /* Comments stripped first. The rule is that audio is never captured, not
   * that the word may never be written down — the paragraph explaining why
   * it is not captured is exactly the comment worth keeping. */
  const code = orb.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // Not connected to the speakers, and never stored.
  assert.ok(!/\.connect\(this\.ctx\.destination\)/.test(code),
    'the microphone is routed to the output');
  assert.ok(!/MediaRecorder|new Blob|upload/i.test(code), 'audio is being captured');
  assert.match(code, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/,
    'the microphone tracks are never stopped');

  const surface = read('assistant.js');
  assert.match(read('app.js'), /if \(state\.route === 'ai'\) leaveAssistant\(\);/,
    'leaving the route does not release the microphone');
  assert.match(surface, /export const leaveAssistant = endSession;/);
});

test('three listening variants, one assistant', () => {
  /* §8. Only the listening animation differs — three assistants would be
   * three products, and the point is to choose a motion, not a personality. */
  const orb = read('assistant-orb.js');
  const ids = [...orb.matchAll(/\{ id: '(\w)', label: '[^']+'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['a', 'b', 'c']);
  /* `drawConcentric` became `drawWaveform`: the rings read as sonar, and
     variant A is now a balanced audio waveform around the orb. */
  for (const fn of ['drawWaveform', 'drawHalo', 'drawRadial']) {
    assert.match(orb, new RegExp(`${fn}\\(`), `variant ${fn} is not implemented`);
  }
  // The selector is a development control, not a user setting.
  const surface = read('assistant.js');
  assert.match(surface, /\$\{devTools\(\) \? devPanelHtml\(\) : ''\}/,
    'the variant selector is not behind the development switch');
  assert.ok(!/listening style/i.test(read('settings.js')),
    'the variant selector leaked into Settings as a permanent preference');
});

test('reduced motion still says "listening"', () => {
  /* §49. The requirement is not "less movement" but "communicates active
   * input without large expanding movement" — thickness and opacity rather
   * than things flying across the screen. */
  const orb = read('assistant-orb.js');
  assert.match(orb, /const reducedMotion = \(\) =>/, 'the preference is not read');
  /* The RULE, not the constant: inside the reduced-motion branch the signal
     is carried by weight and opacity, both driven by the voice, and the
     circles it draws do not travel. Asserting the exact multiplier meant the
     test failed when the visual was retuned while still obeying it. */
  const branch = orb.slice(orb.indexOf('if (reduce) {'));
  const body = branch.slice(0, 700);
  assert.match(body, /lineWidth = 1 \+ a \* \d/, 'weight does not answer to the voice');
  assert.match(body, /rgba\([\s\S]{0,40}a \* [\d.]+\}/,
    'opacity does not answer to the voice');
  assert.match(body, /ctx\.arc\(cx, cy, R \* m/, 'the reduced-motion shape is not a still halo');
  // Read live, so turning it on mid-session does not need a reload.
  assert.ok(!/const reduce = window\.matchMedia\([^)]*\)\.matches;\s*$/m.test(orb));
});

/* ══ The orb actually draws ══════════════════════════════════════════════
 *
 * A regression for a failure that was invisible everywhere except a
 * screenshot: `drawCore` already had a local `const shade`, a module-level
 * helper of the same name put it in that function's temporal dead zone, and
 * the ReferenceError was thrown inside an animation frame where nothing was
 * listening. The orb simply stopped being drawn, and every test still passed.
 *
 * So this one paints. It does not check what it looks like — it checks that
 * every variant completes a frame in every state without throwing, which is
 * the part a screenshot was doing by accident.
 */
function fakeCanvas() {
  const calls: string[] = [];
  const ctx: any = new Proxy({}, {
    get(_t, k: string) {
      if (k === 'canvas') return null;
      if (k === 'createRadialGradient' || k === 'createLinearGradient') {
        return () => ({ addColorStop: (_o: number, c: string) => calls.push(`stop:${c}`) });
      }
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (k === 'measureText') return () => ({ width: 10 });
      return (...a: unknown[]) => { calls.push(`${k}(${a.length})`); };
    },
    set() { return true; },
  });
  const el: any = {
    width: 300, height: 300,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 300, height: 300, x: 0, y: 0 }),
    parentElement: { getBoundingClientRect: () => ({ width: 240, height: 240 }) },
  };
  return { el, calls };
}

test('the orb completes a frame in every variant and state', async () => {
  const g = globalThis as any;
  g.window = {
    matchMedia: () => ({ matches: false }),
    devicePixelRatio: 2,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  };
  g.ResizeObserver = class { observe() {} disconnect() {} };
  g.getComputedStyle = () => ({ getPropertyValue: () => '#6A38E0' });
  g.document = { documentElement: {} };

  const mod = await import(
    `file://${join(process.cwd(), '..', 'web', 'assistant-orb.js')}?t=${Math.random()}`
  ) as any;

  for (const variant of ['a', 'b', 'c']) {
    for (const state of ['idle', 'listening', 'processing']) {
      const { el, calls } = fakeCanvas();
      const orb = new mod.Orb(el, { variant });
      orb.setState(state);
      orb.setLevel(0.7);
      /* Two frames: the second exercises the paths that read history the
         first one wrote — the waveform's trailing contours, for one. */
      assert.doesNotThrow(() => { orb.draw(); orb.draw(); },
        `variant ${variant} threw while ${state}`);
      assert.ok(calls.some((c) => c.startsWith('fill(') || c.startsWith('stroke(')),
        `variant ${variant} painted nothing while ${state}`);
    }
  }
});

test('the orb takes its body colour from the accent token', async () => {
  const g = globalThis as any;
  g.window = {
    matchMedia: () => ({ matches: false }),
    devicePixelRatio: 1,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  };
  g.ResizeObserver = class { observe() {} disconnect() {} };
  g.document = { documentElement: {} };

  const seen: string[][] = [];
  for (const token of ['#8A5DFF', '#6A38E0']) {
    g.getComputedStyle = () => ({ getPropertyValue: () => token });
    const mod = await import(
      `file://${join(process.cwd(), '..', 'web', 'assistant-orb.js')}?t=${Math.random()}`
    ) as any;
    const { el, calls } = fakeCanvas();
    const orb = new mod.Orb(el, { variant: 'a' });
    orb.setState('listening');
    orb.draw();
    seen.push(calls.filter((c) => c.startsWith('stop:rgb(')));
  }
  assert.ok(seen[0]!.length >= 5, 'the body gradient was not built from the token');
  assert.notDeepEqual(seen[0], seen[1],
    'a different accent token produced an identical orb');
});
