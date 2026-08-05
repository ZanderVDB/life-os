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

/** How much company was left in the tank. Words, not a battery icon alone. */
export const SOCIAL = [
  { id: 'empty', label: 'Empty' },
  { id: 'low', label: 'Running low' },
  { id: 'ok', label: 'Enough' },
  { id: 'full', label: 'Full' },
] as const;

const FEELING_IDS = new Set(FEELINGS.map((f) => f.id as string));
const DETAIL_IDS = new Set(FEELINGS.flatMap((f) => f.detail as readonly string[]));
const SOCIAL_IDS = new Set(SOCIAL.map((s) => s.id as string));
const PROMPT_IDS = new Set(PROMPTS.map((p) => p.id as string));

/** One short line each. Long-form belongs in the document, not in a field. */
const MAX_LINE = 500;
const MAX_PROMPT = 2000;

export type Reflection = {
  prompts?: Record<string, string>;
  checkin?: {
    feeling?: string;
    feelingDetail?: string[];
    social?: string;
    highlight?: string;
    challenge?: string;
    gratitude?: string;
    win?: string;
  };
};

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
