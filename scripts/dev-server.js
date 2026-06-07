/*
 * Zero-dependency static dev server for the no-build PWA.
 *
 * Serves the repo root over http with correct MIME types and a SPA fallback to
 * index.html, so `npm run dev` works offline without pulling in a bundler or a
 * third-party server. Override the port with PORT=xxxx.
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = normalize(decodeURIComponent(url.pathname));
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filePath = join(ROOT, pathname);
    // Block path traversal outside the repo root.
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const s = await stat(filePath);
      if (s.isDirectory()) throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
      const body = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      // SPA fallback: serve the app shell for unknown routes.
      const shell = await readFile(join(ROOT, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(shell);
    }
  } catch {
    res.writeHead(500);
    res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log('AAA HyperKernel dev server → http://localhost:' + PORT);
});
