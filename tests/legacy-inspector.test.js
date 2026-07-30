/*
 * Phase A2 — legacy data inspector tests.
 *
 * Extracts the REAL functions from index.html and runs them in Node.
 * SYNTHETIC data only. The synthetic records deliberately contain obvious
 * "secret" strings so the privacy tests can prove none of them ever reach the
 * report.
 *
 * Run:  node tests/legacy-inspector.test.js
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
  const start = src.indexOf('const ' + name + '=');
  if (start < 0) throw new Error('could not find const ' + name);
  let depth = 0, end = -1, started = false;
  for (let p = start; p < src.length; p++) {
    if (src[p] === '{' || src[p] === '[') { depth++; started = true; }
    else if (src[p] === '}' || src[p] === ']') { depth--; if (started && depth === 0) { end = src.indexOf(';', p) + 1; break; } }
    else if (!started && src[p] === ';') { end = p + 1; break; }
  }
  return src.slice(start, end);
}

const sandbox = new Function('TextEncoder', `
  ${extractFn('_exportSerializeValue')}
  ${extractFn('_exportStableString')}
  ${extractFn('_inspHash')}
  ${extractFn('_inspBytes')}
  ${extractFn('_inspShape')}
  ${extractConst('_ISO_DATE')}
  ${extractFn('_inspScanDates')}
  ${extractConst('LEGACY_REGISTRY')}
  ${extractFn('_inspDataset')}
  return { _inspHash, _inspBytes, _inspShape, _inspScanDates, _inspDataset, LEGACY_REGISTRY };
`)(TextEncoder);

const { _inspHash: hash, _inspShape: shape, _inspScanDates: dates,
        _inspDataset: inspect, LEGACY_REGISTRY: REG } = sandbox;

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n          ' + e.message); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };

// ── Synthetic data with unmistakable "secret" markers ─────────────────────
const SECRETS = ['SECRET_TASK_TITLE', 'SECRET_DIARY_TEXT', 'SECRET_PERSON_NAME',
                 'SECRET_NOTE_BODY', 'SECRET_REMINDER_TEXT', 'SECRET_PROJECT_DESC'];
const SYNTH = {
  tasks: [
    { id: 'aaa1111', text: 'SECRET_TASK_TITLE one', done: false, date: '2025-03-04', dailyDate: '2025-03-04', notes: 'SECRET_NOTE_BODY' },
    { id: 'bbb2222', text: 'SECRET_TASK_TITLE two', done: true, date: '2026-01-15', doneAt: 1768000000000, linkedPersonId: 'p1' }
  ],
  people: [{ id: 'p1', name: 'SECRET_PERSON_NAME', promises: [{ id: 'pr1', text: 'SECRET_NOTE_BODY', addedAt: 1750000000000 }] }],
  peopleTags: [{ id: 'tg1', name: 'family' }],
  peopleLevelNames: ['a', 'b', 'c', 'd', 'e'],
  peopleSettings: { defaultSort: 'promise' },
  reminders: [{ id: 'r1', text: 'SECRET_REMINDER_TEXT', createdAt: 1740000000000 }],
  learning: [],
  customEvents: [],
  dayNotes: { '2024-06-01': 'SECRET_DIARY_TEXT here', '2024-06-02': '', '2024-07-15': 'more SECRET_DIARY_TEXT' },
  routineLog: { '2026-07-30': { checks: { a: true }, journal: { j1: 'SECRET_DIARY_TEXT' } },
                '2026-07-29': { checks: {}, journal: { j1: '', j2: '' } } },
  habits: [{ id: 'h1', name: 'Run', checkedDates: ['2026-01-02', '2026-07-30'], createdAt: '2025-12-01' }],
  builds: [{ id: 'b1', title: 'SECRET_PROJECT_DESC', desc: 'SECRET_PROJECT_DESC', date: '2025-08-08' }]
};

console.log('\n=== 1. Hashing ===');
t('hashes are stable, short and non-reversible-looking', () => {
  eq(hash('abc'), hash('abc'), 'stable:');
  ok(hash('abc') !== hash('abd'), 'different inputs differ');
  eq(hash('abc').length, 8, 'length:');
  ok(!hash('SECRET_PERSON_NAME').includes('SECRET'), 'must not embed the input');
});

console.log('\n=== 2. Shape classification (never content) ===');
t('classifies every value kind correctly', () => {
  eq(shape([]), 'empty-array'); eq(shape([1]), 'array');
  eq(shape({}), 'empty-object'); eq(shape({ a: 1 }), 'object');
  eq(shape(''), 'empty-string'); eq(shape('   '), 'empty-string');
  eq(shape('SECRET'), 'string'); eq(shape(null), 'null');
  eq(shape(undefined), 'undefined'); eq(shape(5), 'number'); eq(shape(true), 'boolean');
});
t('handles MIXED value shapes safely', () => {
  const r = inspect('dayNotes', { a: 'text', b: {}, c: [], d: null, e: 5 });
  eq(r.count, 5, 'count:');
  ok(Object.keys(r.valueShapes).length >= 3, 'should tally several shapes: ' + JSON.stringify(r.valueShapes));
});

console.log('\n=== 3. Date-range detection ===');
t('finds ISO date ranges in array records', () => {
  const r = dates(SYNTH.tasks);
  eq(r.earliest, '2025-03-04', 'earliest:'); eq(r.latest, '2026-01-15', 'latest:');
});
t('uses map KEYS as the date range for date-keyed maps', () => {
  const r = inspect('dayNotes', SYNTH.dayNotes);
  eq(r.earliest, '2024-06-01', 'earliest:'); eq(r.latest, '2024-07-15', 'latest:');
  eq(r.keyFormat, 'YYYY-MM-DD (all)', 'key format:');
});
t('detects non-date and mixed key formats', () => {
  eq(inspect('dayNotes', { foo: 1, bar: 2 }).keyFormat, 'non-date keys');
  ok(/mixed/.test(inspect('dayNotes', { '2024-01-01': 1, foo: 2 }).keyFormat));
});
t('epoch-ms fields are converted, out-of-range numbers ignored', () => {
  eq(dates([{ createdAt: 1750000000000 }]).earliest, '2025-06-15');
  eq(dates([{ count: 42 }]).earliest, null, 'a plain number must not become a date');
});

console.log('\n=== 4. Empty vs populated classification ===');
t('an empty dataset is reported as empty, not missing', () => {
  const r = inspect('learning', []);
  eq(r.present, true, 'present:'); eq(r.count, 0, 'count:'); eq(r.populated, false, 'populated:');
  eq(r.shape, 'empty-array', 'shape:');
});
t('an absent dataset is reported as absent', () => {
  const r = inspect('learning', undefined);
  eq(r.present, false); eq(r.populated, false);
});
t('structurally-empty map entries are counted separately', () => {
  const r = inspect('dayNotes', SYNTH.dayNotes);
  eq(r.count, 3, 'total keys:');
  eq(r.structurallyEmpty, 1, 'one entry is an empty string:');
  eq(r.populatedEntries, 2, 'two have content:');
});
t('routineLog days with only blank journal answers count as empty', () => {
  const r = inspect('routineLog', SYNTH.routineLog);
  eq(r.count, 2, 'days:');
  eq(r.structurallyEmpty, 1, 'the all-blank day is empty:');
});

console.log('\n=== 5. Provenance registry is complete and honest ===');
t('every registry entry carries full provenance', () => {
  Object.keys(REG).forEach(k => {
    const e = REG[k];
    ['label', 'reads', 'writes', 'ai', 'ui', 'newer', 'dest', 'risk', 'rec'].forEach(f =>
      ok(e[f] !== undefined, k + ' is missing "' + f + '"'));
    ok(Array.isArray(e.reads) && Array.isArray(e.writes), k + ' reads/writes must be arrays');
  });
});
t('recommendations use only the approved vocabulary', () => {
  const allowed = ['KEEP', 'MIGRATE', 'ARCHIVE', 'EXPORT THEN DELETE', 'DELETE', 'NEEDS CONTENT REVIEW'];
  Object.keys(REG).forEach(k => {
    const base = String(REG[k].rec).split(' (')[0];
    ok(allowed.includes(base), k + ' has an unapproved recommendation: ' + REG[k].rec);
  });
});
t('live datasets are marked KEEP, never a deletion verb', () => {
  ['tasks', 'habits', 'reminders', 'routineLog'].forEach(k =>
    eq(REG[k].rec, 'KEEP', k + ' must be KEEP:'));
});
t('no dataset is preliminarily marked DELETE outright', () => {
  Object.keys(REG).forEach(k =>
    ok(REG[k].rec !== 'DELETE', k + ' must not be auto-marked DELETE — that needs approval'));
});

console.log('\n=== 6. PRIVACY — no free text reaches the report ===');
t('inspecting every synthetic dataset leaks no secret string', () => {
  const report = {};
  Object.keys(SYNTH).forEach(k => { report[k] = inspect(k, SYNTH[k]); });
  const json = JSON.stringify(report);
  SECRETS.forEach(s => ok(!json.includes(s), 'LEAKED "' + s + '" into the report'));
});
t('the report contains no long free-text values at all', () => {
  const report = Object.keys(SYNTH).map(k => inspect(k, SYNTH[k]));
  const walk = v => {
    if (typeof v === 'string') {
      // Allowed strings are labels/shapes/dates/hashes/provenance from OUR registry,
      // never values pulled out of the data.
      ok(!/SECRET/.test(v), 'found data-derived text: ' + v);
    } else if (v && typeof v === 'object') Object.keys(v).forEach(k => walk(v[k]));
  };
  report.forEach(walk);
});
t('id hashes are collected, raw ids are not', () => {
  const r = inspect('people', SYNTH.people);
  eq(r.idHashes, [hash('p1')], 'should hash the id:');
  ok(!JSON.stringify(r).includes('"p1"'), 'raw id must not appear');
});
t('the visible panel never renders a document data field', () => {
  const panel = extractFn('_maybeShowInspectPanel');
  ok(!/\.data\b/.test(panel), 'panel must not touch document data');
  SECRETS.concat(['\\.text', '\\.title', '\\.name', '\\.body', '\\.desc', '\\.notes'])
    .forEach(p => ok(!new RegExp('get:\\s*\\w+\\s*=>\\s*\\w+' + p).test(panel),
      'panel must not render a content field matching ' + p));
});

console.log('\n=== 7. Duplicate / contamination detection ===');
t('shared record ids across profiles are detectable via hashes', () => {
  const a = { r1: hash('x'), r2: hash('y') };
  const b = { r1: hash('x'), r3: hash('z') };
  const shared = Object.keys(a).filter(id => id in b);
  eq(shared, ['r1'], 'shared ids:');
  eq(shared.filter(id => a[id] === b[id]).length, 1, 'byte-identical count:');
});
t('the contamination check covers the fields from the pre-v240 reset gap', () => {
  const fn = extractFn('buildLegacyInspection');
  ['reminders', 'people', 'peopleTags'].forEach(f =>
    ok(new RegExp("'" + f + "'").test(fn), 'contamination check must include ' + f));
  ok(/wasInResetGap/.test(fn), 'must flag which datasets were in the reset gap');
});

console.log('\n=== 8. Board / People-link special cases ===');
t('Board is reported as a view over tasks with no field of its own', () => {
  const fn = extractFn('buildLegacyInspection');
  ok(/__board/.test(fn), 'must report a board entry');
  ok(/NO persisted field of its own/.test(fn), 'must state it has no unique data');
  ok(/t\.dailyDate/.test(fn), 'must count tasks by dailyDate');
});
t('dead per-task fields are enumerated', () => {
  const c = extractConst('LEGACY_TASK_FIELDS');
  ['dailyDate', 'dailySince', 'daily', 'linkedPersonId', 'linkedPromiseId'].forEach(f =>
    ok(c.includes("'" + f + "'"), 'must check ' + f));
});

console.log('\n=== 9. READ-ONLY guarantees (static analysis of shipped code) ===');
const rawBlock = src.slice(src.indexOf('PHASE A2 — LEGACY DATA INSPECTOR'),
                           src.indexOf('// Guarded panel for devices without a console'));
// Strip comments and string literals before scanning for calls. The inspector
// deliberately DOCUMENTS which legacy functions read/write each dataset (e.g.
// "migrateHabits() legacy merge"), and the header comment says "no render()".
// Those are prose, not call sites — scanning raw text would false-positive.
function stripNonCode(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const two = s.slice(i, i + 2);
    if (two === '//') { const n = s.indexOf('\n', i); i = n < 0 ? s.length : n; continue; }
    if (two === '/*') { const n = s.indexOf('*/', i + 2); i = n < 0 ? s.length : n + 2; continue; }
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; }
      i++; out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}
const block = stripNonCode(rawBlock);
t('the stripper itself works (guards against a vacuous pass)', () => {
  ok(!/secret/.test(stripNonCode("const a='secret'; // secret\n/* secret */")), 'must remove strings + comments');
  ok(/realCall\(\)/.test(stripNonCode("realCall(); // note")), 'must keep real code');
  ok(block.length > 500, 'stripped block must still contain real code, got ' + block.length);
});
t('the inspector performs no Firestore writes', () => {
  [/\.set\(/, /\.update\(/, /\.delete\(\s*\)/, /collection\([^)]*\)\.add\(/, /FieldValue/]
    .forEach(re => ok(!re.test(block), 'found a write matching ' + re));
});
t('it does not trigger autosave', () => {
  [/\bsvAll\(/, /\bsvAllNow\(/, /_saveLoop\(/].forEach(re =>
    ok(!re.test(block), 'must not trigger a save: ' + re));
});
t('it does not hydrate live state or run migrations', () => {
  // `=(?!=)` so an ASSIGNMENT is caught but a comparison (`===`) is not —
  // the inspector legitimately READS _schemaVersion to report it.
  [/hydrateProfileState/, /resetProfileState/, /migrateHabits/, /migrateProjects/,
   /_migrateTaskBuckets/, /_schemaVersion\s*=(?!=)/].forEach(re =>
    ok(!re.test(block), 'must not mutate/migrate state: ' + re));
});
t('it never calls render()', () => {
  ok(!/[^a-zA-Z_]render\(\)/.test(block), 'must not trigger a re-render');
});
t('it reads from the SERVER', () => {
  // Inherently a string-literal check, so it scans the RAW text —
  // stripNonCode() removes literals by design.
  ok(/get\(\{source:'server'\}\)/.test(rawBlock), "must use get({source:'server'})");
  ok(/get\(\{source:/.test(block), 'and the call itself must survive stripping');
});
t('it never transmits anything', () => {
  [/fetch\(/, /XMLHttpRequest/, /sendBeacon/, /anthropic/i].forEach(re =>
    ok(!re.test(block), 'must not transmit: ' + re));
});
t('it never writes to localStorage', () => {
  ok(!/localStorage\.setItem/.test(block), 'must not persist anything');
});
t('the downloaded report is named a DIAGNOSTIC, not a backup', () => {
  const fn = extractFn('_inspFilename');
  ok(/DIAGNOSTIC/.test(fn), 'filename must say DIAGNOSTIC');
  ok(!/backup|export_/i.test(fn), 'must not look like a backup');
});
t('volatile documents are excluded from inspection', () => {
  const fn = extractFn('buildLegacyInspection');
  ok(/role!=='profile'/.test(fn), 'must only inspect profile documents');
  ok(/volatileExcluded/.test(fn), 'must record what was excluded');
});

console.log('\n=== 10. The normal UI is untouched without ?inspect=1 ===');
t('the panel is gated behind the query flag', () => {
  const fn = extractFn('_maybeShowInspectPanel');
  ok(/get\('inspect'\)==='1'/.test(fn), 'must require ?inspect=1');
  ok(/if\(!on\|\|document\.getElementById\('los-inspect-panel'\)\)return;/.test(fn),
     'must bail when the flag is absent');
});
t('nothing in the product UI references the inspector', () => {
  const uiRefs = (src.match(/losInspect\(/g) || []).length;
  ok(uiRefs <= 3, 'inspector should only be referenced by its own tooling, found ' + uiRefs);
  ok(!/onclick="losInspect/.test(src), 'must not be wired into any product control');
});

console.log('\n' + (fail === 0 ? '✔ ALL PASS' : '✘ FAILURES: ' + fail) + '   (' + pass + ' passed)');
process.exit(fail ? 1 : 0);
