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
  { id: 'a', label: 'Audio waveform', hint: 'A balanced waveform around the orb, answering to your voice' },
  { id: 'b', label: 'Fluid halo', hint: 'The orb’s own edge moves, with a soft halo behind it' },
  { id: 'c', label: 'Radial waveform', hint: 'A ring of frequency around a still orb' },
];
export const DEFAULT_VARIANT = 'a';

const TAU = Math.PI * 2;

/* ── The ribbon's shape ────────────────────────────────────────────────
 *
 * Six harmonics whose counts share no common factor, so the curve does not
 * repeat around the circle — which is what stops it reading as a polygon.
 * Each drifts at its own rate, so peaks travel and merge instead of holding
 * station.
 *
 * BALANCE comes from the maths rather than from symmetry: every term is a
 * sine over a whole number of periods, so it integrates to zero around the
 * circle and the mean radius is exactly the base. The average is a circle,
 * however the peaks fall.
 *
 * Weights fall away with frequency, which keeps the hills broad. The whole
 * thing sums to about 1, so `swing` means what it says.
 */
const BANDS = [
  /* The lowest band is deliberately NOT the loudest. Letting k=3 dominate
     gave three big swells, and three swells around a circle is a shape with
     a heavy side — exactly the lopsidedness this is meant to avoid. Weight
     sits in the middle of the range, so there are six or seven gentle peaks
     and no single direction the ribbon leans in. */
  { k: 3, drift: 0.9, w: 0.20 },
  { k: 5, drift: -1.3, w: 0.26 },
  { k: 7, drift: 1.7, w: 0.24 },
  { k: 11, drift: -2.2, w: 0.16 },
  { k: 13, drift: 2.6, w: 0.10 },
  { k: 17, drift: -3.1, w: 0.06 },
];

/** How many contours make the ribbon. The reference is many thin ones. */
const STRANDS = 13;
const STEPS = 116;

const ribbon = (th, phase) => {
  let v = 0;
  for (let i = 0; i < BANDS.length; i += 1) {
    const b = BANDS[i];
    v += Math.sin(th * b.k + phase * b.drift) * b.w;
  }
  return v;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

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

  setVariant(v) {
    this.variant = v;
    this.waveHist = null;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    /* A new listening session starts from stillness rather than from the
       tail of the last one. */
    if (s !== 'listening') { this.waveHist = null; this.waveAmp = 0; }
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
  /* ── A — Audio ribbon ──────────────────────────────────────────────────
   *
   * A live audio signal wrapped into a circle: one bright contour with a
   * dozen thin strands close behind it, flowing round the orb.
   *
   * ── Why the symmetry was removed ─────────────────────────────────────
   *
   * The previous version made every harmonic a multiple of nine, which gave
   * exact nine-fold rotational symmetry. That was a real fix for a real
   * problem — before it, two lobes pushed one side out and dented the other —
   * but it overshot: a shape that repeats exactly nine times reads as a
   * geometric star, not as a voice.
   *
   * The harmonics here are 3, 5, 7, 11, 13 and 17. They share no common
   * factor, so the curve does not repeat around the circle and has no fixed
   * points. It is still BALANCED, and for a better reason than symmetry:
   * every term is a sine over a whole number of periods, so each integrates
   * to zero around the circle and the mean radius is exactly the base. No
   * side can collapse, because the average is a circle.
   *
   * Low frequencies carry most of the weight, which is what makes the hills
   * broad and smooth rather than serrated.
   */
  drawWaveform(cx, cy, R, amp, breathe, reduce) {
    const { ctx } = this;
    const idle = this.state === 'idle' || this.state === 'starting';
    const r = R * (1 + (idle ? breathe * 0.02 : amp * 0.06));

    if (reduce) {
      /* Reduced motion still has to say "listening" (§49). A still halo that
       * answers to the voice in weight and opacity, and travels nowhere. */
      [1.30, 1.58].forEach((m, i) => {
        const a = clamp(amp * (1 - i * 0.35), 0, 1);
        ctx.beginPath();
        ctx.arc(cx, cy, R * m, 0, TAU);
        ctx.strokeStyle = `rgba(160,116,255,${0.10 + a * 0.42})`;
        ctx.lineWidth = 1 + a * 4;
        ctx.stroke();
      });
      this.drawCore(cx, cy, r);
      return;
    }

    /* ── Heavily smoothed ──────────────────────────────────────────
       The raw signal jumps between results. Easing toward it means the
       ribbon breathes rather than snapping, which is the difference
       between "flowing" and "twitching". Rising is quicker than falling,
       so a loud syllable is felt and the settle afterwards is gentle. */
    const target = clamp(amp, 0, 1);
    const prev = this.waveAmp ?? 0;
    this.waveAmp = prev + (target - prev) * (target > prev ? 0.16 : 0.055);
    const a = this.waveAmp;

    /* A short history, so the trailing strands are genuinely where the
       ribbon has been rather than copies of where it is. */
    if (this.t - (this.waveAt ?? 0) > 34) {
      this.waveAt = this.t;
      this.waveHist = [a, ...(this.waveHist ?? [])].slice(0, STRANDS);
    }
    const hist = this.waveHist ?? [a];

    /* The gap the reference has between the orb and the ribbon. The inner
       strand never crosses it, whatever the voice does. */
    const gap = R * 0.34;
    /* The ribbon must never reach the orb. A trough deep enough to cross it
       reads as the orb being eaten rather than surrounded, and the reference
       keeps a clear ring of dark between the two. */
    const floor = R * 1.16;

    for (let k = STRANDS - 1; k >= 0; k -= 1) {
      const av = clamp(hist[Math.min(k, hist.length - 1)] ?? 0, 0, 1);
      const lead = k === 0;
      /* Close together, which is what makes them read as one ribbon rather
         than as separate rings. */
      /* Tightly spaced, so thirteen contours read as one ribbon rather than
         as thirteen rings. The whole stack moves outward with the voice. */
      const base = R + gap + R * (k * 0.020 + av * 0.26);
      const swing = R * (0.04 + av * 0.30);
      const phase = this.t / 2600 - k * 0.075;

      const fade = 1 - k / (STRANDS + 3);
      const alpha = lead
        ? 0.42 + av * 0.52
        : (0.10 + av * 0.34) * fade;
      if (alpha < 0.008) continue;

      ctx.beginPath();
      for (let i = 0; i <= STEPS; i += 1) {
        const th = (i / STEPS) * TAU;
        const d = Math.max(floor, base + swing * ribbon(th, phase));
        const x = cx + Math.cos(th) * d;
        const y = cy + Math.sin(th) * d;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = lead
        ? `rgba(214,186,255,${alpha})`
        : `rgba(168,126,255,${alpha})`;
      /* Thin. The reference is many fine strands, not a drawn outline. */
      ctx.lineWidth = lead ? 1.2 + av * 1.6 : 0.75;
      ctx.stroke();

      /* Glow on the leading contour only — one shadowed stroke a frame is
         affordable on a phone; thirteen are not. */
      if (lead && av > 0.10) {
        ctx.save();
        ctx.shadowBlur = 10 + av * 20;
        ctx.shadowColor = `rgba(150,96,255,${0.34 + av * 0.40})`;
        ctx.stroke();
        ctx.restore();
      }
    }

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
