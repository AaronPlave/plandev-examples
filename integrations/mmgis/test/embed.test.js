// The embedded map's user-visible rules: positions outside a simulation's time are not "current", a
// run started from the map finishes even while PlanDev shows an older simulation, drawn regions are
// valid before they are sent, and site outcomes come from what the simulation shows.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { positionAt, runStep, regionProblem, ringSelfIntersects } = require('../lib/util')
const { siteOutcome } = require('../missions/rover')

test('positionAt: no position outside the time a simulation covers', () => {
    const mro = { samples: [[1000, 10, 20], [2000, 11, 21]], coverage: { startMs: 1000, endMs: 3000 } }
    assert.deepEqual(positionAt(mro, 1500), { sample: [1000, 10, 20] })
    assert.deepEqual(positionAt(mro, 2500), { sample: [2000, 11, 21] }) // held until the simulation ends
    assert.equal(positionAt(mro, 5000).outside, 'after') // e.g. a rover plan years later: not frozen at the last sample
    assert.equal(positionAt(mro, 500).outside, 'before')
    assert.equal(positionAt(mro, null).outside, 'no-time')
    // Without a declared coverage, the samples bound it.
    assert.equal(positionAt({ samples: [[1000, 0, 0]] }, 1001).outside, 'after')
})

test('runStep: a run finishes on the newest dataset even while PlanDev shows an older one', () => {
    let run = { planId: 7, fromDs: 100 }
    const row = (o) => ({ id: 7, running: false, phase: null, error: null, latest: { simulationDatasetId: 100, status: 'success' }, ...o })
    let r = runStep(run, row({ running: true, phase: 'scheduling' }), 100)
    assert.equal(r.phase, 'scheduling')
    r = runStep(r.run, row({ running: true, phase: 'simulating', latest: { simulationDatasetId: 101, status: 'success' } }), 100)
    assert.equal(r.phase, 'simulating') // the scheduler's own intermediate dataset does not count while running
    r = runStep(r.run, row({ latest: { simulationDatasetId: 102, status: 'success' } }), 100)
    assert.equal(r.phase, 'complete')
    assert.equal(r.show, 102) // ask PlanDev to show it
    assert.ok(r.run) // until PlanDev does
    r = runStep(r.run, row({ latest: { simulationDatasetId: 102, status: 'success' } }), 102)
    assert.equal(r.run, null) // done: no lingering "running"
    assert.equal(r.show, null)
})

test('runStep: the user’s own pick of a simulation is not overridden', () => {
    const r = runStep({ planId: 7, fromDs: 100, userPicked: true }, { running: false, latest: { simulationDatasetId: 102, status: 'success' } }, 99)
    assert.equal(r.phase, 'complete')
    assert.equal(r.show, null)
    assert.equal(r.run, null)
})

test('runStep: failures end the run', () => {
    assert.equal(runStep({ fromDs: 1 }, { running: false, error: 'scheduling failed: x' }, 1).phase, 'failed')
    assert.equal(runStep({ fromDs: 1 }, { running: false, latest: { simulationDatasetId: 2, status: 'failed' } }, 1).phase, 'failed')
    // Not running and nothing new for several polls (e.g. the server restarted mid-run).
    let r = { run: { fromDs: 1 } }
    for (let i = 0; i < 4; i++) r = runStep(r.run, { running: false, latest: { simulationDatasetId: 1, status: 'success' } }, 1)
    assert.equal(r.phase, 'failed')
    assert.equal(r.run, null)
})

test('regions: obviously invalid rings are refused', () => {
    assert.equal(regionProblem([[0, 0], [1, 0]]), 'needs at least 3 corners')
    assert.equal(regionProblem([[0, 0], [1, 0], [1, 1], [0, 1]]), null)
    assert.equal(ringSelfIntersects([[0, 0], [1, 1], [1, 0], [0, 1]]), true) // a bow tie
    assert.equal(regionProblem([[0, 0], [1, 1], [1, 0], [0, 1]]), 'its edges cross')
    assert.equal(ringSelfIntersects([[0, 0], [2, 0], [2, 2], [1, 0.5], [0, 2]]), false) // concave is fine
})

test('site outcomes distinguish requested, scheduled, reached and observed', () => {
    const base = { requested: true, scheduled: true, simulated: true, reached: true, observed: true }
    assert.equal(siteOutcome(base).state, 'observed')
    assert.equal(siteOutcome({ ...base, observed: false }).state, 'reached')
    assert.equal(siteOutcome({ ...base, observed: false, reached: false, driveStopped: 'stopped early' }).reason, 'stopped early')
    assert.equal(siteOutcome({ ...base, observed: false, reached: false }).state, 'missed')
    assert.equal(siteOutcome({ ...base, simulated: false, reached: null, observed: null }).state, 'planned')
    assert.equal(siteOutcome({ ...base, scheduled: false }).state, 'unscheduled')
    assert.equal(siteOutcome({ ...base, requested: null, scheduled: false }).state, 'unknown')
})

test('a compared feature is matched to the open plan only by site or destination id', () => {
    const { counterpart } = require('../lib/util')
    const F = (kind, props) => ({ properties: { kind, ...props } })
    const open = { features: [F('site', { targetId: 'rim', outcome: { state: 'observed' } }), F('route', { toSiteId: 'rim' }), F('drive', { toSiteId: 'rim', primary: true }), F('observation', { siteId: 'rim' })] }
    assert.strictEqual(counterpart(F('site', { targetId: 'rim' }), open), open.features[0])
    assert.strictEqual(counterpart(F('drive', { toSiteId: 'rim' }), open), open.features[2]) // the simulated drive, not the planned band
    assert.strictEqual(counterpart(F('route', { toSiteId: 'rim' }), open), open.features[1])
    assert.strictEqual(counterpart(F('site', { targetId: 'delta' }), open), null) // a site the open plan lacks: "not in that plan"
    assert.strictEqual(counterpart(F('violation', {}), open), undefined) // nothing to match a violation window by: no claim either way
    assert.strictEqual(counterpart(F('wait', { name: 'Wait: night' }), open), undefined)
})

test('a comparison with a plan follows its re-runs; a pinned earlier simulation stays', () => {
    const { comparisonOutdated } = require('../lib/util')
    const view = { provenance: { simulationDatasetId: 10 } }
    const plans = [{ id: 7, latest: { simulationDatasetId: 12, status: 'success' } }]
    assert.strictEqual(comparisonOutdated({ planId: 7, ds: null, view }, plans), true)
    assert.strictEqual(comparisonOutdated({ planId: 7, ds: 10, view }, plans), false) // pinned
    assert.strictEqual(comparisonOutdated({ planId: 7, ds: null, view }, [{ id: 7, latest: { simulationDatasetId: 12, status: 'incomplete' } }]), false) // not ready yet
    assert.strictEqual(comparisonOutdated({ planId: 7, ds: null, view: { provenance: { simulationDatasetId: 12 } } }, plans), false)
})
