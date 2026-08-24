/**
 * Shell and PWA contract tests.
 *
 * The web app is plain JS with no test runner of its own, so these assert
 * against the SOURCE — the manifest, the service worker, the stylesheet and the
 * app module. That is a real limitation and worth stating: a source assertion
 * proves a rule is written down, not that a browser honours it. The runtime
 * behaviour (registration, update flow, cache contents, tap targets, overflow)
 * was verified in a real browser and is recorded in build-progress.md.
 *
 * What these DO catch, and catch cheaply, is regression: someone deleting the
 * no-store on API calls, reintroducing a profile switcher, caching an
 * authenticated response, or letting the cache name lose its version.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
/* index.html + app.css: the stylesheet moved out of the page so the home
 * page is 5KB instead of 350KB. These assertions are about the app's CSS,
 * which is still the app's CSS — it just has its own file now. */
const html = read('index.html') + read('app.css');
const app = read('app.js');
const sw = read('sw.js');
const pwa = read('pwa.js');
const routes = read('routes.js');
const settings = read('settings.js');
const server = read('server.js');
const manifest = JSON.parse(read('manifest.webmanifest'));

/**
 * Strips comments before matching.
 *
 * Needed because several of these rules are also DESCRIBED in comments — the
 * service worker's comment says "Deliberately NOT skipWaiting()", which a naive
 * search reads as the very call it is promising not to make.
 */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  // Not anchored with `$`: these files have CRLF endings, and the trailing \r
  // defeated the anchor so line comments survived the strip — which made the
  // service-worker test read its own "Deliberately NOT skipWaiting()" comment
  // as the call it promises not to make.
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

/* ── Shell structure ─────────────────────────────────────────────────── */

test('shell: the three-column layout and every region exist', () => {
  assert.match(html, /\.shell\{display:grid/, 'no shell grid');
  // Legacy's structure: TWO top-level columns, with content + rail nested
  // inside so they can share a gutter and a max-width.
  assert.match(html, /\.shell\{display:grid;grid-template-columns:var\(--sidebar-w\) minmax\(0,1fr\)/,
    'the app is not two columns');
  assert.match(html, /\.main-wrap\{display:grid;grid-template-columns:minmax\(0,1fr\) var\(--rail-w\)/,
    'content and rail are not a nested grid');
  for (const sel of ['.sidebar', '.rail', '.composer', '.main-scroll', '.mobile-bar']) {
    assert.ok(html.includes(sel), `${sel} missing from the stylesheet`);
  }
  // These exact numbers are ported from Legacy v244. They ARE the approved
  // design and cannot be re-derived from principles — which is precisely how
  // the first attempt regressed.
  assert.match(html, /--sidebar-w:232px/, 'sidebar width drifted from Legacy');
  assert.match(html, /--rail-w:380px/, 'rail width drifted from Legacy');
  assert.match(html, /--gutter:56px/, 'the content/rail gutter drifted from Legacy');
  assert.match(html, /--content-max:2200px/, 'the content max-width drifted from Legacy');
  assert.match(html, /--composer-max:1544px/, 'the composer max-width drifted from Legacy');
  assert.match(html, /padding:32px 32px 140px 44px/, 'main-wrap padding drifted from Legacy');
});

test('shell: renders once — a route change must not redraw the sidebar or rail', () => {
  // renderShell writes root.innerHTML; loadRoute must only touch main-scroll.
  const loadRoute = app.slice(app.indexOf('async function loadRoute'));
  const body = loadRoute.slice(0, loadRoute.indexOf('\nfunction greetingHtml'));
  assert.ok(!body.includes('renderShell('), 'loadRoute redraws the whole shell');
  assert.ok(!/root\.innerHTML/.test(body), 'loadRoute replaces the shell root');
  assert.ok(body.includes("getElementById('main-scroll')"), 'loadRoute does not target main-scroll');
});

test('nav: one sliding indicator, moved with transform only', () => {
  assert.match(html, /\.nav-pill\{[^}]*transform:translate3d\(0,var\(--pill-y[^}]*\}/,
    'the indicator does not use translate3d');
  assert.match(html, /\.nav-pill\{[^}]*transition:transform/, 'the indicator does not transition transform');
  // translateY only — never left/top, which would not composite on the GPU.
  const pillRule = html.slice(html.indexOf('.nav-pill{'), html.indexOf('.nav-pill.snap'));
  assert.ok(!/\bleft:\s*\d/.test(pillRule.replace('left:0', '')), 'indicator animates a layout property');
  // 200ms glide, per the locked timings.
  assert.match(html, /--t-select:var\(--d-base\)/);
  assert.match(html, /--d-base:200ms/);
});

test('nav: every section keeps a destination, unfinished ones are marked', () => {
  const expected = ['today', 'calendar', 'projects', 'diary', 'library', 'settings'];
  for (const id of expected) {
    assert.ok(new RegExp(`id:\\s*'${id}'`).test(routes), `${id} is missing from navigation`);
  }
  // This used to loop over every unbuilt section with a 140-character window,
  // which reached into the NEXT route entry and matched its `placeholder`. It
  // kept passing for Calendar long after Calendar stopped being one. Assert the
  // two populations separately, against one line each.
  const entryOf = (id: string) => {
    const at = routes.indexOf(`id: '${id}'`);
    const end = routes.indexOf('\n', at);
    return routes.slice(at, end === -1 ? at + 160 : end);
  };
  for (const id of ['today', 'calendar', 'projects', 'library', 'diary']) {
    assert.ok(!/placeholder:\s*true/.test(entryOf(id)), `${id} is built but still a placeholder`);
  }
  /* There are no placeholder sections left. Brain was the last, and it was
   * removed rather than finished — see below. If one is ever added, it belongs
   * in this list with its copy. */
  assert.ok(!/placeholder:\s*true/.test(routes), 'a placeholder section is back');
});

test('nav: Brain is gone, and its job went to the places that do it', () => {
  /* The rule at the top of routes.js protects a section being REBUILT. Brain
   * was not being rebuilt, it was cancelled: its copy promised "ideas,
   * resources and knowledge in one place", which is Library's job, and its
   * remaining future — search, connections, suggestions — is the assistant,
   * which already has a home on every screen. */
  assert.ok(!/id:\s*'brain'/.test(routes), 'the Brain tab is back in navigation');
  assert.ok(!routes.includes('brain: {'), 'Brain still has placeholder copy');
  assert.ok(!/brain/i.test(app.slice(app.indexOf('const ICONS'), app.indexOf('const ICONS') + 3000)),
    'the Brain icon is still carried around');
  /* And an old link still lands somewhere real rather than on an error. */
  assert.match(app, /ALL_ROUTE_IDS\.includes\(id\) \? id : 'today'/);
});

test('placeholders: product voice, reassuring, never fake data', () => {
  // Only sections that ARE placeholders keep placeholder copy. Calendar,
  // Projects and Library are built; their entries stay for the day one of them
  // is ever taken back out, but they are not asserted as live copy.
  for (const id of ['calendar', 'projects']) {
    const block = routes.slice(routes.indexOf(`${id}: {`));
    const copy = block.slice(0, block.indexOf('},'));
    // Says what the section will BE, and that nothing was lost — without
    // narrating the migration at someone just trying to use their app.
    assert.match(copy, /will live here|will roll up|A place to|somewhere to keep|in one place/i,
      `${id} does not describe what it will be`);
    assert.match(copy, /Nothing you have saved has been lost/, `${id} does not reassure`);
    assert.ok(!/export|import|migrat|legacy/i.test(copy),
      `${id} narrates the migration in product UI`);
  }
  // One generated heading, not hard-coded per section.
  assert.match(app, /is coming</);
});

test('there is no Personal/Business profile switcher anywhere', () => {
  for (const [name, src] of Object.entries({ app, html, routes })) {
    assert.ok(!/profileSwitch|switchProfile|profile-switcher/i.test(src),
      `${name} contains a profile switcher`);
    // "Business" must not appear as a selectable workspace concept.
    assert.ok(!/data-profile=/i.test(src), `${name} exposes a profile selector`);
  }
  assert.ok(!/workspaces\.map|workspaceList/.test(app), 'the app renders a workspace list');
});

/* ── Data boundaries ─────────────────────────────────────────────────── */

test('the web client contains no Firestore code at all', () => {
  for (const [name, src] of Object.entries({ app, html, sw, pwa, routes })) {
    assert.ok(!/firebase-firestore|firestore\(|collection\(|onSnapshot|setDoc|updateDoc/.test(src),
      `${name} touches Firestore`);
  }
  // Only Firebase app + auth may be imported.
  const imports = app.match(/firebasejs\/[\d.]+\/firebase-[a-z]+\.js/g) ?? [];
  assert.deepEqual([...new Set(imports)].sort(),
    ['firebasejs/10.7.1/firebase-app.js', 'firebasejs/10.7.1/firebase-auth.js']);
});

test('composer: full width, capped, opaque, and present rather than disabled', () => {
  const rule = html.slice(html.indexOf('.composer-inner{'), html.indexOf('/* ── Buttons'));
  assert.match(rule, /max-width:var\(--composer-max\)/, 'the composer is not capped at Legacy width');
  assert.match(rule, /min-height:var\(--composer-h\)/, 'the composer does not scale with the viewport');
  assert.match(rule, /border:1px solid/, 'composer has no border');
  assert.match(rule, /backdrop-filter:blur/, 'composer has no blur');
  // .62 opacity made it read as broken rather than as pending.
  assert.ok(!/opacity:\.\d/.test(rule), 'the composer is translucent');
  // Its mark carries the brand accent; a grey disabled glyph reads as broken.
  assert.match(rule, /\.composer-inner \.ico\{color:#9E7BFF/,
    'the composer icon is not a brand-purple mark');
  assert.match(html, /\.composer\{position:fixed;left:var\(--sidebar-w\);right:0/,
    'the composer stops at the rail instead of spanning to the edge');
});

test('nav indicator uses Legacy geometry, not the button gradient', () => {
  const rule = html.slice(html.indexOf('.nav-pill{'), html.indexOf('.nav-pill.snap'));
  assert.match(rule, /height:44px/, 'the indicator is not 44px');
  assert.match(rule, /linear-gradient\(180deg,#7C4DFF 0%,#9A67FF 100%\)/,
    'the indicator uses the wrong gradient');
  assert.ok(!/var\(--brand\)/.test(rule), 'the indicator reuses the button gradient');
});

test('settings: a category column and one panel, with every required group', () => {
  for (const id of ['account', 'appearance', 'areas', 'habits', 'integrations', 'app', 'data']) {
    assert.ok(settings.includes("id: '" + id + "'"), 'the ' + id + ' settings section is missing');
  }
  /* The tab strip is gone. Seven cramped pills over a 760px column did not
   * scale and did not read as one workspace; a settings surface is normally a
   * navigation column beside the panel it selects. */
  assert.match(html, /\.set-page\{display:grid;grid-template-columns:var\(--set-nav-w\)/,
    'Settings is not a nav column beside a panel');
  assert.match(html, /\.set-nav-item\[aria-current="page"\]/,
    'the selected category is not marked for assistive tech');
  // Narrow screens get a strip that scrolls, never a squeezed desktop column.
  assert.match(html, /@media \(max-width:900px\)\{[\s\S]{0,400}\.set-nav\{position:static;flex-direction:row/,
    'the settings navigation does not collapse on narrow screens');

  // Rows are divided inside one card rather than being a stack of cards, and a
  // group's title sits above its card — a card inside a card is just noise.
  assert.match(html, /\.set-row \+ \.set-row\{border-top:1px solid var\(--hairline\)\}/,
    'settings rows are separate cards again');

  // Area management must be complete, not read-only.
  assert.match(settings, /data-area-name=/, 'Areas cannot be renamed');
  assert.match(settings, /data-area-del=/, 'Areas cannot be removed');
  assert.match(settings, /lose this label|never deletes/i, 'removal does not explain reassignment');
  assert.ok(!/profile/i.test(settings), 'settings mention profiles');
});

test('settings: no control is drawn for something that cannot happen', () => {
  /* Every badge on this page has to come from something that reported it.
   * The old page said "Connected" for Google Calendar as a hard-coded string
   * and "Soon" for a Calendar that had already shipped. */
  assert.ok(!/pending\('Soon'\)|>Soon</.test(settings), 'Settings still shows a Soon placeholder');
  assert.match(settings, /state\.integration/, 'Integrations does not read real connection state');
  assert.match(settings, /g\?\.configured/,
    'Integrations ignores whether the server can connect at all');
  assert.match(settings, /c\.canWrite/, 'the read/write permission state is not shown');
  assert.match(settings, /lastSyncedAt/, 'the last successful sync is not shown');

  // Export and account deletion do not exist; they must not look like buttons.
  const dataPanel = settings.slice(settings.indexOf('function dataPanel'));
  assert.ok(!/<button[^>]*id="(export|delete-account)"/.test(dataPanel),
    'Privacy offers an action that is not implemented');
  assert.match(dataPanel, /Not built yet/, 'export is not labelled honestly');

  // Version belongs to App alone.
  const accountPanel = settings.slice(settings.indexOf('function accountPanel'),
    settings.indexOf('function appearancePanel'));
  assert.ok(!/LIFE_OS_BUILD/.test(accountPanel), 'the build is still duplicated on Account');
  assert.match(settings.slice(settings.indexOf('function appPanel')), /LIFE_OS_BUILD/,
    'App does not own the version');
});

test('no staging or migration language in the everyday UI', () => {
  const banned = /not connected|legacy export|being rebuilt for|verified export|has not been imported/i;
  for (const [name, src] of Object.entries({ app, routes, settings })) {
    assert.ok(!banned.test(src), name + ' shows migration commentary in normal UI');
  }
});

test('icons: every required file exists at the right dimensions', () => {
  const dims = (file: string) => {
    const b = readFileSync(join(WEB, 'icons', file));
    assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', file + ' is not a PNG');
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  };
  const expected: Record<string, number> = {
    'icon-192.v2.png': 192, 'icon-256.v2.png': 256, 'icon-512.v2.png': 512,
    'maskable-192.v2.png': 192, 'maskable-512.v2.png': 512,
    'apple-touch-icon.v2.png': 180, 'favicon-32.v2.png': 32,
  };
  for (const [file, size] of Object.entries(expected)) {
    const d = dims(file);
    assert.equal(d.w, size, file + ' is ' + d.w + 'px wide, expected ' + size);
    assert.equal(d.h, size, file + ' is ' + d.h + 'px tall, expected ' + size);
  }
  // The maskable variant is a SEPARATE drawing, not the same art rescaled —
  // Android crops to a circle and a rounded-square tile would be clipped.
  const std = readFileSync(join(WEB, 'icons', 'app-icon.svg'), 'utf8');
  const msk = readFileSync(join(WEB, 'icons', 'app-icon-maskable.svg'), 'utf8');
  assert.notEqual(std, msk, 'the maskable icon is a copy of the standard one');
  assert.ok(!/Playfair|<text/.test(std), 'the app icon contains a wordmark');
});

test('the AI composer is inert — no handler, no network call', () => {
  const start = app.indexOf('class="composer-inner"');
  const composer = app.slice(start, app.indexOf('</div>', app.indexOf('composer-badge')));
  assert.match(composer, /aria-disabled="true"/, 'composer is not marked disabled');
  assert.ok(!/fetch\(|anthropic|onclick|addEventListener/i.test(composer),
    'the composer has behaviour attached');
  assert.match(composer, /Ask Life OS or capture a thought/, 'composer copy is not the honest one');
  assert.ok(!/anthropic/i.test(app + html + sw + pwa), 'something references Anthropic');
});

/* ── Phase C3 ────────────────────────────────────────────────────────── */

test('nav: Completed and Settings are not primary destinations', () => {
  const primary = routes.slice(routes.indexOf('export const ROUTES'), routes.indexOf('SECONDARY_ROUTES'));
  assert.ok(!/id: 'history'/.test(primary), 'Completed is still in the primary nav');
  assert.ok(!/id: 'settings'/.test(primary), 'Settings is still in the primary nav');
  assert.deepEqual(
    [...primary.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]),
    ['today', 'calendar', 'projects', 'diary', 'library'],
  );
  // Both remain real, bookmarkable routes.
  assert.match(routes, /SECONDARY_ROUTES[\s\S]*history[\s\S]*settings/);
  assert.match(app, /ALL_ROUTE_IDS\.includes\(id\)/, 'secondary routes are not reachable by URL');
});

test('account: the identity opens Settings directly, with no popover', () => {
  // D4.5 removed the popover. It held Settings, Completed, a build string and
  // Sign out — four unrelated things, none of them account management, all a
  // second click away. The identity block is now a direct link.
  assert.match(app, /id="account-btn" data-route="settings"/,
    'the identity block is not a direct link to Settings');
  for (const gone of ['openAccountMenu', 'account-menu', 'data-am=']) {
    assert.ok(!app.includes(gone), `the account popover survives as ${gone}`);
  }
  // Sign out moved into Settings, where account actions belong.
  assert.match(settings, /id="sign-out"/, 'Sign out has no home');
});

test('history is reachable, and never from the sidebar', () => {
  // C4 removed the Completed control from the Today header: finished work was
  // competing for attention with what still needs doing. The route stays,
  // reached from the account menu, so nothing became unreachable.
  assert.ok(!/function todayHeaderActions/.test(app),
    'the Completed control is back in the Today header');
  assert.match(app, /'history'/, 'the Completed route was removed entirely');
  // D4.5 moved Completed out of the account popover; D4.6 moved it again, out
  // of the board flow and into Today's overflow menu, because a running total
  // of finished work competed with what still needs doing.
  assert.match(app, /View completed tasks/, 'Completed has no destination');
  assert.match(app, /go\('history'\)/, 'the Completed action does not navigate');
  assert.match(app, /data-route="today"[\s\S]{0,120}Back to Today/, 'History cannot get back');
  // Buckets still exclude completed work.
  assert.match(app, /t\.status !== 'done'/, 'buckets no longer exclude completed tasks');
  assert.match(app, /includeCompleted=false/, 'Today still asks for completed tasks');
});

test('rail: no dashboard cards, no fake Upcoming', () => {
  const rail = app.slice(app.indexOf('function renderRail'), app.indexOf('function wireRail'));
  for (const gone of ['Your day', 'Recently finished', 'Active work', 'All areas']) {
    assert.ok(!rail.includes(gone), `the rail still carries the "${gone}" card`);
  }
  // Upcoming is omitted entirely rather than rendered empty, because there is
  // no calendar and every imported task has no due date.
  assert.ok(!/Upcoming|Up next in your calendar/i.test(rail), 'a fake Upcoming card exists');
  // C4 removed Quick Capture; C4.1 removed Up Next as well, because without
  // Calendar or Reminders it only restated the top of the board. The rail is
  // deliberately short rather than padded — see the note in app.js.
  assert.ok(rail.includes('Habits today'), 'the rail is missing "Habits today"');
  assert.ok(!/Up next/i.test(rail), 'Up Next came back');
  // Stripped of comments: the C4 rail comment explains the removal by name.
  assert.ok(!/qc-form|qc-input|quickCapture/i.test(code(app)), 'Quick Capture came back');
});

test('habits: optimistic tick with rollback, and green means done only', () => {
  assert.match(app, /async function toggleHabit/);
  const fn = app.slice(app.indexOf('async function toggleHabit'));
  assert.match(fn, /const before = \{/, 'no snapshot to roll back to');
  assert.match(fn, /Object\.assign\(h, before\)/, 'a failed tick does not roll back');
  // Completion is the ONLY thing wearing green.
  // C4 replaced the tick with a progress ring; green is still the only colour
  // completion wears, and the rail must not borrow the brand purple for it.
  assert.match(html, /\.hr-fill\{fill:none;stroke:var\(--ok\)/, 'the ring is not green');
  // C4.1 gave .hr-mark a permanent green and reveals it with opacity, so the
  // check can fade in rather than appear at full strength.
  assert.match(html, /\.hr-mark\{[^}]*color:var\(--ok\)/, 'the mark is not green');
  assert.match(html, /\.hb-row\.is-done \.hr-mark\{opacity:1/, 'the mark is not revealed when done');
  const ring = html.slice(html.indexOf('.hb-ring{'), html.indexOf('.hb-name{'));
  assert.ok(!/var\(--accent\)/.test(ring), 'purple and green are mixed in the habit rows');
});

test('priority is a marker, not an alarm', () => {
  // C4 renamed `.p-*` to `.pri-*` and restored all five levels. Urgent regained
  // a 1px outline at 42% alpha — deliberately softer than the 1.5px full-alpha
  // ring C3 removed, so it reads as important rather than as an error state.
  const rule = html.slice(html.indexOf('.task.pri-urgent{'), html.indexOf('.task.pri-high{'));
  assert.ok(!/inset 0 0 0 1\.5px/.test(rule), 'urgent draws the old alarm ring');
  assert.match(rule, /box-shadow:inset 0 0 0 1px rgba\(240,86,110,\.42\)/,
    'urgent lost its marker entirely');
  // C3 made medium colourless. C4 reverses that deliberately: the brief asked
  // for all five levels to be tellable apart. Medium keeps the quietest tint of
  // the four that have one, so the default still recedes.
  // Parsed with one static regex, not a built one: a template literal eats the
  // backslashes, and `\d` silently becomes a literal "d" that matches nothing.
  const tint = new Map<string, number>();
  for (const t of html.match(/--p-\w+-bg:[^;]+/g) ?? []) {
    const name = t.slice(0, t.indexOf(':'));
    const value = t.slice(t.indexOf(':') + 1);
    const a = value.match(/,\s*(\.\d+|\d?\.?\d+)\)$/);
    tint.set(name.slice(4, -3), value === 'transparent' ? 0 : Number(a?.[1] ?? 1));
  }
  const alpha = (p: string) => tint.get(p) ?? 0;
  assert.equal(tint.size, 5, 'there are not exactly five priority tints');
  assert.match(html, /--p-someday-bg:transparent/, 'someday should carry no tint at all');
  for (const louder of ['urgent', 'high']) {
    assert.ok(alpha(louder) > alpha('medium'),
      `medium is not quieter than ${louder} — the default adds colour noise`);
  }
});

test('large screens scale by token, never by zoom', () => {
  assert.ok(!/zoom:/.test(html), 'the app uses CSS zoom');
  assert.match(html, /@media \(min-width:1600px\)/, 'no large-screen breakpoint');
  const big = html.slice(html.indexOf('@media (min-width:1600px)'));
  for (const token of ['--fs-task', '--fs-nav', '--fs-h1', '--row-pad-y', '--btn-h',
    '--composer-h', '--stack-gap', '--gutter', '--rail-w']) {
    assert.ok(big.includes(token), `${token} does not scale`);
  }
  // Every clamp floor is the shipped laptop value, so 1440px is untouched.
  assert.match(big, /--fs-task:clamp\(13px/);
  assert.match(big, /--fs-h1:clamp\(34px/);
  assert.match(big, /--gutter:clamp\(56px/);
  assert.match(big, /--rail-w:clamp\(380px/);
});

test('sidebar: one restrained convention for unfinished sections', () => {
  // Five repetitions of the word "soon" read as a list of apologies.
  assert.match(html, /\.nav a \.soon\{width:5px;height:5px;border-radius:50%/,
    'unfinished sections still shout');
  assert.match(html, /font-size:0/, 'the "soon" text is still visible');
});

/* ── PWA ─────────────────────────────────────────────────────────────── */

test('manifest: meets the installability requirements', () => {
  assert.equal(manifest.name, 'Life OS');
  assert.ok(manifest.short_name.length <= 12);
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.start_url, 'no start_url');
  assert.ok(manifest.scope, 'no scope');
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);

  // Installability needs a PNG of at least 192px, and Android needs a maskable.
  const pngs = manifest.icons.filter((i: any) => i.type === 'image/png');
  assert.ok(pngs.some((i: any) => i.sizes === '192x192'), 'no 192px PNG icon');
  assert.ok(pngs.some((i: any) => i.sizes === '512x512'), 'no 512px PNG icon');
  const maskable = manifest.icons.filter((i: any) => String(i.purpose).includes('maskable'));
  assert.ok(maskable.some((i: any) => i.sizes === '192x192'), 'no 192px maskable icon');
  assert.ok(maskable.some((i: any) => i.sizes === '512x512'), 'no 512px maskable icon');

  // A stable id keeps future deploys updating the SAME installed app rather
  // than creating a duplicate installation.
  assert.ok(manifest.id, 'no manifest id');
  assert.ok(!String(manifest.id).includes('web-anchor'), 'the v2 manifest borrows the Legacy identity');

  // Versioned filenames, so a cached old icon can never be served.
  for (const i of pngs) {
    assert.match(i.src, /\.v2\.png$/, i.src + ' is not a versioned v2 filename');
  }
  assert.ok(!JSON.stringify(manifest).includes('/icon.svg'),
    'the old icon filename is still referenced');

  // Every declared icon file must actually exist.
  for (const i of manifest.icons) {
    assert.ok(existsSync(join(WEB, i.src.replace('./', ''))), `${i.src} does not exist`);
  }
  assert.match(html, /<link rel="manifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\.\/icons\/apple-touch-icon\.v2\.png"/,
    'no Apple touch icon');
  assert.ok(!/icons\/icon\.svg|icon-192\.png"/.test(html), 'the head references old icon files');
});

test('service worker: cache name is versioned and namespaced to v2', () => {
  assert.match(sw, /const BUILD = '__BUILD_ID__'/, 'build id is not templated');
  assert.match(sw, /life-os-v2-shell-\$\{BUILD\}/, 'cache name carries no build id');
  assert.match(sw, /CACHE_PREFIX = 'life-os-v2-'/, 'no v2 namespace');
  // Old caches are cleaned on activate, but only ours.
  assert.match(sw, /startsWith\(CACHE_PREFIX\) && n !== CACHE/,
    'activate does not scope its cleanup to v2 caches');
  // The server must substitute the build id, or every deploy shares a cache.
  assert.match(server, /__BUILD_ID__/, 'the server never substitutes the build id');
  assert.match(server, /RAILWAY_GIT_COMMIT_SHA/, 'the build id is not tied to the commit');
});

test('service worker: never caches API responses or credentials', () => {
  assert.match(sw, /if \(isApiRequest\(url, request\)\) return;/,
    'API requests are not excluded from the fetch handler');
  assert.match(sw, /request\.headers\.has\('Authorization'\)/,
    'authenticated requests are not excluded');
  assert.match(sw, /url\.origin !== self\.location\.origin/, 'cross-origin requests are not excluded');
  assert.ok(!/token/i.test(sw.replace(/\/\*[\s\S]*?\*\//g, '')), 'the worker mentions tokens');
  // The shell list must contain no API paths.
  const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  assert.ok(!shell.includes('/api/'), 'an API path is pre-cached');
  // The client also refuses to let any cache answer an API call.
  assert.match(app, /cache: 'no-store'/, 'api() does not set no-store');
});

test('service worker: waits for the user and cannot loop', () => {
  // It must never take over on its own.
  const swCode = code(sw);
  const install = swCode.slice(swCode.indexOf("addEventListener('install'"),
    swCode.indexOf("addEventListener('activate'"));
  assert.ok(!/skipWaiting\(\)/.test(install), 'the worker skips waiting during install');
  // Only an explicit message may activate it.
  assert.match(sw, /event\.data\?\.type === 'SKIP_WAITING'/);
  // The page reloads at most once.
  assert.match(pwa, /if \(reloading\) return;/, 'no reload guard — this is the infinite-loop bug');
  assert.match(pwa, /controllerchange/);
  // A first install is not an update.
  assert.match(pwa, /navigator\.serviceWorker\.controller\) noteWaiting/,
    'a first install would be reported as an update');
});

test('pwa: the update prompt can be postponed and never interrupts editing', () => {
  assert.match(pwa, /function isEditing\(/, 'no editing check');
  assert.match(pwa, /if \(isEditing\(\)\) \{ setTimeout\(showUpdatePrompt/, 'prompts while editing');
  assert.match(pwa, /sessionStorage\.setItem\('los2_update_dismissed'/, 'postpone is not remembered');
  // Postponing is device-scoped and must not reach the account.
  assert.ok(!/api\(|fetch\(/.test(pwa.slice(pwa.indexOf('u-later'), pwa.indexOf('u-now'))),
    'postponing writes to the server');
});

test('mutable assets are served no-store so a deploy cannot leave stale JS', () => {
  // `no-cache` without an ETag or Last-Modified left three separate stale-asset
  // incidents, so these are now `no-store` — strictly stronger.
  assert.match(server, /ext === '\.html' \|\| ext === '\.js' \|\| ext === '\.json'/,
    'HTML/JS/JSON are not singled out');
  assert.match(server, /no-store/, 'mutable assets may still be cached');
  assert.match(server, /'cache-control': 'no-store'[\s\S]{0,200}service-worker-allowed/,
    'sw.js is not served no-store');
});

/* ── Responsive and accessible ───────────────────────────────────────── */

test('mobile: the sidebar becomes a drawer and the rail stays reachable', () => {
  const mobile = html.slice(html.indexOf('@media (max-width:768px)'));
  assert.match(mobile, /\.sidebar\{position:fixed[^}]*transform:translateX\(-100%\)/,
    'the sidebar does not become a drawer');
  assert.match(mobile, /body\.drawer-open \.sidebar\{transform:none\}/);
  assert.match(mobile, /\.mobile-bar\{display:flex/, 'no mobile navigation bar');
  // The rail moves below the content — it must never simply disappear.
  // D4.7 hides the PAGE rail on Calendar only, because Calendar owns a rail
  // inside its own frame there. Everywhere else the rail must still reflow
  // below the content rather than simply vanish.
  // Calendar owns a rail inside its own frame; Projects deliberately has none
  // (see the product model). Everywhere else the rail must still reflow below
  // the content rather than simply vanish.
  const hides = [...html.matchAll(/([^\n{]*)\.rail\{display:none/g)].map((m) => m[1]);
  // Calendar owns a rail inside its own frame. Projects and Library each
  // deliberately have none — see their product models — and both collapse the
  // grid track as well, so the column is genuinely returned to the content.
  // Settings is the fifth: it is an administrative surface, the Habits rail has
  // nothing to say there, and the width is worth more to the settings workspace.
  assert.deepEqual(hides,
    ['body:has(.set-page) ', 'body:has(.cal-head) ', 'body:has(.pj-head) ',
      'body:has(.lib-page) ', 'body:has(.dia-page) '],
    'the rail is hidden with no alternative');
  // Hiding it is only allowed when the track is collapsed too, or the layout
  // keeps a column of dead space where the rail used to be.
  for (const surface of ['set-page', 'cal-head', 'pj-head', 'lib-page', 'dia-page']) {
    assert.ok(html.includes(`body:has(.${surface}) .main-wrap{grid-template-columns:minmax(0,1fr) 0}`),
      `${surface} hides the rail without giving the width back`);
  }
  for (const marker of ['pj-head', 'dia-page', 'lib-page']) {
    assert.ok(html.includes(`body:has(.${marker}) .main-wrap{grid-template-columns:minmax(0,1fr) 0}`),
      `${marker} hides the rail without collapsing its grid track`);
  }
  assert.match(html, /\.cal-rail\{overflow:visible;position:static/,
    'the calendar rail does not reflow below the canvas on a narrow screen');
  const tablet = html.slice(html.indexOf('@media (max-width:1180px)'));
  assert.match(tablet, /\.rail\{position:static/, 'the rail does not reflow below content');
  assert.match(tablet, /grid-template-columns:repeat\(auto-fit/, 'the rail does not become a card row');
});

test('touch: essential controls are never hover-only and meet 44px', () => {
  const coarse = html.slice(html.indexOf('@media (hover:none),(pointer:coarse),(max-width:768px)'));
  // The Move button is the only non-drag path; it must be visible without hover.
  assert.match(coarse, /\.t-actions\{opacity:1\}/, 'task actions stay hover-only on touch');
  assert.match(coarse, /\.grip\{display:none\}/, 'the drag handle is offered on touch');
  assert.match(coarse, /min-height:44px/, 'no 44px minimum is applied');
  assert.match(coarse, /\.icon-btn\{width:44px;height:44px/);
  // Where the visible control stays small, the hit area is extended instead.
  // One selector list now covers every small round control, not just `.tick`.
  assert.match(coarse, /\.t-tick::after/, 'the task tick has no expanded hit area');
  assert.match(coarse, /\.hb-ring::after/, 'the habit ring has no expanded hit area');
  assert.match(coarse, /width:44px;height:44px;transform:translate\(-50%,-50%\)/,
    'the hit-area overlay is not 44px');
  assert.match(coarse, /\.t-title::after/, 'the title has no expanded hit area');
  assert.match(coarse, /right:0;height:44px/, 'text targets do not span the row at 44px');
});

test('accessibility: focus, landmarks and reduced motion are honoured', () => {
  assert.match(html, /:focus-visible\{outline:2px solid/, 'no visible focus ring');
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)/, 'system reduce-motion ignored');
  assert.match(html, /html\[data-motion="reduced"\]/, 'the in-app motion preference does nothing');
  assert.match(app, /aria-label="Main"/, 'the nav has no accessible name');
  assert.match(app, /aria-current="page"/, 'the active route is not announced');
  assert.match(app, /aria-expanded/, 'the drawer button has no expanded state');
  // C4 replaced the side drawer with a centred dialog, so the modal semantics
  // moved out of app.js into their own modules. Both are checked, because
  // "the task editor is a dialog" must hold wherever the editor lives.
  for (const f of ['task-modal.js', 'habit-modal.js']) {
    const src = read(f);
    assert.match(src, /setAttribute\('role', 'dialog'\)/, `${f} is not a dialog`);
    assert.match(src, /setAttribute\('aria-modal', 'true'\)/, `${f} is not modal`);
  }
});

test('the Life OS lockup uses an inline self-contained gradient', () => {
  // A gradient defined inside a display:none <symbol> does not paint in Chrome
  // — that is exactly how this logo went invisible once before.
  assert.match(app, /<linearGradient id="lotus\$\{n\}"/, 'the logo gradient is not inlined');
  assert.ok(!/<use\s/.test(app), 'the logo is drawn from a sprite');
  assert.match(html, /'Playfair Display'/, 'the wordmark font is missing');
  /* Playfair is for the wordmark — and, since F2, for the Book.
   *
   * That is not the rule loosening. The Legacy book audit records Playfair as
   * part of what MAKES the book a book: the cover title, the section tabs and
   * the page headings. It is confined to `.bk-*` and the cover; body text on a
   * page is still Inter, because a handwriting-adjacent serif at 15px on ruled
   * lines is harder to read, not more charming. Anything else that reaches for
   * Playfair is still wrong. */
  /* `.lib-cover-*` joins the allowlist in L3, and it is not a loosening.
   *
   * The shelf cover IS a Book cover — the same marks in the same order at the
   * same 210:297 proportion — and §8 requires the object you press to match the
   * cover that opens. Setting the shelf title in Inter while the Book it opens
   * is set in Playfair would break exactly the correspondence the rule exists
   * to protect. The confinement is unchanged: the cover, never body text. */
  const playfairRules = html.match(/[^}]*Playfair Display[^}]*\}/g) ?? [];
  for (const rule of playfairRules) {
    assert.ok(/logo-word|m-title|\.bk-|\.dia-|\.lib-cover/.test(rule),
      `Playfair used outside the wordmark, the Book, the Diary and the shelf cover: ${rule.slice(0, 60)}`);
  }
  assert.ok(!/\.lib-res-title\{[^}]*Playfair/.test(html),
    'a Document folio is not a Book and must not borrow the Book serif');
  // And neither surface puts it on the body text you write in.
  assert.ok(!/\.bk-editor\{[^}]*Playfair/.test(html), 'Book body text is set in Playfair');
  assert.ok(!/\.dia-editor\{[^}]*Playfair/.test(html), 'Diary body text is set in Playfair');
});

test('the mobile drawer is not trapped inside a stacking context', () => {
  /* This one was invisible to every check that measures position.
   *
   * `.shell{position:relative;z-index:1}` created a STACKING CONTEXT, so the
   * sidebar's z-index:120 only ever competed with its siblings inside the
   * shell. From outside, the whole application was z-index:1 — and
   * `.drawer-scrim`, a body-level child at z-index:110, painted above all of
   * it. The drawer opened, slid to the right place, dimmed itself, and
   * swallowed every tap. Today, Calendar, Projects, Diary, Library and
   * Settings were all unreachable on a phone, and measuring transform, left
   * and opacity said the drawer was fine, because it was.
   *
   * The rule that matters: the scrim and the sidebar must resolve their
   * z-indexes against each other, which means no ancestor of the sidebar may
   * open a context the scrim is not also inside. */
  /* Comments stripped first. The comment explaining why .shell has no z-index
   * quotes the old rule verbatim, and indexOf finds prose before code. */
  const css = html.replace(/\/\*[\s\S]*?\*\//g, '');
  const zOf = (sel: string) => {
    const at = css.indexOf(sel + '{');
    if (at < 0) return null;
    const block = css.slice(at, css.indexOf('}', at));
    const m = block.match(/z-index:(-?\d+|auto)/);
    return m ? m[1] : null;
  };

  // The shell positions itself and must NOT carry a z-index.
  const shell = css.slice(css.indexOf('.shell{position:relative'),
    css.indexOf('}', css.indexOf('.shell{position:relative')));
  assert.ok(!/z-index/.test(shell),
    '.shell has a z-index again, which traps the sidebar and kills the drawer');

  // The star field was the only reason the shell ever needed one; it belongs
  // behind the content rather than in front of the background.
  assert.equal(zOf('#los-stars'), '-1', 'the star field is not behind the app');

  // And within one shared context, the drawer must outrank its own scrim.
  // The DRAWER rule, not the desktop one: only the fixed-position sidebar is
  // the drawer, and only it shares a context with the scrim.
  const sidebarZ = Number(css.match(/\.sidebar\{position:fixed[^}]*z-index:(\d+)/)?.[1] ?? 0);
  const scrimZ = Number(css.match(/\.drawer-scrim\{[^}]*z-index:(\d+)/)?.[1] ?? 0);
  assert.ok(sidebarZ > scrimZ,
    `the scrim (${scrimZ}) is at or above the drawer (${sidebarZ}) and will swallow its taps`);
});
