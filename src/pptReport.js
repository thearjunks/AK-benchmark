import JSZip from 'jszip'

export const PPT_MOBILE = '#e6007e'
export const PPT_DESKTOP = '#4f008c'

const KUWAIT_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kuwait', year: 'numeric', month: '2-digit', day: '2-digit'
})

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

function firstAndLast(values) {
  const numbers = values.filter(Number.isFinite)
  return { first: numbers[0] ?? null, last: numbers.at(-1) ?? null }
}

function scoreChange(values) {
  const { first, last } = firstAndLast(values)
  return first === null || last === null ? null : Math.round((last - first) * 10) / 10
}

function takeAway(site) {
  const mobileChange = site.kpis.mobileChange
  const desktopChange = site.kpis.desktopChange
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
    const list = buckets.get(key) || []
    list.push(record.performance)
    buckets.set(key, list)
  })
  const bucketKeys = [...new Set([...dailyLatest.values()].map(record => {
    const day = dateKey(record.checkedAt)
    return grain === 'month' ? day.slice(0, 7) : day
  }))].sort()

  const sites = domains.map(domain => {
    const mobile = bucketKeys.map(bucket => average(buckets.get(`${bucket}|${domain}|Mobile`) || []))
    const desktop = bucketKeys.map(bucket => average(buckets.get(`${bucket}|${domain}|Web`) || []))
    const mobileValues = [...dailyLatest.values()].filter(record => record.domain === domain && record.device === 'Mobile').map(record => record.performance)
    const desktopValues = [...dailyLatest.values()].filter(record => record.domain === domain && record.device === 'Web').map(record => record.performance)
    const latestRecord = [...dailyLatest.values()].filter(record => record.domain === domain).sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))[0]
    const latestDay = latestRecord ? dateKey(latestRecord.checkedAt) : null
    const latestMobile = latestDay ? dailyLatest.get(`${latestDay}|${domain}|Mobile`)?.performance ?? null : null
    const latestDesktop = latestDay ? dailyLatest.get(`${latestDay}|${domain}|Web`)?.performance ?? null : null
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
        mobileAverage: average(mobileValues),
        desktopAverage: average(desktopValues),
        latestMobile,
        latestDesktop,
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

function xml(value) {
  return String(value ?? '').replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character])
}

function svgText(x, y, text, size, color = '#211f2d', weight = 400, anchor = 'start') {
  return `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${xml(text)}</text>`
}

function chartSvg(site) {
  const x = 220; const y = 255; const width = 1160; const height = 320
  const steps = Math.max(1, site.labels.length - 1)
  const point = (index, value) => ({ x: x + index * width / steps, y: y + height - (value / 100) * height })
  const lines = [0, 20, 40, 60, 80, 100].map(value => {
    const py = y + height - value / 100 * height
    return `<line x1="${x}" y1="${py}" x2="${x + width}" y2="${py}" stroke="#e5e3e9" stroke-width="1"/>${svgText(x - 18, py + 6, value, 15, '#5f5b69', 400, 'end')}`
  }).join('')
  const series = (values, color) => {
    const points = values.flatMap((value, index) => Number.isFinite(value) ? [point(index, value)] : [])
    const paths = points.length > 1 ? `<polyline points="${points.map(item => `${item.x},${item.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` : ''
    const dots = values.map((value, index) => Number.isFinite(value) ? (() => { const p = point(index, value); return `<circle cx="${p.x}" cy="${p.y}" r="7" fill="${color}"/>${svgText(p.x, p.y - 13, Math.round(value), 15, color, 700, 'middle')}` })() : '').join('')
    return paths + dots
  }
  const tickEvery = Math.max(1, Math.ceil(site.labels.length / 10))
  const labels = site.labels.map((label, index) => index % tickEvery === 0 || index === site.labels.length - 1 ? svgText(point(index, 0).x, y + height + 30, label, 14, '#4e4a56', 400, 'middle') : '').join('')
  return `${lines}<line x1="${x}" y1="${y}" x2="${x}" y2="${y + height}" stroke="#4a4650" stroke-width="2"/><line x1="${x}" y1="${y + height}" x2="${x + width}" y2="${y + height}" stroke="#4a4650" stroke-width="2"/>${series(site.mobile, PPT_MOBILE)}${series(site.desktop, PPT_DESKTOP)}${labels}`
}

function kpiCard(x, title, value, detail, accent = '#211f2d') {
  return `<rect x="${x}" y="640" width="340" height="120" fill="#ffffff" stroke="#dedbe5" stroke-width="2"/>${svgText(x + 18, 670, title, 17, '#706b7d', 700)}${svgText(x + 18, 715, value, 33, accent, 700)}${svgText(x + 18, 745, detail, 14, '#34313c')}`
}

function score(value) { return Number.isFinite(value) ? String(value) : 'N/A' }
function signed(value) { return Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value}` : 'N/A' }

function siteSlideSvg(site, model) {
  const latest = `${score(site.kpis.latestMobile)} / ${score(site.kpis.latestDesktop)}`
  const change = `${signed(site.kpis.mobileChange)} / ${signed(site.kpis.desktopChange)}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
    <rect width="1600" height="900" fill="#ffffff"/><rect width="1600" height="66" fill="#4f008c"/>
    ${svgText(48, 43, 'stc', 29, '#ffffff', 700)}${svgText(140, 41, 'Website Performance Snapshot', 18, '#ffffff', 700)}
    ${svgText(58, 118, `${site.label} mobile and desktop performance`, 36, '#211f2d', 700)}
    ${svgText(58, 151, `PPT Report: ${model.periodLabel} · ${model.grain === 'month' ? 'Monthly average' : 'Daily latest'} performance scores`, 17, '#746f80')}
    <rect x="95" y="184" width="1410" height="420" fill="#ffffff" stroke="#dedbe5" stroke-width="2"/>
    ${svgText(220, 228, `${site.label} performance progress`, 23, '#111111', 700)}
    <line x1="235" y1="249" x2="268" y2="249" stroke="${PPT_MOBILE}" stroke-width="5"/><circle cx="251" cy="249" r="6" fill="${PPT_MOBILE}"/>${svgText(280, 255, 'Mobile', 16)}
    <line x1="370" y1="249" x2="403" y2="249" stroke="${PPT_DESKTOP}" stroke-width="5"/><circle cx="387" cy="249" r="6" fill="${PPT_DESKTOP}"/>${svgText(415, 255, 'Desktop', 16)}
    ${chartSvg(site)}
    ${kpiCard(56, 'Mobile period average', score(site.kpis.mobileAverage), `${signed(site.kpis.mobileChange)} pts from first to latest`, PPT_MOBILE)}
    ${kpiCard(410, 'Desktop period average', score(site.kpis.desktopAverage), `${signed(site.kpis.desktopChange)} pts from first to latest`, PPT_DESKTOP)}
    ${kpiCard(764, 'Latest reading', latest, `Mobile / Desktop${site.latestDay ? ` on ${shortDate(site.latestDay, 'day')}` : ''}`)}
    ${kpiCard(1118, 'Overall change', change, 'Mobile / Desktop across period')}
    ${svgText(58, 814, `Key takeaway: ${site.takeaway}`, 18, '#211f2d')}
    ${svgText(1542, 866, 'Source: saved Google PageSpeed score history · Asia/Kuwait', 12, '#7b7683', 400, 'end')}
  </svg>`
}

function comparisonSlideSvg(model) {
  const rowHeight = 78; const startY = 250; const barX = 520; const barWidth = 850
  const rows = model.comparison.map((site, index) => {
    const y = startY + index * rowHeight
    const mobileWidth = Number.isFinite(site.mobile) ? site.mobile / 100 * barWidth : 0
    const desktopWidth = Number.isFinite(site.desktop) ? site.desktop / 100 * barWidth : 0
    return `${svgText(90, y + 30, site.label, 18, '#211f2d', 700)}
      <rect x="${barX}" y="${y}" width="${barWidth}" height="22" rx="11" fill="#f0edf3"/><rect x="${barX}" y="${y}" width="${mobileWidth}" height="22" rx="11" fill="${PPT_MOBILE}"/>${svgText(barX + barWidth + 18, y + 18, score(site.mobile), 17, PPT_MOBILE, 700)}
      <rect x="${barX}" y="${y + 31}" width="${barWidth}" height="22" rx="11" fill="#f0edf3"/><rect x="${barX}" y="${y + 31}" width="${desktopWidth}" height="22" rx="11" fill="${PPT_DESKTOP}"/>${svgText(barX + barWidth + 18, y + 49, score(site.desktop), 17, PPT_DESKTOP, 700)}`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
    <rect width="1600" height="900" fill="#ffffff"/><rect width="1600" height="66" fill="#4f008c"/>
    ${svgText(48, 43, 'stc', 29, '#ffffff', 700)}${svgText(140, 41, 'Website Performance Snapshot', 18, '#ffffff', 700)}
    ${svgText(58, 120, 'Competitor performance at a glance', 38, '#211f2d', 700)}
    ${svgText(58, 154, `PPT Report: ${model.periodLabel} · Average performance scores`, 17, '#746f80')}
    <line x1="525" y1="203" x2="558" y2="203" stroke="${PPT_MOBILE}" stroke-width="8"/>${svgText(572, 209, 'Mobile', 16)}
    <line x1="675" y1="203" x2="708" y2="203" stroke="${PPT_DESKTOP}" stroke-width="8"/>${svgText(722, 209, 'Desktop', 16)}
    ${rows}
    ${svgText(58, 817, `${model.records.length} saved score records · ${model.scanDates.length} scan dates · ${model.sites.length} websites`, 18, '#211f2d', 700)}
    ${svgText(1542, 866, 'Source: saved Google PageSpeed score history · Asia/Kuwait', 12, '#7b7683', 400, 'end')}
  </svg>`
}

function coverSlideSvg(model) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
    <rect width="1600" height="900" fill="#ffffff"/><rect x="0" y="0" width="585" height="900" fill="#4f008c"/>
    ${svgText(60, 84, 'stc', 38, '#ffffff', 700)}${svgText(60, 145, 'Website Benchmark', 18, '#ffffff', 700)}
    ${svgText(60, 520, 'Management performance report', 28, '#ffffff', 700)}
    ${svgText(650, 270, 'Mobile and desktop', 54, '#211f2d', 700)}${svgText(650, 334, 'performance snapshot', 54, '#211f2d', 700)}
    ${svgText(650, 410, `PPT Report: ${model.periodLabel}`, 24, '#4f008c', 700)}
    ${svgText(650, 480, `${model.sites.length} websites`, 22, '#211f2d', 700)}${svgText(650, 520, `${model.scanDates.length} scan dates`, 22, '#211f2d', 700)}${svgText(650, 560, `${model.records.length} saved score records`, 22, '#211f2d', 700)}
    ${svgText(650, 760, 'Prepared from the Website Benchmark Dashboard', 17, '#746f80')}
  </svg>`
}

function slideXml(imageId) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:pic><p:nvPicPr><p:cNvPr id="2" name="Dashboard ${imageId}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

export async function createPptReportBytes(model) {
  if (!model.records.length) throw new Error('No score history is available in the selected date range.')
  const slideSvgs = [coverSlideSvg(model), comparisonSlideSvg(model), ...model.sites.map(site => siteSlideSvg(site, model))]
  const zip = new JSZip()
  const overrides = slideSvgs.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="svg" ContentType="image/svg+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${overrides}</Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`)
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Website Performance Report — ${xml(model.periodLabel)}</dc:title><dc:creator>STC Website Benchmark Dashboard</dc:creator><cp:lastModifiedBy>STC Website Benchmark Dashboard</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified></cp:coreProperties>`)
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>STC Website Benchmark Dashboard</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>${slideSvgs.length}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><Company>stc</Company></Properties>`)
  const slideIds = slideSvgs.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`)
  const slideRelationships = slideSvgs.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideRelationships}<Relationship Id="rId${slideSvgs.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/><Relationship Id="rId${slideSvgs.length + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/><Relationship Id="rId${slideSvgs.length + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/></Relationships>`)
  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`)
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`)
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`)
  zip.file('ppt/theme/theme1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="STC"><a:themeElements><a:clrScheme name="STC"><a:dk1><a:srgbClr val="211F2D"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="4F008C"/></a:dk2><a:lt2><a:srgbClr val="F7F5F8"/></a:lt2><a:accent1><a:srgbClr val="4F008C"/></a:accent1><a:accent2><a:srgbClr val="E6007E"/></a:accent2><a:accent3><a:srgbClr val="00875F"/></a:accent3><a:accent4><a:srgbClr val="FF375E"/></a:accent4><a:accent5><a:srgbClr val="8736C4"/></a:accent5><a:accent6><a:srgbClr val="1D252D"/></a:accent6><a:hlink><a:srgbClr val="4F008C"/></a:hlink><a:folHlink><a:srgbClr val="8736C4"/></a:folHlink></a:clrScheme><a:fontScheme name="Arial"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="STC"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`)
  zip.file('ppt/presProps.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`)
  zip.file('ppt/viewProps.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" lastView="sldView"><p:normalViewPr/><p:slideViewPr/><p:notesTextViewPr/><p:gridSpacing cx="72008" cy="72008"/></p:viewPr>`)
  zip.file('ppt/tableStyles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`)
  slideSvgs.forEach((svg, index) => {
    const number = index + 1
    zip.file(`ppt/media/image${number}.svg`, svg)
    zip.file(`ppt/slides/slide${number}.xml`, slideXml(number))
    zip.file(`ppt/slides/_rels/slide${number}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${number}.svg"/></Relationships>`)
  })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
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
