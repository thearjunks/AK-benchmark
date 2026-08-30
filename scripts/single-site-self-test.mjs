import assert from 'node:assert/strict'
import { standardUrlIndex } from '../vite.config.js'

assert.equal(standardUrlIndex('https://www.stc.com.kw/en'), 0)
assert.equal(standardUrlIndex('https://www.kw.zain.com/en/shop'), 1)
assert.equal(standardUrlIndex('https://www.ooredoo.com.kw/en'), 2)
assert.equal(standardUrlIndex('https://example.com'), -1)
assert.equal(standardUrlIndex('not a URL'), -1)

console.log('Single-site URL validation passed.')
