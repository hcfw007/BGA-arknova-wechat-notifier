import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BgaResponseError,
  describeResponseShape,
  extractRequestToken,
  parseGameStatePage,
  parseTableInfoResponse,
} from '../src/helper/bgaResponse'

const ongoing = { status: 'asyncplay', players: { '1': { fullname: 'Alice' } }, gameserver: '1', game_name: 'arknova' }

function rejection(run: () => unknown): BgaResponseError {
  try {
    run()
  } catch (error: unknown) {
    assert.ok(error instanceof BgaResponseError, `expected BgaResponseError, got ${String(error)}`)
    return error
  }
  assert.fail('expected a BgaResponseError')
}

describe('BGA tableinfos response validation', () => {
  it('accepts a successful payload with or without the top-level status', () => {
    assert.equal(parseTableInfoResponse({ status: 1, data: ongoing }).status, 'asyncplay')
    assert.equal(parseTableInfoResponse({ status: '1', data: ongoing }).players['1'].fullname, 'Alice')
    assert.equal(parseTableInfoResponse({ data: ongoing }).game_name, 'arknova')
  })

  it('treats code 806 and the invalid-session message as a retryable expired session', () => {
    const message = 'Invalid session information for this action. Please try reloading the page or logging in again'
    for (const payload of [
      { status: 0, error: message, code: 806 },
      { status: '0', error: 'x', code: '806' },
      { status: 0, error: message },
      { status: 0, error_code: 806, data: ongoing },
    ]) {
      const error = rejection(() => parseTableInfoResponse(payload))
      assert.equal(error.reason, 'session_expired')
      assert.equal(error.retryable, true)
    }
    assert.equal(rejection(() => parseTableInfoResponse({ status: 0, error: message, code: 806 })).details.applicationCode, '806')
  })

  it('pauses on explicit business errors but retries maintenance notices', () => {
    const missing = rejection(() => parseTableInfoResponse({ status: 0, error: 'This table does not exist', code: 100 }))
    assert.equal(missing.reason, 'bga_error')
    assert.equal(missing.retryable, false)
    assert.equal(missing.details.applicationCode, '100')
    assert.ok(!missing.message.includes('does not exist'))

    const maintenance = rejection(() => parseTableInfoResponse({ status: 0, error: 'BGA is under maintenance, try again later' }))
    assert.equal(maintenance.reason, 'bga_unavailable')
    assert.equal(maintenance.retryable, true)
  })

  it('rejects failed status even when data is present', () => {
    assert.equal(rejection(() => parseTableInfoResponse({ status: 0, error: 'nope', code: 7, data: ongoing })).reason, 'bga_error')
  })

  it('classifies malformed external payloads as retryable invalid responses', () => {
    for (const payload of [null, undefined, '', '<html>login</html>', [], 42, {}, { status: 1 }, { data: [] }, { data: {} },
      { data: { status: 'asyncplay' } }, { data: { status: 'asyncplay', players: { '1': null } } }, { status: 0 }]) {
      const error = rejection(() => parseTableInfoResponse(payload))
      assert.equal(error.reason, 'invalid_response')
      assert.equal(error.retryable, true)
    }
  })

  it('accepts finished tables without player details and drops unsafe game locations', () => {
    assert.deepEqual(parseTableInfoResponse({ data: { status: 'finished' } }).players, {})
    assert.equal(parseTableInfoResponse({ data: { ...ongoing, gameserver: '../evil' } }).gameserver, undefined)
    assert.equal(parseTableInfoResponse({ data: { ...ongoing, gameserver: 3 } }).gameserver, '3')
  })

  it('sanitizes application codes', () => {
    assert.equal(rejection(() => parseTableInfoResponse({ status: 0, error: 'x', code: 'token=secret value' })).details.applicationCode, 'unrecognized')
  })
})

describe('BGA game page parsing', () => {
  it('parses the gamestate object and normalizes player ids', () => {
    const state = parseGameStatePage('x "gamestate":{"active_player":7,"multiactive":[1,"2"],"args":{"result":[]}} y')
    assert.equal(state.active_player, '7')
    assert.deepEqual(state.multiactive, ['1', '2'])
    assert.deepEqual(state.args?.result, [])
  })

  it('ignores braces inside JSON strings', () => {
    const state = parseGameStatePage('"gamestate":{"name":"odd}name{","description":"a \\"}\\" b","active_player":"3"};')
    assert.equal(state.active_player, '3')
  })

  it('treats a null active player as missing rather than invalid', () => {
    const multiactive = parseGameStatePage('"gamestate":{"active_player":null,"multiactive":["1"]}')
    assert.deepEqual(multiactive.multiactive, ['1'])
    assert.equal(multiactive.active_player, undefined)
    assert.deepEqual(parseGameStatePage('"gamestate":{"active_player":null,"args":{"result":[]}}').args?.result, [])
    for (const page of ['"gamestate":{"active_player":null}', '"gamestate":{"active_player":{},"multiactive":["1"]}', '"gamestate":{"active_player":true,"multiactive":["1"]}']) {
      assert.equal(rejection(() => parseGameStatePage(page)).reason, 'invalid_response')
    }
  })

  it('accepts a multiactive state without an active player', () => {
    assert.deepEqual(parseGameStatePage('"gamestate":{"name":"pick","multiactive":["4"]}').multiactive, ['4'])
  })

  it('rejects pages without a usable gamestate as retryable invalid responses', () => {
    for (const page of [null, {}, '', '<html>login</html>', '"gamestate":{"active_player":"1"', '"gamestate":{broken}',
      '"gamestate":{}', '"gamestate":{"active_player":{}}', '"gamestate":{"multiactive":"1"}']) {
      const error = rejection(() => parseGameStatePage(page))
      assert.equal(error.reason, 'invalid_response')
      assert.equal(error.details.stage, 'gamestate')
    }
  })
})

describe('BGA handshake token extraction', () => {
  it('extracts the token or rejects login/maintenance pages as invalid responses', () => {
    assert.equal(extractRequestToken(`requestToken: '${'a'.repeat(64)}'`), 'a'.repeat(64))
    for (const page of [null, { html: true }, '<html>maintenance</html>']) {
      const error = rejection(() => extractRequestToken(page))
      assert.equal(error.reason, 'invalid_response')
      assert.equal(error.details.stage, 'handshake')
    }
  })

  it('describes response shapes without content', () => {
    assert.equal(describeResponseShape(null), 'null')
    assert.equal(describeResponseShape('  '), 'empty_text')
    assert.equal(describeResponseShape('<!DOCTYPE html><html>'), 'html')
    assert.equal(describeResponseShape('plain'), 'text')
    assert.equal(describeResponseShape([]), 'array')
    assert.equal(describeResponseShape({}), 'object')
  })
})
