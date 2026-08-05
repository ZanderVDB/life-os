/**
 * Today's daily arrangement — the recommended order for STANDALONE tasks.
 *
 * Once per local calendar day, when Today is first opened, standalone tasks are
 * put into the order below. It is a suggestion made once, not a sort that keeps
 * enforcing itself: for the rest of that day the order is whatever the user
 * leaves it as.
 *
 * ── What it never touches ────────────────────────────────────────────────
 *
 * PROJECT TASKS. Their order can encode a dependency or a plan someone made on
 * purpose, and a daily re-shuffle would quietly destroy that. So the list is
 * PARTITIONED first and only the standalone half is sorted — not sorted whole
 * and re-separated afterwards, which would still move project rows relative to
 * each other.
 *
 * STEPS. Nothing here reads or writes a step. The ordered-step model owns them.
 *
 * BUCKETS. Order only. A task never leaves Today, or arrives in it, because of
 * how it sorts. An urgent task in Future stays in Future.
 */

/** A standalone task is one with no project. Nothing else makes it standalone. */
export const isStandalone = (t) => t.projectId == null;

/**
 * Splits a bucket's tasks into the two groups Today draws, in one pass.
 *
 * `unresolved` is the honest case §4 asks for: a task WITH a `projectId` whose
 * project could not be loaded. It stays with the project tasks and says so. It
 * must never fall through to standalone, or a failed request would silently
 * enrol someone's project work in a sorter that is not allowed to touch it.
 */
export function partition(list, projectsById = {}) {
  const standalone = [];
  const project = [];
  let unresolved = 0;
  for (const t of list) {
    if (isStandalone(t)) { standalone.push(t); continue; }
    if (!projectsById[t.projectId]) unresolved++;
    project.push(t);
  }
  return { standalone, project, unresolved };
}

/* ── The comparator ──────────────────────────────────────────────────────
 *
 * Five rules, in order, each only consulted when everything above it ties.
 * Written as one ranked key per task so the sort is a plain numeric comparison
 * and cannot depend on the order the browser happens to hand things over in.
 */

/** Rank of each priority. The existing values — nothing invented. */
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, someday: 4 };

/** Tier 1: has a real scheduled block. Tier 2: due. Tier 3: overdue. Tier 4: the rest. */
const TIER = { scheduled: 0, due: 1, overdue: 2, undated: 3 };

/**
 * The sort key for one task, against a reference "now".
 *
 * @param {object} t     the task
 * @param {Date}   now   the moment the arrangement is being made
 * @param {number} index its current manual position in the list
 */
export function sortKey(t, now, index) {
  const ms = (d) => (d ? new Date(d).getTime() : null);
  const scheduled = ms(t.scheduledAt);

  /* A DUE DATE IS NOT A SCHEDULED START.
   *
   * "This is due on Thursday" and "I am doing this at 14:00" are different
   * statements, and conflating them would let a date-only task jump ahead of
   * work someone actually blocked time for. Only `scheduledAt` counts here. */
  if (scheduled != null && scheduled >= now.getTime()) {
    return { tier: TIER.scheduled, at: scheduled, pri: PRIORITY_RANK[t.priority] ?? 9, index };
  }

  if (t.dueDate) {
    /* A date-only due item is ordered as END of its day.
     *
     * So "due today" still sorts after everything actually scheduled today,
     * and before anything due tomorrow. The interpretation is for ORDERING
     * only — nothing displays an invented time. */
    const dueMs = new Date(`${t.dueDate}T23:59:59`).getTime();
    const overdue = dueMs < now.getTime();
    return {
      // Overdue sorts AFTER things still due, and before undated work: it has
      // already missed its moment, so it should not outrank a commitment that
      // has not.
      tier: overdue ? TIER.overdue : TIER.due,
      // Oldest overdue first — it has waited longest. Ascending `at` gives that
      // for both tiers without a special case.
      at: dueMs,
      pri: PRIORITY_RANK[t.priority] ?? 9,
      index,
    };
  }

  // A scheduled block already in the past is not a commitment any more; the
  // task falls through to whatever else it has, which for most is nothing.
  return { tier: TIER.undated, at: Number.POSITIVE_INFINITY, pri: PRIORITY_RANK[t.priority] ?? 9, index };
}

/**
 * The recommended order for one bucket's standalone tasks.
 *
 * Returns a NEW array. The input is never sorted in place, because the caller
 * needs the previous order intact to compare against and to undo to.
 */
export function arrangeStandalone(list, now = new Date()) {
  const keyed = list.map((t, index) => ({ t, k: sortKey(t, now, index) }));
  keyed.sort((a, b) => (
    a.k.tier - b.k.tier
    || a.k.at - b.k.at
    || a.k.pri - b.k.pri
    // The final tie-break is the order the user already had. That is what makes
    // this deterministic AND stable: two tasks that tie on everything the rule
    // cares about do not swap places just because it ran again.
    || a.k.index - b.k.index
  ));
  return keyed.map((x) => x.t);
}

/**
 * Where a newly created standalone task belongs, without re-sorting the rest.
 *
 * §14: a task added after the day's arrangement should land somewhere sensible,
 * but the surrounding manual order is the user's and must survive. So this
 * finds the first task the newcomer outranks and returns that position —
 * one insertion, nothing else moves.
 *
 * @returns {number} index to insert at, `list.length` for the end.
 */
export function insertionIndex(list, task, now = new Date()) {
  const k = sortKey(task, now, Number.MAX_SAFE_INTEGER);
  const at = list.findIndex((other, i) => {
    const o = sortKey(other, now, i);
    return k.tier < o.tier
      || (k.tier === o.tier && k.at < o.at)
      || (k.tier === o.tier && k.at === o.at && k.pri < o.pri);
  });
  return at === -1 ? list.length : at;
}

/** Did the arrangement actually change anything? Nothing to say if not. */
export function orderChanged(before, after) {
  if (before.length !== after.length) return true;
  return before.some((t, i) => t.id !== after[i].id);
}

/**
 * The local calendar date, as the user's own clock sees it.
 *
 * Deliberately NOT `toISOString().slice(0, 10)` — that is the UTC date, which
 * for South Africa (UTC+2) is the previous day for the first two hours of every
 * morning. The whole feature is "once per local day"; getting the day wrong is
 * getting the feature wrong.
 */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    + `-${String(d.getDate()).padStart(2, '0')}`;
}
