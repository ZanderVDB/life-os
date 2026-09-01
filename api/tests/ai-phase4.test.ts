/**
 * Phase 4 — operating the whole of Life OS.
 *
 * The dangerous parts only. What is new and expensive to get wrong:
 *
 *   · an action that needs another's id runs after it, with the real id;
 *   · a dependent whose dependency failed is SKIPPED, never attempted, and
 *     never reported as done;
 *   · a relationship is one `item_links` row and duplicates no entity;
 *   · removing a link removes the edge and neither end;
 *   · the entity resolver picks the obvious one and refuses to guess between
 *     two equally good ones;
 *   · a module switched off takes its capabilities with it, and a module
 *     registered normally works with no central list edited.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { CapabilityRegistry, forRequest } from '../src/ai/registry.js';
import { MODULES } from '../src/ai/modules/index.js';
import { execute } from '../src/ai/executor.js';
import { planOrder, placeholdersIn, substitute, probe, unprobe } from '../src/ai/depends.js';
import {
  itemLinks, tasks, bookPages, aiConversations, aiTurns,
} from '../src/db/schema.js';
import { resolveEntity } from '../src/ai/resolve.js';
import {
  recentReferences, referenceCue, forPrompt as referencesForPrompt,
} from '../src/ai/references.js';
import { z } from 'zod';
import { ProviderRouter, deterministicProvider } from '../src/ai/provider.js';
import type { AiProvider } from '../src/ai/provider.js';
import { and, eq } from 'drizzle-orm';

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
  workspaceId: ws, userId, today: '2026-09-01', timeZone: null, surface: null,
});

const action = (over: Record<string, unknown>) => ({
  id: 'a1', capability: 'task.create', module: 'tasks', title: 'x',
  payload: {}, confidence: 'high', assumptions: [], warnings: [],
  requiresConfirmation: true, important: false, editable: [], enabled: true,
  sources: [], ...over,
});

const run = (deps: any, actions: unknown[], important: string[] = []) => execute(deps, {
  id: 's1', request: '', understood: '', actions, sources: [],
} as any, {
  confirmed: true,
  count: actions.filter((a: any) => a.enabled).length,
  importantAccepted: important,
});

/* ══ The graph itself ════════════════════════════════════════════════════ */

test('phase4: a dependency is READ from the payload, never declared', () => {
  const found = placeholdersIn({ projectId: '{{a1.id}}', title: 'see {{a2.id}} too' });
  assert.deepEqual([...found].sort(), ['a1', 'a2']);
  /* No placeholder, no dependency. An action cannot claim one it has not got. */
  assert.equal(placeholdersIn({ title: 'a1 is a fine title' }).size, 0);
});

test('phase4: order puts a dependency before its dependent', () => {
  const { order, problems } = planOrder([
    action({ id: 'a1', payload: { sourceId: '{{a2.id}}' } }),
    action({ id: 'a2', payload: { title: 'first' } }),
  ] as any);
  assert.deepEqual(problems, []);
  assert.deepEqual(order.map((a) => a.id), ['a2', 'a1']);
});

test('phase4: a loop and a dangling reference are refused, not guessed at', () => {
  const loop = planOrder([
    action({ id: 'a1', payload: { x: '{{a2.id}}' } }),
    action({ id: 'a2', payload: { x: '{{a1.id}}' } }),
  ] as any);
  assert.ok(loop.problems.some((p) => p.code === 'cycle'), JSON.stringify(loop.problems));

  const dangling = planOrder([action({ id: 'a1', payload: { x: '{{a9.id}}' } })] as any);
  assert.equal(dangling.problems[0]!.code, 'unknown_ref');

  const self = planOrder([action({ id: 'a1', payload: { x: '{{a1.id}}' } })] as any);
  assert.ok(self.problems.some((p) => p.code === 'self_ref'));
});

test('phase4: a probe validates without ever being stored', () => {
  const original = { projectId: '{{a1.id}}', note: 'about {{a2.id}}' };
  const p = probe(original);
  /* Well-formed enough for a uuid schema, and DISTINCT per action. */
  assert.match(p['projectId'] as string, /^[0-9a-f-]{36}$/);
  assert.notEqual(p['projectId'], (p['note'] as string).split('about ')[1]);
  /* And it round-trips exactly. */
  assert.deepEqual(unprobe(p, original), original);
});

test('phase4: substitution puts a real id in, and reports what is missing', () => {
  const produced = new Map([['a1', { type: 'task' as const, id: 'ID-1' }]]);
  const ok = substitute({ projectId: '{{a1.id}}' }, produced);
  assert.equal(ok.payload['projectId'], 'ID-1');
  assert.deepEqual(ok.missing, []);

  const bad = substitute({ projectId: '{{a7.id}}' }, produced);
  assert.deepEqual(bad.missing, ['a7']);
  /* Left as written. Nothing may execute a payload in this state. */
  assert.equal(bad.payload['projectId'], '{{a7.id}}');
});

/* ══ Through the executor, against a real database ═══════════════════════ */

test('phase4: a created task is what the next action links to', async () => {
  const { db, ws, userId, call, areaId } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const project = (await call('POST', '/projects', {
    title: 'Office move', outcome: 'Moved', areaId, focus: 'now',
  })).body.project;

  const report = await run({ db, registry, request: request(ws, userId) }, [
    action({ id: 'a1', capability: 'task.create', payload: { title: 'Get moving quotes' } }),
    action({
      id: 'a2', capability: 'link.create', module: 'relationships', title: 'Link',
      payload: {
        kind: 'related',
        sourceType: 'task', sourceId: '{{a1.id}}',
        targetType: 'project', targetId: project.id,
      },
    }),
  ]);

  assert.equal(report.done, 2, JSON.stringify(report.results));
  const taskId = report.results[0]!.ref!.id;
  const [edge] = await db.select().from(itemLinks)
    .where(and(eq(itemLinks.workspaceId, ws), eq(itemLinks.sourceId, taskId)));
  assert.ok(edge, 'the link points at the task that was actually created');
  assert.equal(edge.targetId, project.id);
  /* One edge, and no duplicate of either end. */
  const rows = await db.select().from(tasks).where(eq(tasks.workspaceId, ws));
  assert.equal(rows.length, 1);
});

test('phase4: a dependent is skipped when its dependency fails, not attempted', async () => {
  const { db, ws, userId } = await setup();
  const registry = new CapabilityRegistry(MODULES);

  const report = await run({ db, registry, request: request(ws, userId) }, [
    /* Invalid: no title. This one fails. */
    action({ id: 'a1', capability: 'task.create', payload: { nonsense: true } }),
    action({
      id: 'a2', capability: 'link.create', module: 'relationships', title: 'Link',
      payload: {
        kind: 'related',
        sourceType: 'task', sourceId: '{{a1.id}}',
        targetType: 'task', targetId: '{{a1.id}}',
      },
    }),
  ]);

  assert.equal(report.results[0]!.status, 'failed');
  assert.equal(report.results[1]!.status, 'skipped');
  assert.equal(report.results[1]!.error, 'dependency_failed');
  assert.equal(report.done, 0);
  /* Nothing said "done", and no edge was written. */
  const edges = await db.select().from(itemLinks).where(eq(itemLinks.workspaceId, ws));
  assert.equal(edges.length, 0);
});

test('phase4: an independent action still runs when another fails', async () => {
  const { db, ws, userId } = await setup();
  const registry = new CapabilityRegistry(MODULES);

  const report = await run({ db, registry, request: request(ws, userId) }, [
    action({ id: 'a1', capability: 'task.create', payload: { nonsense: true } }),
    action({ id: 'a2', capability: 'task.create', payload: { title: 'Unrelated' } }),
  ]);
  assert.equal(report.results[0]!.status, 'failed');
  assert.equal(report.results[1]!.status, 'done');
  assert.equal(report.done, 1);
});

test('phase4: a break propagates down a chain, blaming the action that broke', async () => {
  const { db, ws, userId } = await setup();
  const registry = new CapabilityRegistry(MODULES);

  const report = await run({ db, registry, request: request(ws, userId) }, [
    action({ id: 'a1', capability: 'task.create', payload: { nonsense: true } }),
    action({
      id: 'a2', capability: 'task.update',
      payload: { id: '{{a1.id}}', changes: { title: 'x' } },
    }),
    action({
      id: 'a3', capability: 'link.create', module: 'relationships', title: 'Link',
      payload: {
        kind: 'related',
        sourceType: 'task', sourceId: '{{a2.id}}',
        targetType: 'task', targetId: '{{a1.id}}',
      },
    }),
  ]);
  assert.equal(report.results[0]!.status, 'failed');
  assert.equal(report.results[1]!.status, 'skipped');
  assert.equal(report.results[2]!.status, 'skipped', 'the third link is not orphaned');
  assert.equal(report.failed, 1);
  assert.equal(report.skipped, 2);
});

test('phase4: results come back in the order the cards were shown', async () => {
  const { db, ws, userId } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  /* a1 depends on a2, so it EXECUTES second and must still REPORT first. */
  const report = await run({ db, registry, request: request(ws, userId) }, [
    action({
      id: 'a1', capability: 'task.update',
      payload: { id: '{{a2.id}}', changes: { title: 'Renamed' } },
    }),
    action({ id: 'a2', capability: 'task.create', payload: { title: 'Original' } }),
  ]);
  assert.deepEqual(report.results.map((r) => r.actionId), ['a1', 'a2']);
  assert.equal(report.done, 2, JSON.stringify(report.results));
});

/* ══ Operating each module ═══════════════════════════════════════════════ */

test('phase4: a project, then a task inside it, in one proposal', async () => {
  const { db, ws, userId, call, areaId } = await setup();
  const registry = new CapabilityRegistry(MODULES);

  const report = await run({ db, registry, request: request(ws, userId) }, [
    action({
      id: 'a1', capability: 'project.create', module: 'projects', title: 'Office move',
      payload: {
        title: 'Office move', outcome: 'Everything moved and working',
        areaId, focus: 'now',
      },
    }),
    action({
      id: 'a2', capability: 'task.create', title: 'Get moving quotes',
      payload: { title: 'Get moving quotes', projectId: '{{a1.id}}' },
    }),
  ]);
  assert.equal(report.done, 2, JSON.stringify(report.results));

  const projectId = report.results[0]!.ref!.id;
  const shown = (await call('GET', `/projects/${projectId}`)).body;
  assert.equal(shown.tasks.length, 1);
  assert.equal(shown.tasks[0].title, 'Get moving quotes');
  /* Status and focus stay independent — creating a task must not silently
     reclassify the project's focus. */
  assert.equal(shown.project.focus, 'now');
});

test('phase4: a habit is DEFINED and then CHECKED — two different things', async () => {
  const { db, ws, userId, call } = await setup();
  const registry = new CapabilityRegistry(MODULES);

  const made = await run({ db, registry, request: request(ws, userId) }, [
    action({
      id: 'a1', capability: 'habit.create', module: 'habits', title: 'Stretch',
      payload: { name: 'Stretch', frequencyType: 'daily' },
    }),
  ]);
  assert.equal(made.done, 1, JSON.stringify(made.results));
  const habitId = made.results[0]!.ref!.id;

  /* The definition exists and has NOT been ticked by being created. */
  const before = (await call('GET', '/habits?date=2026-09-01')).body.habits
    .find((h: any) => h.id === habitId);
  assert.ok(before, 'the habit is listed');
  assert.equal(before.todayCount ?? 0, 0, 'creating a habit does not tick it');

  const ticked = await run({ db, registry, request: request(ws, userId) }, [
    action({
      id: 'a1', capability: 'habit.check', module: 'habits', title: 'Tick',
      payload: { id: habitId, date: '2026-09-01' },
    }),
  ]);
  assert.equal(ticked.done, 1, JSON.stringify(ticked.results));
  const after = (await call('GET', '/habits?date=2026-09-01')).body.habits
    .find((h: any) => h.id === habitId);
  assert.ok((after.todayCount ?? 0) >= 1, 'and now it is ticked for that civil day');
});

test('phase4: a diary entry is written only where one was asked for', async () => {
  const { db, ws, userId, call } = await setup();
  const registry = new CapabilityRegistry(MODULES);

  const report = await run({ db, registry, request: request(ws, userId) }, [
    action({
      id: 'a1', capability: 'diary.append', module: 'diary', title: 'Write',
      payload: { date: '2026-09-01', text: 'Finished the Life OS AI foundation.' },
    }),
  ]);
  assert.equal(report.done, 1, JSON.stringify(report.results));

  const entry = (await call('GET', '/diary/entries/2026-09-01')).body.entry;
  assert.match(entry.documentText, /Life OS AI foundation/);

  /* The module states the rule the planner is held to. It is not decoration:
     without it, "I had a difficult meeting today" becomes a diary write. */
  const diary = MODULES.find((m) => m.id === 'diary')!;
  assert.ok(
    diary.rules.some((r) => /ONLY when the user asks/i.test(r)),
    'the diary module says it writes only when asked',
  );
});

test('phase4: a book, a section in it, and a page in that', async () => {
  const { db, ws, userId } = await setup();
  const registry = new CapabilityRegistry(MODULES);

  const book = await run({ db, registry, request: request(ws, userId) }, [
    action({
      id: 'a1', capability: 'library.createBook', module: 'library', title: 'Moving',
      payload: { title: 'Moving', firstSection: 'Notes' },
    }),
  ]);
  assert.equal(book.done, 1, JSON.stringify(book.results));

  /* The result ref is the SHELF id. A section created from it must still
     find the right book — the two ids name one book. */
  const shelfId = book.results[0]!.ref!.id;
  const section = await run({ db, registry, request: request(ws, userId) }, [
    action({
      id: 'a1', capability: 'library.createSection', module: 'library', title: 'Checklists',
      payload: { bookId: shelfId, title: 'Checklists' },
    }),
  ]);
  assert.equal(section.done, 1, JSON.stringify(section.results));

  const page = await run({ db, registry, request: request(ws, userId) }, [
    action({
      id: 'a1', capability: 'library.createPage', module: 'library', title: 'Page',
      payload: {
        sectionId: section.results[0]!.ref!.id,
        title: 'Moving checklist', layout: 'notes',
      },
    }),
  ]);
  assert.equal(page.done, 1, JSON.stringify(page.results));

  const [row] = await db.select().from(bookPages)
    .where(and(eq(bookPages.workspaceId, ws), eq(bookPages.id, page.results[0]!.ref!.id)));
  assert.equal(row!.title, 'Moving checklist');
});

test('phase4: unlinking removes the edge and neither end', async () => {
  const { db, ws, userId, call, areaId } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const project = (await call('POST', '/projects', {
    title: 'WebAnchor', outcome: 'Shipped', areaId, focus: 'now',
  })).body.project;
  const task = (await call('POST', '/tasks', { title: 'Send final credentials' })).body.task;

  const linked = await run({ db, registry, request: request(ws, userId) }, [
    action({
      id: 'a1', capability: 'link.create', module: 'relationships', title: 'Link',
      payload: {
        kind: 'related', sourceType: 'task', sourceId: task.id,
        targetType: 'project', targetId: project.id,
      },
    }),
  ]);
  assert.equal(linked.done, 1, JSON.stringify(linked.results));

  const [edge] = await db.select().from(itemLinks).where(eq(itemLinks.workspaceId, ws));
  assert.ok(edge);

  const removed = await run({ db, registry, request: request(ws, userId) }, [
    action({
      id: 'a1', capability: 'link.remove', module: 'relationships', title: 'Unlink',
      payload: { linkId: edge!.id }, important: true,
    }),
  ], ['a1']);
  assert.equal(removed.done, 1, JSON.stringify(removed.results));

  assert.equal((await db.select().from(itemLinks).where(eq(itemLinks.workspaceId, ws))).length, 0);
  /* Both ends survive. An edge is not ownership. */
  assert.equal((await call('GET', `/tasks/${task.id}`)).status, 200);
  assert.equal((await call('GET', `/projects/${project.id}`)).status, 200);
});

/* ══ Resolution and reference ════════════════════════════════════════════ */

test('phase4: the resolver picks the obvious one and refuses to guess', async () => {
  const { db, ws, userId, call } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const ctx = forRequest(db, request(ws, userId));

  await call('POST', '/tasks', { title: 'Send final credentials' });
  await call('POST', '/tasks', { title: 'Review the annual returns' });

  const hit = await resolveEntity(ctx, registry, 'Send final credentials', {
    today: '2026-09-01',
  });
  assert.equal(hit.status, 'resolved');
  assert.equal(hit.status === 'resolved' && hit.hit.title, 'Send final credentials');

  /* Nothing like it. It must say so rather than return the nearest thing. */
  const none = await resolveEntity(ctx, registry, 'Rewire the garage', {
    today: '2026-09-01',
  });
  assert.equal(none.status, 'none');

  /* A pronoun is not a name and must never resolve to whatever it matches. */
  const pronoun = await resolveEntity(ctx, registry, 'it', { today: '2026-09-01' });
  assert.equal(pronoun.status, 'none');
});

test('phase4: two equally good candidates are ambiguous, not a coin toss', async () => {
  const { db, ws, userId, call } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const ctx = forRequest(db, request(ws, userId));

  await call('POST', '/tasks', { title: 'Client call' });
  await call('POST', '/tasks', { title: 'Client call' });

  const r = await resolveEntity(ctx, registry, 'Client call', { today: '2026-09-01' });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.status === 'ambiguous' && r.candidates.length, 2);
});

test('phase4: the type asked for narrows the search', async () => {
  const { db, ws, userId, call, areaId } = await setup();
  const registry = new CapabilityRegistry(MODULES);
  const ctx = forRequest(db, request(ws, userId));

  await call('POST', '/tasks', { title: 'WebAnchor' });
  await call('POST', '/projects', {
    title: 'WebAnchor', outcome: 'Shipped', areaId, focus: 'now',
  });

  const both = await resolveEntity(ctx, registry, 'WebAnchor', { today: '2026-09-01' });
  assert.equal(both.status, 'ambiguous', 'a task and a project both called that');

  const project = await resolveEntity(ctx, registry, 'WebAnchor', {
    today: '2026-09-01', types: ['project'],
  });
  assert.equal(project.status, 'resolved');
  assert.equal(project.status === 'resolved' && project.hit.ref.type, 'project');
});

test('phase4: "it" resolves to what the conversation established, by id', async () => {
  const { db, ws, userId, call, areaId } = await setup();
  const project = (await call('POST', '/projects', {
    title: 'WebAnchor', outcome: 'Shipped', areaId, focus: 'now',
  })).body.project;

  /* A conversation whose last turn created that project. */
  const [conv] = await db.insert(aiConversations)
    .values({ workspaceId: ws, userId }).returning();
  await db.insert(aiTurns).values({
    workspaceId: ws, userId, conversationId: conv!.id,
    request: 'Create a project called WebAnchor', status: 'executed',
    actions: [], sources: [],
    results: [{
      actionId: 'a1', capability: 'project.create', status: 'done',
      ref: { type: 'project', id: project.id }, message: 'Created.',
    }],
  });

  const refs = await recentReferences(db, ws, conv!.id);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.id, project.id);
  assert.equal(refs[0]!.how, 'created');
  /* The TITLE is read now, from the row — never cached in the turn. */
  assert.equal(refs[0]!.title, 'WebAnchor');

  /* And the planner is handed the id, not asked to remember a name. */
  const prompt = referencesForPrompt(refs)!;
  assert.match(prompt, new RegExp(project.id));

  assert.ok(referenceCue('Add a task to it called Send final credentials').present);
  assert.equal(referenceCue('the project').type, 'project');
  assert.equal(referenceCue('Create a task called Buy milk').present, false);
});

test('phase4: a reference to something since deleted quietly drops out', async () => {
  const { db, ws, userId, call } = await setup();
  const task = (await call('POST', '/tasks', { title: 'Temporary' })).body.task;
  const [conv] = await db.insert(aiConversations)
    .values({ workspaceId: ws, userId }).returning();
  await db.insert(aiTurns).values({
    workspaceId: ws, userId, conversationId: conv!.id,
    request: 'x', status: 'executed', actions: [], sources: [],
    results: [{
      actionId: 'a1', capability: 'task.create', status: 'done',
      ref: { type: 'task', id: task.id }, message: 'Added.',
    }],
  });
  assert.equal((await recentReferences(db, ws, conv!.id)).length, 1);

  await db.delete(tasks).where(eq(tasks.id, task.id));
  /* No dead id is ever offered as something "it" could mean. */
  assert.equal((await recentReferences(db, ws, conv!.id)).length, 0);
});

/* ══ Modularity ══════════════════════════════════════════════════════════ */

test('phase4: removing a module removes its capabilities AND its routing', async () => {
  const { db, ws, userId } = await setup();
  const ctx = forRequest(db, request(ws, userId));

  const full = await new CapabilityRegistry(MODULES).describe(ctx);
  assert.ok(full.routing!.some((r) => r.module === 'habits'));

  const without = new CapabilityRegistry(MODULES.filter((m) => m.id !== 'habits'));
  const described = await without.describe(ctx);
  assert.equal(described.capabilities.filter((c) => c.module === 'habits').length, 0);
  assert.equal(described.routing!.filter((r) => r.module === 'habits').length, 0);
  /* And it cannot be executed either — not merely absent from the listing. */
  assert.equal(await without.resolve(ctx, 'habit.create'), null);
});

test('phase4: a module switched OFF stops routing to itself', async () => {
  const { db, ws, userId } = await setup();
  const ctx = forRequest(db, request(ws, userId));
  const off = MODULES.map((m) => (m.id === 'library'
    ? { ...m, available: () => ({ enabled: false, reason: 'Library is off here.' }) }
    : m));
  const described = await new CapabilityRegistry(off as any).describe(ctx);
  assert.equal(described.routing!.filter((r) => r.module === 'library').length, 0);
  assert.ok(described.unavailable.some((u) => u.id === 'library'));
});

test('phase4: a new module is usable with no central list edited', async () => {
  const { db, ws, userId } = await setup();
  const ctx = forRequest(db, request(ws, userId));

  const budget = {
    id: 'budget',
    name: 'Budget',
    entities: [],
    rules: ['Money is never guessed at.'],
    routing: ['Anything about what something COST.'],
    available: () => ({ enabled: true }),
    capabilities: [{
      id: 'budget.record',
      module: 'budget',
      kind: 'mutate' as const,
      label: 'Record spend',
      description: 'Record an amount spent.',
      input: z.object({ amount: z.number(), note: z.string() }).strict(),
      risk: 'confirm' as const,
      async execute(_c: any, input: { amount: number; note: string }) {
        return {
          status: 'done' as const, ref: null,
          message: `Recorded ${input.amount} for ${input.note}.`,
        };
      },
    }],
  };

  const registry = new CapabilityRegistry([...MODULES, budget as any]);
  const described = await registry.describe(ctx);
  assert.ok(described.capabilities.some((c) => c.id === 'budget.record'));
  assert.ok(described.routing!.some((r) => r.module === 'budget'));

  const report = await run({ db, registry, request: request(ws, userId) }, [
    action({
      id: 'a1', capability: 'budget.record', module: 'budget', title: 'Spend',
      payload: { amount: 12.5, note: 'boxes' },
    }),
  ]);
  assert.equal(report.done, 1, JSON.stringify(report.results));
  assert.match(report.results[0]!.message, /Recorded 12.5 for boxes/);
});

test('phase4: areas are retrieved on every turn, not only on a broad pass', async () => {
  /* "Put it in Work" needs the id of the Work area, and nothing in that
     sentence would make a substring search return it. */
  const areas = MODULES.find((m) => m.id === 'areas')!;
  const list = areas.capabilities.find((c) => c.id === 'area.list')!;
  assert.equal(list.always, true);
});

/* ══ Through the real HTTP path ══════════════════════════════════════════
 *
 * The tests above exercise the executor directly. These go through the route
 * the browser uses — plan, persist, confirm, execute — because that is where
 * the version gate, the proposal store and the confirmation count live, and a
 * dependency that works in the executor and not through the route works
 * nowhere that matters.
 *
 * The PLANNER is stubbed. What is being checked is the pipeline, not the
 * model's judgement: that a placeholder survives validation and storage, that
 * the count the button sends still matches, and that the ids that reach the
 * services are the ones the earlier actions actually produced.
 */
function stubPlanner(plans: any[]): AiProvider {
  let i = 0;
  return {
    id: 'stub',
    label: 'Stub',
    model: 'stub-1',
    async plan(input: any) {
      const p = plans[Math.min(i, plans.length - 1)] ?? {};
      i += 1;
      return {
        id: '', request: input.text,
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

async function withPlanner(plans: any[]) {
  const { db } = await freshDb();
  const app = buildApp(db, env, {
    registry: new CapabilityRegistry(MODULES),
    providers: new ProviderRouter(
      [deterministicProvider, stubPlanner(plans)],
      { plan: 'stub', default: 'deterministic' },
    ),
  });
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

test('phase4 http: a composite request survives plan, storage and confirmation', async () => {
  /* Filled in after setup: the plan names a real area id, and there is no
     workspace to get one from until the app exists. The stub reads the array
     when the turn runs, not when it is constructed. */
  const plans: any[] = [];
  const { call, areaId } = await withPlanner(plans);
  plans.push({
    understood: 'Set up the office move',
    actions: [
      {
        capability: 'project.create', title: 'Office move',
        payload: {
          title: 'Office move', outcome: 'Everything moved and working',
          areaId, focus: 'now',
        },
        confidence: 'high', assumptions: [], warnings: [], sources: [],
      },
      {
        capability: 'task.create', title: 'Get moving quotes',
        payload: { title: 'Get moving quotes', projectId: '{{a1.id}}' },
        confidence: 'high', assumptions: [], warnings: [], sources: [],
      },
      {
        capability: 'link.create', title: 'Link the task to the project',
        payload: {
          kind: 'related',
          sourceType: 'task', sourceId: '{{a2.id}}',
          targetType: 'project', targetId: '{{a1.id}}',
        },
        confidence: 'high', assumptions: [], warnings: [], sources: [],
      },
    ],
  });

  const turn = (await call('POST', '/ai/turn', {
    text: 'Create a project called Office move in Work, add a task to get moving quotes, '
      + 'and link them.',
    today: '2026-09-01',
  })).body;

  assert.equal(turn.status, 'proposed', JSON.stringify(turn));
  assert.equal(turn.actions.length, 3, 'all three survived validation');
  /* The placeholder is STORED, not resolved early and not replaced by a
     probe. Confirming a proposal carrying a real-looking id nobody created
     is the failure this guards. */
  assert.equal(turn.actions[1].payload.projectId, '{{a1.id}}');

  const done = (await call('POST', `/ai/turn/${turn.turnId}/confirm`, {
    version: turn.version, count: 3, importantAccepted: [],
  })).body;

  assert.equal(done.done, 3, JSON.stringify(done.results));
  const projectId = done.results[0].ref.id;
  const shown = (await call('GET', `/projects/${projectId}`)).body;
  assert.equal(shown.tasks.length, 1);
  assert.equal(shown.tasks[0].title, 'Get moving quotes');

  /* And the edge points at the two rows that were really created. */
  const related = (await call('GET', `/links?type=task&id=${shown.tasks[0].id}`)).body;
  assert.ok(
    JSON.stringify(related).includes(projectId),
    'the link reaches the project that was created in the same turn',
  );
});

test('phase4 http: a dependent is not run when its dependency fails', async () => {
  const plans: any[] = [];
  const { call, areaId } = await withPlanner(plans);
  /* A REAL project, so every id in the plan is one retrieval produced and
     validation has nothing to object to. */
  const project = (await call('POST', '/projects', {
    title: 'Office move', outcome: 'Moved', areaId, focus: 'now',
  })).body.project;

  plans.push({
    understood: 'Link and then edit',
    actions: [
      {
        /* Passes every plan-time check and fails at EXECUTION: the id is
           real and known, and it is a PROJECT being described as a task.
           The link service checks both ends exist as the types claimed. */
        capability: 'link.create', title: 'Link them',
        payload: {
          kind: 'related',
          sourceType: 'task', sourceId: project.id,
          targetType: 'project', targetId: project.id,
        },
        confidence: 'high', assumptions: [], warnings: [], sources: [],
      },
      {
        capability: 'task.update', title: 'Make it urgent',
        payload: { id: '{{a1.id}}', changes: { priority: 'high' } },
        confidence: 'high', assumptions: [], warnings: [], sources: [],
      },
    ],
  });

  const turn = (await call('POST', '/ai/turn', {
    text: 'Link the office move to itself and make it urgent.', today: '2026-09-01',
  })).body;
  assert.equal(turn.status, 'proposed', JSON.stringify(turn));
  assert.equal(turn.actions.length, 2, 'both were shown — nothing was caught early');

  const done = (await call('POST', `/ai/turn/${turn.turnId}/confirm`, {
    version: turn.version, count: 2, importantAccepted: [],
  })).body;

  assert.equal(done.results[0].status, 'failed', JSON.stringify(done));
  assert.equal(done.results[1].status, 'skipped');
  assert.equal(done.results[1].error, 'dependency_failed');
  assert.equal(done.done, 0, 'nothing claims to be done');
});

test('phase4 http: an action referring to one that was rejected is dropped, not shown', async () => {
  const { call } = await withPlanner([{
    understood: 'Two changes',
    actions: [
      /* Invalid — no title. Rejected before anything is shown. */
      {
        capability: 'task.create', title: 'Broken',
        payload: { nonsense: true },
        confidence: 'high', assumptions: [], warnings: [], sources: [],
      },
      /* Depends on it, so it cannot be carried out either. */
      {
        capability: 'task.update', title: 'Make it urgent',
        payload: { id: '{{a1.id}}', changes: { priority: 'high' } },
        confidence: 'high', assumptions: [], warnings: [], sources: [],
      },
      /* Independent, and must survive. */
      {
        capability: 'task.create', title: 'Unrelated',
        payload: { title: 'Unrelated' },
        confidence: 'high', assumptions: [], warnings: [], sources: [],
      },
    ],
  }]);

  const turn = (await call('POST', '/ai/turn', {
    text: 'Do three things.', today: '2026-09-01',
  })).body;

  /* Only the independent one is offered. The user is never shown a change
     that could not have worked. */
  assert.equal(turn.actions.length, 1, JSON.stringify(turn.actions));
  assert.equal(turn.actions[0].title, 'Unrelated');
});
