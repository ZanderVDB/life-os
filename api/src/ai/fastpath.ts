/**
 * The fast path — obvious commands, without a reasoning chain.
 *
 * ── What this is, and what it very deliberately is not ───────────────────
 *
 * "Add milk" does not need a model. It needs four words parsed and one task
 * proposed, and putting two model round trips between the sentence and the
 * card costs several seconds to arrive at the answer anyone would have
 * written down immediately.
 *
 * It is NOT an attempt to replace the planner with regular expressions. That
 * approach fails the same way every time: the patterns grow, they start
 * matching sentences they only half understand, and the failure is silent —
 * a confidently wrong action instead of a slower right one. So this file
 * recognises FOUR shapes, and every one of them has to be unambiguous in
 * every part before it will produce anything:
 *
 *   create a task        "Add milk", "Add a task called Send invoice"
 *   create a reminder    "Remind me Friday to call Oscar"
 *   complete something   "Complete Morning walk", "Mark Pay the deposit done"
 *   move a task          "Move this to This Week"
 *
 * ── Fail closed ──────────────────────────────────────────────────────────
 *
 * Every uncertainty returns `null` with a REASON, and the caller runs the
 * normal planner. Two tasks match the name — fall back. A date word this file
 * cannot resolve — fall back. A conjunction, which means there are probably
 * two requests — fall back. A question mark — fall back. The fast path is
 * never the only way to get an answer, so declining costs a second and
 * guessing costs the user's trust.
 *
 * ── It gets no special privileges ────────────────────────────────────────
 *
 * What comes out of here is a raw action in the same shape the planner
 * produces, and it goes through the same normalisation afterwards: resolved
 * through the registry, validated against the capability's own schema, risk
 * assigned by the server, written into the same proposal row, confirmed by the
 * same gate. There is no branch anywhere downstream that knows a proposal came
 * from here — which is what makes "the fast path is safe" a structural claim
 * rather than a promise.
 */
import type { CapabilityRegistry, CapabilityCtx } from './registry.js';
import { resolveRelativeDate } from '../lib/civil-date.js';
import type { ContextSource, EntityRef } from './types.js';

/** The shape of an action before the turn normalises it. Matches the planner's. */
export type RawAction = {
  capability: string;
  title: string;
  summary?: string | null;
  payload: Record<string, unknown>;
  confidence: 'high' | 'medium' | 'low';
  assumptions: string[];
  warnings: string[];
  sources: string[];
};

export type FastResult = {
  /** What the request was read as, in a sentence a person can check. */
  understood: string;
  actions: RawAction[];
  /** Which shape matched, for the metrics. Never shown to the user. */
  shape: string;
};

export type FastMiss = { reason: string };

/* ══ Guards ══════════════════════════════════════════════════════════════ */

/**
 * Sentences this file will not look at, whatever they contain.
 *
 * Each of these is a case where a confident cheap reading is likely to be
 * wrong, and where being a second slower costs nothing.
 */
const DISQUALIFIERS: { test: RegExp; reason: string }[] = [
  { test: /\?/, reason: 'a question' },
  { test: /^\s*(what|when|where|who|why|which|how|do i|is|are|can|could|should|show|tell|list|find|remind me what)\b/i, reason: 'a question' },
  /* Two clauses almost always means two requests, and half of one proposal is
     worse than none. "and" inside a title survives, because a title is taken
     verbatim after "called". */
  { test: /\b(and|then|also|plus)\b|[;,](?!\d)/i, reason: 'more than one clause' },
  { test: /\b(actually|instead|no wait|scratch that|change that|make it)\b/i, reason: 'an amendment to something pending' },
  /* Anything reaching outside Life OS, however simple it sounds. */
  { test: /\b(meeting|calendar|event|invite|appointment|book a|schedule a call)\b/i, reason: 'calendar wording' },
  { test: /\b(project|habit streak|diary|journal|page|book)\b/i, reason: 'wording that spans modules' },
];

const MAX_WORDS = 16;

/* ══ Dates ═══════════════════════════════════════════════════════════════
 *
 * There is one resolver, in `lib/civil-date.ts`, and this is not it. There
 * used to be two — a copy here and, effectively, another one inside the model,
 * which was told the date and asked to work out the weekday itself. They
 * disagreed, which is a thing users notice and nothing downstream could
 * catch. */
export { resolveRelativeDate as resolveDate } from '../lib/civil-date.js';

/** A time of day, when one was actually given. `at 3` is not a date. */
function resolveTime(text: string): { time: string; matched: string } | null {
  const m = text.toLowerCase().match(/\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ?? '00';
  const suffix = m[3];
  if (suffix === 'pm' && h < 12) h += 12;
  if (suffix === 'am' && h === 12) h = 0;
  /* "at 3" with no am/pm is genuinely ambiguous. Rather than guessing at an
     afternoon the user did not say, refuse the shape entirely. */
  if (!suffix && h <= 7) return null;
  if (h > 23) return null;
  return { time: `${String(h).padStart(2, '0')}:${min}`, matched: m[0] };
}

/** Words that appear around a title and are not part of it. */
const tidy = (s: string) => s
  .replace(/^\s*(please|pls)\s+/i, '')
  .replace(/^\s*(to|that|the task|a task|task|an?)\s+/i, '')
  .replace(/\s*[.!]+\s*$/, '')
  .trim();

/** Titles are the user's words; only the casing of a leading word is ours. */
const titleCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/* ══ Entity resolution ═══════════════════════════════════════════════════ */

/**
 * Find the ONE thing a name refers to, or nothing.
 *
 * Uses the registry's own search capabilities, so a module that has been
 * removed cannot be resolved against and the fast path loses the shapes that
 * depended on it — automatically, with no list here to keep in step.
 *
 * Exactly one match is required. Two is not "pick the better one": two is a
 * clarification, and clarification is the planner's job.
 */
async function resolveOne(
  ctx: CapabilityCtx, registry: CapabilityRegistry, name: string, types: string[],
): Promise<{ hit: ContextSource } | { ambiguous: number } | null> {
  const clean = name.trim();
  if (clean.length < 2) return null;
  const caps = (await registry.capabilities(ctx)).filter((c) => c.kind === 'search');
  const found: ContextSource[] = [];
  for (const cap of caps) {
    if (!cap.run) continue;
    const parsed = cap.input.safeParse({ query: clean });
    if (!parsed.success) continue;
    const rows = await cap.run(ctx, parsed.data).catch(() => [] as ContextSource[]);
    found.push(...rows.filter((r) => types.includes(r.ref.type)));
  }

  const lower = clean.toLowerCase();
  const byKey = new Map<string, ContextSource>();
  for (const f of found) byKey.set(`${f.ref.type}:${f.ref.id}`, f);
  const all = [...byKey.values()];

  /* An exact title beats everything, including several partial matches. "Add
     milk" resolving against "Milk" and "Buy oat milk for the weekend" is not
     ambiguous — one of them IS the thing named. */
  const exact = all.filter((r) => r.title.trim().toLowerCase() === lower);
  if (exact.length === 1) return { hit: exact[0]! };
  if (exact.length > 1) return { ambiguous: exact.length };
  if (all.length === 1) return { hit: all[0]! };
  if (all.length > 1) return { ambiguous: all.length };
  return null;
}

/* ══ The shapes ══════════════════════════════════════════════════════════ */

/** Habits are ticked, tasks are completed, reminders are done. */
const COMPLETION: Record<string, (ref: EntityRef) => RawAction | null> = {
  task: (ref) => ({
    capability: 'task.complete',
    title: '',
    payload: { id: ref.id, done: true },
    confidence: 'high', assumptions: [], warnings: [], sources: [`task:${ref.id}`],
  }),
  habit: (ref) => ({
    capability: 'habit.check',
    title: '',
    payload: { id: ref.id },
    confidence: 'high', assumptions: [], warnings: [], sources: [`habit:${ref.id}`],
  }),
  reminder: (ref) => ({
    capability: 'reminder.complete',
    title: '',
    payload: { id: ref.id },
    confidence: 'high', assumptions: [], warnings: [], sources: [`reminder:${ref.id}`],
  }),
};

const BUCKETS: { test: RegExp; bucket: string; label: string }[] = [
  { test: /\b(today)\b/i, bucket: 'today', label: 'Today' },
  { test: /\b(this ?week|the week)\b/i, bucket: 'week', label: 'This week' },
  { test: /\b(this ?month|the month)\b/i, bucket: 'month', label: 'This month' },
  { test: /\b(future|later|someday)\b/i, bucket: 'future', label: 'Future' },
];

export type FastInput = {
  text: string;
  ctx: CapabilityCtx;
  registry: CapabilityRegistry;
  /** True when something is still awaiting confirmation. Disqualifies everything. */
  hasPending: boolean;
};

/**
 * Try to answer without a model.
 *
 * @returns a result, or a miss carrying the reason it declined.
 */
export async function tryFastPath(input: FastInput): Promise<FastResult | FastMiss> {
  const { ctx, registry } = input;
  const today = ctx.request.today;
  const raw = input.text.trim();

  /* A pending proposal changes what a sentence means: "complete it" is about
     something on screen that does not exist yet. That is conversation state,
     and conversation state is the planner's. */
  if (input.hasPending) return { reason: 'a proposal is pending' };
  if (raw.split(/\s+/).length > MAX_WORDS) return { reason: 'too long to be obvious' };

  /* "called X" quotes everything after it, so a title containing "and" is not
     mistaken for two requests. The guards run against the rest. */
  const quoted = raw.match(/\b(?:called|named|titled)\b\s+(.+)$/i);
  const guarded = quoted ? raw.slice(0, raw.length - quoted[1]!.length) : raw;
  for (const d of DISQUALIFIERS) {
    if (d.test.test(guarded)) return { reason: d.reason };
  }

  const available = async (id: string) => Boolean(await registry.resolve(ctx, id));

  /* ── 1. Complete something ────────────────────────────────────────── */
  const done = raw.match(
    /^(?:mark|tick|check off|complete|completed|finish|finished|did)\s+(.+?)(?:\s+(?:as\s+)?(?:done|complete|completed|off))?$/i,
  );
  if (done && !/^(?:a|an|the|new)\b/i.test(done[1]!.trim())) {
    const name = tidy(done[1]!);
    const found = await resolveOne(ctx, registry, name, ['task', 'habit', 'reminder']);
    if (!found) return { reason: `nothing matched “${name}”` };
    if ('ambiguous' in found) return { reason: `${found.ambiguous} things match “${name}”` };
    const make = COMPLETION[found.hit.ref.type];
    if (!make) return { reason: 'that kind of thing cannot be completed' };
    const action = make(found.hit.ref);
    if (!action || !(await available(action.capability))) {
      return { reason: 'the capability is not available' };
    }
    action.title = found.hit.title;
    return {
      understood: `Mark “${found.hit.title}” done.`,
      actions: [action],
      shape: 'complete',
    };
  }

  /* ── 2. Move a task to a bucket ───────────────────────────────────── */
  const move = raw.match(/^(?:move|put|push)\s+(.+?)\s+(?:to|into|in)\s+(.+)$/i);
  if (move) {
    const bucket = BUCKETS.find((b) => b.test.test(move[2]!));
    if (!bucket) return { reason: 'not a board column' };
    if (!(await available('task.move'))) return { reason: 'the capability is not available' };

    const subject = tidy(move[1]!.replace(/\bthis\s+(task)?\b/i, 'this').trim());
    let ref: EntityRef | null = null;
    let title = '';
    if (/^(this|it|that)$/i.test(subject)) {
      /* "this" is only meaningful when something is open, and the surface is
         where that is known. Without it the word refers to nothing. */
      const surface = ctx.request.surface?.entity;
      if (!surface || surface.type !== 'task') return { reason: 'no task is open' };
      ref = surface;
      title = 'the open task';
    } else {
      const found = await resolveOne(ctx, registry, subject, ['task']);
      if (!found) return { reason: `no task matched “${subject}”` };
      if ('ambiguous' in found) return { reason: `${found.ambiguous} tasks match “${subject}”` };
      ref = found.hit.ref;
      title = found.hit.title;
    }
    return {
      understood: `Move ${title === 'the open task' ? 'it' : `“${title}”`} to ${bucket.label}.`,
      actions: [{
        capability: 'task.move',
        title: title === 'the open task' ? 'Move to ' + bucket.label : title,
        payload: { id: ref.id, bucket: bucket.bucket },
        confidence: 'high', assumptions: [], warnings: [], sources: [`task:${ref.id}`],
      }],
      shape: 'move',
    };
  }

  /* ── 3. Remind me ─────────────────────────────────────────────────── */
  if (/^remind me\b/i.test(raw)) {
    if (!(await available('reminder.create'))) return { reason: 'the capability is not available' };
    let rest = raw.replace(/^remind me\b\s*/i, '');
    const when = resolveRelativeDate(rest, today);
    /* No date at all is fine — a reminder defaults to today, which is what the
       modal does. A date word this file cannot resolve is NOT fine. */
    if (!when && /\b(next|week|month|weekend|end of|later|sometime|fortnight)\b/i.test(rest)) {
      return { reason: 'a date this cannot resolve exactly' };
    }
    const time = resolveTime(rest);
    if (when) rest = rest.replace(new RegExp(`\\b(on\\s+)?${when.matched}\\b`, 'i'), ' ');
    if (time) rest = rest.replace(time.matched, ' ');
    const title = titleCase(tidy(rest.replace(/\s+/g, ' ')));
    if (title.length < 2) return { reason: 'nothing left to be reminded about' };

    const payload: Record<string, unknown> = { title };
    if (when) payload['dueDate'] = when.date;
    if (time) payload['dueTime'] = time.time;
    return {
      understood: `Set a reminder to ${title.charAt(0).toLowerCase()}${title.slice(1)}${
        when ? ` on ${when.date}` : ''}.`,
      actions: [{
        capability: 'reminder.create',
        title,
        payload,
        confidence: 'high',
        /* Stated because it is a real interpretation, and because the card
           carries an editable field beside it. */
        assumptions: when ? [] : ['No date was given, so this is set for today.'],
        warnings: [], sources: [],
      }],
      shape: 'reminder',
    };
  }

  /* ── 4. Add a task ────────────────────────────────────────────────── */
  const add = raw.match(/^(?:add|create|new|capture|note down|jot down)\b\s*(.+)$/i);
  if (add) {
    if (!(await available('task.create'))) return { reason: 'the capability is not available' };
    let body = add[1]!;
    const named = body.match(/\b(?:called|named|titled)\b\s+(.+)$/i);
    if (named) body = named[1]!;
    /* A date on a bare "add" is the one genuinely ambiguous case in this
       shape: "add pay the rent Friday" could be a deadline or an intention,
       and getting it wrong writes the wrong field. The planner exists for
       exactly that, and it says which it chose on the card. */
    if (!named && resolveRelativeDate(body, today)) {
      return { reason: 'a date that needs interpreting' };
    }
    const title = titleCase(tidy(body.replace(/\s+/g, ' ')));
    if (title.length < 2) return { reason: 'no title' };
    if (title.length > 200) return { reason: 'too long for a task title' };
    return {
      understood: `Add a task called “${title}”.`,
      actions: [{
        capability: 'task.create',
        title,
        payload: { title },
        confidence: 'high', assumptions: [], warnings: [], sources: [],
      }],
      shape: 'task',
    };
  }

  return { reason: 'not an obvious command' };
}

export const isMiss = (r: FastResult | FastMiss): r is FastMiss => 'reason' in r;
