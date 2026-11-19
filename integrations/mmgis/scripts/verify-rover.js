#!/usr/bin/env node
// End-to-end check of the rover demonstration against the live PlanDev stack: for each plan, do the
// scheduled activities, the simulated resources, PlanDev's constraint results and the map adapter's
// derived metrics tell the same story? Prints the policy table and exits 1 on any inconsistency.
//
//   node scripts/verify-rover.js [--run] <planId> ...     (env: PLANDEV_* as for the MMGIS backend)
//
// --run first re-runs each plan's own scheduling specification and simulates it (the plan's goal
// output is replaced; nothing else is written).
'use strict'
const { clientFromEnv } = require('../lib/plandev')
const { createCandidates } = require('../lib/candidates')
const { valueAt, intervalsWhere, greatCircleKm } = require('../lib/util')
const rover = require('../missions/rover')

const RADIUS_KM = 3396.19
const EPS = 1 // s: tolerance between a constraint window and the resource intervals it comes from

async function verify(cands, planId) {
    const v = await cands.view(planId, null, 'rover')
    const startMs = Date.parse(v.plan.startTime)
    const ds = v.simulation.dataset_id
    const dur = v.plan.durationSec
    const ops = { spans: (t) => cands_ops.spans(ds, t) }
    const pr = await cands_ops.profiles(ds, ['rover.latitude', 'rover.longitude', 'rover.driveStatus', 'rover.driveWindowOpen', 'rover.sunElevationDeg', 'rover.driveMinSunElevationDeg', 'mainbattery.batterySOC'])
    const P = (n) => pr[n]
    const acts = await ops.spans(['Drive', 'Observe', 'Wait'])
    const policy = v.inputs?.params.driveWindow ?? '?'
    const minSun = valueAt(P('rover.driveMinSunElevationDeg'), 0)
    const problems = []
    const fail = (msg) => problems.push(msg)
    const h = (sec) => `${(sec / 3600).toFixed(2)} h`
    const sun = (t) => valueAt(P('rover.sunElevationDeg'), t)
    const open = (t) => valueAt(P('rover.driveWindowOpen'), t)
    const soc = (t) => valueAt(P('mainbattery.batterySOC'), t)
    const pos = (t) => [valueAt(P('rover.longitude'), t), valueAt(P('rover.latitude'), t)]
    const closedDuring = (a, b) => intervalsWhere([[P('rover.driveWindowOpen'), (x) => x === false]], a, b).reduce((n, [x, y]) => n + y - x, 0)

    console.log(`\n== #${planId} ${v.plan.name} — driveWindow ${policy}, dataset ${v.simulation.id} (rev ${v.simulation.plan_revision}/${v.plan.revision})`)
    if (v.stale) fail('the latest simulation is of an older plan revision')
    if (!v.inputsCurrent) fail('the goal inputs are not known to have produced this simulation')

    // Activities in time order, with what the resources say at their edges.
    let prev = null
    for (const a of acts) {
        const line = [`${a.type.padEnd(7)} ${h(a.startSec).padStart(8)} → ${h(a.endSec).padStart(8)}`]
        line.push(`sun ${sun(a.startSec).toFixed(1)}°→${sun(a.endSec - 1e-3).toFixed(1)}°`, `window ${open(a.startSec) ? 'open' : 'shut'}→${open(a.endSec - 1e-3) ? 'open' : 'shut'}`, `SOC ${soc(a.startSec).toFixed(1)}→${soc(a.endSec).toFixed(1)} %`)
        if (a.type === 'Drive') {
            const shut = closedDuring(a.startSec, a.endSec)
            line.push(`to ${a.arguments.toSiteId}`, shut ? `${h(shut)} with the window shut` : 'all inside the window')
            if (policy === 'DAYLIGHT' && shut > EPS) fail(`Drive to ${a.arguments.toSiteId} at ${h(a.startSec)} runs ${h(shut)} with the drive window shut`)
            // A drive continuing after a wait (split drive) starts where the rover stopped.
            const wp = a.arguments.waypoints
            const [lon, lat] = pos(a.startSec)
            if (greatCircleKm(lat, lon, wp[0][1], wp[0][0], RADIUS_KM) > 0.01) fail(`Drive at ${h(a.startSec)} starts ${greatCircleKm(lat, lon, wp[0][1], wp[0][0], RADIUS_KM).toFixed(2)} km from its first waypoint`)
            const [elon, elat] = pos(a.endSec)
            const last = wp.at(-1)
            if (greatCircleKm(elat, elon, last[1], last[0], RADIUS_KM) > 0.01) fail(`Drive at ${h(a.startSec)} ends short of its last waypoint`)
            if (prev?.type === 'Wait' && prev.arguments.reason?.startsWith('night') && !open(a.startSec)) fail(`Drive after a night wait starts with the window shut at ${h(a.startSec)}`)
        } else if (a.type === 'Wait') {
            line.push(`"${a.arguments.reason}"`)
            if (a.arguments.reason?.startsWith('night') && policy === 'DAYLIGHT') {
                // A night wait spans the closed window, and ends when it is open again.
                if (!closedDuring(a.startSec, a.endSec)) fail(`night Wait at ${h(a.startSec)} never sees the window shut`)
                if (!open(a.endSec)) fail(`night Wait at ${h(a.startSec)} ends with the window still shut`)
            }
        } else {
            const [lon, lat] = pos(a.startSec)
            const off = greatCircleKm(lat, lon, a.arguments.siteLatitude, a.arguments.siteLongitude, RADIUS_KM)
            line.push(`${a.arguments.siteId} (P${a.arguments.priority})`, off <= 0.1 ? 'on site' : `${off.toFixed(2)} km off site`)
        }
        console.log('  ' + line.join('  '))
        prev = a
    }

    // DriveDaylight's windows are exactly the intervals driving with the window shut.
    const dark = intervalsWhere([[P('rover.driveStatus'), (x) => x === 'DRIVING'], [P('rover.driveWindowOpen'), (x) => x === false]], 0, dur)
    const dd = v.constraints.find((c) => c.name.startsWith('DriveDaylight'))
    if (!dd) fail('no DriveDaylight constraint result')
    else {
        const w = dd.windows.map((x) => [(x.startMs - startMs) / 1000, (x.endMs - startMs) / 1000])
        const same = w.length === dark.length && w.every(([a, b], i) => Math.abs(a - dark[i][0]) <= EPS && Math.abs(b - dark[i][1]) <= EPS)
        if (!same) fail(`DriveDaylight windows ${JSON.stringify(w.map((x) => x.map(h)))} differ from driving-with-window-shut ${JSON.stringify(dark.map((x) => x.map(h)))}`)
        for (const [a, b] of dark) if (sun(a) >= minSun || open(a)) fail(`dark interval at ${h(a)} has the Sun at ${sun(a).toFixed(1)}°`)
    }
    // The map's violation features are the same windows.
    const ddFeatures = v.features.filter((f) => f.properties.kind === 'violation' && f.properties.constraint?.startsWith('DriveDaylight'))
    if (dd && ddFeatures.length !== dd.windows.length) fail(`${dd.windows.length} DriveDaylight windows but ${ddFeatures.length} located on the map`)

    // The adapter's metrics against the raw records.
    const m = Object.fromEntries(v.summary.map((x) => [x.key, x.value]))
    const darkH = dark.reduce((n, [a, b]) => n + b - a, 0) / 3600
    if (Math.abs(m.darkDrive - darkH) > 1e-6) fail(`map metric darkDrive ${m.darkDrive} ≠ ${darkH}`)
    const observes = acts.filter((a) => a.type === 'Observe')
    const onSite = observes.filter((a) => { const [lon, lat] = pos(a.startSec); return greatCircleKm(lat, lon, a.arguments.siteLatitude, a.arguments.siteLongitude, RADIUS_KM) <= 0.1 })
    if (m.sites !== onSite.length) fail(`map metric sites ${m.sites} ≠ ${onSite.length} on-site observations`)
    const sitesOut = v.features.filter((f) => f.properties.kind === 'site')
    const observedOut = sitesOut.filter((f) => f.properties.outcome.state === 'observed')
    if (observedOut.length !== onSite.length) fail(`${observedOut.length} sites drawn as observed, ${onSite.length} observed on site`)
    const requested = sitesOut.filter((f) => f.properties.outcome.state !== 'unknown')
    const minSoc = Math.min(...P('mainbattery.batterySOC').map((s, i, all) => Math.min(valueAt(all, s.t), valueAt(all, (all[i + 1]?.t ?? dur) - 1e-6))))
    if (Math.abs(m.minSOC - minSoc) > 0.01) fail(`map metric minSOC ${m.minSOC} ≠ ${minSoc}`)
    const lowSoc = v.constraints.find((c) => c.name.startsWith('MinBatterySOC'))

    const row = {
        plan: `#${planId}`,
        policy,
        sites: `${onSite.length} of ${requested.length} (P${m.value})`,
        finishH: +m.finish.toFixed(1),
        darkDriveH: +darkH.toFixed(1),
        darkWindows: dd?.windows.length,
        minSOC: +minSoc.toFixed(1),
        socWindows: lowSoc?.windows.length,
        waitH: +m.waitH.toFixed(1),
        driveKWh: +m.energy.toFixed(2),
        km: +m.distance.toFixed(1),
        drives: acts.filter((a) => a.type === 'Drive').length,
        waits: acts.filter((a) => a.type === 'Wait').length,
        socAfterObserve: observes.map((a) => `${a.arguments.siteId} ${soc(a.endSec).toFixed(0)}`).join(', '),
    }
    for (const p of problems) console.log('  ✗ ' + p)
    if (!problems.length) console.log('  ✓ activities, resources, constraint windows and map metrics agree')
    return { row, problems }
}

let cands_ops
;(async () => {
    const run = process.argv.includes('--run')
    const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number)
    if (!ids.length) throw new Error('usage: verify-rover.js [--run] <planId> ...')
    const pd = clientFromEnv()
    const cands = createCandidates(pd, [{ adapter: rover, basePlanId: ids[0] }])
    // The generic layer's cached reads, for the raw checks.
    cands_ops = await opsOf(pd)
    if (run) await Promise.all(ids.map((id) => cands.scheduleAndSimulate(id).then(() => console.log(`#${id}: scheduled and simulated`))))
    const results = []
    for (const id of ids) results.push(await verify(cands, id))
    console.log()
    console.table(results.map((r) => r.row))
    process.exit(results.some((r) => r.problems.length) ? 1 : 0)
})().catch((e) => {
    console.error(e)
    process.exit(2)
})

/** Minimal raw reads (the same queries the generic layer makes). */
async function opsOf(pd) {
    const { intervalToSec } = require('../lib/util')
    return {
        async profiles(ds, names) {
            const d = await pd.gql(`query($ds:Int!,$n:[String!]!){ profile(where:{dataset_id:{_eq:$ds}, name:{_in:$n}}){ name profile_segments(order_by:{start_offset:asc}){ start_offset dynamics } } }`, { ds, n: names })
            return Object.fromEntries(names.map((n) => [n, (d.profile.find((p) => p.name === n)?.profile_segments ?? []).map((s) => ({ t: intervalToSec(s.start_offset), dynamics: s.dynamics }))]))
        },
        async spans(ds, types) {
            const d = await pd.gql(`query($ds:Int!,$t:[String!]!){ span(where:{dataset_id:{_eq:$ds}, type:{_in:$t}}, order_by:{start_offset:asc}){ type start_offset duration attributes } }`, { ds, t: types })
            return d.span.map((s) => ({ type: s.type, startSec: intervalToSec(s.start_offset), endSec: intervalToSec(s.start_offset) + intervalToSec(s.duration), arguments: s.attributes.arguments }))
        },
    }
}
