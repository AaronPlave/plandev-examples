// Map drawing shared by the embedded card and the standalone tool panel: everything here is driven by
// what a plan view carries (features with a basis, overlays, position tracks), never by a mission.
import Map_ from '@basics/Map_/Map_'

export const root = () => (window.mmgisglobal.ROOT_PATH ? `${window.mmgisglobal.ROOT_PATH}/` : '')

export async function api(path, body) {
    const res = await fetch(`${root()}${path}`, {
        method: body ? 'POST' : 'GET',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json()
    if (json.status !== 'success') throw new Error(json.message || `${path} failed`)
    return json.body
}

export const coordsOf = (g) =>
    g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' || g.type === 'MultiPoint' ? g.coordinates : g.type === 'Polygon' ? g.coordinates[0] : g.coordinates.flat()

// ---------- gridded data products (e.g. the terrain a mission plans on) ----------

const grids = new Map() // dataset id → { grid, layer }

function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function colorAt(stops, v) {
    if (v <= stops[0][0]) return hexToRgb(stops[0][1])
    for (let i = 1; i < stops.length; i++) {
        if (v <= stops[i][0]) {
            const [a, b] = [hexToRgb(stops[i - 1][1]), hexToRgb(stops[i][1])]
            const f = (v - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0])
            return a.map((x, k) => Math.round(x + f * (b[k] - x)))
        }
    }
    return hexToRgb(stops.at(-1)[1])
}

/**
 * Show or hide a plan view's overlay ({ datasetId, url }). The grid is fetched once per dataset id and
 * drawn one pixel per cell, stretched over its bounds (cells are square in degrees; over a region this
 * small the map projection's distortion within the image is under a pixel).
 */
export async function setGridOverlay(overlay, on, opacity = 0.6) {
    let g = grids.get(overlay.datasetId)
    if (!on) {
        if (g?.layer) Map_.map.removeLayer(g.layer)
        return g?.grid ?? null
    }
    if (!g) {
        const grid = await api(overlay.url)
        const canvas = document.createElement('canvas')
        canvas.width = grid.ncols
        canvas.height = grid.nrows
        const c = canvas.getContext('2d')
        const img = c.createImageData(grid.ncols, grid.nrows)
        grid.values.forEach((v, i) => {
            if (v === grid.nodata) return
            const [r, gr, b] = colorAt(grid.stops, v)
            // Low values stay faint so the basemap reads through where the data says little.
            const f = Math.min(1, Math.max(0, (v - grid.stops[0][0]) / (grid.stops.at(-1)[0] - grid.stops[0][0])))
            img.data.set([r, gr, b, Math.round(255 * (0.25 + 0.75 * f))], i * 4)
        })
        c.putImageData(img, 0, 0)
        if (!Map_.map.getPane('plandevGrid')) Map_.map.createPane('plandevGrid').style.zIndex = 350 // above tiles, below vectors
        const bounds = [[grid.south, grid.west], [grid.south + grid.nrows * grid.cellDeg, grid.west + grid.ncols * grid.cellDeg]]
        g = { grid, layer: window.L.imageOverlay(canvas.toDataURL(), bounds, { pane: 'plandevGrid', interactive: false, className: 'plandevGrid' }) }
        grids.set(overlay.datasetId, g)
    }
    g.layer.setOpacity(opacity)
    if (!Map_.map.hasLayer(g.layer)) g.layer.addTo(Map_.map)
    return g.grid
}

/** Value of a shown grid at a map position, or null. */
export function gridValueAt(overlay, lat, lon) {
    const grid = grids.get(overlay.datasetId)?.grid
    if (!grid) return null
    const col = Math.floor((lon - grid.west) / grid.cellDeg)
    const row = grid.nrows - 1 - Math.floor((lat - grid.south) / grid.cellDeg)
    if (col < 0 || col >= grid.ncols || row < 0 || row >= grid.nrows) return null
    const v = grid.values[row * grid.ncols + col]
    return v === grid.nodata ? null : v
}

// ---------- position tracks ----------

/** Index of the last sample at or before t (samples sorted by time), or -1. */
export function sampleAt(samples, t) {
    let lo = 0
    let hi = samples.length - 1
    let found = -1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (samples[mid][0] <= t) {
            found = mid
            lo = mid + 1
        } else hi = mid - 1
    }
    return found
}

/** The position tracks of a view: one per tracked entity. */
export const entitiesOf = (view) => view?.positions ?? (view?.position ? [view.position] : [])

/** A small circle on the sphere: [lat, lng] vertices `angularDeg` of arc from the centre. Longitudes are not wrapped. */
export function capLatLngs(lon, lat, angularDeg) {
    const rad = Math.PI / 180
    const p = lat * rad
    const d = angularDeg * rad
    const out = []
    for (let b = 0; b < 360; b += 6) {
        const lat2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(b * rad))
        const lon2 = lon * rad + Math.atan2(Math.sin(b * rad) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(lat2))
        out.push([lat2 / rad, lon2 / rad])
    }
    return out
}
