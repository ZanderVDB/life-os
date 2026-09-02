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
  // Served as themselves, or a crawler gets a download prompt instead.
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/** Env-derived config, or null when nothing is configured. */
/**
 * A stable id for this deployment.
 *
 * Railway sets RAILWAY_GIT_COMMIT_SHA on every build, which is exactly what a
 * build id should be: it changes when and only when the code does. The fallback
 * is a boot timestamp, so a locally-run server still gets a distinct id rather
 * than silently sharing a cache with the previous run.
 */
const BUILD_ID = (process.env.RAILWAY_GIT_COMMIT_SHA
  ?? process.env.BUILD_ID
  ?? `dev-${Date.now().toString(36)}`).slice(0, 12);

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
window.LIFE_OS_BUILD = ${JSON.stringify(BUILD_ID)};
/* Development tools on a DEPLOYED service, asked for by name.
 *
 * The same switch that exposes /preview.html: a deployment somebody is
 * actively working on. It gates the viewport preview and the assistant's
 * A/B/C listening-style selector — neither of which is a user feature, and
 * both of which have to be reachable on the staging deployment that is
 * being worked on. Delete DEV_PREVIEW to turn both off. */
window.LIFE_OS_CONFIG.devTools = ${JSON.stringify(devToolsEnabled)};
`;
}

/**
 * Are development tools available on THIS deployment?
 *
 * ── Why this is derived, not a flag ──────────────────────────────────────
 *
 * It was `DEV_PREVIEW=1`, opt-in, and nobody had set it on the staging web
 * service — so the assistant's Development panel did not exist on staging at
 * all, while every local check said it did. A switch that has to be remembered
 * is a switch that is forgotten, and the thing it hid was the diagnostics we
 * were relying on to debug a real device.
 *
 * So the ENVIRONMENT decides:
 *
 *   production            → they do not exist
 *   staging / local dev   → they are available
 *
 * `DEV_PREVIEW` still forces them on for a deployment that is neither. Note
 * that the staging service runs with NODE_ENV=production like the real thing,
 * which is exactly why keying off NODE_ENV alone was never going to work.
 *
 * FAILS CLOSED: an unrecognised deployment gets nothing.
 */
const ENV_NAME = String(
  process.env.APP_ENV || process.env.RAILWAY_ENVIRONMENT_NAME
  || process.env.RAILWAY_ENVIRONMENT || '',
).toLowerCase();
const IS_PRODUCTION = /prod/.test(ENV_NAME);
const IS_STAGING = /stag|preview|dev/.test(ENV_NAME);
const IS_LOCAL = process.env.NODE_ENV !== 'production';

export const devToolsEnabled = process.env.DEV_PREVIEW === '1'
  || (!IS_PRODUCTION && (IS_STAGING || IS_LOCAL));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    // Trivial liveness probe so Railway's health check has something to hit.
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"status":"ok","service":"life-os-v2-web"}');
    }

    /**
     * The service worker is generated per request so its cache name carries the
     * build id. A new deployment therefore lands in a brand-new cache, and the
     * worker file itself differs byte-for-byte — which is what makes the
     * browser notice an update at all.
     */
    if (url.pathname === '/sw.js') {
      const src = await readFile(join(ROOT, 'sw.js'), 'utf8');
      res.writeHead(200, {
        'content-type': TYPES['.js'],
        'cache-control': 'no-store',
        'service-worker-allowed': '/',
      });
      return res.end(src.replace(/__BUILD_ID__/g, BUILD_ID));
    }

    if (url.pathname === '/version') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ build: BUILD_ID, service: 'life-os-v2-web' }));
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

    /* The viewport preview is a development tool and never reaches a
     * production visitor. It is not a setting and not linked from anywhere in
     * the app — but a URL people can guess should still refuse to answer, so
     * the gate is here rather than relying on obscurity. Deleting
     * web/preview.html removes the feature outright. */
    if (url.pathname === '/preview.html' || url.pathname === '/preview') {
      /* Local development always has it. A DEPLOYED service needs somebody to
       * ask for it by name — the staging web service runs with
       * NODE_ENV=production like the real thing, so keying off that alone hid
       * the tool from the one place it was meant to be used.
       *
       * Now decided by the environment — see `devToolsEnabled` above. */
      if (!devToolsEnabled) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Not found');
      }
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
    /* `/privacy` should reach `/privacy.html`.
     *
     * These two pages get typed by hand, pasted into Google's console and
     * linked from elsewhere, and a 404 on a privacy policy is worse than
     * untidy — it is the one page a reviewer definitely opens. The local dev
     * server resolves extensionless paths, so without this the two behave
     * differently and only production is wrong. */
    if (!info && !extname(file)) {
      const asHtml = `${file}.html`;
      const alt = await stat(asHtml).catch(() => null);
      if (alt?.isFile()) { file = asHtml; info = alt; }
    }
    if (!info) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }

    const body = await readFile(file);
    const ext = extname(file);
    /**
     * HTML, JS and JSON are served `no-store`, not `no-cache`.
     *
     * These filenames carry no content hash, so a cached `app.js` keeps
     * running against a redeployed API. `no-cache` is meant to force
     * revalidation, but it only works if the response carries a validator —
     * and these have no ETag or Last-Modified, so browsers were free to serve
     * them from memory anyway. That produced the exact symptom the version
     * indicator then hid: a fresh `config.js` reporting the new build while a
     * stale `app.js` ran underneath it.
     *
     * `no-store` forbids keeping a copy at all. These files are a few
     * kilobytes; re-fetching them costs far less than a class of bug that
     * looks like "the deploy did not work".
     *
     * Images and fonts keep their cache — their content genuinely does not
     * change under a given name.
     */
    const mutable = ext === '.html' || ext === '.js' || ext === '.json' || ext === '.css';
    res.writeHead(200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': mutable ? 'no-store' : 'public, max-age=300',
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
