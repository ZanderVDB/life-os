/**
 * Moving Life OS onto its own domain, and opening it to people who are not me.
 *
 * The failure that started this was invisible from both ends: the browser
 * refused every API response because the new origin was not on the allowlist,
 * reported it as `TypeError: Failed to fetch`, and the app sat on its boot
 * spinner. Nothing in either log contained the word "origin".
 *
 * These hold down the two halves of that: the origin list, and the rule that a
 * boot failure has to be visible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, corsOrigins, DEFAULT_WEB_ORIGINS } from '../src/env.js';

const read = (p: string) => readFileSync(p, 'utf8');
const app = read(join('..', 'web', 'app.js'));
const manifest = JSON.parse(read(join('..', 'web', 'manifest.webmanifest')));
const pwa = read(join('..', 'web', 'pwa.js'));
const sw = read(join('..', 'web', 'sw.js'));
const gcal = read(join('src', 'routes', 'google-calendar.ts'));

const base = {
  DATABASE_URL: 'postgres://x', FIREBASE_PROJECT_ID: 'p', NODE_ENV: 'production',
};

test('the custom domain is allowed even with no CORS variable set', () => {
  const origins = corsOrigins(loadEnv({ ...base } as never));
  assert.ok(origins.includes('https://life-os.web-anchor.com'),
    'the app domain depends on a variable being right');
  // Both, so a DNS or certificate problem on one cannot lock everyone out.
  assert.ok(origins.includes('https://life-os-v2-web-staging-v2-staging.up.railway.app'),
    'the Railway origin was dropped mid-migration');
});

test('the allowlist stays an allowlist', () => {
  const origins = corsOrigins(loadEnv({
    ...base, CORS_ALLOWED_ORIGINS: 'https://preview.example.com',
  } as never));
  assert.ok(origins.includes('https://preview.example.com'), 'the variable no longer adds origins');
  assert.ok(!origins.includes('https://evil.example.com'), 'an unlisted origin is allowed');
  // A wildcard is refused outright — the API carries credentials.
  assert.throws(() => corsOrigins(loadEnv({ ...base, CORS_ALLOWED_ORIGINS: '*' } as never)),
    /must not contain/, 'a wildcard reaches production');
  assert.ok(!DEFAULT_WEB_ORIGINS.includes('*' as never), 'the defaults contain a wildcard');
  for (const o of DEFAULT_WEB_ORIGINS) {
    assert.ok(o.startsWith('https://'), `${o} is not https`);
    assert.ok(!o.endsWith('/'), `${o} has a trailing slash, which never matches an Origin header`);
  }
});

test('a boot that cannot reach the API says so instead of spinning', () => {
  /* run() reports through a toast. A toast over the boot spinner is a message
   * that vanishes while the spinner stays forever — which is precisely what
   * the custom domain looked like. */
  assert.match(app, /function renderBootFailure/, 'a failed boot has no screen of its own');
  assert.ok(!/await run\(boot\);/.test(app), 'boot failure is still only a toast');
  assert.match(app, /try \{\s*\n\s*await boot\(\);\s*\n\s*\} catch \(e\) \{\s*\n\s*renderBootFailure\(e\);/,
    'boot is not wrapped in the failure screen');
  // And it offers a way out, not just a description.
  assert.match(app, /id="boot-retry"/, 'the failure screen cannot be retried');
  assert.match(app, /id="boot-out"/, 'the failure screen cannot be escaped by signing out');
});

test('Google returns you to the origin you left from', () => {
  /* Google redirects to the API, so the API decides where the browser lands.
   * One hardcoded host meant connecting Calendar from the custom domain
   * dropped you onto a different origin — different session, different service
   * worker, no explanation. */
  assert.ok(!/'https:\/\/life-os-v2-web-staging[^']*'/.test(gcal),
    'a web origin is hardcoded in the Calendar routes again');
  assert.match(gcal, /returnTo: returnOrigin\(req\.headers\.origin, corsOrigins\(env\)\)/,
    'the connect flow does not remember where it started');
  assert.match(gcal, /postConnectUrl\(entry\.returnTo\)/, 'success returns to a fixed origin');
  assert.match(gcal, /postConnectUrl\(known\?\.returnTo\)/, 'failure returns to a fixed origin');
  // Only an origin already trusted for CORS is ever redirected to.
  assert.match(gcal, /\(origin && allowed\.includes\(origin\)\) \? origin : undefined/,
    'the return origin is not checked against the allowlist');
});

test('the Calendar webhook points at the API, not at the app', () => {
  /* Google has to reach the API directly. If this ever derived from a web
   * origin, moving the app would silently kill every push channel. */
  const watch = read(join('src', 'lib', 'calendar-watch.ts'));
  assert.match(watch, /GOOGLE_CALENDAR_REDIRECT_URI/, 'the webhook address is not derived from the API');
  assert.ok(!/WEB_URL|APP_URL|POST_CONNECT/.test(watch),
    'the webhook address is derived from a web origin');
});

test('nothing in the PWA is tied to a hostname', () => {
  /* A manifest is resolved against wherever it is served from, so every path
   * here is relative on purpose: the same file installs correctly on the
   * Railway host and on the custom domain. */
  for (const [k, v] of [['start_url', manifest.start_url], ['scope', manifest.scope]]) {
    assert.ok(String(v).startsWith('.'), `${k} is not relative`);
  }
  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('./'), `icon ${icon.src} is not relative`);
  }
  for (const s of manifest.shortcuts ?? []) {
    assert.ok(s.url.startsWith('./'), `shortcut ${s.url} is not relative`);
  }
  assert.equal(manifest.display, 'standalone', 'the installed app is not standalone');
  assert.ok(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable'),
    'there is no maskable icon, so Android crops the app icon');

  assert.match(pwa, /const SW_URL = '\.\/sw\.js'/, 'the service worker URL is absolute');
  assert.match(pwa, /const SCOPE = '\.\/'/, 'the service worker scope is absolute');
  // Origin-scoped by construction: a worker must never answer for another host.
  assert.match(sw, /url\.origin !== self\.location\.origin/,
    'the service worker handles cross-origin requests');
  /* Comments stripped first: the rule is that no hostname reaches the code,
   * not that the word may never be written down. Explaining why a host does
   * not appear is exactly the comment worth keeping. */
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const [name, src] of [['manifest', JSON.stringify(manifest)],
    ['pwa.js', code(pwa)], ['sw.js', code(sw)]] as [string, string][]) {
    assert.ok(!/railway\.app|web-anchor\.com/.test(src),
      `a hostname is baked into ${name}`);
  }
});

test('signing in does not depend on Google Calendar', () => {
  /* Two separate grants. Someone must be able to have a Life OS account
   * without handing over their calendar. */
  const boot = app.slice(app.indexOf('async function boot()'), app.indexOf('const surfaceCtx'));
  assert.ok(!/calendar/i.test(boot), 'boot will not finish without the calendar');
  assert.match(app, /api\('\/api\/v1\/me'\)/, 'boot no longer establishes the identity first');
});

/* ── Privacy and terms ──────────────────────────────────────────────────
 * Google requires both to be reachable on a domain we own before an app with
 * sensitive scopes can be verified. More importantly, the previous pair were
 * written for the legacy app and said things that were no longer true. */
const privacy = read(join('..', 'web', 'privacy.html'));
const terms = read(join('..', 'web', 'terms.html'));
const settings = read(join('..', 'web', 'settings.js'));
const webServer = read(join('..', 'web', 'server.js'));

test('the legal pages describe THIS app, not the one before it', () => {
  for (const [name, src] of [['privacy', privacy], ['terms', terms]] as [string, string][]) {
    // Every one of these was in the old policy and is false of v2.
    for (const lie of ['Firestore', 'Outlook', 'Anthropic', 'API key']) {
      assert.ok(!new RegExp(lie, 'i').test(src), `${name} still claims: ${lie}`);
    }
  }
  // And the things that ARE true, stated rather than skirted around.
  assert.match(privacy, /PostgreSQL/, 'the privacy policy does not say where data is stored');
  // Wrapped prose: compare against one flat line rather than fighting newlines.
  const flat = privacy.replace(/\s+/g, ' ');
  assert.match(flat, /keeps a copy of your calendar events in its own database/,
    'the privacy policy does not admit that calendar events are mirrored');
  assert.match(flat, /email addresses and names of people invited/,
    'the privacy policy does not disclose that attendee emails are stored');
  assert.match(privacy, /encrypted at rest/, 'token handling is not described');
  for (const scope of ['calendar.events', 'calendar.calendarlist.readonly', 'calendar.freebusy']) {
    assert.ok(privacy.includes(scope), `the privacy policy omits the ${scope} scope`);
  }
  // Google will not verify an app whose policy lacks this.
  assert.match(privacy, /Google API Services User Data Policy/, 'no Limited Use disclosure');
  assert.match(privacy, /Limited Use/, 'no Limited Use disclosure');
});

test('the legal pages are reachable and linked from inside the app', () => {
  // Served from web/, so they exist on whatever origin the app is served from.
  assert.match(privacy, /<title>Privacy Policy/, 'the privacy page has no title');
  assert.match(terms, /<title>Terms of Service/, 'the terms page has no title');
  assert.match(settings, /href="\.\/privacy\.html"/, 'Settings does not link the privacy policy');
  assert.match(settings, /href="\.\/terms\.html"/, 'Settings does not link the terms');
  // Each points at the other, so neither is a dead end.
  assert.match(privacy, /href="\.\/terms\.html"/, 'privacy does not link terms');
  assert.match(terms, /href="\.\/privacy\.html"/, 'terms does not link privacy');
  // /privacy must resolve as well as /privacy.html — the URL gets typed by hand.
  assert.match(webServer, /if \(!info && !extname\(file\)\)/,
    'an extensionless legal URL 404s in production');
});

/* ── The public home page ───────────────────────────────────────────────
 * Google's OAuth verification refused the app on four counts, three of which
 * were the same root cause: the home page was a lone "Continue with Google".
 * It was behind a login, it did not say what the app was for, and the app's
 * own name was not on it in a form a reviewer could read. */
const indexHtml = read(join('..', 'web', 'index.html'));

test('the home page is readable without signing in, and without JavaScript', () => {
  // The landing is static markup in index.html, not something app.js renders.
  const body = indexHtml.slice(indexHtml.indexOf('<body>'));
  assert.match(body, /<main class="lp" id="landing">/,
    'the home page is not in the served HTML, so it is behind a login again');
  // The old arrangement: a spinner, and nothing else, until Firebase answered.
  assert.ok(!/<div id="root"><div class="state"[^>]*><span class="spinner">/.test(body),
    'the root element is a bare spinner again');
  assert.match(body, /id="si"/, 'there is no way to sign in from the home page');
});

test('the home page carries the app name Google was given', () => {
  /* The consent screen says "Life OS". If the home page does not say the same
   * thing, verification fails on a name mismatch — which it did. */
  const h1 = indexHtml.match(/<h1>([^<]*)<\/h1>/);
  assert.ok(h1, 'the home page has no h1');
  assert.equal(h1![1].trim(), 'Life OS', 'the h1 does not match the OAuth app name');
  assert.match(indexHtml, /<title>Life OS<\/title>/, 'the page title is not the app name');
});

test('the home page explains what the app is for', () => {
  const landing = indexHtml.slice(indexHtml.indexOf('id="landing"'),
    indexHtml.indexOf('</main>')).replace(/\s+/g, ' ');
  // Purpose, not just a product name and a button.
  assert.match(landing, /lp-lede/, 'there is no description of the app');
  /* One sentence saying what the app IS, in the first screen. A reviewer who
   * reads nothing else has to come away knowing this much. */
  assert.match(landing, /Life OS is a personal productivity app/,
    'the home page never plainly states what Life OS is');
  assert.match(landing, /<h2>What Life OS is for<\/h2>/, 'there is no purpose section');
  for (const surface of ['Today', 'Calendar', 'Projects', 'Diary', 'Library', 'Habits']) {
    assert.ok(landing.includes(`<dt>${surface}</dt>`), `the home page does not mention ${surface}`);
  }
  /* And it says why it wants a calendar, in the reviewer's own terms. This is
   * the section the scope review reads. */
  assert.match(landing, /Connecting Google Calendar/, 'the calendar permission is never explained');
  assert.match(landing, /entirely optional/, 'the home page implies calendar access is required');
  assert.match(landing, /only ever writes the specific change you confirm/,
    'the home page does not say writes are confirmed first');
  // Each scope explained in its own words, not just named.
  assert.equal((landing.match(/<li><b>/g) ?? []).length, 4,
    'the four calendar permissions are not each explained');
  // Reachable from the page a reviewer lands on.
  // Absolute, so it matches the consent screen string for string — see the
  // homepage-requirements test below.
  assert.match(landing, /href="https:\/\/life-os\.web-anchor\.com\/privacy\.html"/,
    'the home page does not link the privacy policy');
  assert.match(landing, /href="https:\/\/life-os\.web-anchor\.com\/terms\.html"/,
    'the home page does not link the terms');
});

test('a returning visitor does not watch the landing page flash past', () => {
  /* Firebase takes a moment to restore a session. Without a hint, every return
   * visit renders the marketing page first and then throws it away. */
  assert.match(app, /const SEEN = 'los2_signed_in'/, 'there is no returning-visitor hint');
  assert.match(app, /if \(localStorage\.getItem\(SEEN\)\) showSpinner\(\);/,
    'a returning visitor is shown the landing page first');
  assert.match(app, /localStorage\.setItem\(SEEN, '1'\)/, 'the hint is never set');
  assert.match(app, /localStorage\.removeItem\(SEEN\)/, 'signing out leaves the hint behind');
  // It is a hint about which screen to draw, never a way in.
  const reads = app.match(/localStorage\.getItem\(SEEN\)/g) ?? [];
  assert.equal(reads.length, 1, 'the hint is read somewhere other than the first paint');
  assert.match(app, /if \(localStorage\.getItem\(SEEN\)\) showSpinner\(\);/,
    'the only read of the hint does something other than choose a screen');
});

test('the home page is small enough that its content is actually read', () => {
  /* This is the one that cost two verification rounds.
   *
   * The landing page was correct, present, and static — and Google still
   * reported that the home page did not explain the app and did not carry its
   * name. Both were true of the rendered page and false of the fetched bytes:
   * index.html opened with a 350KB inline <style> block, so every word of
   * content sat past byte 353,000, beyond whatever the verifier was willing to
   * read. Nothing was wrong with the markup. It was just too far down. */
  const bytes = Buffer.byteLength(indexHtml, 'utf8');
  assert.ok(bytes < 24_000,
    `index.html is ${bytes} bytes — content is being pushed out of reach again`);

  // The name and the purpose have to be near the top, not merely present.
  const at = (needle: string) => Buffer.byteLength(indexHtml.slice(0, indexHtml.indexOf(needle)), 'utf8');
  assert.ok(indexHtml.includes('<h1>Life OS</h1>'), 'the app name is gone from the home page');
  assert.ok(at('<h1>Life OS</h1>') < 8_000, 'the app name is buried too deep to be read');
  assert.ok(at('Connecting Google Calendar') < 16_000, 'the calendar explanation is buried');

  // The stylesheet is a file, and the page links it rather than carrying it.
  assert.match(indexHtml, /<link rel="stylesheet" href="\.\/app\.css">/,
    'the stylesheet is inline again');
  assert.ok(!/<style>/.test(indexHtml), 'an inline style block is back in the home page');

  // It is part of the shell, or an offline launch renders unstyled.
  const sw = read(join('..', 'web', 'sw.js'));
  assert.match(sw, /'\.\/app\.css'/, 'the stylesheet is not precached');
  // And it carries no content hash, so it must not be cached across a deploy.
  assert.match(webServer, /ext === '\.css'/, 'a stale stylesheet can outlive a deploy');
});

test('nothing stands between a crawler and the public pages', () => {
  const robots = read(join('..', 'web', 'robots.txt'));
  assert.match(robots, /User-agent: \*/, 'robots.txt does not address every crawler');
  assert.match(robots, /Allow: \//, 'the site is not explicitly allowed');
  assert.ok(!/Disallow: \/\s*$/m.test(robots), 'the whole site is disallowed');
  // Served as text, or a crawler is handed a download instead of a file.
  assert.match(webServer, /'\.txt': 'text\/plain/, 'robots.txt is served with the wrong type');
  assert.match(webServer, /'\.xml': 'application\/xml/, 'the sitemap is served with the wrong type');
});

test('the name and the purpose are readable without parsing prose', () => {
  /* Both remaining verification errors asked machine questions — what is this
   * app called, and what is it for — and the only machine-readable answers on
   * the page were <title>Life OS</title> and a meta description reading "Your
   * calm home for everything", which is a tagline and not a purpose. */
  const head = indexHtml.slice(0, indexHtml.indexOf('</head>'));

  // The name, stated identically everywhere a reader might look for it.
  assert.match(head, /<title>Life OS<\/title>/, 'the title is not exactly the app name');
  for (const tag of ['application-name', 'og:site_name', 'og:title']) {
    assert.ok(new RegExp(`(name|property)="${tag}" content="Life OS"`).test(head),
      `${tag} does not carry the app name`);
  }

  // The purpose, in prose a checker can lift whole.
  const desc = head.match(/<meta name="description" content="([^"]+)"/);
  assert.ok(desc, 'there is no meta description');
  assert.match(desc![1], /^Life OS is a personal productivity app/,
    'the description is a tagline rather than a statement of purpose');
  assert.ok(desc![1].length > 90, 'the description is too short to explain anything');
  assert.match(head, /<meta property="og:description" content="Life OS is a personal/,
    'the Open Graph description does not state the purpose');

  // Structured data, which has to be valid JSON or it is worse than absent.
  const ld = head.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(ld, 'there is no structured data');
  const parsed = JSON.parse(ld![1]) as Record<string, unknown>;
  assert.equal(parsed['@type'], 'SoftwareApplication', 'the structured data is not an application');
  assert.equal(parsed.name, 'Life OS', 'the structured data name does not match the consent screen');
  assert.match(String(parsed.description), /personal productivity app/,
    'the structured data does not describe the app');
  assert.equal(parsed.url, 'https://life-os.web-anchor.com/', 'the structured data points elsewhere');

  // And one canonical URL, so there is no argument about which page this is.
  assert.match(head, /<link rel="canonical" href="https:\/\/life-os\.web-anchor\.com\/">/,
    'the home page declares no canonical URL');
});

test("the home page meets Google's published homepage requirements", () => {
  const landing = indexHtml.slice(indexHtml.indexOf('id="landing"'),
    indexHtml.indexOf('</main>')).replace(/\s+/g, ' ');

  /* "Include a link to your privacy policy (this link should match the link
   * you added on your consent screen configuration)."
   *
   * The consent screen carries a full URL. ./privacy.html resolves to the same
   * page in a browser and is not the same string, so a checker comparing the
   * two finds nothing. Absolute, character for character. */
  const POLICY = 'https://life-os.web-anchor.com/privacy.html';
  assert.ok(landing.includes(`href="${POLICY}"`),
    'the privacy link does not match the consent screen configuration');
  assert.ok(!/href="\.\/privacy\.html"/.test(landing),
    'a relative privacy link is back on the home page');

  // "Accurately represent and identify your app or brand."
  assert.ok(indexHtml.includes('<h1>Life OS</h1>'), 'the app is not identified by name');

  // "Fully describe your app's functionality to users."
  assert.ok((landing.match(/<dt>/g) ?? []).length >= 6,
    'the functionality is not described in any detail');

  /* "Explain with transparency the purpose for which your app requests user
   * data" — each scope, and what it is wanted for, not just its name. */
  assert.match(landing, /If you connect it, Life OS asks Google for permission to/,
    'the home page does not explain why user data is requested');
  assert.equal((landing.match(/<li><b>/g) ?? []).length, 4,
    'not every requested permission is explained');

  /* Google's branding rules: no Google product name in the app's own name, and
   * no Google mark as the app's icon. Referring to Google Calendar as the
   * thing being connected to is exactly what those rules permit. */
  assert.equal(indexHtml.match(/<h1>(.*?)<\/h1>/)![1], 'Life OS',
    'the app name contains something it should not');
  for (const tag of ['og:site_name', 'og:title']) {
    const m = indexHtml.match(new RegExp(`property="${tag}" content="([^"]+)"`));
    assert.ok(m && !/google/i.test(m[1]), `${tag} puts a Google product name in the app name`);
  }
});
