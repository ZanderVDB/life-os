/**
 * Voice input — speech becomes text, and nothing else.
 *
 * ── What this is, and what it is not ─────────────────────────────────────
 *
 * An INPUT ADAPTER. Speech goes in, ordinary text comes out, and it is handed
 * to the same composer typing would have filled. There is no voice message,
 * no audio conversation, no second assistant endpoint. By the time anything
 * reaches the server it is indistinguishable from something that was typed,
 * which is the whole point: one canonical path, one set of rules.
 *
 * Speaking the assistant's answer BACK is a separate future capability and is
 * deliberately absent here.
 *
 * ── Audio level is not transcription ─────────────────────────────────────
 *
 * These are two different subsystems and this file owns only the second one.
 * The orb's waveform comes from `getUserMedia` + an AnalyserNode in
 * `assistant-orb.js`; the words come from the Web Speech API here. They can
 * fail independently, and the bug this file was written for was exactly that:
 * the meter danced to a voice that was being transcribed by nothing, because
 * recognition had quietly ended and the microphone stream had not.
 *
 * So this class never touches `getUserMedia`, and a caller must never infer
 * that recognition works because the level is moving.
 *
 * ── Why restarting is the heart of it ────────────────────────────────────
 *
 * `continuous = true` is advisory. Mobile Chrome and Safari end a recognition
 * after a short pause regardless, firing `end` with no error — and the
 * previous implementation had no `end` handler at all, so speaking, pausing,
 * and speaking again produced exactly one fragment and then silence.
 *
 * While the user still intends to be listened to, `end` restarts. What was
 * already heard is kept in `committed`, so restarting cannot lose it and
 * cannot repeat it.
 */

/** Every state a session can be in. `unavailable` is about the browser. */
export const VOICE_STATES = [
  'idle', 'starting', 'listening', 'stopping', 'cancelled', 'error', 'unavailable',
];

/** The constructor the browser has, whichever name it goes by. */
export const speechRecognition = () =>
  (typeof window === 'undefined'
    ? null
    : window.SpeechRecognition || window.webkitSpeechRecognition || null);

export const voiceSupported = () => Boolean(speechRecognition());

/**
 * What went wrong, in words for the person rather than for the console.
 *
 * The raw codes are kept on the event for logging and never shown: "aborted"
 * and "audio-capture" mean nothing to somebody who just wanted to talk.
 */
export const VOICE_MESSAGES = {
  denied: 'Microphone access is blocked. Allow microphone access in your browser '
    + 'settings to use voice input.',
  'no-speech': 'I didn’t catch anything. Try again.',
  unsupported: 'Voice input isn’t supported by this browser.',
  failed: 'Voice input stopped unexpectedly. Try again.',
};

/** Browser error codes, grouped by what the person can actually do about it. */
const CODE_KIND = {
  'not-allowed': 'denied',
  'service-not-allowed': 'denied',
  'no-speech': 'no-speech',
  'audio-capture': 'failed',
  network: 'failed',
  aborted: 'aborted',           // ours, from cancel(). Never surfaced.
};

/** Restarts allowed before concluding the browser will not keep listening. */
const MAX_RESTARTS = 40;

/** A restart sooner than this after a start means it is not really working. */
const TOO_QUICK_MS = 350;

export class VoiceInput {
  /**
   * @param {object} opts
   * @param {(state: string, info?: object) => void} [opts.onState]
   * @param {(text: {base: string, spoken: string, full: string,
   *                interim: string, isFinal: boolean}) => void} [opts.onTranscript]
   * @param {(err: {kind: string, message: string, code?: string}) => void} [opts.onError]
   * @param {string} [opts.lang] defaults to the browser's own preference
   * @param {boolean} [opts.interim] show words as they are heard
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.state = 'idle';
    this.rec = null;
    /** What the user had typed before speaking. Never overwritten. */
    this.base = '';
    /** Finals from recogniser sessions that have already ended. */
    this.committed = '';
    /** Finals from the recogniser that is running now. Folded in by harvest(). */
    this.sessionFinal = '';
    /** True between start() and stop()/cancel(): the user's intent, not the API's. */
    this.wanted = false;
    this.restarts = 0;
    this.startedAt = 0;
    this.lang = opts.lang || (typeof navigator !== 'undefined' ? navigator.language : '') || 'en-US';
  }

  /* ── State ─────────────────────────────────────────────────────────── */

  setState(next, info) {
    if (this.state === next) return;
    this.state = next;
    this.opts.onState?.(next, info);
  }

  get listening() { return this.state === 'listening' || this.state === 'starting'; }

  /** base + everything heard, trimmed of the join seam. */
  compose(interim = '') {
    const spoken = `${this.committed}${interim}`.replace(/\s+/g, ' ').trim();
    if (!this.base) return { spoken, full: spoken };
    if (!spoken) return { spoken, full: this.base };
    /* One space at the seam, and no double space if the draft already ends
       in one. The draft is never re-trimmed — somebody's trailing space may
       be deliberate mid-sentence. */
    const sep = /\s$/.test(this.base) ? '' : ' ';
    return { spoken, full: `${this.base}${sep}${spoken}` };
  }

  emit(interim, isFinal) {
    const { spoken, full } = this.compose(interim);
    this.opts.onTranscript?.({ base: this.base, spoken, full, interim, isFinal });
  }

  fail(kind, code) {
    this.wanted = false;
    this.teardown();
    this.setState(kind === 'unsupported' ? 'unavailable' : 'error', { kind, code });
    this.opts.onError?.({
      kind, code, message: VOICE_MESSAGES[kind] ?? VOICE_MESSAGES.failed,
    });
  }

  /* ── Lifecycle ─────────────────────────────────────────────────────── */

  /**
   * Begin listening, keeping `baseText` as the draft already in the composer.
   *
   * MUST be called synchronously from the user's gesture. iOS Safari refuses
   * `start()` once the activation has been spent, and the previous code
   * awaited `getUserMedia` first — so on iPhone recognition never began at
   * all while the level meter, started by that same await, worked perfectly.
   *
   * @returns {boolean} whether recognition actually started.
   */
  start(baseText = '') {
    const SR = speechRecognition();
    if (!SR) { this.fail('unsupported'); return false; }
    /* Starting twice on one recogniser throws InvalidStateError and, in some
       builds, wedges it. A second tap while listening is not an error the
       person needs to hear about — it simply means "yes, still listening". */
    if (this.wanted) return true;

    this.base = String(baseText ?? '');
    this.committed = '';
    this.sessionFinal = '';
    this.restarts = 0;
    this.wanted = true;
    this.setState('starting');
    return this.open(SR);
  }

  /** One recogniser, wired. Used by `start` and by every restart. */
  open(SR) {
    let rec;
    try {
      rec = new SR();
    } catch (e) {
      this.log('construct failed', e);
      this.fail('failed');
      return false;
    }
    rec.continuous = true;
    rec.interimResults = this.opts.interim !== false;
    rec.lang = this.lang;
    rec.maxAlternatives = 1;

    /* Finals for THIS recogniser, rebuilt from the full result list on every
       event rather than appended to. Chrome re-reports results whose text is
       refined after they were marked final, and appending made the composer
       stutter the same phrase twice. Rebuilding is idempotent.

       On the INSTANCE rather than in a closure, because `settle()` has to be
       able to keep them: some browsers never fire `end` after `stop()`, and
       holding them here meant the last thing said was thrown away by the
       very timeout that exists to stop the UI sticking. */
    this.sessionFinal = '';

    rec.onstart = () => {
      this.startedAt = Date.now();
      if (this.wanted) this.setState('listening');
    };

    rec.onresult = (e) => {
      if (!this.wanted && this.state !== 'stopping') return;
      let finals = '';
      let interim = '';
      for (let i = 0; i < e.results.length; i += 1) {
        const r = e.results[i];
        const said = r[0]?.transcript ?? '';
        if (r.isFinal) finals += `${said} `;
        else interim += `${said} `;
      }
      this.sessionFinal = finals;
      /* `committed` holds earlier sessions only, so the live text is always
         everything before, plus this session's finals, plus what is still
         being heard. No path adds the same words twice. */
      const previous = this.committed;
      this.committed = `${previous}${finals}`;
      this.emit(interim, false);
      this.committed = previous;
    };

    rec.onerror = (e) => {
      const code = e?.error ?? 'unknown';
      this.log('recognition error', code);
      const kind = CODE_KIND[code] ?? 'failed';
      if (kind === 'aborted') return;           // ours; cancel() has the wheel
      /* `no-speech` is routine on a pause, and the browser follows it with
         `end`. Ending the whole session on it would stop listening the moment
         somebody drew breath — so it is only fatal if nothing was ever
         heard AND the user is no longer trying. Let `onend` decide. */
      if (kind === 'no-speech') { this.lastSilent = true; return; }
      this.fail(kind, code);
    };

    rec.onend = () => {
      /* THE BUG THIS FILE EXISTS FOR.
         Mobile ends a recognition after a pause whatever `continuous` says.
         With no handler here, everything after the first phrase was lost in
         silence while the microphone — a different subsystem entirely — went
         on visibly reacting to the voice. */
      this.harvest();

      if (this.state === 'stopping') { this.settle(); return; }
      if (!this.wanted) return;

      /* A recogniser that ends immediately and repeatedly is not listening,
         whatever it reports. Restarting for ever would spin and hold the
         microphone open; better to stop and say so plainly. */
      const quick = Date.now() - this.startedAt < TOO_QUICK_MS;
      this.restarts += quick ? 1 : 0;
      if (this.restarts > MAX_RESTARTS) {
        this.log('restart storm — giving up');
        if (this.committed.trim()) { this.settle(); return; }
        this.fail('failed', 'restart-loop');
        return;
      }
      const SRnow = speechRecognition();
      if (SRnow) this.open(SRnow);
    };

    try {
      rec.start();
    } catch (e) {
      this.log('start threw', e);
      this.fail('failed');
      return false;
    }
    this.rec = rec;
    return true;
  }

  /**
   * Finish, keeping what was heard.
   *
   * `stop()` rather than `abort()`: stop lets the engine deliver whatever it
   * was still working on, and the last thing somebody said is usually the
   * thing they most want kept.
   */
  stop() {
    if (!this.wanted && this.state !== 'listening') { this.settle(); return; }
    this.wanted = false;
    this.setState('stopping');
    try { this.rec?.stop(); } catch (e) { this.log('stop threw', e); this.settle(); }
    /* Some builds never fire `end` after `stop()`. Without this the UI stays
       in "stopping" and the microphone indicator never clears. */
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.settle(), 1200);
  }

  /**
   * Move this recogniser's finals into the running total, exactly once.
   *
   * Both `end` and the stop timeout call it, and whichever arrives first
   * wins; clearing as it folds is what makes the second call harmless.
   */
  harvest() {
    if (!this.sessionFinal) return;
    this.committed += this.sessionFinal;
    this.sessionFinal = '';
  }

  /** The final answer, once. */
  settle() {
    clearTimeout(this.settleTimer);
    if (this.state === 'idle') return;
    /* Keeps whatever the current recogniser had heard, for the browser that
       never fires `end` after `stop()`. */
    this.harvest();
    this.teardown();
    this.emit('', true);
    this.setState('idle');
  }

  /** Throw the session away — nothing heard is kept. */
  cancel() {
    this.wanted = false;
    this.committed = '';
    this.sessionFinal = '';
    clearTimeout(this.settleTimer);
    this.teardown();
    this.emit('', true);
    this.setState('cancelled');
    this.setState('idle');
  }

  /**
   * Release everything. Safe to call repeatedly, and called on unmount,
   * navigation and close — a recogniser left running holds the microphone and
   * the browser shows the recording dot long after the assistant has gone.
   */
  teardown() {
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    rec.onstart = null;
    try { rec.abort(); } catch { /* already finished */ }
  }

  /** Give up entirely; for component teardown. */
  destroy() {
    this.wanted = false;
    clearTimeout(this.settleTimer);
    this.teardown();
    this.state = 'idle';
  }

  log(...args) {
    /* Developer detail only. The person gets VOICE_MESSAGES. */
    if (typeof console !== 'undefined') console.debug('[voice]', ...args);
  }
}
