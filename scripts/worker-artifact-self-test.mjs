import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readSignedWorkerResult } from '../worker-artifact.mjs'
const token = 'test-signing-secret'
const url = 'https://www.stc.com.kw/en'
const body = JSON.stringify({ requestId: 'test-request', url, ok: true, devices: { mobile: { scores: { performance: 0, seo: 100, accessibility: 96, bestPractices: 46 } } } })
const envelope = { body, signature: `sha256=${createHmac('sha256', token).update(body).digest('hex')}` }
assert.equal(readSignedWorkerResult(envelope, token, 'test-request', url).devices.mobile.scores.performance, 0)
assert.throws(() => readSignedWorkerResult({ ...envelope, body: body.replace('100', '99') }, token, 'test-request', url), /signature/)
assert.throws(() => readSignedWorkerResult(envelope, token, 'other-request', url), /match/)
assert.throws(() => readSignedWorkerResult(envelope, token, 'test-request', 'https://www.kw.zain.com/en/shop'), /match/)
assert.throws(() => readSignedWorkerResult(envelope, 'wrong-secret', 'test-request', url), /signature/)
console.log('Signed artifact verification passed: tampering and mismatched audit requests rejected; real zero scores retained.')
