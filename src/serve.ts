import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep, posix } from 'node:path';
import { sha256 } from './store.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.txt': 'text/plain', '.xml': 'application/xml',
};

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Serve a fork over http://127.0.0.1 so root-relative game paths (/assets/x.png) resolve.
 * `isolate` adds COOP/COEP headers (needed by threaded wasm / SharedArrayBuffer builds).
 */
export function serveFork(root: string, port: number, isolate: boolean): Promise<http.Server> {
  const base = resolve(root);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel: string;
      try {
        rel = decodeURIComponent(url.pathname);
      } catch {
        rel = url.pathname;
      }
      let file = resolve(join(base, rel));
      if (file !== base && !file.startsWith(base + sep)) {
        res.writeHead(403).end();
        return;
      }
      const candidates: string[] = [];
      const ext0 = extname(file);
      if (url.search) candidates.push(`${file.slice(0, file.length - ext0.length)}~${sha256(url.search).slice(0, 6)}${ext0}`);
      candidates.push(file, posix.join(file, 'index.html'));
      let found = '';
      for (const c of candidates) if (await isFile(c)) { found = c; break; }
      if (!found) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not in fork: ' + url.pathname);
        return;
      }
      file = found;
      const size = (await stat(file)).size;
      const headers: Record<string, string | number> = {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'cross-origin-resource-policy': 'cross-origin',
      };
      if (isolate) {
        headers['cross-origin-opener-policy'] = 'same-origin';
        headers['cross-origin-embedder-policy'] = 'require-corp';
      }
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(size - Number(m[2]), 0);
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start > end || start >= size) {
          res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
          return;
        }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
        if (req.method === 'HEAD') return void res.end();
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, 'content-length': size });
      if (req.method === 'HEAD') return void res.end();
      createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}
