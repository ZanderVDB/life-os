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
import { signatureOf } from './validate.js';
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
  /**
   * Per-request memo for `available()`. Created by `forRequest()`; absent is
   * fine and simply means every question is asked afresh.
   */
  availability?: Map<string, Promise<ModuleAvailability>>;
};

/**
 * A context that answers each module's availability once.
 *
 * Not an optimisation bolted on: `available()` for Calendar is a database read,
 * and one turn asks the registry what is available from five places. Without
 * this the same question is asked — and paid for — five times.
 */
export const forRequest = (db: Db, request: AiRequestContext): CapabilityCtx =>
  ({ db, request, availability: new Map() });

export type Capability<I = any> = {
  /** `<module>.<verb>`, e.g. `task.create`. Stable; it appears in proposals. */
  id: string;
  module: string;
  kind: CapabilityKind;
  label: string;
  /** One line, written for a planner to read. Says what, and says the limits. */
  description: string;
  /** The shape the PLANNER may propose. Validated at plan time. */
  input: z.ZodTypeAny;
  /**
   * The shape the EXECUTOR runs, when `preview` replaces the payload.
   *
   * Calendar is the reason this exists. Its plan-time input is a whole draft —
   * a calendar, a title, a time — and its preview writes that draft into the
   * mutation ledger and hands back a requestId. What is confirmed is the
   * requestId alone, because the draft is already recorded and re-sending it
   * would be a second, unproposed description of the same write.
   *
   * Without this the executor validated the confirmed payload against the
   * PLAN's schema, a strict object needing a calendarId and a draft that the
   * payload no longer carried, and every assistant calendar write failed after
   * the user had already agreed to it. Absent means the two shapes are the
   * same, which is true of every capability that does not preview.
   */
  confirmed?: z.ZodTypeAny;
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
    summary: string;
    warnings?: string[];
    handle?: string;
    /**
     * Fields the confirmed payload must keep alongside the handle.
     *
     * Only what preview has already validated. A task id travels this way so
     * that "put an hour in for this task" ends with the task and the event
     * linked, which is a local Life OS write and is not part of what the
     * ledger records about Google.
     */
    carry?: Record<string, unknown>;
  }>;
};

/* ══ What a module is ════════════════════════════════════════════════════ */

/**
 * Whether a module can be read from, and — separately — written to.
 *
 * ── Why two answers and not one ──────────────────────────────────────────
 *
 * Because Calendar has three states, not two. Not connected at all; connected
 * with a read-only grant; connected and writable. Collapsing the middle one
 * into "off" was the honest choice while everything a module offered was
 * either all available or all not — but it meant a workspace whose Google
 * grant could not write lost the ability to ASK about its own calendar, and
 * the assistant answered "I cannot see that meeting" about a meeting sitting
 * in front of it.
 *
 * So `enabled` governs the module and `canMutate` governs its writes. A module
 * that omits `canMutate` writes exactly as before: it follows `enabled`.
 */
export type ModuleAvailability = {
  enabled: boolean;
  reason?: string;
  /** Defaults to `enabled`. False means readable, not writable. */
  canMutate?: boolean;
  /** Why writing is off, in words that can be shown to a person. */
  mutateReason?: string;
};

/** Reads stay; mutations go. Used everywhere availability is interpreted. */
const canMutate = (a: ModuleAvailability) => a.enabled && (a.canMutate ?? true);

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
  /** Resolved rather than inferred, so a caller never has to repeat the rule. */
  writable: boolean;
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

  /**
   * `available()` once per module per request, not once per question asked.
   *
   * The memo lives on the context, so it is created and discarded with the
   * request. A module that goes away between one turn and the next is gone;
   * one that goes away between two questions inside the same turn is not, and
   * that is the correct reading — a turn should decide against one consistent
   * picture of what exists.
   */
  private async availability(ctx: CapabilityCtx, m: AiModule): Promise<ModuleAvailability> {
    if (!ctx.availability) return m.available(ctx);
    const key = `${ctx.request.workspaceId}:${m.id}`;
    let hit = ctx.availability.get(key);
    if (!hit) {
      hit = Promise.resolve(m.available(ctx));
      ctx.availability.set(key, hit);
    }
    return hit;
  }

  /**
   * Status of each module for this request, availability resolved.
   *
   * Asked once per turn and reused: `available()` can be a database round trip
   * — Calendar's is — and a turn that calls `status()`, `capabilities()`,
   * `describe()` and `resolve()` four times over would pay for it four times.
   */
  async status(ctx: CapabilityCtx): Promise<ModuleStatus[]> {
    return Promise.all(this.modules.map(async (m) => {
      const a = await this.availability(ctx, m);
      const writable = canMutate(a);
      return {
        id: m.id,
        name: m.name,
        entities: m.entities,
        rules: m.rules,
        enabled: a.enabled,
        writable,
        ...(a.reason ? { reason: a.reason } : {}),
        ...(a.mutateReason ? { mutateReason: a.mutateReason } : {}),
        capabilities: a.enabled
          ? m.capabilities.filter((c) => writable || c.kind !== 'mutate').map((c) => c.id)
          : [],
      };
    }));
  }

  /**
   * The capabilities available RIGHT NOW.
   *
   * This is the answer to "what can the assistant currently do", and it is the
   * only answer. A capability absent from this list does not exist as far as
   * the planner and the executor are concerned.
   *
   * A read-only module still contributes its reads. That is the whole point of
   * the split: losing the ability to write to a calendar is not the same as
   * losing the ability to see it.
   */
  async capabilities(ctx: CapabilityCtx): Promise<Capability[]> {
    const out: Capability[] = [];
    for (const m of this.modules) {
      const a = await this.availability(ctx, m);
      if (!a.enabled) continue;
      const writes = canMutate(a);
      for (const c of m.capabilities) if (writes || c.kind !== 'mutate') out.push(c);
    }
    return out;
  }

  /**
   * Resolve one capability, honouring availability.
   *
   * Returns null for an unknown id, for a known id belonging to a module that
   * is switched off, AND for a mutation belonging to a module that has gone
   * read-only. The executor treats all three the same way, which is what makes
   * "remove the module, the capability disappears" true at execution time and
   * not merely in the listing.
   */
  async resolve(ctx: CapabilityCtx, id: string): Promise<Capability | null> {
    const m = this.modules.find((x) => x.capabilities.some((c) => c.id === id));
    if (!m) return null;
    const a = await this.availability(ctx, m);
    if (!a.enabled) return null;
    const cap = m.capabilities.find((c) => c.id === id) ?? null;
    if (cap?.kind === 'mutate' && !canMutate(a)) return null;
    return cap;
  }

  /**
   * Why one capability is not available, for a sentence a person can read.
   *
   * "Capability unavailable" tells nobody anything. The registry is the only
   * thing that knows whether the answer is "Life OS has never had that",
   * "your calendar is not connected" or "your calendar connection cannot
   * write", so it is the only thing that can say which.
   */
  async explain(ctx: CapabilityCtx, id: string): Promise<
    { available: true } | { available: false; reason: string; readable: boolean }
  > {
    const m = this.modules.find((x) => x.capabilities.some((c) => c.id === id));
    if (!m) return { available: false, reason: 'Life OS cannot do that.', readable: false };
    const a = await this.availability(ctx, m);
    if (!a.enabled) {
      return {
        available: false,
        reason: a.reason ?? `${m.name} is not available right now.`,
        readable: false,
      };
    }
    const cap = m.capabilities.find((c) => c.id === id)!;
    if (cap.kind === 'mutate' && !canMutate(a)) {
      return {
        available: false,
        reason: a.mutateReason ?? `${m.name} changes are not available right now.`,
        /* The distinction the wording pass in §12 turns on: this is the case
           where "I can see it, I just cannot change it" is the true sentence. */
        readable: true,
      };
    }
    return { available: true };
  }

  /** Which module owns an entity type, for relationship traversal. */
  moduleForEntity(type: EntityType): AiModule | null {
    return this.modules.find((m) => m.entities.includes(type)) ?? null;
  }

  /**
   * The planner's view: what may be DONE, and the rules that constrain it.
   *
   * Deliberately narrower than `capabilities()`, which is the full answer to
   * "what can the assistant do" and is what `GET /ai/capabilities` reports.
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
      /* Readable but not writable. The planner needs this stated rather than
         inferred from an absence: "I can see that meeting but cannot move it"
         is a useful answer, and it is unreachable from a capability list that
         merely does not mention Calendar. */
      readOnly: status.filter((s) => s.enabled && !s.writable)
        .map((s) => ({ id: s.id, reason: s.mutateReason ?? 'Changes are not available.' })),
      /* MUTATIONS ONLY.
       *
       * Reads are the context engine's job and have already run — retrieval
       * happened before the planner was called and it has no way to call one.
       * Offering them anyway is a contradiction the model resolves by
       * proposing a search as if it were an action, which is then rejected
       * and the real change alongside it is lost. */
      capabilities: (await this.capabilities(ctx))
        .filter((c) => c.kind === 'mutate')
        .map((c) => ({
          id: c.id,
          module: c.module,
          kind: c.kind,
          description: c.description,
          risk: c.risk,
          /* The payload shape, generated from the capability's own schema.
             Without it the planner infers field names from an English
             sentence, which works for `title` and fails for `id`. */
          payload: signatureOf(c.input),
        })),
    };
  }
}

/** What a payload is checked against at execution. See `Capability.confirmed`. */
export const executionSchema = (c: Capability) => c.confirmed ?? c.input;

/** A ref helper every module needs, kept in one place. */
export const ref = (type: EntityType, id: string): EntityRef => ({ type, id });
