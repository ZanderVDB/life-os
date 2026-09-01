/**
 * One turn of the assistant.
 *
 * ── Three routes in, one set of rules out ────────────────────────────────
 *
 *   FAST      an obvious command — "add milk", "complete Morning walk".
 *             Parsed deterministically, no model, no reasoning chain.
 *   AMEND     a correction to something already on the table — "actually
 *             Saturday". Edits the PENDING proposal rather than proposing
 *             something new about a thing that does not exist yet.
 *   PLAN      everything else. Interpret, retrieve, rank, remember, plan,
 *             validate, preview, persist.
 *
 * They differ in how the actions are arrived at and in nothing else. All three
 * produce raw actions that go through the same normalisation: resolved through
 * the registry, validated against the capability's own schema, risk assigned
 * by the server, written into the same proposal row, run only by the same
 * confirmation gate. There is no downstream branch that knows which route a
 * proposal came from — which is what makes "the fast path is as safe as the
 * planner" a structural claim rather than a promise.
 *
 * ── The full route, in order ─────────────────────────────────────────────
 *
 *   interpret     what is this about, and which modules does it touch
 *   gather        surface → targeted search → relationship traversal
 *   fallback      a second, broader pass when the first found suspiciously
 *                 little for a request that implies something exists
 *   rank          twenty of two hundred rows, by signals Life OS already has
 *   memory        the durable facts that are relevant, not all of them
 *   plan          capabilities and rules FROM THE REGISTRY, never a prompt list
 *   validate      does the card say what the payload does — deterministically
 *   preview       calendar actions go through the mutation ledger, here
 *   persist       the proposal set is written down; the client gets its id
 *
 * The model appears once, in the middle, and is handed data. Everything before
 * it decides what it may see; everything after it decides what may happen.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiConversations, aiTurns } from '../db/schema.js';
import { badRequest, notFound, upstreamUnavailable } from '../lib/errors.js';
import { AiProviderError } from './provider.js';
import { forRequest, type CapabilityRegistry, type CapabilityCtx } from './registry.js';
import type { ProviderRouter } from './provider.js';
import { gather, forPrompt } from './context.js';
import { rank, rankMemories, tokens } from './ranking.js';
import { tryFastPath, isMiss, type RawAction } from './fastpath.js';
import {
  validatePlan, repairBrief, stillDescribes, retitleForDate, applyNamedWeekday,
  type Finding,
} from './validate.js';
import { probe, unprobe, placeholdersIn, planOrder } from './depends.js';
import {
  recentReferences, referenceCue, forPrompt as referencesForPrompt,
  type Reference,
} from './references.js';
import { structure, type Clarification } from './clarify.js';
import { classifyTiming, readingFromChoice } from '../lib/timing-intent.js';
import * as memory from './memory.js';
import type {
  AiRequestContext, ProposalAction, ContextSource, Confidence, EntityRef,
} from './types.js';

export type TurnDeps = {
  db: Db;
  registry: CapabilityRegistry;
  providers: ProviderRouter;
  request: AiRequestContext;
};

export type TurnInput = {
  text: string;
  /** Continues an existing thread. Omitted starts a new one. */
  conversationId?: string | null;
  /**
   * The entity the user picked from a clarification.
   *
   * Set only by `resolveClarification`. It is seeded into retrieval and named
   * to the planner by id, which is the whole point: the choice was already
   * exact and must not be re-derived from the text of a button.
   */
  resolved?: { ref: EntityRef | null; label: string } | null;
};

const refKey = (r: { type: string; id: string }) => `${r.type}:${r.id}`;

const parseRef = (s: string): EntityRef | null => {
  const at = s.indexOf(':');
  if (at < 1) return null;
  return { type: s.slice(0, at) as EntityRef['type'], id: s.slice(at + 1) };
};

/* ══ Conversation state ══════════════════════════════════════════════════ */

/**
 * What a follow-up needs to understand "actually make it Saturday".
 *
 * Deliberately NOT a transcript. What is needed is the last thing proposed and
 * the last thing asked — a few hundred bytes — and resending everything
 * forever gets more expensive and less accurate with every turn.
 */
export type ConversationState = {
  conversationId: string;
  summary: string | null;
  /** The most recent turn that still has something to act on. */
  pending: {
    turnId: string;
    version: number;
    understood: string;
    request: string;
    actions: ProposalAction[];
  } | null;
};

async function loadConversation(
  db: Db, request: AiRequestContext, conversationId?: string | null,
): Promise<ConversationState> {
  if (conversationId) {
    const [row] = await db.select().from(aiConversations).where(and(
      eq(aiConversations.id, conversationId),
      eq(aiConversations.workspaceId, request.workspaceId),
      eq(aiConversations.userId, request.userId),
    )).limit(1);
    if (!row) throw notFound('That conversation is not here.');

    const [last] = await db.select().from(aiTurns)
      .where(eq(aiTurns.conversationId, row.id))
      .orderBy(desc(aiTurns.createdAt)).limit(1);

    return {
      conversationId: row.id,
      summary: row.summary,
      /* Only a turn that is still PROPOSED has anything to amend. One already
         executed is history, and "make it Saturday" about it would be a new
         request rather than an edit. */
      pending: last && last.status === 'proposed' ? {
        turnId: last.id,
        version: last.version,
        understood: last.understood ?? '',
        request: last.request,
        actions: last.actions as unknown as ProposalAction[],
      } : null,
    };
  }
  const [made] = await db.insert(aiConversations).values({
    workspaceId: request.workspaceId, userId: request.userId,
  }).returning();
  return { conversationId: made!.id, summary: null, pending: null };
}

/* ══ The turn ════════════════════════════════════════════════════════════ */

export type TurnResult = {
  turnId: string;
  conversationId: string;
  version: number;
  status: string;
  understood: string;
  answer: string | null;
  actions: ProposalAction[];
  clarification: Clarification | null;
  /** What was asked for but could not be turned into a real action. */
  note: string | null;
  /** True when this turn changed a proposal that was already on the table. */
  amended?: boolean;
  /** What informed this, for the "where did you get that" question. */
  sources: { ref: EntityRef; title: string; module: string; via: string; path?: unknown }[];
  metrics: Record<string, unknown>;
};

/**
 * Words that mean "change what you just offered me".
 *
 * Used as a CHEAP gate, never as the decision. Matching means the pending
 * proposal is handed to the planner WITHOUT a retrieval pass first, because a
 * correction to something on the table refers to the table. The planner still
 * decides whether it is an amendment; not matching simply means retrieval runs
 * first, and an amendment is still possible after it.
 */
const AMENDMENT = new RegExp([
  '^\\s*(actually|no,|no\\.|wait|sorry|scratch that|instead)\\b',
  '^\\s*(make it|change it|change that|change the|set it|move it|push it)\\b',
  "^\\s*(don'?t|do not|drop|remove|cancel|skip|forget)\\b",
  '^\\s*(only|just)\\s+(the|those|these|do)\\b',
].join('|'), 'i');

export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnResult> {
  const started = Date.now();
  const { db, registry, providers, request } = deps;
  const text = input.text.trim();
  if (!text) throw badRequest('Say something first.');

  const ctx = forRequest(db, request);
  const conversation = await loadConversation(db, request, input.conversationId);

  /* ── Route 1: the obvious command ─────────────────────────────────── */
  const fast = input.resolved
    ? { reason: 'continuing a clarification' } as const
    : await tryFastPath({
      text, ctx, registry, hasPending: Boolean(conversation.pending),
    });

  if (!isMiss(fast)) {
    const built = await buildActions(deps, ctx, fast.actions, new Map());
    /* If anything at all went wrong turning the fast reading into a real
       action, this was not the obvious command it looked like. Fall through to
       the planner rather than showing a note about a failure the user could
       not have caused. */
    if (built.actions.length === fast.actions.length && !built.rejected.length) {
      return persistTurn(deps, {
        conversation,
        text,
        understood: fast.understood,
        answer: null,
        actions: built.actions,
        clarification: null,
        note: null,
        ranked: [],
        metrics: { ms: Date.now() - started, route: 'fast', shape: fast.shape, model: null },
      });
    }
  }
  const fastMiss = isMiss(fast) ? fast.reason : 'the fast reading did not hold up';

  const planner = providers.for('plan');
  if (!planner?.plan) {
    throw badRequest('The assistant is not connected to a model yet.');
  }

  /* ── Route 2: amend what is already on the table ───────────────────── */
  /* A short correction to a pending proposal needs no retrieval: everything it
     refers to is in the proposal itself. Skipping the search is most of the
     latency of a follow-up. */
  const amendOnly = Boolean(conversation.pending)
    && AMENDMENT.test(text) && text.split(/\s+/).length <= 14;

  /* ── 1. Interpret ─────────────────────────────────────────────────── */
  const status = await registry.status(ctx);
  const enabled = status.filter((s) => s.enabled);
  const moduleIds = enabled.map((s) => s.id);

  const interpreter = amendOnly ? null : providers.for('interpret');
  const read = interpreter?.interpret
    ? await interpreter.interpret({ text, request, modules: moduleIds }).catch(() => null)
    : null;

  /* ── What "it" could mean ─────────────────────────────────────────
     Stable ids from this conversation's own previous turns, with titles read
     fresh. Loaded BEFORE retrieval because a sentence leaning on "it" gives
     retrieval nothing to search for — the antecedent has to be seeded in, or
     the assistant answers about the right thing having read nothing about
     it. */
  const references = await recentReferences(
    db, request.workspaceId, conversation.conversationId,
  ).catch(() => [] as Reference[]);
  const cue = referenceCue(text);

  /* Seeded only when the sentence actually refers back, and narrowed to the
     type when the words say which — "the project" should not drag in the
     three tasks that were also mentioned. Everything else stays out: a list
     of twelve entities attached to every turn is not context, it is noise
     that crowds out what was actually asked about. */
  const referenceSeeds = cue.present
    ? references
      .filter((r) => !cue.type || r.type === cue.type)
      .slice(0, cue.type ? 3 : 2)
      .map((r) => ({ type: r.type, id: r.id }))
    : [];

  /* ── 2. Retrieve ──────────────────────────────────────────────────── */
  const retrieval = amendOnly
    ? {
      pool: [] as ContextSource[], used: new Set<string>(),
      failed: [] as { capability: string; reason: string }[],
      queries: [] as string[], rankQuery: '', broadened: false,
    }
    : await retrieve(deps, ctx, {
      text,
      queries: read?.queries ?? [],
      seeds: [
        ...(input.resolved?.ref ? [input.resolved.ref] : []),
        ...referenceSeeds,
      ],
    });

  const ranked = amendOnly ? [] : rank(retrieval.pool, {
    query: retrieval.rankQuery,
    today: request.today,
    surface: request.surface?.entity ?? null,
  }, 24);

  /* ── 3. Memory ────────────────────────────────────────────────────── */
  const owner = { workspaceId: request.workspaceId, userId: request.userId };
  const known = await memory.list(db, owner).catch(() => []);
  const relevant = rankMemories(known, text, 10);
  /* Noted as used, so the ones that earn their place stay near the top. Never
     blocks the turn. */
  if (relevant.length) {
    void memory.touchUsed(db, owner, relevant.map((m) => m.id)).catch(() => {});
  }

  /* ── 4. Plan ──────────────────────────────────────────────────────── */
  /* What the date in this request means, read from the USER'S words. Decided
     once, handed to the planner, and checked against the payload afterwards —
     the same shape as the calendar, and for the same reason. */
  const timing = classifyTiming(text);
  /* Unless the user has just answered the question. A clarification exists to
     settle exactly this, so continuing to call the wording ambiguous would
     make the answer unusable and ask again for ever. */
  const chosen = input.resolved ? readingFromChoice(input.resolved.label) : null;
  if (chosen) timing.reading = chosen;
  const described = await registry.describe(ctx);
  const planInput = {
    text,
    request,
    capabilities: described.capabilities,
    rules: enabled.map((s) => ({ module: s.id, rules: s.rules })),
    routing: described.routing,
    /* Readable but not writable — stated rather than left to be inferred from
       an absence, so "I can see that meeting but cannot move it" is reachable. */
    readOnly: described.readOnly,
    timing,
    /* And why the missing ones are missing. A disconnected calendar should
       produce "your calendar is not connected", never "I cannot find it". */
    unavailable: described.unavailable,
    sources: forPrompt(ranked),
    references: referencesForPrompt(references),
    memory: relevant.map((m) => ({ category: m.category, fact: m.fact })),
    ...(conversation.pending ? {
      pending: {
        understood: conversation.pending.understood,
        request: conversation.pending.request,
        actions: conversation.pending.actions.map((a) => ({
          id: a.id, capability: a.capability, title: a.title,
          payload: a.payload, enabled: a.enabled,
        })),
      },
    } : {}),
    ...(input.resolved ? { resolved: input.resolved } : {}),
  };
  /* A provider failure is not an internal error, and the provider already
     wrote the sentence for it — "rate limited, try again shortly", "took too
     long to answer". Left to fall through it became a 500 and the user was
     told "Something went wrong", which is the one thing §12 says never to
     say when the server knows exactly what went wrong. */
  let plan = await planner.plan(planInput as any).catch((e: unknown) => {
    throw asClientError(e);
  });

  /* ── Route 2, continued: an amendment is an EDIT ───────────────────── */
  const amendments = ((plan as any).amend ?? []) as {
    actionId: string; enabled?: boolean | null; fields?: Record<string, any> | null;
  }[];
  if (amendments.length && conversation.pending) {
    return applyAmendment(deps, conversation, plan.understood, amendments, text, {
      ms: Date.now() - started, route: 'amend', model: planner.model ?? null,
    });
  }

  /* ── 5. Consistency, before anything is shown ──────────────────────── */
  const knownIds = new Set<string>(ranked.map((s) => refKey(s.ref)));
  if (request.surface?.entity) knownIds.add(refKey(request.surface.entity));
  /* An id this conversation already established is known, even when this
     turn's retrieval did not happen to return it — "make that urgent" is
     about something named a moment ago, and searching for "that" finds
     nothing. Without this the validator would reject the one id that is
     certainly right. */
  for (const r of references) knownIds.add(refKey(r));
  if (input.resolved?.ref) knownIds.add(refKey(input.resolved.ref));
  for (const a of conversation.pending?.actions ?? []) {
    if (a.target) knownIds.add(refKey(a.target));
  }

  /* ── The named day, applied before anything is judged ──────────────
     A card saying "Friday" over a date that is not a Friday has one right
     answer and the resolver already knows it. Correcting it here means the
     user gets what they asked for rather than a note explaining why they did
     not — asking the model again was tried, and it produced the same wrong
     day. Visible on the card, and editable, before anything is confirmed. */
  const dayFixes: string[] = [];
  for (const a of (plan.actions ?? []) as any[]) {
    const words = [a.title, a.summary ?? '', ...(a.assumptions ?? [])].join('. ');
    const fixed = applyNamedWeekday(words, a.payload ?? {}, request.today);
    if (fixed.changed) {
      a.payload = fixed.payload;
      dayFixes.push(fixed.changed);
    }
  }

  const schemas = await schemaMap(deps, ctx, (plan.actions ?? []) as any);
  const validateInput = {
    schemas,
    knownIds,
    today: request.today,
    timing,
    /* A clarification means the turn is ASKING rather than deciding, which is
       exactly what ambiguous wording should produce — so the ambiguity check
       has nothing to complain about. */
    asking: Boolean((plan as any).clarification),
  };
  let findings = validatePlan({ ...validateInput, actions: (plan.actions ?? []) as any });
  /* What was FOUND, kept separately from what survived. A successful repair
     empties `findings`, and reporting only that made a turn where the model
     got the date wrong and was corrected look identical to one where it got
     the date right — which is exactly the thing worth being able to count. */
  const found = findings.map((f) => f.code);
  let repaired = 0;

  if (findings.some((f) => f.repairable)) {
    /* ONE attempt, with the specific complaint. A model told exactly which
       field contradicts which sentence usually fixes it; a model asked twice
       is a model that is going to keep being wrong more slowly. */
    const brief = repairBrief(findings, (plan.actions ?? []) as any);
    const retry = await planner.plan({
      ...planInput,
      repair: { problems: brief, previous: plan.actions },
    } as any).catch(() => null);   // a failed repair keeps the original plan
    if (retry) {
      const retrySchemas = await schemaMap(deps, ctx, (retry.actions ?? []) as any);
      const after = validatePlan({
        ...validateInput,
        actions: (retry.actions ?? []) as any,
        schemas: retrySchemas,
        asking: Boolean((retry as any).clarification),
      });
      /* Kept only if it is actually better. A repair that trades one
         inconsistency for another is not a repair. */
      if (after.length < findings.length) {
        plan = retry;
        findings = after;
        repaired = 1;
        for (const [id, s] of retrySchemas) schemas.set(id, s);
      }
    }
  }

  /* ── 6. Normalise into server-authored actions ────────────────────── */
  const dropped = new Set(findings.map((f) => f.index));
  const built = await buildActions(
    deps, ctx, (plan.actions ?? []) as any,
    new Map(ranked.map((s) => [refKey(s.ref), s as ContextSource])),
    dropped,
  );

  /* An action withheld by validation is a change the user asked for and is not
     going to get. It is named, in words about the request rather than about
     the check that stopped it. */
  for (const f of findings) {
    const a = ((plan.actions ?? []) as any[])[f.index];
    built.rejected.push({
      capability: a?.capability ?? 'unknown',
      reason: humanFinding(f, a?.title ?? ''),
    });
  }

  const note = built.rejected.length
    ? `${built.rejected.length === 1 ? 'One thing' : `${built.rejected.length} things`} could not be prepared: `
      + `${[...new Set(built.rejected.map((r) => r.reason))].join('; ')}.`
    : null;

  /* ── 7. Clarification, made addressable ───────────────────────────── */
  const clarification = structure((plan as any).clarification, ranked);

  return persistTurn(deps, {
    conversation,
    text,
    understood: plan.understood,
    answer: plan.answer ?? null,
    actions: built.actions,
    clarification,
    note,
    ranked,
    metrics: {
      ms: Date.now() - started,
      route: 'planner',
      /* Why the cheap route declined. Operating information, never shown. */
      fastPathMiss: fastMiss,
      amendOnly,
      retrieved: retrieval.pool.length,
      broadened: retrieval.broadened,
      ranked: ranked.length,
      queries: retrieval.queries.length,
      actions: built.actions.length,
      rejected: built.rejected.length,
      inconsistencies: found,
      /* What still disagreed after the one repair attempt, and was withheld. */
      unresolved: findings.map((f) => f.code),
      /* WHY, in the words the planner was given. A code says which check
         fired; only the detail says which value it fired on, and "the note
         said the date was wrong" is not something anybody can act on without
         knowing what date it used. Operating information: it names fields and
         values from a payload the user never saw, and it stays out of the
         interface. */
      inconsistencyDetail: findings.map((f) => f.detail),
      /* Dates the resolver corrected before anything was judged. */
      dayFixes,
      repaired,
      memoriesUsed: relevant.length,
      capabilitiesUsed: [...retrieval.used],
      /* Empty in normal operation. Anything here means retrieval was quietly
         worse than it should have been, which is the hardest kind of fault to
         notice from the outside. */
      retrievalFailures: retrieval.failed,
      model: planner.model ?? null,
    },
    rejectedDetail: built.rejected,
  });
}

/**
 * A provider failure, in a shape the client can render.
 *
 * `shape` is the one that is genuinely ours: the model answered and could not
 * be made to answer correctly, which is a bad request to a model rather than a
 * broken dependency. Everything else is somebody else's bad minute, and 503
 * says "this is expected to pass" where 500 says "this is broken".
 */
function asClientError(e: unknown): unknown {
  if (!(e instanceof AiProviderError)) return e;
  return e.kind === 'shape' ? badRequest(e.message) : upstreamUnavailable(e.message);
}

/* ══ Retrieval ═══════════════════════════════════════════════════════════ */

/**
 * Search hard, then search harder if the first pass looks wrong.
 *
 * ── Why the queries are not the sentence ─────────────────────────────────
 *
 * Search is `ILIKE '%…%'`, which matches a SUBSTRING. A phrase almost never is
 * one: "reconciling against the bank" appears in no title, while "reconcile"
 * and "bank" both do. So the interpreter's phrases are expanded into
 * distinctive words, crude stems and singular/plural variants — and the
 * phrases are kept as well, because an exact title match outranks everything
 * and is worth the one extra query.
 *
 * Getting this wrong is silent: retrieval returns nothing, the planner is
 * handed an empty context, and it reports that the thing does not exist.
 */
async function retrieve(
  deps: TurnDeps, ctx: CapabilityCtx,
  opts: { text: string; queries: string[]; seeds: EntityRef[] },
) {
  const { registry, request } = deps;
  const phrases = (opts.queries.length ? opts.queries : [opts.text]).slice(0, 5);
  const words = tokens(phrases.join(' '));

  /* ── Shorter is broader, so search the shortest safe form ────────────
   *
   * `ILIKE '%x%'` is substring matching, which means a SHORTER query matches
   * everything a longer one does and more. Two consequences, and the second
   * one was costing real hits:
   *
   *   · a prefix of a long word covers its inflections. "I finished pricing
   *     three options" has to find the task called "Price three options", and
   *     `%pricing%` does not match it while `%pric%` does. A real stemmer is a
   *     dependency and a vocabulary; a prefix is neither.
   *   · a query that CONTAINS another query is redundant. `%invoice%` already
   *     matches "Invoices", so searching for the plural as well buys nothing —
   *     and it used to buy nothing while occupying one of a fixed number of
   *     slots. On a long sentence the slots filled with whole words and the
   *     stems were cut off the end, which is how "pricing" failed to find
   *     "Price".
   *
   * So each word contributes ONE query in its broadest safe form, anything
   * containing another query is dropped, and the budget goes on distinct
   * meanings rather than on spellings of the same one. */
  const broadest = (w: string) => {
    if (w.length >= 6) return w.slice(0, Math.max(4, w.length - 3));
    if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
    return w;
  };
  const candidates = [...new Set([
    ...words.map(broadest),
    /* Kept only when short enough to be a real name rather than a sentence.
       An exact title is the strongest ranking signal there is. */
    ...phrases.filter((q) => q.trim().length >= 2 && q.trim().split(/\s+/).length <= 3)
      .map((q) => q.trim().toLowerCase()),
  ])];
  const queries = candidates
    .filter((q) => q.length >= 2
      && !candidates.some((other) => other !== q && other.length < q.length && q.includes(other)))
    .slice(0, 14);

  /* Ranking sees the ORIGINAL words. A stem is right for a substring search
     and wrong for token overlap: "pric" is not a word and matches nothing in
     a title's own tokens. */
  const rankQuery = [...phrases, ...words].join(' ');

  const used = new Set<string>();
  const failed: { capability: string; reason: string }[] = [];
  const seen = new Map<string, ContextSource>();
  const absorb = (rows: ContextSource[]) => {
    for (const src of rows) {
      const k = refKey(src.ref);
      const prev = seen.get(k);
      /* Lowest level wins: something found on the current surface is a better
         description of itself than the same thing found again by a broad
         search, and the surface copy carries the fuller data. */
      if (!prev || src.level < prev.level) seen.set(k, src);
    }
  };

  /* Every query CONCURRENTLY. Twelve independent searches finish in the time
     of the slowest, not the sum of all twelve. */
  const run = async (qs: string[], level: 1 | 2 | 3, depth: number) => {
    const results = await Promise.all(qs.map((q) => gather(ctx, registry, {
      query: q, level, traverseDepth: depth, limit: 80,
    })));
    for (const g of results) {
      absorb(g.sources);
      g.used.forEach((u) => used.add(u));
      failed.push(...g.failed);
    }
  };

  await Promise.all([
    run(queries, 2, 2),
    /* Level 1 always: what is on screen matters even when nothing was
       searched, and a clarification's chosen entity is a seed of the same
       kind — known exactly, and read in full. */
    (async () => {
      if (!request.surface?.entity && !opts.seeds.length) return;
      const g = await gather(ctx, registry, {
        level: 1, traverseDepth: 1, limit: 24, seeds: opts.seeds,
      });
      absorb(g.sources);
      g.used.forEach((u) => used.add(u));
      failed.push(...g.failed);
    })(),
  ]);

  /* ── Structural expansion ────────────────────────────────────────────
     A project's own tasks are not `item_links` — they are a foreign key — so
     traversal never reaches them. Without this the assistant finds the project
     the question is about and then says it would need to read it, which is
     both true and useless. So the top few hits are read in full, which is what
     a person would have clicked. */
  await expand(deps, ctx, seen, used, rankQuery, 6);

  /* ── The low-result fallback ─────────────────────────────────────────
     When a targeted pass found almost nothing, the likely explanation is that
     the words in the request are not the words in any title — not that the
     workspace is empty. Going broad costs one more round of parameterless
     reads and is the difference between "I could not find it" and finding it.

     It used to require a change verb in the request. That was wrong in the
     most ordinary case there is: "what is on my Today board?" contains no
     verb, matches no title, and so retrieved nothing at all and was answered
     "I cannot see your Today board". Suspiciously little is suspicious
     whatever the sentence was doing. */
  let broadened = false;
  if (seen.size < 3) {
    broadened = true;
    await run(queries.slice(0, 6), 3, 2);
    await expand(deps, ctx, seen, used, rankQuery, 4);
  }

  return { pool: [...seen.values()], used, failed, queries, rankQuery, broadened };
}

/** Read the strongest hits in full, so their structural children come too. */
async function expand(
  deps: TurnDeps, ctx: CapabilityCtx, seen: Map<string, ContextSource>,
  used: Set<string>, query: string, howMany: number,
) {
  const pool = [...seen.values()];
  if (!pool.length) return;
  const preliminary = rank(pool, {
    query, today: deps.request.today, surface: deps.request.surface?.entity ?? null,
  }, howMany);

  const caps = await deps.registry.capabilities(ctx);
  const reads = await Promise.all(preliminary.map(async (top) => {
    const owner = deps.registry.moduleForEntity(top.ref.type);
    const cap = owner && caps.find((c) => c.kind === 'read' && c.module === owner.id
      && c.id.endsWith('.read'));
    if (!cap?.run) return [] as ContextSource[];
    const parsed = cap.input.safeParse({ id: top.ref.id });
    if (!parsed.success) return [] as ContextSource[];
    used.add(cap.id);
    return cap.run(ctx, parsed.data).catch(() => [] as ContextSource[]);
  }));
  for (const rows of reads) {
    for (const r of rows) {
      const k = refKey(r.ref);
      if (!seen.has(k)) seen.set(k, r);
    }
  }
}

/* ══ Turning a plan into server-authored actions ═════════════════════════ */

/** The capability schemas the plan actually names, for the consistency pass. */
async function schemaMap(deps: TurnDeps, ctx: CapabilityCtx, actions: { capability: string }[]) {
  const out = new Map<string, any>();
  for (const a of actions ?? []) {
    if (!a?.capability || out.has(a.capability)) continue;
    const cap = await deps.registry.resolve(ctx, a.capability);
    if (cap) out.set(a.capability, cap.input);
  }
  return out;
}

async function buildActions(
  deps: TurnDeps, ctx: CapabilityCtx, raws: RawAction[],
  byKey: Map<string, ContextSource>, skip: Set<number> = new Set(),
) {
  const actions: ProposalAction[] = [];
  const rejected: { capability: string; reason: string }[] = [];

  for (const [i, raw] of (raws ?? []).entries()) {
    if (skip.has(i)) continue;
    /* Resolved through the REGISTRY, so a capability the model invented, one
       belonging to a module that is off, and one belonging to a module that
       has gone read-only all fail here identically. */
    const cap = await deps.registry.resolve(ctx, raw.capability);
    if (!cap || cap.kind !== 'mutate') {
      const why = await deps.registry.explain(ctx, raw.capability);
      rejected.push({
        capability: raw.capability,
        reason: why.available ? 'that is not a change Life OS can make' : why.reason,
      });
      continue;
    }
    /* Validated through a PROBE, so a field holding `{{a1.id}}` — an id the
       action it depends on has not produced yet — is checked as the uuid it
       will become rather than rejected as the text it currently is. Only the
       placeholders differ; every other rule still applies. */
    const parsed = cap.input.safeParse(probe(raw.payload as Record<string, unknown>));
    if (!parsed.success) {
      /* Rejected HERE rather than at execution. A card the user confirms and
         which then fails on a shape error is the worst of both: they agreed to
         it and it did not happen.

         The reason is written for a person. Zod's own message is a field-level
         fragment — "Required" — which says nothing on its own; naming the
         action and the field is the difference between a note somebody can act
         on and one they can only be puzzled by. */
      const issue = parsed.error.issues[0];
      const field = issue?.path?.filter((p) => typeof p === 'string').join('.') ?? '';
      const detail = issue?.message === 'Required' && field
        ? `no ${field} was given`
        : (issue?.message ?? 'the details were not valid').toLowerCase();
      rejected.push({
        capability: raw.capability,
        reason: `${raw.title || cap.label} — ${detail}`,
      });
      continue;
    }

    const warnings = [...(raw.warnings ?? [])];
    let summary = raw.summary ?? null;
    /* Validated data, with the placeholders put BACK. What is stored and
       later confirmed must still say `{{a1.id}}`; storing the probe would be
       storing an id that was never created. */
    let payload: Record<string, unknown> = unprobe(
      parsed.data, raw.payload as Record<string, unknown>,
    );

    /* ── Calendar preview, at plan time ─────────────────────────────
       An external write is previewed BEFORE the user is asked, so the card
       can carry the real conflicts and the real wording, and so the mutation
       ledger has recorded the proposal. Execution then takes only the
       requestId — there is no path to Google that was not proposed first. */
    if (cap.preview) {
      try {
        const pv = await cap.preview(ctx, parsed.data);
        warnings.push(...(pv.warnings ?? []));
        if (pv.summary) summary = pv.summary;
        /* The confirmed action carries the ledger handle, plus anything the
           preview explicitly asked to keep and has already validated. */
        if (pv.handle) payload = { requestId: pv.handle, ...(pv.carry ?? {}) };
      } catch (e) {
        rejected.push({ capability: raw.capability, reason: (e as Error).message });
        continue;
      }
    }

    const sources = (raw.sources ?? [])
      .map(parseRef).filter(Boolean)
      .filter((r) => byKey.has(refKey(r!))) as EntityRef[];

    actions.push({
      /* Numbered by the PLANNER's own index, not by how many survived.
         `{{a2.id}}` means the second action the model wrote; if the first is
         rejected and everything shuffles up, that reference silently becomes
         a reference to something else. Gaps in the numbering are harmless —
         the ids are opaque handles — and a reference to a rejected action
         then fails loudly as an unknown one, which is the truth. */
      id: `a${i + 1}`,
      capability: cap.id,
      module: cap.module,
      title: raw.title,
      summary,
      payload,
      target: sources[0] ?? null,
      confidence: (raw.confidence ?? 'medium') as Confidence,
      assumptions: (raw.assumptions ?? []).slice(0, 6),
      warnings: warnings.slice(0, 6),
      /* The SERVER decides what needs confirming, from the capability's risk.
         A model that classified its own permission level could lower it. */
      requiresConfirmation: true,
      important: cap.risk === 'important' || cap.risk === 'external',
      editable: editableFor(cap.id, payload),
      enabled: true,
      sources,
    });
  }
  /* ── Is the set actually runnable? ───────────────────────────────
     A reference to an action that was rejected, a loop, an action pointing
     at itself: none of these can be carried out, and all of them look
     perfectly reasonable on a card. Caught here, before anything is shown,
     because the alternative is a person confirming a set of changes that
     was never going to work. The dependent is dropped, not the whole set —
     "create the task" is still worth doing when only the link is broken. */
  /* Repeated until it settles: dropping a broken action orphans anything
     that depended on IT, and reporting only the first round would leave a
     link pointing at a schedule that is no longer being made. */
  let live = actions;
  for (;;) {
    const { problems } = planOrder(live);
    if (!problems.length) break;
    const broken = new Set(problems.map((x) => x.actionId));
    for (const a of live.filter((x) => broken.has(x.id))) {
      rejected.push({
        capability: a.capability,
        reason: `${a.title} — it depends on a change that is not being made`,
      });
    }
    live = live.filter((a) => !broken.has(a.id));
  }

  return { actions: live, rejected };
}

/** A validation finding, said in terms of the request rather than the check. */
function humanFinding(f: Finding, title: string): string {
  const what = title ? `“${title}”` : 'one change';
  switch (f.code) {
    case 'payload_invalid': {
      /* The one case where the specific detail beats a category. "no id was
         given" tells somebody what happened; "did not hold together" does
         not. */
      const detail = f.detail.split(': ').slice(1).join(': ').split('.')[0];
      return detail ? `${what} — ${detail}` : `${what} was missing something it needs`;
    }
    case 'weekday_mismatch':
      return `${what} named a day of the week that the date it used is not`;
    case 'date_missing': case 'date_not_supported':
      return `${what} named a date the change would not actually have set`;
    case 'time_missing':
      return `${what} named a time the change would not actually have set`;
    case 'due_vs_scheduled': case 'scheduled_vs_due':
      return `${what} mixed up a deadline with when to do it`;
    case 'timing_ambiguous':
      return `${what} needed to know whether that date is a deadline or when to do it`;
    case 'kind_mismatch':
      return `${what} would have created something new rather than changing what exists`;
    case 'unknown_id':
      return `${what} referred to something not found in your workspace`;
    case 'ends_before_starts':
      return `${what} ended before it began`;
    case 'time_without_date':
      return `${what} had a time but no day`;
    case 'empty_change':
      return `${what} would not have changed anything`;
    default:
      return `${what} did not hold together`;
  }
}

/* ══ Persisting ══════════════════════════════════════════════════════════ */

async function persistTurn(deps: TurnDeps, p: {
  conversation: ConversationState;
  text: string;
  understood: string;
  answer: string | null;
  actions: ProposalAction[];
  clarification: Clarification | null;
  note: string | null;
  ranked: ContextSource[];
  metrics: Record<string, unknown>;
  rejectedDetail?: unknown;
}): Promise<TurnResult> {
  const { db, request } = deps;
  const sourceRefs = p.ranked.slice(0, 20).map((s) => ({
    ref: s.ref, title: s.title, module: s.module, via: s.via,
    ...(s.path ? { path: s.path } : {}),
  }));

  /* A turn that asked a question of its own is neither answered nor proposed.
     Saying so is what lets the client tell "I need something from you" apart
     from "here is your answer", and lets the choice be resolved by id. */
  const status = p.actions.length ? 'proposed'
    : p.clarification ? 'clarifying' : 'answered';

  const [row] = await db.insert(aiTurns).values({
    workspaceId: request.workspaceId,
    userId: request.userId,
    conversationId: p.conversation.conversationId,
    request: p.text,
    understood: p.understood,
    answer: p.answer,
    status,
    actions: p.actions as unknown[],
    clarification: (p.clarification ?? null) as any,
    sources: sourceRefs as unknown[],
    metrics: p.metrics,
  }).returning();

  await db.update(aiConversations)
    .set({ lastTurnAt: new Date(), updatedAt: new Date() })
    .where(eq(aiConversations.id, p.conversation.conversationId));

  /* Memory extraction runs AFTER the answer is ready, and never blocks it. A
     durable fact is worth noticing; it is not worth making the user wait. */
  void extractMemories(deps, p.text).catch(() => {});
  void sweep(deps).catch(() => {});

  return {
    turnId: row!.id,
    conversationId: p.conversation.conversationId,
    version: row!.version,
    status: row!.status,
    understood: p.understood,
    answer: p.answer,
    note: p.note,
    actions: p.actions,
    clarification: p.clarification,
    sources: sourceRefs,
    metrics: { ...p.metrics, ...(p.rejectedDetail ? { rejectedDetail: p.rejectedDetail } : {}) },
  };
}

/* ══ Amending a pending proposal ═════════════════════════════════════════ */

/**
 * "Actually Saturday" — applied to the proposal that is still on the table.
 *
 * The failure this removes: the assistant heard "actually Saturday", searched
 * for a haircut task, found none — because it had only been PROPOSED, never
 * created — and reported that the thing did not exist. A pending proposal is
 * part of the conversation, and it is addressable before it becomes a Life OS
 * object.
 *
 * The amendment goes through `editTurn`, which is the same validated path the
 * card's own edit control uses: every field checked against the capability's
 * schema, the version bumped, the confirmation gate untouched. Saying a
 * correction has exactly the power of typing one into the card, and no more.
 */
async function applyAmendment(
  deps: TurnDeps, conversation: ConversationState, understood: string,
  amendments: { actionId: string; enabled?: boolean | null; fields?: Record<string, any> | null }[],
  text: string, metrics: Record<string, unknown>,
): Promise<TurnResult> {
  const pending = conversation.pending!;
  const edits = amendments
    .filter((a) => pending.actions.some((x) => x.id === a.actionId))
    .map((a) => ({
      actionId: a.actionId,
      ...(a.enabled === true || a.enabled === false ? { enabled: a.enabled } : {}),
      ...(a.fields && Object.keys(a.fields).length ? { fields: a.fields } : {}),
    }))
    .filter((e) => 'enabled' in e || 'fields' in e);

  if (!edits.length) throw badRequest('That does not match anything still waiting for you.');

  const applied = await editTurn(deps, pending.turnId, pending.version, edits);

  /* Recorded on the proposal itself rather than as a second proposal row.
     There is one set of changes on the table; amending it must not produce a
     second set the user could confirm by accident. */
  const [row] = await deps.db.select().from(aiTurns)
    .where(eq(aiTurns.id, pending.turnId)).limit(1);
  const prior = (row?.metrics ?? {}) as Record<string, unknown>;
  const history = Array.isArray(prior['amendments']) ? prior['amendments'] as unknown[] : [];
  await deps.db.update(aiTurns).set({
    understood,
    metrics: { ...prior, amendments: [...history, { text, at: new Date().toISOString() }] } as any,
    updatedAt: new Date(),
  }).where(eq(aiTurns.id, pending.turnId));

  return {
    turnId: pending.turnId,
    conversationId: conversation.conversationId,
    version: applied.version,
    status: 'proposed',
    understood,
    answer: null,
    actions: applied.actions,
    clarification: null,
    note: null,
    amended: true,
    sources: (row?.sources ?? []) as any,
    metrics: { ...metrics, amended: edits.length },
  };
}

/**
 * Which fields a card may offer for editing.
 *
 * Derived from the capability rather than asked of the model: a model that
 * chose its own editable fields could omit the one the user most needs to
 * correct. Kept small — the fields people actually get wrong are when, and
 * what it is called.
 */
function editableFor(capabilityId: string, payload: Record<string, unknown>) {
  const out: ProposalAction['editable'] = [];
  const put = (key: string, label: string, type: any, value: unknown) => {
    if (value === undefined) return;
    out.push({ key, label, type, value: (value ?? null) as any });
  };
  const p = payload as any;
  const inner = (p.changes ?? p) as Record<string, unknown>;

  if (typeof inner['title'] === 'string') put('title', 'Title', 'text', inner['title']);
  if ('dueDate' in inner) put('dueDate', 'Due', 'date', inner['dueDate']);
  if ('scheduledAt' in inner) put('scheduledAt', 'When', 'text', inner['scheduledAt']);
  if ('date' in inner) put('date', 'Date', 'date', inner['date']);
  if ('dueTime' in inner) put('dueTime', 'Time', 'time', inner['dueTime']);
  if ('notes' in inner) put('notes', 'Notes', 'note', inner['notes']);
  /* A calendar action's payload after preview is only a ledger handle, and
     editing it would mean editing a proposal Google has already been told
     about. The way to change one is to say so, which re-plans and re-previews. */
  if (capabilityId.startsWith('event.')) return [];
  return out;
}

/* ══ Housekeeping ════════════════════════════════════════════════════════ */

/**
 * Retention, run occasionally and never in the user's way.
 *
 * There is no scheduler in Life OS and adding one for this would be the wrong
 * shape of solution: the work is seconds of deletes, a few times a day, for a
 * workspace somebody is actively using. So it rides along behind a turn that
 * has already been answered, at most once every six hours per workspace, and a
 * failure is silent because nothing depends on it having run.
 */
const swept = new Map<string, number>();
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

async function sweep(deps: TurnDeps) {
  const key = `${deps.request.workspaceId}:${deps.request.userId}`;
  const last = swept.get(key) ?? 0;
  if (Date.now() - last < SWEEP_EVERY_MS) return;
  swept.set(key, Date.now());
  await memory.housekeeping(deps.db, {
    workspaceId: deps.request.workspaceId, userId: deps.request.userId,
  });
}

/* ══ Memory extraction ═══════════════════════════════════════════════════ */

async function extractMemories(deps: TurnDeps, text: string) {
  const extractor = deps.providers.for('extractMemory');
  if (!extractor?.extractMemory) return;
  const owner = { workspaceId: deps.request.workspaceId, userId: deps.request.userId };
  const known = await memory.list(deps.db, owner);
  const candidates = await extractor.extractMemory({
    text,
    request: deps.request,
    known: known.map((k) => ({ id: k.id, category: k.category, fact: k.fact })),
  });
  if (!candidates.length) return;
  /* Through the service, which deduplicates and queues. Nothing here believes
     anything — a candidate becomes a memory when a person says so. */
  await memory.proposeMemories(deps.db, owner, candidates);
}

/* ══ Editing a server-held proposal ══════════════════════════════════════ */

export type ProposalEdit = {
  actionId: string;
  /** Turn one card off without touching the others. */
  enabled?: boolean;
  /** Field key → new value. Validated against the capability's schema. */
  fields?: Record<string, string | number | null>;
};

/**
 * Apply an edit to the authoritative proposal.
 *
 * The client sends the version it was looking at. A mismatch means somebody
 * else changed it — another tab, a retry — and the edit is refused rather than
 * applied to a set the user has not seen.
 */
export async function editTurn(
  deps: TurnDeps, turnId: string, version: number, edits: ProposalEdit[],
) {
  const { db, registry, request } = deps;
  const ctx = forRequest(db, request);
  const [row] = await db.select().from(aiTurns).where(and(
    eq(aiTurns.id, turnId),
    eq(aiTurns.workspaceId, request.workspaceId),
    eq(aiTurns.userId, request.userId),
  )).limit(1);
  if (!row) throw notFound('That suggestion is no longer here.');
  if (row.status === 'executed') throw badRequest('Those changes were already made.');
  if (row.status !== 'proposed') throw badRequest('There is nothing to edit here.');
  if (row.version !== version) {
    throw badRequest('This changed somewhere else. Reload to see the current version.');
  }

  const actions = row.actions as unknown as ProposalAction[];
  for (const edit of edits) {
    const action = actions.find((a) => a.id === edit.actionId);
    if (!action) throw badRequest('That change is not part of this suggestion.');
    if (edit.enabled !== undefined) action.enabled = edit.enabled;
    if (!edit.fields) continue;

    const cap = await registry.resolve(ctx, action.capability);
    if (!cap) {
      const why = await registry.explain(ctx, action.capability);
      throw badRequest(why.available ? 'That is no longer something Life OS can do.' : why.reason);
    }

    /* Applied to a COPY and validated before it is kept. An edit that makes
       the payload invalid is rejected with the reason, rather than accepted
       and discovered after the user confirms. */
    const next = structuredClone(action.payload) as any;
    const target = next.changes ?? next;
    for (const [key, value] of Object.entries(edit.fields)) {
      if (!action.editable.some((f) => f.key === key)) {
        throw badRequest(`${key} is not editable on this change.`);
      }
      target[key] = value === '' ? null : value;
    }
    const parsed = cap.input.safeParse(next);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'That value was not accepted.');
    }
    action.payload = parsed.data as Record<string, unknown>;
    action.editable = action.editable.map((f) => (
      f.key in edit.fields! ? { ...f, value: edit.fields![f.key] as any } : f
    ));
    /* An edited action is the user's statement, not the model's guess, so the
       assumption that produced it no longer applies. */
    if (Object.keys(edit.fields).length) {
      action.assumptions = [];
      /* And neither does prose about the old value. "Actually make it Monday"
         moved the date and left the card still reading "Saturday 5 September"
         above a field saying the 7th — a card that says one thing and does
         another, arriving by the one door the consistency pass cannot watch
         because it runs before the edit exists. Dropped only when it has
         genuinely stopped being true. */
      if (action.summary && !stillDescribes(action.summary, action.payload, request.today)) {
        action.summary = null;
      }
      /* The TITLE cannot simply go — it is how the card is identified — so the
         one word that has gone wrong is corrected instead. "Set haircut
         deadline to Saturday" over a Monday date is the same lie as a stale
         summary, in the place a reader looks first. */
      action.title = retitleForDate(action.title, action.payload);
    }
  }

  const [updated] = await db.update(aiTurns)
    .set({ actions: actions as unknown[], version: row.version + 1, updatedAt: new Date() })
    .where(eq(aiTurns.id, turnId)).returning();
  return { turnId, version: updated!.version, actions };
}

/* ══ Resolving a clarification ═══════════════════════════════════════════ */

/**
 * The user picked one of the options. Continue the ORIGINAL request with it.
 *
 * The entity is looked up server-side from the stored option, seeded into
 * retrieval and named to the planner by id. The client sent an option id and
 * nothing else, so there is no path by which the label could be guessed at a
 * second time.
 */
export async function resolveClarification(
  deps: TurnDeps, turnId: string, optionId: string,
): Promise<TurnResult> {
  const [row] = await deps.db.select().from(aiTurns).where(and(
    eq(aiTurns.id, turnId),
    eq(aiTurns.workspaceId, deps.request.workspaceId),
    eq(aiTurns.userId, deps.request.userId),
  )).limit(1);
  if (!row) throw notFound('That question is no longer here.');
  const clarification = row.clarification as unknown as Clarification | null;
  if (!clarification) throw badRequest('There was nothing to choose from.');
  /* Answering moves the turn out of `clarifying`, so a second choice - a
     double tap, a stale panel - cannot start the request again with a
     different option and produce two proposals from one question. */
  if (row.status !== 'clarifying') throw badRequest('That question was already answered.');

  const option = clarification.options.find((o) => o.id === optionId);
  if (!option) throw badRequest('That is not one of the options.');

  /* Answered whichever way the continuation goes. Leaving it open would let
     the same choice be made twice. */
  await deps.db.update(aiTurns)
    .set({ status: 'answered', updatedAt: new Date() })
    .where(eq(aiTurns.id, row.id));

  return runTurn(deps, {
    text: row.request,
    conversationId: row.conversationId,
    resolved: { ref: option.ref ?? null, label: option.label },
  });
}

/** The turn as the client should render it, without re-planning. */
export async function readTurn(deps: TurnDeps, turnId: string) {
  const [row] = await deps.db.select().from(aiTurns).where(and(
    eq(aiTurns.id, turnId),
    eq(aiTurns.workspaceId, deps.request.workspaceId),
    eq(aiTurns.userId, deps.request.userId),
  )).limit(1);
  if (!row) throw notFound('That suggestion is no longer here.');
  return row;
}
