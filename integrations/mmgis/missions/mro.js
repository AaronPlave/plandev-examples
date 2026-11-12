// MRO (examples/05-orbiter) adapter: what the ScheduleTargetObservations goal takes, and what the
// orbiter's simulated resources and activities mean on a map of Mars.
'use strict'
const { anchor, extremaOver, greatCircleKm, pathGeometry, valueAt } = require('../lib/util')

const NAME_PREFIX = 'TargetObs ' // must match ScheduleTargetObservations.NAME_PREFIX
const RADIUS_KM = 3389.5 // Mars mean radius
const TRACK_CONTEXT_SEC = 15 * 60
const OBS = 'TakeRadarObservation'
const R = {
    lat: 'subSCBodies_MARS_latitude', // deg, planetocentric, IAU_MARS
    lon: 'subSCBodies_MARS_longitude', // deg, east-positive [-180, 180)
    soc: 'cbebattery.batterySOC', // %
    volume: 'onboard.volume', // bits
}

module.exports = {
    key: 'mro',
    label: 'MRO radar targets (Mars)',
    help: 'Goal ScheduleTargetObservations: for each target, find the closest MRO sub-spacecraft pass in the plan window and schedule a TakeRadarObservation there. Not a footprint-coverage check.',
    conventions: {
        body: 'MARS',
        frame: 'IAU_MARS body-fixed',
        coordinates: 'planetocentric latitude, east-positive longitude, degrees',
        time: 'UTC',
    },
    targets: { types: ['Point', 'Polygon'], max: 20, ordered: false },
    params: [
        { key: 'maxGroundDistanceKm', label: 'Max ground distance', unit: 'km', type: 'number', min: 1, max: 2000, default: 100 },
        { key: 'observationDurationSec', label: 'Observation duration', unit: 's', type: 'number', min: 10, max: 3600, default: 300 },
        { key: 'mode', label: 'Radar mode', type: 'enum', options: ['LOW_RES', 'MED_RES', 'HI_RES'], default: 'HI_RES' },
    ],

    // The scheduling goals that take the map's inputs (setup-plandev.js uploads them by these names).
    goals: [
        {
            name: 'ScheduleTargetObservations',
            arguments: (targets, p) => ({
                targets: JSON.stringify(targets),
                maxGroundDistanceKm: p.maxGroundDistanceKm,
                observationDuration: Math.round(p.observationDurationSec * 1e6), // microseconds
                mode: p.mode,
            }),
        },
    ],

    inputsFromGoalArguments({ ScheduleTargetObservations: args }) {
        if (!args) return null
        return {
            targets: args.targets ? JSON.parse(args.targets) : { type: 'FeatureCollection', features: [] },
            params: { maxGroundDistanceKm: args.maxGroundDistanceKm, observationDurationSec: args.observationDuration / 1e6, mode: args.mode },
        }
    },

    async interpret({ ops, plan, dataset, goalArgs: byName, startMs, iso }) {
        const goalArgs = byName?.ScheduleTargetObservations ?? null
        const targets = goalArgs ? this.inputsFromGoalArguments(byName).targets.features : []
        const [spans, directives, pr] = await Promise.all([
            ops.spans(dataset.dataset_id, [OBS]),
            ops.directives(plan.id, [OBS]),
            ops.profiles(dataset.dataset_id, [R.lat, R.lon, R.soc]),
        ])
        // The goal names each directive it creates after its target; that is the only link it leaves.
        const targetOf = new Map(directives.filter((d) => d.name.startsWith(NAME_PREFIX)).map((d) => [d.id, d.name.slice(NAME_PREFIX.length)]))
        const ms = (sec) => startMs + sec * 1000

        // Ground-track samples exactly as simulated (one per lat segment, i.e. the model's 30 s sampling).
        const samples = pr[R.lat]
            .map((s) => [s.t, valueAt(pr[R.lon], s.t), valueAt(pr[R.lat], s.t)])
            .filter(([, lo, la]) => typeof lo === 'number' && typeof la === 'number')
        const between = (a, b) => samples.filter(([t]) => t >= a && t <= b)

        const features = targets.map((f) => ({
            type: 'Feature',
            properties: {
                kind: 'target',
                basis: 'input',
                targetId: f.id,
                name: f.properties?.name ?? f.id,
                scheduled: [...targetOf.values()].includes(f.id),
                source: f.properties?.source ?? null,
            },
            geometry: f.geometry,
        }))
        const rows = []
        const binVolumes = await ops.profiles(dataset.dataset_id, [...new Set(spans.map((s) => `scBin${s.arguments.bin ?? 0}.volume`))])

        for (const s of spans) {
            const targetId = targetOf.get(s.directiveId) ?? null
            const target = targets.find((f) => f.id === targetId)
            const common = { spanId: s.spanId, directiveId: s.directiveId, activityType: OBS, start: iso(s.startSec), end: iso(s.endSec), startMs: ms(s.startSec), endMs: ms(s.endSec), mode: s.arguments.mode, targetId }
            const obsPts = between(s.startSec, s.endSec)
            // Draw order (later = on top): context track, association, then the observation itself.
            const ctxGeom = pathGeometry(between(s.startSec - TRACK_CONTEXT_SEC, s.endSec + TRACK_CONTEXT_SEC).map(([, lo, la]) => [lo, la]))
            if (ctxGeom) features.push({ type: 'Feature', properties: { kind: 'track-context', basis: 'simulated', context: true, name: `±15 min ground track`, ...common }, geometry: ctxGeom })
            let closest = null
            if (target) {
                const [tlon, tlat] = anchor(target.geometry)
                for (const [t, lo, la] of obsPts) {
                    const km = greatCircleKm(tlat, tlon, la, lo, RADIUS_KM)
                    if (!closest || km < closest.km) closest = { km, lo, la, t }
                }
                if (closest)
                    features.push({
                        type: 'Feature',
                        properties: { kind: 'association', basis: 'analysis', ...common, distanceKm: +closest.km.toFixed(1), name: `${target.properties?.name ?? targetId} ↔ closest sample` },
                        geometry: { type: 'LineString', coordinates: [[tlon, tlat], [closest.lo, closest.la]] },
                    })
            }
            const obsGeom = pathGeometry(obsPts.map(([, lo, la]) => [lo, la]))
            if (obsGeom) features.push({ type: 'Feature', properties: { kind: 'observation', basis: 'simulated', primary: true, name: `${OBS} ${s.spanId}${target ? ` · ${target.properties?.name}` : ''}`, ...common }, geometry: obsGeom })

            const vol = binVolumes[`scBin${s.arguments.bin ?? 0}.volume`]
            rows.push({
                spanId: s.spanId,
                directiveId: s.directiveId,
                targetId,
                target: target?.properties?.name ?? '—',
                start: iso(s.startSec),
                minDistKm: closest ? closest.km : null,
                socEnd: valueAt(pr[R.soc], s.endSec),
                dataGbit: ((valueAt(vol, s.endSec) ?? NaN) - (valueAt(vol, s.startSec) ?? NaN)) / 1e9,
            })
        }

        const scheduledIds = new Set(targetOf.values())
        const notes = targets
            .filter((f) => !scheduledIds.has(f.id))
            .map((f) => ({ warn: true, text: `No pass within ${goalArgs.maxGroundDistanceKm} km of “${f.properties?.name ?? f.id}” — not scheduled.` }))
        notes.push({ text: 'Min dist: closest 30 s sample of the simulated sub-spacecraft track (subSCBodies_MARS_*) during the observation, not footprint coverage.' })

        return {
            features,
            position: {
                label: 'MRO sub-spacecraft point',
                samples: samples.map(([t, lo, la]) => [ms(t), +lo.toFixed(4), +la.toFixed(4)]),
                hold: 'sample', // shown at the latest simulated sample at or before the time cursor
                note: 'Simulated 30 s samples of subSCBodies_MARS_*; the map shows the latest sample at or before the cursor, not an interpolated position.',
                trackWindowMs: 45 * 60_000,
            },
            table: {
                columns: [
                    { key: 'target', label: 'Target' },
                    { key: 'start', label: 'Start (UTC)', type: 'time' },
                    { key: 'minDistKm', label: 'Min dist', unit: 'km', digits: 1 },
                    { key: 'socEnd', label: 'SOC end', unit: '%', digits: 1 },
                    { key: 'dataGbit', label: 'Data', unit: 'Gbit', digits: 2 },
                ],
                rows,
            },
            notes,
        }
    },

    async metrics({ ops, dataset, durationSec }) {
        const pr = await ops.profiles(dataset.dataset_id, [R.soc, R.volume])
        const obs = await ops.spans(dataset.dataset_id, [OBS])
        return [
            { key: 'minSOC', name: 'Min battery SOC', value: extremaOver(pr[R.soc], 0, durationSec).min, unit: '%', digits: 1 },
            { key: 'finalVolume', name: 'Final onboard data', value: (valueAt(pr[R.volume], durationSec) ?? NaN) / 1e9, unit: 'Gbit', digits: 2 },
            { key: 'observations', name: 'Radar observations', value: obs.length, unit: '', digits: 0 },
        ]
    },
}
