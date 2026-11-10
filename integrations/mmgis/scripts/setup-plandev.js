#!/usr/bin/env node
// One-time PlanDev setup for the MMGIS prototype: upload the 05-orbiter model and the
// ScheduleTargetObservations goal, import the base plan, and simulate it. Idempotent by name.
//
//   PLANDEV_GATEWAY_URL=http://localhost:9000 PLANDEV_HASURA_URL=http://localhost:8080 \
//   PLANDEV_USERNAME=mmgis-planner PLANDEV_PASSWORD=... node scripts/setup-plandev.js
'use strict'
const fs = require('fs')
const path = require('path')
const { clientFromEnv, sleep } = require('../lib/plandev')

const ROOT = path.resolve(__dirname, '../../..')
const ORBITER = path.join(ROOT, 'examples/05-orbiter')
const MODEL_JAR = path.join(ORBITER, 'build/libs/orbiter-example.jar')
const GOAL_JAR = path.join(ORBITER, 'scheduling/build/libs/ScheduleTargetObservations.jar')
const BASE_PLAN = path.join(ORBITER, 'demo/plans/SimplePlan.json')

const MODEL_NAME = 'orbiter-mmgis'
const GOAL_NAME = 'ScheduleTargetObservations'
const PLAN_NAME = 'MRO base plan (MMGIS demo)'

async function main() {
    for (const f of [MODEL_JAR, GOAL_JAR]) {
        if (!fs.existsSync(f)) throw new Error(`${f} missing — see integrations/mmgis/README.md "Build"`)
    }
    const pd = clientFromEnv()

    // Model
    let { mission_model: models } = await pd.gql(
        `query($n:String!){ mission_model(where:{name:{_eq:$n}}, order_by:{id:desc}){ id } }`,
        { n: MODEL_NAME },
    )
    let modelId = models[0]?.id
    if (!modelId) {
        const fileId = await pd.uploadFile(fs.readFileSync(MODEL_JAR), path.basename(MODEL_JAR))
        const d = await pd.gql(
            `mutation($m:mission_model_insert_input!){ insert_mission_model_one(object:$m){ id } }`,
            { m: { name: MODEL_NAME, version: '1', mission: 'MRO', definition_file_id: fileId } },
        )
        modelId = d.insert_mission_model_one.id
        console.log(`created model ${modelId}; waiting for activity types…`)
        for (let i = 0; ; i++) {
            const t = await pd.gql(
                `query($id:Int!){ activity_type_aggregate(where:{model_id:{_eq:$id}}){ aggregate{ count } } }`,
                { id: modelId },
            )
            if (t.activity_type_aggregate.aggregate.count > 0) break
            if (i > 60) throw new Error('model did not finish loading (check merlin logs / SPICE mount)')
            await sleep(2000)
        }
    }
    console.log(`model ${MODEL_NAME} = ${modelId}`)

    // Goal
    const { scheduling_goal_metadata: goals } = await pd.gql(
        `query($n:String!){ scheduling_goal_metadata(where:{name:{_eq:$n}}, order_by:{id:desc}){ id } }`,
        { n: GOAL_NAME },
    )
    let goalId = goals[0]?.id
    if (!goalId) {
        const jarId = await pd.uploadFile(fs.readFileSync(GOAL_JAR), path.basename(GOAL_JAR))
        const d = await pd.gql(
            `mutation($g:scheduling_goal_metadata_insert_input!){ insert_scheduling_goal_metadata_one(object:$g){ id } }`,
            {
                g: {
                    name: GOAL_NAME,
                    description:
                        'MRO closest sub-spacecraft pass per GeoJSON target → TakeRadarObservation (not footprint coverage).',
                    public: true,
                    versions: { data: [{ type: 'JAR', uploaded_jar_id: jarId }] },
                },
            },
        )
        goalId = d.insert_scheduling_goal_metadata_one.id
    }
    console.log(`goal ${GOAL_NAME} = ${goalId}`)

    // Base plan
    const { plan: plans } = await pd.gql(
        `query($n:String!,$m:Int!){ plan(where:{name:{_eq:$n}, model_id:{_eq:$m}}){ id } }`,
        { n: PLAN_NAME, m: modelId },
    )
    let planId = plans[0]?.id
    if (!planId) {
        const planJson = JSON.parse(fs.readFileSync(BASE_PLAN, 'utf8'))
        const r = await pd.importPlan({
            name: PLAN_NAME,
            modelId,
            startTime: planJson.start_time,
            duration: planJson.duration,
            planJson,
        })
        planId = r.id
        const sim = await pd.gql(`query($p:Int!){ simulate(planId:$p, force:true){ simulationDatasetId status reason } }`, {
            p: planId,
        })
        console.log(`imported plan ${planId}; base simulation requested (dataset ${sim.simulate.simulationDatasetId})`)
    }
    console.log(`base plan "${PLAN_NAME}" = ${planId}`)
    console.log(`\nMMGIS backend env:\n  PLANDEV_BASE_PLAN_ID=${planId}\n  PLANDEV_GOAL_ID=${goalId}`)
}

main().catch((e) => {
    console.error(e.message)
    process.exit(1)
})
