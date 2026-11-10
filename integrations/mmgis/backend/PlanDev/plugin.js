/**
 * PlanDev backend plugin — the trusted half of the MMGIS ↔ PlanDev adapter.
 *
 * PlanDev credentials live only here (env). The browser talks to /api/plandev with its MMGIS
 * session; this plugin talks to PlanDev as a service identity with the ordinary `user` role.
 */
const express = require('express')
const { clientFromEnv } = require('../../lib/plandev')
const { createCandidates } = require('../../lib/candidates')

// Mission adapters, enabled by setting their base plan and goal ids.
const ADAPTERS = { mro: require('../../missions/mro'), hopper: require('../../missions/hopper') }

let candidates = null
function workflow() {
    if (!candidates) {
        const missions = Object.values(ADAPTERS)
            .map((adapter) => {
                const env = (k) => process.env[`PLANDEV_${adapter.key.toUpperCase()}_${k}`]
                return { adapter, basePlanId: Number(env('BASE_PLAN_ID')), goalId: Number(env('GOAL_ID')) }
            })
            .filter((m) => m.basePlanId > 0 && m.goalId > 0)
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
    router.get('/missions/:key/candidates', canPlan, send((req) => workflow().listCandidates(req.params.key)))
    router.post(
        '/missions/:key/candidates',
        canPlan,
        send((req) =>
            workflow().createCandidate(req.params.key, {
                targets: req.body.targets,
                params: req.body.params,
                label: req.body.label,
                requestedBy: `mmgis:${req.user}`,
            }),
        ),
    )

    // Any plan whose mission model has an adapter, optionally pinned to one of its simulation datasets.
    const view = (req) => workflow().view(intParam(req.params.id, 'plan id'), intParam(req.query.simulationDatasetId, 'simulationDatasetId'))
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
        { name: 'PLANDEV_MRO_GOAL_ID', required: false },
        { name: 'PLANDEV_HOPPER_BASE_PLAN_ID', required: false },
        { name: 'PLANDEV_HOPPER_GOAL_ID', required: false },
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
