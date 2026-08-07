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
const checkinJs = read('diary-checkin.js');
const editorSaveJs = read('editor-save.js');

const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

/* Comment-stripped. Several of these rules are also DESCRIBED in comments:
 * "No native select" and "not an input type=date" both read as the very
 * things they promise not to do. Same trap web-shell.test.ts documents. */
const viewCode = code(viewJs);
const checkinCode = code(checkinJs);
const entryCode = code(entryJs);
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

test('Diary reuses the Book GEOMETRY and none of its furniture', () => {
  /* D1 forbade all of it, on the reasoning that a diary is a sequence rather
   * than an object you hold. D2 reversed half of that: the page geometry is not
   * Library's property, it is the house style for a page you write on, and two
   * surfaces that both hold writing should not invent two of them. */
  assert.match(entryJs, /class="bk-book bk-spread dia-book"/);
  assert.match(entryJs, /class="bk-page bk-page-left dia-left"/);
  assert.match(entryJs, /class="bk-page bk-page-right dia-right"/);

  // The furniture is still Library's alone: no cover, no section tabs, no
  // shelf, no spread paging. Diary's two pages are today, not pages of a book.
  const all = viewJs + entryJs + historyJs + checkinJs;
  for (const bookThing of ['coverHtml', 'bk-cover', 'bk-tab', 'sectionIdx',
    'spreadIdx', 'spreadCount', 'library-api']) {
    assert.ok(!all.includes(bookThing), `Diary reuses the Book's ${bookThing}`);
  }
});

test('Diary has its own CSS namespace on top of the shared geometry', () => {
  assert.match(html, /\.dia-book\{/);
  assert.match(html, /\.dia-left,\.dia-right\{/);
  assert.match(html, /\.dia-checkin\{/);
  assert.match(html, /body:has\(\.dia-page\) \.rail\{display:none\}/);
  assert.match(html, /body:has\(\.dia-page\) \.main-wrap\{grid-template-columns:minmax\(0,1fr\) 0\}/);
  /* No page proportion and no curl. The calendar's day cells are square
   * (`aspect-ratio: 1`), which is a button, not a page — so this asks about the
   * SHEET rather than about the whole Diary stylesheet. */
  const diaCss = html.slice(html.indexOf('DIARY (Phase D2)'), html.indexOf('Library responsive'));
  // No page curl. Diary is chronological; the spread is a frame, not an object
  // you hold, and it shifts 3% rather than turning.
  assert.doesNotMatch(diaCss, /rotateY|perspective/, 'a page curl was added');
  assert.match(diaCss, /@keyframes diaLeaveNext\{to\{transform:translateX\(-3%\)/);
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

test('leaving a day never loses what was written on it', () => {
  /* REVISED by D2.3 §18/§19. D2's rule was "flush, WAIT, then change the
   * date". It was safe and it was the rubber-band's other half: the visible
   * date could not move until the network agreed, so a second press computed
   * its target from the day still on screen, and four presses produced four
   * requests for three days.
   *
   * The new rule keeps the guarantee and drops the wait. The save coordinator
   * is keyed by DATE, so a write for the day being left completes on its own
   * time and lands on the right record. What it may no longer do is touch the
   * screen — `dia.entry` and `onEntryCreated` are both guarded by "is this
   * date still open", so a late save cannot restore the day it belongs to.
   *
   * Verified in a browser: navigating mid-autosave landed on the requested day
   * and the abandoned day's text was still on the server afterwards. */
  const go = viewCode.slice(viewCode.indexOf('export async function goToDate'));
  const head = go.slice(0, go.indexOf('await renderEntry'));
  // The date is claimed BEFORE anything is awaited.
  assert.ok(head.indexOf('beginDayNav(date)') < head.indexOf('flushAll()'),
    'the date is still committed after the flush');
  assert.match(head, /void flushAll\(\)/, 'the flush blocks the navigation again');
  // The save still cannot be lost: the coordinator is keyed by date…
  const save = code(read('diary-save.js'));
  assert.match(save, /if \(date === dia\.date\) \{/,
    'a save for another day can write into the open day');
  // …and the tab still refuses to close on unsaved work.
  assert.match(viewCode, /beforeunload[\s\S]{0,200}hasUnsaved\(\)/);
  // History and archiving DO still flush first — they take the editor away
  // without a date to hand the write to.
  assert.match(viewCode.slice(viewCode.indexOf('async function goHistory')).slice(0, 400),
    /await flushAll\(\)/);
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
  assert.match(code(app), /if \(state\.route === 'diary'\) return renderDiary\(nav\)/);
});

test('the formatted date is never written into the title', () => {
  // A title the user did not write would then be searchable as if they had.
  const title = viewCode.slice(viewCode.indexOf("#dia-title'"));
  assert.doesNotMatch(title.slice(0, 400), /formatLong|dayName/);
  assert.match(entryJs, /placeholder="Add a title \(optional\)"/);
});

test('the top controls are four things that each say what they do', () => {
  /* D1 had a second chevron pair labelled "Entry", meaning "the previous day I
   * actually wrote on". A real thing to want, and not a thing anyone reads off
   * a chevron — it lives in History now, where the month grid shows exactly
   * where those days are. */
  assert.match(entryJs, /aria-label="Previous day"/);
  assert.match(entryJs, /aria-label="Next day"/);
  assert.match(entryJs, /data-go="today"/);
  assert.match(entryJs, /id="dia-jump"/);
  assert.match(entryJs, /id="dia-history"/);
  assert.doesNotMatch(entryJs, /Previous entry|Next entry|prev-entry|next-entry/);
  assert.doesNotMatch(viewCode, /adjacentEntry/);
});

test('the date jump is the app\'s own grid, never a native date input', () => {
  // The native control cannot be styled, opens an operating-system panel in
  // the middle of a journal, and looks like a form field.
  assert.doesNotMatch(entryCode, /type="date"/);
  assert.doesNotMatch(viewCode, /type="date"/);
  assert.match(entryJs, /export function jumpHtml/);
  assert.match(entryJs, /data-jump-to=/);
  assert.match(viewCode, /kind: 'diary-jump'/);
});

test('the check-in uses the app\'s own controls, never a native select', () => {
  /* A browser dropdown in the middle of a journal reads as a form and makes
   * the whole spread feel like one — which is the impression D2 exists to
   * remove. The only <select> on the page is the block-style control in the
   * editor toolbar, which is chrome, not content. */
  const selects = checkinCode.match(/<select/g) ?? [];
  assert.equal(selects.length, 0, 'the check-in uses a native select');
  assert.match(checkinCode, /class="dia-chip/);
  assert.match(checkinCode, /role="radiogroup"/);
});

test('every check-in option carries a word', () => {
  /* Unchanged in spirit, wider in scope. D2.3 added an expressive face to each
   * broad feeling and four passive dimensions; §5 is explicit that the icon
   * SUPPORTS the label rather than replacing it, so every option — old and new
   * — still renders its word. */
  const fn = checkinCode.slice(checkinCode.indexOf('function chips('));
  assert.match(fn.slice(0, 1200), /<span>\$\{esc\(o\.label\)\}<\/span>/);
  for (const list of ['FEELINGS', 'SOCIAL', 'ENERGIES', 'NOURISHMENT', 'MOVEMENT',
    'OUTSIDE', 'SLEEP']) {
    const at = checkinCode.indexOf(`export const ${list} = [`);
    assert.ok(at > -1, `${list} is missing`);
    const block = checkinCode.slice(at, checkinCode.indexOf('];', at));
    const ids = (block.match(/id: '/g) ?? []).length;
    const labels = (block.match(/label: '/g) ?? []).length;
    assert.equal(labels, ids, `${list} has an option with no word`);
  }
  // A shortened chip keeps the full wording as its accessible name.
  assert.match(fn.slice(0, 1200), /o\.long \? `aria-label="\$\{esc\(o\.long\)\}"/);
});

test('a feeling opens into finer words, and the broad answer is complete on its own', async () => {
  const checkin = await import('../../web/diary-checkin.js' as string);
  // Two levels, never twenty.
  for (const f of checkin.FEELINGS) {
    assert.ok(f.detail.length >= 3 && f.detail.length <= 6,
      `${f.id} offers ${f.detail.length} finer words`);
  }
  // Choosing a broad feeling is never blocked on choosing a detail.
  assert.doesNotMatch(viewCode, /required|must choose/i);
});

test('a chosen chip can be un-chosen', () => {
  // Every one of these is optional, and a control you cannot un-choose has
  // trapped you into an answer you did not mean.
  const fn = viewCode.slice(viewCode.indexOf('function onChip'));
  assert.match(fn.slice(0, 1600), /c\.feeling === id.*delete c\.feeling/s);
  assert.match(fn.slice(0, 600), /dia\.entry\?\.energy === id \? null : id/);
  // Social and the four passive dimensions share one branch: same shape, same
  // toggle, and none of them writes a habit.
  assert.match(fn.slice(0, 1600),
    /group === 'social' \|\| PASSIVE_KEYS\.includes\(group\)[\s\S]{0,400}delete c\[group\]/);
});

test('the streak is a fact, not a scoreboard', () => {
  /* It MOVED in D2.1: continuity belongs beside the other things you keep up,
   * not at the bottom of the page you are writing on.
   *
   * D2.2 finished the move. The row no longer draws its own streak markup — it
   * calls `streakHtml`, the SAME function every ordinary habit row uses, which
   * is the whole of the visual-parity requirement in one line. What survives
   * from D2 is the tone: a run is stated, never demanded. */
  assert.doesNotMatch(checkinCode, /dia-streak/, 'the streak is back on the diary page');
  const rail = code(read('app.js'));
  const fn = rail.slice(rail.indexOf('function diarySystemHabitHtml'));
  assert.match(fn.slice(0, 1600), /streakHtml\(d\)/,
    'the Diary habit draws its own streak instead of sharing the habit one');
  const streak = rail.slice(rail.indexOf('function streakHtml'));
  assert.match(streak.slice(0, 500), /day streak/);
  assert.doesNotMatch(streak.slice(0, 500), /don't break|keep it up|streak lost|missed/i);
});

test('the guided prompts sit BELOW the free writing', () => {
  // A page that opens with five questions is a questionnaire.
  const spread = entryJs.slice(entryJs.indexOf('export function spreadHtml'));
  assert.ok(spread.indexOf('dia-editor') < spread.indexOf('promptsHtml'),
    'the prompts come before the open writing');
  const checkin = checkinJs.slice(checkinJs.indexOf('export function promptsHtml'));
  assert.match(checkin, /If you want a place to start/);
});

test('the right page repaints without touching the left', () => {
  /* A chip tap must not rebuild the editor: the caret may be in it, and
   * replacing a contenteditable destroys the selection and the undo history. */
  const fn = viewCode.slice(viewCode.indexOf('function paintCheckin'));
  assert.match(fn.slice(0, 500), /\.dia-right \.dia-scroll/);
  assert.doesNotMatch(fn.slice(0, 500), /paintSheet|spreadHtml/);
});

test('the reflection is stored as one object, not as a column per question', () => {
  const schema = readFileSync(join('src', 'db', 'schema.ts'), 'utf8');
  assert.match(schema, /reflection: jsonb\('reflection'\)/);
  // …and the prompts and check-in are validated at the boundary, like a doc.
  const refl = readFileSync(join('src', 'lib', 'diary-reflection.ts'), 'utf8');
  assert.match(refl, /export function validateReflection/);
  assert.match(refl, /export function reflectionToText/);
});

test('what is typed into a prompt or a note is searchable', () => {
  // Half of what a person writes in D2 goes into the prompts and the check-in.
  // A search that could not see it would be lying about having looked.
  const route = readFileSync(join('src', 'routes', 'diary.ts'), 'utf8');
  assert.match(route, /function searchText\(doc: any, refl/);
  assert.match(route, /reflectionToText\(refl\)/);
  assert.match(route, /if \(doc !== undefined \|\| refl !== undefined\)/);
});

test('presence in the calendar is never carried by colour alone', () => {
  /* WIDENED by D2.3 §12. A written day now shows the same three indicators the
   * right page uses, so presence is carried by FOUR non-colour things: the
   * indicator row, the context line, the bolder weight and the accessible
   * name. The tint is the fifth and is decoration. */
  assert.match(historyJs, /has an entry.*no entry|no entry/);
  assert.match(historyJs, /class="dia-day-ind"/);
  assert.match(historyJs, /class="dia-day-prev"/);
  assert.match(html, /\.dia-day-cell\.has-entry \.dia-day-n\{font-weight:700/);
  assert.match(historyJs, /aria-label="\$\{esc\(label\)\}"/);
  // Every exact value reaches the accessible name, not only the picture.
  assert.match(historyJs, /felt \$\{feeling\.label\.toLowerCase\(\)\}/);
  assert.match(historyJs, /energy \$\{\(labelOf\(ENERGIES, energy\)/);
  assert.match(historyJs, /social battery \$\{\(labelOf\(SOCIAL, social\)/);
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

test('the date change moves the spread, not the frame, and never curls', () => {
  assert.match(html, /@keyframes diaLeaveNext\{to\{transform:translateX\(-3%\)/);
  assert.match(html, /@keyframes diaEnterNext\{from\{transform:translateX\(3%\)/);
  // 3%, not the Book's 14%: a diary day is replaced in the same frame, and a
  // large translation reads as the layout breaking rather than as time passing.
  assert.doesNotMatch(html, /diaLeave[^}]*translateX\(-?1[0-9]%\)/);
  /* REBUILT by D2.3 §21. D2.2 animated the live book and AWAITED it before
   * fetching, which added 200ms to every day change and left the old day as
   * the only thing on screen while it played. The outgoing day is now a
   * detached clone stacked over the same box, so the frame and the gutter
   * never move and the incoming day arrives over it. */
  assert.match(html, /\.dia-ghost\{position:absolute/);
  assert.match(html, /\.dia-ghost\.leave-next\{animation-name:diaLeaveNext\}/);
  const turn = viewCode.slice(viewCode.indexOf('function beginTurn'));
  assert.match(turn.slice(0, 1800), /reducedMotion\(\)/);
  assert.match(turn.slice(0, 1800), /book\.cloneNode\(true\)/);
  // The clone is inert and carries no ids — never a second editor.
  assert.match(turn.slice(0, 1800), /ghost\.inert = true/);
  assert.match(turn.slice(0, 1800), /removeAttribute\('id'\)/);
  assert.match(turn.slice(0, 1800), /contenteditable', 'false'/);
  // 260ms, the stated structural maximum.
  assert.match(viewCode, /const TURN_MS = 260/);
});

test('an animation that never finishes cannot strand the page', () => {
  const fn = viewCode.slice(viewCode.indexOf('function afterAnimation'));
  assert.match(fn.slice(0, 400), /setTimeout\(finish, ms \+ 60\)/);
});

/* ══ Regression ════════════════════════════════════════════════════════ */

test('clicking a section you are already in returns you to its top level', () => {
  /* Inside an open Book, "Library" in the sidebar has to mean the shelf. It
   * used to mean nothing at all — the same-route guard returned early, so the
   * one control that looks like a way out was the one that did not work.
   *
   * D2.2 changed HOW the hash is written, not what happens: a raw
   * `location.hash =` was invisible to nav.js and counted as a navigation,
   * which is the Library regression. Everything goes through `setHash` now. */
  assert.match(code(app), /async function goToSectionRoot\(id, nav = navToken\(\)\)/);
  assert.match(code(app), /if \(id === 'library'\)[\s\S]{0,240}setHash\('#library'\)/);
  assert.match(code(app), /if \(id === 'diary'\)[\s\S]{0,240}setHash\('#diary'\)/);
  assert.doesNotMatch(code(app), /location\.hash = '#/, 'a raw hash write is back');
  // Only when the hash is deeper than the section root.
  assert.match(code(app), /if \(path\.length > 1\) await goToSectionRoot\(id, nav\)/);
  // And the flush still happens first, so nothing typed is lost on the way out.
  assert.match(code(app), /goToSectionRoot[\s\S]{0,400}await libraryWillLeave\(\)/);
});

test('the closed cover is one page of the open book', () => {
  // Measured in a browser: cover height 569 == open book height 569.
  assert.match(html, /\.bk-cover-frame\{[^}]*aspect-ratio:420\/297/);
  assert.match(html, /\.bk-stage-cover \.bk-book\{[^}]*height:100%/);
  assert.match(html, /\.bk-stage-cover \.bk-book\{[^}]*aspect-ratio:210\/297/);
  // The arrow slots are reserved so both states get the same inner width.
  assert.match(html, /\.bk-arrow-ghost\{visibility:hidden/);
  assert.match(read('library-book.js'), /bk-arrow bk-arrow-ghost/);
});

test('the Book\'s one-page-at-a-time rule never claims the Diary', () => {
  // Without the :not(), it hid the diary's entire right page on a phone.
  assert.match(html, /\.bk-book\.bk-spread:not\(\.dia-book\) \.bk-page-right\{display:none\}/);
  assert.match(html, /\.bk-book\.bk-spread:not\(\.dia-book\)\{aspect-ratio:210\/297/);
});

test('Library and the Book editor are unchanged by the extraction', () => {
  // The geometry, the grid and the Library route all still stand.
  for (const r of ['aspect-ratio:420/297', 'padding:28px 32px 18px 58px',
    'border-radius:20px 20px 4px 4px', 'height:round(down,100%,30px)']) {
    assert.ok(html.includes(r), `Library's ${r} moved`);
  }
  assert.match(code(app), /if \(state\.route === 'library'\) return renderLibrary\(nav\)/);
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
