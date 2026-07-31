/**
 * Static file server for the Life OS v2 web shell.
 *
 * Zero dependencies — Node's own http and fs. Railway runs this with
 * `npm start`, and it is the only reason /web needs a package.json.
 *
 * THE POINT OF THIS FILE: `/config.js` is generated at request time from
 * environment variables, so the Firebase web config and API URL live in
 * Railway's variable store rather than in a commit. Nothing account-specific
 * ever enters git. If the variables are absent, the committed
 * `config.js` — full of FILL_ME_IN — is served instead and the app shows a
 * "Configuration needed" card. Failing loudly beats a blank screen.
 *
 * Nothing here is secret. The Firebase web config identifies a project; it does
 * not authorise anything. The real gate is the API verifying the ID token.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** Env-derived config, or null when nothing is configured. */
function runtimeConfig() {
  const {
    API_BASE_URL, FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN,
    FIREBASE_PROJECT_ID, FIREBASE_APP_ID,
  } = process.env;

  const firebase = {
    apiKey: FIREBASE_API_KEY, authDomain: FIREBASE_AUTH_DOMAIN,
    projectId: FIREBASE_PROJECT_ID, appId: FIREBASE_APP_ID,
  };
  const configured = Object.values(firebase).every((v) => typeof v === 'string' && v.trim());
  if (!configured && !API_BASE_URL) return null;   // nothing set — use the committed file

  return `/* Generated at runtime from environment variables. Not from a commit. */
window.LIFE_OS_CONFIG = {
  apiBaseUrl: localStorage.getItem('los2_api') || ${JSON.stringify(API_BASE_URL ?? '')},
  firebase: ${JSON.stringify(firebase)},
};
window.LIFE_OS_CONFIG.isConfigured = ${JSON.stringify(configured)}
  && Boolean(window.LIFE_OS_CONFIG.apiBaseUrl);
`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    // Trivial liveness probe so Railway's health check has something to hit.
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"status":"ok","service":"life-os-v2-web"}');
    }

    if (url.pathname === '/config.js') {
      const generated = runtimeConfig();
      if (generated) {
        // Never cache: the whole point is that a variable change takes effect
        // on the next request without a redeploy.
        res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
        return res.end(generated);
      }
      // fall through and serve the committed placeholder file
    }

    // Resolve inside ROOT only. normalize() collapses any ../ before we join,
    // so a crafted path cannot climb out of the web directory.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\.]+)/, '');
    let file = join(ROOT, rel || 'index.html');
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

    // Server-side files that happen to live in this directory. None of them
    // contain secrets, but a static host should serve the app, not itself.
    const base = rel.split(/[/\\]/).pop() ?? '';
    if (base.startsWith('.') || base === 'package.json' || base === 'package-lock.json'
        || base === 'server.js') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }

    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }

    const body = await readFile(file);
    const ext = extname(file);
    /**
     * HTML and JS are served no-cache.
     *
     * These filenames are stable — there is no content hash in them — so a
     * cached `app.js` keeps running against a redeployed API until it expires.
     * Five minutes of that is five minutes of confusing, unreproducible bugs.
     * The files are a few kilobytes; revalidating them costs nothing worth
     * having. Images and fonts, whose content does not change under a given
     * name, can still be cached.
     */
    const revalidate = ext === '.html' || ext === '.js' || ext === '.json';
    res.writeHead(200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': revalidate ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
    res.end(body);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Server error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const cfg = runtimeConfig();
  console.log(`Life OS v2 web on :${PORT} — config source: ${cfg ? 'environment' : 'committed config.js (placeholders)'}`);
});
