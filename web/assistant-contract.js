/**
 * The assistant contract.
 *
 * This is the interface the real AI will implement. It exists BEFORE the AI
 * does, on purpose: the shape of what an assistant is allowed to do is a
 * product decision, not a consequence of whichever model gets wired in.
 *
 * ── The safety model, in one line ────────────────────────────────────────
 *
 *   LISTEN -> UNDERSTAND -> PROPOSE -> USER EDITS -> CONFIRM -> EXECUTE
 *
 * There is no arrow from listening to writing. A provider cannot write; it
 * has one method, `propose`, and `propose` returns a description of changes.
 * Nothing in this file, and nothing a provider can return, reaches the
 * database. The executor is a separate layer that only ever runs on an
 * explicit confirmation, and `assertConfirmable()` below is the gate it has
 * to pass through.
 *
 * That ordering is not merely careful, it is the whole reason the assistant
 * can be trusted with a calendar. Speech recognition mishears; a model
 * misreads intent; both will happen. A proposal that is wrong is a card you
 * edit or switch off. A silent write that is wrong is a deleted meeting.
 *
 * ── What survives the real implementation ────────────────────────────────
 *
 * Everything in this file. The mock provider is replaced; the contract, the
 * proposal shapes, the edit operations, the counting and the confirmation
 * gate are what the UI is built against and they do not change when a model
 * appears behind them. See docs/ai-contract.md.
 */

/* ── Proposal kinds ──────────────────────────────────────────────────────
 * Every kind names a Life OS system and a verb. A kind that is not in this
 * list cannot be rendered and cannot be confirmed — an unknown proposal is
 * dropped with a note rather than shown as something the app half
 * understands. */
export const KINDS = {
  'task.create': { label: 'Create task', system: 'Tasks', mutates: true },
  'task.complete': { label: 'Complete', system: 'Tasks', mutates: true },
  'task.update': { label: 'Update task', system: 'Tasks', mutates: true },
  'task.schedule': { label: 'Schedule', system: 'Tasks', mutates: true },
  'event.create': { label: 'Calendar', system: 'Calendar', mutates: true },
  'event.update': { label: 'Calendar', system: 'Calendar', mutates: true, important: true },
  'event.delete': { label: 'Delete event', system: 'Calendar', mutates: true, important: true },
  'reminder.create': { label: 'Reminder', system: 'Reminders', mutates: true },
  'habit.check': { label: 'Habit', system: 'Habits', mutates: true },
  'project.update': { label: 'Project', system: 'Projects', mutates: true, important: true },
  'list.add': { label: 'Add to list', system: 'Library', mutates: true },
  'library.append': { label: 'Write to Book', system: 'Library', mutates: true },
  /* Relationships. The assistant will spend most of its time noticing that
     two things belong together — "the notes for that meeting are on page 4",
     "this task came out of Tuesday" — and without these it would have to
     express that as prose nobody can navigate.
     Both go through the relationship service, never through `item_links`. A
     link is cheap and reversible, so `link.create` is ordinary; removing one
     destroys a judgement somebody made, so `link.remove` is important. */
  'link.create': { label: 'Link', system: 'Relationships', mutates: true },
  'link.remove': { label: 'Unlink', system: 'Relationships', mutates: true, important: true },
  /* Not a change. A question answered, or a fact recalled. It carries no
   * confirmation and contributes nothing to the count, because agreeing with
   * an answer is not an action. */
  answer: { label: 'Answer', system: null, mutates: false },
};

export const isMutation = (kind) => Boolean(KINDS[kind]?.mutates);

/**
 * Changes that must never be committed on the strength of a voice command
 * alone, however confident the model is.
 *
 * These are the ones where being wrong destroys something a person cannot
 * get back by pressing undo: a meeting other people were invited to, a
 * project's state, a deleted task. The UI marks them, and the executor is
 * required to have seen an explicit confirmation for each.
 */
export const isImportant = (kind) => Boolean(KINDS[kind]?.important)
  || kind === 'event.delete' || kind === 'task.complete';

/* ── Field types the editor knows how to render ───────────────────────── */
export const FIELD_TYPES = ['text', 'date', 'time', 'duration', 'choice', 'note'];

/**
 * Normalises whatever a provider returned into something the UI can render
 * without defensive checks at every property access.
 *
 * A provider is an outside system — today a mock, tomorrow a model — and a
 * renderer that trusts it produces `undefined` in the middle of a sentence
 * the first time a field is missing. Unknown kinds are dropped here, once,
 * with the reason recorded, rather than being handled in six places.
 */
export function normalise(raw) {
  const dropped = [];
  const proposals = (raw?.proposals ?? []).map((p, i) => {
    if (!KINDS[p.kind]) { dropped.push(p.kind); return null; }
    return {
      id: p.id ?? `p${i}`,
      kind: p.kind,
      title: String(p.title ?? ''),
      summary: String(p.summary ?? ''),
      context: p.context ?? null,      // the quiet line: "3:00–4:00 is free"
      enabled: p.enabled !== false,
      fields: (p.fields ?? []).filter((f) => FIELD_TYPES.includes(f.type)),
      items: (p.items ?? []).map((it, j) => ({
        id: it.id ?? `${p.id ?? `p${i}`}-i${j}`,
        label: String(it.label ?? ''),
        enabled: it.enabled !== false,
      })),
      target: p.target ?? null,
    };
  }).filter(Boolean);

  return {
    id: raw?.id ?? 'r1',
    transcript: raw?.transcript ?? '',
    understood: raw?.understood ?? 'Here is what I understood',
    reply: raw?.reply ?? null,
    proposals,
    dropped,
  };
}

/**
 * How many changes the Confirm button is about to make.
 *
 * Sub-items count individually, because that is what a person is agreeing
 * to: three groceries is three changes, and a button that says "4 changes"
 * over a card listing six lines is a button nobody can check.
 *
 * A proposal switched off contributes nothing. An `answer` contributes
 * nothing. This number and the list on screen must always agree — if they
 * ever disagree, the number is the thing to fix, never the list.
 */
export function changeCount(proposals) {
  return proposals.reduce((n, p) => {
    if (!p.enabled || !isMutation(p.kind)) return n;
    if (p.items.length) return n + p.items.filter((i) => i.enabled).length;
    return n + 1;
  }, 0);
}

/* ── Edit operations ─────────────────────────────────────────────────────
 * Pure functions over the proposal list. The UI never mutates a proposal in
 * place: an edit produces a new list, which is what makes "the count on the
 * button" and "the cards on screen" impossible to get out of step.
 *
 * The rule these serve is §13: a misheard item is edited or switched off. It
 * is never a reason to start the whole capture again. */

export const setEnabled = (list, id, on) =>
  list.map((p) => (p.id === id ? { ...p, enabled: on } : p));

export const setItemEnabled = (list, id, itemId, on) => list.map((p) => (p.id === id
  ? { ...p, items: p.items.map((i) => (i.id === itemId ? { ...i, enabled: on } : i)) }
  : p));

export const setField = (list, id, key, value) => list.map((p) => (p.id === id
  ? {
    ...p,
    fields: p.fields.map((f) => (f.key === key ? { ...f, value } : f)),
    summary: summarise({ ...p, fields: p.fields.map((f) => (f.key === key ? { ...f, value } : f)) }),
  }
  : p));

export const removeProposal = (list, id) => list.filter((p) => p.id !== id);

/**
 * The one-line summary under a proposal's title, rebuilt from its fields.
 *
 * Rebuilt rather than stored, so editing "Tomorrow" to "Saturday" changes
 * the line that says when. A summary that stays at its original value after
 * an edit is worse than no summary — it is a confident wrong answer sitting
 * directly beneath the right one.
 */
export function summarise(p) {
  const val = (k) => p.fields.find((f) => f.key === k)?.value;
  const parts = [];
  const when = val('when') ?? val('date');
  const time = val('time');
  const dur = val('duration');
  if (when) parts.push(time ? `${when} · ${time}` : when);
  else if (time) parts.push(time);
  if (dur) parts.push(dur);
  const where = val('area') ?? val('project') ?? val('list') ?? val('calendar');
  if (where) parts.push(where);
  return parts.join(' · ');
}

/* ── The gate ────────────────────────────────────────────────────────────
 * The executor calls this before it touches anything. It is deliberately
 * blunt: it throws. A confirmation that is merely "recommended" is a
 * confirmation somebody eventually ships around. */

/**
 * @throws if a batch is being executed without an explicit user confirmation
 * that names the same number of changes the user was shown.
 */
export function assertConfirmable(proposals, confirmation) {
  if (!confirmation || confirmation.confirmed !== true) {
    throw new Error('Assistant changes require an explicit confirmation.');
  }
  const n = changeCount(proposals);
  if (confirmation.count !== n) {
    /* The count is part of the confirmation, not decoration. If the list
     * changed between the button being drawn and being pressed, the person
     * agreed to a different set of changes than the one about to run. */
    throw new Error(`Confirmed ${confirmation.count} changes but ${n} are pending.`);
  }
  return true;
}

/**
 * The provider interface, written down.
 *
 * A provider has exactly ONE method and it returns a description. It is
 * handed no API client, no workspace id and no token, so a provider that
 * wanted to write could not — the capability is absent rather than merely
 * unused.
 *
 *   propose({ text, context }) -> Promise<AssistantResponse>
 *
 * `context` is read-only and is what makes proposals specific rather than
 * generic: the projects that exist, the areas, today's date. It never
 * contains credentials.
 */
export function isProvider(p) {
  return Boolean(p) && typeof p.propose === 'function' && typeof p.id === 'string';
}
