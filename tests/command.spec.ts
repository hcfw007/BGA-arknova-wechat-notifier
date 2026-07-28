import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { looksLikePlayerId, parseCommand } from '../src/helper/command'

describe('parseCommand', () => {

  it('parses ob commands regardless of case', () => {
    for (const text of ['ob 123', 'Ob 123', 'OB 123']) {
      assert.deepEqual(parseCommand(text), { action: 'ob', target: '123' })
    }
  })

  it('parses both the Chinese and English stop commands', () => {
    assert.deepEqual(parseCommand('停止 123'), { action: 'stop', target: '123' })
    assert.deepEqual(parseCommand('stop 123'), { action: 'stop', target: '123' })
    assert.deepEqual(parseCommand('STOP 123'), { action: 'stop', target: '123' })
  })

  it('tolerates surrounding and repeated whitespace', () => {
    assert.deepEqual(parseCommand('  ob 123  '), { action: 'ob', target: '123' })
    assert.deepEqual(parseCommand('ob   123'), { action: 'ob', target: '123' })
    assert.deepEqual(parseCommand('停止\t123'), { action: 'stop', target: '123' })
  })

  it('keeps the full table id', () => {
    assert.deepEqual(parseCommand('ob 889222765'), { action: 'ob', target: '889222765' })
  })

  // 群里 @机器人 时 text() 带 "@名字 " 前缀，所以开头不能锚定
  it('accepts a leading @mention prefix', () => {
    assert.deepEqual(parseCommand('@ArkNovaBot ob 123'), { action: 'ob', target: '123' })
    assert.deepEqual(parseCommand('@ArkNovaBot 停止 123'), { action: 'stop', target: '123' })
    // 微信在 @名字 后插的是 U+2005 而不是普通空格
    assert.deepEqual(parseCommand('@ArkNovaBot ob 123'), { action: 'ob', target: '123' })
  })

  it('still requires the command to end the message', () => {
    assert.equal(parseCommand('ob 123 谢谢'), undefined)
    assert.equal(parseCommand('别 停止 123 啊'), undefined)
  })

  // 开头放开的代价：句末凑巧是命令形状的闲聊也会命中。
  // 群里靠「必须 @机器人」拦住，私聊只有 admin 能发，风险可接受。
  it('does match a command sitting at the end of a sentence', () => {
    assert.deepEqual(parseCommand('帮我 ob 123'), { action: 'ob', target: '123' })
    assert.deepEqual(parseCommand('这局打完了 stop 123'), { action: 'stop', target: '123' })
  })

  it('rejects malformed commands', () => {
    assert.equal(parseCommand('ob'), undefined)
    assert.equal(parseCommand('ob abc'), undefined)
    assert.equal(parseCommand('obs 123'), undefined)
    assert.equal(parseCommand('ob123'), undefined)
    assert.equal(parseCommand(''), undefined)
    assert.equal(parseCommand('   '), undefined)
  })

  it('survives a null-ish text', () => {
    assert.equal(parseCommand(undefined as unknown as string), undefined)
  })

  it('parses subscribe commands with a name or an id', () => {
    assert.deepEqual(parseCommand('订阅 Theim'), { action: 'subscribe', target: 'Theim' })
    assert.deepEqual(parseCommand('subscribe Theim'), { action: 'subscribe', target: 'Theim' })
    assert.deepEqual(parseCommand('Subscribe 94073546'), { action: 'subscribe', target: '94073546' })
  })

  it('parses unsubscribe commands', () => {
    assert.deepEqual(parseCommand('退订 Theim'), { action: 'unsubscribe', target: 'Theim' })
    assert.deepEqual(parseCommand('unsubscribe Theim'), { action: 'unsubscribe', target: 'Theim' })
  })

  // "unsubscribe x" 整串以 "subscribe x" 结尾，匹配顺序错了就会被当成 subscribe
  it('does not mistake unsubscribe for subscribe', () => {
    assert.equal(parseCommand('unsubscribe Theim').action, 'unsubscribe')
    assert.equal(parseCommand('UNSUBSCRIBE Theim').action, 'unsubscribe')
  })

  it('preserves the exact case of a player name', () => {
    assert.equal(parseCommand('订阅 TheImbaNess').target, 'TheImbaNess')
  })

  it('accepts a mention prefix on subscribe too', () => {
    assert.deepEqual(parseCommand('@ArkNovaBot 订阅 Theim'), { action: 'subscribe', target: 'Theim' })
    assert.deepEqual(parseCommand('@ArkNovaBot unsubscribe Theim'), { action: 'unsubscribe', target: 'Theim' })
  })

  it('ignores subscribe commands that do not end the message', () => {
    assert.equal(parseCommand('订阅 Theim 谢谢'), undefined)
    assert.equal(parseCommand('订阅'), undefined)
  })
})

describe('looksLikePlayerId', () => {

  it('treats an all-digit target as a BGA id', () => {
    assert.equal(looksLikePlayerId('94073546'), true)
  })

  it('treats anything else as a name', () => {
    assert.equal(looksLikePlayerId('Theim'), false)
    assert.equal(looksLikePlayerId('player123'), false)
    assert.equal(looksLikePlayerId('123abc'), false)
    assert.equal(looksLikePlayerId(''), false)
  })
})
