// node --test integrations/mmgis/test/*.test.js
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const w = require('../lib/util')
const mro = require('../missions/mro')
const hopper = require('../missions/hopper')

test('intervalToSec parses Postgres interval text', () => {
    assert.equal(w.intervalToSec('144:00:00'), 518400)
    assert.equal(w.intervalToSec('16:03:49.482'), 57829.482)
    assert.equal(w.intervalToSec('1 day 02:00:00'), 93600)
    assert.equal(w.intervalToSec('2 days'), 172800)
    assert.equal(w.intervalToSec('-00:00:01'), -1)
    assert.throws(() => w.intervalToSec('PT1H'))
})

test('secToInterval round-trips', () => {
    for (const s of [0, 1.5, 57829.482, 518400, -1]) assert.equal(w.intervalToSec(w.secToInterval(s)), s)
})

test('valueAt evaluates real and discrete segments', () => {
    const real = [
        { t: 0, dynamics: { initial: 100, rate: 0 } },
        { t: 10, dynamics: { initial: 100, rate: -0.5 } },
        { t: 20, dynamics: { initial: 95, rate: 0 } },
    ]
    assert.equal(w.valueAt(real, 15), 97.5)
    assert.equal(w.valueAt(real, 25), 95)
    assert.equal(w.valueAt(real, -1), null)
    assert.equal(w.valueAt([{ t: 0, dynamics: 'HI_RES' }], 5), 'HI_RES')
    assert.equal(w.valueAt([{ t: 0, dynamics: 3, is_gap: true }], 5), null)
})

test('extremaOver finds the dip inside a linear segment endpoint', () => {
    const real = [
        { t: 0, dynamics: { initial: 100, rate: 0 } },
        { t: 10, dynamics: { initial: 100, rate: -1 } }, // falls to 90 at t=20
        { t: 20, dynamics: { initial: 90, rate: 1 } }, // recovers to 100 at t=30
        { t: 30, dynamics: { initial: 100, rate: 0 } },
    ]
    const { min, max } = w.extremaOver(real, 0, 40)
    assert.ok(Math.abs(min - 90) < 1e-5)
    assert.equal(max, 100)
})

test('splitAtAntimeridian breaks a wrapping track', () => {
    const parts = w.splitAtAntimeridian([
        [178, 0],
        [179, 1],
        [-179, 2],
        [-178, 3],
    ])
    assert.deepEqual(parts, [
        [
            [178, 0],
            [179, 1],
        ],
        [
            [-179, 2],
            [-178, 3],
        ],
    ])
})

test('greatCircleKm on the Mars mean sphere', () => {
    assert.ok(Math.abs(w.greatCircleKm(0, 0, 0, 1, 3389.5) - 59.157) < 0.01)
})

test('normalizeTargets validates at the trust boundary', () => {
    const ok = w.normalizeTargets({
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', id: 'draw-7-1', properties: { name: 'Jezero' }, geometry: { type: 'Point', coordinates: [77.4, 18.4] } },
            {
                type: 'Feature',
                id: 'a b/c',
                properties: {},
                geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
            },
        ],
    })
    assert.equal(ok.features[0].id, 'draw-7-1')
    assert.equal(ok.features[1].id, 'a_b_c')
    assert.throws(() => w.normalizeTargets({ type: 'FeatureCollection', features: [] }), /non-empty/)
    assert.throws(
        () => w.normalizeTargets({ type: 'FeatureCollection', features: [{ geometry: { type: 'LineString', coordinates: [] } }] }),
        /Point or Polygon/,
    )
    assert.throws(
        () => w.normalizeTargets({ type: 'FeatureCollection', features: [{ geometry: { type: 'Point', coordinates: [0, 95] } }] }),
        /bad coordinates/,
    )
    const dup = { type: 'Feature', id: 'x', geometry: { type: 'Point', coordinates: [0, 0] } }
    assert.throws(() => w.normalizeTargets({ type: 'FeatureCollection', features: [dup, dup] }), /duplicate/)
})

test('normalizeTargets honours a mission\'s geometry types and preserves order', () => {
    const fc = (geoms) => ({ type: 'FeatureCollection', features: geoms.map((g, i) => ({ id: `s${i}`, geometry: g })) })
    const pts = w.normalizeTargets(fc([{ type: 'Point', coordinates: [1, 1] }, { type: 'Point', coordinates: [0, 0] }]), hopper.targets)
    assert.deepEqual(pts.features.map((f) => f.id), ['s0', 's1'])
    assert.throws(() => w.normalizeTargets(fc([{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }]), hopper.targets), /only Point/)
})

test('checkParams validates against the adapter spec and fills defaults', () => {
    assert.deepEqual(w.checkParams(hopper.params, { order: 'NEAREST_NEXT' }), { order: 'NEAREST_NEXT', restAfterHopMin: 30, pictureDurationSec: 120, startAfterMin: 60 })
    assert.throws(() => w.checkParams(hopper.params, { order: 'RANDOM' }), /order must be one of/)
    assert.throws(() => w.checkParams(mro.params, { maxGroundDistanceKm: 0 }), /maxGroundDistanceKm/)
})

test('adapters round-trip goal arguments (durations in microseconds)', () => {
    const fc = { type: 'FeatureCollection', features: [] }
    for (const [a, p] of [
        [mro, { maxGroundDistanceKm: 100, observationDurationSec: 300, mode: 'HI_RES' }],
        [hopper, { order: 'AS_DRAWN', restAfterHopMin: 30, pictureDurationSec: 120, startAfterMin: 60 }],
    ]) {
        const args = a.goalArguments(fc, p)
        assert.deepEqual(a.inputsFromGoalArguments(args), { targets: fc, params: p })
    }
    assert.equal(mro.goalArguments(fc, { maxGroundDistanceKm: 1, observationDurationSec: 300, mode: 'HI_RES' }).observationDuration, 300e6)
    assert.equal(hopper.goalArguments(fc, { order: 'AS_DRAWN', restAfterHopMin: 30, pictureDurationSec: 1, startAfterMin: 0 }).restAfterHop, 1800e6)
})
