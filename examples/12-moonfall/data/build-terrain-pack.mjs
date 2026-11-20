#!/usr/bin/env node
/**
 * Pack the Moon terrain the MoonFall model flies over into the mission model jar.
 *
 * Source: Cosmolabe's pinned cube-sphere height product (the terrain its MoonFall scene draws), revision
 * REVISION below, from the versioned data host or from a local copy of the same build. The pack holds the
 * product's own tiles, unchanged: every *finest* tile (no children in the product) of face `nz` whose centre
 * is within RADIUS_KM of the south pole. Nothing is resampled; the Java sampler interpolates the same lattice
 * triangles as Cosmolabe's CubeSphereSampler.
 *
 * Outputs (src/main/resources/moonfall/terrain/):
 *   index.json   committed: revision, datum, region, and per tile [level, x, y, uncertaintyKm, sha256]
 *   tiles.f32    not committed (~21 MB): the tiles' float32 grids, in index order
 *
 *   node build-terrain-pack.mjs                       # fetch from the data host
 *   node build-terrain-pack.mjs --source <dir>        # a local copy (…/test-catalogs/data/moon-terrain-cube)
 *   node build-terrain-pack.mjs --verify              # check tiles.f32 against the committed index
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REVISION = 'cube-fused-79895697c6b6-g3-m12-b6747ec9d';
const HOST = `https://data.aaronplave.com/cube-terrain/moon-terrain-cube/${REVISION}`;
const RADIUS_KM = 22;
const FACE = 'nz';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'resources', 'moonfall', 'terrain');

const { values: opt } = parseArgs({ options: { source: { type: 'string' }, verify: { type: 'boolean' } } });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

if (opt.verify) {
  const index = JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8'));
  const data = readFileSync(join(OUT, 'tiles.f32'));
  if (sha(data) !== index.packSha256) throw Error(`tiles.f32 does not match index.json (${sha(data)} != ${index.packSha256})`);
  console.log(`tiles.f32 matches index.json: ${index.tiles.length} tiles of ${index.revision}`);
  process.exit(0);
}

const read = async path => {
  if (opt.source) return readFileSync(join(opt.source, path));
  const r = await fetch(`${HOST}/${path}`);
  if (!r.ok) throw Error(`${path}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

const manifest = JSON.parse(await read('cpu-grids.json'));
if (manifest.source.version !== REVISION) throw Error(`source is ${manifest.source.version}, expected ${REVISION}`);
if (manifest.geometry) throw Error('expected a datum-height product (no radial-lattice geometry)');
const { width, height } = manifest.grid;
const R = manifest.datum.referenceShape.radiusKm;

// nz basis (packages/three/src/surface/CubeSphere.ts): N = -Z, U = -X, V = +Y.
const listed = new Set(manifest.tiles.filter(t => t[0] === FACE).map(([, l, x, y]) => `${l}/${x}/${y}`));
const hasChild = (l, x, y) => [0, 1].some(i => [0, 1].some(j => listed.has(`${l + 1}/${2 * x + i}/${2 * y + j}`)));
const poleDistanceKm = (l, x, y) => {
  const n = 2 ** l, u = (x + 0.5) / n * 2 - 1, v = (y + 0.5) / n * 2 - 1;
  return Math.acos(1 / Math.hypot(1, u, v)) * R;
};
const tiles = manifest.tiles
  .filter(([f, l, x, y]) => f === FACE && !hasChild(l, x, y) && poleDistanceKm(l, x, y) < RADIUS_KM)
  .sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);

const chunks = [], entries = [];
for (const [, l, x, y, uncertaintyKm] of tiles) {
  const bytes = await read(manifest.grid.uri.replace('{face}', FACE).replace('{level}', l).replace('{x}', x).replace('{y}', y));
  if (bytes.length !== width * height * 4) throw Error(`tile ${l}/${x}/${y}: ${bytes.length} bytes`);
  chunks.push(bytes);
  entries.push([l, x, y, uncertaintyKm, sha(bytes)]);
}
const pack = Buffer.concat(chunks);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'tiles.f32'), pack);
writeFileSync(join(OUT, 'index.json'), JSON.stringify({
  format: 'moonfall-terrain-pack-1',
  revision: REVISION,
  product: manifest.source.id,
  host: HOST,
  datum: manifest.datum,
  frame: 'MOON_ME_DE421',
  face: FACE,
  region: `finest tiles of face ${FACE} centred within ${RADIUS_KM} km of the south pole`,
  grid: { width, height, encoding: manifest.grid.encoding, order: manifest.grid.order },
  interpolation: 'lattice triangle under the point, diagonal v00-v11 (CubeSphereSampler.sample)',
  uncertainty: manifest.uncertainty.kind,
  packSha256: sha(pack),
  tiles: entries,
}) + '\n');
const levels = entries.reduce((m, [l]) => ({ ...m, [l]: (m[l] ?? 0) + 1 }), {});
console.log(`${entries.length} tiles ${JSON.stringify(levels)}, ${(pack.length / 1e6).toFixed(1)} MB → ${OUT}`);
