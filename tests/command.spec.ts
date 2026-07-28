import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseCommand } from '../src/helper/command'

describe('parseCommand', () => {

  it('parses ob commands regardless of case', () => {
    for (const text of ['ob 123', 'Ob 123', 'OB 123']) {
      assert.deepEqual(parseCommand(text), { action: 'ob', tableId: '123' })
    }
  })

  it('parses both the Chinese and English stop commands', () => {
    assert.deepEqual(parseCommand('停止 123'), { action: 'stop', tableId: '123' })
    assert.deepEqual(parseCommand('stop 123'), { action: 'stop', tableId: '123' })
    assert.deepEqual(parseCommand('STOP 123'), { action: 'stop', tableId: '123' })
  })

  it('tolerates surrounding and repeated whitespace', () => {
    assert.deepEqual(parseCommand('  ob 123  '), { action: 'ob', tableId: '123' })
    assert.deepEqual(parseCommand('ob   123'), { action: 'ob', tableId: '123' })
    assert.deepEqual(parseCommand('停止\t123'), { action: 'stop', tableId: '123' })
  })

  it('keeps the full table id', () => {
    assert.deepEqual(parseCommand('ob 889222765'), { action: 'ob', tableId: '889222765' })
  })

  // 回归：命令未锚定时，群聊里随口一句以数字结尾的话会误触发订阅/退订
  it('ignores commands embedded in ordinary chat', () => {
    assert.equal(parseCommand('帮我 ob 123'), undefined)
    assert.equal(parseCommand('ob 123 谢谢'), undefined)
    assert.equal(parseCommand('这局打完了 stop 123'), undefined)
    assert.equal(parseCommand('别 停止 123 啊'), undefined)
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
})
