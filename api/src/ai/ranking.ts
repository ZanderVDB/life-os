/**
 * Relevance — deciding which twenty of two hundred rows the model sees.
 *
 * ── Why not vectors ─────────────────────────────────────────────────────
 *
 * Because the question this system actually gets is not "find me something
 * semantically near this sentence". It is "what do I need before the Trifusion
 * meeting", and the right answer is reached by walking one edge from a title
 * that matched exactly. An embedding index would be a large piece of
 * infrastructure that answers the easy half of the problem and none of the
 * hard half, and it would sit alongside a relationship graph that already
 * answers the hard half precisely.
 *
 * So Phase 2 ranks on signals Life OS already has, and keeps traversal as the
 * strongest of them. Vectors remain a sensible Phase 3 addition for the one
 * thing this cannot do — recall by meaning where no word is shared — and
 * `score()` is the single place they would be added.
 *
 * ── The signals ──────────────────────────────────────────────────────────
 *
 * Each is bounded so no single one can dominate, and each exists because
 * leaving it out produces an answer that is visibly wrong:
 *
 *   exact title       a thing named in the request is what the request is about
 *   token overlap     partial matches, normalised by how specific the word is
 *   surface           what the user is looking at beats what they are not
 *   relationship      one edge from a strong hit beats a coincidental word
 *   lifecycle         an open task is what "what do I still need" means
 *   recency           the recent past is what "lately" means
 *   association       the same project or area as everything else that matched
 *
 * The weights are deliberately visible constants rather than tuned magic; each
 * one is a product judgement and should be argued with in the open.
 */
import type { ContextSource } from './types.js';

/* ── Weights ─────────────────────────────────────────────────────────────
 * Chosen so that: an exact title match outranks anything else on its own; one
 * relationship hop from a strong hit outranks a weak keyword match; and
 * nothing outranks the surface the user is actually looking at. */
const W = {
  exactTitle: 10,
  titlePrefix: 6,
  titleContains: 4,
  tokenOverlap: 5,      // scaled by the fraction of query tokens matched
  surface: 12,          // level 1 — the thing on screen
  hop1: 5,              // one edge from something that matched
  hop2: 2.5,            // two edges
  openLifecycle: 1.5,
  dueSoon: 2,
  recency: 3,           // scaled by decay
  sharedProject: 2,
  sharedArea: 1,
} as const;

/** Words that match everything and therefore distinguish nothing. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'for', 'in', 'on', 'at', 'by',
  'with', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did',
  'i', 'me', 'my', 'mine', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that',
  'these', 'those', 'what', 'which', 'who', 'when', 'where', 'how', 'why',
  'need', 'needs', 'want', 'get', 'got', 'have', 'has', 'had', 'can', 'could',
  'should', 'would', 'will', 'still', 'just', 'about', 'before', 'after', 'up',
]);

export const tokens = (s: string): string[] => String(s ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]+/g, ' ')
  .split(/\s+/)
  .filter((t) => t.length > 1 && !STOP.has(t));

/**
 * How much a token is worth.
 *
 * A rare word is evidence; a common one is noise. Without this, "meeting"
 * pulls every event in the workspace to the top of a question about one
 * meeting. Computed over the candidate set rather than the whole database —
 * it is cheap, and the candidate set is what is being ordered.
 */
function inverseFrequency(sources: ContextSource[]): Map<string, number> {
  const docs = sources.length || 1;
  const seen = new Map<string, number>();
  for (const s of sources) {
    for (const t of new Set(tokens(`${s.title} ${s.summary ?? ''}`))) {
      seen.set(t, (seen.get(t) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [t, n] of seen) idf.set(t, Math.log(1 + docs / (1 + n)));
  return idf;
}

/** Days between two civil dates, or null when either is missing. */
function daysBetween(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Number.isNaN(ms) ? null : Math.round(ms / 86400000);
}

export type RankOptions = {
  query: string;
  today: string;
  /** The entity on screen, if any. Its neighbours are more likely to matter. */
  surface?: { type: string; id: string } | null;
  /** Projects and areas that other strong hits belong to. */
  affinity?: { projectIds: Set<string>; areaIds: Set<string> };
};

export type Scored = ContextSource & { score: number; why: string[] };

/**
 * Score one source. Exported so a test can assert an ordering rather than a
 * number, and so the reasons can be shown when an answer looks wrong.
 */
export function score(s: ContextSource, opts: RankOptions, idf: Map<string, number>): Scored {
  const why: string[] = [];
  let total = 0;
  const add = (n: number, reason: string) => {
    if (n <= 0) return;
    total += n;
    why.push(reason);
  };

  const q = opts.query.toLowerCase().trim();
  const title = String(s.title ?? '').toLowerCase();
  const qTokens = tokens(opts.query);

  /* ── Name matching ───────────────────────────────────────────────── */
  if (title && q && title === q) add(W.exactTitle, 'exact title');
  else if (title && q.length >= 3 && title.startsWith(q)) add(W.titlePrefix, 'title starts with');
  else if (title && q.length >= 3 && title.includes(q)) add(W.titleContains, 'title contains');

  if (qTokens.length) {
    const hay = new Set(tokens(`${s.title} ${s.summary ?? ''}`));
    let weight = 0;
    let matched = 0;
    for (const t of qTokens) {
      if (!hay.has(t)) continue;
      matched += 1;
      weight += idf.get(t) ?? 1;
    }
    if (matched) {
      /* Normalised twice over: by how many of the query's words were found,
         and by how distinctive those words are. A row that matches one common
         word out of five should not look like a row that matches all five. */
      const coverage = matched / qTokens.length;
      const distinctiveness = weight / Math.max(1, matched);
      add(W.tokenOverlap * coverage * Math.min(1, distinctiveness), `matched ${matched} word(s)`);
    }
  }

  /* ── Where the user is ───────────────────────────────────────────── */
  if (s.level === 1 || s.via === 'surface') add(W.surface, 'on screen');
  if (opts.surface && s.ref.type === opts.surface.type && s.ref.id === opts.surface.id) {
    add(W.surface, 'the open item');
  }

  /* ── Relationship proximity ──────────────────────────────────────────
   * The signal this whole architecture was built for. A task nobody named,
   * reached by one edge from the meeting that WAS named, is the answer to
   * "what do I need before it" — and a keyword search would rank it nowhere. */
  if (s.via === 'relationship') {
    const hops = s.path?.length ?? 1;
    add(hops <= 1 ? W.hop1 : W.hop2, hops <= 1 ? 'directly linked' : `${hops} hops away`);
  }

  /* ── Lifecycle ───────────────────────────────────────────────────── */
  const d = (s.data ?? {}) as Record<string, unknown>;
  if (d['status'] === 'open' || d['status'] === 'active') add(W.openLifecycle, 'still open');
  if (d['status'] === 'done' || d['status'] === 'completed' || d['status'] === 'cancelled') {
    /* Not zero: "what did I finish this week" is a real question. Just less
       than an open one, because most questions are about what is left. */
    total -= 1;
  }

  const due = daysBetween(opts.today, (d['dueDate'] ?? d['targetDate']) as string | null);
  if (due !== null && due >= -14 && due <= 14) {
    add(W.dueSoon * (1 - Math.min(1, Math.abs(due) / 14)), due < 0 ? 'overdue' : 'due soon');
  }

  /* ── Recency ─────────────────────────────────────────────────────── */
  const when = (d['startsAt'] ?? d['entryDate'] ?? d['updatedAt']) as string | Date | null;
  if (when) {
    const t = when instanceof Date ? when.getTime() : Date.parse(String(when));
    if (!Number.isNaN(t)) {
      const days = Math.abs(Date.now() - t) / 86400000;
      // Half-life of a fortnight: last week matters, last year rarely does.
      add(W.recency * Math.exp(-days / 14), 'recent');
    }
  }

  /* ── Association ─────────────────────────────────────────────────── */
  if (opts.affinity) {
    const pid = d['projectId'] as string | undefined;
    const aid = d['areaId'] as string | undefined;
    if (pid && opts.affinity.projectIds.has(pid)) add(W.sharedProject, 'same project');
    if (aid && opts.affinity.areaIds.has(aid)) add(W.sharedArea, 'same area');
  }

  return { ...s, score: Math.round(total * 100) / 100, why };
}

/**
 * Order a candidate set, best first.
 *
 * Affinity is derived from the top of the FIRST pass and applied in a second:
 * a project that several strong hits belong to is probably what the question
 * is about, and its other tasks should rise. Two passes rather than one
 * because the affinity is not knowable until something has been ranked.
 */
export function rank(sources: ContextSource[], opts: RankOptions, limit = 24): Scored[] {
  if (!sources.length) return [];
  const idf = inverseFrequency(sources);

  const first = sources.map((s) => score(s, opts, idf)).sort((a, b) => b.score - a.score);

  const projectIds = new Set<string>();
  const areaIds = new Set<string>();
  for (const s of first.slice(0, 6)) {
    const d = (s.data ?? {}) as Record<string, unknown>;
    if (s.ref.type === 'project') projectIds.add(s.ref.id);
    if (typeof d['projectId'] === 'string') projectIds.add(d['projectId']);
    if (typeof d['areaId'] === 'string') areaIds.add(d['areaId']);
  }

  return sources
    .map((s) => score(s, { ...opts, affinity: { projectIds, areaIds } }, idf))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/**
 * Categories that are STANDING context rather than episodic.
 *
 * A preference influences a request it shares no word with — "prefers
 * afternoon meetings" should shape "find me time with John" — so these go in
 * whether or not the request mentions them. Everything else has to earn its
 * place by being about the request.
 */
const STANDING = new Set(['preferences', 'defaults', 'routines', 'work_style', 'communication']);

/**
 * Which memories to put in front of the model.
 *
 * ── The rule, and why it is not "the top twelve" ─────────────────────────
 *
 * Sending every known fact on every turn is how a memory system stops helping.
 * It costs tokens linearly in how much the assistant knows, and it dilutes:
 * a model given fourteen facts about somebody, two of which matter, reasons
 * about the wrong two often enough to notice. So a memory is included when it
 * is one of three things:
 *
 *   pinned      the user said it is right, so it is always context
 *   standing    a preference or default, which applies without being named
 *   relevant    it shares a distinctive word with the request
 *
 * A profile fact about a person the request does not mention is none of those,
 * and it stays out. The bound on standing memories is what stops a long list
 * of preferences becoming the same problem by another route.
 */
export function rankMemories<T extends {
  category: string; fact: string; isPinned?: boolean; confidence?: number;
}>(memories: T[], query: string, limit = 10): T[] {
  const q = new Set(tokens(query));
  const scored = memories.map((m) => {
    const hits = tokens(m.fact).filter((t) => q.has(t)).length;
    const standing = STANDING.has(m.category);
    return {
      m,
      hits,
      keep: Boolean(m.isPinned) || hits > 0 || standing,
      s: (m.isPinned ? 100 : 0) + hits * 20 + (standing ? 5 : 0) + (m.confidence ?? 0.5) * 3,
    };
  });

  /* Standing memories are capped separately, so somebody with thirty recorded
     preferences does not push out the one fact the request is actually
     about. */
  const relevant = scored.filter((x) => x.keep && (x.m.isPinned || x.hits > 0));
  const standing = scored.filter((x) => x.keep && !x.m.isPinned && !x.hits)
    .sort((a, b) => b.s - a.s).slice(0, 4);

  return [...relevant, ...standing]
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.m);
}
