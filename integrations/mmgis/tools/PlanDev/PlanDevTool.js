// PlanDev tool: work on an existing PlanDev plan from the map.
//   Inspect  — the plan's simulated spatial result, metrics and constraints, compared with its source.
//   Evaluate — read-only: check Draw features against the plan's simulation. Creates nothing.
//   Revise   — derive a candidate from the plan with edited spatial inputs (PlanDev duplicates the
//              plan, the mission goal's earlier output is replaced, everything else is kept).
// Standalone, the plan is picked here; embedded in PlanDev, it is the plan PlanDev has open.
// All PlanDev calls go through the /api/plandev backend plugin; this file never sees PlanDev
// credentials. Mission meaning (parameters, metrics, tables) comes from the backend's adapter,
// selected by this tool's `mission` variable in the MMGIS mission config.
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import ToolController_ from '@basics/ToolController_/ToolController_'
import L_ from '@basics/Layers_/Layers_'
import Map_ from '@basics/Map_/Map_'
import { Button, IconButton } from '@design/components'

import { embedded, initEmbed, openPlanInPlanDev } from './PlanDevEmbed'
import './PlanDevTool.css'

initEmbed()

const root = () => (window.mmgisglobal.ROOT_PATH ? `${window.mmgisglobal.ROOT_PATH}/` : '')
const COLORS = ['#00e5ff', '#ff9100', '#d500f9', '#76ff03', '#ffea00', '#ff1744']
const layerUuid = (planId) => `plandev-plan-${planId}`
const missionKey = () => L_.getToolVars('plandev')?.mission || 'mro'

async function api(path, body) {
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

// Survives close/reopen of the tool panel.
const state = { fileId: '', checked: {}, params: null, evalParams: null, label: '', planId: null, mode: 'inspect', compare: {} }

const fmt = (n, d = 1) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—')
const cell = (v, col) => (col.type === 'time' ? (typeof v === 'string' ? v.replace('T', ' ').slice(0, 19) : '—') : typeof v === 'number' ? fmt(v, col.digits ?? 1) : v ?? '—')

function delta(m) {
    if (typeof m.value !== 'number' || typeof m.base !== 'number') return ''
    const v = m.value - m.base
    const d = m.digits ?? 1
    return Math.abs(v) < 10 ** -d ? ' (= source)' : ` (${v > 0 ? '+' : ''}${v.toFixed(d)} vs source)`
}

// A target's id survives edits: features copied from a plan carry their original id in targetId.
function toTarget(file, f) {
    const fid = f.properties?._?.id
    return {
        type: 'Feature',
        id: f.properties?.targetId || `draw-${file.id}-${fid}`,
        properties: {
            name: featureLabel(file, f),
            source: { app: 'mmgis', mission: L_.mission, drawFileId: file.id, drawFileName: file.file_name, featureId: fid },
        },
        geometry: f.geometry,
    }
}

// Draw names new features after their shape ("Point"); fall back to file + feature id then.
function featureLabel(file, f) {
    const n = f.properties?.name
    return n && !['Point', 'Polygon'].includes(n) ? n : `${file.file_name} #${f.properties?._?.id}`
}

function showLayer(plan, colorIndex) {
    const uuid = layerUuid(plan.id)
    if (L_.layers.data[uuid]) return Promise.resolve()
    const color = COLORS[colorIndex % COLORS.length]
    return window.mmgisAPI.addLayer({
        name: `PlanDev ${plan.id}: ${plan.name}`,
        uuid,
        type: 'vector',
        url: new URL(`${root()}api/plandev/plans/${plan.id}/geojson`, document.baseURI).href, // absolute: not under the mission folder
        controlled: false,
        visibility: true,
        initialOpacity: 1,
        radius: 7,
        // Beyond the documented name/type minimum, the vector renderer reads these (it throws on a missing one).
        kind: 'none',
        shape: 'none',
        demparser: '',
        layer3dType: 'clamped',
        tags: ['plandev'],
        legend: '',
        time: { enabled: false, type: 'requery', isRelative: true, current: '', start: '', end: '', startProp: '', endProp: '', format: '%Y-%m-%dT%H:%M:%SZ' },
        style: { className: 'plandevCandidate', color, fillColor: color, weight: 3, fillOpacity: 0.35, opacity: 1 },
        description: `Simulated results of PlanDev plan ${plan.id}, from its latest simulation dataset. Solid: simulated states; dashed: assumed paths; dotted white: inputs.`,
        variables: { useKeyAsName: 'name' },
    })
}

function fitLayer(uuid, n = 10) {
    const b = L_.layers.layer[uuid]?.getBounds?.()
    if (b?.isValid()) Map_.map.fitBounds(b, { padding: [40, 40], maxZoom: 9 })
    else if (n > 0) setTimeout(() => fitLayer(uuid, n - 1), 300)
}

// Evaluation geometry is transient analysis output, so it is a plain Leaflet overlay, not an MMGIS layer.
let analysisLayer = null
function showAnalysis(features) {
    if (analysisLayer) Map_.map.removeLayer(analysisLayer)
    analysisLayer = null
    if (!features?.length) return
    analysisLayer = window.L.geoJSON(
        { type: 'FeatureCollection', features },
        {
            style: (f) => ({ color: '#ffea00', weight: 2, fillOpacity: 0.12, ...f.properties.style, ...(f.properties.visited === false && { color: '#ff6e6e' }) }),
            pointToLayer: (f, ll) => window.L.circleMarker(ll, { radius: 9 }),
            onEachFeature: (f, l) => l.bindTooltip(f.properties.name),
        },
    ).addTo(Map_.map)
}

/** Plans in display order: each root followed by its descendants, with depth. */
function tree(plans) {
    const kids = new Map()
    for (const p of plans) kids.set(p.parent_id, [...(kids.get(p.parent_id) || []), p])
    const ids = new Set(plans.map((p) => p.id))
    const out = []
    const walk = (p, depth) => {
        out.push({ ...p, depth })
        for (const c of kids.get(p.id) || []) walk(c, depth + 1)
    }
    for (const p of plans) if (!ids.has(p.parent_id)) walk(p, 0)
    return out
}

function TargetPicker({ files, file, loadFile, types, checked, setChecked, ordered }) {
    const selectable = (file?.geojson?.features || []).filter((f) => types.includes(f.geometry?.type))
    const selected = selectable.filter((f) => checked[`${file.id}-${f.properties._.id}`])
    return (
        <>
            <div className='plandevTool_row'>
                <select value={file?.id ?? ''} onChange={(e) => loadFile(e.target.value)}>
                    <option value=''>Choose a Draw file…</option>
                    {files.map((f) => (
                        <option key={f.id} value={f.id}>
                            {f.file_name} ({f.file_owner})
                        </option>
                    ))}
                </select>
                <IconButton size='sm' title='Reload the file after editing it with the Draw tool' disabled={!file} onClick={() => loadFile(file.id)}>
                    <i className='mdi mdi-refresh mdi-18px' />
                </IconButton>
            </div>
            {file && selectable.length === 0 && <p className='plandevTool_muted'>No {types.join(' or ')} features in this file. Draw some with the Draw tool.</p>}
            <ul className='plandevTool_targets'>
                {selectable.map((f) => {
                    const k = `${file.id}-${f.properties._.id}`
                    const n = ordered && checked[k] ? selected.indexOf(f) + 1 : null
                    const c = f.geometry.type === 'Point' ? f.geometry.coordinates : f.geometry.coordinates[0][0]
                    return (
                        <li key={k}>
                            <label>
                                <input type='checkbox' checked={!!checked[k]} onChange={(e) => setChecked({ ...checked, [k]: e.target.checked })} />
                                <span>
                                    {n ? `${n}. ` : ''}
                                    {featureLabel(file, f)}
                                </span>
                                <span className='plandevTool_muted'>
                                    {f.geometry.type} {fmt(c[1], 3)}°, {fmt(c[0], 3)}°E
                                </span>
                            </label>
                        </li>
                    )
                })}
            </ul>
            {ordered && <p className='plandevTool_muted'>Ticked features are sent in the order they appear in the Draw file.</p>}
        </>
    )
}

function selectedFeatures(file, types, checked) {
    return (file?.geojson?.features || []).filter((f) => types.includes(f.geometry?.type) && checked[`${file.id}-${f.properties._.id}`])
}

function ParamForm({ spec, values, set }) {
    return (spec || []).flatMap((p) => [
        <label key={`${p.key}-l`}>
            {p.label}
            {p.unit ? ` (${p.unit})` : ''}
        </label>,
        p.type === 'enum' ? (
            <select key={p.key} value={values[p.key] ?? p.default} onChange={(e) => set({ ...values, [p.key]: e.target.value })}>
                {p.options.map((o) => (
                    <option key={o}>{o}</option>
                ))}
            </select>
        ) : (
            <input key={p.key} type='number' min={p.min} max={p.max} value={values[p.key] ?? p.default} onChange={(e) => set({ ...values, [p.key]: e.target.value })} />
        ),
    ])
}

function Table({ table, onRow }) {
    if (!table?.rows?.length) return null
    return (
        <table>
            <thead>
                <tr>
                    {table.columns.map((c) => (
                        <th key={c.key}>
                            {c.label}
                            {c.unit ? ` ${c.unit}` : ''}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {table.rows.map((r, i) => (
                    <tr key={r.spanId ?? i} onClick={() => onRow?.(r)}>
                        {table.columns.map((c) => (
                            <td key={c.key}>{cell(r[c.key], c)}</td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    )
}

const violations = (v) => (v.constraints || []).reduce((n, c) => n + c.windows.length + c.errors.length, 0)

function PlanDevPanel() {
    const key = missionKey()
    const [mission, setMission] = useState(null)
    const [uiUrl, setUiUrl] = useState(null)
    const [plans, setPlans] = useState([])
    const [embed, setEmbed] = useState(embedded())
    const [pickedId, setPickedId] = useState(state.planId)
    const [active, setActive] = useState(null)
    const [mode, setMode] = useState(state.mode)
    const [files, setFiles] = useState([])
    const [file, setFile] = useState(null)
    const [checked, setChecked] = useState(state.checked)
    const [params, setParams] = useState(state.params || {})
    const [evalParams, setEvalParams] = useState(state.evalParams || {})
    const [label, setLabel] = useState(state.label)
    const [evalResult, setEvalResult] = useState(null)
    const [created, setCreated] = useState(null)
    const [compare, setCompare] = useState(state.compare)
    const [compareViews, setCompareViews] = useState({})
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const [, force] = useState(0)
    const poll = useRef(null)
    const plansRef = useRef([])
    plansRef.current = plans

    // Embedded: the plan (and dataset) PlanDev has open. Standalone: the plan picked here.
    const planId = embed?.ctx?.planId ?? pickedId
    const datasetId = embed ? embed.ctx.simulationDatasetId : null
    const viewKey = `${planId}/${datasetId}/${embed?.ctx?.planRevision ?? ''}`

    const refreshPlans = () => api(`api/plandev/missions/${key}/plans`).then(setPlans)

    useEffect(() => {
        api(`api/plandev/missions/${key}/config`)
            .then((c) => {
                setMission(c)
                if (!state.evalParams && c.evaluation) setEvalParams(Object.fromEntries(c.evaluation.params.map((p) => [p.key, p.default])))
                if (state.planId == null && !embedded()) setPickedId(c.defaultPlanId)
            })
            .catch((e) => setError(e.message))
        api('api/plandev/config').then((c) => setUiUrl(c.plandevUiUrl)).catch(() => {})
        refreshPlans().catch((e) => setError(e.message))
        loadFiles()
        const onEmbed = (e) => setEmbed(e.detail)
        document.addEventListener('plandev:embed', onEmbed)
        return () => document.removeEventListener('plandev:embed', onEmbed)
    }, [])

    useEffect(() => {
        if (state.fileId && files.length && !file) loadFile(state.fileId)
    }, [files])

    useEffect(() => {
        Object.assign(state, { checked, params, evalParams, label, planId: pickedId, mode, compare, fileId: file?.id ?? state.fileId })
    }, [checked, params, evalParams, label, pickedId, mode, compare, file])

    // Load (and poll while running) the selected plan's view, at the dataset PlanDev shows when embedded.
    useEffect(() => {
        clearTimeout(poll.current)
        setEvalResult(null)
        showAnalysis(null)
        if (planId == null) return
        let stop = false
        const tick = async () => {
            try {
                const q = new URLSearchParams({ mission: key, ...(datasetId != null && { simulationDatasetId: datasetId }) })
                const v = await api(`api/plandev/plans/${planId}?${q}`)
                if (stop) return
                setActive(v)
                setError(null)
                if (v.inputs && !state.paramsFor?.startsWith(`${planId}/`)) {
                    // Start a revision from the plan's own goal parameters.
                    setParams(v.inputs.params)
                    state.paramsFor = `${planId}/`
                }
                if (v.status === 'running') poll.current = setTimeout(tick, 3000)
                else if (!embedded() && !L_.layers.data[layerUuid(planId)]) {
                    // Standalone: show the selected plan (embedded, PlanDevEmbed already does), replacing the
                    // previously selected one unless it is ticked for comparison.
                    const prev = state.shownPlanId
                    if (prev != null && prev !== planId && !state.compare[prev] && L_.layers.data[layerUuid(prev)]) window.mmgisAPI.removeLayer(layerUuid(prev))
                    state.shownPlanId = planId
                    await showLayer(v.plan, Math.max(0, tree(plansRef.current).findIndex((p) => p.id === planId))).catch((e) => setError(String(e)))
                    fitLayer(layerUuid(planId))
                    force((n) => n + 1)
                }
            } catch (e) {
                if (!stop) setError(e.message)
            }
        }
        setActive(null)
        tick()
        return () => {
            stop = true
            clearTimeout(poll.current)
        }
    }, [viewKey])

    // Poll a just-created candidate until it finishes, then refresh the plan list and comparison.
    useEffect(() => {
        if (!created) return
        let stop = false
        const tick = async () => {
            const v = await api(`api/plandev/plans/${created.planId}?mission=${key}`).catch(() => null)
            if (stop) return
            if (v) setCreated((c) => ({ ...c, view: v }))
            if (!v || v.status === 'running') setTimeout(tick, 3000)
            else {
                refreshPlans()
                setCompare((c) => ({ ...c, [created.planId]: true }))
            }
        }
        tick()
        return () => {
            stop = true
        }
    }, [created?.planId])

    // Comparison: the views of the ticked plans.
    const compareIds = Object.keys(compare).filter((id) => compare[id]).map(Number)
    useEffect(() => {
        for (const id of compareIds)
            if (!compareViews[id] || compareViews[id].status === 'running')
                api(`api/plandev/plans/${id}?mission=${key}`)
                    .then((v) => setCompareViews((cv) => ({ ...cv, [id]: v })))
                    .catch((e) => setError(e.message))
    }, [compareIds.join(','), created?.view?.status])

    function loadFiles() {
        return api('api/files/getfiles', { mission: L_.mission })
            .then((fs) => setFiles(fs.filter((f) => !f.is_master)))
            .catch((e) => setError(`Draw files: ${e.message}`))
    }

    async function loadFile(id) {
        const meta = files.find((f) => String(f.id) === String(id))
        if (!meta) return setFile(null)
        const body = await api('api/files/getfile', { id: meta.id })
        setFile({ ...meta, geojson: body.geojson })
    }

    // Revise: put the plan's current goal inputs in a new Draw file, so they can be edited with the Draw tool.
    async function copyInputsToDraw() {
        setBusy(true)
        setError(null)
        try {
            const features = active.inputs.targets.features.map((f) => ({
                type: 'Feature',
                properties: { name: f.properties?.name ?? f.id, targetId: f.id },
                geometry: f.geometry,
            }))
            const name = `Plan ${active.plan.id} inputs (rev ${active.plan.revision})`
            await api('api/files/make', { mission: L_.mission, file_name: name, file_description: `Goal inputs of PlanDev plan ${active.plan.id}`, intent: 'all', geojson: JSON.stringify({ type: 'FeatureCollection', features }) })
            const fs = (await api('api/files/getfiles', { mission: L_.mission })).filter((f) => !f.is_master)
            setFiles(fs)
            const made = fs.filter((f) => f.file_name === name).sort((a, b) => b.id - a.id)[0]
            const body = await api('api/files/getfile', { id: made.id })
            setFile({ ...made, geojson: body.geojson })
            setChecked(Object.fromEntries(body.geojson.features.map((f) => [`${made.id}-${f.properties._.id}`, true])))
        } catch (e) {
            setError(e.message)
        } finally {
            setBusy(false)
        }
    }

    async function revise() {
        setBusy(true)
        setError(null)
        try {
            const targets = { type: 'FeatureCollection', features: selectedFeatures(file, mission.targets.types, checked).map((f) => toTarget(file, f)) }
            const r = await api(`api/plandev/plans/${planId}/candidates`, { mission: key, targets, params, label, expectedRevision: active.plan.revision })
            setCreated(r)
            setCompare((c) => ({ ...c, [planId]: true, [r.planId]: true }))
            await refreshPlans()
        } catch (e) {
            setError(e.message)
        } finally {
            setBusy(false)
        }
    }

    async function evaluate() {
        setBusy(true)
        setError(null)
        try {
            const targets = { type: 'FeatureCollection', features: selectedFeatures(file, mission.evaluation.targets.types, checked).map((f) => toTarget(file, f)) }
            const r = await api(`api/plandev/plans/${planId}/evaluate`, { mission: key, simulationDatasetId: active.provenance.simulationDatasetId, targets, params: evalParams })
            setEvalResult(r)
            showAnalysis(r.features)
        } catch (e) {
            setError(e.message)
        } finally {
            setBusy(false)
        }
    }

    function toggleLayer(plan, i) {
        const uuid = layerUuid(plan.id)
        if (L_.layers.data[uuid]) window.mmgisAPI.removeLayer(uuid)
        else
            showLayer(plan, i)
                .then(() => fitLayer(uuid))
                .catch((e) => setError(String(e)))
        setTimeout(() => force((n) => n + 1), 300)
    }

    function zoomTo(row) {
        const f = active?.features?.find((x) => x.properties.spanId === row.spanId && x.properties.primary)
        const g = f?.geometry
        const a = g && (g.type === 'LineString' ? g.coordinates[Math.floor(g.coordinates.length / 2)] : g.type === 'Point' ? g.coordinates : null)
        if (a) Map_.map.setView([a[1], a[0]], Math.max(Map_.map.getZoom(), 7))
    }

    const ordered = tree(plans)
    const colorOf = (id) => COLORS[Math.max(0, ordered.findIndex((p) => p.id === id)) % COLORS.length]
    const reviseTypes = mission?.targets?.types || []
    const evalTypes = mission?.evaluation?.targets?.types || []
    const nRevise = selectedFeatures(file, reviseTypes, checked).length
    const nEval = selectedFeatures(file, evalTypes, checked).length
    const reason = active?.scheduling?.status === 'failed' ? active.scheduling.reason : active?.simulation?.reason
    const cmp = compareIds.map((id) => compareViews[id]).filter(Boolean)
    const metricKeys = cmp[0]?.summary?.map((m) => m.key) || []
    const ready = active && ['complete', 'stale'].includes(active.status)

    return (
        <div className='plandevTool'>
            <div className='mmgisToolHeader'>
                <div>
                    <div>
                        <div className='mmgisToolTitle'>PlanDev · {mission?.mission?.label ?? key}</div>
                    </div>
                    <div>
                        <IconButton size='sm' onClick={() => ToolController_.closeActiveTool()} title='Close Tool'>
                            <i className='mdi mdi-close mdi-18px' />
                        </IconButton>
                    </div>
                </div>
            </div>
            <div className='plandevTool_content'>
                {error && <div className='plandevTool_error'>{error}</div>}

                <h3>Plan</h3>
                {embed ? (
                    <div className='plandevTool_muted'>Following the plan open in PlanDev{embed.ctx?.planId == null ? ' (none)' : ''}.</div>
                ) : (
                    <select value={pickedId ?? ''} onChange={(e) => setPickedId(Number(e.target.value))}>
                        {ordered.map((p) => (
                            <option key={p.id} value={p.id}>
                                {' '.repeat(p.depth * 3)}
                                {p.depth ? '↳ ' : ''}#{p.id} {p.name}
                            </option>
                        ))}
                    </select>
                )}
                {active && (
                    <div className='plandevTool_result'>
                        <div>
                            <b>#{active.plan.id}</b> {active.plan.name}
                        </div>
                        <div className='plandevTool_muted'>
                            {active.derivedFrom
                                ? `Derived from #${active.derivedFrom.id}${active.derivedFrom.name ? ` “${active.derivedFrom.name}”` : ''} at its revision ${active.derivedFrom.revisionAtDerivation ?? '?'}${active.derivedFrom.revisionNow != null && active.derivedFrom.revisionNow !== active.derivedFrom.revisionAtDerivation ? ` (now ${active.derivedFrom.revisionNow})` : ''}`
                                : 'Source plan (not derived from another plan)'}
                        </div>
                        <div>
                            Status: <b className={`status ${active.status.replace(/\W+/g, '-')}`}>{active.status}</b>
                            {active.status === 'running' && ' (PlanDev scheduling → simulation)'}
                        </div>
                        <div className='plandevTool_muted'>
                            Plan revision {active.provenance.planRevision} · simulation dataset {active.provenance.simulationDatasetId ?? '—'} (of revision {active.provenance.simulatedPlanRevision ?? '—'})
                        </div>
                        {active.inputsEditedSinceScheduling && <div className='plandevTool_warn'>The goal’s inputs were edited after the last scheduling run.</div>}
                        {uiUrl && !embed && (
                            <a href={`${uiUrl}/plans/${active.plan.id}`} target='_blank' rel='noreferrer'>
                                Open plan in PlanDev ↗
                            </a>
                        )}
                        {reason && <pre className='plandevTool_error'>{reason.message || JSON.stringify(reason).slice(0, 500)}</pre>}
                    </div>
                )}

                <div className='plandevTool_modes'>
                    {[
                        ['inspect', 'Inspect'],
                        ['evaluate', 'Evaluate (read-only)'],
                        ['revise', 'Revise → new candidate'],
                    ].map(([m, l]) => (
                        <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)} disabled={m === 'evaluate' && !mission?.evaluation}>
                            {l}
                        </button>
                    ))}
                </div>

                {mode === 'inspect' && ready && (
                    <>
                        {active.notes.map((n) => (
                            <div key={n.text} className={n.warn ? 'plandevTool_warn' : 'plandevTool_muted'}>
                                {n.text}
                            </div>
                        ))}
                        <h4>Activities (simulated)</h4>
                        <Table table={active.table} onRow={zoomTo} />
                        <h4>Plan metrics (simulated){active.derivedFrom?.simulationDatasetId ? ` · Δ vs #${active.derivedFrom.id}` : ''}</h4>
                        <ul className='plandevTool_metrics'>
                            {active.summary.map((m) => (
                                <li key={m.key}>
                                    {m.name}: {fmt(m.value, m.digits ?? 1)} {m.unit}
                                    <span className='plandevTool_muted'>{delta(m)}</span>
                                </li>
                            ))}
                        </ul>
                        {active.constraints?.length > 0 && <h4>Constraints</h4>}
                        {(active.constraints || []).map((c) => (
                            <div key={c.name} className={`plandevTool_constraint ${c.windows.length || c.errors.length ? 'bad' : 'ok'}`}>
                                {c.name}: {c.errors.length ? c.errors.join('; ') : c.windows.length ? c.windows.map((w) => `${new Date(w.startMs).toISOString().slice(11, 16)}–${new Date(w.endMs).toISOString().slice(11, 16)}`).join(', ') + ' UTC' : 'no violations'}
                            </div>
                        ))}
                    </>
                )}

                {mode === 'evaluate' && mission?.evaluation && (
                    <>
                        <p className='plandevTool_muted'>{mission.evaluation.help}</p>
                        <TargetPicker files={files} file={file} loadFile={loadFile} types={evalTypes} checked={checked} setChecked={setChecked} />
                        <div className='plandevTool_grid'>
                            <ParamForm spec={mission.evaluation.params} values={evalParams} set={setEvalParams} />
                        </div>
                        <Button variant='primary' disabled={busy || !nEval || !ready} onClick={evaluate}>
                            {busy ? 'Evaluating…' : `Evaluate ${nEval} feature${nEval === 1 ? '' : 's'} against #${planId}`}
                        </Button>
                        {evalResult && (
                            <div className='plandevTool_result'>
                                <div className='plandevTool_muted'>
                                    Plan #{evalResult.provenance.planId} rev {evalResult.provenance.planRevision} · simulation dataset {evalResult.provenance.simulationDatasetId}
                                    {evalResult.stale ? ' (stale)' : ''} · nothing was created in PlanDev
                                </div>
                                {evalResult.summary.map((m) => (
                                    <div key={m.key}>
                                        <b>
                                            {m.name}: {fmt(m.value, m.digits ?? 1)} {m.unit}
                                        </b>
                                    </div>
                                ))}
                                <Table table={evalResult.table} />
                                {evalResult.notes.map((n) => (
                                    <div key={n.text} className={n.warn ? 'plandevTool_warn' : 'plandevTool_muted'}>
                                        {n.text}
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}

                {mode === 'revise' && mission && (
                    <>
                        <p className='plandevTool_muted'>
                            Creates a new plan from #{planId} (revision {active?.plan?.revision ?? '…'}): activities the mission goal created there are replaced; all other activities, constraints and simulation settings are kept. #{planId} is not changed.
                        </p>
                        {active?.inputs && (
                            <Button disabled={busy} onClick={copyInputsToDraw}>
                                Copy #{planId}’s {active.inputs.targets.features.length} goal inputs to a new Draw file
                            </Button>
                        )}
                        <TargetPicker files={files} file={file} loadFile={loadFile} types={reviseTypes} checked={checked} setChecked={setChecked} ordered={mission.targets.ordered} />
                        <div className='plandevTool_grid'>
                            <ParamForm spec={mission.params} values={params} set={setParams} />
                            <label>Label (optional)</label>
                            <input type='text' maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
                        </div>
                        <p className='plandevTool_muted'>{mission.mission.help}</p>
                        <Button variant='primary' disabled={busy || !nRevise || !active} onClick={revise}>
                            {busy ? 'Creating…' : `Create candidate from #${planId} with ${nRevise} input${nRevise === 1 ? '' : 's'}`}
                        </Button>
                        {created && (
                            <div className='plandevTool_result'>
                                <div>
                                    Created <b>#{created.planId}</b> from #{created.sourcePlanId} rev {created.sourceRevision}; replaced {created.replacedDirectives} goal-created activities.
                                </div>
                                <div>
                                    Status: <b className={`status ${(created.view?.status || 'running').replace(/\W+/g, '-')}`}>{created.view?.status || 'running'}</b>
                                </div>
                                {embed ? (
                                    <Button onClick={() => openPlanInPlanDev(created.planId)}>Open #{created.planId} in PlanDev</Button>
                                ) : (
                                    <Button onClick={() => setPickedId(created.planId)}>Select #{created.planId}</Button>
                                )}
                            </div>
                        )}
                    </>
                )}

                <h3>Compare</h3>
                <ul className='plandevTool_candidates'>
                    {ordered.map((p) => (
                        <li key={p.id} className={p.id === planId ? 'active' : ''} style={{ paddingLeft: 4 + p.depth * 14 }}>
                            <input type='checkbox' checked={!!compare[p.id]} onChange={(e) => setCompare({ ...compare, [p.id]: e.target.checked })} title={`Compare #${p.id}`} />
                            <span className='swatch' style={{ background: colorOf(p.id) }} />
                            <span className='name' title={p.name}>
                                #{p.id} {p.name.replace(/^.* · from #\d+ · /, '')}
                            </span>
                            {embed ? (
                                p.id !== planId && (
                                    <IconButton size='sm' title='Open in PlanDev' onClick={() => openPlanInPlanDev(p.id)}>
                                        <i className='mdi mdi-open-in-app mdi-18px' />
                                    </IconButton>
                                )
                            ) : (
                                <IconButton size='sm' title='Select' onClick={() => setPickedId(p.id)}>
                                    <i className='mdi mdi-cursor-default-click-outline mdi-18px' />
                                </IconButton>
                            )}
                            <IconButton size='sm' title='Show/hide on map' onClick={() => toggleLayer(p, ordered.indexOf(p))}>
                                <i className={`mdi ${L_.layers.data[layerUuid(p.id)] ? 'mdi-eye' : 'mdi-eye-off-outline'} mdi-18px`} />
                            </IconButton>
                        </li>
                    ))}
                </ul>
                {cmp.length > 0 && (
                    <div className='plandevTool_compare'>
                        <table>
                            <thead>
                                <tr>
                                    <th />
                                    {cmp.map((v) => (
                                        <th key={v.plan.id} style={{ color: colorOf(v.plan.id) }}>
                                            #{v.plan.id}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td>Status</td>
                                    {cmp.map((v) => (
                                        <td key={v.plan.id}>{v.status}</td>
                                    ))}
                                </tr>
                                {metricKeys.map((k) => {
                                    const m0 = cmp[0].summary.find((m) => m.key === k)
                                    return (
                                        <tr key={k}>
                                            <td>
                                                {m0.name} {m0.unit && `(${m0.unit})`}
                                            </td>
                                            {cmp.map((v) => (
                                                <td key={v.plan.id}>{fmt(v.summary.find((m) => m.key === k)?.value, m0.digits ?? 1)}</td>
                                            ))}
                                        </tr>
                                    )
                                })}
                                {(cmp[0].constraints || []).map((c0) => (
                                    <tr key={c0.name}>
                                        <td>{c0.name} violations</td>
                                        {cmp.map((v) => {
                                            const c = (v.constraints || []).find((x) => x.name === c0.name)
                                            const n = c ? c.windows.length + c.errors.length : null
                                            return (
                                                <td key={v.plan.id} className={n ? 'bad' : 'ok'} title={c?.windows.map((w) => new Date(w.startMs).toISOString().slice(11, 16)).join(', ')}>
                                                    {n ?? '—'}
                                                </td>
                                            )
                                        })}
                                    </tr>
                                ))}
                                <tr>
                                    <td>All constraint violations</td>
                                    {cmp.map((v) => (
                                        <td key={v.plan.id}>{v.constraints ? violations(v) : '—'}</td>
                                    ))}
                                </tr>
                            </tbody>
                        </table>
                        <p className='plandevTool_muted'>Each column: the plan’s latest simulation dataset. Toggle the eye icons to overlay their routes.</p>
                    </div>
                )}
            </div>
        </div>
    )
}

const PlanDevTool = {
    height: 0,
    width: 460,
    _root: null,
    make: function () {
        const toolPanel = document.getElementById('toolPanel')
        if (toolPanel) toolPanel.innerHTML = ''
        PlanDevTool._root = createRoot(toolPanel)
        PlanDevTool._root.render(<PlanDevPanel />)
    },
    destroy: function () {
        if (PlanDevTool._root) {
            PlanDevTool._root.unmount()
            PlanDevTool._root = null
        }
        showAnalysis(null)
    },
}

export default PlanDevTool
