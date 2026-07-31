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
const html = read('index.html');
const app = read('app.js');
const sw = read('sw.js');
const pwa = read('pwa.js');
const routes = read('routes.js');
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
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

/* ── Shell structure ─────────────────────────────────────────────────── */

test('shell: the three-column layout and every region exist', () => {
  assert.match(html, /\.shell\{display:grid/, 'no shell grid');
  assert.match(html, /grid-template-columns:var\(--sidebar-w\) minmax\(0,1fr\) var\(--rail-w\)/,
    'sidebar / main / rail columns not declared');
  for (const sel of ['.sidebar', '.rail', '.composer', '.main-scroll', '.mobile-bar']) {
    assert.ok(html.includes(sel), `${sel} missing from the stylesheet`);
  }
  // Widths are tokens so Compact / Icon-only / Drawer modes can plug in later.
  assert.match(html, /--sidebar-w:\s*\d+px/);
  assert.match(html, /--rail-w:\s*\d+px/);
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
  const expected = ['today', 'calendar', 'projects', 'diary', 'library', 'brain', 'settings'];
  for (const id of expected) {
    assert.ok(new RegExp(`id:\\s*'${id}'`).test(routes), `${id} is missing from navigation`);
  }
  for (const id of ['calendar', 'projects', 'diary', 'library', 'brain']) {
    const entry = routes.slice(routes.indexOf(`id: '${id}'`));
    assert.match(entry.slice(0, 140), /placeholder:\s*true/, `${id} is not marked as a placeholder`);
    assert.ok(routes.includes(`${id}: {`), `${id} has no placeholder copy`);
  }
});

test('placeholders: say what is happening and never fake data', () => {
  const { PLACEHOLDERS } = { PLACEHOLDERS: routes };
  for (const id of ['calendar', 'projects', 'diary', 'library', 'brain']) {
    const block = PLACEHOLDERS.slice(PLACEHOLDERS.indexOf(`${id}: {`));
    const copy = block.slice(0, block.indexOf('},'));
    assert.match(copy, /rebuilt|not been imported|preserved/i, `${id} copy does not explain itself`);
  }
  // The heading is generated, not hard-coded per section.
  assert.match(app, /is being rebuilt for Life OS v2/);
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

test('the AI composer is inert — no handler, no network call', () => {
  const start = app.indexOf('class="composer-inner"');
  const composer = app.slice(start, app.indexOf('</div>', app.indexOf('composer-badge')));
  assert.match(composer, /aria-disabled="true"/, 'composer is not marked disabled');
  assert.ok(!/fetch\(|anthropic|onclick|addEventListener/i.test(composer),
    'the composer has behaviour attached');
  assert.match(app, /Coming in v2/);
  assert.ok(!/anthropic/i.test(app + html + sw + pwa), 'something references Anthropic');
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
  assert.ok(manifest.icons.some((i: any) => String(i.purpose).includes('maskable')),
    'no maskable icon');

  // Every declared icon file must actually exist.
  for (const i of manifest.icons) {
    assert.ok(existsSync(join(WEB, i.src.replace('./', ''))), `${i.src} does not exist`);
  }
  assert.match(html, /<link rel="manifest"/);
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

test('mutable assets are served no-cache so a deploy cannot leave stale JS', () => {
  assert.match(server, /const revalidate = ext === '\.html' \|\| ext === '\.js' \|\| ext === '\.json'/,
    'HTML/JS/JSON are not revalidated');
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
  assert.ok(!/\.rail\{display:none/.test(html), 'the rail is hidden with no alternative');
  const tablet = html.slice(html.indexOf('@media (max-width:1080px)'));
  assert.match(tablet, /\.rail\{position:static/, 'the rail does not reflow below content');
});

test('touch: essential controls are never hover-only and meet 44px', () => {
  const coarse = html.slice(html.indexOf('@media (hover:none),(pointer:coarse),(max-width:768px)'));
  // The Move button is the only non-drag path; it must be visible without hover.
  assert.match(coarse, /\.t-actions\{opacity:1\}/, 'task actions stay hover-only on touch');
  assert.match(coarse, /\.grip\{display:none\}/, 'the drag handle is offered on touch');
  assert.match(coarse, /min-height:44px/, 'no 44px minimum is applied');
  assert.match(coarse, /\.icon-btn\{width:44px;height:44px/);
  // Where the visible control stays small, the hit area is extended instead.
  assert.match(coarse, /\.tick::after\{[^}]*width:44px;height:44px/, 'the tick has no 44px hit area');
  assert.match(coarse, /\.t-title::after\{[^}]*height:44px/, 'the title has no 44px hit area');
});

test('accessibility: focus, landmarks and reduced motion are honoured', () => {
  assert.match(html, /:focus-visible\{outline:2px solid/, 'no visible focus ring');
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)/, 'system reduce-motion ignored');
  assert.match(html, /html\[data-motion="reduced"\]/, 'the in-app motion preference does nothing');
  assert.match(app, /aria-label="Main"/, 'the nav has no accessible name');
  assert.match(app, /aria-current="page"/, 'the active route is not announced');
  assert.match(app, /aria-expanded/, 'the drawer button has no expanded state');
  assert.match(app, /setAttribute\('role', 'dialog'\)/, 'the detail panel is not a dialog');
  assert.match(app, /setAttribute\('aria-modal', 'true'\)/, 'the detail panel is not modal');
});

test('the Life OS lockup uses an inline self-contained gradient', () => {
  // A gradient defined inside a display:none <symbol> does not paint in Chrome
  // — that is exactly how this logo went invisible once before.
  assert.match(app, /<linearGradient id="lotus\$\{n\}"/, 'the logo gradient is not inlined');
  assert.ok(!/<use\s/.test(app), 'the logo is drawn from a sprite');
  assert.match(html, /'Playfair Display'/, 'the wordmark font is missing');
  // Playfair is for the wordmark ONLY.
  const playfairRules = html.match(/[^}]*Playfair Display[^}]*\}/g) ?? [];
  for (const rule of playfairRules) {
    assert.ok(/logo-word|m-title/.test(rule), `Playfair used outside the wordmark: ${rule.slice(0, 60)}`);
  }
});
