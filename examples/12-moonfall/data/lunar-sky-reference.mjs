#!/usr/bin/env node
/**
 * Reference Sun / Earth directions for LunarSkyTest from a second, independent CSPICE build — Cosmolabe's
 * cspice-wasm (N0066, @cosmolabe/frames) — loading the same kernel files as the mission model
 * (spice-kernels/: naif0012.tls, de440s.bsp, moon_080317.tf, moon_pa_de421_1900_2050.bpc).
 * Also records Cosmolabe's own MOON_ME_DE421 rotation, the frame its MoonFall scene and terrain use.
 *
 *   node lunar-sky-reference.mjs --cosmolabe <checkout with packages/frames built>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({ options: { cosmolabe: { type: 'string' } } });
const here = dirname(fileURLToPath(import.meta.url));
const kernelDir = join(here, '../../../spice-kernels');
const { createHeritageSpice } = await import(pathToFileURL(join(opt.cosmolabe, 'packages/frames/dist/index.js')).href);
const spice = await createHeritageSpice();
const kernels = [];
for (const name of ['naif0012.tls', 'de440s.bsp', 'moon_080317.tf', 'moon_pa_de421_1900_2050.bpc']) {
  const data = readFileSync(join(kernelDir, name));
  kernels.push({ name, sha256: createHash('sha256').update(data).digest('hex') });
  await spice.furnish({ type: 'buffer', data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), filename: name });
}
const R = 1737.4e3;
const site = (lat, lon, h = 0) => {
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180, r = R + h;
  return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
};
// The MoonFall bases and survey sites, through the December 2028 campaign and a little beyond.
const sites = [[-89.55, -45, -1000], [-89.4, 30, 0], [-89.78, 90, 0], [-89.5, -135, 0], [-89.7, 0, -1500], [-89.62, -30, 0]];
const times = ['2028-12-15T10:00:00Z', '2028-12-15T11:00:00Z', '2028-12-16T06:30:00Z', '2028-12-20T00:00:00Z', '2028-12-28T12:00:00Z'];
const cases = [];
for (const utc of times) {
  const et = spice.str2et(utc.replace('Z', ''));
  for (const target of ['SUN', 'EARTH']) {
    const p = spice.spkpos(target, et, 'MOON_ME_DE421', 'LT+S', 'MOON').position.map((v) => v * 1000);
    for (const [lat, lon, h] of sites) {
      const o = site(lat, lon, h);
      const d = p.map((v, i) => v - o[i]), n = Math.hypot(...d), u = d.map((v) => v / n);
      const up = o.map((v) => v / Math.hypot(...o));
      const elevationDeg = 90 - Math.acos(u.reduce((s, v, i) => s + v * up[i], 0)) * 180 / Math.PI;
      cases.push({ utc, et, target, observerM: o, direction: u, elevationDeg });
    }
  }
}
writeFileSync(join(here, '..', 'src/test/resources/lunar-sky-reference.json'), JSON.stringify({
  generator: 'data/lunar-sky-reference.mjs', toolkit: spice.tkvrsn?.('TOOLKIT') ?? 'cspice-wasm (Cosmolabe @cosmolabe/frames)', kernels, cases,
}, null, 1) + '\n');
console.log(`wrote ${cases.length} cases`);
