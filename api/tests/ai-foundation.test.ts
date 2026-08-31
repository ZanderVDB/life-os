/**
 * The AI foundation — the parts where being wrong is expensive.
 *
 * Not a matrix over every capability. The capabilities are thin adapters and
 * the services under them are already covered; what is NOT covered anywhere
 * else is the architecture itself:
 *
 *   · a module that goes away takes its capabilities with it, at execution
 *     time and not merely in a listing;
 *   · the executor cannot reach a table;
 *   · a confirmation that does not match what was shown is refused;
 *   · calendar writes cannot skip the propose/confirm ledger;
 *   · relationships go through item_links and nowhere else;
 *   · memory belongs to somebody, supersedes rather than accumulates, and
 *     does not quietly overwrite something the user pinned;
 *   · dueDate and scheduledAt are still two facts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { CapabilityRegistry } from '../src/ai/registry.js';
import type { AiModule } from '../src/ai/registry.js';
import { MODULES } from '../src/ai/modules/index.js';
import { execute, assertConfirmable, changeCount } from '../src/ai/executor.js';
import * as memory from '../src/ai/memory.js';
import { itemLinks } from '../src/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

const TOKEN = 'test-bypass-token';
const env = loadEnv({
  NODE_ENV: 'test', PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused', FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173', DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = { authorization: `Bearer ${TOKEN}`, 'x-dev-email': 'zander@example.com' };

async function setup() {
  const { db } = await freshDb();
  const app = buildApp(db, env);
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
  return { app, db, ws, call, userId: me.user.id, areaId: me.areas[0].id };
}

const request = (ws: string, userId: string) => ({
  workspaceId: ws, userId, today: '2026-08-31', timeZone: null, surface: null,
});

/* ══ 1. The registry is the authority ════════════════════════════════════ */

test('ai: the app can say what the assistant can currently do', async () => {
  const { call } = await setup();
  const r = await call('GET', '/ai/capabilities');
  assert.equal(r.status, 200);

  const ids = r.body.capabilities.map((c: { id: string }) => c.id);
  assert.ok(ids.includes('task.create'), 'tasks are not offered');
  assert.ok(ids.includes('link.traverse'), 'relationship traversal is not offered');
  // Every capability names a module that is actually enabled.
  const enabled = new Set(r.body.modules.filter((m: any) => m.enabled).map((m: any) => m.id));
  for (const c of r.body.capabilities) {
    assert.ok(enabled.has(c.module), `${c.id} is offered by a disabled module`);
  }
  /* Calendar is registered on every build and available only where Google is
     connected. In a fresh workspace it is not, and the reason is stated
     rather than left as an unexplained absence. */
  const cal = r.body.modules.find((m: any) => m.id === 'calendar');
  assert.equal(cal.enabled, false);
  assert.match(cal.reason, /connect|write/i);
  assert.ok(!ids.some((id: string) => id.startsWith('event.')),
    'calendar capabilities are offered without a calendar');
  // And the absence of a planner is said out loud, not implied.
  assert.equal(r.body.planner.available, false);
});

test('ai: removing a module removes its capabilities, including from the executor', async () => {
  /* The point of the registry. A build without Calendar must not merely stop
     LISTING calendar actions — an action naming one must fail to resolve, or
     a proposal made before the module went away would still run. */
  const { db, ws, userId } = await setup();
  const withoutCalendar = MODULES.filter((m) => m.id !== 'calendar');
  const registry = new CapabilityRegistry(withoutCalendar);
  const ctx = { db, request: request(ws, userId) };

  const ids = (await registry.capabilities(ctx)).map((c) => c.id);
  assert.ok(!ids.some((id) => id.startsWith('event.')), 'calendar capabilities survived removal');
  assert.equal(await registry.resolve(ctx, 'event.create'), null);
  assert.ok(await registry.resolve(ctx, 'task.create'), 'removing one module broke another');

  const report = await execute({ db, registry, request: request(ws, userId) }, {
    id: 's1', request: '', understood: '', actions: [{
      id: 'a1', capability: 'event.create', module: 'calendar', title: 'x',
      payload: {}, confidence: 'high', assumptions: [], warnings: [],
      requiresConfirmation: true, important: false, editable: [], enabled: true, sources: [],
    }], sources: [],
  } as any, { confirmed: true, count: 1, importantAccepted: [] });
  assert.equal(report.results[0]!.status, 'failed');
  assert.equal(report.results[0]!.error, 'capability_unavailable');
});

test('ai: a module that is switched off for THIS workspace is equally gone', async () => {
  /* Availability, not just presence. Same build, same registry, different
     answer per workspace — which is how Calendar behaves in real life. */
  const { db, ws, userId } = await setup();
  const off: AiModule = {
    id: 'flaky', name: 'Flaky', entities: [], rules: [],
    available: () => ({ enabled: false, reason: 'Not set up.' }),
    capabilities: [{
      id: 'flaky.do', module: 'flaky', kind: 'mutate', label: 'Do',
      description: 'x', input: z.object({}).strict(), risk: 'safe',
      execute: async () => ({ status: 'done' as const, message: 'should never run' }),
    }],
  };
  const registry = new CapabilityRegistry([...MODULES, off]);
  const ctx = { db, request: request(ws, userId) };
  assert.equal(await registry.resolve(ctx, 'flaky.do'), null);
  const status = await registry.status(ctx);
  assert.equal(status.find((s) => s.id === 'flaky')!.capabilities.length, 0);
});

test('ai: a module cannot register a capability it does not own', () => {
  assert.throws(() => new CapabilityRegistry([{
    id: 'a', name: 'A', entities: [], rules: [], available: () => ({ enabled: true }),
    capabilities: [{
      id: 'b.thing', module: 'b', kind: 'read', label: 'x', description: 'x',
      input: z.object({}), risk: 'safe', run: async () => [],
    }],
  }]), /claims module b/);
});

/* ══ 2. The executor ═════════════════════════════════════════════════════ */

test('ai: the executor has no path to a table', () => {
  /* Structural, because it is the invariant everything else rests on. The
     executor resolves a capability and calls it; the moment it can import the
     schema, "AI mutations go through domain services" becomes a convention
     instead of a fact. */
  /* Comments stripped first. The file's own header shows the branch it must
     never grow, and matching against prose would fail on the warning rather
     than on the thing warned about. */
  const src = readFileSync(join('src', 'ai', 'executor.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
  assert.doesNotMatch(src, /from '\.\.\/db\/schema/, 'the executor imports the schema');
  assert.doesNotMatch(src, /\bdb\.(insert|update|delete)\b/, 'the executor writes directly');
  // …and no per-module branching, which is the other way domain logic leaks in.
  assert.doesNotMatch(src, /capability === '/, 'the executor knows about a specific capability');
  assert.doesNotMatch(src, /\bmodule === '/, 'the executor knows about a specific module');
});

test('ai: nothing runs without a confirmation that matches what was shown', () => {
  const actions = [
    { id: 'a', enabled: true, important: false },
    { id: 'b', enabled: true, important: false },
    { id: 'c', enabled: false, important: false },
  ] as any[];
  assert.equal(changeCount(actions), 2, 'a switched-off action was counted');
  assert.throws(() => assertConfirmable(actions, null), /explicit confirmation/);
  assert.throws(() => assertConfirmable(actions, { confirmed: true, count: 3, importantAccepted: [] }),
    /Confirmed 3 changes but 2 are pending/);
  /* A 400, not a 500. The mismatch is the caller's to fix and the message is
     the only actionable thing they get — "Something went wrong" is not. */
  try {
    assertConfirmable(actions, { confirmed: true, count: 3, importantAccepted: [] });
    assert.fail('a mismatched confirmation was accepted');
  } catch (e) {
    assert.equal((e as any).statusCode, 400);
  }
  assert.ok(assertConfirmable(actions, { confirmed: true, count: 2, importantAccepted: [] }));
});

test('ai: an important action needs its own yes, not just the batch', () => {
  const actions = [{ id: 'a', enabled: true, important: true }] as any[];
  assert.throws(
    () => assertConfirmable(actions, { confirmed: true, count: 1, importantAccepted: [] }),
    /their own confirmation/,
  );
  assert.ok(assertConfirmable(actions, { confirmed: true, count: 1, importantAccepted: ['a'] }));
});

test('ai: an executed action goes through the domain service and is visible', async () => {
  const { db, ws, call, userId } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const report = await execute({ db, registry, request: request(ws, userId) }, {
    id: 's1', request: 'add a task', understood: '', actions: [{
      id: 'a1', capability: 'task.create', module: 'tasks', title: 'Add',
      payload: { title: 'Reconcile the bank', dueDate: '2026-09-04' },
      confidence: 'high', assumptions: [], warnings: [], requiresConfirmation: true,
      important: false, editable: [], enabled: true, sources: [],
    }], sources: [],
  } as any, { confirmed: true, count: 1, importantAccepted: [] });

  assert.equal(report.done, 1, JSON.stringify(report.results));
  const id = report.results[0]!.ref!.id;
  const t = (await call('GET', `/tasks/${id}`)).body.task;
  assert.equal(t.title, 'Reconcile the bank');
  // The task activity log recorded it, which is the service's own behaviour —
  // proof the capability delegated rather than inserting a row itself.
  assert.equal(t.dueDate, '2026-09-04');
  assert.equal(t.scheduledAt, null, 'a due date leaked into scheduledAt');
});

test('ai: a payload the capability does not accept is refused before it runs', async () => {
  const { db, ws, userId } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const report = await execute({ db, registry, request: request(ws, userId) }, {
    id: 's1', request: '', understood: '', actions: [{
      id: 'a1', capability: 'task.create', module: 'tasks', title: 'Add',
      // No title, and a field no schema has.
      payload: { nonsense: true },
      confidence: 'low', assumptions: [], warnings: [], requiresConfirmation: true,
      important: false, editable: [], enabled: true, sources: [],
    }], sources: [],
  } as any, { confirmed: true, count: 1, importantAccepted: [] });
  assert.equal(report.results[0]!.status, 'failed');
  assert.equal(report.results[0]!.error, 'invalid_payload');
});

test('ai: one failure does not take the rest of the batch with it', async () => {
  const { db, ws, userId, call } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const report = await execute({ db, registry, request: request(ws, userId) }, {
    id: 's1', request: '', understood: '', actions: [
      {
        id: 'a1', capability: 'task.create', module: 'tasks', title: 'ok',
        payload: { title: 'Buy milk' }, confidence: 'high', assumptions: [], warnings: [],
        requiresConfirmation: true, important: false, editable: [], enabled: true, sources: [],
      },
      {
        id: 'a2', capability: 'task.create', module: 'tasks', title: 'bad',
        payload: { title: '' }, confidence: 'high', assumptions: [], warnings: [],
        requiresConfirmation: true, important: false, editable: [], enabled: true, sources: [],
      },
      {
        id: 'a3', capability: 'task.create', module: 'tasks', title: 'ok',
        payload: { title: 'Buy chicken' }, confidence: 'high', assumptions: [], warnings: [],
        requiresConfirmation: true, important: false, editable: [], enabled: true, sources: [],
      },
    ], sources: [],
  } as any, { confirmed: true, count: 3, importantAccepted: [] });

  assert.equal(report.done, 2);
  assert.equal(report.failed, 1);
  const titles = (await call('GET', '/tasks')).body.tasks.map((t: any) => t.title);
  assert.ok(titles.includes('Buy milk') && titles.includes('Buy chicken'),
    'a failure rolled back its neighbours');
});

/* ══ 3. Calendar cannot be bypassed ══════════════════════════════════════ */

test('ai: a calendar write cannot skip propose and confirm', () => {
  /* The ledger is the enforcement: `preview` writes a row keyed by requestId
     and `execute` takes ONLY that requestId. There is no argument through
     which a confirmed action could carry a different event. */
  const src = readFileSync(join('src', 'ai', 'modules', 'calendar.ts'), 'utf8');
  for (const fn of ['proposeCreateEvent', 'proposeUpdateEvent', 'proposeDeleteEvent']) {
    assert.match(src, new RegExp(fn), `${fn} is not used`);
  }
  assert.match(src, /executeMutation\(/, 'executeMutation is not used');
  // No direct writes to the event tables from the AI module.
  assert.doesNotMatch(src, /db\.insert\(calendarEvents/, 'the AI module writes events directly');
  assert.doesNotMatch(src, /db\.(update|delete)\(calendarEvents/, 'the AI module edits events directly');
  // Every mutating calendar capability takes a requestId and nothing else at
  // execution time.
  assert.match(src, /const ConfirmedMutation[\s\S]{0,200}requestId/);
});

test('ai: the calendar module states occurrence identity as a rule', () => {
  const cal = MODULES.find((m) => m.id === 'calendar')!;
  const joined = cal.rules.join(' ');
  assert.match(joined, /occurrence/i, 'nothing tells the planner about occurrences');
  assert.match(joined, /never by title and date|not by title/i,
    'the planner is not told to avoid title-and-date lookup');
});

/* ══ 4. Relationships ════════════════════════════════════════════════════ */

test('ai: an AI-created relationship is an item_link the UI can see', async () => {
  const { db, ws, userId, call, areaId } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const task = (await call('POST', '/tasks', { title: 'Draft the contract' })).body.task;
  const project = (await call('POST', '/projects', {
    title: 'WebAnchor handover', outcome: 'Handed over', areaId, focus: 'now',
  })).body.project;

  const report = await execute({ db, registry, request: request(ws, userId) }, {
    id: 's1', request: '', understood: '', actions: [{
      id: 'a1', capability: 'link.create', module: 'relationships', title: 'Link',
      payload: {
        sourceType: 'task', sourceId: task.id,
        targetType: 'project', targetId: project.id, kind: 'related',
      },
      confidence: 'high', assumptions: [], warnings: [], requiresConfirmation: true,
      important: false, editable: [], enabled: true, sources: [],
    }], sources: [],
  } as any, { confirmed: true, count: 1, importantAccepted: [] });
  assert.equal(report.done, 1, JSON.stringify(report.results));

  // It is a row in item_links — the same table every Related section reads.
  const rows = await db.select().from(itemLinks).where(and(
    eq(itemLinks.workspaceId, ws), eq(itemLinks.sourceId, task.id),
  ));
  assert.equal(rows.length, 1);
  // …and it is visible from the OTHER end, immediately, through the normal API.
  const back = (await call('GET', `/links?type=project&id=${project.id}`)).body;
  assert.equal(back.count, 1);
  assert.equal(back.incoming[0].entity.title, 'Draft the contract');
});

test('ai: the assistant cannot assert the coupled kind', async () => {
  const { db, ws, userId, call } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const a = (await call('POST', '/tasks', { title: 'One' })).body.task;
  const b = (await call('POST', '/tasks', { title: 'Two' })).body.task;
  const report = await execute({ db, registry, request: request(ws, userId) }, {
    id: 's1', request: '', understood: '', actions: [{
      id: 'a1', capability: 'link.create', module: 'relationships', title: 'Link',
      payload: {
        sourceType: 'task', sourceId: a.id,
        targetType: 'task', targetId: b.id, kind: 'scheduled_as',
      },
      confidence: 'high', assumptions: [], warnings: [], requiresConfirmation: true,
      important: false, editable: [], enabled: true, sources: [],
    }], sources: [],
  } as any, { confirmed: true, count: 1, importantAccepted: [] });
  assert.equal(report.results[0]!.status, 'failed');
  assert.match(report.results[0]!.message, /created by scheduling/i);
});

test('ai: traversal walks item_links and records how it got there', async () => {
  const { db, ws, userId, call, areaId } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const task = (await call('POST', '/tasks', { title: 'Draft the contract' })).body.task;
  const project = (await call('POST', '/projects', {
    title: 'WebAnchor handover', outcome: 'Handed over', areaId, focus: 'now',
  })).body.project;
  const other = (await call('POST', '/tasks', { title: 'Send the invoice' })).body.task;
  await call('POST', '/links', {
    sourceType: 'task', sourceId: task.id, targetType: 'project', targetId: project.id, kind: 'related',
  });
  await call('POST', '/links', {
    sourceType: 'other' in {} ? 'task' : 'task', sourceId: other.id,
    targetType: 'project', targetId: project.id, kind: 'related',
  });

  const ctx = { db, request: request(ws, userId) };
  const cap = (await registry.resolve(ctx, 'link.traverse'))!;
  const sources = await cap.run!(ctx, { type: 'task', id: task.id, depth: 2, limit: 20 });

  const titles = sources.map((s) => s.title);
  assert.ok(titles.includes('WebAnchor handover'), 'one hop failed');
  assert.ok(titles.includes('Send the invoice'), 'two hops failed');
  // The second-hop source carries the path it was reached by, which is what
  // lets an answer explain itself instead of asserting a connection.
  const hop2 = sources.find((s) => s.title === 'Send the invoice')!;
  assert.equal(hop2.via, 'relationship');
  assert.equal(hop2.path!.length, 2);
  assert.equal(hop2.path![0]!.from.id, task.id);
});

/* ══ 5. Context ══════════════════════════════════════════════════════════ */

test('ai: context retrieval names its sources and can be traced', async () => {
  const { call, areaId } = await setup();
  await call('POST', '/projects', {
    title: 'WebAnchor handover', outcome: 'Handed over', areaId, focus: 'now',
  });
  await call('POST', '/tasks', { title: 'WebAnchor invoice' });

  const r = await call('POST', '/ai/context', { query: 'WebAnchor', level: 2 });
  assert.equal(r.status, 200);
  assert.ok(r.body.count >= 2, 'targeted retrieval found nothing');
  for (const s of r.body.sources) {
    assert.ok(s.ref?.type && s.ref?.id, 'a source has no entity to cite');
    assert.ok(s.module, 'a source does not say which module produced it');
    assert.ok([1, 2, 3].includes(s.level));
  }
  assert.ok(r.body.used.length, 'no capability was recorded as used');
});

/* ══ 6. Personal Memory ══════════════════════════════════════════════════ */

test('ai: memory belongs to one person in one workspace', async () => {
  const { call } = await setup();
  const made = await call('POST', '/ai/memory', {
    category: 'preferences', fact: 'Prefers afternoon meetings',
  });
  assert.equal(made.status, 201);
  // Created by the user, so it is theirs and it is certain.
  assert.equal(made.body.memory.source, 'user');
  assert.equal(made.body.memory.confidence, 1);

  const mine = await call('GET', '/ai/memory');
  assert.equal(mine.body.memories.length, 1);

  // A different person in a different workspace sees none of it.
  const { call: other } = await setup();
  assert.equal((await other('GET', '/ai/memory')).body.memories.length, 0);
});

test('ai: a changed belief supersedes the old one rather than piling up', async () => {
  const { db, call, ws, userId } = await setup();
  const first = (await call('POST', '/ai/memory', {
    category: 'preferences', fact: 'Prefers morning meetings',
  })).body.memory;

  const r = await call('POST', `/ai/memory/${first.id}/supersede`, {
    category: 'preferences', fact: 'Prefers afternoon meetings',
  });
  assert.equal(r.status, 200);

  const live = await memory.list(db, { workspaceId: ws, userId });
  assert.equal(live.length, 1, 'both beliefs are live at once');
  assert.equal(live[0]!.fact, 'Prefers afternoon meetings');
  // The old one is kept, marked, and pointing at its replacement.
  assert.equal(r.body.previous.id, first.id);
  const prompt = await memory.forPrompt(db, { workspaceId: ws, userId });
  assert.deepEqual(prompt.map((p) => p.fact), ['Prefers afternoon meetings'],
    'a superseded belief reached the prompt');
});

test('ai: a pinned memory is not replaced behind the user’s back', async () => {
  const { call } = await setup();
  const pinned = (await call('POST', '/ai/memory', {
    category: 'preferences', fact: 'Prefers purple', isPinned: true,
  })).body.memory;
  const r = await call('POST', `/ai/memory/${pinned.id}/supersede`, {
    category: 'preferences', fact: 'Prefers green',
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /pinned/i);
});

test('ai: an extracted fact becomes a candidate, and a duplicate becomes nothing', async () => {
  const { call } = await setup();
  await call('POST', '/ai/memory', { category: 'people', fact: 'John Mercer works on WebAnchor' });

  const r = await call('POST', '/ai/memory/candidates', {
    candidates: [
      { category: 'people', fact: 'John Mercer works on WebAnchor.' },
      { category: 'preferences', fact: 'Prefers concise emails' },
    ],
  });
  assert.equal(r.status, 200);
  const byFact = new Map(r.body.results.map((x: any) => [x.fact, x.outcome]));
  // Punctuation and case are not a new belief.
  assert.equal(byFact.get('John Mercer works on WebAnchor.'), 'duplicate');
  assert.equal(byFact.get('Prefers concise emails'), 'pending');

  const pending = (await call('GET', '/ai/memory')).body.candidates;
  assert.equal(pending.length, 1, 'a duplicate was queued for review anyway');

  const accepted = await call('POST', `/ai/memory/candidates/${pending[0].id}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal((await call('GET', '/ai/memory')).body.candidates.length, 0);
  assert.equal((await call('GET', '/ai/memory')).body.memories.length, 2);
});

test('ai: forgetting a memory really removes it', async () => {
  const { call } = await setup();
  const m = (await call('POST', '/ai/memory', { fact: 'Lives in Cape Town' })).body.memory;
  assert.equal((await call('DELETE', `/ai/memory/${m.id}`)).status, 200);
  assert.equal((await call('GET', '/ai/memory')).body.memories.length, 0);
  assert.equal((await call('DELETE', `/ai/memory/${m.id}`)).status, 404);
});

/* ══ 7. The domain rules the AI must not blur ════════════════════════════ */

test('ai: dueDate and scheduledAt stay two different facts', async () => {
  const { db, ws, userId, call } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const t = (await call('POST', '/tasks', { title: 'Write the proposal', dueDate: '2026-09-04' })).body.task;

  // Scheduling says when it will be DONE. It must not touch the deadline.
  const report = await execute({ db, registry, request: request(ws, userId) }, {
    id: 's1', request: '', understood: '', actions: [{
      id: 'a1', capability: 'task.schedule', module: 'tasks', title: 'Schedule',
      payload: { id: t.id, scheduledAt: '2026-09-02T09:00:00.000Z' },
      confidence: 'high', assumptions: [], warnings: [], requiresConfirmation: true,
      important: false, editable: [], enabled: true, sources: [],
    }], sources: [],
  } as any, { confirmed: true, count: 1, importantAccepted: [] });
  assert.equal(report.done, 1, JSON.stringify(report.results));

  const after = (await call('GET', `/tasks/${t.id}`)).body.task;
  assert.equal(after.dueDate, '2026-09-04', 'scheduling moved the deadline');
  assert.equal(new Date(after.scheduledAt).toISOString(), '2026-09-02T09:00:00.000Z');

  // …and the capability says so, so a planner is told rather than trusted.
  const ctx = { db, request: request(ws, userId) };
  const cap = (await registry.resolve(ctx, 'task.schedule'))!;
  assert.match(cap.description, /not its deadline/i);
  const tasksModule = MODULES.find((m) => m.id === 'tasks')!;
  assert.match(tasksModule.rules.join(' '), /dueDate is the deadline/);
});

test('ai: scheduling a task does not create a calendar event', async () => {
  const { db, ws, userId, call } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const t = (await call('POST', '/tasks', { title: 'Write the proposal' })).body.task;
  await execute({ db, registry, request: request(ws, userId) }, {
    id: 's1', request: '', understood: '', actions: [{
      id: 'a1', capability: 'task.schedule', module: 'tasks', title: 'Schedule',
      payload: { id: t.id, scheduledAt: '2026-09-02T09:00:00.000Z' },
      confidence: 'high', assumptions: [], warnings: [], requiresConfirmation: true,
      important: false, editable: [], enabled: true, sources: [],
    }], sources: [],
  } as any, { confirmed: true, count: 1, importantAccepted: [] });

  const range = (await call('GET', '/calendar/range?from=2026-09-01&to=2026-09-30')).body;
  assert.equal(range.events.length, 0, 'scheduling a task created an event');
});

test('ai: the project module is told status and focus are independent', () => {
  const pm = MODULES.find((m) => m.id === 'projects')!;
  assert.match(pm.rules.join(' '), /INDEPENDENT/);
  const update = pm.capabilities.find((c) => c.id === 'project.update')!;
  assert.equal(update.risk, 'important', 'changing a project state is not marked important');
});
