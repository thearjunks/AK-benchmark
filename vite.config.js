import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import nodemailer from 'nodemailer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo']
const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 }
const STANDARD_URLS = [
  'https://www.stc.com.sa/en/personal/home.html',
  'https://www.stc.com.bh/',
  'https://www.virgin.com/',
  'https://www.ooredoo.com.kw/en',
  'https://www.stc.com.kw/en',
  'https://www.kw.zain.com/en/shop'
]
const DEVICE_METRICS = ['performance', 'accessibility', 'bestPractices', 'seo']

function cleanText(value = '') {
  return value
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character])
}

function score(category) {
  const value = category?.score
  return typeof value === 'number' ? Math.round(value * 100) : null
}

function coreWebVitalsScore(result) {
  const fieldMetrics = result.loadingExperience?.metrics || result.originLoadingExperience?.metrics || {}
  const fieldKeys = ['LARGEST_CONTENTFUL_PAINT_MS', 'CUMULATIVE_LAYOUT_SHIFT_SCORE', 'INTERACTION_TO_NEXT_PAINT']
  const fieldValues = fieldKeys
    .map(key => fieldMetrics[key]?.category)
    .filter(Boolean)
    .map(category => category === 'FAST' ? 100 : category === 'AVERAGE' ? 50 : 0)

  if (fieldValues.length >= 2) {
    return { score: Math.round(fieldValues.reduce((sum, value) => sum + value, 0) / fieldValues.length), source: 'CrUX field data' }
  }

  const audits = result.lighthouseResult?.audits || {}
  const labValues = ['largest-contentful-paint', 'cumulative-layout-shift', 'total-blocking-time']
    .map(key => audits[key]?.score)
    .filter(value => typeof value === 'number')

  return {
    score: labValues.length ? Math.round(labValues.reduce((sum, value) => sum + value, 0) / labValues.length * 100) : null,
    source: 'Lighthouse lab data'
  }
}

function extractIssues(result, domain, device) {
  const lighthouse = result.lighthouseResult || {}
  const audits = lighthouse.audits || {}
  const categories = lighthouse.categories || {}
  const auditCategories = new Map()

  for (const [categoryId, category] of Object.entries(categories)) {
    const label = categoryId === 'best-practices' ? 'Best practices' : categoryId === 'seo' ? 'SEO' : categoryId[0].toUpperCase() + categoryId.slice(1)
    for (const ref of category.auditRefs || []) {
      if (!auditCategories.has(ref.id) || ref.weight > 0) auditCategories.set(ref.id, label)
    }
  }

  return [...auditCategories.entries()]
    .map(([id, category]) => {
      const audit = audits[id]
      if (!audit || typeof audit.score !== 'number' || audit.score >= 0.9 || ['manual', 'notApplicable', 'informative'].includes(audit.scoreDisplayMode)) return null
      const severity = audit.score <= 0.25 ? 'Critical' : audit.score <= 0.5 ? 'High' : audit.score <= 0.75 ? 'Medium' : 'Low'
      const savingsMs = Math.round(audit.details?.overallSavingsMs || 0)
      const gain = Math.max(1, Math.ceil((1 - audit.score) * 6))
      return {
        id: `${domain}-${device.toLowerCase()}-${id}`,
        site: domain,
        device,
        severity,
        title: cleanText(audit.title || id),
        category,
        detail: cleanText(audit.displayValue || audit.explanation || `Lighthouse audit score: ${Math.round(audit.score * 100)}/100.`),
        action: cleanText(audit.description || 'Review this Lighthouse audit and apply the recommended remediation.'),
        impact: savingsMs >= 100 ? `${(savingsMs / 1000).toFixed(1)}s` : `+${gain} ${gain === 1 ? 'pt' : 'pts'}`,
        savingsMs
      }
    })
    .filter(Boolean)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.savingsMs - a.savingsMs)
    .slice(0, 25)
    .map(({ savingsMs, ...issue }) => issue)
}

async function runPageSpeed(targetUrl, strategy, apiKey, categories) {
  const params = new URLSearchParams({ url: targetUrl, strategy, key: apiKey })
  for (const category of categories) params.append('category', category)

  const response = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {
    signal: AbortSignal.timeout(180_000)
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    const upstreamMessage = cleanText(data.error?.message || '')
    const error = new Error(response.status === 429
      ? 'Google PageSpeed quota is temporarily exceeded. Try again later or review the API key quota.'
      : upstreamMessage || `Google PageSpeed returned HTTP ${response.status}.`)
    error.status = response.status
    throw error
  }

  if (data.lighthouseResult?.runtimeError?.message) throw new Error(cleanText(data.lighthouseResult.runtimeError.message))
  return data
}

async function runPageSpeedWithRetry(targetUrl, strategy, apiKey, categories, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await runPageSpeed(targetUrl, strategy, apiKey, categories) }
    catch (error) {
      lastError = error
      if (error.status === 429 || attempt === attempts) throw error
      await new Promise(resolve => setTimeout(resolve, attempt * 2_000))
    }
  }
  throw lastError
}

async function analyzeWebsite(targetUrl, apiKey) {
  const target = new URL(targetUrl)
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only HTTP and HTTPS website URLs are supported.')
  // PageSpeed can intermittently drop one of two simultaneous requests. Run
  // devices sequentially and retry each device so a complete matrix is favored.
  const settle = async strategy => {
    try { return { status: 'fulfilled', value: await runPageSpeedWithRetry(target.href, strategy, apiKey, CATEGORIES) } }
    catch (reason) { return { status: 'rejected', reason } }
  }
  const mobileResult = await settle('mobile')
  const desktopResult = await settle('desktop')
  const mobile = mobileResult.status === 'fulfilled' ? mobileResult.value : null
  const desktop = desktopResult.status === 'fulfilled' ? desktopResult.value : null
  if (!mobile && !desktop) throw new Error(`Mobile: ${mobileResult.reason?.message || 'scan failed'}. Web: ${desktopResult.reason?.message || 'scan failed'}.`)
  const mobileCategories = mobile?.lighthouseResult?.categories || {}
  const desktopCategories = desktop?.lighthouseResult?.categories || {}
  const mobilePerformance = score(mobileCategories.performance)
  const desktopPerformance = score(desktopCategories.performance)
  const deviceScores = {
    mobile: {
      performance: mobilePerformance,
      accessibility: score(mobileCategories.accessibility),
      bestPractices: score(mobileCategories['best-practices']),
      seo: score(mobileCategories.seo)
    },
    desktop: {
      performance: desktopPerformance,
      accessibility: score(desktopCategories.accessibility),
      bestPractices: score(desktopCategories['best-practices']),
      seo: score(desktopCategories.seo)
    }
  }
  const categoryAverage = key => {
    const values = [deviceScores.mobile[key], deviceScores.desktop[key]].filter(value => typeof value === 'number')
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null
  }
  const coreWebVitals = coreWebVitalsScore(mobile || desktop)
  const scores = {
    performance: categoryAverage('performance'), seo: categoryAverage('seo'),
    accessibility: categoryAverage('accessibility'), bestPractices: categoryAverage('bestPractices'),
    coreWebVitals: coreWebVitals.score, mobile: mobilePerformance, desktop: desktopPerformance
  }
  const validScores = Object.values(scores).filter(value => typeof value === 'number')
  const overall = validScores.length ? Math.round(validScores.reduce((sum, value) => sum + value, 0) / validScores.length) : null
  const primaryResult = mobile || desktop
  const domain = new URL(primaryResult.lighthouseResult?.finalUrl || target.href).hostname.replace(/^www\./, '')
  return {
    site: {
      id: domain, domain, url: primaryResult.lighthouseResult?.finalUrl || target.href, overall, scores, deviceScores,
      scannedAt: new Date().toISOString(),
      sourceFetchTime: primaryResult.lighthouseResult?.fetchTime || null,
      status: overall >= 90 ? 'Excellent' : overall >= 75 ? 'Good' : overall >= 50 ? 'Needs work' : 'Poor',
      coreWebVitalsSource: coreWebVitals.source,
      lighthouseVersion: primaryResult.lighthouseResult?.lighthouseVersion || null,
      coverage: { mobile: Boolean(mobile), desktop: Boolean(desktop) },
      scanWarning: !mobile ? `Mobile scan failed: ${mobileResult.reason?.message || 'unknown error'}` : !desktop ? `Web scan failed: ${desktopResult.reason?.message || 'unknown error'}` : null,
      color: null
    },
    issues: [
      ...(mobile ? extractIssues(mobile, domain, 'Mobile') : []),
      ...(desktop ? extractIssues(desktop, domain, 'Web') : [])
    ].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  }
}

function hasCompleteScoreMatrix(site) {
  return site?.coverage?.mobile && site?.coverage?.desktop && ['mobile', 'desktop'].every(device =>
    DEVICE_METRICS.every(metric => typeof site.deviceScores?.[device]?.[metric] === 'number'))
}

function pageSpeedPlugin(apiKey) {
  const handler = async (req, res, next) => {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/api/analyze') return next()

    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (!apiKey) {
      res.statusCode = 503
      return res.end(JSON.stringify({ error: 'Google PageSpeed API key is not configured.' }))
    }

    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 8_192) throw new Error('Request is too large.')
      }
      const parsed = JSON.parse(body || '{}')
      res.end(JSON.stringify(await analyzeWebsite(parsed.url, apiKey)))
    } catch (error) {
      res.statusCode = error.status && error.status >= 400 && error.status < 600 ? error.status : 500
      res.end(JSON.stringify({ error: cleanText(error.message) || 'Website analysis failed.' }))
    }
  }

  return {
    name: 'pagespeed-api',
    configureServer(server) { server.middlewares.use(handler) },
    configurePreviewServer(server) { server.middlewares.use(handler) }
  }
}

function createGmailTransporter(config) {
  return config.user && config.password ? nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: config.user, pass: config.password.replace(/\s/g, '') }
  }) : null
}

function buildMatrixEmail(sites) {
  const emailMetrics = [['performance', 'Performance'], ['accessibility', 'Accessibility'], ['bestPractices', 'Best practices'], ['seo', 'SEO']]
  const scoreStyle = value => {
    if (typeof value !== 'number') return 'background:#f4f4f5;color:#8b9296'
    if (value >= 90) return 'background:#e8f7f2;color:#007956'
    if (value >= 75) return 'background:#f0e7f6;color:#4f008c'
    if (value >= 60) return 'background:#fff3df;color:#a55e00'
    return 'background:#ffedf1;color:#c80025'
  }
  const groups = Array.from({ length: Math.ceil(sites.length / 3) }, (_, index) => sites.slice(index * 3, index * 3 + 3))
  const renderGroup = (group, groupIndex) => {
    const siteHeaders = group.map(site => `<th style="padding:12px;border-left:1px solid #e5e6e8;text-align:left;min-width:190px"><div style="font-size:13px;color:#1d252d">${escapeHtml(site.domain)}</div><div style="font-size:11px;color:#7d858a;margin-top:3px">Overall score <strong style="float:right;font-size:22px;color:#4f008c">${escapeHtml(site.overall ?? '—')}</strong></div></th>`).join('')
    const rows = emailMetrics.map(([key, label]) => `<tr>
      <td style="padding:13px 12px;border-top:1px solid #e5e6e8;font-size:12px;font-weight:700;color:#1d252d">${escapeHtml(label)}<div style="font-size:9px;font-weight:400;color:#8b9296;margin-top:3px">0–100 score</div></td>
      ${group.map(site => {
        const mobile = site.deviceScores?.mobile?.[key]
        const web = site.deviceScores?.desktop?.[key]
        return `<td style="padding:8px;border-left:1px solid #e5e6e8;border-top:1px solid #e5e6e8"><table role="presentation" style="width:100%;border-spacing:5px 0"><tr><td style="${scoreStyle(mobile)};padding:10px;border-radius:7px;font-size:10px">Mobile <strong style="float:right;font-size:17px">${escapeHtml(mobile ?? '—')}</strong></td><td style="${scoreStyle(web)};padding:10px;border-radius:7px;font-size:10px">Web <strong style="float:right;font-size:17px">${escapeHtml(web ?? '—')}</strong></td></tr></table></td>`
      }).join('')}
    </tr>`).join('')
    return `<div style="margin-top:${groupIndex ? '16px' : '0'};border:1px solid #e1e2e4;border-radius:10px;overflow:hidden"><div style="height:30px;line-height:30px;padding:0 12px;background:#f4eff8;color:#4f008c;font-size:10px;font-weight:700;letter-spacing:.7px;text-transform:uppercase">Websites ${groupIndex * 3 + 1}–${groupIndex * 3 + group.length}</div><div style="overflow-x:auto"><table style="width:100%;min-width:760px;border-collapse:collapse"><thead><tr style="background:#fafafa"><th style="padding:12px;text-align:left;color:#737c81;font-size:10px;width:150px">Audit category</th>${siteHeaders}</tr></thead><tbody>${rows}</tbody></table></div></div>`
  }
  const generatedAt = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kuwait', dateStyle: 'medium', timeStyle: 'short' })
  const html = `<div style="font-family:Arial,sans-serif;color:#1d252d;max-width:900px;margin:auto;background:#f7f7f8;padding:20px"><div style="background:#fff;border:1px solid #dedfe1;border-radius:12px;overflow:hidden"><div style="padding:20px;border-bottom:1px solid #e5e6e8"><div style="font-size:10px;letter-spacing:1px;font-weight:700;color:#4f008c;text-transform:uppercase">Score comparison</div><div style="font-size:20px;font-weight:700;margin-top:5px">Mobile and Web benchmark matrix</div><div style="font-size:11px;color:#7d858a;margin-top:5px">${sites.length} websites · grouped three per section</div></div><div style="padding:16px">${groups.map(renderGroup).join('')}</div><div style="padding:12px 20px;border-top:1px solid #e5e6e8;font-size:9px;color:#8b9296">Generated ${escapeHtml(generatedAt)} Kuwait time · Google PageSpeed Insights</div></div></div>`
  const text = `Mobile and Web benchmark matrix\n\n${sites.map(site => [`${site.domain} — Overall ${site.overall ?? '—'}`, ...emailMetrics.map(([key, label]) => `${label}: Mobile ${site.deviceScores?.mobile?.[key] ?? '—'} | Web ${site.deviceScores?.desktop?.[key] ?? '—'}`)].join('\n')).join('\n\n')}`
  return { html, text }
}

async function sendMatrixEmail(transporter, config, recipients, sites) {
  const { html, text } = buildMatrixEmail(sites)
  return transporter.sendMail({
    from: `STC Website Benchmark <${config.user}>`, to: recipients,
    subject: `Mobile and Web benchmark matrix — ${sites.length} ${sites.length === 1 ? 'website' : 'websites'}`,
    text, html
  })
}

function emailReportPlugin(config) {
  const configured = Boolean(config.user && config.password)
  const transporter = createGmailTransporter(config)

  const handler = async (req, res, next) => {
    const path = req.url?.split('?')[0]
    if (req.method === 'GET' && path === '/api/email-status') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      let verified = false
      let errorType = null
      if (configured) {
        try { await transporter.verify(); verified = true } catch (error) {
          verified = false
          errorType = error.code || (error.responseCode ? `SMTP_${error.responseCode}` : 'CONNECTION_FAILED')
        }
      }
      return res.end(JSON.stringify({ configured, verified, sender: configured ? config.user : null, errorType }))
    }
    if (req.method !== 'POST' || path !== '/api/email-report') return next()

    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (!configured) {
      res.statusCode = 503
      return res.end(JSON.stringify({ error: 'Gmail SMTP is not configured.' }))
    }

    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 100_000) throw new Error('Email report is too large.')
      }
      const { recipient, sites = [] } = JSON.parse(body || '{}')
      const recipients = String(recipient || '').split(',').map(value => value.trim()).filter(Boolean)
      if (!recipients.length || recipients.some(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) throw new Error('Enter valid recipient email addresses.')
      if (!Array.isArray(sites) || !sites.length) throw new Error('Run at least one website scan before sending a report.')

      await sendMatrixEmail(transporter, config, recipients, sites)
      res.end(JSON.stringify({ sent: true, recipients }))
    } catch (error) {
      res.statusCode = 500
      const authError = ['EAUTH', '535'].some(code => String(error.code || error.responseCode || '').includes(code))
      res.end(JSON.stringify({ error: authError ? 'Gmail rejected the App Password. Generate a new App Password and update .env.local.' : cleanText(error.message) || 'Email delivery failed.' }))
    }
  }

  return {
    name: 'email-report-api',
    configureServer(server) { server.middlewares.use(handler) },
    configurePreviewServer(server) { server.middlewares.use(handler) }
  }
}

function nextKuwaitRun(time = '15:00', now = Date.now()) {
  const [hour, minute] = /^([01]\d|2[0-3]):([0-5]\d)$/.test(time) ? time.split(':').map(Number) : [15, 0]
  const kuwaitNow = new Date(now + 3 * 60 * 60 * 1000)
  let next = Date.UTC(kuwaitNow.getUTCFullYear(), kuwaitNow.getUTCMonth(), kuwaitNow.getUTCDate(), hour - 3, minute, 0)
  if (next <= now) next += 24 * 60 * 60 * 1000
  return new Date(next).toISOString()
}

async function readJson(file, fallback) {
  try { return { ...fallback, ...JSON.parse(await readFile(file, 'utf8')) } } catch { return fallback }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

function automationPlugin(apiKey, emailConfig) {
  const stateFile = path.join(process.cwd(), 'work', 'benchmark-automation-state.json')
  const settingsFile = path.join(process.cwd(), 'work', 'benchmark-email-settings.json')
  const transporter = createGmailTransporter(emailConfig)
  let timer = null
  let running = null
  let state = {
    status: 'idle', standardUrls: STANDARD_URLS, sites: [], issues: [], progress: [],
    lastAttemptAt: null, lastCompletedAt: null, nextRunAt: nextKuwaitRun(),
    error: null, emailStatus: null
  }
  let settings = { recipients: [], schedule: 'Daily summary', time: '15:00', day: 'Sunday', enabled: true }

  const persistState = () => writeJson(stateFile, state)

  async function initialize() {
    state = await readJson(stateFile, state)
    const resumeInterruptedRun = state.status === 'running'
    settings = await readJson(settingsFile, settings)
    state.standardUrls = STANDARD_URLS
    state.nextRunAt = nextKuwaitRun(settings.time)
    await persistState()
    scheduleNextRun()
    if (resumeInterruptedRun) runAutomation('recovery').catch(() => {})
  }

  function scheduleNextRun() {
    if (timer) clearTimeout(timer)
    const nextRunAt = nextKuwaitRun(settings.time)
    state.nextRunAt = nextRunAt
    persistState().catch(() => {})
    timer = setTimeout(() => {
      runAutomation('scheduled').finally(scheduleNextRun)
    }, Math.max(1_000, new Date(nextRunAt).getTime() - Date.now()))
  }

  async function runAutomation(trigger) {
    if (running) return running
    running = (async () => {
      const stagedSites = []
      const stagedIssues = []
      const failures = []
      const previousProgress = new Map((state.progress || []).map(item => [item.url, item]))
      state = {
        ...state, status: 'running', trigger, lastAttemptAt: new Date().toISOString(),
        error: null, emailStatus: null,
        progress: STANDARD_URLS.map(url => {
          const previous = previousProgress.get(url) || {}
          return {
            url, domain: new URL(url).hostname.replace(/^www\./, ''), status: 'queued', attempt: 0,
            overall: previous.overall, checkedAt: previous.checkedAt, latestSite: previous.latestSite
          }
        })
      }
      await persistState()
      try {
        for (let index = 0; index < STANDARD_URLS.length; index += 1) {
          const url = STANDARD_URLS[index]
          let result = null
          let lastError = null
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            state.progress[index] = { ...state.progress[index], status: 'scanning', attempt }
            await persistState()
            try {
              const candidate = await analyzeWebsite(url, apiKey)
              if (!hasCompleteScoreMatrix(candidate.site)) throw new Error('Mobile or Web score columns are incomplete.')
              result = candidate
              break
            } catch (error) { lastError = error }
          }
          if (!result) {
            state.progress[index] = { ...state.progress[index], status: 'failed', message: cleanText(lastError?.message || 'Score check failed.') }
            failures.push(`${state.progress[index].domain}: ${state.progress[index].message}`)
            await persistState()
            continue
          }
          result.site.standardUrl = url
          result.site.scannedAt = new Date().toISOString()
          stagedSites.push(result.site)
          stagedIssues.push(...result.issues)
          state.progress[index] = { ...state.progress[index], domain: result.site.domain, status: 'complete', overall: result.site.overall, checkedAt: result.site.scannedAt, latestSite: result.site }
          await persistState()
        }

        if (failures.length) throw new Error(failures.join(' | '))

        const completedAt = new Date().toISOString()
        state = { ...state, status: 'completed', sites: stagedSites, issues: stagedIssues, lastCompletedAt: completedAt, error: null }
        await persistState()

        const recipients = Array.isArray(settings.recipients) ? settings.recipients.filter(Boolean) : []
        if (trigger !== 'scheduled') {
          state.emailStatus = { status: 'skipped', message: 'Manual score check completed. Use Send report now if needed.' }
        } else if (recipients.length && transporter) {
          try {
            await transporter.verify()
            await sendMatrixEmail(transporter, emailConfig, recipients, stagedSites)
            state.emailStatus = { status: 'sent', sentAt: new Date().toISOString(), recipients: recipients.length }
          } catch (error) {
            state.emailStatus = { status: 'failed', message: cleanText(error.message || 'Email delivery failed.') }
          }
        } else {
          state.emailStatus = { status: 'skipped', message: recipients.length ? 'Gmail is not configured.' : 'No saved recipients.' }
        }
        await persistState()
      } catch (error) {
        state = { ...state, status: 'failed', error: cleanText(error.message), emailStatus: { status: 'blocked', message: 'Email not sent because the complete score matrix was not available.' } }
        await persistState()
      } finally { running = null }
      return state
    })()
    return running
  }

  const handler = async (req, res, next) => {
    const requestPath = req.url?.split('?')[0]
    if (req.method === 'GET' && requestPath === '/api/automation-state') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      return res.end(JSON.stringify(state))
    }
    if (req.method === 'GET' && requestPath === '/api/email-settings') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      return res.end(JSON.stringify(settings))
    }
    if (req.method === 'POST' && requestPath === '/api/email-settings') {
      try {
        let body = ''
        for await (const chunk of req) body += chunk
        const next = JSON.parse(body || '{}')
        const recipients = Array.isArray(next.recipients) ? [...new Set(next.recipients.map(value => String(value).trim().toLowerCase()).filter(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))] : []
        settings = { ...settings, ...next, schedule: 'Daily summary', recipients }
        await writeJson(settingsFile, settings)
        scheduleNextRun()
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        return res.end(JSON.stringify(settings))
      } catch (error) {
        res.statusCode = 400
        return res.end(JSON.stringify({ error: cleanText(error.message) }))
      }
    }
    if (req.method === 'POST' && requestPath === '/api/automation/run') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (running) {
        res.statusCode = 409
        return res.end(JSON.stringify({ error: 'A full score check is already running.' }))
      }
      runAutomation('manual').catch(() => {})
      res.statusCode = 202
      return res.end(JSON.stringify({ started: true }))
    }
    return next()
  }

  const configure = server => {
    server.middlewares.use(handler)
    initialize().catch(error => { state = { ...state, status: 'failed', error: cleanText(error.message) } })
    server.httpServer?.once('close', () => { if (timer) clearTimeout(timer) })
  }
  return { name: 'daily-benchmark-automation', configureServer: configure, configurePreviewServer: configure }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const emailConfig = { user: env.SMTP_USER, password: env.SMTP_APP_PASSWORD }
  return {
    plugins: [
      react(),
      pageSpeedPlugin(env.GOOGLE_PAGESPEED_API_KEY),
      emailReportPlugin(emailConfig),
      automationPlugin(env.GOOGLE_PAGESPEED_API_KEY, emailConfig)
    ]
  }
})
