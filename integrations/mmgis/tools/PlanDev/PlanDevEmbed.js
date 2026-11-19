// Embedded mode: MMGIS running inside a PlanDev plan's IFrame panel, as PlanDev's spatial view of the open
// plan. Speaks PlanDev's narrow postMessage protocol (plandev.embed.v1): PlanDev sends plan/dataset/time/
// selection ids; this side fetches that plan's spatial view from the PlanDev backend plugin (with its own
// MMGIS session), draws it, and sends back time and activity selections made on the map.
//
// PlanDev owns the plan, the simulation dataset, the time cursor and the selection; nothing here picks
// them. This module holds the embedded state, the bridge and everything drawn on the map, including the
// spatial editor for the mission goals' inputs. PlanDevEmbedUI.js renders the controls over the map.
//
// Only active when MMGIS is framed AND the parent's origin is listed in the PlanDev tool's
// `embedOrigins` variable. Nothing but ids and times crosses the bridge.
import { useSyncExternalStore } from 'react'
import L_ from '@basics/Layers_/Layers_'
import Map_ from '@basics/Map_/Map_'
import useUIStore from '@basics/UserInterface_/store/uiStore'

import { api, capLatLngs, coordsOf, entitiesOf, gridValueAt, sampleAt, setGridOverlay } from './PlanDevMap'
import { comparisonOutdated, counterpart as counterpartIn, pointInRing, positionAt, regionProblem, runStep, segmentHitsRing } from '../../lib/util'

const PROTOCOL = 'plandev.embed.v1'
const CLICK_PX = 12 // click within this many pixels of a position sample to move PlanDev's time cursor
export const COLOR = '#00e5ff' // the open plan
export const OTHER_COLOR = '#ff9100' // the plan being compared with
export const ALSO_COLOR = '#d500f9' // entities of a second plan shown alongside
const REGION_COLOR = '#ff5252'
const POLL_MS = 3000
export const gridInfo = {} // overlay dataset id → { stops, unit, cellDeg }, known once the grid has loaded

export const S = {
    origin: null, // the PlanDev origin we accepted
    ctx: {}, // last context from PlanDev
    key: null, // `${planId}/${simulationDatasetId}` of the view on the map
    view: null,
    loading: null,
    message: 'Waiting for PlanDev…',
    config: null, // the mission's parameters and target rules
    plans: [],
    selected: null, // fid of the selected feature of the open plan
    selectedOther: null, // fid of the selected feature of the compared plan (never sent to PlanDev)
    focus: null, // { key, feature, plan: 'current' | 'compared' }: a constraint window highlighted on the map
    follow: false, // pan to keep the vehicle in view; off so the map can be explored freely
    chrome: false, // show the full MMGIS interface
    inspector: { open: false, tab: 'sites', width: 360 },
    popover: null, // 'layers' | 'menu' | 'error' | null
    overlaysOn: {}, // overlay id → shown
    opacity: {}, // overlay id → 0..1
    hide: { current: false, other: false }, // routes hidden on the map
    compareBy: {}, // planId → { planId, ds? } compared with, or null for none
    recent: [], // plan ids recently chosen for comparison
    other: null, // { planId, ds, view } of the compared plan or simulation
    also: null, // view of a second plan whose tracked entities are shown too (iframe URL: plandevAlso=<plan id>)
    run: null, // a run started here: { planId, fromDs, userPicked?, target?, ... } (see util.runStep)
    runState: null, // { phase, message?, simulationDatasetId? } shown while (and just after) a run goes
    edit: null, // spatial editing of the goals' inputs: see startEdit
    markers: [],
    hover: null, // { lat, lon, value?, overlay } under the pointer
    pins: [], // terrain samples pinned by shift-click: { id, lat, lon }
    pick: null, // { x, y, items: [{ which, f }] }: features of both plans under one click, to choose from
    layer: null,
    otherLayer: null,
    focusLayer: null,
    editLayer: null,
    answerLayer: null,
    pinLayer: null,
}
const SAVED = ['follow', 'chrome', 'inspector', 'overlaysOn', 'opacity', 'hide', 'compareBy', 'recent', 'run', 'pins']
try {
    Object.assign(S, JSON.parse(sessionStorage.getItem('plandevEmbed2') || '{}'))
} catch {}

let version = 0
const listeners = new Set()
export function emit() {
    version++
    try {
        sessionStorage.setItem('plandevEmbed2', JSON.stringify(Object.fromEntries(SAVED.map((k) => [k, S[k]]))))
    } catch {}
    listeners.forEach((l) => l())
    document.dispatchEvent(new CustomEvent('plandev:embed', { detail: embedded() }))
}
/** Re-render on any state change (React). */
export const useS = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => version)

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
 * produced. PlanDev stays the authority: it checks the dataset is the open plan's, and sends the new
 * context back.
 */
export function showSimulationInPlanDev(simulationDatasetId) {
    if (S.origin) send({ type: 'showSimulation', simulationDatasetId })
}

/** Ask PlanDev to expand this panel over its workspace (or restore its grid). PlanDev decides; the map stays the same map. */
export function setExpanded(on) {
    if (S.origin) send({ type: on ? 'expandPanel' : 'restorePanel' })
}

/** Move PlanDev's time cursor; with `endMs`, PlanDev also frames that window on its timeline. */
export function setTime(timeMs, endMs) {
    if (S.origin) send({ type: 'setTime', timeMs, ...(endMs != null && { endMs }) })
}

function send(msg) {
    window.parent.postMessage({ protocol: PROTOCOL, ...msg }, S.origin)
}

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
            S.focus = null
            if (S.edit) stopEdit()
        }
        if (!S.config || S.config.mission.key !== view.mission.key) S.config = await api(`api/plandev/missions/${view.mission.key}/config`)
        refreshPlans()
        draw()
        syncOverlays()
        loadOther(compareSel())
        loadAlso()
        applySelection(true)
        applyTime()
        drawFocus()
        // Fit once per plan, unless the embedding URL pins the map view (MMGIS mapLat/mapLon/mapZoom).
        if (S.fittedPlanId !== planId && !new URLSearchParams(location.search).has('mapLat')) fit(view)
        S.fittedPlanId = planId
        if (S.run) pollRun()
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

function refreshPlans() {
    if (!S.view) return Promise.resolve(S.plans)
    return api(`api/plandev/missions/${S.view.mission.key}/plans`).then(
        (p) => {
            S.plans = p
            // A comparison with a plan's latest simulation follows that plan's re-runs; one pinned to a
            // simulation (sel.ds) stays as it is.
            if (comparisonOutdated(S.other, p)) loadOther(compareSel(), true)
            emit()
            return p
        },
        () => S.plans,
    )
}
setInterval(() => S.origin && S.view && !S.run && refreshPlans(), 15000)

/**
 * While a run started here is in flight, follow the plan's latest run and dataset (not the dataset
 * PlanDev happens to show), and once a new simulation is ready ask PlanDev to show it — unless the
 * user picked another simulation meanwhile.
 */
let pollTimer = null
async function pollRun() {
    clearTimeout(pollTimer)
    if (!S.run || !S.view) return
    const plans = await refreshPlans()
    const run = S.run
    if (!run) return
    const entry = plans.find((p) => p.id === run.planId)
    const r = runStep(run, entry, S.ctx.planId === run.planId ? S.ctx.simulationDatasetId : null)
    S.run = r.run
    S.runState = { phase: r.phase, message: r.message, simulationDatasetId: r.simulationDatasetId, planId: run.planId }
    if (r.show != null && S.ctx.planId === run.planId) showSimulationInPlanDev(r.show)
    if (S.run) pollTimer = setTimeout(pollRun, POLL_MS)
    else if (r.phase === 'complete') setTimeout(() => S.runState?.phase === 'complete' && ((S.runState = null), emit()), 8000)
    emit()
}

export function dismissRun() {
    S.runState = null
    emit()
}

/** The comparison chosen for the open plan: { planId, ds? } or null. Default: the plan it was derived from. */
export function compareSel(view = S.view) {
    if (!view) return null
    const v = S.compareBy[view.plan.id]
    if (v !== undefined) return typeof v === 'number' ? { planId: v } : v
    return view.derivedFrom?.sameModel ? { planId: view.derivedFrom.id } : null
}

export function setCompare(sel) {
    S.compareBy[S.view.plan.id] = sel
    if (sel && sel.planId !== S.view.plan.id) S.recent = [sel.planId, ...S.recent.filter((x) => x !== sel.planId)].slice(0, 5)
    S.popover = null
    loadOther(sel)
}

async function loadOther(sel, force = false) {
    const same = (a, b) => a?.planId === b?.planId && (a?.ds ?? null) === (b?.ds ?? null)
    if (!sel || (sel.planId === S.view?.plan.id && sel.ds == null)) {
        S.other = null
        S.selectedOther = null
        drawOther()
        return emit()
    }
    if (!force && same(S.other, sel) && S.other.view) return
    try {
        const view = await api(`api/plandev/plans/${sel.planId}?${query({ mission: missionKey(), simulationDatasetId: sel.ds })}`)
        if (!same(compareSel(), sel)) return
        if (!same(S.other, sel) || S.other?.view?.provenance.simulationDatasetId !== view.provenance.simulationDatasetId) S.selectedOther = null
        S.other = { planId: sel.planId, ds: sel.ds ?? null, view }
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
    if (pts.length) Map_.map.fitBounds(pts.map(([lo, la]) => [la, lo]), { padding: [40, 40], maxZoom: 13 })
    else {
        const s = entitiesOf(view)[0]?.samples[0]
        if (s) Map_.map.setView([s[2], s[1]], 3)
    }
}

/** Pan/zoom just enough to show a geometry, keeping the user's zoom when it already fits. */
export function reveal(geometry, minZoom = 6) {
    const pts = coordsOf(geometry).map(([lo, la]) => [la, lo])
    if (!pts.length) return
    const b = window.L.latLngBounds(pts)
    if (!Map_.map.getBounds().contains(b)) Map_.map.fitBounds(b, { padding: [60, 60], maxZoom: Math.max(Map_.map.getZoom(), minZoom) })
}

// ---------- drawing ----------

const isRoute = (f) => /LineString/.test(f.geometry.type) && ['simulated', 'planned', 'illustrative'].includes(f.properties.basis) && !f.properties.context

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
    if (p.outcome && ['missed', 'reached'].includes(p.outcome.state)) Object.assign(base, { color: '#ffb74d', fillColor: '#ffb74d', opacity: 1 })
    if (S.hide.current && (isRoute(f) || p.basis === 'violation')) Object.assign(base, { opacity: 0, fillOpacity: 0 })
    if (S.edit && p.basis === 'input') Object.assign(base, { opacity: 0, fillOpacity: 0 }) // the editor draws the inputs
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
                l.on('click', onFeatureClick)
            },
        },
    ).addTo(Map_.map)
    S.layer.eachLayer((l) => l.getTooltip()?.options.permanent && S.edit && l.closeTooltip())
}

function restyle() {
    S.layer?.eachLayer((l) => {
        const st = styleOf(l.feature, S.ctx.timeMs)
        l.setStyle(st)
        // A hidden feature must not catch clicks meant for what is under it (e.g. the compared route).
        l.getElement?.()?.style.setProperty('pointer-events', st.opacity === 0 ? 'none' : '')
        if (l.getTooltip()?.options.permanent) S.edit ? l.closeTooltip() : l.openTooltip()
    })
}

// The compared plan's features worth inspecting on the map: its routes, sites, observations, waits, avoided
// regions and constraint locations. Analysis and context geometry stay out, so the map does not double up.
const COMPARED_KINDS = new Set(['site', 'observation', 'wait', 'avoid', 'violation', 'target', 'picture'])
const isCompared = (f) => isRoute(f) || COMPARED_KINDS.has(f.properties.kind)

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/** Hover text for a compared feature: which plan owns it, what it is, and its first details. */
function otherTooltip(f) {
    const p = f.properties
    const v = S.other.view
    const plan = S.other.ds ? `Compared: plan #${v.plan.id}, simulation ${S.other.ds}` : `Compared plan #${v.plan.id}`
    const lines = (p.details || []).slice(0, 3).map(([k, x]) => `${esc(k)}: ${esc(x)}`)
    return `<b style="color:${OTHER_COLOR}">${esc(plan)}</b><br>${esc(p.name.replace(/ — .*/, ''))}${lines.length ? `<br><span style="opacity:.8">${lines.join('<br>')}</span>` : ''}`
}

/** A compared feature's style: orange, planned versus simulated kept apart as on the open plan; white when selected. */
function otherStyle(f) {
    const p = f.properties
    const st = { weight: 3, opacity: 0.95, fillOpacity: 0.25, ...p.style, color: OTHER_COLOR, fillColor: OTHER_COLOR }
    // The simulated track is a wide casing drawn under the open plan's: where the routes coincide it shows as an
    // orange edge around the cyan line, and where they part it stands on its own.
    if (p.basis === 'simulated' && /LineString/.test(f.geometry.type)) Object.assign(st, { weight: 8, opacity: 0.75 })
    if (p.basis === 'planned') Object.assign(st, { opacity: 0.15 })
    if (p.basis === 'violation') Object.assign(st, { color: '#ff1744', dashArray: '2 6', weight: 4 })
    if (p.fid === S.selectedOther) Object.assign(st, { color: '#ffffff', weight: st.weight + 2, opacity: 1 })
    return st
}

/**
 * The compared plan on the map: clickable, with tooltips naming the plan that owns each feature. Selecting
 * one inspects it here and never selects anything in PlanDev, whose selection belongs to the open plan.
 */
function drawOther() {
    if (S.otherLayer) Map_.map.removeLayer(S.otherLayer)
    S.otherLayer = null
    if (!S.other || S.hide.other) return
    S.otherLayer = window.L.geoJSON(
        { type: 'FeatureCollection', features: S.other.view.features.filter(isCompared) },
        {
            style: otherStyle,
            pointToLayer: (f, ll) => window.L.circleMarker(ll, { radius: f.properties.kind === 'site' ? 6 : 4 }),
            onEachFeature: (f, l) => {
                l.bindTooltip(() => otherTooltip(f), { sticky: true })
                l.on('click', onFeatureClick)
            },
        },
    ).addTo(Map_.map)
    S.layer?.bringToFront()
}

const HIT_PX = 6

/**
 * Every shown feature of the open and the compared plan within a few pixels of a click, points before lines
 * before areas, one entry per activity (its planned band and simulated track are the same thing to pick).
 */
function hitsAt(latlng) {
    const L = window.L
    const click = Map_.map.latLngToLayerPoint(latlng)
    const out = new Map()
    for (const [which, layer] of [['current', S.layer], ['compared', S.otherLayer]]) {
        layer?.eachLayer((l) => {
            if (!l.options.opacity && !l.options.fillOpacity) return // hidden (e.g. the current route switched off)
            const f = l.feature
            const g = f.geometry
            let d = Infinity
            let rank = 1
            if (l instanceof L.CircleMarker) [d, rank] = [Map_.map.latLngToLayerPoint(l.getLatLng()).distanceTo(click) - l.getRadius(), 0]
            else if (g.type === 'Polygon') [d, rank] = [pointInRing([latlng.lng, latlng.lat], g.coordinates[0]) ? 0 : l.closestLayerPoint(click)?.distance ?? Infinity, 2]
            else if (l instanceof L.Polyline) d = l.closestLayerPoint(click)?.distance ?? Infinity
            if (d > HIT_PX) return
            const p = f.properties
            const key = `${which}/${p.spanId ?? p.directiveId ?? `f${p.fid}`}`
            const best = out.get(key)
            if (!best || rank < best.rank || (rank === best.rank && p.primary && !best.f.properties.primary)) out.set(key, { which, f, rank, d })
        })
    }
    return [...out.values()].sort((a, b) => a.rank - b.rank || (a.which === 'current' ? -1 : 1) - (b.which === 'current' ? -1 : 1) || a.d - b.d)
}

/**
 * A click on a plan feature. Where only one plan has features under the pointer, the nearest one (points
 * first) is selected. Where the open and the compared plan overlap, a small menu lists both, so a compared
 * feature hidden under the open plan's route can be reached and is never mistaken for the open plan's.
 */
function onFeatureClick(e) {
    window.L.DomEvent.stopPropagation(e)
    if (S.edit) return
    const hits = hitsAt(e.latlng)
    if (!hits.length) return
    if (new Set(hits.map((h) => h.which)).size > 1) {
        S.pick = { x: e.originalEvent.clientX, y: e.originalEvent.clientY, items: hits.slice(0, 6).map(({ which, f }) => ({ which, f })) }
        return emit()
    }
    choose(hits[0])
}

/** Select one entry of the overlap menu (or a single hit): the open plan's goes to PlanDev too; a compared one never does. */
export function choose(h) {
    S.pick = null
    if (h.which === 'current') selectFeature(h.f)
    else selectOther(h.f)
}

export function closePick() {
    if (S.pick) (S.pick = null), emit()
}

/** Inspect a feature of the compared plan (the open plan's selection is left alone). */
export function selectOther(f, { pan = false } = {}) {
    S.selectedOther = f?.properties.fid ?? null
    S.otherLayer?.eachLayer((l) => l.setStyle(otherStyle(l.feature)))
    if (f && pan) reveal(f.geometry)
    emit()
}

/** The open or compared plan's feature for the same site or destination (lib/util counterpart). */
export const counterpart = (f, view) => counterpartIn(f, view)

export function setHidden(which, hidden) {
    S.hide[which] = hidden
    if (which === 'other') drawOther()
    else restyle()
    emit()
}

export async function syncOverlays() {
    for (const o of S.view?.overlays || []) {
        if (!(o.id in S.overlaysOn)) S.overlaysOn[o.id] = true
        const grid = await setGridOverlay(o, S.overlaysOn[o.id], S.opacity[o.id] ?? 0.6).catch(() => null)
        if (grid) gridInfo[o.datasetId] = { stops: grid.stops, unit: grid.unit, cellDeg: grid.cellDeg }
    }
    drawPins()
    emit()
}

/** The value of the mission's first overlay at a point: { overlay, value } (value null outside the grid), or null with no overlay loaded. */
export function terrainAt(lat, lon) {
    const o = (S.view?.overlays || []).find((x) => gridInfo[x.datasetId])
    return o ? { overlay: o, value: gridValueAt(o, lat, lon), unit: gridInfo[o.datasetId].unit } : null
}

/** A constraint window's map geometry, highlighted over everything else. */
function drawFocus() {
    if (S.focusLayer) Map_.map.removeLayer(S.focusLayer)
    S.focusLayer = null
    const f = S.focus?.feature
    if (!f) return
    // A halo under, and a dashed outline over, the window's geometry, so it stands out from the route.
    const L = window.L
    S.focusLayer = L.layerGroup([
        L.geoJSON(f, { interactive: false, style: () => ({ color: '#ffffff', weight: 14, opacity: 0.35 }), pointToLayer: (_, ll) => L.circleMarker(ll, { radius: 16, stroke: false, fillColor: '#ffffff', fillOpacity: 0.35 }) }),
        L.geoJSON(f, { interactive: false, style: () => ({ color: '#ffffff', weight: 2.5, opacity: 1, dashArray: '3 5' }), pointToLayer: (_, ll) => L.circleMarker(ll, { radius: 11, color: '#ffffff', weight: 2.5, dashArray: '3 4', fill: false }) }),
    ]).addTo(Map_.map)
    S.focusLayer.getLayers()[1].bringToFront()
}

// ---------- time ----------

/** Where each tracked entity is at the cursor: [{ entity, color, other, from, sample | outside }]. */
export function positionsNow() {
    const t = S.ctx.timeMs
    return [
        ...entitiesOf(S.view).map((e) => ({ e, color: '#ff1744' })),
        ...entitiesOf(S.also).map((e) => ({ e, color: ALSO_COLOR, from: S.also.plan })),
        ...entitiesOf(S.other?.view).map((e) => ({ e, color: OTHER_COLOR, other: true })),
    ].map((x) => ({ ...x, ...positionAt(x.e, t) }))
}

function applyTime() {
    restyle()
    const t = S.ctx.timeMs
    const tracks = positionsNow()
    tracks.forEach(({ e, color, other, sample }, i) => {
        const m = (S.markers[i] ??= {})
        Object.assign(m, { sample, entity: e, other: !!other, color })
        if (!sample || (other && S.hide.other)) {
            for (const n of ['marker', 'window', 'cap']) {
                if (m[n]) Map_.map.removeLayer(m[n])
                m[n] = null
            }
            return
        }
        const [, lon, lat, capDeg] = sample
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

/**
 * The Sun at the vehicle at the cursor, from the plan's simulated solar resources (view.sun): elevation,
 * whether the drive window is open, and when that next changes. Null without solar data or outside it.
 */
export function sunNow(view = S.view, t = S.ctx.timeMs) {
    const sun = view?.sun
    if (!sun?.samples.length || t == null) return null
    const s = sun.samples
    if (t < s[0][0] || t > Date.parse(view.plan.startTime) + view.plan.durationSec * 1000) return null
    let k = 0
    while (k + 1 < s.length && s[k + 1][0] <= t) k++
    const [, elev, open, ltst] = s[k]
    const flip = s.slice(k + 1).find((x) => x[2] !== open)
    return { elev, open, ltst, min: sun.minElevationDeg, next: flip ? flip[0] - t : null, dark: (sun.dark || []).some(([a, b]) => t >= a && t < b) }
}

export function setFollow(on) {
    S.follow = on
    applyTime()
    emit()
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
        // PlanDev cleared its selection: drop ours if it was an activity (keep a site, pin or analysis point).
        const cur = S.view?.features.find((x) => x.properties.fid === S.selected)
        if (cur && (cur.properties.spanId != null || cur.properties.directiveId != null)) S.selected = null
        return restyle()
    }
    S.selected = f.properties.fid
    restyle()
    reveal(f.geometry)
}

/** Select a feature of the open plan: on the map, and its activity and start time in PlanDev. */
export function selectFeature(f, { pan = false } = {}) {
    const p = f.properties
    if (S.selectedOther != null) selectOther(null)
    S.selected = p.fid
    restyle()
    emit()
    if (pan) reveal(f.geometry)
    if (p.simulationDatasetId != null && p.simulationDatasetId !== S.ctx.simulationDatasetId) return // a stale feature: never cross datasets
    if (p.spanId != null || p.directiveId != null) send({ type: 'select', spanId: p.spanId ?? null, directiveId: p.spanId == null ? p.directiveId : null })
    if (Number.isFinite(p.startMs)) setTime(p.startMs)
}

/** Select an activity by span (e.g. a table row): its primary feature if it has one. */
export function selectSpan(spanId, directiveId, startMs) {
    const f = S.view?.features.find((x) => x.properties.primary && (spanId != null ? x.properties.spanId === spanId : x.properties.directiveId === directiveId))
    if (f) return selectFeature(f, { pan: true })
    send({ type: 'select', spanId: spanId ?? null, directiveId: spanId == null ? directiveId ?? null : null })
    if (Number.isFinite(startMs)) setTime(startMs)
}

export function clearSelection() {
    S.selected = null
    if (S.selectedOther != null) selectOther(null)
    restyle()
    emit()
}

/**
 * Highlight one constraint window: PlanDev's cursor moves to it (and frames it on the timeline), the map
 * shows where the vehicle was during it. The selected plan, simulation and activity are left alone.
 */
export function focusWindow(w) {
    const same = S.focus?.key === w.key
    S.focus = same ? null : w
    drawFocus()
    if (!same) {
        setTime(w.startMs, w.endMs)
        if (w.feature) reveal(w.feature.geometry)
    }
    emit()
}

function onMapClick(e) {
    closePick()
    if (S.edit) return editClick(e)
    if (e.originalEvent.shiftKey) return addPin(e.latlng)
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
    if (best) setTime(best.t)
}

let hoverFrame = 0
function onMouseMove(e) {
    cancelAnimationFrame(hoverFrame)
    hoverFrame = requestAnimationFrame(() => {
        const { lat, lng } = e.latlng
        const tv = terrainAt(lat, lng)
        S.hover = { lat, lon: lng, ...tv }
        emit()
    })
}

// ---------- terrain pins: shift-click to keep a sample for comparison ----------

function addPin(ll) {
    S.pins = [...S.pins, { id: Date.now().toString(36), lat: +ll.lat.toFixed(5), lon: +ll.lng.toFixed(5) }].slice(-8)
    drawPins()
    emit()
}

export function removePin(id) {
    S.pins = id ? S.pins.filter((p) => p.id !== id) : []
    drawPins()
    emit()
}

function drawPins() {
    if (S.pinLayer) Map_.map.removeLayer(S.pinLayer)
    S.pinLayer = window.L.layerGroup().addTo(Map_.map)
    for (const p of S.pins) {
        const tv = terrainAt(p.lat, p.lon)
        const text = tv?.value != null ? `${tv.value.toFixed(1)}°` : '—'
        window.L.circleMarker([p.lat, p.lon], { radius: 4, color: '#000', weight: 1, fillColor: '#fff', fillOpacity: 1 })
            .bindTooltip(text, { permanent: true, direction: 'top', offset: [0, -4], className: 'pe_pin' })
            .on('click', (e) => {
                window.L.DomEvent.stopPropagation(e)
                removePin(p.id)
            })
            .addTo(S.pinLayer)
    }
}

// ---------- spatial editing: the mission goals' inputs, edited on the map ----------
//
// Sites are draggable markers. Regions use Leaflet.Editable (bundled with MMGIS; its Draw tool edits
// with it): drag corners, drag the midpoint handles to add corners, click a corner to delete it, drag
// the region to move it. A new region is drawn with a guide line to the pointer and is finished by
// clicking its first or last corner (or double-click, or Enter); Backspace removes the last corner,
// Escape cancels. Nothing is scheduled until the user asks.

export function startEdit() {
    const inputs = S.view.inputs
    const t = S.config.targets
    const feats = inputs?.targets.features || []
    // Without the goal inputs that produced this plan, start from the sites the plan shows.
    const fallback = feats.length ? [] : S.view.features.filter((f) => f.properties.kind === 'site' && f.properties.scheduled !== false)
    S.edit = {
        sites: [
            ...feats.filter((f) => f.geometry.type === 'Point').map((f) => ({ id: f.id, name: f.properties?.name ?? f.id, priority: f.properties?.priority ?? t.priority?.default, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })),
            ...fallback.map((f) => ({ id: f.properties.targetId, name: f.properties.siteName ?? f.properties.targetId, priority: f.properties.priority ?? t.priority?.default, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })),
        ],
        regions: feats.filter((f) => f.geometry.type === 'Polygon').map((f) => ({ id: f.id, name: f.properties?.name ?? f.id, ring: f.geometry.coordinates[0].slice(0, -1) })),
        params: { ...Object.fromEntries(S.config.params.map((p) => [p.key, p.default])), ...inputs?.params },
        fromInputs: !!feats.length,
        tool: 'select',
        drawing: 0, // corners of the region being drawn
        selected: null, // id of the selected site or region
        answer: null,
        busy: false,
        error: null,
        dirty: false,
        restore: { inspector: { ...S.inspector }, selected: S.selected },
    }
    S.inspector = { ...S.inspector, open: true }
    S.popover = null
    applyInspector()
    drawEdit()
    restyle()
    emit()
}

export function stopEdit() {
    const r = S.edit?.restore
    Map_.map.editTools?.stopDrawing()
    S.edit = null
    if (r) Object.assign(S, { inspector: r.inspector, selected: r.selected })
    applyInspector()
    drawEdit()
    restyle()
    emit()
}

export function editTargets() {
    return {
        type: 'FeatureCollection',
        features: [
            ...S.edit.sites.map((s) => ({ type: 'Feature', id: s.id, properties: { name: s.name, ...(s.priority != null && { priority: s.priority }) }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })),
            ...S.edit.regions.map((r) => ({ type: 'Feature', id: r.id, properties: { name: r.name }, geometry: { type: 'Polygon', coordinates: [[...r.ring, r.ring[0]]] } })),
        ],
    }
}

const ringOf = (poly) => poly.getLatLngs()[0].map((ll) => [+ll.lng.toFixed(6), +ll.lat.toFixed(6)])

/** Rebuild the editor's map layers from S.edit (on structural changes only: never while a corner is dragged). */
export function drawEdit() {
    for (const k of ['editLayer', 'answerLayer']) {
        if (S[k]) {
            S[k].eachLayer?.((l) => l.editEnabled?.() && l.disableEdit())
            Map_.map.removeLayer(S[k])
        }
        S[k] = null
    }
    const ed = S.edit
    Map_.map.getContainer().style.cursor = ed && ed.tool !== 'select' ? 'crosshair' : ''
    if (!ed) return
    const L = window.L
    const g = (S.editLayer = L.layerGroup().addTo(Map_.map))
    for (const r of ed.regions) {
        const bad = regionProblem(r.ring)
        const poly = L.polygon(
            r.ring.map(([lo, la]) => [la, lo]),
            { color: bad ? '#ffea00' : REGION_COLOR, weight: r.id === ed.selected ? 3 : 2, fillOpacity: r.id === ed.selected ? 0.3 : 0.18, dashArray: bad ? '6 4' : null, draggable: true },
        ).addTo(g)
        poly.bindTooltip(r.name, { sticky: true })
        poly.enableEdit(Map_.map)
        const sync = () => {
            r.ring = ringOf(poly)
            ed.answer = null
            ed.dirty = true
            emit()
        }
        poly.on('editable:vertex:dragend editable:vertex:deleted editable:vertex:new editable:dragend', () => {
            sync()
            // Restyle once a change is complete (validity may have changed).
            const nowBad = regionProblem(r.ring)
            poly.setStyle({ color: nowBad ? '#ffea00' : REGION_COLOR, dashArray: nowBad ? '6 4' : null })
        })
        poly.on('click', (e) => {
            L.DomEvent.stopPropagation(e)
            selectEditItem(r.id, false)
        })
    }
    for (const s of ed.sites) {
        const m = L.marker([s.lat, s.lon], {
            draggable: true,
            icon: L.divIcon({ className: `plandevEditSite${s.id === ed.selected ? ' on' : ''}`, html: `<span>${s.priority ?? ''}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        })
        m.bindTooltip(s.name, { permanent: true, direction: 'right', offset: [12, 0], className: 'pe_label' })
        m.on('dragend', () => {
            const ll = m.getLatLng()
            Object.assign(s, { lat: +ll.lat.toFixed(6), lon: +ll.lng.toFixed(6) })
            ed.answer = null
            ed.dirty = true
            ed.selected = s.id
            emit()
        })
        m.on('click', (e) => {
            L.DomEvent.stopPropagation(e)
            selectEditItem(s.id, false)
        })
        m.addTo(g)
    }
    if (ed.answer?.features.length)
        S.answerLayer = L.geoJSON(
            { type: 'FeatureCollection', features: ed.answer.features },
            { interactive: false, style: (f) => ({ color: '#ffea00', weight: 2, fillOpacity: 0.1, ...f.properties.style }), pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 4 }) },
        ).addTo(Map_.map)
}

export function selectEditItem(id, pan = true) {
    const ed = S.edit
    ed.selected = ed.selected === id && !pan ? null : id
    const s = ed.sites.find((x) => x.id === id)
    const r = ed.regions.find((x) => x.id === id)
    if (pan && (s || r)) reveal(s ? { type: 'Point', coordinates: [s.lon, s.lat] } : { type: 'Polygon', coordinates: [r.ring] }, 10)
    drawEdit()
    emit()
}

export function setTool(tool) {
    const ed = S.edit
    Map_.map.editTools?.stopDrawing()
    ed.tool = tool
    ed.drawing = 0
    if (tool === 'region') startRegion()
    drawEdit()
    emit()
}

/** A change to the inputs that is not a map gesture (rename, priority, parameter, removal). */
export function editInputs(fn, redraw = false) {
    fn(S.edit)
    S.edit.answer = null
    S.edit.dirty = true
    if (redraw) drawEdit()
    emit()
}

function startRegion() {
    const map = Map_.map
    const poly = map.editTools.startPolygon(null, { color: REGION_COLOR, weight: 2, fillOpacity: 0.15 })
    map.doubleClickZoom.disable()
    const update = () => {
        if (S.edit) S.edit.drawing = poly.getLatLngs()[0].length
        emit()
    }
    poly.on('editable:drawing:clicked editable:vertex:deleted', update)
    poly.on('editable:drawing:commit', () => {
        const ring = ringOf(poly)
        map.editTools.featuresLayer.removeLayer(poly)
        map.doubleClickZoom.enable()
        const ed = S.edit
        if (!ed) return
        const bad = regionProblem(ring)
        if (bad) ed.error = `That region was not added: ${bad}.`
        else {
            const id = `region-${Date.now().toString(36)}`
            ed.regions.push({ id, name: `${S.config.targets.roles?.Polygon ?? 'Region'} ${ed.regions.length + 1}`, ring })
            ed.selected = id
            ed.error = null
            ed.dirty = true
            ed.answer = null
        }
        ed.tool = 'select'
        ed.drawing = 0
        drawEdit()
        emit()
    })
    poly.on('editable:drawing:cancel', () => {
        map.editTools.featuresLayer.removeLayer(poly)
        map.doubleClickZoom.enable()
    })
}

function onKey(e) {
    const ed = S.edit
    // Escape is PlanDev's "restore the grid"; inside this frame PlanDev cannot hear it, so pass it on.
    if (!ed && e.key === 'Escape' && !/input|select|textarea/i.test(e.target.tagName)) {
        if (S.pick) closePick()
        else if (S.popover) ((S.popover = null), emit())
        else if (S.ctx.expanded) setExpanded(false)
        return
    }
    if (!ed || /input|select|textarea/i.test(e.target.tagName)) return
    const drawing = Map_.map.editTools?.drawing()
    if (e.key === 'Escape') {
        if (drawing || ed.tool !== 'select') setTool('select')
        else if (ed.selected) selectEditItem(ed.selected, false)
    } else if (drawing && e.key === 'Enter') {
        if (ed.drawing >= 3) Map_.map.editTools.commitDrawing()
    } else if (drawing && (e.key === 'Backspace' || (e.key === 'z' && (e.metaKey || e.ctrlKey)))) {
        e.preventDefault()
        Map_.map.editTools._drawingEditor?.pop()
        ed.drawing = Math.max(0, ed.drawing - 1)
        emit()
    } else if (!drawing && (e.key === 'Delete' || e.key === 'Backspace') && ed.selected) {
        editInputs((x) => {
            x.sites = x.sites.filter((s) => s.id !== x.selected)
            x.regions = x.regions.filter((r) => r.id !== x.selected)
            x.selected = null
        }, true)
    }
}

function editClick(e) {
    const ed = S.edit
    if (Map_.map.editTools?.drawing()) return // Leaflet.Editable takes the click
    if (ed.tool !== 'site') return
    const n = ed.sites.length + 1
    const id = `site-${Date.now().toString(36)}`
    ed.sites.push({ id, name: `New site ${n}`, priority: S.config.targets.priority?.default, lon: +e.latlng.lng.toFixed(6), lat: +e.latlng.lat.toFixed(6) })
    Object.assign(ed, { tool: 'select', selected: id, answer: null, dirty: true })
    drawEdit()
    emit()
}

/**
 * Immediate, local feedback on the edited inputs: terrain at each site, and how each region relates to
 * the open plan's current route and sites. The scheduling goal stays the authority on the actual route.
 */
export function editFeedback() {
    const ed = S.edit
    const maxSlope = Number(ed.params.maxSlopeDeg)
    const routes = (S.view?.features || []).filter((f) => isRoute(f) && f.properties.basis !== 'illustrative' && f.geometry.type === 'LineString')
    const sites = ed.sites.map((s) => {
        const tv = terrainAt(s.lat, s.lon)
        const notes = []
        if (tv && tv.value == null) notes.push({ warn: true, text: `outside the ${tv.overlay.name.toLowerCase()} grid` })
        else if (tv) notes.push({ warn: Number.isFinite(maxSlope) && tv.value > maxSlope, text: `${tv.overlay.name.toLowerCase()} ${tv.value.toFixed(1)}°${Number.isFinite(maxSlope) && tv.value > maxSlope ? ` > ${maxSlope}° drivable` : ''}` })
        const inside = ed.regions.find((r) => r.ring.length >= 3 && pointInRing([s.lon, s.lat], r.ring))
        if (inside) notes.push({ warn: true, text: `inside ${inside.name}` })
        return { id: s.id, notes }
    })
    const regions = ed.regions.map((r) => {
        const notes = []
        const bad = regionProblem(r.ring)
        if (bad) notes.push({ warn: true, text: bad })
        const crossed = routes.filter((f) => f.geometry.coordinates.some((p, i, a) => i > 0 && segmentHitsRing(a[i - 1], p, [...r.ring, r.ring[0]])))
        if (crossed.length) notes.push({ warn: false, text: `crosses the current route (${[...new Set(crossed.map((f) => f.properties.name.replace(/ — .*/, '')))].slice(0, 2).join(', ')}${crossed.length > 2 ? '…' : ''})` })
        else if (!bad) notes.push({ warn: false, text: 'clear of the current route' })
        const covers = ed.sites.filter((s) => pointInRing([s.lon, s.lat], r.ring))
        if (covers.length) notes.push({ warn: true, text: `contains ${covers.map((s) => s.name).join(', ')}` })
        return { id: r.id, notes, invalid: !!bad }
    })
    return { sites, regions, invalid: regions.some((r) => r.invalid) }
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
export const checkAgainstPlan = () =>
    editAction(async () => {
        const v = S.view
        const ev = S.config.evaluation
        S.edit.answer = await api(`api/plandev/plans/${v.plan.id}/evaluate`, {
            mission: v.mission.key,
            simulationDatasetId: v.provenance.simulationDatasetId,
            targets: { ...editTargets(), features: editTargets().features.filter((f) => ev.targets.types.includes(f.geometry.type)) },
            params: {},
        })
        drawEdit()
    })

/**
 * Schedule and simulate the edited inputs. On a plan that is not a working branch this branches it first
 * (the plan itself is never changed) and PlanDev opens the branch; on a working branch it re-runs in place.
 */
export const replan = () =>
    editAction(async () => {
        const v = S.view
        const body = { mission: v.mission.key, targets: editTargets(), params: S.edit.params, expectedRevision: v.plan.revision }
        if (v.exploring) {
            await api(`api/plandev/plans/${v.plan.id}/update`, body)
            // The baseline is the plan's newest simulation, not the (possibly older) one PlanDev shows.
            S.run = { planId: v.plan.id, fromDs: v.history?.[0]?.simulationDatasetId ?? v.provenance.simulationDatasetId }
            stopEdit()
        } else {
            const r = await api(`api/plandev/plans/${v.plan.id}/explore`, body)
            S.run = { planId: r.planId, fromDs: null }
            S.compareBy[r.planId] = { planId: v.plan.id }
            stopEdit()
            openPlanInPlanDev(r.planId)
        }
        S.runState = { phase: 'scheduling', planId: S.run.planId }
        pollRun()
    })

export async function keep() {
    S.popover = null
    await api(`api/plandev/plans/${S.view.plan.id}/keep`, {})
    loadView(S.view.plan.id, S.ctx.simulationDatasetId, true)
}

// ---------- wiring ----------

let layoutBefore = null
/**
 * Embedded, MMGIS is a map only: its Viewer and Globe screens are closed and their splitters removed
 * through MMGIS's own layout state, not hidden. The full interface brings them back as they were.
 */
function mapOnly(on) {
    const ui = useUIStore.getState()
    if (on && !layoutBefore) {
        layoutBefore = { pp: ui.getPanelPercents(), hasViewer: ui.hasViewer, hasGlobe: ui.hasGlobe }
        ui.setPanelPercents(0, 100, 0)
        ui.setHasViewer(false)
        ui.setHasGlobe(false)
    } else if (!on && layoutBefore) {
        const b = layoutBefore
        layoutBefore = null
        ui.setHasViewer(b.hasViewer)
        ui.setHasGlobe(b.hasGlobe)
        ui.setPanelPercents(b.pp.viewer, b.pp.map, b.pp.globe)
    }
}

export function applyChrome() {
    mapOnly(!S.chrome)
    document.body.classList.toggle('plandevEmbedded', !S.chrome)
    // Shift-click pins terrain samples here, so shift-drag box zoom is MMGIS's only with its full interface.
    Map_.map.boxZoom[S.chrome ? 'enable' : 'disable']()
    setTimeout(() => Map_.map.invalidateSize(), 0)
}

/** Width the inspector takes from the map, so the map (and its fit/reveal) stays the visible part. */
export function applyInspector() {
    const w = S.inspector.open && !S.chrome ? Math.round(Math.min(Math.max(280, S.inspector.width), window.innerWidth * 0.62)) : 0
    document.body.style.setProperty('--pe-inspector', `${w}px`)
    setTimeout(() => Map_.map.invalidateSize({ pan: false }), 0)
    return w
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
    // During a run, a simulation picked in PlanDev (not the one the run asked for) is the user's choice.
    if (S.run && m.planId === prev.planId && m.planId === S.run.planId && m.simulationDatasetId !== prev.simulationDatasetId && m.simulationDatasetId !== S.run.target)
        S.run.userPicked = true
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

/** Called once at load with the UI to mount. Does nothing unless framed by an origin listed in the tool's `embedOrigins`. */
export function initEmbed(mountUI) {
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
            applyInspector()
            onMessage(e)
        }
        window.addEventListener('message', hello)
        Map_.map.on('click', onMapClick)
        Map_.map.on('mousemove', onMouseMove)
        Map_.map.on('mouseout', () => ((S.hover = null), emit()))
        window.addEventListener('keydown', onKey)
        window.addEventListener('resize', applyInspector)
        drawPins()
        mountUI()
        // PlanDev posts on iframe load, likely before this listener existed: ask again.
        for (const o of allowed) window.parent.postMessage({ protocol: PROTOCOL, type: 'ready' }, o)
    }, 250)
}

