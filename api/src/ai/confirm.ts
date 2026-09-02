/**
 * Confirming a server-held proposal.
 *
 * ── What this protects against ───────────────────────────────────────────
 *
 * stale        the version confirmed is not the version stored → refused
 * fabricated   the actions come from the ROW, never from the request body
 * replay       a turn already executed returns its original result unchanged
 * concurrent   the status is moved to `executed` in the same statement that
 *              claims it, so two simultaneous confirms cannot both proceed
 * partial      one action failing leaves the others done and says so
 *
 * The request body carries only a turn id, a version and the acceptances. It
 * cannot name an action, cannot supply a payload, and cannot reach a
 * capability. Everything executable was written by the planner.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiTurns } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { execute } from './executor.js';
import type { CapabilityRegistry } from './registry.js';
import type { AiRequestContext, ProposalAction, ExecutionReport } from './types.js';

export type ConfirmDeps = {
  db: Db;
  registry: CapabilityRegistry;
  request: AiRequestContext;
};

export type ConfirmInput = {
  turnId: string;
  /** The version the user was looking at when they pressed the button. */
  version: number;
  /** How many changes the button said it would make. */
  count: number;
  /** Ids of important actions accepted individually. */
  importantAccepted: string[];
};

export type ConfirmResult = ExecutionReport & {
  turnId: string;
  /** True when this confirmation had already been carried out. */
  alreadyDone: boolean;
  /** One line for the user, in the same language the cards used. */
  headline: string;
};

/**
 * A sentence a person can check against what they agreed to.
 *
 * "3 completed, 1 needs attention" rather than "partial success". The failure
 * count is never rounded away and the success count is never inflated.
 */
function headlineFor(r: ExecutionReport): string {
  if (!r.done && !r.failed) return 'Nothing to do.';
  if (!r.failed) return r.done === 1 ? 'Done.' : `Done — ${r.done} changes.`;
  if (!r.done) return r.failed === 1 ? 'That did not work.' : `None of the ${r.failed} changes worked.`;
  return `${r.done} completed, ${r.failed} ${r.failed === 1 ? 'needs' : 'need'} attention.`;
}

export async function confirmTurn(deps: ConfirmDeps, input: ConfirmInput): Promise<ConfirmResult> {
  const { db, registry, request } = deps;

  const [row] = await db.select().from(aiTurns).where(and(
    eq(aiTurns.id, input.turnId),
    eq(aiTurns.workspaceId, request.workspaceId),
    eq(aiTurns.userId, request.userId),
  )).limit(1);
  if (!row) throw notFound('That suggestion is no longer here.');

  /* ── Replay ────────────────────────────────────────────────────────
     Already done. Return what it produced rather than doing it again —
     a retried confirm after a dropped connection must not create a second
     set of tasks. */
  if (row.status === 'executed' && row.results) {
    const results = row.results as unknown as ExecutionReport['results'];
    const report: ExecutionReport = {
      proposalSetId: row.id,
      results,
      done: results.filter((x) => x.status === 'done').length,
      failed: results.filter((x) => x.status === 'failed').length,
      skipped: results.filter((x) => x.status === 'skipped').length,
    };
    return { ...report, turnId: row.id, alreadyDone: true, headline: headlineFor(report) };
  }

  if (row.status === 'cancelled') throw badRequest('That suggestion was discarded.');
  if (row.status !== 'proposed') throw badRequest('There is nothing here to confirm.');
  if (row.version !== input.version) {
    throw badRequest('This changed after you saw it. Reload and check the list again.');
  }

  const actions = row.actions as unknown as ProposalAction[];
  if (!actions.length) throw badRequest('There are no changes to make.');

  /* ── Execute against the day it was PROPOSED on ────────────────────
     Confirming is a second request and carries no date, so the context
     built for it holds the server's own civil day. Anything that defaults
     a date at execution — a reminder with no date is the one that bit —
     would use a day the person may not be having, and a different one from
     the card they agreed to. The turn recorded its date; use that. */
  const planned = (row.metrics ?? {}) as { today?: string; timeZone?: string | null };
  const asPlanned = planned.today
    ? { ...request, today: planned.today, timeZone: planned.timeZone ?? null }
    : request;

  /* ── Claim ─────────────────────────────────────────────────────────
     Move to `executed` conditionally on it still being `proposed` and never
     yet executed. Two simultaneous confirms race here, and exactly one wins:
     the loser updates nothing and is told the work is already in hand. */
  const [claimed] = await db.update(aiTurns)
    .set({ status: 'executed', executedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(aiTurns.id, row.id),
      eq(aiTurns.status, 'proposed'),
      eq(aiTurns.version, input.version),
      isNull(aiTurns.executedAt),
    )).returning();
  if (!claimed) throw badRequest('Those changes are already being made.');

  let report: ExecutionReport;
  try {
    /* The actions come from the ROW. The request body could not name one. */
    report = await execute({ db, registry, request: asPlanned }, {
      id: row.id,
      request: row.request,
      understood: row.understood ?? '',
      actions,
      sources: [],
    } as any, {
      confirmed: true,
      count: input.count,
      importantAccepted: input.importantAccepted ?? [],
    });
  } catch (e) {
    /* The gate refused — a miscounted confirmation, an unaccepted important
       action. Nothing ran, so the claim is released and the proposal is left
       exactly as it was for the user to look at again. */
    await db.update(aiTurns)
      .set({ status: 'proposed', executedAt: null, updatedAt: new Date() })
      .where(eq(aiTurns.id, row.id));
    throw e;
  }

  await db.update(aiTurns)
    .set({
      results: report.results as unknown[],
      /* `failed` is a real outcome, not an error: three of four succeeding is
         three things that happened and must not be reported as a failure. */
      status: report.done > 0 || report.failed === 0 ? 'executed' : 'failed',
      updatedAt: new Date(),
    })
    .where(eq(aiTurns.id, row.id));

  return { ...report, turnId: row.id, alreadyDone: false, headline: headlineFor(report) };
}

/** Throw a proposal away without running any of it. */
export async function cancelTurn(deps: ConfirmDeps, turnId: string) {
  const [row] = await deps.db.update(aiTurns)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(
      eq(aiTurns.id, turnId),
      eq(aiTurns.workspaceId, deps.request.workspaceId),
      eq(aiTurns.userId, deps.request.userId),
      eq(aiTurns.status, 'proposed'),
    )).returning();
  if (!row) throw badRequest('There is nothing here to discard.');
  return { turnId, status: row.status };
}
