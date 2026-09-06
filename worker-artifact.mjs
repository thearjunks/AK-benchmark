import unzipper from 'unzipper'
import { createHmac, timingSafeEqual } from 'node:crypto'

export function readSignedWorkerResult(envelope, token, requestId, url) {
  const body = String(envelope?.body || '')
  if (Buffer.byteLength(body) > 250_000) throw new Error('Worker result exceeds the size limit.')
  const expected = `sha256=${createHmac('sha256', token).update(body).digest('hex')}`
  const signature = String(envelope?.signature || '')
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('Invalid worker artifact signature.')
  const result = JSON.parse(body)
  if (result.requestId !== requestId || result.url !== new URL(url).href) throw new Error('Worker artifact does not match this audit request.')
  return result
}

export async function fetchWorkerArtifact({ repository, githubToken, callbackToken, requestId, url, fetchImpl = fetch }) {
  const api = `https://api.github.com/repos/${repository}/actions/artifacts`
  const headers = { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' }
  const listing = await fetchImpl(`${api}?name=lighthouse-${encodeURIComponent(requestId)}&per_page=10`, { headers, signal: AbortSignal.timeout(15000) })
  if (!listing.ok) throw new Error(`Worker result lookup returned HTTP ${listing.status}.`)
  const { artifacts = [] } = await listing.json()
  const artifact = artifacts.find(item => item.name === `lighthouse-${requestId}` && !item.expired)
  if (!artifact) return null
  if (artifact.size_in_bytes > 1_000_000) throw new Error('Worker result archive exceeds the size limit.')
  const response = await fetchImpl(`${api}/${artifact.id}/zip`, { headers, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Worker result download returned HTTP ${response.status}.`)
  const zip = await unzipper.Open.buffer(Buffer.from(await response.arrayBuffer()))
  const entry = zip.files.find(file => file.path === 'lighthouse-result.json')
  if (!entry || entry.uncompressedSize > 300_000) throw new Error('Worker result file is missing or too large.')
  return readSignedWorkerResult(JSON.parse((await entry.buffer()).toString('utf8')), callbackToken, requestId, url)
}
