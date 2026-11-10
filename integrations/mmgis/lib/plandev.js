// Minimal server-side PlanDev client: gateway login + Hasura GraphQL.
// Runs only in trusted Node (the MMGIS backend plugin and the setup script). Never ship to a browser.
'use strict'

/**
 * @param {{ gatewayUrl: string, hasuraUrl: string, username: string, password: string, role?: string }} cfg
 */
function createClient(cfg) {
    let token = null
    let tokenExp = 0

    async function login() {
        const res = await fetch(`${cfg.gatewayUrl}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: cfg.username, password: cfg.password }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || !body.success || !body.token) {
            throw new Error(`PlanDev login failed for ${cfg.username}: ${body.message || res.status}`)
        }
        token = body.token
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
        tokenExp = (claims.exp || 0) * 1000
    }

    async function auth() {
        if (!token || Date.now() > tokenExp - 60_000) await login()
        return token
    }

    async function gql(query, variables = {}) {
        const res = await fetch(`${cfg.hasuraUrl}/v1/graphql`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${await auth()}`,
                // Default to the ordinary `user` role so the integration is held to normal plan permissions,
                // even when the identity is also allowed aerie_admin.
                'x-hasura-role': cfg.role || 'user',
            },
            body: JSON.stringify({ query, variables }),
        })
        const body = await res.json()
        if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '))
        return body.data
    }

    async function uploadFile(bytes, filename) {
        const form = new FormData()
        form.append('file', new Blob([bytes]), filename)
        const res = await fetch(`${cfg.gatewayUrl}/file`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${await auth()}`, 'x-hasura-role': cfg.role || 'user' },
            body: form,
        })
        if (!res.ok) throw new Error(`upload ${filename} failed: ${res.status} ${await res.text()}`)
        return (await res.json()).id
    }

    async function importPlan({ name, modelId, startTime, duration, planJson }) {
        const form = new FormData()
        form.append('name', name)
        form.append('model_id', String(modelId))
        form.append('start_time', startTime)
        form.append('duration', duration)
        form.append('tags', '[]')
        form.append('plan_file', new Blob([JSON.stringify(planJson)], { type: 'application/json' }), 'plan.json')
        const res = await fetch(`${cfg.gatewayUrl}/importPlan`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${await auth()}`, 'x-hasura-role': cfg.role || 'user' },
            body: form,
        })
        if (!res.ok) throw new Error(`importPlan failed: ${res.status} ${await res.text()}`)
        return res.json()
    }

    return { gql, uploadFile, importPlan, username: cfg.username }
}

/** Read client config from env (shared by the MMGIS backend plugin and the setup script). */
function clientFromEnv(env = process.env) {
    const need = ['PLANDEV_GATEWAY_URL', 'PLANDEV_HASURA_URL', 'PLANDEV_USERNAME', 'PLANDEV_PASSWORD']
    const missing = need.filter((k) => !env[k])
    if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`)
    return createClient({
        gatewayUrl: env.PLANDEV_GATEWAY_URL.replace(/\/$/, ''),
        hasuraUrl: env.PLANDEV_HASURA_URL.replace(/\/$/, ''),
        username: env.PLANDEV_USERNAME,
        password: env.PLANDEV_PASSWORD,
        role: env.PLANDEV_ROLE,
    })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = { createClient, clientFromEnv, sleep }
