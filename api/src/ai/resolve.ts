/**
 * Naming one thing, once, for everybody.
 *
 * ── Why this is not left to each capability ──────────────────────────────
 *
 * Phase 3 taught the fast path to find "the Fitzgerald report" among the
 * user's tasks. Phase 4 needs the same skill for projects, habits, books,
 * pages, diary days and calendar events — and if each capability grows its own
 * title matching, they will disagree. One will treat an exact title as
 * decisive and another will not; one will search archived rows; one will pick
 * the first of three and another will ask. The user meets all of them and
 * experiences an assistant with no consistent idea of what "the client call"
 * means.
 *
 * So there is one resolver, it goes through the REGISTRY's search
 * capabilities, and a module registered tomorrow becomes resolvable with no
 * edit here.
 *
 * ── The three answers ────────────────────────────────────────────────────
 *
 * `resolved`  — one candidate is clearly the strongest.
 * `ambiguous` — several are genuinely plausible. The caller must ASK. This is
 *               a real answer, not a failure: picking one of three meetings
 *               and being wrong is worse than a question.
 * `none`      — nothing matched. The caller must say so. It must never invent
 *               an id, and this type gives it nothing to invent one from.
 *
 * ── What makes one candidate stronger ────────────────────────────────────
 *
 * An exact title beats everything. Below that, evidence accumulates: the type
 * the caller asked for, the thing already on screen, the project or area the
 * rest of the sentence is about, something referred to earlier in the
 * conversation, and how well the words match. `ranking.ts` does the last of
 * these and is not reimplemented here.
 *
 * The DECISION is deliberately not "highest score wins". Two candidates a
 * whisker apart are the ambiguous case, and a resolver that always returns its
 * favourite hides that. `MARGIN` is what stops it.
 */
import type { CapabilityCtx, CapabilityRegistry } from './registry.js';
import type { ContextSource, EntityRef, EntityType } from './types.js';
import { rank } from './ranking.js';

/** How far ahead the best candidate must be to be taken as the answer. */
const MARGIN = 1.35;

/** Below this, a "best" match is not a match at all. */
const FLOOR = 0.5;

export type ResolveHints = {
  /** Restrict to these kinds of thing, when the caller knows. */
  types?: readonly EntityType[] | null;
  /** What the user is looking at. Its neighbours are likelier to be meant. */
  surface?: { type: string; id: string } | null;
  /** Entities named earlier in this conversation, most recent first. */
  recent?: EntityRef[];
  /** Projects and areas the rest of the request is about. */
  affinity?: { projectIds: Set<string>; areaIds: Set<string> };
  today: string;
  /** Candidates to offer when it is ambiguous. */
  limit?: number;
};

export type Resolution =
  | { status: 'resolved'; hit: ContextSource; why: string[] }
  | { status: 'ambiguous'; candidates: ContextSource[] }
  | { status: 'none' };

/** Comparable form of a title: case, spacing and edge punctuation removed. */
export const normalise = (s: string) => String(s ?? '')
  .toLowerCase()
  .replace(/[‘’]/g, "'")
  .replace(/[^a-z0-9'\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Words that name a category rather than a thing. Never the whole subject. */
const BARE = new Set([
  'it', 'that', 'this', 'them', 'those', 'these', 'one', 'thing',
  'task', 'project', 'habit', 'reminder', 'event', 'page', 'book', 'entry',
]);

/**
 * Everything the registry can find for these words.
 *
 * Every search capability is asked, and one that cannot accept a plain query
 * is skipped rather than coerced — a capability whose input is a date range is
 * not a title search and pretending otherwise returns noise. Failures are
 * swallowed per capability: one module being unwell must not make the whole
 * request unanswerable.
 */
export async function candidatesFor(
  ctx: CapabilityCtx, registry: CapabilityRegistry, query: string,
  types?: readonly EntityType[] | null,
): Promise<ContextSource[]> {
  const caps = (await registry.capabilities(ctx)).filter((c) => c.kind === 'search');
  const found: ContextSource[] = [];
  for (const cap of caps) {
    if (!cap.run) continue;
    const parsed = cap.input.safeParse({ query });
    if (!parsed.success) continue;
    const rows = await cap.run(ctx, parsed.data).catch(() => [] as ContextSource[]);
    found.push(...rows);
  }
  const wanted = types && types.length ? new Set<string>(types) : null;
  const byKey = new Map<string, ContextSource>();
  for (const f of found) {
    if (wanted && !wanted.has(f.ref.type)) continue;
    byKey.set(`${f.ref.type}:${f.ref.id}`, f);
  }
  return [...byKey.values()];
}

/**
 * Which of the things in the workspace the user meant.
 *
 * @param name the words the user used, already trimmed of the verb.
 */
export async function resolveEntity(
  ctx: CapabilityCtx, registry: CapabilityRegistry, name: string, hints: ResolveHints,
): Promise<Resolution> {
  const clean = String(name ?? '').trim();
  /* A pronoun is not a name. Resolving "it" against every title in the
     workspace finds something, and what it finds is arbitrary — that is the
     fabrication this whole file exists to prevent. Conversation references
     are answered before this is called; reaching here means there was no
     antecedent, and the honest answer is that nothing was named. */
  if (clean.length < 2 || BARE.has(normalise(clean))) return { status: 'none' };

  const all = await candidatesFor(ctx, registry, clean, hints.types);
  if (!all.length) return { status: 'none' };

  /* ── An exact title is decisive ───────────────────────────────────
     "Add milk" against "Milk" and "Buy oat milk for the weekend" is not
     ambiguous: one of them IS the thing named. Two rows with identical
     titles genuinely are ambiguous, and no amount of scoring fixes that. */
  const target = normalise(clean);
  const exact = all.filter((r) => normalise(r.title) === target);
  if (exact.length === 1) return { status: 'resolved', hit: exact[0]!, why: ['exact title'] };
  if (exact.length > 1) {
    return { status: 'ambiguous', candidates: exact.slice(0, hints.limit ?? 4) };
  }

  const scored = rank(all, {
    query: clean,
    today: hints.today,
    surface: hints.surface ?? null,
    ...(hints.affinity ? { affinity: hints.affinity } : {}),
  }, Math.max(8, hints.limit ?? 4));
  if (!scored.length) return { status: 'none' };

  /* Something named a moment ago is likelier to be meant than something
     that merely reads similarly. Applied as a nudge on top of the ranking
     rather than as an override: "the WebAnchor project" said now beats a
     different project mentioned two turns ago, and should. */
  const recent = new Map(
    (hints.recent ?? []).map((r, i) => [`${r.type}:${r.id}`, 1 + (0.35 / (i + 1))]),
  );
  const adjusted = scored.map((s) => {
    const boost = recent.get(`${s.ref.type}:${s.ref.id}`);
    return boost
      ? { ...s, score: s.score * boost, why: [...s.why, 'mentioned earlier'] }
      : s;
  }).sort((a, b) => b.score - a.score);

  const [best, second] = adjusted;
  if (!best || best.score < FLOOR) return { status: 'none' };
  if (!second || best.score >= second.score * MARGIN) {
    return { status: 'resolved', hit: best, why: best.why };
  }
  /* Genuinely close. Everything within the margin of the best is a real
     possibility and gets offered; anything further behind is not. */
  return {
    status: 'ambiguous',
    candidates: adjusted
      .filter((s) => s.score * MARGIN >= best.score)
      .slice(0, hints.limit ?? 4),
  };
}
