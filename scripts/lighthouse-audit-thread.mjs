import { parentPort, workerData } from 'node:worker_threads'
import lighthouse from 'lighthouse'

// Lighthouse's timing logger is process-global. A worker gives each audit its
// own timing entries, including when a timed-out audit is terminated.
try {
  const result = await lighthouse(workerData.url, workerData.options)
  parentPort.postMessage({ lhr: result?.lhr })
} catch (error) {
  parentPort.postMessage({ error: error?.message || String(error) })
}
