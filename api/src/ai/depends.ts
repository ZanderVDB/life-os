/**
 * Dependencies between actions in one proposal.
 *
 * ── The problem ──────────────────────────────────────────────────────────
 *
 * "Add a task to WebAnchor, schedule 45 minutes Wednesday, and link the task
 * to the handover notes" is three changes, and two of them need something the
 * first one has not created yet. Until now the executor ran a proposal as a
 * flat list of independent agreements, which is correct for six unrelated
 * groceries and wrong for this: there is no task id to schedule until the task
 * exists.
 *
 * ── Why the dependency is DERIVED, never declared ────────────────────────
 *
 * A planner that declares `dependsOn: ["a1"]` alongside a payload can declare
 * one it does not have, or omit one it does. That is the self-consistent-but-
 * wrong shape this codebase keeps meeting: two statements about the same fact,
 * agreeing with each other and disagreeing with reality.
 *
 * So there is one statement. The planner writes a PLACEHOLDER where an id it
 * cannot know yet belongs:
 *
 *     { "projectId": "{{a1.id}}" }
 *
 * and the dependency is read back out of the payload. An action depends on
 * exactly what it references, because referencing is the only way to say it.
 *
 * ── What this deliberately does not do ───────────────────────────────────
 *
 * Ordering without data flow. If B merely ought to happen after A but needs
 * nothing from it, they are independent and both should run — sequencing them
 * would mean A's failure silently cancels a change that would have succeeded.
 * Every real case in Life OS carries an id: schedule needs the task, a link
 * needs both ends.
 */
import type { ProposalAction, EntityRef } from './types.js';

/** `{{a1.id}}` — the id of whatever action `a1` produces. */
const PLACEHOLDER = /\{\{\s*(a\d+)\.id\s*\}\}/g;

/** True when this value is exactly one placeholder and nothing else. */
const SOLE = /^\s*\{\{\s*a\d+\.id\s*\}\}\s*$/;

/** Every action id referenced anywhere inside a payload. */
export function placeholdersIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PLACEHOLDER)) found.add(m[1]!);
    return found;
  }
  if (Array.isArray(value)) {
    for (const v of value) placeholdersIn(v, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) placeholdersIn(v, found);
  }
  return found;
}

/** What each action needs, keyed by action id. */
export function needsOf(actions: ProposalAction[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const a of actions) map.set(a.id, placeholdersIn(a.payload));
  return map;
}

export type GraphProblem = {
  actionId: string;
  code: 'unknown_ref' | 'self_ref' | 'cycle';
  detail: string;
};

/**
 * Execution order, and anything wrong with the graph.
 *
 * A cycle cannot be run and cannot be repaired by trying harder, so it is
 * reported rather than broken arbitrarily — picking an entry point would run
 * half of something the user was shown as a whole.
 */
export function planOrder(actions: ProposalAction[]): {
  order: ProposalAction[];
  problems: GraphProblem[];
} {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const needs = needsOf(actions);
  const problems: GraphProblem[] = [];

  for (const a of actions) {
    for (const ref of needs.get(a.id) ?? []) {
      if (ref === a.id) {
        problems.push({ actionId: a.id, code: 'self_ref', detail: `${a.id} refers to itself` });
      } else if (!byId.has(ref)) {
        problems.push({
          actionId: a.id, code: 'unknown_ref',
          detail: `${a.id} refers to ${ref}, which is not in this proposal`,
        });
      }
    }
  }

  /* Depth-first, marking greys, so a cycle is named by the action that closes
     it rather than by all of them at once. */
  const order: ProposalAction[] = [];
  const state = new Map<string, 'grey' | 'black'>();
  const visit = (a: ProposalAction) => {
    const seen = state.get(a.id);
    if (seen === 'black') return;
    if (seen === 'grey') {
      problems.push({ actionId: a.id, code: 'cycle', detail: `${a.id} is part of a loop` });
      return;
    }
    state.set(a.id, 'grey');
    for (const ref of needs.get(a.id) ?? []) {
      const dep = byId.get(ref);
      if (dep && dep.id !== a.id) visit(dep);
    }
    state.set(a.id, 'black');
    order.push(a);
  };
  for (const a of actions) visit(a);

  return { order, problems };
}

/**
 * A payload with its placeholders replaced by ids that now exist.
 *
 * `missing` is the honest half: a placeholder whose action did not run, or ran
 * and produced nothing to point at. The caller must not execute — a link whose
 * target is the literal string "{{a2.id}}" is a broken edge written on purpose.
 */
export function substitute(
  payload: Record<string, unknown>, produced: Map<string, EntityRef>,
): { payload: Record<string, unknown>; missing: string[] } {
  const missing = new Set<string>();

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      /* A field that IS a placeholder becomes the id itself, keeping the
         string type a uuid field expects. A placeholder inside a sentence is
         interpolated in place — that is a title mentioning what it links to,
         not an identifier. */
      if (SOLE.test(value)) {
        const id = value.match(/(a\d+)/)![1]!;
        const ref = produced.get(id);
        if (!ref) { missing.add(id); return value; }
        return ref.id;
      }
      return value.replace(PLACEHOLDER, (whole, id: string) => {
        const ref = produced.get(id);
        if (!ref) { missing.add(id); return whole; }
        return ref.id;
      });
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };

  return {
    payload: walk(payload) as Record<string, unknown>,
    missing: [...missing],
  };
}

/**
 * A copy in which every placeholder is a well-formed id.
 *
 * Plan-time validation has a real problem: `{{a1.id}}` is not a uuid, so a
 * schema demanding one rejects a payload that is in fact correct — the id
 * simply does not exist yet. Validating a PROBE keeps the schema strict about
 * everything else while letting the one field that cannot be known yet pass.
 *
 * The probe is thrown away. What is stored, shown and later executed is the
 * payload with its placeholders intact, so nothing can confirm a proposal
 * carrying an id that was never real.
 */
const probeId = (actionId: string) =>
  `00000000-0000-4000-8000-${actionId.replace(/\D/g, '').padStart(12, '0')}`;

export function probe(payload: Record<string, unknown>): Record<string, unknown> {
  const stand = new Map<string, EntityRef>();
  for (const id of placeholdersIn(payload)) {
    stand.set(id, { type: 'task', id: probeId(id) });
  }
  return substitute(payload, stand).payload;
}

/**
 * The reverse: a validated payload with its placeholders put back.
 *
 * Necessary because what the schema returns is what gets STORED, and storing
 * the probe would mean confirming a proposal that points at an id nobody ever
 * created. One probe id per action, so two placeholders never collapse into
 * one and come back as the same reference.
 */
export function unprobe(
  value: unknown, original: Record<string, unknown>,
): Record<string, unknown> {
  const back = new Map<string, string>();
  for (const id of placeholdersIn(original)) back.set(probeId(id), `{{${id}.id}}`);
  if (!back.size) return value as Record<string, unknown>;

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v;
      for (const [probed, text] of back) out = out.split(probed).join(text);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as Record<string, unknown>;
}

/**
 * Which actions cannot be attempted, because something they need did not
 * happen, and why — following the chain, so the third link in a broken chain
 * is not reported as an unrelated failure.
 *
 * Keyed by action id, valued with the id of the action that actually broke.
 */
export function blockedBy(
  actions: ProposalAction[], succeeded: Set<string>,
): Map<string, string> {
  const needs = needsOf(actions);
  const blocked = new Map<string, string>();
  /* In planOrder's order a dependency is always decided before its dependent,
     so one pass is enough to propagate a break down a chain. */
  for (const a of planOrder(actions).order) {
    for (const ref of needs.get(a.id) ?? []) {
      if (succeeded.has(ref)) continue;
      blocked.set(a.id, blocked.get(ref) ?? ref);
      break;
    }
  }
  return blocked;
}
