/**
 * Phase D1 — Diary foundation.
 *
 * Four rules these tests exist to defend:
 *
 *   One entry per workspace per LOCAL calendar day.
 *   Reading a date never creates a row.
 *   An entry exists when a PERSON put something in it, not when an editor did.
 *   An archived entry still holds its date, so nothing is duplicated on top.
 *
 * And one that matters more than all of them: no Legacy Diary content is read,
 * written or migrated anywhere in this phase.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { freshDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import {
  isMeaningfulEntry, documentHasContent, isValidCivilDate, addDays, monthBounds,
} from '../src/lib/diary-entry.js';
import { SAMPLE_PREFIX, isDiarySampleAllowed } from '../src/lib/sample-diary.js';

const here = dirname(fileURLToPath(import.meta.url));

const TOKEN = 'test-bypass-token';
const envFor = (nodeEnv: string) => loadEnv({
  NODE_ENV: nodeEnv, PORT: '8080', LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://unused/unused',
  FIREBASE_PROJECT_ID: 'test-project',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  DEV_AUTH_BYPASS: TOKEN,
} as any);
const auth = (email = 'zander@example.com') =>
  ({ authorization: `Bearer ${TOKEN}`, 'x-dev-email': email });

async function setup(nodeEnv = 'test') {
  const { db } = await freshDb();
  const app = buildApp(db, envFor(nodeEnv));
  await app.ready();
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth() })).json();
  const ws = me.workspace.id;
  const base = `/api/v1/workspaces/${ws}`;
  const get = (url: string) => app.inject({ method: 'GET', url: base + url, headers: auth() });
  const put = (url: string, payload: any) =>
    app.inject({ method: 'PUT', url: base + url, headers: auth(), payload });
  const post = (url: string, payload?: any) =>
    app.inject({ method: 'POST', url: base + url, headers: auth(), payload: payload ?? {} });
  return { app, db, ws, base, get, put, post };
}

const doc = (text: string) =>
  ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
// `as const` on the discriminant: `Doc.type` is the literal 'doc', and a
// widened `string` is not assignable to it.
const EMPTY = { type: 'doc' as const, content: [] };
/** What a contenteditable round-trips to when nobody has typed. */
const EDITOR_BOILERPLATE = { type: 'doc', content: [{ type: 'paragraph', content: [] }] };

/* ══ §3  No Legacy migration, at all ═══════════════════════════════════ */

test('legacy: nothing in this phase reads or writes Legacy Diary content', () => {
  const roots = [join(here, '..', 'src'), join(here, '..', '..', 'web')];
  /* Diary-specific on purpose. A blanket /legacy.*entries/ matches
   * `legacyEntries` in the E1 Projects audit tool, which is unrelated to Diary
   * and predates this phase — a test that fires on that is a test nobody can
   * trust. What must never appear is a reader for Legacy's diary, notebook or
   * mood storage. */
  const banned = /legacy[-_]?(diary|notebook|mood)|readLegacyDiary|importLegacy(Diary|Notebook)/i;
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name))
      : [join(dir, e.name)].filter((f) => /\.(ts|js)$/.test(f))));
  for (const dir of roots) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8');
      assert.ok(!banned.test(src), `${file} references Legacy Diary content`);
    }
  }
});

test('the diary migration creates only, and touches nothing that exists', () => {
  const sql = readFileSync(join(here, '..', 'drizzle', '0007_diary.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE diary_entries/);
  for (const destructive of [/DROP TABLE/i, /DELETE FROM/i, /TRUNCATE/i, /ALTER TABLE (?!diary)/i]) {
    assert.ok(!destructive.test(sql), `the migration is destructive: ${destructive}`);
  }
  // No INSERT either — a migration that seeds is a migration that surprises.
  assert.ok(!/INSERT INTO/i.test(sql));
});

/* ══ §4  Civil dates, and one entry per day ════════════════════════════ */

test('a civil date is validated as a real day, not just a shape', () => {
  assert.equal(isValidCivilDate('2026-08-05'), true);
  assert.equal(isValidCivilDate('2026-02-29'), false, '2026 is not a leap year');
  assert.equal(isValidCivilDate('2024-02-29'), true, '2024 is');
  assert.equal(isValidCivilDate('2026-13-01'), false);
  assert.equal(isValidCivilDate('2026-04-31'), false, 'April has 30 days');
  assert.equal(isValidCivilDate('2026-8-5'), false, 'the shape must be padded');
  assert.equal(isValidCivilDate('not-a-date'), false);
});

test('date arithmetic never crosses a timezone', () => {
  assert.equal(addDays('2026-08-05', 1), '2026-08-06');
  assert.equal(addDays('2026-08-01', -1), '2026-07-31');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  // The one that matters in Johannesburg: a date built near midnight must not
  // slide backwards. Everything is built at noon UTC for exactly this reason.
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(monthBounds('2026-02-15'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthBounds('2024-02-15'), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(monthBounds('2026-08-05'), { from: '2026-08-01', to: '2026-08-31' });
});

test('a bad date is refused rather than coerced', async () => {
  const h = await setup();
  assert.equal((await h.get('/diary/entries/2026-02-30')).statusCode, 400);
  assert.equal((await h.get('/diary/entries/2026-13-01')).statusCode, 400);
  assert.equal((await h.get('/diary/entries/yesterday')).statusCode, 400);
  await h.app.close();
});

test('one entry per day: writing the same date twice updates, never duplicates', async () => {
  const h = await setup();
  const first = await h.put('/diary/entries/2026-08-05', { document: doc('First.') });
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().created, true);

  const second = await h.put('/diary/entries/2026-08-05', { document: doc('Second.') });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().created, false);
  assert.equal(second.json().entry.id, first.json().entry.id, 'a second row was created');

  const days = (await h.get('/diary/days?month=2026-08-05')).json();
  assert.equal(days.days.length, 1);
  await h.app.close();
});

test('the date the entry was written on never moves', async () => {
  const h = await setup();
  const made = (await h.put('/diary/entries/2026-08-05',
    { document: doc('Written on the fifth.') })).json();
  // Later edits, including a title, must not restate the date.
  await h.put('/diary/entries/2026-08-05', { title: 'A name' });
  const back = (await h.get('/diary/entries/2026-08-05')).json();
  assert.equal(back.entry.entryDate, '2026-08-05');
  assert.equal(back.entry.id, made.entry.id);
  await h.app.close();
});

test('the timezone is recorded and never used to recompute a date', async () => {
  const h = await setup();
  const made = (await h.put('/diary/entries/2026-08-05',
    { document: doc('Hello.'), timezone: 'Africa/Johannesburg' })).json();
  assert.equal(made.entry.timezone, 'Africa/Johannesburg');
  assert.equal(made.entry.entryDate, '2026-08-05');
  // A later write from a different zone must not move the entry.
  await h.put('/diary/entries/2026-08-05',
    { document: doc('Still the fifth.'), timezone: 'UTC' });
  const back = (await h.get('/diary/entries/2026-08-05')).json();
  assert.equal(back.entry.entryDate, '2026-08-05', 'a zone change moved the entry');
  await h.app.close();
});

/* ══ §19  Meaningful entries, and no ghosts ════════════════════════════ */

test('an empty editor is not an entry', () => {
  assert.equal(documentHasContent(EMPTY), false);
  assert.equal(documentHasContent(EDITOR_BOILERPLATE as any), false);
  assert.equal(documentHasContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '   ' }] }] } as any), false);
  assert.equal(documentHasContent(doc('Something.') as any), true);
});

test('a node with no text but real meaning still counts', () => {
  // A list with items, or a node type from a newer build. Declaring those empty
  // would hide a real day from the person's own history.
  const list = { type: 'doc', content: [{ type: 'bulletList', content: [] }] };
  assert.equal(documentHasContent(list as any), true);
  const future = { type: 'doc', content: [{ type: 'photoGrid', attrs: {} }] };
  assert.equal(documentHasContent(future as any), true);
});

test('any single field a person filled in makes the day an entry', () => {
  assert.equal(isMeaningfulEntry(EMPTY as any, {}), false);
  assert.equal(isMeaningfulEntry(EMPTY as any, { title: '  ' }), false);
  assert.equal(isMeaningfulEntry(EMPTY as any, { title: 'A day' }), true);
  assert.equal(isMeaningfulEntry(EMPTY as any, { mood: 'low' }), true);
  assert.equal(isMeaningfulEntry(EMPTY as any, { energy: 'high' }), true);
  assert.equal(isMeaningfulEntry(EMPTY as any, { locationNote: 'Home' }), true);
  assert.equal(isMeaningfulEntry(EMPTY as any, { weatherNote: 'Rain' }), true);
  assert.equal(isMeaningfulEntry(EMPTY as any, { daySummary: 'Quiet.' }), true);
});

test('reading a date creates nothing', async () => {
  const h = await setup();
  for (const d of ['2026-08-01', '2026-08-02', '2026-08-03']) {
    const r = await h.get(`/diary/entries/${d}`);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().entry, null);
  }
  const days = (await h.get('/diary/days?month=2026-08-01')).json();
  assert.equal(days.days.length, 0, 'looking at days created rows');
  await h.app.close();
});

test('an empty write creates nothing', async () => {
  const h = await setup();
  // What an autosave on an untouched page would send.
  const r = await h.put('/diary/entries/2026-08-05', { document: EDITOR_BOILERPLATE });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().entry, null);
  assert.equal(r.json().created, false);
  assert.equal((await h.get('/diary/days?month=2026-08-05')).json().days.length, 0);
  await h.app.close();
});

test('a mood alone creates the entry', async () => {
  const h = await setup();
  const r = await h.put('/diary/entries/2026-08-05', { mood: 'low' });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().entry.mood, 'low');
  assert.equal((await h.get('/diary/days?month=2026-08-05')).json().days.length, 1);
  await h.app.close();
});

test('a whitespace title is stored as null, not as spaces', async () => {
  const h = await setup();
  await h.put('/diary/entries/2026-08-05', { document: doc('Body.'), title: '   ' });
  const back = (await h.get('/diary/entries/2026-08-05')).json();
  assert.equal(back.entry.title, null);
  await h.app.close();
});

test('the formatted date is never written into the title column', async () => {
  const h = await setup();
  await h.put('/diary/entries/2026-08-05', { document: doc('No title given.') });
  const back = (await h.get('/diary/entries/2026-08-05')).json();
  assert.equal(back.entry.title, null,
    'the server invented a title, which would then be searchable as if written');
  await h.app.close();
});

/* ══ §11/§12  Version safety ═══════════════════════════════════════════ */

test('a stale write is refused, not silently applied', async () => {
  const h = await setup();
  const made = (await h.put('/diary/entries/2026-08-05', { document: doc('One.') })).json();
  const stale = made.entry.updatedAt;

  await h.put('/diary/entries/2026-08-05', { document: doc('Two, from the other tab.') });

  const late = await h.put('/diary/entries/2026-08-05',
    { document: doc('Three, based on One.'), expectedUpdatedAt: stale });
  assert.equal(late.statusCode, 409);
  assert.match(late.json().error.message, /changed somewhere else/i);

  const back = (await h.get('/diary/entries/2026-08-05')).json();
  assert.match(back.entry.documentText, /Two, from the other tab/,
    'the stale write won');
  await h.app.close();
});

test('a write with the current version succeeds', async () => {
  const h = await setup();
  const made = (await h.put('/diary/entries/2026-08-05', { document: doc('One.') })).json();
  const ok = await h.put('/diary/entries/2026-08-05',
    { document: doc('Two.'), expectedUpdatedAt: made.entry.updatedAt });
  assert.equal(ok.statusCode, 200);
  await h.app.close();
});

/* ══ §20  Archive and restore ══════════════════════════════════════════ */

test('an archived entry leaves history and search but keeps its date', async () => {
  const h = await setup();
  const made = (await h.put('/diary/entries/2026-08-05',
    { document: doc('A day I put away.') })).json();
  await h.post(`/diary/entries/${made.entry.id}/archive`);

  assert.equal((await h.get('/diary/days?month=2026-08-05')).json().days.length, 0);
  assert.equal((await h.get('/diary/search?q=put away')).json().results.length, 0);
  assert.equal((await h.get('/diary/recent')).json().entries.length, 0);

  const day = (await h.get('/diary/entries/2026-08-05')).json();
  assert.equal(day.entry, null);
  assert.ok(day.archivedEntry, 'the archived entry is not offered for restore');
  assert.equal(day.archivedEntry.id, made.entry.id);
  await h.app.close();
});

test('writing on an archived date is refused with a restore offer', async () => {
  const h = await setup();
  const made = (await h.put('/diary/entries/2026-08-05', { document: doc('Original.') })).json();
  await h.post(`/diary/entries/${made.entry.id}/archive`);

  const again = await h.put('/diary/entries/2026-08-05', { document: doc('A second entry.') });
  assert.equal(again.statusCode, 409);
  assert.match(again.json().error.message, /archived entry.*[Rr]estore/);

  // And the original is intact — nothing was written over it.
  const restored = await h.post(`/diary/entries/${made.entry.id}/restore`);
  assert.equal(restored.statusCode, 200);
  const back = (await h.get('/diary/entries/2026-08-05')).json();
  assert.match(back.entry.documentText, /Original/);
  assert.equal(back.entry.entryDate, '2026-08-05', 'restore did not return it to its date');
  await h.app.close();
});

test('there is no permanent delete route', async () => {
  const h = await setup();
  const made = (await h.put('/diary/entries/2026-08-05', { document: doc('Keep me.') })).json();
  const r = await h.app.inject({
    method: 'DELETE', url: `${h.base}/diary/entries/${made.entry.id}`, headers: auth(),
  });
  assert.equal(r.statusCode, 404, 'a DELETE route exists');
  await h.app.close();
});

/* ══ §15/§13  History and navigation ═══════════════════════════════════ */

test('days returns only the requested month, in order', async () => {
  const h = await setup();
  for (const d of ['2026-07-30', '2026-08-02', '2026-08-19', '2026-09-01']) {
    await h.put(`/diary/entries/${d}`, { document: doc(`Entry for ${d}.`) });
  }
  const aug = (await h.get('/diary/days?month=2026-08-15')).json();
  assert.deepEqual(aug.days.map((d: any) => d.date), ['2026-08-02', '2026-08-19']);
  assert.equal(aug.from, '2026-08-01');
  assert.equal(aug.to, '2026-08-31');
  // Presence and a label — not whole documents.
  assert.ok(!('document' in aug.days[0]), 'the month grid ships full documents');
  assert.ok('length' in aug.days[0]);
  await h.app.close();
});

test('a backwards range is refused rather than returning nothing', async () => {
  const h = await setup();
  const r = await h.get('/diary/days?from=2026-08-20&to=2026-08-01');
  assert.equal(r.statusCode, 400);
  await h.app.close();
});

test('recent entries are newest first', async () => {
  const h = await setup();
  for (const d of ['2026-08-02', '2026-08-19', '2026-07-30']) {
    await h.put(`/diary/entries/${d}`, { document: doc(`Entry for ${d}.`) });
  }
  const r = (await h.get('/diary/recent?limit=2')).json();
  assert.deepEqual(r.entries.map((e: any) => e.date), ['2026-08-19', '2026-08-02']);
  await h.app.close();
});

test('previous and next ENTRY skip the empty days between', async () => {
  const h = await setup();
  for (const d of ['2026-08-02', '2026-08-19']) {
    await h.put(`/diary/entries/${d}`, { document: doc(`Entry for ${d}.`) });
  }
  // From a day with nothing on it, in the middle.
  const prev = (await h.get('/diary/adjacent?date=2026-08-10&direction=prev')).json();
  assert.equal(prev.date, '2026-08-02');
  const next = (await h.get('/diary/adjacent?date=2026-08-10&direction=next')).json();
  assert.equal(next.date, '2026-08-19');
  // From an entry day, it must not return itself.
  const fromEntry = (await h.get('/diary/adjacent?date=2026-08-02&direction=next')).json();
  assert.equal(fromEntry.date, '2026-08-19');
  // Past the end, honestly nothing.
  const none = (await h.get('/diary/adjacent?date=2026-08-19&direction=next')).json();
  assert.equal(none.date, null);
  await h.app.close();
});

test('adjacent skips archived entries', async () => {
  const h = await setup();
  const a = (await h.put('/diary/entries/2026-08-02', { document: doc('A.') })).json();
  await h.put('/diary/entries/2026-08-05', { document: doc('B.') });
  await h.post(`/diary/entries/${a.entry.id}/archive`);
  const prev = (await h.get('/diary/adjacent?date=2026-08-05&direction=prev')).json();
  assert.equal(prev.date, null, 'an archived day was offered as the previous entry');
  await h.app.close();
});

/* ══ §16  Search ═══════════════════════════════════════════════════════ */

test('search reaches the title, the body, the summary and the notes', async () => {
  const h = await setup();
  await h.put('/diary/entries/2026-08-01',
    { document: doc('Nothing special.'), title: 'A difficult conversation' });
  await h.put('/diary/entries/2026-08-02',
    { document: doc('We walked to the harbour and back.') });
  await h.put('/diary/entries/2026-08-03',
    { document: doc('Body.'), daySummary: 'Rebuilt the shelf.' });
  await h.put('/diary/entries/2026-08-04',
    { document: doc('Body.'), locationNote: 'The kitchen table' });
  await h.put('/diary/entries/2026-08-06',
    { document: doc('Body.'), weatherNote: 'Rain, then not' });

  const hit = async (q: string) =>
    (await h.get(`/diary/search?q=${encodeURIComponent(q)}`)).json().results.map((r: any) => r.date);
  assert.deepEqual(await hit('difficult'), ['2026-08-01']);
  assert.deepEqual(await hit('harbour'), ['2026-08-02']);
  assert.deepEqual(await hit('shelf'), ['2026-08-03']);
  assert.deepEqual(await hit('kitchen'), ['2026-08-04']);
  assert.deepEqual(await hit('Rain'), ['2026-08-06']);
  await h.app.close();
});

test('a search result carries the date and a readable excerpt', async () => {
  const h = await setup();
  await h.put('/diary/entries/2026-08-05', {
    document: doc('This paragraph opens with a good deal of text that has nothing '
      + 'whatever to do with the search, and it carries on for long enough that the '
      + 'sixty-character window cannot reach the start, and only then does the word '
      + 'harbour appear, followed by more text so the window has both sides.'),
  });
  const r = (await h.get('/diary/search?q=harbour')).json().results[0];
  assert.equal(r.date, '2026-08-05');
  assert.match(r.excerpt, /harbour/);
  assert.match(r.excerpt, /^…/, 'the excerpt does not show it was cut from the left');
  await h.app.close();
});

/* ══ §17  Optional context ═════════════════════════════════════════════ */

test('context fields round-trip and can be cleared back to null', async () => {
  const h = await setup();
  await h.put('/diary/entries/2026-08-05', {
    document: doc('Body.'), mood: 'good', energy: 'high',
    weatherNote: 'Clear', locationNote: 'Home', daySummary: 'A good day.',
  });
  let back = (await h.get('/diary/entries/2026-08-05')).json().entry;
  assert.equal(back.mood, 'good');
  assert.equal(back.energy, 'high');
  assert.equal(back.weatherNote, 'Clear');
  assert.equal(back.locationNote, 'Home');
  assert.equal(back.daySummary, 'A good day.');

  await h.put('/diary/entries/2026-08-05', {
    mood: null, energy: null, weatherNote: null, locationNote: null, daySummary: null,
  });
  back = (await h.get('/diary/entries/2026-08-05')).json().entry;
  for (const f of ['mood', 'energy', 'weatherNote', 'locationNote', 'daySummary']) {
    assert.equal(back[f], null, `${f} did not clear`);
  }
  await h.app.close();
});

test('an unknown mood or energy is refused', async () => {
  const h = await setup();
  assert.equal((await h.put('/diary/entries/2026-08-05', { mood: 'ecstatic' })).statusCode, 400);
  assert.equal((await h.put('/diary/entries/2026-08-05', { energy: 'infinite' })).statusCode, 400);
  await h.app.close();
});

/* ══ Workspace isolation ═══════════════════════════════════════════════ */

test('one workspace cannot see or write another workspace', async () => {
  const { db } = await freshDb();
  const app = buildApp(db, envFor('test'));
  await app.ready();
  const mine = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth('a@example.com') })).json();
  const theirs = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth('b@example.com') })).json();
  assert.notEqual(mine.workspace.id, theirs.workspace.id);

  await app.inject({
    method: 'PUT', url: `/api/v1/workspaces/${mine.workspace.id}/diary/entries/2026-08-05`,
    headers: auth('a@example.com'), payload: { document: doc('Mine.') },
  });
  // Reading my date from their workspace must not show my writing.
  const cross = await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${theirs.workspace.id}/diary/entries/2026-08-05`,
    headers: auth('b@example.com'),
  });
  assert.equal(cross.json().entry, null);
  // And reaching into mine with their credentials is refused outright.
  const forbidden = await app.inject({
    method: 'GET', url: `/api/v1/workspaces/${mine.workspace.id}/diary/entries/2026-08-05`,
    headers: auth('b@example.com'),
  });
  assert.ok(forbidden.statusCode === 403 || forbidden.statusCode === 404);
  await app.close();
});

test('two workspaces may both hold the same date', async () => {
  const { db } = await freshDb();
  const app = buildApp(db, envFor('test'));
  await app.ready();
  const a = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth('a@example.com') })).json();
  const b = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth('b@example.com') })).json();
  for (const [ws, email] of [[a.workspace.id, 'a@example.com'], [b.workspace.id, 'b@example.com']] as const) {
    const r = await app.inject({
      method: 'PUT', url: `/api/v1/workspaces/${ws}/diary/entries/2026-08-05`,
      headers: auth(email), payload: { document: doc('Same day, different life.') },
    });
    assert.equal(r.statusCode, 201, 'the unique index is not scoped to the workspace');
  }
  await app.close();
});

/* ══ §29  Sample data ══════════════════════════════════════════════════ */

test('sample data is refused in production, and allowed everywhere else', () => {
  /* Tested at the guard rather than through a production app, because a
   * production environment REFUSES to boot with DEV_AUTH_BYPASS set — which is
   * itself the stronger protection, and means there is no way to reach these
   * routes in production at all. Same reasoning as library-f1. */
  assert.equal(isDiarySampleAllowed('production'), false);
  assert.equal(isDiarySampleAllowed('staging'), true);
  assert.equal(isDiarySampleAllowed('test'), true);

  const src = readFileSync(join(here, '..', 'src', 'routes', 'diary.ts'), 'utf8');
  for (const route of ['app.post(`${base}/diary/sample`', "app.post(`${base}/diary/sample/remove`"]) {
    const body = src.slice(src.indexOf(route));
    assert.match(body.slice(0, 400), /if \(!isDiarySampleAllowed\(env\.NODE_ENV\)\)/,
      `${route} does not check the environment`);
  }
});

test('the sample set covers what it claims to', async () => {
  const h = await setup();
  const added = (await h.post('/diary/sample', { today: '2026-08-05' })).json();
  assert.ok(added.entriesCreated >= 5);
  assert.equal(added.archivedCreated, 1, 'no archived sample entry');

  // Today is there and readable.
  const today = (await h.get('/diary/entries/2026-08-05')).json();
  assert.ok(today.entry, 'the sample set has no entry for today');

  // The archived one is excluded from history but still holds its date.
  const foot = (await h.get('/diary/sample')).json();
  assert.equal(foot.archived, 1);
  await h.app.close();
});

test('sample cleanup matches the exact prefix and nothing else', async () => {
  const h = await setup();
  await h.post('/diary/sample', { today: '2026-08-05' });

  // A REAL entry, on a date the samples did not take, whose summary looks
  // similar but does not carry the marker.
  await h.put('/diary/entries/2026-06-02', {
    document: doc('My own writing, which must survive.'),
    title: 'A day I put away',                 // same title as a sample entry
    daySummary: 'sample:d1: looks like the marker, but is only text I typed',
    timezone: 'Africa/Johannesburg',           // a real zone, not the marker
  });

  const removed = (await h.post('/diary/sample/remove')).json();
  assert.ok(removed.removed >= 5);

  const survivor = (await h.get('/diary/entries/2026-06-02')).json();
  assert.ok(survivor.entry, 'cleanup deleted a real entry');
  assert.match(survivor.entry.documentText, /must survive/);

  assert.equal((await h.get('/diary/sample')).json().entries, 0);
  await h.app.close();
});

test('the sample marker is the exact prefix, on a field nobody types into', () => {
  assert.equal(SAMPLE_PREFIX, 'sample:d1:');
  const src = readFileSync(join(here, '..', 'src', 'lib', 'sample-diary.ts'), 'utf8');
  /* Cleanup is a prefix LIKE on `timezone` — a field nobody types into and
   * nothing displays. It was `day_summary` first, and the marker showed up on
   * screen as "sample:d1: An ordinary Tuesday" in the history list. */
  assert.match(src, /like\(diaryEntries\.timezone, `\$\{SAMPLE_PREFIX\}%`\)/);
  assert.ok(!/like\(diaryEntries\.daySummary/.test(src), 'the marker is on a displayed field');
  assert.ok(!/like\(diaryEntries\.title/.test(src));
  assert.ok(!/gte\(diaryEntries\.entryDate/.test(src));
});

test('seeding never overwrites a day somebody wrote', async () => {
  const h = await setup();
  await h.put('/diary/entries/2026-08-05', { document: doc('My real today.') });
  const added = (await h.post('/diary/sample', { today: '2026-08-05' })).json();
  assert.ok(added.alreadyPresent >= 1);
  const mine = (await h.get('/diary/entries/2026-08-05')).json();
  assert.match(mine.entry.documentText, /My real today/, 'seeding replaced real writing');
  await h.app.close();
});

test('the sample content is invented, not borrowed or personal', () => {
  const src = readFileSync(join(here, '..', 'src', 'lib', 'sample-diary.ts'), 'utf8');
  // No real addresses, no contact details, no attributed quotations.
  assert.ok(!/@[a-z0-9-]+\.(com|co\.za|org|net)/i.test(src.replace(/example\.com/g, '')));
  assert.ok(!/\+\d{7,}/.test(src), 'a phone number appears in sample data');
  assert.ok(!/zander/i.test(src), 'the sample data names the user');
});

/* ══ Regression: nothing else moved ════════════════════════════════════ */

test('Diary entries are not Library items', async () => {
  const h = await setup();
  await h.put('/diary/entries/2026-08-05', { document: doc('A diary day.') });
  /* A new account now arrives with starter Books, so "empty" is no longer the
   * test — "no diary in it" is. What matters is that writing a Diary day
   * creates nothing in Library, whatever else is already on the shelf. */
  const before = (await h.get('/library/items')).json().items.length;
  await h.put('/diary/entries/2026-08-06', { document: doc('Another diary day.') });
  const items = (await h.get('/library/items')).json();
  assert.equal(items.items.length, before, 'a diary entry appeared on the Library shelf');
  assert.ok(!items.items.some((i: any) => /diary day/i.test(i.title)));
  const found = (await h.get('/library/search?q=diary day')).json();
  assert.equal(found.items.length, 0);
  assert.equal(found.pages.length, 0);
  await h.app.close();
});

test('Diary shares the document grammar and nothing else', () => {
  const route = readFileSync(join(here, '..', 'src', 'routes', 'diary.ts'), 'utf8');
  // It validates with the same grammar…
  assert.match(route, /from '\.\.\/lib\/book-doc\.js'/);
  // …and never reaches into Library's tables.
  for (const table of ['libraryItems', 'libraryBooks', 'bookSections', 'bookPages']) {
    assert.ok(!route.includes(table), `diary.ts touches ${table}`);
  }
});

test('Google access is still read-only', () => {
  const google = readFileSync(join(here, '..', 'src', 'lib', 'google-calendar.ts'), 'utf8');
  assert.match(google, /auth\/calendar\.readonly'/);
  assert.ok(!/auth\/calendar'/.test(google), 'a Google write scope was added');
});
