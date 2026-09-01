/**
 * Clarification, with entities rather than labels.
 *
 * ── The pattern this replaces ────────────────────────────────────────────
 *
 *   Assistant:  "Which John meeting?"
 *   User:       taps "John — Tuesday 14:00"
 *   Client:     sends the string "John — Tuesday 14:00" as a new request
 *   Planner:    searches for it, finds two again, and asks again
 *
 * The wrong thing there is not the loop. It is that the system KNEW which
 * meeting each button stood for, threw that away, and asked a language model
 * to work it out a second time from a shorter and worse description. Every
 * disambiguation is exactly the case where the id is already in hand.
 *
 * ── What replaces it ─────────────────────────────────────────────────────
 *
 * An option carries a stable entity ref. The set is written into the turn row
 * server-side; the client sends back an option ID and nothing else; the
 * original request is then re-run with that entity SEEDED into retrieval and
 * named to the planner by id. The user sees a row of ordinary buttons — this
 * is a correctness change, not an interface one.
 *
 * ── Where the refs come from ─────────────────────────────────────────────
 *
 * The planner may supply them, and often does. When it does not, the option
 * labels are matched back against what retrieval actually produced, which is
 * a search over twenty rows rather than a guess. An option that matches
 * nothing stays a plain choice — "leave them open" or "cancel them" are real
 * options that are not entities at all, and forcing a ref onto them would be
 * inventing one.
 */
import type { ContextSource, EntityRef } from './types.js';

export type ClarifyOption = {
  /** Stable within the turn. What the client sends back. */
  id: string;
  label: string;
  /** Enough to tell two similarly named things apart, at a glance. */
  detail?: string | null;
  ref?: EntityRef | null;
};

export type Clarification = {
  question: string;
  options: ClarifyOption[];
};

/** What the model may return, before this file makes it addressable. */
export type RawClarification = {
  question?: unknown;
  options?: { id?: unknown; label?: unknown; ref?: unknown; detail?: unknown }[];
} | null | undefined;

const parseRef = (v: unknown): EntityRef | null => {
  if (!v || typeof v !== 'string') return null;
  const at = v.indexOf(':');
  if (at < 1) return null;
  const id = v.slice(at + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { type: v.slice(0, at) as EntityRef['type'], id };
};

/**
 * A line that tells two things called "Invoice" apart.
 *
 * Built from what the source already carries, not from a second model call.
 * The fields chosen are the ones a person uses to recognise their own work:
 * when it is due, what it belongs to, whether it is still open.
 */
export function detailFor(s: ContextSource): string | null {
  const d = (s.data ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  const when = d['startsAt'] ?? d['dueDate'] ?? d['entryDate'] ?? d['startDate'];
  if (typeof when === 'string') bits.push(when.length > 10 ? when.slice(0, 16).replace('T', ' ') : when);
  else if (when instanceof Date) bits.push(when.toISOString().slice(0, 16).replace('T', ' '));
  if (typeof d['status'] === 'string' && d['status'] !== 'open') bits.push(String(d['status']));
  /* The summary already reads as "done · in WebAnchor" for a task, which is
     the most useful line there is and costs nothing to reuse. */
  if (!bits.length && s.summary) bits.push(s.summary.slice(0, 60));
  const label = s.ref.type.replace('_', ' ');
  return bits.length ? `${label} · ${bits.join(' · ')}` : label;
}

/**
 * Turn whatever the planner produced into options that name real things.
 *
 * Never invents a ref. An option whose label matches nothing retrieved keeps
 * its label and no ref, and resolving it falls back to re-asking with the
 * user's chosen words — which is the old behaviour, correctly reserved for the
 * case where there is genuinely no entity to name.
 */
export function structure(raw: RawClarification, sources: ContextSource[]): Clarification | null {
  if (!raw || typeof raw.question !== 'string' || !raw.question.trim()) return null;
  const opts = Array.isArray(raw.options) ? raw.options : [];
  if (opts.length < 2) return null;

  const byKey = new Map(sources.map((s) => [`${s.ref.type}:${s.ref.id}`, s]));
  const byTitle = new Map<string, ContextSource[]>();
  for (const s of sources) {
    const k = s.title.trim().toLowerCase();
    byTitle.set(k, [...(byTitle.get(k) ?? []), s]);
  }

  const out: ClarifyOption[] = [];
  for (const [i, o] of opts.slice(0, 6).entries()) {
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : null;
    if (!label) continue;

    /* 1. The planner named one, and it is real. A ref it invented is dropped
          rather than trusted — the same rule the payload ids obey. */
    let ref = parseRef(o.ref);
    let source = ref ? byKey.get(`${ref.type}:${ref.id}`) ?? null : null;
    if (ref && !source) ref = null;

    /* 2. Otherwise match the label against what was actually retrieved. Exact
          first, then a unique containment — two candidates means the label
          does not identify one, and guessing between them is precisely the
          mistake this file exists to remove. */
    if (!ref) {
      const exact = byTitle.get(label.toLowerCase());
      const pick = exact?.length === 1 ? exact[0]
        : sources.filter((s) => label.toLowerCase().includes(s.title.trim().toLowerCase())
          && s.title.trim().length >= 3);
      const chosen = Array.isArray(pick) ? (pick.length === 1 ? pick[0] : null) : pick;
      if (chosen) { ref = chosen.ref; source = chosen; }
    }

    out.push({
      id: `c${i + 1}`,
      label,
      detail: typeof o.detail === 'string' && o.detail.trim()
        ? o.detail.trim().slice(0, 120)
        : (source ? detailFor(source) : null),
      ref: ref ?? null,
    });
  }
  return out.length >= 2 ? { question: raw.question.trim().slice(0, 300), options: out } : null;
}

/**
 * Build a clarification from candidates the SERVER found ambiguous.
 *
 * Used where the ambiguity is structural rather than a judgement — several
 * things share a name and the request acts on one of them. No model is
 * involved, so the options are exact by construction.
 */
export function fromCandidates(question: string, candidates: ContextSource[]): Clarification | null {
  const list = candidates.slice(0, 5);
  if (list.length < 2) return null;
  return {
    question,
    options: list.map((s, i) => ({
      id: `c${i + 1}`,
      label: s.title,
      detail: detailFor(s),
      ref: s.ref,
    })),
  };
}
