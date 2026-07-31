/**
 * Legacy import mapping — pure, synthetic data only.
 * The fixture deliberately mirrors the real export shape, including a Business
 * profile that must be completely ignored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportPlan, parseLegacyTime, chooseProfile, summarisePlan, EXPORT_FORMAT } from '../src/lib/legacy-import.js';

const ts = (iso: string) => ({ __t: 'timestamp', seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0, iso });

function fixture(over: any = {}) {
  const personal = {
    workProjects: [
      { id: 'fin', name: 'Finance', color: 'gold', order: 2 },
      { id: 'gym', name: 'Gym', color: 'sage', order: 3 },
      { id: 'dup', name: '  finance  ', color: 'red', order: 4 },   // duplicate by case/space
      { id: 'bad', name: '', color: 'red', order: 5 },              // unusable
    ],
    tasks: [
      { id: 'aaa1111', text: 'Personal task', done: false, bucket: 'today', ord: 0, priority: 'hi',
        area: 'personal', project: 'gen', notes: 'note', dueDate: '2026-08-01', scheduledTime: '3:30pm',
        dailyDate: '2026-07-01', dailySince: '2026-06-01', daily: true,
        linkedPersonId: 'p1', linkedPromiseId: 'pr1', lastCheckedAt: 1750000000000,
        steps: [{ id: 's1', text: 'Step A', done: true }, { id: 's2', text: 'Step B', done: false }] },
      { id: 'bbb2222', text: 'Finance task', done: true, bucket: 'week', ord: 1, priority: 'lo',
        area: 'work', project: 'fin', doneAt: 1760000000000, scheduledTime: 'whenever' },
      { id: 'ccc3333', text: 'Work task', done: false, bucket: 'nonsense', priority: 'weird', area: 'work' },
      { id: 'ddd4444', text: '   ', done: false },                  // empty title → skipped
      { id: '', text: 'No id', done: false },                       // no id → skipped
      { id: 'aaa1111', text: 'Duplicate id', done: false },         // dupe → skipped
    ],
    reminders: [{ id: 'r1', text: 'x' }, { id: 'r2', text: 'y' }],
    habits: [{ id: 'h1', name: 'Run' }],
    notebook: { sections: [{ id: 'n1', title: 'Ideas' }] },
    people: [{ id: 'p1', name: 'Someone' }],
    dayNotes: {}, customEvents: [], learning: [],
    updatedAt: ts('2026-07-31T00:00:00Z'),
    _schemaVersion: 3,
  };
  const business = {
    tasks: [{ id: 'zzz9999', text: 'BUSINESS TASK', done: false, bucket: 'today' }],
    reminders: Array.from({ length: 10 }, (_, i) => ({ id: `br${i}`, text: 'business reminder' })),
    people: [{ id: 'p1', name: 'Someone' }],
    workProjects: [{ id: 'bizarea', name: 'Business Area', color: 'blue', order: 0 }],
    routineLog: { '2026-07-01': { checks: {}, journal: { j1: 'business diary' } } },
  };
  return {
    exportFormat: EXPORT_FORMAT, exportVersion: 1, appVersion: 'v242',
    createdAt: '2026-07-31T01:08:00.000Z', firebaseProjectId: 'life-os-a25bc',
    userId: 'uid', activeProfileId: 'main',
    profiles: [
      { id: 'main', name: 'Personal', mode: 'personal' },
      { id: 'p_x9zxkv4', name: 'Business', mode: 'business' },
    ],
    documentCount: 4,
    documents: {
      _index: { data: {} },
      main: { data: personal },
      p_x9zxkv4: { data: business },
      presence: { volatile: true, data: null },
    },
    verification: { ok: true, status: 'VERIFIED', failed: [], checks: [] },
    ...over,
  };
}

test('parseLegacyTime handles the real formats and rejects junk', () => {
  assert.equal(parseLegacyTime('3:30pm'), 15 * 60 + 30);
  assert.equal(parseLegacyTime('10am'), 600);
  assert.equal(parseLegacyTime('12am'), 0);
  assert.equal(parseLegacyTime('12pm'), 720);
  assert.equal(parseLegacyTime('14:05'), 845);
  assert.equal(parseLegacyTime('whenever'), null);
  assert.equal(parseLegacyTime('25:00'), null);
  assert.equal(parseLegacyTime(''), null);
  assert.equal(parseLegacyTime(undefined), null);
});

test('the Personal profile is chosen and Business is ignored', () => {
  const { chosen, ignored } = chooseProfile(fixture());
  assert.equal(chosen.id, 'main');
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0]!.id, 'p_x9zxkv4');
  assert.match(ignored[0]!.reason, /not migrated/i);
});

test('Personal is chosen even if Business is listed first', () => {
  const exp = fixture({ profiles: [
    { id: 'p_x9zxkv4', name: 'Business', mode: 'business' },
    { id: 'main', name: 'Personal', mode: 'personal' },
  ] });
  assert.equal(chooseProfile(exp).chosen.id, 'main', 'chosen explicitly, never by position');
});

test('an unverified export is refused', () => {
  const plan = buildImportPlan(fixture({ verification: { ok: false, status: 'FAILED — DATA MISMATCH' } }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /VERIFIED/);
  assert.equal(plan.tasks.total, 0, 'nothing is planned from an unverified file');
});

test('a non-Life-OS file is refused', () => {
  const plan = buildImportPlan({ some: 'other json' });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /Not a Life OS export/);
});

test('Areas import, with case/space duplicates collapsed', () => {
  const plan = buildImportPlan(fixture());
  assert.ok(plan.ok, plan.errors.join('; '));
  const names = plan.areas.plan.map((a) => a.name);
  assert.deepEqual(names, ['Finance', 'Gym'], 'duplicate and unnamed dropped');
  assert.match(plan.warnings.join(' '), /Duplicate Area name/);
});

test('BUSINESS data never appears in the plan', () => {
  const plan = buildImportPlan(fixture());
  const blob = JSON.stringify(plan);
  assert.ok(!blob.includes('BUSINESS TASK'), 'no Business task');
  assert.ok(!blob.includes('business reminder'), 'no Business reminder');
  assert.ok(!blob.includes('Business Area'), 'no Business area');
  assert.ok(!blob.includes('business diary'), 'no Business diary');
  assert.ok(!plan.tasks.plan.some((t) => t.legacyId === 'zzz9999'));
});

test('tasks map correctly and retired fields are dropped', () => {
  const plan = buildImportPlan(fixture());
  assert.equal(plan.tasks.total, 3, 'three valid tasks');
  const t = plan.tasks.plan.find((x) => x.legacyId === 'aaa1111')!;
  assert.equal(t.title, 'Personal task');
  assert.equal(t.priority, 'high', 'hi → high');
  assert.equal(t.bucket, 'today');
  assert.equal(t.status, 'open');
  assert.equal(t.dueDate, '2026-08-01');
  assert.equal(t.areaLegacyKey, '__personal', "project 'gen' falls back to area");
  assert.equal(t.steps.length, 2);
  assert.equal(t.steps[0]!.completed, true);

  // Every retired field must be absent from the planned row.
  const keys = Object.keys(t);
  for (const dead of ['dailyDate', 'dailySince', 'daily', 'linkedPersonId', 'linkedPromiseId', 'lastCheckedAt']) {
    assert.ok(!keys.includes(dead), `${dead} must not be imported`);
  }
  assert.ok(!JSON.stringify(t).includes('p1'), 'no People link leaks through');
});

test('task.project maps to an AREA, and project_id is never set', () => {
  const plan = buildImportPlan(fixture());
  const fin = plan.tasks.plan.find((x) => x.legacyId === 'bbb2222')!;
  assert.equal(fin.areaLegacyKey, 'fin', 'legacy project id is an Area');
  assert.ok(!('projectId' in fin), 'Projects do not exist yet');
  const work = plan.tasks.plan.find((x) => x.legacyId === 'ccc3333')!;
  assert.equal(work.areaLegacyKey, '__work');
});

test('invalid bucket and priority fall back to safe defaults', () => {
  const plan = buildImportPlan(fixture());
  const t = plan.tasks.plan.find((x) => x.legacyId === 'ccc3333')!;
  assert.equal(t.bucket, 'today');
  assert.equal(t.priority, 'medium');
});

test('a parseable time WITH a date becomes scheduled_at', () => {
  const plan = buildImportPlan(fixture());
  const t = plan.tasks.plan.find((x) => x.legacyId === 'aaa1111')!;
  assert.equal(t.scheduledAt, '2026-08-01T15:30:00');
  assert.equal(t.legacyScheduledTimeRaw, null, 'fully represented, no raw needed');
});

test('an UNPARSEABLE time is preserved verbatim, never discarded', () => {
  const plan = buildImportPlan(fixture());
  const t = plan.tasks.plan.find((x) => x.legacyId === 'bbb2222')!;
  assert.equal(t.scheduledAt, null);
  assert.equal(t.legacyScheduledTimeRaw, 'whenever', 'raw value kept');
  assert.equal(plan.tasks.withUnparseableTime, 1);
});

test('completed tasks keep their completion time', () => {
  const plan = buildImportPlan(fixture());
  const t = plan.tasks.plan.find((x) => x.legacyId === 'bbb2222')!;
  assert.equal(t.status, 'done');
  assert.ok(t.completedAt?.startsWith('2025-10-'), `got ${t.completedAt}`);
  assert.equal(plan.tasks.completed, 1);
});

test('unusable tasks are skipped WITH a reason, not silently dropped', () => {
  const plan = buildImportPlan(fixture());
  const reasons = Object.fromEntries(plan.tasks.skipped.map((s) => [s.reason, s.count]));
  assert.equal(reasons['empty title'], 1);
  assert.equal(reasons['missing id'], 1);
  assert.equal(reasons['duplicate legacy id'], 1);
});

test('excluded collections are reported, never imported', () => {
  const plan = buildImportPlan(fixture());
  const names = plan.excluded.map((e) => e.collection);
  for (const c of ['dayNotes', 'customEvents', 'people']) assert.ok(names.includes(c), `${c} reported`);
  const people = plan.excluded.find((e) => e.collection === 'people')!;
  assert.match(people.reason, /retired/i);
  assert.ok(!JSON.stringify(plan.areas).includes('Someone'));
});

test('systems not in this baseline are flagged as present but NOT imported', () => {
  const plan = buildImportPlan(fixture());
  const w = plan.warnings.join(' | ');
  for (const label of ['Reminders', 'Habits', 'Notebook']) {
    assert.match(w, new RegExp(`${label}: \\d+ record`), `${label} must be flagged`);
  }
  assert.match(w, /NOT imported/);
});

test('every legacy id is preserved for idempotent re-import', () => {
  const plan = buildImportPlan(fixture());
  assert.ok(plan.tasks.plan.every((t) => t.legacyId), 'tasks carry a legacy id');
  assert.ok(plan.areas.plan.every((a) => a.legacyId), 'areas carry a legacy id');
  // Running twice is deterministic — same ids, same counts.
  const again = buildImportPlan(fixture());
  assert.deepEqual(again.tasks.plan.map((t) => t.legacyId), plan.tasks.plan.map((t) => t.legacyId));
});

test('the summary is counts-only and carries no task text', () => {
  const s = summarisePlan(buildImportPlan(fixture()));
  const blob = JSON.stringify(s);
  for (const text of ['Personal task', 'Finance task', 'Step A', 'note', 'Someone']) {
    assert.ok(!blob.includes(text), `summary leaked "${text}"`);
  }
  assert.equal(s.tasks.total, 3);
  assert.equal(s.steps, 2);
  assert.deepEqual(s.tasks.byBucket, { today: 2, week: 1 });
  assert.equal(s.profileChosen!.id, 'main');
  assert.equal(s.profileChosen!.name, 'Personal');
  assert.deepEqual(s.profilesIgnored.map((p) => p.id), ['p_x9zxkv4']);
  assert.deepEqual(s.profilesIgnored.map((p) => p.name), ['Business']);
  assert.ok(s.profilesIgnored[0]?.reason, 'an ignored profile must say why');
});

test('a missing Personal document is an error, not a silent empty import', () => {
  const exp = fixture();
  delete (exp.documents as any).main;
  const plan = buildImportPlan(exp);
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /Personal profile document/);
});

test('preview reports excluded-profile counts, retired fields and duplicate risk', () => {
  const s = summarisePlan(buildImportPlan(fixture()));

  // Excluded Business profile: counts only, and NO content.
  const biz = s.excludedProfiles.find((p) => p.name === 'Business');
  assert.ok(biz, 'the Business profile is not reported as excluded');
  const byName = Object.fromEntries(biz!.collections.map((c) => [c.collection, c.count]));
  assert.equal(byName.reminders, 10, 'Business reminder count wrong');
  assert.equal(byName.tasks, 1, 'Business task count wrong');
  assert.equal(byName.people, 1);
  // The fixture's Business task text must not appear anywhere in the summary.
  assert.ok(!JSON.stringify(s).includes('BUSINESS TASK'), 'Business task text leaked');
  assert.ok(!JSON.stringify(s).includes('business reminder'), 'Business reminder text leaked');
  assert.ok(!JSON.stringify(s).includes('business diary'), 'Business diary text leaked');

  // Retired fields: counted from the file, including on tasks later skipped.
  assert.equal(s.retiredFields.daily, 1, 'daily not counted');
  assert.equal(s.retiredFields.linkedPersonId, 1, 'linkedPersonId not counted');
  assert.equal(s.retiredFields.linkedPromiseId, 1);
  assert.equal(s.retiredFields.lastCheckedAt, 1);
  assert.equal(s.retiredFields.dailyDate, 1);
  assert.equal(s.retiredFields.dailySince, 1);

  // Duplicate risk.
  assert.equal(s.duplicateRisk.duplicateLegacyIdsInFile, 1, 'the duplicate id in the fixture was not counted');
  assert.equal(s.duplicateRisk.tasksCarryingLegacyId, s.tasks.total);
  assert.equal(s.duplicateRisk.areasCarryingLegacyId, s.areas.total);
});

test('the excluded profile is chosen by NOT being Personal, whatever it is called', () => {
  // The real export's second profile is named "Trifusion", not "Business".
  // Selection must never depend on the excluded profile's name — it works by
  // positively identifying Personal, so any other name is excluded the same way.
  for (const otherName of ['Trifusion', 'Business', 'Side Project', '', 'Personal Admin']) {
    const exp = fixture({
      profiles: [
        { id: 'p_other', name: otherName, mode: 'business' },
        { id: 'main', name: 'Personal', mode: 'personal' },
      ],
    });
    const { chosen, ignored } = chooseProfile(exp);
    assert.equal(chosen.id, 'main', `Personal not chosen when the other profile is "${otherName}"`);
    assert.equal(ignored.length, 1);
    assert.equal(ignored[0]!.id, 'p_other');
  }
});

test('a profile whose name merely CONTAINS "personal" is not mistaken for Personal', () => {
  // "Personal Admin" must not win over the real Personal profile. The name test
  // is anchored, so only an exact match counts.
  const exp = fixture({
    profiles: [
      { id: 'p_decoy', name: 'Personal Admin', mode: 'business' },
      { id: 'main', name: 'Personal', mode: 'personal' },
    ],
  });
  assert.equal(chooseProfile(exp).chosen.id, 'main');
});

test('legacy dueDate format matches what the importer accepts', () => {
  // Legacy writes t.dueDate from an <input type="date">, whose value is always
  // 'YYYY-MM-DD'. If that parser were ever loosened or tightened out of step,
  // every due date would be silently dropped — which is exactly the kind of
  // failure a preview reports as a plausible-looking zero.
  const exp = fixture();
  exp.documents.main.data.tasks = [
    { id: 'd1', text: 'has due', done: false, bucket: 'today', dueDate: '2026-08-14' },
    { id: 'd2', text: 'no due', done: false, bucket: 'today' },
    { id: 'd3', text: 'empty due', done: false, bucket: 'today', dueDate: '' },
  ];
  const plan = buildImportPlan(exp);
  assert.equal(plan.tasks.withDueDate, 1, 'a YYYY-MM-DD due date must be recognised');
  assert.equal(plan.tasks.plan.find((t) => t.legacyId === 'd1')!.dueDate, '2026-08-14');
  assert.equal(plan.tasks.plan.find((t) => t.legacyId === 'd2')!.dueDate, null);
  assert.equal(plan.tasks.plan.find((t) => t.legacyId === 'd3')!.dueDate, null);
});
