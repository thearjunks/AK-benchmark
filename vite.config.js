import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import nodemailer from 'nodemailer'
import ExcelJS from 'exceljs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { authPlugin } from './auth.mjs'
import { parseLegacyDesktopHistory, parseLegacyMobileHistory } from './legacy-history.mjs'

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo']
const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 }
const STANDARD_URLS = [
  'https://www.stc.com.kw/en',
  'https://www.kw.zain.com/en/shop',
  'https://www.ooredoo.com.kw/en',
  'https://www.stc.com.sa/en/personal/home.html',
  'https://www.stc.com.bh/',
  'https://www.virgin.com/'
]
const DEVICE_METRICS = ['performance', 'accessibility', 'bestPractices', 'seo']

export function standardUrlIndex(value) {
  try {
    const normalized = new URL(value).href
    return STANDARD_URLS.findIndex(url => new URL(url).href === normalized)
  } catch { return -1 }
}

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

  if (data.lighthouseResult?.runtimeError?.message) {
    const error = new Error(cleanText(data.lighthouseResult.runtimeError.message))
    error.code = 'PAGESPEED_RUNTIME_ERROR'
    throw error
  }
  return data
}

async function runPageSpeedWithRetry(targetUrl, strategy, apiKey, categories, attempts = 3, retryRuntimeErrors = false) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await runPageSpeed(targetUrl, strategy, apiKey, categories) }
    catch (error) {
      lastError = error
      if ((!retryRuntimeErrors && error.code === 'PAGESPEED_RUNTIME_ERROR') || error.status === 429 || (error.status && error.status < 500) || attempt === attempts) throw error
      await new Promise(resolve => setTimeout(resolve, attempt * 2_000))
    }
  }
  throw lastError
}

async function runLighthouseFallback(targetUrl, strategy) {
  const [{ default: lighthouse }, { launch }] = await Promise.all([
    import('lighthouse'),
    import('chrome-launcher')
  ])
  let chrome
  let lighthouseTimer
  try {
    let chromePath = process.env.CHROME_PATH || undefined
    let chromeFlags = [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--ignore-certificate-errors', '--disable-extensions', '--window-size=1440,900'
    ]
    if (!chromePath && process.platform === 'linux') {
      const { default: chromium } = await import('@sparticuz/chromium')
      chromePath = await chromium.executablePath()
      chromeFlags = [...chromium.args, '--ignore-certificate-errors', '--window-size=1440,900']
    }
    chrome = await launch({
      chromePath,
      chromeFlags
    })
    const mobile = strategy === 'mobile'
    const lighthouseRun = lighthouse(targetUrl, {
      port: chrome.port,
      output: 'json',
      logLevel: 'silent',
      onlyCategories: CATEGORIES,
      formFactor: mobile ? 'mobile' : 'desktop',
      throttlingMethod: 'simulate',
      screenEmulation: mobile
        ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }
        : { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false }
    })
    const result = await Promise.race([
      lighthouseRun,
      new Promise((_, reject) => { lighthouseTimer = setTimeout(() => reject(new Error('Direct Lighthouse audit timed out after 150 seconds.')), 150_000) })
    ])
    if (!result?.lhr) throw new Error('Lighthouse did not return an audit result.')
    if (result.lhr.runtimeError?.message) throw new Error(cleanText(result.lhr.runtimeError.message))
    return { lighthouseResult: result.lhr, auditSource: 'Direct Lighthouse fallback' }
  } finally {
    if (lighthouseTimer) clearTimeout(lighthouseTimer)
    await chrome?.kill().catch(() => {})
  }
}

async function runLighthouseWithRetry(targetUrl, strategy, attempts = 2) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await runLighthouseFallback(targetUrl, strategy) }
    catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 2_000))
    }
  }
  throw lastError
}

function hasAllAuditCategoryScores(result) {
  const categories = result?.lighthouseResult?.categories || {}
  return CATEGORIES.every(category => typeof categories[category]?.score === 'number')
}

async function runAuditWithFallback(targetUrl, strategy, apiKey, fallbackMode = 'direct') {
  const managedOnly = fallbackMode === 'managed'
  try {
    const result = await runPageSpeedWithRetry(targetUrl, strategy, apiKey, CATEGORIES, managedOnly ? 4 : 3, managedOnly)
    if (!hasAllAuditCategoryScores(result)) throw new Error(`${strategy} response did not contain all four Lighthouse category scores.`)
    return { ...result, auditSource: managedOnly ? 'Google PageSpeed managed Lighthouse' : 'Google PageSpeed Insights' }
  } catch (pageSpeedError) {
    if (managedOnly) throw new Error(`Managed Lighthouse failed: ${cleanText(pageSpeedError.message)}`)
    try {
      const result = await runLighthouseWithRetry(targetUrl, strategy)
      if (!hasAllAuditCategoryScores(result)) throw new Error(`${strategy} Lighthouse result did not contain all four category scores.`)
      return result
    } catch (lighthouseError) {
      throw new Error(`PageSpeed failed: ${cleanText(pageSpeedError.message)} Lighthouse fallback failed: ${cleanText(lighthouseError.message)}`)
    }
  }
}

async function analyzeWebsite(targetUrl, apiKey, fallbackMode = 'direct') {
  const target = new URL(targetUrl)
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only HTTP and HTTPS website URLs are supported.')
  // PageSpeed can intermittently drop one of two simultaneous requests. Run
  // devices sequentially and retry each device so a complete matrix is favored.
  const settle = async strategy => {
    try { return { status: 'fulfilled', value: await runAuditWithFallback(target.href, strategy, apiKey, fallbackMode) } }
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
      auditSources: {
        mobile: mobile?.auditSource || null,
        desktop: desktop?.auditSource || null
      },
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

function zeroScoreSite(standardUrl, index) {
  const domain = new URL(standardUrl).hostname.replace(/^www\./, '')
  const zeroDevice = () => ({ performance: 0, accessibility: 0, bestPractices: 0, seo: 0 })
  return {
    id: `pending-${index}-${domain}`,
    domain,
    url: standardUrl,
    standardUrl,
    overall: 0,
    scores: { performance: 0, seo: 0, accessibility: 0, bestPractices: 0, coreWebVitals: 0, mobile: 0, desktop: 0 },
    deviceScores: { mobile: zeroDevice(), desktop: zeroDevice() },
    scannedAt: null,
    sourceFetchTime: null,
    status: 'Pending',
    coverage: { mobile: false, desktop: false },
    auditSources: { mobile: null, desktop: null },
    scanWarning: null,
    pending: true,
    color: null
  }
}

function workerScore(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`Lighthouse worker returned an invalid ${label} score.`)
  return value
}

function workerPayloadToAnalysis(payload, expectedUrl) {
  if (!payload?.ok || new URL(payload.url).href !== new URL(expectedUrl).href) throw new Error('Lighthouse worker returned a mismatched URL.')
  const expectedHost = new URL(expectedUrl).hostname.replace(/^www\./, '')
  const devices = {}
  let finalUrl = expectedUrl
  let sourceFetchTime = null
  let lighthouseVersion = null
  let coreWebVitals = null

  for (const device of ['mobile', 'desktop']) {
    const result = payload.devices?.[device]
    const final = new URL(result?.finalUrl || '')
    if (final.hostname.replace(/^www\./, '') !== expectedHost || /(?:error|login|signin|auth)[=_/-]?/i.test(`${final.pathname}${final.search}`)) {
      throw new Error(`Lighthouse worker reached an invalid ${device} final URL.`)
    }
    devices[device] = {
      performance: workerScore(result.scores?.performance, `${device} Performance`),
      accessibility: workerScore(result.scores?.accessibility, `${device} Accessibility`),
      bestPractices: workerScore(result.scores?.bestPractices, `${device} Best Practices`),
      seo: workerScore(result.scores?.seo, `${device} SEO`)
    }
    finalUrl = result.finalUrl
    sourceFetchTime ||= result.fetchTime || null
    lighthouseVersion ||= result.lighthouseVersion || null
    coreWebVitals ??= Number.isInteger(result.coreWebVitals) ? result.coreWebVitals : null
  }

  const categoryAverage = key => Math.round((devices.mobile[key] + devices.desktop[key]) / 2)
  const scores = {
    performance: categoryAverage('performance'), seo: categoryAverage('seo'),
    accessibility: categoryAverage('accessibility'), bestPractices: categoryAverage('bestPractices'),
    coreWebVitals, mobile: devices.mobile.performance, desktop: devices.desktop.performance
  }
  const validScores = Object.values(scores).filter(value => typeof value === 'number')
  const overall = Math.round(validScores.reduce((sum, value) => sum + value, 0) / validScores.length)
  const domain = new URL(finalUrl).hostname.replace(/^www\./, '')
  const issues = ['mobile', 'desktop'].flatMap(device => (payload.devices[device].issues || []).slice(0, 25).map((issue, index) => ({
    id: `${domain}-${device}-worker-${index}`,
    site: domain,
    device: device === 'mobile' ? 'Mobile' : 'Web',
    severity: ['Critical', 'High', 'Medium', 'Low'].includes(issue.severity) ? issue.severity : 'Low',
    title: cleanText(String(issue.title || 'Lighthouse finding')),
    category: cleanText(String(issue.category || 'Performance')),
    detail: cleanText(String(issue.detail || 'Review this Lighthouse finding.')),
    action: cleanText(String(issue.action || 'Apply the Lighthouse recommendation.')),
    impact: cleanText(String(issue.impact || '+1 pt'))
  })))

  return {
    site: {
      id: domain, domain, url: finalUrl, overall, scores, deviceScores: devices,
      scannedAt: new Date().toISOString(), sourceFetchTime,
      status: overall >= 90 ? 'Excellent' : overall >= 75 ? 'Good' : overall >= 50 ? 'Needs work' : 'Poor',
      coreWebVitalsSource: coreWebVitals === null ? null : 'GitHub Lighthouse lab data',
      lighthouseVersion, coverage: { mobile: true, desktop: true },
      auditSources: { mobile: 'GitHub Actions Lighthouse', desktop: 'GitHub Actions Lighthouse' },
      scanWarning: null, color: null
    },
    issues: issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  }
}

function pageSpeedPlugin(apiKey, fallbackMode) {
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
      if (typeof parsed.url !== 'string' || !parsed.url.trim()) {
        res.statusCode = 400
        return res.end(JSON.stringify({ error: 'Website URL is required.' }))
      }
      res.end(JSON.stringify(await analyzeWebsite(parsed.url, apiKey, fallbackMode)))
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

function historyDateKey(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuwait', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function filterHistoryByDateRange(history, dateFrom = '', dateTo = '') {
  const validDate = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value)
  if (!validDate(dateFrom) || !validDate(dateTo)) throw new Error('Use valid From and To dates.')
  if (dateFrom && dateTo && dateFrom > dateTo) throw new Error('The From date must be before the To date.')
  return history.filter(record => {
    const date = historyDateKey(record.checkedAt)
    return (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo)
  })
}

export function buildHistoryEmail(history) {
  const emailMetrics = [['seo', 'SEO'], ['bestPractices', 'Best practices'], ['accessibility', 'Accessibility'], ['performance', 'Performance'], ['overall', 'Overall']]
  const scoreClass = value => typeof value !== 'number' ? 'missing' : value >= 90 ? 'great' : value >= 75 ? 'good' : value >= 60 ? 'warn' : 'bad'
  const domainColors = ['#ff375e', '#8736c5', '#00a1df', '#4f008c', '#c5003e', '#d71920']
  const dateKey = historyDateKey
  const orderedDomains = STANDARD_URLS.map(url => new URL(url).hostname.replace(/^www\./, ''))
  const extraDomains = [...new Set(history.map(record => record.domain))].filter(domain => !orderedDomains.includes(domain))
  const domains = [...orderedDomains, ...extraDomains]
  const dates = [...new Set(history.map(record => dateKey(record.checkedAt)))].sort()
  const latest = new Map()
  for (const record of [...history].sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt))) {
    latest.set(`${dateKey(record.checkedAt)}|${record.domain}|${record.device}`, record)
  }
  const groups = Array.from({ length: Math.ceil(domains.length / 3) }, (_, index) => domains.slice(index * 3, index * 3 + 3))
  const displayDate = value => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00Z`))
  const checkedAt = value => {
    const record = typeof value === 'object' ? value : { checkedAt: value }
    return record?.dateOnly ? `${displayDate(dateKey(record.checkedAt))} (imported date only)` : new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuwait', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(record.checkedAt))
  }
  const domainHeaders = domains.map((domain, index) => `<th class="domain" colspan="12" style="background:${domainColors[index % domainColors.length]}">${escapeHtml(domain)}<small>${escapeHtml(WEBSITE_META[domain]?.name || domain)}</small></th>`).join('')
  const deviceHeaders = domains.map((domain, index) => `<th class="device" colspan="5" style="background:${domainColors[index % domainColors.length]}">Mobile</th><th class="device" colspan="5" style="background:${domainColors[index % domainColors.length]}">Desktop</th><th class="device" colspan="2" style="background:${domainColors[index % domainColors.length]}">Audit details</th>`).join('')
  const metricHeaders = domains.map(() => `${['Mobile', 'Desktop'].map(() => emailMetrics.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')).join('')}<th>Checked date &amp; time</th><th>Source URL</th>`).join('')
  const dataRows = dates.map(date => `<tr><th class="date">${escapeHtml(displayDate(date))}</th>${domains.map(domain => {
    const deviceCells = ['Mobile', 'Web'].map(device => {
      const record = latest.get(`${date}|${domain}|${device}`)
      return emailMetrics.map(([key]) => `<td class="score ${scoreClass(record?.[key])}">${escapeHtml(record?.[key] ?? 'N/A')}</td>`).join('')
    }).join('')
    const records = ['Mobile', 'Web'].map(device => latest.get(`${date}|${domain}|${device}`)).filter(Boolean).sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))
    const record = records[0]
    const audit = record ? `<td class="checked">${escapeHtml(checkedAt(record))}</td><td class="url"><a href="${escapeHtml(record.url || '')}">${escapeHtml(record.url || '')}</a></td>` : '<td class="missing">N/A</td><td class="missing">N/A</td>'
    return `${deviceCells}${audit}`
  }).join('')}</tr>`).join('')
  const generatedAt = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kuwait', dateStyle: 'medium', timeStyle: 'short' })
  const periodLabel = dates.length === 1 ? displayDate(dates[0]) : dates.length ? `${displayDate(dates[0])} to ${displayDate(dates.at(-1))}` : 'No dates'
  const mobileCount = history.filter(record => record.device === 'Mobile').length
  const webCount = history.filter(record => record.device === 'Web').length
  const latestDate = history.reduce((latestValue, record) => !latestValue || new Date(record.checkedAt) > new Date(latestValue) ? record.checkedAt : latestValue, null)
  const html = `<style>.wrap{font-family:Arial,sans-serif;color:#111827;background:#f7f7f8;padding:16px}.card{background:#fff;border:1px solid #dfe2e5;border-radius:12px;overflow:hidden}.head{padding:18px 20px}.eyebrow{font-size:10px;letter-spacing:1px;font-weight:700;color:#4f008c;text-transform:uppercase}.head h1{font-size:20px;margin:5px 0}.head p{font-size:10px;color:#778087;margin:0}.kpis{width:100%;border-collapse:collapse;border-top:1px solid #e2e4e6}.kpis td{padding:10px 12px;border-right:1px solid #e2e4e6}.kpis td:last-child{border-right:0}.kpis span{display:block;font-size:8px;color:#788187}.kpis b{display:block;font-size:18px;margin:4px 0}.kpis small{font-size:8px;color:#899196}.section{padding:15px}.section h2{font-size:15px;margin:3px 0}.section p{font-size:9px;color:#7b8489}.scroll{overflow-x:auto;border:1px solid #dfe2e4}.matrix{border-collapse:collapse;min-width:4200px;width:100%}.matrix th,.matrix td{border:1px solid #dde1e3;text-align:center;padding:7px 6px;font-size:9px}.matrix .datehead{background:#1d252d;color:#fff;min-width:90px}.matrix .domain{color:#fff;font-size:11px;padding:10px}.matrix .domain small{display:block;font-size:8px;margin-top:2px}.matrix .device{color:#fff;border-top-color:rgba(255,255,255,.5)}.matrix thead tr:nth-child(3) th{background:#fff1f4;min-width:56px}.matrix .date{background:#f6f7f8;white-space:nowrap}.score{font-weight:700}.great{background:#e8f7f2;color:#007956}.good{background:#f0e7f6;color:#4f008c}.warn{background:#fff3df;color:#a55e00}.bad{background:#ffedf1;color:#c80025}.missing{background:#f1f2f3;color:#8a9298}.checked{color:#737c81;white-space:nowrap}.url{text-align:left!important;min-width:180px}.url a{color:#4f008c;text-decoration:none}.foot{padding:11px 20px;border-top:1px solid #e5e6e8;font-size:8px;color:#8b9296}</style><div class="wrap"><div class="card"><div class="head"><div class="eyebrow">Score history</div><h1>Website Score History Report</h1><p>${escapeHtml(periodLabel)} · Six-website Mobile and Desktop scores. The filtered Excel workbook is attached.</p></div><table class="kpis" role="presentation"><tr><td><span>History records</span><b>${history.length}</b><small>Imported and automatic rows</small></td><td><span>Websites tracked</span><b>${domains.length}</b><small>Ordered competitor set</small></td><td><span>Mobile records</span><b>${mobileCount}</b><small>Automatic Mobile</small></td><td><span>Web records</span><b>${webCount}</b><small>Imported and automatic Desktop</small></td><td><span>Latest history</span><b style="font-size:11px">${latestDate ? escapeHtml(checkedAt(latestDate)) : 'N/A'}</b><small>Asia/Kuwait time</small></td></tr></table><div class="section"><div class="eyebrow">Excel-style score archive</div><h2>Six-website history comparison</h2><p>Each row is one Kuwait calendar date. Scroll horizontally to compare every domain.</p><div class="scroll"><table class="matrix"><thead><tr><th class="datehead" rowspan="3">Date</th>${domainHeaders}</tr><tr>${deviceHeaders}</tr><tr>${metricHeaders}</tr></thead><tbody>${dataRows}</tbody></table></div></div><div class="foot">Generated ${escapeHtml(generatedAt)} Kuwait time · Saved benchmark history</div></div></div>`
  const text = `Website Score History Report\n\n${dates.map(date => `${displayDate(date)}\n${domains.map(domain => ['Mobile', 'Web'].map(device => { const record = latest.get(`${date}|${domain}|${device}`); return `${domain} ${device === 'Web' ? 'Desktop' : device}: ${emailMetrics.map(([key, label]) => `${label} ${record?.[key] ?? 'N/A'}`).join(' | ')}` }).join('\n')).join('\n')}`).join('\n\n')}`
  return { html, text, dates, domains, periodLabel }
}

async function sendHistoryEmail(transporter, config, recipients, history) {
  const { html, text, dates, domains, periodLabel } = buildHistoryEmail(history)
  if (!dates.length || !domains.length) throw new Error('No score history is available to send.')
  const workbook = await buildHistoryWorkbook(history)
  return transporter.sendMail({
    from: `STC Website Benchmark <${config.user}>`, to: recipients,
    subject: `Website Score History Report — ${periodLabel}`,
    text, html,
    attachments: [{
      filename: `website-benchmark-history-${new Date().toISOString().slice(0, 10)}.xlsx`,
      content: Buffer.from(workbook),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }]
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

export function firstWorkingDayOfMonth(year, monthIndex) {
  const weekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay()
  return weekday === 5 ? 3 : weekday === 6 ? 2 : 1
}

export function nextMonthlyHistoryRun(time = '15:00', now = Date.now()) {
  const [hour, minute] = /^([01]\d|2[0-3]):([0-5]\d)$/.test(time) ? time.split(':').map(Number) : [15, 0]
  const kuwaitNow = new Date(now + 3 * 60 * 60 * 1000)
  let year = kuwaitNow.getUTCFullYear()
  let month = kuwaitNow.getUTCMonth()
  let day = firstWorkingDayOfMonth(year, month)
  let next = Date.UTC(year, month, day, hour - 3, minute, 0)
  if (next <= now) {
    month += 1
    if (month > 11) { month = 0; year += 1 }
    day = firstWorkingDayOfMonth(year, month)
    next = Date.UTC(year, month, day, hour - 3, minute, 0)
  }
  return new Date(next).toISOString()
}

function dueMonthlyHistoryPeriod(time = '15:00', now = Date.now()) {
  const [hour, minute] = /^([01]\d|2[0-3]):([0-5]\d)$/.test(time) ? time.split(':').map(Number) : [15, 0]
  const kuwaitNow = new Date(now + 3 * 60 * 60 * 1000)
  const year = kuwaitNow.getUTCFullYear()
  const month = kuwaitNow.getUTCMonth()
  if (kuwaitNow.getUTCDate() !== firstWorkingDayOfMonth(year, month)) return null
  const scheduled = Date.UTC(year, month, kuwaitNow.getUTCDate(), hour - 3, minute, 0)
  return now >= scheduled ? `${year}-${String(month + 1).padStart(2, '0')}` : null
}

async function readJson(file, fallback) {
  try { return { ...fallback, ...JSON.parse(await readFile(file, 'utf8')) } } catch { return fallback }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

async function readLegacyHistory() {
  const desktopFile = path.join(process.cwd(), 'data', 'legacy-desktop-history-2026.csv')
  const mobileFile = path.join(process.cwd(), 'data', 'legacy-mobile-history-2026.csv')
  const [desktopSource, mobileSource] = await Promise.all([
    readFile(desktopFile, 'utf8'),
    readFile(mobileFile, 'utf8')
  ])
  return [...parseLegacyDesktopHistory(desktopSource), ...parseLegacyMobileHistory(mobileSource)]
}

const WEBSITE_META = {
  'stc.com.kw': { name: 'STC Kuwait', page: 'Homepage', sheet: 'STC KW' },
  'kw.zain.com': { name: 'Zain Kuwait', page: 'Shop', sheet: 'Zain KW' },
  'ooredoo.com.kw': { name: 'Ooredoo Kuwait', page: 'Homepage', sheet: 'Ooredoo KW' },
  'stc.com.sa': { name: 'STC Saudi Arabia', page: 'Personal homepage', sheet: 'STC KSA' },
  'stc.com.bh': { name: 'STC Bahrain', page: 'Homepage', sheet: 'STC BH' },
  'virgin.com': { name: 'Virgin', page: 'Homepage', sheet: 'Virgin' }
}

function historyRecordsForSite(site) {
  if (!site?.domain || !site?.scannedAt) return []
  const meta = WEBSITE_META[site.domain] || { name: site.domain, page: new URL(site.url || `https://${site.domain}`).pathname || '/', sheet: site.domain }
  return [['mobile', 'Mobile'], ['desktop', 'Web']].map(([deviceKey, deviceLabel]) => {
    const scores = site.deviceScores?.[deviceKey] || {}
    const scoreValues = DEVICE_METRICS.map(metric => scores[metric]).filter(value => typeof value === 'number')
    if (scoreValues.length !== DEVICE_METRICS.length) return null
    const checkedAt = new Date(site.scannedAt).toISOString()
    return {
      id: `${site.domain}-${deviceKey}-${checkedAt}`,
      domain: site.domain,
      website: meta.name,
      page: meta.page,
      url: site.standardUrl || site.url,
      device: deviceLabel,
      checkedAt,
      seo: scores.seo,
      bestPractices: scores.bestPractices,
      accessibility: scores.accessibility,
      performance: scores.performance,
      overall: Math.round(scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length),
      source: 'Google PageSpeed Insights'
    }
  }).filter(Boolean)
}

function mergeHistory(current, records) {
  const byId = new Map((Array.isArray(current) ? current : []).map(record => [record.id, record]))
  for (const record of records) byId.set(record.id, record)
  return [...byId.values()].sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))
}

export async function buildHistoryWorkbook(history) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'STC Website Benchmark'
  workbook.created = new Date()
  const purple = '4F008C'
  const coral = 'FF375E'
  const dark = '1D252D'
  const orderedDomains = STANDARD_URLS.map(url => new URL(url).hostname.replace(/^www\./, ''))
  const extraDomains = [...new Set(history.map(record => record.domain))].filter(domain => !orderedDomains.includes(domain))
  const domainOrder = [...orderedDomains, ...extraDomains]
  const orderIndex = new Map(domainOrder.map((domain, index) => [domain, index]))
  const rows = [...history].sort((a, b) => (orderIndex.get(a.domain) ?? 999) - (orderIndex.get(b.domain) ?? 999) || new Date(b.checkedAt) - new Date(a.checkedAt) || a.device.localeCompare(b.device))

  const applyHeader = row => {
    row.height = 24
    row.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${purple}` } }
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
      cell.border = { bottom: { style: 'thin', color: { argb: `FF${coral}` } } }
    })
  }
  const applyScoreStyle = (cell, value) => {
    const fill = value >= 90 ? 'E8F7F2' : value >= 75 ? 'F0E7F6' : value >= 60 ? 'FFF3DF' : 'FFEDF1'
    const font = value >= 90 ? '007956' : value >= 75 ? purple : value >= 60 ? 'A55E00' : 'C80025'
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${fill}` } }
    cell.font = { bold: true, color: { argb: `FF${font}` } }
    cell.alignment = { horizontal: 'center' }
  }

  const comparison = workbook.addWorksheet('Score Comparison', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 3, showGridLines: false }]
  })
  const metricColumns = [
    ['SEO', 'seo'],
    ['Best Practices', 'bestPractices'],
    ['Accessibility', 'accessibility'],
    ['Performance', 'performance'],
    ['Overall', 'overall']
  ]
  const devices = [['Mobile', 'Mobile'], ['Desktop', 'Web']]
  const auditDetailColumns = ['Checked date & time', 'Source URL']
  const groupColors = ['4F008C', '00A9CE', 'F57C00', 'FF375E', '7F35B2', '1D252D', '00857A', '6F777C']
  const comparisonDomains = domainOrder.filter(domain => WEBSITE_META[domain] || rows.some(record => record.domain === domain))
  const comparisonGroupWidth = devices.length * metricColumns.length + auditDetailColumns.length
  const totalComparisonColumns = 1 + comparisonDomains.length * comparisonGroupWidth
  const kuwaitDateKey = value => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kuwait', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(value)).map(part => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
  }
  const latestByDateDomainDevice = new Map()
  for (const record of [...rows].sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt))) {
    latestByDateDomainDevice.set(`${kuwaitDateKey(record.checkedAt)}|${record.domain}|${record.device}`, record)
  }
  const comparisonDates = [...new Set(rows.map(record => kuwaitDateKey(record.checkedAt)))].sort()

  comparison.mergeCells(1, 1, 3, 1)
  comparison.getCell(1, 1).value = 'Date'
  comparison.getCell(1, 1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
  comparison.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${dark}` } }
  comparison.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'center' }
  comparison.getCell(1, 1).border = { bottom: { style: 'thin', color: { argb: `FF${coral}` } }, right: { style: 'medium', color: { argb: 'FFFFFFFF' } } }

  comparisonDomains.forEach((domain, domainIndex) => {
    const meta = WEBSITE_META[domain] || { name: domain }
    const groupStart = 2 + domainIndex * comparisonGroupWidth
    const groupEnd = groupStart + comparisonGroupWidth - 1
    const color = groupColors[domainIndex % groupColors.length]
    comparison.mergeCells(1, groupStart, 1, groupEnd)
    const websiteCell = comparison.getCell(1, groupStart)
    websiteCell.value = meta.name
    websiteCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 }
    websiteCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${color}` } }
    websiteCell.alignment = { vertical: 'middle', horizontal: 'center' }
    websiteCell.border = { right: { style: 'medium', color: { argb: 'FFFFFFFF' } } }

    devices.forEach(([displayDevice], deviceIndex) => {
      const deviceStart = groupStart + deviceIndex * metricColumns.length
      const deviceEnd = deviceStart + metricColumns.length - 1
      comparison.mergeCells(2, deviceStart, 2, deviceEnd)
      const deviceCell = comparison.getCell(2, deviceStart)
      deviceCell.value = displayDevice
      deviceCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
      deviceCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${color}` } }
      deviceCell.alignment = { vertical: 'middle', horizontal: 'center' }
      deviceCell.border = { top: { style: 'thin', color: { argb: 'FFFFFFFF' } }, right: { style: 'medium', color: { argb: 'FFFFFFFF' } } }
      metricColumns.forEach(([label], metricIndex) => {
        const cell = comparison.getCell(3, deviceStart + metricIndex)
        cell.value = label
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${color}` } }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        cell.border = {
          bottom: { style: 'thin', color: { argb: `FF${coral}` } },
          right: metricIndex === metricColumns.length - 1 ? { style: 'medium', color: { argb: 'FFFFFFFF' } } : { style: 'thin', color: { argb: 'FFD9D9D9' } }
        }
      })
    })
    const detailStart = groupStart + devices.length * metricColumns.length
    const detailEnd = detailStart + auditDetailColumns.length - 1
    comparison.mergeCells(2, detailStart, 2, detailEnd)
    const detailCell = comparison.getCell(2, detailStart)
    detailCell.value = 'Audit details'
    detailCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
    detailCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${color}` } }
    detailCell.alignment = { vertical: 'middle', horizontal: 'center' }
    detailCell.border = { top: { style: 'thin', color: { argb: 'FFFFFFFF' } }, right: { style: 'medium', color: { argb: 'FFFFFFFF' } } }
    auditDetailColumns.forEach((label, detailIndex) => {
      const cell = comparison.getCell(3, detailStart + detailIndex)
      cell.value = label
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${color}` } }
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
      cell.border = {
        bottom: { style: 'thin', color: { argb: `FF${coral}` } },
        right: detailIndex === auditDetailColumns.length - 1 ? { style: 'medium', color: { argb: 'FFFFFFFF' } } : { style: 'thin', color: { argb: 'FFD9D9D9' } }
      }
    })
  })
  comparison.getRow(1).height = 25
  comparison.getRow(2).height = 22
  comparison.getRow(3).height = 32

  comparisonDates.forEach(dateKey => {
    const row = comparison.addRow([])
    row.getCell(1).value = new Date(`${dateKey}T12:00:00Z`)
    row.getCell(1).numFmt = 'd-mmm-yyyy'
    row.getCell(1).font = { bold: true, color: { argb: `FF${dark}` } }
    row.getCell(1).alignment = { horizontal: 'center' }
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F3F4' } }
    row.getCell(1).border = { bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } }, right: { style: 'medium', color: { argb: 'FFB8BDC0' } } }

    comparisonDomains.forEach((domain, domainIndex) => {
      const groupStart = 2 + domainIndex * comparisonGroupWidth
      const auditRecords = devices
        .map(([, historyDevice]) => latestByDateDomainDevice.get(`${dateKey}|${domain}|${historyDevice}`))
        .filter(Boolean)
        .sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))
      devices.forEach(([, historyDevice], deviceIndex) => {
        const record = latestByDateDomainDevice.get(`${dateKey}|${domain}|${historyDevice}`)
        const startColumn = groupStart + deviceIndex * metricColumns.length
        metricColumns.forEach(([, metricKey], metricIndex) => {
          const cell = row.getCell(startColumn + metricIndex)
          const value = record?.[metricKey]
          if (typeof value === 'number') {
            cell.value = value
            applyScoreStyle(cell, value)
          } else {
            cell.value = 'N/A'
            cell.font = { italic: true, color: { argb: 'FF7D858A' } }
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F3F4' } }
            cell.alignment = { horizontal: 'center' }
          }
          cell.border = {
            bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
            right: metricIndex === metricColumns.length - 1 ? { style: 'medium', color: { argb: 'FFB8BDC0' } } : { style: 'thin', color: { argb: 'FFE5E6E8' } }
          }
        })
      })
      const auditRecord = auditRecords[0]
      const detailStart = groupStart + devices.length * metricColumns.length
      const checkedCell = row.getCell(detailStart)
      const sourceCell = row.getCell(detailStart + 1)
      if (auditRecord) {
        checkedCell.value = auditRecord.dateOnly ? `${dateKey} (imported date only)` : new Date(auditRecord.checkedAt)
        if (!auditRecord.dateOnly) checkedCell.numFmt = 'd-mmm-yyyy h:mm AM/PM'
        sourceCell.value = auditRecord.url || ''
      } else {
        checkedCell.value = 'N/A'
        sourceCell.value = 'N/A'
        checkedCell.font = { italic: true, color: { argb: 'FF7D858A' } }
        sourceCell.font = { italic: true, color: { argb: 'FF7D858A' } }
      }
      for (const cell of [checkedCell, sourceCell]) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F8' } }
        cell.alignment = { horizontal: cell === checkedCell ? 'center' : 'left', vertical: 'middle' }
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } }, right: { style: cell === sourceCell ? 'medium' : 'thin', color: { argb: 'FFB8BDC0' } } }
      }
    })
  })
  if (!comparisonDates.length) {
    comparison.mergeCells(4, 1, 4, Math.max(1, totalComparisonColumns))
    comparison.getCell(4, 1).value = 'No completed scan history yet.'
    comparison.getCell(4, 1).font = { italic: true, color: { argb: 'FF7D858A' } }
    comparison.getCell(4, 1).alignment = { horizontal: 'center' }
  }
  comparison.getColumn(1).width = 15
  comparisonDomains.forEach((domain, domainIndex) => {
    const groupStart = 2 + domainIndex * comparisonGroupWidth
    for (let column = groupStart; column < groupStart + devices.length * metricColumns.length; column += 1) comparison.getColumn(column).width = 14
    comparison.getColumn(groupStart + devices.length * metricColumns.length).width = 28
    comparison.getColumn(groupStart + devices.length * metricColumns.length + 1).width = 48
  })
  comparison.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  comparison.headerFooter.oddFooter = '&LSTC Website Benchmark&CPage &P of &N&RGenerated in Kuwait time'

  const summary = workbook.addWorksheet('All History', { views: [{ state: 'frozen', ySplit: 4 }] })
  summary.mergeCells('A1:J1')
  summary.getCell('A1').value = 'Website Benchmark Score History'
  summary.getCell('A1').font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } }
  summary.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${purple}` } }
  summary.getCell('A1').alignment = { vertical: 'middle' }
  summary.getRow(1).height = 34
  summary.mergeCells('A2:J2')
  summary.getCell('A2').value = `Generated ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kuwait' })} · Asia/Kuwait · ${rows.length} history records`
  summary.getCell('A2').font = { size: 9, color: { argb: 'FF6F777C' } }
  const summaryHeaders = ['Website', 'Page', 'Device', 'Checked date & time', 'SEO', 'Best Practices', 'Accessibility', 'Performance', 'Overall', 'Source URL']
  summary.getRow(4).values = summaryHeaders
  applyHeader(summary.getRow(4))
  rows.forEach(record => {
    const canonicalWebsite = WEBSITE_META[record.domain]?.name || record.website || record.domain
    const canonicalPage = WEBSITE_META[record.domain]?.page || record.page
    const row = summary.addRow([canonicalWebsite, canonicalPage, record.device, record.dateOnly ? `${historyDateKey(record.checkedAt)} (imported date only)` : new Date(record.checkedAt), record.seo, record.bestPractices, record.accessibility, record.performance, record.overall, record.url])
    if (!record.dateOnly) row.getCell(4).numFmt = 'd-mmm-yyyy h:mm AM/PM'
    for (let column = 5; column <= 9; column += 1) applyScoreStyle(row.getCell(column), row.getCell(column).value)
  })
  summary.autoFilter = { from: 'A4', to: 'J4' }
  summary.columns = [{ width: 22 }, { width: 22 }, { width: 12 }, { width: 23 }, { width: 10 }, { width: 16 }, { width: 15 }, { width: 14 }, { width: 11 }, { width: 42 }]

  for (const domain of domainOrder) {
    const meta = WEBSITE_META[domain] || { name: domain, page: '/', sheet: domain.slice(0, 18) }
    for (const device of ['Mobile', 'Web']) {
      const sheet = workbook.addWorksheet(`${meta.sheet} ${device}`.slice(0, 31), { views: [{ state: 'frozen', ySplit: 4 }] })
      sheet.mergeCells('A1:F1')
      sheet.getCell('A1').value = `${meta.name} ${device} Page — ${meta.page}`
      sheet.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } }
      sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${purple}` } }
      sheet.getRow(1).height = 30
      sheet.getRow(3).values = ['Date', 'SEO', 'Best Practices', 'Accessibility', 'Performance', 'Overall']
      applyHeader(sheet.getRow(3))
      const deviceRows = rows.filter(record => record.domain === domain && record.device === device).sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt))
      deviceRows.forEach(record => {
        const row = sheet.addRow([new Date(record.checkedAt), record.seo, record.bestPractices, record.accessibility, record.performance, record.overall])
        row.getCell(1).numFmt = record.dateOnly ? 'd-mmm-yyyy' : 'd-mmm-yyyy h:mm AM/PM'
        for (let column = 2; column <= 6; column += 1) applyScoreStyle(row.getCell(column), row.getCell(column).value)
      })
      if (!deviceRows.length) {
        sheet.mergeCells('A4:F4')
        sheet.getCell('A4').value = 'No completed scan history yet.'
        sheet.getCell('A4').font = { italic: true, color: { argb: 'FF7D858A' } }
        sheet.getCell('A4').alignment = { horizontal: 'center' }
      }
      sheet.autoFilter = { from: 'A3', to: 'F3' }
      sheet.columns = [{ width: 24 }, { width: 11 }, { width: 17 }, { width: 16 }, { width: 15 }, { width: 12 }]
    }
  }
  return workbook.xlsx.writeBuffer()
}

function automationPlugin(apiKey, emailConfig, deploymentConfig = {}) {
  const bundledStateFile = path.join(process.cwd(), 'work', 'benchmark-automation-state.json')
  const isHostedRuntime = (process.env.NODE_ENV === 'production' || Boolean(process.env.PORT)) && process.env.HOME
  const defaultRuntimeDir = isHostedRuntime
    ? path.join(process.env.HOME, '.webpulse-benchmark')
    : path.join(process.cwd(), 'work')
  const runtimeDir = process.env.BENCHMARK_DATA_DIR || defaultRuntimeDir
  const stateFile = path.join(runtimeDir, 'benchmark-automation-state.json')
  const settingsFile = path.join(runtimeDir, 'benchmark-email-settings.json')
  const historyBackupFile = path.join(runtimeDir, 'website-benchmark-score-history.xlsx')
  const transporter = createGmailTransporter(emailConfig)
  let timer = null
  let monthlyTimer = null
  let running = null
  let individualRunning = null
  let state = {
    status: 'idle', standardUrls: STANDARD_URLS, sites: [], issues: [], progress: [], history: [],
    lastAttemptAt: null, lastCompletedAt: null, nextRunAt: nextKuwaitRun(),
    error: null, emailStatus: null, historyEmailStatus: null, nextHistoryEmailAt: null
  }
  let settings = {
    recipients: deploymentConfig.recipients || [], schedule: 'Daily summary', time: deploymentConfig.time || '15:00', day: 'Sunday', enabled: true,
    autoSendAfterCheck: deploymentConfig.autoSendAfterCheck === true, reportType: 'benchmark', monthlyHistoryEnabled: true, lastMonthlyHistoryPeriod: null
  }
  let initialized = false
  let initializationError = null
  const workerRepository = String(deploymentConfig.lighthouseWorkerRepository || '')
  const workerConfigured = /^[\w.-]+\/[\w.-]+$/.test(workerRepository) && Boolean(deploymentConfig.githubActionsToken && deploymentConfig.lighthouseCallbackToken && deploymentConfig.publicAppUrl)
  const pendingWorkerRuns = new Map()

  const persistState = () => writeJson(stateFile, state)
  const persistSettings = () => writeJson(settingsFile, settings)
  const persistHistoryBackup = async () => {
    await mkdir(path.dirname(historyBackupFile), { recursive: true })
    await writeFile(historyBackupFile, Buffer.from(await buildHistoryWorkbook(state.history || [])))
  }

  function verifyWorkerSignature(body, signature) {
    const expected = `sha256=${createHmac('sha256', deploymentConfig.lighthouseCallbackToken).update(body).digest('hex')}`
    const supplied = String(signature || '')
    return supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  }

  async function runGitHubLighthouse(url) {
    if (!workerConfigured) throw new Error('GitHub Lighthouse worker is not configured.')
    const requestId = randomUUID()
    let resolveRun
    let rejectRun
    const result = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject })
    const timer = setTimeout(() => {
      pendingWorkerRuns.delete(requestId)
      rejectRun(new Error('GitHub Lighthouse worker timed out after 12 minutes.'))
    }, 12 * 60 * 1000)
    pendingWorkerRuns.set(requestId, { url: new URL(url).href, resolve: resolveRun, reject: rejectRun, timer })

    const callbackUrl = new URL('/api/lighthouse-worker/callback', deploymentConfig.publicAppUrl).href
    let response
    try {
      response = await fetch(`https://api.github.com/repos/${workerRepository}/actions/workflows/lighthouse-worker.yml/dispatches`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${deploymentConfig.githubActionsToken}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({
          ref: deploymentConfig.lighthouseWorkerRef || 'main',
          inputs: { request_id: requestId, url: new URL(url).href, callback_url: callbackUrl }
        })
      })
    } catch (error) {
      clearTimeout(timer)
      pendingWorkerRuns.delete(requestId)
      throw error
    }
    if (!response.ok) {
      clearTimeout(timer)
      pendingWorkerRuns.delete(requestId)
      throw new Error(`GitHub Lighthouse worker dispatch failed with HTTP ${response.status}.`)
    }
    return workerPayloadToAnalysis(await result, url)
  }

  async function deliverHistoryReport(recipients, trigger, selectedHistory = state.history) {
    if (!Array.isArray(selectedHistory) || !selectedHistory.length) throw new Error('No score history is available to send.')
    if (!recipients.length) throw new Error('No saved recipients.')
    if (!transporter) throw new Error('Gmail is not configured.')
    await transporter.verify()
    await sendHistoryEmail(transporter, emailConfig, recipients, selectedHistory)
    state.historyEmailStatus = { status: 'sent', trigger, sentAt: new Date().toISOString(), recipients: recipients.length }
    await persistState()
  }

  async function runScheduledHistoryReport() {
    const period = dueMonthlyHistoryPeriod(settings.time)
    if (!period || period === settings.lastMonthlyHistoryPeriod || !settings.monthlyHistoryEnabled) return
    const recipients = Array.isArray(settings.recipients) ? settings.recipients.filter(Boolean) : []
    try {
      await deliverHistoryReport(recipients, 'monthly')
      settings.lastMonthlyHistoryPeriod = period
      await persistSettings()
    } catch (error) {
      state.historyEmailStatus = { status: 'failed', trigger: 'monthly', message: cleanText(error.message || 'Monthly history email failed.') }
      await persistState()
    }
  }

  async function initialize() {
    const bundledState = await readJson(bundledStateFile, state)
    state = await readJson(stateFile, bundledState)
    const legacyHistory = await readLegacyHistory()
    const resumeInterruptedRun = state.status === 'running'
    settings = { ...settings, ...await readJson(settingsFile, {}) }
    if (!settings.recipients.length && deploymentConfig.recipients?.length) settings.recipients = deploymentConfig.recipients
    settings.autoSendAfterCheck = settings.autoSendAfterCheck === true
    settings.monthlyHistoryEnabled = settings.monthlyHistoryEnabled !== false
    settings.reportType = settings.reportType === 'history' ? 'history' : 'benchmark'
    state.standardUrls = STANDARD_URLS
    state.history = mergeHistory(legacyHistory, Array.isArray(state.history) ? state.history : [])
    const seedSites = [...(Array.isArray(state.sites) ? state.sites : []), ...(state.progress || []).map(item => item.latestSite).filter(Boolean)]
    state.history = mergeHistory(state.history, seedSites.flatMap(historyRecordsForSite))
    state.nextRunAt = nextKuwaitRun(settings.time)
    await persistState()
    await persistHistoryBackup()
    initialized = true
    initializationError = null
    scheduleNextRun()
    scheduleMonthlyHistoryRun()
    if (dueMonthlyHistoryPeriod(settings.time) && settings.lastMonthlyHistoryPeriod !== dueMonthlyHistoryPeriod(settings.time)) {
      runScheduledHistoryReport().finally(scheduleMonthlyHistoryRun)
    }
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

  function scheduleMonthlyHistoryRun() {
    if (monthlyTimer) clearTimeout(monthlyTimer)
    if (!settings.monthlyHistoryEnabled) {
      state.nextHistoryEmailAt = null
      persistState().catch(() => {})
      return
    }
    const nextRunAt = nextMonthlyHistoryRun(settings.time)
    const target = new Date(nextRunAt).getTime()
    state.nextHistoryEmailAt = nextRunAt
    persistState().catch(() => {})
    const remaining = Math.max(1_000, target - Date.now())
    monthlyTimer = setTimeout(() => {
      if (Date.now() + 1_000 < target) return scheduleMonthlyHistoryRun()
      runScheduledHistoryReport().finally(scheduleMonthlyHistoryRun)
    }, Math.min(remaining, 2_147_000_000))
  }

  async function runAutomation(trigger) {
    if (running || individualRunning) return running || individualRunning
    running = (async () => {
      const stagedSites = []
      const stagedIssues = []
      const failures = []
      const resetSites = STANDARD_URLS.map(zeroScoreSite)
      state = {
        ...state, status: 'running', trigger, lastAttemptAt: new Date().toISOString(),
        error: null, emailStatus: null, individualRun: null, sites: resetSites, issues: [],
        progress: STANDARD_URLS.map((url, index) => ({
          url,
          domain: resetSites[index].domain,
          status: 'queued',
          attempt: 0,
          overall: 0,
          checkedAt: null,
          latestSite: resetSites[index]
        }))
      }
      await persistState()
      try {
        for (let index = 0; index < STANDARD_URLS.length; index += 1) {
          const url = STANDARD_URLS[index]
          const canUseWorker = workerConfigured && new URL(url).hostname.replace(/^www\./, '') === 'kw.zain.com'
          let result = null
          let lastError = null
          for (let attempt = 1; attempt <= (canUseWorker ? 1 : 2); attempt += 1) {
            state.progress[index] = { ...state.progress[index], status: 'scanning', attempt }
            await persistState()
            try {
              const candidate = await analyzeWebsite(url, apiKey, deploymentConfig.lighthouseFallbackMode)
              if (!hasCompleteScoreMatrix(candidate.site)) throw new Error('Mobile or Web score columns are incomplete.')
              result = candidate
              break
            } catch (error) { lastError = error }
          }
          if (!result && canUseWorker) {
            state.progress[index] = { ...state.progress[index], status: 'scanning', message: 'Waiting for GitHub Actions Lighthouse.' }
            await persistState()
            try { result = await runGitHubLighthouse(url) } catch (error) { lastError = error }
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
          state.history = mergeHistory(state.history, historyRecordsForSite(result.site))
          state.sites[index] = result.site
          state.issues = [...stagedIssues]
          state.progress[index] = { ...state.progress[index], domain: result.site.domain, status: 'complete', overall: result.site.overall, checkedAt: result.site.scannedAt, latestSite: result.site }
          await persistState()
          await persistHistoryBackup()
        }

        if (failures.length) throw new Error(failures.join(' | '))

        const completedAt = new Date().toISOString()
        state = { ...state, status: 'completed', sites: stagedSites, issues: stagedIssues, lastCompletedAt: completedAt, error: null }
        await persistState()

        const recipients = Array.isArray(settings.recipients) ? settings.recipients.filter(Boolean) : []
        const shouldSendEmail = trigger === 'scheduled' || (trigger === 'manual' && settings.autoSendAfterCheck)
        if (!shouldSendEmail) {
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

  async function runIndividualAutomation(url, canSendEmail) {
    if (running || individualRunning) throw new Error('Another score check is already running.')
    const index = standardUrlIndex(url)
    if (index < 0) throw new Error('Choose one of the six standard website URLs.')
    const standardUrl = STANDARD_URLS[index]
    const domain = new URL(standardUrl).hostname.replace(/^www\./, '')
    individualRunning = (async () => {
      const startedAt = new Date().toISOString()
      const zeroSite = zeroScoreSite(standardUrl, index)
      state.sites[index] = zeroSite
      state.issues = state.issues.filter(issue => issue.site !== domain)
      state.progress[index] = { url: standardUrl, domain, status: 'scanning', attempt: 1, overall: 0, checkedAt: null, latestSite: zeroSite }
      state.individualRun = { url: standardUrl, domain, status: 'running', startedAt, updatedAt: startedAt, error: null }
      await persistState()
      try {
        let result
        let lastError
        const canUseWorker = workerConfigured && domain === 'kw.zain.com'
        for (let attempt = 1; attempt <= (canUseWorker ? 1 : 2); attempt += 1) {
          state.progress[index] = { ...state.progress[index], status: 'scanning', attempt }
          await persistState()
          try {
            const candidate = await analyzeWebsite(standardUrl, apiKey, deploymentConfig.lighthouseFallbackMode)
            if (!hasCompleteScoreMatrix(candidate.site)) throw new Error('Mobile or Web score columns are incomplete.')
            result = candidate
            break
          } catch (error) { lastError = error }
        }
        if (!result && canUseWorker) {
          state.progress[index] = { ...state.progress[index], message: 'Waiting for GitHub Actions Lighthouse.' }
          await persistState()
          try { result = await runGitHubLighthouse(standardUrl) } catch (error) { lastError = error }
        }
        if (!result) throw lastError || new Error('Score check failed.')

        result.site.standardUrl = standardUrl
        result.site.scannedAt = new Date().toISOString()
        state.sites[index] = result.site
        state.issues = [...state.issues.filter(issue => issue.site !== domain), ...result.issues]
        state.history = mergeHistory(state.history, historyRecordsForSite(result.site))
        state.progress[index] = { ...state.progress[index], status: 'complete', overall: result.site.overall, checkedAt: result.site.scannedAt, latestSite: result.site, message: null }
        const completedAt = new Date().toISOString()
        state.individualRun = { url: standardUrl, domain, status: 'completed', startedAt, completedAt, updatedAt: completedAt, error: null }

        if (STANDARD_URLS.every((item, siteIndex) => state.progress[siteIndex]?.status === 'complete' && hasCompleteScoreMatrix(state.sites[siteIndex]))) {
          state.status = 'completed'
          state.lastCompletedAt = completedAt
          state.error = null
          if (settings.autoSendAfterCheck && canSendEmail) {
            const recipients = Array.isArray(settings.recipients) ? settings.recipients.filter(Boolean) : []
            if (recipients.length && transporter) {
              try {
                await transporter.verify()
                await sendMatrixEmail(transporter, emailConfig, recipients, state.sites)
                state.emailStatus = { status: 'sent', sentAt: completedAt, recipients: recipients.length }
              } catch (error) { state.emailStatus = { status: 'failed', message: cleanText(error.message || 'Email delivery failed.') } }
            } else state.emailStatus = { status: 'skipped', message: recipients.length ? 'Gmail is not configured.' : 'No saved recipients.' }
          } else state.emailStatus = { status: 'skipped', message: 'Website score check completed. Use Send report now if needed.' }
        } else {
          const remainingFailures = state.progress.filter(item => item?.status === 'failed').map(item => `${item.domain}: ${item.message || 'Score check failed.'}`)
          state.status = 'failed'
          state.error = remainingFailures.join(' | ') || 'One or more website score columns are incomplete.'
          state.emailStatus = { status: 'blocked', message: 'Email not sent because the complete score matrix was not available.' }
        }
        await persistState()
        await persistHistoryBackup()
      } catch (error) {
        const failedAt = new Date().toISOString()
        const message = cleanText(error.message || 'Score check failed.')
        state.progress[index] = { ...state.progress[index], status: 'failed', overall: 0, checkedAt: null, message }
        state.individualRun = { url: standardUrl, domain, status: 'failed', startedAt, failedAt, updatedAt: failedAt, error: message }
        state.status = 'failed'
        state.error = `${domain}: ${message}`
        state.emailStatus = { status: 'blocked', message: 'Email not sent because the complete score matrix was not available.' }
        await persistState()
      } finally { individualRunning = null }
    })()
    return individualRunning
  }

  const handler = async (req, res, next) => {
    const requestPath = req.url?.split('?')[0]
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'POST' && requestPath === '/api/lighthouse-worker/callback') {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 250_000) {
          res.statusCode = 413
          return res.end(JSON.stringify({ error: 'Worker callback is too large.' }))
        }
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (!workerConfigured || !verifyWorkerSignature(body, req.headers['x-benchmark-signature'])) {
        res.statusCode = 401
        return res.end(JSON.stringify({ error: 'Invalid worker signature.' }))
      }
      let payload
      try { payload = JSON.parse(body) } catch {
        res.statusCode = 400
        return res.end(JSON.stringify({ error: 'Invalid worker callback JSON.' }))
      }
      const pending = pendingWorkerRuns.get(String(payload.requestId || ''))
      if (!pending) {
        res.statusCode = 202
        return res.end(JSON.stringify({ accepted: false, reason: 'Worker request is no longer active.' }))
      }
      clearTimeout(pending.timer)
      pendingWorkerRuns.delete(payload.requestId)
      if (payload.ok === true && payload.url === pending.url) pending.resolve(payload)
      else pending.reject(new Error(cleanText(payload.error || 'GitHub Lighthouse worker failed.')))
      res.statusCode = 202
      return res.end(JSON.stringify({ accepted: true }))
    }
    if (req.method === 'GET' && requestPath === '/api/health') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.statusCode = initialized ? 200 : 503
      return res.end(JSON.stringify({
        status: initialized ? 'ok' : 'starting', runtime: 'node', initialized,
        pageSpeedConfigured: Boolean(apiKey), emailConfigured: Boolean(transporter),
        authConfigured: deploymentConfig.authConfigured === true,
        lighthouseFallbackMode: deploymentConfig.lighthouseFallbackMode,
        lighthouseWorkerConfigured: workerConfigured,
        schedulerEnabled: true, persistence: initialized ? 'writable' : 'pending',
        historyCount: state.history?.length || 0,
        error: initializationError
      }))
    }
    if (req.method === 'GET' && requestPath === '/api/automation-state') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      const { history, ...publicState } = state
      return res.end(JSON.stringify({ ...publicState, historyCount: history?.length || 0 }))
    }
    if (req.method === 'GET' && requestPath === '/api/history') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      return res.end(JSON.stringify({ history: state.history || [], total: state.history?.length || 0 }))
    }
    if (req.method === 'GET' && requestPath === '/api/history.xlsx') {
      try {
        const workbook = await buildHistoryWorkbook(state.history || [])
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', `attachment; filename="website-benchmark-history-${new Date().toISOString().slice(0, 10)}.xlsx"`)
        res.setHeader('Content-Length', workbook.byteLength)
        return res.end(Buffer.from(workbook))
      } catch (error) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        return res.end(JSON.stringify({ error: cleanText(error.message || 'Unable to generate Excel history.') }))
      }
    }
    if (req.method === 'GET' && requestPath === '/api/email-settings') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      return res.end(JSON.stringify({ ...settings, nextMonthlyHistoryRunAt: state.nextHistoryEmailAt }))
    }
    if (req.method === 'POST' && requestPath === '/api/email-settings') {
      try {
        let body = ''
        for await (const chunk of req) body += chunk
        const next = JSON.parse(body || '{}')
        const recipients = Array.isArray(next.recipients) ? [...new Set(next.recipients.map(value => String(value).trim().toLowerCase()).filter(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))] : []
        settings = {
          ...settings,
          ...next,
          schedule: 'Daily summary',
          recipients,
          autoSendAfterCheck: next.autoSendAfterCheck === undefined ? settings.autoSendAfterCheck : next.autoSendAfterCheck === true,
          reportType: next.reportType === undefined ? settings.reportType : next.reportType === 'history' ? 'history' : 'benchmark',
          monthlyHistoryEnabled: next.monthlyHistoryEnabled === undefined ? settings.monthlyHistoryEnabled : next.monthlyHistoryEnabled !== false
        }
        await persistSettings()
        scheduleNextRun()
        scheduleMonthlyHistoryRun()
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        return res.end(JSON.stringify({ ...settings, nextMonthlyHistoryRunAt: state.nextHistoryEmailAt }))
      } catch (error) {
        res.statusCode = 400
        return res.end(JSON.stringify({ error: cleanText(error.message) }))
      }
    }
    if (req.method === 'POST' && requestPath === '/api/automation/run') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (running || individualRunning) {
        res.statusCode = 409
        return res.end(JSON.stringify({ error: 'Another score check is already running.' }))
      }
      const canSendEmail = req.benchmarkUser?.role === 'admin' || req.benchmarkPermissions?.canSendEmail === true
      runAutomation(canSendEmail ? 'manual' : 'manual-no-email').catch(() => {})
      res.statusCode = 202
      return res.end(JSON.stringify({ started: true }))
    }
    if (req.method === 'POST' && requestPath === '/api/automation/run-one') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (running || individualRunning) {
        res.statusCode = 409
        return res.end(JSON.stringify({ error: 'Another score check is already running.' }))
      }
      try {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 2_048) throw new Error('Request is too large.')
        }
        const { url } = JSON.parse(body || '{}')
        if (standardUrlIndex(url) < 0) throw new Error('Choose one of the six standard website URLs.')
        const canSendEmail = req.benchmarkUser?.role === 'admin' || req.benchmarkPermissions?.canSendEmail === true
        runIndividualAutomation(url, canSendEmail).catch(() => {})
        res.statusCode = 202
        return res.end(JSON.stringify({ started: true, url: new URL(url).href }))
      } catch (error) {
        res.statusCode = 400
        return res.end(JSON.stringify({ error: cleanText(error.message || 'Unable to start the website score check.') }))
      }
    }
    if (req.method === 'POST' && requestPath === '/api/history-email-report') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      try {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 100_000) throw new Error('Email request is too large.')
        }
        const parsed = JSON.parse(body || '{}')
        const recipients = String(parsed.recipient || '').split(',').map(value => value.trim()).filter(Boolean)
        if (!recipients.length || recipients.some(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) throw new Error('Enter valid recipient email addresses.')
        const selectedHistory = filterHistoryByDateRange(state.history || [], parsed.dateFrom, parsed.dateTo)
        if (!selectedHistory.length) throw new Error('No score history is available in the selected date range.')
        await deliverHistoryReport(recipients, 'manual', selectedHistory)
        return res.end(JSON.stringify({ sent: true, reportType: 'history', recipients, dateFrom: parsed.dateFrom || null, dateTo: parsed.dateTo || null, records: selectedHistory.length }))
      } catch (error) {
        res.statusCode = /valid recipient|too large|From date/i.test(error.message || '') ? 400 : /not configured/i.test(error.message || '') ? 503 : /No score history/i.test(error.message || '') ? 404 : 500
        const authError = ['EAUTH', '535'].some(code => String(error.code || error.responseCode || '').includes(code))
        return res.end(JSON.stringify({ error: authError ? 'Gmail rejected the App Password. Generate a new App Password and update .env.local.' : cleanText(error.message) || 'Score History Report delivery failed.' }))
      }
    }
    return next()
  }

  const configure = server => {
    server.middlewares.use(handler)
    initialize().catch(error => {
      initializationError = cleanText(error.message)
      state = { ...state, status: 'failed', error: initializationError }
    })
    server.httpServer?.once('close', () => {
      if (timer) clearTimeout(timer)
      if (monthlyTimer) clearTimeout(monthlyTimer)
      for (const pending of pendingWorkerRuns.values()) { clearTimeout(pending.timer); pending.reject(new Error('Application stopped before Lighthouse worker completed.')) }
      pendingWorkerRuns.clear()
    })
  }
  return { name: 'daily-benchmark-automation', configureServer: configure, configurePreviewServer: configure }
}

function publicSnapshotPlugin() {
  return {
    name: 'public-benchmark-snapshot',
    apply: 'build',
    async generateBundle() {
      const saved = await readJson(path.join(process.cwd(), 'work', 'benchmark-automation-state.json'), {})
      const history = mergeHistory(await readLegacyHistory(), Array.isArray(saved.history) ? saved.history : [])
      const { history: ignoredHistory, ...publicState } = saved
      this.emitFile({
        type: 'asset',
        fileName: 'benchmark-automation-state.json',
        source: JSON.stringify({ ...publicState, historyCount: history.length, hostingMode: 'static-snapshot' })
      })
      this.emitFile({ type: 'asset', fileName: 'benchmark-history.json', source: JSON.stringify({ history, total: history.length }) })
      const workbook = Buffer.from(await buildHistoryWorkbook(history))
      this.emitFile({ type: 'asset', fileName: 'website-benchmark-score-history.xlsx', source: workbook })
      this.emitFile({ type: 'asset', fileName: 'benchmark-history-workbook.json', source: JSON.stringify({ base64: workbook.toString('base64') }) })
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const fallbackMode = String(env.LIGHTHOUSE_FALLBACK_MODE || process.env.LIGHTHOUSE_FALLBACK_MODE || (mode === 'production' ? 'managed' : 'direct')).toLowerCase()
  const emailConfig = { user: env.SMTP_USER, password: env.SMTP_APP_PASSWORD }
  const accessConfig = {
    adminEmail: env.ADMIN_EMAIL || env.SMTP_USER,
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPassword: env.ADMIN_PASSWORD,
    publicAppUrl: env.PUBLIC_APP_URL,
    notificationsEnabled: String(env.ACCESS_EMAIL_NOTIFICATIONS || 'true').toLowerCase() !== 'false',
    smtpUser: env.SMTP_USER,
    smtpPassword: env.SMTP_APP_PASSWORD
  }
  const deploymentConfig = {
    recipients: [...new Set(String(env.EMAIL_RECIPIENTS || '').split(',').map(value => value.trim().toLowerCase()).filter(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))],
    time: /^([01]\d|2[0-3]):([0-5]\d)$/.test(env.REPORT_TIME || '') ? env.REPORT_TIME : '15:00',
    autoSendAfterCheck: String(env.AUTO_SEND_AFTER_CHECK || 'true').toLowerCase() === 'true',
    authConfigured: Boolean(env.ADMIN_PASSWORD && (env.ADMIN_EMAIL || env.SMTP_USER)),
    lighthouseFallbackMode: fallbackMode === 'managed' ? 'managed' : 'direct',
    githubActionsToken: env.GITHUB_ACTIONS_TOKEN || process.env.GITHUB_ACTIONS_TOKEN,
    lighthouseCallbackToken: env.LIGHTHOUSE_CALLBACK_TOKEN || process.env.LIGHTHOUSE_CALLBACK_TOKEN,
    lighthouseWorkerRepository: env.LIGHTHOUSE_WORKER_REPOSITORY || process.env.LIGHTHOUSE_WORKER_REPOSITORY || 'thearjunks/AK-benchmark',
    lighthouseWorkerRef: env.LIGHTHOUSE_WORKER_REF || process.env.LIGHTHOUSE_WORKER_REF || 'main',
    publicAppUrl: env.PUBLIC_APP_URL || process.env.PUBLIC_APP_URL
  }
  return {
    preview: {
      allowedHosts: ['bench.stcdigitalhub.com']
    },
    plugins: [
      authPlugin(accessConfig),
      react(),
      pageSpeedPlugin(env.GOOGLE_PAGESPEED_API_KEY, deploymentConfig.lighthouseFallbackMode),
      emailReportPlugin(emailConfig),
      automationPlugin(env.GOOGLE_PAGESPEED_API_KEY, emailConfig, deploymentConfig),
      ...(String(env.STATIC_SNAPSHOT_EXPORT || '').toLowerCase() === 'true' ? [publicSnapshotPlugin()] : [])
    ]
  }
})
