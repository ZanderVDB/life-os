/**
 * Consistency — does the card say what the payload does?
 *
 * ── The failure this exists to catch ─────────────────────────────────────
 *
 * A plan can be perfectly valid and still be a lie. The schema is satisfied,
 * the capability exists, the id resolves — and the card says "Schedule the
 * haircut Saturday" over a payload with no date in it at all. The user reads
 * the sentence, agrees to the sentence, and gets the payload.
 *
 * Schema validation cannot see this: both halves are individually fine and it
 * is the RELATIONSHIP between them that is wrong. Nor can the planner be asked
 * to check its own work — a model that produced an inconsistency is the least
 * reliable judge of whether it did.
 *
 * So this is a deterministic pass, between planning and the user seeing
 * anything, that reads the words on the card and the values in the payload and
 * says where they disagree.
 *
 * ── What it will and will not decide ─────────────────────────────────────
 *
 * It reports; it does not rewrite. A finding is either REPAIRABLE — the turn
 * may ask the planner once, with the specific complaint, before showing
 * anything — or fatal, in which case the action is withheld and the user is
 * told what could not be prepared. Silently correcting a payload to match a
 * sentence would be this file guessing, which is the thing it exists to stop.
 *
 * ── Conservative on purpose ──────────────────────────────────────────────
 *
 * Every check here fires only on a DEFINITE disagreement. A card that mentions
 * no date and a payload with no date agree. A card that mentions a date the
 * payload also contains agrees. Only "the card names Saturday and the payload
 * says Thursday", or "the card names a day and the payload names none", is a
 * finding — because a validator that cries wolf gets the whole stage disabled.
 */
import type { z } from 'zod';
import { resolveDate } from './fastpath.js';

export type Finding = {
  /** Which action, by its index in the plan. */
  index: number;
  code: string;
  /** Written for the planner to act on, and for a person to read in a note. */
  detail: string;
  /** Whether asking the planner again could plausibly fix it. */
  repairable: boolean;
};

export type ValidatableAction = {
  capability: string;
  title: string;
  summary?: string | null;
  payload: Record<string, unknown>;
  assumptions?: string[];
};

/* ══ Reading a Zod schema ════════════════════════════════════════════════ */

/**
 * The field names a capability actually accepts, at the top level and inside
 * a `changes` object.
 *
 * This is what makes the pass SCHEMA-aware rather than a list of field names
 * kept in step by hand: "the card says Saturday and this capability has
 * nowhere to put a date" is a different finding from "it has a date field and
 * left it empty", and only the schema knows which.
 */
export function fieldsOf(schema: z.ZodTypeAny, depth = 0): Set<string> {
  const out = new Set<string>();
  if (!schema || depth > 4) return out;
  const def = (schema as any)._def;
  if (!def) return out;
  const kind = def.typeName;

  if (kind === 'ZodObject') {
    const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
    for (const [key, value] of Object.entries(shape ?? {})) {
      out.add(key);
      /* `{ id, changes: {...} }` is the shape half the mutations use, and the
         fields that matter are inside it. */
      if (key === 'changes' || key === 'draft') {
        for (const inner of fieldsOf(value as z.ZodTypeAny, depth + 1)) out.add(inner);
      }
    }
    return out;
  }
  if (kind === 'ZodEffects') return fieldsOf(def.schema, depth + 1);
  if (kind === 'ZodIntersection') {
    for (const s of [def.left, def.right]) for (const f of fieldsOf(s, depth + 1)) out.add(f);
    return out;
  }
  if (kind === 'ZodOptional' || kind === 'ZodNullable' || kind === 'ZodDefault') {
    return fieldsOf(def.innerType, depth + 1);
  }
  if (kind === 'ZodUnion') {
    for (const s of def.options ?? []) for (const f of fieldsOf(s, depth + 1)) out.add(f);
    return out;
  }
  return out;
}

/** Payload values, flattened through `changes` / `draft`, for value checks. */
function flatten(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload ?? {})) {
    if ((k === 'changes' || k === 'draft') && v && typeof v === 'object') {
      Object.assign(out, v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out;
}

/* ══ Reading the words ═══════════════════════════════════════════════════ */

const DATE_FIELDS = ['dueDate', 'date', 'entryDate', 'targetDate', 'startDate', 'endDate'];
const TIME_FIELDS = ['scheduledAt', 'startsAt', 'endsAt', 'dueTime'];

/** Every date the card's own words commit to, resolved. */
function datesIn(text: string, today: string): string[] {
  const out = new Set<string>();
  /* Scanned clause by clause so a sentence naming two days yields two dates
     rather than only the first. */
  for (const part of text.split(/[,;.]|\band\b|\bthen\b/i)) {
    const hit = resolveDate(part, today);
    if (hit) out.add(hit.date);
  }
  return [...out];
}

/** A time of day the words commit to, as `HH:MM`, or null. */
function timeIn(text: string): string | null {
  const m = text.toLowerCase().match(/\b(?:at|by|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;
  let h = Number(m[1]);
  const suffix = m[3];
  if (suffix === 'pm' && h < 12) h += 12;
  if (suffix === 'am' && h === 12) h = 0;
  /* No meridiem and a small number is not a claim about the afternoon. */
  if (!suffix && h <= 7) return null;
  if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`;
}

/** Does any value in the payload carry this date? */
const carriesDate = (values: Record<string, unknown>, iso: string) =>
  Object.values(values).some((v) => typeof v === 'string' && v.startsWith(iso));

const carriesTime = (values: Record<string, unknown>, hhmm: string) =>
  Object.values(values).some((v) => typeof v === 'string' && v.includes(`T${hhmm}`))
  || Object.values(values).some((v) => v === hhmm);

/* ══ The checks ══════════════════════════════════════════════════════════ */

export type ValidateInput = {
  actions: ValidatableAction[];
  /** Resolved capability schemas, by id. Missing means unresolvable. */
  schemas: Map<string, z.ZodTypeAny>;
  /** `type:id` of everything retrieval actually produced. */
  knownIds: Set<string>;
  today: string;
};

const CREATE_WORDS = /\b(add|create|new|start|set up|make)\b/i;
const CHANGE_WORDS = /\b(move|reschedule|change|update|shift|push|rename|edit|set)\b/i;

export function validatePlan(input: ValidateInput): Finding[] {
  const findings: Finding[] = [];
  const add = (index: number, code: string, detail: string, repairable = true) =>
    findings.push({ index, code, detail, repairable });

  for (const [index, a] of input.actions.entries()) {
    const schema = input.schemas.get(a.capability);
    if (!schema) continue;                        // resolved elsewhere; not this pass's job
    const fields = fieldsOf(schema);
    const values = flatten(a.payload ?? {});
    /* The card's OWN words — never the turn's overall answer, which may be
       describing a different action in the same request. */
    const words = [a.title, a.summary ?? '', ...(a.assumptions ?? [])].join('. ');

    /* ── 1. A date the words promise ────────────────────────────────── */
    const promised = datesIn(words, input.today);
    if (promised.length) {
      const hasDateField = [...DATE_FIELDS, ...TIME_FIELDS].some((f) => fields.has(f));
      const kept = promised.filter((d) => carriesDate(values, d));
      if (!hasDateField && Object.keys(values).length) {
        add(index, 'date_not_supported',
          `“${a.title}” names a date but ${a.capability} has no date field. `
          + 'Either drop the date from the wording or use a capability that can hold it.');
      } else if (hasDateField && !kept.length) {
        add(index, 'date_missing',
          `“${a.title}” says ${promised.join(' and ')} but the payload contains no such date. `
          + 'Put the date in the payload or stop claiming it.');
      }
    }

    /* ── 2. A time the words promise ────────────────────────────────── */
    const clock = timeIn(words);
    if (clock && TIME_FIELDS.some((f) => fields.has(f)) && !carriesTime(values, clock)) {
      add(index, 'time_missing',
        `“${a.title}” says ${clock} but the payload does not contain that time.`);
    }

    /* ── 3. Deadline and intention are different fields ─────────────── */
    const saysDue = /\b(due|deadline|by then|needs to be (done|in)|hand(ed)? in)\b/i.test(words);
    const saysDoIt = /\b(schedule|work on|sit down|block out|spend|do it on|start on)\b/i.test(words);
    if (saysDue && !saysDoIt && fields.has('dueDate')
      && values['dueDate'] == null && values['scheduledAt'] != null) {
      add(index, 'due_vs_scheduled',
        `“${a.title}” describes a deadline but the payload sets scheduledAt. `
        + 'dueDate is the deadline; scheduledAt is when the user intends to do it.');
    }
    if (saysDoIt && !saysDue && fields.has('scheduledAt')
      && values['scheduledAt'] == null && values['dueDate'] != null) {
      add(index, 'scheduled_vs_due',
        `“${a.title}” describes working on it but the payload sets dueDate. `
        + 'scheduledAt is when the user intends to do it; dueDate is the deadline.');
    }

    /* ── 4. Create versus change ────────────────────────────────────── */
    const isCreate = /\.(create|append|add)/i.test(a.capability);
    if (isCreate && CHANGE_WORDS.test(a.title) && !CREATE_WORDS.test(words)) {
      add(index, 'kind_mismatch',
        `“${a.title}” describes changing something that exists, but ${a.capability} `
        + 'creates a new one. Use the update capability with the existing id, or say plainly '
        + 'that the thing could not be found.');
    }

    /* ── 5. Ids must be ids retrieval actually produced ──────────────── */
    for (const [key, v] of Object.entries(values)) {
      if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v)) continue;
      if (key === 'requestId') continue;
      /* Any uuid in a payload is a claim that the thing exists. The claim is
         checkable, and an unchecked one becomes a foreign-key error the user
         sees after they have already agreed to the change. */
      const known = [...input.knownIds].some((k) => k.endsWith(`:${v}`));
      if (!known) {
        add(index, 'unknown_id',
          `“${a.title}” names ${key}=${v}, which was not in the retrieved context. `
          + 'Ids must come from context. If the thing was not found, say so instead.',
          /* Not repairable by re-asking: the id is absent because the thing was
             not retrieved, and another attempt cannot invent it truthfully. */
          false);
      }
    }

    /* ── 6. Impossible on its face ──────────────────────────────────── */
    const start = values['startsAt'];
    const end = values['endsAt'];
    if (typeof start === 'string' && typeof end === 'string'
      && Date.parse(end) <= Date.parse(start)) {
      add(index, 'ends_before_starts', `“${a.title}” ends at or before it starts.`);
    }
    if (values['dueTime'] && values['dueDate'] === null) {
      add(index, 'time_without_date',
        `“${a.title}” has a time of day but no date to put it on.`);
    }
    if ('changes' in (a.payload ?? {})) {
      const changes = a.payload['changes'];
      if (changes && typeof changes === 'object' && !Object.keys(changes).length) {
        add(index, 'empty_change', `“${a.title}” changes nothing.`);
      }
    }
  }

  return findings;
}

/** The complaint handed back to the planner for one repair attempt. */
export function repairBrief(findings: Finding[], actions: ValidatableAction[]): string {
  return findings.filter((f) => f.repairable).map((f) => {
    const a = actions[f.index];
    return `- action ${f.index + 1} (${a?.capability ?? 'unknown'}): ${f.detail}`;
  }).join('\n');
}
