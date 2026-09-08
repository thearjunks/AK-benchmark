export const WEBSITE_ORDER = [
  'stc.com.kw',
  'stc.com.sa',
  'stc.com.bh',
  'virginmobile.com.kw',
  'kw.zain.com',
  'ooredoo.com.kw'
]

export function orderWebsites(items = [], select = item => item.domain ?? item) {
  const rank = item => {
    const value = String(select(item))
    const domain = (value.includes('://') ? new URL(value).hostname : value).replace(/^www\./, '')
    const index = WEBSITE_ORDER.indexOf(domain === 'virgin.com' ? 'virginmobile.com.kw' : domain)
    return index < 0 ? WEBSITE_ORDER.length : index
  }
  return [...items].sort((a, b) => rank(a) - rank(b))
}
