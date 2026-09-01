/**
 * What "it" refers to.
 *
 * ── Why this is not the model's job ──────────────────────────────────────
 *
 * "Open the WebAnchor project." / "Add a task to it called Send final
 * credentials." / "Make that urgent."
 *
 * The obvious implementation is to send the previous messages and let the
 * model work out the antecedent from the prose. That fails in a specific and
 * expensive way: the model re-derives an ENTITY from a TITLE it remembers, and
 * a second guess at something already known exactly is the guess that picks
 * the wrong project. Worse, it fails silently — the card says "WebAnchor" and
 * the payload carries the id of a different project with a similar name.
 *
 * So references resolve to the STABLE IDS the previous turns actually used.
 * The ids were real: they came from a search, or from a row this assistant
 * created. Nothing is re-derived and nothing is re-guessed.
 *
 * ── Where the list comes from ────────────────────────────────────────────
 *
 * The turn table already records everything needed, and deliberately records
 * no content: `sources` are the refs a turn read, `actions` name what they
 * targeted, `results` name what they produced. Three places, one meaning —
 * things this conversation has been about, most recent first.
 *
 * Titles are read from the canonical rows at the moment they are needed, never
 * stored here. A cached title is a title that goes stale the first time
 * somebody renames something, and then the assistant confidently refers to a
 * project by a name it no longer has.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiTurns } from '../db/schema.js';
import { summarise, isEntityType } from '../lib/relationships.js';
import type { EntityRef, ProposalAction, ActionResult } from './types.js';

/** How many turns back to look. Beyond this, "it" is not a live reference. */
const DEPTH = 6;

/** How many distinct entities to carry. A long list is not a reference. */
const WIDTH = 12;

export type Reference = EntityRef & {
  title: string;
  subtitle?: string | null;
  /** How it entered the conversation. `created` is the strongest kind. */
  how: 'created' | 'changed' | 'mentioned';
  /** 0 is the most recent turn. */
  turnsAgo: number;
};

const key = (r: { type: string; id: string }) => `${r.type}:${r.id}`;

/**
 * The entities this conversation has been about, most recent first.
 *
 * A thing the assistant CREATED outranks one it merely read, at the same
 * distance: "add a task to it" after creating a project means that project,
 * even if three others were listed on the way.
 */
export async function recentReferences(
  db: Db, workspaceId: string, conversationId: string,
): Promise<Reference[]> {
  const rows = await db.select({
    sources: aiTurns.sources,
    actions: aiTurns.actions,
    results: aiTurns.results,
  })
    .from(aiTurns)
    .where(and(
      eq(aiTurns.conversationId, conversationId),
      eq(aiTurns.workspaceId, workspaceId),
    ))
    .orderBy(desc(aiTurns.createdAt))
    .limit(DEPTH);

  /* Collected newest-first, and the FIRST sighting of an entity wins — that
     is its most recent one, which is the distance that matters. */
  const seen = new Map<string, { ref: EntityRef; how: Reference['how']; turnsAgo: number }>();
  const note = (ref: unknown, how: Reference['how'], turnsAgo: number) => {
    const r = ref as EntityRef | null;
    if (!r || typeof r !== 'object' || !r.id || !isEntityType(r.type)) return;
    const k = key(r);
    const prior = seen.get(k);
    /* Same turn, better provenance: created beats changed beats mentioned. */
    if (prior && (prior.turnsAgo < turnsAgo || rankHow(prior.how) >= rankHow(how))) return;
    seen.set(k, { ref: { type: r.type, id: r.id }, how, turnsAgo });
  };

  rows.forEach((row, turnsAgo) => {
    for (const r of (row.results ?? []) as ActionResult[]) {
      if (r?.status === 'done' && r.ref) note(r.ref, 'created', turnsAgo);
    }
    for (const a of (row.actions ?? []) as ProposalAction[]) {
      if (a?.target) note(a.target, 'changed', turnsAgo);
    }
    for (const s of (row.sources ?? []) as EntityRef[]) note(s, 'mentioned', turnsAgo);
  });

  const picked = [...seen.values()]
    .sort((a, b) => a.turnsAgo - b.turnsAgo || rankHow(b.how) - rankHow(a.how))
    .slice(0, WIDTH);
  if (!picked.length) return [];

  /* Titles read NOW, from the rows themselves. Anything that has since been
     deleted simply drops out — a reference to a thing that is gone is not a
     reference, and offering it would let the planner name a dead id. */
  const summaries = await summarise(db, workspaceId, picked.map((p) => p.ref));
  return picked.flatMap((p) => {
    const s = summaries.get(key(p.ref));
    if (!s) return [];
    return [{
      type: p.ref.type,
      id: p.ref.id,
      title: s.title,
      subtitle: s.subtitle ?? null,
      how: p.how,
      turnsAgo: p.turnsAgo,
    } satisfies Reference];
  });
}

const rankHow = (h: Reference['how']) =>
  (h === 'created' ? 2 : h === 'changed' ? 1 : 0);

/* ══ Reading a reference out of what the user said ═══════════════════════ */

/**
 * Bare pronouns, and the "the <type>" shorthand.
 *
 * Deliberately small. This is not an attempt to parse English — it decides
 * whether the sentence contains a reference at all, and if so what TYPE of
 * thing is being referred to. Choosing WHICH one is the reference list's job,
 * and the planner's when the list is not decisive.
 */
const PRONOUN = /\b(it|that|this|them|those|the one|the same)\b/i;

const TYPED = [
  { re: /\bthe (project)\b/i, type: 'project' },
  { re: /\bthe (task)\b/i, type: 'task' },
  { re: /\bthe (habit)\b/i, type: 'habit' },
  { re: /\bthe (reminder)\b/i, type: 'reminder' },
  { re: /\bthe (event|meeting|call|appointment)\b/i, type: 'event' },
  { re: /\bthe (page|note|notes)\b/i, type: 'book_page' },
  { re: /\bthe (book)\b/i, type: 'library' },
  { re: /\bthe (entry|diary)\b/i, type: 'diary' },
  { re: /\bthe (area)\b/i, type: 'area' },
] as const;

export type ReferenceCue = {
  /** True when the sentence leans on something already established. */
  present: boolean;
  /** The kind of thing referred to, when the words say. */
  type?: string | null;
};

export function referenceCue(text: string): ReferenceCue {
  const t = String(text ?? '');
  for (const { re, type } of TYPED) {
    if (re.test(t)) return { present: true, type };
  }
  /* "the one I just added" is a reference; "the one" alone caught above. */
  if (PRONOUN.test(t)) return { present: true, type: null };
  return { present: false };
}

/**
 * The reference list, written for a planner to read.
 *
 * Ids included ON PURPOSE. The planner is asked to reuse an id it is given
 * rather than describe the thing again, and it cannot do that without seeing
 * one. These are ids the user's own previous turns established, in their own
 * workspace, so nothing is disclosed that was not already theirs.
 */
export function forPrompt(refs: Reference[]): string | null {
  if (!refs.length) return null;
  const lines = refs.map((r) => {
    const when = r.turnsAgo === 0 ? 'just now' : `${r.turnsAgo} turns ago`;
    const what = r.how === 'created' ? 'created' : r.how === 'changed' ? 'changed' : 'mentioned';
    const extra = r.subtitle ? ` (${r.subtitle})` : '';
    return `- ${r.type} ${r.id} "${r.title}"${extra} — ${what} ${when}`;
  });
  return `Things this conversation has already been about, newest first. When the user says\n`
    + `"it", "that", "the project", or names one of these, USE THE ID GIVEN HERE rather than\n`
    + `searching for it again:\n${lines.join('\n')}`;
}
