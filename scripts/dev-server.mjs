// Static dev server for local testing on Windows/macOS/Linux.
//
// Three things this does that a plain `python -m http.server` does not:
//   - binds dual-stack, so `localhost` works whether the browser resolves it
//     to 127.0.0.1 or ::1 (Windows browsers usually try ::1 first)
//   - sends no-store on everything, so an edited module is never served stale
//   - proxies /api upstream, so the LAN address behaves like localhost
//
// Usage: node scripts/dev-server.mjs [port]

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8099;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav'
};

// Both player.html and js/api.js resolve the API base the same way: file:// or
// localhost talks to the real backend, anything else talks to /api on its own
// origin. Opening the LAN address on a phone therefore lands on the second
// branch, and without an /api here the app silently falls back to the checked-in
// seed in data/player — which holds a handful of levels, not the real campaign.
// Proxying keeps the phone and the desktop on the same data, and being
// same-origin it also sidesteps CORS entirely.
const API_UPSTREAM = process.env.PEGGLE_API_UPSTREAM || 'https://peggle.vercel.app';

// node:https rather than fetch, because fetch is not global before Node 18 and
// this has to run on whatever the machine has.
function proxyApi(req, res, targetUrl = API_UPSTREAM.replace(/\/$/, '') + req.url, body = null, depth = 0) {
  if (depth > 3) return send(res, 508, 'API proxy: too many redirects');

  const collectThenSend = (buffered) => {
    let target;
    try {
      target = new URL(targetUrl);
    } catch {
      return send(res, 502, `API proxy: bad upstream URL ${targetUrl}`);
    }
    const client = target.protocol === 'http:' ? http : https;
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      // Hop-by-hop headers must not be forwarded, host has to name the
      // upstream, and identity encoding keeps the body readable.
      if (['host', 'connection', 'content-length', 'accept-encoding'].includes(key)) continue;
      if (typeof value === 'string') headers[key] = value;
    }
    headers.host = target.host;
    headers['accept-encoding'] = 'identity';
    if (buffered) headers['content-length'] = buffered.length;

    const upstream = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers
    }, (up) => {
      const location = up.headers.location;
      if (location && up.statusCode >= 300 && up.statusCode < 400) {
        up.resume();
        return proxyApi(req, res, new URL(location, targetUrl).toString(), buffered, depth + 1);
      }
      res.writeHead(up.statusCode || 502, {
        'Content-Type': up.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
      });
      up.pipe(res);
    });

    upstream.on('error', (error) => {
      // Loud rather than silent: a failed proxy otherwise looks exactly like
      // the static-seed fallback, which is the bug this exists to prevent.
      console.error(`  [api] proxy failed ${req.method} ${req.url}: ${error.message}`);
      send(res, 502, `API proxy to ${API_UPSTREAM} failed: ${error.message}`);
    });

    if (buffered) upstream.end(buffered);
    else upstream.end();
  };

  if (body !== null || req.method === 'GET' || req.method === 'HEAD') {
    collectThenSend(body);
    return;
  }
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => collectThenSend(Buffer.concat(chunks)));
  req.on('error', () => send(res, 400, 'API proxy: request stream failed'));
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }

  if (urlPath === '/api' || urlPath.startsWith('/api/')) {
    proxyApi(req, res);
    return;
  }

  // The player is the thing you almost always want; a directory listing at /
  // is what makes it look like the server "isn't serving anything".
  if (urlPath === '/') urlPath = '/player.html';

  const filePath = path.join(ROOT, urlPath);
  // Refuse anything that escapes the project directory.
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, `Not found: ${urlPath}`);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Either something else is serving it, or a previous dev server is still running.`);
    console.error(`  Try: node scripts/dev-server.mjs ${PORT + 1}\n`);
    process.exit(1);
  }
  throw err;
});

/** Physical LAN addresses, for testing on a phone on the same network. */
function lanAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      // Skip Hyper-V/WSL/VPN adapters — a phone cannot reach those.
      if (/vEthernet|VMware|VirtualBox|Loopback|WSL/i.test(name)) continue;
      found.push({ name, address: entry.address });
    }
  }
  return found;
}

// No host argument => dual-stack on every interface, so localhost, 127.0.0.1,
// ::1 and the LAN address all work.
server.listen(PORT, () => {
  console.log('');
  console.log('  RealPeggle dev server');
  console.log(`    Game     http://localhost:${PORT}/player.html`);
  console.log(`    Editor   http://localhost:${PORT}/editor.html`);
  console.log(`    Lighting http://localhost:${PORT}/test/playfield-lab.html?scale=2`);
  console.log(`    Renderer http://localhost:${PORT}/test/renderer-lab.html`);
  const lan = lanAddresses();
  if (lan.length) {
    console.log('');
    console.log('  On the same Wi-Fi (phone):');
    for (const { name, address } of lan) {
      console.log(`    http://${address}:${PORT}/player.html   (${name})`);
    }
  }
  console.log('');
  console.log(`  /api proxies to ${API_UPSTREAM} (set PEGGLE_API_UPSTREAM to change),`);
  console.log('  so the LAN address gets the same campaign as localhost.');
  console.log('  Ctrl+C to stop. Rebuild the bundle after editing js/ with:');
  console.log('    npm run build');
  console.log('');
});
