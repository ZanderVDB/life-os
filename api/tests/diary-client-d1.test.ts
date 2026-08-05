/**
 * Diary client (Phase D1).
 *
 * The date arithmetic and the routing are RUN, because they are logic and
 * getting them wrong files somebody's writing under the wrong day. The rest —
 * the Library boundary, the shared-editor rules, the honesty rules — is
 * asserted against the source, because it is a decision that must stay made.
 *
 * The pixel geometry and the interactions are verified in a real browser; those
 * measurements are in the phase report and in the diary docs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');

const html = read('index.html');
const app = read('app.js');
const routes = read('routes.js');
const apiJs = read('diary-api.js');
const viewJs = read('diary-view.js');
const saveJs = read('diary-save.js');
const entryJs = read('diary-entry.js');
const historyJs = read('diary-history.js');
const editorSaveJs = read('editor-save.js');

const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const viewCode = code(viewJs);
const apiCode = code(apiJs);
const saveCode = code(saveJs);

/* ══ Civil dates ═══════════════════════════════════════════════════════ */

const dapi = await import('../../web/diary-api.js' as string);

test('date arithmetic never crosses a timezone', () => {
  assert.equal(dapi.addDays('2026-08-05', 1), '2026-08-06');
  assert.equal(dapi.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(dapi.addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(dapi.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(dapi.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dapi.addMonths('2026-08-15', -1), '2026-07-01');
  assert.equal(dapi.addMonths('2026-01-15', -1), '2025-12-01');
  assert.equal(dapi.addMonths('2026-12-15', 1), '2027-01-01');
});

test('a date is validated as a real day, not just a shape', () => {
  assert.equal(dapi.isValidDate('2026-08-05'), true);
  assert.equal(dapi.isValidDate('2026-02-29'), false);
  assert.equal(dapi.isValidDate('2024-02-29'), true);
  assert.equal(dapi.isValidDate('2026-04-31'), false);
  assert.equal(dapi.isValidDate('2026-8-5'), false);
  assert.equal(dapi.isValidDate(''), false);
  assert.equal(dapi.isValidDate(null as any), false);
});

test('the month grid is always six whole weeks, Monday first', () => {
  const g = dapi.monthGrid('2026-08-05');
  assert.equal(g.length, 42, 'the grid reflows height as you page through months');
  // August 2026 starts on a Saturday, so the first cell is Monday 27 July.
  assert.equal(g[0].date, '2026-07-27');
  assert.equal(g[0].inMonth, false);
  assert.ok(g.some((c: any) => c.date === '2026-08-01' && c.inMonth));
  assert.ok(g.some((c: any) => c.date === '2026-08-31' && c.inMonth));
  // Every cell is exactly one day after the last.
  for (let i = 1; i < g.length; i++) {
    assert.equal(g[i].date, dapi.addDays(g[i - 1].date, 1), `gap at cell ${i}`);
  }
});

test('a February grid still fills six weeks', () => {
  assert.equal(dapi.monthGrid('2026-02-10').length, 42);
  assert.equal(dapi.monthGrid('2024-02-10').length, 42);
});

test('today is the LOCAL day, never the UTC one', () => {
  // In Johannesburg toISOString().slice(0,10) is yesterday until 02:00, which
  // would file an entry written after midnight under the wrong day.
  assert.doesNotMatch(apiCode, /toISOString\(\)/,
    'diary-api uses toISOString, which is the UTC date');
  const fn = apiCode.slice(apiCode.indexOf('export function localToday'));
  assert.match(fn.slice(0, 260), /getFullYear\(\)/);
  assert.match(fn.slice(0, 260), /getMonth\(\)/);
  assert.match(fn.slice(0, 260), /getDate\(\)/);
});

test('every computed date is built at noon, so no offset can shift it', () => {
  for (const fn of ['addDays', 'addMonths', 'isValidDate', 'monthGrid']) {
    const body = apiCode.slice(apiCode.indexOf(`function ${fn}`), apiCode.indexOf(`function ${fn}`) + 700);
    assert.match(body, /Date\.UTC\([^)]*12\)/, `${fn} does not build at noon UTC`);
  }
});

test('relative days read as words where words help', () => {
  assert.equal(dapi.relativeDay('2026-08-05', '2026-08-05'), 'Today');
  assert.equal(dapi.relativeDay('2026-08-04', '2026-08-05'), 'Yesterday');
  assert.match(dapi.relativeDay('2026-07-12', '2026-08-05'), /July/);
});

/* ══ Routing ═══════════════════════════════════════════════════════════ */

const view = await import('../../web/diary-view.js' as string);

test('#diary routes resolve to a day or to history', () => {
  const T = '2026-08-05';
  assert.deepEqual(view.parseDiaryHash('#diary', T), { mode: 'entry', date: T });
  assert.deepEqual(view.parseDiaryHash('#diary/2026-07-12', T),
    { mode: 'entry', date: '2026-07-12' });
  assert.deepEqual(view.parseDiaryHash('#diary/history', T),
    { mode: 'history', date: null });
  assert.equal(view.parseDiaryHash('#library/book/x', T), null);
  assert.equal(view.parseDiaryHash('#today', T), null);
});

test('a nonsense date opens the diary rather than erroring', () => {
  const T = '2026-08-05';
  assert.deepEqual(view.parseDiaryHash('#diary/2026-02-30', T), { mode: 'entry', date: T });
  assert.deepEqual(view.parseDiaryHash('#diary/tomorrow', T), { mode: 'entry', date: T });
});

test('typing never writes a history entry', () => {
  // The hash is set on date changes only. An autosave that pushed history would
  // make Back a per-keystroke undo of navigation.
  const setHashCalls = viewCode.match(/setHash\(/g) ?? [];
  assert.ok(setHashCalls.length <= 4, 'setHash is called from too many places');
  const queue = viewCode.slice(viewCode.indexOf("editor.addEventListener('input'"));
  assert.doesNotMatch(queue.slice(0, 400), /setHash|location\.hash/);
});

/* ══ The Library boundary ══════════════════════════════════════════════ */

test('Diary imports the shared editor, never Library', () => {
  for (const [name, src] of Object.entries({
    view: viewJs, entry: entryJs, history: historyJs, api: apiJs, save: saveJs,
  })) {
    assert.doesNotMatch(src, /from '\.\/library-/,
      `diary-${name}.js imports a Library module`);
  }
  // …and it does import the shared ones.
  assert.match(viewJs, /from '\.\/editor-doc\.js'/);
  assert.match(viewJs, /from '\.\/editor-blocks\.js'/);
  assert.match(saveJs, /from '\.\/editor-save\.js'/);
});

test('Diary does not reuse the Book furniture', () => {
  const all = viewJs + entryJs + historyJs;
  for (const bookThing of ['coverHtml', 'spreadHtml', 'bk-spread', 'bk-tab',
    'bk-page-right', 'page-turn', 'sectionIdx', 'spreadIdx']) {
    assert.ok(!all.includes(bookThing), `Diary reuses the Book's ${bookThing}`);
  }
});

test('Diary has its own CSS namespace and its own sheet', () => {
  assert.match(html, /\.dia-sheet\{/);
  assert.match(html, /body:has\(\.dia-page\) \.rail\{display:none\}/);
  assert.match(html, /body:has\(\.dia-page\) \.main-wrap\{grid-template-columns:minmax\(0,1fr\) 0\}/);
  /* No page proportion and no curl. The calendar's day cells are square
   * (`aspect-ratio: 1`), which is a button, not a page — so this asks about the
   * SHEET rather than about the whole Diary stylesheet. */
  const diaCss = html.slice(html.indexOf('DIARY (Phase D1)'), html.indexOf('Library responsive'));
  const sheet = diaCss.slice(diaCss.indexOf('.dia-sheet{'), diaCss.indexOf('.dia-sheet-head'));
  assert.doesNotMatch(sheet, /aspect-ratio/, 'the diary sheet has a page aspect ratio');
  assert.doesNotMatch(diaCss, /rotateY|perspective/, 'a page curl was added');
  assert.doesNotMatch(diaCss, /bk-spread|grid-template-columns:repeat\(2/,
    'the diary borrowed the two-page spread');
});

test('the ruled paper and the F2.1 block grid carry over intact', () => {
  // Diary DOES borrow these — they are the parts of the Book that make writing
  // read well, and the lead-row rule is what stops a heading drawing a ruled
  // line the caret cannot reach.
  assert.match(html, /\.dia-editor\{[^}]*line-height:30px/);
  assert.match(html, /transparent 29px,var\(--paper-line\) 29px,var\(--paper-line\) 30px/);
  assert.match(html, /\.dia-editor h2,\.dia-editor h3\{[^}]*padding:30px 0 0/);
  assert.match(html, /\.dia-editor h2::before,\.dia-editor h3::before\{[^}]*background:var\(--paper\)/);
  assert.match(html, /\.dia-editor h2::before,\.dia-editor h3::before\{[^}]*pointer-events:none/);
  assert.match(html, /\.dia-editor > \*\{[^}]*margin:0/);
});

/* ══ Saving ════════════════════════════════════════════════════════════ */

test('the save coordinator is a factory, so two surfaces never share a queue', () => {
  // A module-level map shared by Library and Diary would let one surface's
  // forgetAll() clear the other's pending write.
  assert.match(code(editorSaveJs), /export function createSaveCoordinator/);
  assert.match(code(read('library-save.js')), /createSaveCoordinator\(\{/);
  assert.match(saveCode, /createSaveCoordinator\(\{/);
});

test('Diary saves are keyed by DATE, not by entry id', () => {
  // A blank day has no id. The date is its only stable handle, and the first
  // successful write is what brings the row into being.
  assert.match(saveCode, /export const trackDate = \(date, entry\)/);
  assert.match(saveCode, /co\.queue\(date,/);
  assert.match(saveCode, /co\.flush\(date\)/);
});

test('an empty day is a successful save of nothing', () => {
  assert.match(saveCode, /if \(!r\.entry\) return null;/);
  assert.match(code(editorSaveJs), /if \(r === null\) \{ setStatus\(e, 'saved'\); return; \}/);
});

test('nothing outside the coordinator moves the version token', () => {
  /* onEntryCreated used to call adopt(), which moved the version before the
   * coordinator set it from the write's own result. Its staleness guard then
   * fired on its own success and left the status on "Saving…" for ever while
   * the row sat happily in the database. */
  const hook = viewCode.slice(viewCode.indexOf('onEntryCreated('));
  assert.doesNotMatch(hook.slice(0, 700), /adopt\(/,
    'the created hook moves the version behind the coordinator');
});

test('a flush happens before anything takes the editor away', () => {
  const go = viewCode.slice(viewCode.indexOf('export async function goToDate'));
  assert.match(go.slice(0, 500), /await flushAll\(\)/);
  // And if it could not save, the navigation is abandoned.
  assert.match(go.slice(0, 600), /if \(!ok && hasUnsaved\(\)\)/);
  assert.match(viewCode, /export async function diaryWillLeave[\s\S]{0,200}await flushAll\(\)/);
  assert.match(code(app), /if \(state\.route === 'diary'\) await diaryWillLeave\(\)/);
  const hist = viewCode.slice(viewCode.indexOf('async function goHistory'));
  assert.match(hist.slice(0, 400), /await flushAll\(\)/);
});

test('the conflict surface keeps the writing whichever way it goes', () => {
  const fn = viewCode.slice(viewCode.indexOf('export async function showConflict'));
  for (const id of ['mine', 'theirs', 'copy']) {
    assert.ok(fn.includes(`id: '${id}'`), `the conflict dialog is missing ${id}`);
  }
  // Taking theirs copies FIRST, then loads. In that order.
  const theirs = fn.slice(fn.indexOf('Taking theirs') > -1 ? fn.indexOf('resolveTakeTheirs') : 0);
  assert.match(fn, /await copyText\(resolveTakeTheirs\(date, server\)/);
  assert.doesNotMatch(fn, /merge/i, 'an automatic rich-text merge was implied');
});

/* ══ The editor element survives typing ════════════════════════════════ */

test('the sheet is rebuilt only when the date changes', () => {
  const input = viewCode.slice(viewCode.indexOf("editor.addEventListener('input'"));
  const handler = input.slice(0, input.indexOf('});'));
  assert.doesNotMatch(handler, /innerHTML|paintSheet|entryHtml/);
  assert.match(handler, /queueSave/);
  // And the status painter never redraws the sheet either.
  const status = viewCode.slice(viewCode.indexOf('function wireSaveStatus'));
  assert.doesNotMatch(status.slice(0, 900), /paintSheet\(/);
});

/* ══ Product rules ═════════════════════════════════════════════════════ */

test('Diary is a real route, not a placeholder', () => {
  assert.doesNotMatch(routes, /id: 'diary'[^}]*placeholder/);
  assert.doesNotMatch(routes, /^\s*diary: \{/m);
  assert.match(code(app), /if \(state\.route === 'diary'\) return renderDiary\(\)/);
});

test('the formatted date is never written into the title', () => {
  // A title the user did not write would then be searchable as if they had.
  const title = viewCode.slice(viewCode.indexOf("#dia-title'"));
  assert.doesNotMatch(title.slice(0, 400), /formatLong|dayName/);
  assert.match(entryJs, /placeholder="Add a title \(optional\)"/);
});

test('day and entry navigation are labelled and distinct', () => {
  // Two adjacent unlabelled chevron pairs would be a guess every time.
  assert.match(entryJs, /aria-label="Previous day"/);
  assert.match(entryJs, /aria-label="Next day"/);
  assert.match(entryJs, /aria-label="Previous entry"/);
  assert.match(entryJs, /aria-label="Next entry"/);
  assert.match(entryJs, /class="dia-nav-label">Day</);
  assert.match(entryJs, /class="dia-nav-label">Entry</);
  // Entry steps have to ASK the server where the gaps are.
  assert.match(viewCode, /adjacentEntry\(dia\.date, direction\)/);
});

test('context is optional, labelled, and never a row of faces', () => {
  assert.match(entryJs, /Add context/);
  assert.match(entryJs, /Not recorded/);
  for (const label of ['Mood', 'Energy', 'Weather', 'Where', 'Day summary']) {
    assert.ok(entryJs.includes(`>${label}<`), `the ${label} field has no text label`);
  }
  // Values are words, and the option list comes from one table.
  assert.match(apiJs, /\{ id: 'very_low', label: 'Very low' \}/);
  assert.doesNotMatch(entryJs, /😀|🙂|😐|🙁|😢/, 'emoji stand in for a label');
});

test('presence in the calendar is never carried by colour alone', () => {
  assert.match(historyJs, /has an entry.*no entry|no entry/);
  assert.match(historyJs, /class="dia-dot"/);
  assert.match(html, /\.dia-day-cell\.has-entry \.dia-day-n\{font-weight:700/);
  assert.match(historyJs, /aria-label="\$\{esc\(label\)\}"/);
});

test('no native dialogs anywhere in Diary', () => {
  for (const [name, src] of Object.entries({
    view: viewCode, entry: code(entryJs), history: code(historyJs),
  })) {
    assert.doesNotMatch(src, /\bwindow\.(confirm|prompt|alert)\b/, `${name} uses a native dialog`);
    assert.doesNotMatch(src, /(^|[^.\w])(confirm|alert)\(/m, `${name} uses a native dialog`);
  }
});

test('sample data is a console hook, and the server is the real guard', () => {
  assert.match(viewCode, /window\.__sampleDiary/);
  assert.doesNotMatch(code(entryJs) + code(historyJs), /sample/i,
    'a seed control leaked into the interface');
});

/* ══ Motion ════════════════════════════════════════════════════════════ */

test('the date change moves the sheet, not the frame, and never curls', () => {
  assert.match(html, /@keyframes diaLeaveNext\{to\{transform:translateX\(-3%\)/);
  assert.match(html, /@keyframes diaEnterNext\{from\{transform:translateX\(3%\)/);
  assert.match(html, /\.dia-sheet\.leave-next\{animation:diaLeaveNext var\(--d-base\)/);
  // 3%, not the Book's 14%: a diary day is replaced in the same frame, and a
  // large translation reads as the layout breaking rather than as time passing.
  assert.doesNotMatch(html, /diaLeave[^}]*translateX\(-?1[0-9]%\)/);
  const go = viewCode.slice(viewCode.indexOf('export async function goToDate'));
  assert.match(go.slice(0, 900), /reducedMotion\(\)/);
});

test('an animation that never finishes cannot strand the page', () => {
  const fn = viewCode.slice(viewCode.indexOf('function afterAnimation'));
  assert.match(fn.slice(0, 400), /setTimeout\(finish, ms \+ 60\)/);
});

/* ══ Regression ════════════════════════════════════════════════════════ */

test('Library and the Book editor are unchanged by the extraction', () => {
  // The geometry, the grid and the Library route all still stand.
  for (const r of ['aspect-ratio:420/297', 'padding:28px 32px 18px 58px',
    'border-radius:20px 20px 4px 4px', 'height:round(down,100%,30px)']) {
    assert.ok(html.includes(r), `Library's ${r} moved`);
  }
  assert.match(code(app), /if \(state\.route === 'library'\) return renderLibrary\(\)/);
  // Library binds the SHARED editor now, not a copy of it.
  assert.match(read('library-book.js'), /from '\.\/editor-blocks\.js'/);
  assert.match(read('library-book.js'), /from '\.\/editor-doc\.js'/);
  assert.match(read('library-view.js'), /import\('\.\/editor-doc\.js'\)/);
  // And nothing still points at the old filenames.
  for (const f of ['library-book.js', 'library-view.js', 'library-save.js']) {
    assert.ok(!read(f).includes('library-doc.js'), `${f} still imports library-doc.js`);
    assert.ok(!read(f).includes('library-blocks.js'), `${f} still imports library-blocks.js`);
  }
});

test('Calendar, Projects, Tasks and Habits are untouched', () => {
  for (const id of ['calendar', 'projects', 'today']) {
    assert.match(code(app), new RegExp(`state\\.route === '${id}'`), `${id} lost its route`);
  }
  assert.match(routes, /id: 'today'/);
  assert.match(routes, /id: 'calendar'/);
  assert.match(routes, /id: 'projects'/);
  // Brain is the one section still honestly marked as a placeholder.
  assert.match(routes, /id: 'brain'[^}]*placeholder: true/);
});

test('no Diary code reaches for Google, or for anything write-scoped', () => {
  const all = viewJs + apiJs + entryJs + historyJs + saveJs;
  for (const forbidden of ['googleapis', 'auth/calendar', 'calendar.events']) {
    assert.ok(!all.includes(forbidden), `Diary references ${forbidden}`);
  }
});
