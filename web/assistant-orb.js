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

/* ── The three variants ─────────────────────────────────────────────────
 * Only the LISTENING animation differs. Same orb, same states, same copy,
 * same everything else — three assistants would be three products, and the
 * point of the comparison is to choose a motion, not a personality. */
export const VARIANTS = [
  { id: 'a', label: 'Concentric pulse', hint: 'Pressure waves leave the orb on your voice' },
  { id: 'b', label: 'Fluid halo', hint: 'The orb’s own edge moves, with a soft halo behind it' },
  { id: 'c', label: 'Radial waveform', hint: 'A ring of frequency around a still orb' },
];
export const DEFAULT_VARIANT = 'a';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Reads the reduced-motion preference live rather than once.
 *
 * Someone turning it on in the middle of a listening session should not have
 * to reload the application to be taken seriously.
 */
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Orb {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} o  { variant }
   */
  constructor(canvas, o = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.variant = o.variant ?? DEFAULT_VARIANT;
    this.state = 'idle';
    this.level = 0;          // smoothed 0..1, what the drawing actually uses
    this.raw = 0;            // the latest measurement
    this.bins = null;        // frequency data for variant C
    this.rings = [];
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

  setVariant(v) {
    this.variant = v;
    this.rings = [];
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    if (s !== 'listening') this.rings = [];
  }

  /** 0..1. The only channel the microphone has into this class. */
  setLevel(v) { this.raw = clamp(v, 0, 1); }

  setBins(b) { this.bins = b; }

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
    const k = this.raw > this.level ? 0.35 : 0.08;
    this.level += (this.raw - this.level) * k;

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

    if (this.state === 'processing') this.drawProcessing(cx, cy, R, reduce);
    else if (this.variant === 'b') this.drawHalo(cx, cy, R, amp, breathe, reduce);
    else if (this.variant === 'c') this.drawRadial(cx, cy, R, amp, breathe, reduce);
    else this.drawConcentric(cx, cy, R, amp, breathe, reduce);
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
    body.addColorStop(0, '#CBA8FF');
    body.addColorStop(0.30, '#A177FF');
    body.addColorStop(0.62, '#8552F4');
    body.addColorStop(0.88, '#5E31CE');
    body.addColorStop(1, '#46209E');
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
  drawConcentric(cx, cy, R, amp, breathe, reduce) {
    const { ctx } = this;
    const idle = this.state === 'idle' || this.state === 'starting';
    const r = R * (1 + (idle ? breathe * 0.02 : amp * 0.18));

    if (reduce) {
      /* Reduced motion still has to say "listening" (§49). It says it with
       * thickness and opacity on rings that do not travel, rather than with
       * things flying across the screen. */
      [1.35, 1.75, 2.15].forEach((m, i) => {
        const a = clamp(amp * (1 - i * 0.22), 0, 1);
        ctx.beginPath();
        ctx.arc(cx, cy, R * m, 0, TAU);
        ctx.strokeStyle = `rgba(174,134,255,${0.10 + a * 0.5})`;
        ctx.lineWidth = 1 + a * 5;
        ctx.stroke();
      });
      this.drawCore(cx, cy, r);
      return;
    }

    /* Emit. A loud voice emits more often AND more strongly, and near-silence
     * emits rarely and faintly — it does not stop, because a listening orb
     * that goes completely still reads as one that has stopped listening
     * (§9). The two cadences are far enough apart that the difference
     * between speaking and not speaking is obvious across the room. */
    const speaking = amp > 0.06;
    const gap = speaking ? 210 - amp * 150 : 620;
    if (!this.lastEmit || this.t - this.lastEmit > gap) {
      const strength = this.state === 'listening'
        ? (speaking ? amp : 0.05 + breathe * 0.02)
        : breathe * 0.04;
      if (strength > 0.03) {
        this.lastEmit = this.t;
        this.rings.push({ r: R, born: this.t, strength, wob: (this.rings.length % 5) * 1.3 });
      }
    }

    /* The canvas half-width, less the most a ring's wobble can add. A ring
       whose crest crosses the edge is clipped, and one clipped edge is all
       it takes to see the box. */
    const reach = (Math.min(this.w, this.h) / 2) * 0.94;
    this.rings = this.rings.filter((ring) => {
      const age = (this.t - ring.born) / 1;
      /* Travel scales hard with the loudness the ring was born with: a shout
       * throws a ring across the whole field in about a second, a murmur
       * puts one just past the edge of the orb. That correspondence is the
       * point — the waves ARE the sound, not a decoration timed to it. */
      const travel = age * (0.022 + ring.strength * 0.095);
      const rad = R + travel;
      if (rad > reach * 1.02) return false;
      const life = 1 - (rad - R) / (reach - R);
      const alpha = clamp(life * life * (0.16 + ring.strength * 0.72), 0, 1);
      if (alpha < 0.005) return false;

      /* Organic, not geometric. Each ring is a closed path whose radius
       * breathes around the circle, so waves read as pressure moving through
       * air rather than as concentric hoops from a physics diagram. */
      ctx.beginPath();
      const wobble = (0.012 + ring.strength * 0.03) * rad;
      for (let i = 0; i <= 48; i += 1) {
        const a = (i / 48) * TAU;
        const d = rad + Math.sin(a * 3 + ring.wob + this.t / 900) * wobble
          + Math.sin(a * 5 - ring.wob * 2 + this.t / 1400) * wobble * 0.5;
        const x = cx + Math.cos(a) * d;
        const y = cy + Math.sin(a) * d;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `rgba(186,150,255,${alpha})`;
      ctx.lineWidth = Math.max(0.5, (0.9 + ring.strength * 6) * life);
      ctx.stroke();
      return true;
    });

    this.drawCore(cx, cy, r);
  }

  /* ── B — Fluid halo ────────────────────────────────────────────────────
   * The orb's own surface moves. Quieter, more modern, and it keeps every
   * pixel of the animation attached to the object — nothing leaves, so
   * nothing competes with the transcript above it. */
  drawHalo(cx, cy, R, amp, breathe, reduce) {
    const { ctx } = this;
    const deform = reduce ? 0 : (0.05 + amp * 0.20);
    const r = R * (1 + amp * 0.06 + breathe * 0.012);

    // Halo pulses, behind the body.
    if (!reduce) {
      const pulses = 3;
      for (let i = 0; i < pulses; i += 1) {
        const p = ((this.t / 2600) + i / pulses + this.phase / TAU) % 1;
        const rad = r * (1.05 + p * 1.05);
        const a = (1 - p) * (0.05 + amp * 0.3);
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, TAU);
        ctx.fillStyle = `rgba(138,93,255,${a * 0.22})`;
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.5, 0, TAU);
      ctx.fillStyle = `rgba(138,93,255,${0.06 + amp * 0.24})`;
      ctx.fill();
    }

    // The body, as a closed deforming path rather than an arc.
    ctx.beginPath();
    for (let i = 0; i <= 64; i += 1) {
      const a = (i / 64) * TAU;
      const n = Math.sin(a * 2 + this.t / 1100 + this.phase)
        + Math.sin(a * 3 - this.t / 1700) * 0.6
        + Math.sin(a * 5 + this.t / 800) * 0.32;
      const d = r * (1 + n * deform * 0.32);
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.42, r * 0.1, cx, cy, r * 1.2);
    g.addColorStop(0, '#C8A0FF');
    g.addColorStop(0.55, '#8A5DFF');
    g.addColorStop(1, '#5B2FD6');
    ctx.fillStyle = g;
    ctx.fill();
    // The reactive rim, so the edge reads as a surface under pressure.
    ctx.strokeStyle = `rgba(214,186,255,${0.18 + amp * 0.5})`;
    ctx.lineWidth = 1 + amp * 2.5;
    ctx.stroke();
  }

  /* ── C — Radial waveform ───────────────────────────────────────────────
   * The orb holds still and the sound is drawn around it as a ring of
   * frequency. The most precise of the three and the most technical: you can
   * see the shape of a vowel. Whether that is the right register for Life OS
   * is exactly the thing to look at. */
  drawRadial(cx, cy, R, amp, breathe, reduce) {
    const { ctx } = this;
    const base = R * 1.42;
    const n = 96;
    const bins = this.bins;

    ctx.beginPath();
    for (let i = 0; i <= n; i += 1) {
      const a = (i / n) * TAU - Math.PI / 2;
      let v;
      if (bins && bins.length) {
        /* Mirrored around the vertical axis, so the ring is symmetric and
         * reads as one object rather than as a strip chart bent into a
         * circle. */
        const half = Math.min(bins.length - 1, Math.floor(bins.length * 0.62));
        const k = Math.round(Math.abs(((i / n) * 2) - 1) * half);
        v = bins[k] / 255;
      } else {
        v = amp * (0.6 + Math.sin(i * 0.7 + this.t / 260) * 0.4);
      }
      const d = base + (reduce ? 0 : v * R * 0.62);
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = `rgba(186,150,255,${0.22 + amp * 0.62})`;
    ctx.lineWidth = reduce ? 1 + amp * 5 : 1.6;
    ctx.stroke();

    // A second, fainter ring at rest, so the shape is legible in silence.
    ctx.beginPath();
    ctx.arc(cx, cy, base, 0, TAU);
    ctx.strokeStyle = 'rgba(138,93,255,.16)';
    ctx.lineWidth = 1;
    ctx.stroke();

    this.drawCore(cx, cy, R * (1 + breathe * 0.014));
  }

  /* ── Processing ────────────────────────────────────────────────────────
   * Sound-reactive motion STOPS. Anything still responding to the room
   * during "making sense of that" is telling the person it is still
   * listening while it is not. A single slow sweep says working. */
  drawProcessing(cx, cy, R, reduce) {
    const { ctx } = this;
    this.drawCore(cx, cy, R);
    const rad = R * 1.45;
    if (reduce) {
      const a = 0.16 + (Math.sin(this.t / 900) * 0.5 + 0.5) * 0.34;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, TAU);
      ctx.strokeStyle = `rgba(186,150,255,${a})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      return;
    }
    const start = (this.t / 900) % TAU;
    const g = ctx.createLinearGradient(cx - rad, cy, cx + rad, cy);
    g.addColorStop(0, 'rgba(186,150,255,0)');
    g.addColorStop(1, 'rgba(186,150,255,.75)');
    ctx.beginPath();
    ctx.arc(cx, cy, rad, start, start + Math.PI * 0.85);
    ctx.strokeStyle = g;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
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
