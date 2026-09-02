/**
 * The listening visual, as parameters rather than as code.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * Four rounds of "closer, but not it" is a signal that the loop is wrong, not
 * that the taste is unclear. Describing a motion in words and having somebody
 * else implement it is a slow, lossy way to design something that is, in the
 * end, looked at. This is the main thing people will interact with, so it is
 * worth being able to try twenty of them in a minute rather than one a day.
 *
 * So the renderer takes a CONFIG, twenty presets are supplied, and every
 * number is adjustable live. Nothing here is a user setting — it is a design
 * instrument that lives behind the development flag and leaves when a look is
 * chosen. What survives is the winning config, pasted into `PRESETS` as the
 * default.
 *
 * ── The two families ─────────────────────────────────────────────────────
 *
 * `ribbon`  contours AROUND the orb; the orb itself stays a perfect circle.
 * `body`    the orb's own edge deforms, and everything beyond its resting
 *           radius is painted in a second colour — so a swell reads as energy
 *           leaving the ball rather than as the ball changing shape.
 *
 * Both can run at once (`both`), which is the closest thing to the fluid
 * halo with a coloured overflow.
 */

/* ── Symmetry ────────────────────────────────────────────────────────────
 *
 * `even: true` builds the shape from COSINES only. Cosine is even, so
 * cos(k(2π−θ)) = cos(kθ) and the curve is identical on both sides of the
 * axis — a swell on one side always has its twin. It cannot be lopsided.
 *
 * `even: false` allows a drifting phase, which travels around the orb and is
 * livelier at the cost of that guarantee. Both are offered because the choice
 * is a taste question, not a correctness one.
 */
export const shapeAt = (th, t, cfg) => {
  let v = 0;
  const speed = cfg.speed ?? 1;
  for (let i = 0; i < cfg.k.length; i += 1) {
    const k = cfg.k[i];
    const w = cfg.w[i] ?? 0;
    const drift = (cfg.drift?.[i] ?? (i + 1)) * speed;
    v += cfg.even === false
      ? Math.sin(th * k + t * drift * 0.0006) * w
      : Math.sin(t * drift * 0.00042) * w * Math.cos(th * k);
  }
  return v;
};

/** Everything the renderer reads. Every one of these is on a slider. */
export const PARAMS = [
  { key: 'amp', label: 'Wave size (loud)', min: 0, max: 0.6, step: 0.01 },
  { key: 'quiet', label: 'Wave size (quiet)', min: 0, max: 0.2, step: 0.005 },
  { key: 'gap', label: 'Distance from orb', min: 0, max: 1, step: 0.02 },
  { key: 'strands', label: 'Contours', min: 1, max: 24, step: 1 },
  { key: 'spread', label: 'Contour spacing', min: 0, max: 0.12, step: 0.002 },
  { key: 'lag', label: 'Trail delay (ms)', min: 0, max: 260, step: 10 },
  { key: 'attack', label: 'Reaction speed', min: 0.05, max: 1, step: 0.01 },
  { key: 'release', label: 'Settle speed', min: 0.01, max: 0.5, step: 0.01 },
  { key: 'speed', label: 'Flow speed', min: 0, max: 4, step: 0.05 },
  { key: 'glow', label: 'Glow', min: 0, max: 3, step: 0.05 },
  { key: 'weight', label: 'Line weight', min: 0.2, max: 5, step: 0.1 },
  { key: 'push', label: 'Body swell', min: 0, max: 0.5, step: 0.01 },
];

const base = {
  mode: 'ribbon',
  k: [2, 3, 4],
  w: [0.50, 0.32, 0.18],
  even: true,
  amp: 0.10,
  quiet: 0.03,
  gap: 0.34,
  strands: 12,
  spread: 0.026,
  lag: 70,
  attack: 0.38,
  release: 0.04,
  speed: 1,
  glow: 1,
  weight: 1,
  push: 0.12,
  /* Everything beyond the orb's resting edge, in `body` mode. A deep
     blue-purple so a swell reads as a different substance leaving the ball
     rather than as the ball itself changing colour. */
  beyond: '#3A1E8F',
  line: '#D6BAFF',
  trail: '#A87EFF',
};

const P = (name, over) => ({ ...base, name, ...over });

/**
 * Twenty, deliberately far apart.
 *
 * Small variations are useless for choosing — the point is to cover the space
 * so the answer becomes obvious, then narrow with the sliders.
 */
export const PRESETS = [
  P('1 · Calm ribbon', {}),
  P('2 · Breathing body', { mode: 'body', amp: 0.16, push: 0.18, strands: 0 }),
  P('3 · Body + halo', { mode: 'both', amp: 0.13, push: 0.15, strands: 6, gap: 0.22 }),
  P('4 · Tight threads', { strands: 20, spread: 0.010, lag: 30, weight: 0.5 }),
  P('5 · Wide echoes', { strands: 7, spread: 0.075, lag: 150, amp: 0.12 }),
  P('6 · Two lobes', { k: [2], w: [1], amp: 0.16 }),
  P('7 · Six lobes', { k: [6], w: [1], amp: 0.09 }),
  P('8 · Deep swell', { k: [2, 3], w: [0.7, 0.3], amp: 0.24, quiet: 0.02, speed: 0.5 }),
  P('9 · Fast flutter', { speed: 3, amp: 0.08, attack: 0.8, release: 0.2 }),
  P('10 · Slow drift', { speed: 0.25, amp: 0.14, attack: 0.15, release: 0.02 }),
  P('11 · Travelling wave', { even: false, k: [3, 5, 7], w: [0.5, 0.3, 0.2], speed: 1.4 }),
  P('12 · Spectral', { even: false, k: [3, 5, 7, 11, 13], w: [0.4, 0.26, 0.18, 0.1, 0.06] }),
  P('13 · Hairline', { strands: 24, spread: 0.008, weight: 0.3, glow: 0.4, amp: 0.09 }),
  P('14 · Heavy glow', { strands: 5, weight: 2.4, glow: 2.6, amp: 0.11 }),
  P('15 · Close hug', { gap: 0.10, strands: 14, spread: 0.014, amp: 0.08 }),
  P('16 · Far orbit', { gap: 0.85, strands: 9, spread: 0.03, amp: 0.10 }),
  P('17 · Molten body', { mode: 'body', k: [2, 3], w: [0.6, 0.4], amp: 0.22, push: 0.24,
    speed: 0.6, strands: 0 }),
  P('18 · Aurora', { mode: 'both', strands: 16, spread: 0.018, gap: 0.16, glow: 1.8,
    amp: 0.12, push: 0.10 }),
  P('19 · Pulse rings', { k: [0], w: [0], amp: 0, quiet: 0, strands: 10, spread: 0.05,
    lag: 120, glow: 1.4 }),
  P('20 · Whisper', { amp: 0.05, quiet: 0.012, strands: 10, spread: 0.02, glow: 0.5,
    weight: 0.6, speed: 0.6 }),
];

export const DEFAULT_PRESET = PRESETS[0];

const STORE = 'los2_orb_cfg';

/** The config in force: a stored experiment, or the chosen default. */
export function currentConfig() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return { ...DEFAULT_PRESET, ...JSON.parse(raw) };
  } catch { /* private mode, or something half-written */ }
  return { ...DEFAULT_PRESET };
}

export function saveConfig(cfg) {
  try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch { /* no store */ }
}

export function clearConfig() {
  try { localStorage.removeItem(STORE); } catch { /* no store */ }
}
