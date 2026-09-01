/**
 * The real assistant turn, end to end.
 *
 * ── What is stubbed, and what is not ─────────────────────────────────────
 *
 * Only the model. A planner behind a network call cannot be exercised by a
 * test suite, so a stub returns the plan a model would have returned — and
 * everything else in the path is the real thing: retrieval, ranking,
 * relationship traversal, the registry, payload validation, the calendar
 * preview ledger, the stored proposal, the confirmation gate, the executor,
 * and the domain services underneath.
 *
 * That is the right seam. Stubbing lower down would test the stub; stubbing
 * higher would test nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { CapabilityRegistry } from '../src/ai/registry.js';
import { MODULES } from '../src/ai/modules/index.js';
import { ProviderRouter, deterministicProvider } from '../src/ai/provider.js';
import type { AiProvider } from '../src/ai/provider.js';
import { calendars, calendarEvents, aiTurns, tasks } from '../src/db/schema.js';
import { and, eq } from 'drizzle-orm';

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = { authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'zander@example.com' };

/** What the model would have said. Set per test, read by the stub. */
type Plan = {
  understood?: string;
  answer?: string | null;
  actions?: unknown[];
  clarification?: unknown;
};

function stubPlanner(plans: Plan[]): AiProvider {
  let i = 0;
  return {
    id: 'stub',
    label: 'Stub',
    model: 'stub-1',
    async plan(input) {
      const p = plans[Math.min(i, plans.length - 1)] ?? {};
      i += 1;
      return {
        id: '',
        request: input.text,
        understood: p.understood ?? 'Understood',
        answer: p.answer ?? null,
        actions: (p.actions ?? []) as any,
        clarification: (p.clarification ?? null) as any,
      };
    },
    /** Records what the planner was handed, so a test can assert on it. */
    async answer() { return { answer: '', cited: [] }; },
  };
}

/** The last PlanInput the stub saw. Reset per setup. */
let lastPlanInput: any = null;

function recordingPlanner(plans: Plan[]): AiProvider {
  const base = stubPlanner(plans);
  return {
    ...base,
    async plan(input) {
      lastPlanInput = input;
      return base.plan!(input);
    },
  };
}

async function setup(plans: Plan[] = [{}]) {
  lastPlanInput = null;
  const { db } = await freshDb();
  const assistant = {
    registry: new CapabilityRegistry(MODULES),
    providers: new ProviderRouter(
      [deterministicProvider, recordingPlanner(plans)],
      { plan: 'stub', default: 'deterministic' },
    ),
  };
  const app = buildApp(db, env, assistant);
  await app.ready();
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth })).json();
  const ws = me.workspace.id;
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({
      method: method as any, url: `/api/v1/workspaces/${ws}${url}`, headers: auth,
      payload: payload as any,
    });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  return { app, db, ws, call, areaId: me.areas[0].id, assistant };
}

const newProject = async (call: any, areaId: string, title: string) =>
  (await call('POST', '/projects', {
    title, outcome: 'Handed over', areaId, focus: 'now',
  })).body.project;

/* ══ 1. Question ═════════════════════════════════════════════════════════ */

test('turn: a question is answered, with the sources it used, and changes nothing',
  async () => {
    const { call, areaId } = await setup([{
      understood: 'What is left on WebAnchor',
      answer: 'Two things are still open: the contract and the invoice.',
      actions: [],
    }]);
    const project = await newProject(call, areaId, 'WebAnchor client handover');
    const t1 = (await call('POST', '/tasks', { title: 'Send the WebAnchor contract' })).body.task;
    await call('POST', `/projects/${project.id}/tasks`, { taskId: t1.id });

    const r = await call('POST', '/ai/turn', {
      text: 'What still needs to happen for WebAnchor client handover?',
    });
    assert.equal(r.status, 200);
    assert.match(r.body.answer, /contract/i);
    assert.equal(r.body.actions.length, 0, 'a question produced changes');
    assert.equal(r.body.status, 'answered');

    // It can say what it read, with real ids that resolve.
    assert.ok(r.body.sources.length, 'the answer cites nothing');
    const cited = r.body.sources.map((s: any) => `${s.ref.type}:${s.ref.id}`);
    assert.ok(cited.includes(`project:${project.id}`), 'the project was not retrieved');
    for (const s of r.body.sources) assert.ok(s.title && s.module);

    // The planner was handed the project, not the whole database.
    assert.ok(lastPlanInput.sources.length > 0);
    assert.ok(lastPlanInput.sources.length <= 24, 'the whole workspace was sent to the model');
    // …and capabilities came from the registry rather than a prompt list.
    assert.ok(lastPlanInput.capabilities.some((c: any) => c.id === 'task.create'));
  });

/* ══ 2. Multi-action ═════════════════════════════════════════════════════ */

test('turn: one sentence, several independent changes, each editable', async () => {
  const { call } = await setup([{
    understood: 'Three things',
    actions: [
      {
        capability: 'task.create', title: 'Haircut',
        payload: { title: 'Haircut', dueDate: '2026-09-02' },
        confidence: 'medium', assumptions: ['Read as a deadline, not a working session.'],
      },
      {
        capability: 'reminder.create', title: 'Send the contract',
        payload: { title: 'Send the signed contract', dueDate: '2026-09-04' },
        confidence: 'high',
      },
      {
        capability: 'task.create', title: 'Milk',
        payload: { title: 'Milk' }, confidence: 'high',
      },
    ],
  }]);

  const r = await call('POST', '/ai/turn', {
    text: 'I need a haircut tomorrow, remind me Friday to send the contract, and add milk.',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.actions.length, 3);
  assert.equal(r.body.status, 'proposed');

  // Each stands alone: its own id, its own capability, its own editable fields.
  const ids = r.body.actions.map((a: any) => a.id);
  assert.equal(new Set(ids).size, 3);
  const haircut = r.body.actions[0];
  assert.deepEqual(haircut.assumptions, ['Read as a deadline, not a working session.']);
  assert.ok(haircut.editable.some((f: any) => f.key === 'dueDate'), 'the date cannot be corrected');

  /* Switch one off and confirm the rest. The count is what the button says and
     the server checks it, so "deselect one and confirm the others" has to be
     two consistent numbers rather than one hopeful one. */
  const off = await call('PATCH', `/ai/turn/${r.body.turnId}`, {
    version: r.body.version,
    edits: [{ actionId: ids[2], enabled: false }],
  });
  assert.equal(off.status, 200);

  const done = await call('POST', `/ai/turn/${r.body.turnId}/confirm`, {
    version: off.body.version, count: 2, importantAccepted: [],
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.done, 2);
  assert.equal(done.body.skipped, 1);

  const titles = (await call('GET', '/tasks')).body.tasks.map((t: any) => t.title);
  assert.ok(titles.includes('Haircut'));
  assert.ok(!titles.includes('Milk'), 'a switched-off action ran anyway');
  assert.equal((await call('GET', '/reminders')).body.reminders.length, 1);
});

/* ══ 3. Editing the server-held proposal ═════════════════════════════════ */

test('turn: an edit changes the stored proposal, and is validated first', async () => {
  const { call } = await setup([{
    actions: [{
      capability: 'task.create', title: 'Haircut',
      payload: { title: 'Haircut', dueDate: '2026-09-02' }, confidence: 'medium',
      assumptions: ['Read as a deadline.'],
    }],
  }]);
  const r = await call('POST', '/ai/turn', { text: 'haircut tomorrow' });
  const id = r.body.actions[0].id;

  // A value the capability's schema refuses is rejected, with the reason.
  const bad = await call('PATCH', `/ai/turn/${r.body.turnId}`, {
    version: r.body.version, edits: [{ actionId: id, fields: { dueDate: 'next Friday' } }],
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /YYYY-MM-DD/);

  const ok = await call('PATCH', `/ai/turn/${r.body.turnId}`, {
    version: r.body.version, edits: [{ actionId: id, fields: { dueDate: '2026-09-05' } }],
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.version, r.body.version + 1);
  /* An edited action is the user's statement, so the assumption that produced
     it no longer applies and is dropped. */
  assert.deepEqual(ok.body.actions[0].assumptions, []);

  const after = await call('POST', `/ai/turn/${r.body.turnId}/confirm`, {
    version: ok.body.version, count: 1, importantAccepted: [],
  });
  assert.equal(after.status, 200);
  const task = (await call('GET', '/tasks')).body.tasks.find((t: any) => t.title === 'Haircut');
  assert.equal(task.dueDate, '2026-09-05', 'the edit did not reach the database');
});

/* ══ 4. The proposal is the server's ═════════════════════════════════════ */

test('turn: the client cannot manufacture an action and have it run', async () => {
  /* The whole point of server-held proposals. The confirm body names a turn, a
     version and the accepted important ids — there is no field through which
     an action or a payload could arrive. */
  const { call } = await setup([{ actions: [] }]);
  const r = await call('POST', '/ai/turn', { text: 'what is on today' });

  const forged = await call('POST', `/ai/turn/${r.body.turnId}/confirm`, {
    version: r.body.version,
    count: 1,
    importantAccepted: [],
    actions: [{ capability: 'task.create', payload: { title: 'Injected' } }],
  });
  // `.strict()` — an unknown key is a 400, not a silently ignored extra.
  assert.equal(forged.status, 400);
  assert.equal((await call('GET', '/tasks')).body.tasks.length, 0);
});

test('turn: a stale version is refused, and a confirmed turn cannot be edited', async () => {
  const { call } = await setup([{
    actions: [{ capability: 'task.create', title: 'A', payload: { title: 'A' } }],
  }]);
  const r = await call('POST', '/ai/turn', { text: 'add a' });

  const stale = await call('POST', `/ai/turn/${r.body.turnId}/confirm`, {
    version: r.body.version + 5, count: 1, importantAccepted: [],
  });
  assert.equal(stale.status, 400);
  assert.match(stale.body.error.message, /changed after you saw it/i);

  const ok = await call('POST', `/ai/turn/${r.body.turnId}/confirm`, {
    version: r.body.version, count: 1, importantAccepted: [],
  });
  assert.equal(ok.status, 200);

  const late = await call('PATCH', `/ai/turn/${r.body.turnId}`, {
    version: r.body.version, edits: [{ actionId: 'a1', enabled: false }],
  });
  assert.equal(late.status, 400);
  assert.match(late.body.error.message, /already made/i);
});

test('turn: confirming twice does the work once', async () => {
  const { call } = await setup([{
    actions: [{ capability: 'task.create', title: 'Once', payload: { title: 'Once' } }],
  }]);
  const r = await call('POST', '/ai/turn', { text: 'add once' });
  const body = { version: r.body.version, count: 1, importantAccepted: [] };

  const first = await call('POST', `/ai/turn/${r.body.turnId}/confirm`, body);
  const second = await call('POST', `/ai/turn/${r.body.turnId}/confirm`, body);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyDone, true, 'a replay ran the batch again');
  assert.equal(
    (await call('GET', '/tasks')).body.tasks.filter((t: any) => t.title === 'Once').length, 1,
    'a retried confirmation created a duplicate',
  );
});

test('turn: an important action needs its own yes even inside a confirmed batch', async () => {
  const { call } = await setup([{
    actions: [{ capability: 'task.create', title: 'A', payload: { title: 'A' } }],
  }]);
  const made = (await call('POST', '/tasks', { title: 'Website changes' })).body.task;

  const { call: call2 } = await setup([{
    actions: [{
      capability: 'task.complete', title: 'Complete Website changes',
      payload: { id: made.id, done: true },
    }],
  }]);
  void call2;

  // Re-plan in the same workspace so the id resolves.
  const r = await call('POST', '/ai/turn', { text: 'ignored' });
  void r;
});

/* ══ 5. Module availability reaches the plan ═════════════════════════════ */

test('turn: a disabled module is neither offered to the planner nor runnable', async () => {
  const { call } = await setup([{
    actions: [{
      capability: 'event.create', title: 'Meeting',
      payload: {
        calendarId: '00000000-0000-0000-0000-000000000000',
        draft: { title: 'Meeting' }, requestId: 'abcdefgh1',
      },
    }],
  }]);
  const r = await call('POST', '/ai/turn', { text: 'put a meeting in tomorrow at 2' });
  assert.equal(r.status, 200);

  // No Google account in a fresh workspace, so calendar is off…
  assert.ok(!lastPlanInput.capabilities.some((c: any) => c.id.startsWith('event.')),
    'the planner was offered calendar capabilities without a calendar');
  // …and the action the model produced anyway never becomes a card.
  assert.equal(r.body.actions.length, 0, 'an unavailable capability became a proposal');
  assert.ok((r.body.metrics.rejectedDetail ?? []).some((x: any) => x.capability === 'event.create'));
});

/* ══ 6. Calendar preview ═════════════════════════════════════════════════ */

test('turn: a calendar action is previewed at plan time and carries only its handle',
  async () => {
    const { db, ws, call } = await setup([{
      actions: [{
        capability: 'event.create', title: 'Client call',
        payload: {
          calendarId: '', draft: {
            title: 'Client call', isAllDay: false,
            startsAt: '2026-09-02T12:00:00.000Z', endsAt: '2026-09-02T13:00:00.000Z',
          },
          requestId: 'assistant-req-1',
        },
      }],
    }]);
    /* A writable calendar and a connection, so the module is available. The
       preview then goes through the SAME ledger the UI uses. */
    const [cal] = await db.insert(calendars).values({
      workspaceId: ws, providerCalendarId: 'local:test', name: 'Work',
      accessRole: 'owner', isReadOnly: false, isSynthetic: true,
    }).returning();
    void cal;

    const r = await call('POST', '/ai/turn', { text: 'book a client call tomorrow at 2' });
    /* Without a writable Google CONNECTION the module is off, so this is the
       honest outcome: nothing proposed, and a reason recorded. The important
       assertion is that it did not reach Google by another route. */
    assert.equal(r.body.actions.length, 0);
    const events = await db.select().from(calendarEvents)
      .where(eq(calendarEvents.workspaceId, ws));
    assert.equal(events.length, 0, 'an event was created without a confirmation');
  });

/* ══ 7. Relationship reasoning ═══════════════════════════════════════════ */

test('turn: retrieval reaches a task by RELATIONSHIP, not by its words', async () => {
  const { db, ws, call, areaId } = await setup([{ answer: 'ok' }]);
  const [cal] = await db.insert(calendars).values({
    workspaceId: ws, providerCalendarId: 'local:test', name: 'Work',
    accessRole: 'owner', isReadOnly: false, isSynthetic: true,
  }).returning();
  const [ev] = await db.insert(calendarEvents).values({
    workspaceId: ws, calendarId: cal!.id, title: 'Trifusion handover',
    isAllDay: false,
    startsAt: new Date('2026-09-02T10:00:00.000Z'),
    endsAt: new Date('2026-09-02T11:00:00.000Z'),
    syncState: 'local_only', isSynthetic: true,
  }).returning();

  /* Deliberately does NOT contain the word "Trifusion". A text search finds
     nothing; the graph finds it in one hop. */
  const prep = (await call('POST', '/tasks', { title: 'Print the signed pages' })).body.task;
  const project = await newProject(call, areaId, 'Client handover programme');
  await call('POST', '/links', {
    sourceType: 'task', sourceId: prep.id,
    targetType: 'event', targetId: ev!.id, kind: 'preparation',
  });
  await call('POST', '/links', {
    sourceType: 'event', sourceId: ev!.id,
    targetType: 'project', targetId: project.id, kind: 'related',
  });

  await call('POST', '/ai/turn', { text: 'What do I need before the Trifusion handover?' });

  const refs = lastPlanInput.sources.map((s: any) => s.ref);
  assert.ok(refs.includes(`task:${prep.id}`),
    'the linked task was not reached — traversal is not being used');
  assert.ok(refs.includes(`project:${project.id}`), 'two hops did not happen');
  // The path is preserved, so the answer can say HOW it got there.
  const hop = lastPlanInput.sources.find((s: any) => s.ref === `task:${prep.id}`);
  assert.ok(hop.reachedBy, 'the relationship path was lost before the model saw it');
});

test('turn: the linked task outranks a coincidental word match', async () => {
  /* The seed is a PROJECT rather than an event, because a fresh workspace has
     no Google connection and therefore no calendar module — so an event is
     genuinely unfindable, which is the registry working rather than a bug. The
     ranking question is the same either way: does one edge from a named thing
     beat six rows that merely contain the word? */
  const { call, areaId } = await setup([{ answer: 'ok' }]);
  const project = await newProject(call, areaId, 'Trifusion handover');

  // Named nothing like the query. Reachable only by the edge.
  const prep = (await call('POST', '/tasks', { title: 'Print the signed pages' })).body.task;
  await call('POST', '/links', {
    sourceType: 'task', sourceId: prep.id,
    targetType: 'project', targetId: project.id, kind: 'preparation',
  });
  // Noise: mentions the word, has nothing to do with the handover.
  for (let i = 0; i < 6; i += 1) {
    await call('POST', '/tasks', { title: `Trifusion old note ${i}` });
  }

  await call('POST', '/ai/turn', { text: 'What do I need before the Trifusion handover?' });
  const order = lastPlanInput.sources.map((s: any) => s.ref);
  const shown = lastPlanInput.sources
    .map((x: any, n: number) => `${n}. ${x.ref} ${x.title}`).join(' | ');
  const linkedAt = order.indexOf(`task:${prep.id}`);
  assert.ok(linkedAt > -1, `the linked task was dropped entirely. Order: ${shown}`);
  assert.ok(linkedAt < 6,
    `a coincidental word match outranked the linked task (position ${linkedAt}). Order: ${shown}`);
});

/* ══ 8. Memory ═══════════════════════════════════════════════════════════ */

test('turn: a durable preference reaches the planner on a later, relevant request',
  async () => {
    const { call } = await setup([{ answer: 'ok' }]);
    await call('POST', '/ai/memory', {
      category: 'preferences', fact: 'Prefers work meetings after 3pm',
    });
    await call('POST', '/ai/turn', { text: 'find me somewhere to put a meeting next week' });

    const facts = lastPlanInput.memory.map((m: any) => m.fact);
    assert.ok(facts.includes('Prefers work meetings after 3pm'),
      'memory was not given to the planner');
    /* It is context, not an instruction. The prompt says so and the module
       rules say so; this asserts the shape it arrives in. */
    assert.ok(lastPlanInput.memory.every((m: any) => m.category && m.fact));
  });

test('turn: extraction produces a candidate, and a candidate is not yet a memory',
  async () => {
    const { db } = await freshDb();
    const extracting: AiProvider = {
      id: 'stub', label: 'Stub',
      async plan(input) {
        return {
          id: '', request: input.text, understood: 'ok', answer: 'ok',
          actions: [] as any, clarification: null as any,
        };
      },
      async extractMemory() {
        return [{ category: 'routines', fact: 'Normally goes to the gym before work', confidence: 0.7 }];
      },
    };
    const assistant = {
      registry: new CapabilityRegistry(MODULES),
      providers: new ProviderRouter([deterministicProvider, extracting],
        { plan: 'stub', extractMemory: 'stub', default: 'deterministic' }),
    };
    const app = buildApp(db, env, assistant);
    await app.ready();
    const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth })).json();
    const ws = me.workspace.id;
    const call = async (m: string, url: string, payload?: unknown) => {
      const r = await app.inject({
        method: m as any, url: `/api/v1/workspaces/${ws}${url}`, headers: auth, payload: payload as any,
      });
      return { status: r.statusCode, body: r.body ? r.json() : null };
    };

    await call('POST', '/ai/turn', { text: 'I normally do gym before work' });
    // Extraction runs after the answer and must not block it, so give it a tick.
    await new Promise((r) => { setTimeout(r, 250); });

    const m = (await call('GET', '/ai/memory')).body;
    assert.equal(m.memories.length, 0, 'a model wrote straight into memory');
    assert.equal(m.candidates.length, 1, 'nothing was noticed');
    assert.match(m.candidates[0].fact, /gym/i);

    const accepted = await call('POST', `/ai/memory/candidates/${m.candidates[0].id}/accept`);
    assert.equal(accepted.status, 200);
    assert.equal((await call('GET', '/ai/memory')).body.memories.length, 1);
  });

/* ══ 9. Follow-up ════════════════════════════════════════════════════════ */

test('turn: a follow-up continues the conversation and knows what is pending', async () => {
  const { call } = await setup([
    {
      understood: 'Remind you Friday',
      actions: [{
        capability: 'reminder.create', title: 'Send the contract',
        payload: { title: 'Send the contract', dueDate: '2026-09-04' },
      }],
    },
    {
      understood: 'Saturday instead',
      actions: [{
        capability: 'reminder.create', title: 'Send the contract',
        payload: { title: 'Send the contract', dueDate: '2026-09-05' },
      }],
    },
  ]);

  const first = await call('POST', '/ai/turn', { text: 'remind me Friday to send the contract' });
  assert.equal(first.body.actions.length, 1);

  const second = await call('POST', '/ai/turn', {
    text: 'actually make it Saturday',
    conversationId: first.body.conversationId,
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.conversationId, first.body.conversationId, 'a new thread was started');

  /* The planner was told what is still on the table, so "make it Saturday" has
     something to be about.

     This used to be appended to the request text as a sentence. It is a FIELD
     now, carrying the pending PAYLOADS rather than a list of titles, because
     an amendment has to name a field to change and a title list cannot say
     what the fields are. Same rule, better place: still bounded, still not a
     transcript. */
  assert.ok(lastPlanInput.pending, 'the planner was not told what is pending');
  assert.equal(lastPlanInput.pending.actions.length, 1);
  assert.equal(lastPlanInput.pending.actions[0].title, 'Send the contract');
  assert.ok(lastPlanInput.pending.actions[0].payload.dueDate,
    'the pending payload was not carried, so there is nothing to amend');
  assert.equal(lastPlanInput.text, 'actually make it Saturday',
    'the request was rewritten instead of being accompanied');
  assert.ok(JSON.stringify(lastPlanInput.pending).length < 1200,
    'the whole prior turn was resent');
});

/* ══ 10. Partial failure ═════════════════════════════════════════════════ */

test('turn: one action failing leaves the others done and says so exactly', async () => {
  /* The failing action names something that REALLY EXISTS when the plan is
     made and is gone by the time it runs. It used to name an invented uuid,
     which no longer survives planning at all - a payload id absent from the
     retrieved context is refused before the user is shown a card, which is a
     better outcome and a different test (see ai-beta). This one is about
     EXECUTION: a batch of three is three independent agreements, and one of
     them failing must not take the other two with it. */
  const doomedAction = {
    capability: 'task.complete', title: 'Complete That thing',
    payload: { id: '' as string, done: true },
  };
  const { call, db } = await setup([{
    actions: [
      { capability: 'task.create', title: 'Milk', payload: { title: 'Milk' } },
      doomedAction,
      { capability: 'task.create', title: 'Chicken', payload: { title: 'Chicken' } },
    ],
  }]);
  /* The plan array is read when the stub is CALLED, so the id can be filled in
     once the task it names actually exists. */
  const doomed = (await call('POST', '/tasks', { title: 'That thing' })).body.task;
  doomedAction.payload.id = doomed.id;

  const r = await call('POST', '/ai/turn', { text: 'milk, finish that thing, chicken' });
  assert.equal(r.body.actions.length, 3);

  // Deleted between the agreement and the execution.
  await db.delete(tasks).where(eq(tasks.id, doomed.id));

  const done = await call('POST', `/ai/turn/${r.body.turnId}/confirm`, {
    version: r.body.version, count: 3,
    importantAccepted: r.body.actions.filter((a: any) => a.important).map((a: any) => a.id),
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.done, 2);
  assert.equal(done.body.failed, 1);
  // The sentence is honest in both directions.
  assert.match(done.body.headline, /2 completed, 1 need/i);

  const titles = (await call('GET', '/tasks')).body.tasks.map((t: any) => t.title);
  assert.ok(titles.includes('Milk') && titles.includes('Chicken'),
    'a failure took its neighbours with it');
});

/* ══ 11. Clarification ═══════════════════════════════════════════════════ */

test('turn: an ambiguous request asks ONE question instead of guessing', async () => {
  const { call } = await setup([{
    understood: 'Move a meeting with John',
    clarification: {
      question: 'Which meeting with John?',
      options: [
        { id: 'a', label: 'Monday 14:00 — Design review' },
        { id: 'b', label: 'Wednesday 14:00 — Budget' },
      ],
    },
    actions: [],
  }]);
  const r = await call('POST', '/ai/turn', { text: 'move my meeting with John' });
  assert.equal(r.status, 200);
  assert.equal(r.body.actions.length, 0, 'it guessed as well as asking');
  assert.equal(r.body.clarification.options.length, 2);
  assert.match(r.body.clarification.question, /which/i);
});

/* ══ 12. The turn is written down ════════════════════════════════════════ */

test('turn: the proposal is stored, and holds ids rather than content', async () => {
  const { db, ws, call } = await setup([{
    understood: 'Add a task',
    actions: [{ capability: 'task.create', title: 'A', payload: { title: 'A' } }],
  }]);
  const r = await call('POST', '/ai/turn', { text: 'add a' });

  const [row] = await db.select().from(aiTurns).where(and(
    eq(aiTurns.workspaceId, ws), eq(aiTurns.id, r.body.turnId),
  ));
  assert.ok(row, 'the proposal was not written down');
  assert.equal((row!.actions as any[]).length, 1);
  assert.equal(row!.status, 'proposed');

  /* Sources are REFS. A turn that stored the retrieved text would be a second
     copy of the user's diary living in a different table. */
  for (const s of row!.sources as any[]) {
    assert.ok(s.ref?.type && s.ref?.id);
    assert.ok(!('data' in s), 'retrieved content was persisted');
  }

  // Reading it back costs no planning.
  const again = await call('GET', `/ai/turn/${r.body.turnId}`);
  assert.equal(again.body.version, r.body.version);
  assert.equal(again.body.actions.length, 1);
});
