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
 * Feature order is preserved (a mission may treat it as meaningful).
 */
function normalizeTargets(fc, { max = 20, types = ['Point', 'Polygon'] } = {}) {
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
            return {
                type: 'Feature',
                id,
                properties: { id, name: String(f.properties?.name ?? id).slice(0, 120), source: f.properties?.source ?? null },
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

module.exports = {
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
}
