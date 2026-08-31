/**
 * The typed contracts the whole AI layer is built on.
 *
 * Everything here is a SHAPE, not a behaviour. The planner, the executor, the
 * context engine, the memory service and every provider agree on these types
 * and on nothing else, which is what lets any one of them be replaced without
 * the others noticing.
 *
 * Nothing in this file imports a table, a model or a route.
 */
import { z } from 'zod';
import { ENTITY_TYPES } from '../lib/relationships.js';

/* ══ Who is asking, and from where ═══════════════════════════════════════ */

/**
 * The one object every AI function receives.
 *
 * It carries a workspace and an actor and NOTHING that could be used to write
 * — no db handle, no token, no client. A capability is handed the database by
 * the executor when it runs; a provider never is. That asymmetry is the whole
 * safety model expressed as a parameter list.
 */
export type AiRequestContext = {
  workspaceId: string;
  userId: string;
  /** The user's civil date, so "tomorrow" resolves where the user is. */
  today: string;
  /** IANA zone when the client sent one. */
  timeZone?: string | null;
  /** Where the assistant was invoked from. See `SurfaceContext`. */
  surface?: SurfaceContext | null;
};

export const ENTITY_TYPE_VALUES = ENTITY_TYPES;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** A stable pointer at one Life OS object. The unit of traceability. */
export type EntityRef = { type: EntityType; id: string };

export const EntityRefSchema = z.object({
  type: z.enum(ENTITY_TYPES as unknown as [string, ...string[]]),
  id: z.string().uuid(),
});

/**
 * What the user was looking at when they invoked the assistant.
 *
 * Level 1 of the context engine, and the cheapest useful context there is:
 * "move this to Friday" is unanswerable without it and unambiguous with it.
 * A route is included as well as an entity because some surfaces are a place
 * rather than an object — a calendar week, the Today board.
 */
export type SurfaceContext = {
  route: string;
  entity?: EntityRef | null;
  /** For date-ranged surfaces: the visible window. */
  range?: { from: string; to: string } | null;
};

/* ══ Retrieved context ═══════════════════════════════════════════════════ */

/**
 * One fact the assistant was given, with its provenance attached.
 *
 * Provenance is not decoration. An answer that cannot name what it read is an
 * answer nobody can check, and a wrong answer nobody can check is worse than
 * no answer. Every source carries a real entity id, so the UI can offer a way
 * to go and look, and so a bad answer can be traced to what produced it.
 */
export type ContextSource = {
  ref: EntityRef;
  /** Which registered module produced this. */
  module: string;
  title: string;
  /** One line a person could read. Never the whole record. */
  summary?: string | null;
  /** The fields the planner may reason over. Small and explicit. */
  data?: Record<string, unknown>;
  /**
   * How this was reached. `direct` for a search hit or the current surface;
   * a relationship path for anything found by traversal.
   */
  via: 'surface' | 'direct' | 'relationship';
  /** For `relationship`: the edge chain, nearest first. */
  path?: { from: EntityRef; kind: string; label: string }[];
  /** Retrieval level that produced it — 1 surface, 2 targeted, 3 broad. */
  level: 1 | 2 | 3;
};

/* ══ Proposals ═══════════════════════════════════════════════════════════ */

/** Higher means more certain. See docs/ai-system.md §12. */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * A single change the assistant is offering to make.
 *
 * The rule this shape enforces: an action names a CAPABILITY, not a table and
 * not a function. The executor resolves the capability through the registry at
 * execution time, so an action naming a module that has since been switched
 * off cannot run — see `executor.ts`.
 */
export type ProposalAction = {
  id: string;
  /** A registered capability id, e.g. `task.create`. */
  capability: string;
  /** Denormalised for rendering and for refusing early. */
  module: string;
  title: string;
  summary?: string | null;
  /** Validated against the capability's own input schema before it can run. */
  payload: Record<string, unknown>;
  /** What this acts on, when it acts on something that already exists. */
  target?: EntityRef | null;
  /** What it produced, filled in after execution. */
  result?: EntityRef | null;
  confidence: Confidence;
  /**
   * Interpretations made on the user's behalf, in plain words.
   *
   * A medium-confidence reading is not a reason to stop and ask; it is a
   * reason to say what was assumed, on the card, where it can be corrected.
   */
  assumptions: string[];
  /** Things that are true and unwelcome: a clash, a read-only calendar. */
  warnings: string[];
  /** Whether this one needs its own explicit confirmation. */
  requiresConfirmation: boolean;
  /** Marked when being wrong destroys something undo cannot return. */
  important: boolean;
  /** Fields the proposal card may offer for editing, and their types. */
  editable: EditableField[];
  /** Off means "do not run this one". The count on the button follows it. */
  enabled: boolean;
  /** What the sources say this was based on. */
  sources: EntityRef[];
};

export const FIELD_TYPES = ['text', 'date', 'time', 'duration', 'choice', 'note'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type EditableField = {
  key: string;
  label: string;
  type: FieldType;
  value: string | number | null;
  options?: { id: string; label: string }[];
};

/**
 * One interpretation of one user request.
 *
 * A single utterance can be several unrelated actions — "I finished the
 * website, I need a haircut tomorrow, and move John to 3" is three — so a
 * proposal set is a list, and each entry stands or falls alone.
 */
export type ProposalSet = {
  id: string;
  /** What the user said, as the system received it. */
  request: string;
  /** What the assistant believes was asked, in the user's own terms. */
  understood: string;
  /** A direct answer, when the request was a question rather than a change. */
  answer?: string | null;
  actions: ProposalAction[];
  /** Everything that informed this, for citation and for debugging. */
  sources: ContextSource[];
  /**
   * A question back, used ONLY when proceeding under any reading would be
   * wrong AND the consequence matters. See §12: clarification is the last
   * resort, not the default.
   */
  clarification?: {
    question: string;
    options: { id: string; label: string; ref?: EntityRef }[];
  } | null;
};

/* ══ Confirmation and execution ══════════════════════════════════════════ */

/**
 * What the user actually agreed to.
 *
 * The COUNT is part of the agreement, not decoration. If the list changed
 * between the button being drawn and being pressed, the person agreed to a
 * different set of changes from the one about to run.
 */
export type Confirmation = {
  confirmed: true;
  /** How many changes the button said it would make. */
  count: number;
  /** Ids of actions marked important, each confirmed on its own. */
  importantAccepted: string[];
};

export type ActionResult = {
  actionId: string;
  capability: string;
  status: 'done' | 'skipped' | 'failed';
  /** What it created or changed, so the UI can link to it. */
  ref?: EntityRef | null;
  /** In the same language the card used, so the result can be checked. */
  message: string;
  error?: string | null;
};

export type ExecutionReport = {
  proposalSetId: string;
  results: ActionResult[];
  done: number;
  failed: number;
  skipped: number;
};

/* ══ Traceability ════════════════════════════════════════════════════════ */

/**
 * What happened during one assistant turn.
 *
 * Deliberately NOT persisted. A trace names entity ids and capability ids and
 * nothing else — no transcript, no field values, no retrieved content — so it
 * can be returned to a developer without becoming a second copy of the user's
 * life in a log. Persisting it would be a privacy decision, and this phase has
 * not made one.
 */
export type Trace = {
  runId: string;
  startedAt: string;
  request: { length: number; surface: string | null };
  modules: { id: string; enabled: boolean; reason?: string }[];
  capabilitiesOffered: string[];
  contextSources: { ref: EntityRef; via: string; level: number }[];
  plannedActions: { id: string; capability: string; confidence: Confidence }[];
  execution?: { actionId: string; capability: string; status: string }[];
  provider?: { id: string; job: string; model: string | null }[];
  ms: number;
};
