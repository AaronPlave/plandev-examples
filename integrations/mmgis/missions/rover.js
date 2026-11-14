// Mars rover (examples/11-rover) adapter: what the ScheduleTraverse goal takes, and what the rover's
// Drive/Observe activities and simulated location, power and data resources mean on a map of Jezero.
//
// Three kinds of geometry are kept apart:
//   planned   — the route the goal chose: the waypoints in each Drive activity's arguments;
//   simulated — where the model put the rover: rover.latitude/longitude, which change on arrival at
//               each waypoint (the simulation can stop short of the planned route);
//   input     — sites and avoided regions given to the goal, and the mission's site catalog.
'use strict'
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { extremaOver, greatCircleKm, integrateStep, pointInRing, pointToSegmentKm, valueAt } = require('../lib/util')

const R = {
    lat: 'rover.latitude', // deg, planetocentric
    lon: 'rover.longitude', // deg, east-positive
    odo: 'rover.odometerKm',
    slope: 'rover.slopeDeg', // terrain slope of the leg being driven
    status: 'rover.driveStatus',
    terrain: 'rover.terrainDataset', // the terrain grid the simulation drove on
    soc: 'mainbattery.batterySOC', // %
    driveLoad: '/pel/driveLoad', // W
    volume: 'onboard.volume', // bits
    maxVolume: 'onboard.maxVolume',
    received: 'onboard.receivedVolume',
}
const RADIUS_KM = 3396.19 // must match rover.DriveModel.MARS_RADIUS_KM
const STEEP_DEG = 10 // "steep terrain" in the metrics; a reporting threshold, not a model limit
const ON_SITE_KM = 0.1
const MIN = 60e6 // microseconds per minute
const GOAL = 'ScheduleTraverse'
const DEFAULTS = { objective: 'MIN_ENERGY', maxSlopeDeg: 20, minSOC: 30, observeDurationMin: 30, startAfterMin: 60 } // ScheduleTraverse.Defaults

// The mission's data products, read from the mission package itself: the same files the model jar ships.
const DATA_DIR = process.env.PLANDEV_ROVER_DATA_DIR || path.resolve(__dirname, '../../../examples/11-rover/src/main/resources/rover')
const TERRAIN = 'jezero-ctx-slope-200m-v1' // rover.Terrain.DATASET
let terrainCache = null
function terrain() {
    if (!terrainCache) {
        const bytes = fs.readFileSync(path.join(DATA_DIR, 'terrain', `${TERRAIN}.asc`))
        const lines = bytes.toString('ascii').split(/\r?\n/)
        const h = Object.fromEntries(lines.slice(0, 6).map((l) => l.trim().split(/\s+/)).map(([k, v]) => [k.toLowerCase(), Number(v)]))
        terrainCache = {
            // Same identity the model computes (rover.Terrain): dataset name @ first 12 hex digits of the file's SHA-256.
            id: `${TERRAIN}@${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`,
            name: 'Terrain slope',
            unit: 'deg',
            source: 'Mean slope in 200 m cells of the USGS Mars 2020 TRN CTX DTM of Jezero crater (20 m/px). Measured terrain; the rover’s response to slope is illustrative.',
            ncols: h.ncols,
            nrows: h.nrows,
            west: h.xllcorner,
            south: h.yllcorner,
            cellDeg: h.cellsize,
            nodata: h.nodata_value,
            // Row 0 is the northernmost row.
            values: lines.slice(6, 6 + h.nrows).flatMap((l) => l.trim().split(/\s+/).map(Number)),
            stops: [[0, '#1a9850'], [5, '#fee08b'], [10, '#fc8d59'], [15, '#d73027'], [20, '#7f0000']],
        }
    }
    return terrainCache
}
const catalog = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sites.geojson'), 'utf8'))

const hm = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${String(Math.round((sec % 3600) / 60)).padStart(2, '0')} min` : `${Math.round(sec / 60)} min`)

/** The simulated track: one entry per arrival at a waypoint, with the leg just driven. [{t, lon, lat, km, slope}] */
function track(pr) {
    const times = [...new Set([...pr[R.lat], ...pr[R.lon]].map((s) => s.t))].sort((a, b) => a - b)
    const out = []
    for (const t of times) {
        const lon = valueAt(pr[R.lon], t)
        const lat = valueAt(pr[R.lat], t)
        const prev = out.at(-1)
        if (typeof lon !== 'number' || typeof lat !== 'number' || (prev && prev.lon === lon && prev.lat === lat)) continue
        out.push({ t, lon, lat, km: prev ? greatCircleKm(prev.lat, prev.lon, lat, lon, RADIUS_KM) : 0, slope: prev ? valueAt(pr[R.slope], t - 1e-3) ?? 0 : 0 })
    }
    return out
}

/** Lowest value of a real profile and when: linear segments have their extremes at their ends. */
function lowest(segments, durationSec) {
    let best = null
    segments.forEach((s, i) => {
        for (const t of [s.t, (segments[i + 1]?.t ?? durationSec) - 1e-6]) {
            const v = valueAt(segments, t)
            if (typeof v === 'number' && (!best || v < best.value)) best = { value: v, t }
        }
    })
    return best
}

module.exports = {
    key: 'rover',
    label: 'Rover traverse (Jezero crater, Mars)',
    help: 'Goal ScheduleTraverse routes the rover between science sites over the mission’s terrain slope grid, choosing the visiting order that collects the most site priority before the plan ends, and stops to recharge to keep the battery above the reserve. Drive speed and energy as a function of slope are illustrative, and shared with the simulation.',
    conventions: {
        body: 'MARS',
        frame: 'IAU_MARS body-fixed',
        coordinates: 'planetocentric latitude, east-positive longitude, degrees',
        time: 'UTC',
    },
    // Points are sites (with a priority); polygons are regions the route must avoid.
    targets: { types: ['Point', 'Polygon'], max: 12, ordered: false, keep: ['priority'], roles: { Point: 'Science site', Polygon: 'Region to avoid' }, priority: { min: 1, max: 3, default: 2 } },
    params: [
        { key: 'objective', label: 'Each route minimizes', type: 'enum', options: ['MIN_ENERGY', 'MIN_TIME', 'MIN_DISTANCE'], default: DEFAULTS.objective },
        { key: 'maxSlopeDeg', label: 'Steepest drivable slope', unit: 'deg', type: 'number', min: 5, max: 35, default: DEFAULTS.maxSlopeDeg },
        { key: 'minSOC', label: 'Battery reserve', unit: '%', type: 'number', min: 10, max: 90, default: DEFAULTS.minSOC },
        { key: 'observeDurationMin', label: 'Observation per site', unit: 'min', type: 'number', min: 5, max: 240, default: DEFAULTS.observeDurationMin },
        { key: 'startAfterMin', label: 'Start after plan start', unit: 'min', type: 'number', min: 0, max: 1440, default: DEFAULTS.startAfterMin },
    ],
    // The adapter reads a plan's planned route from its directives, so a plan needs no simulation to be drawn.
    interpretsPlanOnly: true,

    goals: [
        {
            name: GOAL,
            arguments: (fc, p) => {
                const of = (type) => ({ type: 'FeatureCollection', features: fc.features.filter((f) => f.geometry.type === type) })
                const avoid = of('Polygon')
                return {
                    sites: JSON.stringify(of('Point')),
                    avoid: avoid.features.length ? JSON.stringify(avoid) : '',
                    objective: p.objective,
                    maxSlopeDeg: p.maxSlopeDeg,
                    minSOC: p.minSOC,
                    observeDuration: Math.round(p.observeDurationMin * MIN),
                    startAfter: Math.round(p.startAfterMin * MIN),
                }
            },
        },
    ],

    inputsFromGoalArguments({ [GOAL]: a }) {
        if (!a) return null
        // Blank sites means the goal used the mission's own catalog.
        const sites = a.sites ? JSON.parse(a.sites) : catalog()
        const avoid = a.avoid ? JSON.parse(a.avoid) : { features: [] }
        return {
            targets: { type: 'FeatureCollection', features: [...sites.features, ...avoid.features] },
            params: {
                objective: a.objective ?? DEFAULTS.objective,
                maxSlopeDeg: a.maxSlopeDeg ?? DEFAULTS.maxSlopeDeg,
                minSOC: a.minSOC ?? DEFAULTS.minSOC,
                observeDurationMin: a.observeDuration != null ? a.observeDuration / MIN : DEFAULTS.observeDurationMin,
                startAfterMin: a.startAfter != null ? a.startAfter / MIN : DEFAULTS.startAfterMin,
            },
        }
    },

    data: {
        terrain: async () => terrain(),
    },

    async interpret({ ops, plan, dataset, goalArgs, startMs, durationSec, iso }) {
        const ms = (sec) => startMs + sec * 1000
        const ds = dataset?.dataset_id
        // With a simulation: what it simulated (spans carry their arguments). Without: the plan's directives.
        const acts = ds != null
            ? await ops.spans(ds, ['Drive', 'Observe'])
            : (await ops.directives(plan.id, ['Drive', 'Observe'])).map((d) => ({ spanId: null, directiveId: d.id, type: d.type, startSec: d.startSec, endSec: null, arguments: d.arguments }))
        const pr = ds != null ? await ops.profiles(ds, [R.lat, R.lon, R.odo, R.slope, R.status, R.terrain, R.soc, R.driveLoad, R.received]) : null
        const legs = pr ? track(pr) : []
        const at = (sec) => (pr ? [valueAt(pr[R.lon], sec), valueAt(pr[R.lat], sec)] : null)
        const common = (s) => ({ spanId: s.spanId, directiveId: s.directiveId, activityType: s.type, startMs: ms(s.startSec), endMs: s.endSec != null ? ms(s.endSec) : null })
        const given = goalArgs ? this.inputsFromGoalArguments(goalArgs) : null

        const features = []
        const rows = []
        const notes = []
        const observed = new Map() // siteId → true if observed on site, false if observed elsewhere
        const plannedOn = new Set()

        for (const s of acts.filter((a) => a.type === 'Drive')) {
            const wp = s.arguments.waypoints || []
            const to = s.arguments.toSiteId || ''
            if (s.arguments.terrain) plannedOn.add(s.arguments.terrain)
            if (wp.length < 2) continue
            const plannedKm = wp.slice(1).reduce((km, p, i) => km + greatCircleKm(wp[i][1], wp[i][0], p[1], p[0], RADIUS_KM), 0)
            const driven = pr ? legs.filter((l) => l.t > s.startSec && l.t <= s.endSec) : []
            const simKm = driven.reduce((km, l) => km + l.km, 0)
            const status = pr ? valueAt(pr[R.status], s.endSec) : null
            const stopped = status === 'HALTED_LOW_BATTERY' ? 'stopped early: battery below the fault limit' : status === 'OFF_ROUTE' ? 'did not start: the rover was not at the first waypoint' : null
            const details = [['Heading for', to || '—'], ['Planned route', `${plannedKm.toFixed(2)} km, ${wp.length} waypoints`]]
            if (pr) {
                const wh = integrateStep(pr[R.driveLoad], s.startSec, s.endSec) / 3600
                const maxSlope = Math.max(0, ...driven.map((l) => l.slope))
                details.push(
                    ['Simulated drive', `${simKm.toFixed(2)} km in ${hm(s.endSec - s.startSec)}`],
                    ['Drive energy', `${wh.toFixed(0)} Wh`],
                    ['Battery', `${(valueAt(pr[R.soc], s.startSec) ?? NaN).toFixed(0)} → ${(valueAt(pr[R.soc], s.endSec) ?? NaN).toFixed(0)} %`],
                    ['Steepest slope', `${maxSlope.toFixed(1)}°`],
                )
                if (stopped) details.push(['Simulation', stopped])
                rows.push({ spanId: s.spanId, directiveId: s.directiveId, to, start: iso(s.startSec), distanceKm: simKm, durationH: (s.endSec - s.startSec) / 3600, energyWh: wh, socAfter: valueAt(pr[R.soc], s.endSec), maxSlope })
                if (stopped) notes.push({ warn: true, text: `Drive to ${to} ${stopped}; it covered ${simKm.toFixed(2)} of ${plannedKm.toFixed(2)} km planned.` })
            }
            const name = `Drive to ${to}`
            features.push({
                type: 'Feature',
                properties: { kind: 'route', basis: 'planned', name: `${name} — planned route`, toSiteId: to, objective: s.arguments.objective || null, primary: driven.length === 0, details, ...common(s) },
                geometry: { type: 'LineString', coordinates: wp },
            })
            if (driven.length)
                features.push({
                    type: 'Feature',
                    properties: { kind: 'drive', basis: 'simulated', primary: true, name, toSiteId: to, details, ...common(s) },
                    geometry: { type: 'LineString', coordinates: [at(s.startSec), ...driven.map((l) => [l.lon, l.lat])] },
                })
        }

        const sites = new Map() // siteId → {name, priority, lon, lat}: sites the plan's Observe activities name
        for (const s of acts.filter((a) => a.type === 'Observe')) {
            const a = s.arguments
            if (a.siteId) sites.set(a.siteId, { name: a.siteName || a.siteId, priority: a.priority ?? 1, lon: a.siteLongitude, lat: a.siteLatitude })
            if (!pr) continue
            const [lon, lat] = at(s.startSec)
            const offKm = a.siteId ? greatCircleKm(a.siteLatitude, a.siteLongitude, lat, lon, RADIUS_KM) : 0
            observed.set(a.siteId, offKm <= ON_SITE_KM)
            const gbit = ((valueAt(pr[R.received], s.endSec) ?? NaN) - (valueAt(pr[R.received], s.startSec) ?? NaN)) / 1e9
            features.push({
                type: 'Feature',
                properties: {
                    kind: 'observation', basis: 'simulated', primary: true, name: `Observe ${a.siteName || a.siteId || ''}`.trim(), siteId: a.siteId || null,
                    details: [
                        ['Site', `${a.siteName || a.siteId || '—'} (priority ${a.priority ?? '—'})`],
                        ['Observed from', offKm <= ON_SITE_KM ? 'the site' : `${offKm.toFixed(2)} km short of the site`],
                        ['Duration', hm(s.endSec - s.startSec)],
                        ['Data collected', `${gbit.toFixed(2)} Gbit`],
                        ['Battery', `${(valueAt(pr[R.soc], s.startSec) ?? NaN).toFixed(0)} → ${(valueAt(pr[R.soc], s.endSec) ?? NaN).toFixed(0)} %`],
                    ],
                    ...common(s),
                },
                geometry: { type: 'Point', coordinates: [lon, lat] },
            })
            if (offKm > ON_SITE_KM) notes.push({ warn: true, text: `${a.siteName || a.siteId} was observed ${offKm.toFixed(2)} km from the site: the rover had not arrived.` })
        }

        // Sites: those the goal was given (or the mission catalog), plus any the plan's activities name.
        const inputSites = (given?.targets.features ?? catalog().features).filter((f) => f.geometry.type === 'Point')
        for (const f of inputSites) if (!sites.has(f.id)) sites.set(f.id, { name: f.properties?.name ?? f.id, priority: f.properties?.priority ?? 1, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], unplanned: true })
        for (const [id, s] of sites) {
            const state = s.unplanned ? 'not in the plan' : !pr ? 'planned' : observed.get(id) ? 'observed' : 'not reached in simulation'
            features.unshift({
                type: 'Feature',
                properties: { kind: 'site', basis: 'input', targetId: id, name: `${s.name} — ${state}`, label: `${s.name} · P${s.priority}`, siteName: s.name, priority: s.priority, scheduled: !s.unplanned, observed: !!observed.get(id), details: [['Science priority', `${s.priority} of 3`], ['Status', state]] },
                geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
            })
        }
        for (const f of (given?.targets.features ?? []).filter((x) => x.geometry.type === 'Polygon'))
            features.unshift({ type: 'Feature', properties: { kind: 'avoid', basis: 'input', targetId: f.id, name: `${f.properties?.name ?? 'Region'} — avoided by the route` }, geometry: f.geometry })

        let position = null
        if (pr) {
            const start = at(0)
            if (typeof start[0] === 'number') features.push({ type: 'Feature', properties: { kind: 'start', basis: 'simulated', name: 'Rover at plan start (simulated)' }, geometry: { type: 'Point', coordinates: start } })
            const low = lowest(pr[R.soc], durationSec)
            if (low && low.value < 99.9) {
                const [lon, lat] = at(low.t)
                features.push({
                    type: 'Feature',
                    properties: { kind: 'min-soc', basis: 'analysis', name: `Lowest battery: ${low.value.toFixed(0)} %`, startMs: ms(low.t), endMs: ms(low.t), details: [['State of charge', `${low.value.toFixed(1)} %`], ['When', `${iso(low.t).replace('T', ' ').slice(0, 16)} UTC`]] },
                    geometry: { type: 'Point', coordinates: [lon, lat] },
                })
            }
            position = {
                label: 'Rover',
                samples: legs.map((l) => [ms(l.t), l.lon, l.lat]),
                hold: 'step',
                note: 'Simulated rover.latitude/longitude, which change on arrival at each waypoint; position between waypoints is not modeled.',
                trackWindowMs: null,
            }
        } else if (acts.length) notes.push({ text: 'This plan has no simulation yet: the map shows the planned route from its Drive activities, and no simulated position or resources.' })

        // Which terrain grid informed the plan, the simulation, and this map.
        const mine = terrain()
        const simulatedOn = pr ? valueAt(pr[R.terrain], 0) : null
        const others = [...plannedOn, ...(simulatedOn ? [simulatedOn] : [])].filter((id) => id !== mine.id)
        if (others.length) notes.push({ warn: true, text: `Terrain mismatch: the map shows ${mine.id}, but the route was planned on ${[...plannedOn].join(', ') || '—'} and simulated on ${simulatedOn ?? '—'}.` })
        notes.push({ text: `Wide faint line: the planned route (Drive waypoints). Solid line: the simulated track. Terrain: ${mine.id}${plannedOn.size ? `, the grid the route was planned on${simulatedOn ? ' and simulated on' : ''}` : ''}.` })

        return {
            features,
            position,
            overlays: [{ id: 'terrain', name: mine.name, datasetId: mine.id, url: 'api/plandev/missions/rover/data/terrain', usedByPlan: plannedOn.has(mine.id), usedBySimulation: simulatedOn === mine.id, source: mine.source }],
            table: {
                columns: [
                    { key: 'to', label: 'Drive to' },
                    { key: 'start', label: 'Start (UTC)', type: 'time' },
                    { key: 'distanceKm', label: 'Dist', unit: 'km', digits: 2 },
                    { key: 'durationH', label: 'Time', unit: 'h', digits: 1 },
                    { key: 'energyWh', label: 'Energy', unit: 'Wh', digits: 0 },
                    { key: 'socAfter', label: 'SOC after', unit: '%', digits: 0 },
                    { key: 'maxSlope', label: 'Max slope', unit: '°', digits: 1 },
                ],
                rows,
            },
            notes,
        }
    },

    // `headline` metrics are the ones a comparison leads with; `better` says which direction is an improvement.
    async metrics({ ops, dataset, durationSec }) {
        const pr = await ops.profiles(dataset.dataset_id, [R.lat, R.lon, R.odo, R.slope, R.soc, R.driveLoad, R.volume, R.maxVolume, R.received])
        const [drives, observes] = await Promise.all(['Drive', 'Observe'].map((t) => ops.spans(dataset.dataset_id, [t])))
        const legs = track(pr)
        const onSite = observes.filter((s) => {
            const a = s.arguments
            return greatCircleKm(a.siteLatitude, a.siteLongitude, valueAt(pr[R.lat], s.startSec), valueAt(pr[R.lon], s.startSec), RADIUS_KM) <= ON_SITE_KM
        })
        const acts = [...drives, ...observes]
        return [
            { key: 'sites', name: 'Sites observed', value: onSite.length, unit: '', digits: 0, headline: true, better: 'high' },
            { key: 'value', name: 'Science priority collected', value: onSite.reduce((n, s) => n + (s.arguments.priority ?? 1), 0), unit: '', digits: 0, better: 'high' },
            { key: 'distance', name: 'Distance driven', value: valueAt(pr[R.odo], durationSec) ?? 0, unit: 'km', digits: 1, headline: true, better: 'low' },
            { key: 'finish', name: 'Traverse finishes at', value: acts.length ? Math.max(...acts.map((s) => s.endSec)) / 3600 : 0, unit: 'h', digits: 1, headline: true, better: 'low' },
            { key: 'energy', name: 'Drive energy', value: integrateStep(pr[R.driveLoad], 0, durationSec) / 3.6e6, unit: 'kWh', digits: 2, headline: true, better: 'low' },
            { key: 'minSOC', name: 'Lowest battery', value: extremaOver(pr[R.soc], 0, durationSec).min, unit: '%', digits: 0, headline: true, better: 'high' },
            { key: 'steepKm', name: `Driven on slopes over ${STEEP_DEG}°`, value: legs.filter((l) => l.slope > STEEP_DEG).reduce((km, l) => km + l.km, 0), unit: 'km', digits: 1, headline: true, better: 'low' },
            { key: 'maxSlope', name: 'Steepest slope driven', value: Math.max(0, ...legs.map((l) => l.slope)), unit: '°', digits: 1, better: 'low' },
            { key: 'drives', name: 'Drive activities', value: drives.length, unit: '', digits: 0 },
            { key: 'data', name: 'Data collected', value: (valueAt(pr[R.received], durationSec) ?? NaN) / 1e9, unit: 'Gbit', digits: 2, better: 'high' },
            { key: 'peakStorage', name: 'Peak onboard storage', value: (100 * extremaOver(pr[R.volume], 0, durationSec).max) / (valueAt(pr[R.maxVolume], 0) || NaN), unit: '% full', digits: 0, better: 'low' },
        ]
    },

    // ---------- read-only questions about an existing plan ----------

    evaluation: {
        help: 'Read-only: checks points and regions against this plan’s simulated track. Points: how close does the rover come, and does it observe there? Regions: does the rover enter, and how far does it drive inside? Nothing is scheduled.',
        targets: { types: ['Point', 'Polygon'], max: 20, ordered: false },
        params: [{ key: 'radiusKm', label: 'Reached if the rover comes within', unit: 'km', type: 'number', min: 0.05, max: 20, default: 0.2 }],
    },

    async evaluate({ ops, dataset, iso }, fc, { radiusKm }) {
        const pr = await ops.profiles(dataset.dataset_id, [R.lat, R.lon, R.slope])
        const observes = await ops.spans(dataset.dataset_id, ['Observe'])
        const legs = track(pr)
        const features = []
        const rows = []
        for (const f of fc.features) {
            const name = f.properties.name
            if (f.geometry.type === 'Point') {
                const p = f.geometry.coordinates
                let best = null
                legs.forEach((l, i) => {
                    const a = legs[i - 1] ?? l
                    const km = pointToSegmentKm(p, [a.lon, a.lat], [l.lon, l.lat], RADIUS_KM)
                    if (!best || km < best.km) best = { km, l }
                })
                const reached = best && best.km <= radiusKm
                const obs = observes.filter((s) => greatCircleKm(p[1], p[0], valueAt(pr[R.lat], s.startSec), valueAt(pr[R.lon], s.startSec), RADIUS_KM) <= radiusKm)
                const result = reached ? (obs.length ? 'reached, observed' : 'passed, not observed') : `not reached: closest approach ${best ? best.km.toFixed(2) : '—'} km`
                rows.push({ name, kind: 'point', result, distanceKm: best?.km ?? null, when: best ? iso(best.l.t) : null, insideKm: null })
                features.push({ type: 'Feature', properties: { kind: 'eval-site', basis: 'input', name: `${name}: ${result}`, visited: !!reached }, geometry: f.geometry })
                if (best)
                    features.push({
                        type: 'Feature',
                        properties: { kind: 'eval-nearest', basis: 'analysis', name: `${name}: closest approach ${best.km.toFixed(2)} km`, startMs: null },
                        geometry: { type: 'LineString', coordinates: [p, [best.l.lon, best.l.lat]] },
                    })
            } else {
                const ring = f.geometry.coordinates[0]
                const inside = legs.filter((l) => pointInRing([l.lon, l.lat], ring))
                const km = inside.reduce((n, l) => n + l.km, 0)
                const steepKm = inside.filter((l) => l.slope > STEEP_DEG).reduce((n, l) => n + l.km, 0)
                const result = inside.length ? `entered: ${km.toFixed(1)} km driven inside${steepKm ? `, ${steepKm.toFixed(1)} km of it over ${STEEP_DEG}°` : ''}` : 'not entered'
                rows.push({ name, kind: 'region', result, distanceKm: null, when: inside[0] ? iso(inside[0].t) : null, insideKm: km })
                features.push({ type: 'Feature', properties: { kind: 'eval-region', basis: 'input', name: `${name}: ${result}`, visited: !inside.length }, geometry: f.geometry })
                if (inside.length > 1) features.push({ type: 'Feature', properties: { kind: 'eval-inside', basis: 'analysis', name: `Track inside ${name}` }, geometry: { type: 'MultiPoint', coordinates: inside.map((l) => [l.lon, l.lat]) } })
            }
        }
        const regions = rows.filter((r) => r.kind === 'region')
        return {
            features,
            table: {
                columns: [
                    { key: 'name', label: 'Feature' },
                    { key: 'result', label: 'Result' },
                    { key: 'distanceKm', label: 'Closest', unit: 'km', digits: 2 },
                    { key: 'when', label: 'When (UTC)', type: 'time' },
                ],
                rows,
            },
            summary: regions.length ? [{ key: 'insideKm', name: 'Driven inside the regions', value: regions.reduce((n, r) => n + r.insideKm, 0), unit: 'km', digits: 1 }] : [],
            notes: [{ text: `Against the simulated track (arrivals at waypoints, joined by straight lines). “Reached” = within ${radiusKm} km. A region counts the legs that end inside it.` }],
        }
    },
}
