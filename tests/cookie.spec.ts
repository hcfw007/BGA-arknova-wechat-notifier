import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mergeCookies } from '../src/helper/cookie'

describe('mergeCookies', () => {

  // 回归：原实现直接字符串拼接，每次刷新会话都会让 PHPSESSID 再堆一份
  it('lets the incoming value win for a repeated cookie name', () => {
    assert.equal(
      mergeCookies('PHPSESSID=aaa; foo=1', 'PHPSESSID=bbb; bar=2'),
      'PHPSESSID=bbb; foo=1; bar=2',
    )
  })

  it('does not duplicate a name no matter how often it is merged', () => {
    let cookie = 'PHPSESSID=v1'
    for (const next of ['PHPSESSID=v2', 'PHPSESSID=v3', 'PHPSESSID=v4']) {
      cookie = mergeCookies(cookie, next)
    }
    assert.equal(cookie, 'PHPSESSID=v4')
  })

  it('keeps distinct names from both sides', () => {
    assert.equal(mergeCookies('a=1', 'b=2'), 'a=1; b=2')
  })

  it('handles a missing or empty side', () => {
    assert.equal(mergeCookies(undefined, 'a=1'), 'a=1')
    assert.equal(mergeCookies('a=1', undefined), 'a=1')
    assert.equal(mergeCookies('a=1', ''), 'a=1')
    assert.equal(mergeCookies(undefined, undefined), '')
    assert.equal(mergeCookies('', ''), '')
  })

  it('preserves values that themselves contain "="', () => {
    assert.equal(mergeCookies(undefined, 'token=abc=='), 'token=abc==')
  })

  it('drops malformed fragments instead of emitting junk', () => {
    assert.equal(mergeCookies('a=1; garbage; =novalue', 'b=2'), 'a=1; b=2')
  })

  it('normalises spacing around separators', () => {
    assert.equal(mergeCookies('a=1;b=2', ' c=3 '), 'a=1; b=2; c=3')
  })
})
