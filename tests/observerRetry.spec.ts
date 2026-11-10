import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyObserverFailure, retryDelay, sanitizeEndpoint } from '../src/helper/observerRetry'

describe('observer retry policy', () => {
  const axiosFailure = (details: Record<string, unknown>) => ({ isAxiosError: true, ...details })

  it('retries every server error and 429', () => {
    for (const status of [429, 501, 503, 599]) {
      assert.equal(classifyObserverFailure(axiosFailure({ response: { status } })).retryable, true)
    }
    for (const status of [400, 401, 404]) {
      assert.equal(classifyObserverFailure(axiosFailure({ response: { status } })).retryable, false)
    }
  })

  it('retries known network failures but pauses ordinary errors', () => {
    assert.equal(classifyObserverFailure(axiosFailure({ code: 'ECONNRESET' })).retryable, true)
    assert.equal(classifyObserverFailure(new Error('bad payload')).retryable, false)
  })

  it('logs only a sanitized request endpoint and table identifier', () => {
    assert.equal(
      sanitizeEndpoint('https://en.boardgamearena.com/table/infos?id=123&token=secret&cookie=private'),
      'https://en.boardgamearena.com/table/infos?id=123',
    )
    assert.equal(sanitizeEndpoint('https://en.boardgamearena.com/path?token=secret'), 'https://en.boardgamearena.com/path')
  })

  it('uses capped exponential backoff and honors Retry-After', () => {
    assert.equal(retryDelay(1, undefined, 0, () => 0.5), 60_000)
    assert.equal(retryDelay(8, undefined, 0, () => 0.5), 900_000)
    assert.equal(retryDelay(1, '120', 0, () => 0.5), 120_000)
    assert.equal(retryDelay(1, '-1', 0, () => 0.5), 60_000)
    assert.equal(retryDelay(1, 'invalid', 0, () => 0.5), 60_000)
    assert.equal(retryDelay(1, 'Wed, 21 Oct 2099 07:28:00 GMT', 0, () => 0.5), Date.parse('Wed, 21 Oct 2099 07:28:00 GMT'))
    assert.equal(retryDelay(1, '1e308', 0, () => 0.5), 60_000)
    assert.equal(retryDelay(1, 'Infinity', 0, () => 0.5), 60_000)
    assert.equal(retryDelay(1, '1e3', 0, () => 0.5), 60_000)
    assert.equal(retryDelay(1, '1.5', 0, () => 0.5), 60_000)
    assert.equal(retryDelay(1, '2040-01-01', 0, () => 0.5), 60_000)
    assert.equal(retryDelay(1, 120, 0, () => 0.5), 120_000)
  })
})
