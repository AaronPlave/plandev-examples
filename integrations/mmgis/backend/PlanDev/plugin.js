/**
 * PlanDev backend plugin — the trusted half of the MMGIS ↔ PlanDev adapter.
 *
 * PlanDev credentials live only here (env). The browser talks to /api/plandev with its MMGIS
 * session; this plugin talks to PlanDev as a service identity with the ordinary `user` role.
 */
const express = require('express')
const { clientFromEnv } = require('../../lib/plandev')
const { createCandidates } = require('../../lib/candidates')

// Mission adapters, enabled by setting a plan of their mission model (the default plan). Their goals are
// found in PlanDev by name (adapter.goals).
const ADAPTERS = { mro: require('../../missions/mro'), hopper: require('../../missions/hopper'), rover: require('../../missions/rover') }

let candidates = null
function workflow() {
    if (!candidates) {
        const missions = Object.values(ADAPTERS)
            .map((adapter) => {
                const env = (k) => process.env[`PLANDEV_${adapter.key.toUpperCase()}_${k}`]
                return { adapter, basePlanId: Number(env('BASE_PLAN_ID')) }
            })
            .filter((m) => m.basePlanId > 0)
        candidates = createCandidates(clientFromEnv(), missions)
    }
    return candidates
}

const send = (fn) => async (req, res) => {
    try {
        res.send({ status: 'success', body: await fn(req) })
    } catch (e) {
        res.send({ status: 'failure', message: e.message })
    }
}

const intParam = (v, name) => {
    if (v == null || v === '') return null
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`)
    return n
}

function makeRouter(s) {
    const router = express.Router()
    const canPlan = s.authorize('draw.use') // signed-in MMGIS users; core has no finer "plan" capability

    router.get(
        '/config',
        canPlan,
        send(async () => ({
            missions: workflow().missions.map((m) => m.adapter.key),
            plandevUiUrl: process.env.PLANDEV_UI_URL || null,
        })),
    )
    router.get('/missions/:key/config', canPlan, send((req) => workflow().config(req.params.key)))
    // Every plan of the mission's model (with parent_id lineage): any of them can be inspected, evaluated or revised.
    router.get('/missions/:key/plans', canPlan, send((req) => workflow().plans(req.params.key)))
    // A data product of the mission (the rover's terrain grid), for the map to draw.
    router.get('/missions/:key/data/:name', canPlan, send((req) => workflow().data(req.params.key, req.params.name)))

    // Working branches. expectedRevision is the revision the user was looking at: a plan that changed
    // since is refused rather than changed from stale context.
    const inputs = (req) => ({
        mission: req.body.mission,
        targets: req.body.targets,
        params: req.body.params,
        label: req.body.label,
        expectedRevision: intParam(req.body.expectedRevision, 'expectedRevision'),
        requestedBy: `mmgis:${req.user}`,
    })
    // Explore an alternative: branch plan :id (never changed) into a new working branch and run it.
    router.post('/plans/:id/explore', canPlan, send((req) => workflow().explore(intParam(req.params.id, 'plan id'), inputs(req))))
    // Update the exploration: re-run working branch :id with new inputs (refused for any other plan).
    router.post('/plans/:id/update', canPlan, send((req) => workflow().update(intParam(req.params.id, 'plan id'), inputs(req))))
    // Keep as plan: :id stops being a working branch; it stays an ordinary PlanDev plan.
    router.post('/plans/:id/keep', canPlan, send((req) => workflow().keep(intParam(req.params.id, 'plan id'))))
    // Read-only evaluation of spatial inputs against a plan's simulation. Creates nothing in PlanDev.
    router.post(
        '/plans/:id/evaluate',
        canPlan,
        send((req) =>
            workflow().evaluate(intParam(req.params.id, 'plan id'), intParam(req.body.simulationDatasetId, 'simulationDatasetId'), {
                mission: req.body.mission,
                targets: req.body.targets,
                params: req.body.params,
            }),
        ),
    )

    // Any plan whose mission model has an adapter, optionally pinned to one of its simulation datasets.
    const view = (req) =>
        workflow().view(intParam(req.params.id, 'plan id'), intParam(req.query.simulationDatasetId, 'simulationDatasetId'), req.query.mission || null)
    router.get('/plans/:id', canPlan, send(view))
    // Plain GeoJSON (no envelope) so it can back an MMGIS vector layer's `url` directly.
    router.get('/plans/:id/geojson', canPlan, async (req, res) => {
        try {
            res.json({ type: 'FeatureCollection', features: (await view(req)).features })
        } catch (e) {
            res.status(404).json({ type: 'FeatureCollection', features: [], error: e.message })
        }
    })

    return router
}

module.exports = {
    envs: [
        { name: 'PLANDEV_GATEWAY_URL', required: true },
        { name: 'PLANDEV_HASURA_URL', required: true },
        { name: 'PLANDEV_USERNAME', required: true },
        { name: 'PLANDEV_PASSWORD', required: true, private: true },
        { name: 'PLANDEV_MRO_BASE_PLAN_ID', required: false },
        { name: 'PLANDEV_HOPPER_BASE_PLAN_ID', required: false },
        { name: 'PLANDEV_ROVER_BASE_PLAN_ID', required: false },
        { name: 'PLANDEV_ROVER_DATA_DIR', required: false },
        { name: 'PLANDEV_UI_URL', required: false },
    ],
    onceInit: (s) => {
        s.app.use(
            s.ROOT_PATH + '/api/plandev',
            s.ensureUser({ forbid: true }),
            s.checkHeadersCodeInjection,
            s.setContentType,
            express.json({ limit: '1mb' }),
            s.registerRouter('/api/plandev', makeRouter(s)),
        )
    },
}
