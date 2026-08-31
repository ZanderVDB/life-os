/**
 * The Capability Registry — what the assistant can currently do.
 *
 * ── Why this exists at all ───────────────────────────────────────────────
 *
 * The obvious way to build an assistant is a large system prompt that lists
 * everything the app can do, and a switch statement that carries it out. Both
 * halves rot in the same way: the prompt keeps advertising a feature after it
 * is removed, and the switch grows a branch per module until the assistant is
 * where the application's business logic lives.
 *
 * So capability is DECLARED BY THE MODULE THAT OWNS IT. Tasks says what can be
 * done to a task. If Calendar is removed, its registration goes with it and
 * every calendar capability disappears — from the planner's vocabulary, from
 * `GET /ai/capabilities`, and from the executor, which will refuse an action
 * naming a capability it cannot resolve. There is no second list to remember.
 *
 * ── Availability is asked, not assumed ───────────────────────────────────
 *
 * A module can be present in the code and unavailable to this workspace: the
 * Calendar module is registered on every deployment and can write nothing
 * until a Google account is connected. `available()` is asked per request, so
 * the assistant is never told it can do something that would fail.
 *
 * ── What a capability may NOT do ─────────────────────────────────────────
 *
 * Contain business rules. `execute` is an adapter: it validates its input
 * against its own schema and calls an application service. If a capability
 * starts deciding what a valid task looks like, that rule now applies to the
 * assistant and not to the person using the app, which is exactly the split
 * this architecture exists to prevent.
 */
import type { z } from 'zod';
import type { Db } from '../db/client.js';
import type {
  AiRequestContext, ContextSource, EntityRef, EntityType, ActionResult,
} from './types.js';

/* ══ What a capability is ════════════════════════════════════════════════ */

export type CapabilityKind =
  /** Find candidates by text. Cheap, and never exhaustive. */
  | 'search'
  /** Load one known thing in full. */
  | 'read'
  /** Walk relationships out from something. */
  | 'traverse'
  /** Change something. Goes through propose → confirm → execute. */
  | 'mutate';

/**
 * How much a mistake costs, which decides what the confirmation has to be.
 *
 *   safe      — reversible and local. A proposal card is enough.
 *   confirm   — ordinary mutation; the batch confirmation covers it.
 *   important — being wrong destroys something undo cannot return. Needs its
 *               OWN acceptance, not just the batch's.
 *   external  — leaves Life OS. Reaches a system other people can see, and is
 *               additionally gated by that system's own rules.
 */
export type Risk = 'safe' | 'confirm' | 'important' | 'external';

export type CapabilityCtx = {
  db: Db;
  request: AiRequestContext;
};

export type Capability<I = any> = {
  /** `<module>.<verb>`, e.g. `task.create`. Stable; it appears in proposals. */
  id: string;
  module: string;
  kind: CapabilityKind;
  label: string;
  /** One line, written for a planner to read. Says what, and says the limits. */
  description: string;
  /** The only accepted input shape. Validated before anything runs. */
  input: z.ZodTypeAny;
  risk: Risk;
  /**
   * Reads. Returns typed sources with provenance, never raw rows.
   * Present for `search` | `read` | `traverse`.
   */
  run?: (ctx: CapabilityCtx, input: I) => Promise<ContextSource[]>;
  /**
   * Writes. Present only for `mutate`, and only ever called by the executor
   * after a confirmation has been checked.
   */
  execute?: (ctx: CapabilityCtx, input: I) => Promise<Omit<ActionResult, 'actionId' | 'capability'>>;
  /**
   * Optional dry run, at plan time.
   *
   * Where a domain has its own confirmation machinery — Calendar's
   * propose/execute ledger — this is where the proposal row is created, so the
   * assistant cannot reach `executeMutation` without having proposed first.
   */
  preview?: (ctx: CapabilityCtx, input: I) => Promise<{
    summary: string; warnings?: string[]; handle?: string;
  }>;
};

/* ══ What a module is ════════════════════════════════════════════════════ */

export type ModuleAvailability = { enabled: boolean; reason?: string };

export type AiModule = {
  id: string;
  name: string;
  /** Relationship entity types this module owns. Used to route traversal. */
  entities: EntityType[];
  /**
   * Constraints the planner must respect for this module, in plain words.
   *
   * These are the sentences that stop a plausible-sounding plan from being
   * wrong — "a due date is not a calendar event" — and they belong to the
   * module because the module is what would be damaged by ignoring them.
   */
  rules: string[];
  /** Asked per request. A module the workspace cannot use is not offered. */
  available: (ctx: CapabilityCtx) => Promise<ModuleAvailability> | ModuleAvailability;
  capabilities: Capability[];
};

/* ══ The registry ════════════════════════════════════════════════════════ */

export type ModuleStatus = ModuleAvailability & {
  id: string;
  name: string;
  entities: EntityType[];
  rules: string[];
  capabilities: string[];
};

export class CapabilityRegistry {
  private readonly modules: AiModule[];

  constructor(modules: AiModule[]) {
    const seen = new Set<string>();
    for (const m of modules) {
      if (seen.has(m.id)) throw new Error(`Duplicate AI module: ${m.id}`);
      seen.add(m.id);
      for (const c of m.capabilities) {
        if (c.module !== m.id) {
          throw new Error(`Capability ${c.id} claims module ${c.module} but is registered by ${m.id}`);
        }
        if (c.kind === 'mutate' && !c.execute) {
          throw new Error(`Mutating capability ${c.id} has no execute`);
        }
        if (c.kind !== 'mutate' && !c.run) {
          throw new Error(`Reading capability ${c.id} has no run`);
        }
      }
    }
  this.modules = modules;
  }

  /** Every module in the build, whether or not this workspace can use it. */
  all(): AiModule[] { return [...this.modules]; }

  /** Status of each module for this request, availability resolved. */
  async status(ctx: CapabilityCtx): Promise<ModuleStatus[]> {
    return Promise.all(this.modules.map(async (m) => {
      const a = await m.available(ctx);
      return {
        id: m.id,
        name: m.name,
        entities: m.entities,
        rules: m.rules,
        enabled: a.enabled,
        ...(a.reason ? { reason: a.reason } : {}),
        capabilities: a.enabled ? m.capabilities.map((c) => c.id) : [],
      };
    }));
  }

  /**
   * The capabilities available RIGHT NOW.
   *
   * This is the answer to "what can the assistant currently do", and it is the
   * only answer. A capability absent from this list does not exist as far as
   * the planner and the executor are concerned.
   */
  async capabilities(ctx: CapabilityCtx): Promise<Capability[]> {
    const out: Capability[] = [];
    for (const m of this.modules) {
      const a = await m.available(ctx);
      if (a.enabled) out.push(...m.capabilities);
    }
    return out;
  }

  /**
   * Resolve one capability, honouring availability.
   *
   * Returns null for an unknown id AND for a known id belonging to a module
   * that is switched off. The executor treats both the same way, which is what
   * makes "remove the module, the capability disappears" true at execution
   * time and not merely in the listing.
   */
  async resolve(ctx: CapabilityCtx, id: string): Promise<Capability | null> {
    const m = this.modules.find((x) => x.capabilities.some((c) => c.id === id));
    if (!m) return null;
    const a = await m.available(ctx);
    if (!a.enabled) return null;
    return m.capabilities.find((c) => c.id === id) ?? null;
  }

  /** Which module owns an entity type, for relationship traversal. */
  moduleForEntity(type: EntityType): AiModule | null {
    return this.modules.find((m) => m.entities.includes(type)) ?? null;
  }

  /**
   * The planner's view: what may be done, and the rules that constrain it.
   *
   * Built per request from live availability rather than written into a
   * prompt, which is the difference between an assistant that stops offering
   * Calendar when Calendar is removed and one that keeps offering it for as
   * long as nobody remembers to edit the prompt.
   */
  async describe(ctx: CapabilityCtx) {
    const status = await this.status(ctx);
    const enabled = status.filter((s) => s.enabled);
    return {
      today: ctx.request.today,
      timeZone: ctx.request.timeZone ?? null,
      surface: ctx.request.surface ?? null,
      modules: enabled.map((s) => ({ id: s.id, name: s.name, rules: s.rules })),
      unavailable: status.filter((s) => !s.enabled)
        .map((s) => ({ id: s.id, reason: s.reason ?? 'Not available.' })),
      capabilities: (await this.capabilities(ctx)).map((c) => ({
        id: c.id,
        module: c.module,
        kind: c.kind,
        description: c.description,
        risk: c.risk,
      })),
    };
  }
}

/** A ref helper every module needs, kept in one place. */
export const ref = (type: EntityType, id: string): EntityRef => ({ type, id });
