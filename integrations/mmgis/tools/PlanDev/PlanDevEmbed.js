// Embedded mode: MMGIS running inside a PlanDev plan's IFrame panel. Speaks PlanDev's narrow
// postMessage protocol (plandev.embed.v1): PlanDev sends plan/dataset/time/selection ids; this side
// fetches that plan's spatial view from the PlanDev backend plugin (with its own MMGIS session),
// draws it, and sends back time and activity selections made on the map.
//
// PlanDev owns the plan, the simulation dataset, the time cursor and the selection; nothing here picks
// them. The map shows the open plan without any tool being opened, and one small card carries what a
// planner needs beside it: where the vehicle is, what is selected, the headline consequences, an
// alternative to compare with, and a way into spatial editing.
//
// Only active when MMGIS is framed AND the parent's origin is listed in the PlanDev tool's
// `embedOrigins` variable. Nothing but ids and times crosses the bridge.
import React, { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import L_ from '@basics/Layers_/Layers_'
import Map_ from '@basics/Map_/Map_'

import { api, capLatLngs, coordsOf, entitiesOf, gridValueAt, sampleAt, setGridOverlay } from './PlanDevMap'

const PROTOCOL = 'plandev.embed.v1'
const CLICK_PX = 12 // click within this many pixels of a position sample to move PlanDev's time cursor
const COLOR = '#00e5ff'
const OTHER_COLOR = '#ff9100' // the plan being compared with
const ALSO_COLOR = '#d500f9' // entities of a second plan shown alongside
const POLL_MS = 3000
const gridInfo = {} // overlay dataset id → { stops, unit }, known once the grid has loaded

const S = {
    origin: null, // the PlanDev origin we accepted
    ctx: {}, // last context from PlanDev
    key: null, // `${planId}/${simulationDatasetId}` of the view on the map
    view: null,
    loading: null,
    message: 'Waiting for PlanDev…',
    config: null, // the mission's parameters and target rules
    plans: [],
    selected: null, // fid of the selected feature
    follow: false, // pan to keep the vehicle in view; off so the map can be explored freely
    chrome: false, // show the full MMGIS interface
    collapsed: false,
    overlaysOn: {}, // overlay id → shown
    compareBy: {}, // planId → the plan it is compared with (null: none)
    other: null, // { planId, view } of the compared plan
    also: null, // view of a second plan whose tracked entities are shown too (iframe URL: plandevAlso=<plan id>)
    run: null, // { planId, fromDs }: a run started here whose simulation PlanDev should show when it is ready
    edit: null, // { sites, regions, params, tool, drawing, answer, busy, error }
    fittedPlanId: null,
    layer: null,
    otherLayer: null,
    editLayer: null,
    answerLayer: null,
    markers: [],
    hover: null,
}
const SAVED = ['follow', 'chrome', 'collapsed', 'overlaysOn', 'compareBy', 'run']
try {
    Object.assign(S, JSON.parse(sessionStorage.getItem('plandevEmbed') || '{}'))
} catch {}

let version = 0
const listeners = new Set()
function emit() {
    version++
    try {
        sessionStorage.setItem('plandevEmbed', JSON.stringify(Object.fromEntries(SAVED.map((k) => [k, S[k]]))))
    } catch {}
    listeners.forEach((l) => l())
    document.dispatchEvent(new CustomEvent('plandev:embed', { detail: embedded() }))
}

const missionKey = () => L_.getToolVars('plandev')?.mission || null

/** For the PlanDev tool panel: whether MMGIS is embedded in a PlanDev plan, and that plan's context. */
export function embedded() {
    return S.origin ? { ctx: S.ctx, view: S.view } : null
}

/** Ask PlanDev to open another plan (keeps PlanDev's current view). */
export function openPlanInPlanDev(planId) {
    if (S.origin) send({ type: 'openPlan', planId })
}

/**
 * Ask PlanDev to show one of the open plan's simulations, e.g. the one a run started from the map just
 * produced (PlanDev only switches by itself for simulations its own UI started). PlanDev stays the
 * authority: it checks the dataset is the open plan's, and sends the new context back.
 */
export function showSimulationInPlanDev(simulationDatasetId) {
    if (S.origin) send({ type: 'showSimulation', simulationDatasetId })
}

function send(msg) {
    window.parent.postMessage({ protocol: PROTOCOL, ...msg }, S.origin)
}

const fmtTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
const num = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—')
const query = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)))

// ---------- plan / dataset ----------

async function loadView(planId, simulationDatasetId, force) {
    const key = `${planId}/${simulationDatasetId}`
    if (!force && (key === S.key || key === S.loading)) return
    S.loading = key
    if (S.view?.plan.id !== planId) {
        S.message = `Loading plan ${planId}…`
        emit()
    }
    try {
        const view = await api(`api/plandev/plans/${planId}?${query({ simulationDatasetId, mission: missionKey() })}`)
        if (S.loading !== key) return // superseded by a newer context
        const samePlan = S.view?.plan.id === planId
        S.view = view
        S.key = key
        S.message = null
        if (!samePlan) {
            S.selected = null
            S.edit = null
            drawEdit()
        }
        if (!S.config || S.config.mission.key !== view.mission.key) {
            S.config = await api(`api/plandev/missions/${view.mission.key}/config`)
            api(`api/plandev/missions/${view.mission.key}/plans`).then((p) => {
                S.plans = p
                emit()
            }, () => {})
        }
        draw()
        syncOverlays()
        // Compare with the plan this one was derived from, unless another (or none) was chosen.
        const want = planId in S.compareBy ? S.compareBy[planId] : view.derivedFrom?.sameModel ? view.derivedFrom.id : null
        loadOther(want)
        loadAlso()
        applySelection(true)
        applyTime()
        // Fit once per plan, unless the embedding URL pins the map view (MMGIS mapLat/mapLon/mapZoom).
        if (S.fittedPlanId !== planId && !new URLSearchParams(location.search).has('mapLat')) fit(view)
        S.fittedPlanId = planId
        followRun(view)
    } catch (e) {
        if (S.loading !== key) return
        S.view = null
        S.key = key
        draw()
        S.message = /unauthori[sz]ed/i.test(e.message) ? `Sign in to MMGIS to show PlanDev plan ${planId} here.` : `Plan ${planId}: ${e.message}`
    } finally {
        if (S.loading === key) S.loading = null
        emit()
    }
}

/** While a run is in flight, keep reading the plan; when its simulation is ready, ask PlanDev to show it. */
let pollTimer = null
function followRun(view) {
    clearTimeout(pollTimer)
    const mine = S.run?.planId === view.plan.id
    const ds = view.provenance.simulationDatasetId
    if (view.status === 'running' || (mine && (view.status !== 'complete' || ds === S.run.fromDs))) {
        if (mine && /failed/.test(view.status)) S.run = null
        else pollTimer = setTimeout(() => S.ctx.planId === view.plan.id && loadView(view.plan.id, S.ctx.simulationDatasetId, true), POLL_MS)
        return
    }
    if (mine) {
        S.run = null
        if (ds !== S.ctx.simulationDatasetId) showSimulationInPlanDev(ds)
    }
}

async function loadOther(planId) {
    if (planId == null || planId === S.view?.plan.id) {
        S.other = null
        drawOther()
        return emit()
    }
    try {
        const view = await api(`api/plandev/plans/${planId}?${query({ mission: missionKey() })}`)
        if (S.view && (S.view.plan.id in S.compareBy ? S.compareBy[S.view.plan.id] : S.view.derivedFrom?.id) !== planId) return
        S.other = { planId, view }
    } catch {
        S.other = null
    }
    drawOther()
    applyTime()
    emit()
}

/**
 * A second plan's tracked entities on the same map and time cursor, e.g. a relay orbiter's plan beside a
 * rover's. Any mission with an adapter, as long as it is on the same body.
 */
async function loadAlso() {
    const id = Number(new URLSearchParams(location.search).get('plandevAlso'))
    if (!id || S.also?.plan.id === id || !S.view) return
    try {
        const view = await api(`api/plandev/plans/${id}`)
        if (view.provenance.body !== S.view.provenance.body) throw new Error(`plan ${id} is on ${view.provenance.body}, not ${S.view.provenance.body}`)
        S.also = view
    } catch (e) {
        console.warn(`[plandev] plandevAlso: ${e.message}`)
    }
    applyTime()
    emit()
}

function fit(view) {
    const pts = []
    for (const f of view.features) if (!f.properties.context) pts.push(...coordsOf(f.geometry)) // context geometry (e.g. surrounding track) doesn't drive the fit
    if (pts.length) Map_.map.fitBounds(pts.map(([lo, la]) => [la, lo]), { padding: [60, 60], maxZoom: 13 })
    else {
        const s = entitiesOf(view)[0]?.samples[0]
        if (s) Map_.map.setView([s[2], s[1]], 3)
    }
}

// ---------- drawing ----------

/** A feature's style now: its basis (from the server), dimmed if it has not started yet, emphasised if selected or in progress. */
function styleOf(f, t) {
    const p = f.properties
    const base = { color: COLOR, fillColor: COLOR, weight: 3, opacity: 1, fillOpacity: 0.35, ...p.style }
    const timed = Number.isFinite(p.startMs) && t != null
    const upcoming = timed && p.startMs > t
    const current = timed && p.startMs <= t && p.endMs != null && t < p.endMs
    if (upcoming) Object.assign(base, { opacity: base.opacity * 0.4, fillOpacity: base.fillOpacity * 0.4 })
    if (current && p.basis === 'simulated') base.weight += 2
    if (p.fid === S.selected) Object.assign(base, { color: '#ffffff', weight: base.weight + 2, opacity: 1, fillOpacity: Math.max(base.fillOpacity, 0.6) })
    if (p.kind === 'site' && p.scheduled === false) Object.assign(base, { opacity: 0.6, dashArray: '2 4' })
    return base
}

function draw() {
    if (S.layer) Map_.map.removeLayer(S.layer)
    S.layer = null
    for (const m of S.markers) for (const l of [m.marker, m.window, m.cap]) if (l) Map_.map.removeLayer(l)
    S.markers = []
    if (!S.view) return
    const t = S.ctx.timeMs
    S.layer = window.L.geoJSON(
        { type: 'FeatureCollection', features: S.view.features },
        {
            style: (f) => styleOf(f, t),
            pointToLayer: (f, ll) => window.L.circleMarker(ll, { radius: f.properties.basis === 'input' ? 7 : 5 }),
            onEachFeature: (f, l) => {
                // A feature the adapter labels (a site, say) carries its label on the map; the rest name themselves on hover.
                if (f.properties.label) l.bindTooltip(f.properties.label, { permanent: true, direction: 'right', offset: [8, 0], className: 'pe_label' })
                else l.bindTooltip(f.properties.name, { sticky: true })
                l.on('click', (e) => {
                    window.L.DomEvent.stopPropagation(e)
                    if (!S.edit) onFeatureClick(f)
                })
            },
        },
    ).addTo(Map_.map)
}

function restyle() {
    S.layer?.eachLayer((l) => l.setStyle(styleOf(l.feature, S.ctx.timeMs)))
}

/** The compared plan's route, in another colour and not clickable: lines only, so it reads as "the other way". */
function drawOther() {
    if (S.otherLayer) Map_.map.removeLayer(S.otherLayer)
    S.otherLayer = null
    if (!S.other) return
    const features = S.other.view.features.filter((f) => /LineString/.test(f.geometry.type) && ['simulated', 'planned', 'illustrative'].includes(f.properties.basis) && !f.properties.context)
    S.otherLayer = window.L.geoJSON(
        { type: 'FeatureCollection', features },
        {
            interactive: false,
            style: (f) => ({ weight: 3, opacity: 0.95, ...f.properties.style, color: OTHER_COLOR, ...(f.properties.basis === 'simulated' && { dashArray: '6 5' }) }),
        },
    ).addTo(Map_.map)
    S.layer?.bringToFront()
}

async function syncOverlays() {
    for (const o of S.view?.overlays || []) {
        if (!(o.id in S.overlaysOn)) S.overlaysOn[o.id] = true
        const grid = await setGridOverlay(o, S.overlaysOn[o.id]).catch(() => null)
        if (grid) gridInfo[o.datasetId] = { stops: grid.stops, unit: grid.unit }
    }
    emit()
}

// ---------- time ----------

function applyTime() {
    restyle()
    const t = S.ctx.timeMs
    const tracks = [
        ...entitiesOf(S.view).map((e) => ({ e, color: '#ff1744' })),
        ...entitiesOf(S.also).map((e) => ({ e, color: ALSO_COLOR, from: S.also.plan })),
        ...entitiesOf(S.other?.view).map((e) => ({ e, color: OTHER_COLOR, other: true })),
    ]
    tracks.forEach(({ e, color, other, from }, i) => {
        const m = (S.markers[i] ??= {})
        const k = t == null ? -1 : sampleAt(e.samples, t)
        m.sample = k < 0 ? null : e.samples[k]
        m.entity = e
        m.other = !!other
        m.from = from
        m.color = color
        if (k < 0) {
            for (const n of ['marker', 'window', 'cap']) {
                if (m[n]) Map_.map.removeLayer(m[n])
                m[n] = null
            }
            return
        }
        const [, lon, lat, capDeg] = e.samples[k]
        const ll = [lat, lon]
        if (!m.marker) m.marker = window.L.circleMarker(ll, { radius: other ? 6 : 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, interactive: false }).addTo(Map_.map)
        else m.marker.setLatLng(ll)
        m.marker.bringToFront()
        if (!other && i === 0 && S.follow && !Map_.map.getBounds().pad(-0.1).contains(ll)) Map_.map.panTo(ll, { animate: false }) // follow, without changing zoom
        // A region that moves with the entity (e.g. where an orbiter is above the horizon), from the same sample.
        if (Number.isFinite(capDeg)) {
            const ring = capLatLngs(lon, lat, capDeg)
            if (!m.cap) m.cap = window.L.polygon(ring, { color, weight: 1.5, fillOpacity: 0.12, dashArray: '8 6', interactive: false }).addTo(Map_.map)
            else m.cap.setLatLngs(ring)
        }
        if (e.trackWindowMs) {
            // The sampled track around the cursor, so the current point reads against the trajectory.
            const parts = [[]]
            for (let j = Math.max(0, sampleAt(e.samples, t - e.trackWindowMs)); j <= sampleAt(e.samples, t + e.trackWindowMs); j++) {
                const s = e.samples[j]
                const prev = parts.at(-1).at(-1)
                if (prev && Math.abs(prev[1] - s[1]) > 180) parts.push([])
                parts.at(-1).push([s[2], s[1]])
            }
            if (!m.window) m.window = window.L.polyline(parts, { color: '#ffea00', weight: 2, opacity: 0.8, interactive: false }).addTo(Map_.map)
            else m.window.setLatLngs(parts)
        }
    })
    for (const m of S.markers.splice(tracks.length)) for (const l of [m.marker, m.window, m.cap]) if (l) Map_.map.removeLayer(l)
}

// ---------- selection ----------

function matches(f, ctx) {
    if (f.properties.simulationDatasetId !== ctx.simulationDatasetId && f.properties.simulationDatasetId != null) return false
    if (ctx.selectedSpanId != null) return f.properties.spanId === ctx.selectedSpanId
    if (ctx.selectedActivityDirectiveId != null) return f.properties.directiveId === ctx.selectedActivityDirectiveId
    return false
}

let selectionKey = null
function applySelection(force) {
    const ctx = S.ctx
    const key = `${ctx.simulationDatasetId}/${ctx.selectedSpanId}/${ctx.selectedActivityDirectiveId}`
    if (!force && key === selectionKey) return
    selectionKey = key
    const all = S.view?.features.filter((x) => matches(x, ctx)) || []
    const f = all.find((x) => x.properties.primary) || all[0]
    if (!f) {
        // PlanDev cleared its selection: drop ours if it was an activity (keep a site or analysis point).
        const cur = S.view?.features.find((x) => x.properties.fid === S.selected)
        if (cur && (cur.properties.spanId != null || cur.properties.directiveId != null)) S.selected = null
        return restyle()
    }
    S.selected = f.properties.fid
    restyle()
    const bounds = window.L.latLngBounds(coordsOf(f.geometry).map(([lo, la]) => [la, lo]))
    if (!Map_.map.getBounds().contains(bounds)) Map_.map.fitBounds(bounds, { padding: [80, 80], maxZoom: Math.max(Map_.map.getZoom(), 6) })
}

function onFeatureClick(f) {
    const p = f.properties
    S.selected = p.fid
    restyle()
    emit()
    if (p.simulationDatasetId != null && p.simulationDatasetId !== S.ctx.simulationDatasetId) return // a stale feature: never cross datasets
    if (p.spanId != null || p.directiveId != null) send({ type: 'select', spanId: p.spanId ?? null, directiveId: p.spanId == null ? p.directiveId : null })
    if (Number.isFinite(p.startMs)) send({ type: 'setTime', timeMs: p.startMs })
}

function onMapClick(e) {
    if (S.edit) return editClick(e)
    // Clicking near the shown trajectory moves PlanDev's time cursor to that simulated sample.
    const p = entitiesOf(S.view)[0]
    if (!p?.samples.length) return
    const t = S.ctx.timeMs
    const from = p.trackWindowMs && t != null ? sampleAt(p.samples, t - p.trackWindowMs) : 0
    const to = p.trackWindowMs && t != null ? sampleAt(p.samples, t + p.trackWindowMs) : p.samples.length - 1
    const click = Map_.map.latLngToContainerPoint(e.latlng)
    let best = null
    for (let k = Math.max(0, from); k <= to; k++) {
        const s = p.samples[k]
        const d = Map_.map.latLngToContainerPoint([s[2], s[1]]).distanceTo(click)
        if (d < CLICK_PX && (!best || d < best.d)) best = { d, t: s[0] }
    }
    if (best) send({ type: 'setTime', timeMs: best.t })
}

function onMouseMove(e) {
    const o = (S.view?.overlays || []).find((x) => S.overlaysOn[x.id])
    const v = o ? gridValueAt(o, e.latlng.lat, e.latlng.lng) : null
    const next = v == null ? null : { name: o.name, value: v, unit: gridInfo[o.datasetId]?.unit ?? '' }
    if (next?.value !== S.hover?.value) {
        S.hover = next
        emit()
    }
}

// ---------- spatial editing: inputs for the mission's goals, edited on the map ----------

function startEdit() {
    const inputs = S.view.inputs
    const t = S.config.targets
    const feats = inputs?.targets.features || []
    S.edit = {
        sites: feats.filter((f) => f.geometry.type === 'Point').map((f) => ({ id: f.id, name: f.properties?.name ?? f.id, priority: f.properties?.priority ?? t.priority?.default, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })),
        regions: feats.filter((f) => f.geometry.type === 'Polygon').map((f) => ({ id: f.id, name: f.properties?.name ?? f.id, ring: f.geometry.coordinates[0].slice(0, -1) })),
        params: { ...Object.fromEntries(S.config.params.map((p) => [p.key, p.default])), ...inputs?.params },
        tool: 'move',
        drawing: null,
        answer: null,
        busy: false,
        error: null,
    }
    drawEdit()
    emit()
}

function stopEdit() {
    S.edit = null
    drawEdit()
    emit()
}

const editTargets = () => ({
    type: 'FeatureCollection',
    features: [
        ...S.edit.sites.map((s) => ({ type: 'Feature', id: s.id, properties: { name: s.name, ...(s.priority != null && { priority: s.priority }) }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })),
        ...S.edit.regions.map((r) => ({ type: 'Feature', id: r.id, properties: { name: r.name }, geometry: { type: 'Polygon', coordinates: [[...r.ring, r.ring[0]]] } })),
    ],
})

function drawEdit() {
    for (const k of ['editLayer', 'answerLayer']) {
        if (S[k]) Map_.map.removeLayer(S[k])
        S[k] = null
    }
    Map_.map.getContainer().style.cursor = S.edit && S.edit.tool !== 'move' ? 'crosshair' : ''
    if (!S.edit) return
    const L = window.L
    const g = (S.editLayer = L.layerGroup().addTo(Map_.map))
    for (const r of S.edit.regions) L.polygon(r.ring.map(([lo, la]) => [la, lo]), { color: '#ff5252', weight: 2, fillOpacity: 0.25, interactive: false }).bindTooltip(r.name).addTo(g)
    if (S.edit.drawing?.length) L.polyline(S.edit.drawing.map(([lo, la]) => [la, lo]), { color: '#ff5252', weight: 2, dashArray: '4 4', interactive: false }).addTo(g)
    for (const s of S.edit.sites) {
        const m = L.marker([s.lat, s.lon], { draggable: true, icon: L.divIcon({ className: 'plandevEditSite', html: `<span>${s.priority ?? ''}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }) })
        m.bindTooltip(`${s.name} — drag to move`)
        m.on('dragend', () => {
            const ll = m.getLatLng()
            Object.assign(s, { lat: +ll.lat.toFixed(6), lon: +ll.lng.toFixed(6) })
            S.edit.answer = null
            emit()
        })
        m.addTo(g)
    }
    if (S.edit.answer?.features.length)
        S.answerLayer = L.geoJSON(
            { type: 'FeatureCollection', features: S.edit.answer.features },
            { interactive: false, style: (f) => ({ color: '#ffea00', weight: 2, fillOpacity: 0.1, ...f.properties.style }), pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 4 }) },
        ).addTo(Map_.map)
}

function editClick(e) {
    const ed = S.edit
    const p = [+e.latlng.lng.toFixed(6), +e.latlng.lat.toFixed(6)]
    if (ed.tool === 'site') {
        const n = ed.sites.length + 1
        ed.sites.push({ id: `site-${Date.now().toString(36)}`, name: `New site ${n}`, priority: S.config.targets.priority?.default, lon: p[0], lat: p[1] })
        ed.tool = 'move'
    } else if (ed.tool === 'region') ed.drawing = [...(ed.drawing || []), p]
    else return
    ed.answer = null
    drawEdit()
    emit()
}

function finishRegion() {
    const ed = S.edit
    if (ed.drawing?.length >= 3) ed.regions.push({ id: `region-${Date.now().toString(36)}`, name: `Region ${ed.regions.length + 1}`, ring: ed.drawing })
    ed.drawing = null
    ed.tool = 'move'
    drawEdit()
    emit()
}

async function editAction(fn) {
    S.edit.busy = true
    S.edit.error = null
    emit()
    try {
        await fn()
    } catch (e) {
        if (S.edit) S.edit.error = e.message
    }
    if (S.edit) S.edit.busy = false
    emit()
}

/** Read-only: ask the mission's evaluation about the edited points and regions against the open plan. */
const ask = () =>
    editAction(async () => {
        const v = S.view
        S.edit.answer = await api(`api/plandev/plans/${v.plan.id}/evaluate`, { mission: v.mission.key, simulationDatasetId: v.provenance.simulationDatasetId, targets: editTargets(), params: {} })
        drawEdit()
    })

/**
 * Schedule and simulate the edited inputs. On a plan that is not a working branch this branches it first
 * (the plan itself is never changed) and PlanDev opens the branch; on a working branch it re-runs in place.
 */
const replan = () =>
    editAction(async () => {
        const v = S.view
        const body = { mission: v.mission.key, targets: editTargets(), params: S.edit.params, expectedRevision: v.plan.revision }
        if (v.exploring) {
            await api(`api/plandev/plans/${v.plan.id}/update`, body)
            S.run = { planId: v.plan.id, fromDs: v.provenance.simulationDatasetId }
            S.edit = null
            drawEdit()
            loadView(v.plan.id, S.ctx.simulationDatasetId, true)
        } else {
            const r = await api(`api/plandev/plans/${v.plan.id}/explore`, body)
            S.run = { planId: r.planId, fromDs: null }
            S.compareBy[r.planId] = v.plan.id
            S.edit = null
            drawEdit()
            emit()
            openPlanInPlanDev(r.planId)
        }
    })

async function keep() {
    await api(`api/plandev/plans/${S.view.plan.id}/keep`, {})
    loadView(S.view.plan.id, S.ctx.simulationDatasetId, true)
}

// ---------- the card ----------

const useS = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => version)

function Delta({ m, other }) {
    const b = other?.find((x) => x.key === m.key)?.value
    if (typeof b !== 'number' || typeof m.value !== 'number') return null
    const d = m.value - b
    if (Math.abs(d) < 10 ** -(m.digits ?? 1) / 2) return <span className='pe_muted'> =</span>
    const good = m.better ? (m.better === 'low' ? d < 0 : d > 0) : null
    return <span className={good == null ? 'pe_muted' : good ? 'pe_good' : 'pe_bad'}> {d > 0 ? '+' : '−'}{Math.abs(d).toFixed(m.digits ?? 1)}</span>
}

function Selected({ view, f }) {
    const p = f.properties
    const hits = (view.constraints || []).flatMap((c) => c.windows.filter((w) => Number.isFinite(p.startMs) && p.endMs != null && w.startMs < p.endMs && w.endMs > p.startMs).map((w) => ({ c, w })))
    return (
        <div className='pe_section'>
            <div className='pe_title'>
                {p.name}
                <button className='pe_x' title='Clear selection' onClick={() => { S.selected = null; restyle(); emit() }}>×</button>
            </div>
            <div className='pe_muted'>
                {p.basis}
                {Number.isFinite(p.startMs) && ` · ${fmtTime(p.startMs)}${p.endMs != null && p.endMs !== p.startMs ? ` – ${fmtTime(p.endMs).slice(11)}` : ''} UTC`}
            </div>
            {(p.details || []).map(([k, v]) => (
                <div key={k} className='pe_kv'>
                    <span>{k}</span>
                    <span>{v}</span>
                </div>
            ))}
            {hits.map(({ c, w }) => (
                <div key={`${c.name}${w.startMs}`} className='pe_bad'>
                    ⚠ {c.name}: {fmtTime(w.startMs).slice(5)} – {fmtTime(w.endMs).slice(11)}
                </div>
            ))}
        </div>
    )
}

function Editor({ view }) {
    const ed = S.edit
    const t = S.config.targets
    const set = (fn) => { fn(); ed.answer = null; drawEdit(); emit() }
    const canPoint = t.types.includes('Point')
    const canRegion = t.types.includes('Polygon')
    return (
        <div className='pe_section pe_edit'>
            <div className='pe_title'>{view.exploring ? 'Change this alternative' : 'Try a change'}</div>
            <div className='pe_muted'>
                {view.exploring ? `Re-plans alternative #${view.plan.id} in place.` : `Plan #${view.plan.id} is not changed: the result is a new alternative you can keep or discard.`}
            </div>
            <div className='pe_tools'>
                <button className={ed.tool === 'move' ? 'on' : ''} onClick={() => set(() => { ed.tool = 'move'; ed.drawing = null })}>Move</button>
                {canPoint && <button className={ed.tool === 'site' ? 'on' : ''} onClick={() => set(() => { ed.tool = 'site'; ed.drawing = null })}>+ {t.roles?.Point ?? 'Point'}</button>}
                {canRegion && <button className={ed.tool === 'region' ? 'on' : ''} onClick={() => set(() => { ed.tool = 'region'; ed.drawing = [] })}>+ {t.roles?.Polygon ?? 'Region'}</button>}
                {ed.tool === 'region' && <button disabled={(ed.drawing?.length || 0) < 3} onClick={finishRegion}>Finish</button>}
            </div>
            <div className='pe_muted'>
                {ed.tool === 'site' ? 'Click the map to place it.' : ed.tool === 'region' ? `Click the map to add corners (${ed.drawing?.length || 0}), then Finish.` : 'Drag a marker to move it.'}
            </div>
            <div className='pe_list'>
                {ed.sites.map((s) => (
                    <div key={s.id} className='pe_row'>
                        <input value={s.name} maxLength={60} onChange={(e) => set(() => { s.name = e.target.value })} />
                        {t.priority && (
                            <select title='Priority' value={s.priority} onChange={(e) => set(() => { s.priority = Number(e.target.value) })}>
                                {Array.from({ length: t.priority.max - t.priority.min + 1 }, (_, i) => t.priority.min + i).map((n) => (
                                    <option key={n} value={n}>P{n}</option>
                                ))}
                            </select>
                        )}
                        <button className='pe_x' title='Remove' onClick={() => set(() => { ed.sites = ed.sites.filter((x) => x !== s) })}>×</button>
                    </div>
                ))}
                {ed.regions.map((r) => (
                    <div key={r.id} className='pe_row'>
                        <input value={r.name} maxLength={60} onChange={(e) => set(() => { r.name = e.target.value })} />
                        <span className='pe_muted'>{t.roles?.Polygon ?? 'region'}</span>
                        <button className='pe_x' title='Remove' onClick={() => set(() => { ed.regions = ed.regions.filter((x) => x !== r) })}>×</button>
                    </div>
                ))}
            </div>
            <div className='pe_params'>
                {S.config.params.map((p) => [
                    <label key={`${p.key}l`}>{p.label}{p.unit ? ` (${p.unit})` : ''}</label>,
                    p.type === 'enum' ? (
                        <select key={p.key} value={ed.params[p.key]} onChange={(e) => set(() => { ed.params[p.key] = e.target.value })}>
                            {p.options.map((o) => <option key={o}>{o}</option>)}
                        </select>
                    ) : (
                        <input key={p.key} type='number' min={p.min} max={p.max} value={ed.params[p.key]} onChange={(e) => set(() => { ed.params[p.key] = e.target.value })} />
                    ),
                ])}
            </div>
            {ed.error && <div className='pe_bad'>{ed.error}</div>}
            {ed.answer && (
                <div className='pe_answer'>
                    <div className='pe_muted'>Against plan #{view.plan.id} as simulated (nothing was changed):</div>
                    {ed.answer.table.rows.map((r) => (
                        <div key={r.name} className='pe_kv'>
                            <span>{r.name}</span>
                            <span>{r.result}</span>
                        </div>
                    ))}
                </div>
            )}
            <div className='pe_actions'>
                <button className='primary' disabled={ed.busy || !(ed.sites.length + ed.regions.length)} onClick={replan}>{ed.busy ? 'Working…' : view.exploring ? 'Re-plan' : 'Plan alternative'}</button>
                {S.config.evaluation && <button disabled={ed.busy || !(ed.sites.length + ed.regions.length) || view.simulation?.status !== 'success'} onClick={ask} title='Read-only: check these points and regions against the plan as simulated'>Check current plan</button>}
                <button disabled={ed.busy} onClick={stopEdit}>Cancel</button>
            </div>
        </div>
    )
}

function Card() {
    useS()
    const view = S.view
    if (!view) return <div className='pe_card'><div className='pe_muted'>{S.message}</div></div>
    const t = S.ctx.timeMs
    const sel = view.features.find((f) => f.properties.fid === S.selected)
    const now = t != null && view.features.find((f) => f.properties.primary && f.properties.startMs <= t && f.properties.endMs != null && t < f.properties.endMs)
    const violations = (view.constraints || []).reduce((n, c) => n + c.windows.length + c.errors.length, 0)
    const otherViolations = S.other?.view.constraints ? S.other.view.constraints.reduce((n, c) => n + c.windows.length + c.errors.length, 0) : null
    const headline = view.summary.filter((m) => m.headline)
    const metrics = headline.length ? headline : view.summary.slice(0, 6)
    const running = view.status === 'running' || S.run?.planId === view.plan.id
    const state = running ? 'Scheduling and simulating…'
        : view.status === 'complete' ? null
        : view.status === 'stale' ? `Showing a simulation of an earlier revision (${view.provenance.simulatedPlanRevision}); re-simulate in PlanDev`
        : view.status === 'not simulated' ? 'Not simulated: planned geometry only'
        : view.status
    const compareId = view.plan.id in S.compareBy ? S.compareBy[view.plan.id] : view.derivedFrom?.sameModel ? view.derivedFrom.id : null
    return (
        <div className='pe_card'>
            <div className='pe_head'>
                <span className='pe_swatch' style={{ background: COLOR }} />
                <b title={view.plan.name}>{view.plan.name.replace(/ · from #\d+ · /, ' · ')}</b>
                {view.exploring && <span className='pe_badge' title='An alternative being explored: still an ordinary PlanDev plan'>alternative</span>}
                <button className='pe_x' title={S.collapsed ? 'Expand' : 'Collapse'} onClick={() => { S.collapsed = !S.collapsed; emit() }}>{S.collapsed ? '▾' : '▴'}</button>
            </div>
            {state && <div className={running ? 'pe_run' : 'pe_warn'}>{state}</div>}
            {S.markers.filter((m) => m.sample && !m.other).map((m, i) => (
                <div key={i} className='pe_pos' title={m.entity.note}>
                    <span className='pe_dot' style={{ background: m.color }} /> {m.entity.label}{m.from ? ` (plan #${m.from.id})` : ''}: {m.sample[2].toFixed(4)}°, {m.sample[1].toFixed(4)}°E
                    {i === 0 && now ? ` · ${now.properties.name}` : ''}
                    {i === 0 && <label><input type='checkbox' checked={S.follow} onChange={(e) => { S.follow = e.target.checked; applyTime(); emit() }} /> follow</label>}
                </div>
            ))}
            {t == null && entitiesOf(view).length > 0 && <div className='pe_muted'>Click the timeline’s time-cursor lane in PlanDev to place the vehicle.</div>}
            {!S.collapsed && (
                <>
                    {sel && !S.edit && <Selected view={view} f={sel} />}
                    {S.edit ? <Editor view={view} /> : (
                        <>
                            {view.simulation?.status === 'success' && !running && (
                                <div className='pe_section'>
                                    {S.other && <div className='pe_muted'>vs <span className='pe_swatch' style={{ background: OTHER_COLOR }} /> #{S.other.planId} {S.other.view.plan.name.replace(/ · from #\d+ · /, ' · ')}</div>}
                                    {metrics.map((m) => (
                                        <div key={m.key} className='pe_kv'>
                                            <span>{m.name}</span>
                                            <span>{num(m.value, m.digits)} {m.unit}{S.other && <Delta m={m} other={S.other.view.summary} />}</span>
                                        </div>
                                    ))}
                                    {view.constraints && (
                                        <div className='pe_kv'>
                                            <span>Constraint violations</span>
                                            <span className={violations ? 'pe_bad' : 'pe_good'}>
                                                {violations}
                                                {otherViolations != null && <Delta m={{ key: 'v', value: violations, digits: 0, better: 'low' }} other={[{ key: 'v', value: otherViolations }]} />}
                                            </span>
                                        </div>
                                    )}
                                    {(view.constraints || []).filter((c) => c.windows.length || c.errors.length).map((c) => (
                                        <div key={c.name} className='pe_bad pe_small' onClick={() => c.windows[0] && send({ type: 'setTime', timeMs: c.windows[0].startMs })} title='Go to the first violation'>
                                            ⚠ {c.name}{c.errors.length ? `: ${c.errors[0]}` : ` ×${c.windows.length}`}
                                        </div>
                                    ))}
                                </div>
                            )}
                            {!running && view.notes.filter((n) => n.warn).map((n) => <div key={n.text} className='pe_warn pe_small'>{n.text}</div>)}
                            <div className='pe_section'>
                                {(view.overlays || []).map((o) => (
                                    <div key={o.id}>
                                        <label title={`${o.source}\n${o.datasetId}`}>
                                            <input type='checkbox' checked={!!S.overlaysOn[o.id]} onChange={(e) => { S.overlaysOn[o.id] = e.target.checked; syncOverlays() }} /> {o.name}
                                            <span className='pe_muted'> · {o.usedByPlan ? 'the data this route was planned on' : 'not the data this plan used'}</span>
                                        </label>
                                        {S.overlaysOn[o.id] && <Legend o={o} />}
                                    </div>
                                ))}
                                <div className='pe_row'>
                                    <span>Compare with</span>
                                    <select value={compareId ?? ''} onChange={(e) => { S.compareBy[view.plan.id] = e.target.value ? Number(e.target.value) : null; loadOther(S.compareBy[view.plan.id]) }}>
                                        <option value=''>nothing</option>
                                        {S.plans.filter((p) => p.id !== view.plan.id).map((p) => (
                                            <option key={p.id} value={p.id}>#{p.id} {p.name.replace(/ · from #\d+ · /, ' · ')}</option>
                                        ))}
                                    </select>
                                    {S.other && <button title='Open that plan in PlanDev' onClick={() => openPlanInPlanDev(S.other.planId)}>Open</button>}
                                </div>
                            </div>
                            <div className='pe_actions'>
                                {S.config && <button className='primary' disabled={running} onClick={startEdit}>{view.exploring ? 'Change sites or regions…' : 'Try a change…'}</button>}
                                {view.exploring && !running && <button onClick={keep} title='Stop treating this plan as an exploration; it stays an ordinary PlanDev plan'>Keep as plan</button>}
                                <button title='Show or hide the full MMGIS interface (layers, Draw, the PlanDev tool)' onClick={() => { S.chrome = !S.chrome; applyChrome(); emit() }}>{S.chrome ? 'Hide map tools' : 'Map tools'}</button>
                            </div>
                        </>
                    )}
                    <div className='pe_foot' title={view.notes.map((n) => n.text).join('\n')}>
                        Plan #{view.plan.id} rev {view.provenance.planRevision} · simulation {view.provenance.simulationDatasetId ?? '—'}
                        {S.hover && ` · ${S.hover.name} ${S.hover.value.toFixed(1)} ${S.hover.unit}`}
                    </div>
                </>
            )}
        </div>
    )
}

function Legend({ o }) {
    const stops = gridInfo[o.datasetId]
    if (!stops) return null
    return (
        <div className='pe_legend'>
            <div style={{ background: `linear-gradient(to right, ${stops.stops.map(([, c]) => c).join(', ')})` }} />
            <span>{stops.stops[0][0]}</span>
            <span>{stops.stops.at(-1)[0]}+ {stops.unit}</span>
        </div>
    )
}

// ---------- wiring ----------

function applyChrome() {
    document.body.classList.toggle('plandevEmbedded', !S.chrome)
    setTimeout(() => Map_.map.invalidateSize(), 0)
}

function onMessage(e) {
    if (e.source !== window.parent || e.origin !== S.origin) return
    const m = e.data
    if (!m || m.protocol !== PROTOCOL || m.type !== 'context') return
    const prev = S.ctx
    S.ctx = m
    if (m.planId == null) {
        S.view = null
        S.message = 'No plan open in PlanDev.'
        draw()
        return emit()
    }
    if (m.planId !== prev.planId || m.simulationDatasetId !== prev.simulationDatasetId || m.planRevision !== prev.planRevision) {
        // A new revision may not have been simulated yet; reload so the status says so.
        loadView(m.planId, m.simulationDatasetId, m.planRevision !== prev.planRevision)
    }
    if (S.view) {
        if (m.timeMs !== prev.timeMs) applyTime()
        applySelection(false)
        emit()
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
            S.origin = e.origin
            window.addEventListener('message', onMessage)
            applyChrome()
            onMessage(e)
        }
        window.addEventListener('message', hello)
        Map_.map.on('click', onMapClick)
        Map_.map.on('mousemove', onMouseMove)
        const host = document.createElement('div')
        document.body.appendChild(host)
        createRoot(host).render(<Card />)
        // PlanDev posts on iframe load, likely before this listener existed: ask again.
        for (const o of allowed) window.parent.postMessage({ protocol: PROTOCOL, type: 'ready' }, o)
    }, 250)
}
