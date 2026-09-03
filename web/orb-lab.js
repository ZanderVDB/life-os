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

/* ── Symmetry, properly ──────────────────────────────────────────────────
 *
 * Two independent kinds, and the first version only had the weaker one.
 *
 * MIRROR (`mirror`) reflects across one axis: what happens on the right also
 * happens on the left. Built from cosines only, because cosine is even —
 * cos(k(2π−θ)) = cos(kθ). A drifting phase would add a sine term, which is
 * odd, so with mirror on the phases hold still and the amplitudes breathe
 * instead.
 *
 * ROTATIONAL (`fold`) is the one that was missing. `fold: 4` means the shape
 * repeats every quarter turn — a swell in one corner appears in all four.
 * The rule is exact and simple: EVERY harmonic must be a multiple of the
 * fold. So the harmonics are fold×1, fold×2, fold×3, and nothing else can
 * creep in.
 *
 *   fold 1  free-form
 *   fold 2  right ↔ left AND top ↔ bottom
 *   fold 3  three-way
 *   fold 4  all four corners
 *   fold 6, 8  progressively more petal-like
 *
 * Both together give the full dihedral symmetry — the most ordered, most
 * "system rather than random motion" end of the range.
 *
 * ── Round versus sharp ───────────────────────────────────────────────────
 *
 * Sharpness is not a separate shape, it is how much the HIGHER harmonics
 * contribute. At `sharp: 0` only the fundamental survives and the lobes are
 * broad and round; as it rises the second and third come in and the peaks
 * tighten. The weights are normalised so turning it up changes the character
 * without changing the size.
 */
/**
 * How far the whole pattern has turned by time `t`.
 *
 * Rotating a symmetric shape leaves it symmetric — the fold is unchanged and
 * the mirror axis simply travels with it — so this costs none of the
 * guarantees and turns "sections pushing out" into "a wave going round".
 */
export const turnAt = (t, cfg) => t * (cfg.spin ?? 0.3) * 0.00045;

export const shapeAt = (rawTh, t, cfg) => {
  const th = rawTh - turnAt(t, cfg);
  const fold = Math.max(1, Math.round(cfg.fold ?? 1));
  const sharp = Math.max(0, Math.min(1, cfg.sharp ?? 0.35));
  const speed = cfg.speed ?? 1;
  const mirror = cfg.mirror !== false;

  /* Fundamental, plus two overtones whose weight is the sharpness. */
  const w = [1, 0.55 * sharp, 0.30 * sharp];
  const total = w[0] + w[1] + w[2];
  const rates = [0.9, -1.3, 1.7];

  let v = 0;
  for (let i = 0; i < 3; i += 1) {
    if (w[i] < 0.001) continue;
    const k = fold * (i + 1);
    const drift = rates[i] * speed;
    v += mirror
      /* Even in θ: the mirror holds at every instant, and the motion is in
         the amplitude rather than in a travelling phase. */
      ? Math.sin(t * drift * 0.00042) * (w[i] / total) * Math.cos(th * k)
      : Math.sin(th * k + t * drift * 0.0006) * (w[i] / total);
  }
  return v;
};

/** Everything the renderer reads. Every one of these is on a slider. */
export const PARAMS = [
  { key: 'fold', label: 'Symmetry (1 = free)', min: 1, max: 8, step: 1 },
  { key: 'sharp', label: 'Round ↔ sharp', min: 0, max: 1, step: 0.02 },
  { key: 'amp', label: 'Wave size (loud)', min: 0, max: 0.8, step: 0.01 },
  { key: 'quiet', label: 'Wave size (quiet)', min: 0, max: 0.3, step: 0.005 },
  { key: 'gap', label: 'Distance from orb', min: 0, max: 2, step: 0.02 },
  { key: 'strands', label: 'Contours', min: 1, max: 30, step: 1 },
  { key: 'spread', label: 'Contour spacing', min: 0, max: 0.30, step: 0.005 },
  { key: 'lag', label: 'Trail delay (ms)', min: 0, max: 400, step: 10 },
  { key: 'attack', label: 'Reaction speed', min: 0.05, max: 1, step: 0.01 },
  { key: 'release', label: 'Settle speed', min: 0.01, max: 0.5, step: 0.01 },
  { key: 'speed', label: 'Flow speed', min: 0, max: 4, step: 0.05 },
  { key: 'spin', label: 'Rotation speed', min: -3, max: 3, step: 0.05 },
  { key: 'idle', label: 'Idle wave (not listening)', min: 0, max: 0.4, step: 0.01 },
  { key: 'glow', label: 'Glow', min: 0, max: 3, step: 0.05 },
  { key: 'weight', label: 'Line weight', min: 0.2, max: 5, step: 0.1 },
  { key: 'push', label: 'Ball movement', min: 0, max: 0.30, step: 0.005 },
];

const base = {
  mode: 'ribbon',
  /* Symmetry. `fold` is the rotational order, `mirror` the reflection. */
  fold: 2,
  mirror: true,
  /* 0 = broad round lobes, 1 = tight peaks. */
  sharp: 0.35,
  amp: 0.14,
  quiet: 0.03,
  gap: 0.70,
  strands: 16,
  spread: 0.055,
  lag: 90,
  attack: 0.38,
  release: 0.04,
  speed: 1,
  /* The wave travels round the orb. Negative turns the other way. */
  spin: 0.6,
  /* How much wave there is when nobody is speaking. Not zero: an orb that
     goes completely still reads as one that has stopped paying attention,
     and this is the difference between "ready" and "asleep". */
  idle: 0.16,
  glow: 1,
  weight: 1,
  /* Minimal by default: the ball is a ball, and the energy is what leaves
     it. Raise this for the fluid-halo family. */
  push: 0.03,
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
 * so the answer becomes obvious, then narrow with the sliders. The first is
 * the stated direction: the wave well away from the middle, many contours
 * widely spaced so it reads as emanating, and the ball barely moving.
 */
export const PRESETS = [
  /* ── The five real candidates, from testing ────────────────────────
     The first is the config that came back from the phone; the next four
     are outside suggestions. All five keep the rotation and idle defaults
     unless they say otherwise, so they can be compared on shape alone. */
  P('1 · Yours — Heavy glow', {
    fold: 5, mirror: true, sharp: 0, amp: 0.10, quiet: 0, gap: 0.04,
    strands: 18, spread: 0.075, lag: 240, attack: 0.05, release: 0.20,
    speed: 1.7, glow: 2.8, weight: 2.7, push: 0,
  }),
  P('2 · Balanced halo', {
    fold: 2, mirror: true, sharp: 0.05, amp: 0.28, quiet: 0.03, gap: 0.08,
    strands: 12, spread: 0.055, lag: 180, attack: 0.55, release: 0.38,
    speed: 0.65, glow: 1.8, weight: 2.1, push: 0.03,
  }),
  P('3 · Premium energy', {
    fold: 4, mirror: true, sharp: 0.08, amp: 0.36, quiet: 0.04, gap: 0.11,
    strands: 16, spread: 0.045, lag: 210, attack: 0.65, release: 0.42,
    speed: 0.85, glow: 2.35, weight: 1.8, push: 0.04,
  }),
  P('4 · Soft liquid', {
    fold: 2, mirror: true, sharp: 0, amp: 0.20, quiet: 0.025, gap: 0.06,
    strands: 9, spread: 0.06, lag: 140, attack: 0.38, release: 0.30,
    speed: 0.42, glow: 1.45, weight: 1.7, push: 0.06,
  }),
  P('5 · Voice reactive', {
    fold: 4, mirror: true, sharp: 0.10, amp: 0.46, quiet: 0.045, gap: 0.09,
    strands: 13, spread: 0.05, lag: 150, attack: 0.85, release: 0.50,
    speed: 1.0, glow: 2.0, weight: 2.0, push: 0.08,
  }),

  /* ── The same five, with the rotation dialled differently ──────────
     Rotation is the new variable and the one hardest to picture from a
     number, so each candidate gets a slow and a fast reading. */
  P('6 · Yours, slow spin', {
    fold: 5, sharp: 0, amp: 0.10, quiet: 0, gap: 0.04, strands: 18,
    spread: 0.075, lag: 240, attack: 0.05, release: 0.20, speed: 1.7,
    glow: 2.8, weight: 2.7, push: 0, spin: 0.22, idle: 0.20,
  }),
  P('7 · Yours, fast spin', {
    fold: 5, sharp: 0, amp: 0.10, quiet: 0, gap: 0.04, strands: 18,
    spread: 0.075, lag: 240, attack: 0.05, release: 0.20, speed: 1.7,
    glow: 2.8, weight: 2.7, push: 0, spin: 1.6, idle: 0.14,
  }),
  P('8 · Yours, counter-spin', {
    fold: 5, sharp: 0, amp: 0.10, quiet: 0, gap: 0.04, strands: 18,
    spread: 0.075, lag: 240, attack: 0.05, release: 0.20, speed: 1.7,
    glow: 2.8, weight: 2.7, push: 0, spin: -0.9, idle: 0.18,
  }),
  P('9 · Balanced, spinning', {
    fold: 2, sharp: 0.05, amp: 0.28, quiet: 0.03, gap: 0.08, strands: 12,
    spread: 0.055, lag: 180, attack: 0.55, release: 0.38, speed: 0.65,
    glow: 1.8, weight: 2.1, push: 0.03, spin: 1.1, idle: 0.18,
  }),
  P('10 · Premium, spinning', {
    fold: 4, sharp: 0.08, amp: 0.36, quiet: 0.04, gap: 0.11, strands: 16,
    spread: 0.045, lag: 210, attack: 0.65, release: 0.42, speed: 0.85,
    glow: 2.35, weight: 1.8, push: 0.04, spin: 1.3, idle: 0.16,
  }),

  /* ── Idle behaviour on its own ─────────────────────────────────────
     What it looks like when nobody is speaking, which is most of the time
     somebody is looking at it. */
  P('11 · Quiet standby', { fold: 5, sharp: 0, amp: 0.10, gap: 0.04, strands: 18,
    spread: 0.075, glow: 2.8, weight: 2.7, spin: 0.35, idle: 0.10, quiet: 0 }),
  P('12 · Lively standby', { fold: 5, sharp: 0, amp: 0.10, gap: 0.04, strands: 18,
    spread: 0.075, glow: 2.8, weight: 2.7, spin: 0.9, idle: 0.30, quiet: 0 }),
  P('13 · Still until spoken to', { fold: 5, sharp: 0, amp: 0.14, gap: 0.04,
    strands: 18, spread: 0.075, glow: 2.8, weight: 2.7, spin: 0.5, idle: 0 }),

  /* ── The rest of the range, for reference ──────────────────────────── */
  P('14 · Eight petals', { fold: 8, gap: 0.6, strands: 14, spread: 0.05, sharp: 0.15 }),
  P('15 · Three-way', { fold: 3, gap: 0.75, strands: 15, spread: 0.06 }),
  P('16 · Far and sparse', { gap: 1.4, strands: 8, spread: 0.12, amp: 0.12 }),
  P('17 · Close and dense', { gap: 0.12, strands: 26, spread: 0.012, amp: 0.07 }),
  P('18 · Free-form', { fold: 1, mirror: false, sharp: 0.6, speed: 1.4, gap: 0.6 }),
  P('19 · Body + halo', { mode: 'both', push: 0.14, strands: 10, spread: 0.06,
    gap: 0.55, fold: 4 }),
  P('20 · Molten', { mode: 'body', push: 0.28, strands: 1, sharp: 0.15,
    speed: 0.5, fold: 3 }),
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
