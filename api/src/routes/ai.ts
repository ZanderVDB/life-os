/**
 * The AI surface.
 *
 * Thin, like `calendar-write.ts` and for the same reason: these handlers
 * parse, authorise and hand over. Nothing here decides what the assistant may
 * do — the registry does — and nothing here changes anything except through
 * the executor.
 *
 * ── The proposal is the server's, not the client's ───────────────────────
 *
 * `POST /ai/turn` plans and WRITES the proposal set down. The client is given
 * its id and version and renders a copy; edits go back through validation into
 * the stored row; confirmation names the id and the version the person saw.
 * There is no endpoint that takes an action from the browser and runs it.
 */
import type { AppInstance, Guards } from '../types.js';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { Assistant } from '../ai/index.js';
import { gather } from '../ai/context.js';
import { changeCount } from '../ai/executor.js';
import { runTurn, editTurn, readTurn } from '../ai/turn.js';
import { confirmTurn, cancelTurn } from '../ai/confirm.js';
import * as memory from '../ai/memory.js';
import type { AiRequestContext } from '../ai/types.js';
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
    const [status, described, all] = await Promise.all([
      assistant.registry.status(ctx),
      assistant.registry.describe(ctx),
      assistant.registry.capabilities(ctx),
    ]);
    return {
      modules: status,
      /* EVERYTHING available, reads included. This is the answer to "what can
         the assistant do", and the client renders proposals against it.
         `describe()` is narrower on purpose — it is what the PLANNER is
         offered, and a planner cannot call a read. */
      capabilities: all.map((c) => ({
        id: c.id, module: c.module, kind: c.kind, description: c.description, risk: c.risk,
      })),
      plannable: described.capabilities.map((c) => c.id),
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
      failed: r.failed,
      truncated: r.truncated,
      count: r.sources.length,
    };
  });

  /* ══ A turn ══════════════════════════════════════════════════════════ */

  /**
   * Say something to the assistant.
   *
   * Plans, writes the proposal down, and returns it. Nothing is changed by
   * this call however confident the plan is — `POST /ai/turn/:id/confirm` is
   * the only thing that writes, and it can only run what this wrote.
   */
  app.post(`${base}/ai/turn`, pre, async (req) => {
    const b = z.object({
      text: z.string().trim().min(1).max(4000),
      conversationId: uuid.nullish(),
      surface: SurfaceSchema.nullish(),
      timeZone: z.string().max(64).nullish(),
      today: z.string().regex(ISO_DATE).optional(),
    }).strict().parse(req.body ?? {});

    const request = requestCtx(req, {
      surface: (b.surface ?? null) as any,
      timeZone: b.timeZone ?? null,
      ...(b.today ? { today: b.today } : {}),
    });
    if (!request.userId) throw badRequest('The assistant needs a signed-in user.');

    return runTurn(
      { db, registry: assistant.registry, providers: assistant.providers, request },
      { text: b.text, conversationId: b.conversationId ?? null },
    );
  });

  /** Read a turn back without re-planning — a refresh must cost nothing. */
  app.get(`${base}/ai/turn/:id`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const deps = {
      db, registry: assistant.registry, providers: assistant.providers,
      request: requestCtx(req),
    };
    const row = await readTurn(deps, id);
    return {
      turnId: row.id,
      conversationId: row.conversationId,
      version: row.version,
      status: row.status,
      understood: row.understood,
      answer: row.answer,
      actions: row.actions,
      sources: row.sources,
      results: row.results ?? null,
    };
  });

  /**
   * Edit the authoritative proposal.
   *
   * Field edits are validated against the capability's own schema before they
   * are kept, so a card cannot be edited into something that will fail after
   * the user has already agreed to it.
   */
  app.patch(`${base}/ai/turn/:id`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      version: z.number().int().min(1),
      edits: z.array(z.object({
        actionId: z.string().min(1).max(80),
        enabled: z.boolean().optional(),
        fields: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
      })).min(1).max(25),
    }).strict().parse(req.body ?? {});

    return editTurn(
      {
        db, registry: assistant.registry, providers: assistant.providers,
        request: requestCtx(req),
      },
      id, b.version, b.edits,
    );
  });

  /**
   * Carry out what was proposed.
   *
   * The body names a turn, a version and the individually accepted important
   * actions. It cannot name an action or supply a payload — everything
   * executable was written by the planner.
   */
  app.post(`${base}/ai/turn/:id/confirm`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      version: z.number().int().min(1),
      count: z.number().int().min(0).max(100),
      importantAccepted: z.array(z.string().max(80)).max(25).default([]),
    }).strict().parse(req.body ?? {});

    const request = requestCtx(req);
    if (!request.userId) throw badRequest('An assistant change needs a signed-in user.');
    return confirmTurn({ db, registry: assistant.registry, request }, {
      turnId: id,
      version: b.version,
      count: b.count,
      importantAccepted: b.importantAccepted,
    });
  });

  /** Throw a proposal away without running any of it. */
  app.post(`${base}/ai/turn/:id/discard`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return cancelTurn(
      { db, registry: assistant.registry, request: requestCtx(req) }, id,
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

}
