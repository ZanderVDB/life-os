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
  ${extractFn('_exportDocRole')}
  ${extractFn('_exportClassify')}
  ${extractFn('_exportVerify')}
  const EXPORT_VOLATILE_DOCS=['presence'];
  return { _exportSerializeValue, _exportDeserializeValue, _exportStableString,
           _exportCountFields, _exportVerify, _exportDocRole, _exportClassify };
`)(TextEncoder, s => Buffer.from(s, 'binary').toString('base64'));

const { _exportSerializeValue: ser, _exportDeserializeValue: deser,
        _exportStableString: stable, _exportCountFields: count,
        _exportVerify: verify, _exportDocRole: role, _exportClassify: classify } = sandbox;

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

console.log('\n=== 6. Document roles + presence policy ===');
t('presence is classified volatile, metadata-only and non-restorable', () => {
  const r = role('presence', ['main', 'p_biz']);
  eq(r.role, 'presence'); eq(r.volatile, true); eq(r.restorable, false);
  ok(/rewritten/i.test(r.reason), 'must explain why');
});
t('_index and profile documents are restorable and verified', () => {
  eq(role('_index', ['main']).volatile, false);
  eq(role('_index', ['main']).restorable, true);
  eq(role('main', ['main']).role, 'profile');
  eq(role('main', ['main']).volatile, false);
});
t('an unrecognised document defaults to FULL capture + verification', () => {
  const r = role('something_new', ['main']);
  eq(r.role, 'unknown'); eq(r.volatile, false); eq(r.restorable, true);
});

console.log('\n=== 7. Verification against a live-shaped export (4 docs, 2 profiles) ===');
// Mirrors the real account shape: _index + 2 profiles + presence.
const liveExp = () => ({
  exportFormat: 'life-os-firestore-export', exportVersion: 1,
  userId: 'uid-synthetic', firebaseProjectId: 'proj-synthetic',
  activeProfileId: 'main',
  profiles: [{ id: 'main', name: 'P1' }, { id: 'p_biz', name: 'P2' }],
  documents: {
    _index:   { path: 'u/d/_index',   role: 'index',    verified: true,  fieldCount: 12, fingerprint: 'f-index', data: {} },
    main:     { path: 'u/d/main',     role: 'profile',  verified: true,  fieldCount: 900, fingerprint: 'f-main', data: {} },
    p_biz:    { path: 'u/d/p_biz',    role: 'profile',  verified: true,  fieldCount: 120, fingerprint: 'f-biz',  data: {} },
    presence: { path: 'u/d/presence', role: 'presence', verified: false, volatile: true, contentOmitted: true,
                fieldCount: 3, fingerprint: 'f-pres', data: null }
  }
});
const read = (over) => ([
  { id: '_index',   path: 'u/d/_index',   role: 'index',    volatile: false, fieldCount: 12,  fingerprint: 'f-index', updatedAtIso: '2026-07-31T01:00:00Z' },
  { id: 'main',     path: 'u/d/main',     role: 'profile',  volatile: false, fieldCount: 900, fingerprint: 'f-main',  updatedAtIso: '2026-07-31T01:00:00Z' },
  { id: 'p_biz',    path: 'u/d/p_biz',    role: 'profile',  volatile: false, fieldCount: 120, fingerprint: 'f-biz',   updatedAtIso: '2026-07-31T00:50:00Z' },
  { id: 'presence', path: 'u/d/presence', role: 'presence', volatile: true,  fieldCount: 3,   fingerprint: 'f-pres',  updatedAtIso: '2026-07-31T01:00:05Z' }
].map(d => Object.assign(d, (over || {})[d.id] || {})));

t('a clean live-shaped export VERIFIES', () => {
  const v = verify(liveExp(), read(), read());
  ok(v.ok, 'should pass, failed: ' + JSON.stringify(v.failed));
  eq(v.status, 'VERIFIED');
  ok(v.checks.length >= 12, 'expected 12+ checks, got ' + v.checks.length);
});

t('THE LIVE BUG: a changing presence heartbeat must NOT fail the export', () => {
  // Exactly what happened: presence rewritten every 10s by the exporting tab.
  const b = read({ presence: { fingerprint: 'f-pres-CHANGED', updatedAtIso: '2026-07-31T01:00:15Z' } });
  const v = verify(liveExp(), read(), b);
  ok(v.ok, 'volatile presence must not invalidate a valid backup — failed: ' + JSON.stringify(v.failed));
  eq(v.status, 'VERIFIED');
});
t('presence changing field count also does not fail it', () => {
  const b = read({ presence: { fieldCount: 99, fingerprint: 'x' } });
  ok(verify(liveExp(), read(), b).ok, 'presence field count must be ignored');
});

t('a REAL profile write during export → CONCURRENT CHANGE (not corruption)', () => {
  const b = read({ main: { fingerprint: 'f-main-v2', updatedAtIso: '2026-07-31T01:00:09Z' } });
  const v = verify(liveExp(), read(), b);
  ok(!v.ok, 'must fail');
  eq(v.status, 'FAILED — CONCURRENT CHANGE DETECTED');
  ok(v.failed.includes('no_concurrent_writes'), 'failed: ' + v.failed);
  const c = v.checks.find(x => x.name === 'no_concurrent_writes');
  eq(c.category, 'concurrent-write detection');
  ok(c.path.includes('u/d/main'), 'must name the affected document path');
});
t('content changing WITHOUT updatedAt moving → DATA MISMATCH (checksum stability)', () => {
  const b = read({ main: { fingerprint: 'f-main-v2' } });   // updatedAt unchanged
  const v = verify(liveExp(), read(), b);
  eq(v.status, 'FAILED — DATA MISMATCH');
  ok(v.failed.includes('fingerprints_match_second_read'), 'failed: ' + v.failed);
  eq(v.checks.find(x => x.name === 'fingerprints_match_second_read').category, 'checksum stability');
});
t('a document disappearing between reads is caught', () => {
  const v = verify(liveExp(), read(), read().filter(d => d.id !== 'p_biz'));
  ok(!v.ok);
  ok(v.failed.includes('document_set_stable'), 'failed: ' + v.failed);
});
t('a profile in the index but missing from the export → INCOMPLETE', () => {
  const e = liveExp(); delete e.documents.p_biz;
  const v = verify(e, read().filter(d => d.id !== 'p_biz'), read().filter(d => d.id !== 'p_biz'));
  ok(v.failed.includes('every_indexed_profile_exported'), 'failed: ' + v.failed);
  eq(v.status, 'FAILED — INCOMPLETE EXPORT');
});
t('an orphaned/unrecognised document is reported', () => {
  const e = liveExp();
  e.documents.stale_leftover = { path: 'u/d/stale_leftover', role: 'unknown', verified: true, fieldCount: 2, fingerprint: 'f-x', data: {} };
  const extra = read().concat([{ id: 'stale_leftover', path: 'u/d/stale_leftover', role: 'unknown', volatile: false, fieldCount: 2, fingerprint: 'f-x', updatedAtIso: null }]);
  const v = verify(e, extra, extra);
  ok(v.failed.includes('no_orphaned_profile_documents'), 'failed: ' + v.failed);
});
t('a missing active profile is caught', () => {
  const e = liveExp(); e.activeProfileId = 'ghost';
  ok(verify(e, read(), read()).failed.includes('active_profile_present'));
});
t('a duplicated profile in the index is caught', () => {
  const e = liveExp(); e.profiles.push({ id: 'main', name: 'dupe' });
  ok(verify(e, read(), read()).failed.includes('no_duplicate_profiles'));
});
t('serialisation damage is caught and classified first', () => {
  const e = liveExp(); e.documents.main.data = { x: { __t: 'circular' } };
  const v = verify(e, read(), read());
  eq(v.status, 'FAILED — SERIALISATION ERROR');
  ok(v.failed.includes('no_circular_values'));
});
t('missing restore identity is caught', () => {
  const e = liveExp(); delete e.userId;
  ok(verify(e, read(), read()).failed.includes('has_restore_identity'));
});

console.log('\n=== 8. Failure classification is deterministic ===');
t('every status string is one of the six documented values', () => {
  const allowed = ['VERIFIED', 'FAILED — DATA MISMATCH', 'FAILED — INCOMPLETE EXPORT',
                   'FAILED — CONCURRENT CHANGE DETECTED', 'FAILED — SERIALISATION ERROR',
                   'FAILED — UNKNOWN'];
  const cases = [
    verify(liveExp(), read(), read()).status,
    verify(liveExp(), read(), read({ main: { fingerprint: 'z', updatedAtIso: 'later' } })).status,
    verify(liveExp(), read(), read({ main: { fingerprint: 'z' } })).status
  ];
  cases.forEach(s => ok(allowed.includes(s), 'unexpected status: ' + s));
});
t('an unknown failure falls back to FAILED — UNKNOWN', () => {
  eq(classify([{ name: 'something_else', ok: false }]), 'FAILED — UNKNOWN');
});

console.log('\n=== 9. Diagnostic output exposes NO private content ===');
t('failure records carry only paths, counts, hashes and explanations', () => {
  const v = verify(liveExp(), read(), read({ main: { fingerprint: 'f-main-v2', updatedAtIso: 'later' } }));
  const c = v.checks.find(x => x.name === 'no_concurrent_writes');
  const keys = Object.keys(c).sort();
  const allowed = ['name', 'ok', 'category', 'expected', 'actual', 'path', 'explanation', 'documents'].sort();
  keys.forEach(k => ok(allowed.includes(k), 'unexpected key in a check result: ' + k));
  // The nested per-document records must be metadata only.
  (c.documents || []).forEach(d => {
    Object.keys(d).forEach(k => ok(
      ['path', 'role', 'expected', 'actual', 'updatedAtChanged'].includes(k),
      'unexpected key in a failure document record: ' + k));
  });
});
t('checksums are truncated in failure records', () => {
  const v = verify(liveExp(), read(), read({ main: { fingerprint: 'abcdef0123456789abcdef', updatedAtIso: 'later' } }));
  const c = v.checks.find(x => x.name === 'no_concurrent_writes');
  ok(c.documents[0].actual.endsWith('…'), 'fingerprints should be truncated: ' + c.documents[0].actual);
});

console.log('\n=== 10. Byte sizes + canonical form are deterministic ===');
t('the same content always produces the same canonical string and size', () => {
  const doc = { tasks: [{ id: 'a', n: 1 }], m: { z: 1, a: 2 }, ts: new FakeTimestamp(1750000000, 7) };
  const s1 = stable(ser(doc)), s2 = stable(ser(doc));
  eq(s1, s2, 'canonical form must be stable:');
  eq(new TextEncoder().encode(s1).length, new TextEncoder().encode(s2).length, 'byte size:');
});
t('a resolved server timestamp is stable across reads', () => {
  const a = ser({ updatedAt: new FakeTimestamp(1750000000, 7) });
  const b = ser({ updatedAt: new FakeTimestamp(1750000000, 7) });
  eq(stable(a), stable(b), 'identical timestamps must serialise identically:');
});
t('a PENDING server timestamp (null) vs resolved is correctly seen as different', () => {
  // This is a genuine difference, not a false positive: it means the write
  // landed between the two reads.
  const pending = ser({ updatedAt: null });
  const resolved = ser({ updatedAt: new FakeTimestamp(1750000000, 0) });
  ok(stable(pending) !== stable(resolved), 'must be detected as a real change');
});

console.log('\n=== 11. Read-only guarantees (static analysis of the shipped code) ===');
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

t('the local diagnostic reader performs no uploads, network calls or writes', () => {
  const fn = extractFn('_exportInspectFile');
  [/fetch\(/, /XMLHttpRequest/, /sendBeacon/, /\.set\(/, /\.update\(/, /\.delete\(\s*\)/,
   /localStorage/, /anthropic/i, /firestore/i].forEach(re => {
    ok(!re.test(fn), 'diagnostic reader must not contain ' + re);
  });
  ok(/FileReader/.test(fn), 'must read from disk via FileReader');
  ok(/readAsText/.test(fn), 'must read the file locally');
});
t('the diagnostic reader never surfaces document content', () => {
  const fn = extractFn('_exportInspectFile');
  // It may report whether data exists, but must never read into it.
  ok(/hasData:/.test(fn), 'should report presence of data as a boolean');
  ok(!/JSON\.stringify\(docs\[id\]\.data/.test(fn), 'must not serialise document data');
  ok(!/\.data\./.test(fn.replace(/docs\[id\]\.data!=null/g, '')), 'must not read into document data');
});
t('the retry path never writes and never silently claims success', () => {
  const fn = extractFn('losExport');
  [/\.set\(/, /\.update\(/, /\.delete\(\s*\)/, /svAll\(/].forEach(re =>
    ok(!re.test(fn), 'retry path must not write: ' + re));
  ok(/verification\.ok/.test(fn), 'must gate on the real verification result');
  ok(/status:v\.status/.test(fn), 'must report the real status, never a hardcoded pass');
  ok(!/status:'VERIFIED'/.test(fn), 'must never hardcode VERIFIED');
});
t('the export waits for pending saves before reading', () => {
  ok(/await _exportWaitForQuiet\(/.test(extractFn('buildFirestoreExport')),
     'buildFirestoreExport must wait for quiescence');
  const q = extractFn('_exportWaitForQuiet');
  ok(/_saveDirty/.test(q) && /_saveLooping/.test(q), 'must check both save flags');
});
t('volatile documents are exported metadata-only, with the omission recorded', () => {
  const fn = extractFn('buildFirestoreExport');
  ok(/contentOmitted:true/.test(fn), 'must record that content was omitted');
  ok(/omissionReason/.test(fn), 'must record WHY it was omitted');
  ok(/data:null/.test(fn), 'volatile document content must not be stored');
  ok(/volatileDocuments/.test(fn), 'the export must list which documents were treated as volatile');
});

console.log('\n=== 12. Export privacy is enforced by .gitignore ===');
t('export filenames are git-ignored', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  ok(/life-os-export_\*\.json/.test(gi), 'must ignore life-os-export_*.json');
  ok(/firestore-export/.test(gi), 'must ignore *firestore-export*.json');
});

console.log('\n' + (fail === 0 ? '✔ ALL PASS' : '✘ FAILURES: ' + fail) + '   (' + pass + ' passed)');
process.exit(fail ? 1 : 0);
