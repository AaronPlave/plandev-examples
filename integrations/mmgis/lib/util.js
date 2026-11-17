// Pure helpers shared by the generic candidate workflow and the mission adapters. No I/O.
'use strict'

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

/** Great-circle distance on a sphere of `radiusKm`. */
function greatCircleKm(lat1, lon1, lat2, lon2, radiusKm) {
    const r = Math.PI / 180
    const dp = (lat2 - lat1) * r
    const dl = (lon2 - lon1) * r
    const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2
    return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(a)))
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

/** LineString, MultiLineString, or null for a lon/lat path. */
function pathGeometry(coords) {
    const parts = splitAtAntimeridian(coords)
    if (!parts.length) return null
    return parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : { type: 'MultiLineString', coordinates: parts }
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

/**
 * Validate browser-supplied targets at the trust boundary; returns a clean FeatureCollection.
 * Feature order is preserved (a mission may treat it as meaningful). `keep` names the feature
 * properties a mission reads (numbers, or strings up to 120 characters); all others are dropped.
 */
function normalizeTargets(fc, { max = 20, types = ['Point', 'Polygon'], keep = [] } = {}) {
    const features = fc && fc.type === 'FeatureCollection' ? fc.features : null
    if (!Array.isArray(features) || features.length === 0) throw new Error('targets must be a non-empty FeatureCollection')
    if (features.length > max) throw new Error(`at most ${max} targets`)
    const ids = new Set()
    const okPos = (p) =>
        Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 360
    return {
        type: 'FeatureCollection',
        features: features.map((f, i) => {
            const g = f && f.geometry
            if (!g || !types.includes(g.type)) throw new Error(`target ${i}: only ${types.join(' or ')}`)
            if (g.type === 'Point' && !okPos(g.coordinates)) throw new Error(`target ${i}: bad coordinates`)
            if (g.type === 'Polygon' && !(Array.isArray(g.coordinates?.[0]) && g.coordinates[0].length >= 4 && g.coordinates[0].every(okPos)))
                throw new Error(`target ${i}: bad polygon`)
            const id = String(f.id ?? f.properties?.id ?? i).replace(/[^\w:.\-]/g, '_').slice(0, 80)
            if (ids.has(id)) throw new Error(`duplicate target id ${id}`)
            ids.add(id)
            const kept = {}
            for (const k of keep) {
                const v = f.properties?.[k]
                if (Number.isFinite(v)) kept[k] = v
                else if (typeof v === 'string') kept[k] = v.slice(0, 120)
            }
            return {
                type: 'Feature',
                id,
                properties: { ...kept, id, name: String(f.properties?.name ?? id).slice(0, 120), source: f.properties?.source ?? null },
                geometry: { type: g.type, coordinates: g.coordinates },
            }
        }),
    }
}

/** The point a mission plans against: the point itself, or a polygon's outer-ring vertex mean. */
function anchor(geometry) {
    if (geometry.type === 'Point') return geometry.coordinates
    const ring = geometry.coordinates[0].slice(0, -1)
    return [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length]
}

// Planar lon/lat geometry: fine for regions a few degrees across away from the poles and antimeridian,
// which is what a site-scale evaluation draws. ponytail: spherical tests if regions get continental.

/** Ray-casting point-in-polygon on the outer ring ([lon, lat] pairs). */
function pointInRing([x, y], ring) {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
}

/** Whether segment a–b touches the polygon ring: an endpoint inside, or crossing an edge. */
function segmentHitsRing(a, b, ring) {
    if (pointInRing(a, ring) || pointInRing(b, ring)) return true
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    for (let i = 0; i < ring.length - 1; i++) {
        const c = ring[i]
        const d = ring[i + 1]
        if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true
    }
    return false
}

/** Distance in km from point p to segment a–b ([lon, lat] degrees), on a local flat projection about p. */
function pointToSegmentKm(p, a, b, radiusKm) {
    const k = (Math.PI / 180) * radiusKm
    const cos = Math.cos((p[1] * Math.PI) / 180)
    const ax = (a[0] - p[0]) * k * cos, ay = (a[1] - p[1]) * k
    const bx = (b[0] - p[0]) * k * cos, by = (b[1] - p[1]) * k
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0
    return Math.hypot(ax + t * dx, ay + t * dy)
}

/** Integral of a piecewise-constant (discrete, numeric) profile over [from, to], in value·seconds. */
function integrateStep(segments, from, to) {
    let sum = 0
    for (let i = 0; i < segments.length; i++) {
        const a = Math.max(from, segments[i].t)
        const b = Math.min(to, i + 1 < segments.length ? segments[i + 1].t : to)
        if (b > a && typeof segments[i].dynamics === 'number') sum += segments[i].dynamics * (b - a)
    }
    return sum
}

/**
 * Intervals [[from, to]] within [from, to] where every discrete profile's value satisfies its test:
 * conds is [[segments, (value) => boolean], ...]. Profiles change only at segment starts.
 */
function intervalsWhere(conds, from, to) {
    const times = [...new Set([from, ...conds.flatMap(([segs]) => segs.map((s) => s.t))])].filter((t) => t >= from && t < to).sort((a, b) => a - b)
    const out = []
    times.forEach((t, i) => {
        const end = times[i + 1] ?? to
        if (!conds.every(([segs, test]) => test(valueAt(segs, t)))) return
        if (out.length && out.at(-1)[1] === t) out.at(-1)[1] = end
        else out.push([t, end])
    })
    return out
}

/**
 * A run failure for display: a one-line `summary`, the exception message PlanDev reported (`cause`, when one
 * can be found in its reason), and the raw reason as `detail`. No interpretation beyond that: adapters may
 * map a cause they understand to a better summary (adapter.explainError).
 */
function runFailure(stage, reason) {
    const detail = reason == null ? '' : typeof reason === 'string' ? reason : JSON.stringify(reason, null, 2)
    const text = typeof reason === 'string' ? reason : reason?.data?.trace ?? reason?.data?.message ?? reason?.message ?? detail
    const m = /(?:Exception|Error): ([^\n]+)/.exec(String(text))
    const cause = m ? m[1].trim().slice(0, 200) : null
    const Stage = stage[0].toUpperCase() + stage.slice(1)
    // A Java trace reads better as itself than inside escaped JSON.
    const trace = reason?.data?.trace
    return { stage, cause, summary: `${Stage} failed`, detail: typeof trace === 'string' ? `${reason.data.type ?? ''}\n${trace}`.trim() : detail }
}

/**
 * A tracked entity's position track from two profiles, declared rather than coded: `spec` is
 * { label, lat, lon, hold: 'step' | 'sample', note? } naming the latitude and longitude resources
 * (planetocentric, east-positive degrees, in the adapter's declared body and frame). One sample per change
 * of either value: [ms, lon, lat]. Nothing is guessed from resource names.
 */
function positionFromProfiles(pr, spec, startMs, conventions = {}) {
    const lat = pr[spec.lat] || []
    const lon = pr[spec.lon] || []
    const times = [...new Set([...lat, ...lon].map((s) => s.t))].sort((a, b) => a - b)
    const samples = []
    for (const t of times) {
        const lo = valueAt(lon, t)
        const la = valueAt(lat, t)
        const prev = samples.at(-1)
        if (typeof lo !== 'number' || typeof la !== 'number' || (prev && prev[1] === lo && prev[2] === la)) continue
        samples.push([startMs + t * 1000, lo, la])
    }
    return {
        label: spec.label,
        samples,
        hold: spec.hold ?? 'step',
        note: spec.note ?? `Simulated ${spec.lat} / ${spec.lon} (${conventions.coordinates ?? 'degrees'}, ${conventions.frame ?? ''}).`,
        trackWindowMs: spec.trackWindowMs ?? null,
        source: { lat: spec.lat, lon: spec.lon, basis: 'simulated' },
    }
}

/**
 * The feature of `view` that stands for the same thing as `f` (of the other plan): a site by its target id,
 * a drive or route by its destination, an observation by its site. Nothing is matched on anything weaker.
 */
function counterpart(f, view) {
    const p = f?.properties
    if (!p || !view) return undefined
    const key = p.kind === 'site' || p.kind === 'target' || p.kind === 'avoid' ? ['targetId', p.targetId]
        : p.kind === 'route' || p.kind === 'drive' ? ['toSiteId', p.toSiteId]
        : p.kind === 'observation' || p.kind === 'picture' ? ['siteId', p.siteId] : null
    if (!key || key[1] == null) return undefined
    const xs = view.features.filter((x) => x.properties[key[0]] === key[1] && (x.properties.kind === p.kind || (p.kind === 'route' && x.properties.kind === 'drive') || (p.kind === 'drive' && x.properties.kind === 'route')))
    return xs.find((x) => x.properties.kind === p.kind && x.properties.primary) || xs.find((x) => x.properties.kind === p.kind) || xs[0] || null
}

/**
 * Whether a loaded comparison ({ planId, ds, view }) should be read again: it follows its plan's latest
 * simulation (no pinned `ds`) and the plan list now names a newer successful one. A pinned simulation never is.
 */
function comparisonOutdated(other, plans) {
    if (!other?.view || other.ds != null) return false
    const latest = plans.find((x) => x.id === other.planId)?.latest
    return latest?.status === 'success' && latest.simulationDatasetId !== other.view.provenance.simulationDatasetId
}

/** Validate a numeric parameter against an adapter's param spec. */
function checkParams(spec, input) {
    const out = {}
    for (const p of spec) {
        const raw = input?.[p.key] ?? p.default
        if (p.type === 'enum') {
            if (!p.options.includes(raw)) throw new Error(`${p.key} must be one of ${p.options.join(', ')}`)
            out[p.key] = raw
        } else {
            const v = Number(raw)
            if (!(Number.isFinite(v) && v >= p.min && v <= p.max)) throw new Error(`${p.key} must be in [${p.min}, ${p.max}]`)
            out[p.key] = v
        }
    }
    return out
}

/** Whether a closed ring ([lon, lat] pairs, first point not repeated) has two non-adjacent edges that cross. */
function ringSelfIntersects(ring) {
    const n = ring.length
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n]
        for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue // adjacent through the closing edge
            const c = ring[j], d = ring[(j + 1) % n]
            if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true
        }
    }
    return false
}

/** Problems that make a drawn region unusable as a goal input, or null. */
function regionProblem(ring) {
    if (ring.length < 3) return 'needs at least 3 corners'
    if (ringSelfIntersects(ring)) return 'its edges cross'
    return null
}

/**
 * Where a tracked entity is at time t: { sample } (the last sample at or before t), or { outside, coverFrom,
 * coverTo } when t is not in the time its simulation covers (entity.coverage; without one, its first to last sample).
 * Two independently dated simulations are only simultaneous where both cover t.
 */
function positionAt(entity, t) {
    const s = entity?.samples || []
    if (t == null || !s.length) return { outside: 'no-time' }
    const from = entity.coverage?.startMs ?? s[0][0]
    const to = entity.coverage?.endMs ?? s.at(-1)[0]
    if (t < from) return { outside: 'before', coverFrom: from, coverTo: to }
    if (t > to) return { outside: 'after', coverFrom: from, coverTo: to }
    let lo = 0, hi = s.length - 1, k = -1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (s[mid][0] <= t) (k = mid), (lo = mid + 1)
        else hi = mid - 1
    }
    return k < 0 ? { outside: 'before', coverFrom: from, coverTo: to } : { sample: s[k] }
}

/**
 * One poll of a scheduling + simulation run started from the map, independent of the dataset the host
 * happens to show. run: { planId, fromDs, target?, userPicked?, idle? }; entry: the plan's row from
 * missions/:key/plans; shownDs: the dataset PlanDev shows. Returns the next run (null when finished)
 * and what to tell the user and PlanDev.
 *   phase: 'scheduling' | 'simulating' | 'complete' | 'failed'
 *   show:  a dataset id to ask PlanDev to show, or null
 */
function runStep(run, entry, shownDs) {
    if (!entry) return { run, phase: 'scheduling', show: null }
    if (entry.error) return { run: null, phase: 'failed', message: entry.error, show: null }
    if (entry.running) return { run: { ...run, idle: 0 }, phase: entry.phase || 'scheduling', show: null }
    const ds = entry.latest
    if (ds && ds.simulationDatasetId !== run.fromDs) {
        if (ds.status === 'failed') return { run: null, phase: 'failed', message: `simulation ${ds.simulationDatasetId} failed`, show: null }
        if (ds.status === 'success') {
            const shown = shownDs === ds.simulationDatasetId
            // The user picked another simulation in PlanDev meanwhile: their choice stands.
            if (run.userPicked || shown) return { run: null, phase: 'complete', show: null, simulationDatasetId: ds.simulationDatasetId }
            // PlanDev may not list the new dataset yet; keep asking for a while.
            const tries = (run.tries || 0) + 1
            return { run: tries > 10 ? null : { ...run, target: ds.simulationDatasetId, tries }, phase: 'complete', show: ds.simulationDatasetId, simulationDatasetId: ds.simulationDatasetId }
        }
        return { run, phase: 'simulating', show: null }
    }
    // Not running, nothing new: give the server a few polls (it may not have registered the run yet).
    const idle = (run.idle || 0) + 1
    if (idle > 3) return { run: null, phase: 'failed', message: 'the run ended without a new simulation', show: null }
    return { run: { ...run, idle }, phase: 'scheduling', show: null }
}

module.exports = {
    comparisonOutdated,
    counterpart,
    intervalsWhere,
    positionFromProfiles,
    runFailure,
    intervalToSec,
    secToInterval,
    greatCircleKm,
    splitAtAntimeridian,
    pathGeometry,
    valueAt,
    extremaOver,
    normalizeTargets,
    anchor,
    checkParams,
    pointInRing,
    segmentHitsRing,
    pointToSegmentKm,
    integrateStep,
    ringSelfIntersects,
    regionProblem,
    positionAt,
    runStep,
}
