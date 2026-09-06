import assert from 'node:assert/strict'
import { automatedEmailPhases, automationAuditPhases, automationAuditPlan, automationTimingPolicy, buildMatrixEmail, classifyBatchFailures, historyRecordsForSite, shouldQueueScheduledRun } from '../vite.config.js'

const phases = automationAuditPhases()
assert.deepEqual(phases.primaryIndices, [0, 2, 3, 4, 1])
assert.equal(phases.zainIndex, 5)
assert.deepEqual(automationAuditPlan(true), [
  { domain: 'stc.com.kw', provider: 'pagespeed', fallback: 'lighthouse' },
  { domain: 'ooredoo.com.kw', provider: 'pagespeed', fallback: 'lighthouse' },
  { domain: 'stc.com.sa', provider: 'pagespeed', fallback: 'lighthouse' },
  { domain: 'stc.com.bh', provider: 'pagespeed', fallback: 'lighthouse' },
  { domain: 'virgin.com', provider: 'pagespeed', fallback: 'lighthouse' },
  { domain: 'kw.zain.com', provider: 'pagespeed', fallback: 'lighthouse' }
])
assert.deepEqual(automationAuditPlan(false).at(-1), { domain: 'kw.zain.com', provider: 'pagespeed', fallback: 'lighthouse' })
assert.deepEqual(automatedEmailPhases({ zainPageSpeedSucceeded: true }), ['daily'])
assert.deepEqual(automatedEmailPhases({ zainPageSpeedSucceeded: false, zainLighthouseSucceeded: false }), ['initial'])
assert.deepEqual(automatedEmailPhases({ zainPageSpeedSucceeded: false, zainLighthouseSucceeded: true }), ['initial', 'updated'])
assert.equal(shouldQueueScheduledRun('scheduled', true), true)
assert.equal(shouldQueueScheduledRun('manual', true), false)
assert.equal(shouldQueueScheduledRun('scheduled', false), false)
const timing = automationTimingPolicy()
assert.equal(timing.batchBudgetMs, 20 * 60 * 1000)
assert.equal(timing.primaryConcurrency, 2)
assert.equal(timing.providerAttempts, 1)
assert.equal(timing.siteAttempts, 1)
assert.ok(timing.pageSpeedTimeoutMs <= 90_000)
assert.ok(timing.lighthouseTimeoutMs <= 120_000)

const zainOnly = classifyBatchFailures([{ domain: 'kw.zain.com', message: 'audit unavailable' }])
assert.equal(zainOnly.canSend, true)
assert.equal(zainOnly.tolerated.length, 1)
assert.equal(zainOnly.blocking.length, 0)

const otherFailure = classifyBatchFailures([
  { domain: 'kw.zain.com', message: 'audit unavailable' },
  { domain: 'stc.com.kw', message: 'audit unavailable' }
])
assert.equal(otherFailure.canSend, true)
assert.equal(otherFailure.tolerated.length, 2)
assert.equal(otherFailure.blocking.length, 0)

const scores = { performance: 91, accessibility: 96, bestPractices: 69, seo: 100 }
const sites = [
  {
    domain: 'stc.com.kw', overall: 89,
    coverage: { mobile: true, desktop: true },
    deviceScores: { mobile: scores, desktop: scores }
  },
  {
    domain: 'kw.zain.com', overall: 0, auditUnavailable: true,
    coverage: { mobile: false, desktop: false },
    deviceScores: {
      mobile: { performance: 0, accessibility: 0, bestPractices: 0, seo: 0 },
      desktop: { performance: 0, accessibility: 0, bestPractices: 0, seo: 0 }
    }
  }
]
const report = buildMatrixEmail(sites)
assert.match(report.html, /Partial or unavailable this run/)
assert.match(report.html, />N\/A</)
assert.match(report.text, /stc\.com\.kw — Overall 89/)
assert.match(report.text, /kw\.zain\.com — Overall N\/A \(partial or unavailable this run\)/)
assert.match(report.text, /Performance: Mobile 91 \| Web 91/)
assert.match(report.text, /Performance: Mobile N\/A \| Web N\/A/)

const initialReport = buildMatrixEmail([sites[0], { ...sites[1], auditUnavailable: false, pending: true }])
assert.match(initialReport.html, /Extended audit pending/)
assert.match(initialReport.text, /kw\.zain\.com — Overall N\/A \(extended audit pending\)/)

const partialZain = {
  ...sites[1],
  coverage: { mobile: true, desktop: false },
  deviceScores: { mobile: scores, desktop: sites[1].deviceScores.desktop },
  scannedAt: '2026-09-03T07:00:00.000Z',
  standardUrl: 'https://www.kw.zain.com/en/shop'
}
const partialReport = buildMatrixEmail([sites[0], partialZain])
assert.match(partialReport.text, /Performance: Mobile 91 \| Web N\/A/)
const partialHistory = historyRecordsForSite(partialZain)
assert.equal(partialHistory.length, 1)
assert.equal(partialHistory[0].device, 'Mobile')
assert.equal(partialHistory[0].performance, 91)

console.log('Partial report validation passed: Zain may be unavailable while completed website scores remain email-ready.')
