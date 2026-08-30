import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { buildPptReportModel, createPptReportBytes, historyRange } from '../src/pptReport.js'

const domains = ['stc.com.kw', 'kw.zain.com', 'ooredoo.com.kw', 'stc.com.sa', 'stc.com.bh', 'virgin.com']
const labels = { 'stc.com.kw': 'STC Kuwait', 'kw.zain.com': 'Zain Kuwait', 'ooredoo.com.kw': 'Ooredoo Kuwait', 'stc.com.sa': 'STC Saudi Arabia', 'stc.com.bh': 'STC Bahrain', 'virgin.com': 'Virgin' }
const state = JSON.parse(await readFile(new URL('../work/benchmark-automation-state.json', import.meta.url), 'utf8'))
const history = Array.isArray(state.history) ? state.history : []
const range = historyRange(history)
assert.ok(range.min && range.max, 'Saved history must contain a valid date range.')
const model = buildPptReportModel(history, domains, labels, range.min, range.max)
assert.equal(model.sites.length, 6)
assert.ok(model.records.length > 0)
assert.ok(model.sites.every(site => site.labels.length === site.mobile.length && site.labels.length === site.desktop.length))
const custom = buildPptReportModel(history, domains, labels, '2026-08-01', '2026-08-20')
assert.equal(custom.periodLabel, '01 August 2026 – 20 August 2026')
assert.ok(custom.records.length > 0 && custom.records.length < model.records.length)

const bytes = await createPptReportBytes(model)
assert.equal(bytes[0], 0x50)
assert.equal(bytes[1], 0x4b)
assert.ok(bytes.length > 10_000)
if (process.argv[2]) await writeFile(process.argv[2], bytes)
console.log(`PPT report validation passed: ${model.records.length} records, ${model.scanDates.length} dates, ${bytes.length} bytes.`)
