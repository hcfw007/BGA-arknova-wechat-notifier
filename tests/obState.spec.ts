import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseObState } from '../src/helper/obState'

const legacyFile = [
  { tableId: '889222765', subscribers: [{ type: 'room', id: 'room-1' }] },
]

describe('parseObState', () => {

  // 线上跑着的实例存的就是这个裸数组格式，认不下来就会丢掉所有正在 ob 的桌
  it('accepts the v1 bare-array file and keeps every table', () => {
    assert.deepEqual(parseObState(legacyFile), {
      tables: legacyFile,
      players: [],
    })
  })

  it('reads the v2 object file', () => {
    const v2 = {
      tables: legacyFile,
      players: [{ playerId: '94073546', playerName: 'Theim', subscribers: [{ type: 'room', id: 'room-1' }] }],
    }
    assert.deepEqual(parseObState(v2), v2)
  })

  it('fills in a missing half of the v2 file', () => {
    assert.deepEqual(parseObState({ tables: legacyFile }), { tables: legacyFile, players: [] })
    assert.deepEqual(parseObState({ players: [] }), { tables: [], players: [] })
  })

  it('falls back to empty on junk instead of throwing', () => {
    assert.deepEqual(parseObState(null), { tables: [], players: [] })
    assert.deepEqual(parseObState('nope'), { tables: [], players: [] })
    assert.deepEqual(parseObState({ tables: 'nope', players: 7 }), { tables: [], players: [] })
  })
})
