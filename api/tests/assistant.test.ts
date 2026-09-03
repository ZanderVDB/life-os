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

test('one listening renderer, configured — not three chosen by a stored key', () => {
  /* §8. It WAS three renderers picked by a stored `variant`, and that turned
     out to be the cause of two reports at once: "none of the buttons change
     anything" (two of the three ignored the lab config entirely) and "it
     looks different on my phone" (each device had quietly kept a different
     choice, and the picker had since been removed, so the value was stuck).
     One renderer, driven by the config, cannot do either. */
  const orb = read('assistant-orb.js');
  assert.doesNotMatch(orb, /this\.variant ===/, 'a stored style still diverts the renderer');
  assert.doesNotMatch(orb, /drawHalo\(|drawRadial\(/, 'the alternative renderers are back');
  assert.match(orb, /else this\.drawWaveform\(/, 'there is no single listening renderer');

  const surface = read('assistant.js');
  assert.doesNotMatch(surface, /currentVariant\(\)/, 'the surface still chooses a style');
  /* The instrument that replaced it is behind the development switch. */
  assert.match(surface, /\$\{devTools\(\) \? devPanelHtml\(\) : ''\}/,
    'the lab is not behind the development switch');
  assert.match(surface, /data-preset=/, 'the presets are gone');
  assert.match(surface, /setConfig\(/, 'a change never reaches the running orb');
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
  assert.match(body, /ctx\.arc\(cx, cy, R \* [\d.]+, 0, TAU\)/,
    'the reduced-motion shape is not a still, complete halo');
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

/* ══ Diagnostics reach staging, and never production ═════════════════════
 *
 * They did not. `DEV_PREVIEW=1` was opt-in, nobody had set it on the staging
 * web service, and the deployed bundle therefore served `devTools = false` —
 * so the Development panel did not exist on the one deployment it was for,
 * while every local check said it did.
 */

test('diagnostics: the environment decides, and it fails closed', () => {
  const server = readFileSync(join('..', 'web', 'server.js'), 'utf8');
  assert.match(server, /export const devToolsEnabled/, 'the gate is not one decision');
  assert.match(server, /RAILWAY_ENVIRONMENT_NAME/, 'the deployment environment is not read');
  assert.match(server, /IS_PRODUCTION = \/prod\//, 'production is not recognised');
  assert.match(server, /IS_STAGING = \/stag/, 'staging is not recognised');
  assert.match(server, /!IS_PRODUCTION && \(IS_STAGING \|\| IS_LOCAL\)/,
    'the rule is not "production never, staging and local yes"');
  /* The same decision governs the config the browser gets AND /preview.html,
     so the two cannot drift apart. */
  assert.match(server, /devTools = \$\{JSON\.stringify\(devToolsEnabled\)\}/);
  assert.match(server, /if \(!devToolsEnabled\)/);
});

test('diagnostics: the rule holds for every deployment shape', () => {
  /* The logic, exercised rather than read. Production must get nothing. */
  const decide = (env: Record<string, string>) => {
    const E = String(env['APP_ENV'] || env['RAILWAY_ENVIRONMENT_NAME']
      || env['RAILWAY_ENVIRONMENT'] || '').toLowerCase();
    const prod = /prod/.test(E);
    const stag = /stag|preview|dev/.test(E);
    const local = env['NODE_ENV'] !== 'production';
    return env['DEV_PREVIEW'] === '1' || (!prod && (stag || local));
  };
  assert.equal(decide({ APP_ENV: 'production', NODE_ENV: 'production' }), false);
  assert.equal(decide({ RAILWAY_ENVIRONMENT_NAME: 'v2-staging', NODE_ENV: 'production' }), true);
  assert.equal(decide({ NODE_ENV: 'development' }), true);
  // An unrecognised deployment gets nothing.
  assert.equal(decide({ NODE_ENV: 'production' }), false);
  assert.equal(decide({ NODE_ENV: 'production', DEV_PREVIEW: '1' }), true);
});

test('diagnostics: the panel offers what a real-device trace needs', () => {
  const surface = readFileSync(join('..', 'web', 'assistant.js'), 'utf8');
  assert.match(surface, /id="asst-copy-trace"/, 'no copy control');
  assert.match(surface, /id="asst-clear-trace"/, 'no clear control');
  assert.match(surface, /No voice trace captured yet/, 'an empty trace says nothing');
  assert.match(surface, /asst-trace-box/, 'no fallback when the clipboard refuses');
  assert.match(surface, /id="asst-meter"/, 'no live signal meter');
  // Behind the switch, and collapsed so it cannot dominate the screen.
  assert.match(surface, /\$\{devTools\(\) \? devPanelHtml\(\) : ''\}/);
  assert.match(surface, /<details class="asst-dev"/, 'the panel is not collapsible');
});

/* ══ The waveform ════════════════════════════════════════════════════════ */

test('waveform: symmetry is a property of the formula, not a tuning', () => {
  const src = readFileSync(join('..', 'web', 'assistant-orb.js'), 'utf8');
  /* Cosine is even, so cos(k(2π−θ)) = cos(kθ) and the curve is identical on
     both sides of the axis. A drifting PHASE would introduce a sine term,
     which is odd, and break exactly that. */
  assert.match(src, /Math\.cos\(th \* b\.k\)/, 'the shape is not built from cosines');
  const from = src.indexOf('const ribbon = (th, t)');
  const ribbon = src.slice(from, src.indexOf('};', from));
  assert.doesNotMatch(ribbon, /Math\.sin\(th/, 'an odd term would break the mirror');

  /* And measured: r(θ) must equal r(−θ) at every angle, at any moment. */
  const SW = [{ k: 2, w: 0.50, rate: 1 / 2600 },
    { k: 3, w: 0.32, rate: -1 / 3400 },
    { k: 4, w: 0.18, rate: 1 / 4300 }];
  const shape = (th: number, t: number) =>
    SW.reduce((v, b) => v + Math.sin(t * b.rate) * b.w * Math.cos(th * b.k), 0);
  for (const t of [0, 1200, 5000, 22000]) {
    for (let i = 1; i < 24; i += 1) {
      const th = (i / 24) * Math.PI * 2;
      assert.ok(Math.abs(shape(th, t) - shape(-th, t)) < 1e-12,
        `not mirrored at t=${t}`);
    }
  }
});

test('waveform: the shipped default is a near-circle that breathes', async () => {
  /* The SHAPE is a config now, so the rule belongs to the config rather than
     to the drawing code. What ships is the default preset. */
  const lab = await import(
    `file://${join(process.cwd(), '..', 'web', 'orb-lab.js')}?t=${Math.random()}`
  ) as any;
  const d = lab.DEFAULT_PRESET;
  assert.ok(d.quiet <= 0.05, `quiet deviation of ${d.quiet} is not a near-circle`);
  assert.ok(d.quiet + d.amp <= 0.20,
    `loud deviation of ${d.quiet + d.amp} loses the circular identity`);
  assert.deepEqual(d.k, [2, 3, 4], 'the default harmonics are not the low, broad ones');
  assert.ok(d.strands >= 8 && d.strands <= 14, 'the default contour count is outside 8-14');
  assert.notEqual(d.even, false, 'the default is not the symmetric family');
});

test('waveform: every preset stays a circle, whatever it does', async () => {
  const lab = await import(
    `file://${join(process.cwd(), '..', 'web', 'orb-lab.js')}?t=${Math.random()}`
  ) as any;
  assert.ok(lab.PRESETS.length >= 20, 'there are not twenty starting points');
  for (const pr of lab.PRESETS) {
    assert.ok(pr.quiet + pr.amp <= 0.5, `${pr.name} deviates too far to read as a circle`);
    assert.ok(pr.gap >= 0, `${pr.name} would draw inside the orb`);
    assert.ok(pr.strands >= 0 && pr.strands <= 24, `${pr.name} has an unreasonable count`);
  }
});

test('waveform: symmetry is available and is the default', async () => {
  const lab = await import(
    `file://${join(process.cwd(), '..', 'web', 'orb-lab.js')}?t=${Math.random()}`
  ) as any;
  /* Measured, not read: with `even`, r(θ) must equal r(−θ) at any moment. */
  const cfg = { ...lab.DEFAULT_PRESET, even: true };
  for (const t of [0, 900, 4200, 30000]) {
    for (let i = 1; i < 20; i += 1) {
      const th = (i / 20) * Math.PI * 2;
      assert.ok(Math.abs(lab.shapeAt(th, t, cfg) - lab.shapeAt(-th, t, cfg)) < 1e-12,
        `not mirrored at t=${t}`);
    }
  }
});

test('waveform: the voice drives it, and silence returns it to a circle', () => {
  const src = readFileSync(join('..', 'web', 'assistant-orb.js'), 'utf8');
  const wave = src.slice(src.indexOf('drawWaveform('));
  assert.match(wave, /this\.energy = prev \+ \(target - prev\)/, 'amplitude is not smoothed');
  assert.match(wave, /cfg\.attack/, 'reaction speed is not adjustable');
  assert.match(wave, /cfg\.release/, 'settle speed is not adjustable');
  assert.match(wave, /ev \* \(cfg\.amp/, 'reach ignores the voice');
  assert.match(wave, /alpha = lead \? [\d.]+ \+ ev \* [\d.]+/, 'brightness ignores the voice');
  assert.match(wave, /push = \(cfg\.push \?\? 0\) \* e/, 'the body swell ignores the voice');
});

/* ══ Thinking ════════════════════════════════════════════════════════════ */

test('thinking: nothing rotates, and nothing reads as progress', () => {
  const src = readFileSync(join('..', 'web', 'assistant-orb.js'), 'utf8');
  const fn = src.slice(src.indexOf('drawProcessing(cx, cy, R, reduce) {'));
  assert.ok(fn.length > 200, 'the thinking state could not be found');
  /* The spinner was `arc(cx, cy, rad, start, start + PI*0.85)` with `start`
     advancing on a clock: a rotating gradient sweep, which is a loading
     indicator whatever it is called. */
  assert.doesNotMatch(fn, /const start = \(this\.t/, 'a rotating start angle is back');
  assert.doesNotMatch(fn, /createLinearGradient/, 'the sweeping gradient is back');
  assert.doesNotMatch(fn, /lineCap = 'round'/, 'the spinner cap is back');
  /* Every ring is a COMPLETE circle. A partial arc is the thing that reads
     as a percentage. */
  const arcs = [...fn.matchAll(/ctx\.arc\([^;]*?\);/g)].map((m) => m[0]);
  assert.ok(arcs.length > 0, 'nothing is drawn');
  for (const a of arcs) {
    assert.match(a, /0, TAU\);$/, `a partial arc reads as progress: ${a}`);
  }
  // And it breathes on its own, which is what makes it different from listening.
  assert.match(fn, /Math\.sin\(this\.t \/ 1500\)/, 'the thinking state does not breathe');
});

test('thinking and listening are visually distinct', () => {
  const src = readFileSync(join('..', 'web', 'assistant-orb.js'), 'utf8');
  const think = src.slice(src.indexOf('drawProcessing(cx, cy, R, reduce) {'));
  const listen = src.slice(src.indexOf('drawWaveform(cx, cy, R, amp, breathe, reduce) {'),
    src.indexOf('drawHalo(cx, cy, R, amp, breathe, reduce) {'));
  assert.ok(think.length > 200 && listen.length > 200, 'a slice is empty');
  /* Listening answers to a voice and does not move on its own; thinking moves
     on its own and answers to nothing. */
  assert.doesNotMatch(think, /\bamp\b/, 'thinking is driven by the microphone');
  assert.match(listen, /this\.energy/, 'listening is not driven by the voice');
});
