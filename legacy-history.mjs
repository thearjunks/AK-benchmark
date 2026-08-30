export const LEGACY_HISTORY_CUTOFF = '2026-08-11'

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
}

const LEGACY_SITES = [
  { domain: 'stc.com.kw', website: 'STC Kuwait', page: 'Homepage', url: 'https://www.stc.com.kw/en' },
  { domain: 'kw.zain.com', website: 'Zain Kuwait', page: 'Shop', url: 'https://www.kw.zain.com/en/shop' },
  { domain: 'ooredoo.com.kw', website: 'Ooredoo Kuwait', page: 'Homepage', url: 'https://www.ooredoo.com.kw/en' },
  { domain: 'virgin.com', website: 'Virgin', page: 'Homepage', url: 'https://www.virgin.com/' },
  { domain: 'stc.com.sa', website: 'STC Saudi Arabia', page: 'Personal homepage', url: 'https://www.stc.com.sa/en/personal/home.html' },
  { domain: 'stc.com.bh', website: 'STC Bahrain', page: 'Homepage', url: 'https://www.stc.com.bh/' }
]

function sourceDateKey(value) {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(String(value).trim())
  if (!match || !MONTHS[match[2]]) throw new Error(`Invalid legacy history date: ${value}`)
  const year = match[3].length === 2 ? `20${match[3]}` : match[3]
  return `${year}-${MONTHS[match[2]]}-${match[1].padStart(2, '0')}`
}

function score(value, rowNumber, columnNumber) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Invalid legacy score at row ${rowNumber}, column ${columnNumber}.`)
  }
  return parsed
}

export function parseLegacyDesktopHistory(csvText) {
  const lines = String(csvText).replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim())
  if (lines.length < 3) throw new Error('Legacy history CSV has no data rows.')
  const rowsByDate = new Map()

  lines.slice(2).forEach((line, index) => {
    const rowNumber = index + 3
    const columns = line.split(',').map(value => value.trim())
    if (!columns[0]) return
    if (columns.length !== 25) throw new Error(`Legacy history row ${rowNumber} must contain 25 columns.`)
    const date = sourceDateKey(columns[0])
    if (date >= LEGACY_HISTORY_CUTOFF) return
    rowsByDate.set(date, { date, rowNumber, values: columns.slice(1) })
  })

  return [...rowsByDate.values()].flatMap(row => LEGACY_SITES.map((site, siteIndex) => {
    const offset = siteIndex * 4
    const seo = score(row.values[offset], row.rowNumber, offset + 2)
    const bestPractices = score(row.values[offset + 1], row.rowNumber, offset + 3)
    const accessibility = score(row.values[offset + 2], row.rowNumber, offset + 4)
    const performance = score(row.values[offset + 3], row.rowNumber, offset + 5)
    return {
      id: `legacy-desktop-${site.domain}-${row.date}`,
      ...site,
      device: 'Web',
      checkedAt: `${row.date}T09:00:00.000Z`,
      seo,
      bestPractices,
      accessibility,
      performance,
      overall: Math.round((seo + bestPractices + accessibility + performance) / 4),
      source: 'Imported historical desktop CSV',
      historicalImport: true,
      dateOnly: true
    }
  }))
}

export function parseLegacyMobileHistory(csvText) {
  const lines = String(csvText).replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length < 3) throw new Error('Legacy mobile history CSV has no data rows.')
  const rowsByDate = new Map()
  // Source groups: STC Homepage, Zain Homepage, Ooredoo Homepage,
  // Virgin Mobile Homepage, STC KSA, and STC Bahrain.
  const groupStarts = [1, 13, 21, 25, 29, 33]

  lines.slice(2).forEach((line, index) => {
    const rowNumber = index + 3
    const columns = line.split(',').map(value => value.trim())
    if (!columns[0]) return
    if (columns.length !== 37) throw new Error(`Legacy mobile history row ${rowNumber} must contain 37 columns.`)
    const date = sourceDateKey(columns[0])
    if (date >= LEGACY_HISTORY_CUTOFF) return
    rowsByDate.set(date, { date, rowNumber, values: columns })
  })

  return [...rowsByDate.values()].flatMap(row => LEGACY_SITES.map((site, siteIndex) => {
    const start = groupStarts[siteIndex]
    const seo = score(row.values[start], row.rowNumber, start + 1)
    const bestPractices = score(row.values[start + 1], row.rowNumber, start + 2)
    const accessibility = score(row.values[start + 2], row.rowNumber, start + 3)
    const performance = score(row.values[start + 3], row.rowNumber, start + 4)
    return {
      id: `legacy-mobile-${site.domain}-${row.date}`,
      ...site,
      device: 'Mobile',
      checkedAt: `${row.date}T09:00:00.000Z`,
      seo,
      bestPractices,
      accessibility,
      performance,
      overall: Math.round((seo + bestPractices + accessibility + performance) / 4),
      source: 'Imported historical mobile CSV',
      historicalImport: true,
      dateOnly: true
    }
  }))
}
