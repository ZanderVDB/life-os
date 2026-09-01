/**
 * Beta readiness — the parts added for real users, and only the risky ones.
 *
 * Not a matrix. The existing suites already cover the turn, the executor, the
 * confirmation gate and the domain services; what is new and expensive to get
 * wrong is:
 *
 *   · the fast path decides correctly AND fails closed;
 *   · retrieval expands structurally and goes broad rather than giving up;
 *   · clarification options name entities, and choosing one continues the
 *     ORIGINAL request with that entity;
 *   · a pending proposal can be amended before it exists;
 *   · a plan whose words and payload disagree never reaches the user;
 *   · read and write availability are separate — losing the ability to write
 *     a calendar is not losing the ability to see it;
 *   · a module registered through the normal mechanism is usable with no
 *     central list edited anywhere;
 *   · a pinned memory is not quietly overwritten, and housekeeping removes
 *     only what it says it removes;
 *   · a calendar action survives the round trip from plan to execution.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { CapabilityRegistry, forRequest, executionSchema } from '../src/ai/registry.js';
import type { AiModule } from '../src/ai/registry.js';
import { MODULES } from '../src/ai/modules/index.js';
import { ProviderRouter, deterministicProvider } from '../src/ai/provider.js';
import type { AiProvider } from '../src/ai/provider.js';
import { tryFastPath, isMiss, resolveDate } from '../src/ai/fastpath.js';
import { validatePlan, fieldsOf, signatureOf } from '../src/ai/validate.js';
import { structure, fromCandidates } from '../src/ai/clarify.js';
import { rankMemories } from '../src/ai/ranking.js';
import * as memory from '../src/ai/memory.js';
import {
  tasks, habits, aiTurns, aiMemoryCandidates, itemLinks, calendars, calendarEvents,
  calendarConnections,
} from '../src/db/schema.js';
import { and, eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { encryptToken } from '../src/lib/token-crypto.js';

const GOOGLE_KEY = 'test-key-that-is-definitely-long-enough-32';

/** Google, scripted. The same shape `calendar-two-way.test.ts` uses. */
function stubGoogle() {
  process.env['GOOGLE_CALENDAR_CLIENT_ID'] = 'test-client';
  process.env['GOOGLE_CALENDAR_CLIENT_SECRET'] = 'test-secret';
  process.env['GOOGLE_CALENDAR_REDIRECT_URI'] = 'http://localhost/cb';
  process.env['GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY'] = GOOGLE_KEY;
  const real = globalThis.fetch;
  const calls: { method: string; url: string; body: any }[] = [];
  const event = {
    id: 'gev-ai-1',
    status: 'confirmed',
    summary: 'Handover note',
    etag: '"etag-1"',
    updated: '2026-09-01T09:00:00.000Z',
    start: { dateTime: '2026-09-03T09:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-09-03T10:00:00Z', timeZone: 'UTC' },
  };
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const href = String(url);
    const method = init.method ?? 'GET';
    let body: any = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
    calls.push({ method, url: href, body });
    const reply = (status: number, b: any) => new Response(JSON.stringify(b), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    if (href.includes('oauth2.googleapis.com/token')) {
      return reply(200, { access_token: 'fresh', expires_in: 3600 });
    }
    if (href.includes('/freeBusy')) return reply(200, { calendars: {} });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return reply(200, event);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = { authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'zander@example.com' };

type Plan = {
  understood?: string;
  answer?: string | null;
  actions?: unknown[];
  amend?: unknown[];
  clarification?: unknown;
};

let lastPlanInput: any = null;
let planCalls = 0;

function stubPlanner(plans: Plan[]): AiProvider {
  let i = 0;
  return {
    id: 'stub',
    label: 'Stub',
    model: 'stub-1',
    async plan(input) {
      lastPlanInput = input;
      planCalls += 1;
      const p = plans[Math.min(i, plans.length - 1)] ?? {};
      i += 1;
      return {
        id: '',
        request: input.text,
        understood: p.understood ?? 'Understood',
        answer: p.answer ?? null,
        actions: (p.actions ?? []) as any,
        amend: (p.amend ?? []) as any,
        clarification: (p.clarification ?? null) as any,
      };
    },
    async answer() { return { answer: '', cited: [] }; },
  };
}

async function setup(plans: Plan[] = [{}], modules: AiModule[] = MODULES) {
  lastPlanInput = null;
  planCalls = 0;
  const { db } = await freshDb();
  const assistant = {
    registry: new CapabilityRegistry(modules),
    providers: new ProviderRouter(
      [deterministicProvider, stubPlanner(plans)],
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
  return {
    app, db, ws, call, assistant,
    userId: me.user.id, areaId: me.areas[0].id,
    ctx: forRequest(db, {
      workspaceId: ws, userId: me.user.id, today: '2026-09-01', timeZone: null, surface: null,
    }),
  };
}

/* ══ 1. The fast path ════════════════════════════════════════════════════ */

test('fast path: obvious commands are answered without a model at all', async () => {
  const { call, ws, db } = await setup([{ understood: 'should not be reached', actions: [] }]);

  const add = await call('POST', '/ai/turn', { text: 'Add milk' });
  assert.equal(add.status, 200);
  assert.equal(add.body.metrics.route, 'fast', 'the planner was asked about "Add milk"');
  assert.equal(add.body.metrics.model, null, 'a model was involved');
  assert.equal(add.body.actions.length, 1);
  assert.equal(add.body.actions[0].capability, 'task.create');
  assert.equal(add.body.actions[0].payload.title, 'Milk');
  assert.equal(planCalls, 0, 'the planner was called for an obvious command');

  /* And it is a NORMAL proposal: nothing has happened, and confirming it goes
     through the same gate everything else does. */
  assert.equal(add.body.status, 'proposed');
  assert.equal((await db.select().from(tasks).where(eq(tasks.workspaceId, ws))).length, 0,
    'the fast path wrote something without a confirmation');
  const done = await call('POST', `/ai/turn/${add.body.turnId}/confirm`, {
    version: add.body.version, count: 1, importantAccepted: [],
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.done, 1);

  const named = await call('POST', '/ai/turn', { text: 'Add a task called Send invoice' });
  assert.equal(named.body.metrics.route, 'fast');
  assert.equal(named.body.actions[0].payload.title, 'Send invoice');

  const remind = await call('POST', '/ai/turn', {
    text: 'Remind me Friday to call Oscar', today: '2026-09-01',
  });
  assert.equal(remind.body.metrics.route, 'fast');
  assert.equal(remind.body.actions[0].capability, 'reminder.create');
  assert.equal(remind.body.actions[0].payload.title, 'Call Oscar');
  assert.equal(remind.body.actions[0].payload.dueDate, '2026-09-04', 'Friday was resolved wrongly');
});

test('fast path: completing resolves an entity, whatever kind it is', async () => {
  const { call, db, ws } = await setup([{ actions: [] }]);
  await db.insert(habits).values({ workspaceId: ws, name: 'Morning walk', targetCount: 1 });
  const task = (await call('POST', '/tasks', { title: 'Pay the deposit' })).body.task;

  const habit = await call('POST', '/ai/turn', { text: 'Complete Morning walk' });
  assert.equal(habit.body.metrics.route, 'fast');
  assert.equal(habit.body.actions[0].capability, 'habit.check',
    'a habit was completed as though it were a task');

  const done = await call('POST', '/ai/turn', { text: 'Mark Pay the deposit complete' });
  assert.equal(done.body.metrics.route, 'fast');
  assert.equal(done.body.actions[0].capability, 'task.complete');
  assert.equal(done.body.actions[0].payload.id, task.id);
  /* Completing is destructive enough to need its own yes, and the SERVER
     decided that from the capability's risk - the fast path had no say. */
  assert.equal(done.body.actions[0].important, true);

  const move = await call('POST', '/ai/turn', { text: 'Move Pay the deposit to this week' });
  assert.equal(move.body.metrics.route, 'fast');
  assert.equal(move.body.actions[0].capability, 'task.move');
  assert.equal(move.body.actions[0].payload.bucket, 'week');
});

test('fast path: anything less than obvious falls through to the planner', async () => {
  const { call, db, ws, ctx, assistant } = await setup([{
    understood: 'Planned', actions: [{ capability: 'task.create', title: 'X', payload: { title: 'X' } }],
  }]);
  await db.insert(tasks).values([
    { workspaceId: ws, title: 'Invoice', bucket: 'today' },
    { workspaceId: ws, title: 'Invoice', bucket: 'week' },
    { workspaceId: ws, title: 'Quote for Trifusion', bucket: 'today' },
  ]);

  const miss = async (text: string) => {
    const r = await tryFastPath({
      text, ctx, registry: assistant.registry, hasPending: false,
    });
    assert.ok(isMiss(r), `"${text}" was taken as obvious`);
    return (r as any).reason as string;
  };

  assert.match(await miss('What is left on the handover?'), /question/);
  assert.match(await miss('Add milk and chicken'), /clause/);
  assert.match(await miss('Complete Invoice'), /2 things match/);
  /* But a name that matches one thing EXACTLY and others partially is not
     ambiguous - one of them is the thing named. Refusing here would send
     "add milk" to a reasoning chain because a task called "buy oat milk"
     also exists, which is the fast path declining to be useful. */
  const exact = await tryFastPath({
    text: 'Complete Quote for Trifusion', ctx, registry: assistant.registry, hasPending: false,
  });
  assert.ok(!isMiss(exact), 'an exact match was treated as ambiguous');
  assert.match(await miss('Complete Zzyzx planning'), /nothing matched/);
  assert.match(await miss('Remind me at the end of the month to file'), /cannot resolve/);
  assert.match(await miss('Add pay the rent on Friday'), /needs interpreting/);
  assert.match(await miss('Move Invoice to Todoist'), /not a board column/);
  assert.match(await miss('Move this to today'), /no task is open/);
  assert.match(await miss('Book a meeting tomorrow'), /calendar/);

  /* And falling through really does reach the planner, which really does own
     the outcome. */
  const r = await call('POST', '/ai/turn', { text: 'What is left on the handover?' });
  assert.equal(r.body.metrics.route, 'planner');
  assert.ok(r.body.metrics.fastPathMiss, 'no reason was recorded for the fall-through');
  assert.equal(planCalls, 1);
});

test('fast path: a weekday is the NEXT one, never today', () => {
  // 2026-09-01 is a Tuesday.
  assert.equal(resolveDate('on Friday', '2026-09-01')?.date, '2026-09-04');
  assert.equal(resolveDate('tuesday', '2026-09-01')?.date, '2026-09-08', 'today was offered back');
  assert.equal(resolveDate('tomorrow', '2026-09-01')?.date, '2026-09-02');
  assert.equal(resolveDate('in 3 days', '2026-09-01')?.date, '2026-09-04');
  assert.equal(resolveDate('next month sometime', '2026-09-01'), null, 'a vague date was resolved');
});

/* ══ 2. Retrieval ════════════════════════════════════════════════════════ */

test('retrieval: a project question reaches the project’s own tasks', async () => {
  const { call, areaId } = await setup([{ answer: 'ok', actions: [] }]);
  const project = (await call('POST', '/projects', {
    title: 'WebAnchor client handover', outcome: 'Handed over', areaId, focus: 'now',
  })).body.project;
  /* Deliberately NOT sharing a word with the question. A task belongs to a
     project by FOREIGN KEY, so neither text search nor link traversal reaches
     it - only reading the project does. */
  for (const title of ['Print the signed pages', 'Return the door fob']) {
    const t = (await call('POST', '/tasks', { title })).body.task;
    await call('POST', `/projects/${project.id}/tasks`, { taskId: t.id });
  }

  await call('POST', '/ai/turn', { text: 'What still needs to happen for WebAnchor?' });
  const refs = lastPlanInput.sources.map((s: any) => s.ref);
  assert.ok(refs.includes(`project:${project.id}`), 'the project was not retrieved');
  const titles = lastPlanInput.sources.map((s: any) => s.title);
  assert.ok(titles.includes('Print the signed pages'),
    'the project’s own tasks never reached the planner');
  assert.ok(titles.includes('Return the door fob'));
});

test('retrieval: plurals, inflections and casing all find the same thing', async () => {
  const { call, db, ws } = await setup([{ answer: 'ok', actions: [] }]);
  await db.insert(tasks).values([
    { workspaceId: ws, title: 'Price three options', bucket: 'today' },
    { workspaceId: ws, title: 'Invoice', bucket: 'today' },
  ]);

  const found = async (text: string) => {
    await call('POST', '/ai/turn', { text });
    return lastPlanInput.sources.map((s: any) => s.title);
  };
  assert.ok((await found('I finished pricing three options')).includes('Price three options'),
    'an inflected verb found nothing');
  assert.ok((await found('what about the invoices')).includes('Invoice'),
    'a plural found nothing');
  assert.ok((await found('INVOICE status?')).includes('Invoice'), 'casing mattered');
});

test('retrieval: a thin first pass is widened before giving up', async () => {
  const { call, db, ws } = await setup([{ answer: 'ok', actions: [] }]);
  /* Nothing whose title contains any word of the request. A targeted search
     returns nothing at all, which is exactly when concluding "it does not
     exist" is most likely to be wrong. */
  await db.insert(habits).values({ workspaceId: ws, name: 'Stretching', targetCount: 1 });

  const r = await call('POST', '/ai/turn', { text: 'what remaining zqx' });
  assert.equal(r.body.metrics.broadened, true, 'retrieval gave up on the first pass');
  assert.ok(lastPlanInput.sources.some((s: any) => s.title === 'Stretching'),
    'the broad pass found nothing the narrow one had missed');
});

test('retrieval: "what is on today" is answerable, though it names nothing', async () => {
  /* The most ordinary question a command centre gets, and the one that used to
     retrieve NOTHING: it contains no word that appears in any title, so every
     search returned empty and the assistant said it could not see the board.
     Search answers "which of these is X"; a list answers "what is there". */
  const { call, db, ws } = await setup([{ answer: 'ok', actions: [] }]);
  await db.insert(tasks).values([
    { workspaceId: ws, title: 'Reconcile against the bank', bucket: 'today' },
    { workspaceId: ws, title: 'Pay the deposit', bucket: 'today' },
    { workspaceId: ws, title: 'File the return', bucket: 'week' },
  ]);

  const r = await call('POST', '/ai/turn', { text: 'What is on my Today board?' });
  assert.equal(r.status, 200);
  const titles = lastPlanInput.sources.map((s: any) => s.title);
  assert.ok(titles.includes('Reconcile against the bank'), 'the board never reached the planner');
  assert.ok(titles.includes('Pay the deposit'));
  assert.equal(r.body.metrics.broadened, true, 'a question with no search term did not widen');

  /* Directly, too: these answer with no arguments at all, which is what makes
     them reachable from the broad pass. */
  const listed = await call('POST', '/ai/context', { level: 3, limit: 40 });
  assert.ok(listed.body.used.includes('task.list'));
  assert.ok(listed.body.used.includes('reminder.list'));
  assert.ok(listed.body.used.includes('project.list'));
});

test('the planner is told each capability payload shape, from the schema', async () => {
  /* Why this exists: the planner was given a capability id, description and
     risk but not its schema, so it inferred field names from an English
     sentence. That works for `title` and fails for `id` - task.complete
     describes no field at all, and the model kept proposing it against the
     right task with no id in the payload. */
  const shape = signatureOf(z.object({
    id: z.string().uuid(),
    done: z.boolean().default(true),
    when: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    changes: z.object({ title: z.string().optional() }),
  })) as Record<string, unknown>;
  assert.equal(shape['id'], 'uuid from CONTEXT');
  /* A defaulted field IS optional to the caller, and saying so is right:
     the planner may omit it. */
  assert.equal(shape['done'], 'boolean, optional');
  assert.equal(shape['when'], 'YYYY-MM-DD, optional');
  assert.deepEqual(shape['changes'], { title: 'string, optional' });

  const { call } = await setup([{ actions: [] }]);
  await call('POST', '/ai/turn', { text: 'what is happening' });
  const complete = lastPlanInput.capabilities.find((c: any) => c.id === 'task.complete');
  assert.ok(complete.payload?.id, 'the planner cannot know task.complete needs an id');
  /* Generated FROM the schema, so it cannot drift from what is enforced. */
  assert.match(String(complete.payload.id), /uuid/);
});

/* ══ 3. Structured clarification ═════════════════════════════════════════ */

test('clarification: options name entities, and choosing one continues the request',
  async () => {
    const { call, db, ws } = await setup([
      {
        understood: 'Which invoice',
        clarification: {
          question: 'Which one did you mean?',
          options: [{ id: 'x', label: 'Invoice' }, { id: 'y', label: 'Invoice for Trifusion' }],
        },
        actions: [],
      },
      /* The continuation. It is handed the chosen id and proposes against it. */
      { understood: 'Completing it', actions: [] },
    ]);
    const [a, b] = await db.insert(tasks).values([
      { workspaceId: ws, title: 'Invoice', bucket: 'today' },
      { workspaceId: ws, title: 'Invoice for Trifusion', bucket: 'today' },
    ]).returning();

    const asked = await call('POST', '/ai/turn', { text: 'complete the invoice' });
    assert.equal(asked.body.status, 'clarifying');
    assert.equal(asked.body.actions.length, 0, 'it guessed as well as asking');

    const opts = asked.body.clarification.options;
    assert.equal(opts.length, 2);
    /* The point of the whole change: each option resolves to a real row, and
       carries something a person can tell them apart by. */
    const ids = opts.map((o: any) => o.ref?.id);
    assert.ok(ids.includes(a!.id) && ids.includes(b!.id),
      'the options do not name the things they stand for');
    for (const o of opts) {
      assert.equal(o.ref.type, 'task');
      assert.ok(o.detail, 'nothing distinguishes the two options');
      assert.ok(o.id && o.id !== o.label, 'the option id is its label again');
    }

    const chosen = opts.find((o: any) => o.ref.id === b!.id);
    const next = await call('POST', `/ai/turn/${asked.body.turnId}/clarify`, {
      optionId: chosen.id,
    });
    assert.equal(next.status, 200);
    // The ORIGINAL request continued, with the choice settled by id.
    assert.equal(lastPlanInput.text, 'complete the invoice');
    assert.equal(lastPlanInput.resolved.ref.id, b!.id);
    assert.ok(lastPlanInput.sources.some((s: any) => s.ref === `task:${b!.id}`),
      'the chosen entity was not seeded into retrieval');

    // And the question cannot be answered twice.
    const again = await call('POST', `/ai/turn/${asked.body.turnId}/clarify`, {
      optionId: chosen.id,
    });
    assert.equal(again.status, 400);
  });

test('clarification: a ref the model invented is dropped, not trusted', () => {
  const sources = [{
    ref: { type: 'task' as const, id: '11111111-1111-4111-8111-111111111111' },
    module: 'tasks', title: 'Invoice', summary: null, via: 'direct' as const, level: 2 as const,
    data: { status: 'open' },
  }];
  const c = structure({
    question: 'Which?',
    options: [
      { label: 'Invoice', ref: 'task:11111111-1111-4111-8111-111111111111' },
      { label: 'Something else', ref: 'task:99999999-9999-4999-8999-999999999999' },
    ],
  }, sources)!;
  assert.equal(c.options[0]!.ref!.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(c.options[1]!.ref, null, 'an id that was never retrieved was believed');

  /* An option that is not an entity at all stays a plain choice. "Leave them
     open" is a real answer and forcing a ref onto it would be inventing one. */
  const choice = structure({
    question: 'What about the open tasks?',
    options: [{ label: 'Leave them open' }, { label: 'Cancel them' }],
  }, sources)!;
  assert.equal(choice.options.every((o) => !o.ref), true);

  assert.equal(fromCandidates('Which?', sources), null, 'one candidate is not a choice');
});

/* ══ 4. Pending proposals ════════════════════════════════════════════════ */

test('pending: a follow-up amends the proposal instead of inventing a second one',
  async () => {
    const { call, db, ws } = await setup([
      {
        understood: 'A haircut tomorrow',
        actions: [{
          capability: 'task.create', title: 'Haircut',
          payload: { title: 'Haircut', dueDate: '2026-09-02' },
          assumptions: ['Read as a deadline.'],
        }],
      },
      { understood: 'Saturday instead', amend: [{ actionId: 'a1', fields: { dueDate: '2026-09-05' } }] },
      { understood: 'Dropped', amend: [{ actionId: 'a1', enabled: false }] },
    ]);

    const first = await call('POST', '/ai/turn', {
      text: 'I need a haircut tomorrow', today: '2026-09-01',
    });
    assert.equal(first.body.actions.length, 1);

    const second = await call('POST', '/ai/turn', {
      text: 'actually Saturday', conversationId: first.body.conversationId,
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.amended, true, 'a second proposal was made instead of an amendment');
    assert.equal(second.body.turnId, first.body.turnId, 'the pending proposal was abandoned');
    assert.equal(second.body.actions.length, 1, 'there are now two haircuts');
    assert.equal(second.body.actions[0].payload.dueDate, '2026-09-05');
    assert.equal(second.body.version, first.body.version + 1, 'the version did not move');
    /* The amendment is the user's statement, so the model's reading of the
       original no longer stands beside it. */
    assert.deepEqual(second.body.actions[0].assumptions, []);
    // Nothing was written: it is still a proposal.
    assert.equal((await db.select().from(tasks).where(eq(tasks.workspaceId, ws))).length, 0);

    /* An amendment skips retrieval entirely - there is nothing to search for,
       because what it refers to does not exist yet. */
    assert.equal(lastPlanInput.sources.length, 0);
    assert.ok(lastPlanInput.pending, 'the planner was not told what was pending');
    assert.equal(lastPlanInput.pending.actions[0].payload.dueDate, '2026-09-02');

    const third = await call('POST', '/ai/turn', {
      text: "don't bother with it", conversationId: first.body.conversationId,
    });
    assert.equal(third.body.actions[0].enabled, false);

    /* Safety is untouched: the count the button would show is now zero, and a
       confirmation claiming otherwise is still refused. */
    const lie = await call('POST', `/ai/turn/${first.body.turnId}/confirm`, {
      version: third.body.version, count: 1, importantAccepted: [],
    });
    assert.equal(lie.status, 400);
    assert.match(lie.body.error.message, /Confirmed 1 changes but 0/);
  });

test('pending: an amendment drops prose that has stopped being true', async () => {
  /* The card carried its own sentence - "Saturday 5 September" - above a date
     field the amendment had just moved to the 7th. A card that says one thing
     and does another, arriving through the one door the consistency pass
     cannot watch: it runs between planning and the user, and an amendment
     happens after. */
  const { call } = await setup([
    {
      actions: [{
        capability: 'task.create', title: 'Add haircut task',
        summary: 'Saturday 5 September',
        payload: { title: 'Haircut', dueDate: '2026-09-05' },
      }],
    },
    { understood: 'Monday instead', amend: [{ actionId: 'a1', fields: { dueDate: '2026-09-07' } }] },
  ]);
  const first = await call('POST', '/ai/turn', { text: 'haircut saturday', today: '2026-09-01' });
  assert.equal(first.body.actions[0].summary, 'Saturday 5 September');

  const after = await call('POST', '/ai/turn', {
    text: 'actually Monday', conversationId: first.body.conversationId, today: '2026-09-01',
  });
  assert.equal(after.body.actions[0].payload.dueDate, '2026-09-07');
  assert.equal(after.body.actions[0].summary, null,
    'the card still claims a date the change no longer makes');

  /* A summary that is STILL true survives. Dropping every summary on every
     edit would lose a useful line to be safe about a rare one. */
  const { call: c2 } = await setup([
    {
      actions: [{
        capability: 'task.create', title: 'Add haircut task',
        summary: 'A short errand, nothing booked yet',
        payload: { title: 'Haircut', dueDate: '2026-09-05' },
      }],
    },
    { understood: 'Rename it', amend: [{ actionId: 'a1', fields: { title: 'Barber' } }] },
  ]);
  const one = await c2('POST', '/ai/turn', { text: 'haircut saturday', today: '2026-09-01' });
  const two = await c2('POST', '/ai/turn', {
    text: 'actually call it Barber', conversationId: one.body.conversationId, today: '2026-09-01',
  });
  assert.equal(two.body.actions[0].summary, 'A short errand, nothing booked yet');
});

test('pending: an amendment naming nothing pending is refused, not applied elsewhere',
  async () => {
    const { call } = await setup([
      { actions: [{ capability: 'task.create', title: 'Haircut', payload: { title: 'Haircut' } }] },
      { understood: 'Nope', amend: [{ actionId: 'a99', fields: { title: 'Elsewhere' } }] },
    ]);
    const first = await call('POST', '/ai/turn', { text: 'I need a haircut' });
    const second = await call('POST', '/ai/turn', {
      text: 'actually call it something else', conversationId: first.body.conversationId,
    });
    assert.equal(second.status, 400);
    const still = await call('GET', `/ai/turn/${first.body.turnId}`);
    assert.equal(still.body.actions[0].title, 'Haircut', 'an unmatched amendment changed something');
  });

/* ══ 5. Plan / payload consistency ═══════════════════════════════════════ */

test('consistency: a card that says one thing over a payload that does another is withheld',
  async () => {
    const { call } = await setup([
      {
        understood: 'Haircut Saturday',
        actions: [
          /* The failure this stage exists for: the sentence promises a date the
             payload does not contain. Both halves are individually valid. */
          {
            capability: 'task.create', title: 'Haircut on Saturday',
            payload: { title: 'Haircut' },
          },
          { capability: 'task.create', title: 'Milk', payload: { title: 'Milk' } },
        ],
      },
      /* The one repair attempt returns the same contradiction, so it is not
         kept and the action is withheld. */
      {
        understood: 'Haircut Saturday',
        actions: [
          { capability: 'task.create', title: 'Haircut on Saturday', payload: { title: 'Haircut' } },
          { capability: 'task.create', title: 'Milk', payload: { title: 'Milk' } },
        ],
      },
    ]);

    const r = await call('POST', '/ai/turn', {
      text: 'haircut saturday and milk', today: '2026-09-01',
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.metrics.inconsistencies.includes('date_missing'));
    assert.equal(planCalls, 2, 'no repair was attempted');
    // The good one survives; the misleading one does not, and is accounted for.
    assert.equal(r.body.actions.length, 1);
    assert.equal(r.body.actions[0].title, 'Milk');
    assert.match(r.body.note, /named a date the change would not actually have set/);
  });

test('consistency: a repair that fixes the contradiction is kept', async () => {
  const { call } = await setup([
    {
      actions: [{
        capability: 'task.create', title: 'Haircut on Saturday', payload: { title: 'Haircut' },
      }],
    },
    {
      actions: [{
        capability: 'task.create', title: 'Haircut on Saturday',
        payload: { title: 'Haircut', dueDate: '2026-09-05' },
      }],
    },
  ]);
  const r = await call('POST', '/ai/turn', { text: 'haircut saturday', today: '2026-09-01' });
  assert.equal(planCalls, 2);
  assert.equal(r.body.metrics.repaired, 1);
  assert.equal(r.body.actions.length, 1);
  assert.equal(r.body.actions[0].payload.dueDate, '2026-09-05');
  assert.equal(r.body.note, null);
  // The repair brief named the field and the sentence that disagreed.
  assert.match(lastPlanInput.repair.problems, /no such date/i);
});

test('consistency: the checks are deterministic and read the real schemas', () => {
  const schema = z.object({
    id: z.string().uuid(),
    changes: z.object({ title: z.string().optional(), dueDate: z.string().nullish() }),
  });
  assert.deepEqual([...fieldsOf(schema)].sort(), ['changes', 'dueDate', 'id', 'title']);

  const schemas = new Map<string, z.ZodTypeAny>([
    ['task.create', z.object({ title: z.string(), dueDate: z.string().nullish() })],
    ['habit.check', z.object({ id: z.string().uuid() })],
  ]);
  const known = new Set(['task:11111111-1111-4111-8111-111111111111']);

  // Agreement is silent.
  assert.equal(validatePlan({
    actions: [{
      capability: 'task.create', title: 'Haircut',
      payload: { title: 'Haircut', dueDate: '2026-09-05' },
      assumptions: ['Saturday means 2026-09-05.'],
    }],
    schemas, knownIds: known, today: '2026-09-01',
  }).length, 0);

  /* "Today" is a board COLUMN as well as a day. A card saying "Add chicken to
     the Today list" over a payload whose bucket IS today promises nothing it
     does not deliver, and refusing it told the user their shopping could not
     be prepared. */
  assert.equal(validatePlan({
    actions: [{
      capability: 'task.create', title: 'Add chicken to the Today list',
      payload: { title: 'Chicken', bucket: 'today' },
    }],
    schemas: new Map([['task.create', z.object({
      title: z.string(), bucket: z.string().default('today'), dueDate: z.string().nullish(),
    })]]),
    knownIds: known, today: '2026-09-01',
  }).length, 0, 'a board column was read as a promise about a due date');

  // A capability with nowhere to put the date it promises.
  assert.equal(validatePlan({
    actions: [{
      capability: 'habit.check', title: 'Tick the walk on Saturday',
      payload: { id: '11111111-1111-4111-8111-111111111111' },
    }],
    schemas, knownIds: known, today: '2026-09-01',
  })[0]?.code, 'date_not_supported');

  // An id nobody retrieved. The repair is a DIFFERENT action, not a better id.
  const invented = validatePlan({
    actions: [{
      capability: 'habit.check', title: 'Tick it',
      payload: { id: '99999999-9999-4999-8999-999999999999' },
    }],
    schemas, knownIds: known, today: '2026-09-01',
  })[0]!;
  assert.equal(invented.code, 'unknown_id');
  assert.match(invented.detail, /create capability instead|could not find it/,
    'the brief does not say what the honest second attempt is');

  /* A payload that does not fit the schema at all. Caught HERE, where the
     repair pass can hand the model one precise complaint, rather than
     downstream where it could only ever become a note. */
  const shapeless = validatePlan({
    actions: [{ capability: 'habit.check', title: 'Tick the walk', payload: {} }],
    schemas, knownIds: known, today: '2026-09-01',
  });
  assert.equal(shapeless.length, 1, 'one cause produced several findings');
  assert.equal(shapeless[0]!.code, 'payload_invalid');
  assert.equal(shapeless[0]!.repairable, true);
  assert.match(shapeless[0]!.detail, /no id was given/);
});

/* ══ 6. Modular capability registration ══════════════════════════════════ */

test('modularity: removing a module removes its capabilities everywhere', async () => {
  const without = MODULES.filter((m) => m.id !== 'habits');
  const { call } = await setup([{
    actions: [{
      capability: 'habit.check', title: 'Tick it',
      payload: { id: '11111111-1111-4111-8111-111111111111' },
    }],
  }], without);

  const caps = (await call('GET', '/ai/capabilities')).body;
  assert.ok(!caps.capabilities.some((c: any) => c.module === 'habits'),
    'a removed module still advertises capabilities');
  assert.ok(!caps.modules.some((m: any) => m.id === 'habits'));

  const r = await call('POST', '/ai/turn', { text: 'tick the walk' });
  assert.ok(!lastPlanInput.capabilities.some((c: any) => c.id.startsWith('habit.')),
    'the planner was offered a habit capability with no habits module');
  assert.equal(r.body.actions.length, 0, 'a removed capability became a proposal');
});

test('modularity: a read-only module keeps its reads and loses only its writes',
  async () => {
    /* The Calendar case, exactly: connected, but the grant cannot write. This
       used to switch the whole module off, and the assistant then said it
       could not SEE a calendar that was sitting in front of it. */
    const { call, db, ws } = await setup([{
      actions: [{
        capability: 'event.create', title: 'Client call',
        payload: {
          calendarId: '11111111-1111-4111-8111-111111111111',
          draft: { title: 'Client call', isAllDay: true, startDate: '2026-09-03' },
          requestId: 'assistant-req-1',
        },
      }],
    }]);
    await db.insert(calendarConnections).values({
      workspaceId: ws, provider: 'google', providerAccountId: 'acct-1',
      status: 'active', canWrite: false, scopesVersion: 1,
    });
    const [cal] = await db.insert(calendars).values({
      workspaceId: ws, providerCalendarId: 'primary', name: 'Work',
      accessRole: 'owner', isReadOnly: false,
    }).returning();
    await db.insert(calendarEvents).values({
      workspaceId: ws, calendarId: cal!.id, title: 'Trifusion review', isAllDay: false,
      startsAt: new Date('2026-09-03T09:00:00.000Z'), endsAt: new Date('2026-09-03T10:00:00.000Z'),
      syncState: 'synced',
    });

    const caps = (await call('GET', '/ai/capabilities')).body;
    assert.ok(caps.capabilities.some((c: any) => c.id === 'event.search'),
      'a read-only calendar lost the ability to be read');
    assert.ok(!caps.capabilities.some((c: any) => c.id === 'event.create'),
      'a calendar that cannot write still offered to write');
    assert.ok(caps.readOnly.some((m: any) => m.id === 'calendar'),
      'nothing says WHY the writes are missing');

    const r = await call('POST', '/ai/turn', { text: 'what is the Trifusion review about' });
    assert.ok(lastPlanInput.sources.some((s: any) => s.title === 'Trifusion review'),
      'the event could not be read');
    assert.ok(!lastPlanInput.capabilities.some((c: any) => c.id.startsWith('event.')),
      'the planner was offered a write it cannot do');
    assert.ok(lastPlanInput.readOnly.some((m: any) => m.id === 'calendar'),
      'the planner cannot tell "gone" from "cannot change"');

    // …and the write the model produced anyway is refused, with the real reason.
    assert.equal(r.body.actions.length, 0);
    assert.match(r.body.note, /can only read|permission/i);
  });

test('modularity: a new module registers and is usable with no central list edited',
  async () => {
    /* TEST C. The whole extension point is putting a module in the array; this
       one is built here, in a test file, and reaches the planner, the
       capability listing and the executor without touching anything else. */
    const bookmarked: string[] = [];
    const mockModule: AiModule = {
      id: 'weather',
      name: 'Weather',
      entities: [],
      rules: ['A forecast is a guess, and is never stored as a fact.'],
      available: () => ({ enabled: true }),
      capabilities: [{
        id: 'weather.note',
        module: 'weather',
        kind: 'mutate',
        label: 'Note the forecast',
        description: 'Write down what the forecast said.',
        input: z.object({ place: z.string().min(1).max(60) }).strict(),
        risk: 'confirm',
        async execute(_ctx, input: { place: string }) {
          bookmarked.push(input.place);
          return { status: 'done', ref: null, message: `Noted the forecast for ${input.place}.` };
        },
      }],
    };

    const { call } = await setup([{
      understood: 'Note the forecast',
      actions: [{ capability: 'weather.note', title: 'Forecast for Cape Town', payload: { place: 'Cape Town' } }],
    }], [...MODULES, mockModule]);

    const caps = (await call('GET', '/ai/capabilities')).body;
    assert.ok(caps.capabilities.some((c: any) => c.id === 'weather.note'),
      'a registered capability was not listed');
    assert.ok(caps.plannable.includes('weather.note'));

    const r = await call('POST', '/ai/turn', { text: 'note the forecast for Cape Town' });
    assert.equal(r.body.actions.length, 1);
    assert.equal(r.body.actions[0].module, 'weather');
    assert.ok(lastPlanInput.rules.some((x: any) => x.module === 'weather'),
      'the module’s own rules never reached the planner');

    const done = await call('POST', `/ai/turn/${r.body.turnId}/confirm`, {
      version: r.body.version, count: 1, importantAccepted: [],
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.done, 1);
    assert.deepEqual(bookmarked, ['Cape Town'], 'the capability never ran');
  });

test('modularity: the registry says WHY, not just no', async () => {
  const { assistant, ctx } = await setup([{}]);
  assert.deepEqual(await assistant.registry.explain(ctx, 'task.create'), { available: true });

  const gone = await assistant.registry.explain(ctx, 'nonsense.invented');
  assert.equal(gone.available, false);
  assert.match((gone as any).reason, /cannot do that/i);

  /* No Google account at all: not readable either, and the sentence says so
     rather than saying "capability unavailable". */
  const cal = await assistant.registry.explain(ctx, 'event.create');
  assert.equal(cal.available, false);
  assert.equal((cal as any).readable, false);
  assert.match((cal as any).reason, /Google Calendar/i);
});

/* ══ 7. Memory ═══════════════════════════════════════════════════════════ */

test('memory: a pinned belief is never quietly overturned', async () => {
  const { db, ws, userId, call } = await setup([{}]);
  const owner = { workspaceId: ws, userId };
  const pinned = await memory.create(db, owner, {
    category: 'preferences', fact: 'Prefers morning meetings',
    confidence: 1, source: 'user', isPinned: true,
  });

  /* The model notices the opposite. It is recognised as a CONTRADICTION and
     routed at the pinned memory, which is what makes accepting it refuse. */
  const out = await memory.proposeMemories(db, owner, [
    { category: 'preferences', fact: 'Prefers afternoon meetings', confidence: 0.7 },
  ] as any);
  assert.equal(out[0]!.outcome, 'conflict');

  const candidate = (await memory.listCandidates(db, owner))[0]!;
  assert.equal(candidate.supersedesId, pinned.id);
  await assert.rejects(
    () => memory.acceptCandidate(db, owner, candidate.id),
    /pinned/i,
    'a pinned memory was overwritten by something a model inferred',
  );
  const live = await memory.list(db, owner);
  assert.equal(live.length, 1);
  assert.equal(live[0]!.fact, 'Prefers morning meetings');

  /* Two facts about DIFFERENT people are not a contradiction, however alike
     they read. Treating them as one would quietly delete half of what is
     known, which is the opposite failure and a worse one. */
  await memory.create(db, owner, {
    category: 'people', fact: 'John Mercer is the client contact on WebAnchor',
    confidence: 1, source: 'user', isPinned: false,
  });
  const alongside = await memory.proposeMemories(db, owner, [{
    category: 'people', fact: 'Sarah Lowe is the client contact on WebAnchor', confidence: 0.8,
  }] as any);
  assert.equal(alongside[0]!.outcome, 'pending', 'a second colleague replaced the first');

  /* The user can still change their own mind - the block is on inference, not
     on the person. */
  await call('PATCH', `/ai/memory/${pinned.id}`, { isPinned: false });
  const now = await memory.acceptCandidate(db, owner, candidate.id);
  assert.equal(now.fact, 'Prefers afternoon meetings');
});

test('memory: the same observation twice does not become two suggestions', async () => {
  const { db, ws, userId } = await setup([{}]);
  const owner = { workspaceId: ws, userId };
  const fact = { category: 'routines' as const, fact: 'Goes to the gym before work', confidence: 0.6 };
  assert.equal((await memory.proposeMemories(db, owner, [fact] as any))[0]!.outcome, 'pending');
  assert.equal((await memory.proposeMemories(db, owner, [fact] as any))[0]!.outcome, 'queued');
  assert.equal((await memory.listCandidates(db, owner)).length, 1);
});

test('memory: only what is relevant is put in front of the model', () => {
  const known = [
    { category: 'preferences', fact: 'Prefers afternoon meetings', isPinned: false, confidence: 0.8 },
    { category: 'people', fact: 'John Mercer works on WebAnchor', isPinned: false, confidence: 0.9 },
    { category: 'people', fact: 'Sarah Lowe runs the Trifusion account', isPinned: false, confidence: 0.9 },
    { category: 'interests', fact: 'Collects vinyl records', isPinned: false, confidence: 0.9 },
    { category: 'other', fact: 'Pinned and always relevant', isPinned: true, confidence: 1 },
  ];
  const picked = rankMemories(known, 'when can I see John about WebAnchor', 10).map((m) => m.fact);
  assert.ok(picked.includes('John Mercer works on WebAnchor'), 'the relevant fact was dropped');
  assert.ok(picked.includes('Prefers afternoon meetings'),
    'a standing preference has to apply without being named');
  assert.ok(picked.includes('Pinned and always relevant'));
  assert.ok(!picked.includes('Collects vinyl records'),
    'an unrelated fact was sent anyway');
  assert.ok(!picked.includes('Sarah Lowe runs the Trifusion account'));
});

test('memory: housekeeping removes what it says and nothing else', async () => {
  const { db, ws, userId, call } = await setup([{}]);
  const owner = { workspaceId: ws, userId };
  const keep = await memory.create(db, owner, {
    category: 'other', fact: 'Something the user said years ago',
    confidence: 1, source: 'user', isPinned: true,
  });

  await memory.proposeMemories(db, owner, [
    { category: 'other', fact: 'A rejected guess', confidence: 0.5 },
    { category: 'other', fact: 'An ignored guess', confidence: 0.5 },
  ] as any);
  const [rejected, ignored] = await memory.listCandidates(db, owner);
  await memory.rejectCandidate(db, owner, rejected!.id);

  const turn = await call('POST', '/ai/turn', { text: 'Add milk' });
  const old = new Date(Date.now() - 200 * 86400000);
  await db.update(aiMemoryCandidates).set({ resolvedAt: old, createdAt: old })
    .where(eq(aiMemoryCandidates.workspaceId, ws));
  await db.update(aiTurns).set({ createdAt: old }).where(eq(aiTurns.workspaceId, ws));

  const swept = await memory.housekeeping(db, owner);
  assert.equal(swept.rejectedCandidates, 1);
  assert.equal(swept.staleCandidates, 1);
  /* The turn is still PROPOSED. However old, deleting it would silently
     discard something the user was in the middle of. */
  assert.equal(swept.turns, 0, 'an unconfirmed proposal was swept away');
  const [still] = await db.select().from(aiTurns).where(eq(aiTurns.id, turn.body.turnId));
  assert.ok(still, 'a pending proposal was deleted');
  void ignored;

  // Memory itself is never touched by retention.
  const live = await memory.list(db, owner);
  assert.equal(live.length, 1);
  assert.equal(live[0]!.id, keep.id);

  // Once it is finished, it goes.
  await db.update(aiTurns).set({ status: 'executed' }).where(eq(aiTurns.workspaceId, ws));
  assert.equal((await memory.housekeeping(db, owner)).turns, 1);
});

/* ══ 8. Calendar safety ══════════════════════════════════════════════════ */

test('calendar: a confirmed action carries the ledger handle and still executes', async () => {
  /* The bug this pins down: the executor validated the CONFIRMED payload
     against the capability's PLAN-time schema. After preview that payload is a
     requestId and nothing else, so a strict schema demanding a calendarId and
     a draft refused a payload that was exactly right - and every assistant
     calendar write failed after the user had agreed to it. */
  const cal = MODULES.find((m) => m.id === 'calendar')!;
  for (const id of ['event.create', 'event.update', 'event.delete']) {
    const capability = cal.capabilities.find((c) => c.id === id)!;
    const schema = executionSchema(capability);
    assert.notEqual(schema, capability.input, `${id} has no execution schema`);
    assert.equal(schema.safeParse({ requestId: 'assistant-req-1' }).success, true,
      `${id} would refuse the handle its own preview produced`);
    // And it still refuses anything else.
    assert.equal(schema.safeParse({ requestId: 'assistant-req-1', draft: {} }).success, false,
      `${id} accepts an unproposed draft at execution`);
  }

  /* Everything that does NOT preview is unchanged: one schema, both times. */
  const tasksModule = MODULES.find((m) => m.id === 'tasks')!;
  const create = tasksModule.capabilities.find((c) => c.id === 'task.create')!;
  assert.equal(executionSchema(create), create.input);
});

test('calendar: an event created for a task ends up linked to it, both ways', async () => {
  const google = stubGoogle();
  try {
  const { db, ws, call, assistant, ctx } = await setup([{}]);
  await db.insert(calendarConnections).values({
    workspaceId: ws, provider: 'google', providerAccountId: 'acct-1',
    accessTokenRef: encryptToken('access-token', GOOGLE_KEY),
    refreshTokenRef: encryptToken('refresh-token', GOOGLE_KEY),
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    status: 'active', canWrite: true, scopesVersion: 99,
  });
  const [cal] = await db.insert(calendars).values({
    workspaceId: ws, providerCalendarId: 'primary', name: 'Work',
    accessRole: 'owner', isReadOnly: false, isDefaultTarget: true,
  }).returning();
  const task = (await call('POST', '/tasks', { title: 'Write the handover note' })).body.task;

  const capability = assistant.registry.all().find((m) => m.id === 'calendar')!
    .capabilities.find((c) => c.id === 'event.create')!;

  const previewed = await capability.preview!(ctx, {
    calendarId: cal!.id,
    draft: {
      title: 'Handover note', isAllDay: false,
      startsAt: '2026-09-03T09:00:00.000Z', endsAt: '2026-09-03T10:00:00.000Z',
    },
    requestId: 'assistant-link-1',
    taskId: task.id,
  });
  /* The task travels with the handle so that execution can make the link, and
     it was checked before the user was asked. */
  assert.equal(previewed.carry?.['taskId'], task.id);
  await assert.rejects(() => capability.preview!(ctx, {
    calendarId: cal!.id,
    draft: { title: 'X', isAllDay: true, startDate: '2026-09-03' },
    requestId: 'assistant-link-2',
    taskId: '99999999-9999-4999-8999-999999999999',
  }), /no longer here/i, 'an invented task id survived to the calendar write');

  await capability.execute!(ctx, { requestId: 'assistant-link-1', taskId: task.id });

  const links = await db.select().from(itemLinks).where(and(
    eq(itemLinks.workspaceId, ws), eq(itemLinks.sourceId, task.id),
  ));
  assert.equal(links.length, 1, 'the event and the task are not linked');
  assert.equal(links[0]!.targetType, 'event');

  /* Both ways, through the same Related surface every screen uses. */
  const fromTask = await call('GET', `/links?type=task&id=${task.id}`);
  assert.equal(fromTask.status, 200);
  assert.ok(fromTask.body.links.some((l: any) => l.entity?.type === 'event'));
  const fromEvent = await call('GET', `/links?type=event&id=${links[0]!.targetId}`);
  assert.ok(fromEvent.body.links.some((l: any) => l.entity?.type === 'task'),
    'the event does not know about the task');

  /* And it went to Google through the ledger, once. */
  assert.equal(google.calls.filter((c) => c.method === 'POST'
    && /\/events(\?|$)/.test(c.url)).length, 1);
  } finally { google.restore(); }
});

test('the model is told the surface renders text literally', async () => {
  /* The panel and the phone render an answer as plain text, so `**Urgent**`
     arrives on screen as asterisks. Telling the model not to emit markdown is
     the whole fix; adding a renderer would be a different product decision
     made by accident. */
  const src = readFileSync(join('src', 'ai', 'providers', 'anthropic.ts'), 'utf8');
  assert.match(src, /PLAIN TEXT ONLY/);
  assert.match(src, /renders what you write literally/);

  /* And nothing on either surface parses it, which is what makes the rule
     necessary rather than merely tidy. Comments are stripped first: the word
     "marked" appears in one, describing a card that cannot run. */
  const CODE = /\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm;
  for (const file of ['assistant-panel.js', 'assistant.js', 'assistant-cards.js']) {
    const web = readFileSync(join('..', 'web', file), 'utf8').replace(CODE, ' ');
    assert.ok(!/marked\(|markdown|remark|DOMPurify/i.test(web),
      `${file} parses markdown, so the rule is wrong rather than the renderer`);
  }
});

test('operations: /health/version says whether a model is configured here', async () => {
  /* The only way to find out whether an environment had an API key was to
     sign in and ask the assistant, and the answer to "why is it not working"
     was a shrug. A boolean and the job names - no key, no vendor, no model id,
     because this endpoint is public and unauthenticated. */
  const { app } = await setup([{}]);
  const r = (await app.inject({ method: 'GET', url: '/health/version' })).json();
  assert.equal(typeof r.assistant.configured, 'boolean');
  assert.equal(r.assistant.configured, true, 'a stub planner is configured and unreported');
  assert.equal(r.assistant.jobs.plan, true);

  const body = JSON.stringify(r);
  for (const secret of ['api-key', 'x-api-key', 'sk-ant', 'anthropic.com', 'ANTHROPIC']) {
    assert.ok(!body.includes(secret), `${secret} reached a public endpoint`);
  }
});

/* ══ 9. Performance shape ════════════════════════════════════════════════ */

test('performance: the obvious command costs one round of work, not a chain', async () => {
  const { call, db, ws } = await setup([{ actions: [] }]);
  /* Enough rows that a full retrieval pass would be visible against a fast
     one. The claim is not a millisecond count - that varies with the machine -
     but that the cheap route did no retrieval and no planning at all. */
  await db.insert(tasks).values(Array.from({ length: 40 }, (_, i) => ({
    workspaceId: ws, title: `Task number ${i}`, bucket: 'today' as const,
  })));

  const fast = await call('POST', '/ai/turn', { text: 'Add milk' });
  assert.equal(fast.body.metrics.route, 'fast');
  assert.equal(fast.body.metrics.retrieved, undefined, 'the fast path retrieved anyway');
  assert.equal(planCalls, 0);

  const slow = await call('POST', '/ai/turn', { text: 'what is happening with task number 12' });
  assert.equal(slow.body.metrics.route, 'planner');
  assert.ok((slow.body.metrics.retrieved ?? 0) > 0);
  assert.ok(slow.body.metrics.queries > 1, 'only one query was searched for');
});

test('performance: availability is asked once per request, not once per question', async () => {
  const { db, ws, userId } = await setup([{}]);
  let asked = 0;
  const counted: AiModule = {
    id: 'counted', name: 'Counted', entities: [], rules: [],
    available: () => { asked += 1; return { enabled: true }; },
    capabilities: [{
      id: 'counted.read', module: 'counted', kind: 'read', label: 'Read',
      description: 'x', input: z.object({}).strict(), risk: 'safe',
      async run() { return []; },
    }],
  };
  const registry = new CapabilityRegistry([counted]);
  const ctx = forRequest(db, {
    workspaceId: ws, userId, today: '2026-09-01', timeZone: null, surface: null,
  });
  await registry.status(ctx);
  await registry.capabilities(ctx);
  await registry.describe(ctx);
  await registry.resolve(ctx, 'counted.read');
  assert.equal(asked, 1, 'every question re-asked the module whether it exists');

  // A fresh request asks again — availability is never cached beyond the turn.
  await registry.status(forRequest(db, {
    workspaceId: ws, userId, today: '2026-09-02', timeZone: null, surface: null,
  }));
  assert.equal(asked, 2);
  void sql;
});
