// Mission-independent PlanDev workflow for spatially driven candidate plans:
// duplicate a base plan, set a scheduling goal's arguments, schedule, simulate, and read back
// directives, spans, resource profiles, and constraint results for a mission adapter to interpret.
//
// All durable state lives in PlanDev (plan lineage, spec-goal arguments, scheduling requests,
// simulation datasets). This module keeps only in-flight promises, run errors, and a cache of
// immutable (successful) dataset reads.
'use strict'
const { sleep } = require('./plandev')
const { intervalToSec, checkParams, normalizeTargets } = require('./util')

const PROFILE_CACHE_MAX = 200 // ponytail: FIFO by (dataset, resource); a real LRU if many datasets are browsed

function createCandidates(pd, missions) {
    // missions: [{ adapter, basePlanId, goalId }]
    const inflight = new Map() // planId → promise (only to avoid double-driving in this process)
    const runErrors = new Map() // planId → message, for failures before PlanDev records a request
    const profileCache = new Map()

    const byKey = (key) => {
        const m = missions.find((x) => x.adapter.key === key)
        if (!m) throw new Error(`unknown mission ${key}`)
        return m
    }

    async function plan(planId) {
        const d = await pd.gql(
            `query($id:Int!){ plan_by_pk(id:$id){ id revision name description parent_id model_id start_time duration created_at owner
               scheduling_specification{ id } simulations{ id } } }`,
            { id: planId },
        )
        if (!d.plan_by_pk) throw new Error(`plan ${planId} not found or not visible to ${pd.username}`)
        return d.plan_by_pk
    }

    /** The configured mission whose base plan uses the same mission model as `p`. */
    async function missionForPlan(p) {
        for (const m of missions) {
            m.modelId ??= (await plan(m.basePlanId)).model_id
            if (m.modelId === p.model_id) return m
        }
        return null
    }

    async function waitFor(fn, isDone, timeoutMs = 20 * 60_000) {
        const until = Date.now() + timeoutMs
        for (;;) {
            const v = await fn()
            if (isDone(v)) return v
            if (Date.now() > until) throw new Error('timed out waiting for PlanDev')
            await sleep(2000)
        }
    }

    // ---------- candidate creation ----------

    async function createCandidate(missionKey, { targets, params, requestedBy, label }) {
        const m = byKey(missionKey)
        const fc = normalizeTargets(targets, m.adapter.targets)
        const args = m.adapter.goalArguments(fc, checkParams(m.adapter.params, params))
        const base = await plan(m.basePlanId)
        const n = (await listCandidates(missionKey)).length + 1
        const name = `${base.name} · candidate ${n}${label ? ` · ${String(label).slice(0, 60)}` : ''}`

        const dup = await pd.gql(
            `mutation($p:Int!,$n:String!){ duplicate_plan(args:{plan_id:$p, new_plan_name:$n}){ new_plan_id } }`,
            { p: m.basePlanId, n: name },
        )
        const planId = dup.duplicate_plan.new_plan_id
        await pd.gql(`mutation($id:Int!,$d:String!){ update_plan_by_pk(pk_columns:{id:$id}, _set:{description:$d}){ id } }`, {
            id: planId,
            d: `Created from MMGIS by ${requestedBy} via the PlanDev MMGIS adapter (${m.adapter.key}). Goal arguments hold the source GeoJSON.`,
        })
        // duplicate_plan (v4.5) copies activities and simulation arguments but not the plan's constraint
        // specification; copy it so candidates are checked against the same constraints as their base.
        const cs = await pd.gql(
            `query($p:Int!){ constraint_specification(where:{plan_id:{_eq:$p}}){ constraint_id constraint_revision arguments enabled order } }`,
            { p: m.basePlanId },
        )
        if (cs.constraint_specification.length)
            await pd.gql(`mutation($o:[constraint_specification_insert_input!]!){ insert_constraint_specification(objects:$o){ affected_rows } }`, {
                o: cs.constraint_specification.map((c) => ({ ...c, plan_id: planId })),
            })
        const spec = (await plan(planId)).scheduling_specification
        await pd.gql(
            `mutation($g:scheduling_specification_goals_insert_input!){ insert_scheduling_specification_goals_one(object:$g){ goal_id } }`,
            { g: { specification_id: spec.id, goal_id: m.goalId, arguments: args, enabled: true, priority: 0 } },
        )

        const run = drive(planId, spec.id)
            .catch((e) => {
                runErrors.set(planId, e.message)
                console.error(`[plandev] candidate ${planId}: ${e.message}`)
            })
            .finally(() => inflight.delete(planId))
        inflight.set(planId, run)
        return { planId }
    }

    async function drive(planId, specId) {
        // The scheduler rejects a spec whose plan_revision is stale; the PlanDev UI stamps it the same way.
        const { revision } = await plan(planId)
        await pd.gql(
            `mutation($id:Int!,$r:Int!){ update_scheduling_specification_by_pk(pk_columns:{id:$id}, _set:{plan_revision:$r, analysis_only:false}){ id } }`,
            { id: specId, r: revision },
        )
        const s = await pd.gql(`query($s:Int!){ schedule(specificationId:$s){ analysisId reason } }`, { s: specId })
        const analysisId = s.schedule.analysisId
        const req = await waitFor(
            async () =>
                (await pd.gql(`query($a:Int!){ scheduling_request(where:{analysis_id:{_eq:$a}}){ status reason } }`, { a: analysisId }))
                    .scheduling_request[0],
            (r) => r && ['success', 'failed'].includes(r.status),
        )
        if (req.status !== 'success') return
        const sim = await pd.gql(`query($p:Int!){ simulate(planId:$p, force:true){ simulationDatasetId status reason } }`, { p: planId })
        if (sim.simulate.status === 'failed') throw new Error(`simulate: ${JSON.stringify(sim.simulate.reason).slice(0, 300)}`)
        await waitFor(
            async () =>
                (await pd.gql(`query($id:Int!){ simulation_dataset_by_pk(id:$id){ status } }`, { id: sim.simulate.simulationDatasetId }))
                    .simulation_dataset_by_pk,
            (d) => d && ['success', 'failed'].includes(d.status),
        )
    }

    async function listCandidates(missionKey) {
        const m = byKey(missionKey)
        const d = await pd.gql(`query($p:Int!){ plan(where:{parent_id:{_eq:$p}}, order_by:{id:asc}){ id name created_at } }`, {
            p: m.basePlanId,
        })
        return d.plan
    }

    // ---------- reads (generic) ----------

    async function latestDataset(p) {
        if (!p.simulations[0]) return null
        const d = await pd.gql(
            `query($s:Int!){ simulation_dataset(where:{simulation_id:{_eq:$s}}, order_by:{id:desc}, limit:1){ id dataset_id status reason plan_revision } }`,
            { s: p.simulations[0].id },
        )
        return d.simulation_dataset[0] || null
    }

    /** A specific simulation dataset, refusing one that belongs to another plan. */
    async function datasetOfPlan(p, simulationDatasetId) {
        const d = await pd.gql(
            `query($id:Int!){ simulation_dataset_by_pk(id:$id){ id dataset_id status reason plan_revision simulation{ plan_id } } }`,
            { id: simulationDatasetId },
        )
        const ds = d.simulation_dataset_by_pk
        if (!ds) throw new Error(`simulation dataset ${simulationDatasetId} not found`)
        if (ds.simulation.plan_id !== p.id) throw new Error(`simulation dataset ${simulationDatasetId} is not plan ${p.id}'s`)
        return ds
    }

    /** Full-plan profile segments by name, as [{t (sec from plan start), dynamics, is_gap}]. */
    async function profiles(datasetId, names) {
        const out = {}
        const missing = names.filter((n) => !profileCache.has(`${datasetId}/${n}`))
        if (missing.length) {
            const d = await pd.gql(
                `query($ds:Int!,$names:[String!]!){ profile(where:{dataset_id:{_eq:$ds}, name:{_in:$names}}){ name
                   profile_segments(order_by:{start_offset:asc}){ start_offset dynamics is_gap } } }`,
                { ds: datasetId, names: missing },
            )
            for (const n of missing) {
                const p = d.profile.find((x) => x.name === n)
                const segs = (p?.profile_segments || []).map((s) => ({ t: intervalToSec(s.start_offset), dynamics: s.dynamics, is_gap: s.is_gap }))
                profileCache.set(`${datasetId}/${n}`, segs)
                if (profileCache.size > PROFILE_CACHE_MAX) profileCache.delete(profileCache.keys().next().value)
            }
        }
        for (const n of names) out[n] = profileCache.get(`${datasetId}/${n}`) || []
        return out
    }

    async function spans(datasetId, types) {
        const d = await pd.gql(
            `query($ds:Int!,$types:[String!]!){ span(where:{dataset_id:{_eq:$ds}, type:{_in:$types}}, order_by:{start_offset:asc}){ span_id type start_offset duration attributes } }`,
            { ds: datasetId, types },
        )
        return d.span.map((s) => ({
            spanId: s.span_id,
            type: s.type,
            startSec: intervalToSec(s.start_offset),
            endSec: intervalToSec(s.start_offset) + (s.duration ? intervalToSec(s.duration) : 0),
            directiveId: s.attributes?.directiveId ?? null,
            arguments: s.attributes?.arguments ?? {},
        }))
    }

    async function directives(planId, types) {
        const d = await pd.gql(
            `query($p:Int!,$types:[String!]!){ activity_directive(where:{plan_id:{_eq:$p}, type:{_in:$types}}, order_by:{start_offset:asc}){ id name type start_offset arguments } }`,
            { p: planId, types },
        )
        return d.activity_directive.map((x) => ({ ...x, startSec: intervalToSec(x.start_offset) }))
    }

    /** Runs (or reuses) the plan's constraint checks for a dataset; PlanDev caches results per dataset. */
    async function constraints(planId, simulationDatasetId, startMs) {
        const d = await pd.gql(
            `query($p:Int!,$s:Int!){ constraintViolations(planId:$p, simulationDatasetId:$s, force:false){ constraintsRun {
               constraintName success results { violations { windows { start end } } } errors { message } } } }`,
            { p: planId, s: simulationDatasetId },
        )
        return d.constraintViolations.constraintsRun.map((c) => ({
            name: c.constraintName,
            success: c.success,
            // windows are microsecond offsets from plan start
            windows: (c.results?.violations || []).flatMap((v) => v.windows).map((w) => ({ startMs: startMs + w.start / 1000, endMs: startMs + w.end / 1000 })),
            errors: (c.errors || []).map((e) => e.message),
        }))
    }

    const ops = { profiles, spans, directives }

    // ---------- the plan view: everything a map needs about one plan + dataset ----------

    async function view(planId, simulationDatasetId = null) {
        const p = await plan(planId)
        const m = await missionForPlan(p)
        if (!m) throw new Error(`plan ${planId}'s mission model has no MMGIS adapter configured`)
        const a = m.adapter
        const dataset = simulationDatasetId != null ? await datasetOfPlan(p, simulationDatasetId) : await latestDataset(p)
        const isCandidate = p.parent_id === m.basePlanId

        const g = await pd.gql(
            `query($s:Int!,$g:Int!){
               scheduling_specification_goals(where:{specification_id:{_eq:$s}, goal_id:{_eq:$g}}){ arguments }
               scheduling_request(where:{specification_id:{_eq:$s}}, order_by:{analysis_id:desc}, limit:1){ analysis_id status reason requested_at } }`,
            { s: p.scheduling_specification.id, g: m.goalId },
        )
        const goalArgs = g.scheduling_specification_goals[0]?.arguments || null
        const scheduling = g.scheduling_request[0] || null
        const startMs = Date.parse(p.start_time)
        const ctx = { ops, plan: p, dataset, goalArgs, startMs, durationSec: intervalToSec(p.duration), iso: (sec) => new Date(startMs + sec * 1000).toISOString() }
        const ok = dataset?.status === 'success'

        const out = {
            mission: { key: a.key, label: a.label },
            provenance: {
                planId: p.id,
                planRevision: p.revision,
                simulationDatasetId: dataset?.id ?? null,
                datasetId: dataset?.dataset_id ?? null,
                simulatedPlanRevision: dataset?.plan_revision ?? null,
                ...a.conventions,
            },
            plan: { id: p.id, name: p.name, description: p.description, startTime: p.start_time, durationSec: ctx.durationSec, parentId: p.parent_id },
            isCandidate,
            status: status(p.id, scheduling, dataset, isCandidate),
            scheduling,
            simulation: dataset,
            inputs: goalArgs ? a.inputsFromGoalArguments(goalArgs) : null,
            features: [],
            position: null,
            table: null,
            notes: [],
            summary: [],
            constraints: null,
        }
        if (ok) {
            Object.assign(out, await a.interpret(ctx))
            const metrics = await a.metrics(ctx)
            if (isCandidate) {
                const bp = await plan(m.basePlanId)
                const bds = await latestDataset(bp)
                if (bds?.status === 'success') {
                    const bStart = Date.parse(bp.start_time)
                    const baseMetrics = await a.metrics({ ...ctx, plan: bp, dataset: bds, goalArgs: null, startMs: bStart, durationSec: intervalToSec(bp.duration) })
                    for (const x of metrics) x.base = baseMetrics.find((b) => b.key === x.key)?.value ?? null
                }
            }
            out.summary = metrics
            out.constraints = await constraints(p.id, dataset.id, startMs).catch((e) => [{ name: 'constraint check', success: false, windows: [], errors: [e.message] }])
        }
        // fid: unique per feature, so a map can select exactly one; primary: the feature that stands for its activity.
        out.features = out.features.map((f, i) => ({ ...f, properties: { ...f.properties, fid: i, planId: p.id, simulationDatasetId: dataset?.id ?? null } }))
        return out
    }

    function status(planId, scheduling, dataset, isCandidate) {
        if (runErrors.has(planId)) return `failed: ${runErrors.get(planId)}`
        // While this process drives a candidate, the scheduler's own simulation datasets can appear and
        // finish first; only the dataset requested after scheduling counts, so report running until then.
        if (inflight.has(planId)) return 'running'
        if (isCandidate && scheduling?.status === 'failed') return 'scheduling failed'
        if (!dataset) return isCandidate && scheduling?.status === 'success' ? 'scheduled, not simulated' : 'not simulated'
        return { success: 'complete', failed: 'simulation failed' }[dataset.status] || 'running'
    }

    return {
        createCandidate,
        listCandidates,
        view,
        plan,
        missions,
        config: async (key) => {
            const m = byKey(key)
            const base = await plan(m.basePlanId)
            return {
                mission: { key, label: m.adapter.label, help: m.adapter.help },
                basePlan: { id: base.id, name: base.name, startTime: base.start_time, duration: base.duration },
                goalId: m.goalId,
                params: m.adapter.params,
                targets: m.adapter.targets,
                conventions: m.adapter.conventions,
            }
        },
    }
}

module.exports = { createCandidates }
