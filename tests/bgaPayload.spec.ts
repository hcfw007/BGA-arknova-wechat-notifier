import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getExpectedPlayers, resultFromTableInfo } from '../src/helper/bgaPayload'

// 形状取自真实的 tableinfos.html 响应（data 节点）
const finishedTable = {
  status: 'finished',
  result: {
    player: [
      { name: 'UrUncleMe', score: '112', score_aux: '3', gamerank: '2' },
      { name: 'MyOnlyStarCN', score: '134', score_aux: '0', gamerank: '1' },
      { name: 'Theim', score: '98', score_aux: '1', gamerank: '3' },
    ],
  },
}

describe('resultFromTableInfo', () => {

  it('sorts players by rank and coerces gamerank to a number', () => {
    assert.deepEqual(resultFromTableInfo(finishedTable), [
      { name: 'MyOnlyStarCN', score: '134', score_aux: '0', rank: 1 },
      { name: 'UrUncleMe', score: '112', score_aux: '3', rank: 2 },
      { name: 'Theim', score: '98', score_aux: '1', rank: 3 },
    ])
  })

  it('returns null when the table carries no result yet', () => {
    assert.equal(resultFromTableInfo({ status: 'play' }), null)
    assert.equal(resultFromTableInfo({ status: 'play', result: {} }), null)
    assert.equal(resultFromTableInfo({ status: 'play', result: { player: [] } }), null)
  })

  it('returns null instead of throwing on a missing payload', () => {
    assert.equal(resultFromTableInfo(null), null)
    assert.equal(resultFromTableInfo(undefined), null)
    assert.equal(resultFromTableInfo({ result: { player: 'not-an-array' } }), null)
  })
})

describe('getExpectedPlayers', () => {

  it('returns only the players who have not sat down yet', () => {
    const tableInfo = {
      players: {
        '1': { fullname: 'Theim', table_status: 'play' },
        '2': { fullname: 'UrUncleMe', table_status: 'expected' },
        '3': { fullname: 'MyOnlyStarCN', table_status: 'expected' },
      },
    }
    assert.deepEqual(getExpectedPlayers(tableInfo), ['UrUncleMe', 'MyOnlyStarCN'])
  })

  it('returns an empty list once everyone has joined', () => {
    const tableInfo = {
      players: {
        '1': { fullname: 'Theim', table_status: 'play' },
        '2': { fullname: 'UrUncleMe', table_status: 'play' },
      },
    }
    assert.deepEqual(getExpectedPlayers(tableInfo), [])
  })

  it('returns an empty list instead of throwing on a missing payload', () => {
    assert.deepEqual(getExpectedPlayers(null), [])
    assert.deepEqual(getExpectedPlayers(undefined), [])
    assert.deepEqual(getExpectedPlayers({}), [])
  })
})
