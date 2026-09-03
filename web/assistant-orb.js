/**
 * The listening orb.
 *
 * ── What this has to communicate ─────────────────────────────────────────
 *
 * One thing, instantly, without a caption:
 *
 *     LIFE OS CAN HEAR ME RIGHT NOW.
 *
 * That is why it is a ball with sound coming OFF it rather than a microphone
 * glyph or a waveform along the bottom of the screen. A waveform at the foot
 * of a page is a meter — it reports a level. A ball that the room visibly
 * pushes against is a thing that is listening to you. The difference is the
 * whole interaction, and it is the reason this is not a Siri clone.
 *
 * ── Why canvas ───────────────────────────────────────────────────────────
 *
 * Twelve expanding rings with per-ring deformation is twelve DOM nodes being
 * laid out sixty times a second. On the phones this is FOR, that is the
 * difference between an orb that breathes and one that stutters. Canvas draws
 * the same twelve rings in one composited layer with no layout at all.
 *
 * The Life OS mark itself is NOT drawn here. It stays a DOM element on top,
 * so it is crisp at any pixel ratio and never re-rasterised — the canvas
 * draws the body and everything the voice does to it, and nothing else.
 *
 * ── The amplitude is only ever a picture ─────────────────────────────────
 *
 * Microphone samples drive the animation and are never recorded, uploaded,
 * buffered or sent anywhere. The analyser reads the live stream and the
 * numbers it produces reach exactly one place: the shape of a ring. When
 * listening stops, every track is stopped and the context is closed.
 */

import { currentConfig, shapeAt } from './orb-lab.js';

const TAU = Math.PI * 2;

/** `#RRGGBB` at an alpha, for colours that arrive from a config. */
const hexA = (hex, a) => {
  const n = parseInt(String(hex ?? '#B296FF').slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * The reduced-motion preference, read LIVE rather than once.
 *
 * Somebody who turns it on mid-session should not have to reload to be
 * listened to.
 */
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* A hex nudged toward white (positive) or black (negative). Enough to build a
   sphere's worth of stops from one brand colour, and nothing more.
   NOT called `shade`: `drawCore` already has a local `shade` for its inner
   shadow gradient, and a module-level one of the same name sat in that
   function's temporal dead zone — which threw inside the animation frame,
   where nothing was watching, and the orb simply stopped being drawn. */
const tint = (hex, amount) => {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(amount >= 0
    ? c + (255 - c) * amount
    : c * (1 + amount));
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `rgb(${clamp(r, 0, 255)},${clamp(g, 0, 255)},${clamp(b, 0, 255)})`;
};

const STEPS = 128;

/**
 * Deviation from the circle at this angle, in [-1, 1].
 *
 * Amplitudes breathe on their own slow clocks so no two frames are the same;
 * the shape stays even in θ throughout.
 */
const ribbon = (th, t) => {
  let v = 0;
  for (let i = 0; i < SWELLS.length; i += 1) {
    const b = SWELLS[i];
    v += Math.sin(t * b.rate) * b.w * Math.cos(th * b.k);
  }
  return v;
};

export class Orb {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} o  { variant }
   */
  constructor(canvas, o = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = 'idle';
    this.level = 0;          // smoothed 0..1, what the drawing actually uses
    this.raw = 0;            // the latest measurement
    this.t = 0;
    this.dpr = 1;
    this.running = false;
    this.lastFrame = 0;
    /* Per-orb phase offsets, so two orbs on the same screen — the one on
     * Today and the one on the assistant — do not breathe in lockstep like a
     * pair of loading spinners. Derived from a counter, never from
     * Math.random, so a screenshot of the same state is the same picture. */
    Orb.seq = (Orb.seq ?? 0) + 1;
    this.phase = (Orb.seq * 1.7) % TAU;

    this.resize = this.resize.bind(this);
    this.frame = this.frame.bind(this);
    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(canvas);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    /* Capped at 2. A three-times ratio on a modern phone triples the fill
     * cost for a difference nobody can see on a soft gradient. */
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.w = r.width;
    this.h = r.height;
    /* ── The orb's size is the CONTAINER's, not the canvas's ──────────
     *
     * The canvas is allowed to be bigger than the orb so that waves have
     * somewhere to go. Without this the two were the same box and a loud
     * ring hit the canvas edge and stopped dead — a square edge appearing
     * out of nowhere around a round thing, which is exactly what it looked
     * like.
     *
     * So the DRAWN radius follows the element the layout sized, and the
     * canvas's extra room is bleed for the rings to fade into. How much
     * bleed is a CSS decision and this reads it rather than assuming. */
    const box = this.canvas.parentElement?.getBoundingClientRect();
    this.unit = box?.width && box?.height
      ? Math.min(box.width, box.height)
      : Math.min(r.width, r.height);
  }

  /**
   * The brand purple, from the stylesheet.
   *
   * Read once and cached: `getComputedStyle` in a draw loop is a layout read
   * sixty times a second. `refreshAccent()` exists for the theme experiment,
   * which is the only thing that changes it at runtime.
   */
  accent() {
    if (this._accent) return this._accent;
    let v = '';
    try {
      v = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent-deep').trim();
    } catch { /* no document, or a stylesheet that has not arrived */ }
    this._accent = /^#[0-9a-f]{6}$/i.test(v) ? v : '#6A38E0';
    return this._accent;
  }

  refreshAccent() { this._accent = null; }

  /** The lab changed something. Pick it up on the next frame. */
  setConfig(cfg) { this.cfg = cfg; this.waveHist = null; }

  /** Kept as a no-op for callers that still pass a style name. */
  setVariant() {
    this.waveHist = null;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    /* A new listening session starts from stillness rather than from the
       tail of the last one. */
    if (s !== 'listening') { this.waveHist = null; this.energy = 0; }
  }

  /** 0..1. The only channel the microphone has into this class. */
  setLevel(v) { this.raw = clamp(v, 0, 1); }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  destroy() {
    this.stop();
    this.ro.disconnect();
  }

  frame(now) {
    if (!this.running) return;
    const dt = Math.min(64, now - this.lastFrame);   // a backgrounded tab
    this.lastFrame = now;
    this.t += dt;

    /* Attack fast, release slow. A level that falls as quickly as it rises
     * makes the orb flicker on every consonant; a slow release is what turns
     * a stream of samples into something that reads as a voice. */
    /* Attack fast, release slow. 0.35 up felt like a delay on a phone —
       roughly four frames before anything visible moved. */
    const k = this.raw > this.level ? 0.55 : 0.06;
    this.level += (this.raw - this.level) * k;

    /* ── The shape's own clock ──────────────────────────────────────
       Advanced by how much speech is arriving rather than by wall time, so
       the pattern follows the words instead of ticking through them. A
       trickle keeps it from freezing solid in a silence; the rest is voice.
       `drive` decides the mix, and at 0 this is the old metronome. */
    const cfg = this.cfg ?? {};
    const drive = cfg.drive ?? 0.75;
    const rate = (1 - drive) + drive * (0.12 + this.level * 2.4);
    this.wavePhase = (this.wavePhase ?? 0) + dt * rate;

    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  }

  /* ── Geometry ──────────────────────────────────────────────────────── */
  get core() {
    /* The resting radius. Everything else is expressed as a multiple of it.
       From `unit` — the visible orb box — so bleeding the canvas gives the
       waves more room without making the orb itself grow. */
    return (this.unit || Math.min(this.w, this.h)) * 0.215;
  }

  draw() {
    const { ctx } = this;
    if (!this.w) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    const cx = this.w / 2;
    const cy = this.h / 2;
    const R = this.core;
    const reduce = reducedMotion();
    const breathe = Math.sin(this.t / 1400 + this.phase) * 0.5 + 0.5;   // 0..1

    // A voice only moves the orb while it is being listened to.
    const live = this.state === 'listening' || this.state === 'paused';
    const amp = live ? this.level : 0;

    /* ── ONE listening renderer ───────────────────────────────────
       There used to be three, chosen by a stored `variant`, and that was the
       bug behind "none of the buttons change anything" and "it looks
       different on my phone": two of the three ignored the config entirely,
       and each device had quietly kept a different choice. The look is the
       CONFIG now — see `orb-lab.js` — so every device draws the same thing
       and every control reaches it. */
    if (this.state === 'processing') this.drawProcessing(cx, cy, R, reduce);
    else this.drawWaveform(cx, cy, R, amp, breathe, reduce);
  }

  /**
   * The body.
   *
   * ── What makes this read as an object rather than a coloured circle ──────
   *
   * Five passes, in the order light actually behaves. A single radial
   * gradient plus one flat bloom — which is what this was — gives a disc: a
   * flat shape with a bright spot painted on it. What is missing is the
   * evidence that light came from somewhere and that the surface is curved.
   *
   *   1  ambient bloom   wide, very faint, no edge you can find
   *   2  the sphere      four stops, the darkest at the rim, so the body
   *                      turns away from the light instead of stopping
   *   3  terminator      a shadow gathered on the lower-right, which is what
   *                      tells the eye the top-left is nearer
   *   4  rim light       a thin bright arc on the shadow side — bounced
   *                      light, and the single cheapest thing that makes a
   *                      sphere look solid
   *   5  specular        one small soft highlight, off-centre, not a stripe
   *
   * All of it is gradients and arcs. No shadowBlur anywhere: a canvas shadow
   * on a shape that moves every frame is the most expensive thing a phone
   * GPU can be asked for, and it is what the old bloom would have become.
   */
  drawCore(cx, cy, r) {
    const { ctx } = this;

    /* 1 — Ambient. Two stops rather than one, so the falloff is a curve
     * instead of a cone: the old version reached zero in a straight line and
     * that hard-edged cone is exactly what reads as a cheap glow. */
    const bloom = ctx.createRadialGradient(cx, cy, r * 0.82, cx, cy, r * 2.35);
    bloom.addColorStop(0, 'rgba(138,93,255,.26)');
    bloom.addColorStop(0.42, 'rgba(124,77,255,.10)');
    bloom.addColorStop(1, 'rgba(124,77,255,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, r * 2.35, 0, TAU);
    ctx.fillStyle = bloom;
    ctx.fill();

    // 2 — The sphere. Light from the upper left, dark at the far rim.
    const body = ctx.createRadialGradient(
      cx - r * 0.34, cy - r * 0.40, r * 0.06,
      cx - r * 0.05, cy - r * 0.05, r * 1.08,
    );
    /* The orb IS the brand mark, so its body follows the accent hierarchy
       rather than five hard-coded purples. `--accent-deep` is the weight, and
       the stops step around it — so switching the deeper token on moves the
       orb with the rest of the product instead of leaving it behind. */
    const deep = this.accent();
    body.addColorStop(0, tint(deep, 0.62));
    body.addColorStop(0.30, tint(deep, 0.30));
    body.addColorStop(0.62, tint(deep, 0.02));
    body.addColorStop(0.88, tint(deep, -0.28));
    body.addColorStop(1, tint(deep, -0.48));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = body;
    ctx.fill();

    /* 3 — The terminator, clipped to the sphere. Where a lit ball goes dark
     * is a soft band, not the edge — putting the shadow ON the edge is what
     * makes a gradient circle look like a sticker. */
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.clip();
    const shade = ctx.createRadialGradient(
      cx + r * 0.42, cy + r * 0.52, r * 0.1,
      cx + r * 0.30, cy + r * 0.38, r * 1.25,
    );
    shade.addColorStop(0, 'rgba(30,10,74,.42)');
    shade.addColorStop(0.55, 'rgba(30,10,74,.14)');
    shade.addColorStop(1, 'rgba(30,10,74,0)');
    ctx.fillStyle = shade;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();

    /* 4 — Rim light on the shadow side. Drawn as a stroke just inside the
     * silhouette so it never widens the ball. */
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.985, Math.PI * 0.12, Math.PI * 0.92);
    const rim = ctx.createLinearGradient(cx - r, cy + r * 0.3, cx + r, cy - r * 0.3);
    rim.addColorStop(0, 'rgba(214,186,255,0)');
    rim.addColorStop(0.45, 'rgba(226,204,255,.5)');
    rim.addColorStop(1, 'rgba(214,186,255,0)');
    ctx.strokeStyle = rim;
    ctx.lineWidth = Math.max(0.8, r * 0.035);
    ctx.stroke();
    ctx.restore();

    /* 5 — One specular highlight. An ellipse, tilted, well inside the edge:
     * a highlight touching the rim reads as a reflection of the screen
     * rather than of a light. */
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.clip();
    ctx.translate(cx - r * 0.33, cy - r * 0.40);
    ctx.rotate(-0.5);
    const spec = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.42);
    spec.addColorStop(0, 'rgba(255,255,255,.5)');
    spec.addColorStop(0.45, 'rgba(255,255,255,.16)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.42, r * 0.26, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /* ── A — Concentric pulse ──────────────────────────────────────────────
   * Pressure waves leave the orb. A ring is born at the surface when the
   * voice rises, carries the loudness it was born with, and thins as it
   * travels — so a shout throws a thick ring a long way and a murmur puts a
   * faint one just past the edge. That correspondence is the whole point:
   * the waves are the sound, not a decoration timed to it. */
  /* ── A — The configurable listening visual ─────────────────────────────
   *
   * Reads a CONFIG rather than hard-coding a look — see `orb-lab.js` for why,
   * and for the twenty presets. Two families, which may run together:
   *
   *   ribbon   contours around a perfectly circular orb
   *   body     the orb's own edge swells, and everything beyond its resting
   *            radius is painted in a second colour, so the overflow reads as
   *            energy leaving the ball rather than as the ball deforming
   */
  drawWaveform(cx, cy, R, amp, breathe, reduce) {
    const { ctx } = this;
    const cfg = this.cfg ?? (this.cfg = currentConfig());
    const idle = this.state === 'idle' || this.state === 'starting';

    if (reduce) {
      const a = clamp(amp, 0, 1);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.34, 0, TAU);
      ctx.strokeStyle = `rgba(160,116,255,${0.10 + a * 0.42})`;
      ctx.lineWidth = 1 + a * 4;
      ctx.stroke();
      this.drawCore(cx, cy, R);
      return;
    }

    /* Attack and release are separate, and both adjustable: how fast it
       answers is as much a part of the feel as how far it moves. */
    const target = clamp(amp, 0, 1);
    const prev = this.energy ?? 0;
    this.energy = prev + (target - prev)
      * (target > prev ? (cfg.attack ?? 0.38) : (cfg.release ?? 0.04));

    /* ── Level meter, or something that answers per word ────────────
       `this.energy` is the heavily smoothed reading — steady, and the same
       for "the" as for "extraordinary". `amp` is the faster one, which
       still carries the shape of individual words. `punch` mixes them: at
       0 the wave is a calm meter, at 1 every word throws it. */
    const punch = clamp(cfg.punch ?? 0.6, 0, 1);
    const lively = this.energy + (target - this.energy) * punch;
    /* ── Active, but not listening ──────────────────────────────
       At rest the wave does not disappear — it settles to `cfg.idle` and
       keeps turning. A completely still orb reads as one that has stopped
       paying attention, and the difference between "ready" and "asleep" is
       worth a few percent of amplitude. */
    const e = idle
      ? Math.max(cfg.idle ?? 0.16, Math.min(lively, 0.25))
      : Math.max(lively, (cfg.idle ?? 0.16) * 0.6);

    const strands = Math.max(0, Math.round(cfg.strands ?? 12));
    if (this.t - (this.waveAt ?? 0) > 34) {
      this.waveAt = this.t;
      this.waveHist = [e, ...(this.waveHist ?? [])].slice(0, Math.max(1, strands));
    }
    const hist = this.waveHist ?? [e];
    const wants = cfg.mode ?? 'ribbon';

    /* ── The body ────────────────────────────────────────────────
       Drawn FIRST and underneath, so the orb's own gradient covers the part
       of it that lies inside the resting circle. What is left showing is
       exactly the overflow — which is the effect: a coloured swell escaping
       a ball that is still a ball. */
    const push = (cfg.push ?? 0) * e;
    if ((wants === 'body' || wants === 'both') && push > 0.001) {
      ctx.beginPath();
      for (let i = 0; i <= STEPS; i += 1) {
        const th = (i / STEPS) * TAU;
        const d = R * (1 + push * (0.5 + 0.5 * shapeAt(th, this.t, cfg, this.wavePhase)));
        const x = cx + Math.cos(th) * d;
        const y = cy + Math.sin(th) * d;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const beyond = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * (1 + push * 1.2));
      beyond.addColorStop(0, `${cfg.beyond}00`);
      beyond.addColorStop(0.35, `${cfg.beyond}CC`);
      beyond.addColorStop(1, `${cfg.beyond}55`);
      ctx.fillStyle = beyond;
      ctx.fill();
      if (cfg.glow) {
        ctx.save();
        ctx.shadowBlur = 16 * cfg.glow * e;
        ctx.shadowColor = `${cfg.beyond}AA`;
        ctx.fill();
        ctx.restore();
      }
    }

    /* ── The ribbon ──────────────────────────────────────────────── */
    if (wants === 'ribbon' || wants === 'both') {
      const gap = R * (cfg.gap ?? 0.34);
      for (let k = strands - 1; k >= 0; k -= 1) {
        const ev = clamp(hist[Math.min(k, hist.length - 1)] ?? 0, 0, 1);
        const lead = k === 0;
        const bs = R + gap + R * (k * (cfg.spread ?? 0.026) + ev * 0.22);
        const swing = bs * ((cfg.quiet ?? 0.03) + ev * (cfg.amp ?? 0.10));
        const when = this.t - k * (cfg.lag ?? 70);

        const fade = 1 - k / (strands + 3);
        const alpha = lead ? 0.40 + ev * 0.44 : (0.09 + ev * 0.26) * fade;
        if (alpha < 0.008) continue;

        ctx.beginPath();
        for (let i = 0; i <= STEPS; i += 1) {
          const th = (i / STEPS) * TAU;
          /* The trailing contours lag in the SHAPE as well as in the
             rotation, so a word travels outward through the stack. */
          const d = bs + swing * shapeAt(th, when, cfg, (this.wavePhase ?? 0) - k * (cfg.lag ?? 70));
          const x = cx + Math.cos(th) * d;
          const y = cy + Math.sin(th) * d;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = lead
          ? hexA(cfg.line, alpha)
          : hexA(cfg.trail, alpha);
        ctx.lineWidth = Math.max(0.2,
          (lead ? 0.9 + ev * 0.9 : 0.6) * (cfg.weight ?? 1));
        ctx.stroke();

        if (lead && ev > 0.10 && cfg.glow) {
          ctx.save();
          ctx.shadowBlur = (9 + ev * 18) * cfg.glow;
          ctx.shadowColor = hexA(cfg.trail, 0.30 + ev * 0.38);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    /* The orb itself. Always a circle — only its size breathes. */
    this.drawCore(cx, cy, R * (1 + (idle ? breathe * 0.02 : e * 0.05)));
  }

  drawProcessing(cx, cy, R, reduce) {
    const { ctx } = this;
    /* One slow breath, shared by everything, so the whole thing moves as one
       object rather than as a set of independently animated parts. */
    const pulse = Math.sin(this.t / 1500) * 0.5 + 0.5;         // 0..1

    if (reduce) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.42, 0, TAU);
      ctx.strokeStyle = `rgba(186,150,255,${0.16 + pulse * 0.22})`;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      this.drawCore(cx, cy, R);
      return;
    }

    /* The glow, behind everything, swelling and settling. */
    const bloom = ctx.createRadialGradient(
      cx, cy, R * 0.9, cx, cy, R * (1.9 + pulse * 0.35),
    );
    bloom.addColorStop(0, `rgba(150,96,255,${0.16 + pulse * 0.10})`);
    bloom.addColorStop(1, 'rgba(150,96,255,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, R * 2.3, 0, TAU);
    ctx.fillStyle = bloom;
    ctx.fill();

    /* Three complete rings, each on its own clock so they drift in and out
       of step. Full circles, never arcs. */
    for (let i = 0; i < 3; i += 1) {
      const own = Math.sin(this.t / (1700 + i * 520) - i * 0.9) * 0.5 + 0.5;
      const rad = R * (1.26 + i * 0.17 + own * 0.05);
      const a = (0.05 + own * 0.16) * (1 - i * 0.22);
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, TAU);
      ctx.strokeStyle = `rgba(196,158,255,${a})`;
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }

    /* The orb itself breathes, gently. */
    this.drawCore(cx, cy, R * (1 + pulse * 0.022));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   THE MICROPHONE
   Amplitude only, live only, kept nowhere.
   ══════════════════════════════════════════════════════════════════════ */
export class MicLevel {
  constructor() {
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.time = null;
    this.freq = null;
    this.on = false;
  }

  /**
   * @returns {Promise<'ok'|'denied'|'unsupported'>}
   *
   * The three outcomes are distinct because the copy has to be. "Denied"
   * is something the person can undo in their browser; "unsupported" is not,
   * and telling them to check their settings would be a wild goose chase.
   */
  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
      return 'unsupported';
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          /* Off, all three. They are corrections for a call, and here they
           * would flatten exactly the dynamics the picture is made of — gain
           * control in particular turns a whisper and a shout into the same
           * number within about a second. */
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        },
      });
    } catch (e) {
      return e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'denied' : 'unsupported';
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.72;
    src.connect(this.analyser);
    /* Deliberately NOT connected to the destination. Routing a microphone to
     * the speakers is a feedback loop, and there is no reason for the sound
     * to leave the analyser at all. */
    this.time = new Uint8Array(this.analyser.fftSize);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.on = true;
    return 'ok';
  }

  /** Root-mean-square of the current window, curved so speech fills 0..1. */
  read() {
    if (!this.on) return 0;
    this.analyser.getByteTimeDomainData(this.time);
    let sum = 0;
    for (let i = 0; i < this.time.length; i += 1) {
      const v = (this.time[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.time.length);
    // Ordinary speech at arm's length is around 0.02–0.12 RMS, which is a
    // very small part of the range. The curve is what makes a normal voice
    // produce a visible orb instead of a twitch.
    return clamp((rms / 0.22) ** 0.72, 0, 1);
  }

  bins() {
    if (!this.on) return null;
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  }

  /** Everything released. Called on leaving the surface, not on pausing. */
  stop() {
    this.on = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
    this.analyser = null;
  }
}

/**
 * A voice, without a voice.
 *
 * When the microphone is unavailable — a browser without it, a permission
 * refused, or a laptop being used to review the interaction — the orb still
 * has to be judgeable, so this produces a speech-shaped envelope: syllables
 * at roughly four a second, riding a slower phrase contour, with real gaps
 * between sentences. It is obviously synthetic and it is labelled as such
 * wherever it runs.
 */
export function synthLevel(t) {
  const syll = Math.max(0, Math.sin(t / 130)) ** 0.7;
  const phrase = 0.55 + Math.sin(t / 1900) * 0.45;
  const gap = Math.sin(t / 4300) > 0.82 ? 0.05 : 1;
  return clamp(syll * phrase * gap * 0.85, 0, 1);
}
