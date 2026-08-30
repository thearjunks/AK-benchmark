import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import lighthouse from 'lighthouse'
import { launch } from 'chrome-launcher'

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo']
const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 }

export function validateFinalUrl(value, expectedUrl) {
  const final = new URL(value)
  const expected = new URL(expectedUrl)
  if (final.hostname.replace(/^www\./, '') !== expected.hostname.replace(/^www\./, '')) throw new Error('Lighthouse reached a different domain.')
  if (/(?:error|login|signin|auth)[=_/-]?/i.test(`${final.pathname}${final.search}`)) throw new Error('Lighthouse reached a login or error page.')
  return final.href
}

function score(category, label) {
  if (typeof category?.score !== 'number') throw new Error(`Lighthouse did not return ${label}.`)
  return Math.round(category.score * 100)
}

function coreWebVitals(audits) {
  const values = ['largest-contentful-paint', 'cumulative-layout-shift', 'total-blocking-time']
    .map(key => audits[key]?.score)
    .filter(value => typeof value === 'number')
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) : null
}

function issuesFrom(lhr) {
  const auditCategories = new Map()
  for (const [categoryId, category] of Object.entries(lhr.categories || {})) {
    const label = categoryId === 'best-practices' ? 'Best practices' : categoryId === 'seo' ? 'SEO' : categoryId[0].toUpperCase() + categoryId.slice(1)
    for (const ref of category.auditRefs || []) if (!auditCategories.has(ref.id) || ref.weight > 0) auditCategories.set(ref.id, label)
  }
  return [...auditCategories.entries()].map(([id, category]) => {
    const audit = lhr.audits?.[id]
    if (!audit || typeof audit.score !== 'number' || audit.score >= 0.9 || ['manual', 'notApplicable', 'informative'].includes(audit.scoreDisplayMode)) return null
    const severity = audit.score <= 0.25 ? 'Critical' : audit.score <= 0.5 ? 'High' : audit.score <= 0.75 ? 'Medium' : 'Low'
    const savingsMs = Math.round(audit.details?.overallSavingsMs || 0)
    const gain = Math.max(1, Math.ceil((1 - audit.score) * 6))
    return {
      severity, category, title: audit.title || id,
      detail: audit.displayValue || audit.explanation || `Lighthouse audit score: ${Math.round(audit.score * 100)}/100.`,
      action: audit.description || 'Review this Lighthouse audit and apply the recommended remediation.',
      impact: savingsMs >= 100 ? `${(savingsMs / 1000).toFixed(1)}s` : `+${gain} ${gain === 1 ? 'pt' : 'pts'}`
    }
  }).filter(Boolean).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, 25)
}

async function audit(url, strategy) {
  const chrome = await launch({ chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--ignore-certificate-errors', '--window-size=1440,900'] })
  let auditTimer
  try {
    const mobile = strategy === 'mobile'
    const run = lighthouse(url, {
      port: chrome.port, output: 'json', logLevel: 'silent', onlyCategories: CATEGORIES,
      formFactor: mobile ? 'mobile' : 'desktop', throttlingMethod: 'simulate', maxWaitForLoad: 120_000,
      screenEmulation: mobile
        ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }
        : { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false }
    })
    const result = await Promise.race([run, new Promise((_, reject) => { auditTimer = setTimeout(() => reject(new Error(`${strategy} Lighthouse timed out.`)), 240_000) })])
    const lhr = result?.lhr
    if (!lhr) throw new Error(`${strategy} Lighthouse returned no report.`)
    if (lhr.runtimeError?.message) throw new Error(lhr.runtimeError.message)
    const finalUrl = validateFinalUrl(lhr.finalUrl || url, url)
    return {
      finalUrl, fetchTime: lhr.fetchTime || new Date().toISOString(), lighthouseVersion: lhr.lighthouseVersion || null,
      coreWebVitals: coreWebVitals(lhr.audits || {}),
      scores: {
        performance: score(lhr.categories?.performance, 'Performance'),
        accessibility: score(lhr.categories?.accessibility, 'Accessibility'),
        bestPractices: score(lhr.categories?.['best-practices'], 'Best Practices'),
        seo: score(lhr.categories?.seo, 'SEO')
      },
      issues: issuesFrom(lhr)
    }
  } finally {
    if (auditTimer) clearTimeout(auditTimer)
    await chrome.kill().catch(() => {})
  }
}

async function postCallback(callbackUrl, token, payload) {
  const body = JSON.stringify(payload)
  const signature = `sha256=${createHmac('sha256', token).update(body).digest('hex')}`
  const response = await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Benchmark-Signature': signature }, body })
  if (!response.ok) throw new Error(`Callback returned HTTP ${response.status}.`)
}

async function main() {
  if (process.argv.includes('--self-test')) {
    assert.match(validateFinalUrl('https://www.kw.zain.com/en/shop', 'https://www.kw.zain.com/en/shop'), /kw\.zain\.com/)
    assert.throws(() => validateFinalUrl('https://www.kw.zain.com/en/shop?error=login_required', 'https://www.kw.zain.com/en/shop'))
    assert.throws(() => validateFinalUrl('https://example.com/', 'https://www.kw.zain.com/en/shop'))
    console.log('Lighthouse worker validation passed.')
    return
  }

  const requestId = process.env.WORKER_REQUEST_ID
  const url = process.env.WORKER_URL
  const callbackUrl = new URL(process.env.WORKER_CALLBACK_URL)
  const token = process.env.LIGHTHOUSE_CALLBACK_TOKEN
  if (!requestId || !url || !token || callbackUrl.protocol !== 'https:' || callbackUrl.hostname !== 'bench.stcdigitalhub.com' || callbackUrl.pathname !== '/api/lighthouse-worker/callback') {
    throw new Error('Lighthouse worker inputs are invalid or incomplete.')
  }

  let payload
  try {
    payload = { requestId, url: new URL(url).href, ok: true, devices: { mobile: await audit(url, 'mobile'), desktop: await audit(url, 'desktop') } }
  } catch (error) {
    payload = { requestId, url: new URL(url).href, ok: false, error: String(error.message || 'Lighthouse worker failed.').replace(/\s+/g, ' ').trim() }
    process.exitCode = 1
  }
  await postCallback(callbackUrl.href, token, payload)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
