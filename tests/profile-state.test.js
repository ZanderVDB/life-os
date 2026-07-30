/*
 * Phase A1 — profile-contamination regression tests.
 *
 * These extract the REAL functions out of index.html and run them in Node,
 * rather than re-implementing them, so the tests fail if the shipped code
 * changes behaviour.
 *
 * Run:  node tests/profile-state.test.js
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(FILE, 'utf8');

// ── Extract the functions under test ──────────────────────────────────────
function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('could not find function ' + name);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (let p = i; p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) { end = p + 1; break; } }
  }
  if (end < 0) throw new Error('unbalanced braces in ' + name);
  return src.slice(start, end);
}

// localStorage stub — _deviceAIConfirmMode reads it.
const localStorage = { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
                       setItem(k, v) { this._d[k] = String(v); } };

const sandbox = new Function('localStorage', 'console', `
  ${extractFn('_deviceAIConfirmMode')}
  ${extractFn('defaultProfileState')}
  ${extractFn('hydrateProfileState')}
  const PROFILE_STATE_KEYS = Object.keys(defaultProfileState());
  let S = defaultProfileState();
  ${extractFn('resetProfileState')}
  return { defaultProfileState, hydrateProfileState, resetProfileState,
           PROFILE_STATE_KEYS, getS: () => S, setS: v => { S = v; } };
`)(localStorage, { warn() {} });

const { defaultProfileState, hydrateProfileState, PROFILE_STATE_KEYS } = sandbox;

// resetProfileState closes over the sandbox's own `S`, so drive it through
// setS/getS to test the real implementation.
function resetVia(state) { sandbox.setS(state); sandbox.resetProfileState(); return sandbox.getS(); }

// ── Tiny harness ──────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n          ' + e.message); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };

// Realistic populated profile document.
const PROFILE_A = {
  tasks: [{ id: 'a1', text: 'A task', done: false, bucket: 'today', ord: 0 }],
  habits: [{ id: 'h1', name: 'A habit', checkedDates: ['2026-07-30'] }],
  reminders: [{ id: 'r1', text: 'A REMINDER', recurrence: { type: 'daily' } }],
  people: [{ id: 'p1', name: 'Alice' }],
  peopleTags: [{ id: 't1', name: 'family' }],
  peopleLevelNames: ['L1', 'L2', 'L3', 'L4', 'L5'],
  peopleSettings: { defaultSort: 'name' },
  builds: [{ id: 'b1', title: 'A project' }],
  ideas: [{ id: 'i1', title: 'An idea' }],
  resources: [{ id: 's1', title: 'A resource' }],
  notes: [{ id: 'n1', title: 'A note' }],
  workProjects: [{ id: 'wp', name: 'Area', color: 'peach' }],
  notebook: { sections: [{ id: 'sec', title: 'Section A', pages: [] }] },
  dayNotes: { '2026-07-30': 'a day note' },
  routineLog: { '2026-07-30': { checks: {}, journal: { j1: 'A journal' } } },
  aiHistory: [{ at: 1, prompt: 'A prompt' }],
  aiMemory: ['A fact'],
  disabledCalendars: ['cal-a'],
  lifeRhythm: 'A rhythm',
  todaysTip: 'A tip',
  growthFocus: 'A focus',
  weeklyReview: { text: 'A review' },
  routine: { weekday: [{ id: 'x' }], weekend: [] },
  calendarDefaults: { timedReminders: [15], allDayReminders: [0], birthdayReminders: [420, 0] },
  defaultWriteCalendar: { source: 'google', calendarId: 'cal-a' },
  aiConfirmMode: 'all', habitCatchupEnabled: false, checkinLevel: 'thorough',
  morningHabitCatchup: false, faithFocus: false,
  trialStart: '2026-01-01', entitlement: 'pro', onboardDone: true,
  _personalOrder: 3, _workOrder: 7, _schemaVersion: 5
};

// Every profile-scoped key that PROFILE_A populates.
const A_KEYS = Object.keys(PROFILE_A).filter(k => PROFILE_STATE_KEYS.includes(k));

/** Simulate a real profile switch: reset, then hydrate the target document. */
function switchTo(state, doc) {
  const s = resetVia(state);      // resetStateForNewUser() path
  hydrateProfileState(s, doc);    // handleSnapshot() path
  return s;
}

console.log('\n=== 1. The factory is the single source of truth ===');
t('every key has an explicit declared default', () => {
  const d = defaultProfileState();
  ok(PROFILE_STATE_KEYS.length >= 30, 'expected 30+ declared fields, got ' + PROFILE_STATE_KEYS.length);
  ok(Object.prototype.hasOwnProperty.call(d, 'reminders'), 'reminders must be declared');
  ok(Object.prototype.hasOwnProperty.call(d, 'people'), 'people must be declared');
  ok(Object.prototype.hasOwnProperty.call(d, 'peopleTags'), 'peopleTags must be declared');
  ok(Object.prototype.hasOwnProperty.call(d, 'peopleLevelNames'), 'peopleLevelNames must be declared');
});
t('returns a FRESH object each call (no shared references)', () => {
  const a = defaultProfileState(), b = defaultProfileState();
  a.tasks.push({ id: 'x' }); a.notebook.sections.push({ id: 'y' }); a.calendarDefaults.timedReminders.push(999);
  eq(b.tasks, [], 'tasks leaked between factory calls:');
  eq(b.notebook.sections, [], 'notebook leaked:');
  eq(b.calendarDefaults.timedReminders, [60, 10], 'calendarDefaults leaked:');
});
t('defaults cover arrays, objects, booleans, scalars and undefined', () => {
  const d = defaultProfileState();
  eq(d.tasks, [], 'array default:');                    eq(d.dayNotes, {}, 'object default:');
  eq(d.faithFocus, true, 'boolean default:');           eq(d.lifeRhythm, '', 'string default:');
  eq(d.todaysTip, null, 'null default:');               eq(d.checkinLevel, 'balanced', 'enum default:');
  ok(d.trialStart === undefined, 'optional default must be undefined');
  eq(d.notebook, { sections: [] }, 'nested object default:');
  eq(d.peopleLevelNames.length, 5, 'peopleLevelNames default length:');
});

console.log('\n=== 2. Populated Profile A → EMPTY Profile B (the reported bug) ===');
t('no field from A survives into an empty B', () => {
  let s = switchTo(defaultProfileState(), PROFILE_A);
  eq(s.reminders.length, 1, 'A should have loaded:');
  s = switchTo(s, {});                                   // B has NO fields at all
  const def = defaultProfileState();
  const leaked = A_KEYS.filter(k => JSON.stringify(s[k]) !== JSON.stringify(def[k]));
  eq(leaked, [], 'these fields leaked from A into B:');
});
t('specifically: reminders / people / peopleTags / peopleLevelNames', () => {
  let s = switchTo(defaultProfileState(), PROFILE_A);
  s = switchTo(s, {});
  eq(s.reminders, [], 'stale reminders:');
  eq(s.people, [], 'stale people:');
  eq(s.peopleTags, [], 'stale peopleTags:');
  eq(s.peopleLevelNames, defaultProfileState().peopleLevelNames, 'stale peopleLevelNames:');
  eq(s.peopleSettings, { defaultSort: 'promise' }, 'stale peopleSettings:');
});
t('and the conditional fields: notebook / calendarDefaults / aiConfirmMode', () => {
  let s = switchTo(defaultProfileState(), PROFILE_A);
  s = switchTo(s, {});
  eq(s.notebook, { sections: [] }, 'stale notebook:');
  eq(s.calendarDefaults.timedReminders, [60, 10], 'stale calendarDefaults:');
  eq(s.aiConfirmMode, 'calendar', 'stale aiConfirmMode:');
});
t('optional fields are DELETED, not left stale', () => {
  let s = switchTo(defaultProfileState(), PROFILE_A);
  ok(s.trialStart === '2026-01-01', 'A trialStart should load');
  s = switchTo(s, {});
  ok(!('trialStart' in s), 'trialStart must be absent, got ' + s.trialStart);
  ok(!('entitlement' in s), 'entitlement must be absent');
  ok(!('onboardDone' in s), 'onboardDone must be absent');
  ok(!('_personalOrder' in s), '_personalOrder must be absent');
  ok(!('_workOrder' in s), '_workOrder must be absent');
});

console.log('\n=== 3. EMPTY Profile A → populated Profile B ===');
t('B loads fully from an empty starting state', () => {
  let s = switchTo(defaultProfileState(), {});
  s = switchTo(s, PROFILE_A);
  eq(s.tasks.length, 1, 'tasks:'); eq(s.reminders.length, 1, 'reminders:');
  eq(s.people.length, 1, 'people:'); eq(s.notebook.sections.length, 1, 'notebook:');
  eq(s.aiConfirmMode, 'all', 'aiConfirmMode:');
  eq(s.trialStart, '2026-01-01', 'trialStart:');
});

console.log('\n=== 4. Repeated switching in both directions ===');
t('A→B→A→B→A stays clean and correct every time', () => {
  const B = { tasks: [{ id: 'b1', text: 'B task', bucket: 'week', ord: 0 }], lifeRhythm: 'B rhythm' };
  let s = defaultProfileState();
  for (let round = 0; round < 3; round++) {
    s = switchTo(s, PROFILE_A);
    eq(s.reminders.length, 1, 'round ' + round + ' A reminders:');
    eq(s.tasks[0].text, 'A task', 'round ' + round + ' A task:');
    eq(s.lifeRhythm, 'A rhythm', 'round ' + round + ' A rhythm:');

    s = switchTo(s, B);
    eq(s.reminders, [], 'round ' + round + ' B inherited reminders:');
    eq(s.people, [], 'round ' + round + ' B inherited people:');
    eq(s.tasks[0].text, 'B task', 'round ' + round + ' B task:');
    eq(s.lifeRhythm, 'B rhythm', 'round ' + round + ' B rhythm:');
    ok(!('trialStart' in s), 'round ' + round + ' B inherited trialStart');
  }
});

console.log('\n=== 5. Individually missing fields ===');
// Documented legacy migrations: when the field is absent, hydration derives a
// value from ANOTHER field of the SAME document. That is not contamination, so
// these are asserted separately (and still checked against A's value below).
//   checkinLevel: absent + habitCatchupEnabled===false → 'off'
const MIGRATED_WHEN_ABSENT = {
  checkinLevel: doc => (doc.habitCatchupEnabled === false ? 'off' : undefined)
};

t('omitting ANY single field yields that field\'s default, never A\'s value', () => {
  const bad = [];
  for (const key of A_KEYS) {
    let s = switchTo(defaultProfileState(), PROFILE_A);
    const partial = Object.assign({}, PROFILE_A); delete partial[key];
    s = switchTo(s, partial);
    const def = defaultProfileState();
    const migrated = MIGRATED_WHEN_ABSENT[key] && MIGRATED_WHEN_ABSENT[key](partial);
    const acceptable = [JSON.stringify(def[key])];
    if (migrated !== undefined) acceptable.push(JSON.stringify(migrated));
    if (!acceptable.includes(JSON.stringify(s[key]))) {
      bad.push(key + ' → ' + JSON.stringify(s[key]));
    }
  }
  eq(bad, [], 'fields that inherited instead of defaulting:');
});

t('omitting ANY single field never yields the value Profile A had', () => {
  // The strict contamination check: whatever the result is (default OR a
  // documented migration), it must never equal what A held for that field.
  const bad = [];
  for (const key of A_KEYS) {
    const def = defaultProfileState();
    // Skip fields where A's value legitimately equals the default anyway —
    // there is nothing to distinguish and no leak is observable.
    if (JSON.stringify(PROFILE_A[key]) === JSON.stringify(def[key])) continue;
    let s = switchTo(defaultProfileState(), PROFILE_A);
    const partial = Object.assign({}, PROFILE_A); delete partial[key];
    s = switchTo(s, partial);
    if (JSON.stringify(s[key]) === JSON.stringify(PROFILE_A[key])) {
      bad.push(key + ' still held A\'s value ' + JSON.stringify(s[key]));
    }
  }
  eq(bad, [], 'fields that leaked A\'s value:');
});

console.log('\n=== 6. Corrupt / wrong-typed values fall back to defaults ===');
t('wrong types never crash and never inherit', () => {
  let s = switchTo(defaultProfileState(), PROFILE_A);
  s = switchTo(s, { tasks: 'not-an-array', reminders: 42, people: { nope: true },
                    notebook: 'bad', calendarDefaults: 7, dayNotes: [], routineLog: null,
                    peopleLevelNames: ['too', 'few'] });
  eq(s.tasks, [], 'tasks:'); eq(s.reminders, [], 'reminders:'); eq(s.people, [], 'people:');
  eq(s.notebook, { sections: [] }, 'notebook:');
  eq(s.calendarDefaults.timedReminders, [60, 10], 'calendarDefaults:');
  eq(s.routineLog, {}, 'routineLog:');
  eq(s.peopleLevelNames.length, 5, 'peopleLevelNames re-defaulted:');
});

console.log('\n=== 7. Structural guard — future fields are hard to omit ===');
t('every field the save payload writes is declared in the factory', () => {
  const p = src.match(/function _buildSavePayload\(\)\{([\s\S]*?)\n  return payload;/);
  ok(p, 'could not locate _buildSavePayload');
  const written = new Set();
  for (const m of p[1].matchAll(/payload\.(\w+)\s*=/g)) written.add(m[1]);
  const inline = p[1].match(/const payload=\{([\s\S]*?)\};/);
  if (inline) for (const m of inline[1].matchAll(/(\w+)\s*:/g)) written.add(m[1]);
  // Not profile state: server timestamp, and the API key written separately.
  ['updatedAt', 'ak'].forEach(k => written.delete(k));
  const missing = [...written].filter(k => !PROFILE_STATE_KEYS.includes(k));
  eq(missing, [], 'saved to Firestore but NOT declared in defaultProfileState():');
});
t('hydrateProfileState assigns on every path (no bare "keep old" returns)', () => {
  const fn = extractFn('hydrateProfileState');
  ok(!/if\(d\[k\]===undefined\)return;/.test(fn),
     'found the old "absent → keep previous value" guard');
});

console.log('\n=== 8. Global (device) state is NOT profile-scoped ===');
t('soundsEnabled is global and excluded from the profile factory', () => {
  ok(!PROFILE_STATE_KEYS.includes('soundsEnabled'), 'soundsEnabled must not be profile-scoped');
  ok(/GLOBAL_STATE_KEYS\s*=\s*\['soundsEnabled'\]/.test(src), 'GLOBAL_STATE_KEYS must declare it');
});
t('a profile switch does not clear global state', () => {
  const s = defaultProfileState(); s.soundsEnabled = true;
  const after = resetVia(s);
  eq(after.soundsEnabled, true, 'global state was wiped by the profile reset:');
});

console.log('\n=== 9. Save safety during a profile switch ===');
t('switchProfile flushes pending writes BEFORE changing the active profile', () => {
  const fn = extractFn('switchProfile');
  const flush = fn.indexOf('flushPendingSaves');
  const change = fn.indexOf('_activeProfileId=id');
  ok(flush > -1, 'switchProfile must call flushPendingSaves()');
  ok(change > -1, 'switchProfile must set _activeProfileId');
  ok(flush < change, 'flush must happen BEFORE _activeProfileId changes');
});
t('switchProfile raises the write barrier before changing profile', () => {
  const fn = extractFn('switchProfile');
  ok(fn.indexOf('_profileSwitching=true') < fn.indexOf('_activeProfileId=id'),
     '_profileSwitching must be set before _activeProfileId changes');
});
t('both save entry points refuse to write mid-switch', () => {
  ok(/_profileSwitching\)\{console\.warn\('\[save\] skipped/.test(extractFn('svAll')),
     'svAll must bail while switching');
  ok(/_profileSwitching\)\{console\.warn\('\[save-now\] skipped/.test(extractFn('svAllNow')),
     'svAllNow must bail while switching');
});
t('the save loop itself refuses and breaks mid-drain', () => {
  const fn = extractFn('_saveLoop');
  ok(/if\(_profileSwitching\)\{console\.warn/.test(fn), '_saveLoop must bail on entry');
  ok(/if\(_profileSwitching\)break;/.test(fn), '_saveLoop must break if a switch starts mid-drain');
});
t('the barrier is lifted only when a snapshot completes hydration', () => {
  const sites = (src.match(/_initialSyncDone=true;_profileSwitching=false;/g) || []).length;
  const total = (src.match(/_initialSyncDone=true;/g) || []).length;
  eq(sites, total, 'every _initialSyncDone=true site must also clear _profileSwitching:');
});

console.log('\n=== 10. Step 3 autosave engine — no regression ===');
t('coalescing, retry and backoff are intact', () => {
  const fn = extractFn('_saveLoop');
  ok(/while\(_saveDirty\)/.test(fn), 'coalescing while-loop missing');
  ok(/_saveDirty=false;/.test(fn), 'dirty flag capture missing');
  ok(/_saveRetry>SAVE_MAX_RETRY/.test(fn), 'retry cap missing');
  ok(/Math\.min\(30000,500\*Math\.pow\(2,_saveRetry-1\)\)/.test(fn), 'exponential backoff missing');
  ok(/NEVER revert local state/.test(fn), 'no-revert guarantee comment/behaviour missing');
});
t('echo suppression + busy-deferral still present', () => {
  ok(/if\(_initialSyncDone&&snap\.metadata\.hasPendingWrites\)return;/.test(src),
     'write-echo suppression missing');
  ok(/if\(_stateFp\(\)===_fpBefore\)return;/.test(src), 'state fingerprint short-circuit missing');
  ok(/if\(_isUserBusy\(\)\)\{_deferredRemoteRender=true;return;\}/.test(src),
     'typing/dragging deferral missing');
});
t('pre-sync write protection still present', () => {
  ok(/if\(!_initialSyncDone\)\{console\.warn\('\[save\] skipped/.test(extractFn('svAll')),
     'svAll pre-sync guard missing');
});

console.log('\n' + (fail === 0 ? '✔ ALL PASS' : '✘ FAILURES: ' + fail) + '   (' + pass + ' passed)');
process.exit(fail ? 1 : 0);
