import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import nodemailer from 'nodemailer'
import ExcelJS from 'exceljs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

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

export function buildHistoryEmail(history) {
  const emailMetrics = [['seo', 'SEO'], ['bestPractices', 'Best practices'], ['accessibility', 'Accessibility'], ['performance', 'Performance'], ['overall', 'Overall']]
  const scoreStyle = value => {
    if (typeof value !== 'number') return 'background:#f4f4f5;color:#8b9296'
    if (value >= 90) return 'background:#e8f7f2;color:#007956'
    if (value >= 75) return 'background:#f0e7f6;color:#4f008c'
    if (value >= 60) return 'background:#fff3df;color:#a55e00'
    return 'background:#ffedf1;color:#c80025'
  }
  const dateKey = value => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kuwait', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(value)).map(part => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
  }
  const orderedDomains = STANDARD_URLS.map(url => new URL(url).hostname.replace(/^www\./, ''))
  const extraDomains = [...new Set(history.map(record => record.domain))].filter(domain => !orderedDomains.includes(domain))
  const domains = [...orderedDomains, ...extraDomains]
  const dates = [...new Set(history.map(record => dateKey(record.checkedAt)))].sort().reverse()
  const emailDates = dates.slice(0, 5)
  const latest = new Map()
  for (const record of [...history].sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt))) {
    latest.set(`${dateKey(record.checkedAt)}|${record.domain}|${record.device}`, record)
  }
  const groups = Array.from({ length: Math.ceil(domains.length / 3) }, (_, index) => domains.slice(index * 3, index * 3 + 3))
  const displayDate = value => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00Z`))
  const checkedAt = value => new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuwait', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value))
  const renderGroup = (group, groupIndex) => {
    const siteHeaders = group.map(domain => `<th style="padding:12px;border-left:1px solid #e5e6e8;text-align:left;min-width:190px"><div style="font-size:13px;color:#1d252d">${escapeHtml(domain)}</div><div style="font-size:10px;color:#7d858a;margin-top:3px">${escapeHtml(WEBSITE_META[domain]?.name || domain)}</div></th>`).join('')
    const dateRows = emailDates.map(date => {
      const metricRows = emailMetrics.map(([key, label]) => `<tr>
        <td style="padding:9px 12px;border-top:1px solid #e5e6e8;font-size:11px;font-weight:700;color:#1d252d">${escapeHtml(label)}</td>
        ${group.map(domain => {
          const mobile = latest.get(`${date}|${domain}|Mobile`)?.[key]
          const desktop = latest.get(`${date}|${domain}|Web`)?.[key]
          return `<td style="padding:7px;border-left:1px solid #e5e6e8;border-top:1px solid #e5e6e8"><table role="presentation" style="width:100%;border-spacing:5px 0"><tr><td style="${scoreStyle(mobile)};padding:8px;border-radius:6px;font-size:9px">Mobile <strong style="float:right;font-size:14px">${escapeHtml(mobile ?? 'N/A')}</strong></td><td style="${scoreStyle(desktop)};padding:8px;border-radius:6px;font-size:9px">Desktop <strong style="float:right;font-size:14px">${escapeHtml(desktop ?? 'N/A')}</strong></td></tr></table></td>`
        }).join('')}
      </tr>`).join('')
      const auditRow = `<tr><td style="padding:8px 12px;border-top:1px solid #e5e6e8;font-size:10px;font-weight:700;color:#596369">Checked</td>${group.map(domain => {
        const records = ['Mobile', 'Web'].map(device => latest.get(`${date}|${domain}|${device}`)).filter(Boolean).sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))
        const record = records[0]
        return `<td style="padding:8px 12px;border-left:1px solid #e5e6e8;border-top:1px solid #e5e6e8;font-size:9px;color:#6f777c">${record ? `${escapeHtml(checkedAt(record.checkedAt))}<br><a href="${escapeHtml(record.url || '')}" style="color:#4f008c">${escapeHtml(record.url || '')}</a>` : 'N/A'}</td>`
      }).join('')}</tr>`
      return `<tr><td colspan="${group.length + 1}" style="padding:8px 12px;background:#f4eff8;color:#4f008c;font-size:11px;font-weight:700;border-top:1px solid #d9c8e4">${escapeHtml(displayDate(date))}</td></tr>${metricRows}${auditRow}`
    }).join('')
    return `<div style="margin-top:${groupIndex ? '16px' : '0'};border:1px solid #e1e2e4;border-radius:10px;overflow:hidden"><div style="height:30px;line-height:30px;padding:0 12px;background:#4f008c;color:#fff;font-size:10px;font-weight:700;letter-spacing:.7px;text-transform:uppercase">Websites ${groupIndex * 3 + 1}–${groupIndex * 3 + group.length}</div><div style="overflow-x:auto"><table style="width:100%;min-width:760px;border-collapse:collapse"><thead><tr style="background:#fafafa"><th style="padding:12px;text-align:left;color:#737c81;font-size:10px;width:120px">Scan history</th>${siteHeaders}</tr></thead><tbody>${dateRows}</tbody></table></div></div>`
  }
  const generatedAt = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kuwait', dateStyle: 'medium', timeStyle: 'short' })
  const html = `<div style="font-family:Arial,sans-serif;color:#1d252d;max-width:900px;margin:auto;background:#f7f7f8;padding:20px"><div style="background:#fff;border:1px solid #dedfe1;border-radius:12px;overflow:hidden"><div style="padding:20px;border-bottom:1px solid #e5e6e8"><div style="font-size:10px;letter-spacing:1px;font-weight:700;color:#4f008c;text-transform:uppercase">Score history</div><div style="font-size:20px;font-weight:700;margin-top:5px">Website Score History Report</div><div style="font-size:11px;color:#7d858a;margin-top:5px">${domains.length} websites · ${dates.length} historical scan dates · Mobile and Desktop</div><div style="margin-top:10px;padding:9px 11px;border-radius:7px;background:#f4eff8;color:#4f008c;font-size:10px">Latest ${emailDates.length} scan dates are shown below. The complete Excel history is attached.</div></div><div style="padding:16px">${groups.map(renderGroup).join('')}</div><div style="padding:12px 20px;border-top:1px solid #e5e6e8;font-size:9px;color:#8b9296">Generated ${escapeHtml(generatedAt)} Kuwait time · Google PageSpeed Insights</div></div></div>`
  const text = `Website Score History Report\n\n${dates.map(date => `${displayDate(date)}\n${domains.map(domain => ['Mobile', 'Web'].map(device => { const record = latest.get(`${date}|${domain}|${device}`); return `${domain} ${device === 'Web' ? 'Desktop' : device}: ${emailMetrics.map(([key, label]) => `${label} ${record?.[key] ?? 'N/A'}`).join(' | ')}` }).join('\n')).join('\n')}`).join('\n\n')}`
  return { html, text, dates, domains }
}

async function sendHistoryEmail(transporter, config, recipients, history) {
  const { html, text, dates, domains } = buildHistoryEmail(history)
  if (!dates.length || !domains.length) throw new Error('No score history is available to send.')
  const workbook = await buildHistoryWorkbook(history)
  return transporter.sendMail({
    from: `STC Website Benchmark <${config.user}>`, to: recipients,
    subject: `Website Score History Report — ${dates.length} scan dates`,
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

async function buildHistoryWorkbook(history) {
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
        checkedCell.value = new Date(auditRecord.checkedAt)
        checkedCell.numFmt = 'd-mmm-yyyy h:mm AM/PM'
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
    const row = summary.addRow([canonicalWebsite, canonicalPage, record.device, new Date(record.checkedAt), record.seo, record.bestPractices, record.accessibility, record.performance, record.overall, record.url])
    row.getCell(4).numFmt = 'd-mmm-yyyy h:mm AM/PM'
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
        row.getCell(1).numFmt = 'd-mmm-yyyy h:mm AM/PM'
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
  const stateFile = path.join(process.cwd(), 'work', 'benchmark-automation-state.json')
  const settingsFile = path.join(process.cwd(), 'work', 'benchmark-email-settings.json')
  const transporter = createGmailTransporter(emailConfig)
  let timer = null
  let monthlyTimer = null
  let running = null
  let state = {
    status: 'idle', standardUrls: STANDARD_URLS, sites: [], issues: [], progress: [], history: [],
    lastAttemptAt: null, lastCompletedAt: null, nextRunAt: nextKuwaitRun(),
    error: null, emailStatus: null, historyEmailStatus: null, nextHistoryEmailAt: null
  }
  let settings = {
    recipients: deploymentConfig.recipients || [], schedule: 'Daily summary', time: deploymentConfig.time || '15:00', day: 'Sunday', enabled: true,
    autoSendAfterCheck: false, reportType: 'benchmark', monthlyHistoryEnabled: true, lastMonthlyHistoryPeriod: null
  }

  const persistState = () => writeJson(stateFile, state)
  const persistSettings = () => writeJson(settingsFile, settings)

  async function deliverHistoryReport(recipients, trigger) {
    if (!Array.isArray(state.history) || !state.history.length) throw new Error('No score history is available to send.')
    if (!recipients.length) throw new Error('No saved recipients.')
    if (!transporter) throw new Error('Gmail is not configured.')
    await transporter.verify()
    await sendHistoryEmail(transporter, emailConfig, recipients, state.history)
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
    state = await readJson(stateFile, state)
    const resumeInterruptedRun = state.status === 'running'
    settings = { ...settings, ...await readJson(settingsFile, {}) }
    if (!settings.recipients.length && deploymentConfig.recipients?.length) settings.recipients = deploymentConfig.recipients
    settings.autoSendAfterCheck = settings.autoSendAfterCheck === true
    settings.monthlyHistoryEnabled = settings.monthlyHistoryEnabled !== false
    settings.reportType = settings.reportType === 'history' ? 'history' : 'benchmark'
    state.standardUrls = STANDARD_URLS
    state.history = Array.isArray(state.history) ? state.history : []
    const seedSites = [...(Array.isArray(state.sites) ? state.sites : []), ...(state.progress || []).map(item => item.latestSite).filter(Boolean)]
    state.history = mergeHistory(state.history, seedSites.flatMap(historyRecordsForSite))
    state.nextRunAt = nextKuwaitRun(settings.time)
    await persistState()
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
          state.history = mergeHistory(state.history, historyRecordsForSite(result.site))
          state.progress[index] = { ...state.progress[index], domain: result.site.domain, status: 'complete', overall: result.site.overall, checkedAt: result.site.scannedAt, latestSite: result.site }
          await persistState()
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

  const handler = async (req, res, next) => {
    const requestPath = req.url?.split('?')[0]
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
      if (running) {
        res.statusCode = 409
        return res.end(JSON.stringify({ error: 'A full score check is already running.' }))
      }
      runAutomation('manual').catch(() => {})
      res.statusCode = 202
      return res.end(JSON.stringify({ started: true }))
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
        await deliverHistoryReport(recipients, 'manual')
        return res.end(JSON.stringify({ sent: true, reportType: 'history', recipients }))
      } catch (error) {
        res.statusCode = /valid recipient|too large/i.test(error.message || '') ? 400 : /not configured|No score history/i.test(error.message || '') ? 503 : 500
        const authError = ['EAUTH', '535'].some(code => String(error.code || error.responseCode || '').includes(code))
        return res.end(JSON.stringify({ error: authError ? 'Gmail rejected the App Password. Generate a new App Password and update .env.local.' : cleanText(error.message) || 'Score History Report delivery failed.' }))
      }
    }
    return next()
  }

  const configure = server => {
    server.middlewares.use(handler)
    initialize().catch(error => { state = { ...state, status: 'failed', error: cleanText(error.message) } })
    server.httpServer?.once('close', () => { if (timer) clearTimeout(timer); if (monthlyTimer) clearTimeout(monthlyTimer) })
  }
  return { name: 'daily-benchmark-automation', configureServer: configure, configurePreviewServer: configure }
}

function publicSnapshotPlugin() {
  return {
    name: 'public-benchmark-snapshot',
    apply: 'build',
    async generateBundle() {
      const saved = await readJson(path.join(process.cwd(), 'work', 'benchmark-automation-state.json'), {})
      const history = Array.isArray(saved.history) ? saved.history : []
      const { history: ignoredHistory, ...publicState } = saved
      this.emitFile({
        type: 'asset',
        fileName: 'benchmark-automation-state.json',
        source: JSON.stringify({ ...publicState, historyCount: history.length })
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
  const emailConfig = { user: env.SMTP_USER, password: env.SMTP_APP_PASSWORD }
  const deploymentConfig = {
    recipients: [...new Set(String(env.EMAIL_RECIPIENTS || '').split(',').map(value => value.trim().toLowerCase()).filter(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))],
    time: /^([01]\d|2[0-3]):([0-5]\d)$/.test(env.REPORT_TIME || '') ? env.REPORT_TIME : '15:00'
  }
  return {
    plugins: [
      react(),
      pageSpeedPlugin(env.GOOGLE_PAGESPEED_API_KEY),
      emailReportPlugin(emailConfig),
      automationPlugin(env.GOOGLE_PAGESPEED_API_KEY, emailConfig, deploymentConfig),
      publicSnapshotPlugin()
    ]
  }
})
