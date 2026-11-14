// The rover adapter against a small hand-made simulation: planned, simulated and input geometry stay
// apart, a drive that stops short is reported, and the metrics come from the simulated resources.
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const rover = require('../missions/rover')
const { integrateStep, normalizeTargets, pointToSegmentKm } = require('../lib/util')

const seg = (t, dynamics) => ({ t, dynamics, is_gap: false })
const WP = [[77.45, 18.44], [77.44, 18.44], [77.43, 18.44], [77.42, 18.44]]
// The rover reaches the second waypoint at 1000 s, the third at 2500 s, then halts: the fourth is never reached.
const PROFILES = {
    'rover.longitude': [seg(0, 77.45), seg(1000, 77.44), seg(2500, 77.43)],
    'rover.latitude': [seg(0, 18.44)],
    'rover.odometerKm': [seg(0, 0), seg(1000, 0.56), seg(2500, 1.12)],
    'rover.slopeDeg': [seg(0, 0), seg(100, 4), seg(1000, 12), seg(2500, 0)],
    'rover.driveStatus': [seg(0, 'IDLE'), seg(100, 'DRIVING'), seg(2500, 'HALTED_LOW_BATTERY')],
    'rover.terrainDataset': [seg(0, 'some-other-grid@000000000000')],
    'mainbattery.batterySOC': [seg(0, { initial: 100, rate: 0 }), seg(100, { initial: 100, rate: -0.0375 }), seg(2500, { initial: 10, rate: 0 })],
    '/pel/driveLoad': [seg(0, 0), seg(100, 220), seg(1000, 460), seg(2500, 0)],
    'onboard.receivedVolume': [seg(0, { initial: 0, rate: 0 }), seg(3000, { initial: 0, rate: 5e5 })],
    'onboard.volume': [seg(0, { initial: 0, rate: 0 })],
    'onboard.maxVolume': [seg(0, { initial: 8e9, rate: 0 })],
}
const DRIVE = { toSiteId: 'a', waypoints: WP, terrain: 'jezero-ctx-slope-200m-v1@4c627ad56e5c', objective: 'MIN_ENERGY' }
const OBSERVE = { siteId: 'a', siteName: 'Site A', siteLatitude: 18.44, siteLongitude: 77.42, priority: 3 }
const SPANS = [
    { spanId: 1, directiveId: 11, type: 'Drive', startSec: 100, endSec: 2500, arguments: DRIVE },
    { spanId: 2, directiveId: 12, type: 'Observe', startSec: 3000, endSec: 4800, arguments: OBSERVE },
]
const ops = {
    profiles: async (ds, names) => Object.fromEntries(names.map((n) => [n, PROFILES[n] || []])),
    spans: async (ds, types) => SPANS.filter((s) => types.includes(s.type)),
    directives: async (planId, types) => SPANS.filter((s) => types.includes(s.type)).map((s) => ({ id: s.directiveId, type: s.type, startSec: s.startSec, arguments: s.arguments })),
}
const ctx = { ops, plan: { id: 1 }, dataset: { dataset_id: 9 }, goalArgs: null, startMs: 0, durationSec: 6000, iso: (s) => new Date(s * 1000).toISOString() }
const kinds = (v, basis) => v.features.filter((f) => f.properties.basis === basis).map((f) => f.properties.kind)

test('planned route, simulated track and inputs are separate features', async () => {
    const v = await rover.interpret(ctx)
    const planned = v.features.find((f) => f.properties.kind === 'route')
    const driven = v.features.find((f) => f.properties.kind === 'drive')
    assert.deepStrictEqual(planned.geometry.coordinates, WP) // the Drive's own waypoints
    assert.deepStrictEqual(driven.geometry.coordinates, WP.slice(0, 3)) // only where the model put the rover
    assert.strictEqual(planned.properties.basis, 'planned')
    assert.strictEqual(driven.properties.basis, 'simulated')
    assert.strictEqual(driven.properties.spanId, 1)
    assert.ok(kinds(v, 'input').includes('site'))
    assert.deepStrictEqual(v.position.samples.map((s) => s[1]), [77.45, 77.44, 77.43])
})

test('a simulation that leaves the plan is reported, not hidden', async () => {
    const v = await rover.interpret(ctx)
    const warnings = v.notes.filter((n) => n.warn).map((n) => n.text).join('\n')
    assert.match(warnings, /stopped early/)
    assert.match(warnings, /Site A was observed 0\.\d+ km from the site/)
    assert.match(warnings, /Terrain mismatch/) // simulated on a grid this map does not have
    const site = v.features.find((f) => f.properties.kind === 'site' && f.properties.targetId === 'a')
    assert.strictEqual(site.properties.observed, false)
    assert.strictEqual(v.overlays[0].usedByPlan, true)
    assert.strictEqual(v.overlays[0].usedBySimulation, false)
})

test('a plan with no simulation still shows its planned route', async () => {
    const v = await rover.interpret({ ...ctx, dataset: null })
    assert.deepStrictEqual(kinds(v, 'planned'), ['route'])
    assert.deepStrictEqual(kinds(v, 'simulated'), [])
    assert.strictEqual(v.position, null)
})

test('metrics come from the simulated resources', async () => {
    const m = Object.fromEntries((await rover.metrics(ctx)).map((x) => [x.key, x.value]))
    assert.strictEqual(m.sites, 0) // observed, but not at the site
    assert.ok(Math.abs(m.energy - (220 * 900 + 460 * 1500) / 3.6e6) < 1e-9)
    assert.ok(Math.abs(m.minSOC - 10) < 1e-3)
    assert.ok(m.steepKm > 0.5 && m.steepKm < 0.6) // only the 12 degree leg
    assert.strictEqual(m.maxSlope, 12)
})

test('read-only questions: closest approach and distance inside a region', async () => {
    const fc = normalizeTargets({
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', id: 'p', properties: { name: 'North' }, geometry: { type: 'Point', coordinates: [77.44, 18.45] } },
            { type: 'Feature', id: 'r', properties: { name: 'Box' }, geometry: { type: 'Polygon', coordinates: [[[77.425, 18.43], [77.435, 18.43], [77.435, 18.45], [77.425, 18.45], [77.425, 18.43]]] } },
        ],
    })
    const r = await rover.evaluate(ctx, fc, { radiusKm: 0.2 })
    assert.match(r.table.rows[0].result, /not reached: closest approach 0\.59 km/)
    assert.match(r.table.rows[1].result, /entered: 0\.6 km driven inside, 0\.6 km of it over 10°/)
})

test('goal arguments round-trip, sites and avoided regions by geometry type', () => {
    const fc = normalizeTargets(
        {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', id: 's', properties: { name: 'S', priority: 3, junk: 'x' }, geometry: { type: 'Point', coordinates: [77.4, 18.4] } },
                { type: 'Feature', id: 'r', properties: { name: 'R' }, geometry: { type: 'Polygon', coordinates: [[[77, 18], [77.1, 18], [77.1, 18.1], [77, 18]]] } },
            ],
        },
        rover.targets,
    )
    assert.strictEqual(fc.features[0].properties.priority, 3)
    assert.strictEqual(fc.features[0].properties.junk, undefined)
    const args = rover.goals[0].arguments(fc, { objective: 'MIN_TIME', maxSlopeDeg: 15, minSOC: 40, observeDurationMin: 20, startAfterMin: 30 })
    assert.strictEqual(JSON.parse(args.sites).features.length, 1)
    assert.strictEqual(JSON.parse(args.avoid).features[0].id, 'r')
    const back = rover.inputsFromGoalArguments({ ScheduleTraverse: args })
    assert.deepStrictEqual(back.params, { objective: 'MIN_TIME', maxSlopeDeg: 15, minSOC: 40, observeDurationMin: 20, startAfterMin: 30 })
    assert.strictEqual(back.targets.features.length, 2)
    // Blank sites: the goal used the mission's own catalog.
    assert.ok(rover.inputsFromGoalArguments({ ScheduleTraverse: { objective: 'MIN_ENERGY' } }).targets.features.length >= 6)
})

test('the terrain the map draws is the grid the model ships', async () => {
    const t = await rover.data.terrain()
    assert.strictEqual(t.values.length, t.ncols * t.nrows)
    assert.match(t.id, /^jezero-ctx-slope-200m-v1@[0-9a-f]{12}$/)
})

test('helpers', () => {
    assert.strictEqual(integrateStep([seg(0, 2), seg(10, 4)], 5, 20), 2 * 5 + 4 * 10)
    assert.ok(Math.abs(pointToSegmentKm([0, 0.01], [-1, 0], [1, 0], 3396.19) - 0.5927) < 1e-3)
})
