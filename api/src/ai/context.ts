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

  for (const seed of seeds) {
    const readCap = caps.find((c) => c.kind === 'read' && c.module === registry
      .moduleForEntity(seed.type)?.id);
    if (readCap) {
      const rows = await call(readCap.id, { id: seed.id });
      out.push(...rows.map((r) => ({ ...r, via: 'surface' as const, level: 1 as const })));
    }
  }

  if (level >= 2 && opts.query && opts.query.trim().length >= 2) {
    /* ── Level 2: targeted search ──────────────────────────────────── */
    const q = opts.query.trim().slice(0, 200);
    const searches = caps.filter((c) => c.kind === 'search');
    for (const c of searches) {
      if (out.length >= limit) break;
      out.push(...await call(c.id, { query: q }));
    }
  }

  /* ── Traversal: the reason relationships exist ─────────────────────── */
  if (level >= 2 && depth > 0) {
    const traverseCap = byId.get('link.traverse');
    if (traverseCap) {
      /* Walk from the strongest starting points only — the surface, and the
         first few search hits. Walking from everything turns a search that
         returned twenty rows into twenty graph walks. */
      const starts = merge(out).sort((a, b) => a.level - b.level).slice(0, 5);
      for (const s of starts) {
        if (out.length >= limit) break;
        out.push(...await call('link.traverse', {
          type: s.ref.type, id: s.ref.id, depth, limit: 12,
        }));
      }
    }
  }

  if (level >= 3) {
    /* ── Level 3: broad ────────────────────────────────────────────── */
    for (const c of caps.filter((x) => x.kind === 'read' && x.input.safeParse({}).success)) {
      if (out.length >= limit) break;
      out.push(...await call(c.id, {}));
    }
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
