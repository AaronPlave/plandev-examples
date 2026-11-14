// MRO (examples/05-orbiter) adapter: what the ScheduleTargetObservations goal takes, and what the
// orbiter's simulated resources and activities mean on a map of Mars.
'use strict'
const { anchor, extremaOver, greatCircleKm, pathGeometry, pointInRing, valueAt } = require('../lib/util')

const NAME_PREFIX = 'TargetObs ' // must match ScheduleTargetObservations.NAME_PREFIX
const RADIUS_KM = 3389.5 // Mars mean radius
const TRACK_CONTEXT_SEC = 15 * 60
const OBS = 'TakeRadarObservation'
const R = {
    lat: 'subSCBodies_MARS_latitude', // deg, planetocentric, IAU_MARS
    lon: 'subSCBodies_MARS_longitude', // deg, east-positive [-180, 180)
    soc: 'cbebattery.batterySOC', // %
    volume: 'onboard.volume', // bits
    altitude: 'SpacecraftAltitude_MARS', // km
}
// Illustrative, not an instrument model: the ground swath is the simulated sub-spacecraft track widened by
// this much on each side, and "in view" means at least this far above a spherical horizon.
const SWATH_HALF_WIDTH_KM = 15
const MIN_ELEVATION_DEG = 10

/** The track [[lon, lat], ...] widened to a polygon ring, `halfKm` to each side (flat about each point). */
function swathRing(track, halfKm) {
    const rad = Math.PI / 180
    const d = halfKm / RADIUS_KM / rad // degrees of arc
    const left = []
    const right = []
    track.forEach(([lon, lat], i) => {
        const [a, b] = [track[Math.max(0, i - 1)], track[Math.min(track.length - 1, i + 1)]]
        const cos = Math.cos(lat * rad)
        const dx = (b[0] - a[0]) * cos
        const dy = b[1] - a[1]
        const n = Math.hypot(dx, dy) || 1
        // unit normal to the direction of travel
        const [nx, ny] = [-dy / n, dx / n]
        left.push([lon + (nx * d) / cos, lat + ny * d])
        right.push([lon - (nx * d) / cos, lat - ny * d])
    })
    return [...left, ...right.reverse(), left[0]]
}

/** Fraction of a polygon's area inside a ring, by sampling a 30 x 30 grid over the polygon's bounds. */
function coveredFraction(target, ring) {
    const xs = target.map((p) => p[0])
    const ys = target.map((p) => p[1])
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    let inside = 0
    let covered = 0
    for (let i = 0; i < 30; i++)
        for (let j = 0; j < 30; j++) {
            const p = [x0 + ((i + 0.5) / 30) * (x1 - x0), y0 + ((j + 0.5) / 30) * (y1 - y0)]
            if (!pointInRing(p, target)) continue
            inside++
            if (pointInRing(p, ring)) covered++
        }
    return inside ? covered / inside : null
}

/** Angular radius (deg of arc) of the region from which a spacecraft at `altKm` is at least `elevDeg` above a spherical horizon. */
function visibilityCapDeg(altKm, elevDeg) {
    const e = (elevDeg * Math.PI) / 180
    return ((Math.acos((RADIUS_KM / (RADIUS_KM + altKm)) * Math.cos(e)) - e) * 180) / Math.PI
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
            ops.profiles(dataset.dataset_id, [R.lat, R.lon, R.soc, R.altitude]),
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

            // An area result: the swath this observation would sweep, and how much of a polygon target lies in it.
            let coveredPct = null
            const track = obsPts.map(([, lo, la]) => [lo, la])
            if (track.length > 1 && track.every((p, i) => i === 0 || Math.abs(p[0] - track[i - 1][0]) < 180)) {
                const ring = swathRing(track, SWATH_HALF_WIDTH_KM)
                if (target?.geometry.type === 'Polygon') coveredPct = 100 * coveredFraction(target.geometry.coordinates[0], ring)
                features.push({
                    type: 'Feature',
                    properties: {
                        kind: 'swath', basis: 'illustrative', name: `Swath of ${OBS} ${s.spanId} (assumed ±${SWATH_HALF_WIDTH_KM} km)`, ...common,
                        details: [['Swath', `simulated track ±${SWATH_HALF_WIDTH_KM} km (assumed width)`], ...(coveredPct != null ? [['Target area inside', `${coveredPct.toFixed(0)} %`]] : [])],
                    },
                    geometry: { type: 'Polygon', coordinates: [ring] },
                })
            }

            const vol = binVolumes[`scBin${s.arguments.bin ?? 0}.volume`]
            rows.push({
                spanId: s.spanId,
                directiveId: s.directiveId,
                targetId,
                target: target?.properties?.name ?? '—',
                start: iso(s.startSec),
                minDistKm: closest ? closest.km : null,
                coveredPct,
                socEnd: valueAt(pr[R.soc], s.endSec),
                dataGbit: ((valueAt(vol, s.endSec) ?? NaN) - (valueAt(vol, s.startSec) ?? NaN)) / 1e9,
            })
        }

        const scheduledIds = new Set(targetOf.values())
        const notes = targets
            .filter((f) => !scheduledIds.has(f.id))
            .map((f) => ({ warn: true, text: `No pass within ${goalArgs.maxGroundDistanceKm} km of “${f.properties?.name ?? f.id}” — not scheduled.` }))
        notes.push({ text: `Dashed polygons are swaths of an assumed ±${SWATH_HALF_WIDTH_KM} km about the simulated track, not an instrument footprint.` })
        notes.push({ text: 'Min dist: closest 30 s sample of the simulated sub-spacecraft track (subSCBodies_MARS_*) during the observation, not footprint coverage.' })

        return {
            features,
            position: {
                label: 'MRO sub-spacecraft point',
                // The 4th value is a region that moves with the spacecraft: the angular radius of the ground area
                // from which it is in view, from the simulated altitude at the same sample.
                samples: samples.map(([t, lo, la]) => {
                    const alt = valueAt(pr[R.altitude], t)
                    return [ms(t), +lo.toFixed(4), +la.toFixed(4), ...(typeof alt === 'number' ? [+visibilityCapDeg(alt, MIN_ELEVATION_DEG).toFixed(2)] : [])]
                }),
                hold: 'sample', // shown at the latest simulated sample at or before the time cursor
                note: `Simulated 30 s samples of subSCBodies_MARS_*; the map shows the latest sample at or before the cursor, not an interpolated position. Dashed circle: where MRO is at least ${MIN_ELEVATION_DEG}° above a spherical horizon, from the simulated altitude (no terrain).`,
                trackWindowMs: 45 * 60_000,
            },
            table: {
                columns: [
                    { key: 'target', label: 'Target' },
                    { key: 'start', label: 'Start (UTC)', type: 'time' },
                    { key: 'minDistKm', label: 'Min dist', unit: 'km', digits: 1 },
                    { key: 'coveredPct', label: 'In swath', unit: '%', digits: 0 },
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
