/**
 * The assistant, assembled.
 *
 * One place where the registry, the providers, the context engine and the
 * executor are wired together, so a route never has to know how any of them
 * are built. Everything below is composition; the decisions all live in the
 * files being composed.
 */
import type { Db } from '../db/client.js';
import { CapabilityRegistry } from './registry.js';
import { MODULES } from './modules/index.js';
import { defaultRouter, ProviderRouter } from './provider.js';
import type { AiRequestContext, Trace, ProposalAction, ProposalSet } from './types.js';
import { gather, forPrompt, type GatherOptions } from './context.js';
import { execute } from './executor.js';
import * as memory from './memory.js';

export type Assistant = {
  registry: CapabilityRegistry;
  providers: ProviderRouter;
};

/**
 * Built once, at boot.
 *
 * The module list is fixed at build time; AVAILABILITY is not — it is asked
 * per request, so one workspace with a Google account and one without get
 * different answers from the same registry.
 */
export function createAssistant(): Assistant {
  return {
    registry: new CapabilityRegistry(MODULES),
    providers: defaultRouter(),
  };
}

/* ══ Traces ══════════════════════════════════════════════════════════════ */

/**
 * A record of one turn, holding ids and names and nothing else.
 *
 * No transcript, no field values, no retrieved text. That is a deliberate
 * limit rather than an oversight: a trace is meant to be safe to look at while
 * debugging, and a trace that quotes the user's diary is a second copy of it.
 *
 * Not persisted for the same reason — storing traces is a privacy decision and
 * this phase has not made one. See docs/ai-system.md §14.
 */
export function startTrace(request: AiRequestContext): Trace & { finish: () => Trace } {
  const startedAt = new Date();
  const t: Trace = {
    runId: `run_${startedAt.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    startedAt: startedAt.toISOString(),
    request: { length: 0, surface: request.surface?.route ?? null },
    modules: [],
    capabilitiesOffered: [],
    contextSources: [],
    plannedActions: [],
    provider: [],
    ms: 0,
  };
  return Object.assign(t, {
    finish() {
      t.ms = Date.now() - startedAt.getTime();
      return t;
    },
  });
}

export {
  CapabilityRegistry, MODULES, ProviderRouter, gather, forPrompt, execute, memory,
};
export type { AiRequestContext, GatherOptions, ProposalAction, ProposalSet, Trace };
