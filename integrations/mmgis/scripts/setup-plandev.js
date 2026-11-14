#!/usr/bin/env node
// One-time PlanDev setup for the MMGIS prototype, per mission: upload the mission model, its
// scheduling goals and constraints, create or import its plans, and schedule/simulate them.
// Idempotent by name. UPDATE_GOALS=1 uploads the goal jars again as new goal versions.
//
//   PLANDEV_ROLE=aerie_admin PLANDEV_GATEWAY_URL=http://localhost:9000 PLANDEV_HASURA_URL=http://localhost:8080 \
//   PLANDEV_USERNAME=mmgis-planner PLANDEV_PASSWORD=... node scripts/setup-plandev.js [mro|hopper|rover ...]
'use strict'
const fs = require('fs')
const path = require('path')
const { clientFromEnv, sleep } = require('../lib/plandev')
const { createCandidates } = require('../lib/candidates')

const EX = path.resolve(__dirname, '../../../examples')
// Illustrative small-hopper sizing, as plain model configuration: the model defaults' 5 m² array
// out-produces the 1000 W hop load (power would never constrain a traverse), and the default 10 kbit/s
// playback rate would make a Downlink pass irrelevant.
const HOPPER_PLAN = {
    startTime: '2025-01-01T00:00:00Z',
    duration: '48:00:00',
    simulationArguments: {
        initialDataRate: 2e6, // bit/s during a Downlink pass
        powerConfig: {
            batteryConfig: { batteryCapacity: 10.0, busVoltage: 28.0, initialSOC: 100.0 },
            powerSourceConfig: { deploymentState: 'DEPLOYED', arrayMechArea: 2.0, packingFactor: 0.9, cellEfficiency: 0.28, conversionEfficiency: 0.9, otherLosses: 1.0 },
        },
    },
}

const MISSIONS = {
    mro: {
        model: { name: 'orbiter-mmgis', mission: 'MRO', jar: `${EX}/05-orbiter/build/libs/orbiter-example.jar` },
        goals: [
            {
                name: 'ScheduleTargetObservations',
                jar: `${EX}/05-orbiter/scheduling/build/libs/ScheduleTargetObservations.jar`,
                description: 'MRO closest sub-spacecraft pass per GeoJSON target → TakeRadarObservation (not footprint coverage).',
            },
        ],
        plans: [{ name: 'MRO base plan (MMGIS demo)', file: `${EX}/05-orbiter/demo/plans/SimplePlan.json` }],
    },
    hopper: {
        model: { name: 'hopper-mmgis', mission: 'Hopper', jar: `${EX}/04-hopper/build/libs/hopper.jar` },
        goals: [
            {
                name: 'ScheduleHopTraverse',
                jar: `${EX}/04-hopper/scheduling/build/libs/ScheduleHopTraverse.jar`,
                description: 'Lunar hopper: hop to each GeoJSON site and image it (illustrative hop timing, see HopModel).',
            },
            {
                name: 'ScheduleStorageDownlinks',
                jar: `${EX}/04-hopper/scheduling/build/libs/ScheduleStorageDownlinks.jar`,
                description: 'Lunar hopper: add Downlink passes in free contact windows (illustrative schedule) to keep simulated onboard storage below a limit.',
            },
        ],
        constraints: [
            { name: 'MinBatterySOC (hopper)', jar: `${EX}/04-hopper/constraints/build/libs/MinBatterySOC.jar`, arguments: { minSOC: 80 } },
            { name: 'OnboardStorageFull (hopper)', jar: `${EX}/04-hopper/constraints/build/libs/OnboardStorageFull.jar`, arguments: { fractionFull: 0.99 } },
        ],
        plans: [
            { name: 'Hopper base plan (MMGIS demo)', ...HOPPER_PLAN },
            {
                // An "existing" plan as a PlanDev user would build it, without MMGIS: ops activities placed by
                // hand, plus two goals in the scheduling spec, in order: the traverse (sites typed in as
                // GeoJSON), then storage downlinks, which simulate the traverse's output.
                name: 'Reiner Gamma ops (traverse + downlinks)',
                ...HOPPER_PLAN,
                activities: [
                    { name: 'Camera calibration', type: 'TakePicture', start_offset: '00:20:00', arguments: { durationSeconds: 60, dataRateBps: 2e7, siteId: '' } },
                    { name: 'DSN pass 1', type: 'Downlink', start_offset: '06:00:00', arguments: { duration: 3600e6 } },
                    { name: 'DSN pass 2', type: 'Downlink', start_offset: '30:00:00', arguments: { duration: 3600e6 } },
                ],
                goals: [
                    {
                        name: 'ScheduleHopTraverse',
                        arguments: {
                            sites: JSON.stringify({
                                type: 'FeatureCollection',
                                features: [
                                    ['west-swirl', 'West swirl', -59.35, 7.45],
                                    ['dark-lane', 'Dark lane', -59.3, 7.2],
                                    ['reiner-rim', 'Reiner rim', -58.85, 7.1],
                                ].map(([id, name, lon, lat]) => ({ type: 'Feature', id, properties: { id, name }, geometry: { type: 'Point', coordinates: [lon, lat] } })),
                            }),
                            order: 'AS_DRAWN',
                            startAfter: 3600e6,
                            restAfterHop: 1800e6,
                            pictureDuration: 120e6,
                        },
                    },
                    { name: 'ScheduleStorageDownlinks', arguments: { maxFraction: 0.9 } },
                ],
            },
        ],
    },
}

// Built the way a PlanDev user would, with nothing from MMGIS: the traverse goal in the scheduling
// specification with the mission's own site catalog (sites left blank), and a hand-placed relay pass.
const roverPlan = (name, objective, startTime = '2027-02-01T00:00:00Z') => ({
    name,
    startTime,
    duration: '96:00:00',
    activities: [{ name: 'Relay pass', type: 'Downlink', start_offset: '36:00:00', arguments: { duration: 900e6 } }],
    goals: [{ name: 'ScheduleTraverse', arguments: { objective } }],
})
MISSIONS.rover = {
    model: { name: 'rover-mmgis', mission: 'Rover', jar: `${EX}/11-rover/build/libs/rover.jar` },
    goals: [
        {
            name: 'ScheduleTraverse',
            jar: `${EX}/11-rover/scheduling/build/libs/ScheduleTraverse.jar`,
            description: 'Rover: route a traverse of science sites over the mission terrain grid (slope from the USGS Jezero CTX DTM) and create its Drive and Observe activities. Drive speed and energy are illustrative (see DriveModel).',
        },
    ],
    // The battery and storage constraints are the hopper's jars: they name only resources both models have.
    constraints: [
        { name: 'MinBatterySOC (rover)', jar: `${EX}/04-hopper/constraints/build/libs/MinBatterySOC.jar`, arguments: { minSOC: 25 } },
        { name: 'OnboardStorageFull (rover)', jar: `${EX}/04-hopper/constraints/build/libs/OnboardStorageFull.jar`, arguments: { fractionFull: 0.99 } },
        { name: 'DriveSlopeLimit (rover)', jar: `${EX}/11-rover/constraints/build/libs/DriveSlopeLimit.jar`, arguments: { maxSlopeDeg: 15 } },
    ],
    plans: [
        roverPlan('Jezero traverse (least energy)', 'MIN_ENERGY'),
        roverPlan('Jezero traverse (shortest distance)', 'MIN_DISTANCE'),
        // Same days as the MRO base plan, so the two plans' vehicles can be shown on one map and time cursor.
        roverPlan('Jezero traverse (alongside the MRO plan)', 'MIN_ENERGY', '2024-01-02T00:00:00Z'),
    ],
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
    const jarId = !goals[0] || process.env.UPDATE_GOALS ? await pd.uploadFile(fs.readFileSync(g.jar), path.basename(g.jar)) : null
    if (goals[0]) {
        if (jarId) await pd.gql(`mutation($d:scheduling_goal_definition_insert_input!){ insert_scheduling_goal_definition_one(object:$d){ revision } }`, { d: { goal_id: goals[0].id, type: 'JAR', uploaded_jar_id: jarId } })
        return goals[0].id
    }
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
    const constraints = cfg.constraints || []
    for (const f of [cfg.model.jar, ...cfg.goals.map((g) => g.jar), ...constraints.map((c) => c.jar)]) {
        if (!fs.existsSync(f)) throw new Error(`${f} missing — see integrations/mmgis/README.md "Build"`)
    }
    const modelId = await upsertModel(pd, cfg.model)
    const goalIds = {}
    for (const g of cfg.goals) goalIds[g.name] = await upsertGoal(pd, g)
    for (const c of constraints) c.id = await upsertConstraint(pd, c)
    console.log(`[${key}] model ${modelId}, goals ${JSON.stringify(goalIds)}${constraints.length ? `, constraints ${constraints.map((c) => c.id)}` : ''}`)

    const ids = []
    for (const p of cfg.plans) ids.push(await upsertPlan(pd, key, modelId, goalIds, constraints, p))
    console.log(`[${key}] MMGIS backend env:\n  PLANDEV_${key.toUpperCase()}_BASE_PLAN_ID=${ids[0]}`)
}

async function upsertPlan(pd, key, modelId, goalIds, constraints, cfg) {
    const { plan: plans } = await pd.gql(`query($n:String!,$m:Int!){ plan(where:{name:{_eq:$n}, model_id:{_eq:$m}}){ id } }`, { n: cfg.name, m: modelId })
    if (plans[0]) return plans[0].id
    let planId
    if (cfg.file) {
        const planJson = JSON.parse(fs.readFileSync(cfg.file, 'utf8'))
        planId = (await pd.importPlan({ name: cfg.name, modelId, startTime: planJson.start_time, duration: planJson.duration, planJson })).id
    } else {
        const d = await pd.gql(`mutation($p:plan_insert_input!){ insert_plan_one(object:$p){ id } }`, {
            p: { name: cfg.name, model_id: modelId, start_time: cfg.startTime, duration: cfg.duration },
        })
        planId = d.insert_plan_one.id
    }
    if (cfg.simulationArguments)
        await pd.gql(`mutation($p:Int!,$a:jsonb!){ update_simulation(where:{plan_id:{_eq:$p}}, _set:{arguments:$a}){ affected_rows } }`, { p: planId, a: cfg.simulationArguments })
    if (constraints.length)
        await pd.gql(`mutation($o:[constraint_specification_insert_input!]!){ insert_constraint_specification(objects:$o){ affected_rows } }`, {
            o: constraints.map((c) => ({ plan_id: planId, constraint_id: c.id, arguments: c.arguments, enabled: true })),
        })
    if (cfg.activities?.length)
        await pd.gql(`mutation($o:[activity_directive_insert_input!]!){ insert_activity_directive(objects:$o){ affected_rows } }`, {
            o: cfg.activities.map((a) => ({ ...a, plan_id: planId })),
        })
    if (cfg.goals?.length) {
        const spec = (await pd.gql(`query($p:Int!){ plan_by_pk(id:$p){ scheduling_specification{ id } } }`, { p: planId })).plan_by_pk.scheduling_specification
        // In list order: each goal is simulated after (simulate_after defaults to true), so later goals see earlier output.
        for (const g of cfg.goals)
            await pd.gql(`mutation($g:scheduling_specification_goals_insert_input!){ insert_scheduling_specification_goals_one(object:$g){ goal_invocation_id } }`, {
                g: { specification_id: spec.id, goal_id: goalIds[g.name], arguments: g.arguments, enabled: true },
            })
        console.log(`[${key}] created plan ${planId}; scheduling and simulating…`)
        await createCandidates(pd, []).scheduleAndSimulate(planId)
    } else {
        const sim = await pd.gql(`query($p:Int!){ simulate(planId:$p, force:true){ simulationDatasetId } }`, { p: planId })
        console.log(`[${key}] created plan ${planId}; simulation requested (dataset ${sim.simulate.simulationDatasetId})`)
    }
    return planId
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
