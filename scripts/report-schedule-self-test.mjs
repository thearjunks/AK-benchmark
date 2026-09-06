import assert from 'node:assert/strict'
import {
  buildSundayHistoryEmail,
  filterPreviousKuwaitDays,
  isKuwaitSunday,
  nextSundayHistoryRun,
  previousKuwaitDateKeys,
  shouldSendSundayHistory
} from '../vite.config.js'

const monday = '2026-09-07T07:20:00.000Z'
assert.equal(isKuwaitSunday(monday), false)
assert.equal(isKuwaitSunday('2026-09-06T07:20:00.000Z'), true)
assert.equal(shouldSendSundayHistory('scheduled', '2026-09-06T07:20:00.000Z', null), true)
assert.equal(shouldSendSundayHistory('manual', '2026-09-06T07:20:00.000Z', null), true)
assert.equal(shouldSendSundayHistory('recovery', '2026-09-06T07:20:00.000Z', null), false)
assert.equal(shouldSendSundayHistory('scheduled', '2026-09-06T07:20:00.000Z', { dateKey: '2026-09-06' }), false)
assert.deepEqual(previousKuwaitDateKeys(monday, 15), [
  '2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
  '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01',
  '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'
])
assert.equal(nextSundayHistoryRun('10:00', '2026-09-03T08:00:00.000Z'), '2026-09-06T07:00:00.000Z')

const history = [
  { id: 'included', checkedAt: '2026-09-03T08:00:00.000Z', domain: 'stc.com.kw', device: 'Mobile', seo: 100, bestPractices: 90, accessibility: 95, performance: 80, overall: 91 },
  { id: 'friday', checkedAt: '2026-09-04T08:00:00.000Z', domain: 'stc.com.kw', device: 'Mobile', seo: 100, bestPractices: 90, accessibility: 95, performance: 80, overall: 91 },
  { id: 'current-sunday', checkedAt: '2026-09-06T06:00:00.000Z', domain: 'stc.com.kw', device: 'Mobile', seo: 100, bestPractices: 90, accessibility: 95, performance: 80, overall: 91 }
]
assert.deepEqual(filterPreviousKuwaitDays(history, '2026-09-06T07:20:00.000Z', 15).map(record => record.id), ['included', 'friday'])

const scores = { performance: 80, accessibility: 95, bestPractices: 90, seo: 100 }
const sundayReport = buildSundayHistoryEmail(history, '2026-09-06T07:20:00.000Z')
assert.equal(sundayReport.selectedHistory.length, 2)
assert.match(sundayReport.subject, /Sunday Website Score History — Previous 15 Days/)
assert.match(sundayReport.text, /Previous 15 days/)
assert.match(sundayReport.html, /Website Score History Report/)

console.log('Reporting schedule self-test passed: 10:00 Kuwait daily schedule and Sunday previous-15-calendar-day report are valid.')
