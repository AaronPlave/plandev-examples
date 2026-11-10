// Lunar hopper (examples/04-hopper) adapter: what the ScheduleHopTraverse goal takes, and what the
// hopper's simulated location, power and data resources mean on a map of the Moon.
'use strict'
const { extremaOver, valueAt } = require('../lib/util')

const R = {
    lat: 'hopper.latitude', // deg, planetocentric
    lon: 'hopper.longitude', // deg, east-positive
    odo: 'hopper.odometerKm',
    soc: 'mainbattery.batterySOC', // %
    volume: 'onboard.volume', // bits
    maxVolume: 'onboard.maxVolume', // bits
}
const MIN = 60e6 // microseconds per minute

module.exports = {
    key: 'hopper',
    label: 'Lunar hopper traverse (Moon)',
    help: 'Goal ScheduleHopTraverse: hop to each site in turn and image it. Hop duration = 60 s + distance at 50 m/s — an illustrative model shared by the goal and the simulation, not a vehicle design.',
    conventions: {
        body: 'MOON',
        frame: 'Moon body-fixed',
        coordinates: 'planetocentric latitude, east-positive longitude, degrees',
        time: 'UTC',
    },
    targets: { types: ['Point'], max: 12, ordered: true },
    params: [
        { key: 'order', label: 'Visit order', type: 'enum', options: ['AS_DRAWN', 'NEAREST_NEXT'], default: 'AS_DRAWN' },
        { key: 'restAfterHopMin', label: 'Rest after each hop', unit: 'min', type: 'number', min: 0, max: 600, default: 30 },
        { key: 'pictureDurationSec', label: 'Imaging per site', unit: 's', type: 'number', min: 10, max: 1800, default: 120 },
        { key: 'startAfterMin', label: 'Start after plan start', unit: 'min', type: 'number', min: 0, max: 1440, default: 60 },
    ],

    goalArguments(sites, p) {
        return {
            sites: JSON.stringify(sites),
            order: p.order,
            restAfterHop: Math.round(p.restAfterHopMin * MIN),
            pictureDuration: Math.round(p.pictureDurationSec * 1e6),
            startAfter: Math.round(p.startAfterMin * MIN),
        }
    },

    inputsFromGoalArguments(args) {
        return {
            targets: args.sites ? JSON.parse(args.sites) : { type: 'FeatureCollection', features: [] },
            params: { order: args.order, restAfterHopMin: args.restAfterHop / MIN, pictureDurationSec: args.pictureDuration / 1e6, startAfterMin: args.startAfter / MIN },
        }
    },

    async interpret({ ops, dataset, goalArgs, startMs, iso }) {
        const sites = goalArgs ? this.inputsFromGoalArguments(goalArgs).targets.features : []
        const [hops, pictures, pr] = await Promise.all([
            ops.spans(dataset.dataset_id, ['PerformHop']),
            ops.spans(dataset.dataset_id, ['TakePicture']),
            ops.profiles(dataset.dataset_id, [R.lat, R.lon, R.odo, R.soc]),
        ])
        const ms = (sec) => startMs + sec * 1000
        // Location just before / at a time: the model changes it only when a hop lands.
        const at = (sec) => [valueAt(pr[R.lon], sec), valueAt(pr[R.lat], sec)]
        const before = (sec) => at(sec - 1e-6)
        const name = (id) => sites.find((f) => f.id === id)?.properties?.name ?? id
        const common = (s) => ({ spanId: s.spanId, directiveId: s.directiveId, activityType: s.type, start: iso(s.startSec), end: iso(s.endSec), startMs: ms(s.startSec), endMs: ms(s.endSec) })

        const visited = new Map() // siteId → leg number, from the simulated hops' arguments
        const features = []
        const rows = []
        let leg = 0
        for (const s of hops) {
            const to = s.arguments.toSiteId
            if (!to) continue // hop in place: no location change
            leg++
            visited.set(to, leg)
            const from = before(s.startSec)
            const landed = at(s.endSec)
            const km = (valueAt(pr[R.odo], s.endSec) ?? 0) - (valueAt(pr[R.odo], s.startSec - 1e-6) ?? 0)
            features.push({
                type: 'Feature',
                properties: { kind: 'hop', primary: true, name: `Leg ${leg}: → ${name(to)}`, leg, siteId: to, distanceKm: +km.toFixed(3), durationSec: s.endSec - s.startSec, ...common(s) },
                // Straight segment between simulated take-off and landing locations; the flight path itself is not modeled.
                geometry: { type: 'LineString', coordinates: [from, landed] },
            })
            rows.push({
                spanId: s.spanId,
                directiveId: s.directiveId,
                leg,
                to: name(to),
                start: iso(s.startSec),
                distanceKm: km,
                durationSec: s.endSec - s.startSec,
                socAfter: valueAt(pr[R.soc], s.endSec),
            })
        }
        for (const s of pictures) {
            const [lon, lat] = at(s.startSec)
            features.push({
                type: 'Feature',
                properties: { kind: 'picture', primary: true, name: `Image ${name(s.arguments.siteId || '?')}`, siteId: s.arguments.siteId || null, ...common(s) },
                geometry: { type: 'Point', coordinates: [lon, lat] },
            })
        }
        const start = at(0)
        if (typeof start[0] === 'number')
            features.unshift({ type: 'Feature', properties: { kind: 'start', name: 'Location at plan start (simulated)' }, geometry: { type: 'Point', coordinates: start } })
        for (const f of sites)
            features.unshift({
                type: 'Feature',
                properties: { kind: 'target', targetId: f.id, name: f.properties?.name ?? f.id, scheduled: visited.has(f.id), leg: visited.get(f.id) ?? null, source: f.properties?.source ?? null },
                geometry: f.geometry,
            })

        const notes = sites.filter((f) => !visited.has(f.id)).map((f) => ({ warn: true, text: `“${f.properties?.name ?? f.id}” not visited — the traverse would run past the plan end.` }))
        notes.push({ text: 'Hop legs join the simulated take-off and landing locations; the in-flight path, terrain and illumination are not modeled.' })
        return {
            features,
            position: {
                label: 'Hopper location',
                samples: pr[R.lat].map((s) => [ms(s.t), valueAt(pr[R.lon], s.t), valueAt(pr[R.lat], s.t)]).filter(([, lo, la]) => typeof lo === 'number' && typeof la === 'number'),
                hold: 'step', // the simulated location is piecewise constant: it changes when a hop lands
                note: 'Simulated hopper.latitude/longitude: changes when a hop lands; position during a hop is not modeled.',
                trackWindowMs: null, // show the whole itinerary
            },
            table: {
                columns: [
                    { key: 'leg', label: 'Leg', digits: 0 },
                    { key: 'to', label: 'To' },
                    { key: 'start', label: 'Start (UTC)', type: 'time' },
                    { key: 'distanceKm', label: 'Dist', unit: 'km', digits: 2 },
                    { key: 'durationSec', label: 'Hop', unit: 's', digits: 0 },
                    { key: 'socAfter', label: 'SOC after', unit: '%', digits: 1 },
                ],
                rows,
            },
            notes,
        }
    },

    async metrics({ ops, dataset, durationSec }) {
        const pr = await ops.profiles(dataset.dataset_id, [R.odo, R.soc, R.volume, R.maxVolume])
        const [hops, pictures] = await Promise.all([ops.spans(dataset.dataset_id, ['PerformHop']), ops.spans(dataset.dataset_id, ['TakePicture'])])
        const acts = [...hops, ...pictures]
        const span = acts.length ? (Math.max(...acts.map((s) => s.endSec)) - Math.min(...acts.map((s) => s.startSec))) / 3600 : 0
        return [
            { key: 'distance', name: 'Distance hopped', value: valueAt(pr[R.odo], durationSec) ?? 0, unit: 'km', digits: 2 },
            { key: 'traverseHours', name: 'Traverse duration', value: span, unit: 'h', digits: 2 },
            { key: 'hops', name: 'Hops', value: hops.length, unit: '', digits: 0 },
            { key: 'pictures', name: 'Images', value: pictures.length, unit: '', digits: 0 },
            { key: 'minSOC', name: 'Min battery SOC', value: extremaOver(pr[R.soc], 0, durationSec).min, unit: '%', digits: 1 },
            { key: 'data', name: 'Data onboard at end', value: (valueAt(pr[R.volume], durationSec) ?? NaN) / 1e9, unit: 'Gbit', digits: 2 },
            { key: 'capacity', name: 'Onboard storage capacity', value: (valueAt(pr[R.maxVolume], durationSec) ?? NaN) / 1e9, unit: 'Gbit', digits: 2 },
        ]
    },
}
