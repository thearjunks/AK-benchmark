import assert from 'node:assert/strict'
import { access, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const port = 56502
const base = `http://127.0.0.1:${port}`
const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'benchmark-auth-test-'))
const adminPassword = 'AdminTest-2026!'
const userPassword = 'UserStart-2026!'
const resetPassword = 'UserReset-2026!'
const allPassword = 'AllReset-2026!'
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    BENCHMARK_DATA_DIR: runtimeDir,
    ADMIN_EMAIL: 'admin@stc.com.kw',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: adminPassword,
    ACCESS_EMAIL_NOTIFICATIONS: 'false',
    SMTP_USER: '',
    SMTP_APP_PASSWORD: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let output = ''
child.stdout.on('data', chunk => { output += chunk })
child.stderr.on('data', chunk => { output += chunk })

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return response.json()
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Test server did not become ready.\n${output}`)
}

async function request(pathname, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  })
  const payload = await response.json().catch(() => ({}))
  return { response, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' }
}

try {
  await waitForHealth()

  const adminLogin = await request('/api/auth/login', { method: 'POST', body: { identifier: 'admin', password: adminPassword } })
  assert.equal(adminLogin.response.status, 200)
  assert.ok(adminLogin.cookie)

  const invalid = await request('/api/auth/request-access', {
    method: 'POST',
    body: { username: 'UpperCase', mobile: '50000000', department: 'Digital', email: 'upper@stc.com.kw', password: userPassword, confirmPassword: userPassword }
  })
  assert.equal(invalid.response.status, 400)
  assert.match(invalid.payload.error, /lowercase letters only/i)

  const submitted = await request('/api/auth/request-access', {
    method: 'POST',
    body: { username: 'testuser', mobile: '50000000', department: 'Digital', email: 'testuser@stc.com.kw', password: userPassword, confirmPassword: userPassword }
  })
  assert.equal(submitted.response.status, 201)

  const accessList = await request('/api/admin/access', { cookie: adminLogin.cookie })
  assert.equal(accessList.response.status, 200)
  const pending = accessList.payload.requests.find(item => item.username === 'testuser')
  assert.ok(pending)
  assert.equal(Object.hasOwn(pending, 'passwordHash'), false)

  const approved = await request(`/api/admin/access-requests/${pending.id}/decision`, {
    method: 'POST', cookie: adminLogin.cookie,
    body: { decision: 'approve', role: 'user', sections: ['overview', 'history', 'ppt'], canSendEmail: false, canDownload: true }
  })
  assert.equal(approved.response.status, 200)
  assert.equal(approved.payload.activated, true)

  const userLogin = await request('/api/auth/login', { method: 'POST', body: { identifier: 'testuser', password: userPassword } })
  assert.equal(userLogin.response.status, 200)
  const forbidden = await request('/api/admin/access', { cookie: userLogin.cookie })
  assert.equal(forbidden.response.status, 403)

  const users = (await request('/api/admin/access', { cookie: adminLogin.cookie })).payload.users
  const testUser = users.find(item => item.username === 'testuser')
  const singleReset = await request('/api/admin/password-reset', {
    method: 'POST', cookie: adminLogin.cookie,
    body: { scope: 'user', userId: testUser.id, password: resetPassword, confirmPassword: resetPassword }
  })
  assert.equal(singleReset.response.status, 200)
  assert.equal(singleReset.payload.users, 1)
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { identifier: 'testuser', password: resetPassword } })).response.status, 200)

  const resetAll = await request('/api/admin/password-reset', {
    method: 'POST', cookie: adminLogin.cookie,
    body: { scope: 'all', password: allPassword, confirmPassword: allPassword }
  })
  assert.equal(resetAll.response.status, 200)
  assert.equal(resetAll.payload.users, 2)
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { identifier: 'testuser', password: allPassword } })).response.status, 200)

  const deleted = await request(`/api/admin/users/${testUser.id}`, { method: 'DELETE', cookie: adminLogin.cookie })
  assert.equal(deleted.response.status, 200)
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { identifier: 'testuser', password: allPassword } })).response.status, 401)

  const history = await request('/api/history', { cookie: adminLogin.cookie })
  assert.equal(history.response.status, 200)
  assert.ok(history.payload.history.length >= 864)
  await access(path.join(runtimeDir, 'website-benchmark-score-history.xlsx'))

  console.log(`Auth validation passed: request, approval, RBAC, single/all reset, deletion, ${history.payload.history.length} history records.`)
} finally {
  child.kill('SIGTERM')
}
