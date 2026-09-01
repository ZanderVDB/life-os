/**
 * What a date in a sentence MEANS — the deadline, or the doing.
 *
 * ── The bug this exists to end ───────────────────────────────────────────
 *
 * "I need a haircut Saturday" became a task with `dueDate: 2026-09-05` and a
 * card reading "Saturday as the deadline". The date was right; the FIELD was a
 * guess presented as a fact.
 *
 * Nothing could catch it, and the reason is worth stating: the consistency
 * pass compares the card's words against the card's payload, and here they
 * agreed perfectly. The model said deadline and wrote a deadline. The
 * disagreement was with the USER, who had said neither.
 *
 * That is the same shape as the weekday bug one phase earlier — self-
 * consistent and wrong — and it wants the same answer: resolve it
 * deterministically from the user's own words, hand the planner the reading
 * rather than asking it to intuit one, and check the payload against it
 * afterwards.
 *
 * ── The distinction Life OS refuses to collapse ──────────────────────────
 *
 *   dueDate      when it must be FINISHED. A day, never a moment.
 *   scheduledAt  when the user intends to DO it. An instant.
 *
 * They are different facts about different moments, and writing one from the
 * other is how "finish the report by Friday" becomes a Friday afternoon that
 * was never free.
 *
 * ── What this file does NOT decide ───────────────────────────────────────
 *
 * Which capability runs. "Put an hour aside on Friday" is `scheduled` with
 * `block: true`, and whether that becomes `task.schedule` or `event.create`
 * depends on what the registry currently offers — which is the planner's
 * decision, from live capabilities, not a sentence list here.
 */

export type TimingReading =
  /** Must be finished by then. `dueDate`. */
  | 'deadline'
  /** Intended to be done then. `scheduledAt`, or time held in the calendar. */
  | 'scheduled'
  /** Asking to be told, not to hold time or set a deadline. */
  | 'reminder'
  /** No date in the sentence at all. */
  | 'none'
  /** A date, and nothing that says which of the two it is. ASK. */
  | 'ambiguous';

export type TimingIntent = {
  reading: TimingReading;
  /** The words that decided it. Shown in the assumption, quoted to the planner. */
  matched: string | null;
  /** A clock time was given. A deadline is a day, so this forces `scheduled`. */
  hasTime: boolean;
  /** The words ask for a SPAN to be held — an hour, a block, a booking. */
  block: boolean;
};

/* ── The vocabulary ──────────────────────────────────────────────────────
 *
 * Deliberately small, and every entry is a phrase people actually use rather
 * than a synonym harvested from a thesaurus. Anything not listed produces
 * `ambiguous`, which asks — so the cost of a gap here is a question, and the
 * cost of a false positive is a wrong field. The list errs towards asking. */

/** A date-ish word, so `by` is only a deadline when it governs a time. */
const WHEN = String.raw`(?:then|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|the\s+\w+|next\s+\w+|this\s+\w+|end\s+of\s+\w+|\d{1,2}(?:st|nd|rd|th)?|\d{4}-\d{2}-\d{2})`;

const DEADLINE: RegExp[] = [
  new RegExp(String.raw`\bby\s+${WHEN}`, 'i'),
  new RegExp(String.raw`\bbefore\s+${WHEN}`, 'i'),
  /\bdue\b/i,
  /\bdeadline\b/i,
  /\bneeds?\s+to\s+be\s+(?:done|finished|ready|in|submitted|sent)\b/i,
  /\bhas\s+to\s+be\s+(?:done|finished|ready|in)\b/i,
  /\bhand\s+(?:it\s+|them\s+)?in\b/i,
  /\bno\s+later\s+than\b/i,
];

const SCHEDULED: RegExp[] = [
  /\bwork(?:ing)?\s+on\b/i,
  /\bi'?ll\s+(?:do|start|write|finish|look|work)\b/i,
  /\bsit\s+down\b/i,
  /\bstart\s+on\b/i,
  /\bspend\s+(?:an?|\d+|some)\b/i,
  /\bdo\s+(?:it|the|my|this|that)\b/i,
  /\bget\s+(?:it|this|that)\s+done\s+on\b/i,
];

/** Holding a span of time. Still `scheduled`; the span is the extra fact. */
const BLOCK: RegExp[] = [
  /\bblock\s+(?:out|off)\b/i,
  /\b(?:put|set|carve)\s+(?:aside|out)\b/i,
  /\b(?:put|set)\s+(?:an?\s+)?(?:hour|half\s+an\s+hour|\d+\s*(?:min(?:ute)?s?|hours?))\b/i,
  /\baside\b/i,
  /\bschedule\b/i,
  /\bbook\s+(?:me\b|a\b|an\b|the\b)/i,
  /\bmake\s+time\b/i,
  /\bfind\s+(?:me\s+)?(?:an?\s+)?(?:hour|time|slot)\b/i,
  /\bin\s+(?:my|the)\s+calendar\b/i,
];

const REMINDER: RegExp[] = [
  /\bremind\s+me\b/i,
  /\bgive\s+me\s+a\s+nudge\b/i,
  /\bdon'?t\s+let\s+me\s+forget\b/i,
];

/** A clock time. A deadline is a day; a time means somebody is planning to act. */
const CLOCK = /\b(?:at|from)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|\b\d{1,2}(?::\d{2})\s*(?:am|pm)?\b|\b\d{1,2}\s*(?:am|pm)\b/i;

/** Does the sentence refer to a day at all? Without one there is nothing to read. */
const HAS_DATE = new RegExp(
  String.raw`\b(?:today|tonight|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|\d{4}-\d{2}-\d{2})\b`
  + String.raw`|\bin\s+\d{1,3}\s+(?:days?|weeks?)\b|\bnext\s+week\b`, 'i');

const firstMatch = (text: string, list: RegExp[]): string | null => {
  for (const re of list) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
};

/**
 * Read one request.
 *
 * Order matters, and each step is a claim about English rather than a
 * preference:
 *
 *   1. "remind me" is asking to be TOLD. It sets neither field.
 *   2. "by Friday", "due", "deadline" say when it must be finished.
 *   3. "work on it", "block out an hour", "book me" say when it will be done.
 *   4. A clock time cannot be a deadline, because `dueDate` holds a day.
 *   5. A date with none of the above is genuinely ambiguous, and the honest
 *      answer is a question rather than a coin toss.
 */
export function classifyTiming(text: string): TimingIntent {
  const t = String(text ?? '');
  const hasTime = CLOCK.test(t);
  const blockWords = firstMatch(t, BLOCK);

  const remind = firstMatch(t, REMINDER);
  if (remind) {
    return { reading: 'reminder', matched: remind, hasTime, block: false };
  }

  const deadline = firstMatch(t, DEADLINE);
  const scheduled = firstMatch(t, SCHEDULED) ?? blockWords;

  /* Both kinds of wording in one sentence: "block out Friday morning to finish
     the report by Monday" is two facts, and the SCHEDULING is the one this
     sentence is asking for. The deadline survives as something to say on the
     card, not as the field to write. */
  if (deadline && !scheduled) {
    /* Except when a clock time contradicts it. "Due by 3pm" is a real thing
       people say, but `dueDate` cannot hold 3pm — so the reading stays
       deadline and the time is the planner's problem to state or drop. */
    return { reading: 'deadline', matched: deadline, hasTime, block: false };
  }
  if (scheduled) {
    return { reading: 'scheduled', matched: scheduled, hasTime, block: Boolean(blockWords) };
  }

  /* A time of day with no other signal. Nobody says "finish it by 2pm on
     Saturday" and means a date field; they are planning to be somewhere. */
  if (hasTime && HAS_DATE.test(t)) {
    return { reading: 'scheduled', matched: t.match(CLOCK)?.[0]?.trim() ?? null, hasTime, block: false };
  }

  if (!HAS_DATE.test(t)) return { reading: 'none', matched: null, hasTime, block: false };
  return { reading: 'ambiguous', matched: null, hasTime, block: false };
}

/**
 * The two readings, in the user's own terms, for a clarification.
 *
 * Written here rather than in the prompt so the question is the same question
 * every time, and so it cannot drift into leading the user towards one answer.
 */
export const AMBIGUOUS_OPTIONS = [
  { id: 'c1', label: 'Do it then', detail: 'Sets when you intend to do it' },
  { id: 'c2', label: 'Have it done by then', detail: 'Sets it as a deadline' },
] as const;

/** Which field a chosen option means. Used when a clarification is answered. */
export function readingFromChoice(label: string): 'scheduled' | 'deadline' | null {
  const l = String(label ?? '').toLowerCase();
  if (/\bdone by\b|\bdeadline\b|\bby then\b|\bfinish/.test(l)) return 'deadline';
  if (/\bdo it\b|\bwork on\b|\bthen\b/.test(l)) return 'scheduled';
  return null;
}
