/**
 * The guided prompts and the quick check-in.
 *
 * One validated object, stored in `diary_entries.reflection`. The grammar lives
 * here so the client and the server agree on it in one place, the way
 * `book-doc.ts` does for a document.
 *
 * ── Why it is validated rather than trusted ──────────────────────────────
 *
 * The same reason page content is: the column is `jsonb`, so without a grammar
 * it would accept anything a client happened to send and every later reader
 * would have to defend itself. Unknown keys are DROPPED at the boundary — the
 * server must not store what it cannot describe.
 *
 * The client does not drop, for the F2 §13 reason: it round-trips, so an older
 * tab discarding a newer build's key would silently delete an answer somebody
 * gave. That asymmetry is deliberate and is documented on both sides.
 */

/** The five guided prompts. Order is the order they are asked in. */
export const PROMPTS = [
  { id: 'stood_out', label: 'What stood out today?' },
  { id: 'felt_good', label: 'What felt good?' },
  { id: 'felt_hard', label: 'What felt difficult?' },
  { id: 'remember', label: 'What do I want to remember?' },
  { id: 'differently', label: 'What would I do differently tomorrow?' },
] as const;

/**
 * The broad feelings, each with the finer ones it opens into.
 *
 * Two levels, not twenty. The broad answer alone is a complete answer — the
 * detail is there for the days when "good" is not quite the word, and is never
 * required to have chosen one.
 */
export const FEELINGS = [
  { id: 'rough', label: 'Rough', detail: ['drained', 'anxious', 'sad', 'angry', 'numb'] },
  { id: 'low', label: 'Low', detail: ['tired', 'flat', 'worried', 'lonely', 'restless'] },
  { id: 'steady', label: 'Steady', detail: ['calm', 'focused', 'patient', 'ordinary', 'quiet'] },
  { id: 'good', label: 'Good', detail: ['peaceful', 'proud', 'relieved', 'connected', 'curious'] },
  { id: 'great', label: 'Great', detail: ['excited', 'grateful', 'joyful', 'inspired', 'loved'] },
] as const;

/**
 * How much company was left in the tank. Words, not a battery icon alone.
 *
 * FIVE states from D2.4 §4. Four made this the odd one out beside Overall
 * Feeling and Energy, and it forced an uneven battery: four cells cannot be
 * evenly spaced against a five-step sibling.
 *
 * `good` is the state that was missing — between "just enough to get through"
 * and "plenty". The order is deliberately monotonic in how much company was
 * left, not in how the day went.
 */
export const SOCIAL = [
  { id: 'empty', label: 'Empty' },
  { id: 'low', label: 'Running low' },
  { id: 'ok', label: 'Enough' },
  { id: 'good', label: 'Good' },
  { id: 'full', label: 'Full' },
] as const;

/* ── The passive daily check-ins (D2.3 §7, §8) ───────────────────────────
 *
 * THESE DESCRIBE A DAY. THEY ARE NOT HABITS.
 *
 * A habit is a behaviour somebody intends to repeat and chose to track. These
 * are observations of how the day actually went, and the difference is not
 * pedantic — it decides what the app is allowed to conclude.
 *
 *   `Movement = Very active` does NOT complete a Gym habit.
 *   `Nourishment = Great`    does NOT create or complete an Eating Well habit.
 *
 * Nothing here writes a `habit_entries` row, and nothing here is counted in a
 * habit total. The one computed habit Diary feeds — `Write in Diary` — is
 * about whether you WROTE, not about what you recorded.
 *
 * Gym is deliberately absent: it is an intentional activity and belongs to
 * Habits. Movement is universal and descriptive, which is why it belongs here.
 *
 * Each scale is ordered from least to most, and `index / (length - 1)` is the
 * only arithmetic anything is allowed to do with them — see `scaleValue`.
 */
export const NOURISHMENT = [
  { id: 'poor', label: 'Poor' },
  { id: 'okay', label: 'Okay' },
  { id: 'good', label: 'Good' },
  { id: 'great', label: 'Great' },
] as const;

export const MOVEMENT = [
  { id: 'barely', label: 'Barely moved' },
  { id: 'light', label: 'Light' },
  { id: 'active', label: 'Active' },
  { id: 'very_active', label: 'Very active' },
] as const;

export const OUTSIDE = [
  { id: 'none', label: 'None' },
  { id: 'little', label: 'A little' },
  { id: 'some', label: 'Some time' },
  { id: 'plenty', label: 'Plenty' },
] as const;

/**
 * FOUR states from D2.4 §8, like every other Daily Rhythm row.
 *
 * `rested` is the top state rather than `great`, deliberately: it names the
 * OUTCOME you actually notice the next morning rather than grading the night.
 * "Great sleep" and "I feel rested" are the same answer, and only one of them
 * is a thing you can report without thinking about it.
 *
 * `great` is still accepted on the way in and normalised to `rested` — see
 * `SLEEP_ALIAS`. Dropping it would silently empty the sleep value on any day
 * recorded before D2.4 the first time that day was re-saved.
 */
export const SLEEP = [
  { id: 'rough', label: 'Rough' },
  { id: 'poor', label: 'Poor' },
  { id: 'fine', label: 'Fine' },
  { id: 'rested', label: 'Rested' },
] as const;

/** Retired ids, and what they became. Read on the way in, never written. */
export const SLEEP_ALIAS: Record<string, string> = { great: 'rested' };

/** The passive dimensions, by the key they are stored under. */
export const PASSIVE = {
  nourishment: NOURISHMENT,
  movement: MOVEMENT,
  outside: OUTSIDE,
  sleep: SLEEP,
} as const;

export type PassiveKey = keyof typeof PASSIVE;
export const PASSIVE_KEYS = Object.keys(PASSIVE) as PassiveKey[];

const FEELING_IDS = new Set(FEELINGS.map((f) => f.id as string));
const DETAIL_IDS = new Set(FEELINGS.flatMap((f) => f.detail as readonly string[]));
const SOCIAL_IDS = new Set(SOCIAL.map((s) => s.id as string));
const PROMPT_IDS = new Set(PROMPTS.map((p) => p.id as string));
const PASSIVE_IDS = Object.fromEntries(
  PASSIVE_KEYS.map((k) => [k, new Set((PASSIVE[k] as readonly { id: string }[]).map((o) => o.id))]),
) as Record<PassiveKey, Set<string>>;

/** One short line each. Long-form belongs in the document, not in a field. */
const MAX_LINE = 500;
const MAX_PROMPT = 2000;

export type Reflection = {
  prompts?: Record<string, string>;
  checkin?: {
    feeling?: string;
    feelingDetail?: string[];
    social?: string;
    /** Passive daily dimensions — observations, never habits. */
    nourishment?: string;
    movement?: string;
    outside?: string;
    sleep?: string;
    /* The four Moment lines. D2.3 §2/§3 moved them off the right page, which
     * is now tap-only, and they are no longer offered on a fresh day. They stay
     * in the grammar and in storage so that days already holding one keep it —
     * the left page surfaces those as guided prompts. Nothing writes a NEW one. */
    highlight?: string;
    challenge?: string;
    gratitude?: string;
    win?: string;
  };
};

/**
 * A scale position as a 0–1 fraction, for a meter or a bar.
 *
 * The ONLY arithmetic these scales permit. It is a position on an ordered list
 * — never a score, never summed with another dimension, never averaged into a
 * "day rating". D2.3 §10 is explicit that the day is not graded.
 */
export function scaleValue(
  scale: readonly { id: string }[], id: string | null | undefined,
): number | null {
  if (!id) return null;
  const at = scale.findIndex((o) => o.id === id);
  if (at < 0) return null;
  return scale.length > 1 ? at / (scale.length - 1) : 1;
}

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t.slice(0, max);
};

/**
 * Validates and normalises. Never throws.
 *
 * A malformed reflection must not cost somebody the writing it arrived with —
 * the same reasoning as `validateDoc`. What cannot be described is dropped, and
 * everything else is kept.
 */
export function validateReflection(raw: unknown): Reflection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const src = raw as Record<string, any>;
  const out: Reflection = {};

  if (src.prompts && typeof src.prompts === 'object' && !Array.isArray(src.prompts)) {
    const prompts: Record<string, string> = {};
    for (const [k, v] of Object.entries(src.prompts)) {
      if (!PROMPT_IDS.has(k)) continue;          // a question this build cannot ask
      const t = str(v, MAX_PROMPT);
      if (t) prompts[k] = t;
    }
    if (Object.keys(prompts).length) out.prompts = prompts;
  }

  const c = src.checkin;
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const checkin: NonNullable<Reflection['checkin']> = {};
    if (typeof c.feeling === 'string' && FEELING_IDS.has(c.feeling)) checkin.feeling = c.feeling;
    if (Array.isArray(c.feelingDetail)) {
      const detail: string[] = [...new Set(
        (c.feelingDetail as unknown[]).filter(
          (d): d is string => typeof d === 'string' && DETAIL_IDS.has(d),
        ),
      )].slice(0, 5);
      if (detail.length) checkin.feelingDetail = detail;
    }
    if (typeof c.social === 'string' && SOCIAL_IDS.has(c.social)) checkin.social = c.social;
    /* The passive dimensions. Each is one id from its own ordered scale, with
     * retired ids normalised rather than dropped — see `SLEEP_ALIAS`. */
    for (const k of PASSIVE_KEYS) {
      if (typeof c[k] !== 'string') continue;
      const v = k === 'sleep' ? (SLEEP_ALIAS[c[k]] ?? c[k]) : c[k];
      if (PASSIVE_IDS[k].has(v)) checkin[k] = v;
    }
    /* Still accepted, still stored, no longer offered on a new day — see the
     * note on the type. Dropping them here would delete somebody's Highlight
     * the first time an old entry was re-saved by a new build. */
    for (const k of ['highlight', 'challenge', 'gratitude', 'win'] as const) {
      const t = str(c[k], MAX_LINE);
      if (t) checkin[k] = t;
    }
    if (Object.keys(checkin).length) out.checkin = checkin;
  }

  return out;
}

/** Is there anything a person put here? Used by the meaningful-entry rule. */
export function reflectionHasContent(r: Reflection | null | undefined): boolean {
  if (!r) return false;
  if (r.prompts && Object.keys(r.prompts).length) return true;
  if (r.checkin && Object.keys(r.checkin).length) return true;
  return false;
}

/**
 * The searchable text of a reflection.
 *
 * Folded into `document_text` on write, so a search for a word somebody typed
 * into "What felt difficult?" finds the day. Without this, half of what a
 * person writes would be invisible to their own search.
 */
export function reflectionToText(r: Reflection | null | undefined): string {
  if (!r) return '';
  const parts: string[] = [];
  for (const p of PROMPTS) if (r.prompts?.[p.id]) parts.push(r.prompts[p.id]!);
  const c = r.checkin;
  if (c) {
    for (const k of ['highlight', 'challenge', 'gratitude', 'win'] as const) {
      if (c[k]) parts.push(c[k]!);
    }
  }
  return parts.join(' ').trim();
}
