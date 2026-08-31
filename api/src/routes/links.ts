/**
 * The relationship endpoints.
 *
 * Thin on purpose: every rule about what may link to what, what a kind means
 * and what happens on delete lives in `lib/relationships.ts`, so that a future
 * assistant action calling the service directly obeys exactly the same rules
 * as a person clicking in the UI. A second copy of those rules here would be
 * a second thing to keep in step.
 */
import type { AppInstance, Guards } from '../types.js';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  ENTITY_TYPES, LINK_KINDS, LINK_KIND_IDS,
  createLink, removeLink, linksFor, searchLinkable,
} from '../lib/relationships.js';

const uuid = z.string().uuid();
const entity = z.enum(ENTITY_TYPES);

export function registerLinkRoutes(app: AppInstance, db: Db, guards: Guards) {
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const base = '/api/v1/workspaces/:workspaceId';

  /**
   * The vocabulary, served rather than duplicated in the client.
   *
   * The picker needs the same list the validator uses. Shipping it twice is
   * how a client offers a kind the server rejects.
   */
  app.get(`${base}/links/kinds`, pre, async () => ({
    kinds: LINK_KIND_IDS.map((id) => ({
      id,
      label: LINK_KINDS[id].label,
      inverse: LINK_KINDS[id].inverse,
      coupled: Boolean((LINK_KINDS[id] as { coupled?: boolean }).coupled),
    })),
    entityTypes: ENTITY_TYPES,
  }));

  /**
   * Everything connected to one entity, in both directions.
   *
   * One endpoint rather than `/tasks/:id/links` and nine siblings: the
   * question is identical whichever kind of thing is asking it, and the
   * assistant will ask it about types the UI has no page for.
   */
  app.get(`${base}/links`, pre, async (req) => {
    const q = z.object({ type: entity, id: uuid }).parse(req.query);
    return linksFor(db, req.workspaceId!, q.type, q.id);
  });

  /** Candidates to link to, across every type at once. */
  app.get(`${base}/links/search`, pre, async (req) => {
    const q = z.object({
      q: z.string().trim().max(120),
      excludeType: entity.optional(),
      excludeId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(50).default(24),
    }).parse(req.query);
    return searchLinkable(db, req.workspaceId!, q.q, {
      limit: q.limit,
      exclude: q.excludeType && q.excludeId ? { type: q.excludeType, id: q.excludeId } : null,
    });
  });

  app.post(`${base}/links`, pre, async (req, reply) => {
    const body = z.object({
      sourceType: entity,
      sourceId: uuid,
      targetType: entity,
      targetId: uuid,
      kind: z.enum(LINK_KIND_IDS as [string, ...string[]]),
      note: z.string().trim().max(280).nullish(),
    }).strict().parse(req.body);

    const res = await createLink(db, req.workspaceId!, {
      ...body,
      kind: body.kind as never,
      // Matches calendar-write.ts: the guard attaches it, the type does not.
      userId: (req as any).user?.id ?? null,
    });
    // 200 rather than 201 when it already existed: pressing link twice is the
    // same intent stated twice, not a conflict.
    reply.code(res.created ? 201 : 200);
    return res;
  });

  /** Removes the edge. Neither end is touched — see the service. */
  app.delete(`${base}/links/:id`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return removeLink(db, req.workspaceId!, id);
  });
}
