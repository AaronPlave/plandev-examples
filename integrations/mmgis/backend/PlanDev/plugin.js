/**
 * PlanDev backend plugin — the trusted half of the MMGIS ↔ PlanDev adapter.
 *
 * PlanDev credentials live only here (env). The browser talks to /api/plandev with its MMGIS
 * session; this plugin talks to PlanDev as a service identity with the ordinary `user` role.
 */
const express = require('express')
const { clientFromEnv } = require('../../lib/plandev')
const { createWorkflow } = require('../../lib/workflow')

const MODES = ['LOW_RES', 'MED_RES', 'HI_RES']
let wf = null

function workflow() {
    if (!wf) {
        wf = createWorkflow(clientFromEnv(), {
            basePlanId: Number(process.env.PLANDEV_BASE_PLAN_ID),
            goalId: Number(process.env.PLANDEV_GOAL_ID),
        })
    }
    return wf
}

const send = (fn) => async (req, res) => {
    try {
        res.send({ status: 'success', body: await fn(req) })
    } catch (e) {
        res.send({ status: 'failure', message: e.message })
    }
}

function makeRouter(s) {
    const router = express.Router()
    const canPlan = s.authorize('draw.use') // signed-in MMGIS users; core has no finer "plan" capability

    router.get(
        '/config',
        canPlan,
        send(async () => {
            const w = workflow()
            const base = await w.plan(w.basePlanId)
            return {
                basePlan: { id: base.id, name: base.name, startTime: base.start_time, duration: base.duration },
                goalId: w.goalId,
                modes: MODES,
                plandevUiUrl: process.env.PLANDEV_UI_URL || null,
                conventions: {
                    body: 'MARS (IAU_MARS body-fixed)',
                    coordinates: 'planetocentric latitude, east-positive longitude, degrees',
                    time: 'UTC ISO-8601',
                },
            }
        }),
    )

    router.get('/candidates', canPlan, send(() => workflow().listCandidates()))

    router.post(
        '/candidates',
        canPlan,
        send(async (req) => {
            const p = req.body.params || {}
            const params = {
                maxGroundDistanceKm: Number(p.maxGroundDistanceKm),
                observationDurationSec: Number(p.observationDurationSec),
                mode: p.mode,
            }
            if (!(params.maxGroundDistanceKm > 0 && params.maxGroundDistanceKm <= 2000)) throw new Error('maxGroundDistanceKm must be in (0, 2000]')
            if (!(params.observationDurationSec >= 10 && params.observationDurationSec <= 3600)) throw new Error('observationDurationSec must be in [10, 3600]')
            if (!MODES.includes(params.mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`)
            return workflow().createCandidate({
                targets: req.body.targets,
                params,
                label: req.body.label,
                requestedBy: `mmgis:${req.user}`,
            })
        }),
    )

    router.get('/candidates/:id', canPlan, send((req) => workflow().getCandidate(Number(req.params.id))))

    // Plain GeoJSON (no envelope) so it can back an MMGIS vector layer's `url` directly.
    router.get('/candidates/:id/geojson', canPlan, async (req, res) => {
        try {
            res.json((await workflow().getCandidate(Number(req.params.id))).geojson)
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
        { name: 'PLANDEV_BASE_PLAN_ID', required: true },
        { name: 'PLANDEV_GOAL_ID', required: true },
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
