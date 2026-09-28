/**
 * Recorded speech in, text out.
 *
 * The measurement spike for replacing mobile Web Speech -- see
 * `docs/mobile-transcription-options.md` and `../lib/transcribe.ts`, which
 * documents where the audio lives and for how long.
 *
 * Nothing here decides whether mobile SHOULD use this. The client asks; the
 * flag that lets it ask is in the browser, and this route simply refuses when
 * no provider is configured.
 */
import type { AppInstance, Guards } from '../types.js';
import type { Db } from '../db/client.js';
import {
  transcribe, transcriptionMode, acceptedMime,
  TranscriptionFailed, TranscriptionUnavailable,
} from '../lib/transcribe.js';
import { recordUsage } from '../usage/ledger.js';
import { withMeter } from '../usage/meter.js';
import { assertCanUseAi } from '../usage/allowance.js';

/**
 * A hard ceiling on one recording.
 *
 * Opus at 24 kbps is about 180 KB a minute, so this is roughly half an hour --
 * far beyond the five-minute safety stop in the client, and small enough that
 * a forgotten microphone cannot post something enormous.
 */
export const MAX_AUDIO_BYTES = 6 * 1024 * 1024;

export function registerVoiceRoutes(app: AppInstance, db: Db, guards: Guards) {
  /* Raw bodies. The audio arrives as itself rather than wrapped in multipart:
     one less dependency, one less parse, and nothing to leave behind on
     disk -- `@fastify/multipart` buffers to a temporary file above a
     threshold, which is exactly the thing this must not do. */
  app.addContentTypeParser(
    /^audio\//, { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES },
    (_req, body, done) => { done(null, body); },
  );

  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const base = '/api/v1/workspaces/:workspaceId';

  const owner = (req: any) => ({
    workspaceId: req.workspaceId ?? req.params.workspaceId,
    userId: req.principal?.userId ?? req.user?.id ?? '',
  });

  /** Is this even on? Lets the client hide the flag rather than fail at it. */
  app.get(`${base}/voice/transcription`, pre, async () => ({
    mode: transcriptionMode(),
    maxBytes: MAX_AUDIO_BYTES,
  }));

  app.post(`${base}/voice/transcribe`, pre, async (request: any, reply) => {
    const mode = transcriptionMode();
    if (mode === 'off') {
      return reply.code(503).send({
        error: 'transcription_unavailable',
        message: 'Transcription is not configured on this server.',
      });
    }

    const mime = String(request.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (!acceptedMime(mime)) {
      return reply.code(415).send({
        error: 'unsupported_format',
        message: `This server cannot transcribe ${mime || 'an unknown format'}.`,
      });
    }

    const audio = request.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      return reply.code(400).send({ error: 'empty', message: 'No audio arrived.' });
    }
    if (audio.length > MAX_AUDIO_BYTES) {
      return reply.code(413).send({
        error: 'too_large',
        message: 'That recording is too long to send.',
      });
    }

    /* The same gate the assistant uses, and for the same reason: the browser
       never decides whether a paid call may happen. */
    const who = owner(request);
    await assertCanUseAi(db, who.userId, {});

    const began = Date.now();
    return withMeter({ ...who, conversationId: null, turnId: null, origin: 'user' },
      async (scope) => {
    try {
      const out = await transcribe(audio, mime);
      /* Priced from the PROVIDER's duration, never the client's. The browser
         sends its own measurement for the latency report and it is used for
         nothing else. */
      await recordUsage(db, scope, {
        provider: out.provider,
        model: out.model,
        job: 'transcribe',
        attempt: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        audioSeconds: Math.round(out.audioSeconds),
        providerRequestId: out.providerRequestId,
        status: 'ok',
        errorType: null,
        latencyMs: Date.now() - began,
        seq: 1,
      });

      return {
        text: out.text,
        provider: out.provider,
        model: out.model,
        /* For the spike's latency report. Deliberately separate from the
           numbers the ledger was written from. */
        timings: {
          providerMs: out.providerMs,
          serverMs: Date.now() - began,
          bytes: audio.length,
          audioSeconds: out.audioSeconds,
          durationEstimated: out.durationEstimated,
        },
      };
    } catch (e) {
      const failed = e instanceof TranscriptionFailed;
      const code = failed ? (e as TranscriptionFailed).code
        : e instanceof TranscriptionUnavailable ? 'unconfigured' : 'unknown';
      /* A failed call is recorded and charged nothing -- the ledger's own
         rule. What matters is that the attempt is visible. */
      await recordUsage(db, scope, {
        provider: mode === 'openai' ? 'openai' : 'stub',
        model: 'gpt-4o-mini-transcribe',
        job: 'transcribe',
        attempt: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        providerRequestId: null,
        status: 'failed',
        errorType: code,
        latencyMs: Date.now() - began,
        seq: 1,
      }).catch(() => { /* the ledger must never be why a request 500s */ });

      request.log.warn({ code }, 'transcription failed');
      return reply.code(502).send({
        error: 'transcription_failed',
        message: 'That could not be transcribed. Your words are still here.',
      });
    }
      });
  });
}
