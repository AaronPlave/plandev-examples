#!/usr/bin/env node
// One-time PlanDev setup for the MMGIS prototype, per mission: upload the mission model, its
// scheduling goal and (optionally) a constraint, create or import the base plan, and simulate it.
// Idempotent by name.
//
//   PLANDEV_ROLE=aerie_admin PLANDEV_GATEWAY_URL=http://localhost:9000 PLANDEV_HASURA_URL=http://localhost:8080 \
//   PLANDEV_USERNAME=mmgis-planner PLANDEV_PASSWORD=... node scripts/setup-plandev.js [mro|hopper ...]
'use strict'
const fs = require('fs')
const path = require('path')
const { clientFromEnv, sleep } = require('../lib/plandev')

const EX = path.resolve(__dirname, '../../../examples')
const MISSIONS = {
    mro: {
        model: { name: 'orbiter-mmgis', mission: 'MRO', jar: `${EX}/05-orbiter/build/libs/orbiter-example.jar` },
        goal: {
            name: 'ScheduleTargetObservations',
            jar: `${EX}/05-orbiter/scheduling/build/libs/ScheduleTargetObservations.jar`,
            description: 'MRO closest sub-spacecraft pass per GeoJSON target → TakeRadarObservation (not footprint coverage).',
        },
        plan: { name: 'MRO base plan (MMGIS demo)', file: `${EX}/05-orbiter/demo/plans/SimplePlan.json` },
    },
    hopper: {
        model: { name: 'hopper-mmgis', mission: 'Hopper', jar: `${EX}/04-hopper/build/libs/hopper.jar` },
        goal: {
            name: 'ScheduleHopTraverse',
            jar: `${EX}/04-hopper/scheduling/build/libs/ScheduleHopTraverse.jar`,
            description: 'Lunar hopper: hop to each GeoJSON site and image it (illustrative hop timing, see HopModel).',
        },
        constraint: { name: 'MinBatterySOC (hopper)', jar: `${EX}/04-hopper/constraints/build/libs/MinBatterySOC.jar`, arguments: { minSOC: 80 } },
        plan: {
            name: 'Hopper base plan (MMGIS demo)',
            startTime: '2025-01-01T00:00:00Z',
            duration: '48:00:00',
            // Illustrative small-hopper power sizing (the model defaults' 5 m² array out-produces the
            // 1000 W hop load, so power never constrains a traverse). Plain model configuration.
            simulationArguments: {
                powerConfig: {
                    batteryConfig: { batteryCapacity: 10.0, busVoltage: 28.0, initialSOC: 100.0 },
                    powerSourceConfig: { deploymentState: 'DEPLOYED', arrayMechArea: 2.0, packingFactor: 0.9, cellEfficiency: 0.28, conversionEfficiency: 0.9, otherLosses: 1.0 },
                },
            },
        },
    },
}

async function upsertModel(pd, m) {
    const { mission_model: models } = await pd.gql(`query($n:String!){ mission_model(where:{name:{_eq:$n}}, order_by:{id:desc}){ id } }`, { n: m.name })
    if (models[0]) return models[0].id
    const fileId = await pd.uploadFile(fs.readFileSync(m.jar), path.basename(m.jar))
    const d = await pd.gql(`mutation($m:mission_model_insert_input!){ insert_mission_model_one(object:$m){ id } }`, {
        m: { name: m.name, version: '1', mission: m.mission, definition_file_id: fileId },
    })
    const id = d.insert_mission_model_one.id
    console.log(`created model ${id}; waiting for activity types…`)
    for (let i = 0; ; i++) {
        const t = await pd.gql(`query($id:Int!){ activity_type_aggregate(where:{model_id:{_eq:$id}}){ aggregate{ count } } }`, { id })
        if (t.activity_type_aggregate.aggregate.count > 0) return id
        if (i > 60) throw new Error('model did not finish loading (check merlin logs / SPICE mount)')
        await sleep(2000)
    }
}

async function upsertGoal(pd, g) {
    const { scheduling_goal_metadata: goals } = await pd.gql(
        `query($n:String!){ scheduling_goal_metadata(where:{name:{_eq:$n}}, order_by:{id:desc}){ id } }`,
        { n: g.name },
    )
    if (goals[0]) return goals[0].id
    const jarId = await pd.uploadFile(fs.readFileSync(g.jar), path.basename(g.jar))
    const d = await pd.gql(`mutation($g:scheduling_goal_metadata_insert_input!){ insert_scheduling_goal_metadata_one(object:$g){ id } }`, {
        g: { name: g.name, description: g.description, public: true, versions: { data: [{ type: 'JAR', uploaded_jar_id: jarId }] } },
    })
    return d.insert_scheduling_goal_metadata_one.id
}

async function upsertConstraint(pd, c) {
    const { constraint_metadata: cs } = await pd.gql(`query($n:String!){ constraint_metadata(where:{name:{_eq:$n}}, order_by:{id:desc}){ id } }`, { n: c.name })
    if (cs[0]) return cs[0].id
    const jarId = await pd.uploadFile(fs.readFileSync(c.jar), path.basename(c.jar))
    const d = await pd.gql(`mutation($c:constraint_metadata_insert_input!){ insert_constraint_metadata_one(object:$c){ id } }`, {
        c: { name: c.name, public: true, versions: { data: [{ type: 'JAR', uploaded_jar_id: jarId }] } },
    })
    return d.insert_constraint_metadata_one.id
}

async function setup(pd, key) {
    const cfg = MISSIONS[key]
    for (const f of [cfg.model.jar, cfg.goal.jar, cfg.constraint?.jar].filter(Boolean)) {
        if (!fs.existsSync(f)) throw new Error(`${f} missing — see integrations/mmgis/README.md "Build"`)
    }
    const modelId = await upsertModel(pd, cfg.model)
    const goalId = await upsertGoal(pd, cfg.goal)
    const constraintId = cfg.constraint ? await upsertConstraint(pd, cfg.constraint) : null
    console.log(`[${key}] model ${modelId}, goal ${goalId}${constraintId ? `, constraint ${constraintId}` : ''}`)

    const { plan: plans } = await pd.gql(`query($n:String!,$m:Int!){ plan(where:{name:{_eq:$n}, model_id:{_eq:$m}}){ id } }`, {
        n: cfg.plan.name,
        m: modelId,
    })
    let planId = plans[0]?.id
    if (!planId) {
        if (cfg.plan.file) {
            const planJson = JSON.parse(fs.readFileSync(cfg.plan.file, 'utf8'))
            planId = (await pd.importPlan({ name: cfg.plan.name, modelId, startTime: planJson.start_time, duration: planJson.duration, planJson })).id
        } else {
            const d = await pd.gql(`mutation($p:plan_insert_input!){ insert_plan_one(object:$p){ id } }`, {
                p: { name: cfg.plan.name, model_id: modelId, start_time: cfg.plan.startTime, duration: cfg.plan.duration },
            })
            planId = d.insert_plan_one.id
        }
        if (cfg.plan.simulationArguments) {
            await pd.gql(`mutation($p:Int!,$a:jsonb!){ update_simulation(where:{plan_id:{_eq:$p}}, _set:{arguments:$a}){ affected_rows } }`, {
                p: planId,
                a: cfg.plan.simulationArguments,
            })
        }
        if (constraintId) {
            // The candidate workflow copies this into every candidate (duplicate_plan does not).
            await pd.gql(`mutation($c:constraint_specification_insert_input!){ insert_constraint_specification_one(object:$c){ invocation_id } }`, {
                c: { plan_id: planId, constraint_id: constraintId, arguments: cfg.constraint.arguments, enabled: true },
            })
        }
        const sim = await pd.gql(`query($p:Int!){ simulate(planId:$p, force:true){ simulationDatasetId } }`, { p: planId })
        console.log(`[${key}] created base plan ${planId}; simulation requested (dataset ${sim.simulate.simulationDatasetId})`)
    }
    console.log(`[${key}] MMGIS backend env:\n  PLANDEV_${key.toUpperCase()}_BASE_PLAN_ID=${planId}\n  PLANDEV_${key.toUpperCase()}_GOAL_ID=${goalId}`)
}

async function main() {
    const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MISSIONS)
    const pd = clientFromEnv()
    for (const k of keys) {
        if (!MISSIONS[k]) throw new Error(`unknown mission ${k}; one of ${Object.keys(MISSIONS).join(', ')}`)
        await setup(pd, k)
    }
}

main().catch((e) => {
    console.error(e.message)
    process.exit(1)
})
