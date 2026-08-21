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
