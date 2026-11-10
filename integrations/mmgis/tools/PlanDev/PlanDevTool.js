// PlanDev tool: pick targets drawn with MMGIS's Draw tool, run a PlanDev candidate plan for them,
// and show the scheduled/simulated results as map layers. All PlanDev calls go through the
// /api/plandev backend plugin; this file never sees PlanDev credentials. Mission-specific meaning
// (goal parameters, metrics, table columns) comes from the backend's mission adapter, selected by
// this tool's `mission` variable in the MMGIS mission config.
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import ToolController_ from '@basics/ToolController_/ToolController_'
import L_ from '@basics/Layers_/Layers_'
import Map_ from '@basics/Map_/Map_'
import { Button, IconButton } from '@design/components'

import { initEmbed } from './PlanDevEmbed'
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
const state = { fileId: '', checked: {}, params: null, label: '', activeId: null }

function fmt(n, d = 1) {
    return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—'
}

function cell(v, col) {
    if (col.type === 'time') return typeof v === 'string' ? v.replace('T', ' ').slice(0, 19) : '—'
    return typeof v === 'number' ? fmt(v, col.digits ?? 1) : v ?? '—'
}

function delta(m) {
    if (typeof m.value !== 'number' || typeof m.base !== 'number') return ''
    const v = m.value - m.base
    const d = m.digits ?? 1
    return Math.abs(v) < 10 ** -d ? ' (= base)' : ` (${v > 0 ? '+' : ''}${v.toFixed(d)} vs base)`
}

function toTarget(file, f) {
    const fid = f.properties?._?.id
    return {
        type: 'Feature',
        id: `draw-${file.id}-${fid}`,
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
    const id = f.properties?._?.id
    return n && !['Point', 'Polygon'].includes(n) ? n : `${file.file_name} #${id}`
}

function anchor(g) {
    if (g.type === 'Point') return g.coordinates
    if (g.type === 'Polygon') {
        const r = g.coordinates[0].slice(0, -1)
        return [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length]
    }
    return null
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
        description: `Scheduled & simulated results of PlanDev plan ${plan.id}, from its latest simulation dataset.`,
        variables: { useKeyAsName: 'name' },
    })
}

function PlanDevPanel() {
    const [mission, setMission] = useState(null)
    const [uiUrl, setUiUrl] = useState(null)
    const [files, setFiles] = useState([])
    const [file, setFile] = useState(null)
    const [checked, setChecked] = useState(state.checked)
    const [params, setParams] = useState(state.params || {})
    const [label, setLabel] = useState(state.label)
    const [candidates, setCandidates] = useState([])
    const [activeId, setActiveId] = useState(state.activeId)
    const [active, setActive] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const [, force] = useState(0)
    const poll = useRef(null)
    const key = missionKey()

    const refreshCandidates = () => api(`api/plandev/missions/${key}/candidates`).then(setCandidates)

    useEffect(() => {
        api(`api/plandev/missions/${key}/config`)
            .then((c) => {
                setMission(c)
                if (!state.params) setParams(Object.fromEntries(c.params.map((p) => [p.key, p.default])))
            })
            .catch((e) => setError(e.message))
        api('api/plandev/config').then((c) => setUiUrl(c.plandevUiUrl)).catch(() => {})
        refreshCandidates().catch((e) => setError(e.message))
        api('api/files/getfiles', { mission: L_.mission })
            .then((fs) => setFiles(fs.filter((f) => !f.is_master)))
            .catch((e) => setError(`Draw files: ${e.message}`))
    }, [])

    useEffect(() => {
        state.fileId = file?.id ?? state.fileId
    }, [file])

    useEffect(() => {
        if (state.fileId && files.length && !file) loadFile(state.fileId)
    }, [files])

    useEffect(() => {
        Object.assign(state, { checked, params, label, activeId })
    }, [checked, params, label, activeId])

    // Poll the active plan until PlanDev says it is finished.
    useEffect(() => {
        clearTimeout(poll.current)
        if (activeId == null) return
        let stop = false
        const tick = async () => {
            try {
                const c = await api(`api/plandev/plans/${activeId}`)
                if (stop) return
                setActive(c)
                if (c.status === 'running') poll.current = setTimeout(tick, 3000)
                else {
                    refreshCandidates()
                    if (L_.layers.data[layerUuid(activeId)]) window.mmgisAPI.reloadLayer(layerUuid(activeId), true, true, true)
                }
            } catch (e) {
                if (!stop) setError(e.message)
            }
        }
        tick()
        return () => {
            stop = true
            clearTimeout(poll.current)
        }
    }, [activeId])

    async function loadFile(id) {
        const meta = files.find((f) => String(f.id) === String(id))
        if (!meta) return setFile(null)
        const body = await api('api/files/getfile', { id: meta.id })
        setFile({ ...meta, geojson: body.geojson })
    }

    const types = mission?.targets?.types || ['Point', 'Polygon']
    const selectable = (file?.geojson?.features || []).filter((f) => types.includes(f.geometry?.type))
    const selected = selectable.filter((f) => checked[`${file.id}-${f.properties._.id}`])

    async function run() {
        setBusy(true)
        setError(null)
        try {
            const targets = { type: 'FeatureCollection', features: selected.map((f) => toTarget(file, f)) }
            const { planId } = await api(`api/plandev/missions/${key}/candidates`, { targets, params, label })
            await refreshCandidates()
            setActive(null)
            setActiveId(planId)
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
                .then(() => {
                    // Fit once the layer's GeoJSON has arrived.
                    const fit = (n) => {
                        const b = L_.layers.layer[uuid]?.getBounds?.()
                        if (b?.isValid()) Map_.map.fitBounds(b, { padding: [40, 40], maxZoom: 9 })
                        else if (n > 0) setTimeout(() => fit(n - 1), 300)
                    }
                    fit(10)
                })
                .catch((e) => setError(String(e)))
        setTimeout(() => force((n) => n + 1), 300)
    }

    function zoomTo(row) {
        const f = active?.features?.find((x) => x.properties.spanId === row.spanId && x.properties.primary)
        const g = f?.geometry
        const a = g && (g.type === 'LineString' ? g.coordinates[Math.floor(g.coordinates.length / 2)] : g.type === 'Point' ? g.coordinates : null)
        if (a) Map_.map.setView([a[1], a[0]], Math.max(Map_.map.getZoom(), 7))
    }

    const base = mission?.basePlan
    const plans = base ? [{ id: base.id, name: `${base.name} (base)` }, ...candidates] : candidates
    const reason = active?.scheduling?.status === 'failed' ? active.scheduling.reason : active?.simulation?.reason

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

                <h3>1 · Targets from Draw</h3>
                <select value={file?.id ?? ''} onChange={(e) => loadFile(e.target.value)}>
                    <option value=''>Choose a Draw file…</option>
                    {files.map((f) => (
                        <option key={f.id} value={f.id}>
                            {f.file_name} ({f.file_owner})
                        </option>
                    ))}
                </select>
                {file && selectable.length === 0 && <p className='plandevTool_muted'>No {types.join(' or ')} features in this file. Draw some with the Draw tool.</p>}
                <ul className='plandevTool_targets'>
                    {selectable.map((f) => {
                        const k = `${file.id}-${f.properties._.id}`
                        const a = anchor(f.geometry)
                        const n = mission?.targets?.ordered && checked[k] ? selected.indexOf(f) + 1 : null
                        return (
                            <li key={k}>
                                <label>
                                    <input type='checkbox' checked={!!checked[k]} onChange={(e) => setChecked({ ...checked, [k]: e.target.checked })} />
                                    <span>
                                        {n ? `${n}. ` : ''}
                                        {featureLabel(file, f)}
                                    </span>
                                    <span className='plandevTool_muted'>
                                        {f.geometry.type} {fmt(a[1], 3)}°, {fmt(a[0], 3)}°E
                                    </span>
                                </label>
                            </li>
                        )
                    })}
                </ul>
                <p className='plandevTool_muted'>
                    {mission?.conventions?.body}: {mission?.conventions?.coordinates}.{mission?.targets?.ordered ? ' Ticked targets are sent in the order they appear in the Draw file.' : ''}
                </p>

                <h3>2 · Schedule on a copy of “{base?.name ?? '…'}”</h3>
                <div className='plandevTool_grid'>
                    {(mission?.params || []).flatMap((p) => [
                        <label key={`${p.key}-l`}>
                            {p.label}
                            {p.unit ? ` (${p.unit})` : ''}
                        </label>,
                        p.type === 'enum' ? (
                            <select key={p.key} value={params[p.key] ?? p.default} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })}>
                                {p.options.map((o) => (
                                    <option key={o}>{o}</option>
                                ))}
                            </select>
                        ) : (
                            <input key={p.key} type='number' min={p.min} max={p.max} value={params[p.key] ?? p.default} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })} />
                        ),
                    ])}
                    <label>Label (optional)</label>
                    <input type='text' maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
                </div>
                <p className='plandevTool_muted'>{mission?.mission?.help}</p>
                <Button variant='primary' disabled={busy || selected.length === 0 || !mission} onClick={run}>
                    {busy ? 'Creating…' : `Create candidate for ${selected.length} target${selected.length === 1 ? '' : 's'}`}
                </Button>

                <h3>3 · Plans</h3>
                <ul className='plandevTool_candidates'>
                    {plans.map((c, i) => (
                        <li key={c.id} className={c.id === activeId ? 'active' : ''}>
                            <span className='swatch' style={{ background: COLORS[i % COLORS.length] }} />
                            <button className='link' onClick={() => setActiveId(c.id)}>
                                #{c.id} {c.name.replace(`${base?.name ?? ''} · `, '')}
                            </button>
                            <IconButton size='sm' title='Show/hide on map' onClick={() => toggleLayer(c, i)}>
                                <i className={`mdi ${L_.layers.data[layerUuid(c.id)] ? 'mdi-eye' : 'mdi-eye-off-outline'} mdi-18px`} />
                            </IconButton>
                        </li>
                    ))}
                    {candidates.length === 0 && <li className='plandevTool_muted'>No candidates yet.</li>}
                </ul>

                {active && (
                    <div className='plandevTool_result'>
                        <div>
                            <b>#{active.plan.id}</b> {active.plan.name}
                        </div>
                        <div>
                            Status: <b className={`status ${active.status.replace(/\W+/g, '-')}`}>{active.status}</b>
                            {active.status === 'running' && ' (PlanDev scheduling → simulation)'}
                        </div>
                        <div className='plandevTool_muted'>
                            Plan revision {active.provenance.planRevision} · simulation dataset {active.provenance.simulationDatasetId ?? '—'}
                            {active.provenance.simulatedPlanRevision != null && active.provenance.simulatedPlanRevision !== active.provenance.planRevision && ' (simulated an older revision)'}
                        </div>
                        {active.inputs && (
                            <div className='plandevTool_muted'>
                                Inputs: {active.inputs.targets.features.length} target(s); {Object.entries(active.inputs.params).map(([k, v]) => `${k}=${v}`).join(', ')}
                            </div>
                        )}
                        {uiUrl && (
                            <a href={`${uiUrl}/plans/${active.plan.id}`} target='_blank' rel='noreferrer'>
                                Open plan in PlanDev ↗
                            </a>
                        )}
                        {reason && <pre className='plandevTool_error'>{reason.message || JSON.stringify(reason).slice(0, 500)}</pre>}

                        {active.status === 'complete' && (
                            <>
                                {active.table && active.table.rows.length > 0 && (
                                    <>
                                        <h4>Activities (simulated)</h4>
                                        <table>
                                            <thead>
                                                <tr>
                                                    {active.table.columns.map((c) => (
                                                        <th key={c.key}>
                                                            {c.label}
                                                            {c.unit ? ` ${c.unit}` : ''}
                                                        </th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {active.table.rows.map((r) => (
                                                    <tr key={r.spanId} onClick={() => zoomTo(r)} title={`span ${r.spanId}, directive ${r.directiveId}`}>
                                                        {active.table.columns.map((c) => (
                                                            <td key={c.key}>{cell(r[c.key], c)}</td>
                                                        ))}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </>
                                )}
                                <h4>Plan metrics (simulated)</h4>
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
                                        {c.name}: {c.errors.length ? c.errors.join('; ') : c.windows.length ? `${c.windows.length} violation window(s), first ${new Date(c.windows[0].startMs).toISOString().slice(11, 19)} UTC` : 'no violations'}
                                    </div>
                                ))}
                                {active.notes.map((n) => (
                                    <div key={n.text} className={n.warn ? 'plandevTool_warn' : 'plandevTool_muted'}>
                                        {n.text}
                                    </div>
                                ))}
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}

const PlanDevTool = {
    height: 0,
    width: 420,
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
    },
}

export default PlanDevTool
