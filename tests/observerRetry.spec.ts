import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BgaResponseError } from '../src/helper/bgaResponse'
import { classifyObserverFailure, describeErrorSafely, retryDelay, sanitizeEndpoint } from '../src/helper/observerRetry'

describe('observer failure diagnostics', () => {
  it('maps typed BGA response errors to their declared reason and retryability', () => {
    const session = new BgaResponseError('session_expired', true, { stage: 'tableinfos', applicationCode: '806', responseType: 'object' })
    assert.deepEqual(classifyObserverFailure(session), { retryable: true, reason: 'session_expired', applicationCode: '806' })
    const business = new BgaResponseError('bga_error', false, { stage: 'tableinfos', applicationCode: '100', responseType: 'object' })
    assert.deepEqual(classifyObserverFailure(business), { retryable: false, reason: 'bga_error', applicationCode: '100' })
  })

  it('keeps TypeError and other program errors permanent', () => {
    assert.equal(classifyObserverFailure(new TypeError('x is undefined')).retryable, false)
    assert.equal(classifyObserverFailure(new TypeError('x')).reason, 'unexpected_error')
  })

  it('describes errors by safe name, metadata and code frame only', () => {
    const error = new TypeError('leak PHPSESSID=secret token=abc')
    error.stack = [
      'TypeError: leak PHPSESSID=secret token=abc',
      '    at fetch (https://en.boardgamearena.com/table?table=1&token=abc:1:1)',
      '    at TableObserver.initOnce (/app/dist/service/tableObserver.js:171:20)',
    ].join('\n')
    const description = describeErrorSafely(error)
    assert.equal(description, 'errorName=TypeError frame=/app/dist/service/tableObserver.js:171:20')

    const custom = new Error('x')
    custom.name = 'Bad Name PHPSESSID=secret'
    custom.stack = 'Error: x'
    assert.equal(describeErrorSafely(custom), 'errorName=Error frame=none')
    assert.equal(describeErrorSafely('raw string secret'), 'errorName=non_error frame=none')

    const typed = new BgaResponseError('invalid_response', true, { stage: 'gamestate', responseType: 'html' })
    assert.match(describeErrorSafely(typed), /^errorName=BgaResponseError stage=gamestate responseType=html /)
  })

  it('labels axios errors with their safe code only', () => {
    assert.equal(describeErrorSafely({ isAxiosError: true, code: 'ECONNRESET', message: 'secret' }), 'errorName=AxiosError code=ECONNRESET')
    assert.equal(describeErrorSafely({ isAxiosError: true, code: 'bad code!', message: 'secret' }), 'errorName=AxiosError code=unrecognized')
  })
})

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
