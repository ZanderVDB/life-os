// Minimal zero-dependency static server for Railway.
// Railway runs services (not bare static files), so this ~50-line Node
// server does what Cloudflare Pages did: serve the repo's files over HTTP.
// Critical detail: index.html and sw.js are sent with Cache-Control:
// no-store — the service-worker update flow (auto skipWaiting on new
// CACHE version) only works if browsers/CDNs always fetch the newest
// copies of those two files. Everything else gets a modest 1h cache.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    // Resolve inside ROOT only — reject anything that escapes (traversal).
    const file0 = path.normalize(path.join(ROOT, urlPath));
    if (!file0.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
    let file = file0;
    // Unknown paths fall back to the app shell (the app is hash-routed, so
    // any real navigation target is index.html anyway). Real files — e.g.
    // /privacy.html, /terms.html, /.well-known/assetlinks.json — serve as-is.
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(ROOT, 'index.html');
    }
    const base = path.basename(file);
    const noStore = base === 'sw.js' || base === 'index.html';
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': noStore ? 'no-store' : 'public, max-age=3600'
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500); res.end('Server error');
  }
}).listen(PORT, '0.0.0.0', () => console.log('Life OS serving on :' + PORT));
