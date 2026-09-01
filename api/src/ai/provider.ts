/**
 * The provider abstraction — where a model plugs in, and the only place.
 *
 * ── Why not just call an SDK ─────────────────────────────────────────────
 *
 * Because the jobs are not alike. Classifying an intent, extracting a date and
 * noticing a durable fact are cheap and frequent; planning a five-action
 * request across four systems is neither. One client hard-wired into the
 * domain would force the same model on all of them and make changing it a
 * search-and-replace through the app.
 *
 * So a provider answers JOBS, and a router picks a provider per job. Swapping
 * a model is a line in the router. Adding a second provider for the expensive
 * jobs is a line in the router. Neither touches a capability, a service, or a
 * route.
 *
 * ── What a provider is structurally denied ───────────────────────────────
 *
 * A database handle. Every job takes plain data and returns plain data; there
 * is no argument through which a provider could reach a table. It cannot write
 * even if it decided to — the capability is absent rather than merely unused,
 * which is the same reason the client-side contract gives a provider exactly
 * one method.
 */
import type {
  AiRequestContext, ProposalSet, ContextSource, Confidence,
} from './types.js';
import type { MemoryCandidate } from './memory.js';
import { tokens } from './ranking.js';

/* ══ The jobs ════════════════════════════════════════════════════════════ */

export type AiJob =
  /** What is being asked, and which modules it concerns. Cheap and frequent. */
  | 'interpret'
  /** Turn a request plus context into proposed actions. The expensive one. */
  | 'plan'
  /** Answer a question from retrieved sources, with citations. */
  | 'answer'
  /** Condense something long into something readable. */
  | 'summarise'
  /** Notice durable facts worth remembering. Cheap, runs often, writes nothing. */
  | 'extractMemory';

export type InterpretInput = {
  text: string;
  request: AiRequestContext;
  /** Module ids currently available, from the registry. */
  modules: string[];
};

export type InterpretOutput = {
  /** What the user appears to want, in their own terms. */
  understood: string;
  /** Whether this is a question to answer or a change to propose. */
  intent: 'question' | 'change' | 'both' | 'unclear';
  /** Modules worth retrieving from. Drives level-2 targeting. */
  modules: string[];
  /** Text to search with, which is often not the whole utterance. */
  queries: string[];
  confidence: Confidence;
};

export type PlanInput = {
  text: string;
  request: AiRequestContext;
  /** Exactly what may be proposed, from the registry. Never a static list. */
  capabilities: {
    id: string; module: string; kind: string; description: string; risk: string;
    /** The payload shape, generated from the capability's own Zod schema. */
    payload?: unknown;
  }[];
  /** The module rules the plan has to respect. */
  rules: { module: string; rules: string[] }[];
  /**
   * Modules that can be READ but not written to right now.
   *
   * Stated rather than left to be inferred from an absence. "I can see that
   * meeting, but calendar changes aren't available" is a useful answer and it
   * is unreachable from a capability list that merely does not mention
   * Calendar — from that, the only available conclusion is silence.
   */
  readOnly?: { id: string; reason: string }[];
  /** What was retrieved, already trimmed by the context engine. */
  sources: ReturnType<typeof import('./context.js').forPrompt>;
  /** Durable facts about this user. Small, and never secrets. */
  memory: { category: string; fact: string }[];
  /**
   * The proposal still awaiting confirmation, when there is one.
   *
   * Present so that "actually Saturday" has something to be about. A pending
   * proposal is conversation state: it does not exist in the workspace yet, so
   * searching for it finds nothing, and an assistant without this said the
   * thing the user was looking at did not exist.
   */
  pending?: {
    understood: string;
    request: string;
    actions: {
      id: string; capability: string; title: string;
      payload: Record<string, unknown>; enabled: boolean;
    }[];
  };
  /** The entity the user picked from a clarification, by id rather than label. */
  resolved?: { ref: { type: string; id: string } | null; label: string } | null;
  /**
   * One chance to fix a plan that contradicted itself.
   *
   * Set by the consistency pass, which is deterministic and runs before the
   * user sees anything. The complaint names the field and the sentence that
   * disagree; a model told exactly that usually fixes it.
   */
  repair?: { problems: string; previous: unknown };
};

/**
 * An edit to a proposal that is already on the table.
 *
 * Deliberately shaped like the card's own edit control, because it goes down
 * the same validated path: field values checked against the capability's
 * schema, the version bumped, the confirmation gate untouched.
 */
export type PlanAmendment = {
  actionId: string;
  enabled?: boolean | null;
  fields?: Record<string, string | number | null> | null;
};

export type AnswerInput = {
  question: string;
  request: AiRequestContext;
  sources: ReturnType<typeof import('./context.js').forPrompt>;
};

export type AnswerOutput = {
  answer: string;
  /** `type:id` of everything the answer actually used. */
  cited: string[];
};

export type ExtractMemoryInput = {
  text: string;
  request: AiRequestContext;
  /** What is already known, so the model proposes changes rather than repeats. */
  known: { id: string; category: string; fact: string }[];
};

/**
 * A provider.
 *
 * Every method is optional except `id` and `label`: a provider that only does
 * the cheap jobs is a legitimate provider, and the router falls through to
 * another for the rest.
 */
export type AiProvider = {
  id: string;
  label: string;
  /** For the trace, so a wrong answer can be attributed. */
  model?: string | null;
  interpret?: (input: InterpretInput) => Promise<InterpretOutput>;
  plan?: (input: PlanInput) => Promise<Omit<ProposalSet, 'sources'> & { amend?: PlanAmendment[] }>;
  answer?: (input: AnswerInput) => Promise<AnswerOutput>;
  summarise?: (input: { text: string; maxWords?: number }) => Promise<string>;
  extractMemory?: (input: ExtractMemoryInput) => Promise<MemoryCandidate[]>;
};

export const supports = (p: AiProvider, job: AiJob) => typeof (p as any)[job] === 'function';

/* ══ The router ══════════════════════════════════════════════════════════ */

/**
 * Which provider does which job.
 *
 * A map rather than a chain of conditionals, so "route planning to the strong
 * model and extraction to the cheap one" is data. The fallback is used for any
 * job with no explicit entry.
 */
export type ProviderRouting = Partial<Record<AiJob, string>> & { default?: string };

export class ProviderRouter {
  private readonly providers = new Map<string, AiProvider>();

  constructor(providers: AiProvider[], private routing: ProviderRouting = {}) {
    for (const p of providers) this.providers.set(p.id, p);
  }

  register(p: AiProvider) { this.providers.set(p.id, p); return this; }

  route(routing: ProviderRouting) { this.routing = { ...this.routing, ...routing }; return this; }

  list(): { id: string; label: string; model: string | null; jobs: AiJob[] }[] {
    const JOBS: AiJob[] = ['interpret', 'plan', 'answer', 'summarise', 'extractMemory'];
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      label: p.label,
      model: p.model ?? null,
      jobs: JOBS.filter((j) => supports(p, j)),
    }));
  }

  /**
   * The provider for a job, or null.
   *
   * Null is a real answer, not an error: a deployment with no model configured
   * has no planner, and the honest behaviour is for the assistant to say it
   * cannot do that yet rather than for the app to fail to start.
   */
  for(job: AiJob): AiProvider | null {
    const named = this.routing[job] ?? this.routing.default;
    const chosen = named ? this.providers.get(named) : undefined;
    if (chosen && supports(chosen, job)) return chosen;
    for (const p of this.providers.values()) if (supports(p, job)) return p;
    return null;
  }
}

/* ══ The provider that needs no model ════════════════════════════════════ */

/**
 * Deterministic answers for the jobs that do not need a model.
 *
 * Not a mock and not a placeholder — it is the correct implementation for
 * requests where a model would add cost and risk without adding anything. It
 * also makes the rest of the system testable end to end without a network,
 * which is why the executor and registry tests can be honest about what they
 * exercise.
 *
 * It deliberately does NOT implement `plan`. Guessing at multi-step intent
 * without a model is exactly the kind of confident wrong answer the whole
 * proposal architecture exists to keep away from the database.
 */
export const deterministicProvider: AiProvider = {
  id: 'deterministic',
  label: 'No model',
  model: null,
  async interpret({ text, modules }) {
    const t = text.trim();
    const asksSomething = /^(what|when|where|who|why|how|which|do i|is there|are there)\b/i.test(t)
      || t.endsWith('?');
    /* Which modules a sentence concerns, from words the modules own. Crude,
       and used only to NARROW retrieval — being wrong costs a wider search,
       never a wrong write. */
    const HINTS: Record<string, RegExp> = {
      tasks: /\btask|todo|to-do|finish|done|complete\b/i,
      projects: /\bproject\b/i,
      calendar: /\bmeeting|calendar|event|schedule|appointment\b/i,
      reminders: /\bremind|reminder\b/i,
      habits: /\bhabit|streak\b/i,
      diary: /\bdiary|journal|felt|mood\b/i,
      library: /\bnote|page|book|document\b/i,
    };
    const hinted = modules.filter((m) => HINTS[m]?.test(t));
    /* WORDS, not the sentence.
     *
     * Search is `ILIKE '%…%'`, so handing it a whole question matches nothing
     * — "what do I need before the Trifusion handover?" has no row containing
     * that string, and a search that finds nothing means no seed and therefore
     * no relationship traversal. The distinctive words are what a person would
     * have typed into a search box. */
    const words = tokens(t);
    return {
      understood: t,
      intent: asksSomething ? 'question' : 'unclear',
      modules: hinted.length ? hinted : modules,
      queries: words.length ? words.slice(0, 4) : [t.slice(0, 200)],
      confidence: hinted.length ? 'medium' : 'low',
    };
  },
  async summarise({ text, maxWords = 40 }) {
    const words = text.trim().split(/\s+/);
    return words.length <= maxWords ? text.trim() : `${words.slice(0, maxWords).join(' ')}…`;
  },
};

/**
 * What this deployment actually has.
 *
 * The deterministic provider is always present; the model provider joins it
 * only when a key is configured. Routing then sends the cheap jobs to the
 * model as well — `interpret` benefits from a real reading of the sentence —
 * while `summarise` stays deterministic, because trimming a string to forty
 * words does not need a model and paying for one would be waste.
 *
 * With no key the router still answers: `for('plan')` returns null, and the
 * turn says the assistant is not configured rather than failing obscurely.
 */
export function buildRouter(providers: AiProvider[] = []): ProviderRouter {
  const router = new ProviderRouter([deterministicProvider, ...providers]);
  const model = providers[0];
  if (model) {
    router.route({
      interpret: model.id,
      plan: model.id,
      answer: model.id,
      extractMemory: model.id,
      summarise: 'deterministic',
      default: model.id,
    });
  } else {
    router.route({ default: 'deterministic' });
  }
  return router;
}

/** Kept for callers that only ever wanted the no-model behaviour. */
export const defaultRouter = () => buildRouter();

export type { ContextSource };
