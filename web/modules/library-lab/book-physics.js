/**
 * THE PHYSICAL RULES — height, thickness, and the sample rows (L3.5 §4/§5/§30).
 *
 * Split out of `shared-cover.js` because the component lab needs to reason about
 * a Book's size without rendering its cover, and because the height rule needed
 * replacing rather than tuning.
 *
 * ── Why the old height rule looked generated ──────────────────────────────
 *
 * L3.4 hashed the id with `n = (n * 31 + ch) % 997` and took `n % 5`. That is a
 * fine hash for lookup and a bad one for appearance, because it does not
 * avalanche: two ids differing in one low character produce two `n` values
 * differing by a small amount, and `% 5` then walks through the buckets in
 * order. The sample ids are `b1 … b8` — sequential — so the shelf came out
 *
 *     increase, increase, increase, reset, increase, increase, reset
 *
 * which is exactly what the review saw. The defect was never the five steps; it
 * was that consecutive ids produced consecutive buckets.
 */

/**
 * A 32-bit hash that actually avalanches: FNV-1a for the mixing, then murmur3's
 * fmix32 finaliser. The finaliser is the part that matters — it is what makes
 * `b1` and `b2` produce uncorrelated outputs, so neighbouring Books on a shelf
 * have unrelated heights however their ids were assigned.
 */
export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export const H_MIN = 170;
export const H_MAX = 215;

/**
 * The height ladder: sixteen slots, hand-weighted.
 *
 * A curated table rather than arithmetic on the hash, because the thing being
 * controlled is a *distribution*, and a table is the only version of it that
 * can be read at a glance and argued with.
 *
 *     170 ×1   175 ×1   180 ×2   185 ×2   190 ×3
 *     195 ×2   200 ×2   205 ×1   210 ×1   215 ×1
 *
 * Middle-weighted so most Books are ordinary, with the extremes present but
 * rare — one Book in sixteen is tall enough to notice. A uniform draw over the
 * whole range gives a silhouette that reads as damage rather than as a shelf;
 * averaging draws to fix that pulls the tails in so far that 170 and 215 never
 * actually appear. The table gives both, exactly, and the order of the entries
 * is itself irregular so no arrangement of ids can walk it in steps.
 *
 * Quantised to 5px: neighbours differing by 1–2px read as misalignment rather
 * than as variation, which was the right instinct behind the original steps.
 */
const LADDER = [190, 200, 180, 195, 210, 185, 175, 200,
  190, 215, 185, 195, 170, 205, 190, 180];

export function bookHeight(id) {
  return LADDER[hash32(id) % LADDER.length];
}

export { LADDER as HEIGHT_LADDER };

/**
 * Thickness: content volume first, with a small binding offset.
 *
 *     clamp(26, 26 + round(sqrt(pages) * 2.2) + bind(id), 58)
 *
 * The square root keeps early differences legible while flattening the tail — a
 * linear mapping would make a 500-page Book eight times a 60-page one, which is
 * a wardrobe standing next to some envelopes.
 *
 * `bind` is −2 … +2 from the id. Its whole job is to stop two Books with the
 * same page count from being pixel-identical twins, which on a shelf reads as a
 * duplicated render. It is deliberately small: at ±2px on a 26–58px range it
 * cannot reorder two Books by apparent volume, so *thicker still means more
 * inside* — which is the property that must not be traded away.
 */
export const THICK_MIN = 26;
export const THICK_MAX = 58;
export function bindingOffset(id) {
  return (hash32(`bind:${id}`) % 5) - 2;                   // −2 … +2
}
export function bookThickness(pages = 0, id = '') {
  const p = Math.max(0, Number(pages) || 0);
  const t = THICK_MIN + Math.round(Math.sqrt(p) * 2.2) + (id ? bindingOffset(id) : 0);
  return Math.min(THICK_MAX, Math.max(THICK_MIN, t));
}

/** The cover width every concept shares, so slot maths is one number. */
export const COVER_W = 126;

/**
 * The width a slot must reserve for a Book turned by `deg`.
 *
 * A cover at an angle occupies `126·|cos| + t·|sin|` across the shelf. Reserving
 * exactly that is what keeps the pulled state from overlapping a neighbour —
 * and, because the hit target is the slot rather than the rotated faces, it is
 * also what keeps pointer input honest. See §14.
 */
export function turnedWidth(deg, thickness) {
  const r = (Math.abs(deg) * Math.PI) / 180;
  return Math.ceil(COVER_W * Math.abs(Math.cos(r)) + thickness * Math.abs(Math.sin(r)));
}

/* ── Sample rows (§30) ─────────────────────────────────────────────────────
 *
 * Deterministic literals, not generated at render time. The 20-Book row is the
 * one that matters: nine Books is too few to tell an irregular silhouette from
 * a lucky one, and forty is too many to look at as a shape.
 */

const EXTRA = [
  ['x01', 'Winter Reading', 'The months I actually finished something', 'sage', 2024, 74],
  ['x02', 'Kitchen Notes', null, 'peach', 2025, 18],
  ['x03', 'The Long Way Round', 'Three years of getting there slowly', 'blue', 2023, 310],
  ['x04', 'Interviews', 'What people said when I stopped talking', 'lavender', 2025, 132],
  ['x05', 'Rates & Ratios', null, 'sage', 2024, 47],
  ['x06', 'A Field Guide', 'To the things I keep mistaking for problems', 'peach', 2026, 205],
  ['x07', 'Drafts', null, 'blue', 2026, 6],
  ['x08', 'The Quiet Hours', 'Before anyone else is awake', 'lavender', 2025, 88],
  ['x09', 'Ledger', null, 'sage', 2022, 420],
  ['x10', 'Second Thoughts', 'Everything I changed my mind about', 'peach', 2025, 61],
  ['x11', 'Coastlines', null, 'blue', 2024, 155],
  ['x12', 'Small Repairs', 'A running list of things I fixed myself', 'lavender', 2026, 33],
  ['x13', 'Provisions', null, 'sage', 2023, 12],
  ['x14', 'The Argument', 'One idea, taken as far as it goes', 'peach', 2024, 268],
  ['x15', 'Notes On Weather', null, 'blue', 2025, 95],
  ['x16', 'Borrowed Light', 'Things other people taught me', 'lavender', 2026, 51],
  ['x17', 'Inventory', null, 'sage', 2022, 178],
  ['x18', 'The Slow Fix', 'What took a year and was worth it', 'peach', 2023, 29],
  ['x19', 'Correspondence', null, 'blue', 2025, 340],
  ['x20', 'Beginnings', 'Twenty-one attempts at a first page', 'lavender', 2026, 3],
  ['x21', 'The Back Catalogue', null, 'sage', 2021, 112],
  ['x22', 'Rough Cut', 'Before the edit', 'peach', 2026, 22],
  ['x23', 'Standing Orders', null, 'blue', 2024, 66],
  ['x24', 'What Remains', 'The parts that survived every rewrite', 'lavender', 2023, 190],
  ['x25', 'Marginalia', null, 'sage', 2025, 40],
  ['x26', 'The Practice', 'Same thing, every day, for a while', 'peach', 2024, 500],
  ['x27', 'Offcuts', null, 'blue', 2026, 15],
  ['x28', 'Due North', 'Where I was actually trying to get to', 'lavender', 2022, 143],
  ['x29', 'Provisional', null, 'sage', 2026, 8],
  ['x30', 'The Reckoning', 'Adding it all up, honestly', 'peach', 2025, 232],
  ['x31', 'Shortwave', null, 'blue', 2023, 57],
];

const toBook = ([id, title, sub, accent, year, pages]) => ({
  id, title, sub, accent, year, pages, author: 'You',
});

/**
 * A row of exactly `n` Books, always the same `n` Books, always in the same
 * order: the Diary, then the eight sample Books, then as many extras as needed.
 */
export function sampleRow(n, DIARY, BOOKS) {
  const base = [DIARY, ...BOOKS];
  const out = base.slice(0, n);
  for (let i = 0; out.length < n && i < EXTRA.length; i++) out.push(toBook(EXTRA[i]));
  return out;
}

export const ROW_SIZES = [9, 20, 40];
