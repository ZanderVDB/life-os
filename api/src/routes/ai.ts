/**
 * The AI surface.
 *
 * Thin, like `calendar-write.ts` and for the same reason: these handlers
 * parse, authorise and hand over. Nothing here decides what the assistant may
 * do — the registry does — and nothing here changes anything except through
 * the executor.
 *
 * ── What is deliberately absent ──────────────────────────────────────────
 *
 * There is no `POST /ai/ask`. A turn needs a planner, and a planner needs a
 * model, and no model is configured yet. Shipping the endpoint anyway would
 * mean shipping something that either fails or quietly guesses, and a
 * guessing assistant is exactly what the proposal architecture exists to keep
 * away from the database. The pieces a turn is made of are all here and all
 * tested; the turn itself is Phase 2.
 */
import type { AppInstance, Guards } from '../types.js';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { Assistant } from '../ai/index.js';
import { gather } from '../ai/context.js';
import { execute, assertConfirmable, changeCount } from '../ai/executor.js';
import * as memory from '../ai/memory.js';
import type { AiRequestContext, ProposalSet } from '../ai/types.js';
import { badRequest } from '../lib/errors.js';

const uuid = z.string().uuid();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const SurfaceSchema = z.object({
  route: z.string().max(120),
  entity: z.object({ type: z.string().max(40), id: uuid }).nullish(),
  range: z.object({
    from: z.string().regex(ISO_DATE), to: z.string().regex(ISO_DATE),
  }).nullish(),
}).strict();

export function registerAiRoutes(
  app: AppInstance, db: Db, guards: Guards, assistant: Assistant,
) {
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const base = '/api/v1/workspaces/:workspaceId';

  /** The one object every AI function takes. Built here, from the request. */
  const requestCtx = (req: any, extra: Partial<AiRequestContext> = {}): AiRequestContext => ({
    workspaceId: req.workspaceId ?? req.params.workspaceId,
    userId: req.principal?.userId ?? req.user?.id ?? '',
    today: extra.today ?? new Date().toISOString().slice(0, 10),
    timeZone: extra.timeZone ?? null,
    surface: extra.surface ?? null,
  });

  const owner = (req: any) => ({
    workspaceId: req.workspaceId ?? req.params.workspaceId,
    userId: req.principal?.userId ?? req.user?.id ?? '',
  });

  /* ══ What can the assistant currently do? ════════════════════════════ */

  /**
   * The answer to that question, and the only answer.
   *
   * Built from live module availability, so a workspace with no Google account
   * genuinely sees no calendar capabilities — not a list with a disabled flag
   * beside them, which is how a planner ends up proposing them anyway.
   */
  app.get(`${base}/ai/capabilities`, pre, async (req) => {
    const ctx = { db, request: requestCtx(req) };
    const [status, described] = await Promise.all([
      assistant.registry.status(ctx),
      assistant.registry.describe(ctx),
    ]);
    return {
      modules: status,
      capabilities: described.capabilities,
      unavailable: described.unavailable,
      providers: assistant.providers.list(),
      /* Said plainly rather than implied by an empty list: there is no planner
         until a model is configured, and the caller should not have to infer
         that from the absence of something. */
      planner: assistant.providers.for('plan')
        ? { available: true }
        : { available: false, reason: 'No model is configured for planning yet.' },
    };
  });

  /* ══ Context ═════════════════════════════════════════════════════════ */

  /**
   * What the assistant would be given for a request, without asking a model.
   *
   * Useful on its own — it is how the retrieval levels are exercised and how a
   * wrong answer is traced back to what was read.
   */
  app.post(`${base}/ai/context`, pre, async (req) => {
    const b = z.object({
      query: z.string().max(500).optional(),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      traverseDepth: z.number().int().min(0).max(3).optional(),
      limit: z.number().int().min(1).max(120).optional(),
      surface: SurfaceSchema.nullish(),
      seeds: z.array(z.object({ type: z.string().max(40), id: uuid })).max(10).optional(),
    }).strict().parse(req.body ?? {});

    const ctx = {
      db,
      request: requestCtx(req, { surface: (b.surface ?? null) as any }),
    };
    const r = await gather(ctx, assistant.registry, {
      ...(b.query ? { query: b.query } : {}),
      ...(b.level ? { level: b.level } : {}),
      ...(b.traverseDepth !== undefined ? { traverseDepth: b.traverseDepth } : {}),
      ...(b.limit ? { limit: b.limit } : {}),
      ...(b.seeds ? { seeds: b.seeds as any } : {}),
    });
    return {
      sources: r.sources,
      used: r.used,
      truncated: r.truncated,
      count: r.sources.length,
    };
  });

  /* ══ Execution ═══════════════════════════════════════════════════════ */

  /**
   * Run a confirmed proposal set.
   *
   * The proposal set arrives from the caller because Phase 1 has no planner to
   * produce one. That is safe for a reason worth stating: an action names a
   * CAPABILITY, its payload is validated against that capability's own schema,
   * and the capability calls an application service. A caller cannot express
   * anything a person using the UI could not do, and the confirmation gate is
   * checked before any of it runs.
   */
  app.post(`${base}/ai/execute`, pre, async (req) => {
    const b = z.object({
      proposalSet: z.object({
        id: z.string().min(1).max(80),
        request: z.string().max(4000).default(''),
        understood: z.string().max(2000).default(''),
        answer: z.string().max(4000).nullish(),
        actions: z.array(z.object({
          id: z.string().min(1).max(80),
          capability: z.string().min(1).max(80),
          module: z.string().min(1).max(40),
          title: z.string().max(300).default(''),
          summary: z.string().max(600).nullish(),
          payload: z.record(z.unknown()).default({}),
          target: z.object({ type: z.string().max(40), id: uuid }).nullish(),
          confidence: z.enum(['high', 'medium', 'low']).default('medium'),
          assumptions: z.array(z.string().max(300)).default([]),
          warnings: z.array(z.string().max(300)).default([]),
          requiresConfirmation: z.boolean().default(true),
          important: z.boolean().default(false),
          editable: z.array(z.any()).default([]),
          enabled: z.boolean().default(true),
          sources: z.array(z.object({ type: z.string().max(40), id: uuid })).default([]),
        })).max(25),
      }),
      confirmation: z.object({
        confirmed: z.literal(true),
        count: z.number().int().min(0).max(100),
        importantAccepted: z.array(z.string().max(80)).default([]),
      }),
    }).strict().parse(req.body ?? {});

    const request = requestCtx(req);
    if (!request.userId) throw badRequest('An assistant change needs a signed-in user.');

    return execute(
      { db, registry: assistant.registry, request },
      b.proposalSet as unknown as ProposalSet,
      b.confirmation,
    );
  });

  /** How many changes a Confirm button covering this set would make. */
  app.post(`${base}/ai/preflight`, pre, async (req) => {
    const b = z.object({
      actions: z.array(z.object({
        id: z.string(), enabled: z.boolean().default(true), important: z.boolean().default(false),
      })).max(25),
    }).strict().parse(req.body ?? {});
    const count = changeCount(b.actions as any);
    return {
      count,
      important: b.actions.filter((a) => a.enabled && a.important).map((a) => a.id),
    };
  });

  /* ══ Personal Memory ═════════════════════════════════════════════════ */

  /**
   * What Life OS knows about me.
   *
   * A list, in the user's own words, that the user can edit and delete. A
   * memory the user cannot see is a memory they cannot correct, which is the
   * difference between a memory system and a hidden profile.
   */
  app.get(`${base}/ai/memory`, pre, async (req) => {
    const q = z.object({ category: z.string().max(40).optional() }).parse(req.query ?? {});
    const [memories, candidates] = await Promise.all([
      memory.list(db, owner(req), q.category ? { category: q.category } : {}),
      memory.listCandidates(db, owner(req)),
    ]);
    return { memories, candidates };
  });

  app.post(`${base}/ai/memory`, pre, async (req, reply) => {
    const b = memory.MemoryInput.parse(req.body ?? {});
    /* Created here means the user said it, so it is theirs and it is certain.
       An assistant-extracted fact goes through candidates instead. */
    const row = await memory.create(db, owner(req), { ...b, source: 'user', confidence: 1 });
    reply.code(201);
    return { memory: row };
  });

  app.patch(`${base}/ai/memory/:id`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = memory.MemoryPatch.parse(req.body ?? {});
    return { memory: await memory.update(db, owner(req), id, b) };
  });

  app.delete(`${base}/ai/memory/:id`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await memory.remove(db, owner(req), id);
    return { deleted: true };
  });

  app.post(`${base}/ai/memory/:id/supersede`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = memory.MemoryInput.parse(req.body ?? {});
    return memory.supersede(db, owner(req), id, b);
  });

  /** What a model noticed, waiting to be believed or thrown away. */
  app.post(`${base}/ai/memory/candidates`, pre, async (req) => {
    const b = z.object({
      candidates: z.array(memory.MemoryCandidateInput).max(20),
    }).strict().parse(req.body ?? {});
    return { results: await memory.proposeMemories(db, owner(req), b.candidates) };
  });

  app.post(`${base}/ai/memory/candidates/:id/accept`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { memory: await memory.acceptCandidate(db, owner(req), id) };
  });

  app.post(`${base}/ai/memory/candidates/:id/reject`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { candidate: await memory.rejectCandidate(db, owner(req), id) };
  });

  void assertConfirmable;
}
