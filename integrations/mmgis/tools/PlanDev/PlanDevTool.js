// PlanDev tool: pick targets drawn with MMGIS's Draw tool, run a PlanDev candidate plan for them,
// and show the scheduled/simulated results as map layers. All PlanDev calls go through the
// /api/plandev backend plugin; this file never sees PlanDev credentials.
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import ToolController_ from '@basics/ToolController_/ToolController_'
import L_ from '@basics/Layers_/Layers_'
import Map_ from '@basics/Map_/Map_'
import { Button, IconButton } from '@design/components'

import './PlanDevTool.css'

const root = () => (window.mmgisglobal.ROOT_PATH ? `${window.mmgisglobal.ROOT_PATH}/` : '')
const COLORS = ['#00e5ff', '#ff9100', '#d500f9', '#76ff03', '#ffea00', '#ff1744']
const layerUuid = (planId) => `plandev-candidate-${planId}`

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
const state = {
    fileId: '',
    checked: {},
    params: { maxGroundDistanceKm: 100, observationDurationSec: 300, mode: 'HI_RES' },
    label: '',
    activeId: null,
}

function fmt(n, d = 1) {
    return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—'
}

function delta(a, b, d = 1) {
    if (typeof a !== 'number' || typeof b !== 'number') return ''
    const v = a - b
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

function showLayer(c, colorIndex) {
    const uuid = layerUuid(c.id)
    if (L_.layers.data[uuid]) return Promise.resolve()
    const color = COLORS[colorIndex % COLORS.length]
    return window.mmgisAPI.addLayer({
        name: `PlanDev ${c.id}: ${c.name}`,
        uuid,
        type: 'vector',
        url: new URL(`${root()}api/plandev/candidates/${c.id}/geojson`, document.baseURI).href, // absolute: not under the mission folder
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
        description: `Scheduled & simulated results of PlanDev plan ${c.id}. Tracks are the simulated MRO sub-spacecraft ground track (subSCBodies_MARS_*).`,
        variables: {},
    })
}

function PlanDevPanel() {
    const [config, setConfig] = useState(null)
    const [files, setFiles] = useState([])
    const [file, setFile] = useState(null)
    const [checked, setChecked] = useState(state.checked)
    const [params, setParams] = useState(state.params)
    const [label, setLabel] = useState(state.label)
    const [candidates, setCandidates] = useState([])
    const [activeId, setActiveId] = useState(state.activeId)
    const [active, setActive] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const [, force] = useState(0)
    const poll = useRef(null)

    const refreshCandidates = () => api('api/plandev/candidates').then(setCandidates)

    useEffect(() => {
        api('api/plandev/config').then(setConfig).catch((e) => setError(e.message))
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

    // Poll the active candidate until PlanDev says it is finished.
    useEffect(() => {
        clearTimeout(poll.current)
        if (activeId == null) return
        let stop = false
        const tick = async () => {
            try {
                const c = await api(`api/plandev/candidates/${activeId}`)
                if (stop) return
                setActive(c)
                if (c.status === 'running') poll.current = setTimeout(tick, 3000)
                else {
                    refreshCandidates()
                    const L = L_.layers.data[layerUuid(activeId)]
                    if (L) window.mmgisAPI.reloadLayer(layerUuid(activeId), true, true, true)
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

    const selectable = (file?.geojson?.features || []).filter((f) => ['Point', 'Polygon'].includes(f.geometry?.type))
    const selected = selectable.filter((f) => checked[`${file.id}-${f.properties._.id}`])

    async function run() {
        setBusy(true)
        setError(null)
        try {
            const targets = { type: 'FeatureCollection', features: selected.map((f) => toTarget(file, f)) }
            const { planId } = await api('api/plandev/candidates', { targets, params, label })
            await refreshCandidates()
            setActive(null)
            setActiveId(planId)
        } catch (e) {
            setError(e.message)
        } finally {
            setBusy(false)
        }
    }

    function toggleLayer(c, i) {
        const uuid = layerUuid(c.id)
        if (L_.layers.data[uuid]) window.mmgisAPI.removeLayer(uuid)
        else showLayer(c, i).catch((e) => setError(String(e)))
        setTimeout(() => force((n) => n + 1), 300)
    }

    function zoomTo(obs) {
        const t = active?.inputs?.targets?.features?.find((f) => String(f.id) === obs.targetId)
        const a = t && anchor(t.geometry)
        if (a) Map_.map.setView([a[1], a[0]], Math.max(Map_.map.getZoom(), 7))
    }

    const reason = active?.scheduling?.reason || active?.simulation?.reason
    const base = config?.basePlan

    return (
        <div className='plandevTool'>
            <div className='mmgisToolHeader'>
                <div>
                    <div>
                        <div className='mmgisToolTitle'>PlanDev</div>
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
                {file && selectable.length === 0 && <p className='plandevTool_muted'>No points or polygons in this file. Draw some with the Draw tool.</p>}
                <ul className='plandevTool_targets'>
                    {selectable.map((f) => {
                        const k = `${file.id}-${f.properties._.id}`
                        const a = anchor(f.geometry)
                        return (
                            <li key={k}>
                                <label>
                                    <input type='checkbox' checked={!!checked[k]} onChange={(e) => setChecked({ ...checked, [k]: e.target.checked })} />
                                    <span>{featureLabel(file, f)}</span>
                                    <span className='plandevTool_muted'>
                                        {f.geometry.type} {fmt(a[1], 3)}°, {fmt(a[0], 3)}°E
                                    </span>
                                </label>
                            </li>
                        )
                    })}
                </ul>
                <p className='plandevTool_muted'>Mars, planetocentric latitude / east longitude (deg). Polygons use their vertex mean.</p>

                <h3>2 · Schedule on a copy of “{base?.name ?? '…'}”</h3>
                <div className='plandevTool_grid'>
                    <label>Max ground distance (km)</label>
                    <input type='number' min='1' max='2000' value={params.maxGroundDistanceKm} onChange={(e) => setParams({ ...params, maxGroundDistanceKm: e.target.value })} />
                    <label>Observation duration (s)</label>
                    <input type='number' min='10' max='3600' value={params.observationDurationSec} onChange={(e) => setParams({ ...params, observationDurationSec: e.target.value })} />
                    <label>Radar mode</label>
                    <select value={params.mode} onChange={(e) => setParams({ ...params, mode: e.target.value })}>
                        {(config?.modes || ['HI_RES']).map((m) => (
                            <option key={m}>{m}</option>
                        ))}
                    </select>
                    <label>Label (optional)</label>
                    <input type='text' maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
                </div>
                <p className='plandevTool_muted'>
                    Goal ScheduleTargetObservations: for each target, find the closest MRO sub-spacecraft pass in the plan window and schedule a TakeRadarObservation there. Not a footprint-coverage check.
                </p>
                <Button variant='primary' disabled={busy || selected.length === 0 || !config} onClick={run}>
                    {busy ? 'Creating…' : `Create candidate for ${selected.length} target${selected.length === 1 ? '' : 's'}`}
                </Button>

                <h3>3 · Candidates</h3>
                <ul className='plandevTool_candidates'>
                    {candidates.map((c, i) => (
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
                    {candidates.length === 0 && <li className='plandevTool_muted'>None yet.</li>}
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
                            Inputs: {active.inputs.targets.features.length} target(s), ≤{active.inputs.maxGroundDistanceKm} km, {active.inputs.observationDurationSec}s, {active.inputs.mode}
                        </div>
                        {config?.plandevUiUrl && (
                            <a href={`${config.plandevUiUrl}/plans/${active.plan.id}`} target='_blank' rel='noreferrer'>
                                Open plan in PlanDev ↗
                            </a>
                        )}
                        {reason && <pre className='plandevTool_error'>{reason.message || JSON.stringify(reason).slice(0, 500)}</pre>}

                        {active.status === 'complete' && (
                            <>
                                <h4>Observations (simulated)</h4>
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Target</th>
                                            <th>Start (UTC)</th>
                                            <th>Min dist km</th>
                                            <th>SOC end %</th>
                                            <th>Data Gbit</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {active.observations.map((o) => (
                                            <tr key={o.directiveId} onClick={() => zoomTo(o)} title={`directive ${o.directiveId}, ${o.mode}, peak load ${fmt(o.peakLoadW, 0)} W`}>
                                                <td>{o.targetName}</td>
                                                <td>{o.start.replace('T', ' ').slice(0, 19)}</td>
                                                <td>{fmt(o.minSampledDistanceKm)}</td>
                                                <td>
                                                    {fmt(o.socAtEnd)}
                                                    <span className='plandevTool_muted'> (base {fmt(o.baseSocAtEnd)})</span>
                                                </td>
                                                <td>{fmt(o.dataWrittenGbit, 2)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                {active.inputs.targets.features
                                    .filter((f) => !active.observations.some((o) => o.targetId === String(f.id)))
                                    .map((f) => (
                                        <div key={f.id} className='plandevTool_warn'>
                                            No pass within {active.inputs.maxGroundDistanceKm} km of “{f.properties?.name ?? f.id}” — not scheduled.
                                        </div>
                                    ))}
                                <h4>Plan metrics (simulated)</h4>
                                <ul className='plandevTool_metrics'>
                                    <li>Min battery SOC: {fmt(active.metrics?.minBatterySOC)}%{delta(active.metrics?.minBatterySOC, active.baseMetrics?.minBatterySOC)}</li>
                                    <li>
                                        Final onboard data: {fmt(active.metrics?.finalOnboardVolumeGbit, 2)} Gbit
                                        {delta(active.metrics?.finalOnboardVolumeGbit, active.baseMetrics?.finalOnboardVolumeGbit, 2)}
                                    </li>
                                </ul>
                                <p className='plandevTool_muted'>
                                    Min dist: closest 30 s sample of the simulated sub-spacecraft track (subSCBodies_MARS_*) during the observation. SOC: cbebattery.batterySOC. Data: scBin volume written during
                                    the observation.
                                </p>
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
