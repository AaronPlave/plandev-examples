// node --test integrations/cosmolabe/test/*.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { targets, vehicle } from '../missions/mro/adapter.js';
import { fileFor } from '../serve.mjs';

const proposal = (over = {}) => ({
  body: 'Mars', frame: 'IAU_MARS', id: 'cosmo-1', name: 'Mars 18.54°, 77.40°', latDeg: 18.536771, lonDeg: 77.396246,
  window: { start: '2024-01-02T08:37:30.000Z', end: '2024-01-02T09:07:30.000Z' },
  source: { app: 'cosmolabe', location: 'probe', window: 'viewer-time', planId: 86, simulationDatasetId: 217 },
  ...over,
});

test('stage adds one Point target the goal reads: GeoJSON [lon, lat], window, provenance, strict rejection', () => {
  const args = targets.stage({ mode: 'HI_RES' }, proposal());
  assert.equal(args.mode, 'HI_RES');
  assert.equal(args.rejectUnscheduled, true);
  const [f] = JSON.parse(args.targets).features;
  assert.deepEqual(f.geometry, { type: 'Point', coordinates: [77.39625, 18.53677] });
  assert.equal(f.id, 'cosmo-1');
  assert.deepEqual(f.properties.window, proposal().window);
  assert.equal(f.properties.source.app, 'cosmolabe');
  assert.deepEqual(targets.read(args).map((t) => [t.id, t.latDeg, t.lonDeg]), [['cosmo-1', 18.53677, 77.39625]]);
});

test('stage keeps targets already there (e.g. drawn in MMGIS) and remove takes out only one', () => {
  const mmgis = { targets: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'draw-7-1', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] }) };
  const args = targets.stage(mmgis, proposal());
  assert.equal(JSON.parse(args.targets).features.length, 2);
  assert.deepEqual(targets.read(args).map((t) => t.id), ['cosmo-1']); // only Points are drawn back
  assert.deepEqual(JSON.parse(targets.remove(args, 'cosmo-1').targets).features.map((f) => f.id), ['draw-7-1']);
});

test('check: only Mars, valid coordinates, a non-empty window', () => {
  assert.deepEqual(targets.check(proposal()), []);
  assert.match(targets.check(proposal({ body: 'Moon' }))[0], /on Mars/);
  assert.equal(targets.check(proposal({ latDeg: 91 })).length, 1);
  assert.equal(targets.check(proposal({ window: { start: '2024-01-02T09:00:00Z', end: '2024-01-02T09:00:00Z' } })).length, 1);
  assert.throws(() => targets.stage({ targets: JSON.stringify({ type: 'FeatureCollection', features: Array(20).fill({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } }) }) }, proposal()), /at most 20/);
});

test('created activities map back to targets by the goal’s directive name', () => {
  assert.equal(vehicle, 'MRO');
  assert.equal(targets.targetOf(targets.directiveName('cosmo-1')), 'cosmo-1');
  assert.equal(targets.targetOf('Periapsis_MARS'), null);
  // The prefix must match the goal's NAME_PREFIX.
  const goal = readFileSync(new URL('../../../examples/05-orbiter/scheduling/src/main/java/scheduling/procedures/ScheduleTargetObservations.java', import.meta.url), 'utf8');
  assert.match(goal, /NAME_PREFIX = "TargetObs "/);
  assert.match(goal, new RegExp(`MARS_MEAN_RADIUS_KM = ${targets.meanRadiusKm};`));
  assert.equal(targets.directiveName('x'), 'TargetObs x');
});

test('the scene loads a PCK its N0066 CSPICE reads correctly, and the same kernels the model loads otherwise', () => {
  const catalog = JSON.parse(readFileSync(new URL('../missions/mro/catalog.json', import.meta.url), 'utf8'));
  const kernels = catalog.spiceKernels.map((k) => (typeof k === 'string' ? k : k.url).split('/').pop());
  // pck00011.tpc's Mars model needs CSPICE N0067; Cosmolabe's cspice-wasm is N0066 (Mars pole 2.2° off).
  assert.ok(kernels.includes('pck00011_n0066.tpc') && !kernels.includes('pck00011.tpc'));
  // …and it must stay out of spice-kernels/: the model furnishes every .tpc there, and it would override pck00011.
  assert.ok(!existsSync(new URL('../../../spice-kernels/pck00011_n0066.tpc', import.meta.url)));
  assert.ok(existsSync(new URL('../missions/mro/pck00011_n0066.tpc', import.meta.url)));
  const meta = readFileSync(new URL('../../../spice-kernels/latest_meta_kernel.tm', import.meta.url), 'utf8');
  for (const k of kernels.filter((k) => k !== 'pck00011_n0066.tpc')) assert.ok(meta.includes(k), k);
});

test('the server serves only inside its roots', () => {
  assert.match(fileFor('/missions/mro/catalog.json'), /missions\/mro\/catalog\.json$/);
  assert.match(fileFor('/kernels/mro_psp.bsp'), /spice-kernels\/mro_psp\.bsp$/);
  assert.equal(fileFor('/missions/../serve.mjs'), null);
  assert.equal(fileFor('/kernels/%2e%2e/README.md'), null);
  assert.equal(fileFor('/etc/passwd'), null);
});
