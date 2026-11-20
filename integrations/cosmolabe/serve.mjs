#!/usr/bin/env node
// Static server for the PlanDev ↔ Cosmolabe prototype: the mission index, catalogs and adapters, the SPICE
// kernels the mission models themselves load (spice-kernels/), and Cosmolabe's shared scene data (textures,
// places), and Cosmolabe's versioned large products (terrain, imagery) proxied from its data host at /hosted/ — the
// host does not allow the PlanDev UI's origin. CORS-open because the PlanDev UI fetches from another origin. Development use only.
//
//   COSMOLABE_DATA=~/code/cosmolabe/apps/viewer/test-catalogs node integrations/cosmolabe/serve.mjs   # :8890
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOTS = {
  missions: join(here, 'missions'),
  kernels: resolve(here, '../../spice-kernels'),
  ...(process.env.COSMOLABE_DATA ? { cosmolabe: resolve(process.env.COSMOLABE_DATA) } : {}),
};
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.gltf': 'model/gltf+json' };
const PORT = Number(process.env.PORT ?? 8890);
const DATA_HOST = process.env.COSMOLABE_DATA_HOST ?? 'https://data.aaronplave.com';
/** Only build-pinned product paths are proxied: <kind>/<name>/<build>/<file>. */
export const hostedUrl = (urlPath) =>
  /^\/hosted\/(cube-terrain|cube-imagery)\/[\w.-]+\/[\w.-]+\/[\w./-]+$/.test(urlPath) && !urlPath.includes('..')
    ? DATA_HOST + urlPath.slice('/hosted'.length)
    : null;

/** The file a URL path names under one of ROOTS, or null (unknown root, or a path escaping it). */
export function fileFor(urlPath) {
  const [, root, ...rest] = decodeURIComponent(urlPath).split('/');
  const base = ROOTS[root];
  if (!base) return null;
  const file = normalize(join(base, ...rest));
  return file === base || file.startsWith(base + sep) ? file : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const hosted = hostedUrl(new URL(req.url, 'http://x').pathname);
    if (hosted) {
      (async () => {
        try {
          const r = await fetch(hosted);
          const body = Buffer.from(await r.arrayBuffer());
          res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'max-age=86400' });
          res.end(body);
        } catch {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        }
      })();
      return;
    }
    const file = fileFor(new URL(req.url, 'http://x').pathname);
    let size = -1;
    try {
      size = file ? statSync(file).isFile() ? statSync(file).size : -1 : -1;
    } catch {}
    if (size < 0) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }).listen(PORT, () => console.log(`cosmolabe missions on http://localhost:${PORT} (${Object.keys(ROOTS).join(', ')})`));
}
