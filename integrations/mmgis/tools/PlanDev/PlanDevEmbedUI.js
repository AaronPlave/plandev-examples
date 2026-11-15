// The embedded map's controls, as PlanDev's spatial view of the open plan:
//   - a one-line plan bar (what plan, which simulation, where the vehicle is, what is selected);
//   - a selection card for the feature or activity selected on the map or in PlanDev;
//   - a terrain readout under the pointer;
//   - an inspector beside the map (it narrows the map rather than covering it) with the plan's site
//     outcomes, route, metrics, every constraint window, and the comparison with another plan;
//   - a layers popover; and, while editing the goals' inputs, an edit bar and the inputs list.
// Everything here renders state from PlanDevEmbed.js and calls its actions.
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import {
    COLOR, OTHER_COLOR, S, applyChrome, applyInspector, checkAgainstPlan, clearSelection, compareSel, dismissRun, editFeedback, editInputs, emit, focusWindow,
    gridInfo, keep, openPlanInPlanDev, positionsNow, removePin, replan, selectEditItem, selectFeature, selectSpan, setCompare, setFollow, setHidden, setTool,
    startEdit, stopEdit, syncOverlays, useS,
} from './PlanDevEmbed'

// ---------- formatting ----------

const fmtTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
const fmtShort = (ms) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
/** "02-04 01:57 – 02-05 00:00" or "02-04 01:57 – 03:12": the end's date only when it differs. */
const fmtRange = (a, b) => `${fmtShort(a)} – ${fmtShort(b).slice(0, 5) === fmtShort(a).slice(0, 5) ? fmtShort(b).slice(6) : fmtShort(b)}`
const num = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—')
const dur = (ms) => {
    const m = Math.round(ms / 60000)
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m` : `${m} min`
}
const latlon = (lat, lon) => `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`
/** "Jezero traverse (least energy) · from #59 · alternative 1" → "alternative 1"; other names unchanged. */
const shortName = (name) => (/ · from #\d+ · /.test(name) ? name.replace(/^.* · from #\d+ · /, '') : name)
const lineage = (p) => (p.parent_id ?? p.parentId) != null ? `from #${p.parent_id ?? p.parentId}` : ''
const violationsOf = (v) => (v?.constraints || []).reduce((n, c) => n + c.windows.length + c.errors.length, 0)
const close = (el) => (S.popover === el ? null : el)
const go = (tab) => {
    S.inspector = { ...S.inspector, open: true, tab }
    S.popover = null
    applyInspector()
    emit()
}

// ---------- plan bar ----------

function runLabel(view) {
    const r = S.runState
    if (!r || r.planId !== view.plan.id) return null
    if (r.phase === 'scheduling') return { cls: 'run', text: 'Scheduling…' }
    if (r.phase === 'simulating') return { cls: 'run', text: 'Simulating…' }
    if (r.phase === 'complete') return { cls: 'ok', text: `New simulation ${r.simulationDatasetId ?? ''}`, title: 'The run finished; PlanDev shows its simulation' }
    return { cls: 'bad', text: 'Run failed', title: r.message, dismiss: true }
}

function simLabel(view) {
    const ds = view.provenance.simulationDatasetId
    const latest = view.history?.[0]?.simulationDatasetId
    const ids = `Plan #${view.plan.id} rev ${view.provenance.planRevision} · simulation ${ds ?? '—'}${view.provenance.simulatedPlanRevision != null ? ` (of rev ${view.provenance.simulatedPlanRevision})` : ''}`
    if (view.status === 'running') return { cls: 'run', text: 'Running in PlanDev…', title: ids }
    if (view.status === 'not simulated') return { cls: 'muted', text: 'Planned only', title: `${ids}\nNot simulated: the map shows the planned route only.` }
    if (/failed/.test(view.status)) return { cls: 'bad', text: view.status, title: ids }
    if (view.stale) return { cls: 'warn', text: `Sim of rev ${view.provenance.simulatedPlanRevision}`, title: `${ids}\nThis simulation is of an earlier plan revision; re-simulate in PlanDev for the current plan.` }
    if (latest != null && ds !== latest) return { cls: 'warn', text: `Earlier sim ${ds}`, title: `${ids}\nPlanDev shows an earlier simulation; the latest is ${latest}.` }
    return { cls: 'ok', text: 'Simulated', title: ids }
}

function PlanBar() {
    const view = S.view
    const t = S.ctx.timeMs
    const st = runLabel(view) || simLabel(view)
    const n = violationsOf(view)
    const now = t != null && view.features.find((f) => f.properties.primary && f.properties.startMs <= t && f.properties.endMs != null && t < f.properties.endMs)
    const pos = positionsNow().filter((p) => !p.other)
    const sel = compareSel()
    const headline = view.summary.filter((m) => m.headline).slice(0, 2)
    return (
        <div className='pe_bar'>
            <div className='pe_bar1'>
                <span className='pe_swatch' style={{ background: COLOR }} />
                <b className='pe_name' title={`${view.plan.name}\n#${view.plan.id}`}>{shortName(view.plan.name)}</b>
                {view.exploring ? <span className='pe_badge' title='A working branch: an ordinary PlanDev plan that re-planning from the map changes in place'>alternative</span>
                    : view.plan.parentId != null ? <span className='pe_badge plain'>{`from #${view.plan.parentId}`}</span> : null}
                <span className={`pe_chip ${st.cls}`} title={st.title}>{st.text}{st.dismiss && <button className='pe_x' onClick={dismissRun}>×</button>}</span>
                <span className='pe_grow' />
                {view.constraints?.length > 0 && (
                    <button className={`pe_icon ${n ? 'bad' : 'ok'}`} title={n ? `${n} constraint violation${n === 1 ? '' : 's'}: show them` : 'No constraint violations'} onClick={() => go('constraints')}>
                        {n ? `⚠ ${n}` : '✓'}
                    </button>
                )}
                <button className={`pe_icon ${S.popover === 'layers' ? 'on' : ''}`} title='Layers: terrain, routes' onClick={() => ((S.popover = close('layers')), emit())}>◧</button>
                {S.config && !S.edit && <button className='pe_icon' disabled={!!runLabel(view) && runLabel(view).cls === 'run'} title={view.exploring ? 'Change sites or avoid regions, then re-plan this alternative' : 'Change sites or avoid regions, then plan an alternative'} onClick={startEdit}>✎<span className='pe_lbl'> Edit</span></button>}
                <button className={`pe_icon ${S.inspector.open ? 'on' : ''}`} title='Details: sites, route, metrics, constraints, comparison' onClick={() => { S.inspector = { ...S.inspector, open: !S.inspector.open }; applyInspector(); emit() }}>☰</button>
                <button className={`pe_icon ${S.popover === 'menu' ? 'on' : ''}`} title='More' onClick={() => ((S.popover = close('menu')), emit())}>⋯</button>
            </div>
            <div className='pe_bar2'>
                {pos.map((p, i) => (
                    <span key={i} className='pe_pos' title={p.e.note}>
                        <span className='pe_dot' style={{ background: p.color }} />
                        {p.e.label}{p.from ? ` (#${p.from.id})` : ''}{' '}
                        {p.sample ? latlon(p.sample[2], p.sample[1]) : p.outside === 'no-time' ? <i>— place PlanDev’s time cursor</i> : <i title={`Its simulation covers ${fmtTime(p.coverFrom)} – ${fmtTime(p.coverTo)} UTC`}>no position data at this time</i>}
                    </span>
                ))}
                {now && <span className='pe_now' title='In progress at the time cursor'>· {now.properties.name.replace(/ — .*/, '')}</span>}
                <span className='pe_grow' />
                {sel && S.other && (
                    <span className='pe_vs' title={S.other.view.plan.name}>
                        vs <span className='pe_swatch' style={{ background: OTHER_COLOR }} />
                        <button className='pe_link' onClick={() => go('compare')}>{S.other.ds ? `sim ${S.other.ds}` : `#${S.other.planId}`}</button>
                    </span>
                )}
                {!sel && headline.map((m) => <span key={m.key} className='pe_muted' title={m.name}>{num(m.value, m.digits)}{m.unit ? ` ${m.unit}` : ''} {m.key === 'sites' ? 'sites' : ''}</span>)}
            </div>
            {S.popover === 'layers' && <Layers />}
            {S.popover === 'menu' && <Menu />}
        </div>
    )
}

function Menu() {
    const view = S.view
    return (
        <div className='pe_pop pe_menu'>
            {view.exploring && <button onClick={keep} title='Stop treating this plan as an exploration; it stays an ordinary PlanDev plan'>Keep this alternative as a plan</button>}
            {S.other && <button onClick={() => openPlanInPlanDev(S.other.planId)}>Open compared plan #{S.other.planId} in PlanDev</button>}
            {view.derivedFrom?.id != null && <button onClick={() => openPlanInPlanDev(view.derivedFrom.id)}>Open source plan #{view.derivedFrom.id} in PlanDev</button>}
            <button onClick={() => { S.chrome = !S.chrome; S.popover = null; applyChrome(); applyInspector(); emit() }}>{S.chrome ? 'Hide' : 'Show'} full MMGIS tools</button>
            <div className='pe_muted pe_small'>
                Plan #{view.plan.id} rev {view.provenance.planRevision} · simulation {view.provenance.simulationDatasetId ?? '—'}
                {view.derivedFrom ? ` · derived from #${view.derivedFrom.id}` : ''}
            </div>
        </div>
    )
}

// ---------- layers ----------

function Legend({ o }) {
    const g = gridInfo[o.datasetId]
    if (!g) return null
    return (
        <div className='pe_legend'>
            <div style={{ background: `linear-gradient(to right, ${g.stops.map(([, c]) => c).join(', ')})` }} />
            <span>{g.stops[0][0]}</span>
            <span>{g.stops.at(-1)[0]}+ {g.unit}</span>
        </div>
    )
}

function Layers() {
    const view = S.view
    return (
        <div className='pe_pop pe_layers'>
            {(view.overlays || []).map((o) => (
                <div key={o.id} className='pe_layer'>
                    <label>
                        <input type='checkbox' checked={!!S.overlaysOn[o.id]} onChange={(e) => { S.overlaysOn[o.id] = e.target.checked; syncOverlays() }} /> {o.name}
                        <input type='range' min='0.1' max='1' step='0.05' title='Opacity' value={S.opacity[o.id] ?? 0.6} disabled={!S.overlaysOn[o.id]}
                            onChange={(e) => { S.opacity[o.id] = Number(e.target.value); syncOverlays() }} />
                    </label>
                    {S.overlaysOn[o.id] && <Legend o={o} />}
                    <details className='pe_small'>
                        <summary className='pe_muted'>{o.usedByPlan ? 'The data this route was planned on' : 'Not the data this plan used'}{o.resolution ? ` · ${o.resolution}` : ''}</summary>
                        <div className='pe_muted'>{o.source}</div>
                        <div className='pe_muted pe_mono'>{o.datasetId}</div>
                    </details>
                </div>
            ))}
            <div className='pe_layer'>
                <label><input type='checkbox' checked={!S.hide.current} onChange={(e) => setHidden('current', !e.target.checked)} /> <span className='pe_swatch' style={{ background: COLOR }} /> Current plan route</label>
                {S.other && <label><input type='checkbox' checked={!S.hide.other} onChange={(e) => setHidden('other', !e.target.checked)} /> <span className='pe_swatch' style={{ background: OTHER_COLOR }} /> Compared route</label>}
                <label title='Pan to keep the vehicle in view as the time cursor moves'><input type='checkbox' checked={S.follow} onChange={(e) => setFollow(e.target.checked)} /> Follow the vehicle</label>
            </div>
            <div className='pe_muted pe_small'>Wide faint line: planned route · solid: simulated track · red: constraint windows</div>
        </div>
    )
}

// ---------- terrain readout ----------

function Readout() {
    const h = S.hover
    const pinsTerrain = S.pins.length > 0
    if (!h && !pinsTerrain) return null
    return (
        <div className='pe_readout' title='Shift-click the map to pin a terrain sample; click a pin to remove it'>
            {h && h.overlay && (
                <div>
                    <span className='pe_muted'>{h.overlay.name}</span>{' '}
                    <b>{h.value != null ? `${h.value.toFixed(1)}°` : 'no data here'}</b>
                </div>
            )}
            {h && <div className='pe_muted pe_small'>{latlon(h.lat, h.lon)}{h.overlay?.resolution ? ` · ${h.overlay.resolution}` : ''}</div>}
            {pinsTerrain && (
                <div className='pe_small'>
                    <span className='pe_muted'>{S.pins.length} pinned · </span>
                    <button className='pe_link' onClick={() => removePin(null)}>clear</button>
                </div>
            )}
        </div>
    )
}

// ---------- selection ----------

/** Windows of a view's constraints, each with what the map can honestly say about where it happened. */
function windowsOf(view, which) {
    const out = []
    const viol = view.features.filter((f) => f.properties.kind === 'violation')
    const entity = (view.positions ?? [view.position])[0]
    for (const c of view.constraints || []) {
        for (const w of c.windows) {
            const feature = viol.find((f) => f.properties.constraint === c.name && f.properties.startMs === w.startMs)
            const during = view.features.filter((f) => f.properties.primary && f.properties.startMs < w.endMs && (f.properties.endMs ?? f.properties.startMs) > w.startMs)
            const where = !feature ? (entity ? `no ${entity.label.toLowerCase()} position recorded for this window` : 'no position for this mission')
                : feature.geometry.type === 'Point' ? `${entity?.label ?? 'vehicle'} held one position throughout`
                : `${entity?.label ?? 'vehicle'} track during the window (${feature.geometry.coordinates.length} recorded positions)`
            out.push({ key: `${which}/${c.name}/${w.startMs}`, which, name: c.name, startMs: w.startMs, endMs: w.endMs, feature, during, where })
        }
    }
    return out
}

function Selected() {
    const view = S.view
    const f = view.features.find((x) => x.properties.fid === S.selected)
    if (!f) return null
    const p = f.properties
    const hits = windowsOf(view, 'current').filter((w) => Number.isFinite(p.startMs) && p.endMs != null && w.startMs < p.endMs && w.endMs > p.startMs)
    return (
        <div className='pe_sel'>
            <div className='pe_title'>
                <span className='pe_ellip'>{p.name.replace(/ — .*/, '')}</span>
                <button className='pe_x' title='Clear selection' onClick={clearSelection}>×</button>
            </div>
            <div className='pe_muted pe_small'>
                {p.basis}
                {Number.isFinite(p.startMs) && ` · ${p.endMs != null && p.endMs !== p.startMs ? fmtRange(p.startMs, p.endMs) : fmtShort(p.startMs)} UTC`}
            </div>
            {(p.details || []).map(([k, v]) => (
                <div key={k} className='pe_kv'>
                    <span>{k}</span>
                    <span>{v}</span>
                </div>
            ))}
            {(p.observations || []).map((o) => (
                <button key={o.spanId ?? o.directiveId} className='pe_link pe_small' onClick={() => selectSpan(o.spanId, o.directiveId, o.startMs)}>
                    Observation at {fmtShort(o.startMs)} →
                </button>
            ))}
            {hits.map((w) => (
                <button key={w.key} className='pe_link pe_bad pe_small' onClick={() => focusWindow(w)}>
                    ⚠ {w.name}: {fmtRange(w.startMs, w.endMs)}
                </button>
            ))}
        </div>
    )
}

// ---------- inspector ----------

const STATE_ORDER = ['missed', 'reached', 'unscheduled', 'unknown', 'planned', 'observed']

function Sites() {
    const view = S.view
    const sites = view.features.filter((f) => f.properties.outcome)
    const counts = {}
    for (const f of sites) counts[f.properties.outcome.state] = (counts[f.properties.outcome.state] || 0) + 1
    const sorted = [...sites].sort((a, b) => STATE_ORDER.indexOf(a.properties.outcome.state) - STATE_ORDER.indexOf(b.properties.outcome.state) || (b.properties.priority ?? 0) - (a.properties.priority ?? 0))
    if (!sites.length) return <div className='pe_muted'>This mission’s adapter reports no site outcomes.</div>
    return (
        <>
            <div className='pe_counts'>
                {STATE_ORDER.filter((s) => counts[s]).map((s) => (
                    <span key={s} className={`pe_state ${s}`}>{counts[s]} {s}</span>
                ))}
            </div>
            <table className='pe_table'>
                <tbody>
                    {sorted.map((f) => {
                        const p = f.properties
                        return (
                            <tr key={p.fid} className={p.fid === S.selected ? 'on' : ''} onClick={() => selectFeature(f, { pan: true })}>
                                <td>
                                    <div>{p.siteName ?? p.name}{p.priority != null && <span className='pe_muted'> · P{p.priority}</span>}</div>
                                    {p.outcome.reason && <div className='pe_muted pe_small'>{p.outcome.reason}</div>}
                                </td>
                                <td className='pe_right'><span className={`pe_state ${p.outcome.state}`}>{p.outcome.label}</span></td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
            <div className='pe_muted pe_small'>From the plan’s activities and its simulated track: “reached” means a simulated arrival within 100 m; “observed” means an observation made on the site.</div>
        </>
    )
}

function Route() {
    const view = S.view
    const tb = view.table
    const warn = view.notes.filter((n) => n.warn)
    return (
        <>
            {warn.map((n) => <div key={n.text} className='pe_warn pe_small'>{n.text}</div>)}
            {!tb?.rows?.length ? <div className='pe_muted'>No simulated activities to list.</div> : (
                <div className='pe_scroll'>
                    <table className='pe_table pe_grid'>
                        <thead>
                            <tr>{tb.columns.map((c) => <th key={c.key} className={c.digits != null ? 'pe_right' : ''}>{c.label}{c.unit && <div className='pe_muted'>{c.unit}</div>}</th>)}</tr>
                        </thead>
                        <tbody>
                            {tb.rows.map((r, i) => {
                                const on = S.view.features.find((f) => f.properties.fid === S.selected)?.properties.spanId === r.spanId && r.spanId != null
                                return (
                                    <tr key={i} className={on ? 'on' : ''} onClick={() => selectSpan(r.spanId, r.directiveId, Date.parse(r.start))}>
                                        {tb.columns.map((c) => <td key={c.key} className={c.digits != null ? 'pe_right' : ''}>{c.type === 'time' ? fmtShort(Date.parse(r[c.key])) : c.digits != null ? num(r[c.key], c.digits) : r[c.key]}</td>)}
                                    </tr>
                                )
                            })}
                        </tbody>
                        {tb.columns.some((c) => c.sum) && (
                            <tfoot>
                                <tr>{tb.columns.map((c, i) => <td key={c.key} className={c.digits != null ? 'pe_right' : ''}>{i === 0 ? 'Total' : c.sum ? num(tb.rows.reduce((n, r) => n + (r[c.key] || 0), 0), c.digits) : ''}</td>)}</tr>
                            </tfoot>
                        )}
                    </table>
                </div>
            )}
            <div className='pe_muted pe_small'>Click a row to select the activity in PlanDev and on the map. Time series are in PlanDev’s resource rows.</div>
        </>
    )
}

function Metrics() {
    const view = S.view
    if (!view.summary.length) return <div className='pe_muted'>Metrics need a successful simulation.</div>
    return (
        <>
            <table className='pe_table'>
                <tbody>
                    {view.summary.map((m) => (
                        <tr key={m.key} className='pe_static'>
                            <td>{m.name}</td>
                            <td className='pe_right'>{num(m.value, m.digits)} {m.unit}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <div className='pe_muted pe_small'>From simulation {view.provenance.simulationDatasetId}’s activities and resources. Compare plans in the Compare tab.</div>
        </>
    )
}

function Constraints() {
    const view = S.view
    const cur = windowsOf(view, 'current')
    const oth = S.other ? windowsOf(S.other.view, 'compared') : []
    const errors = (view.constraints || []).filter((c) => c.errors.length)
    const names = [...new Set([...(view.constraints || []), ...(S.other?.view.constraints || [])].map((c) => c.name))]
    if (!view.constraints) return <div className='pe_muted'>Constraints are checked on a successful simulation.</div>
    return (
        <>
            {errors.map((c) => <div key={c.name} className='pe_bad pe_small'>{c.name}: {c.errors.join('; ')}</div>)}
            {names.map((name) => {
                const ws = [...cur, ...oth].filter((w) => w.name === name).sort((a, b) => a.startMs - b.startMs)
                const nc = cur.filter((w) => w.name === name).length
                return (
                    <div key={name} className='pe_group'>
                        <div className='pe_title'>
                            <span className='pe_ellip'>{name}</span>
                            <span className={nc ? 'pe_bad' : 'pe_good'}>{nc || '✓'}</span>
                            {S.other && <span className='pe_muted'>&nbsp;vs {oth.filter((w) => w.name === name).length}</span>}
                        </div>
                        {ws.map((w) => (
                            <button key={w.key} className={`pe_window ${S.focus?.key === w.key ? 'on' : ''}`} onClick={() => focusWindow(w)}>
                                <span className='pe_swatch' style={{ background: w.which === 'current' ? COLOR : OTHER_COLOR }} title={w.which === 'current' ? 'Current plan' : 'Compared plan'} />
                                <span>
                                    <span>{fmtRange(w.startMs, w.endMs)} UTC <span className='pe_muted'>({dur(w.endMs - w.startMs)})</span></span>
                                    <span className='pe_muted pe_small'>
                                        {w.during.length ? `during ${w.during.map((f) => f.properties.name.replace(/ — .*/, '')).slice(0, 2).join(', ')}${w.during.length > 2 ? '…' : ''} · ` : ''}
                                        {w.where}
                                    </span>
                                </span>
                            </button>
                        ))}
                    </div>
                )
            })}
            <div className='pe_muted pe_small'>Selecting a window moves PlanDev’s time cursor to it and frames it on the timeline, where the violation and its resources show in full.</div>
        </>
    )
}

/** Plans worth comparing with: earlier simulations of this plan, its source, siblings, children, recent picks, then a search over the rest. */
function CompareChooser({ onClose }) {
    const view = S.view
    const [q, setQ] = useState('')
    const ds = view.provenance.simulationDatasetId
    const plans = S.plans.filter((p) => p.id !== view.plan.id)
    const byId = Object.fromEntries(S.plans.map((p) => [p.id, p]))
    const groups = [
        ['Earlier simulations of this plan', (view.history || []).filter((h) => h.status === 'success' && h.simulationDatasetId !== ds).slice(0, 5).map((h) => ({ sel: { planId: view.plan.id, ds: h.simulationDatasetId }, name: `Simulation ${h.simulationDatasetId}`, ctx: `rev ${h.planRevision}${h.requestedAt ? ` · ${fmtShort(Date.parse(h.requestedAt))}` : ''}` }))],
        ['Source', view.plan.parentId != null && byId[view.plan.parentId] ? [byId[view.plan.parentId]] : []],
        ['Alternatives from the same source', view.plan.parentId != null ? plans.filter((p) => p.parent_id === view.plan.parentId) : []],
        ['Derived from this plan', plans.filter((p) => p.parent_id === view.plan.id)],
        ['Recent', S.recent.map((id) => byId[id]).filter(Boolean)],
    ]
    const shown = new Set()
    const items = groups.map(([title, xs]) => [title, xs.map((p) => p.sel ? p : { sel: { planId: p.id }, name: shortName(p.name), ctx: [`#${p.id}`, lineage(p), p.exploring && 'alternative'].filter(Boolean).join(' · '), title: p.name }).filter((x) => {
        const k = `${x.sel.planId}@${x.sel.ds ?? ''}`
        return !shown.has(k) && shown.add(k)
    })]).filter(([, xs]) => xs.length)
    const ql = q.trim().toLowerCase()
    const found = ql ? plans.filter((p) => `#${p.id} ${p.name}`.toLowerCase().includes(ql)).slice(0, 12) : []
    const pick = (sel) => { setCompare(sel); onClose() }
    const Item = ({ x }) => (
        <button className='pe_item' title={x.title} onClick={() => pick(x.sel)}>
            <span className='pe_ellip'>{x.name}</span>
            <span className='pe_muted pe_small'>{x.ctx}</span>
        </button>
    )
    return (
        <div className='pe_chooser'>
            <input autoFocus placeholder={`Search ${S.plans.length - 1} other plans…`} value={q} onChange={(e) => setQ(e.target.value)} />
            {ql ? (found.length ? found.map((p) => <Item key={p.id} x={{ sel: { planId: p.id }, name: shortName(p.name), ctx: [`#${p.id}`, lineage(p)].filter(Boolean).join(' · '), title: p.name }} />) : <div className='pe_muted'>No plan matches.</div>)
                : items.map(([title, xs]) => (
                    <div key={title}>
                        <div className='pe_group_title'>{title}</div>
                        {xs.map((x) => <Item key={`${x.sel.planId}@${x.sel.ds ?? ''}`} x={x} />)}
                    </div>
                ))}
            {compareSel() && <button className='pe_item' onClick={() => pick(null)}><i>No comparison</i></button>}
        </div>
    )
}

function Compare() {
    const view = S.view
    const [choosing, setChoosing] = useState(false)
    const o = S.other?.view
    const sel = compareSel()
    const label = (v, ds) => (ds ? `Simulation ${ds} of this plan` : `#${v.plan.id} ${shortName(v.plan.name)}`)
    return (
        <>
            <div className='pe_cmp_ids'>
                <div><span className='pe_swatch' style={{ background: COLOR }} /> <b>Current</b> <span className='pe_ellip' title={view.plan.name}>#{view.plan.id} {shortName(view.plan.name)}</span><span className='pe_muted pe_small'>sim {view.provenance.simulationDatasetId ?? '—'}</span></div>
                <div>
                    <span className='pe_swatch' style={{ background: OTHER_COLOR }} /> <b>Compared</b>{' '}
                    <button className='pe_pick' onClick={() => setChoosing(!choosing)} title={o?.plan.name}>{o ? label(o, S.other.ds) : sel ? 'loading…' : 'choose a plan…'} ▾</button>
                    {o && <span className='pe_muted pe_small'>sim {o.provenance.simulationDatasetId ?? '—'}{o.plan.id === view.plan.parentId ? ' · source' : ''}</span>}
                </div>
            </div>
            {choosing && <CompareChooser onClose={() => setChoosing(false)} />}
            {o && !choosing && (
                <>
                    <div className='pe_row pe_small'>
                        <label><input type='checkbox' checked={!S.hide.current} onChange={(e) => setHidden('current', !e.target.checked)} /> current route</label>
                        <label><input type='checkbox' checked={!S.hide.other} onChange={(e) => setHidden('other', !e.target.checked)} /> compared route</label>
                    </div>
                    {o.status !== 'complete' && o.status !== 'stale' ? <div className='pe_warn'>The compared plan has no successful simulation ({o.status}).</div> : (
                        <table className='pe_table pe_cmp'>
                            <thead>
                                <tr>
                                    <th>Metric <span className='pe_muted'>· Δ = current − compared</span></th>
                                    <th className='pe_right' style={{ color: COLOR }}>Current</th>
                                    <th className='pe_right' style={{ color: OTHER_COLOR }}>Compared</th>
                                    <th className='pe_right' title='Current minus compared'>Δ</th>
                                </tr>
                            </thead>
                            <tbody>
                                {view.summary.map((m) => {
                                    const b = o.summary.find((x) => x.key === m.key)?.value
                                    const d = typeof m.value === 'number' && typeof b === 'number' ? m.value - b : null
                                    const same = d != null && Math.abs(d) < 10 ** -(m.digits ?? 1) / 2
                                    const unit = m.unit?.startsWith('%') ? 'pp' : m.unit
                                    return (
                                        <tr key={m.key} className={`pe_static ${d != null && !same ? 'pe_changed' : ''}`} title={m.better ? `Usually preferred: ${m.better === 'low' ? 'lower' : 'higher'}` : ''}>
                                            <td>{m.name}{m.unit ? <span className='pe_muted'> ({m.unit})</span> : ''}</td>
                                            <td className='pe_right'>{num(m.value, m.digits)}</td>
                                            <td className='pe_right'>{num(b, m.digits)}</td>
                                            <td className='pe_right'>{d == null ? '—' : same ? '=' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(m.digits ?? 1)}${unit && unit !== '' ? ` ${unit}` : ''}`}</td>
                                        </tr>
                                    )
                                })}
                                <tr className='pe_static pe_changed'>
                                    <td>Constraint violations</td>
                                    <td className='pe_right'>{violationsOf(view)}</td>
                                    <td className='pe_right'>{violationsOf(o)}</td>
                                    <td className='pe_right'>{violationsOf(view) === violationsOf(o) ? '=' : `${violationsOf(view) > violationsOf(o) ? '+' : '−'}${Math.abs(violationsOf(view) - violationsOf(o))}`}</td>
                                </tr>
                            </tbody>
                        </table>
                    )}
                    <div className='pe_muted pe_small'>Δ is current minus compared (pp: percentage points). It does not judge which is better: weigh the trade-offs. Each plan’s violation windows are listed under Constraints.</div>
                </>
            )}
            {!sel && !choosing && <div className='pe_muted'>Choose a plan or an earlier simulation to compare routes, metrics and constraint violations.</div>}
        </>
    )
}

function Inputs() {
    const ed = S.edit
    const view = S.view
    const t = S.config.targets
    const fb = editFeedback()
    const notes = (xs) => xs.map((n, i) => <span key={i} className={n.warn ? 'pe_warn' : 'pe_muted'}>{i ? ' · ' : ''}{n.text}</span>)
    return (
        <>
            {!ed.fromInputs && <div className='pe_warn pe_small'>The goal inputs that produced this plan are not known; starting from the sites the plan shows.</div>}
            <div className='pe_group_title'>{t.roles?.Point ?? 'Points'} ({ed.sites.length})</div>
            {ed.sites.map((s) => (
                <div key={s.id} className={`pe_input ${ed.selected === s.id ? 'on' : ''}`} onClick={() => selectEditItem(s.id)}>
                    <div className='pe_row'>
                        <input value={s.name} maxLength={60} onClick={(e) => e.stopPropagation()} onChange={(e) => editInputs((x) => { x.sites.find((y) => y.id === s.id).name = e.target.value })} />
                        {t.priority && (
                            <select title='Priority' value={s.priority} onClick={(e) => e.stopPropagation()} onChange={(e) => editInputs((x) => { x.sites.find((y) => y.id === s.id).priority = Number(e.target.value) }, true)}>
                                {Array.from({ length: t.priority.max - t.priority.min + 1 }, (_, i) => t.priority.min + i).map((n) => <option key={n} value={n}>P{n}</option>)}
                            </select>
                        )}
                        <button className='pe_x' title='Remove' onClick={(e) => { e.stopPropagation(); editInputs((x) => { x.sites = x.sites.filter((y) => y.id !== s.id) }, true) }}>×</button>
                    </div>
                    <div className='pe_small'>{notes(fb.sites.find((x) => x.id === s.id).notes)}</div>
                </div>
            ))}
            <div className='pe_group_title'>{t.roles?.Polygon ?? 'Regions'} ({ed.regions.length})</div>
            {!ed.regions.length && <div className='pe_muted pe_small'>None. Use “+ {t.roles?.Polygon ?? 'Region'}” to draw one.</div>}
            {ed.regions.map((r) => (
                <div key={r.id} className={`pe_input ${ed.selected === r.id ? 'on' : ''}`} onClick={() => selectEditItem(r.id)}>
                    <div className='pe_row'>
                        <input value={r.name} maxLength={60} onClick={(e) => e.stopPropagation()} onChange={(e) => editInputs((x) => { x.regions.find((y) => y.id === r.id).name = e.target.value })} />
                        <span className='pe_muted pe_small'>{r.ring.length} corners</span>
                        <button className='pe_x' title='Remove' onClick={(e) => { e.stopPropagation(); editInputs((x) => { x.regions = x.regions.filter((y) => y.id !== r.id) }, true) }}>×</button>
                    </div>
                    <div className='pe_small'>{notes(fb.regions.find((x) => x.id === r.id).notes)}</div>
                </div>
            ))}
            <details className='pe_params_box'>
                <summary className='pe_group_title'>Goal parameters</summary>
                <div className='pe_params'>
                    {S.config.params.map((p) => [
                        <label key={`${p.key}l`}>{p.label}{p.unit ? ` (${p.unit})` : ''}</label>,
                        p.type === 'enum' ? (
                            <select key={p.key} value={ed.params[p.key]} onChange={(e) => editInputs((x) => { x.params[p.key] = e.target.value })}>
                                {p.options.map((o) => <option key={o}>{o}</option>)}
                            </select>
                        ) : (
                            <input key={p.key} type='number' min={p.min} max={p.max} value={ed.params[p.key]} onChange={(e) => editInputs((x) => { x.params[p.key] = e.target.value })} />
                        ),
                    ])}
                </div>
            </details>
            {ed.error && <div className='pe_bad'>{ed.error}</div>}
            {ed.answer && (
                <div className='pe_answer'>
                    <div className='pe_muted pe_small'>Against #{view.plan.id} as simulated (sim {ed.answer.provenance.simulationDatasetId}); nothing was changed:</div>
                    {ed.answer.table.rows.map((r) => (
                        <div key={r.name} className='pe_kv'>
                            <span>{r.name}</span>
                            <span>{r.result}</span>
                        </div>
                    ))}
                </div>
            )}
            <div className='pe_muted pe_small'>Terrain and route notes are a quick local check; the scheduling goal decides the actual route when you re-plan.</div>
        </>
    )
}

const TABS = [
    ['sites', 'Sites'],
    ['route', 'Route'],
    ['metrics', 'Metrics'],
    ['constraints', 'Constraints'],
    ['compare', 'Compare'],
]

function Inspector() {
    const view = S.view
    const drag = useRef(null)
    const w = applyInspectorWidth()
    if (!S.inspector.open) return null
    const tabs = TABS.filter(([k]) => k !== 'sites' || view.features.some((f) => f.properties.outcome))
    const tab = S.edit ? 'inputs' : tabs.some(([k]) => k === S.inspector.tab) ? S.inspector.tab : tabs[0][0]
    const n = violationsOf(view)
    const onDown = (e) => {
        e.preventDefault()
        const x0 = e.clientX
        const w0 = w
        drag.current = (ev) => {
            S.inspector = { ...S.inspector, width: w0 + (x0 - ev.clientX) }
            applyInspector()
            emit()
        }
        const up = () => {
            window.removeEventListener('mousemove', drag.current)
            window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', drag.current)
        window.addEventListener('mouseup', up)
    }
    return (
        <div className='pe_insp' style={{ width: w }}>
            <div className='pe_resize' onMouseDown={onDown} title='Drag to resize' />
            {S.edit ? (
                <div className='pe_tabs'><span className='on'>Inputs · {view.exploring ? `re-plan #${view.plan.id}` : `new alternative from #${view.plan.id}`}</span></div>
            ) : (
                <div className='pe_tabs'>
                    {tabs.map(([k, l]) => (
                        <button key={k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>
                            {l}{k === 'constraints' && n ? <span className='pe_bad'> {n}</span> : ''}
                        </button>
                    ))}
                    <button className='pe_x' title='Close' onClick={() => { S.inspector = { ...S.inspector, open: false }; applyInspector(); emit() }}>×</button>
                </div>
            )}
            <div className='pe_body'>
                {tab === 'sites' && <Sites />}
                {tab === 'route' && <Route />}
                {tab === 'metrics' && <Metrics />}
                {tab === 'constraints' && <Constraints />}
                {tab === 'compare' && <Compare />}
                {tab === 'inputs' && <Inputs />}
            </div>
        </div>
    )
}
const applyInspectorWidth = () => Math.round(Math.min(Math.max(280, S.inspector.width), window.innerWidth * 0.62))

// ---------- editing bar ----------

function EditBar() {
    const ed = S.edit
    const view = S.view
    const t = S.config.targets
    const fb = editFeedback()
    const empty = !(ed.sites.length + ed.regions.length)
    const hint = ed.tool === 'site' ? 'Click the map to place the site · Esc to stop'
        : ed.tool === 'region' ? (ed.drawing < 3 ? `Click to add corners (${ed.drawing}) · Backspace undoes · Esc cancels` : `Click the first or last corner, double-click, or Enter to finish (${ed.drawing} corners) · Backspace · Esc`)
        : 'Drag sites, region corners or regions · drag a mid-edge handle to add a corner · click a corner to delete it · Del removes the selected item'
    return (
        <div className='pe_bar pe_editbar'>
            <div className='pe_bar1'>
                <b className='pe_name'>{view.exploring ? `Changing alternative #${view.plan.id}` : `New alternative from #${view.plan.id}`}</b>
                <span className='pe_grow' />
                <div className='pe_seg'>
                    <button className={ed.tool === 'select' ? 'on' : ''} onClick={() => setTool('select')}>Select</button>
                    {t.types.includes('Point') && <button className={ed.tool === 'site' ? 'on' : ''} onClick={() => setTool('site')}>+ {t.roles?.Point ?? 'Point'}</button>}
                    {t.types.includes('Polygon') && <button className={ed.tool === 'region' ? 'on' : ''} onClick={() => setTool('region')}>+ {t.roles?.Polygon ?? 'Region'}</button>}
                </div>
            </div>
            <div className='pe_bar1'>
                {S.config.evaluation && (
                    <button disabled={ed.busy || empty || view.simulation?.status !== 'success'} onClick={checkAgainstPlan} title='Read-only: how the current simulated route meets these sites and regions'>Check current plan</button>
                )}
                <span className='pe_grow' />
                <button disabled={ed.busy} onClick={stopEdit}>Cancel</button>
                <button className='primary' disabled={ed.busy || empty || fb.invalid || ed.tool === 'region'} title={fb.invalid ? 'A region is invalid' : view.exploring ? `Re-run the scheduling goals on #${view.plan.id} with these inputs, then simulate` : `Copy #${view.plan.id} into a new alternative and schedule it with these inputs; #${view.plan.id} is not changed`} onClick={replan}>
                    {ed.busy ? 'Working…' : view.exploring ? 'Re-plan' : 'Plan alternative'}
                </button>
            </div>
            <div className='pe_hint'>{hint}</div>
        </div>
    )
}

// ---------- root ----------

function Root() {
    useS()
    const view = S.view
    if (S.chrome) return <button className='pe_back' onClick={() => { S.chrome = false; applyChrome(); applyInspector(); emit() }}>Back to the PlanDev map view</button>
    if (!view) return <div className='pe_map'><div className='pe_top'><div className='pe_bar'><div className='pe_muted'>{S.message}</div></div></div></div>
    return (
        <>
            <div className='pe_map'>
                <div className='pe_top'>
                    {S.edit ? <EditBar /> : <PlanBar />}
                    <Readout />
                </div>
                {!S.edit && <Selected />}
            </div>
            <Inspector />
        </>
    )
}

/** A render error shows itself (and can be retried) instead of blanking the map's controls. */
class Boundary extends React.Component {
    state = { error: null }
    static getDerivedStateFromError(error) {
        return { error }
    }
    render() {
        if (!this.state.error) return this.props.children
        return (
            <div className='pe_map'><div className='pe_top'><div className='pe_bar'>
                <span className='pe_bad'>Map controls failed: {this.state.error.message} </span>
                <button className='pe_link' onClick={() => this.setState({ error: null })}>retry</button>
            </div></div></div>
        )
    }
}

export function mountEmbedUI() {
    const host = document.createElement('div')
    host.className = 'pe_root'
    document.body.appendChild(host)
    createRoot(host).render(<Boundary><Root /></Boundary>)
}
