// Local preview: serves the app and answers /api with the real Code.gs running on in-memory fakes.
// Data resets on every restart. Photos are kept in memory and served from /photo/<id>.
// Run: node tools/dev-server.mjs  →  http://localhost:5173
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadBackend } from './fake-gas.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const b = loadBackend(path.join(root, 'apps-script'));
b.setup();
const port = Number(process.env.PORT) || 5173;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api') {
    let body = ''; req.setEncoding('utf8');
    req.on('data', c => { body += c; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b.post(body))); });
    return;
  }
  if (url.pathname === '/config.js') { // point the app at this server and at local photo URLs
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end("window.API_URL = '/api'; window.PHOTO_BASE = '/photo/';");
    return;
  }
  if (url.pathname.startsWith('/photo/')) {
    const f = b.files.get(decodeURIComponent(url.pathname.slice(7)));
    if (!f) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': f.mime }); res.end(f.bytes); return;
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(root) || file.includes(`${path.sep}tools${path.sep}`) || file.includes(`${path.sep}apps-script${path.sep}`) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Preview: http://localhost:${port}  (login admin / 1234, data resets on restart)`));
