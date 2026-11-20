#!/usr/bin/env node
// End-to-end check of the MoonFall example on a live PlanDev stack (examples/12-moonfall).
//
//   node scripts/verify-moonfall.js <hopPlanId> [<surveyPlanId> ...]     (env: PLANDEV_* as for setup-plandev.js)
//
// On the hop plan it edits the PerformHop destination the way an operator does in the activity form (the
// directive's arguments), re-simulates, and checks that the simulation flew a new trajectory with a different
// duration and propellant, that nothing of the old trajectory remains in the drone's state profile, and that an
// infeasible destination leaves the drone where it was with the solver's reason. It then restores the original
// destination and checks the original trajectory comes back bit-identical (same trajectoryId, duration, mass).
// For survey plans it prints the hop and imaging outcome. Exits 1 on any inconsistency.
'use strict'
const { clientFromEnv, sleep } = require('../lib/plandev')

const pd = clientFromEnv()
const problems = []
const fail = (m) => problems.push(m)

async function simulate(planId) {
    const { simulate } = await pd.gql(`query($p:Int!){ simulate(planId:$p, force:true){ simulationDatasetId } }`, { p: planId })
    const id = simulate.simulationDatasetId
    for (;;) {
        const { simulation_dataset_by_pk: d } = await pd.gql(`query($id:Int!){ simulation_dataset_by_pk(id:$id){ status reason dataset_id } }`, { id })
        if (d.status === 'success') return d.dataset_id
        if (d.status === 'failed') throw new Error(`simulation ${id} failed: ${JSON.stringify(d.reason)}`)
        await sleep(1000)
    }
}

async function latestDataset(planId) {
    const { simulation_dataset: [d] } = await pd.gql(
        `query($p:Int!){ simulation_dataset(where:{simulation:{plan_id:{_eq:$p}}, status:{_eq:"success"}}, order_by:{id:desc}, limit:1){ dataset_id } }`, { p: planId })
    return d.dataset_id
}

async function spans(ds, type) {
    const { span } = await pd.gql(`query($d:Int!,$t:String!){ span(where:{dataset_id:{_eq:$d}, type:{_eq:$t}}, order_by:{start_offset:asc}){ start_offset duration attributes } }`, { d: ds, t: type })
    return span.map((s) => ({ ...s, out: s.attributes.computedAttributes, args: s.attributes.arguments, directiveId: s.attributes.directiveId }))
}

async function trajectoryIds(ds, drone) {
    const { profile: [p] } = await pd.gql(`query($d:Int!,$n:String!){ profile(where:{dataset_id:{_eq:$d}, name:{_eq:$n}}){ profile_segments{ dynamics } } }`, { d: ds, n: `${drone}.state` })
    return new Set(p.profile_segments.map((s) => s.dynamics.trajectoryId).filter(Boolean))
}

const setArgs = (planId, id, args) =>
    pd.gql(`mutation($p:Int!,$id:Int!,$a:jsonb!){ update_activity_directive_by_pk(pk_columns:{plan_id:$p, id:$id}, _set:{arguments:$a}){ id } }`, { p: planId, id, a: args })

const fmt = (o) => `${o.status} ${o.trajectoryId || ''} ${o.durationS?.toFixed(1)} s, ${o.propellantKg?.toFixed(3)} kg, range ${o.rangeM?.toFixed(0)} m — ${o.reason}`

async function checkHopPlan(planId) {
    const ds0 = await latestDataset(planId)
    const [hop0] = await spans(ds0, 'PerformHop')
    const args0 = hop0.args
    console.log(`\n== plan ${planId}: ${args0.drone} → ${args0.destinationLatitude}, ${args0.destinationLongitude}\n  original: ${fmt(hop0.out)}`)

    // 1. The operator moves the destination.
    const moved = { ...args0, destinationLatitude: -89.7, destinationLongitude: 0 }
    await setArgs(planId, hop0.directiveId, moved)
    const ds1 = await simulate(planId)
    const [hop1] = await spans(ds1, 'PerformHop')
    console.log(`  moved to -89.70, 0: ${fmt(hop1.out)}`)
    if (hop1.out.status !== 'FEASIBLE') fail('moved destination should be feasible')
    if (hop1.out.trajectoryId === hop0.out.trajectoryId) fail('the moved destination kept the old trajectory id')
    if (!(hop1.out.durationS > hop0.out.durationS && hop1.out.propellantKg > hop0.out.propellantKg)) fail('a 9.7 km hop should take longer and burn more than a 3.9 km one')
    if (Math.abs(hop1.out.landingLatitude + 89.7) > 1e-6) fail('did not land at the moved destination')
    const ids1 = await trajectoryIds(ds1, args0.drone)
    if (ids1.has(hop0.out.trajectoryId) || !ids1.has(hop1.out.trajectoryId)) fail(`state profile trajectories ${[...ids1]} are not exactly the new one`)
    const dur = (s) => s.duration
    console.log(`  span durations: ${dur(hop0)} → ${dur(hop1)}; state profile carries only ${[...ids1]}`)

    // 2. An infeasible destination: explicit result, no motion.
    await setArgs(planId, hop0.directiveId, { ...args0, destinationLatitude: -89.45, destinationLongitude: -60 })
    const ds2 = await simulate(planId)
    const [hop2] = await spans(ds2, 'PerformHop')
    console.log(`  steep site -89.45, -60: ${fmt(hop2.out)}`)
    if (hop2.out.status !== 'LANDING_SLOPE') fail('the steep site should be rejected for slope')
    if ((await trajectoryIds(ds2, args0.drone)).size !== 0) fail('a rejected hop must not leave a trajectory in the state profile')

    // 3. Back to the original: the same flight, bit for bit.
    await setArgs(planId, hop0.directiveId, args0)
    const ds3 = await simulate(planId)
    const [hop3] = await spans(ds3, 'PerformHop')
    console.log(`  restored: ${fmt(hop3.out)}`)
    for (const k of ['trajectoryId', 'durationS', 'propellantKg', 'landingLatitude', 'landingLongitude'])
        if (hop3.out[k] !== hop0.out[k]) fail(`restored ${k} ${hop3.out[k]} != original ${hop0.out[k]}`)
}

async function reportSurvey(planId) {
    const ds = await latestDataset(planId)
    const { plan_by_pk: plan } = await pd.gql(`query($p:Int!){ plan_by_pk(id:$p){ name } }`, { p: planId })
    const [hop] = await spans(ds, 'PerformHop')
    const [img] = await spans(ds, 'AcquireSurveyImages')
    console.log(`\n== plan ${planId}: ${plan.name}\n  hop: ${fmt(hop.out)}`)
    if (!img) return fail(`plan ${planId} has no survey`)
    const o = img.out
    console.log(`  survey "${o.targetName}": ${o.imagesTaken} taken, ${o.imagesSkipped} skipped, ${o.dataMbit.toFixed(1)} Mbit, area coverage ${(100 * (o.geometricCoverage ?? o.targetCoverage)).toFixed(1)} %`)
    if (o.trajectoryId !== hop.out.trajectoryId) fail(`plan ${planId}: images from ${o.trajectoryId}, hop flew ${hop.out.trajectoryId}`)
    const fc = JSON.parse(o.footprints)
    if (fc.features.length !== o.imagesTaken) fail(`plan ${planId}: ${fc.features.length} footprints for ${o.imagesTaken} images`)
    return o
}

;(async () => {
    const [hopPlan, ...surveyPlans] = process.argv.slice(2).map(Number)
    if (hopPlan) await checkHopPlan(hopPlan)
    for (const p of surveyPlans) await reportSurvey(p)
    console.log(problems.length ? `\nFAILED:\n- ${problems.join('\n- ')}` : '\nOK')
    process.exit(problems.length ? 1 : 0)
})().catch((e) => {
    console.error(e)
    process.exit(1)
})
