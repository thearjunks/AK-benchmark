import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import { parseLegacyDesktopHistory, parseLegacyMobileHistory } from '../legacy-history.mjs'
import { buildHistoryWorkbook } from '../vite.config.js'
import { buildPptReportModel, orderPptDomains, PPT_DOMAIN_ORDER } from '../src/pptReport.js'

const desktopSource = await readFile(new URL('../data/legacy-desktop-history-2026.csv', import.meta.url), 'utf8')
const mobileSource = await readFile(new URL('../data/legacy-mobile-history-2026.csv', import.meta.url), 'utf8')
const desktop = parseLegacyDesktopHistory(desktopSource)
const mobile = parseLegacyMobileHistory(mobileSource)
const legacy = [...desktop, ...mobile]
const ids = new Set(legacy.map(record => record.id))
const dates = new Set(legacy.map(record => record.checkedAt.slice(0, 10)))
assert.equal(desktop.length, 864)
assert.equal(mobile.length, 870)
assert.equal(legacy.length, 1734)
assert.equal(ids.size, legacy.length)
assert.equal(dates.size, 145)
assert.ok(desktop.every(record => record.device === 'Web' && record.historicalImport && record.dateOnly))
assert.ok(mobile.every(record => record.device === 'Mobile' && record.historicalImport && record.dateOnly))
assert.equal([...dates].sort()[0], '2026-01-04')
assert.equal([...dates].sort().at(-1), '2026-08-10')
assert.deepEqual(
  desktop.filter(record => record.domain === 'stc.com.kw' && record.checkedAt.startsWith('2026-02-22')).map(record => [record.seo, record.bestPractices, record.accessibility, record.performance]),
  [[100, 50, 94, 61]]
)
assert.deepEqual(
  mobile.filter(record => record.domain === 'stc.com.kw' && record.checkedAt.startsWith('2026-05-12')).map(record => [record.seo, record.bestPractices, record.accessibility, record.performance]),
  [[100, 46, 94, 49]]
)

const saved = JSON.parse(await readFile(new URL('../work/benchmark-automation-state.json', import.meta.url), 'utf8'))
const combined = [...new Map([...legacy, ...(saved.history || [])].map(record => [record.id, record])).values()]
const workbookBytes = await buildHistoryWorkbook(combined)
assert.ok(workbookBytes.byteLength > 100_000)
const workbook = new ExcelJS.Workbook()
await workbook.xlsx.load(workbookBytes)
const comparison = workbook.getWorksheet('Score Comparison')
const januaryRow = comparison.getRows(4, comparison.rowCount - 3).find(row => row.getCell(1).value instanceof Date && row.getCell(1).value.toISOString().startsWith('2026-01-04'))
assert.ok(januaryRow)
assert.deepEqual([2, 3, 4, 5, 6].map(column => januaryRow.getCell(column).value), [100, 46, 94, 29, 67])
assert.deepEqual([7, 8, 9, 10, 11].map(column => januaryRow.getCell(column).value), [100, 50, 94, 59, 76])
assert.match(String(januaryRow.getCell(12).value), /imported date only/)

const domains = orderPptDomains(['virginmobile.com.kw', 'stc.com.sa', 'ooredoo.com.kw', 'stc.com.bh', 'kw.zain.com', 'stc.com.kw'])
assert.deepEqual(domains, PPT_DOMAIN_ORDER)
const labels = Object.fromEntries(domains.map(domain => [domain, domain]))
const ppt = buildPptReportModel(combined, domains, labels, '2026-01-01', '2026-08-30')
assert.equal(ppt.from, '2026-01-01')
assert.equal(ppt.grain, 'month')
assert.equal(ppt.sites.length, 6)
assert.deepEqual(ppt.sites.map(site => site.domain), PPT_DOMAIN_ORDER)
assert.ok(ppt.sites.every(site => site.labels[0] === 'Jan 26'))
if (process.argv[2]) await writeFile(process.argv[2], workbookBytes)
console.log(`Legacy history validation passed: ${desktop.length} desktop + ${mobile.length} mobile records, ${dates.size} unique dates, ${combined.length} combined records.`)
