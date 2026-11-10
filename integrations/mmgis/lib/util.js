// PlanDev candidate workflow for spatial targets: duplicate a base plan, parameterize a procedural
// goal with GeoJSON targets, schedule, simulate, and read results back as GeoJSON + metrics.
// All state lives in PlanDev (plan lineage, spec-goal arguments, scheduling requests, sim datasets);
// this module keeps nothing but the in-flight promise.
'use strict'
const { sleep } = require('./plandev')

const NAME_PREFIX = 'TargetObs ' // must match ScheduleTargetObservations.NAME_PREFIX
const MARS_MEAN_RADIUS_KM = 3389.5
const TRACK_CONTEXT_SEC = 15 * 60
const MAX_TARGETS = 20

// Mission-specific mapping: which simulated resources mean what. Kept here, small and explicit.
const RESOURCES = {
    lat: 'subSCBodies_MARS_latitude', // deg, planetocentric, IAU_MARS
    lon: 'subSCBodies_MARS_longitude', // deg, east-positive [-180, 180)
    soc: 'cbebattery.batterySOC', // %
    load: 'spacecraft.cbeLoad', // W
    volume: 'onboard.volume', // bits
}

// ---------- pure helpers (unit-tested) ----------

/** Postgres interval text ("144:00:00", "1 day 02:00:00.5", "-00:00:01") → seconds. */
function intervalToSec(s) {
    if (typeof s === 'number') return s
    let total = 0
    let rest = String(s).trim()
    const days = rest.match(/^(-?\d+) days?\s*/)
    if (days) {
        total += Number(days[1]) * 86400
        rest = rest.slice(days[0].length)
    }
    if (rest) {
        const m = rest.match(/^(-)?(\d+):(\d+):(\d+(?:\.\d+)?)$/)
        if (!m) throw new Error(`unparseable interval ${s}`)
        const v = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])
        total += m[1] ? -v : v
    }
    return total
}

/** seconds → Postgres interval literal accepted by Hasura comparisons. */
function secToInterval(sec) {
    const sign = sec < 0 ? '-' : ''
    const a = Math.abs(sec)
    const h = Math.floor(a / 3600)
    const m = Math.floor((a % 3600) / 60)
    const s = (a % 60).toFixed(6)
    return `${sign}${h}:${String(m).padStart(2, '0')}:${s.padStart(9, '0')}`
}

function greatCircleKm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180
    const dp = (lat2 - lat1) * r
    const dl = (lon2 - lon1) * r
    const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2
    return 2 * MARS_MEAN_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Split a lon/lat path wherever it wraps the antimeridian so the map doesn't draw a 360° line. */
function splitAtAntimeridian(coords) {
    const parts = [[]]
    for (let i = 0; i < coords.length; i++) {
        if (i > 0 && Math.abs(coords[i][0] - coords[i - 1][0]) > 180) parts.push([])
        parts[parts.length - 1].push(coords[i])
    }
    return parts.filter((p) => p.length > 1)
}

/** Value of a real ({initial, rate}) or discrete profile at `sec`, given segments sorted by offset. */
function valueAt(segments, sec) {
    let seg = null
    for (const s of segments) {
        if (s.t <= sec) seg = s
        else break
    }
    if (!seg || seg.is_gap) return null
    const d = seg.dynamics
    return d && typeof d === 'object' && 'initial' in d ? d.initial + d.rate * (sec - seg.t) : d
}

/** Min/max of a profile over [from, to], evaluating real segments at their endpoints. */
function extremaOver(segments, from, to) {
    const pts = [from, to, ...segments.map((s) => s.t).filter((t) => t > from && t < to)]
    // real segments are linear: their extremes are at the endpoints, i.e. just before the next start
    for (const s of segments) if (s.t > from && s.t <= to) pts.push(s.t - 1e-6)
    const vals = pts.map((t) => valueAt(segments, t)).filter((v) => typeof v === 'number')
    if (!vals.length) return { min: null, max: null }
    return { min: Math.min(...vals), max: Math.max(...vals) }
}

/** Validate browser-supplied targets at the trust boundary; returns a clean FeatureCollection. */
function normalizeTargets(fc) {
    const features = fc && fc.type === 'FeatureCollection' ? fc.features : null
    if (!Array.isArray(features) || features.length === 0) throw new Error('targets must be a non-empty FeatureCollection')
    if (features.length > MAX_TARGETS) throw new Error(`at most ${MAX_TARGETS} targets`)
    const ids = new Set()
    const okPos = (p) =>
        Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 360
    return {
        type: 'FeatureCollection',
        features: features.map((f, i) => {
            const g = f && f.geometry
            if (!g || !['Point', 'Polygon'].includes(g.type)) throw new Error(`target ${i}: only Point or Polygon`)
            if (g.type === 'Point' && !okPos(g.coordinates)) throw new Error(`target ${i}: bad coordinates`)
            if (g.type === 'Polygon' && !(Array.isArray(g.coordinates?.[0]) && g.coordinates[0].length >= 4 && g.coordinates[0].every(okPos)))
                throw new Error(`target ${i}: bad polygon`)
            const id = String(f.id ?? f.properties?.id ?? i).replace(/[^\w:.\-]/g, '_').slice(0, 80)
            if (ids.has(id)) throw new Error(`duplicate target id ${id}`)
            ids.add(id)
            return {
                type: 'Feature',
                id,
                properties: { id, name: String(f.properties?.name ?? id).slice(0, 120), source: f.properties?.source ?? null },
                geometry: { type: g.type, coordinates: g.coordinates },
            }
        }),
    }
}

function targetAnchor(f) {
    if (f.geometry.type === 'Point') return f.geometry.coordinates
    const ring = f.geometry.coordinates[0].slice(0, -1) // same vertex mean the goal uses
    return [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length]
}

// ---------- PlanDev operations ----------

function createWorkflow(pd, { basePlanId, goalId }) {
    const inflight = new Map() // planId → promise (only to avoid double-driving in this process)

    async function plan(planId) {
        const d = await pd.gql(
            `query($id:Int!){ plan_by_pk(id:$id){ id revision name description parent_id start_time duration created_at owner
               scheduling_specification{ id } simulations{ id } } }`,
            { id: planId },
        )
        if (!d.plan_by_pk) throw new Error(`plan ${planId} not found or not visible to ${pd.username}`)
        return d.plan_by_pk
    }

    async function waitFor(fn, isDone, timeoutMs = 20 * 60_000) {
        const until = Date.now() + timeoutMs
        for (;;) {
            const v = await fn()
            if (isDone(v)) return v
            if (Date.now() > until) throw new Error('timed out waiting for PlanDev')
            await sleep(2000)
        }
    }

    /** Create a candidate plan and start schedule→simulate. Returns as soon as the plan exists. */
    async function createCandidate({ targets, params, requestedBy, label }) {
        const fc = normalizeTargets(targets)
        const base = await plan(basePlanId)
        const n = (await listCandidates()).length + 1
        const name = `${base.name} · candidate ${n}${label ? ` · ${String(label).slice(0, 60)}` : ''}`

        const dup = await pd.gql(
            `mutation($p:Int!,$n:String!){ duplicate_plan(args:{plan_id:$p, new_plan_name:$n}){ new_plan_id } }`,
            { p: basePlanId, n: name },
        )
        const planId = dup.duplicate_plan.new_plan_id
        await pd.gql(`mutation($id:Int!,$d:String!){ update_plan_by_pk(pk_columns:{id:$id}, _set:{description:$d}){ id } }`, {
            id: planId,
            d: `Created from MMGIS by ${requestedBy} via the PlanDev MMGIS adapter. Goal arguments hold the source GeoJSON targets.`,
        })

        const spec = (await plan(planId)).scheduling_specification
        const args = {
            targets: JSON.stringify(fc),
            maxGroundDistanceKm: Number(params.maxGroundDistanceKm),
            observationDuration: Math.round(Number(params.observationDurationSec) * 1e6), // microseconds
            mode: String(params.mode),
        }
        await pd.gql(
            `mutation($g:scheduling_specification_goals_insert_input!){ insert_scheduling_specification_goals_one(object:$g){ goal_id } }`,
            { g: { specification_id: spec.id, goal_id: goalId, arguments: args, enabled: true, priority: 0 } },
        )

        const run = drive(planId, spec.id).finally(() => inflight.delete(planId))
        run.catch((e) => console.error(`[plandev] candidate ${planId}: ${e.message}`))
        inflight.set(planId, run)
        return { planId }
    }

    async function drive(planId, specId) {
        // The scheduler rejects a spec whose plan_revision is stale; the PlanDev UI stamps it the same way.
        const { revision } = await plan(planId)
        await pd.gql(
            `mutation($id:Int!,$r:Int!){ update_scheduling_specification_by_pk(pk_columns:{id:$id}, _set:{plan_revision:$r, analysis_only:false}){ id } }`,
            { id: specId, r: revision },
        )
        const s = await pd.gql(`query($s:Int!){ schedule(specificationId:$s){ analysisId reason } }`, { s: specId })
        const analysisId = s.schedule.analysisId
        const req = await waitFor(
            async () =>
                (
                    await pd.gql(`query($a:Int!){ scheduling_request(where:{analysis_id:{_eq:$a}}){ status reason } }`, {
                        a: analysisId,
                    })
                ).scheduling_request[0],
            (r) => r && ['success', 'failed'].includes(r.status),
        )
        if (req.status !== 'success') return
        const sim = await pd.gql(`query($p:Int!){ simulate(planId:$p, force:true){ simulationDatasetId status reason } }`, {
            p: planId,
        })
        await waitFor(
            async () =>
                (
                    await pd.gql(`query($id:Int!){ simulation_dataset_by_pk(id:$id){ status } }`, {
                        id: sim.simulate.simulationDatasetId,
                    })
                ).simulation_dataset_by_pk,
            (d) => d && ['success', 'failed'].includes(d.status),
        )
    }

    async function listCandidates() {
        const d = await pd.gql(
            `query($p:Int!){ plan(where:{parent_id:{_eq:$p}}, order_by:{id:asc}){ id name created_at } }`,
            { p: basePlanId },
        )
        return d.plan
    }

    async function latestDataset(simulationId) {
        const d = await pd.gql(
            `query($s:Int!){ simulation_dataset(where:{simulation_id:{_eq:$s}}, order_by:{id:desc}, limit:1){ id dataset_id status reason } }`,
            { s: simulationId },
        )
        return d.simulation_dataset[0] || null
    }

    async function profiles(datasetId, names, from, to) {
        const where = from == null ? {} : { start_offset: { _lte: secToInterval(to) } }
        const d = await pd.gql(
            `query($ds:Int!,$names:[String!]!,$w:profile_segment_bool_exp!){
               profile(where:{dataset_id:{_eq:$ds}, name:{_in:$names}}){ name
                 profile_segments(where:$w, order_by:{start_offset:asc}){ start_offset dynamics is_gap } } }`,
            { ds: datasetId, names, w: where },
        )
        const out = {}
        for (const p of d.profile) {
            let segs = p.profile_segments.map((s) => ({ t: intervalToSec(s.start_offset), dynamics: s.dynamics, is_gap: s.is_gap }))
            // keep the segment in force at `from` plus everything after it
            if (from != null) {
                const firstIn = segs.findIndex((s) => s.t > from)
                segs = segs.slice(Math.max(0, (firstIn === -1 ? segs.length : firstIn) - 1))
            }
            out[p.name] = segs
        }
        return out
    }

    async function planMetrics(datasetId, durationSec) {
        const p = await profiles(datasetId, [RESOURCES.soc, RESOURCES.volume])
        const soc = extremaOver(p[RESOURCES.soc] || [], 0, durationSec)
        const vol = extremaOver(p[RESOURCES.volume] || [], 0, durationSec)
        return {
            minBatterySOC: soc.min,
            finalBatterySOC: valueAt(p[RESOURCES.soc] || [], durationSec),
            maxOnboardVolumeGbit: vol.max == null ? null : vol.max / 1e9,
            finalOnboardVolumeGbit: (valueAt(p[RESOURCES.volume] || [], durationSec) ?? NaN) / 1e9,
        }
    }

    /** Everything MMGIS needs about one candidate, read from PlanDev. */
    async function getCandidate(planId) {
        const p = await plan(planId)
        if (p.parent_id !== basePlanId) throw new Error(`plan ${planId} is not a candidate of base plan ${basePlanId}`)
        const startMs = Date.parse(p.start_time)
        const durationSec = intervalToSec(p.duration)
        const iso = (sec) => new Date(startMs + sec * 1000).toISOString()

        const g = await pd.gql(
            `query($s:Int!,$g:Int!){
               scheduling_specification_goals(where:{specification_id:{_eq:$s}, goal_id:{_eq:$g}}){ arguments }
               scheduling_request(where:{specification_id:{_eq:$s}}, order_by:{analysis_id:desc}, limit:1){ analysis_id status reason requested_at } }`,
            { s: p.scheduling_specification.id, g: goalId },
        )
        const args = g.scheduling_specification_goals[0]?.arguments || {}
        const targets = args.targets ? JSON.parse(args.targets) : { type: 'FeatureCollection', features: [] }
        const scheduling = g.scheduling_request[0] || null
        const dataset = p.simulations[0] ? await latestDataset(p.simulations[0].id) : null
        const base = await plan(basePlanId)
        const baseDs = base.simulations[0] ? await latestDataset(base.simulations[0].id) : null
        const baseOk = baseDs?.status === 'success'

        const directives = (
            await pd.gql(
                `query($p:Int!){ activity_directive(where:{plan_id:{_eq:$p}, type:{_eq:"TakeRadarObservation"}, name:{_like:"${NAME_PREFIX}%"}},
                   order_by:{start_offset:asc}){ id name start_offset arguments } }`,
                { p: planId },
            )
        ).activity_directive

        const status =
            inflight.has(planId) && !(dataset && ['success', 'failed'].includes(dataset.status))
                ? 'running'
                : scheduling?.status === 'failed'
                  ? 'scheduling failed'
                  : !dataset
                    ? scheduling?.status === 'success'
                        ? 'scheduled, not simulated'
                        : scheduling?.status || 'not run'
                    : dataset.status === 'success'
                      ? 'complete'
                      : dataset.status === 'failed'
                        ? 'simulation failed'
                        : 'running'

        const result = {
            plan: { id: p.id, name: p.name, description: p.description, startTime: p.start_time, durationSec, createdAt: p.created_at },
            basePlanId,
            inputs: { targets, maxGroundDistanceKm: args.maxGroundDistanceKm, observationDurationSec: args.observationDuration / 1e6, mode: args.mode },
            status,
            scheduling,
            simulation: dataset,
            observations: [],
            metrics: null,
            baseMetrics: null,
        }
        const byTarget = new Map(targets.features.map((f) => [String(f.id), f]))
        const features = []

        for (const f of targets.features) {
            const [lon, lat] = targetAnchor(f)
            const scheduled = directives.some((d) => d.name === NAME_PREFIX + f.id)
            features.push({
                type: 'Feature',
                properties: {
                    kind: 'target',
                    targetId: f.id,
                    name: f.properties?.name ?? f.id,
                    scheduled,
                    candidatePlanId: planId,
                    note: f.geometry.type === 'Polygon' ? 'polygon reduced to vertex mean for the pass search' : undefined,
                },
                geometry: f.geometry.type === 'Point' ? { type: 'Point', coordinates: [lon, lat] } : f.geometry,
            })
        }

        if (dataset?.status === 'success') {
            const spans = (
                await pd.gql(
                    `query($ds:Int!){ span(where:{dataset_id:{_eq:$ds}, type:{_eq:"TakeRadarObservation"}}){ start_offset duration attributes } }`,
                    { ds: dataset.dataset_id },
                )
            ).span
            for (const d of directives) {
                const targetId = d.name.slice(NAME_PREFIX.length)
                const span = spans.find((s) => s.attributes?.directiveId === d.id)
                const t0 = span ? intervalToSec(span.start_offset) : intervalToSec(d.start_offset)
                const t1 = t0 + (span ? intervalToSec(span.duration) : d.arguments.duration / 1e6)
                const binVolume = `scBin${d.arguments.bin ?? 0}.volume` // the bin TakeRadarObservation writes into
                const pr = await profiles(
                    dataset.dataset_id,
                    [RESOURCES.lat, RESOURCES.lon, RESOURCES.soc, RESOURCES.load, binVolume],
                    t0 - TRACK_CONTEXT_SEC,
                    t1 + TRACK_CONTEXT_SEC,
                )
                const baseSoc = baseOk ? (await profiles(baseDs.dataset_id, [RESOURCES.soc], t1, t1))[RESOURCES.soc] : null
                const track = (from, to) =>
                    (pr[RESOURCES.lat] || [])
                        .filter((s) => s.t >= from && s.t <= to)
                        .map((s) => [valueAt(pr[RESOURCES.lon], s.t), valueAt(pr[RESOURCES.lat], s.t), s.t])
                        .filter(([lo, la]) => typeof lo === 'number' && typeof la === 'number')
                const obsTrack = track(t0, t1)
                const ctxTrack = track(t0 - TRACK_CONTEXT_SEC, t1 + TRACK_CONTEXT_SEC)

                const target = byTarget.get(targetId)
                let closest = null
                if (target) {
                    const [tlon, tlat] = targetAnchor(target)
                    for (const [lo, la, t] of obsTrack) {
                        const km = greatCircleKm(tlat, tlon, la, lo)
                        if (!closest || km < closest.km) closest = { km, lon: lo, lat: la, t }
                    }
                    if (closest) {
                        features.push({
                            type: 'Feature',
                            properties: { kind: 'association', targetId, directiveId: d.id, candidatePlanId: planId, distanceKm: +closest.km.toFixed(1) },
                            geometry: { type: 'LineString', coordinates: [[tlon, tlat], [closest.lon, closest.lat]] },
                        })
                    }
                }
                const load = extremaOver(pr[RESOURCES.load] || [], t0, t1)
                const obs = {
                    directiveId: d.id,
                    targetId,
                    targetName: target?.properties?.name ?? targetId,
                    start: iso(t0),
                    end: iso(t1),
                    mode: d.arguments.mode,
                    minSampledDistanceKm: closest ? +closest.km.toFixed(1) : null,
                    socAtEnd: valueAt(pr[RESOURCES.soc] || [], t1),
                    baseSocAtEnd: baseSoc ? valueAt(baseSoc, t1) : null,
                    dataWrittenGbit: ((valueAt(pr[binVolume] || [], t1) ?? NaN) - (valueAt(pr[binVolume] || [], t0) ?? NaN)) / 1e9,
                    peakLoadW: load.max,
                }
                result.observations.push(obs)
                const lineProps = { directiveId: d.id, targetId, candidatePlanId: planId, start: obs.start, end: obs.end, mode: obs.mode }
                for (const [kind, pts] of [['track-context', ctxTrack], ['observation-track', obsTrack]]) {
                    const parts = splitAtAntimeridian(pts.map(([lo, la]) => [lo, la]))
                    if (parts.length)
                        features.push({
                            type: 'Feature',
                            properties: { kind, ...lineProps },
                            geometry: parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : { type: 'MultiLineString', coordinates: parts },
                        })
                }
            }
            result.metrics = await planMetrics(dataset.dataset_id, durationSec)
            if (baseOk) result.baseMetrics = await planMetrics(baseDs.dataset_id, intervalToSec(base.duration))
        }
        result.geojson = { type: 'FeatureCollection', features }
        return result
    }

    return { createCandidate, listCandidates, getCandidate, plan, basePlanId, goalId }
}

module.exports = {
    createWorkflow,
    intervalToSec,
    secToInterval,
    greatCircleKm,
    splitAtAntimeridian,
    valueAt,
    extremaOver,
    normalizeTargets,
    NAME_PREFIX,
    RESOURCES,
}
