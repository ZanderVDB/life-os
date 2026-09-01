/**
 * The executor — the only thing in the AI layer that changes anything.
 *
 * ── What it is allowed to do ─────────────────────────────────────────────
 *
 * Check a confirmation, resolve a capability, validate an input, call the
 * capability, record the result. That is the complete list. It has no db
 * import, no table import and no domain knowledge; if you ever need to add an
 * `if (action.capability === 'task.create')` here, the rule you are about to
 * write belongs in the task service instead.
 *
 * The test that holds this down reads this file and fails if it ever imports
 * the schema — see `ai-foundation.test.ts`.
 *
 * ── The gate ─────────────────────────────────────────────────────────────
 *
 * `assertConfirmable` is deliberately blunt: it throws. A confirmation that is
 * merely recommended is a confirmation somebody eventually ships around. The
 * count is part of the agreement — if the list changed between the button
 * being drawn and being pressed, the person agreed to a different set of
 * changes from the one about to run.
 *
 * ── Why each action is its own transaction ───────────────────────────────
 *
 * A batch of six is six independent agreements. One failing must not roll back
 * the five that worked, and must not stop the sixth being attempted, because
 * "I added the milk but not the chicken" is a true and useful report and "the
 * whole thing failed" is neither.
 *
 * ── Except where one needs another ───────────────────────────────────────
 *
 * "Create the task, schedule it, link it to the notes" is still three separate
 * agreements, but two of them cannot be attempted until the first has produced
 * an id. Those are found by reading the payloads — see `depends.ts` — and a
 * dependent whose dependency failed is SKIPPED, not attempted and not counted
 * as a failure of its own. Running it anyway would write a link pointing at a
 * task that does not exist, which is the one outcome worse than doing nothing.
 *
 * Independence is still the default. Only an action that actually references
 * another's result is ordered behind it.
 */
import type { Db } from '../db/client.js';
/* The one non-type import, and it is an error SHAPE rather than a rule. A
   confirmation that does not match what was shown is the caller's problem, and
   a generic throw reaches the client as "Something went wrong" — which tells
   the person nothing about the one thing they could act on: the list changed,
   look again. */
import { badRequest } from '../lib/errors.js';
import { executionSchema } from './registry.js';
import { planOrder, blockedBy, substitute } from './depends.js';
import type { CapabilityRegistry, CapabilityCtx } from './registry.js';
import type {
  AiRequestContext, ProposalSet, ProposalAction, Confirmation,
  ExecutionReport, ActionResult, EntityRef,
} from './types.js';

/** How many changes a Confirm button covering this set would make. */
export function changeCount(actions: ProposalAction[]): number {
  return actions.filter((a) => a.enabled).length;
}

/**
 * @throws when a batch is about to run without an explicit agreement that
 * names the same number of changes the user was shown, or when an action
 * marked important was not individually accepted.
 */
export function assertConfirmable(actions: ProposalAction[], confirmation: Confirmation | null) {
  if (!confirmation || confirmation.confirmed !== true) {
    throw badRequest('Assistant changes require an explicit confirmation.');
  }
  const n = changeCount(actions);
  if (confirmation.count !== n) {
    throw badRequest(
      `Confirmed ${confirmation.count} changes but ${n} are pending. Check the list again.`,
    );
  }
  /* Important actions are not covered by the batch. A meeting other people
     were invited to, a completed task, a project's state: each needs its own
     yes, however confident the model was. */
  const accepted = new Set(confirmation.importantAccepted ?? []);
  const missing = actions
    .filter((a) => a.enabled && a.important && !accepted.has(a.id))
    .map((a) => a.id);
  if (missing.length) {
    throw badRequest(`These need their own confirmation: ${missing.join(', ')}`);
  }
  return true;
}

export type ExecuteDeps = {
  db: Db;
  registry: CapabilityRegistry;
  request: AiRequestContext;
};

export async function execute(
  deps: ExecuteDeps, set: ProposalSet, confirmation: Confirmation | null,
): Promise<ExecutionReport> {
  assertConfirmable(set.actions, confirmation);
  const ctx: CapabilityCtx = { db: deps.db, request: deps.request };
  const results: ActionResult[] = [];

  /* Dependencies first: an action referencing another's id runs after it.
     A graph that cannot be run — a loop, a reference to an action that is not
     in this set — is refused as a whole rather than partly attempted, because
     the person agreed to a set of changes that does not describe anything the
     executor could carry out. Validation rejects these before a proposal is
     ever shown; reaching one here means a confirmed set was tampered with. */
  const { order, problems } = planOrder(set.actions);
  if (problems.length) {
    throw badRequest(
      `These changes depend on each other in a way that cannot be carried out: ${
        problems.map((p) => p.detail).join('; ')}.`,
    );
  }

  /* What each finished action produced, so a later one can point at it. */
  const produced = new Map<string, EntityRef>();
  const succeeded = new Set<string>();

  for (const action of order) {
    if (!action.enabled) {
      results.push({
        actionId: action.id,
        capability: action.capability,
        status: 'skipped',
        message: 'Switched off.',
      });
      continue;
    }
    /* ── Did the thing this needs actually happen? ──────────────────
       Reported against the action that BROKE, not the one immediately
       above, so a three-step chain does not blame its middle. */
    const blocker = blockedBy(set.actions, succeeded).get(action.id);
    if (blocker) {
      const why = results.find((r) => r.actionId === blocker);
      results.push({
        actionId: action.id,
        capability: action.capability,
        status: 'skipped',
        message: why?.status === 'skipped'
          ? 'Not done, because it needed a change that was switched off.'
          : 'Not done, because it needed a change that did not work.',
        error: 'dependency_failed',
      });
      continue;
    }

    try {
      /* Resolved through the registry at EXECUTION time, not at plan time.
         A module switched off between the proposal being made and confirmed —
         a Google account disconnected, a module removed by a deploy — makes
         this null, and the action fails with a reason instead of running
         against a system that is no longer there. */
      const cap = await deps.registry.resolve(ctx, action.capability);
      if (!cap) {
        results.push({
          actionId: action.id,
          capability: action.capability,
          status: 'failed',
          message: 'That is no longer something Life OS can do.',
          error: 'capability_unavailable',
        });
        continue;
      }
      if (cap.kind !== 'mutate' || !cap.execute) {
        results.push({
          actionId: action.id,
          capability: action.capability,
          status: 'failed',
          message: 'That capability does not change anything.',
          error: 'not_a_mutation',
        });
        continue;
      }
      /* Validated against the CAPABILITY's schema, not against whatever the
         planner produced. A payload that drifted — a hallucinated field, a
         date in the wrong shape — is rejected here rather than reaching a
         service that would have to defend itself against it.

         The EXECUTION schema, which is the plan-time one for everything that
         does not preview. Where preview replaced the payload with a ledger
         handle, checking the handle against the schema for a full draft
         refuses a payload that is exactly right. */
      /* Placeholders become the ids the earlier actions produced. Done
         BEFORE validation, so what the schema checks is what will run: a
         uuid field validated while still holding "{{a1.id}}" would fail on
         a payload that is in fact correct. */
      const filled = substitute(action.payload, produced);
      if (filled.missing.length) {
        /* Unreachable via `blockedBy` — kept because executing a payload
           still carrying a placeholder would write the literal text. */
        results.push({
          actionId: action.id,
          capability: action.capability,
          status: 'skipped',
          message: 'Not done, because it needed a change that did not work.',
          error: 'dependency_failed',
        });
        continue;
      }

      const parsed = executionSchema(cap).safeParse(filled.payload);
      if (!parsed.success) {
        results.push({
          actionId: action.id,
          capability: action.capability,
          status: 'failed',
          message: parsed.error.issues[0]?.message ?? 'That change was not valid.',
          error: 'invalid_payload',
        });
        continue;
      }

      const r = await cap.execute(ctx, parsed.data);
      results.push({ actionId: action.id, capability: action.capability, ...r });
      if (r.status === 'done') {
        succeeded.add(action.id);
        if (r.ref?.id) produced.set(action.id, r.ref);
      }
    } catch (e) {
      /* One failure, one report. The batch continues: the other five
         agreements are still agreements. */
      results.push({
        actionId: action.id,
        capability: action.capability,
        status: 'failed',
        message: (e as Error).message || 'That change could not be made.',
        error: (e as Error).name || 'error',
      });
    }
  }

  /* Reported in the order the CARDS were shown, not the order they ran.
     Execution order is an implementation detail; a result list that
     reshuffles itself would make the report hard to check against the
     proposal the person actually agreed to. */
  const byAction = new Map(results.map((r) => [r.actionId, r]));
  const inOrder = set.actions
    .map((a) => byAction.get(a.id))
    .filter(Boolean) as ActionResult[];

  return {
    proposalSetId: set.id,
    results: inOrder,
    done: inOrder.filter((r) => r.status === 'done').length,
    failed: inOrder.filter((r) => r.status === 'failed').length,
    skipped: inOrder.filter((r) => r.status === 'skipped').length,
  };
}
