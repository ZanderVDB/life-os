/**
 * The mock provider.
 *
 * ── What this is, and what it is emphatically not ────────────────────────
 *
 * This is a STUB that returns proposals so the assistant's interaction can be
 * designed, walked and criticised before a model exists. It is not AI, it does
 * not understand anything, and it writes nothing to the database. It matches
 * phrases and returns a fixed shape.
 *
 * It is deliberately the only file in the assistant that knows any of this.
 * `assistant.js` talks to `provider.propose()` and has no idea whether the
 * answer came from here or from a model; replacing this file with a real
 * provider is the entire migration. Nothing else changes — which is the point
 * of building the contract first.
 *
 * ── Why it must never commit ─────────────────────────────────────────────
 *
 * A mock that wrote real rows would be indistinguishable, from the outside,
 * from a working assistant — right up until somebody trusted it with a real
 * calendar. The prototype exists to test whether the INTERACTION is right, and
 * a fake that pretends to have done the work cannot answer that question
 * honestly. So every surface it drives says what it is.
 */

/* ── Deterministic scenarios ─────────────────────────────────────────────
 * Keyed by what they match, not by an index, so a demo can be repeated word
 * for word and produce the same result every time. That repeatability is the
 * whole value of a mock: two people can look at the same proposal. */

const DEMO_TRANSCRIPT = 'I finished the website changes. I need a haircut tomorrow. '
  + 'Add milk, chicken and toothpaste to groceries. '
  + 'Move my meeting with John from 2 to 3.';

const tomorrowLabel = (now) => {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString(undefined, { weekday: 'long' });
};

/** The days a "when" field can be moved to, without inventing a date picker. */
const whenOptions = (now) => {
  const out = ['Today', 'Tomorrow'];
  for (let i = 2; i <= 7; i += 1) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    out.push(d.toLocaleDateString(undefined, { weekday: 'long' }));
  }
  out.push('No date');
  return out;
};

const TIMES = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00',
  '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00'];

/**
 * The full demonstration — §11's sentence, and the response it describes.
 *
 * Six changes: one completion, one task, three list lines and one calendar
 * move. The count on the button is derived from the list rather than written
 * here, so the two cannot disagree.
 */
function demoResponse(ctx) {
  const project = ctx.projects?.[0]?.title ?? 'WebAnchor';
  const area = ctx.areas?.find((a) => /personal/i.test(a.name))?.name
    ?? ctx.areas?.[0]?.name ?? 'Personal';
  return {
    id: 'demo',
    understood: 'Here is what I understood',
    proposals: [
      {
        id: 'p-complete',
        kind: 'task.complete',
        title: 'Finish website changes',
        context: project,
        fields: [],
      },
      {
        id: 'p-haircut',
        kind: 'task.create',
        title: 'Haircut',
        fields: [
          { key: 'title', label: 'Task', type: 'text', value: 'Haircut' },
          { key: 'when', label: 'When', type: 'choice', value: 'Tomorrow', options: whenOptions(ctx.now) },
          { key: 'area', label: 'Area', type: 'choice', value: area,
            options: (ctx.areas ?? []).map((a) => a.name).concat('No area') },
        ],
      },
      {
        id: 'p-groceries',
        kind: 'list.add',
        title: 'Add to Groceries',
        fields: [{ key: 'list', label: 'List', type: 'choice', value: 'Groceries',
          options: ['Groceries', 'Shopping', 'Household'] }],
        items: [
          { id: 'g-milk', label: 'Milk' },
          { id: 'g-chicken', label: 'Chicken' },
          { id: 'g-toothpaste', label: 'Toothpaste' },
        ],
      },
      {
        id: 'p-john',
        kind: 'event.update',
        title: 'Meeting with John',
        context: '3:00–4:00 is free',
        fields: [
          { key: 'time', label: 'Start', type: 'choice', value: '15:00', options: TIMES },
          { key: 'duration', label: 'For', type: 'choice', value: '1 hour',
            options: ['30 minutes', '45 minutes', '1 hour', '90 minutes', '2 hours'] },
          { key: 'when', label: 'Day', type: 'choice', value: 'Today', options: whenOptions(ctx.now) },
        ],
        target: { was: '14:00' },
      },
    ],
  };
}

/** A single captured task — the commonest thing anybody says to an assistant. */
function oneTask(text, ctx) {
  const cleaned = text
    .replace(/^(hey |ok |okay )?(life ?os[, ]*)?/i, '')
    .replace(/^(please |can you |could you )?/i, '')
    .replace(/^(remind me to|remember to|i need to|i have to|add a task to|add task|add|note that|note) /i, '')
    .replace(/\s+(today|tomorrow|tonight|this evening|next week)\b.*$/i, '')
    .trim();
  const when = /tomorrow/i.test(text) ? 'Tomorrow'
    : /next week/i.test(text) ? 'Next week'
      : /today|tonight|this evening/i.test(text) ? 'Today' : 'No date';
  return {
    id: 'capture',
    understood: 'Here is what I understood',
    proposals: [{
      id: 'p-1',
      kind: 'task.create',
      title: cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : 'New task',
      fields: [
        { key: 'title', label: 'Task', type: 'text',
          value: cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : '' },
        { key: 'when', label: 'When', type: 'choice', value: when, options: whenOptions(ctx.now) },
        { key: 'area', label: 'Area', type: 'choice',
          value: ctx.areas?.[0]?.name ?? 'No area',
          options: (ctx.areas ?? []).map((a) => a.name).concat('No area') },
      ],
    }],
  };
}

/** A question about the day. An answer, not a change. */
function dayAnswer(ctx) {
  const n = ctx.counts ?? {};
  const bits = [];
  if (n.events) bits.push(`${n.events} ${n.events === 1 ? 'meeting' : 'meetings'}`);
  if (n.tasks) bits.push(`${n.tasks} ${n.tasks === 1 ? 'task' : 'tasks'}`);
  if (n.habitsTotal) bits.push(`${n.habitsDone ?? 0} of ${n.habitsTotal} habits done`);
  const next = ctx.next
    ? `Next up is ${ctx.next.title} at ${ctx.next.time}.`
    : 'Nothing else is scheduled today.';
  return {
    id: 'answer',
    understood: 'Here is your day',
    reply: `${bits.length ? `${bits.join(', ')}. ` : ''}${next}`,
    proposals: [{
      id: 'p-answer',
      kind: 'answer',
      title: bits.length ? bits.join(' · ') : 'Nothing scheduled',
      context: ctx.next ? `${ctx.next.time} · ${ctx.next.title}` : null,
      fields: [],
    }],
  };
}

/**
 * The provider.
 *
 * One method, and it is handed no way to write anything — see the contract.
 * The delay is real on purpose: an interaction that resolves instantly hides
 * every question about what the processing state should look like, and the
 * processing state is one of the things this prototype exists to test.
 */
export const mockProvider = {
  id: 'mock',
  /** Said out loud wherever the assistant is on screen. */
  label: 'Prototype — no changes are saved',

  async propose({ text, context = {} }) {
    const ctx = { now: context.now ?? Date.now(), ...context };
    await new Promise((r) => { setTimeout(r, 900); });

    const t = String(text ?? '').trim();
    const lower = t.toLowerCase();

    if (!t) {
      return { id: 'empty', understood: 'I did not catch that', proposals: [] };
    }
    if (/\b(what|how).*(day|schedule|on today|coming up|next)\b/.test(lower)
      || /^(what.s|whats) (on|up|next)/.test(lower)) {
      return { transcript: t, ...dayAnswer(ctx) };
    }
    // The full demonstration, matched loosely enough to survive a real
    // dictation of the same sentence.
    if (/haircut/.test(lower) && /groceries|milk/.test(lower)) {
      return { transcript: t, ...demoResponse(ctx) };
    }
    return { transcript: t, ...oneTask(t, ctx) };
  },
};

/**
 * What the microphone would have heard, for testing where it cannot.
 *
 * Speech recognition is a Chrome and Safari feature, behaves differently in
 * each, and is absent in Firefox entirely. Blocking the UX work on it would
 * mean the interaction could only be tested on one browser — so the transcript
 * has a development source as well as a real one, and the surface says which
 * it used. §10.
 */
export const MOCK_TRANSCRIPTS = [
  {
    id: 'demo',
    label: 'The full demonstration',
    text: DEMO_TRANSCRIPT,
    /* Word timings, so the transcript ARRIVES rather than appearing. Watching
     * it build is most of what tells somebody the app is listening, and a
     * block of text that materialises at once tests none of that. */
    pace: 190,
  },
  { id: 'one', label: 'One task', text: 'Remind me to call the dentist tomorrow', pace: 210 },
  { id: 'ask', label: 'A question', text: 'What does my day look like', pace: 200 },
];
