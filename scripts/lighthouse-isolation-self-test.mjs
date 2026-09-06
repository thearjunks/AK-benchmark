import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { launch } from 'chrome-launcher'
import path from 'node:path'

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end('<!doctype html><html lang="en"><head><title>Audit verification</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Lighthouse verification page"></head><body><main><h1>Audit verification</h1><p>Content available for concurrent audit testing.</p></main></body></html>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const root = path.resolve('work/lighthouse-profiles')
await mkdir(root, { recursive: true })
try {
  await Promise.all(['mobile', 'desktop'].map(async formFactor => {
    const userDataDir = await mkdtemp(path.join(root, 'isolation-test-'))
    const chrome = await launch({ userDataDir, chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'], handleSIGINT: false })
    let worker
    let timer
    try {
      const result = await new Promise((resolve, reject) => {
        worker = new Worker(new URL('./lighthouse-audit-thread.mjs', import.meta.url), {
          workerData: { url: `http://127.0.0.1:${server.address().port}/`, options: {
            port: chrome.port, logLevel: 'silent', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
            formFactor, screenEmulation: { disabled: true }, throttlingMethod: 'provided'
          } }
        })
        worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message))
        worker.once('error', reject)
        timer = setTimeout(() => reject(new Error('Isolation verification timed out')), 60000)
      })
      assert.ok(!result.lhr.runtimeError, JSON.stringify(result.lhr.runtimeError))
      for (const name of ['performance', 'accessibility', 'best-practices', 'seo']) assert.equal(typeof result.lhr.categories[name].score, 'number')
      console.log(`${formFactor}: all four real Lighthouse category scores returned`)
    } finally {
      clearTimeout(timer)
      await worker?.terminate()
      await chrome.kill()
    }
  }))
} finally {
  server.closeAllConnections()
  server.close()
}
