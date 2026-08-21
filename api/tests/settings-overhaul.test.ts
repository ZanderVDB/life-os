/**
 * Settings as a control centre rather than a column of cards in the corner.
 *
 * The rules these hold down are the ones that were broken before: a status
 * that nobody reported, a control for something that cannot happen, a number
 * stated before it was known, and a native <select> opening as a white sheet
 * in a dark app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');

const settings = read('settings.js');
const app = read('app.js');
const html = read('index.html');
const menu = read('menu.js');

test('the dropdown is app-wide, not a Calendar part borrowed by Settings', () => {
  /* The rule is now: if Life OS owns the dropdown UI, it uses this component.
   * A component that only Calendar can reach cannot carry that rule. */
  assert.match(menu, /export function wireMenus/, 'menu.js is not the shared dropdown');
  assert.match(menu, /export const selectField/, 'the trigger markup is not shared');
  assert.match(settings, /from '\.\/menu\.js'/, 'Settings does not use the shared dropdown');
  assert.match(app, /import \{ wireMenus \} from '\.\/menu\.js'/,
    'Settings controls are never wired to the shared dropdown');

  // The scope it anchors inside is a page region here, not a dialog — which is
  // the whole point of it no longer being modal-only.
  assert.match(app, /wireMenus\(page, page,/, 'the dropdown is still wired against a dialog');
  assert.match(html, /\.set-page\{[^}]*position:relative/,
    'the settings page is not a positioning context, so a menu would escape it');
});

test('no native select survives anywhere in Settings', () => {
  assert.ok(!/<select/.test(settings), 'Settings still opens an operating-system menu');
  assert.ok(!/qc-sel|habit-freq"/.test(settings), 'the old native frequency control is still there');
  assert.match(settings, /selectField\(`habit-freq-\$\{h\.id\}`/,
    'habit frequency is not the shared dropdown');
});

test('the rail is gone from Settings and the width is given back', () => {
  assert.match(html, /body:has\(\.set-page\) \.rail\{display:none\}/,
    'the Habits rail still takes a third of Settings');
  assert.match(html, /body:has\(\.set-page\) \.main-wrap\{grid-template-columns:minmax\(0,1fr\) 0\}/,
    'the rail is hidden but its column is still reserved');
  // And only inside Settings.
  assert.ok(!/\.rail\{display:none\}(?![\s\S]*body:has)/.test(html.slice(0, html.indexOf('.set-page'))),
    'the rail was hidden globally');
});

test('a number is not shown before it is known', () => {
  /* Landing straight on Settings never loaded the task list, so every area
   * read "0 tasks" — not a placeholder, a wrong number. */
  assert.match(settings, /state\.tasksLoaded/, 'the area count does not check whether tasks are loaded');
  assert.match(settings, /n === null \? '' :/, 'an unknown count still renders as a number');
  assert.match(app, /state\.tasksLoaded = true;/, 'nothing ever marks the task list as loaded');
  assert.match(app, /settingsTab === 'areas' && !state\.tasksLoaded/,
    'opening Areas does not fetch the tasks it counts');
});

test('integration status is read, never asserted', () => {
  const panel = settings.slice(settings.indexOf('function integrationsPanel'),
    settings.indexOf('const assistantSection'));
  // Each state has to be reachable from something the server said.
  for (const [what, re] of [
    ['unreachable', /g\.unreachable/],
    ['server not configured', /!g\?\.configured/],
    ['no connection', /const c = g\.connection;\s*\n\s*if \(!c\)/],
    ['revoked', /c\.status === 'revoked'/],
    ['read only', /c\.canWrite/],
    ['failing', /c\.failureCount/],
  ] as [string, RegExp][]) {
    assert.match(panel, re, `the ${what} state is not handled`);
  }
  // Disconnected is a real product state; "not connected" was migration-era
  // language the everyday UI is not allowed to use.
  assert.ok(!/not connected/i.test(settings), 'migration language is back in Settings');

  // Raw scopes and Google's own error text stay behind a disclosure.
  assert.match(panel, /<details class="set-diag">/, 'diagnostics are not behind a disclosure');
  const beforeDetails = panel.slice(0, panel.indexOf('<details'));
  assert.ok(!/c\.scopes/.test(beforeDetails), 'OAuth scopes are shown in the open');
});

test('every action in Settings reaches a real endpoint', () => {
  const wiring = app.slice(app.indexOf('function wireIntegrations'));
  for (const [id, path] of [
    ['gc-connect', '/connect'], ['gc-reconnect', '/connect'],
    ['gc-sync', '/sync'], ['gc-disconnect', '/disconnect'],
  ] as [string, string][]) {
    assert.ok(wiring.includes(id), `${id} is drawn but never wired`);
    assert.ok(wiring.includes(`integrations/google-calendar${path}`),
      `${id} has no endpoint behind it`);
  }
  // Disconnect is destructive and says what it does and does not touch.
  assert.match(wiring, /confirm\(`Disconnect Google Calendar\?/, 'disconnect has no confirmation');
  assert.match(wiring, /Nothing in \\?\n?Google Calendar itself is changed/,
    'the confirmation does not say what is left alone');
});

test('one visual grammar, and group titles are not cards inside cards', () => {
  for (const part of ['.set-sec{', '.set-sec-h{', '.set-card{', '.set-row{',
    '.set-label{', '.set-desc{', '.set-badge{', '.set-item{', '.set-add{']) {
    assert.ok(html.includes(part), `the shared Settings grammar is missing ${part}`);
  }
  // Rows divide inside one card rather than each being its own card.
  assert.match(html, /\.set-row \+ \.set-row\{border-top:1px solid var\(--hairline\)\}/,
    'settings rows are separate cards again');
  assert.ok(!/\.set-card [^{]*\.set-card/.test(html), 'a card is nested inside a card');

  // Every badge tone is defined, or the whole declaration is silently dropped.
  for (const tone of ['is-on', 'is-warn', 'is-off', 'is-later']) {
    assert.ok(html.includes(`.set-badge.${tone}{`), `the ${tone} badge has no styling`);
  }
});

test('version belongs to App, and the ambiguous arrow is gone', () => {
  const account = settings.slice(settings.indexOf('function accountPanel'),
    settings.indexOf('function appearancePanel'));
  assert.ok(!/LIFE_OS_BUILD/.test(account), 'the build is duplicated on Account');

  /* The habit control was a bare down-arrow with a title attribute. It gave no
   * clue whether it meant reorder, collapse, or archive. */
  assert.ok(!/&#8595;|\u2193/.test(settings), 'the ambiguous arrow control is back');
  assert.match(settings, /data-habit-archive="\$\{h\.id\}"[\s\S]{0,120}>Archive</,
    'the archive control does not say what it does');
});
