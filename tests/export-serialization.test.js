/*
 * Phase A3 — protected Firestore export: serialisation + verification tests.
 *
 * Extracts the REAL functions from index.html and runs them in Node.
 * Uses SYNTHETIC data only — no live private content appears here.
 *
 * Run:  node tests/export-serialization.test.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const sandbox = new Function('TextEncoder', 'btoa', `
  ${extractFn('_exportSerializeValue')}
  ${extractFn('_exportDeserializeValue')}
  ${extractFn('_exportStableString')}
  ${extractFn('_exportCountFields')}
  ${extractFn('_exportVerify')}
  return { _exportSerializeValue, _exportDeserializeValue, _exportStableString,
           _exportCountFields, _exportVerify };
`)(TextEncoder, s => Buffer.from(s, 'binary').toString('base64'));

const { _exportSerializeValue: ser, _exportDeserializeValue: deser,
        _exportStableString: stable, _exportCountFields: count,
        _exportVerify: verify } = sandbox;

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n          ' + e.message); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };
// Canonical (key-sorted) compare. The serialiser sorts keys deliberately so
// fingerprints are stable, so round-trip equality is checked by VALUE, not by
// key order.
const canon = v => (v === null || typeof v !== 'object') ? JSON.stringify(v)
  : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
const eqDeep = (a, b, m) => { if (canon(a) !== canon(b))
  throw new Error((m || '') + ' expected ' + canon(b) + ' got ' + canon(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };

// A fake Firestore Timestamp, shaped like the compat SDK's.
function FakeTimestamp(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
FakeTimestamp.prototype.toDate = function () { return new Date(this.seconds * 1000); };

console.log('\n=== 1. Primitives round-trip exactly ===');
t('strings, numbers, booleans, null', () => {
  const v = { s: 'hello', n: 42, f: 1.5, neg: -7, zero: 0, tt: true, ff: false, nul: null, empty: '' };
  eqDeep(deser(ser(v)), v);
});
t('empty array and empty object survive', () => {
  eqDeep(deser(ser({ a: [], o: {} })), { a: [], o: {} });
});
t('nested structures survive', () => {
  const v = { a: [1, { b: [2, { c: 'deep' }] }], d: { e: { f: [null, true] } } };
  eqDeep(deser(ser(v)), v);
});
t('unicode and newlines survive', () => {
  const v = { t: 'line1\nline2\t— émoji 🌸 "quoted" \\backslash' };
  eq(deser(ser(v)), v);
});

console.log('\n=== 2. Special values are boxed reversibly (not silently lost) ===');
t('undefined is preserved as a marker, not dropped', () => {
  const s = ser({ a: undefined, b: 1 });
  eq(s.a, { __t: 'undefined' }, 'undefined marker:');
  ok('a' in s, 'the key itself must survive');
  ok(deser(s).a === undefined, 'round-trips back to undefined');
});
t('NaN and Infinity survive', () => {
  const s = ser({ n: NaN, i: Infinity, ni: -Infinity });
  eq(s.n, { __t: 'number', v: 'NaN' });
  ok(Number.isNaN(deser(s).n), 'NaN round-trip');
  ok(deser(s).i === Infinity, 'Infinity round-trip');
});
t('Firestore Timestamps keep seconds, nanoseconds AND a readable ISO', () => {
  const ts = new FakeTimestamp(1750000000, 123456789);
  const s = ser({ updatedAt: ts });
  eq(s.updatedAt.__t, 'timestamp');
  eq(s.updatedAt.seconds, 1750000000, 'seconds:');
  eq(s.updatedAt.nanoseconds, 123456789, 'nanoseconds:');
  ok(/^\d{4}-\d{2}-\d{2}T/.test(s.updatedAt.iso), 'iso present: ' + s.updatedAt.iso);
  const back = deser(s).updatedAt;
  eq(back.seconds, 1750000000, 'restored seconds:');
  eq(back.nanoseconds, 123456789, 'restored nanoseconds:');
});
t('a Timestamp with nanoseconds:0 keeps 0 (not dropped)', () => {
  eq(ser({ x: new FakeTimestamp(1, 0) }).x.nanoseconds, 0);
});
t('Date objects survive', () => {
  const d = new Date('2026-07-31T09:15:00.000Z');
  eq(ser({ d }).d, { __t: 'date', iso: '2026-07-31T09:15:00.000Z' });
  ok(deser(ser({ d })).d instanceof Date, 'restores to a Date');
});
t('circular references are marked, never thrown', () => {
  const a = { name: 'a' }; a.self = a;
  const s = ser({ a });
  eq(s.a.self, { __t: 'circular' });
  ok(JSON.stringify(s).length > 0, 'must remain serialisable');
});
t('functions are marked unsupported rather than silently dropped', () => {
  eq(ser({ fn: function () {} }).fn, { __t: 'unsupported', repr: 'function' });
});

console.log('\n=== 3. UNKNOWN fields are preserved (legacy / future data) ===');
t('fields the app does not recognise are exported verbatim', () => {
  const doc = {
    tasks: [{ id: 't1', text: 'x' }],
    someLegacyFieldFrom2024: { nested: [1, 2, 3] },
    aFutureFieldNobodyKnowsYet: 'keep me',
    _weirdInternal: true
  };
  const back = deser(ser(doc));
  eqDeep(back, doc, 'unknown fields must survive untouched (order is normalised on purpose):');
});
t('key ORDER does not affect the serialised form (stable)', () => {
  eq(stable(ser({ b: 1, a: 2 })), stable(ser({ a: 2, b: 1 })));
});

console.log('\n=== 4. Fingerprints ===');
t('identical content → identical fingerprint', () => {
  eq(sha(stable(ser({ a: [1, 2], b: 'x' }))), sha(stable(ser({ b: 'x', a: [1, 2] }))));
});
t('any content change → different fingerprint', () => {
  ok(sha(stable(ser({ a: 1 }))) !== sha(stable(ser({ a: 2 }))), 'value change');
  ok(sha(stable(ser({ a: [1, 2] }))) !== sha(stable(ser({ a: [2, 1] }))), 'array order change');
  ok(sha(stable(ser({ a: 1 }))) !== sha(stable(ser({ a: '1' }))), 'type change');
});

console.log('\n=== 5. Field counting ===');
t('counts nested fields deterministically', () => {
  eq(count({ a: 1, b: { c: 2 } }), 5, '{a,1,b,{c,2}} =');   // a+val + b + (c+val) = 5
  eq(count({}), 0, 'empty object:');
  eq(count({ list: [1, 2, 3] }), 4, 'list + 3 items:');
});

console.log('\n=== 6. Verification catches real failure modes ===');
const goodExp = () => ({
  exportFormat: 'life-os-firestore-export', exportVersion: 1,
  userId: 'uid-synthetic', firebaseProjectId: 'proj-synthetic',
  activeProfileId: 'main',
  profiles: [{ id: 'main', name: 'P1' }, { id: 'p_two', name: 'P2' }],
  documents: {
    _index: { fieldCount: 5, fingerprint: 'f-index', data: {} },
    main:   { fieldCount: 9, fingerprint: 'f-main',  data: {} },
    p_two:  { fieldCount: 7, fingerprint: 'f-two',   data: {} }
  }
});
const goodSrc = () => ([
  { id: '_index', fieldCount: 5, fingerprint: 'f-index' },
  { id: 'main',   fieldCount: 9, fingerprint: 'f-main' },
  { id: 'p_two',  fieldCount: 7, fingerprint: 'f-two' }
]);

t('a correct export passes every check', () => {
  const v = verify(goodExp(), goodSrc());
  ok(v.ok, 'should pass, failed: ' + JSON.stringify(v.failed));
  ok(v.checks.length >= 10, 'expected 10+ checks, got ' + v.checks.length);
});
t('detects a profile in the index that was NOT exported', () => {
  const e = goodExp(); delete e.documents.p_two;
  const v = verify(e, goodSrc().filter(d => d.id !== 'p_two'));
  ok(!v.ok && v.failed.includes('every_indexed_profile_exported'), 'failed: ' + v.failed);
});
t('detects a document-count mismatch', () => {
  const v = verify(goodExp(), goodSrc().slice(0, 2));
  ok(!v.ok && v.failed.includes('document_count_matches'), 'failed: ' + v.failed);
});
t('detects a field-count mismatch', () => {
  const s = goodSrc(); s[1].fieldCount = 999;
  const v = verify(goodExp(), s);
  ok(!v.ok && v.failed.includes('field_counts_match'), 'failed: ' + v.failed);
});
t('detects data changing between the two reads (fingerprint drift)', () => {
  const s = goodSrc(); s[1].fingerprint = 'CHANGED';
  const v = verify(goodExp(), s);
  ok(!v.ok && v.failed.includes('fingerprints_match_second_read'), 'failed: ' + v.failed);
});
t('detects circular / unsupported values in the payload', () => {
  const e = goodExp(); e.documents.main.data = { x: { __t: 'circular' } };
  ok(verify(e, goodSrc()).failed.includes('no_circular_values'));
  const e2 = goodExp(); e2.documents.main.data = { x: { __t: 'unsupported', repr: 'fn' } };
  ok(verify(e2, goodSrc()).failed.includes('no_unsupported_values'));
});
t('detects a missing active profile document', () => {
  const e = goodExp(); e.activeProfileId = 'ghost-profile';
  ok(verify(e, goodSrc()).failed.includes('active_profile_present'));
});
t('detects a duplicated profile in the index', () => {
  const e = goodExp(); e.profiles.push({ id: 'main', name: 'dupe' });
  ok(verify(e, goodSrc()).failed.includes('no_duplicate_profiles'));
});
t('detects missing restore identity', () => {
  const e = goodExp(); delete e.userId;
  ok(verify(e, goodSrc()).failed.includes('has_restore_identity'));
});

console.log('\n=== 7. Read-only guarantees (static analysis of the shipped code) ===');
const exportBlock = src.slice(src.indexOf('PHASE A3 — PROTECTED FIRESTORE EXPORT'),
                              src.indexOf('window.losExport=losExport;'));
t('the export path never writes to Firestore', () => {
  // NB: `seen.add(v)` / `seen.delete(v)` are JS Set operations inside the
  // serialiser's cycle detector, not Firestore writes. These patterns target
  // Firestore call shapes specifically: its delete() takes no arguments, and
  // set/update/add are only reachable off a doc/collection reference.
  const writeShapes = [
    /\.set\(/, /\.update\(/,
    /\.delete\(\s*\)/,                    // Firestore delete() — no args
    /collection\([^)]*\)\.add\(/,
    /\bsvAll\(/, /\bsvAllNow\(/, /FieldValue/
  ];
  writeShapes.forEach(re => {
    ok(!re.test(exportBlock), 'found a write-ish call matching ' + re);
  });
  // And prove the only .add(/.delete( uses are the Set-based cycle detector.
  const addDel = exportBlock.match(/\w+\.(add|delete)\(/g) || [];
  ok(addDel.every(x => x.startsWith('seen.')),
     'unexpected add/delete calls: ' + addDel.filter(x => !x.startsWith('seen.')).join(', '));
});
t('it reads from the SERVER, not the local cache', () => {
  ok(/get\(\{source:'server'\}\)/.test(exportBlock), "must use get({source:'server'})");
});
t('it never hydrates into live app state', () => {
  ok(!/hydrateProfileState|resetProfileState/.test(exportBlock), 'must not touch live state');
});
t('it never stores the export in localStorage', () => {
  ok(!/localStorage\.setItem/.test(exportBlock), 'must not persist the export locally');
});
t('it never sends the export anywhere', () => {
  ok(!/fetch\(|XMLHttpRequest|navigator\.sendBeacon|anthropic/i.test(exportBlock),
     'must not transmit the export');
});
t('the filename contains no email and no raw user id', () => {
  const fn = extractFn('_exportFilename');
  ok(!/email/i.test(fn), 'filename must not use the email');
  ok(/userIdFingerprint/.test(fn) && !/exp\.userId[^F]/.test(fn), 'must use the fingerprint, not the raw uid');
});
t('no document content is printed to the console', () => {
  const dl = extractFn('losExport');
  ok(!/console\.log\([^)]*\.data/.test(dl), 'must never log document data');
  ok(/perDocument/.test(dl) && /fieldCount|fields:/.test(dl), 'summary should be counts only');
});

console.log('\n=== 8. Export privacy is enforced by .gitignore ===');
t('export filenames are git-ignored', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  ok(/life-os-export_\*\.json/.test(gi), 'must ignore life-os-export_*.json');
  ok(/firestore-export/.test(gi), 'must ignore *firestore-export*.json');
});

console.log('\n' + (fail === 0 ? '✔ ALL PASS' : '✘ FAILURES: ' + fail) + '   (' + pass + ' passed)');
process.exit(fail ? 1 : 0);
