import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, CalendarClock, Check, Clock3, Download, FileText, Gauge, Globe2,
  Mail, Monitor, Plus, RefreshCw, Search, Send, ShieldCheck, Smartphone, Sparkles, Trash2, UserPlus
} from 'lucide-react'

const metrics = [
  ['performance', 'Performance', Gauge],
  ['accessibility', 'Accessibility', ShieldCheck],
  ['bestPractices', 'Best practices', Sparkles],
  ['seo', 'SEO', Search]
]
const palette = ['#4f008c', '#ff375e', '#1d252d', '#8736c4', '#8e9aa0', '#c80025']

function loadSaved(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

function colorForDomain(domain) {
  return palette[[...domain].reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length]
}

function scoreTone(score) {
  if (score >= 90) return 'great'
  if (score >= 75) return 'good'
  if (score >= 60) return 'warn'
  return 'bad'
}

function relativeTime(date) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date)) / 60000))
  if (minutes < 2) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`
}

function checkedTime(date) {
  if (!date) return 'Not checked yet'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuwait', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(date))
}

function deviceScore(site, device, metric) {
  const exact = site.deviceScores?.[device]?.[metric]
  if (typeof exact === 'number') return exact
  if (metric === 'performance') return device === 'mobile' ? site.scores.mobile : site.scores.desktop
  return null
}

function parseWebsiteEntries(value) {
  return [...new Set(value
    .split(/[\s,;]+/)
    .map(entry => entry.trim().replace(/^[\[<(]+/, '').replace(/[\])>|]+$/, ''))
    .filter(Boolean))]
}

function loadEmailRecipients() {
  try {
    const saved = JSON.parse(localStorage.getItem('benchmark-email-recipients') || '[]')
    if (Array.isArray(saved)) return saved.filter(value => typeof value === 'string')
  } catch { /* use legacy value below */ }
  const legacy = localStorage.getItem('benchmark-email-recipient')
  return legacy ? [legacy] : []
}

function App() {
  const [sites, setSites] = useState(() => loadSaved('webpulse-live-sites-v1'))
  const [issues, setIssues] = useState(() => loadSaved('webpulse-live-issues-v1'))
  const [url, setUrl] = useState('')
  const [view, setView] = useState('overview')
  const [selectedSite, setSelectedSite] = useState('')
  const [severity, setSeverity] = useState('All')
  const [issueSite, setIssueSite] = useState('All')
  const [query, setQuery] = useState('')
  const [isScanning, setIsScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState(null)
  const [batchItems, setBatchItems] = useState([])
  const [emailRecipient, setEmailRecipient] = useState('')
  const [emailRecipients, setEmailRecipients] = useState(loadEmailRecipients)
  const [emailSchedule, setEmailSchedule] = useState(() => localStorage.getItem('benchmark-email-schedule') || 'After every completed scan')
  const [emailTime, setEmailTime] = useState(() => localStorage.getItem('benchmark-email-time') || '09:00')
  const [emailDay, setEmailDay] = useState(() => localStorage.getItem('benchmark-email-day') || 'Sunday')
  const [emailEnabled, setEmailEnabled] = useState(() => localStorage.getItem('benchmark-email-enabled') === 'true')
  const [emailStatus, setEmailStatus] = useState({ configured: false, sender: null, loading: true })
  const [emailSending, setEmailSending] = useState(false)
  const [automation, setAutomation] = useState({ status: 'loading', standardUrls: [], progress: [], sites: [], nextRunAt: null })
  const sitesRef = useRef(sites)
  const comparisonSitesRef = useRef([])
  const issuesRef = useRef(issues)
  const appliedAutomationRef = useRef(null)
  const [toast, setToast] = useState('')

  const standardComparisonSites = automation.standardUrls?.length ? automation.standardUrls.map((standardUrl, index) => {
    const domain = new URL(standardUrl).hostname.replace(/^www\./, '')
    const progress = automation.progress?.find(item => item.url === standardUrl)
    const savedSite = sites.find(item => item.standardUrl === standardUrl || item.domain === domain)
    return progress?.latestSite || savedSite || {
      id: `standard-${index}`, domain, url: standardUrl, standardUrl,
      overall: typeof progress?.overall === 'number' ? progress.overall : null,
      scores: {}, deviceScores: { mobile: {}, desktop: {} }, scannedAt: progress?.checkedAt || null
    }
  }) : []
  const standardDomains = new Set((automation.standardUrls || []).map(standardUrl => new URL(standardUrl).hostname.replace(/^www\./, '')))
  const extraSites = sites.filter(site => !standardDomains.has(site.domain))
  const comparisonSites = automation.standardUrls?.length ? [...standardComparisonSites, ...extraSites] : sites
  const comparisonGroups = Array.from({ length: Math.ceil(comparisonSites.length / 3) }, (_, index) => comparisonSites.slice(index * 3, index * 3 + 3))
  const average = sites.length ? Math.round(sites.reduce((sum, site) => sum + site.overall, 0) / sites.length) : null
  const filteredIssues = issues.filter(issue =>
    (severity === 'All' || issue.severity === severity) &&
    (issueSite === 'All' || issue.site === issueSite) &&
    `${issue.title} ${issue.site} ${issue.category} ${issue.device || ''}`.toLowerCase().includes(query.toLowerCase())
  )
  const severityCounts = useMemo(() => ['Critical', 'High', 'Medium', 'Low'].map(level => ({
    level, count: issues.filter(issue => issue.severity === level).length
  })), [issues])

  useEffect(() => localStorage.setItem('webpulse-live-sites-v1', JSON.stringify(sites)), [sites])
  useEffect(() => localStorage.setItem('webpulse-live-issues-v1', JSON.stringify(issues)), [issues])
  useEffect(() => { sitesRef.current = sites }, [sites])
  useEffect(() => { comparisonSitesRef.current = comparisonSites }, [comparisonSites])
  useEffect(() => { issuesRef.current = issues }, [issues])
  useEffect(() => {
    fetch('/api/email-status').then(response => response.json()).then(status => setEmailStatus({ ...status, loading: false })).catch(() => setEmailStatus({ configured: false, sender: null, loading: false }))
  }, [])
  useEffect(() => {
    fetch('/api/email-settings').then(response => response.json()).then(settings => {
      if (Array.isArray(settings.recipients) && settings.recipients.length) setEmailRecipients(settings.recipients)
      else if (emailRecipients.length) persistEmailSettings(emailRecipients)
      if (settings.schedule) setEmailSchedule(settings.schedule)
      if (settings.time) setEmailTime(settings.time)
      if (settings.day) setEmailDay(settings.day)
    }).catch(() => {})
  }, [])
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const response = await fetch('/api/automation-state', { cache: 'no-store' })
        const next = await response.json()
        if (!active) return
        setAutomation(next)
        if (next.lastCompletedAt && next.lastCompletedAt !== appliedAutomationRef.current && Array.isArray(next.sites) && next.sites.length) {
          appliedAutomationRef.current = next.lastCompletedAt
          const liveSites = next.sites.map(site => ({ ...site, color: colorForDomain(site.domain), delta: 0 }))
          setSites(liveSites)
          setIssues(Array.isArray(next.issues) ? next.issues : [])
        }
      } catch { /* server status remains visible from the last successful poll */ }
    }
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    if (sites.length && !sites.some(site => site.domain === selectedSite)) setSelectedSite(sites[0].domain)
  }, [sites, selectedSite])

  function notify(message) {
    setToast(message)
    window.setTimeout(() => setToast(''), 2800)
  }

  async function scanWebsite(targetUrl) {
    const response = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: targetUrl })
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `Analysis failed with HTTP ${response.status}.`)
    const previous = sites.find(site => site.domain === result.site.domain)
    const site = { ...result.site, delta: previous?.overall == null ? 0 : result.site.overall - previous.overall, color: colorForDomain(result.site.domain) }
    setSites(current => current.some(item => item.domain === site.domain)
      ? current.map(item => item.domain === site.domain ? site : item)
      : [...current, site])
    setIssues(current => [...result.issues, ...current.filter(issue => issue.site !== site.domain)])
    setSelectedSite(site.domain)
    return site
  }

  async function scanBatch(targets) {
    const failures = []
    let completed = 0
    setBatchItems(targets.map(target => ({ url: target, domain: new URL(target).hostname.replace(/^www\./, ''), status: 'queued' })))
    setIsScanning(true)
    try {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index]
        setScanProgress({ current: index + 1, total: targets.length, domain: new URL(target).hostname })
        setBatchItems(items => items.map((item, itemIndex) => itemIndex === index ? { ...item, status: 'scanning' } : item))
        try {
          const scannedSite = await scanWebsite(target)
          completed += 1
          setBatchItems(items => items.map((item, itemIndex) => itemIndex === index ? {
            ...item,
            status: scannedSite.scanWarning ? 'partial' : 'complete',
            domain: scannedSite.domain,
            overall: scannedSite.overall,
            message: scannedSite.scanWarning
          } : item))
        }
        catch (error) {
          failures.push({ url: target, message: error.message || 'Analysis failed' })
          setBatchItems(items => items.map((item, itemIndex) => itemIndex === index ? { ...item, status: 'failed', message: error.message || 'Analysis failed' } : item))
          continue
        }
      }
      setUrl(targets.join('\n'))
      notify(failures.length ? `${completed} of ${targets.length} completed; ${failures.length} need retry` : `${completed} live ${completed === 1 ? 'scan' : 'scans'} completed`)
      if (completed && emailEnabled && emailSchedule === 'After every completed scan' && emailRecipients.length) {
        window.setTimeout(() => sendEmailReport(emailRecipients.join(','), true), 800)
      }
    } finally { setIsScanning(false); setScanProgress(null) }
  }

  function analyze(event) {
    event?.preventDefault()
    const entries = parseWebsiteEntries(url)
    if (!entries.length) return notify('Enter at least one website URL')
    if (entries.length > 10) return notify('Add up to 10 websites per batch')
    const targets = []
    for (const entry of entries) {
      try {
        const target = new URL(/^https?:\/\//i.test(entry) ? entry : `https://${entry}`)
        if (!target.hostname.includes('.')) throw new Error()
        targets.push(target.href)
      } catch { return notify(`Invalid website URL: ${entry}`) }
    }
    scanBatch(targets)
  }

  function rescan(site) {
    if (site && !isScanning) scanBatch([site.url])
  }

  function downloadCsv() {
    if (!sites.length) return notify('No benchmark results to export')
    const deviceHeaders = metrics.flatMap(([, label]) => [`Mobile ${label}`, `Web ${label}`])
    const head = ['Website', 'Overall', ...deviceHeaders, 'Issues', 'Scan date']
    const rows = sites.map(site => [
      site.domain, site.overall,
      ...metrics.flatMap(([key]) => [deviceScore(site, 'mobile', key) ?? '', deviceScore(site, 'desktop', key) ?? '']),
      issues.filter(issue => issue.site === site.domain).length,
      new Date(site.scannedAt).toISOString()
    ])
    const csv = [head, ...rows].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    link.download = `stc-website-benchmark-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
    notify('Excel-compatible report downloaded')
  }

  async function sendEmailReport(recipient = emailRecipients.join(','), automatic = false) {
    if (!emailStatus.configured) return notify('Gmail is not connected on the server')
    const recipients = String(recipient).split(',').map(value => value.trim()).filter(Boolean)
    if (!recipients.length || recipients.some(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) return notify('Add at least one valid recipient email address')
    if (!comparisonSitesRef.current.length) return notify('Run at least one website scan first')
    setEmailSending(true)
    try {
      const response = await fetch('/api/email-report', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient,
          sites: comparisonSitesRef.current.map(site => ({
            domain: site.domain, overall: site.overall,
            deviceScores: {
              mobile: Object.fromEntries(metrics.map(([key]) => [key, deviceScore(site, 'mobile', key)])),
              desktop: Object.fromEntries(metrics.map(([key]) => [key, deviceScore(site, 'desktop', key)]))
            }
          }))
        })
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Email delivery failed')
      notify(automatic ? `Automatic report sent to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}` : `Report sent to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`)
    } catch (error) { notify(error.message || 'Email delivery failed') }
    finally { setEmailSending(false) }
  }

  async function persistEmailSettings(recipients = emailRecipients, overrides = {}) {
    try {
      await fetch('/api/email-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients, schedule: emailSchedule, time: emailTime, day: emailDay, enabled: true, ...overrides })
      })
    } catch { /* local settings remain available if the server is temporarily offline */ }
  }

  async function runStandardCheck() {
    if (automation.status === 'running') return
    try {
      const response = await fetch('/api/automation/run', { method: 'POST' })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Unable to start the score check')
      setAutomation(current => ({ ...current, status: 'running', trigger: 'manual', progress: [] }))
      notify('Score check started for all six standard URLs')
    } catch (error) { notify(error.message || 'Unable to start the score check') }
  }

  function saveEmailDelivery() {
    const recipients = [...emailRecipients]
    if (emailRecipient.trim()) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRecipient.trim())) return notify('Enter a valid recipient email address')
      if (!recipients.includes(emailRecipient.trim().toLowerCase())) recipients.push(emailRecipient.trim().toLowerCase())
    }
    if (!recipients.length) return notify('Add at least one recipient email address')
    setEmailRecipients(recipients)
    setEmailRecipient('')
    localStorage.setItem('benchmark-email-recipients', JSON.stringify(recipients))
    localStorage.setItem('benchmark-email-schedule', emailSchedule)
    localStorage.setItem('benchmark-email-time', emailTime)
    localStorage.setItem('benchmark-email-day', emailDay)
    const canAutomate = emailStatus.verified
    localStorage.setItem('benchmark-email-enabled', String(canAutomate))
    setEmailEnabled(canAutomate)
    persistEmailSettings(recipients, { schedule: emailSchedule, time: emailTime, day: emailDay })
    notify(canAutomate ? 'Recipients saved and automatic reports enabled' : 'Recipients and schedule saved')
  }

  function addEmailRecipient() {
    const value = emailRecipient.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return notify('Enter a valid recipient email address')
    if (emailRecipients.includes(value)) return notify('This email address is already saved')
    const next = [...emailRecipients, value]
    setEmailRecipients(next)
    setEmailRecipient('')
    localStorage.setItem('benchmark-email-recipients', JSON.stringify(next))
    persistEmailSettings(next)
    notify('Recipient added')
  }

  function removeEmailRecipient(value) {
    const next = emailRecipients.filter(item => item !== value)
    setEmailRecipients(next)
    localStorage.setItem('benchmark-email-recipients', JSON.stringify(next))
    persistEmailSettings(next)
    if (!next.length) {
      setEmailEnabled(false)
      localStorage.setItem('benchmark-email-enabled', 'false')
    }
    notify('Recipient removed')
  }

  function openGmailDraft() {
    const recipients = [...emailRecipients]
    if (emailRecipient.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRecipient.trim())) recipients.push(emailRecipient.trim())
    if (!recipients.length) return notify('Add at least one recipient email address')
    if (!comparisonSites.length) return notify('Run at least one website scan first')
    const reportLines = comparisonSites.map(site => {
      const categoryLines = metrics.map(([key, label]) => `${label}: Mobile ${deviceScore(site, 'mobile', key) ?? '—'} | Web ${deviceScore(site, 'desktop', key) ?? '—'}`)
      return `${site.domain}\nOverall score: ${site.overall}/100\n${categoryLines.join('\n')}`
    })
    const body = [
      'Mobile and Web Benchmark Matrix',
      '', ...reportLines.flatMap(line => [line, ''])
    ].join('\n')
    const composeUrl = `https://mail.google.com/mail/?view=cm&fs=1&tf=1&to=${encodeURIComponent([...new Set(recipients)].join(','))}&su=${encodeURIComponent(`Mobile and Web benchmark matrix — ${comparisonSites.length} websites`)}&body=${encodeURIComponent(body)}`
    window.open(composeUrl, '_blank', 'noopener,noreferrer')
  }

  return <div className="matrix-app">
    <aside className="dashboard-sidebar">
      <div className="sidebar-brand"><span className="brand-mark">stc</span><div><strong>Website benchmark</strong><span>Competitor intelligence</span></div></div>
      <div className="sidebar-label">Dashboard</div>
      <nav aria-label="Dashboard screens">
        <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}><Gauge size={18}/><span>Benchmark overview</span></button>
        <button className={view === 'findings' ? 'active' : ''} onClick={() => setView('findings')}><AlertTriangle size={18}/><span>Audit findings</span><b>{issues.length}</b></button>
        <button className={view === 'emails' ? 'active' : ''} onClick={() => setView('emails')}><Mail size={18}/><span>Emails to send</span></button>
      </nav>
      <div className="sidebar-source"><i></i><span><strong>Google PageSpeed</strong><small>Live audit source</small></span></div>
    </aside>

    <div className="dashboard-body">
    <header className="matrix-topbar">
      <div className="page-context"><span>STC Kuwait digital intelligence</span><strong>{view === 'overview' ? 'Benchmark overview' : view === 'findings' ? 'Audit findings' : 'Emails to send'}</strong></div>
      <div className="top-status"><i></i>Google PageSpeed live</div>
      <div className="report-actions">
        <button onClick={downloadCsv}><Download size={16}/>Excel</button>
        <button className="primary" onClick={() => sites.length ? window.print() : notify('No benchmark results to export')}><FileText size={16}/>PDF report</button>
      </div>
    </header>

    <main className="matrix-main">
      <div className={`view-screen ${view === 'overview' ? 'active' : ''}`}>
      <section className="standard-monitor">
        <div className="standard-monitor-head">
          <div><span>Automated standard monitoring</span><h1>Six websites. One complete score check.</h1><p>All Mobile and Web values are validated before the dashboard is updated or the email is sent.</p></div>
          <div className="automation-actions"><span>Next automatic run<strong>{checkedTime(automation.nextRunAt)}</strong></span><button onClick={runStandardCheck} disabled={automation.status === 'running'}>{automation.status === 'running' ? <RefreshCw className="spin" size={17}/> : <Gauge size={17}/>} {automation.status === 'running' ? `Checking ${automation.progress?.filter(item => item.status === 'complete').length || 0}/6` : 'Check Score Now'}</button></div>
        </div>
        <div className={`automation-status ${automation.status || 'idle'}`}>
          {automation.status === 'running' ? <RefreshCw className="spin" size={15}/> : automation.status === 'failed' ? <AlertTriangle size={15}/> : <Check size={15}/>}
          <span>{automation.status === 'running' ? 'Fetching all eight score values for every website. The report will wait until all six are complete.' : automation.status === 'failed' ? `${automation.error || 'The latest complete check failed.'} Dashboard data was preserved and email was not sent.` : automation.lastCompletedAt ? `Last complete run: ${checkedTime(automation.lastCompletedAt)} · Email ${automation.emailStatus || 'not sent'}` : 'Ready for the first complete six-site score check.'}</span>
        </div>
        <div className="standard-url-grid">
          {(automation.standardUrls || []).map((standardUrl, index) => {
            const domain = new URL(standardUrl).hostname.replace(/^www\./, '')
            const site = sites.find(item => item.standardUrl === standardUrl || item.domain === domain)
            const progress = automation.progress?.find(item => item.url === standardUrl)
            const displayOverall = typeof progress?.overall === 'number' ? progress.overall : site?.overall
            const displayCheckedAt = progress?.checkedAt || site?.scannedAt
            return <article key={standardUrl} className={progress?.status || ''}>
              <i style={{ background: colorForDomain(domain) }}>{index + 1}</i><div><strong>{domain}</strong><small title={standardUrl}>{standardUrl}</small><em><Clock3 size={11}/>Last checked: {checkedTime(displayCheckedAt)}</em></div>
              <b className={typeof displayOverall === 'number' ? scoreTone(displayOverall) : ''}>{displayOverall ?? '—'}</b>
              {progress?.status === 'scanning' && <RefreshCw className="spin card-progress" size={14}/>}
              {progress?.status === 'failed' && <AlertTriangle className="card-progress" size={14}/>}
            </article>
          })}
        </div>
      </section>

      <section className="workspace-stats" aria-label="Workspace summary">
        <div><span>Workspace average</span><strong>{average ?? '—'}<small>{average !== null && '/100'}</small></strong></div>
        <div><span>Websites compared</span><strong>{sites.length}</strong></div>
        <div><span>Total findings</span><strong>{issues.length}</strong></div>
        <div><span>Critical + high</span><strong className="danger-number">{severityCounts[0].count + severityCounts[1].count}</strong></div>
      </section>

      {sites.length > 0 && <section className="site-ribbon">
        {sites.map(site => {
          const siteIssues = issues.filter(issue => issue.site === site.domain)
          return <button key={site.id} className={selectedSite === site.domain ? 'selected' : ''} onClick={() => { setSelectedSite(site.domain); setIssueSite(site.domain) }}>
            <i style={{ background: colorForDomain(site.domain) }}>{site.domain[0].toUpperCase()}</i>
            <span><strong>{site.domain}</strong><small><Clock3 size={11}/>{relativeTime(site.scannedAt)} · {siteIssues.length} issues</small></span>
            <b className={scoreTone(site.overall)}>{site.overall}</b>
          </button>
        })}
      </section>}

      <section className="matrix-panel">
        <div className="section-head">
          <div><span>Score comparison</span><h2>Mobile and Web benchmark matrix</h2></div>
          <p><Smartphone size={14}/>Mobile <Monitor size={14}/>Web <small>90+ strong · 50–89 improve · below 50 poor</small></p>
        </div>
        {comparisonSites.length ? <div className="matrix-scroll matrix-groups">
          {comparisonGroups.map((group, groupIndex) => <div className="matrix-group" key={`matrix-group-${groupIndex}`}>
          <div className="matrix-group-label">Websites {groupIndex * 3 + 1}–{groupIndex * 3 + group.length}</div>
          <div className="score-matrix" style={{ gridTemplateColumns: `170px repeat(${group.length}, minmax(190px, 1fr))` }}>
            <div className="matrix-corner">Audit category</div>
            {group.map((site, index) => <div className="matrix-site" key={site.id}><i style={{ background: colorForDomain(site.domain) }}></i><span>{site.domain}<small>{groupIndex === 0 && index === 0 ? 'Primary website' : 'Competitor'}</small></span><b>{typeof site.overall === 'number' ? site.overall : '—'}</b></div>)}
            {metrics.map(([key, label, Icon]) => <div className="matrix-row" key={key}>
              <div className="metric-label"><Icon size={17}/><span>{label}<small>0–100 score</small></span></div>
              {group.map(site => <div className="dual-score" key={`${site.id}-${key}`}>
                {[['mobile', Smartphone, 'Mobile'], ['desktop', Monitor, 'Web']].map(([device, DeviceIcon, deviceLabel]) => {
                  const value = deviceScore(site, device, key)
                  return <div key={device} className={value == null ? 'missing' : scoreTone(value)} title={value == null ? `Waiting for complete ${deviceLabel} ${label} score` : `${deviceLabel} ${label}: ${value}`}><DeviceIcon size={14}/><span>{deviceLabel}</span><strong>{value ?? '—'}</strong></div>
                })}
              </div>)}
            </div>)}
          </div>
          </div>)}
        </div> : <div className="empty-matrix"><Gauge size={30}/><strong>Your comparison matrix is ready</strong><span>Add your website and competitors above to generate live scores.</span></div>}
      </section>

      </div>

      <div className={`view-screen findings-screen ${view === 'findings' ? 'active' : ''}`}>
      <section className="findings-hero">
        <div><span>Technical audit command center</span><h1>Audit findings</h1><p>Prioritize every issue across your website and competitors, then move from diagnosis to recommended action.</p></div>
        <div className="findings-hero-actions"><button onClick={() => setView('overview')}><Gauge size={16}/>View scores</button><button className="primary" onClick={downloadCsv}><Download size={16}/>Export findings</button></div>
      </section>

      <section className="finding-kpis">
        <div><span>All open issues</span><strong>{issues.length}</strong><small>Across {sites.length} {sites.length === 1 ? 'website' : 'websites'}</small></div>
        <div className="critical"><span>Critical</span><strong>{severityCounts[0].count}</strong><small>Fix immediately</small></div>
        <div className="high"><span>High priority</span><strong>{severityCounts[1].count}</strong><small>Plan next</small></div>
        <div><span>Mobile findings</span><strong>{issues.filter(issue => issue.device !== 'Web').length}</strong><small>Mobile Lighthouse</small></div>
        <div><span>Web findings</span><strong>{issues.filter(issue => issue.device === 'Web').length}</strong><small>Desktop Lighthouse</small></div>
      </section>

      {sites.length > 0 && <section className="issue-site-board">
        <div className="issue-site-intro"><span>Website comparison</span><strong>Where should the team focus first?</strong><small>Select a website to filter the findings below.</small></div>
        {sites.map(site => {
          const siteIssues = issues.filter(issue => issue.site === site.domain)
          const urgent = siteIssues.filter(issue => issue.severity === 'Critical' || issue.severity === 'High').length
          return <button key={site.id} className={issueSite === site.domain ? 'selected' : ''} onClick={() => setIssueSite(issueSite === site.domain ? 'All' : site.domain)}>
            <span><i style={{ background: colorForDomain(site.domain) }}>{site.domain[0].toUpperCase()}</i><b>{site.domain}</b></span>
            <strong>{siteIssues.length}<small>issues</small></strong>
            <em>{urgent} urgent</em>
            <div><i style={{ width: `${siteIssues.length ? urgent / siteIssues.length * 100 : 0}%` }}></i></div>
          </button>
        })}
      </section>}

      <section className="findings-panel">
        <div className="section-head findings-title">
          <div><span>Audit findings</span><h2>Issues and recommended actions</h2></div>
          <div className="findings-tools"><label><Search size={14}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search issues"/></label><select value={issueSite} onChange={event => setIssueSite(event.target.value)}><option value="All">All websites</option>{sites.map(site => <option key={site.id} value={site.domain}>{site.domain}</option>)}</select></div>
        </div>
        <div className="priority-tabs"><button className={severity === 'All' ? 'active' : ''} onClick={() => setSeverity('All')}>All <b>{issues.length}</b></button>{severityCounts.map(item => <button key={item.level} className={severity === item.level ? 'active' : ''} onClick={() => setSeverity(item.level)}>{item.level} <b>{item.count}</b></button>)}</div>
        <div className="findings-table">
          <div className="finding-row table-head"><span>Priority & issue</span><span>Website</span><span>Device</span><span>Category</span><span>Potential gain</span></div>
          {filteredIssues.map(issue => <div className="finding-row" key={issue.id}>
            <div className="finding-name"><i className={issue.severity.toLowerCase()}></i><span><strong>{issue.title}</strong><small>{issue.detail}</small><em>{issue.action}</em></span></div>
            <span className="site-chip">{issue.site}</span><span className="device-chip">{issue.device === 'Web' ? <Monitor size={13}/> : <Smartphone size={13}/>} {issue.device || 'Mobile'}</span><span>{issue.category}</span><b className="gain">{issue.impact}</b>
          </div>)}
          {!filteredIssues.length && <div className="empty-findings"><ShieldCheck size={27}/><strong>No matching issues</strong><span>{sites.length ? 'Change the filters or run a fresh scan.' : 'Audit findings will appear after your first scan.'}</span></div>}
        </div>
      </section>
      </div>

      <div className={`view-screen email-screen ${view === 'emails' ? 'active' : ''}`}>
        <section className="email-hero">
          <div className="email-hero-icon"><Mail size={24}/></div>
          <div><span>Automated reporting</span><h1>Emails to send</h1><p>Configure who receives the clean Mobile and Web score comparison matrix.</p></div>
          <div className={`email-connection ${emailStatus.verified ? 'connected' : emailStatus.errorType === 'ESOCKET' ? 'draft-ready' : ''}`}><i></i><span><strong>{emailStatus.loading ? 'Checking Gmail connection' : emailStatus.verified ? 'Gmail sender connected' : emailStatus.errorType === 'ESOCKET' ? 'Gmail draft mode available' : 'Email service not connected'}</strong><small>{emailStatus.verified ? emailStatus.sender : emailStatus.errorType === 'ESOCKET' ? 'Automatic SMTP is blocked; open a prepared Gmail draft instead' : emailStatus.configured ? 'Gmail could not verify the current credentials' : 'Gmail SMTP credentials required'}</small></span></div>
        </section>

        <section className="email-layout">
          <article className="email-setup-card">
            <div className="email-card-head"><span>Delivery setup</span><h2>Report recipient and schedule</h2><p>Settings can be prepared now. Sending starts only after a secure email service is connected.</p></div>
            <div className="recipient-manager"><span>Business email recipients</span><div className="recipient-entry"><div><Mail size={16}/><input type="email" value={emailRecipient} onChange={event => setEmailRecipient(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addEmailRecipient() } }} placeholder="name@company.com"/></div><button onClick={addEmailRecipient}><UserPlus size={15}/>Add</button></div>
              <div className="saved-recipients"><div><strong>Saved email addresses</strong><small>{emailRecipients.length} recipient{emailRecipients.length === 1 ? '' : 's'}</small></div>{emailRecipients.length ? emailRecipients.map(recipient => <div className="recipient-row" key={recipient}><i><Mail size={13}/></i><span>{recipient}</span><button onClick={() => removeEmailRecipient(recipient)} title={`Remove ${recipient}`}><Trash2 size={14}/></button></div>) : <p>No saved recipients yet.</p>}</div>
            </div>
            <div className="schedule-settings"><label><span>Delivery schedule</span><div><CalendarClock size={16}/><strong>Daily complete report</strong></div></label><label><span>Send time</span><div><Clock3 size={16}/><input type="time" value={emailTime} onChange={event => { setEmailTime(event.target.value); setEmailSchedule('Daily summary') }}/></div></label><small className="timezone-note">Asia/Kuwait timezone. Default: 3:00 PM. The server must stay running for the scheduled check and email.</small></div>
            <div className="email-includes"><span>Report includes only</span><div><b><Check size={13}/>Overall website scores</b><b><Check size={13}/>Four Mobile + Web category scores</b></div></div>
            <div className="email-buttons">{emailStatus.verified ? <button className="connect-email secondary" onClick={() => sendEmailReport()} disabled={emailSending}><Send size={16}/>{emailSending ? 'Sending…' : 'Send report now'}</button> : <button className="connect-email secondary" onClick={openGmailDraft}><Mail size={16}/>Open Gmail draft</button>}<button className="connect-email" onClick={saveEmailDelivery}><Check size={16}/>{emailEnabled ? 'Saved & enabled' : 'Save preferences'}</button></div>
          </article>

          <article className="email-preview-card">
            <div className="email-card-head"><span>Exact email preview</span><h2>Mobile and Web benchmark matrix</h2><p>The email contains this score comparison only.</p></div>
            {comparisonSites.length ? <div className="email-preview-groups">{comparisonGroups.map((group, groupIndex) => <div className="email-matrix-scroll" key={`email-group-${groupIndex}`}><div className="email-preview-group-label">Websites {groupIndex * 3 + 1}–{groupIndex * 3 + group.length}</div><div className="email-preview-matrix" style={{gridTemplateColumns:`125px repeat(${group.length}, minmax(180px,1fr))`}}>
              <div className="email-matrix-corner">Audit category</div>{group.map(site => <div className="email-matrix-site" key={site.id}><span><i style={{background:colorForDomain(site.domain)}}></i><strong>{site.domain}</strong></span><b>{typeof site.overall === 'number' ? site.overall : '—'}</b></div>)}
              {metrics.map(([key,label]) => <div className="email-matrix-row" key={key}><div className="email-metric-name">{label}<small>0–100 score</small></div>{group.map(site => <div className="email-dual-score" key={`${site.id}-${key}`}><span className={deviceScore(site,'mobile',key) == null ? 'missing' : scoreTone(deviceScore(site,'mobile',key))}>Mobile <b>{deviceScore(site,'mobile',key) ?? '—'}</b></span><span className={deviceScore(site,'desktop',key) == null ? 'missing' : scoreTone(deviceScore(site,'desktop',key))}>Web <b>{deviceScore(site,'desktop',key) ?? '—'}</b></span></div>)}</div>)}
            </div></div>)}</div> : <div className="email-empty">Run a website scan to build the report preview.</div>}
          </article>
        </section>
      </div>
    </main>
    </div>
    {toast && <div className="toast"><Check size={16}/>{toast}</div>}
  </div>
}

export default App
