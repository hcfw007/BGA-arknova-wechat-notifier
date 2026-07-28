import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pickExactPlayer } from '../src/helper/bgaPayload'

// 真实的 findplayer.html?q=Theim 返回：前缀搜索，会带回一堆不相干的人
const findPlayerResponse = {
  items: [
    { id: '94073546', q: 'Theim' },
    { id: '97330476', q: 'theimada' },
    { id: '84222845', q: 'TheImbaNess' },
    { id: '93932664', q: 'theimitator' },
  ],
}

describe('pickExactPlayer', () => {

  it('picks only the exactly matching name', () => {
    assert.deepEqual(pickExactPlayer(findPlayerResponse, 'Theim'), {
      kind: 'found',
      player: { id: '94073546', name: 'Theim' },
    })
  })

  // 大小写必须一致，否则 "theim" 会悄悄订阅到 "Theim" 之外的人
  it('is case sensitive', () => {
    assert.deepEqual(pickExactPlayer(findPlayerResponse, 'theim'), { kind: 'none' })
    assert.deepEqual(pickExactPlayer(findPlayerResponse, 'THEIM'), { kind: 'none' })
  })

  it('never falls back to a prefix match', () => {
    assert.deepEqual(pickExactPlayer(findPlayerResponse, 'The'), { kind: 'none' })
    assert.deepEqual(pickExactPlayer(findPlayerResponse, 'Theimx'), { kind: 'none' })
  })

  // 宁可不订阅，也不能替用户从重名里挑一个
  it('reports every candidate instead of guessing when a name is not unique', () => {
    const duplicated = { items: [{ id: '1', q: 'Same' }, { id: '2', q: 'Same' }] }
    assert.deepEqual(pickExactPlayer(duplicated, 'Same'), {
      kind: 'ambiguous',
      matches: [{ id: '1', name: 'Same' }, { id: '2', name: 'Same' }],
    })
  })

  it('trims the query but not the candidates', () => {
    assert.equal(pickExactPlayer(findPlayerResponse, '  Theim  ').kind, 'found')
  })

  it('returns none on a malformed payload', () => {
    assert.deepEqual(pickExactPlayer(null, 'Theim'), { kind: 'none' })
    assert.deepEqual(pickExactPlayer({}, 'Theim'), { kind: 'none' })
    assert.deepEqual(pickExactPlayer({ items: 'nope' }, 'Theim'), { kind: 'none' })
  })
})
