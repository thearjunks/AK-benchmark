import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, CalendarClock, Check, Clock3, Download, FileText, Gauge, Globe2,
  History, Mail, Monitor, Plus, RefreshCw, Search, Send, ShieldCheck, Smartphone, Sparkles, Trash2, UserPlus
} from 'lucide-react'

const metrics = [
  ['performance', 'Performance', Gauge],
  ['accessibility', 'Accessibility', ShieldCheck],
  ['bestPractices', 'Best practices', Sparkles],
  ['seo', 'SEO', Search]
]
const historyMetrics = [
  ['SEO', 'seo'],
  ['Best Practices', 'bestPractices'],
  ['Accessibility', 'accessibility'],
  ['Performance', 'performance'],
  ['Overall', 'overall']
]
const websiteLabels = {
  'stc.com.kw': 'STC Kuwait',
  'kw.zain.com': 'Zain Kuwait',
  'ooredoo.com.kw': 'Ooredoo Kuwait',
  'stc.com.sa': 'STC Saudi Arabia',
  'stc.com.bh': 'STC Bahrain',
  'virgin.com': 'Virgin'
}
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

function kuwaitDateKey(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuwait', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(date)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function historyDateLabel(dateKey) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${dateKey}T12:00:00Z`))
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
  const [emailReportType, setEmailReportType] = useState(() => localStorage.getItem('benchmark-email-report-type') || 'benchmark')
  const [emailEnabled, setEmailEnabled] = useState(() => localStorage.getItem('benchmark-email-enabled') === 'true')
  const [autoSendAfterCheck, setAutoSendAfterCheck] = useState(() => localStorage.getItem('benchmark-auto-send-after-check') === 'true')
  const [emailStatus, setEmailStatus] = useState({ configured: false, sender: null, loading: true })
  const [emailSending, setEmailSending] = useState(false)
  const [automation, setAutomation] = useState({ status: 'loading', standardUrls: [], progress: [], sites: [], nextRunAt: null })
  const [history, setHistory] = useState([])
  const [historyDevice, setHistoryDevice] = useState('All')
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
  const historySites = [...new Set(history.map(record => record.domain))]
  const standardHistoryDomains = (automation.standardUrls || []).map(standardUrl => new URL(standardUrl).hostname.replace(/^www\./, ''))
  const historyDomains = standardHistoryDomains.length ? standardHistoryDomains : historySites
  const historyDevices = historyDevice === 'All' ? ['Mobile', 'Web'] : [historyDevice]
  const historyLookup = new Map()
  history.forEach(record => {
    const key = `${kuwaitDateKey(record.checkedAt)}|${record.domain}|${record.device}`
    const current = historyLookup.get(key)
    if (!current || new Date(record.checkedAt) > new Date(current.checkedAt)) historyLookup.set(key, record)
  })
  const historyDates = [...new Set(history.map(record => kuwaitDateKey(record.checkedAt)))].sort()
  const recentHistoryDates = [...historyDates].reverse().slice(0, 3)

  useEffect(() => localStorage.setItem('webpulse-live-sites-v1', JSON.stringify(sites)), [sites])
  useEffect(() => localStorage.setItem('webpulse-live-issues-v1', JSON.stringify(issues)), [issues])
  useEffect(() => { sitesRef.current = sites }, [sites])
  useEffect(() => { comparisonSitesRef.current = comparisonSites }, [comparisonSites])
  useEffect(() => { issuesRef.current = issues }, [issues])
  useEffect(() => {
    fetch('/api/email-status').then(response => response.json()).then(status => setEmailStatus({ ...status, loading: false })).catch(() => setEmailStatus({ configured: false, sender: null, loading: false }))
  }, [])
  useEffect(() => {
    let active = true
    const refreshHistory = async () => {
      try {
        const response = await fetch('/api/history', { cache: 'no-store' })
        if (!response.ok) return
        const result = await response.json()
        if (active) setHistory(Array.isArray(result.history) ? result.history : [])
      } catch { /* history remains at its last loaded state */ }
    }
    refreshHistory()
    const timer = window.setInterval(refreshHistory, 15000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    fetch('/api/email-settings').then(response => response.json()).then(settings => {
      if (Array.isArray(settings.recipients) && settings.recipients.length) setEmailRecipients(settings.recipients)
      else if (emailRecipients.length) persistEmailSettings(emailRecipients)
      if (settings.schedule) setEmailSchedule(settings.schedule)
      if (settings.time) setEmailTime(settings.time)
      if (settings.day) setEmailDay(settings.day)
      if (settings.reportType === 'benchmark' || settings.reportType === 'history') {
        setEmailReportType(settings.reportType)
        localStorage.setItem('benchmark-email-report-type', settings.reportType)
      }
      if (typeof settings.autoSendAfterCheck === 'boolean') {
        setAutoSendAfterCheck(settings.autoSendAfterCheck)
        localStorage.setItem('benchmark-auto-send-after-check', String(settings.autoSendAfterCheck))
      }
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
        window.setTimeout(() => sendEmailReport(emailRecipients.join(','), true, 'benchmark'), 800)
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

  async function downloadHistoryExcel() {
    try {
      const response = await fetch('/api/history.xlsx', { cache: 'no-store' })
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        throw new Error(result.error || 'Excel history export failed')
      }
      const blob = await response.blob()
      const disposition = response.headers.get('Content-Disposition') || ''
      const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `website-benchmark-history-${new Date().toISOString().slice(0, 10)}.xlsx`
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = filename
      link.click()
      URL.revokeObjectURL(link.href)
      notify('Complete score history workbook downloaded')
    } catch (error) { notify(error.message || 'Excel history export failed') }
  }

  async function sendEmailReport(recipient = emailRecipients.join(','), automatic = false, reportType = emailReportType) {
    if (!emailStatus.configured) return notify('Gmail is not connected on the server')
    const recipients = String(recipient).split(',').map(value => value.trim()).filter(Boolean)
    if (!recipients.length || recipients.some(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) return notify('Add at least one valid recipient email address')
    if (reportType === 'history' && !history.length) return notify('No Score History Report is available yet')
    if (reportType === 'benchmark' && !comparisonSitesRef.current.length) return notify('Run at least one website scan first')
    setEmailSending(true)
    try {
      const response = await fetch(reportType === 'history' ? '/api/history-email-report' : '/api/email-report', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reportType === 'history' ? { recipient } : { recipient,
          sites: comparisonSitesRef.current.map(site => ({
            domain: site.domain, overall: site.overall,
            deviceScores: {
              mobile: Object.fromEntries(metrics.map(([key]) => [key, deviceScore(site, 'mobile', key)])),
              desktop: Object.fromEntries(metrics.map(([key]) => [key, deviceScore(site, 'desktop', key)]))
            }
          })) })
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Email delivery failed')
      const label = reportType === 'history' ? 'Score History Report' : 'Benchmark Report'
      notify(automatic ? `Automatic ${label} sent to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}` : `${label} sent manually to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`)
    } catch (error) { notify(error.message || 'Email delivery failed') }
    finally { setEmailSending(false) }
  }

  async function persistEmailSettings(recipients = emailRecipients, overrides = {}) {
    try {
      await fetch('/api/email-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients, schedule: emailSchedule, time: emailTime, day: emailDay, enabled: true, autoSendAfterCheck, reportType: emailReportType, monthlyHistoryEnabled: true, ...overrides })
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

  async function toggleAutoSendAfterCheck() {
    if (automation.status === 'running') return
    const next = !autoSendAfterCheck
    setAutoSendAfterCheck(next)
    localStorage.setItem('benchmark-auto-send-after-check', String(next))
    try {
      const response = await fetch('/api/email-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients: emailRecipients,
          schedule: emailSchedule,
          time: emailTime,
          day: emailDay,
          enabled: true,
          autoSendAfterCheck: next
        })
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Unable to save Auto-Send Email')
      notify(next ? 'Auto-Send Email enabled for completed score checks' : 'Auto-Send Email disabled; reports can be reviewed and sent manually')
    } catch (error) {
      setAutoSendAfterCheck(!next)
      localStorage.setItem('benchmark-auto-send-after-check', String(!next))
      notify(error.message || 'Unable to save Auto-Send Email')
    }
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
    localStorage.setItem('benchmark-email-report-type', emailReportType)
    const canAutomate = emailStatus.verified
    localStorage.setItem('benchmark-email-enabled', String(canAutomate))
    setEmailEnabled(canAutomate)
    persistEmailSettings(recipients, { schedule: emailSchedule, time: emailTime, day: emailDay, reportType: emailReportType, monthlyHistoryEnabled: true })
    notify(canAutomate ? 'Recipients and daily/monthly report schedules saved' : 'Recipients and report schedules saved')
  }

  function selectEmailReportType(value) {
    const next = value === 'history' ? 'history' : 'benchmark'
    setEmailReportType(next)
    localStorage.setItem('benchmark-email-report-type', next)
    persistEmailSettings(emailRecipients, { reportType: next, monthlyHistoryEnabled: true })
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
    if (emailReportType === 'history') {
      if (!history.length) return notify('No Score History Report is available yet')
      const summary = recentHistoryDates.map(dateKey => `${historyDateLabel(dateKey)}\n${historyDomains.map(domain => ['Mobile', 'Web'].map(device => {
        const record = historyLookup.get(`${dateKey}|${domain}|${device}`)
        return `${domain} ${device === 'Web' ? 'Desktop' : device}: ${historyMetrics.map(([label, key]) => `${label} ${record?.[key] ?? 'N/A'}`).join(' | ')}`
      }).join('\n')).join('\n')}`).join('\n\n')
      const composeUrl = `https://mail.google.com/mail/?view=cm&fs=1&tf=1&to=${encodeURIComponent([...new Set(recipients)].join(','))}&su=${encodeURIComponent('Website Score History Report')}&body=${encodeURIComponent(`Website Score History Report\n\n${summary}`)}`
      window.open(composeUrl, '_blank', 'noopener,noreferrer')
      return
    }
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
        <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}><History size={18}/><span>Score history</span><b>{history.length}</b></button>
        <button className={view === 'findings' ? 'active' : ''} onClick={() => setView('findings')}><AlertTriangle size={18}/><span>Audit findings</span><b>{issues.length}</b></button>
        <button className={view === 'emails' ? 'active' : ''} onClick={() => setView('emails')}><Mail size={18}/><span>Emails to send</span></button>
      </nav>
      <div className="sidebar-source"><i></i><span><strong>Google PageSpeed</strong><small>Live audit source</small></span></div>
    </aside>

    <div className="dashboard-body">
    <header className="matrix-topbar">
      <div className="page-context"><span>STC Kuwait digital intelligence</span><strong>{view === 'overview' ? 'Benchmark overview' : view === 'history' ? 'Score history' : view === 'findings' ? 'Audit findings' : 'Emails to send'}</strong></div>
      <div className="top-status"><i></i>Google PageSpeed live</div>
      <div className="report-actions">
        <button onClick={downloadHistoryExcel}><Download size={16}/>Excel history</button>
        <button className="primary" onClick={() => sites.length ? window.print() : notify('No benchmark results to export')}><FileText size={16}/>PDF report</button>
      </div>
    </header>

    <main className="matrix-main">
      <div className={`view-screen ${view === 'overview' ? 'active' : ''}`}>
      <section className="standard-monitor">
        <div className="standard-monitor-head">
          <div><span>Automated standard monitoring</span><h1>Six websites. One complete score check.</h1><p>All Mobile and Web values are validated before the dashboard is updated or the email is sent.</p></div>
          <div className="automation-actions"><span className="next-run">Next automatic run<strong>{checkedTime(automation.nextRunAt)}</strong></span><label className={`auto-send-toggle ${autoSendAfterCheck ? 'enabled' : ''}`} title={autoSendAfterCheck ? 'The completed report will be emailed to all saved recipients' : 'The completed report will wait for manual review'}><input type="checkbox" checked={autoSendAfterCheck} onChange={toggleAutoSendAfterCheck} disabled={automation.status === 'running'}/><span aria-hidden="true"><i></i></span><b>Auto-Send Email<small>{autoSendAfterCheck ? 'Enabled' : 'Disabled'}</small></b></label><button onClick={runStandardCheck} disabled={automation.status === 'running'}>{automation.status === 'running' ? <RefreshCw className="spin" size={17}/> : <Gauge size={17}/>} {automation.status === 'running' ? `Checking ${automation.progress?.filter(item => item.status === 'complete').length || 0}/6` : 'Check Score Now'}</button></div>
        </div>
        <div className={`automation-status ${automation.status || 'idle'}`}>
          {automation.status === 'running' ? <RefreshCw className="spin" size={15}/> : automation.status === 'failed' ? <AlertTriangle size={15}/> : <Check size={15}/>}
          <span>{automation.status === 'running' ? `Fetching all eight score values for every website. ${autoSendAfterCheck ? 'The report will be emailed after all six are complete.' : 'The completed report will be held for manual review.'}` : automation.status === 'failed' ? `${automation.error || 'The latest complete check failed.'} Dashboard data was preserved and email was not sent.` : automation.lastCompletedAt ? `Last complete run: ${checkedTime(automation.lastCompletedAt)} · Email ${automation.emailStatus?.status || 'not sent'}${automation.emailStatus?.message ? ` — ${automation.emailStatus.message}` : ''}` : 'Ready for the first complete six-site score check.'}</span>
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

      <div className={`view-screen history-screen ${view === 'history' ? 'active' : ''}`}>
        <section className="history-hero">
          <div><span>Long-term score tracking</span><h1>Website score history</h1><p>Review every completed Mobile and Web PageSpeed snapshot and download the complete Excel workbook whenever required.</p></div>
          <button onClick={downloadHistoryExcel}><Download size={16}/>Download Excel history</button>
        </section>

        <section className="history-kpis">
          <div><span>History records</span><strong>{history.length}</strong><small>Mobile and Web rows</small></div>
          <div><span>Websites tracked</span><strong>{historySites.length}</strong><small>Ordered competitor set</small></div>
          <div><span>Mobile records</span><strong>{history.filter(record => record.device === 'Mobile').length}</strong><small>Google PageSpeed Mobile</small></div>
          <div><span>Web records</span><strong>{history.filter(record => record.device === 'Web').length}</strong><small>Google PageSpeed Web</small></div>
          <div><span>Latest history</span><strong className="history-latest">{checkedTime(history[0]?.checkedAt)}</strong><small>Asia/Kuwait time</small></div>
        </section>

        <section className="history-panel">
          <div className="history-toolbar"><div><span>Excel-style score archive</span><h2>Six-website history comparison</h2><p>Each row is one Kuwait calendar date. Scroll horizontally to compare every domain.</p></div><div><label>Device view<select value={historyDevice} onChange={event => setHistoryDevice(event.target.value)}><option value="All">Mobile + Desktop</option><option>Mobile</option><option value="Web">Desktop</option></select></label></div></div>
          {historyDates.length ? <div className="history-matrix-scroll"><table className="history-sheet">
            <thead>
              <tr className="history-domain-row"><th className="history-date-head" rowSpan="3">Date</th>{historyDomains.map(domain => <th colSpan={historyDevices.length * historyMetrics.length + 2} style={{'--history-domain-color':colorForDomain(domain)}} key={domain}><strong>{domain}</strong><small>{websiteLabels[domain] || domain}</small></th>)}</tr>
              <tr className="history-device-row">{historyDomains.map(domain => <Fragment key={domain}>{historyDevices.map(device => <th colSpan={historyMetrics.length} style={{'--history-domain-color':colorForDomain(domain)}} key={`${domain}-${device}`}>{device === 'Web' ? <Monitor size={12}/> : <Smartphone size={12}/>} {device === 'Web' ? 'Desktop' : 'Mobile'}</th>)}<th colSpan="2" style={{'--history-domain-color':colorForDomain(domain)}}>Audit details</th></Fragment>)}</tr>
              <tr className="history-metric-row">{historyDomains.map(domain => <Fragment key={domain}>{historyDevices.flatMap(device => historyMetrics.map(([label]) => <th style={{'--history-domain-color':colorForDomain(domain)}} key={`${domain}-${device}-${label}`}>{label}</th>))}<th style={{'--history-domain-color':colorForDomain(domain)}}>Checked date &amp; time</th><th style={{'--history-domain-color':colorForDomain(domain)}}>Source URL</th></Fragment>)}</tr>
            </thead>
            <tbody>{historyDates.map(dateKey => <tr key={dateKey}><th className="history-date-cell">{historyDateLabel(dateKey)}</th>{historyDomains.map(domain => {
              const records = historyDevices.map(device => historyLookup.get(`${dateKey}|${domain}|${device}`)).filter(Boolean)
              const auditRecord = [...records].sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))[0]
              return <Fragment key={`${dateKey}-${domain}`}>{historyDevices.flatMap(device => {
                const record = historyLookup.get(`${dateKey}|${domain}|${device}`)
                return historyMetrics.map(([label, key]) => { const value = record?.[key]; return <td className={typeof value === 'number' ? `history-score ${scoreTone(value)}` : 'history-score missing'} title={`${domain} · ${device === 'Web' ? 'Desktop' : device} · ${label}`} key={`${dateKey}-${domain}-${device}-${key}`}>{typeof value === 'number' ? value : 'N/A'}</td> })
              })}<td className="history-audit-cell">{auditRecord ? checkedTime(auditRecord.checkedAt) : 'N/A'}</td><td className="history-source-cell">{auditRecord?.url ? <a href={auditRecord.url} target="_blank" rel="noreferrer" title={auditRecord.url}>{auditRecord.url}</a> : 'N/A'}</td></Fragment>
            })}</tr>)}</tbody>
          </table></div> : <div className="history-empty"><History size={28}/><strong>No completed score history yet</strong><span>Run Check Score Now. Every successfully completed Mobile and Desktop result will be retained here.</span></div>}
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
          <div><span>Automated reporting</span><h1>Emails to send</h1><p>Send the latest Benchmark Report or the complete Score History Report to the same saved recipients.</p></div>
          <div className={`email-connection ${emailStatus.verified ? 'connected' : emailStatus.errorType === 'ESOCKET' ? 'draft-ready' : ''}`}><i></i><span><strong>{emailStatus.loading ? 'Checking Gmail connection' : emailStatus.verified ? 'Gmail sender connected' : emailStatus.errorType === 'ESOCKET' ? 'Gmail draft mode available' : 'Email service not connected'}</strong><small>{emailStatus.verified ? emailStatus.sender : emailStatus.errorType === 'ESOCKET' ? 'Automatic SMTP is blocked; open a prepared Gmail draft instead' : emailStatus.configured ? 'Gmail could not verify the current credentials' : 'Gmail SMTP credentials required'}</small></span></div>
        </section>

        <section className="email-layout">
          <article className="email-setup-card">
            <div className="email-card-head"><span>Delivery setup</span><h2>Report recipient and schedule</h2><p>Select a report for manual sending. Monthly history delivery uses the same saved recipient list.</p></div>
            <div className="recipient-manager"><span>Business email recipients</span><div className="recipient-entry"><div><Mail size={16}/><input type="email" value={emailRecipient} onChange={event => setEmailRecipient(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addEmailRecipient() } }} placeholder="name@company.com"/></div><button onClick={addEmailRecipient}><UserPlus size={15}/>Add</button></div>
              <div className="saved-recipients"><div><strong>Saved email addresses</strong><small>{emailRecipients.length} recipient{emailRecipients.length === 1 ? '' : 's'}</small></div>{emailRecipients.length ? emailRecipients.map(recipient => <div className="recipient-row" key={recipient}><i><Mail size={13}/></i><span>{recipient}</span><button onClick={() => removeEmailRecipient(recipient)} title={`Remove ${recipient}`}><Trash2 size={14}/></button></div>) : <p>No saved recipients yet.</p>}</div>
            </div>
            <div className="schedule-settings"><label className="report-type-setting"><span>Select Report Type</span><div><FileText size={16}/><select aria-label="Select Report Type" value={emailReportType} onChange={event => selectEmailReportType(event.target.value)}><option value="benchmark">Benchmark Report</option><option value="history">Score History Report</option></select></div></label><label><span>Benchmark schedule</span><div><CalendarClock size={16}/><strong>Daily complete report</strong></div></label><label><span>History schedule</span><div><History size={16}/><strong>First working day monthly</strong></div></label><label><span>Send time</span><div><Clock3 size={16}/><input type="time" value={emailTime} onChange={event => { setEmailTime(event.target.value); setEmailSchedule('Daily summary') }}/></div></label><small className="timezone-note">Sunday–Thursday working week · Asia/Kuwait timezone. Next monthly history report: {checkedTime(automation.nextHistoryEmailAt)}. The server must stay running.</small></div>
            <div className="email-includes"><span>{emailReportType === 'history' ? 'Score History Report includes' : 'Benchmark Report includes'}</span><div>{emailReportType === 'history' ? <><b><Check size={13}/>All saved historical scan dates</b><b><Check size={13}/>Mobile + Desktop scores and audit sources</b></> : <><b><Check size={13}/>Overall website scores</b><b><Check size={13}/>Four Mobile + Web category scores</b></>}</div></div>
            <div className="email-buttons">{emailStatus.verified ? <button className="connect-email secondary" onClick={() => sendEmailReport()} disabled={emailSending}><Send size={16}/>{emailSending ? 'Sending…' : 'Send Manually'}</button> : <button className="connect-email secondary" onClick={openGmailDraft}><Mail size={16}/>Open manual Gmail draft</button>}<button className="connect-email" onClick={saveEmailDelivery}><Check size={16}/>{emailEnabled ? 'Schedules saved' : 'Save preferences'}</button></div>
          </article>

          <article className="email-preview-card">
            <div className="email-card-head"><span>Email preview</span><h2>{emailReportType === 'history' ? 'Website Score History Report' : 'Mobile and Web benchmark matrix'}</h2><p>{emailReportType === 'history' ? 'The complete email follows the same STC report format and includes every saved date.' : 'The email contains this score comparison only.'}</p></div>
            {emailReportType === 'history' ? (historyDates.length ? <div className="history-email-preview"><div className="history-preview-summary"><span><b>{historyDomains.length}</b> websites</span><span><b>{historyDates.length}</b> scan dates</span><span><b>{history.length}</b> Mobile + Desktop records</span></div>{recentHistoryDates.map(dateKey => <div className="history-preview-date" key={dateKey}><strong>{historyDateLabel(dateKey)}</strong><div>{historyDomains.map(domain => { const mobile = historyLookup.get(`${dateKey}|${domain}|Mobile`); const desktop = historyLookup.get(`${dateKey}|${domain}|Web`); return <span key={`${dateKey}-${domain}`}><b>{domain}</b><small>Mobile {mobile?.overall ?? 'N/A'} · Desktop {desktop?.overall ?? 'N/A'}</small></span> })}</div></div>)}</div> : <div className="email-empty">Run a website scan to build the Score History Report.</div>) : (comparisonSites.length ? <div className="email-preview-groups">{comparisonGroups.map((group, groupIndex) => <div className="email-matrix-scroll" key={`email-group-${groupIndex}`}><div className="email-preview-group-label">Websites {groupIndex * 3 + 1}–{groupIndex * 3 + group.length}</div><div className="email-preview-matrix" style={{gridTemplateColumns:`125px repeat(${group.length}, minmax(180px,1fr))`}}>
              <div className="email-matrix-corner">Audit category</div>{group.map(site => <div className="email-matrix-site" key={site.id}><span><i style={{background:colorForDomain(site.domain)}}></i><strong>{site.domain}</strong></span><b>{typeof site.overall === 'number' ? site.overall : '—'}</b></div>)}
              {metrics.map(([key,label]) => <div className="email-matrix-row" key={key}><div className="email-metric-name">{label}<small>0–100 score</small></div>{group.map(site => <div className="email-dual-score" key={`${site.id}-${key}`}><span className={deviceScore(site,'mobile',key) == null ? 'missing' : scoreTone(deviceScore(site,'mobile',key))}>Mobile <b>{deviceScore(site,'mobile',key) ?? '—'}</b></span><span className={deviceScore(site,'desktop',key) == null ? 'missing' : scoreTone(deviceScore(site,'desktop',key))}>Web <b>{deviceScore(site,'desktop',key) ?? '—'}</b></span></div>)}</div>)}
            </div></div>)}</div> : <div className="email-empty">Run a website scan to build the report preview.</div>)}
          </article>
        </section>
      </div>
    </main>
    </div>
    {toast && <div className="toast"><Check size={16}/>{toast}</div>}
  </div>
}

export default App
