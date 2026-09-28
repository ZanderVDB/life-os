/**
 * Recording speech, for transcription somewhere else.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * Android's recogniser ends itself on every pause, and the platform plays a
 * tone each time it is restarted. Nothing in the Web Speech API stops that;
 * on-device recognition, the last lever, is desktop-only. So this is the
 * other way round: capture the audio ourselves and send it to be
 * transcribed. No recogniser, no restarts, no tone.
 *
 * Measurement spike. See `docs/mobile-transcription-options.md`.
 *
 * ── ONE microphone stream ───────────────────────────────────────────────
 *
 * The recorder and the orb's amplitude meter share a single `getUserMedia`.
 * This matters more than it looks: a second stream is what took the
 * microphone away from the recogniser on a real phone, and the orb has been
 * driven by recognition energy ever since rather than by loudness.
 *
 * With no recogniser in the picture there is nothing to compete with, so the
 * analyser can finally read the voice directly -- which is what was wanted
 * all along. One stream, two consumers, no contention.
 */
const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * Formats worth asking for, best first.
 *
 * Opus is small -- around 24 kbps, so roughly 180 KB a minute -- and every
 * Android browser produces it. Safari produces mp4/aac instead and refuses
 * webm entirely, which is why this asks rather than assumes: uploading a
 * format the transcriber cannot decode is a failure that looks like a bug in
 * the recording.
 */
const WANTED = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
];

/** The bitrate asked of the encoder. Speech needs very little. */
const BITS_PER_SECOND = 24_000;

/** Nothing ordinary should ever reach this. See `SAFETY_MS` in assistant.js. */
export const MAX_SECONDS = 5 * 60;

/** What this browser will actually record, or null if it will not. */
export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of WANTED) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch { /* older implementations throw rather than answer */ }
  }
  /* A recorder with no supported type still records in SOMETHING on a few
     builds; an empty string tells MediaRecorder to choose. The blob carries
     its own type, and that is what gets uploaded. */
  return '';
}

export function recordingSupported() {
  return typeof MediaRecorder !== 'undefined'
    && Boolean(navigator?.mediaDevices?.getUserMedia)
    && pickMime() !== null;
}

export class VoiceRecorder {
  /**
   * @param {object} opts
   * @param {(reason: 'limit') => void} [opts.onLimit] the safety ceiling hit
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.stream = null;
    this.rec = null;
    this.ctx = null;
    this.analyser = null;
    this.time = null;
    this.chunks = [];
    this.mime = '';
    this.startedAt = 0;
    this.limitTimer = 0;
    this.state = 'idle';       // idle | recording | stopping | done
  }

  get recording() { return this.state === 'recording'; }

  /** Seconds captured so far. */
  get seconds() {
    return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  /**
   * @returns {Promise<'ok'|'denied'|'unsupported'>} — reported, never thrown.
   */
  async start() {
    if (this.state !== 'idle') return 'unsupported';
    if (!recordingSupported()) return 'unsupported';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          /* ON, all three, and deliberately the opposite of the orb's own
             meter. That one turns them off to keep the dynamics it draws;
             this is a transcript, where a flattened, de-noised, echo-free
             signal is exactly what the recogniser wants. The orb reads the
             same processed stream and looks no worse for it. */
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        },
      });
    } catch (e) {
      return e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
        ? 'denied' : 'unsupported';
    }

    this.mime = pickMime() ?? '';
    try {
      this.rec = new MediaRecorder(this.stream, {
        ...(this.mime ? { mimeType: this.mime } : {}),
        audioBitsPerSecond: BITS_PER_SECOND,
      });
    } catch {
      /* A browser that rejects the options can usually still record. */
      try {
        this.rec = new MediaRecorder(this.stream);
      } catch {
        this.release();
        return 'unsupported';
      }
    }
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.rec.start();

    /* The analyser hangs off the SAME stream. Never connected to the
       destination -- routing a microphone to the speakers is a feedback
       loop, and the sound has no reason to leave the analyser. */
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        this.ctx = new AC();
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        const src = this.ctx.createMediaStreamSource(this.stream);
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.72;
        src.connect(this.analyser);
        this.time = new Uint8Array(this.analyser.fftSize);
      }
    } catch {
      /* A picture is worth less than a transcript. Carry on without it. */
      this.analyser = null;
    }

    this.startedAt = Date.now();
    this.state = 'recording';
    clearTimeout(this.limitTimer);
    this.limitTimer = setTimeout(() => {
      if (this.state === 'recording') this.opts.onLimit?.('limit');
    }, MAX_SECONDS * 1000);
    return 'ok';
  }

  /**
   * Current loudness, 0..1. Real amplitude, from the microphone.
   *
   * The same curve the orb's own meter uses, so the picture reads the same
   * as it always has -- ordinary speech at arm's length is a small part of
   * the raw range, and without the curve a normal voice is a twitch.
   */
  read() {
    if (!this.analyser || this.state !== 'recording') return 0;
    this.analyser.getByteTimeDomainData(this.time);
    let sum = 0;
    for (let i = 0; i < this.time.length; i += 1) {
      const v = (this.time[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.time.length);
    return clamp01((rms / 0.22) ** 0.72);
  }

  /**
   * Finish, and hand back what was recorded.
   *
   * @returns {Promise<{blob: Blob, mime: string, seconds: number, stopMs: number}|null>}
   */
  stop() {
    if (this.state !== 'recording') return Promise.resolve(null);
    this.state = 'stopping';
    clearTimeout(this.limitTimer);
    const seconds = this.seconds;
    const began = Date.now();
    return new Promise((resolve) => {
      const finish = () => {
        const type = this.rec?.mimeType || this.mime || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];
        this.release();
        this.state = 'done';
        resolve({ blob, mime: type, seconds, stopMs: Date.now() - began });
      };
      /* `onstop` fires after the last `ondataavailable`, which is the only
         moment the recording is actually complete. A browser that never
         fires it would hang the whole flow, so there is a ceiling. */
      const guard = setTimeout(finish, 4000);
      this.rec.onstop = () => { clearTimeout(guard); finish(); };
      try {
        this.rec.stop();
      } catch {
        clearTimeout(guard);
        finish();
      }
    });
  }

  /**
   * Throw it away. Nothing is uploaded and nothing is kept.
   *
   * The chunks are dropped before the recorder is even asked to stop, so
   * there is no window in which a cancelled recording could still be sent.
   */
  cancel() {
    clearTimeout(this.limitTimer);
    this.chunks = [];
    this.state = 'done';
    try { this.rec?.stop(); } catch { /* already stopped */ }
    this.rec = null;
    this.release();
  }

  /** Microphone, audio context, everything. */
  release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
    this.time = null;
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
  }
}
