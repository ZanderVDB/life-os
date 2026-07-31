/**
 * Ambient stars — the atmosphere layer.
 *
 * Purely decorative: aria-hidden, pointer-events none, fixed behind everything,
 * and it never affects layout. Drawn once as inline SVG rather than animated
 * DOM nodes, so it costs one paint and no per-frame work.
 *
 * Shape rule: larger marks are soft FOUR-POINT stars (concave curves between
 * the points, so they read as light rather than as a plus sign); small marks
 * become simple rounded dots, because a four-point star below ~4px degenerates
 * into a hard square — which is exactly the artefact to avoid.
 */

/** Deterministic PRNG so the sky is identical on every load and does not shimmer. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A four-point star as a path: each arm is drawn with a quadratic curve pulling
 * in toward the centre, which is what gives the soft concave waist.
 */
function starPath(cx, cy, r) {
  const w = r * 0.30;   // waist — smaller value = sharper points
  return `M${cx} ${cy - r}`
    + `Q${cx + w} ${cy - w} ${cx + r} ${cy}`
    + `Q${cx + w} ${cy + w} ${cx} ${cy + r}`
    + `Q${cx - w} ${cy + w} ${cx - r} ${cy}`
    + `Q${cx - w} ${cy - w} ${cx} ${cy - r}Z`;
}

const TINTS = ['#C9B0FF', '#A98CFF', '#8A5DFF', '#D8CBFF'];

/**
 * @param {{count?: number, seed?: number}} [opts]
 */
export function renderStars(opts = {}) {
  document.getElementById('los-stars')?.remove();

  // Density scales with area but is capped: a large display should not pay for
  // thousands of nodes, and past a point more stars read as noise, not depth.
  const area = window.innerWidth * window.innerHeight;
  const count = opts.count ?? Math.min(90, Math.max(28, Math.round(area / 26000)));
  const rand = seeded(opts.seed ?? 20260731);

  const W = 1000;
  const H = 1000;
  const parts = [];

  for (let i = 0; i < count; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const roll = rand();
    // Mostly small. A few larger ones carry the character.
    const r = roll > 0.94 ? 5.5 + rand() * 3
      : roll > 0.80 ? 3.2 + rand() * 1.6
        : 1.0 + rand() * 1.2;
    const tint = TINTS[Math.floor(rand() * TINTS.length)];
    // Low contrast throughout — this must never compete with text.
    const op = (r > 3 ? 0.16 : 0.11) + rand() * 0.10;

    if (r >= 3) {
      parts.push(`<path d="${starPath(x, y, r)}" fill="${tint}" opacity="${op.toFixed(3)}"/>`);
    } else {
      // Round, never square — a 1px rect is the harsh dot we are avoiding.
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}"`
        + ` fill="${tint}" opacity="${op.toFixed(3)}"/>`);
    }
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'los-stars';
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.innerHTML = parts.join('');
  document.body.prepend(svg);
}

/** Re-seed on resize so density suits the new viewport, but never mid-interaction. */
let resizeTimer;
export function initStars() {
  renderStars();
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderStars(), 400);
  });
}
