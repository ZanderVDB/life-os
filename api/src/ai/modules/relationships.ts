/**
 * Relationships, as the assistant sees them.
 *
 * ── Why this is a capability and not a helper ────────────────────────────
 *
 * "What do I need before the Trifusion meeting?" is not a text search for
 * "Trifusion". It is: find the event, walk to what is linked to it, walk once
 * more from there, and answer from what you found. Text search would return
 * every mention of the word and miss the task that prepares for it because
 * nobody wrote the client's name in its title.
 *
 * So traversal is a first-class capability with a depth, and every source it
 * returns records the PATH it was reached by — which is what later lets the
 * assistant say "because this task is linked to that meeting" rather than
 * asserting a connection the user has to take on trust.
 *
 * ── One graph, not two ───────────────────────────────────────────────────
 *
 * Everything here goes through `lib/relationships.ts`, which is the same
 * service the Related section on every screen calls. The assistant does not
 * get its own edge table, its own kinds, or its own idea of what a backlink
 * is. A link it creates appears on both objects immediately, because it is
 * the same row the UI would have written.
 */
import { z } from 'zod';
import {
  linksFor, createLink, removeLink, summarise, isCoupled,
  LINK_KINDS, LINK_KIND_IDS, ENTITY_TYPES,
} from '../../lib/relationships.js';
import type { AiModule, Capability, CapabilityCtx } from '../registry.js';
import type { ContextSource, EntityRef, EntityType } from '../types.js';

const uuid = z.string().uuid();
const entityType = z.enum(ENTITY_TYPES as unknown as [string, ...string[]]);

/**
 * An edge whose far end still exists.
 *
 * `linksFor` already drops edges pointing at something deleted, so this never
 * removes anything at runtime — it is how the compiler is told that, derived
 * from the service's own return type so it cannot drift from it.
 */
type LinkRow = Awaited<ReturnType<typeof linksFor>>['links'][number];
type Resolved = LinkRow & { entity: NonNullable<LinkRow['entity']> };
const resolved = (l: LinkRow): l is Resolved => Boolean(l.entity);

/** Which module owns a type, so a source says where it came from. */
const OWNER: Record<string, string> = {
  task: 'tasks',
  project: 'projects',
  area: 'areas',
  habit: 'habits',
  reminder: 'reminders',
  event: 'calendar',
  library: 'library',
  book_page: 'library',
  diary: 'diary',
};

/**
 * Walk out from one entity, `depth` hops, breadth-first.
 *
 * Breadth-first and visited-tracked, so a graph with a cycle terminates and
 * the path recorded for each node is the SHORTEST one — the shortest path is
 * the one a person would give as the explanation.
 */
async function traverse(
  ctx: CapabilityCtx, start: EntityRef, depth: number, limit: number,
): Promise<ContextSource[]> {
  const ws = ctx.request.workspaceId;
  const seen = new Set<string>([`${start.type}:${start.id}`]);
  const out: ContextSource[] = [];
  let frontier: { ref: EntityRef; path: ContextSource['path'] }[] = [{ ref: start, path: [] }];

  for (let hop = 0; hop < depth && frontier.length && out.length < limit; hop += 1) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      const links = await linksFor(ctx.db, ws, node.ref.type as any, node.ref.id);
      for (const l of links.links.filter(resolved)) {
        const key = `${l.entity.type}:${l.entity.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const path = [
          ...(node.path ?? []),
          { from: node.ref, kind: l.kind, label: l.label },
        ];
        out.push({
          ref: { type: l.entity.type as EntityType, id: l.entity.id },
          module: OWNER[l.entity.type] ?? 'relationships',
          title: l.entity.title,
          summary: l.entity.subtitle ?? null,
          /* `at` matters as much as the label. A traversed row's subtitle is a
             HUMAN date - "3 Sep · 10:00", no year, no weekday - and the model
             reading that had to work the weekday out, which is the whole
             mistake this pass exists to remove. The instant is already on the
             summary; carrying it lets `forPrompt` attach the real day. */
          data: {
            relationship: l.label, hops: hop + 1,
            ...(l.entity.at ? { at: l.entity.at } : {}),
            ...(l.entity.on ? { on: l.entity.on } : {}),
          },
          via: 'relationship',
          path,
          level: 2,
        });
        next.push({ ref: { type: l.entity.type as EntityType, id: l.entity.id }, path });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    frontier = next;
  }
  return out;
}

const inspectCap: Capability = {
  id: 'link.inspect',
  module: 'relationships',
  kind: 'traverse',
  label: 'What is this connected to',
  description: 'The things linked to one entity, in BOTH directions, each with the wording '
    + 'that reads correctly from this end.',
  input: z.object({ type: entityType, id: uuid }).strict(),
  risk: 'safe',
  async run(ctx, input: { type: string; id: string }) {
    const links = await linksFor(ctx.db, ctx.request.workspaceId, input.type as any, input.id);
    return links.links.filter(resolved).map<ContextSource>((l) => ({
      ref: { type: l.entity.type as EntityType, id: l.entity.id },
      module: OWNER[l.entity.type] ?? 'relationships',
      title: l.entity.title,
      summary: l.entity.subtitle ?? null,
      data: {
        relationship: l.label, direction: l.direction, kind: l.kind,
        ...(l.entity.at ? { at: l.entity.at } : {}),
        ...(l.entity.on ? { on: l.entity.on } : {}),
      },
      via: 'relationship',
      path: [{ from: { type: input.type as EntityType, id: input.id }, kind: l.kind, label: l.label }],
      level: 2,
    }));
  },
};

const traverseCap: Capability = {
  id: 'link.traverse',
  module: 'relationships',
  kind: 'traverse',
  label: 'Follow relationships',
  description: 'Walk the relationship graph out from one entity up to a few hops. Use this '
    + 'to answer "what do I need for X" rather than searching for the words in X.',
  input: z.object({
    type: entityType,
    id: uuid,
    depth: z.number().int().min(1).max(3).default(2),
    limit: z.number().int().min(1).max(40).default(20),
  }).strict(),
  risk: 'safe',
  run: (ctx, input: { type: string; id: string; depth: number; limit: number }) =>
    traverse(ctx, { type: input.type as EntityType, id: input.id }, input.depth, input.limit),
};

const createCap: Capability = {
  id: 'link.create',
  module: 'relationships',
  kind: 'mutate',
  label: 'Link two things',
  description: 'Record that two objects are related, with a kind that says how. Cheap and '
    + 'reversible. Cannot create the coupled kind (scheduled_as) - that comes from scheduling.',
  input: z.object({
    sourceType: entityType,
    sourceId: uuid,
    targetType: entityType,
    targetId: uuid,
    kind: z.enum(LINK_KIND_IDS as unknown as [string, ...string[]]),
  }).strict(),
  risk: 'confirm',
  async execute(ctx, input: any) {
    /* Refused here as well as in the service. The service is the enforcement;
       this is the assistant being told why, in words that can be shown. */
    if (isCoupled(input.kind)) {
      return {
        status: 'failed' as const,
        ref: null,
        message: 'That relationship is created by scheduling, not by linking.',
        error: 'coupled_kind_refused',
      };
    }
    const r = await createLink(ctx.db, ctx.request.workspaceId, input);
    const spec = (LINK_KINDS as Record<string, { label: string }>)[input.kind];
    return {
      status: 'done' as const,
      ref: { type: input.sourceType, id: input.sourceId },
      message: r.created ? `Linked as "${spec?.label ?? input.kind}".` : 'Already linked.',
    };
  },
};

const removeCap: Capability = {
  id: 'link.remove',
  module: 'relationships',
  kind: 'mutate',
  label: 'Unlink',
  description: 'Remove a relationship by its link id. Both objects survive - only the edge goes.',
  input: z.object({ linkId: uuid }).strict(),
  risk: 'important',
  async execute(ctx, input: { linkId: string }) {
    await removeLink(ctx.db, ctx.request.workspaceId, input.linkId);
    return { status: 'done' as const, ref: null, message: 'Unlinked.' };
  },
};

export const relationshipsModule: AiModule = {
  id: 'relationships',
  routing: [
    'A connection BETWEEN things that already exist. Never a reason to create a copy of either.',
    'When the user says two things are about each other, that is a link - propose it, do not '
      + 'write it silently.',
  ],
  name: 'Relationships',
  /* Owns no entity type of its own: it is the edges BETWEEN the others. The
     empty list is why `moduleForEntity` never routes here. */
  entities: [],
  rules: [
    'item_links is the one semantic edge in Life OS. There is no second graph and no '
      + 'AI-specific relationship store.',
    'A relationship is stored once and read from both ends. Never create the reverse edge.',
    'Nine kinds are informational and cause nothing to happen. Exactly one, scheduled_as, is '
      + 'coupled, and it is created by scheduling rather than by linking.',
    'Structural relationships - a task belonging to a project, a page belonging to a book, a '
      + 'project having its Book - are NOT links and must not be expressed as one.',
    'Prefer traversal over text search when a question is about what something needs or what '
      + 'came out of it.',
    'Noticing a connection is useful; recording one is a change. When the user states that two '
      + 'things are about each other - "the client call is where we discuss the annual '
      + 'returns" - PROPOSE the link with the kind that says how. Never write one because it '
      + 'seemed likely.',
    'Both ends must be things you can actually see, with real ids. If either end is uncertain, '
      + 'or several candidates fit, ask which is meant instead of linking the nearest match.',
    'Pick the kind from what the user said: discussed_in for a conversation about something, '
      + 'preparation for work done beforehand, resource for something used, result for what '
      + 'came out of it, related when nothing more specific is true.',
  ],
  available: () => ({ enabled: true }),
  capabilities: [inspectCap, traverseCap, createCap, removeCap],
};

export { summarise };
