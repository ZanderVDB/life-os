/*
 * Phase A closeout — legacy People/Promise AI write freeze.
 *
 * Extracts the REAL functions from index.html and runs them in Node.
 * Synthetic data only.
 *
 * Run:  node tests/people-freeze.test.js
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(FILE, 'utf8');

function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('could not find function ' + name);
  let depth = 0, end = -1;
  for (let p = src.indexOf('{', start); p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) { end = p + 1; break; } }
  }
  return src.slice(start, end);
}
function extractConst(name) {
  const i = src.indexOf('const ' + name + '=');
  if (i < 0) throw new Error('could not find const ' + name);
  const nl = src.indexOf('\n', i);
  let depth = 0, started = false, end = -1;
  for (let p = i; p < src.length; p++) {
    if (src[p] === '{' || src[p] === '[') { depth++; started = true; }
    else if (src[p] === '}' || src[p] === ']') { depth--; if (started && depth === 0) { end = src.indexOf(';', p) + 1; break; } }
    else if (!started && src[p] === ';') { end = p + 1; break; }
  }
  return src.slice(i, end > 0 ? end : nl);
}

const sandbox = new Function(`
  ${extractConst('AI_SCOPES')}
  ${extractConst('LEGACY_PEOPLE_FROZEN')}
  ${extractConst('FROZEN_PEOPLE_OPS')}
  ${extractConst('LEGACY_PEOPLE_MESSAGE')}
  ${extractFn('_peopleOpsBlocked')}
  ${extractFn('_stripFrozenPeopleOps')}
  ${extractFn('_allowedOps')}
  ${extractFn('_scopeFilterCh')}
  return { AI_SCOPES, LEGACY_PEOPLE_FROZEN, FROZEN_PEOPLE_OPS, LEGACY_PEOPLE_MESSAGE,
           _peopleOpsBlocked, _stripFrozenPeopleOps, _allowedOps, _scopeFilterCh };
`)();

const { AI_SCOPES, LEGACY_PEOPLE_FROZEN: FROZEN, FROZEN_PEOPLE_OPS: OPS,
        LEGACY_PEOPLE_MESSAGE: MSG, _peopleOpsBlocked: blocked,
        _stripFrozenPeopleOps: strip, _allowedOps: allowed,
        _scopeFilterCh: scopeFilter } = sandbox;

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n          ' + e.message); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };

console.log('\n=== 1. The freeze is on, and covers the right operations ===');
t('the freeze flag is enabled', () => eq(FROZEN, true));
t('addPerson and addPromise are the frozen operations', () => {
  ok(OPS.includes('addPerson'), 'addPerson must be frozen');
  ok(OPS.includes('addPromise'), 'addPromise must be frozen');
  eq(OPS.length, 2, 'exactly these two:');
});
t('there is a clear user-facing message', () => {
  ok(/retired/i.test(MSG), 'must say the feature is retired');
  ok(/not .*accepting|no longer accepting/i.test(MSG), 'must say it accepts no new records');
  ok(/unchanged|existing/i.test(MSG), 'must reassure that existing data is safe');
});

console.log('\n=== 2. Layer 1 — the model is never offered the operations ===');
t('addPerson/addPromise are absent from EVERY scope', () => {
  Object.keys(AI_SCOPES).forEach(scope => {
    const ops = allowed(scope);
    OPS.forEach(op => ok(!ops.includes(op), op + ' still offered in scope "' + scope + '"'));
  });
});
t('the former people scope is now empty of write operations', () => {
  eq(allowed('people'), [], 'people scope should offer nothing:');
});
t('unrelated operations are STILL offered', () => {
  const today = allowed('today');
  ['addTasks', 'completeTasks', 'removeTasks', 'addHabits', 'completeHabits',
   'addBuild', 'addBuildNote', 'addIdea', 'addResource', 'addNote',
   'addReminders', 'completeReminders', 'addEvent', 'removeEvent', 'updateEvent',
   'completeRoutine', 'addNotebookEntry'].forEach(op =>
    ok(today.includes(op), op + ' must still be available'));
});
t('other scopes are untouched', () => {
  eq(allowed('brain'), ['addIdea', 'addResource', 'addNote'], 'brain:');
  eq(allowed('notebook'), ['addNotebookEntry'], 'notebook:');
  eq(allowed('projects'), ['addBuild', 'addBuildNote'], 'projects:');
  eq(allowed('settings'), [], 'settings:');
});

console.log('\n=== 3. Layer 2 — the scope filter strips them ===');
t('addPerson is removed from a proposed change set', () => {
  const ch = { addPerson: [{ name: 'X' }], addTasks: [{ text: 'real task' }] };
  scopeFilter(ch, 'today');
  ok(!('addPerson' in ch), 'addPerson must be stripped');
  eq(ch.addTasks.length, 1, 'the task must survive:');
});
t('addPromise is removed', () => {
  const ch = { addPromise: [{ person: 'X', text: 'y' }], addHabits: [{ name: 'Run' }] };
  scopeFilter(ch, 'today');
  ok(!('addPromise' in ch), 'addPromise must be stripped');
  eq(ch.addHabits.length, 1, 'the habit must survive:');
});
t('a People-only request leaves nothing behind', () => {
  const ch = { addPerson: [{ name: 'X' }], addPromise: [{ person: 'X', text: 'y' }], message: 'ok' };
  scopeFilter(ch, 'today');
  eq(Object.keys(ch).sort(), ['message'], 'only the message should remain:');
});
t('stripping is detected so the reason can be explained', () => {
  eq(blocked({ addPerson: [{ name: 'X' }] }), true, 'addPerson detected:');
  eq(blocked({ addPromise: [{ text: 'y' }] }), true, 'addPromise detected:');
  eq(blocked({ addTasks: [{ text: 'x' }] }), false, 'unrelated op must not trigger it:');
  eq(blocked({ addPerson: [] }), false, 'an EMPTY people array is not a request:');
  eq(blocked({}), false, 'empty change set:');
  eq(blocked(null), false, 'null-safe:');
});

console.log('\n=== 4. Layer 3 — the apply-time guard ===');
t('strip() removes the ops and reports whether any were present', () => {
  const ch = { addPerson: [{ name: 'X' }], addTasks: [{ text: 'keep me' }] };
  eq(strip(ch), true, 'must report a hit:');
  ok(!('addPerson' in ch), 'addPerson removed');
  eq(ch.addTasks.length, 1, 'unrelated op untouched:');
});
t('strip() reports false when no People ops were requested', () => {
  const ch = { addTasks: [{ text: 'x' }] };
  eq(strip(ch), false);
  eq(ch.addTasks.length, 1, 'nothing else disturbed:');
});
t('an empty People array is removed but not reported as a request', () => {
  const ch = { addPerson: [] };
  eq(strip(ch), false, 'empty array is not a real request:');
  ok(!('addPerson' in ch), 'but the key is still cleaned up');
});
t('applyChanges runs the guard BEFORE anything is applied or saved', () => {
  const fn = extractFn('applyChanges');
  const guard = fn.indexOf('_stripFrozenPeopleOps');
  const firstSave = fn.indexOf('svAll(');
  const firstApply = fn.indexOf('S.tasks');
  ok(guard > -1, 'applyChanges must call the guard');
  ok(firstSave === -1 || guard < firstSave, 'guard must precede any save');
  ok(firstApply === -1 || guard < firstApply, 'guard must precede any mutation');
});
t('a People-only change set returns early WITHOUT saving', () => {
  const fn = extractFn('applyChanges');
  const i = fn.indexOf('_peopleBlocked');
  const ret = fn.indexOf('return {status:LEGACY_PEOPLE_MESSAGE');
  ok(i > -1 && ret > i, 'must return early with the message');
  const before = fn.slice(0, ret);
  ok(!/svAll\(\)/.test(before), 'must not save before returning');
});

console.log('\n=== 5. Existing People data is never touched ===');
t('no frozen path deletes, edits or rewrites People records', () => {
  const guardFns = ['_stripFrozenPeopleOps', '_peopleOpsBlocked', '_allowedOps', '_scopeFilterCh'];
  guardFns.forEach(n => {
    const fn = extractFn(n);
    ok(!/S\.people/.test(fn), n + ' must not touch S.people');
    ok(!/svAll\(/.test(fn), n + ' must not trigger a save');
    ok(!/\.splice\(|\.filter\(/.test(fn.replace(/ops\.filter/g, '')), n + ' must not mutate records');
  });
});
t('the freeze does not redirect People requests into another system', () => {
  const fn = extractFn('_stripFrozenPeopleOps');
  ['addTasks', 'addNote', 'addIdea', 'addBuild', 'addNotebookEntry'].forEach(op =>
    ok(!fn.includes(op), 'must not silently convert People into ' + op));
});
t('read paths for existing People data still exist', () => {
  ok(/S\.people/.test(src), 'People data must remain readable');
  ok(/_usBuild|universal search/i.test(src), 'search over people should be untouched');
});

console.log('\n=== 6. Reversibility ===');
t('the freeze is a single flag with a documented un-freeze path', () => {
  ok(/const LEGACY_PEOPLE_FROZEN=true;/.test(src), 'must be one boolean constant');
  ok(/TO UN-FREEZE: set LEGACY_PEOPLE_FROZEN = false/.test(src),
     'must document exactly how to reverse it');
});
t('every guard honours the flag rather than hard-coding the block', () => {
  ['_peopleOpsBlocked', '_stripFrozenPeopleOps', '_allowedOps'].forEach(n =>
    ok(/LEGACY_PEOPLE_FROZEN/.test(extractFn(n)), n + ' must check the flag'));
});
t('the underlying AI_SCOPES definition is left intact for reversal', () => {
  ok(AI_SCOPES.people.ops.includes('addPerson'),
     'the original scope definition should be preserved so un-freezing restores it');
});

console.log('\n=== 7. The user is told why ===');
t('a People-only request explains itself instead of saying "no changes"', () => {
  ok(/_peopleWasRequested/.test(src), 'the turn must track that People were requested');
  ok(/_peopleWasRequested\s*\n?\s*\?LEGACY_PEOPLE_MESSAGE/.test(src) ||
     /_peopleWasRequested\s*$[\s\S]{0,80}LEGACY_PEOPLE_MESSAGE/m.test(src),
     'the no-op branch must surface the retirement message');
});
t('a mixed request still applies the rest AND mentions the block', () => {
  ok(/\(ch\.message\|\|'Done!'\)\+\(_peopleWasRequested\?/.test(src),
     'the success branch must append the message when People were blocked');
});
t('the block is recorded in AI history distinctly', () => {
  ok(/blocked — People retired/.test(src), 'history should record the block reason');
});

console.log('\n' + (fail === 0 ? '✔ ALL PASS' : '✘ FAILURES: ' + fail) + '   (' + pass + ' passed)');
process.exit(fail ? 1 : 0);
