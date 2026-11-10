// Embedded mode: MMGIS running inside a PlanDev plan's IFrame panel. Speaks PlanDev's narrow
// postMessage protocol (plandev.embed.v1): PlanDev sends plan/dataset/time/selection ids; this side
// fetches that plan's spatial view from the PlanDev backend plugin (with its own MMGIS session),
// shows it, and sends back time and activity selections made on the map.
//
// Only active when MMGIS is framed AND the parent's origin is listed in the PlanDev tool's
// `embedOrigins` variable. Nothing but ids and times crosses the bridge.
import L_ from '@basics/Layers_/Layers_'
import Map_ from '@basics/Map_/Map_'

const PROTOCOL = 'plandev.embed.v1'
const LAYER = 'plandev-embed'
const CLICK_PX = 12 // click within this many pixels of a position sample to move PlanDev's time cursor

const root = () => (window.mmgisglobal.ROOT_PATH ? `${window.mmgisglobal.ROOT_PATH}/` : '')

const state = {
    origin: null, // the PlanDev origin we accepted
    ctx: {}, // last context from PlanDev
    key: null, // `${planId}/${simulationDatasetId}` of the view on the map
    view: null,
    loading: null,
    marker: null,
    window: null,
    pill: null,
    applyingSelection: null, // feature selected because PlanDev asked; don't echo it back
}

function send(msg) {
    window.parent.postMessage({ protocol: PROTOCOL, ...msg }, state.origin)
}

async function api(path) {
    const res = await fetch(`${root()}${path}`, { credentials: 'same-origin' })
    const json = await res.json()
    if (json.status !== 'success') throw new Error(json.message || `${path} failed`)
    return json.body
}

// ---------- plan / dataset ----------

async function loadView(planId, simulationDatasetId) {
    const key = `${planId}/${simulationDatasetId}`
    if (key === state.key || key === state.loading) return
    state.loading = key
    pill(`Loading plan ${planId}…`)
    try {
        const q = simulationDatasetId != null ? `?simulationDatasetId=${simulationDatasetId}` : ''
        const view = await api(`api/plandev/plans/${planId}${q}`)
        if (state.loading !== key) return // superseded by a newer context
        state.view = view
        state.key = key
        await showFeatures(view)
        applyTime()
        applySelection(true)
        fitTo(view)
    } catch (e) {
        if (state.loading === key) {
            state.view = null
            state.key = key
            if (L_.layers.layer[LAYER]) L_.clearVectorLayer(LAYER)
            clearPosition()
            pill(`Plan ${planId}: ${e.message}`)
        }
    } finally {
        if (state.loading === key) state.loading = null
    }
}

async function showFeatures(view) {
    const fc = { type: 'FeatureCollection', features: view.features }
    if (L_.layers.data[LAYER]) {
        L_.clearVectorLayer(LAYER)
        if (fc.features.length) L_.updateVectorLayer(LAYER, fc)
        return
    }
    const { planId, simulationDatasetId } = view.provenance
    await window.mmgisAPI.addLayer({
        name: 'PlanDev (embedded plan)',
        uuid: LAYER,
        type: 'vector',
        url: new URL(`${root()}api/plandev/plans/${planId}/geojson${simulationDatasetId != null ? `?simulationDatasetId=${simulationDatasetId}` : ''}`, document.baseURI).href,
        controlled: false,
        visibility: true,
        initialOpacity: 1,
        radius: 6,
        kind: 'none',
        shape: 'none',
        demparser: '',
        layer3dType: 'clamped',
        tags: ['plandev'],
        legend: '',
        time: { enabled: false, type: 'requery', isRelative: true, current: '', start: '', end: '', startProp: '', endProp: '', format: '%Y-%m-%dT%H:%M:%SZ' },
        style: { className: 'plandevEmbed', color: '#00e5ff', fillColor: '#00e5ff', weight: 3, fillOpacity: 0.35, opacity: 1 },
        description: 'Simulated activities of the plan open in PlanDev. Follows PlanDev plan/simulation selection.',
        variables: { useKeyAsName: 'name' },
    })
}

function fitTo(view) {
    const pts = []
    for (const f of view.features) {
        if (!f.properties.context) pts.push(...coords(f.geometry)) // context geometry (e.g. surrounding track) doesn't drive the fit
    }
    if (pts.length) Map_.map.fitBounds(pts.map(([lo, la]) => [la, lo]), { padding: [40, 40], maxZoom: 9 })
    else if (view.position?.samples?.length) Map_.map.setView([view.position.samples[0][2], view.position.samples[0][1]], 3)
}

// ---------- time ----------

/** Index of the last sample at or before t (samples sorted by time), or -1. */
function sampleAt(samples, t) {
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

const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)

function clearPosition() {
    for (const k of ['marker', 'window']) {
        if (state[k]) Map_.map.removeLayer(state[k])
        state[k] = null
    }
}

function applyTime() {
    const view = state.view
    const t = state.ctx.timeMs
    const p = view?.position
    const where = view ? `Plan ${view.plan.id} rev ${view.provenance.planRevision} · sim dataset ${view.provenance.simulationDatasetId ?? '—'} · ${view.status}` : ''
    if (!p || !p.samples.length || t == null) {
        clearPosition()
        return pill(view ? `${where}${t == null ? ' · no time cursor set in PlanDev' : ''}` : 'Waiting for PlanDev…')
    }
    const i = sampleAt(p.samples, t)
    if (i < 0) {
        clearPosition()
        return pill(`${where} · ${fmt(t)} is before the simulation`)
    }
    const [st, lon, lat] = p.samples[i]
    const ll = [lat, lon]
    if (!state.marker) {
        state.marker = window.L.circleMarker(ll, { radius: 8, color: '#fff', weight: 2, fillColor: '#ff1744', fillOpacity: 1, interactive: false }).addTo(Map_.map)
    } else state.marker.setLatLng(ll)
    state.marker.bringToFront()
    if (!Map_.map.getBounds().pad(-0.05).contains(ll)) Map_.map.panTo(ll, { animate: false }) // follow, without changing zoom

    if (p.trackWindowMs) {
        // The sampled track around the cursor, so the current point reads against the trajectory.
        const a = sampleAt(p.samples, t - p.trackWindowMs)
        const b = sampleAt(p.samples, t + p.trackWindowMs)
        const parts = [[]]
        for (let k = Math.max(0, a); k <= b; k++) {
            const s = p.samples[k]
            const prev = parts[parts.length - 1].at(-1)
            if (prev && Math.abs(prev[1] - s[1]) > 180) parts.push([])
            parts[parts.length - 1].push([s[2], s[1]])
        }
        if (!state.window) state.window = window.L.polyline(parts, { color: '#ffea00', weight: 2, opacity: 0.8, interactive: false }).addTo(Map_.map)
        else state.window.setLatLngs(parts)
    }
    const inActivity = view.features.find((f) => f.properties.primary && f.properties.startMs <= t && t < f.properties.endMs)
    const sampleNote = p.hold === 'sample' ? `sample ${fmt(st)} UTC` : `since ${fmt(st)} UTC`
    pill(`${where}\n${p.label}: ${lat.toFixed(3)}°, ${lon.toFixed(3)}°E (${sampleNote})${inActivity ? ` · in ${inActivity.properties.name}` : ''}\n${p.note}`)
}

// ---------- selection ----------

function matches(f, ctx) {
    if (f.properties.simulationDatasetId !== ctx.simulationDatasetId) return false
    if (ctx.selectedSpanId != null) return f.properties.spanId === ctx.selectedSpanId
    if (ctx.selectedActivityDirectiveId != null) return f.properties.directiveId === ctx.selectedActivityDirectiveId
    return false
}

function applySelection(force) {
    const ctx = state.ctx
    const key = `${ctx.simulationDatasetId}/${ctx.selectedSpanId}/${ctx.selectedActivityDirectiveId}`
    if (!force && key === state.selectionKey) return
    state.selectionKey = key
    const all = state.view?.features.filter((x) => matches(x, ctx)) || []
    const f = all.find((x) => x.properties.primary) || all[0]
    if (!f || !L_.layers.layer[LAYER]) return
    state.applyingSelection = f.properties.fid
    window.mmgisAPI.selectFeature(LAYER, { key: 'fid', value: f.properties.fid })
    const lls = coords(f.geometry).map(([lo, la]) => [la, lo])
    const bounds = window.L.latLngBounds(lls)
    if (!Map_.map.getBounds().contains(bounds)) Map_.map.fitBounds(bounds, { padding: [60, 60], maxZoom: Math.max(Map_.map.getZoom(), 6) })
}

function coords(g) {
    return g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates[0] : g.coordinates.flat()
}

function onActiveFeature(e) {
    const af = e.detail?.activeFeature
    if (!af || L_.asLayerUUID(af.layerName) !== LAYER) return
    const p = af.feature?.properties || {}
    const echo = state.applyingSelection
    state.applyingSelection = null
    if (echo != null && echo === p.fid) return // the selection PlanDev just asked for; don't send it back
    if (p.simulationDatasetId !== state.ctx.simulationDatasetId) return // a stale feature: never cross datasets
    if (p.spanId != null || p.directiveId != null) send({ type: 'select', spanId: p.spanId ?? null, directiveId: p.spanId == null ? p.directiveId : null })
    if (Number.isFinite(p.startMs)) send({ type: 'setTime', timeMs: p.startMs })
}

function onMapClick(e) {
    // Clicking near the shown trajectory moves PlanDev's time cursor to that simulated sample.
    const p = state.view?.position
    if (!p?.samples.length || state.ctx.timeMs == null) return
    const t = state.ctx.timeMs
    const from = p.trackWindowMs ? sampleAt(p.samples, t - p.trackWindowMs) : 0
    const to = p.trackWindowMs ? sampleAt(p.samples, t + p.trackWindowMs) : p.samples.length - 1
    const click = Map_.map.latLngToContainerPoint(e.latlng)
    let best = null
    for (let k = Math.max(0, from); k <= to; k++) {
        const s = p.samples[k]
        const d = Map_.map.latLngToContainerPoint([s[2], s[1]]).distanceTo(click)
        if (d < CLICK_PX && (!best || d < best.d)) best = { d, t: s[0] }
    }
    if (best) send({ type: 'setTime', timeMs: best.t })
}

// ---------- status pill ----------

function pill(text) {
    if (!state.pill) {
        state.pill = document.createElement('div')
        state.pill.className = 'plandevEmbedPill'
        document.body.appendChild(state.pill)
    }
    state.pill.textContent = text
}

// ---------- wiring ----------

function onMessage(e) {
    if (e.source !== window.parent || e.origin !== state.origin) return
    const m = e.data
    if (!m || m.protocol !== PROTOCOL || m.type !== 'context') return
    const prev = state.ctx
    state.ctx = m
    if (m.planId == null) return pill('No plan open in PlanDev.')
    if (m.planId !== prev.planId || m.simulationDatasetId !== prev.simulationDatasetId || m.planRevision !== prev.planRevision) {
        // A new revision may not have been simulated yet; reload so the status says so.
        state.key = m.planRevision !== prev.planRevision ? null : state.key
        loadView(m.planId, m.simulationDatasetId)
    }
    if (state.view) {
        if (m.timeMs !== prev.timeMs) applyTime()
        applySelection(false)
    }
}

/** Called once at load. Does nothing unless framed by an origin listed in the tool's `embedOrigins`. */
export function initEmbed() {
    if (window.parent === window) return
    const wait = setInterval(() => {
        if (!Map_.map || !L_.tools) return
        clearInterval(wait)
        const allowed = L_.getToolVars('plandev')?.embedOrigins
        if (!Array.isArray(allowed) || !allowed.length) return
        // The parent's origin is only known from a message; accept the first one from an allowed origin.
        const hello = (e) => {
            if (e.source !== window.parent || !allowed.includes(e.origin) || e.data?.protocol !== PROTOCOL) return
            window.removeEventListener('message', hello)
            state.origin = e.origin
            window.addEventListener('message', onMessage)
            onMessage(e)
        }
        window.addEventListener('message', hello)
        document.addEventListener('newActiveFeature', onActiveFeature)
        Map_.map.on('click', onMapClick)
        pill('Waiting for PlanDev…')
        // PlanDev posts on iframe load, likely before this listener existed: ask again.
        for (const o of allowed) window.parent.postMessage({ protocol: PROTOCOL, type: 'ready' }, o)
    }, 250)
}
