// Mission-independent PlanDev workflow for spatial planning on existing plans:
//   - read any plan of a configured mission model, at a consistent plan revision / simulation dataset;
//   - derive a candidate from it (duplicate, replace the mission goal's earlier output, schedule, simulate);
//   - evaluate it read-only against spatial inputs.
// Mission meaning (goal arguments, geometry, metrics, evaluation) comes from the adapter.
//
// All durable state lives in PlanDev (plans and parent_id lineage, the snapshot duplicate_plan takes,
// spec-goal arguments, directives' source goal invocation, scheduling requests, simulation datasets).
// This module keeps only in-flight promises, run errors, and a cache of immutable dataset reads.
'use strict'
const { sleep } = require('./plandev')
const { intervalToSec, checkParams, normalizeTargets } = require('./util')

const PROFILE_CACHE_MAX = 200 // ponytail: FIFO by (dataset, resource); a real LRU if many datasets are browsed

// How each kind of geometry is drawn, so modeled states read differently from assumed paths,
// user inputs and analysis constructions. Adapters say which one a feature is (properties.basis).
const STYLE_BY_BASIS = {
    simulated: null, // the layer's own solid style
    illustrative: { dashArray: '8 6' },
    input: { color: '#ffffff', fillColor: '#ffffff', weight: 2, dashArray: '2 5', fillOpacity: 0.1 },
    analysis: { color: '#ffea00', fillColor: '#ffea00', weight: 2, dashArray: '4 4', fillOpacity: 0.15 },
}

function createCandidates(pd, missions) {
    // missions: [{ adapter, goalId, basePlanId }]; the base plan identifies the mission model and is the
    // default plan to show; any plan of that model can be inspected, evaluated or revised.
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
               scheduling_specification{ id revision } simulations{ id } } }`,
            { id: planId },
        )
        if (!d.plan_by_pk) throw new Error(`plan ${planId} not found or not visible to ${pd.username}`)
        return d.plan_by_pk
    }

    async function modelOf(m) {
        m.modelId ??= (await plan(m.basePlanId)).model_id
        return m.modelId
    }

    /**
     * The configured mission for `p`'s mission model; rejects plans of any other model, and plans of
     * another mission than the caller's (`expectKey`, e.g. a Moon map asked to revise a Mars plan).
     */
    async function missionForPlan(p, expectKey = null) {
        for (const m of missions) {
            if ((await modelOf(m)) !== p.model_id) continue
            if (expectKey && m.adapter.key !== expectKey) throw new Error(`plan ${p.id} is a ${m.adapter.key} plan, not ${expectKey}`)
            return m
        }
        throw new Error(`plan ${p.id} uses mission model ${p.model_id}, which has no MMGIS adapter configured`)
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

    const specGoals = async (specId) =>
        (
            await pd.gql(
                `query($s:Int!){ scheduling_specification_goals(where:{specification_id:{_eq:$s}}, order_by:{priority:asc}){
                   goal_id goal_revision goal_invocation_id arguments enabled priority simulate_after } }`,
                { s: specId },
            )
        ).scheduling_specification_goals

    // ---------- candidates: derived from any plan ----------

    /**
     * Duplicate `sourcePlanId` and re-run the mission goal on the copy with new inputs. The source is
     * not modified. Directives the source's own invocation of that goal created (PlanDev's
     * source_scheduling_goal_invocation_id) are removed from the copy first; every other directive stays.
     */
    async function createCandidate(sourcePlanId, { mission, targets, params, requestedBy, label, expectedRevision }) {
        const src = await plan(sourcePlanId)
        const m = await missionForPlan(src, mission)
        if (expectedRevision != null && src.revision !== expectedRevision)
            throw new Error(`plan ${src.id} is now at revision ${src.revision}, not ${expectedRevision} as shown; reload before revising it`)
        const fc = normalizeTargets(targets, m.adapter.targets)
        const args = m.adapter.goalArguments(fc, checkParams(m.adapter.params, params))
        const goals = await specGoals(src.scheduling_specification.id)
        const prior = goals.filter((g) => g.goal_id === m.goalId)

        const n = (await pd.gql(`query($p:Int!){ plan_aggregate(where:{parent_id:{_eq:$p}}){ aggregate{ count } } }`, { p: src.id })).plan_aggregate.aggregate.count + 1
        const name = `${src.name.split(' · ')[0]} · from #${src.id} · ${label ? String(label).slice(0, 60) : `revision ${n}`}`
        // ponytail: revision checked just before duplicating, not atomically with it; a PlanDev-side check if edits race this
        const dup = await pd.gql(`mutation($p:Int!,$n:String!){ duplicate_plan(args:{plan_id:$p, new_plan_name:$n}){ new_plan_id } }`, { p: src.id, n: name })
        const planId = dup.duplicate_plan.new_plan_id

        // duplicate_plan copies directives with their source goal invocation ids, but those point at the
        // *source* plan's spec goals; the copy's own invocation can't adopt them (the column isn't
        // writable), so the goal's ActivityAutoDelete would not see them. Remove them here instead.
        let replaced = 0
        if (prior.length) {
            const old = await pd.gql(`query($p:Int!,$i:[Int!]!){ activity_directive(where:{plan_id:{_eq:$p}, source_scheduling_goal_invocation_id:{_in:$i}}){ id } }`, {
                p: planId,
                i: prior.map((g) => g.goal_invocation_id),
            })
            const ids = old.activity_directive.map((a) => a.id)
            if (ids.length) {
                // Anything anchored to a removed directive is re-anchored to plan start at the same time.
                await pd.gql(`mutation($ids:_int4!,$p:Int!){ delete_activity_by_pk_reanchor_plan_start_bulk(args:{_activity_ids:$ids, _plan_id:$p}){ change_type } }`, {
                    ids: `{${ids.join(',')}}`,
                    p: planId,
                })
                replaced = ids.length
            }
        }

        await pd.gql(`mutation($id:Int!,$d:String!){ update_plan_by_pk(pk_columns:{id:$id}, _set:{description:$d}){ id } }`, {
            id: planId,
            d:
                `Derived from plan ${src.id} (revision ${src.revision}) by ${requestedBy} via the PlanDev MMGIS adapter (${m.adapter.key}). ` +
                `${replaced} directive(s) created by the source's ${m.adapter.key} goal were replaced; the goal's arguments hold the new GeoJSON inputs.`,
        })
        // duplicate_plan (v4.5) copies activities and simulation arguments but not the plan's constraint
        // or scheduling specification; copy both so the candidate is checked and scheduled like its source.
        const cs = await pd.gql(`query($p:Int!){ constraint_specification(where:{plan_id:{_eq:$p}}){ constraint_id constraint_revision arguments enabled order } }`, { p: src.id })
        if (cs.constraint_specification.length)
            await pd.gql(`mutation($o:[constraint_specification_insert_input!]!){ insert_constraint_specification(objects:$o){ affected_rows } }`, {
                o: cs.constraint_specification.map((c) => ({ ...c, plan_id: planId })),
            })
        const spec = (await plan(planId)).scheduling_specification
        const others = goals.filter((g) => g.goal_id !== m.goalId)
        const priority = prior[0]?.priority ?? Math.max(-1, ...others.map((g) => g.priority)) + 1
        await pd.gql(`mutation($o:[scheduling_specification_goals_insert_input!]!){ insert_scheduling_specification_goals(objects:$o){ affected_rows } }`, {
            o: [
                { goal_id: m.goalId, arguments: args, enabled: true, priority, specification_id: spec.id },
                // Other goals are kept for the record but disabled: their earlier output was copied as-is,
                // and re-running them here would add to it rather than replace it.
                ...others.map(({ goal_invocation_id, ...g }) => ({ ...g, enabled: false, specification_id: spec.id })),
            ],
        })

        const run = scheduleAndSimulate(planId)
            .catch((e) => {
                runErrors.set(planId, e.message)
                console.error(`[plandev] candidate ${planId}: ${e.message}`)
            })
            .finally(() => inflight.delete(planId))
        inflight.set(planId, run)
        return { planId, sourcePlanId: src.id, sourceRevision: src.revision, replacedDirectives: replaced }
    }

    async function scheduleAndSimulate(planId) {
        // The scheduler rejects a spec whose plan_revision is stale; the PlanDev UI stamps it the same way.
        const { revision, scheduling_specification: spec } = await plan(planId)
        await pd.gql(`mutation($id:Int!,$r:Int!){ update_scheduling_specification_by_pk(pk_columns:{id:$id}, _set:{plan_revision:$r, analysis_only:false}){ id } }`, {
            id: spec.id,
            r: revision,
        })
        const s = await pd.gql(`query($s:Int!){ schedule(specificationId:$s){ analysisId reason } }`, { s: spec.id })
        const analysisId = s.schedule.analysisId
        const req = await waitFor(
            async () => (await pd.gql(`query($a:Int!){ scheduling_request(where:{analysis_id:{_eq:$a}}){ status reason } }`, { a: analysisId })).scheduling_request[0],
            (r) => r && ['success', 'failed'].includes(r.status),
        )
        if (req.status !== 'success') return
        const sim = await pd.gql(`query($p:Int!){ simulate(planId:$p, force:true){ simulationDatasetId status reason } }`, { p: planId })
        if (sim.simulate.status === 'failed') throw new Error(`simulate: ${JSON.stringify(sim.simulate.reason).slice(0, 300)}`)
        await waitFor(
            async () => (await pd.gql(`query($id:Int!){ simulation_dataset_by_pk(id:$id){ status } }`, { id: sim.simulate.simulationDatasetId })).simulation_dataset_by_pk,
            (d) => d && ['success', 'failed'].includes(d.status),
        )
    }

    /** Every plan of the mission's model visible to the integration, with lineage. */
    async function plans(missionKey) {
        const d = await pd.gql(`query($m:Int!){ plan(where:{model_id:{_eq:$m}}, order_by:{id:asc}){ id name parent_id revision owner updated_at } }`, {
            m: await modelOf(byKey(missionKey)),
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
        const d = await pd.gql(`query($id:Int!){ simulation_dataset_by_pk(id:$id){ id dataset_id status reason plan_revision simulation{ plan_id } } }`, { id: simulationDatasetId })
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

    /**
     * Everything an adapter may read about one plan + dataset. When the dataset simulated an older plan
     * revision, the current plan state (directives, goal inputs) no longer describes it: adapters get
     * only what the dataset itself recorded (spans with their arguments, profiles).
     */
    async function context(planId, simulationDatasetId, mission = null) {
        const p = await plan(planId)
        const m = await missionForPlan(p, mission)
        const dataset = simulationDatasetId != null ? await datasetOfPlan(p, simulationDatasetId) : await latestDataset(p)
        const stale = dataset != null && dataset.plan_revision !== p.revision
        const g = await pd.gql(
            `query($s:Int!,$g:Int!){
               scheduling_specification_goals(where:{specification_id:{_eq:$s}, goal_id:{_eq:$g}}){ arguments }
               scheduling_request(where:{specification_id:{_eq:$s}}, order_by:{analysis_id:desc}, limit:1){ analysis_id status reason requested_at specification_revision } }`,
            { s: p.scheduling_specification.id, g: m.goalId },
        )
        const goalArgs = g.scheduling_specification_goals[0]?.arguments || null
        const startMs = Date.parse(p.start_time)
        const ctx = {
            ops: stale ? { ...ops, directives: async () => [] } : ops,
            plan: p,
            dataset,
            stale,
            goalArgs: stale ? null : goalArgs,
            startMs,
            durationSec: intervalToSec(p.duration),
            iso: (sec) => new Date(startMs + sec * 1000).toISOString(),
        }
        return { p, m, dataset, stale, goalArgs, scheduling: g.scheduling_request[0] || null, ctx }
    }

    function provenance(p, m, dataset) {
        return {
            planId: p.id,
            planRevision: p.revision,
            simulationDatasetId: dataset?.id ?? null,
            datasetId: dataset?.dataset_id ?? null,
            simulatedPlanRevision: dataset?.plan_revision ?? null,
            ...m.adapter.conventions,
        }
    }

    /** fid: unique per feature, so a map can select exactly one; style: from the feature's basis. */
    function tag(features, p, dataset) {
        return features.map((f, i) => {
            const style = STYLE_BY_BASIS[f.properties.basis]
            return { ...f, properties: { ...f.properties, ...(style && { style }), fid: i, planId: p.id, simulationDatasetId: dataset?.id ?? null } }
        })
    }

    /** The plan this one was duplicated from, and its revision at the time (the snapshot duplicate_plan took). */
    async function lineage(p) {
        if (p.parent_id == null) return null
        const d = await pd.gql(
            `query($p:Int!,$at:timestamptz!){ plan_by_pk(id:$p){ id name revision model_id }
               plan_snapshot(where:{plan_id:{_eq:$p}, taken_at:{_lte:$at}}, order_by:{taken_at:desc}, limit:1){ revision } }`,
            { p: p.parent_id, at: p.created_at },
        )
        const parent = d.plan_by_pk
        if (!parent) return { id: p.parent_id, visible: false }
        return { id: parent.id, name: parent.name, revisionNow: parent.revision, revisionAtDerivation: d.plan_snapshot[0]?.revision ?? null, sameModel: parent.model_id === p.model_id }
    }

    // ---------- the plan view: everything a map needs about one plan + dataset ----------

    async function view(planId, simulationDatasetId = null, mission = null) {
        const { p, m, dataset, stale, goalArgs, scheduling, ctx } = await context(planId, simulationDatasetId, mission)
        const a = m.adapter
        const derivedFrom = await lineage(p)
        const out = {
            mission: { key: a.key, label: a.label },
            provenance: provenance(p, m, dataset),
            plan: { id: p.id, name: p.name, description: p.description, startTime: p.start_time, durationSec: ctx.durationSec, parentId: p.parent_id, revision: p.revision },
            derivedFrom,
            status: status(p.id, scheduling, dataset, stale),
            stale,
            scheduling,
            // Spec-goal arguments are not versioned with the plan; flag edits made after the last scheduling run.
            inputsEditedSinceScheduling: scheduling ? scheduling.specification_revision !== p.scheduling_specification.revision : null,
            simulation: dataset,
            inputs: goalArgs ? a.inputsFromGoalArguments(goalArgs) : null,
            features: [],
            position: null,
            table: null,
            notes: [],
            summary: [],
            constraints: null,
        }
        if (dataset?.status === 'success') {
            Object.assign(out, await a.interpret(ctx))
            if (stale)
                out.notes.unshift({
                    warn: true,
                    text: `Simulation dataset ${dataset.id} is of plan revision ${dataset.plan_revision}; the plan is now at revision ${p.revision}. Showing only what that simulation recorded — current goal inputs and directive details are omitted. Re-simulate for the current plan.`,
                })
            const metrics = await a.metrics(ctx)
            // Compare against the plan this one was derived from, at its latest simulation.
            if (derivedFrom?.sameModel) {
                const sp = await plan(derivedFrom.id)
                const sds = await latestDataset(sp)
                if (sds?.status === 'success') {
                    const sStart = Date.parse(sp.start_time)
                    const sm = await a.metrics({ ...ctx, plan: sp, dataset: sds, goalArgs: null, startMs: sStart, durationSec: intervalToSec(sp.duration) })
                    for (const x of metrics) x.base = sm.find((b) => b.key === x.key)?.value ?? null
                    derivedFrom.simulationDatasetId = sds.id
                    derivedFrom.simulationStale = sds.plan_revision !== sp.revision
                }
            }
            out.summary = metrics
            out.constraints = await constraints(p.id, dataset.id, ctx.startMs).catch((e) => [{ name: 'constraint check', success: false, windows: [], errors: [e.message] }])
        }
        out.features = tag(out.features, p, dataset)
        return out
    }

    /** Read-only: the adapter's evaluation of spatial inputs against a plan's simulation. Creates nothing. */
    async function evaluate(planId, simulationDatasetId, { mission, targets, params }) {
        const { p, m, dataset, stale, ctx } = await context(planId, simulationDatasetId, mission)
        const ev = m.adapter.evaluation
        if (!ev || !m.adapter.evaluate) throw new Error(`the ${m.adapter.key} adapter defines no evaluation`)
        if (dataset?.status !== 'success') throw new Error(`plan ${p.id} has no successful simulation to evaluate`)
        const r = await m.adapter.evaluate(ctx, normalizeTargets(targets, ev.targets), checkParams(ev.params, params))
        return { provenance: provenance(p, m, dataset), stale, ...r, features: tag(r.features, p, dataset) }
    }

    function status(planId, scheduling, dataset, stale) {
        if (runErrors.has(planId)) return `failed: ${runErrors.get(planId)}`
        // While this process drives a candidate, the scheduler's own simulation datasets can appear and
        // finish first; only the dataset requested after scheduling counts, so report running until then.
        if (inflight.has(planId)) return 'running'
        if (scheduling?.status === 'failed' && !dataset) return 'scheduling failed'
        if (!dataset) return 'not simulated'
        if (dataset.status === 'success') return stale ? 'stale' : 'complete'
        return dataset.status === 'failed' ? 'simulation failed' : 'running'
    }

    return {
        createCandidate,
        scheduleAndSimulate,
        plans,
        view,
        evaluate,
        plan,
        missions,
        config: async (key) => {
            const m = byKey(key)
            const a = m.adapter
            return {
                mission: { key, label: a.label, help: a.help },
                defaultPlanId: m.basePlanId,
                goalId: m.goalId,
                params: a.params,
                targets: a.targets,
                evaluation: a.evaluation ? { help: a.evaluation.help, targets: a.evaluation.targets, params: a.evaluation.params } : null,
                conventions: a.conventions,
            }
        },
    }
}

module.exports = { createCandidates }
