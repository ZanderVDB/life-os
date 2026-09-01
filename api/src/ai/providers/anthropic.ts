/**
 * The Anthropic adapter.
 *
 * ── The only file in Life OS that knows a model vendor exists ────────────
 *
 * Everything else talks to `AiProvider`. This file translates five jobs into
 * HTTP and translates the answers back, and it is the whole surface area a
 * future provider swap would touch.
 *
 * ── Structured output, and why it is not optional ────────────────────────
 *
 * A model asked for JSON returns JSON *usually*. The failure mode is not a
 * parse error — those are easy — it is a plausible object with a field that is
 * subtly wrong: a capability id that does not exist, a date as "next Friday",
 * a payload missing the one property the service requires. Every response here
 * is parsed against a Zod schema, and a schema failure is RETRIED with the
 * error handed back to the model, twice, before the job is failed.
 *
 * Silently accepting a malformed plan would push the problem downstream to the
 * executor, where it becomes an action that fails after the user confirmed it.
 *
 * ── What this adapter cannot do ──────────────────────────────────────────
 *
 * Write. It is handed strings and returns strings; there is no db, no client
 * and no capability object with an `execute` on it anywhere in its arguments.
 */
import { z } from 'zod';
import { calendarWindow, longDate } from '../../lib/civil-date.js';
import { AiProviderError } from '../provider.js';
import type {
  AiProvider, InterpretInput, InterpretOutput, PlanInput, AnswerInput,
  AnswerOutput, ExtractMemoryInput,
} from '../provider.js';
import type { MemoryCandidate } from '../memory.js';

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

/**
 * Model choice per job, overridable by environment.
 *
 * Two tiers, because the jobs are genuinely different: deciding which modules
 * a sentence concerns is a classification, and planning four actions across
 * three systems is not. Defaults name the current family; a deployment that
 * wants something else sets the variable rather than editing code.
 */
export const MODELS = {
  plan: process.env['AI_MODEL_PLAN'] ?? 'claude-sonnet-4-5',
  answer: process.env['AI_MODEL_ANSWER'] ?? 'claude-sonnet-4-5',
  fast: process.env['AI_MODEL_FAST'] ?? 'claude-haiku-4-5-20251001',
} as const;

export const isConfigured = () => Boolean(process.env['ANTHROPIC_API_KEY']);

type CallOpts = {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  /** Seconds. A turn the user is waiting on cannot hang for ever. */
  timeoutMs?: number;
};

/* The shape lives in the provider CONTRACT, so the turn can recognise it
   without importing this file. Kept under the old name here because that is
   what this file has always called it. */
const ProviderError = AiProviderError;
type ProviderError = AiProviderError;

async function call(opts: CallOpts): Promise<string> {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) throw new ProviderError('The assistant is not configured yet.', 'auth');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 45_000);
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': VERSION,
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 2048,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      }),
      signal: ctrl.signal,
    });

    if (r.status === 401 || r.status === 403) {
      throw new ProviderError('The assistant’s credentials were refused.', 'auth');
    }
    if (r.status === 400) {
      /* The account cannot be used — out of credit, a model that is not
         enabled, a request the plan does not allow. NOT a network problem, and
         reporting it as one ("could not be reached") sends whoever is fixing
         it to look at the wrong thing entirely. This is the one case where the
         provider's own sentence is passed through: a 400 here is about the
         ACCOUNT, it is written for the person who owns it, and it carries none
         of the request. Anything unrecognisable falls back to our own words. */
      const detail = await r.json().catch(() => null) as
        { error?: { message?: string; type?: string } } | null;
      const said = detail?.error?.message;
      throw new ProviderError(
        said && said.length < 300
          ? `The assistant could not run: ${said}`
          : 'The assistant’s account cannot be used right now. Check its plan and credit.',
        'auth',
      );
    }
    if (r.status === 429) {
      throw new ProviderError('The assistant is rate limited. Try again shortly.', 'rate');
    }
    if (!r.ok) {
      /* The provider's own error body is not shown to the user — it can carry
         request echoes — but it IS worth the operator's while, so the kind is
         preserved and the detail is dropped. */
      throw new ProviderError('The assistant could not be reached just now.', 'upstream');
    }
    const body = await r.json() as { content?: { type: string; text?: string }[] };
    const text = (body.content ?? [])
      .filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (!text.trim()) throw new ProviderError('The assistant returned nothing.', 'shape');
    return text;
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new ProviderError('The assistant took too long to answer.', 'timeout');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the JSON out of a reply that may be wrapped in prose or a fence.
 *
 * Asking for "only JSON" works most of the time. The times it does not are
 * not worth failing a turn over, and a brace-matched extraction is cheaper and
 * more reliable than another round trip.
 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.search(/[[{]/);
  if (start === -1) throw new ProviderError('The assistant did not return a plan.', 'shape');
  const open = raw[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const c = raw[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); }
        catch { throw new ProviderError('The assistant returned a malformed plan.', 'shape'); }
      }
    }
  }
  throw new ProviderError('The assistant returned a truncated plan.', 'shape');
}

/**
 * Ask, validate, and on a schema failure ask again WITH the failure.
 *
 * Bounded at three attempts. A model that has been told twice exactly which
 * field was wrong and still gets it wrong is not going to be fixed by a fourth
 * try; failing there is faster and more honest than looping.
 */
async function structured<T>(
  schema: z.ZodType<T>, opts: CallOpts, label: string,
): Promise<{ value: T; attempts: number; ms: number }> {
  const started = Date.now();
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const user = attempt === 1 ? opts.user
      : `${opts.user}\n\nYour previous answer was rejected: ${last}\nReturn ONLY valid JSON matching the schema.`;
    const text = await call({ ...opts, user });
    try {
      const parsed = schema.safeParse(extractJson(text));
      if (parsed.success) {
        return { value: parsed.data, attempts: attempt, ms: Date.now() - started };
      }
      last = parsed.error.issues.slice(0, 4)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    } catch (e) {
      if (e instanceof ProviderError && e.kind !== 'shape') throw e;
      last = (e as Error).message;
    }
  }
  throw new ProviderError(`The assistant could not produce a valid ${label}.`, 'shape');
}

/* ══ Schemas the model must satisfy ══════════════════════════════════════ */

const InterpretSchema = z.object({
  understood: z.string().min(1).max(400),
  intent: z.enum(['question', 'change', 'both', 'unclear']),
  modules: z.array(z.string().max(40)).max(12).default([]),
  queries: z.array(z.string().max(200)).max(5).default([]),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});

const PlanActionSchema = z.object({
  capability: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  summary: z.string().max(400).nullish(),
  payload: z.record(z.unknown()),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  assumptions: z.array(z.string().max(240)).max(6).default([]),
  warnings: z.array(z.string().max(240)).max(6).default([]),
  sources: z.array(z.string().max(80)).max(10).default([]),
});

/**
 * An edit to the proposal already on the table.
 *
 * Separate from `actions` on purpose. An amendment is not a new change; it is
 * a correction to one the user is still looking at, and routing it through the
 * card's own validated edit path is what keeps "actually Saturday" from
 * becoming a second haircut.
 */
const PlanAmendSchema = z.object({
  actionId: z.string().min(1).max(80),
  enabled: z.boolean().nullish(),
  fields: z.record(z.union([z.string(), z.number(), z.null()])).nullish(),
});

const PlanSchema = z.object({
  understood: z.string().min(1).max(400),
  answer: z.string().max(3000).nullish(),
  actions: z.array(PlanActionSchema).max(12).default([]),
  amend: z.array(PlanAmendSchema).max(25).default([]),
  clarification: z.object({
    question: z.string().min(1).max(300),
    options: z.array(z.object({
      id: z.string().max(80),
      label: z.string().max(200),
      /* "type:id" from CONTEXT. The server verifies it against what was
         actually retrieved and drops it if it names nothing real — an
         invented ref is treated exactly like an invented payload id. */
      ref: z.string().max(80).nullish(),
      detail: z.string().max(120).nullish(),
    })).min(2).max(6),
  }).nullish(),
});

const AnswerSchema = z.object({
  answer: z.string().min(1).max(3000),
  cited: z.array(z.string().max(80)).max(20).default([]),
});

const MemorySchema = z.object({
  candidates: z.array(z.object({
    category: z.enum(['profile', 'preferences', 'people', 'places', 'routines',
      'work_style', 'communication', 'defaults', 'interests', 'other']),
    fact: z.string().min(3).max(300),
    confidence: z.number().min(0).max(1).default(0.6),
    evidence: z.string().max(240).nullish(),
  })).max(6).default([]),
});

/* ══ Prompts ═════════════════════════════════════════════════════════════ */

/**
 * What the model is told, and what it is merely told AGAIN.
 *
 * Most of what follows is also enforced in code, and that is the point. A rule
 * that exists only here is a rule the model can decide not to follow at three
 * in the morning; a rule that exists only in code produces a refusal the model
 * cannot explain. So the ones that would corrupt data if broken are enforced
 * by the registry, the schemas and the consistency pass — and repeated here so
 * that the plan is usually right the first time rather than merely rejected
 * correctly.
 *
 * Enforced elsewhere, whatever this text says:
 *   capability whitelist   registry.resolve — an unlisted id resolves to null
 *   payload shape          the capability's own Zod schema, at plan time
 *   ids exist              validate.ts: a uuid not in CONTEXT is refused
 *   card matches payload   validate.ts: a stated date the payload lacks is refused
 *   who needs confirming   the capability's risk, assigned by the server
 *   external writes        calendar's propose/execute ledger
 */
const RULES = `You are the reasoning layer inside Life OS, a personal command centre.

You do not perform actions. You propose them. A proposal the user edits and
confirms is carried out by Life OS itself, through the same services its
buttons use. Never claim to have done something.

Hard rules:
- You may ONLY use capabilities listed for you. If something is not listed, it
  is not available - say so plainly rather than inventing an alternative.
- Some modules can be READ but not changed. If the user asks for a change there,
  say what you can see and that the change is not available - do not propose it
  and do not pretend the thing does not exist.
- Entity ids come from the CONTEXT you were given. Never invent a uuid. If you
  cannot find the thing being referred to, say so or ask.
- CONTEXT IS EVERYTHING YOU HAVE. There is no way for you to fetch more: it has
  already been retrieved for you. Never say you need to read, check or look at
  something - answer from what is there, and if a fact is genuinely absent say
  which fact is missing.
- dueDate is a DEADLINE - the day something must be FINISHED. scheduledAt is
  WHEN THE USER INTENDS TO DO IT. They are different facts about different
  moments, and neither is ever written from the other. Getting the date right
  and the field wrong is still wrong.
- WHEN THE REQUEST DOES NOT SAY WHICH, ASK. It is not a small call to make on
  somebody's behalf: a deadline that was meant as a plan nags early, and a plan
  that was meant as a deadline goes silently past. TIMING below tells you which
  reading the request supports; when it says "ambiguous", clarify.
- A task due date is NOT a calendar event. Reserving time is a separate action.
- A reminder is a Life OS record and never a Google event. Prefer a reminder
  when the user asked to be reminded rather than to hold time.
- A project's status and its focus are independent. Change only what was asked.
- Every date or time you state in a title, summary or assumption MUST also be
  in the payload. A card that says Saturday over a payload with no date is a
  card that lies to the person confirming it.
- Write British English, plainly. No exclamation marks, no filler.
- FORMATTING: short paragraphs separated by a blank line, **bold** for a word
  or two, and hyphen bullets or "1." numbers for a genuine list. That is the
  whole set the surface renders. Headings, tables, links and code fences are
  not rendered - their markers are stripped and the words kept - so do not use
  them.
- NEVER STATE A COUNT YOU DO NOT THEN LIST, and never write a placeholder
  bullet. "Two more without a priority set: - (no other tasks visible)" is a
  list you could not fill; either name the two or do not mention them. If
  something is genuinely absent from CONTEXT, say so in a sentence.`;

const fmt = (o: unknown) => JSON.stringify(o, null, 1);

/**
 * The next fortnight, resolved, as a line the model reads rather than a sum
 * it performs.
 *
 * Being told "Today is 2026-09-01" and asked for "Saturday" requires working
 * out that 2026-09-01 is a Tuesday and counting forward. Models get that wrong
 * often enough to matter — the same sentence produced 5 September in one run
 * and 6 September in the next, and both are valid ISO dates so nothing
 * downstream could tell which was right. Handing over the calendar turns
 * arithmetic into a lookup.
 */
const dateBriefing = (today: string) => [
  `TODAY IS ${longDate(today)} (${today}).`,
  '',
  "TODAY'S CALENDAR. Take dates from this table; never calculate one:",
  calendarWindow(today, 14).map((d, i) => {
    const tag = i === 0 ? '  <- today' : i === 1 ? '  <- tomorrow' : '';
    return `  ${d.date}  ${d.weekday}${tag}`;
  }).join('\n'),
  '',
  'A weekday NAME with no other qualifier means the NEXT one and never today:',
  'on a Tuesday, "Friday" is this coming Friday and "Tuesday" is a week away.',
  '"this Friday" is the same as "Friday". "next Friday" is seven days later',
  'than that. Anything further out than this table, say you are not sure which',
  'date is meant and ask.',
].join('\n');

/* ══ The provider ════════════════════════════════════════════════════════ */

export type ProviderMetrics = { job: string; model: string; ms: number; attempts: number };

/** Filled in by each call so a turn can report what it cost. */
export const lastMetrics: ProviderMetrics[] = [];
const note = (m: ProviderMetrics) => {
  lastMetrics.push(m);
  if (lastMetrics.length > 50) lastMetrics.shift();
};

export const anthropicProvider: AiProvider = {
  id: 'anthropic',
  label: 'Claude',
  model: MODELS.plan,

  async interpret(input: InterpretInput): Promise<InterpretOutput> {
    const r = await structured(InterpretSchema, {
      model: MODELS.fast,
      maxTokens: 512,
      timeoutMs: 20_000,
      system: `${RULES}

Classify one request. Return ONLY JSON:
{"understood": string, "intent": "question"|"change"|"both"|"unclear",
 "modules": string[], "queries": string[], "confidence": "high"|"medium"|"low"}

"modules" are which of the available module ids the request concerns - be
narrow, this decides what is retrieved.

"queries" are fed to a SUBSTRING search over titles. Give the distinctive words
a title would actually contain - names, nouns, one or two words each - not the
sentence and not a verb phrase. "I finished reconciling against the bank" gives
["reconcile", "bank"], never ["reconciling against the bank"].`,
      user: `${dateBriefing(input.request.today)}
Available modules: ${input.modules.join(', ')}

Request: ${JSON.stringify(input.text)}`,
    }, 'interpretation');
    note({ job: 'interpret', model: MODELS.fast, ms: r.ms, attempts: r.attempts });
    return {
      understood: r.value.understood,
      intent: r.value.intent,
      modules: r.value.modules ?? [],
      queries: r.value.queries ?? [],
      confidence: r.value.confidence ?? 'medium',
    };
  },

  async plan(input: PlanInput) {
    const r = await structured(PlanSchema, {
      model: MODELS.plan,
      maxTokens: 4096,
      system: `${RULES}

Produce a plan. Return ONLY JSON:
{"understood": string,
 "answer": string | null,
 "actions": [{"capability": string, "title": string, "summary": string | null,
              "payload": object, "confidence": "high"|"medium"|"low",
              "assumptions": string[], "warnings": string[], "sources": string[]}],
 "amend": [{"actionId": string, "enabled": boolean|null, "fields": object|null}],
 "clarification": {"question": string,
                   "options": [{"id","label","ref","detail"}]} | null}

A request can be a question, changes, or both. Answer the informational part in
"answer" and put every change in "actions" - do not describe a change in prose
instead of proposing it, and do not propose an action for something that was
only a question.

One action per distinct change. "I finished X and remind me about Y" is two.
"Add milk and chicken" is two tasks, not one. Never drop a change because
another one in the same sentence was hard — propose every part you can.

"payload" must match the capability's input schema exactly. Ids must come from
CONTEXT. "sources" are "type:id" strings from CONTEXT that justify the action.

CAPABILITIES lists only things that CHANGE something. Reading has already
happened — everything available is in CONTEXT. There is no search action.

CREATE VERSUS CHANGE. A capability that acts on something that already exists
takes its id, and that id must appear in CONTEXT. If the thing is not in
CONTEXT it does not exist as far as you are concerned:
- use the CREATE capability, or
- say in the answer that you could not find it, or ask which one is meant.
Never call a change capability without the id it requires, and never invent
one. "I need a haircut tomorrow" is a NEW task — task.create — not a schedule
or an update of something you cannot see.

WHAT THE DATE MEANS
TIMING is read from the user's own words before you see them, and it is not a
suggestion. Resolving the date correctly is a different problem from choosing
the right field, and only the second one is yours:

  reading=deadline    it must be FINISHED by then -> dueDate
  reading=scheduled   they intend to DO it then -> scheduledAt, or a calendar
                      action when block=true and they asked for time to be
                      HELD. Choose that from the capabilities you were given,
                      not from the wording.
  reading=reminder    they want to be TOLD -> a reminder. Neither field.
  reading=none        no date. Set neither.
  reading=ambiguous   a date, and nothing saying which it is. DO NOT CHOOSE.
                      Return a clarification for that part and no action:
                        question: what the date means for <the thing>
                        options:  "Do it then" / "Have it done by then"
                      Everything unambiguous in the same request is still
                      proposed alongside it.

A clock time is never a deadline: dueDate holds a day, so "Saturday at 10" is
always a plan and never a due date.

MEMORY AND DEFAULTS NEVER DECIDE THIS. Explicit words in the request beat any
learned preference; a preference cannot turn an ambiguous date into a deadline.

DATES COME FROM TODAY'S CALENDAR, NEVER FROM ARITHMETIC. It is above, it is
resolved, and it is right. Look the day up. If you write an assumption naming
a weekday, the date in the payload must be the row for that weekday - a card
saying "Saturday" over a date that is a Sunday is refused before the user ever
sees it.

DATE AND TIME FORMATS, exactly:
- dueDate, date, targetDate, entryDate: "YYYY-MM-DD"
- scheduledAt, startsAt, endsAt: full ISO-8601 with an offset,
  e.g. "2026-09-02T14:00:00+02:00"
- dueTime: "HH:MM"
Never put a bare date where a datetime is required. If you only know the day,
use the dueDate field rather than inventing a time.

If an assumption states a resolved value - "Friday means 2026-09-05" - that
value MUST also appear in the payload. An assumption describing a date the
payload does not contain produces a card that says one thing and does another.

CONFIDENCE AND ASSUMPTIONS
- high: the request said it. Propose it, no assumption needed.
- medium: you interpreted something. Propose it AND write the interpretation in
  "assumptions" in one plain sentence - e.g. "Read as a deadline, not a working
  session."
- low AND the consequence matters (several things match, or it is destructive
  or external): return "clarification" instead of guessing, and return no
  actions for that part. Everything unambiguous in the same request should
  still be proposed.

Do not ask for clarification about small reversible things. An editable card
absorbs ordinary uncertainty; a question costs the user a turn.

CLARIFICATION OPTIONS MUST NAME THINGS, NOT DESCRIBE THEM. When the choice is
between entities that exist, put the "type:id" from CONTEXT in "ref" and one
distinguishing line - a date, a project, a status - in "detail". An option
without a ref is right only when the choice is not an entity at all ("leave
them open" / "cancel them").

AMENDING WHAT IS PENDING
If PENDING is present, the user is looking at changes that have NOT happened
yet. A correction to them - "actually Saturday", "make it 4", "don't add the
milk", "only the first two" - is an AMENDMENT, not a new request. Put it in
"amend", naming the pending action id, and return NO action for that part:
  "amend": [{"actionId": "a2", "fields": {"dueDate": "2026-09-05"}}]
  "amend": [{"actionId": "a1", "enabled": false}]
Never propose a new action to fix a pending one, and never say a pending thing
cannot be found: it has not been created, so of course it is not in CONTEXT.
Only genuinely new requests go in "actions" while something is pending.

MEMORY may inform defaults. It never overrides an explicit instruction or a
fact from CONTEXT.`,
      user: [
        dateBriefing(input.request.today),
        input.request.timeZone ? `The user is in ${input.request.timeZone}.` : '',
        input.request.surface ? `The user is looking at: ${fmt(input.request.surface)}` : '',
        '',
        'CAPABILITIES YOU MAY USE. "payload" is the exact shape that capability',
        'accepts - use those field names, and include every one not marked optional:',
        fmt(input.capabilities),
        '',
        input.readOnly?.length
          ? `READABLE BUT NOT CHANGEABLE RIGHT NOW:\n${fmt(input.readOnly)}` : '',
        /* WHY something is missing, not merely that it is. Without this the
           only available answer about a disconnected calendar is silence, and
           silence reads to the user as "I could not find your meeting". */
        input.unavailable?.length
          ? 'NOT AVAILABLE AT ALL. If the request needs one of these, say so using '
            + `this reason - do not say the thing does not exist:\n${fmt(input.unavailable)}` : '',
        '',
        'MODULE RULES:',
        fmt(input.rules),
        '',
        'CONTEXT (the only real ids that exist). "days" maps each date a row',
        'mentions to its weekday - use it rather than working one out:',
        fmt(input.sources),
        '',
        input.pending
          ? 'PENDING - proposed, not yet confirmed, and absent from CONTEXT because '
            + `it does not exist yet:\n${fmt(input.pending)}` : '',
        '',
        input.timing
          ? `TIMING: ${fmt(input.timing)}` : '',
        '',
        input.resolved
          ? `The user has just chosen: ${JSON.stringify(input.resolved.label)}`
            + `${input.resolved.ref ? ` = ${input.resolved.ref.type}:${input.resolved.ref.id}` : ''}.`
            + ' Use that exact id; the ambiguity is settled.' : '',
        '',
        input.memory.length ? `MEMORY about this user:\n${fmt(input.memory)}` : '',
        '',
        input.repair
          ? `YOUR PREVIOUS PLAN CONTRADICTED ITSELF:\n${input.repair.problems}\n`
            + 'Return a corrected plan. Either put the stated value in the payload or '
            + 'stop stating it - do not repeat the same contradiction.' : '',
        '',
        `REQUEST: ${JSON.stringify(input.text)}`,
      ].filter(Boolean).join('\n'),
    }, 'plan');
    note({ job: 'plan', model: MODELS.plan, ms: r.ms, attempts: r.attempts });
    return {
      id: '',
      request: input.text,
      understood: r.value.understood,
      answer: r.value.answer ?? null,
      actions: r.value.actions as any,
      amend: (r.value.amend ?? []) as any,
      clarification: (r.value.clarification ?? null) as any,
    };
  },

  async answer(input: AnswerInput): Promise<AnswerOutput> {
    const r = await structured(AnswerSchema, {
      model: MODELS.answer,
      maxTokens: 1500,
      system: `${RULES}

Answer the question from CONTEXT only. Return ONLY JSON:
{"answer": string, "cited": string[]}

"cited" holds the "type:id" strings you actually used. If CONTEXT does not
contain the answer, say what is missing rather than guessing. Be brief - a few
sentences or a short list. Do not repeat the question back.`,
      user: [
        dateBriefing(input.request.today),
        'CONTEXT. "days" maps each date a row mentions to its weekday. Never',
        'name a weekday that is not the one written there, and never work one',
        'out yourself:',
        fmt(input.sources),
        '',
        `QUESTION: ${JSON.stringify(input.question)}`,
      ].join('\n'),
    }, 'answer');
    note({ job: 'answer', model: MODELS.answer, ms: r.ms, attempts: r.attempts });
    return { answer: r.value.answer, cited: r.value.cited ?? [] };
  },

  async summarise({ text, maxWords = 40 }) {
    const out = await call({
      model: MODELS.fast,
      maxTokens: 300,
      timeoutMs: 20_000,
      system: 'Condense the text. Plain British English, no preamble. Return only the summary.',
      user: `In at most ${maxWords} words:\n\n${text}`,
    });
    return out.trim();
  },

  async extractMemory(input: ExtractMemoryInput): Promise<MemoryCandidate[]> {
    const r = await structured(MemorySchema, {
      model: MODELS.fast,
      maxTokens: 800,
      timeoutMs: 20_000,
      system: `${RULES}

Notice DURABLE facts about the person. Return ONLY JSON:
{"candidates": [{"category": ..., "fact": string, "confidence": number, "evidence": string|null}]}

A memory must be all three of: durable, useful, and about the PERSON.

YES: "Prefers afternoon meetings." "John Mercer works with them on WebAnchor."
     "Normally goes to the gym before work." "Prefers concise emails."
NO:  "Buy milk tomorrow." "Finished the proposal." "Moved the meeting."
     Those are Life OS records, not facts about the person.

Return an empty array when nothing qualifies, which is the usual case. Do not
record anything sensitive - health, finances, credentials, other people's
private details - unless the user plainly asked you to remember it.
Do not repeat anything already in KNOWN.`,
      user: [
        input.known.length ? `KNOWN:\n${fmt(input.known.map((k) => k.fact))}` : 'KNOWN: (nothing yet)',
        '',
        `TEXT: ${JSON.stringify(input.text)}`,
      ].join('\n'),
    }, 'memory extraction');
    note({ job: 'extractMemory', model: MODELS.fast, ms: r.ms, attempts: r.attempts });
    return r.value.candidates as MemoryCandidate[];
  },
};

export { ProviderError };
