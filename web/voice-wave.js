/**
 * The little waveform in the desktop composer.
 *
 * ── What it is for ──────────────────────────────────────────────────────
 *
 * One job: "Life OS can hear my microphone." Not a transcript, not a level
 * meter with numbers, not the Assistant orb. A row of bars that moves when you
 * speak and settles when you stop, small enough to live inside the composer.
 *
 * ── Why it reads the microphone rather than the words ───────────────────
 *
 * `VoiceInput.activity` is driven by recognised TEXT, which is the right
 * signal for the orb — a picture that moves only when words are landing tells
 * you transcription is alive. It is the wrong signal here, because this
 * answers a question asked before any word has been recognised: is the
 * microphone working at all. So this is real amplitude, from `MicLevel`.
 *
 * ── The care that needs taking ──────────────────────────────────────────
 *
 * `assistant.js` notes that the microphone stream is the ONE thing that must
 * not compete with a running recogniser — a second `getUserMedia` is what
 * appeared to take the microphone away from recognition on a real phone. So
 * this is desktop-only, it opens AFTER recognition has already claimed the
 * microphone, and every failure is soft: no stream means a still waveform and
 * a working recording, never a broken one.
 */
import { MicLevel } from './assistant-orb.js';
import { reducedMotion } from './motion.js';

/* A FIXED bar width, with as many bars as the strip can hold.
 *
 * The first version divided the width by a fixed bar count, which on a
 * composer nearly a thousand pixels wide made every bar 24px across — so a
 * quiet room rendered as a row of long dashes and read as a divider rather
 * than a waveform. A waveform is thin bars, however wide the container. */
const BAR_W = 3;
const GAP = 3;

/* Attack fast, decay slow. A meter that falls as fast as it rises flickers on
   every consonant; one that falls slowly reads as a voice. */
const ATTACK = 0.45;
const DECAY = 0.12;

/* How often a bar is COMMITTED to the strip, which is the whole of the
 * apparent travel speed: bars are BAR_W + GAP apart, so one per frame at 60fps
 * scrolled the strip 360px a second and read as frantic rather than alive.
 *
 * This is deliberately NOT the sampling rate. The microphone is still read
 * every frame and ATTACK is unchanged, so a voice still lifts the strip the
 * instant it starts -- what slowed down is how fast the picture travels, not
 * how fast it reacts. At 40ms that is 25 bars a second against 60, a little
 * over 40% of the old speed, and the same shape stretched wider. */
const TRAVEL_MS = 40;

/** Reduced motion: sample slowly and hold still between samples. */
const CALM_MS = 280;

/** Enough history for the widest strip anybody will see. */
const HISTORY = 400;

export class VoiceWave {
  constructor(canvas) {
    this.canvas = canvas ?? null;
    this.mic = null;
    this.level = 0;
    this.history = [];
    this.raf = 0;
    this.timer = 0;
    this.calm = false;
    this.lastPush = 0;
  }

  /**
   * @returns {Promise<'ok'|'denied'|'unsupported'>} — reported, never thrown.
   * A refused microphone is a quiet waveform, not a failed recording.
   */
  async start() {
    if (!this.canvas) return 'unsupported';
    this.calm = reducedMotion();
    this.mic = new MicLevel();
    let got = 'unsupported';
    try {
      got = await this.mic.start();
    } catch {
      got = 'unsupported';
    }
    if (got !== 'ok') {
      this.mic = null;
      this.draw();          // a flat, honest line rather than a blank box
      return got;
    }
    if (this.calm) {
      this.timer = setInterval(() => this.sample(), CALM_MS);
      this.sample();
    } else {
      const frame = () => {
        this.sample();
        this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    }
    return 'ok';
  }

  /** One reading, smoothed, pushed along the strip. */
  sample() {
    const target = this.mic ? this.mic.read() : 0;
    const k = target > this.level ? ATTACK : DECAY;
    this.level += (target - this.level) * k;
    /* Reduced motion keeps no history at all: every bar stands at the current
       level, so nothing travels across the screen for somebody who asked for
       less movement. It still answers the question — the strip is taller when
       you speak. */
    if (!this.calm) {
      const now = Date.now();
      if (!this.lastPush || now - this.lastPush >= TRAVEL_MS) {
        this.history.push(this.level);
        if (this.history.length > HISTORY) this.history.shift();
        this.lastPush = now;
      } else if (this.history.length) {
        /* Between commits the leading bar tracks the live level, so the strip
           answers a voice on the very next frame even though it only travels
           25 times a second. Slower motion, identical responsiveness. */
        this.history[this.history.length - 1] = this.level;
      }
    }
    this.draw();
  }

  draw() {
    const c = this.canvas;
    if (!c) return;
    const ctx = c.getContext?.('2d');
    if (!ctx) return;
    const dpr = Math.min(3, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
    const w = c.clientWidth || c.width;
    const h = c.clientHeight || c.height;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const count = Math.max(8, Math.floor((w + GAP) / (BAR_W + GAP)));
    const mid = h / 2;
    /* Read from the stylesheet so the strip follows the theme rather than
       carrying its own colour. */
    const ink = getComputedStyle(c).getPropertyValue('--wave-ink').trim() || '#8b7ff5';
    ctx.fillStyle = ink;
    for (let i = 0; i < count; i += 1) {
      const v = this.calm
        ? this.level
        : (this.history[this.history.length - count + i] ?? 0);
      const clamped = Math.max(0, Math.min(1, v));
      /* A floor, so the strip exists when the room is silent — an empty canvas
         reads as broken rather than quiet. */
      const bh = Math.max(BAR_W, clamped * (h - 2));
      const x = i * (BAR_W + GAP);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, mid - bh / 2, BAR_W, bh, BAR_W / 2);
      else ctx.rect(x, mid - bh / 2, BAR_W, bh);
      ctx.fill();
    }
  }

  /** Everything released — the stream, the context and the loop. */
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearInterval(this.timer);
    this.raf = 0;
    this.timer = 0;
    this.mic?.stop();
    this.mic = null;
    this.level = 0;
    this.history = [];
    this.lastPush = 0;
    this.draw();
  }
}
