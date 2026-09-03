import { useEffect, useMemo, useState } from 'react'
import { CalendarRange, Download, FileChartColumn, Monitor, Smartphone } from 'lucide-react'
import { buildPptReportModel, downloadPptReport, historyRange, orderPptDomains, PPT_DESKTOP, PPT_MOBILE } from './pptReport.js'

function valueLabel(value) {
  return Number.isFinite(value) ? `${Number.isInteger(value) ? value : value.toFixed(1)}%` : 'N/A'
}

function signed(value) {
  return Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value} pp` : 'N/A'
}

function TrendChart({ site }) {
  const width = 1000; const height = 350; const left = 58; const top = 24; const plotWidth = 910; const plotHeight = 270
  const steps = Math.max(1, site.labels.length - 1)
  const point = (index, value) => ({ x: left + index * plotWidth / steps, y: top + plotHeight - value / 100 * plotHeight })
  const availablePoints = values => values.flatMap((value, index) => Number.isFinite(value) ? [point(index, value)] : [])
  const every = Math.max(1, Math.ceil(site.labels.length / 10))
  return <svg className="ppt-trend-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${site.label} Mobile and Desktop performance trend`}>
    {[0,20,40,60,80,100].map(value => { const y = point(0, value).y; return <g key={value}><line x1={left} y1={y} x2={left + plotWidth} y2={y}/><text x={left - 14} y={y + 5} textAnchor="end">{value}%</text></g> })}
    <line className="axis" x1={left} y1={top} x2={left} y2={top + plotHeight}/><line className="axis" x1={left} y1={top + plotHeight} x2={left + plotWidth} y2={top + plotHeight}/>
    {availablePoints(site.mobile).length > 1 && <polyline className="mobile-line" points={availablePoints(site.mobile).map(item => `${item.x},${item.y}`).join(' ')}/>}
    {availablePoints(site.desktop).length > 1 && <polyline className="desktop-line" points={availablePoints(site.desktop).map(item => `${item.x},${item.y}`).join(' ')}/>}
    {site.mobile.map((value,index) => Number.isFinite(value) ? <g key={`md-${index}`}><circle className="mobile-dot" cx={point(index,value).x} cy={point(index,value).y} r="5"><title>{site.labels[index]} Mobile: {valueLabel(value)}</title></circle><text className="mobile-value" x={point(index,value).x} y={point(index,value).y + 20} textAnchor="middle">{valueLabel(Math.round(value))}</text></g> : null)}
    {site.desktop.map((value,index) => Number.isFinite(value) ? <g key={`dd-${index}`}><circle className="desktop-dot" cx={point(index,value).x} cy={point(index,value).y} r="5"><title>{site.labels[index]} Desktop: {valueLabel(value)}</title></circle><text className="desktop-value" x={point(index,value).x} y={point(index,value).y - 10} textAnchor="middle">{valueLabel(Math.round(value))}</text></g> : null)}
    {site.labels.map((label,index) => index % every === 0 || index === site.labels.length - 1 ? <text className="x-label" x={point(index,0).x} y={top + plotHeight + 32} textAnchor="middle" key={label}>{label}</text> : null)}
  </svg>
}

function ComparisonChart({ comparison }) {
  return <div className="ppt-comparison-chart">{comparison.map(site => <article key={site.domain}><strong>{site.label}<small>{site.domain}</small></strong><div><span><i style={{ width: `${site.mobile || 0}%`, background: PPT_MOBILE }}/><b>{valueLabel(site.mobile)}</b><em>Mobile</em></span><span><i style={{ width: `${site.desktop || 0}%`, background: PPT_DESKTOP }}/><b>{valueLabel(site.desktop)}</b><em>Desktop</em></span></div></article>)}</div>
}

export default function PptReport({ history, domains, labels, canDownload, notify }) {
  const range = useMemo(() => historyRange(history), [history])
  const orderedDomains = useMemo(() => orderPptDomains(domains), [domains])
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [selectedDomain, setSelectedDomain] = useState(orderedDomains[0] || '')
  const [periodPreset, setPeriodPreset] = useState('all')
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    if (!range.min || !range.max) return
    setFromDate(current => current || range.min)
    setToDate(current => current || range.max)
  }, [range.min, range.max])
  useEffect(() => { if (!orderedDomains.includes(selectedDomain)) setSelectedDomain(orderedDomains[0] || '') }, [orderedDomains, selectedDomain])

  const monthOptions = useMemo(() => [...new Set(range.dates.map(date => date.slice(0, 7)))].sort().reverse(), [range.dates])
  const model = useMemo(() => buildPptReportModel(history, orderedDomains, labels, fromDate, toDate), [history, orderedDomains, labels, fromDate, toDate])
  const site = model.sites.find(item => item.domain === selectedDomain) || model.sites[0]

  function selectPreset(value) {
    setPeriodPreset(value)
    if (value === 'all') { setFromDate(range.min); setToDate(range.max); return }
    if (value.startsWith('month:')) {
      const month = value.slice(6)
      const [year, monthNumber] = month.split('-').map(Number)
      const monthEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10)
      setFromDate(`${month}-01`); setToDate(monthEnd > range.max ? range.max : monthEnd)
      return
    }
    if (value === 'last30') {
      const end = new Date(`${range.max}T12:00:00Z`)
      const start = new Date(end); start.setUTCDate(start.getUTCDate() - 29)
      setFromDate(start.toISOString().slice(0, 10) < range.min ? range.min : start.toISOString().slice(0, 10)); setToDate(range.max)
    }
  }

  async function download() {
    if (!canDownload) return notify('You do not have permission to download reports')
    if (!model.records.length) return notify('No score history is available in the selected date range')
    setDownloading(true)
    try {
      await downloadPptReport(model)
      notify(`PPT Report downloaded for ${model.periodLabel}`)
    } catch (error) { notify(error.message || 'Unable to generate the PPT Report') }
    finally { setDownloading(false) }
  }

  if (!range.dates.length) return <section className="ppt-empty"><FileChartColumn size={34}/><strong>No score history is available yet</strong><span>Complete a website score check before creating a PPT Report.</span></section>

  return <div className="ppt-report">
    <section className="ppt-report-hero"><div><span>Management reporting</span><h1>PPT performance dashboard</h1><p>Select a reporting period, review the same visuals that will appear in the management presentation, and download the completed PowerPoint. All audit scores are percentages.</p></div><button onClick={download} disabled={!canDownload || downloading || !model.records.length}><Download size={17}/>{downloading ? 'Building PPT…' : 'Download PPT Report'}</button></section>
    <section className="ppt-filter-bar">
      <label><span>Reporting period</span><div><CalendarRange size={15}/><select value={periodPreset} onChange={event => selectPreset(event.target.value)}><option value="all">All saved history</option><option value="last30">Latest 30 days</option>{monthOptions.map(month => <option value={`month:${month}`} key={month}>{new Intl.DateTimeFormat('en-GB',{month:'long',year:'numeric'}).format(new Date(`${month}-01T12:00:00Z`))}</option>)}<option value="custom">Custom date range</option></select></div></label>
      <label><span>From Date</span><input type="date" max={toDate || range.max} value={fromDate} onChange={event => { setPeriodPreset('custom'); setFromDate(event.target.value) }}/></label>
      <label><span>To Date</span><input type="date" min={fromDate || range.min} max={range.max} value={toDate} onChange={event => { setPeriodPreset('custom'); setToDate(event.target.value) }}/></label>
      <label><span>Website view</span><select value={selectedDomain} onChange={event => setSelectedDomain(event.target.value)}>{orderedDomains.map(domain => <option value={domain} key={domain}>{labels[domain] || domain}</option>)}</select></label>
      <div className="ppt-period-summary"><span>Selected report</span><strong>{model.periodLabel}</strong><small>{model.scanDates?.length || 0} scan dates · {model.records.length} records</small></div>
    </section>

    {site && model.records.length ? <>
      <section className="ppt-snapshot">
        <header><div><span>Performance trend</span><h2>{site.label} mobile and desktop performance</h2><p>{model.grain === 'month' ? 'Monthly average' : 'Daily latest'} scores (%) · {model.periodLabel}</p></div><div className="ppt-legend"><span><i className="mobile"/>Mobile (%)</span><span><i className="desktop"/>Desktop (%)</span></div></header>
        <div className="ppt-chart-shell"><TrendChart site={site}/></div>
        <div className="ppt-kpis"><article><span>Mobile period average</span><strong className="mobile">{valueLabel(site.kpis.mobileAverage)}</strong><small>{signed(site.kpis.mobileChange)} from first to latest</small></article><article><span>Desktop period average</span><strong className="desktop">{valueLabel(site.kpis.desktopAverage)}</strong><small>{signed(site.kpis.desktopChange)} from first to latest</small></article><article><span>Latest reading</span><strong>{valueLabel(site.kpis.latestMobile)} / {valueLabel(site.kpis.latestDesktop)}</strong><small>Mobile / Desktop{site.latestLabel ? ` on ${site.latestLabel}` : ''}</small></article><article className="change"><span>Overall change</span><strong>{signed(site.kpis.mobileChange)} / {signed(site.kpis.desktopChange)}</strong><small>Mobile / Desktop percentage-point change</small></article></div>
        <p className="ppt-takeaway"><b>Key takeaway:</b> {site.takeaway}</p>
      </section>
      <section className="ppt-comparison"><header><div><span>Period comparison</span><h2>All six websites at a glance</h2><p>Average performance scores (%) for the selected reporting period.</p></div><small>0–100%</small></header><ComparisonChart comparison={model.comparison}/></section>
      <p className="ppt-source">Values: audit scores are percentages (%) · Changes are percentage points (pp) · Source: saved benchmark score history · Imported desktop records retain date-only metadata · Asia/Kuwait timezone · Missing scans remain N/A.</p>
    </> : <section className="ppt-empty"><CalendarRange size={34}/><strong>No data in this period</strong><span>Choose a date range containing completed score history.</span></section>}
  </div>
}
