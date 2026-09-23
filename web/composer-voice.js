/**
 * The desktop composer's voice session — the rules, with no DOM in sight.
 *
 * ── Why this is its own file ────────────────────────────────────────────
 *
 * The guarantee people actually care about is not visual. It is: "the words I
 * already had are still there afterwards." That is a state machine, and a
 * state machine tangled into event handlers can only be tested by driving a
 * browser — which is why the old behaviour went wrong quietly. Everything here
 * is a pure function of what has happened so far, so every promise below is a
 * test rather than a hope.
 *
 * ── The model ───────────────────────────────────────────────────────────
 *
 *     committed text   what is in the composer, from typing or an earlier
 *                      recording. Snapshotted the instant a recording starts.
 *     active segment   the CURRENT recording, and nothing else.
 *
 * The segment never merges into the committed text until the person chooses.
 * Cancel throws the segment away and restores the snapshot exactly. Keep folds
 * it in and stops. Send folds it in and sends the whole thing, once.
 *
 * ── Why the recogniser is not in here ───────────────────────────────────
 *
 * `VoiceInput` owns recognition and already solves overlap, restarts and stale
 * recognisers. This owns the question that is left over: what the composer
 * should say, given what has been heard so far and which button was pressed.
 */
import { joinSegment } from './voice-input.js';

/** idle → listening → finishing → idle. Nothing skips a step. */
export const COMPOSER_VOICE_STATES = ['idle', 'listening', 'finishing'];

export class ComposerVoice {
  constructor() {
    this.state = 'idle';
    /** The composer's exact text at the moment this recording began. */
    this.base = '';
    /** Everything heard during THIS recording. Never includes `base`. */
    this.segment = '';
    /** Which button is being honoured: 'keep' | 'send' | 'cancel' | null. */
    this.pending = null;
    /** Settled exactly once per session. The duplicate-send guard. */
    this.applied = false;
    /** Counts sessions, so a caller can tell a restart from a new recording. */
    this.sessions = 0;
  }

  get active() { return this.state !== 'idle'; }

  /** What the composer would say if the recording settled right now. */
  get text() { return joinSegment(this.base, this.segment); }

  /**
   * Start a recording over whatever the composer currently holds.
   *
   * `currentText` is read fresh every time rather than remembered from the
   * last session, which is what makes an edit BETWEEN recordings become the
   * new base — the case that is easy to get wrong and impossible to notice
   * until somebody loses a sentence.
   */
  begin(currentText = '') {
    if (this.active) return false;
    this.base = String(currentText ?? '');
    this.segment = '';
    this.pending = null;
    this.applied = false;
    this.sessions += 1;
    this.state = 'listening';
    return true;
  }

  /**
   * What has been heard so far in this recording.
   *
   * Cumulative for the session, not a delta: `VoiceInput` already folds
   * restarts together and trims the overlap, so the latest reading replaces
   * the previous one rather than being appended to it. Appending here is how
   * a restart says everything twice.
   *
   * Ignored once the session is over, which is what stops a recogniser that
   * is still delivering trailing results from rewriting a settled composer.
   */
  hear(spoken) {
    if (!this.active) return false;
    this.segment = String(spoken ?? '');
    return true;
  }

  /**
   * The person pressed Keep or Send.
   *
   * This only RECORDS the intent and moves to `finishing`. Nothing is applied
   * until `settle()`, because the last word or two is usually still in flight
   * inside the recogniser when the button is pressed — see the finalisation
   * sequence in assistant-panel.js.
   *
   * A second press is refused rather than queued. That is the whole of the
   * "duplicate send impossible" requirement: `settle` can only ever run for
   * one pending action, and only once.
   */
  finish(action) {
    if (action !== 'keep' && action !== 'send') return false;
    if (this.state !== 'listening') return false;
    this.state = 'finishing';
    this.pending = action;
    return true;
  }

  /**
   * Throw this recording away and restore the composer exactly.
   *
   * Allowed from `finishing` as well as `listening`: somebody who presses Send
   * and immediately thinks better of it should get their draft back, not a
   * half-finished send.
   *
   * Returns the text the composer must show — the snapshot, byte for byte,
   * whether it came from typing, an earlier recording, or both.
   */
  cancel() {
    if (!this.active) return null;
    const restored = this.base;
    this.segment = '';
    this.pending = 'cancel';
    this.applied = true;
    this.state = 'idle';
    return restored;
  }

  /**
   * Apply the pending action, exactly once.
   *
   * `finalText` is the recogniser's last word on this session, when there is
   * one; without it the most recent reading stands. Either way the segment is
   * merged only at its boundary with the base — see `joinSegment`.
   *
   * `send` is false for an empty result so that pressing Send with nothing to
   * say does nothing, rather than posting an empty turn.
   */
  settle(finalText = null) {
    if (this.state !== 'finishing' || this.applied) return null;
    if (finalText !== null && finalText !== undefined) this.segment = String(finalText);
    const text = this.text;
    const send = this.pending === 'send' && text.trim().length > 0;
    this.applied = true;
    this.pending = null;
    this.state = 'idle';
    return { text, send };
  }

  /** Give up without touching the composer — for unmount and navigation. */
  reset() {
    this.state = 'idle';
    this.base = '';
    this.segment = '';
    this.pending = null;
    this.applied = true;
  }
}
