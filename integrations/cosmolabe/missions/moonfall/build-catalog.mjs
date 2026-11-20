#!/usr/bin/env node
// Builds catalog.json, the PlanDev-driven MoonFall scene, from Cosmolabe's standalone MoonFall scene
// (apps/viewer/test-catalogs/moonfall-shackleton.json at the Cosmolabe commit the PlanDev UI pins).
//
// Kept from it: the Moon (DE421 mean-Earth orientation, pinned cube terrain and its imagery), Sun, Earth, the
// viewpoints, place names and MoonFall sites. Dropped: the twelve authored hopper flights and their activities —
// in this scene the drones' positions and attitudes come only from the PlanDev simulation (MissionState sources
// supplied by adapter.js), so nothing flies unless the selected simulation flew it.
//
//   node build-catalog.mjs <cosmolabe checkout>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const src = JSON.parse(readFileSync(join(process.argv[2], 'apps/viewer/test-catalogs/moonfall-shackleton.json'), 'utf8'));
const datasets = JSON.parse(readFileSync(join(process.argv[2], 'scripts/data-hosting/datasets.json'), 'utf8')).datasets;

// Large products from Cosmolabe's versioned data host (proxied by serve.mjs at /hosted), pinned to their builds;
// everything else from Cosmolabe's shared scene data (/cosmolabe).
const rewrite = (value) => {
  if (typeof value === 'string') {
    for (const [key, d] of Object.entries(datasets)) {
      if (d.catalogPrefix && d.build && value.startsWith(d.catalogPrefix)) {
        return `../../hosted/${key}/${d.build}/${value.slice(d.catalogPrefix.length)}`;
      }
    }
    return /\.(json|jpg|png|dds|glb|tf|bpc|tls|tpc|bsp)(\.gz)?$/.test(value) && !value.includes('://') ? `../../cosmolabe/${value}` : value;
  }
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
  return value;
};

const DRONES = [
  ['Polaris-A', [0.4, 0.85, 1.0]],
  ['Polaris-B', [1.0, 0.65, 0.3]],
  ['Polaris-C', [0.6, 1.0, 0.5]],
  ['Polaris-D', [1.0, 0.45, 0.75]],
];
// Must match examples/12-moonfall Camera: 40° across track (body Y) x 30° along track (body X), boresight -Z,
// image up +X. The camera is nested in its drone: a nested item's parent is the item it sits in (its own `center`
// is ignored), and a sensor is placed at, and pointed by the attitude of, that parent.
//
// Trajectory plot: a hop lasts two to three minutes, so the plot is short and resampled every 2 s (otherwise the
// trail chords across up to a minute of flight); 10 min of trail behind the drone and 10 min of planned path ahead.
// Selecting a hop in PlanDev also asks for its whole interval as the lead (Cosmolabe's selected-activity lead).
const drone = ([name, color]) => ({
  name,
  class: 'spacecraft',
  center: 'Moon',
  // The frame adapter.js supplies positions in (DroneState): declared so the scene knows it before any source exists.
  trajectoryFrame: 'MOON_ME_DE421',
  trajectory: { type: 'MissionState', source: name },
  rotationModel: { type: 'MissionState', source: name },
  trajectoryPlot: { frame: 'MOON_ME_DE421', duration: '20min', lead: '10min', sampleInterval: '2s', fade: 0.2, color },
  geometry: { type: 'Mesh', source: 'drone.gltf', size: 0.0022, castShadow: true },
  label: { color },
  items: [
    {
      name: `${name} Survey Camera`,
      trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
      label: { visible: false },
      geometry: {
        type: 'Sensor', target: 'Moon', shape: 'rectangular', horizontalFov: 40, verticalFov: 30, range: 5,
        mounting: { boresight: [0, 0, -1], up: [1, 0, 0] }, frustumColor: color, frustumOpacity: 0.25,
      },
    },
  ],
});

// A side view of Polaris-A's operating area (its base at -89.55, -45 and the rim-plain and crater sites near
// lon -30..0), from 5 km up, 10 km out on the side away from the pole, so a hop's arc stands out against the terrain.
const R = 1737.4;
const dir = (lat, lon) => [Math.cos(lat * Math.PI / 180) * Math.cos(lon * Math.PI / 180), Math.cos(lat * Math.PI / 180) * Math.sin(lon * Math.PI / 180), Math.sin(lat * Math.PI / 180)];
const hopArea = {
  name: 'Polaris-A Hop Area',
  type: 'Viewpoint',
  center: 'Moon',
  frame: 'BodyFixed',
  distance: R + 5,
  latitude: -89.3,
  longitude: -28,
  target: dir(-89.63, -24).map((v) => v * (R + 0.3)),
  up: dir(-89.3, -28),
};

const items = src.items.map((it) => {
  if (it.name === 'Moon') {
    const { items: _hoppers, ...moon } = it;
    return { ...rewrite(moon), items: DRONES.map(drone) };
  }
  if (it.name === 'Polaris-A Close-up') return { ...it, distance: 0.03 };
  return rewrite(it);
});

items.splice(items.findIndex((i) => i.name === 'Polaris-A Close-up') + 1, 0, hopArea);

const catalog = {
  name: 'MoonFall at Shackleton (PlanDev plan)',
  description: 'Four fictional MoonFall-like drones whose positions and attitudes come from the selected PlanDev simulation of examples/12-moonfall (mission-computed hops). No authored flights. The drone mesh is a conceptual approximation, not MoonFall flight hardware; the survey camera is the fictional model of examples/12-moonfall Camera.',
  displayNote: 'Planned (PlanDev simulation) · conceptual drone & camera',
  defaultTime: '2028-12-15T11:00:00Z',
  defaultViewpoint: hopArea.name,
  defaultGeographicNames: src.defaultGeographicNames,
  require: rewrite(src.require),
  items,
};
writeFileSync(new URL('./catalog.json', import.meta.url), JSON.stringify(catalog, null, 1) + '\n');
console.log('wrote catalog.json:', items.map((i) => i.name).join(', '));
