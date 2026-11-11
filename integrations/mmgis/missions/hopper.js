// Lunar hopper (examples/04-hopper) adapter: what the ScheduleHopTraverse goal takes, and what the
// hopper's simulated location, power and data resources mean on a map of the Moon.
'use strict'
const { extremaOver, greatCircleKm, pointInRing, segmentHitsRing, valueAt } = require('../lib/util')

const R = {
    lat: 'hopper.latitude', // deg, planetocentric
    lon: 'hopper.longitude', // deg, east-positive
    odo: 'hopper.odometerKm',
    soc: 'mainbattery.batterySOC', // %
    volume: 'onboard.volume', // bits
    maxVolume: 'onboard.maxVolume', // bits
    received: 'onboard.receivedVolume', // bits written to storage
    removed: 'onboard.removedVolume', // bits played back by Downlink passes
}
const RADIUS_KM = 1737.4 // must match hopper.HopModel.MOON_RADIUS_KM

/** Where the hopper sat, from the simulated location: [{t, tEnd, lon, lat}], one per landing (plus the start). */
function stays(pr, durationSec) {
    const out = []
    for (const s of pr[R.lat]) {
        const lon = valueAt(pr[R.lon], s.t)
        const lat = valueAt(pr[R.lat], s.t)
        if (typeof lon !== 'number' || typeof lat !== 'number') continue
        const prev = out.at(-1)
        if (prev && prev.lon === lon && prev.lat === lat) continue
        if (prev) prev.tEnd = s.t
        out.push({ t: s.t, tEnd: durationSec, lon, lat })
    }
    return out
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
                properties: { kind: 'hop', basis: 'illustrative', primary: true, name: `Leg ${leg}: → ${name(to)}`, leg, siteId: to, distanceKm: +km.toFixed(3), durationSec: s.endSec - s.startSec, ...common(s) },
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
                properties: { kind: 'picture', basis: 'simulated', primary: true, name: `Image ${name(s.arguments.siteId || '?')}`, siteId: s.arguments.siteId || null, ...common(s) },
                geometry: { type: 'Point', coordinates: [lon, lat] },
            })
        }
        const start = at(0)
        if (typeof start[0] === 'number')
            features.unshift({ type: 'Feature', properties: { kind: 'start', basis: 'simulated', name: 'Location at plan start (simulated)' }, geometry: { type: 'Point', coordinates: start } })
        for (const f of sites)
            features.unshift({
                type: 'Feature',
                properties: { kind: 'target', basis: 'input', targetId: f.id, name: f.properties?.name ?? f.id, scheduled: visited.has(f.id), leg: visited.get(f.id) ?? null, source: f.properties?.source ?? null },
                geometry: f.geometry,
            })

        const notes = sites.filter((f) => !visited.has(f.id)).map((f) => ({ warn: true, text: `“${f.properties?.name ?? f.id}” not visited — the traverse would run past the plan end.` }))
        notes.push({ text: 'Dashed hop legs are assumed straight paths between the simulated take-off and landing locations (solid points); the in-flight path, terrain and illumination are not modeled.' })
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
        const pr = await ops.profiles(dataset.dataset_id, [R.odo, R.soc, R.volume, R.maxVolume, R.received, R.removed])
        const [hops, pictures] = await Promise.all([ops.spans(dataset.dataset_id, ['PerformHop']), ops.spans(dataset.dataset_id, ['TakePicture'])])
        const acts = [...hops, ...pictures]
        const span = acts.length ? (Math.max(...acts.map((s) => s.endSec)) - Math.min(...acts.map((s) => s.startSec))) / 3600 : 0
        return [
            { key: 'distance', name: 'Distance hopped', value: valueAt(pr[R.odo], durationSec) ?? 0, unit: 'km', digits: 2 },
            { key: 'traverseHours', name: 'Traverse duration', value: span, unit: 'h', digits: 2 },
            { key: 'hops', name: 'Hops', value: hops.length, unit: '', digits: 0 },
            { key: 'pictures', name: 'Images', value: pictures.length, unit: '', digits: 0 },
            { key: 'minSOC', name: 'Min battery SOC', value: extremaOver(pr[R.soc], 0, durationSec).min, unit: '%', digits: 1 },
            { key: 'peakStorage', name: 'Peak onboard storage', value: (100 * extremaOver(pr[R.volume], 0, durationSec).max) / (valueAt(pr[R.maxVolume], 0) || NaN), unit: '% full', digits: 0 },
            { key: 'generated', name: 'Data written to storage', value: (valueAt(pr[R.received], durationSec) ?? NaN) / 1e9, unit: 'Gbit', digits: 2 },
            // ground.volume in the data library counts the full playback rate even with nothing onboard; use what left storage.
            { key: 'downlinked', name: 'Data downlinked by plan end', value: (valueAt(pr[R.removed], durationSec) ?? NaN) / 1e9, unit: 'Gbit', digits: 2 },
            { key: 'data', name: 'Data still onboard at plan end', value: (valueAt(pr[R.volume], durationSec) ?? NaN) / 1e9, unit: 'Gbit', digits: 2 },
        ]
    },

    // ---------- read-only evaluation of an existing plan ----------

    evaluation: {
        help: 'Read-only: checks Draw features against this plan’s simulated landings. Points: did the hopper land within the radius, and image there? Polygons: landings inside, and hop legs that cross (assuming straight legs). Nothing is scheduled.',
        targets: { types: ['Point', 'Polygon'], max: 20, ordered: false },
        params: [{ key: 'radiusKm', label: 'Visited if a landing is within', unit: 'km', type: 'number', min: 0.01, max: 50, default: 1 }],
    },

    async evaluate({ ops, dataset, durationSec, iso }, fc, { radiusKm }) {
        const pr = await ops.profiles(dataset.dataset_id, [R.lat, R.lon])
        const [hops, pictures] = await Promise.all([ops.spans(dataset.dataset_id, ['PerformHop']), ops.spans(dataset.dataset_id, ['TakePicture'])])
        const at = stays(pr, durationSec)
        const imagedDuring = (st) => pictures.filter((p) => p.startSec >= st.t && p.startSec < st.tEnd)
        const legs = hops.filter((h) => h.arguments.toSiteId).map((h) => {
            const from = at.findLast((st) => st.t < h.endSec) // where it took off: the last stay before landing
            const to = at.find((st) => st.t >= h.endSec)
            return { h, from, to }
        }).filter((l) => l.from && l.to)

        const features = []
        const rows = []
        for (const f of fc.features) {
            const name = f.properties.name
            if (f.geometry.type === 'Point') {
                const [lon, lat] = f.geometry.coordinates
                let best = null
                for (const st of at) {
                    const km = greatCircleKm(lat, lon, st.lat, st.lon, RADIUS_KM)
                    if (!best || km < best.km) best = { km, st }
                }
                const visited = best && best.km <= radiusKm
                const imgs = visited ? imagedDuring(best.st) : []
                rows.push({ name, kind: 'site', result: visited ? (imgs.length ? 'visited, imaged' : 'visited, not imaged') : 'not visited', distanceKm: best?.km ?? null, when: visited ? iso(best.st.t) : null, images: imgs.length })
                features.push({ type: 'Feature', properties: { kind: 'eval-site', basis: 'input', name: `${name}: ${rows.at(-1).result}`, visited: !!visited, images: imgs.length }, geometry: f.geometry })
                if (best)
                    features.push({
                        type: 'Feature',
                        properties: { kind: 'eval-nearest', basis: 'analysis', name: `${name} ↔ nearest simulated landing (${best.km.toFixed(2)} km)`, distanceKm: +best.km.toFixed(3), startMs: null },
                        geometry: { type: 'LineString', coordinates: [[lon, lat], [best.st.lon, best.st.lat]] },
                    })
            } else {
                const ring = f.geometry.coordinates[0]
                const inside = at.filter((st) => pointInRing([st.lon, st.lat], ring))
                const crossing = legs.filter((l) => segmentHitsRing([l.from.lon, l.from.lat], [l.to.lon, l.to.lat], ring))
                const result = inside.length ? `${inside.length} landing(s) inside` : crossing.length ? `${crossing.length} leg(s) cross (assumed straight)` : 'clear'
                rows.push({ name, kind: 'region', result, distanceKm: null, when: inside[0] ? iso(inside[0].t) : crossing[0] ? iso(crossing[0].h.startSec) : null, images: inside.reduce((n, st) => n + imagedDuring(st).length, 0) })
                features.push({ type: 'Feature', properties: { kind: 'eval-region', basis: 'input', name: `${name}: ${result}`, landingsInside: inside.length, legsCrossing: crossing.length }, geometry: f.geometry })
                for (const l of crossing)
                    features.push({
                        type: 'Feature',
                        properties: { kind: 'eval-crossing', basis: 'analysis', name: `${l.h.arguments.toSiteId} leg crosses ${name}`, spanId: l.h.spanId, directiveId: l.h.directiveId },
                        geometry: { type: 'LineString', coordinates: [[l.from.lon, l.from.lat], [l.to.lon, l.to.lat]] },
                    })
            }
        }
        const sites = rows.filter((r) => r.kind === 'site')
        return {
            features,
            table: {
                columns: [
                    { key: 'name', label: 'Feature' },
                    { key: 'result', label: 'Result' },
                    { key: 'distanceKm', label: 'Nearest', unit: 'km', digits: 2 },
                    { key: 'when', label: 'When (UTC)', type: 'time' },
                    { key: 'images', label: 'Images', digits: 0 },
                ],
                rows,
            },
            summary: sites.length ? [{ key: 'visited', name: 'Sites visited', value: sites.filter((r) => r.result !== 'not visited').length, unit: `of ${sites.length}`, digits: 0 }] : [],
            notes: [
                { text: `Landings are the simulated hopper.latitude/longitude; “visited” = a landing within ${radiusKm} km (great circle). Images are TakePicture spans that start while the hopper sits there.` },
                ...(rows.some((r) => r.kind === 'region') ? [{ text: 'Region crossings assume straight legs in lon/lat between simulated landings — the flight path is not modeled.' }] : []),
            ],
        }
    },
}
