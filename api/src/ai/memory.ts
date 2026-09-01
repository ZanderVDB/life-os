/**
 * Personal Memory — what Life OS knows about the person, not about their work.
 *
 * ── The line that decides what belongs here ──────────────────────────────
 *
 *   "Prefers afternoon meetings"        → memory
 *   "Haircut tomorrow"                  → a task
 *   "John Mercer works with me on WebAnchor" → memory
 *   "Call John Friday"                  → a reminder
 *   "Notes from today's meeting"        → a diary entry or a book page
 *
 * The test is three words: DURABLE, USEFUL, PERSONALLY RELEVANT. A fact that
 * will be false next week, or that changes no future answer, is conversational
 * trivia. Storing it makes the memory longer and the assistant worse, because
 * every future prompt carries it.
 *
 * ── Candidates, not writes ───────────────────────────────────────────────
 *
 * A model does not write memory. It produces CANDIDATES, and this service
 * decides: near-duplicates of what is already known are dropped, restatements
 * of a known fact supersede it, and everything else waits to be accepted. A
 * model that wrote directly would write whatever it misheard, and a wrong
 * durable fact is worse than a wrong answer because it repeats.
 *
 * ── Not a hidden profile ─────────────────────────────────────────────────
 *
 * Everything here is meant to be shown to the user, in their own words, in a
 * list they can edit and delete. `list()` is the query behind that screen. A
 * memory the user cannot see is a memory they cannot correct.
 */
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  aiMemories, aiMemoryCandidates, aiTurns, MEMORY_CATEGORIES, MEMORY_SOURCES,
} from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';

export type MemoryOwner = { workspaceId: string; userId: string };

export const MemoryInput = z.object({
  category: z.enum(MEMORY_CATEGORIES).default('other'),
  fact: z.string().trim().min(3).max(500),
  confidence: z.number().min(0).max(1).default(0.6),
  source: z.enum(MEMORY_SOURCES).default('assistant'),
  isPinned: z.boolean().default(false),
  sourceRefType: z.string().max(40).nullish(),
  sourceRefId: z.string().uuid().nullish(),
}).strict();

export const MemoryPatch = MemoryInput.partial().strict();

export const MemoryCandidateInput = z.object({
  category: z.enum(MEMORY_CATEGORIES).default('other'),
  fact: z.string().trim().min(3).max(500),
  confidence: z.number().min(0).max(1).default(0.5),
  /** A short quotation, for review. Never the whole conversation. */
  evidence: z.string().max(400).nullish(),
  supersedesId: z.string().uuid().nullish(),
}).strict();

export type MemoryCandidate = z.infer<typeof MemoryCandidateInput>;

/**
 * Normalise for comparison.
 *
 * "Prefers afternoon meetings." and "prefers afternoon meetings" are the same
 * belief, and storing both means the second one adds nothing and costs a line
 * in every future prompt.
 */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The live memories, newest first. Superseded rows are never included. */
export async function list(db: Db, owner: MemoryOwner, opts: { category?: string } = {}) {
  return db.select().from(aiMemories).where(and(
    eq(aiMemories.workspaceId, owner.workspaceId),
    eq(aiMemories.userId, owner.userId),
    isNull(aiMemories.supersededAt),
    ...(opts.category ? [eq(aiMemories.category, opts.category)] : []),
  )).orderBy(desc(aiMemories.isPinned), desc(aiMemories.updatedAt));
}

/**
 * The memories worth putting in front of a model.
 *
 * Bounded and ordered: pinned first, then most confident, then most recently
 * useful. A memory list that grows without limit eventually costs more than it
 * informs, and the least useful thing in it is the thing nothing has ever read.
 */
export async function forPrompt(db: Db, owner: MemoryOwner, limit = 40) {
  const rows = await db.select().from(aiMemories).where(and(
    eq(aiMemories.workspaceId, owner.workspaceId),
    eq(aiMemories.userId, owner.userId),
    isNull(aiMemories.supersededAt),
  )).orderBy(
    desc(aiMemories.isPinned),
    desc(aiMemories.confidence),
    desc(sql`coalesce(${aiMemories.lastUsedAt}, ${aiMemories.updatedAt})`),
  ).limit(limit);
  return rows.map((r) => ({ category: r.category, fact: r.fact }));
}

export async function create(db: Db, owner: MemoryOwner, input: z.infer<typeof MemoryInput>) {
  const [row] = await db.insert(aiMemories).values({
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    ...input,
    sourceRefType: input.sourceRefType ?? null,
    sourceRefId: input.sourceRefId ?? null,
  }).returning();
  return row!;
}

export async function update(
  db: Db, owner: MemoryOwner, id: string, patch: z.infer<typeof MemoryPatch>,
) {
  const [row] = await db.update(aiMemories)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(
      eq(aiMemories.id, id),
      eq(aiMemories.workspaceId, owner.workspaceId),
      eq(aiMemories.userId, owner.userId),
    )).returning();
  if (!row) throw notFound('That memory is not here.');
  return row;
}

/**
 * Forget something.
 *
 * A real delete, not a supersede. "Forget that" has to mean gone, or the
 * control is a lie — and a user asking to be forgotten is the one case where
 * keeping history is the wrong instinct.
 */
export async function remove(db: Db, owner: MemoryOwner, id: string) {
  const [row] = await db.delete(aiMemories).where(and(
    eq(aiMemories.id, id),
    eq(aiMemories.workspaceId, owner.workspaceId),
    eq(aiMemories.userId, owner.userId),
  )).returning();
  if (!row) throw notFound('That memory is not here.');
  return row;
}

/**
 * Replace a belief with a newer one.
 *
 * The old row stays, marked superseded and pointing at its replacement, so
 * "you used to say mornings" is answerable and so a wrong replacement can be
 * traced. Nothing superseded is ever read into a prompt.
 *
 * A PINNED memory is not superseded automatically. The user said it is right;
 * changing it silently is exactly the behaviour that makes a memory system
 * feel like it is making things up.
 */
export async function supersede(
  db: Db, owner: MemoryOwner, id: string, input: z.infer<typeof MemoryInput>,
) {
  const [old] = await db.select().from(aiMemories).where(and(
    eq(aiMemories.id, id),
    eq(aiMemories.workspaceId, owner.workspaceId),
    eq(aiMemories.userId, owner.userId),
  )).limit(1);
  if (!old) throw notFound('That memory is not here.');
  if (old.isPinned) {
    throw badRequest('That memory is pinned. Edit or unpin it before replacing it.');
  }
  if (old.supersededAt) throw badRequest('That memory was already replaced.');

  const next = await create(db, owner, input);
  await db.update(aiMemories)
    .set({ supersededById: next.id, supersededAt: new Date(), updatedAt: new Date() })
    .where(eq(aiMemories.id, old.id));
  return { previous: old, current: next };
}

/** Note that a memory was actually used, so the useful ones stay near the top. */
export async function touchUsed(db: Db, owner: MemoryOwner, ids: string[]) {
  if (!ids.length) return;
  await db.update(aiMemories).set({ lastUsedAt: new Date() }).where(and(
    eq(aiMemories.workspaceId, owner.workspaceId),
    eq(aiMemories.userId, owner.userId),
    /* `inArray`, not a raw `= any(...)` — see the note in modules/tasks.ts:
       the raw form binds a JS array in a way PGlite rejects. */
    inArray(aiMemories.id, ids),
  ));
}

/* ══ Candidates ══════════════════════════════════════════════════════════ */

/**
 * Record what a model noticed, having first decided whether it is news.
 *
 * Returns what it did with each candidate, because "we already knew that" is
 * the most common and most important outcome and silently dropping it would
 * make the extraction look broken.
 */
/**
 * Does this candidate contradict something already believed?
 *
 * Two facts in the same category that share most of their distinctive words
 * and are not the same sentence are almost always a change of mind rather than
 * two separate beliefs: "prefers morning meetings" and "prefers afternoon
 * meetings" both belong to `preferences` and share every word but one.
 *
 * Detecting it matters because of where it routes the candidate. A contradiction
 * becomes a SUPERSEDE, and supersede refuses to touch a pinned memory - so a
 * model that mishears cannot quietly overturn something the user confirmed.
 * Without this the contradiction would arrive as an unrelated new memory and
 * both would sit in the list, and the assistant would have two opposite
 * beliefs and no way to choose.
 */
function contradicts(
  fact: string, category: string, live: { id: string; category: string; fact: string }[],
): string | null {
  const words = new Set(norm(fact).split(' ').filter((w) => w.length > 3));
  if (words.size < 2) return null;
  for (const m of live) {
    if (m.category !== category) continue;
    const theirs = new Set(norm(m.fact).split(' ').filter((w) => w.length > 3));
    if (theirs.size < 2) continue;
    let shared = 0;
    for (const w of words) if (theirs.has(w)) shared += 1;
    const overlap = shared / Math.max(words.size, theirs.size);
    /* High overlap and not identical. Identical was already caught as a
       duplicate; near-identical is the interesting case. */
    if (overlap >= 0.6 && norm(m.fact) !== norm(fact)) return m.id;
  }
  return null;
}

export async function proposeMemories(
  db: Db, owner: MemoryOwner, candidates: MemoryCandidate[],
) {
  const live = await list(db, owner);
  const known = new Map(live.map((m) => [norm(m.fact), m]));
  /* Already queued and still waiting. Extraction runs on every turn, so the
     same observation arrives repeatedly; queuing it twice would make the
     review screen a list of the same sentence. */
  const waiting = await listCandidates(db, owner);
  const queued = new Map(waiting.map((c) => [norm(c.fact), c]));
  const out: {
    fact: string;
    outcome: 'duplicate' | 'queued' | 'pending' | 'conflict';
    id?: string;
  }[] = [];

  for (const c of candidates) {
    const parsed = MemoryCandidateInput.safeParse(c);
    if (!parsed.success) continue;
    const key = norm(parsed.data.fact);

    const existing = known.get(key);
    if (existing) {
      /* Already believed. Not an error and not a new row — just a reason to
         trust it slightly more the next time it is ranked. */
      await db.update(aiMemories).set({ lastUsedAt: new Date() })
        .where(eq(aiMemories.id, existing.id));
      out.push({ fact: parsed.data.fact, outcome: 'duplicate', id: existing.id });
      continue;
    }
    const already = queued.get(key);
    if (already) {
      out.push({ fact: parsed.data.fact, outcome: 'queued', id: already.id });
      continue;
    }

    /* A stated supersedesId is trusted only if it names something live; the
       model can be wrong about ids here as anywhere else. */
    const stated = parsed.data.supersedesId
      && live.some((m) => m.id === parsed.data.supersedesId)
      ? parsed.data.supersedesId : null;
    const conflict = stated ?? contradicts(parsed.data.fact, parsed.data.category, live);

    const [row] = await db.insert(aiMemoryCandidates).values({
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      category: parsed.data.category,
      fact: parsed.data.fact,
      confidence: parsed.data.confidence,
      evidence: parsed.data.evidence ?? null,
      supersedesId: conflict,
    }).returning();
    queued.set(key, row!);
    out.push({
      fact: parsed.data.fact,
      outcome: conflict ? 'conflict' : 'pending',
      id: row!.id,
    });
  }
  return out;
}

export async function listCandidates(db: Db, owner: MemoryOwner) {
  return db.select().from(aiMemoryCandidates).where(and(
    eq(aiMemoryCandidates.workspaceId, owner.workspaceId),
    eq(aiMemoryCandidates.userId, owner.userId),
    eq(aiMemoryCandidates.status, 'pending'),
  )).orderBy(desc(aiMemoryCandidates.createdAt));
}

/** Believe a candidate. Supersedes the memory it replaces, if it named one. */
export async function acceptCandidate(db: Db, owner: MemoryOwner, id: string) {
  const [c] = await db.select().from(aiMemoryCandidates).where(and(
    eq(aiMemoryCandidates.id, id),
    eq(aiMemoryCandidates.workspaceId, owner.workspaceId),
    eq(aiMemoryCandidates.userId, owner.userId),
  )).limit(1);
  if (!c) throw notFound('That suggestion is not here.');
  if (c.status !== 'pending') throw badRequest('That suggestion was already dealt with.');

  const input = {
    category: c.category as any,
    fact: c.fact,
    confidence: c.confidence,
    source: 'assistant' as const,
    isPinned: false,
  };
  const memory = c.supersedesId
    ? (await supersede(db, owner, c.supersedesId, input)).current
    : await create(db, owner, input);

  await db.update(aiMemoryCandidates)
    .set({ status: 'accepted', memoryId: memory.id, resolvedAt: new Date() })
    .where(eq(aiMemoryCandidates.id, c.id));
  return memory;
}

/* ══ Housekeeping ════════════════════════════════════════════════════════ */

/**
 * Retention, and what it deliberately never touches.
 *
 * Two things here grow without a ceiling if nothing removes them: memory
 * candidates the user rejected or ignored, and the record of every turn ever
 * taken. Neither is history worth keeping indefinitely - a rejected suggestion
 * is a suggestion the user has already answered, and a proposal from four
 * months ago cannot be confirmed.
 *
 * What is never removed:
 *   - any memory, pinned or not, superseded or not. That is the user's own
 *     record of what Life OS knows about them, and it is theirs to delete.
 *   - an accepted candidate, which is the provenance of a live memory.
 *   - a turn still awaiting confirmation, however old. Deleting one would
 *     silently discard something the user was in the middle of.
 *
 * Deliberately conservative. Aggressively pruning a personal system is how a
 * user discovers that something they cared about is gone, and there is no
 * version of that story where the storage saved was worth it.
 */
export const RETENTION = {
  /** A rejected suggestion is an answered question. */
  rejectedCandidateDays: 30,
  /** Never accepted, never rejected - just ignored for a season. */
  staleCandidateDays: 120,
  /** Finished turns. The proposal they carried is long since irrelevant. */
  finishedTurnDays: 90,
} as const;

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);

export async function housekeeping(db: Db, owner: MemoryOwner) {
  const removedCandidates = await db.delete(aiMemoryCandidates).where(and(
    eq(aiMemoryCandidates.workspaceId, owner.workspaceId),
    eq(aiMemoryCandidates.userId, owner.userId),
    eq(aiMemoryCandidates.status, 'rejected'),
    lt(aiMemoryCandidates.resolvedAt, daysAgo(RETENTION.rejectedCandidateDays)),
  )).returning({ id: aiMemoryCandidates.id });

  const removedStale = await db.delete(aiMemoryCandidates).where(and(
    eq(aiMemoryCandidates.workspaceId, owner.workspaceId),
    eq(aiMemoryCandidates.userId, owner.userId),
    eq(aiMemoryCandidates.status, 'pending'),
    lt(aiMemoryCandidates.createdAt, daysAgo(RETENTION.staleCandidateDays)),
  )).returning({ id: aiMemoryCandidates.id });

  /* `proposed` is excluded by listing the finished states rather than by
     negating one, so a status added later is kept by default rather than
     deleted by accident. */
  const removedTurns: { id: string }[] = [];
  for (const status of ['executed', 'answered', 'failed', 'cancelled', 'clarifying']) {
    const gone = await db.delete(aiTurns).where(and(
      eq(aiTurns.workspaceId, owner.workspaceId),
      eq(aiTurns.userId, owner.userId),
      eq(aiTurns.status, status),
      lt(aiTurns.createdAt, daysAgo(RETENTION.finishedTurnDays)),
    )).returning({ id: aiTurns.id });
    removedTurns.push(...gone);
  }

  return {
    rejectedCandidates: removedCandidates.length,
    staleCandidates: removedStale.length,
    turns: removedTurns.length,
  };
}

export async function rejectCandidate(db: Db, owner: MemoryOwner, id: string) {
  const [row] = await db.update(aiMemoryCandidates)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(and(
      eq(aiMemoryCandidates.id, id),
      eq(aiMemoryCandidates.workspaceId, owner.workspaceId),
      eq(aiMemoryCandidates.userId, owner.userId),
      eq(aiMemoryCandidates.status, 'pending'),
    )).returning();
  if (!row) throw notFound('That suggestion is not here.');
  return row;
}
