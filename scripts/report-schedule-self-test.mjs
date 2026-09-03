import assert from 'node:assert/strict'
import {
  buildSundayBenchmarkEmail,
  filterPreviousKuwaitWorkingDays,
  isKuwaitSunday,
  nextSundayHistoryRun,
  previousKuwaitWorkingDateKeys
} from '../vite.config.js'

const monday = '2026-09-07T07:20:00.000Z'
assert.equal(isKuwaitSunday(monday), false)
assert.equal(isKuwaitSunday('2026-09-06T07:20:00.000Z'), true)
assert.deepEqual(previousKuwaitWorkingDateKeys(monday, 15), [
  '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-23',
  '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-30',
  '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-06'
])
assert.equal(nextSundayHistoryRun('10:00', '2026-09-03T08:00:00.000Z'), '2026-09-06T07:00:00.000Z')

const history = [
  { id: 'included', checkedAt: '2026-09-03T08:00:00.000Z', domain: 'stc.com.kw', device: 'Mobile', seo: 100, bestPractices: 90, accessibility: 95, performance: 80, overall: 91 },
  { id: 'friday', checkedAt: '2026-09-04T08:00:00.000Z', domain: 'stc.com.kw', device: 'Mobile', seo: 100, bestPractices: 90, accessibility: 95, performance: 80, overall: 91 },
  { id: 'current-sunday', checkedAt: '2026-09-06T06:00:00.000Z', domain: 'stc.com.kw', device: 'Mobile', seo: 100, bestPractices: 90, accessibility: 95, performance: 80, overall: 91 }
]
assert.deepEqual(filterPreviousKuwaitWorkingDays(history, '2026-09-06T07:20:00.000Z', 15).map(record => record.id), ['included'])

const scores = { performance: 80, accessibility: 95, bestPractices: 90, seo: 100 }
const sites = [{ domain: 'stc.com.kw', url: 'https://www.stc.com.kw/en', overall: 91, scannedAt: '2026-09-06T07:15:00.000Z', deviceScores: { mobile: scores, desktop: scores } }]
const sundayReport = buildSundayBenchmarkEmail(sites, history, '2026-09-06T07:20:00.000Z')
assert.equal(sundayReport.selectedHistory.length, 1)
assert.match(sundayReport.subject, /Sunday Website Benchmark Report \+ 15 Working Day History/)
assert.match(sundayReport.text, /Mobile and Web benchmark matrix/)
assert.match(sundayReport.text, /Previous 15 Kuwait working days/)
assert.match(sundayReport.html, /Website Score History Report/)

console.log('Reporting schedule self-test passed: 10:00 Kuwait daily schedule and Sunday 15-working-day bundle are valid.')
