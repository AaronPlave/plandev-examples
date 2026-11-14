#!/usr/bin/env node
// One-time MMGIS setup for the PlanDev demo: create the first SuperAdmin (if none) and the
// Mars-PlanDev, Moon-PlanDev and Jezero-PlanDev missions (basemap + Draw + PlanDev tools). Uses MMGIS's own HTTP APIs.
//
//   MMGIS_URL=http://localhost:8888 MMGIS_ADMIN=admin MMGIS_ADMIN_PASSWORD='...' MMGIS_SETUP_CODE=... \
//     node scripts/setup-mmgis.js
'use strict'
const path = require('path')

const URL_ = (process.env.MMGIS_URL || 'http://localhost:8888').replace(/\/$/, '')
const MISSIONS = ['Mars-PlanDev', 'Moon-PlanDev', 'Jezero-PlanDev']
const user = process.env.MMGIS_ADMIN || 'admin'
const pass = process.env.MMGIS_ADMIN_PASSWORD
let cookie = ''

async function post(p, body) {
    const res = await fetch(URL_ + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
    })
    const set = res.headers.getSetCookie?.() || []
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ')
    return res.json().catch(() => ({ status: `http ${res.status}` }))
}

;(async () => {
    if (!pass) throw new Error('MMGIS_ADMIN_PASSWORD is required')
    const has = await post('/api/users/has', {})
    if (has.status === 'success' && has.has === false) {
        const r = await post('/api/users/first_signup', { username: user, password: pass, setup_code: process.env.MMGIS_SETUP_CODE })
        console.log('first_signup:', r.status, r.message || '')
    }
    const login = await post('/api/users/login', { username: user, password: pass })
    if (login.status !== 'success') throw new Error(`login failed: ${login.message}`)
    for (const MISSION of MISSIONS) await addMission(MISSION, require(path.join(__dirname, `../mission/${MISSION}.config.json`)))
    console.log(`\nOpen ${URL_.replace(/:8888$/, ':8889')}/?mission=${MISSIONS[0]}`)
})().catch((e) => {
    console.error(e.message)
    process.exit(1)
})

async function addMission(MISSION, config) {
    const r = await post('/api/configure/add', { mission: MISSION, config, makedir: true })
    console.log(`add ${MISSION}:`, r.status, r.message || '')
    if (r.status !== 'success') {
        // Already exists: overlay our sections onto the current config and upsert it.
        const res = await fetch(`${URL_}/api/configure/get?mission=${MISSION}&full=true`, { headers: { cookie } })
        const current = await res.json()
        const cur = current.config || current
        const next = { ...cur, ...config, msv: { ...cur.msv, ...config.msv }, look: { ...cur.look, ...config.look } }
        next.tools = [...cur.tools.filter((t) => !config.tools.some((m) => m.name === t.name)), ...config.tools]
        const u = await post('/api/configure/upsert', { mission: MISSION, config: next })
        console.log(`upsert ${MISSION}:`, u.status, u.message || '')
    }
}
