#!/usr/bin/env node
/**
 * Reference terrain samples from Cosmolabe's own sampler, for MoonTerrainTest: the Java sampler must give the
 * same height as the renderer's CPU grids at the same point.
 *
 *   node terrain-reference.mjs --cosmolabe <checkout with packages/three built> [--grids <cpu-grids.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({ options: { cosmolabe: { type: 'string' }, grids: { type: 'string' } } });
const here = dirname(fileURLToPath(import.meta.url));
const index = JSON.parse(readFileSync(join(here, '..', 'src/main/resources/moonfall/terrain/index.json'), 'utf8'));
const grids = opt.grids ?? join(opt.cosmolabe, 'apps/viewer/test-catalogs/data/moon-terrain-cube/cpu-grids.json');
const { CubeSphereGridSource } = await import(pathToFileURL(join(opt.cosmolabe, 'packages/three/dist/surface/CubeSphereGrids.js')).href);
const source = await CubeSphereGridSource.fromUrl(pathToFileURL(grids).href, { fetch: async url => new Response(readFileSync(new URL(url))) });
if (source.manifest.source.version !== index.revision) throw Error('revision mismatch');
await source.ready;

// Deterministic points: a polar grid out to 21 km plus the old MoonFall bases.
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const points = [[-89.55, -45], [-89.4, 30], [-89.78, 90], [-89.5, -135], [-89.67, 129.78]];
while (points.length < 300) {
  const rKm = 21 * Math.sqrt(rand()), az = 360 * rand() - 180;
  points.push([-90 + rKm / 1737.4 * 180 / Math.PI, az]);
}
const samples = [];
for (const [lat, lon] of points) {
  await source.request(lat, lon);
  const c = source.coverage(lat, lon), s = source.sampler.sample(lat, lon);
  samples.push({ lat, lon, coverage: c.state, tile: s?.tileId ?? null, elevationM: s ? s.elevationKm * 1000 : null });
}
source.dispose();
writeFileSync(join(here, '..', 'src/test/resources/terrain-reference.json'),
  JSON.stringify({ revision: index.revision, sampler: 'CubeSphereSampler.sample (Cosmolabe)', samples }, null, 1) + '\n');
console.log(`${samples.length} samples; coverage ${JSON.stringify(samples.reduce((m, s) => ({ ...m, [s.coverage]: (m[s.coverage] ?? 0) + 1 }), {}))}`);
