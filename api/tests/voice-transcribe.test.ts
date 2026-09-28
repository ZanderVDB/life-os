/**
 * The recorded-audio path: the measurement spike.
 *
 * See `docs/mobile-transcription-options.md`. Android's recogniser ends on
 * every pause and the platform plays a tone on every restart; this records
 * the audio instead and has it transcribed elsewhere. It is behind a flag and
 * the existing mobile voice system is untouched.
 *
 * What these hold: that the audio goes nowhere it should not, that a failure
 * never costs somebody their words, and that the flag really is off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join('..', 'web', f), 'utf8');
const api = (f: string) => readFileSync(join('src', f), 'utf8');
/* The `[^:\\]` matters. `addContentTypeParser(/^audio\//, ...)` ends in two
   slashes, and a stripper that calls those a line comment eats the rest of
   the line — which it did, so three assertions "failed" against source that
   had never been there. A test harness can be the thing that is broken. */
const strip = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\])\/\/[^\r\n]*/g, '$1');

const assistant = strip(read('assistant.js'));
const recorder = strip(read('voice-record.js'));
const lib = strip(api('lib/transcribe.ts'));
const route = strip(api('routes/voice.ts'));

/* ══ The flag ════════════════════════════════════════════════════════════ */

test('spike: the recorded path is off unless it is deliberately switched on', () => {
  assert.match(assistant, /export const recordMode = \(\) => \{/);
  const fn = assistant.slice(assistant.indexOf('export const recordMode'),
    assistant.indexOf('const recording = ()'));
  /* The environment decides whether it can exist at all -- the same gate the
     diagnostics panel uses, which `loadEnv` refuses to enable in production. */
  assert.match(fn, /if \(!devPossible\(\)\) return false;/,
    'the spike could be switched on in production');
  assert.match(fn, /localStorage\.getItem\('los2_rec'\) === '1'/);
  /* And the existing system is what runs when it is off. */
  assert.match(assistant, /if \(recordMode\(\) && recordingSupported\(\)\) \{ void startRecording\(\); return; \}/);
  assert.match(assistant, /if \(startSpeech\(session\.transcript\.trim\(\)\)\)/,
    'the Web Speech path was removed');
  assert.match(assistant, /new VoiceInput\(/, 'the recogniser is gone');
});

test('spike: desktop is not involved at all', () => {
  const panel = strip(read('assistant-panel.js'));
  assert.ok(!/VoiceRecorder|recordMode|transcribeAudio/.test(panel),
    'the desktop composer picked up the recorded path');
  assert.match(panel, /new VoiceInput\(/);
  assert.match(panel, /autoStop: false/);
});

/* ══ One microphone ══════════════════════════════════════════════════════ */

test('recorder: one getUserMedia feeds both the recorder and the orb', () => {
  const calls = recorder.match(/getUserMedia\(/g) ?? [];
  assert.equal(calls.length, 1, `the microphone is opened ${calls.length} times`);
  /* The analyser hangs off the same stream object. */
  assert.match(recorder, /createMediaStreamSource\(this\.stream\)/);
  assert.match(recorder, /new MediaRecorder\(this\.stream/);
  /* And the orb reads it. */
  assert.match(assistant, /session\.recorder \? session\.recorder\.read\(\) : session\.voice\.activity/,
    'the orb is not reading real amplitude while recording');
});

test('recorder: nothing is ever routed to the speakers', () => {
  assert.ok(!/\.destination\b/.test(recorder), 'the microphone reaches the speakers');
});

test('recorder: the format is asked for, never assumed', () => {
  assert.match(recorder, /MediaRecorder\.isTypeSupported/);
  /* Safari produces mp4 and refuses webm; Android produces webm/opus. Both
     must be offered or one of them silently uploads something undecodable. */
  assert.match(recorder, /audio\/webm;codecs=opus/);
  assert.match(recorder, /audio\/mp4/);
  /* And the blob's OWN type is what gets uploaded, not the requested one. */
  assert.match(recorder, /this\.rec\?\.mimeType \|\| this\.mime/);
});

test('recorder: there is a ceiling, and ordinary silence is not it', () => {
  assert.match(recorder, /export const MAX_SECONDS = 5 \* 60/);
  assert.match(recorder, /this\.opts\.onLimit\?\.\('limit'\)/);
  /* Nothing in the recorder watches for quiet. */
  assert.ok(!/silen|vad|quiet/i.test(recorder), 'the recorder stops itself on silence');
  assert.match(assistant, /onLimit: \(\) => \{[\s\S]{0,200}finishListening\('keep'\)/,
    'hitting the ceiling loses the recording instead of keeping it');
});

/* ══ Cancel must never upload ════════════════════════════════════════════ */

test('cancel: the audio is dropped before the recorder is even stopped', () => {
  const fn = recorder.slice(recorder.indexOf('  cancel()'), recorder.indexOf('  release()'));
  const dropped = fn.indexOf('this.chunks = []');
  const stopped = fn.indexOf('this.rec?.stop()');
  assert.ok(dropped >= 0 && stopped >= 0);
  assert.ok(dropped < stopped,
    'there is a window where a cancelled recording could still be sent');
});

test('cancel: never reaches transcription', () => {
  const fn = assistant.slice(assistant.indexOf('function cancelListening'),
    assistant.indexOf('function stopCapture'));
  assert.ok(!/finishRecording|transcrib/i.test(fn), 'Cancel can reach the upload');
  /* And stopCapture, which Cancel goes through, discards the recorder. */
  const at = assistant.indexOf('function stopCapture');
  const stop = assistant.slice(at, assistant.indexOf('\n}', at));
  assert.match(stop, /session\.recorder\?\.cancel\(\)/);
});

test('leaving the surface drops the audio and frees the microphone', () => {
  const fn = assistant.slice(assistant.indexOf('function endSession'),
    assistant.indexOf('export const leaveAssistant'));
  assert.match(fn, /session\.recorder\?\.cancel\(\)/,
    'a microphone is left open behind a page nobody is looking at');
  assert.match(fn, /clearTimeout\(session\.graceTimer\)/);
  assert.match(fn, /clearTimeout\(session\.safetyTimer\)/);
});

/* ══ Failure never costs somebody their words ════════════════════════════ */

test('a failed transcription settles with an empty segment, keeping the base', () => {
  const fn = assistant.slice(assistant.indexOf('async function finishRecording'),
    assistant.indexOf('/**\n * The orb'));
  /* Both the failure path and the empty-recording path settle rather than
     hang -- and settling with '' merges base + nothing, which is the base. */
  assert.equal((fn.match(/applyFinish\('\'\)/g) ?? []).length, 2,
    'a failure can leave the surface stuck in Transcribing');
  assert.match(fn, /catch \(e\)/);
  /* The ComposerVoice contract is what decides what happens next, unchanged. */
  assert.match(fn, /applyFinish\(String\(res\?\.text \?\? ''\)\.trim\(\)\)/);
});

test('a second press cannot start a second upload', () => {
  /* `cv.finish()` refuses when the state is not 'listening', so the second
     press returns before anything is stopped or sent. */
  assert.match(assistant, /if \(!session\.cv\?\.finish\(action\)\) return;/);
  const fn = assistant.slice(assistant.indexOf('function finishListening'),
    assistant.indexOf('async function applyFinish') > 0
      ? assistant.indexOf('async function applyFinish')
      : assistant.indexOf('function applyFinish'));
  assert.ok(fn.indexOf('cv?.finish(action)') < fn.indexOf('finishRecording'),
    'the guard runs after the upload starts');
  /* And the recorder is taken off the session immediately, so a race cannot
     stop it twice. */
  const rec = assistant.slice(assistant.indexOf('async function finishRecording'));
  assert.ok(rec.indexOf('session.recorder = null') < rec.indexOf('await rec.stop()'),
    'two presses could both stop the same recorder');
});

test('navigating away mid-transcription touches nothing', () => {
  const fn = assistant.slice(assistant.indexOf('async function finishRecording'),
    assistant.indexOf('/**\n * The orb'));
  assert.ok((fn.match(/if \(!session\)/g) ?? []).length >= 3,
    'a late response can write into a session that has gone');
});

/* ══ The server ══════════════════════════════════════════════════════════ */

test('server: audio is never written anywhere', () => {
  for (const [name, src] of [['transcribe.ts', lib], ['voice.ts', route]] as const) {
    assert.ok(!/writeFile|createWriteStream|tmpdir|\.insert\(|s3|putObject/i.test(src),
      `${name} can persist audio`);
  }
  /* Multipart is refused deliberately: @fastify/multipart buffers to a
     temporary file above a threshold, which is the one thing this must not
     do. The body arrives as itself. */
  assert.match(route, /parseAs: 'buffer'/);
  assert.ok(!/multipart/.test(route.replace(/multipart field/g, '')),
    'the route went through a multipart parser');
});

test('server: the key never leaves the server, and nor does the transcript', () => {
  assert.match(lib, /env\.OPENAI_API_KEY/);
  /* Never returned, never logged. */
  /* Only a failure CODE is logged. Matching the word "transcript" was too
     blunt — `log.warn({ code }, 'transcription failed')` contains it. */
  assert.ok(!/log\.\w+\([^)]*\b(out\.text|res\.text|audio|blob)\b/.test(route),
    'a transcript or the audio itself is being logged');
  assert.ok(!/OPENAI_API_KEY/.test(route), 'the route handles the key itself');
  const web = strip(read('assistant-api.js'));
  assert.ok(!/OPENAI|api\.openai/i.test(web), 'the browser knows about the provider');
});

test('server: cost comes from the provider, never from the browser', () => {
  assert.match(lib, /response_format', 'verbose_json/,
    'the provider is not asked how long the audio was');
  assert.match(route, /audioSeconds: Math\.round\(out\.audioSeconds\)/);
  /* Nothing read off the request decides the price. */
  const handler = route.slice(route.indexOf("app.post("));
  assert.ok(!/headers\[[^\]]*duration|body\.seconds|request\.headers\['x-seconds/.test(handler),
    'the client supplies the billable duration');
});

test('server: the ledger records the whole story, success or failure', () => {
  assert.match(route, /job: 'transcribe'/);
  assert.equal((route.match(/recordUsage\(/g) ?? []).length, 2,
    'a failed transcription leaves no trace in the ledger');
  assert.match(route, /status: 'failed'/);
  assert.match(route, /assertCanUseAi\(db, who\.userId/,
    'a paid call happens without checking the allowance');
  /* And the ledger can never be the reason a request 500s. */
  const failure = route.slice(route.indexOf("status: 'failed'"));
  assert.match(failure, /\}\)\.catch\(/,
    'a ledger write that throws would turn a handled failure into a 500');
});

test('server: an unsupported format is refused rather than forwarded', () => {
  assert.match(route, /if \(!acceptedMime\(mime\)\)/);
  assert.match(route, /code\(415\)/);
  assert.match(route, /code\(413\)/, 'there is no size ceiling');
  assert.match(route, /export const MAX_AUDIO_BYTES/);
});

test('pricing: transcription is in the normal registry, and flagged provisional', () => {
  const pricing = api('usage/pricing.ts');
  assert.match(pricing, /provider: 'openai'/);
  assert.match(pricing, /perMinuteUsd: 0\.003/);
  assert.match(pricing, /PROVISIONAL/,
    'a price nobody has verified is presented as if it were checked');
  /* Text models must price identically to before. */
  assert.match(pricing, /\(tokens\.audioSeconds \?\? 0\) \/ 60\) \* \(price\.perMinuteUsd \?\? 0\)/);
});

/* ══ The money, against a real database ══════════════════════════════════ */

test('a transcription is priced by the second and lands in the ledger', async () => {
  const { freshDb } = await import('./helpers.js');
  const { users, workspaces, workspaceMemberships, aiUsageEvents } =
    await import('../src/db/schema.js');
  const { recordUsage, totalsForUser } = await import('../src/usage/ledger.js');
  const { priceUsage } = await import('../src/usage/pricing.js');

  const { db } = await freshDb();
  const [u] = await db.insert(users).values({
    email: 'zander@example.com', displayName: 'Zander',
  }).returning();
  const [ws] = await db.insert(workspaces).values({
    ownerUserId: u!.id, name: 'Life OS',
  }).returning();
  await db.insert(workspaceMemberships).values({ workspaceId: ws!.id, userId: u!.id });

  /* Twenty seconds at $0.003 a minute. */
  const priced = priceUsage('openai', 'gpt-4o-mini-transcribe', {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    audioSeconds: 20,
  });
  assert.ok(priced, 'transcription is not in the pricing registry');
  assert.equal(priced!.usd, 0.001);
  assert.equal(priced!.estimated, false, 'the model fell through to a ceiling');

  const scope = {
    scopeId: 'spike', workspaceId: ws!.id, userId: u!.id,
    conversationId: null, turnId: null, origin: 'user' as const,
    calls: [], budgetUsd: null, spentUsd: 0, exhausted: false,
  };
  await recordUsage(db, scope, {
    provider: 'openai', model: 'gpt-4o-mini-transcribe', job: 'transcribe',
    attempt: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, audioSeconds: 20, providerRequestId: 'req_abc',
    status: 'ok', errorType: null, latencyMs: 1234, seq: 1,
  });

  const [row] = await db.select().from(aiUsageEvents);
  assert.ok(row, 'nothing was written');
  /* Everything the spike was asked to prove it can capture. */
  assert.equal(row!.userId, u!.id);
  assert.equal(row!.workspaceId, ws!.id);
  assert.equal(row!.audioSeconds, 20, 'the duration was not recorded');
  assert.equal(row!.provider, 'openai');
  assert.equal(row!.model, 'gpt-4o-mini-transcribe');
  assert.equal(row!.job, 'transcribe');
  assert.equal(row!.providerRequestId, 'req_abc');
  assert.equal(Number(row!.providerCostUsd), 0.001);
  assert.equal(Number(row!.billableCostUsd), 0.001);
  assert.equal(row!.status, 'ok');
  assert.equal(row!.latencyMs, 1234);
  assert.ok(row!.createdAt instanceof Date);

  /* And the allowance sees it: the totals query filters by user and window
     only, with no list of jobs it is willing to count — so a new kind of
     spend is counted the day it starts happening rather than the day
     somebody remembers to add it. */
  const totals = await totalsForUser(db, u!.id);
  assert.equal(totals.billableCostUsd, 0.001, 'the allowance did not see it');
  assert.equal(totals.calls, 1);
});

test('a failed transcription is recorded and charged nothing', async () => {
  const { freshDb } = await import('./helpers.js');
  const { users, workspaces, workspaceMemberships, aiUsageEvents } =
    await import('../src/db/schema.js');
  const { recordUsage } = await import('../src/usage/ledger.js');

  const { db } = await freshDb();
  const [u] = await db.insert(users).values({
    email: 'z@example.com', displayName: 'Z',
  }).returning();
  const [ws] = await db.insert(workspaces).values({
    ownerUserId: u!.id, name: 'W',
  }).returning();
  await db.insert(workspaceMemberships).values({ workspaceId: ws!.id, userId: u!.id });

  await recordUsage(db, {
    scopeId: 's', workspaceId: ws!.id, userId: u!.id, conversationId: null,
    turnId: null, origin: 'user' as const, calls: [], budgetUsd: null,
    spentUsd: 0, exhausted: false,
  }, {
    provider: 'openai', model: 'gpt-4o-mini-transcribe', job: 'transcribe',
    attempt: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, audioSeconds: 12, providerRequestId: null,
    status: 'failed', errorType: 'http_503', latencyMs: 900, seq: 1,
  });

  const [row] = await db.select().from(aiUsageEvents);
  assert.equal(row!.status, 'failed');
  assert.equal(row!.errorType, 'http_503');
  assert.equal(Number(row!.providerCostUsd), 0, 'a failed call was charged for');
  /* How much audio was sent is a fact about the REQUEST, so it survives. */
  assert.equal(row!.audioSeconds, 12);
});

test('text models price exactly as they did before', async () => {
  const { priceUsage } = await import('../src/usage/pricing.js');
  const tokens = {
    inputTokens: 1_000_000, outputTokens: 1_000_000,
    cacheReadTokens: 0, cacheWriteTokens: 0,
  };
  const haiku = priceUsage('anthropic', 'claude-haiku-4-5', tokens);
  /* $1 in + $5 out per million, and not a cent of audio. */
  assert.equal(haiku!.usd, 6);
  assert.equal(priceUsage('anthropic', 'claude-haiku-4-5',
    { ...tokens, audioSeconds: 0 })!.usd, 6);
});
