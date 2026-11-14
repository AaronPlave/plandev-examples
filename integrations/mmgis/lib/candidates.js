// Mission-independent PlanDev workflow for spatial planning on existing plans:
//   - read any plan of a configured mission model, at a consistent plan revision / simulation dataset;
//   - explore an alternative on a working branch: duplicate the plan once, then set the mission goals'
//     inputs, run the plan's whole scheduling specification and simulate, as often as needed;
//   - evaluate a plan read-only against spatial inputs.
// Mission meaning (which goals take map inputs, geometry, metrics, evaluation) comes from the adapter.
//
// All durable state lives in PlanDev: plans and parent_id lineage, the snapshot duplicate_plan takes,
// spec-goal arguments, directives' source goal invocation (which PlanDev's goal auto-delete uses to
// replace a goal's earlier output), scheduling requests, simulation datasets, and a plan tag marking a
// working branch. This module keeps only in-flight promises, run errors, and a cache of dataset reads.
'use strict'
const { sleep } = require('./plandev')
const { intervalToSec, checkParams, normalizeTargets } = require('./util')

const PROFILE_CACHE_MAX = 200 // ponytail: FIFO by (dataset, resource); a real LRU if many datasets are browsed

// How each kind of geometry is drawn, so modeled states read differently from planned geometry, assumed
// paths, user inputs and analysis constructions. Adapters say which one a feature is (properties.basis).
const STYLE_BY_BASIS = {
    simulated: null, // the layer's own solid style
    planned: { weight: 9, opacity: 0.3, fillOpacity: 0.15 }, // a wide, faint band: where the plan says to go
    violation: { color: '#ff1744', fillColor: '#ff1744', weight: 5, opacity: 0.95 },
    illustrative: { dashArray: '8 6' },
    input: { color: '#ffffff', fillColor: '#ffffff', weight: 2, dashArray: '2 5', fillOpacity: 0.1 },
    analysis: { color: '#ffea00', fillColor: '#ffea00', weight: 2, dashArray: '4 4', fillOpacity: 0.15 },
}

// A plan with this tag is a working branch: the integration may re-run its goals with new inputs.
// Any other plan (a source plan, a kept alternative) is only ever branched from, never changed.
const EXPLORING_TAG = 'mmgis-exploring'

function createCandidates(pd, missions) {
    // missions: [{ adapter, basePlanId }]; the base plan identifies the mission model and is the default
    // plan to show; any plan of that model can be inspected, evaluated or explored. adapter.goals names the
    // scheduling goals that take the map's inputs.
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
               scheduling_specification{ id revision } simulations{ id } tags{ tag{ name } } } }`,
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

    /** Goal ids by adapter goal name (a name may have several metadata rows; any of them counts). */
    async function goalIds(m) {
        if (!m.goalIds) {
            const names = m.adapter.goals.map((g) => g.name)
            const d = await pd.gql(`query($n:[String!]!){ scheduling_goal_metadata(where:{name:{_in:$n}}, order_by:{id:desc}){ id name } }`, { n: names })
            m.goalIds = Object.fromEntries(names.map((n) => [n, d.scheduling_goal_metadata.filter((g) => g.name === n).map((g) => g.id)]))
            for (const n of names) if (!m.goalIds[n].length) throw new Error(`scheduling goal ${n} is not in PlanDev (see scripts/setup-plandev.js)`)
        }
        return m.goalIds
    }

    /** The plan's spec-goal arguments for each adapter goal: { name: arguments | null }. */
    async function goalArgsByName(m, goals) {
        const ids = await goalIds(m)
        return Object.fromEntries(m.adapter.goals.map((g) => [g.name, goals.find((x) => ids[g.name].includes(x.goal_id))?.arguments ?? null]))
    }

    async function tagId() {
        const d = await pd.gql(`query($n:String!){ tags(where:{name:{_eq:$n}}){ id } }`, { n: EXPLORING_TAG })
        if (d.tags[0]) return d.tags[0].id
        return (await pd.gql(`mutation($n:String!){ insert_tags_one(object:{name:$n, color:"#ff9100"}){ id } }`, { n: EXPLORING_TAG })).insert_tags_one.id
    }

    const isExploring = (p) => (p.tags || []).some((t) => t.tag.name === EXPLORING_TAG)

    function checkRevision(p, expectedRevision) {
        if (expectedRevision != null && p.revision !== expectedRevision)
            throw new Error(`plan ${p.id} is now at revision ${p.revision}, not ${expectedRevision} as shown; reload before changing it`)
    }

    /**
     * Write the map's inputs into the plan's own invocations of the adapter's goals (merged into their
     * existing arguments; enabled state, order and other goals untouched). A goal the spec lacks is
     * appended. Two invocations of one adapter goal is ambiguous and refused.
     */
    async function applyInputs(p, m, targets, params) {
        const fc = normalizeTargets(targets, m.adapter.targets)
        const pv = checkParams(m.adapter.params, params)
        const ids = await goalIds(m)
        const goals = await specGoals(p.scheduling_specification.id)
        for (const g of m.adapter.goals) {
            const args = g.arguments(fc, pv)
            const mine = goals.filter((x) => ids[g.name].includes(x.goal_id))
            if (mine.length > 1) throw new Error(`plan ${p.id}'s scheduling specification has ${mine.length} ${g.name} goals; expected one`)
            if (mine[0])
                await pd.gql(`mutation($id:Int!,$a:jsonb!){ update_scheduling_specification_goals_by_pk(pk_columns:{goal_invocation_id:$id}, _set:{arguments:$a}){ goal_invocation_id } }`, {
                    id: mine[0].goal_invocation_id,
                    a: { ...mine[0].arguments, ...args },
                })
            else
                await pd.gql(`mutation($g:scheduling_specification_goals_insert_input!){ insert_scheduling_specification_goals_one(object:$g){ goal_invocation_id } }`, {
                    g: { specification_id: p.scheduling_specification.id, goal_id: ids[g.name][0], arguments: args, enabled: true },
                })
        }
    }

    function run(planId) {
        if (inflight.has(planId)) throw new Error(`plan ${planId} is already being scheduled and simulated`)
        runErrors.delete(planId)
        const r = scheduleAndSimulate(planId)
            .catch((e) => {
                runErrors.set(planId, e.message)
                console.error(`[plandev] plan ${planId}: ${e.message}`)
            })
            .finally(() => inflight.delete(planId))
        inflight.set(planId, r)
    }

    // ---------- exploration: working branches are ordinary PlanDev plans ----------

    /**
     * Branch `sourcePlanId` into a new working branch and run its scheduling specification with the map's
     * inputs. duplicate_plan copies directives, the scheduling and constraint specifications, and maps each
     * goal-created directive to the branch's own goal invocation, so the goals replace their earlier
     * output there; everything else is kept. The source is not modified.
     */
    async function explore(sourcePlanId, { mission, targets, params, requestedBy, label, expectedRevision }) {
        const src = await plan(sourcePlanId)
        const m = await missionForPlan(src, mission)
        checkRevision(src, expectedRevision)
        normalizeTargets(targets, m.adapter.targets) // validate before creating anything
        checkParams(m.adapter.params, params)
        const n = (await pd.gql(`query($p:Int!){ plan_aggregate(where:{parent_id:{_eq:$p}}){ aggregate{ count } } }`, { p: src.id })).plan_aggregate.aggregate.count + 1
        const name = `${src.name.split(' · ')[0]} · from #${src.id} · ${label ? String(label).slice(0, 60) : `alternative ${n}`}`
        // ponytail: revision checked just before duplicating, not atomically with it; a PlanDev-side check if edits race this
        const dup = await pd.gql(`mutation($p:Int!,$n:String!){ duplicate_plan(args:{plan_id:$p, new_plan_name:$n}){ new_plan_id } }`, { p: src.id, n: name })
        const planId = dup.duplicate_plan.new_plan_id
        await pd.gql(`mutation($id:Int!,$d:String!,$t:Int!){
            update_plan_by_pk(pk_columns:{id:$id}, _set:{description:$d}){ id }
            insert_plan_tags_one(object:{plan_id:$id, tag_id:$t}, on_conflict:{constraint:plan_tags_pkey, update_columns:[]}){ tag_id } }`, {
            id: planId,
            t: await tagId(),
            d: `Working branch of plan ${src.id} (revision ${src.revision}), explored by ${requestedBy} in MMGIS (${m.adapter.key}). ` +
               `The ${m.adapter.goals.map((g) => g.name).join(' and ')} goals' arguments hold the map's inputs.`,
        })
        const p = await plan(planId)
        await applyInputs(p, m, targets, params)
        run(planId)
        return { planId, sourcePlanId: src.id, sourceRevision: src.revision }
    }

    /** Re-run a working branch with new inputs. Refuses any plan that is not a working branch. */
    async function update(planId, { mission, targets, params, expectedRevision }) {
        const p = await plan(planId)
        const m = await missionForPlan(p, mission)
        if (!isExploring(p)) throw new Error(`plan ${p.id} is not a working branch; explore an alternative from it instead`)
        checkRevision(p, expectedRevision)
        if (inflight.has(planId)) throw new Error(`plan ${planId} is already being scheduled and simulated`)
        await applyInputs(p, m, targets, params)
        run(planId)
        return { planId, fromRevision: p.revision }
    }

    /** Stop treating a working branch as one: it stays an ordinary PlanDev plan and can still be branched from. */
    async function keep(planId) {
        const p = await plan(planId)
        await missionForPlan(p)
        await pd.gql(`mutation($p:Int!,$t:Int!){ delete_plan_tags(where:{plan_id:{_eq:$p}, tag_id:{_eq:$t}}){ affected_rows } }`, { p: planId, t: await tagId() })
        return { planId }
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

    /**
     * Every plan of the mission's model visible to the integration: lineage, whether it is a working
     * branch, and its latest simulation dataset, so a client can tell when a plan's results change.
     */
    async function plans(missionKey) {
        const d = await pd.gql(
            `query($m:Int!){ plan(where:{model_id:{_eq:$m}}, order_by:{id:asc}){ id name parent_id revision owner updated_at tags{ tag{ name } }
               simulations{ simulation_datasets(order_by:{id:desc}, limit:1){ id status plan_revision } } } }`,
            { m: await modelOf(byKey(missionKey)) },
        )
        return d.plan.map(({ tags, simulations, ...p }) => {
            const ds = simulations[0]?.simulation_datasets[0] || null
            return {
                ...p,
                exploring: isExploring({ tags }),
                running: inflight.has(p.id),
                latest: ds && { simulationDatasetId: ds.id, status: ds.status, planRevision: ds.plan_revision, stale: ds.plan_revision !== p.revision },
            }
        })
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
     * Everything an adapter may read about one plan + dataset. Goal inputs (spec-goal arguments) are
     * not versioned with datasets, so they are given to the adapter only when they demonstrably produced
     * this dataset: it simulated the current plan revision, and the last scheduling run succeeded with
     * the specification as it is now. Otherwise adapters get only what the dataset itself recorded (spans
     * with their arguments, profiles) — and, for an older revision, no current directives either.
     */
    async function context(planId, simulationDatasetId, mission = null) {
        const p = await plan(planId)
        const m = await missionForPlan(p, mission)
        const dataset = simulationDatasetId != null ? await datasetOfPlan(p, simulationDatasetId) : await latestDataset(p)
        const stale = dataset != null && dataset.plan_revision !== p.revision
        const g = await pd.gql(
            `query($s:Int!){ scheduling_request(where:{specification_id:{_eq:$s}}, order_by:{analysis_id:desc}, limit:1){
               analysis_id status reason requested_at specification_revision plan_revision } }`,
            { s: p.scheduling_specification.id },
        )
        const scheduling = g.scheduling_request[0] || null
        const goalArgs = await goalArgsByName(m, await specGoals(p.scheduling_specification.id))
        const inputsCurrent =
            dataset != null && !stale && !inflight.has(p.id) && scheduling?.status === 'success' && scheduling.specification_revision === p.scheduling_specification.revision
        const startMs = Date.parse(p.start_time)
        const ctx = {
            ops: stale ? { ...ops, directives: async () => [] } : ops,
            plan: p,
            dataset,
            stale,
            goalArgs: inputsCurrent ? goalArgs : null,
            startMs,
            durationSec: intervalToSec(p.duration),
            iso: (sec) => new Date(startMs + sec * 1000).toISOString(),
        }
        return { p, m, dataset, stale, goalArgs, inputsCurrent, scheduling, ctx }
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

    /** The plan's simulation datasets, newest first, each identified by the plan revision it simulated. */
    async function history(p) {
        if (!p.simulations[0]) return []
        const d = await pd.gql(
            `query($s:Int!){ simulation_dataset(where:{simulation_id:{_eq:$s}}, order_by:{id:desc}, limit:12){ id status plan_revision requested_at } }`,
            { s: p.simulations[0].id },
        )
        return d.simulation_dataset.map((x) => ({ simulationDatasetId: x.id, status: x.status, planRevision: x.plan_revision, requestedAt: x.requested_at, current: x.plan_revision === p.revision }))
    }

    // ---------- the plan view: everything a map needs about one plan + dataset ----------

    async function view(planId, simulationDatasetId = null, mission = null) {
        const { p, m, dataset, stale, goalArgs, inputsCurrent, scheduling, ctx } = await context(planId, simulationDatasetId, mission)
        const a = m.adapter
        const derivedFrom = await lineage(p)
        const anyArgs = Object.values(goalArgs).some(Boolean)
        const out = {
            mission: { key: a.key, label: a.label },
            provenance: provenance(p, m, dataset),
            plan: { id: p.id, name: p.name, description: p.description, startTime: p.start_time, durationSec: ctx.durationSec, parentId: p.parent_id, revision: p.revision },
            derivedFrom,
            status: status(p.id, scheduling, dataset, stale),
            stale,
            exploring: isExploring(p),
            scheduling,
            // Spec-goal arguments are not versioned with the plan; flag edits made after the last scheduling run.
            inputsEditedSinceScheduling: scheduling ? scheduling.specification_revision !== p.scheduling_specification.revision : null,
            simulation: dataset,
            // The goals' current arguments, to start an edit from; inputsCurrent says whether they produced this dataset.
            inputs: anyArgs ? a.inputsFromGoalArguments(goalArgs) : null,
            inputsCurrent,
            history: await history(p),
            features: [],
            overlays: [],
            position: null,
            table: null,
            notes: [],
            summary: [],
            constraints: null,
        }
        // A plan's planned geometry needs no simulation: an adapter that can read it from the plan's
        // directives alone says so, and is then also asked when there is no successful dataset.
        if (dataset?.status !== 'success' && a.interpretsPlanOnly) Object.assign(out, await a.interpret({ ...ctx, dataset: null }))
        if (dataset?.status === 'success') {
            Object.assign(out, await a.interpret(ctx))
            if (stale)
                out.notes.unshift({
                    warn: true,
                    text: `Simulation dataset ${dataset.id} is of plan revision ${dataset.plan_revision}; the plan is now at revision ${p.revision}. Showing only what that simulation recorded — current goal inputs and directive details are omitted. Re-simulate for the current plan.`,
                })
            else if (!inputsCurrent && anyArgs)
                out.notes.unshift({
                    warn: true,
                    text: 'The goals’ inputs changed after this simulation’s scheduling run (or are being re-run), so they are not drawn: PlanDev does not record which inputs a scheduling run used.',
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
            out.features.push(...violationFeatures(out.constraints, out.position))
        }
        out.features = tag(out.features, p, dataset)
        return out
    }

    /**
     * Where each constraint violation happened: the simulated positions held during its windows. Needs
     * only constraint results and a position track, so it is the same for every mission.
     */
    function violationFeatures(constraints, position) {
        const out = []
        const samples = position?.samples || []
        for (const c of constraints || []) {
            for (const w of c.windows) {
                const before = samples.findLast(([t]) => t <= w.startMs)
                const pts = [...(before ? [before] : []), ...samples.filter(([t]) => t > w.startMs && t <= w.endMs)].map(([, lon, lat]) => [lon, lat])
                if (!pts.length) continue
                out.push({
                    type: 'Feature',
                    properties: { kind: 'violation', basis: 'violation', name: `${c.name} violated`, constraint: c.name, startMs: w.startMs, endMs: w.endMs },
                    geometry: pts.length > 1 ? { type: 'LineString', coordinates: pts } : { type: 'Point', coordinates: pts[0] },
                })
            }
        }
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
        if (['pending', 'incomplete'].includes(scheduling?.status)) return 'running'
        if (scheduling?.status === 'failed' && !dataset) return 'scheduling failed'
        if (!dataset) return 'not simulated'
        if (dataset.status === 'success') return stale ? 'stale' : 'complete'
        return dataset.status === 'failed' ? 'simulation failed' : 'running'
    }

    return {
        explore,
        update,
        keep,
        scheduleAndSimulate,
        plans,
        view,
        evaluate,
        plan,
        missions,
        /** A data product the adapter serves to the map (e.g. the terrain grid its mission plans on). */
        data: async (key, name) => {
            const fn = byKey(key).adapter.data?.[name]
            if (!fn) throw new Error(`the ${key} adapter has no data product ${name}`)
            return fn()
        },
        config: async (key) => {
            const m = byKey(key)
            const a = m.adapter
            return {
                mission: { key, label: a.label, help: a.help },
                defaultPlanId: m.basePlanId,
                goals: a.goals.map((g) => g.name),
                params: a.params,
                targets: a.targets,
                evaluation: a.evaluation ? { help: a.evaluation.help, targets: a.evaluation.targets, params: a.evaluation.params } : null,
                conventions: a.conventions,
            }
        },
    }
}

module.exports = { createCandidates }
