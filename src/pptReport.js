import PptxGenJS from 'pptxgenjs'

export const PPT_MOBILE = '#e6007e'
export const PPT_DESKTOP = '#4f008c'

const MOBILE = 'E6007E'
const DESKTOP = '4F008C'
const INK = '211F2D'
const MUTED = '746F80'
const BORDER = 'DEDCE5'
const LIGHT = 'F0EDF3'
const WHITE = 'FFFFFF'
const KUWAIT_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuwait', year: 'numeric', month: '2-digit', day: '2-digit' })

function dateKey(value) {
  const parts = Object.fromEntries(KUWAIT_DATE.formatToParts(new Date(value)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function average(values) {
  const numbers = values.filter(Number.isFinite)
  return numbers.length ? Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 10) / 10 : null
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(`${value}T12:00:00Z`))
}

function shortDate(value, grain) {
  const date = new Date(`${grain === 'month' ? `${value}-01` : value}T12:00:00Z`)
  return new Intl.DateTimeFormat('en-GB', grain === 'month' ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' }).format(date)
}

function scoreChange(values) {
  const numbers = values.filter(Number.isFinite)
  return numbers.length ? Math.round((numbers.at(-1) - numbers[0]) * 10) / 10 : null
}

function takeAway(site) {
  const { mobileChange, desktopChange } = site.kpis
  if (mobileChange === null && desktopChange === null) return 'Not enough completed scans are available to calculate a period change.'
  const points = value => `${Math.abs(value)} ${Math.abs(value) === 1 ? 'point' : 'points'}`
  const direction = value => value > 0 ? `improved by ${points(value)}` : value < 0 ? `declined by ${points(value)}` : 'was unchanged'
  if (mobileChange === null) return `Desktop performance ${direction(desktopChange)} during the selected period.`
  if (desktopChange === null) return `Mobile performance ${direction(mobileChange)} during the selected period.`
  return `Mobile performance ${direction(mobileChange)}, while desktop performance ${direction(desktopChange)} during the selected period.`
}

export function historyRange(history) {
  const dates = [...new Set((history || []).map(record => dateKey(record.checkedAt)))].sort()
  return { min: dates[0] || '', max: dates.at(-1) || '', dates }
}

export function buildPptReportModel(history, domains, labels, fromDate, toDate) {
  const range = historyRange(history)
  const from = fromDate || range.min
  const to = toDate || range.max
  if (!from || !to || from > to) return { from, to, periodLabel: 'No reporting period', records: [], sites: [], comparison: [], grain: 'day' }

  const filtered = (history || []).filter(record => {
    const key = dateKey(record.checkedAt)
    return key >= from && key <= to && domains.includes(record.domain) && Number.isFinite(record.performance)
  })
  const span = Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86_400_000) + 1
  const grain = span > 45 ? 'month' : 'day'
  const dailyLatest = new Map()
  filtered.forEach(record => {
    const key = `${dateKey(record.checkedAt)}|${record.domain}|${record.device}`
    const current = dailyLatest.get(key)
    if (!current || new Date(record.checkedAt) > new Date(current.checkedAt)) dailyLatest.set(key, record)
  })
  const buckets = new Map()
  dailyLatest.forEach(record => {
    const day = dateKey(record.checkedAt)
    const bucket = grain === 'month' ? day.slice(0, 7) : day
    const key = `${bucket}|${record.domain}|${record.device}`
    buckets.set(key, [...(buckets.get(key) || []), record.performance])
  })
  const bucketKeys = [...new Set([...dailyLatest.values()].map(record => {
    const day = dateKey(record.checkedAt)
    return grain === 'month' ? day.slice(0, 7) : day
  }))].sort()

  const sites = domains.map(domain => {
    const mobile = bucketKeys.map(bucket => average(buckets.get(`${bucket}|${domain}|Mobile`) || []))
    const desktop = bucketKeys.map(bucket => average(buckets.get(`${bucket}|${domain}|Web`) || []))
    const domainRecords = [...dailyLatest.values()].filter(record => record.domain === domain)
    const latestRecord = domainRecords.sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))[0]
    const latestDay = latestRecord ? dateKey(latestRecord.checkedAt) : null
    const site = {
      domain,
      label: labels[domain] || domain,
      labels: bucketKeys.map(bucket => shortDate(bucket, grain)),
      bucketKeys,
      mobile,
      desktop,
      latestDay,
      latestLabel: latestDay ? shortDate(latestDay, 'day') : null,
      kpis: {
        mobileAverage: average(domainRecords.filter(record => record.device === 'Mobile').map(record => record.performance)),
        desktopAverage: average(domainRecords.filter(record => record.device === 'Web').map(record => record.performance)),
        latestMobile: latestDay ? dailyLatest.get(`${latestDay}|${domain}|Mobile`)?.performance ?? null : null,
        latestDesktop: latestDay ? dailyLatest.get(`${latestDay}|${domain}|Web`)?.performance ?? null : null,
        mobileChange: scoreChange(mobile),
        desktopChange: scoreChange(desktop)
      }
    }
    return { ...site, takeaway: takeAway(site) }
  })
  return {
    from,
    to,
    periodLabel: `${formatDate(from)} – ${formatDate(to)}`,
    records: filtered,
    scanDates: [...new Set(filtered.map(record => dateKey(record.checkedAt)))].sort(),
    sites,
    comparison: sites.map(site => ({ domain: site.domain, label: site.label, mobile: site.kpis.mobileAverage, desktop: site.kpis.desktopAverage })),
    grain
  }
}

function score(value) { return Number.isFinite(value) ? String(value) : 'N/A' }
function signed(value) { return Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value}` : 'N/A' }

function addHeader(pptx, slide) {
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: .55, line: { color: DESKTOP, transparency: 100 }, fill: { color: DESKTOP } })
  slide.addText('stc', { x: .4, y: .12, w: .55, h: .25, fontFace: 'Arial', fontSize: 19, bold: true, color: WHITE, margin: 0 })
  slide.addText('Website Performance Snapshot', { x: 1.2, y: .15, w: 2.8, h: .22, fontFace: 'Arial', fontSize: 11, bold: true, color: WHITE, margin: 0 })
}

function addFooter(slide) {
  slide.addText('Source: saved Google PageSpeed score history · Asia/Kuwait', { x: 8.5, y: 7.18, w: 4.35, h: .15, fontFace: 'Arial', fontSize: 7, color: MUTED, align: 'right', margin: 0 })
}

function addKpi(pptx, slide, x, title, value, detail, color = INK) {
  slide.addShape(pptx.ShapeType.rect, { x, y: 5.32, w: 2.85, h: 1.02, line: { color: BORDER, width: 1 }, fill: { color: WHITE } })
  slide.addText(title, { x: x + .15, y: 5.48, w: 2.55, h: .18, fontFace: 'Arial', fontSize: 10, bold: true, color: MUTED, margin: 0, breakLine: false })
  slide.addText(value, { x: x + .15, y: 5.76, w: 2.55, h: .3, fontFace: 'Arial', fontSize: 21, bold: true, color, margin: 0 })
  slide.addText(detail, { x: x + .15, y: 6.14, w: 2.55, h: .14, fontFace: 'Arial', fontSize: 8, color: INK, margin: 0, breakLine: false })
}

function addCover(pptx, model) {
  const slide = pptx.addSlide()
  slide.background = { color: WHITE }
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 4.95, h: 7.5, line: { color: DESKTOP, transparency: 100 }, fill: { color: DESKTOP } })
  slide.addText('stc', { x: .5, y: .48, w: .8, h: .36, fontFace: 'Arial', fontSize: 26, bold: true, color: WHITE, margin: 0 })
  slide.addText('Website Benchmark', { x: .5, y: 1.05, w: 2, h: .22, fontFace: 'Arial', fontSize: 12, bold: true, color: WHITE, margin: 0 })
  slide.addText('Management performance report', { x: .5, y: 4.08, w: 3.8, h: .35, fontFace: 'Arial', fontSize: 18, bold: true, color: WHITE, margin: 0 })
  slide.addText('Mobile and desktop\nperformance snapshot', { x: 5.48, y: 1.85, w: 6.9, h: 1.1, fontFace: 'Arial', fontSize: 34, bold: true, color: INK, margin: 0, breakLine: false })
  slide.addText(`PPT Report: ${model.periodLabel}`, { x: 5.48, y: 3.26, w: 6.8, h: .3, fontFace: 'Arial', fontSize: 16, bold: true, color: DESKTOP, margin: 0 })
  slide.addText(`${model.sites.length} websites\n${model.scanDates.length} scan dates\n${model.records.length} saved score records`, { x: 5.48, y: 3.85, w: 3.7, h: .9, fontFace: 'Arial', fontSize: 14, bold: true, color: INK, breakLine: false, margin: 0, paraSpaceAfterPt: 9 })
  slide.addText('Prepared from the Website Benchmark Dashboard', { x: 5.48, y: 6.25, w: 4.8, h: .2, fontFace: 'Arial', fontSize: 10, color: MUTED, margin: 0 })
}

function addComparison(pptx, model) {
  const slide = pptx.addSlide()
  slide.background = { color: WHITE }
  addHeader(pptx, slide)
  slide.addText('Competitor performance at a glance', { x: .5, y: .77, w: 7.8, h: .4, fontFace: 'Arial', fontSize: 27, bold: true, color: INK, margin: 0 })
  slide.addText(`PPT Report: ${model.periodLabel} · Average performance scores`, { x: .5, y: 1.18, w: 8, h: .2, fontFace: 'Arial', fontSize: 10, color: MUTED, margin: 0 })
  ;[[4.45, MOBILE, 'Mobile'], [5.72, DESKTOP, 'Desktop']].forEach(([x, color, label]) => {
    slide.addShape(pptx.ShapeType.line, { x, y: 1.68, w: .28, h: 0, line: { color, width: 5 } })
    slide.addText(label, { x: x + .4, y: 1.58, w: .8, h: .2, fontFace: 'Arial', fontSize: 10, color: INK, margin: 0 })
  })
  model.comparison.forEach((site, index) => {
    const y = 2.08 + index * .65
    slide.addText(site.label, { x: .76, y: y + .12, w: 2.7, h: .2, fontFace: 'Arial', fontSize: 10, bold: true, color: INK, margin: 0 })
    ;[[site.mobile, MOBILE, 0], [site.desktop, DESKTOP, .25]].forEach(([value, color, offset]) => {
      slide.addShape(pptx.ShapeType.roundRect, { x: 4.4, y: y + offset, w: 7.2, h: .18, line: { color: LIGHT, transparency: 100 }, fill: { color: LIGHT } })
      if (Number.isFinite(value)) slide.addShape(pptx.ShapeType.roundRect, { x: 4.4, y: y + offset, w: Math.max(.05, value / 100 * 7.2), h: .18, line: { color, transparency: 100 }, fill: { color } })
      slide.addText(score(value), { x: 11.75, y: y + offset - .03, w: .6, h: .2, fontFace: 'Arial', fontSize: 10, bold: true, color, margin: 0 })
    })
  })
  slide.addText(`${model.records.length} saved score records · ${model.scanDates.length} scan dates · ${model.sites.length} websites`, { x: .5, y: 6.72, w: 6, h: .22, fontFace: 'Arial', fontSize: 10, bold: true, color: INK, margin: 0 })
  addFooter(slide)
}

function addSiteSlide(pptx, model, site) {
  const slide = pptx.addSlide()
  slide.background = { color: WHITE }
  addHeader(pptx, slide)
  slide.addText(`${site.label} mobile and desktop performance`, { x: .5, y: .76, w: 11.9, h: .42, fontFace: 'Arial', fontSize: 25, bold: true, color: INK, margin: 0, breakLine: false })
  slide.addText(`PPT Report: ${model.periodLabel} · ${model.grain === 'month' ? 'Monthly average' : 'Daily latest'} performance scores`, { x: .5, y: 1.18, w: 11, h: .2, fontFace: 'Arial', fontSize: 10, color: MUTED, margin: 0 })
  slide.addChart(pptx.ChartType.line, [
    { name: 'Mobile', labels: site.labels, values: site.mobile },
    { name: 'Desktop', labels: site.labels, values: site.desktop }
  ], {
    x: .8, y: 1.55, w: 11.85, h: 3.45,
    chartColors: [MOBILE, DESKTOP], lineSize: 3, showMarker: true, markerSize: 5,
    showLegend: true, legendPos: 't', legendFontFace: 'Arial', legendFontSize: 9,
    showTitle: true, title: `${site.label} performance progress`, titleFontFace: 'Arial', titleFontSize: 15,
    showValue: true, dataLabelPosition: 't', dataLabelColor: INK, dataLabelFormatCode: '0',
    catAxisLabelFontFace: 'Arial', catAxisLabelFontSize: 8,
    valAxisLabelFontFace: 'Arial', valAxisLabelFontSize: 8, valAxisMinVal: 0, valAxisMaxVal: 100, valAxisMajorUnit: 20,
    showValAxis: true, showCatAxis: true, showValGridLine: true, valGridLine: { color: 'E5E3E9', width: 1 },
    showCatGridLine: false, showBorder: true, border: { color: BORDER, width: 1 }
  })
  addKpi(pptx, slide, .48, 'Mobile period average', score(site.kpis.mobileAverage), `${signed(site.kpis.mobileChange)} pts from first to latest`, MOBILE)
  addKpi(pptx, slide, 3.45, 'Desktop period average', score(site.kpis.desktopAverage), `${signed(site.kpis.desktopChange)} pts from first to latest`, DESKTOP)
  addKpi(pptx, slide, 6.42, 'Latest reading', `${score(site.kpis.latestMobile)} / ${score(site.kpis.latestDesktop)}`, `Mobile / Desktop${site.latestLabel ? ` on ${site.latestLabel}` : ''}`)
  addKpi(pptx, slide, 9.39, 'Overall change', `${signed(site.kpis.mobileChange)} / ${signed(site.kpis.desktopChange)}`, 'Mobile / Desktop across period')
  slide.addText(`Key takeaway: ${site.takeaway}`, { x: .5, y: 6.67, w: 11.9, h: .22, fontFace: 'Arial', fontSize: 11, color: INK, margin: 0, breakLine: false })
  addFooter(slide)
}

function buildPresentation(model) {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'STC Website Benchmark Dashboard'
  pptx.company = 'stc'
  pptx.subject = `Website performance report: ${model.periodLabel}`
  pptx.title = `Website Performance Report — ${model.periodLabel}`
  pptx.lang = 'en-US'
  pptx.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial', lang: 'en-US' }
  addCover(pptx, model)
  addComparison(pptx, model)
  model.sites.forEach(site => addSiteSlide(pptx, model, site))
  return pptx
}

export async function createPptReportBytes(model) {
  if (!model.records.length) throw new Error('No score history is available in the selected date range.')
  const bytes = await buildPresentation(model).write({ outputType: 'uint8array', compression: true })
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

export async function downloadPptReport(model) {
  const bytes = await createPptReportBytes(model)
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `website-performance-${model.from}-to-${model.to}.pptx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1_000)
}
