export const WEBSITE_ORDER = [
  'stc.com.kw',
  'stc.com.sa',
  'stc.com.bh',
  'virgin.com',
  'kw.zain.com',
  'ooredoo.com.kw'
]

export function orderWebsites(items = [], select = item => item.domain ?? item) {
  const rank = item => {
    const value = String(select(item))
    const domain = (value.includes('://') ? new URL(value).hostname : value).replace(/^www\./, '')
    const index = WEBSITE_ORDER.indexOf(domain)
    return index < 0 ? WEBSITE_ORDER.length : index
  }
  return [...items].sort((a, b) => rank(a) - rank(b))
}
