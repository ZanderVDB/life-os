/**
 * One turn of the assistant.
 *
 * ── The whole flow, in order ─────────────────────────────────────────────
 *
 *   interpret     what is this about, and which modules does it touch
 *   gather        surface → targeted search → relationship traversal
 *   rank          twenty of two hundred rows, by signals Life OS already has
 *   memory        a bounded set of durable facts about this person
 *   plan          capabilities and rules FROM THE REGISTRY, never a prompt list
 *   preview       calendar actions go through the mutation ledger, here
 *   persist       the proposal set is written down; the client gets its id
 *
 * The model appears once, in the middle, and is handed data. Everything before
 * it decides what it may see; everything after it decides what may happen.
 *
 * ── Why the proposal is written down ─────────────────────────────────────
 *
 * Phase 1 let the client hand the executor a set. Safe, because every action
 * still had to name a registered capability and pass its schema — but it meant
 * the client could confirm a set the planner never produced. Now the planner
 * writes the set here and confirmation names its id and version. What runs is
 * what was planned.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiConversations, aiTurns } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { CapabilityRegistry, CapabilityCtx } from './registry.js';
import type { ProviderRouter } from './provider.js';
import { gather, forPrompt } from './context.js';
import { rank, rankMemories, tokens } from './ranking.js';
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
 * the last thing answered — a few hundred bytes — and resending everything
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
    actions: { id: string; capability: string; title: string }[];
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
        actions: (last.actions as any[]).map((a) => ({
          id: a.id, capability: a.capability, title: a.title,
        })),
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
  clarification: { question: string; options: { id: string; label: string; ref?: EntityRef }[] } | null;
  /** What was asked for but could not be turned into a real action. */
  note: string | null;
  /** What informed this, for the "where did you get that" question. */
  sources: { ref: EntityRef; title: string; module: string; via: string; path?: unknown }[];
  metrics: Record<string, unknown>;
};

export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnResult> {
  const started = Date.now();
  const { db, registry, providers, request } = deps;
  const text = input.text.trim();
  if (!text) throw badRequest('Say something first.');

  const planner = providers.for('plan');
  if (!planner?.plan) {
    throw badRequest('The assistant is not connected to a model yet.');
  }

  const ctx: CapabilityCtx = { db, request };
  const conversation = await loadConversation(db, request, input.conversationId);

  /* ── 1. Interpret ─────────────────────────────────────────────────── */
  const status = await registry.status(ctx);
  const enabled = status.filter((s) => s.enabled);
  const moduleIds = enabled.map((s) => s.id);

  const interpreter = providers.for('interpret');
  const read = interpreter?.interpret
    ? await interpreter.interpret({ text, request, modules: moduleIds }).catch(() => null)
    : null;

  /* ── 2. Retrieve ──────────────────────────────────────────────────── */
  /* ── What to search for ─────────────────────────────────────────────
   *
   * Search is `ILIKE '%…%'`, which matches a SUBSTRING. A phrase almost never
   * is one: "reconciling against the bank" appears in no title, while
   * "reconcile" and "bank" both do. So whatever the interpreter returns —
   * phrases, or nothing at all — it is expanded into distinctive words, and
   * the phrases are kept as well because an exact title match outranks
   * everything and is worth the one extra query.
   *
   * Getting this wrong is silent: retrieval returns nothing, the planner is
   * handed an empty context, and it proposes actions with no ids in them. */
  const phrases = (read?.queries?.length ? read.queries : [text]).slice(0, 5);
  const words = tokens(phrases.join(' '));
  /* ── Stems, crudely ─────────────────────────────────────────────────
   * "I finished pricing three options" has to find the task called "Price
   * three options", and `%pricing%` does not match it. A real stemmer is a
   * dependency and a vocabulary; a prefix of a long word is neither, and it
   * catches the English inflections that actually come up — price/pricing,
   * book/booking, reconcile/reconciling. A wrong extra hit costs one row in a
   * ranked list; a miss costs the whole action. */
  const stems = words
    .filter((w) => w.length >= 6)
    .map((w) => w.slice(0, Math.max(4, w.length - 3)));
  const queries = [...new Set([
    ...phrases.filter((q) => q.trim().length >= 2 && q.trim().split(/\s+/).length <= 4),
    ...words,
    ...stems,
  ])].slice(0, 10);
  const collected: ContextSource[] = [];
  const usedCaps = new Set<string>();
  const failedCaps: { capability: string; reason: string }[] = [];

  for (const q of queries) {
    const g = await gather(ctx, registry, {
      query: q,
      level: 2,
      traverseDepth: 2,
      limit: 80,
      ...(conversation.pending ? {} : {}),
    });
    collected.push(...g.sources);
    g.used.forEach((u) => usedCaps.add(u));
    failedCaps.push(...g.failed);
  }
  // Level 1 always: what is on screen matters even when nothing was searched.
  if (request.surface?.entity) {
    const g = await gather(ctx, registry, { level: 1, traverseDepth: 1, limit: 20 });
    collected.push(...g.sources);
    g.used.forEach((u) => usedCaps.add(u));
    failedCaps.push(...g.failed);
  }

  /* ── Deduplicate across queries ─────────────────────────────────────
     Each `gather` deduplicates its own result; the UNION of three does not.
     Sending the same project twice wastes context and lets one row vote twice
     in the ranking. Lowest level wins, as it does inside `gather`. */
  const seen = new Map<string, (typeof collected)[number]>();
  for (const src of collected) {
    const k = refKey(src.ref);
    const prev = seen.get(k);
    if (!prev || src.level < prev.level) seen.set(k, src);
  }
  let pool = [...seen.values()];

  /* ── Expand the strongest hits STRUCTURALLY ─────────────────────────
     A project's own tasks are not `item_links` — they are a foreign key — so
     traversal never reaches them. Without this the assistant finds the project
     the question is about and then says it would need to read it, which is
     both true and useless. So the top few hits are read in full, which is what
     a person would have clicked. */
  const preliminary = rank(pool, {
    query: queries.join(' '),
    today: request.today,
    surface: request.surface?.entity ?? null,
  }, 6);

  for (const top of preliminary) {
    const owner = registry.moduleForEntity(top.ref.type);
    const readCap = owner && (await registry.capabilities(ctx))
      .find((c) => c.kind === 'read' && c.module === owner.id && c.id.endsWith('.read'));
    if (!readCap?.run) continue;
    const parsed = readCap.input.safeParse({ id: top.ref.id });
    if (!parsed.success) continue;
    usedCaps.add(readCap.id);
    const rows = await readCap.run(ctx, parsed.data).catch(() => []);
    for (const r of rows) {
      const k = refKey(r.ref);
      if (!seen.has(k)) { seen.set(k, r); pool.push(r); }
    }
  }
  pool = [...seen.values()];

  const ranked = rank(pool, {
    query: queries.join(' '),
    today: request.today,
    surface: request.surface?.entity ?? null,
  }, 24);

  /* ── 3. Memory ────────────────────────────────────────────────────── */
  const owner = { workspaceId: request.workspaceId, userId: request.userId };
  const known = await memory.list(db, owner).catch(() => []);
  const relevant = rankMemories(known, text, 12);

  /* ── 4. Plan ──────────────────────────────────────────────────────── */
  const described = await registry.describe(ctx);
  const plan = await planner.plan({
    text: conversation.pending
      /* A follow-up is given what is still on the table, so "make it Saturday"
         has something to be about. Bounded to titles and capability ids —
         re-sending the whole prior plan would grow every turn. */
      ? `${text}\n\n(Continuing. Still pending from the last turn: ${
        conversation.pending.actions.map((a) => `${a.id}=${a.title}`).join('; ')})`
      : text,
    request,
    capabilities: described.capabilities,
    rules: enabled.map((s) => ({ module: s.id, rules: s.rules })),
    sources: forPrompt(ranked),
    memory: relevant.map((m) => ({ category: m.category, fact: m.fact })),
  });

  /* ── 5. Normalise into server-authored actions ────────────────────── */
  const byKey = new Map(ranked.map((s) => [refKey(s.ref), s]));
  const actions: ProposalAction[] = [];
  const rejected: { capability: string; reason: string }[] = [];

  for (const [i, a] of (plan.actions ?? []).entries()) {
    const raw = a as unknown as {
      capability: string; title: string; summary?: string | null;
      payload: Record<string, unknown>; confidence?: Confidence;
      assumptions?: string[]; warnings?: string[]; sources?: string[];
    };
    /* Resolved through the REGISTRY, so a capability the model invented, or
       one belonging to a module that is off, never becomes a card. */
    const cap = await registry.resolve(ctx, raw.capability);
    if (!cap || cap.kind !== 'mutate') {
      rejected.push({ capability: raw.capability, reason: 'not an available change' });
      continue;
    }
    const parsed = cap.input.safeParse(raw.payload);
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
    let payload: Record<string, unknown> = parsed.data as Record<string, unknown>;

    /* ── Calendar preview, at plan time ─────────────────────────────
       An external write is previewed BEFORE the user is asked, so the card
       can carry the real conflicts and the real wording, and so the mutation
       ledger has recorded the proposal. Execution then takes only the
       requestId — there is no path to Google that was not proposed first. */
    if (cap.preview) {
      try {
        const pv = await cap.preview(ctx, parsed.data);
        warnings.push(...(pv.warnings ?? []));
        if (pv.summary) raw.summary = pv.summary;
        /* The confirmed action carries the ledger handle and nothing else. */
        if (pv.handle) payload = { requestId: pv.handle };
      } catch (e) {
        rejected.push({ capability: raw.capability, reason: (e as Error).message });
        continue;
      }
    }

    const sources = (raw.sources ?? [])
      .map(parseRef).filter(Boolean)
      .filter((r) => byKey.has(refKey(r!))) as EntityRef[];

    actions.push({
      id: `a${i + 1}`,
      capability: cap.id,
      module: cap.module,
      title: raw.title,
      summary: raw.summary ?? null,
      payload,
      target: sources[0] ?? null,
      confidence: raw.confidence ?? 'medium',
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

  /* ── Say what could not be prepared ─────────────────────────────────
     An action that failed validation at plan time is a change the user asked
     for and is not going to get. Dropping it silently is the worst option:
     they said four things, three cards appear, and nothing accounts for the
     fourth. */
  const note = rejected.length
    ? `${rejected.length === 1 ? 'One thing' : `${rejected.length} things`} could not be prepared: `
      + `${[...new Set(rejected.map((r) => r.reason))].join('; ')}.`
    : null;
  const answer = plan.answer ?? null;
  const clarification = (plan as any).clarification ?? null;

  /* ── 6. Persist ───────────────────────────────────────────────────── */
  const sourceRefs = ranked.slice(0, 20).map((s) => ({
    ref: s.ref, title: s.title, module: s.module, via: s.via, ...(s.path ? { path: s.path } : {}),
  }));

  const metrics = {
    ms: Date.now() - started,
    retrieved: collected.length,
    ranked: ranked.length,
    actions: actions.length,
    rejected: rejected.length,
    memoriesUsed: relevant.length,
    capabilitiesUsed: [...usedCaps],
    /* Empty in normal operation. Anything here means retrieval was quietly
       worse than it should have been, which is the hardest kind of fault to
       notice from the outside. */
    retrievalFailures: failedCaps,
    model: planner.model ?? null,
  };

  const [row] = await db.insert(aiTurns).values({
    workspaceId: request.workspaceId,
    userId: request.userId,
    conversationId: conversation.conversationId,
    request: text,
    understood: plan.understood,
    answer,
    status: actions.length ? 'proposed' : 'answered',
    actions: actions as unknown[],
    sources: sourceRefs as unknown[],
    metrics,
  }).returning();

  await db.update(aiConversations)
    .set({ lastTurnAt: new Date(), updatedAt: new Date() })
    .where(eq(aiConversations.id, conversation.conversationId));

  /* Memory extraction runs AFTER the answer is ready, and never blocks it. A
     durable fact is worth noticing; it is not worth making the user wait. */
  void extractMemories(deps, text).catch(() => {});

  return {
    turnId: row!.id,
    conversationId: conversation.conversationId,
    version: row!.version,
    status: row!.status,
    understood: plan.understood,
    answer,
    /** What was asked for and could not be prepared. Shown, never swallowed. */
    note,
    actions,
    clarification,
    sources: sourceRefs,
    metrics: { ...metrics, rejectedDetail: rejected },
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
  const ctx: CapabilityCtx = { db, request };
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
    if (!cap) throw badRequest('That is no longer something Life OS can do.');

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
    if (Object.keys(edit.fields).length) action.assumptions = [];
  }

  const [updated] = await db.update(aiTurns)
    .set({ actions: actions as unknown[], version: row.version + 1, updatedAt: new Date() })
    .where(eq(aiTurns.id, turnId)).returning();
  return { turnId, version: updated!.version, actions };
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
