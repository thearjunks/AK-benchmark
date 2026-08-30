import assert from 'node:assert/strict'
import { mergeAuditAnalyses, standardUrlIndex } from '../vite.config.js'

assert.equal(standardUrlIndex('https://www.stc.com.kw/en'), 0)
assert.equal(standardUrlIndex('https://www.kw.zain.com/en/shop'), 1)
assert.equal(standardUrlIndex('https://www.ooredoo.com.kw/en'), 2)
assert.equal(standardUrlIndex('https://example.com'), -1)
assert.equal(standardUrlIndex('not a URL'), -1)

const partial = (device, source, performance) => ({
  site: {
    domain: 'kw.zain.com', url: 'https://www.kw.zain.com/en/shop', scores: { coreWebVitals: 70 },
    coverage: { mobile: device === 'mobile', desktop: device === 'desktop' },
    deviceScores: {
      mobile: device === 'mobile' ? { performance, accessibility: 90, bestPractices: 80, seo: 95 } : {},
      desktop: device === 'desktop' ? { performance, accessibility: 91, bestPractices: 81, seo: 96 } : {}
    },
    auditSources: { mobile: device === 'mobile' ? source : null, desktop: device === 'desktop' ? source : null }
  },
  issues: [{ device: device === 'mobile' ? 'Mobile' : 'Web', severity: 'Low' }]
})
const merged = mergeAuditAnalyses(
  partial('mobile', 'Google PageSpeed Insights', 42),
  partial('desktop', 'GitHub Actions Lighthouse', 67),
  'https://www.kw.zain.com/en/shop'
)
assert.equal(merged.site.coverage.mobile, true)
assert.equal(merged.site.coverage.desktop, true)
assert.equal(merged.site.deviceScores.mobile.performance, 42)
assert.equal(merged.site.deviceScores.desktop.performance, 67)
assert.equal(merged.site.auditSources.mobile, 'Google PageSpeed Insights')
assert.equal(merged.site.auditSources.desktop, 'GitHub Actions Lighthouse')
assert.equal(merged.issues.length, 2)

console.log('Single-site URL validation passed.')
