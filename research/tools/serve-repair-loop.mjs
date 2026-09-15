import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildRadialLoop, REPO_ROOT } from './build-radial-loop.mjs';
import { buildSupportStudy } from './build-support-study.mjs';

const portIndex = process.argv.indexOf('--port');
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8765;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024..65535');
const supports = process.argv.includes('--supports');
const archiveIndex = process.argv.indexOf('--archive');
if (supports) await buildSupportStudy(archiveIndex >= 0 ? process.argv[archiveIndex + 1] : null);
else await buildRadialLoop();
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const root = await fs.realpath(REPO_ROOT);
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end('Local research server: remote writes are disabled.'); return; }
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/') { res.writeHead(302, { Location: supports ? '/research/generated/support-study-v1/index.html' : '/research/generated/radial-loop-v1/index.html' }); res.end(); return; }
    // This dedicated origin never reaches production Redis. The HTML override
    // is installed before any module can resolve API_BASE.
    if (url.pathname.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ names: [], characters: {}, campaigns: [], localResearchOnly: true })); return; }
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.')) || pathname.includes('/node_modules/')) throw new Error('Forbidden path');
    let file = path.resolve(root, `.${pathname}`);
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
    file = await fs.realpath(file);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escapes research workspace');
    const type = mime[path.extname(file).toLowerCase()];
    if (!type) { res.writeHead(403); res.end('Unsupported file type'); return; }
    let bytes = await fs.readFile(file);
    if (type === 'text/html') bytes = Buffer.from(bytes.toString('utf8').replace(/<head(?:\s[^>]*)?>/i,
      '$&<script>window.__PEGGLE_API_BASE__="/api";</script>'));
    res.writeHead(200, { 'Content-Type': type + (type.startsWith('text/') ? '; charset=utf-8' : ''), 'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is occupied. No process was stopped. Use npm run research:repair -- --port 8766`
    : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Repair loop: http://127.0.0.1:${port}/`);
  console.log('Local only; no production API, no automatic browser opening. Keep this terminal open. Ctrl+C stops the server.');
});
