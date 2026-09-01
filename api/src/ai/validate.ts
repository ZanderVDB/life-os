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
import {
  resolveRelativeDate, weekdayNamesIn, isWeekday, weekdayOf, nextWeekday,
  longDate, isCivilDate,
} from '../lib/civil-date.js';
import type { TimingIntent } from '../lib/timing-intent.js';

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

/**
 * The payload shape, in a line a planner can copy.
 *
 * ── The failure this removes ─────────────────────────────────────────────
 *
 * The planner was given a capability's id, module, description and risk, and
 * NOT its schema. So it had to infer the field names from an English sentence,
 * which works for `title` and `dueDate` because those are the obvious words —
 * and fails for `task.complete`, whose description reads "mark a task done"
 * and mentions no field at all. The model proposed the right capability
 * against the right task and left out `id`, repeatedly, because nothing had
 * ever told it there was one.
 *
 * Generated FROM the Zod schema rather than written beside it, so it cannot
 * drift: change the capability's input and the sentence the planner reads
 * changes with it. This is the same principle as taking the capability list
 * from the registry — the machine-checked thing is also the described thing.
 */
export function signatureOf(schema: z.ZodTypeAny, depth = 0): unknown {
  const def = (schema as any)?._def;
  if (!def || depth > 3) return 'value';
  const kind = def.typeName;

  switch (kind) {
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(shape ?? {})) {
        const inner = signatureOf(value as z.ZodTypeAny, depth + 1);
        const optional = (value as any)?.isOptional?.() ?? false;
        out[key] = optional && typeof inner === 'string' ? `${inner}, optional` : inner;
      }
      return out;
    }
    case 'ZodString': {
      const checks = def.checks ?? [];
      if (checks.some((c: any) => c.kind === 'uuid')) return 'uuid from CONTEXT';
      if (checks.some((c: any) => c.kind === 'datetime')) return 'ISO datetime with offset';
      const re = checks.find((c: any) => c.kind === 'regex')?.regex?.source ?? '';
      if (re.includes('\\d{4}')) return 'YYYY-MM-DD';
      if (re.includes('\\d{2}:')) return 'HH:MM';
      return 'string';
    }
    case 'ZodNumber': return 'number';
    case 'ZodBoolean': return 'boolean';
    case 'ZodEnum': return (def.values ?? []).join('|');
    case 'ZodNativeEnum': return 'enum';
    case 'ZodArray': return [signatureOf(def.type, depth + 1)];
    case 'ZodRecord': return 'object';
    case 'ZodOptional': case 'ZodNullable': case 'ZodDefault':
      return signatureOf(def.innerType, depth + 1);
    case 'ZodEffects': return signatureOf(def.schema, depth + 1);
    case 'ZodIntersection': {
      const left = signatureOf(def.left, depth + 1);
      const right = signatureOf(def.right, depth + 1);
      return (typeof left === 'object' && typeof right === 'object')
        ? { ...(left as object), ...(right as object) } : left;
    }
    case 'ZodUnion': return signatureOf((def.options ?? [])[0], depth + 1);
    default: return 'value';
  }
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
    const hit = resolveRelativeDate(part, today);
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

/**
 * Does any value in the payload carry this date?
 *
 * `bucket` counts, and it has to. "Today" is a board COLUMN in Life OS as well
 * as a day, so a card reading "Add chicken to the Today list" over a payload
 * with `bucket: 'today'` and no due date is not lying about anything — it is
 * describing the bucket. Without this the check refused a correct action and
 * told the user their shopping could not be prepared, which is the exact
 * failure mode a validator that cries wolf produces.
 */
const carriesDate = (values: Record<string, unknown>, iso: string, today: string) => {
  if (Object.values(values).some((v) => typeof v === 'string' && v.startsWith(iso))) return true;
  return iso === today && values['bucket'] === 'today';
};

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
  /**
   * What the date in the USER'S request meant, read deterministically.
   *
   * The checks below that use it are the only ones that look outside the card.
   * They have to: "I need a haircut Saturday" produced a card saying
   * "deadline" over a payload setting `dueDate`, which agrees with itself
   * perfectly and disagrees with the person who said neither.
   */
  timing?: TimingIntent;
  /** True when the plan asked a question rather than deciding. */
  asking?: boolean;
};

/** Fields where a task's two meanings of "when" actually compete. */
const DUE_FIELD = 'dueDate';
const DO_FIELDS = ['scheduledAt', 'startsAt'];

const CREATE_WORDS = /\b(add|create|new|start|set up|make)\b/i;
const CHANGE_WORDS = /\b(move|reschedule|change|update|shift|push|rename|edit|set)\b/i;

export function validatePlan(input: ValidateInput): Finding[] {
  const findings: Finding[] = [];
  const add = (index: number, code: string, detail: string, repairable = true) =>
    findings.push({ index, code, detail, repairable });

  for (const [index, a] of input.actions.entries()) {
    const schema = input.schemas.get(a.capability);
    if (!schema) continue;                        // resolved elsewhere; not this pass's job

    /* ── 0. Does the payload even fit the schema ────────────────────────
     *
     * This used to be checked further downstream, where a failure could only
     * become a note: "Complete 'Price three options' — no id was given."
     * True, unhelpful, and avoidable — the model had the task in front of it
     * and left the field out.
     *
     * Checked HERE it becomes repairable, and the repair pass already knows
     * how to hand a model one precise complaint. Which is the whole point of
     * having a repair pass: "you left out the id" is exactly the kind of
     * mistake a second attempt fixes, and exactly the kind a user should
     * never have to see. */
    const shape = schema.safeParse(a.payload ?? {});
    if (!shape.success) {
      const issue = shape.error.issues[0];
      const field = issue?.path?.filter((x) => typeof x === 'string').join('.') ?? '';
      const detail = issue?.message === 'Required' && field
        ? `no ${field} was given`
        : `${field ? `${field}: ` : ''}${(issue?.message ?? 'invalid').toLowerCase()}`;
      add(index, 'payload_invalid',
        `“${a.title}” does not fit ${a.capability}: ${detail}. `
        + 'Every required field must be present, and any id must come from CONTEXT.');
      /* The rest of the checks read values that are not there. Reporting six
         consequences of one cause is noise. */
      continue;
    }

    const fields = fieldsOf(schema);
    /* The PARSED payload, so schema defaults are part of what is checked. A
       task created with no bucket really does land on Today, and the card is
       entitled to say so. */
    const values = flatten((shape.data ?? a.payload ?? {}) as Record<string, unknown>);
    /* The card's OWN words — never the turn's overall answer, which may be
       describing a different action in the same request. */
    const words = [a.title, a.summary ?? '', ...(a.assumptions ?? [])].join('. ');

    /* ── 1. A date the words promise ────────────────────────────────── */
    const promised = datesIn(words, input.today);
    if (promised.length) {
      const hasDateField = [...DATE_FIELDS, ...TIME_FIELDS].some((f) => fields.has(f));
      const kept = promised.filter((d) => carriesDate(values, d, input.today));
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

    /* ── 1b. A weekday the words NAME must be the weekday it lands on ──
     *
     * The hole the date bug went through. `date_missing` asks "does the
     * payload carry one of the dates the words promise" — and a card reading
     * "Haircut on Saturday" with the assumption "Saturday means 2026-09-06"
     * over a payload of 2026-09-06 answers yes. Self-consistent, valid ISO,
     * and wrong: 6 September 2026 is a Sunday.
     *
     * A weekday NAME is the one piece of prose with exactly one right answer,
     * so it is checkable without parsing anything. If the words say Saturday,
     * every date in the payload that the words are about has to be a
     * Saturday. */
    const named = weekdayNamesIn(words);
    if (named.length) {
      const dated = Object.entries(values)
        .filter(([, v]) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))
        .map(([k, v]) => [k, String(v).slice(0, 10)] as const);
      for (const [key, iso] of dated) {
        if (!isCivilDate(iso)) continue;
        if (named.some((n) => isWeekday(iso, n))) continue;
        /* The RIGHT date, not just the wrong one. "Use the calendar" left the
           model to look it up again and it drifted again; naming the row turns
           the repair from a complaint into an answer — the same thing that
           made handing over payload shapes work. */
        const right = named.map((n) => `${n} is ${nextWeekday(input.today, n)}`).join(', ');
        add(index, 'weekday_mismatch',
          `“${a.title}” says ${named.join(' and ')} but ${key}=${iso} is a `
          + `${longDate(iso).split(',')[0]}. From TODAY'S CALENDAR, ${right}. `
          + `Use that date and keep any time of day you had.`);
      }
    }

    /* ── 2. A time the words promise ────────────────────────────────── */
    const clock = timeIn(words);
    if (clock && TIME_FIELDS.some((f) => fields.has(f)) && !carriesTime(values, clock)) {
      add(index, 'time_missing',
        `“${a.title}” says ${clock} but the payload does not contain that time.`);
    }

    /* ── 3. Deadline and intention are different fields ───────────────
     *
     * Read from the USER'S words, not the card's. The card agreeing with
     * itself is exactly the failure: "I need a haircut Saturday" produced a
     * card saying "deadline" over a payload setting `dueDate`, and every
     * check that compared the two was satisfied.
     *
     * Only where the fields genuinely COMPETE. A reminder's `dueDate` is when
     * it fires and has no rival; a diary date is the day it belongs to. The
     * choice is real only when one capability offers both, which the schema
     * knows and no list here has to remember. */
    const due = values[DUE_FIELD];
    const doAt = DO_FIELDS.map((f) => values[f]).find((v) => v != null);
    const competes = fields.has(DUE_FIELD) && DO_FIELDS.some((f) => fields.has(f));
    const setsDue = due != null;
    const setsDo = doAt != null;

    if (competes && (setsDue || setsDo) && input.timing) {
      const { reading, matched } = input.timing;
      if (reading === 'deadline' && setsDo && !setsDue) {
        add(index, 'scheduled_vs_due',
          `The request said “${matched}”, which is a deadline, but the payload sets `
          + `${DO_FIELDS.find((f) => values[f] != null)}. Use dueDate.`);
      } else if (reading === 'scheduled' && setsDue && !setsDo) {
        add(index, 'due_vs_scheduled',
          `The request said “${matched}”, which is when the user intends to DO it, but `
          + 'the payload sets dueDate. Use scheduledAt, or a calendar action if they '
          + 'asked for time to be held.');
      } else if (reading === 'ambiguous' && !input.asking) {
        /* The one that shipped. A date with nothing saying which field it is,
           silently written into one of them. */
        add(index, 'timing_ambiguous',
          `“${a.title}” chose between a deadline and a working time, and the request `
          + 'said neither. Do NOT choose. Return a clarification asking what the date '
          + 'means — "Do it then" or "Have it done by then" — and no action for this '
          + 'part.');
      }
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
        /* Repairable, but not by finding the id — it does not exist. The
           honest second attempt is a DIFFERENT action: create the thing, or
           say plainly that it could not be found. The brief says so. */
        add(index, 'unknown_id',
          `“${a.title}” names ${key}=${v}, which was not in the retrieved context. `
          + 'Ids must come from CONTEXT. If the thing is not there it does not exist: '
          + 'use the create capability instead, or drop the action and say in "answer" '
          + 'that you could not find it. Do not invent another id.');
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

/**
 * Do these words still describe this payload?
 *
 * Used after an EDIT, which is the one place the consistency pass cannot
 * reach: it runs between planning and the user, and an amendment happens
 * after. "Actually make it Monday" changed the date field and left the card's
 * own sentence saying "Saturday 5 September" — a card that says one thing and
 * does another, which is precisely what this file exists to prevent, arriving
 * by the one door it was not watching.
 */
export function stillDescribes(words: string, payload: Record<string, unknown>, today: string) {
  const values = flatten(payload ?? {});
  for (const d of datesIn(words, today)) if (!carriesDate(values, d, today)) return false;
  const clock = timeIn(words);
  if (clock && !carriesTime(values, clock)) return false;
  /* A weekday named in prose that no longer matches the date is the same lie
     by a different route: "Saturday 5 September" over a field the amendment
     moved to Monday. */
  const named = weekdayNamesIn(words);
  if (named.length) {
    for (const v of Object.values(values)) {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) continue;
      if (!named.some((n) => isWeekday(v.slice(0, 10), n))) return false;
    }
  }
  return true;
}

/**
 * The named day, applied to the payload the model wrote.
 *
 * ── Why correct rather than ask again ────────────────────────────────────
 *
 * The user said "Friday". `civil-date.ts` says Friday is the 4th. The model
 * wrote the 5th while its own card said Friday. There is nothing to decide
 * here — the right answer is already known, deterministically, and asking a
 * model to look it up a second time was tried: told in plain words that Friday
 * is the 4th, it produced the 5th again, and the action was withheld. The user
 * asked for something unambiguous and got nothing.
 *
 * So the resolved date is applied, and the card shows it before anything is
 * confirmed. This is the same resolver the whole date path uses, reaching the
 * one field the model mislabelled.
 *
 * ── When it refuses ──────────────────────────────────────────────────────
 *
 * Exactly one weekday named, exactly one date in the payload. Two of either
 * and there is no single right answer — "move it from Friday to the 9th" names
 * a day it is deliberately NOT using — so nothing is touched and the finding
 * stands. A time of day is kept exactly as written: only the day was wrong.
 */
export function applyNamedWeekday(
  words: string, payload: Record<string, unknown>, today: string,
): { payload: Record<string, unknown>; changed: string | null } {
  const named = weekdayNamesIn(words);
  if (named.length !== 1) return { payload, changed: null };
  const want = nextWeekday(today, named[0]!);

  const flat = flatten(payload ?? {});
  const dated = Object.entries(flat)
    .filter(([, v]) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v as string));
  if (dated.length !== 1) return { payload, changed: null };

  const [key, value] = dated[0] as [string, string];
  const iso = value.slice(0, 10);
  if (!isCivilDate(iso) || iso === want) return { payload, changed: null };

  const next = structuredClone(payload) as Record<string, unknown>;
  const target = (next['changes'] ?? next['draft'] ?? next) as Record<string, unknown>;
  if (!(key in target)) return { payload, changed: null };
  /* The rest of the string is the time of day and its offset. Only the ten
     characters that were wrong are replaced. */
  target[key] = `${want}${value.slice(10)}`;
  return { payload: next, changed: `${key}: ${iso} -> ${want}` };
}

/**
 * The same words, with a stale weekday corrected.
 *
 * A card's TITLE is the model's label for a value — "Set haircut deadline to
 * Saturday" — and an amendment changes the value underneath it. Dropping the
 * title is not an option, because it is how the card is identified; leaving it
 * is the lie this whole pass exists to remove.
 *
 * So the one word that has gone wrong is corrected, deterministically: the
 * weekday named is replaced by the weekday the date actually falls on. No
 * model, no rewriting of anything else, and only when the payload names
 * exactly one date — with two there is no single right answer and the words
 * are left alone for the summary rule to handle.
 */
export function retitleForDate(title: string, payload: Record<string, unknown>): string {
  const named = weekdayNamesIn(title);
  if (!named.length) return title;
  const dates = [...new Set(Object.values(flatten(payload ?? {}))
    .filter((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))
    .map((v) => v.slice(0, 10))
    .filter(isCivilDate))];
  if (dates.length !== 1) return title;

  const actual = weekdayOf(dates[0]!);
  if (named.includes(actual)) return title;

  let out = title;
  for (const wrong of named) {
    out = out.replace(new RegExp(`\\b${wrong}\\b`, 'gi'),
      (m) => (m[0] === m[0]!.toUpperCase()
        ? actual.charAt(0).toUpperCase() + actual.slice(1) : actual));
  }
  return out;
}

/** The complaint handed back to the planner for one repair attempt. */
export function repairBrief(findings: Finding[], actions: ValidatableAction[]): string {
  return findings.filter((f) => f.repairable).map((f) => {
    const a = actions[f.index];
    return `- action ${f.index + 1} (${a?.capability ?? 'unknown'}): ${f.detail}`;
  }).join('\n');
}
