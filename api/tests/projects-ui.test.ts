/**
 * Phase E2 — the Projects interface: motion architecture, overview rules,
 * failure behaviour and the things that must NOT be there.
 *
 * The motion assertions are structural rather than visual. Whether a transition
 * looks right is a screenshot question; whether it can run at all is a code
 * question, and it is the one that keeps being answered wrongly — C4's FLIP was
 * written after the list already rebuilt itself, so it animated nodes that no
 * longer existed. These tests hold the architecture that makes motion possible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const html = read('index.html');
const app = read('app.js');
const projects = read('projects.js');
const modal = read('project-modal.js');
const routes = read('routes.js');

const strip = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
const appCode = strip(app);
const pjCode = strip(projects);
const modalCode = strip(modal);
const css = strip(html);

/**
 * The Projects section of app.js.
 *
 * Scoped deliberately: assertions about Projects must not pass or fail because
 * of the habit ring's 900ms celebration or the Calendar's event routes.
 */
const pjSection = appCode.slice(
  appCode.indexOf('PROJECTS'),
  appCode.indexOf('Google Calendar connection'),
);

function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `${decl} not found`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:async )?(?:export )?(?:function |const \w+ = )/);
  return end === -1 ? rest : rest.slice(0, end);
}

/* ── Motion architecture ─────────────────────────────────────────────── */

test('motion: the list reconciles in place — it is never rebuilt', () => {
  // The whole architecture rests on this. A row that changes status has to be
  // the SAME node afterwards or the move cannot be animated.
  const fn = body(pjCode, 'export function applyGroups(container, groups, areaName)');
  assert.match(fn, /rows\.appendChild\(row\)/,
    'rows are not moved — appendChild is what relocates an existing node');
  assert.match(fn, /existing\.get\(p\.id\)/, 'rows are not looked up by id, so identity is lost');
  // The container's innerHTML must never be replaced wholesale.
  assert.ok(!/container\.innerHTML\s*=/.test(fn),
    'applyGroups rebuilds the list, which silently turns every transition into a jump');
});

test('motion: paint is wrapped in FLIP', () => {
  const fn = body(appCode, 'function paintProjects()');
  assert.match(fn, /flip\(list\.querySelectorAll\('\.pj-row'\), \(\) => \{\s*applyGroups/,
    'the group change is applied without measuring first');
});

test('motion: a filter change crossfades rather than pretending rows moved', () => {
  // Different rows. Animating them as if they had travelled is a lie about
  // what happened.
  const fn = body(appCode, 'async function setProjectFilter(filter)');
  assert.match(fn, /animate\(\[\{ opacity: 1 \}, \{ opacity: 0 \}\]/, 'no fade out');
  assert.match(fn, /el\.innerHTML = ''/, 'the crossfade reuses rows from a different filter');
  assert.match(fn, /if \(pj\.filter !== filter\) return;/,
    'a slow response can repaint a filter the user has already left');
});

test('motion: only the locked tokens, and no springs', () => {
  const sources = pjSection + pjCode + modalCode;
  const durations = [...sources.matchAll(/duration: (\d+)/g)].map((m) => Number(m[1]));
  const allowed = new Set([90, 120, 140, 160, 200, 220, 260, 320, 1300, 1400, 8000, 1200, 2000]);
  for (const d of durations) {
    assert.ok(allowed.has(d), `${d}ms is not a locked motion token`);
  }
  assert.ok(!/spring|overshoot|bounce|elastic|cubic-bezier\([^)]*,\s*1\.\d/.test(sources),
    'a spring or overshoot easing crept in');
});

test('motion: reduced motion is honoured everywhere something moves', () => {
  const animated: [string, string][] = [
    ['async function setProjectFilter(filter)', 'setProjectFilter'],
    ['function undoBar(message, onUndo)', 'undoBar'],
    ['async function renderProjectDetail(scroll)', 'renderProjectDetail'],
  ];
  for (const [decl, name] of animated) {
    assert.match(body(appCode, decl), /reducedMotion\(\)/, `${name} animates regardless`);
  }
  assert.match(modalCode, /if \(!reducedMotion\(\)\)/, 'the modal animates regardless');
});

test('motion: a new row is highlighted after it lands, not while it moves', () => {
  const fn = body(appCode, 'function newProject()');
  assert.match(fn, /await refreshProjects\(\)/, 'the highlight runs before the row exists');
  assert.match(fn, /requestAnimationFrame\(\(\) => \{[\s\S]*?is-new/,
    'the highlight is applied in the same frame as the insertion');
  assert.match(css, /\.pj-row\.is-new\{animation:pj-land/, 'there is no landing highlight');
  // …and it is a highlight, not a celebration.
  // Completion is information. (Scoped to Projects — Today's habit ring has its
  // own restrained mark, which is not this test's business.)
  assert.ok(!/confetti|celebrat|party/i.test(pjSection + pjCode + modalCode));
});

/* ── Overview rules ──────────────────────────────────────────────────── */

test('overview: a list at every width, never a card grid', () => {
  assert.match(css, /\.pj-list\{display:flex;flex-direction:column/,
    'the overview is a grid, which has to be redesigned for a phone');
  assert.ok(!/\.pj-list\{[^}]*grid-template-columns/.test(css));
  // The mobile rule changes density, not structure.
  const mobile = css.slice(css.indexOf('@media (max-width:900px)'));
  assert.match(mobile, /\.pj-row\{flex-direction:column/, 'rows do not restack on a phone');
});

test('overview: no rail, and none is rendered behind it', () => {
  assert.match(css, /body:has\(\.pj-head\) \.rail\{display:none\}/, 'Projects renders a rail');
  assert.match(css, /body:has\(\.pj-head\) \.main-wrap\{grid-template-columns:minmax\(0,1fr\) 0\}/,
    'a rail column is reserved, so the frame is off-centre');
});

test('overview: no decorative statistics', () => {
  // The filter counts answer "is there anything behind this?" — a decision.
  // A total project count answers nothing.
  const head = body(pjCode, 'export function projectsHeaderHtml(filter, available = {})');
  assert.ok(!/projects?\.length|total|Total/.test(head),
    'the header reports a total, which changes nothing the user does');
  assert.match(head, /f\.id === 'working' \? null : available\[f\.id\]/,
    'the counts are not scoped to the filters they belong to');
});

test('overview: every mark is a word, never an unexplained dot', () => {
  const row = body(pjCode, 'export function projectRowHtml(p, areaName)');
  assert.match(row, /STATUS_LABEL\[p\.status\]/, 'status is shown without a label');
  assert.match(row, /FOCUS_LABEL\[p\.focus\]/, 'focus is shown without a label');
  assert.match(row, /title="\$\{esc\(health\.why\)\}"/, 'a health mark appears without saying why');
  assert.ok(!/pj-dot|<i class="dot/.test(row), 'an unexplained dot is rendered');
});

test('overview: the next action outranks the metadata', () => {
  const row = body(pjCode, 'export function projectRowHtml(p, areaName)');
  // Title, then next action, then the marks.
  assert.ok(row.indexOf('pj-title') < row.indexOf('pj-next'), 'the title is not first');
  assert.ok(row.indexOf('pj-next') < row.indexOf('pj-marks'),
    'metadata is rendered above the next action');
  assert.match(row, /No next action — add one/, 'a project with nothing to do says nothing');
});

test('overview: empty states say what is missing and what to do', () => {
  const fn = body(pjCode, 'export function projectsEmptyHtml(filter, available = {})');
  assert.match(fn, /finite outcome/, 'the first-run state does not explain what a project is');
  assert.match(fn, /another filter/, 'an empty Working view does not mention what is elsewhere');
  assert.ok(!/>Nothing here</.test(fn) || /words\[filter\] \?\?/.test(fn),
    'a generic "Nothing here" is shown when the system knows why');
});

/* ── Loading and failure ─────────────────────────────────────────────── */

test('loading: skeleton rows, never an empty page that fills', () => {
  const fn = body(appCode, 'async function loadProjects()');
  assert.match(fn, /pj-skel/, 'the first load flashes an empty list');
  assert.match(fn, /if \(!pj\.data\)/, 'the skeleton is shown even when data is already on screen');
  assert.match(css, /\.pj-skel\{height:\d+px/, 'the skeleton has no height, so the page collapses');
});

test('failure: an error is an error, never an empty list', () => {
  const fn = body(appCode, 'async function loadProjects()');
  assert.match(fn, /scroll\.innerHTML = errorHtml\(e\.message\)/,
    'a failed load renders emptiness, which reads as "you have no projects"');
  assert.match(fn, /#retry/, 'a failed load offers no way back');
});

test('failure: one authoritative mutation per interaction', () => {
  // A double click must not create two projects.
  assert.match(modalCode, /if \(saving\) return;/, 'the save button can be pressed twice');
  assert.match(modalCode, /btn\.disabled = true/, 'the button stays live during the request');
  // …and the modal closes only after the write actually succeeded.
  const save = modalCode.slice(modalCode.indexOf("$('#pm-save').onclick"));
  assert.ok(save.indexOf('await ctx.onSave') < save.indexOf('close(true)'),
    'the modal closes optimistically, so a failure has nowhere to report itself');
});

test('failure: the user\'s text is never discarded', () => {
  assert.match(modalCode, /isDirty\(\)\s*&& !confirm/, 'closing a dirty form loses the typing');
  const notes = body(appCode, 'function wireProjectNotes(project)');
  assert.match(notes, /setState\('error', 'Not saved — retry'\)/,
    'a failed note save reports nothing');
  assert.ok(!/ta\.value = /.test(notes), 'a failed save overwrites what the user typed');
  assert.match(notes, /badge\.onclick = \(\) => save\(\)/, 'there is no retry');
});

test('failure: no false success', () => {
  const notes = body(appCode, 'function wireProjectNotes(project)');
  const saveFn = notes.slice(notes.indexOf('const save = async'));
  assert.ok(saveFn.indexOf('await api(') < saveFn.indexOf("setState('saved'"),
    '"Saved" is shown before the request completes');
});

test('failure: completion asks rather than guessing', () => {
  const fn = body(appCode, 'async function completeProject(project)');
  assert.match(fn, /detail\?\.reason !== 'open_tasks'/, 'a real error is treated as a prompt');
  assert.match(fn, /openChoiceDialog\(\{/, 'the decision is asked with a browser confirm');
  assert.match(fn, /openTasks: choice/, 'the choice is not passed through');
  assert.match(fn, /if \(!choice\) return;/, 'dismissing the dialog still completes the project');
  assert.ok(!/status: 'done'/.test(fn), 'the client marks tasks done on completion');
});

test('failure: archive offers undo, and delete keeps the work', () => {
  const arch = body(appCode, 'async function archiveProject(project)');
  assert.match(arch, /undoBar\(/, 'archiving is not reversible from the UI');
  const del = body(appCode, 'async function deleteProject(project, silent = false)');
  assert.match(del, /tasksKept/, 'deleting does not report what happened to the work');
});

/* ── Detail ──────────────────────────────────────────────────────────── */

test('detail: one column, no rail, four sections and nothing promised', () => {
  const fn = body(pjCode, 'export function projectDetailBodyHtml(p, tasks, taskHtml)');
  for (const section of ['Next action', 'Tasks', 'Notes']) {
    assert.ok(fn.includes(section), `the ${section} section is missing`);
  }
  for (const absent of ['Boards', 'Resources', 'Timeline', 'Library', 'Files',
    'People', 'Phases', 'History', 'AI chat', 'Milestones']) {
    assert.ok(!fn.includes(absent), `an empty ${absent} section promises a feature`);
  }
  assert.match(css, /\.pjd-body\{display:flex;flex-direction:column/, 'detail is not one column');
});

test('detail: Back restores the list that was left', () => {
  const open = body(appCode, 'async function openProjectDetail(id)');
  assert.match(open, /pj\.resume = \{[\s\S]*?filter: pj\.filter[\s\S]*?scrollTop[\s\S]*?rowId/,
    'the list position is not captured, so Back cannot restore it');
  const close = body(appCode, 'async function closeProjectDetail(push = true)');
  assert.match(close, /pj\.filter = back\.filter/, 'the filter is not restored');
  assert.match(close, /window\.scrollTo\(\{ top: back\.scrollTop/, 'the scroll position is lost');
  assert.match(close, /row\?\.focus/, 'focus is not returned to the row');
});

test('detail: the project is a real destination', () => {
  assert.match(appCode, /const projectFromHash/, 'a project cannot be linked to');
  assert.match(appCode, /history\.pushState\(null, '', `#projects\/\$\{id\}`\)/,
    'opening a project does not change the URL, so Back cannot leave it');
  const load = body(appCode, 'async function loadProjects()');
  assert.match(load, /if \(fromUrl && !pj\.openId\)/, 'a refresh on a project URL opens the list');
});

test('detail: tasks are the same records, editor and rows as everywhere else', () => {
  // No duplicate task table, no second task UI.
  assert.match(appCode, /projectDetailBodyHtml\(data\.project, data\.tasks, taskHtml\)/,
    'the detail page renders its own task row instead of the shared one');
  const add = body(appCode, 'function addProjectTask(project)');
  assert.match(add, /openTaskModal\(\{/, 'a second task editor was built');
  assert.match(add, /projectId: project\.id/, 'a task added here does not belong to the project');
  assert.match(add, /areaId: body\.areaId \?\? project\.areaId/, 'the area is not inherited');
  assert.match(add, /project\.focus === 'now' \? 'today' : 'future'/,
    'a task in a quiet project is forced onto Today');
});

test('detail: notes are plain, with no AI and no browser call to a model', () => {
  const fn = body(pjCode, 'export function projectDetailBodyHtml(p, tasks, taskHtml)');
  assert.match(fn, /<textarea class="pjd-notes"/, 'notes are not a plain field');
  assert.ok(!/anthropic|Structure with AI|api\.anthropic\.com/i.test(pjCode + appCode),
    'an AI rewrite action reached Projects');
  assert.ok(!/contenteditable|block-editor/i.test(pjCode), 'a block editor was introduced');
});

/* ── Creation ────────────────────────────────────────────────────────── */

test('create: four required fields, and status is not one of them', () => {
  assert.match(modalCode, /pm-title/, 'no title field');
  assert.match(modalCode, /pm-outcome/, 'no outcome field');
  assert.match(modalCode, /pm-area/, 'no area field');
  assert.match(modalCode, /pm-focus/, 'no focus field');
  // Status is decided by whether there is work — asking would make the user
  // choose between two words the form cannot explain.
  assert.ok(!/pm-status/.test(modalCode), 'creation asks for a lifecycle status');
  for (const absent of ['milestone', 'phase', 'priority', 'startDate', 'people', 'board']) {
    assert.ok(!new RegExp(absent, 'i').test(modalCode), `creation exposes ${absent}`);
  }
});

test('create: the outcome placeholder is the definition, not a label', () => {
  assert.match(modalCode, /placeholder="What is true when this is done\?"/,
    'the outcome field does not explain itself');
  assert.match(modalCode, /focus: p\?\.focus \?\? 'upcoming'/,
    'a new project defaults to Now, so everything arrives demanding attention');
});

test('create: the modal traps focus and returns it', () => {
  assert.match(modalCode, /FOCUSABLE/, 'no focus trap');
  assert.match(modalCode, /if \(opener\?\.isConnected\) opener\.focus\(\)/, 'focus is not returned');
  assert.match(modalCode, /e\.key === 'Escape'/, 'Escape does not close');
});

/* ── Accessibility ───────────────────────────────────────────────────── */

test('a11y: rows are reachable and openable by keyboard', () => {
  const row = body(pjCode, 'export function projectRowHtml(p, areaName)');
  assert.match(row, /tabindex="0"/, 'a row cannot be focused');
  assert.match(row, /aria-label="\$\{esc\(p\.title\)\}"/, 'a row announces nothing');
  const wire = body(appCode, 'function wireProjectRows()');
  assert.match(wire, /e\.key !== 'Enter'/, 'Enter does not open a row');
});

test('a11y: state is never conveyed by colour alone', () => {
  const row = body(pjCode, 'export function projectRowHtml(p, areaName)');
  // Each mark carries its own text.
  assert.match(row, /class="pj-state">\$\{esc\(STATUS_LABEL/);
  assert.match(row, /class="pj-focus">\$\{esc\(FOCUS_LABEL/);
  // The notes save state is a word, not a tint.
  assert.match(css, /\.pjd-save\[data-state="error"\]\{color:var\(--danger\)/);
  assert.match(appCode, /setState\('saving', 'Saving…'\)/, 'the save state has no text');
});

test('a11y: touch targets and no hover-only actions on small screens', () => {
  const mobile = css.slice(css.indexOf('@media (max-width:900px)'));
  assert.match(mobile, /\.pj-row \.pj-more\{opacity:1\}/, 'the row menu is hover-only on touch');
  assert.match(mobile, /\.pj-more\{width:38px;height:38px\}/, 'the touch target is too small');
});

/* ── Auth freshness ──────────────────────────────────────────────────── */

test('auth: the token is fetched per request, not from a background timer', () => {
  // The bug this replaces: a 45-minute setInterval refreshing a 60-minute
  // token. Browsers throttle background timers and Chrome freezes them in a
  // hidden tab, so leaving the tab in the background let the token expire and
  // the next action failed with "Invalid or expired sign-in token."
  assert.match(appCode, /async function authToken\(force = false\)/,
    'there is no on-demand token');
  assert.match(appCode, /authUser\.getIdToken\(force\)/,
    'the token is not fetched from Firebase per request');
  assert.ok(!/setInterval\([\s\S]{0,200}getIdToken/.test(appCode),
    'a background refresh timer is back — it does not fire in a hidden tab');
});

test('auth: a 401 is retried once with a forced refresh', () => {
  const fn = body(appCode, 'async function api(path, opts = {})');
  assert.match(fn, /if \(res\.status === 401 && \(authUser \|\| devToken\)\)/,
    'an expired token is not retried, so the user has to reload');
  assert.match(fn, /const fresh = await authToken\(true\)/, 'the retry reuses the dead token');
  // Exactly one retry. A fresh token that is also rejected means the session is
  // gone, and looping would only delay saying so.
  assert.equal((fn.match(/authToken\(true\)/g) ?? []).length, 1, 'the retry can loop');
  assert.match(fn, /Your sign-in has expired\. Reload the page to sign in again\./,
    'a dead session reports a raw API error instead of what to do about it');
});

test('auth: an ID token is never written to disk', () => {
  // It was stored and never read back — a Firebase ID token sitting in
  // plaintext localStorage, outliving the tab that fetched it.
  assert.ok(!/setItem\('los2_token'/.test(appCode),
    'the ID token is written to localStorage');
  // Sign-out still clears anything an older build left behind.
  assert.match(appCode, /removeItem\('los2_token'\)/, 'an old stored token is never cleared');
});

/* ── Safety ──────────────────────────────────────────────────────────── */

test('safety: Projects is a real route now, and nothing else changed', () => {
  assert.match(routes, /\{ id: 'projects', label: 'Projects', icon: 'projects' \}/,
    'Projects is still a placeholder');
  for (const stillPlaceholder of ['diary', 'library', 'brain']) {
    assert.match(routes, new RegExp(`id: '${stillPlaceholder}'[^}]*placeholder: true`),
      `${stillPlaceholder} stopped being a placeholder`);
  }
});

test('safety: no Google write, no boards, no library, no AI', () => {
  const all = pjSection + pjCode + modalCode;
  for (const forbidden of ['calendar\\.events\\b', 'calendar/write', 'auth/calendar\\b']) {
    assert.ok(!new RegExp(forbidden).test(all), `a Google write scope appears (${forbidden})`);
  }
  // …and the API still asks for read-only and nothing else.
  const google = readFileSync(join('src', 'lib', 'google-calendar.ts'), 'utf8');
  assert.match(google, /auth\/calendar\.readonly'/, 'the Google scope changed');
  assert.ok(!/auth\/calendar'/.test(google), 'a Google write scope was added');
  for (const absent of ['/boards', '/library', '/ai/', 'aiPropose']) {
    assert.ok(!all.includes(absent), `${absent} shipped in E2`);
  }
});

test('safety: Calendar is untouched by Projects', () => {
  // Projects reuses the Calendar frame variables but must not redefine the
  // Calendar's own layout rules.
  assert.ok(!/body:has\(\.pj-head\) \.cal-/.test(css), 'Projects overrides Calendar styles');
  assert.match(css, /body:has\(\.cal-head\) \.main-wrap\{grid-template-columns:minmax\(0,1fr\) 0\}/,
    'the Calendar frame rule was disturbed');
});
