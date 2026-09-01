/**
 * The Context Engine — what the assistant is allowed to have read.
 *
 * ── The thing it exists to avoid ─────────────────────────────────────────
 *
 * Putting the user's whole Life OS into every model call. That is expensive,
 * it is slow, and it is worse at answering than a small relevant slice —
 * a model given four hundred rows finds the wrong one confidently.
 *
 * So retrieval happens in three levels, cheapest first, and stops as soon as
 * it has enough.
 *
 *   LEVEL 1 — the current surface.
 *     What the user was looking at. "Move this to Friday" is unanswerable
 *     without it and unambiguous with it. Costs one read.
 *
 *   LEVEL 2 — targeted retrieval.
 *     Search the modules the request actually concerns, then WALK
 *     RELATIONSHIPS out from what was found. "What was decided about the
 *     WebAnchor handover" should reach the project, its linked pages and the
 *     diary day that discusses it — and should not touch the user's habits.
 *
 *   LEVEL 3 — broad.
 *     Only for genuinely broad questions: "what has been taking most of my
 *     attention lately". Queries several modules and is expected to be
 *     expensive, which is why it is opt-in rather than a fallback.
 *
 * ── Provenance is not optional ───────────────────────────────────────────
 *
 * Every source carries the entity it came from, the module that produced it,
 * and — when it was reached by traversal — the path. An answer that cannot
 * name what it read is an answer nobody can check.
 */
import type { CapabilityRegistry, CapabilityCtx } from './registry.js';
import type { ContextSource, EntityRef } from './types.js';

export type GatherOptions = {
  /** The user's words. Level 2 searches with this. */
  query?: string;
  /** How far to go. Higher levels include the lower ones. */
  level?: 1 | 2 | 3;
  /** Hops to walk out from each level-2 hit. 0 disables traversal. */
  traverseDepth?: number;
  /** A ceiling, so a well-connected object cannot flood the context. */
  limit?: number;
  /** Extra entities the caller already knows are relevant. */
  seeds?: EntityRef[];
};

export type GatherResult = {
  sources: ContextSource[];
  /** Which capabilities were actually used, for the trace. */
  used: string[];
  /**
   * Retrievals that threw, with the reason.
   *
   * A failing capability used to vanish: the catch below returned an empty
   * list and the turn carried on with less context and no sign of it. That
   * hid a real bug — a bad array binding made task search throw for every task
   * belonging to a project, and the only symptom was an assistant that could
   * not find things. Recorded now, and surfaced in the turn's metrics.
   */
  failed: { capability: string; reason: string }[];
  /** True when the ceiling stopped retrieval before it ran out of results. */
  truncated: boolean;
};

const key = (s: ContextSource) => `${s.ref.type}:${s.ref.id}`;

/**
 * Deduplicate, keeping the BEST occurrence of each entity.
 *
 * Best means lowest level: something found on the current surface is a better
 * description of itself than the same thing found again by a broad search, and
 * the surface copy carries the fuller data.
 */
function merge(all: ContextSource[]): ContextSource[] {
  const byKey = new Map<string, ContextSource>();
  for (const s of all) {
    const existing = byKey.get(key(s));
    if (!existing || s.level < existing.level) byKey.set(key(s), s);
  }
  return [...byKey.values()];
}

export async function gather(
  ctx: CapabilityCtx, registry: CapabilityRegistry, opts: GatherOptions = {},
): Promise<GatherResult> {
  const level = opts.level ?? 2;
  const limit = opts.limit ?? 60;
  const depth = opts.traverseDepth ?? 2;
  const caps = await registry.capabilities(ctx);
  const byId = new Map(caps.map((c) => [c.id, c]));
  const used: string[] = [];
  const failed: GatherResult['failed'] = [];
  const out: ContextSource[] = [];

  const call = async (id: string, input: unknown) => {
    const cap = byId.get(id);
    if (!cap?.run) return [];
    const parsed = cap.input.safeParse(input);
    if (!parsed.success) return [];
    used.push(id);
    /* A single failing retrieval must not fail the turn — a module can be
       misconfigured, and answering from less is better than not answering at
       all. But it must not be SILENT either. */
    return cap.run(ctx, parsed.data).catch((e: Error) => {
      failed.push({ capability: id, reason: e.message });
      return [] as ContextSource[];
    });
  };

  /* ── Level 1: where the user is ───────────────────────────────────── */
  const seeds: EntityRef[] = [...(opts.seeds ?? [])];
  const surface = ctx.request.surface;
  if (surface?.entity) seeds.push(surface.entity);

  const seeded = await Promise.all(seeds.map(async (seed) => {
    const owner = registry.moduleForEntity(seed.type)?.id;
    /* `<module>.read` first: several modules register more than one read, and
       the one that loads a single thing by id is the one a seed wants. */
    const readCap = caps.find((c) => c.kind === 'read' && c.module === owner && c.id.endsWith('.read'))
      ?? caps.find((c) => c.kind === 'read' && c.module === owner);
    if (!readCap) return [];
    const rows = await call(readCap.id, { id: seed.id });
    /* Only the seed ITSELF is "on screen". A project read brings its tasks
       with it, and marking those as level 1 too would give every one of them
       the surface weight — twelve points for existing near something the user
       is looking at, which buries whatever they actually asked about. */
    return rows.map((r) => (r.ref.id === seed.id && r.ref.type === seed.type
      ? { ...r, via: 'surface' as const, level: 1 as const }
      : r));
  }));
  for (const rows of seeded) out.push(...rows);

  if (level >= 2 && opts.query && opts.query.trim().length >= 2) {
    /* ── Level 2: targeted search ────────────────────────────────────
     *
     * Every registered search, CONCURRENTLY. They are independent reads
     * against different tables and running them in series made a turn wait
     * for the sum of eight round trips to learn what the slowest one alone
     * would have told it. Nothing here depends on anything else here. */
    const q = opts.query.trim().slice(0, 200);
    const searches = caps.filter((c) => c.kind === 'search');
    const rows = await Promise.all(searches.map((c) => call(c.id, { query: q })));
    for (const r of rows) out.push(...r);
  }

  /* ── Traversal: the reason relationships exist ─────────────────────── */
  if (level >= 2 && depth > 0 && byId.has('link.traverse')) {
    /* Walk from the strongest starting points only — the surface, and the
       first few search hits. Walking from everything turns a search that
       returned twenty rows into twenty graph walks. Concurrent for the same
       reason the searches are: five independent walks, no shared state. */
    const starts = merge(out).sort((a, b) => a.level - b.level).slice(0, 5);
    const walked = await Promise.all(starts.map((s) => call('link.traverse', {
      type: s.ref.type, id: s.ref.id, depth, limit: 12,
    })));
    for (const r of walked) out.push(...r);
  }

  if (level >= 3) {
    /* ── Level 3: broad ──────────────────────────────────────────────
     *
     * Every read that will accept an empty input: the whole habit list, the
     * areas, whatever else answers "just tell me what is there". Expensive by
     * design, which is why nothing reaches it by accident — a caller asks for
     * level 3, or the low-result fallback in `turn.ts` escalates to it after
     * a targeted pass came back suspiciously empty. */
    /* Searches too, not only reads. `event.search` takes an optional query and
       answers "what is coming up" when given none; excluding it because of its
       KIND meant a broad pass could not see the calendar at all. What matters
       is whether a capability will answer with no arguments. */
    const broad = caps.filter((x) => (x.kind === 'read' || x.kind === 'search')
      && x.input.safeParse({}).success);
    const rows = await Promise.all(broad.map((c) => call(c.id, {})));
    for (const r of rows) out.push(...r);
  }

  const merged = merge(out);
  return {
    sources: merged.slice(0, limit),
    used: [...new Set(used)],
    failed,
    truncated: merged.length > limit,
  };
}

/**
 * The sources, shaped for a model prompt.
 *
 * Ids are kept — they are how an answer cites what it read and how a proposal
 * names what it acts on — and the rest is trimmed to a line each. A model that
 * needs more asks for it with `read`, which is cheaper than sending everything
 * to every call on the chance it matters.
 */
export function forPrompt(sources: ContextSource[]) {
  return sources.map((s) => ({
    ref: `${s.ref.type}:${s.ref.id}`,
    title: s.title,
    ...(s.summary ? { summary: s.summary.slice(0, 200) } : {}),
    ...(s.data ? { data: s.data } : {}),
    ...(s.path?.length
      ? { reachedBy: s.path.map((p) => `${p.from.type} --${p.label}-->`).join(' ') }
      : {}),
  }));
}
