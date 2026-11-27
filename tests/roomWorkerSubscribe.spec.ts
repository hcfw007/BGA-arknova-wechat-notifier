import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { UnknownPlayerError } from '../src/service/playerClient'

interface FakePlayerClient {
  dropSessionCalls: number
  findPlayerByName(name: string): Promise<unknown>
  listArkNovaTables(playerId: string): Promise<{ playerName?: string; tables: unknown[] }>
  dropSession(): void
}

interface WorkerHarness {
  playerSubscribeList: Array<{ playerId: string; playerName: string; subscribers: Array<{ id: string }>; knownTables: string[] }>
  playerClient: FakePlayerClient
  logger: { error(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void }
  safeSay(target: { id: string }, text: string, mentionList?: unknown[]): Promise<void>
  sendAlarm(text: string): Promise<void>
  persistState(): void
  startPlayerScan(): void
  reportPlayerTables(player: { id: string; name?: string }, target: { id: string }, restored: boolean): Promise<void>
  subscribeTable(tableId: string, target: { id: string }, announce?: boolean): Promise<void>
  subscribePlayer(target: string, reportTarget: { id: string }, announce?: boolean): Promise<void>
  restorePlayerSubscribe(player: { playerId: string; playerName: string }, target: { id: string }): Promise<void>
  restoreState(): Promise<void>
}

async function makeWorker(): Promise<WorkerHarness> {
  const previousToken = process.env.WORK_TOKEN
  if (!previousToken) process.env.WORK_TOKEN = 'test-only-placeholder'
  try {
    const { RoomWorker } = await import('../src/service/roomWorker')
    return Object.create(RoomWorker.prototype) as WorkerHarness
  } finally {
    if (previousToken === undefined) delete process.env.WORK_TOKEN
  }
}

function makePlayerClient(overrides: Partial<FakePlayerClient> = {}): FakePlayerClient {
  return {
    dropSessionCalls: 0,
    findPlayerByName: async () => ({ kind: 'none' }),
    listArkNovaTables: async () => ({ playerName: undefined, tables: [] }),
    dropSession() { this.dropSessionCalls++ },
    ...overrides,
  }
}

function reportTarget(id = 'room-1') {
  return { id, sync: async () => undefined }
}

const silentLogger = { error: () => undefined, info: () => undefined, warn: () => undefined }

describe('RoomWorker player subscription session recovery', () => {
  it('distinguishes an unknown player id from a BGA session failure', async () => {
    const worker = await makeWorker()
    worker.logger = silentLogger
    worker.playerSubscribeList = []
    const messages: string[] = []
    worker.safeSay = async (_target, text) => { messages.push(text) }
    worker.persistState = () => undefined
    worker.startPlayerScan = () => undefined

    worker.playerClient = makePlayerClient({
      listArkNovaTables: async () => { throw new UnknownPlayerError('unknow player') },
    })
    await worker.subscribePlayer('94073546', reportTarget(), true)
    assert.equal(messages.at(-1), 'BGA上没有id为 94073546 的玩家')
    assert.equal(worker.playerClient.dropSessionCalls, 0)
    assert.equal(worker.playerSubscribeList.length, 0)

    worker.playerClient = makePlayerClient({
      findPlayerByName: async () => { throw new Error('806 session expired') },
    })
    await worker.subscribePlayer('Theim', reportTarget(), true)
    assert.equal(messages.at(-1), '订阅 Theim 失败：查询BGA出错')
    assert.equal(worker.playerClient.dropSessionCalls, 1)
    assert.equal(worker.playerSubscribeList.length, 0)
  })

  it('drops the shared session when the table report fails after subscribing', async () => {
    const worker = await makeWorker()
    worker.logger = silentLogger
    worker.playerSubscribeList = []
    const messages: string[] = []
    worker.safeSay = async (_target, text) => { messages.push(text) }
    worker.persistState = () => undefined
    worker.startPlayerScan = () => undefined
    worker.playerClient = makePlayerClient({
      findPlayerByName: async () => ({ kind: 'found', player: { id: '42', name: 'Theim' } }),
      listArkNovaTables: async () => { throw new Error('806 session expired') },
    })

    await worker.subscribePlayer('Theim', reportTarget(), true)

    assert.equal(messages.at(-1), '已订阅 Theim，但查询当前牌桌失败，稍后会自动重试')
    assert.equal(worker.playerClient.dropSessionCalls, 1)
    // 订阅关系已经落下来了，重试由定时扫描兜底
    assert.deepEqual(worker.playerSubscribeList.map(item => item.playerId), ['42'])
  })

  it('lists same-name candidates without subscribing anyone', async () => {
    const worker = await makeWorker()
    worker.logger = silentLogger
    worker.playerSubscribeList = []
    const messages: string[] = []
    worker.safeSay = async (_target, text) => { messages.push(text) }
    worker.persistState = () => undefined
    worker.startPlayerScan = () => undefined
    worker.playerClient = makePlayerClient({
      findPlayerByName: async () => ({
        kind: 'ambiguous',
        matches: [{ id: '1', name: 'Theim' }, { id: '2', name: 'Theim' }],
      }),
    })

    await worker.subscribePlayer('Theim', reportTarget(), true)

    assert.match(messages.at(-1) ?? '', /同名玩家有多个，没有订阅/)
    assert.match(messages.at(-1) ?? '', /Theim  id=1/)
    assert.equal(worker.playerSubscribeList.length, 0)

    worker.playerClient = makePlayerClient()
    await worker.subscribePlayer('NoSuchOne', reportTarget(), true)
    assert.match(messages.at(-1) ?? '', /找不到玩家「NoSuchOne」/)
    assert.equal(worker.playerSubscribeList.length, 0)
  })
})

describe('RoomWorker state restoration', () => {
  it('resubscribes resolved targets, skips lost ones, and alarms on failures', async () => {
    const worker = await makeWorker()
    worker.logger = silentLogger
    worker.playerSubscribeList = []
    const room = { id: 'room-1', sync: async () => undefined }
    const loaded = {
      tables: [
        { tableId: '1', subscribers: [{ type: 'room' as const, id: 'room-1' }, { type: 'contact' as const, id: 'gone' }] },
        { tableId: '2', subscribers: [{ type: 'room' as const, id: 'room-1' }] },
      ],
      players: [
        { playerId: '42', playerName: 'Theim', subscribers: [{ type: 'room' as const, id: 'room-1' }] },
      ],
    }
    let loadCalls = 0
    const internals = worker as unknown as { stateStore: unknown; bot: unknown }
    internals.stateStore = { load: () => { loadCalls++; return loaded }, save: () => undefined }
    internals.bot = {
      Room: { find: async ({ id }: { id: string }) => (id === 'room-1' ? room : undefined) },
      Contact: { find: async () => undefined },
    }
    const subscribed: string[] = []
    worker.subscribeTable = async (tableId: string) => {
      if (tableId === '2') throw new Error('observer init failed')
      subscribed.push(tableId)
    }
    const restoredPlayers: string[] = []
    worker.restorePlayerSubscribe = async (player, target) => { restoredPlayers.push(`${player.playerId}:${target.id}`) }
    const alarms: string[] = []
    worker.sendAlarm = async text => { alarms.push(text) }
    let persisted = 0
    worker.persistState = () => { persisted++ }

    await worker.restoreState()
    await worker.restoreState()

    assert.deepEqual(subscribed, ['1'])
    assert.equal(loadCalls, 1)
    assert.deepEqual(restoredPlayers, ['42:room-1'])
    assert.equal(alarms.length, 1)
    assert.match(alarms[0], /恢复Ob游戏桌2失败/)
    assert.equal(persisted, 1)
  })

  it('restorePlayerSubscribe dedupes subscribers by id and reports tables as restored', async () => {
    const worker = await makeWorker()
    worker.logger = silentLogger
    worker.playerSubscribeList = []
    let scans = 0
    worker.startPlayerScan = () => { scans++ }
    const reports: string[] = []
    worker.reportPlayerTables = async (player, target, restored) => {
      reports.push(`${player.id}:${target.id}:${restored}`)
    }

    const firstInstance = { id: 'room-1', sync: async () => undefined }
    const sameIdOtherInstance = { id: 'room-1', sync: async () => undefined }
    const another = { id: 'room-2', sync: async () => undefined }
    const player = { playerId: '42', playerName: 'Theim' }

    await worker.restorePlayerSubscribe(player, firstInstance)
    // 重启恢复出来的实例与消息里带的不是同一个对象，必须按 id 去重
    await worker.restorePlayerSubscribe(player, sameIdOtherInstance)
    await worker.restorePlayerSubscribe(player, another)

    assert.equal(worker.playerSubscribeList.length, 1)
    assert.deepEqual(worker.playerSubscribeList[0].subscribers.map(sub => sub.id), ['room-1', 'room-2'])
    assert.deepEqual(worker.playerSubscribeList[0].knownTables, [])
    assert.equal(scans, 3)
    assert.deepEqual(reports, ['42:room-1:true', '42:room-1:true', '42:room-2:true'])
  })
})
