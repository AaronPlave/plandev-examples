#!/usr/bin/env node
// Writes drone.gltf: a CONCEPTUAL MoonFall-like propulsive drone, not flight CAD. No official 3D model of the
// MoonFall drones is published (checked November 2026); public descriptions give roughly 2.1 m across and 1.2 m
// tall. This is a squat octagonal body on four legs with a downward main engine, built from those proportions.
//
// Model axes are the body axes of examples/12-moonfall (metres, origin at the footpad plane):
//   +Z up (thrust axis), +X forward (direction of travel while coasting; red marker), camera on the underside
//   looking along -Z (the survey camera's boresight, Camera.BORESIGHT).
// Run: node make-drone-model.mjs
import { writeFileSync } from 'node:fs';

/** A closed n-sided prism (or frustum) along Z: radius r0 at z0, r1 at z1, centred at (cx, cy). */
function prism({ n, r0, r1 = r0, z0, z1, cx = 0, cy = 0, rot = 0 }) {
  const pos = [], nrm = [], idx = [];
  const ring = (r, z) => Array.from({ length: n }, (_, i) => {
    const a = rot + (2 * Math.PI * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), z];
  });
  const lo = ring(r0, z0), hi = ring(r1, z1);
  const quad = (a, b, c, d, nv) => {
    const base = pos.length / 3;
    for (const p of [a, b, c, d]) { pos.push(...p); nrm.push(...nv); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const mid = (2 * i + 1) * Math.PI / n + rot;
    const slope = (r0 - r1) / (z1 - z0);
    const nv = [Math.cos(mid), Math.sin(mid), slope];
    const l = Math.hypot(...nv);
    quad(lo[i], lo[j], hi[j], hi[i], nv.map((x) => x / l));
  }
  for (const [r, z, up] of [[lo, z0, -1], [hi, z1, 1]]) {
    const c = pos.length / 3;
    pos.push(cx, cy, z); nrm.push(0, 0, up);
    for (const p of r) { pos.push(...p); nrm.push(0, 0, up); }
    for (let i = 0; i < n; i++) {
      const a = c + 1 + i, b = c + 1 + ((i + 1) % n);
      idx.push(...(up > 0 ? [c, a, b] : [c, b, a]));
    }
  }
  return { pos, nrm, idx };
}

const legs = [0, 1, 2, 3].map((k) => {
  const a = Math.PI / 4 + (k * Math.PI) / 2;
  return { x: 0.95 * Math.cos(a), y: 0.95 * Math.sin(a) };
});
const parts = [
  { name: 'body', color: [0.78, 0.78, 0.8], ...prism({ n: 8, r0: 1.05, z0: 0.55, z1: 0.95, rot: Math.PI / 8 }) },
  { name: 'tanks', color: [0.85, 0.7, 0.35], ...prism({ n: 16, r0: 0.55, r1: 0.4, z0: 0.95, z1: 1.2 }) },
  { name: 'engine', color: [0.25, 0.25, 0.28], ...prism({ n: 16, r0: 0.28, r1: 0.12, z0: 0.3, z1: 0.55 }) },
  ...legs.map((l, k) => ({ name: `leg${k}`, color: [0.55, 0.55, 0.58], ...prism({ n: 6, r0: 0.04, z0: 0.05, z1: 0.6, cx: l.x, cy: l.y }) })),
  ...legs.map((l, k) => ({ name: `pad${k}`, color: [0.55, 0.55, 0.58], ...prism({ n: 10, r0: 0.14, z0: 0, z1: 0.05, cx: l.x, cy: l.y }) })),
  { name: 'survey camera (-Z)', color: [0.1, 0.1, 0.12], ...prism({ n: 12, r0: 0.09, z0: 0.42, z1: 0.55, cx: 0.55 }) },
  { name: 'forward marker (+X)', color: [0.85, 0.15, 0.15], ...prism({ n: 4, r0: 0.12, z0: 0.95, z1: 1.0, cx: 0.85, rot: Math.PI / 4 }) },
];

const chunks = [], meshes = [], accessors = [], bufferViews = [];
let offset = 0;
const push = (array, target) => {
  const bytes = Buffer.from(array.buffer);
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
  chunks.push(bytes);
  offset += bytes.length;
  return bufferViews.length - 1;
};
for (const [i, p] of parts.entries()) {
  const f = new Float32Array(p.pos);
  const min = [0, 1, 2].map((k) => Math.min(...p.pos.filter((_, j) => j % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...p.pos.filter((_, j) => j % 3 === k)));
  const pv = push(f, 34962), nv = push(new Float32Array(p.nrm), 34962), iv = push(new Uint16Array(p.idx), 34963);
  accessors.push(
    { bufferView: pv, componentType: 5126, count: f.length / 3, type: 'VEC3', min, max },
    { bufferView: nv, componentType: 5126, count: f.length / 3, type: 'VEC3' },
    { bufferView: iv, componentType: 5123, count: p.idx.length, type: 'SCALAR' },
  );
  meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: 3 * i, NORMAL: 3 * i + 1 }, indices: 3 * i + 2, material: i }] });
}
const buffer = Buffer.concat(chunks);
writeFileSync(new URL('./drone.gltf', import.meta.url), JSON.stringify({
  asset: { version: '2.0', generator: 'plandev-examples moonfall make-drone-model.mjs', copyright: 'Conceptual approximation; not MoonFall flight hardware' },
  scene: 0,
  scenes: [{ nodes: parts.map((_, i) => i) }],
  nodes: parts.map((p, i) => ({ name: p.name, mesh: i })),
  meshes,
  materials: parts.map((p) => ({ name: p.name, pbrMetallicRoughness: { baseColorFactor: [...p.color, 1], metallicFactor: 0.3, roughnessFactor: 0.6 } })),
  accessors,
  bufferViews,
  buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${buffer.toString('base64')}` }],
}));
console.log('wrote drone.gltf', buffer.length, 'bytes');
