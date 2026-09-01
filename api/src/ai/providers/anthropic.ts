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

class ProviderError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'timeout' | 'rate' | 'upstream' | 'shape') {
    super(message);
  }
}

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

const PlanSchema = z.object({
  understood: z.string().min(1).max(400),
  answer: z.string().max(3000).nullish(),
  actions: z.array(PlanActionSchema).max(12).default([]),
  clarification: z.object({
    question: z.string().min(1).max(300),
    options: z.array(z.object({
      id: z.string().max(80),
      label: z.string().max(200),
      ref: z.string().max(80).nullish(),
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

const RULES = `You are the reasoning layer inside Life OS, a personal command centre.

You do not perform actions. You propose them. A proposal the user edits and
confirms is carried out by Life OS itself, through the same services its
buttons use. Never claim to have done something.

Hard rules:
- You may ONLY use capabilities listed for you. If something is not listed, it
  is not available - say so plainly rather than inventing an alternative.
- Entity ids come from the CONTEXT you were given. Never invent a uuid. If you
  cannot find the thing being referred to, say so or ask.
- dueDate is a DEADLINE. scheduledAt is WHEN THE USER INTENDS TO DO IT. They
  are different facts. Never write one from the other.
- A task due date is NOT a calendar event. Reserving time is a separate action.
- A reminder is a Life OS record and never a Google event. Prefer a reminder
  when the user asked to be reminded rather than to hold time.
- A project's status and its focus are independent. Change only what was asked.
- Write British English, plainly. No exclamation marks, no filler.`;

const fmt = (o: unknown) => JSON.stringify(o, null, 1);

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
narrow, this decides what is retrieved. "queries" are the words worth searching
for, which are usually NOT the whole sentence: names of things, not verbs.`,
      user: `Today is ${input.request.today}.
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
 "clarification": {"question": string, "options": [{"id","label","ref"}]} | null}

A request can be a question, changes, or both. Answer the informational part in
"answer" and put every change in "actions" - do not describe a change in prose
instead of proposing it, and do not propose an action for something that was
only a question.

One action per distinct change. "I finished X and remind me about Y" is two.

"payload" must match the capability's input schema exactly. Ids must come from
CONTEXT. "sources" are "type:id" strings from CONTEXT that justify the action.

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

MEMORY may inform defaults. It never overrides an explicit instruction or a
fact from CONTEXT.`,
      user: [
        `Today is ${input.request.today}${input.request.timeZone ? ` (${input.request.timeZone})` : ''}.`,
        input.request.surface ? `The user is looking at: ${fmt(input.request.surface)}` : '',
        '',
        'CAPABILITIES YOU MAY USE:',
        fmt(input.capabilities),
        '',
        'MODULE RULES:',
        fmt(input.rules),
        '',
        'CONTEXT (the only real ids that exist):',
        fmt(input.sources),
        '',
        input.memory.length ? `MEMORY about this user:\n${fmt(input.memory)}` : '',
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
        `Today is ${input.request.today}.`,
        'CONTEXT:',
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
