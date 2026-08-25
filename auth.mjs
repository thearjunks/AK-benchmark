import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import nodemailer from 'nodemailer'

const scrypt = promisify(scryptCallback)
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const INVITE_TTL_MS = 48 * 60 * 60 * 1000
const ALL_SECTIONS = ['overview', 'history', 'findings', 'emails']

function clean(value, max = 200) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function runtimeDirectory() {
  if (process.env.BENCHMARK_DATA_DIR) return process.env.BENCHMARK_DATA_DIR
  if ((process.env.NODE_ENV === 'production' || process.env.PORT) && process.env.HOME) return path.join(process.env.HOME, '.webpulse-benchmark')
  return path.join(process.cwd(), 'work')
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

async function passwordHash(password) {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, 64)
  return `scrypt:${salt.toString('hex')}:${Buffer.from(derived).toString('hex')}`
}

async function passwordMatches(password, stored) {
  const [, saltHex, hashHex] = String(stored || '').split(':')
  if (!saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function tokenHash(token) {
  return createHash('sha256').update(String(token || '')).digest('base64url')
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character])
}

function publicUser(user) {
  if (!user) return null
  const { passwordHash: ignoredPassword, inviteTokenHash: ignoredInvite, ...safe } = user
  return safe
}

function cookieMap(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split('=').map(value => decodeURIComponent(value))).filter(pair => pair.length === 2))
}

async function bodyJson(req, limit = 50_000) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 })
  }
  try { return JSON.parse(body || '{}') } catch { throw Object.assign(new Error('Invalid JSON request.'), { status: 400 }) }
}

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

function permissionsFor(user) {
  if (user?.role === 'admin') return { sections: [...ALL_SECTIONS, 'admin'], canSendEmail: true, canDownload: true }
  return {
    sections: Array.isArray(user?.sections) ? user.sections.filter(section => ALL_SECTIONS.includes(section)) : [],
    canSendEmail: user?.canSendEmail === true,
    canDownload: user?.canDownload === true
  }
}

export function authPlugin(config = {}) {
  const authFile = path.join(runtimeDirectory(), 'benchmark-auth.json')
  const sessions = new Map()
  const failedLogins = new Map()
  const transporter = config.smtpUser && config.smtpPassword ? nodemailer.createTransport({ service: 'gmail', auth: { user: config.smtpUser, pass: config.smtpPassword } }) : null
  let store = { users: [], requests: [] }
  let ready = false

  const persist = () => writeJson(authFile, store)
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const stcEmailPattern = /^[^\s@]+@(?:stc\.com|stc\.com\.kw|stc\.com\.sa|stc\.com\.bh)$/i

  async function initialize() {
    store = await readJson(authFile, store)
    store.users = Array.isArray(store.users) ? store.users : []
    store.requests = Array.isArray(store.requests) ? store.requests : []
    const adminEmail = clean(config.adminEmail || config.smtpUser).toLowerCase()
    if (adminEmail && config.adminPassword && !store.users.some(user => user.role === 'admin')) {
      store.users.push({
        id: randomBytes(12).toString('hex'), username: clean(config.adminUsername || 'admin', 80), email: adminEmail,
        mobile: '', department: 'Administration', role: 'admin', status: 'active', sections: [...ALL_SECTIONS],
        canSendEmail: true, canDownload: true, passwordHash: await passwordHash(config.adminPassword),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      })
      await persist()
    }
    ready = true
  }

  function sessionUser(req) {
    const token = cookieMap(req.headers.cookie || '').benchmark_session
    const session = token ? sessions.get(token) : null
    if (!session || session.expiresAt < Date.now()) {
      if (token) sessions.delete(token)
      return null
    }
    return store.users.find(user => user.id === session.userId && user.status === 'active') || null
  }

  function createSession(res, user, req) {
    const token = randomBytes(32).toString('base64url')
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS })
    const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production'
    res.setHeader('Set-Cookie', `benchmark_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`)
  }

  function clearSession(req, res) {
    const token = cookieMap(req.headers.cookie || '').benchmark_session
    if (token) sessions.delete(token)
    res.setHeader('Set-Cookie', 'benchmark_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
  }

  async function sendAccessRequestNotification(request) {
    if (config.notificationsEnabled === false || !transporter || !config.adminEmail) return false
    await transporter.sendMail({
      from: `STC Benchmark Access <${config.smtpUser}>`, to: config.adminEmail,
      subject: `Access request — ${request.username}`,
      text: `A new Website Benchmark Dashboard access request is waiting for review.\n\nUsername: ${request.username}\nDepartment: ${request.department}\nMobile: ${request.mobile}\nSTC email: ${request.email}`,
      html: `<div style="font-family:Arial,sans-serif"><h2>New dashboard access request</h2><table cellpadding="7"><tr><td><b>Username</b></td><td>${escapeHtml(request.username)}</td></tr><tr><td><b>Department</b></td><td>${escapeHtml(request.department)}</td></tr><tr><td><b>Mobile</b></td><td>${escapeHtml(request.mobile)}</td></tr><tr><td><b>STC email</b></td><td>${escapeHtml(request.email)}</td></tr></table><p>Open the Admin Access dashboard to approve or reject this request.</p></div>`
    })
    return true
  }

  async function sendInvitation(user, rawToken, req) {
    if (config.notificationsEnabled === false) return false
    if (!transporter) throw new Error('Email service is not configured for invitations.')
    const proto = req.headers['x-forwarded-proto'] || (process.env.NODE_ENV === 'production' ? 'https' : 'http')
    const origin = config.publicAppUrl || `${proto}://${req.headers.host}`
    const url = `${origin.replace(/\/$/, '')}/?setup=${encodeURIComponent(rawToken)}`
    await transporter.sendMail({
      from: `STC Website Benchmark <${config.smtpUser}>`, to: user.email,
      subject: 'Website Benchmark Dashboard access approved',
      text: `Your access request was approved. Set your password within 48 hours: ${url}`,
      html: `<div style="font-family:Arial,sans-serif"><h2>Access approved</h2><p>Hello ${escapeHtml(user.username)},</p><p>Your Website Benchmark Dashboard access request was approved.</p><p><a href="${escapeHtml(url)}" style="display:inline-block;padding:11px 18px;border-radius:7px;background:#4f008c;color:#fff;text-decoration:none">Set password and sign in</a></p><p>This invitation expires in 48 hours.</p></div>`
    })
  }

  function requireAdmin(req, res) {
    const user = sessionUser(req)
    if (!user) { json(res, 401, { error: 'Sign in is required.' }); return null }
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin access is required.' }); return null }
    return user
  }

  function isAllowed(user, requestPath, method) {
    if (user.role === 'admin') return true
    const permissions = permissionsFor(user)
    if (requestPath === '/api/automation-state') return permissions.sections.length > 0
    if (requestPath.startsWith('/api/history')) return permissions.sections.includes('history') && (method !== 'GET' || !requestPath.endsWith('.xlsx') || permissions.canDownload)
    if (requestPath.startsWith('/api/email') || requestPath === '/api/history-email-report') return permissions.sections.includes('emails') && (method === 'GET' || permissions.canSendEmail)
    if (requestPath === '/api/analyze' || requestPath === '/api/automation/run') return permissions.sections.includes('overview')
    return permissions.sections.includes('overview')
  }

  const handler = async (req, res, next) => {
    const requestPath = req.url?.split('?')[0] || ''
    if (!requestPath.startsWith('/api/')) return next()
    if (!ready && requestPath !== '/api/health') return json(res, 503, { error: 'Access service is starting.' })

    try {
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method || '') && req.headers.origin) {
        const requestHost = clean(req.headers['x-forwarded-host'] || req.headers.host, 255)
        let originHost = ''
        try { originHost = new URL(req.headers.origin).host } catch { return json(res, 403, { error: 'Invalid request origin.' }) }
        if (!requestHost || originHost !== requestHost) return json(res, 403, { error: 'Cross-site requests are not allowed.' })
      }
      if (requestPath === '/api/auth/request-access' && req.method === 'POST') {
        const input = await bodyJson(req)
        const request = {
          id: randomBytes(12).toString('hex'), username: clean(input.username, 80), mobile: clean(input.mobile, 30),
          department: clean(input.department, 100), email: clean(input.email).toLowerCase(), status: 'pending',
          requestedAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null
        }
        if (!request.username || !request.department || !/^\+?[0-9 ()-]{8,20}$/.test(request.mobile) || !stcEmailPattern.test(request.email)) {
          return json(res, 400, { error: 'Enter a username, valid mobile number, department, and valid STC email ID.' })
        }
        if (store.users.some(user => user.email === request.email || user.username.toLowerCase() === request.username.toLowerCase()) || store.requests.some(item => item.status === 'pending' && (item.email === request.email || item.username.toLowerCase() === request.username.toLowerCase()))) {
          return json(res, 409, { error: 'An account or pending request already exists for this user.' })
        }
        store.requests.unshift(request)
        await persist()
        let adminNotified = false
        try { adminNotified = await sendAccessRequestNotification(request) } catch { /* request remains visible in Admin Access */ }
        return json(res, 201, { submitted: true, adminNotified })
      }

      if (requestPath === '/api/auth/login' && req.method === 'POST') {
        const ip = clean(req.headers['x-forwarded-for'] || req.socket.remoteAddress, 100)
        const attempt = failedLogins.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 }
        if (attempt.resetAt < Date.now()) { attempt.count = 0; attempt.resetAt = Date.now() + 15 * 60 * 1000 }
        if (attempt.count >= 10) return json(res, 429, { error: 'Too many sign-in attempts. Try again later.' })
        const input = await bodyJson(req)
        const identifier = clean(input.identifier, 200).toLowerCase()
        const user = store.users.find(item => item.status === 'active' && (item.email === identifier || item.username.toLowerCase() === identifier))
        if (!user || !(await passwordMatches(String(input.password || ''), user.passwordHash))) {
          attempt.count += 1; failedLogins.set(ip, attempt)
          return json(res, 401, { error: 'Invalid username/email or password.' })
        }
        failedLogins.delete(ip)
        createSession(res, user, req)
        return json(res, 200, { user: publicUser(user), permissions: permissionsFor(user) })
      }

      if (requestPath === '/api/auth/setup-password' && req.method === 'POST') {
        const input = await bodyJson(req)
        const rawToken = String(input.token || '')
        const user = store.users.find(item => item.inviteTokenHash === tokenHash(rawToken) && item.inviteExpiresAt && new Date(item.inviteExpiresAt).getTime() > Date.now())
        if (!user) return json(res, 400, { error: 'This invitation is invalid or has expired.' })
        if (String(input.password || '').length < 10) return json(res, 400, { error: 'Use a password with at least 10 characters.' })
        user.passwordHash = await passwordHash(String(input.password))
        user.status = 'active'; user.inviteTokenHash = null; user.inviteExpiresAt = null; user.updatedAt = new Date().toISOString()
        await persist()
        createSession(res, user, req)
        return json(res, 200, { user: publicUser(user), permissions: permissionsFor(user) })
      }

      if (requestPath === '/api/auth/me' && req.method === 'GET') {
        const user = sessionUser(req)
        return user ? json(res, 200, { user: publicUser(user), permissions: permissionsFor(user) }) : json(res, 401, { error: 'Sign in is required.' })
      }
      if (requestPath === '/api/auth/logout' && req.method === 'POST') {
        clearSession(req, res)
        return json(res, 200, { signedOut: true })
      }

      if (requestPath === '/api/admin/access' && req.method === 'GET') {
        if (!requireAdmin(req, res)) return
        return json(res, 200, { requests: store.requests, users: store.users.map(publicUser) })
      }
      const decisionMatch = requestPath.match(/^\/api\/admin\/access-requests\/([^/]+)$/)
      if (decisionMatch && req.method === 'POST') {
        const admin = requireAdmin(req, res); if (!admin) return
        const input = await bodyJson(req)
        const request = store.requests.find(item => item.id === decisionMatch[1])
        if (!request || request.status !== 'pending') return json(res, 404, { error: 'Pending access request not found.' })
        if (!['approve', 'reject'].includes(input.decision)) return json(res, 400, { error: 'Choose approve or reject.' })
        request.status = input.decision === 'approve' ? 'approved' : 'rejected'
        request.reviewedAt = new Date().toISOString(); request.reviewedBy = admin.id
        let invitationSent = false
        if (input.decision === 'approve') {
          const rawToken = randomBytes(32).toString('base64url')
          const user = {
            id: randomBytes(12).toString('hex'), username: request.username, email: request.email, mobile: request.mobile,
            department: request.department, role: input.role === 'admin' ? 'admin' : 'user', status: 'invited',
            sections: Array.isArray(input.sections) ? input.sections.filter(section => ALL_SECTIONS.includes(section)) : ['overview'],
            canSendEmail: input.canSendEmail === true, canDownload: input.canDownload === true,
            passwordHash: null, inviteTokenHash: tokenHash(rawToken), inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
          }
          if (user.role === 'admin') { user.sections = [...ALL_SECTIONS]; user.canSendEmail = true; user.canDownload = true }
          store.users.push(user)
          await persist()
          try { invitationSent = await sendInvitation(user, rawToken, req) !== false } catch { /* Admin can resend after SMTP recovery */ }
        } else await persist()
        return json(res, 200, { request, invitationSent })
      }
      const userMatch = requestPath.match(/^\/api\/admin\/users\/([^/]+)$/)
      if (userMatch && req.method === 'PATCH') {
        const admin = requireAdmin(req, res); if (!admin) return
        const input = await bodyJson(req)
        const user = store.users.find(item => item.id === userMatch[1])
        if (!user) return json(res, 404, { error: 'User not found.' })
        if (user.id === admin.id && input.role && input.role !== 'admin') return json(res, 400, { error: 'You cannot remove your own Admin role.' })
        if (user.id === admin.id && input.status && input.status !== 'active') return json(res, 400, { error: 'You cannot disable your own admin account.' })
        const removesAdmin = user.role === 'admin' && (input.role === 'user' || (input.status && input.status !== 'active'))
        const activeAdmins = store.users.filter(item => item.role === 'admin' && item.status === 'active')
        if (removesAdmin && activeAdmins.length <= 1) return json(res, 400, { error: 'At least one active Admin account is required.' })
        user.role = input.role === 'admin' ? 'admin' : 'user'
        user.status = ['active', 'disabled', 'invited'].includes(input.status) ? input.status : user.status
        user.sections = user.role === 'admin' ? [...ALL_SECTIONS] : Array.isArray(input.sections) ? input.sections.filter(section => ALL_SECTIONS.includes(section)) : user.sections
        user.canSendEmail = user.role === 'admin' || input.canSendEmail === true
        user.canDownload = user.role === 'admin' || input.canDownload === true
        user.updatedAt = new Date().toISOString()
        await persist()
        return json(res, 200, { user: publicUser(user) })
      }
      if (userMatch && req.method === 'POST') {
        if (!requireAdmin(req, res)) return
        const user = store.users.find(item => item.id === userMatch[1])
        if (!user || user.status !== 'invited') return json(res, 404, { error: 'Invited user not found.' })
        const rawToken = randomBytes(32).toString('base64url')
        user.inviteTokenHash = tokenHash(rawToken)
        user.inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString()
        user.updatedAt = new Date().toISOString()
        await persist()
        let invitationSent = false
        try { invitationSent = await sendInvitation(user, rawToken, req) !== false } catch { /* invitation stays available for another resend */ }
        return json(res, invitationSent ? 200 : 503, { invitationSent, error: invitationSent ? undefined : 'Invitation saved, but email delivery failed.' })
      }

      if (requestPath.startsWith('/api/admin/')) return json(res, 404, { error: 'Admin endpoint not found.' })
      if (requestPath === '/api/health') return next()
      const user = sessionUser(req)
      if (!user) return json(res, 401, { error: 'Sign in is required.' })
      if (!isAllowed(user, requestPath, req.method)) return json(res, 403, { error: 'You do not have permission to use this feature.' })
      req.benchmarkUser = user
      req.benchmarkPermissions = permissionsFor(user)
      return next()
    } catch (error) {
      return json(res, error.status || 500, { error: clean(error.message) || 'Access service failed.' })
    }
  }

  const configure = server => {
    server.middlewares.use(handler)
    initialize().catch(() => { ready = false })
    server.httpServer?.once('close', () => sessions.clear())
  }

  return { name: 'benchmark-auth-rbac', enforce: 'pre', configureServer: configure, configurePreviewServer: configure }
}
