/**
 * Turning recorded speech into text.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * Android's speech recogniser ends itself on every pause, and the platform
 * plays a tone each time it is restarted. Nothing in the Web Speech API stops
 * that -- on-device recognition, the last lever, is desktop-only. So mobile
 * may end up recording the audio and sending it here instead. This is the
 * measurement spike for that: see `docs/mobile-transcription-options.md`.
 *
 * ── Where the audio lives, and for how long ─────────────────────────────
 *
 * In memory, for the duration of one request, and nowhere else.
 *
 * It arrives as a request body, is handed to the provider as a multipart
 * field, and goes out of scope when the handler returns. It is never written
 * to disk, never put in the database, never logged, and no object storage is
 * involved. There is deliberately no code here that could persist it -- the
 * safest version of "delete it afterwards" is having nowhere to delete from.
 *
 * ── The key ─────────────────────────────────────────────────────────────
 *
 * Server-side only, read from the environment at call time. It is never sent
 * to the browser, never returned in a response, and never logged.
 */

/** What the provider answered, and what it cost us to ask. */
export type Transcription = {
  text: string;
  provider: string;
  model: string;
  providerRequestId: string | null;
  /** The provider's own view of how long the audio was. */
  audioSeconds: number;
  /** True when nobody authoritative told us the duration. */
  durationEstimated: boolean;
  /** Time spent inside the provider call alone. */
  providerMs: number;
};

export class TranscriptionUnavailable extends Error {
  constructor(message = 'Transcription is not configured') {
    super(message);
    this.name = 'TranscriptionUnavailable';
  }
}

export class TranscriptionFailed extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TranscriptionFailed';
    this.code = code;
  }
}

export const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

/**
 * Which provider is configured, if any.
 *
 * `stub` exists so the whole path -- record, upload, price, ledger, merge --
 * can be exercised and TIMED without a provider account. It answers every
 * question the spike asks except how long the provider itself takes, and it
 * is refused outright in production.
 */
export function transcriptionMode(
  env: NodeJS.ProcessEnv = process.env,
): 'openai' | 'stub' | 'off' {
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.TRANSCRIBE_STUB === '1' && env.NODE_ENV !== 'production') return 'stub';
  return 'off';
}

/** Opus at the bitrate the recorder asks for, used only when nothing better. */
const ASSUMED_BYTES_PER_SECOND = 24_000 / 8;

/**
 * Transcribe one recording.
 *
 * `audio` is a Buffer that came straight off the request. Nothing here keeps
 * a reference to it beyond the call.
 */
export async function transcribe(
  audio: Buffer, mime: string, env: NodeJS.ProcessEnv = process.env,
): Promise<Transcription> {
  const mode = transcriptionMode(env);
  if (mode === 'off') throw new TranscriptionUnavailable();
  const began = Date.now();

  if (mode === 'stub') {
    /* A deliberate, configurable delay so a stub run is not mistaken for a
       measurement of a real provider. Everything either side of the provider
       call -- recorder stop, upload, pricing, ledger -- is genuinely timed. */
    const delay = Number(env.TRANSCRIBE_STUB_MS ?? 250);
    await new Promise((r) => { setTimeout(r, Math.max(0, delay)); });
    return {
      text: String(env.TRANSCRIBE_STUB_TEXT
        ?? 'This is a stubbed transcript, not speech.'),
      provider: 'stub',
      model: 'stub',
      providerRequestId: null,
      audioSeconds: Math.max(1, Math.round(audio.length / ASSUMED_BYTES_PER_SECOND)),
      durationEstimated: true,
      providerMs: Date.now() - began,
    };
  }

  const form = new FormData();
  /* The filename matters: the provider picks the decoder from its extension
     as well as the type, and an unrecognised one is rejected rather than
     guessed at. */
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), fileNameFor(mime));
  form.append('model', TRANSCRIBE_MODEL);
  /* Asks the provider to report the duration it actually decoded. That is
     what the call is priced on -- never a number the browser supplied. */
  form.append('response_format', 'verbose_json');

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
  } catch (e) {
    throw new TranscriptionFailed('unreachable', 'The transcription service could not be reached');
  }

  if (!res.ok) {
    /* The provider's body can quote the audio back in an error. Only the
       status is kept. */
    throw new TranscriptionFailed(`http_${res.status}`,
      `The transcription service returned ${res.status}`);
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new TranscriptionFailed('unreadable', 'The transcription service returned nothing usable');
  }

  const reported = Number(body?.duration);
  const known = Number.isFinite(reported) && reported > 0;
  return {
    text: String(body?.text ?? '').trim(),
    provider: 'openai',
    model: TRANSCRIBE_MODEL,
    providerRequestId: res.headers.get('x-request-id'),
    audioSeconds: known
      ? reported
      : Math.max(1, Math.round(audio.length / ASSUMED_BYTES_PER_SECOND)),
    durationEstimated: !known,
    providerMs: Date.now() - began,
  };
}

/** Types a phone actually produces, and what to call them. */
const EXTENSIONS: Array<[RegExp, string]> = [
  [/^audio\/webm/, 'webm'],
  [/^audio\/ogg/, 'ogg'],
  [/^audio\/mp4/, 'mp4'],
  [/^audio\/mpeg/, 'mp3'],
  [/^audio\/wav|^audio\/x-wav/, 'wav'],
  [/^audio\/aac/, 'aac'],
  [/^audio\/flac/, 'flac'],
];

/** True when a phone's chosen format is one the provider can decode. */
export function acceptedMime(mime: string): boolean {
  return EXTENSIONS.some(([re]) => re.test(mime));
}

export function fileNameFor(mime: string): string {
  const hit = EXTENSIONS.find(([re]) => re.test(mime));
  return `speech.${hit ? hit[1] : 'webm'}`;
}
