/**
 * Phase E1 — Projects discovery.
 *
 * E1 builds no Projects UI and migrates no data. These tests exist to hold the
 * two claims the phase actually makes: the audit reads structure without
 * touching content, and nothing in v2 has quietly grown a Project relationship
 * while nobody was looking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditLegacyProjects, summariseProjectAudit, LEGACY_STAGES } from '../src/lib/projects-audit.js';

const schema = readFileSync(join('src', 'db', 'schema.ts'), 'utf8');
const importWriter = readFileSync(join('src', 'lib', 'import-writer.ts'), 'utf8');
const legacyImport = readFileSync(join('src', 'lib', 'legacy-import.ts'), 'utf8');
const auditSrc = readFileSync(join('src', 'lib', 'projects-audit.ts'), 'utf8');
const importRoute = readFileSync(join('src', 'routes', 'import.ts'), 'utf8');

/** A minimal export in the shape the Legacy exporter actually writes. */
function exportWith(builds: any[], extra: Record<string, any> = {}) {
  return {
    exportFormat: 'life-os-export', exportVersion: 2, appVersion: 'v244',
    createdAt: '2026-08-03T10:00:00.000Z',
    verification: { ok: true },
    activeProfileId: 'main',
    profiles: [
      { id: 'main', name: 'Personal', mode: 'personal' },
      { id: 'biz', name: 'TriFusion', mode: 'business' },
    ],
    documents: {
      main: { data: { builds, tasks: [], workProjects: [], ...extra } },
      biz: { data: { builds: [{ id: 'x', title: 'Other' }], tasks: [{ id: 't' }] } },
    },
  };
}

/* ── The audit reads structure, not content ──────────────────────────── */

test('audit: counts Projects and reports their shape', () => {
  const a = auditLegacyProjects(exportWith([
    { id: 'b1', title: 'WebAnchor site', desc: 'A description', notes: 'notes here',
      status: 'active', stage: 2, log: [{ id: 'l1', date: '2026-07-01', content: 'x' }] },
    { id: 'b2', title: 'Empty one', auto: false, status: 'future' },
  ]));
  assert.equal(a.ok, true, a.errors.join('; '));
  assert.equal(a.total, 2);
  assert.equal(a.summary.withDescription, 1);
  assert.equal(a.summary.withNotes, 1);
  assert.equal(a.summary.withLog, 1);
  assert.equal(a.summary.empty, 1, 'a project with nothing but a title is not flagged');
  assert.equal(a.projects[0]!.stageName, LEGACY_STAGES[2]);
});

test('audit: never returns description, notes or log CONTENT', () => {
  const secret = 'PRIVATE-CONTENT-MARKER';
  const a = auditLegacyProjects(exportWith([
    { id: 'b1', title: 'Keep the title', desc: secret, notes: secret,
      log: [{ id: 'l1', date: '2026-07-01', content: secret }] },
  ]));
  const dumped = JSON.stringify(a);
  assert.ok(!dumped.includes(secret),
    'the audit leaks project body text — it must report presence and length only');
  // …but the length is reported, because "is there anything in here" is the
  // whole question a migration decision turns on.
  assert.equal(a.projects[0]!.descriptionChars, secret.length);
  assert.equal(a.projects[0]!.hasNotes, true);
  assert.equal(a.projects[0]!.logEntries, 1);
});

test('audit: Legacy status is derived from recency unless pinned', () => {
  // `auto !== false` is Legacy's rule. A migration that reads `status` without
  // reading `auto` would import a status the user never chose.
  const a = auditLegacyProjects(exportWith([
    { id: 'b1', title: 'Auto', status: 'background' },
    { id: 'b2', title: 'Pinned', status: 'active', auto: false },
  ]));
  assert.equal(a.summary.derivedStatus, 1);
  assert.equal(a.summary.pinnedStatus, 1);
  assert.equal(a.projects[0]!.statusIsDerived, true);
  assert.equal(a.projects[1]!.statusIsDerived, false);
});

test('audit: flags duplicates, missing ids and unrecognised fields', () => {
  const a = auditLegacyProjects(exportWith([
    { id: 'b1', title: 'Same name' },
    { id: 'b2', title: 'Same name' },
    { title: 'No id at all' },
    { id: 'b4', title: 'Odd', mysteryField: 1 },
  ]));
  assert.deepEqual(a.summary.duplicateTitles, [{ title: 'Same name', count: 2 }]);
  assert.equal(a.summary.missingId, 1);
  assert.ok(a.summary.unknownFields.includes('mysteryField'));
  assert.ok(a.warnings.some((w) => w.includes('mysteryField')),
    'an unrecognised field passes silently, so it would be silently dropped');
});

test('audit: the second profile is counted, never read', () => {
  const a = auditLegacyProjects(exportWith([{ id: 'b1', title: 'Mine' }]));
  assert.equal(a.profile?.id, 'main');
  assert.equal(a.excludedProfiles.length, 1);
  assert.equal(a.excludedProfiles[0]!.projects, 1);
  assert.ok(!JSON.stringify(a.excludedProfiles).includes('Other'),
    'content from the excluded profile reached the report');
});

test('audit: Legacy has no task->Project relationship', () => {
  // The single most important finding for the migration: legacy `task.project`
  // holds a workProject id, which is an AREA. There is nothing to reconcile.
  const a = auditLegacyProjects(exportWith(
    [{ id: 'b1', title: 'P' }],
    { tasks: [{ id: 't1', project: 'wp1' }], workProjects: [{ id: 'wp1', name: 'Work' }] },
  ));
  assert.equal(a.taskLinkage.legacyTasksHaveProjectField, true);
  assert.match(a.taskLinkage.note, /AREA, not a Project/);
  assert.equal(a.warnings.filter((w) => w.includes('matches a Project id')).length, 0);
});

test('audit: warns if a task.project ever pointed at a Project id', () => {
  // It should not be possible, which is exactly why it is worth detecting
  // rather than assuming.
  const a = auditLegacyProjects(exportWith(
    [{ id: 'shared', title: 'P' }],
    { tasks: [{ id: 't1', project: 'shared' }], workProjects: [] },
  ));
  assert.ok(a.warnings.some((w) => w.includes('matches a Project id')),
    'an ambiguous project reference would be migrated blindly');
});

test('audit: a bad export fails loudly rather than reporting zero', () => {
  // "0 projects" and "I could not read this" must never look the same.
  assert.equal(auditLegacyProjects(null).ok, false);
  assert.equal(auditLegacyProjects({}).ok, false);
  const noPersonal = auditLegacyProjects({
    profiles: [{ id: 'biz', name: 'TriFusion', mode: 'business' }], documents: {},
  });
  assert.equal(noPersonal.ok, false);
  assert.ok(noPersonal.errors.some((e) => /Personal/.test(e)));
  assert.deepEqual(summariseProjectAudit(noPersonal), noPersonal.errors);
});

/* ── E1 writes nothing ───────────────────────────────────────────────── */

test('e1: the audit is pure — no database, no writes, no migration', () => {
  for (const forbidden of ['db.insert', 'db.update', 'db.delete', 'drizzle', 'fetch(']) {
    assert.ok(!auditSrc.includes(forbidden),
      `the audit module reaches for ${forbidden} — it must be a pure function`);
  }
  // And the route exposes no execute counterpart.
  assert.match(importRoute, /import\/legacy\/projects\/audit/, 'the audit route is missing');
  assert.ok(!/import\/legacy\/projects\/execute/.test(importRoute),
    'a Projects migration endpoint exists — E1 does not migrate');
  assert.match(importRoute, /wouldWrite: false/, 'the audit does not declare itself read-only');
});

/* ── The v2 foundation has not quietly grown Projects ────────────────── */

test('foundation: the Legacy import still assigns no project', () => {
  // E1 asserted that project_id was an unused placeholder. E2 made it a real
  // foreign key and added the projects table — deliberately, after approval.
  // What must NOT change is the import: Legacy has no task-to-project
  // relationship at all, so inventing one during migration would be fabrication.
  assert.match(schema, /projectId: uuid\('project_id'\)/, 'the column is gone');
  assert.match(schema, /pgTable\('projects'/, 'the projects table is gone');
  assert.match(importWriter, /projectId: null/, 'the importer invents a Project relationship');
  assert.match(legacyImport, /project_id stays null/,
    'the reason the importer sets no project is no longer recorded');
});

test('foundation: legacy task.project is an Area, and that is written down', () => {
  assert.match(legacyImport, /task\.project meant an AREA, not a project/,
    'the single most misleading legacy field is undocumented');
  assert.match(legacyImport, /areaLegacyKey = legacyProject/,
    'legacy task.project no longer maps to the Area');
});

test('foundation: the polymorphic link table can carry Projects without a migration', () => {
  // Renamed `calendar_item_links` -> `item_links` in F1. The shape was already
  // general; only the name said Calendar, which is how a second link table
  // eventually gets created beside it. One relationship model, one name.
  const links = schema.slice(schema.indexOf("pgTable('item_links'"));
  assert.ok(!schema.includes("pgTable('calendar_item_links'"),
    'the Calendar-scoped link table name is back');
  assert.match(links.slice(0, 1400), /targetType: text\('target_type'\)\.notNull\(\)/,
    'there is no polymorphic target');
  assert.match(schema, /target: task \| project \| library \| diary/,
    'Projects and Library are not anticipated by the link model');
});

test('foundation: workspace isolation holds for anything Projects will inherit', () => {
  // Every table Projects will touch is scoped to a workspace and cascades.
  for (const table of ['tasks', 'areas', 'item_links']) {
    const at = schema.indexOf(`pgTable('${table}'`);
    assert.ok(at > -1, `${table} is missing`);
    const body = schema.slice(at, at + 1400);
    assert.match(body, /workspaceId: uuid\('workspace_id'\)\.notNull\(\)/,
      `${table} is not workspace-scoped`);
    assert.match(body, /onDelete: 'cascade'/, `${table} would outlive its workspace`);
  }
});

/* ── Calendar stays frozen ───────────────────────────────────────────── */

test('calendar: frozen, with its outstanding debt still recorded', () => {
  const debt = readFileSync(join('..', 'docs', 'technical-debt.md'), 'utf8');
  assert.match(debt, /Month loading: no caching, prefetch or skeletons/,
    'the month caching debt was quietly dropped');
  const plan = readFileSync(join('..', 'docs', 'v2-relaunch-plan.md'), 'utf8');
  assert.match(plan, /Calendar[\s\S]{0,400}frozen/i, 'Calendar is not recorded as frozen');
});
