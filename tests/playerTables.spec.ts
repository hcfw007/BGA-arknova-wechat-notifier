import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { arkNovaTablesFromPlayerTables } from '../src/helper/bgaPayload'

// 形状取自真实的 tablemanager/tableinfos.html?playerfilter=94073546 返回
const response = {
  status: 1,
  data: {
    player: { player_fullname: 'Theim' },
    tables: {
      '889222765': { id: '889222765', game_name: 'arknova', status: 'asyncplay', progression: '76', cancelled: '0' },
      '888411961': { id: '888411961', game_name: 'arknova', status: 'asyncplay', progression: '29', cancelled: '0' },
    },
  },
}

describe('arkNovaTablesFromPlayerTables', () => {

  it('reads the ark nova tables with their progression', () => {
    assert.deepEqual(arkNovaTablesFromPlayerTables(response), [
      { tableId: '888411961', progression: 29 },
      { tableId: '889222765', progression: 76 },
    ])
  })

  // 这个接口返回该玩家所有游戏的桌，不是只有 Ark Nova
  it('filters out other games', () => {
    const mixed = {
      data: {
        tables: {
          '1': { id: '1', game_name: 'arknova', progression: '10', cancelled: '0' },
          '2': { id: '2', game_name: 'earth', progression: '20', cancelled: '0' },
          '3': { id: '3', game_name: 'terraformingmars', progression: '30', cancelled: '0' },
        },
      },
    }
    assert.deepEqual(arkNovaTablesFromPlayerTables(mixed), [{ tableId: '1', progression: 10 }])
  })

  it('skips cancelled tables', () => {
    const withCancelled = {
      data: {
        tables: {
          '1': { id: '1', game_name: 'arknova', progression: '10', cancelled: '1' },
          '2': { id: '2', game_name: 'arknova', progression: '20', cancelled: '0' },
        },
      },
    }
    assert.deepEqual(arkNovaTablesFromPlayerTables(withCancelled), [{ tableId: '2', progression: 20 }])
  })

  it('returns an empty list when the player has no table', () => {
    assert.deepEqual(arkNovaTablesFromPlayerTables({ status: 1, data: { tables: {} } }), [])
  })

  it('returns an empty list instead of throwing on a malformed payload', () => {
    assert.deepEqual(arkNovaTablesFromPlayerTables(null), [])
    assert.deepEqual(arkNovaTablesFromPlayerTables({}), [])
    assert.deepEqual(arkNovaTablesFromPlayerTables({ data: { tables: 'nope' } }), [])
  })
})
