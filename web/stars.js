/**
 * Ambient stars — the atmosphere layer.
 *
 * Purely decorative: aria-hidden, pointer-events none, fixed behind everything,
 * and it never affects layout. Drawn once as inline SVG rather than animated
 * DOM nodes, so it costs one paint and no per-frame work.
 *
 * Shape rule: EVERY mark is a four-point star — no circles. The waist of each
 * star is varied instead: a wide waist gives a chunky, almost-square body with
 * short points, a narrow waist gives a classic sparkle with long sharp points.
 * That variation is what makes a sky look like stars rather than like dots.
 *
 * Placement: a jittered grid, not pure random. Uniform random sampling clumps —
 * it leaves bald patches next to clusters, which reads as scattered debris. One
 * star per grid cell, offset randomly inside it, gives even coverage while
 * staying irregular enough not to look like a lattice.
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
 * A four-point star.
 *
 * `waist` is the fraction of the radius at which the concave curve between two
 * points sits. Low values (~0.2) pull the sides in hard and give long, sharp
 * arms — a genuine sparkle. High values (~0.55) barely pull in at all, leaving
 * a fat, nearly square body with just a suggestion of points.
 */
function starPath(cx, cy, r, waist) {
  const w = r * waist;
  const f = (n) => n.toFixed(2);
  return `M${f(cx)} ${f(cy - r)}`
    + `Q${f(cx + w)} ${f(cy - w)} ${f(cx + r)} ${f(cy)}`
    + `Q${f(cx + w)} ${f(cy + w)} ${f(cx)} ${f(cy + r)}`
    + `Q${f(cx - w)} ${f(cy + w)} ${f(cx - r)} ${f(cy)}`
    + `Q${f(cx - w)} ${f(cy - w)} ${f(cx)} ${f(cy - r)}Z`;
}

const TINTS = ['#C9B0FF', '#A98CFF', '#8A5DFF', '#D8CBFF'];

/**
 * @param {{count?: number, seed?: number}} [opts]
 */
export function renderStars(opts = {}) {
  document.getElementById('los-stars')?.remove();

  /* Density scales with area but is capped: a large display should not pay
   * for thousands of nodes, and past a point more stars read as noise, not
   * depth.
   *
   * The FLOOR was the problem on a phone. `max(28, …)` meant a 390 x 844
   * screen — a third of a laptop's area — still got 28 marks, so the sky was
   * three times denser per square inch than the one it was designed for.
   * Held at arm's length that is not atmosphere, it is dust on the screen,
   * and it was being reported as a stray mark beside the content. Nine is a
   * floor for "the sky is not empty"; the arithmetic does the rest. */
  const area = window.innerWidth * window.innerHeight;
  const count = opts.count ?? Math.min(90, Math.max(9, Math.round(area / 26000)));
  const rand = seeded(opts.seed ?? 20260731);

  const W = 1000;
  const H = 1000;
  const parts = [];

  // Jittered grid: cols x rows chosen to stay near-square, one star per cell.
  const cols = Math.max(4, Math.round(Math.sqrt(count * (W / H))));
  const rows = Math.max(4, Math.ceil(count / cols));
  const cw = W / cols;
  const ch = H / rows;

  let placed = 0;
  for (let gy = 0; gy < rows && placed < count; gy++) {
    for (let gx = 0; gx < cols && placed < count; gx++) {
      placed++;
      // Inset from the cell edges so two neighbours cannot end up touching.
      const x = gx * cw + cw * (0.18 + rand() * 0.64);
      const y = gy * ch + ch * (0.18 + rand() * 0.64);

      const roll = rand();
      // Roughly a third are large enough to read as proper stars; the rest are
      // small chunky specks that give the sky its depth without competing.
      const r = roll > 0.90 ? 5.0 + rand() * 3.0
        : roll > 0.66 ? 3.0 + rand() * 1.8
          : 1.4 + rand() * 1.3;

      // Big stars lean sharp; small ones lean chunky, so a 2px mark still reads
      // as a solid little star instead of vanishing into a speck.
      const waist = r >= 3
        ? 0.20 + rand() * 0.16          // 0.20-0.36 — long arms, real sparkle
        : 0.38 + rand() * 0.20;         // 0.38-0.58 — square body, soft points

      const tint = TINTS[Math.floor(rand() * TINTS.length)];
      // Low contrast throughout — this must never compete with text.
      const op = (r > 3 ? 0.16 : 0.11) + rand() * 0.10;

      parts.push(`<path d="${starPath(x, y, r, waist)}" fill="${tint}"`
        + ` opacity="${op.toFixed(3)}"/>`);
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
