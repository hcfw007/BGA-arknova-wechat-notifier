import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

interface SayRecorder {
  calls: unknown[][]
  say(...args: unknown[]): Promise<void>
}

interface WorkerHarness {
  tableObserveList: Array<{ tableId: string; subscribers: Array<{ id: string }>; observer: unknown; announceReady: boolean }>
  retryNoticeAt: Map<string, number>
  bot: { currentUser?: { name(): string } }
  logger: { error(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void }
  formatRetryTime(timestamp: number): string
  safeSay(target: { id: string }, text: string, mentionList?: unknown[]): Promise<void>
  sendAlarm(text: string): Promise<void>
  isMentioningSelf(message: { mentionSelf(): boolean; text(): string }): boolean
  reportCurrentState(entry: WorkerHarness['tableObserveList'][number]): void
  bindEvents(entry: WorkerHarness['tableObserveList'][number]): void
  persistState(): void
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

function recorder(): SayRecorder {
  const calls: unknown[][] = []
  return { calls, say: async (...args: unknown[]) => { calls.push(args) } }
}

function target(id: string, rec: SayRecorder = recorder()) {
  return { id, sync: async () => undefined, say: rec.say, calls: rec.calls }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('RoomWorker outgoing message primitives', () => {
  it('formats retry deadlines in Beijing time and guards unusable timestamps', async () => {
    const worker = await makeWorker()

    const formatted = worker.formatRetryTime(new Date('2026-11-27T03:05:00Z').getTime())
    assert.match(formatted, /^北京时间 2026年11月27日/)
    assert.match(formatted, /（UTC\+08:00）$/)

    assert.equal(worker.formatRetryTime(Infinity), 'epoch Infinity')
    assert.equal(worker.formatRetryTime(NaN), 'epoch NaN')
    assert.equal(worker.formatRetryTime(10_000_000_000_000_000), 'epoch 10000000000000000')
  })

  it('never forwards an undefined mention list to say()', async () => {
    const worker = await makeWorker()
    worker.logger = { error: () => undefined, info: () => undefined, warn: () => undefined }
    const plain = target('plain')
    const mentioned = target('mentioned')
    const empty = target('empty')
    const contact = { id: 'c1' }

    // say(text, undefined) 会被 Room.say 解析成 mentionList=[undefined] 而抛错，必须只传一个参数
    await worker.safeSay(plain, 'hello')
    await worker.safeSay(empty, 'hello', [])
    await worker.safeSay(mentioned, 'hello', [contact])

    assert.deepEqual(plain.calls, [['hello']])
    assert.deepEqual(empty.calls, [['hello']])
    assert.deepEqual(mentioned.calls, [['hello', { mentionList: [contact] }]])
  })

  it('logs send failures without throwing', async () => {
    const worker = await makeWorker()
    const logged: string[] = []
    worker.logger = { error: (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }, info: () => undefined, warn: () => undefined }
    const failing = target('failing', {
      calls: [],
      say: async () => { throw new Error('send failed') },
    })

    await assert.doesNotReject(() => worker.safeSay(failing, 'hello'))
    assert.equal(logged.length, 1)
    assert.match(logged[0], /messageSendError/)
  })

  it('sendAlarm targets the admin contact only and isolates its failures', async () => {
    const worker = await makeWorker()
    worker.logger = { error: () => undefined, info: () => undefined, warn: () => undefined }
    const alarm = recorder()

    await worker.sendAlarm('no contact configured')
    assert.deepEqual(alarm.calls, [])

    const workerWithContact = await makeWorker()
    workerWithContact.logger = { error: () => undefined, info: () => undefined, warn: () => undefined }
    const contact = { id: 'admin', say: alarm.say }
    ;(workerWithContact as unknown as { contact?: unknown }).contact = contact

    await workerWithContact.sendAlarm('observer paused')
    await workerWithContact.sendAlarm('second alarm')
    assert.deepEqual(alarm.calls, [['observer paused'], ['second alarm']])

    const failingContact = { id: 'admin', say: async () => { throw new Error('send failed') } }
    ;(workerWithContact as unknown as { contact?: unknown }).contact = failingContact
    await assert.doesNotReject(() => workerWithContact.sendAlarm('must not throw'))
  })

  it('isMentioningSelf trusts mentionSelf and falls back to the bot name in text', async () => {
    const worker = await makeWorker()
    worker.logger = { error: () => undefined, info: () => undefined, warn: () => undefined }
    worker.bot = { currentUser: { name: () => 'BotName' } }

    assert.equal(worker.isMentioningSelf({ mentionSelf: () => true, text: () => 'ob 1' }), true)
    assert.equal(worker.isMentioningSelf({ mentionSelf: () => false, text: () => '@BotName ob 1' }), true)
    assert.equal(worker.isMentioningSelf({ mentionSelf: () => false, text: () => 'ob 1' }), false)
    // puppet 给不出 mentionIdList 时 mentionSelf 抛错，退回文本匹配
    assert.equal(worker.isMentioningSelf({
      mentionSelf: () => { throw new Error('mentionIdList missing') },
      text: () => '@BotName 停止 1',
    }), true)

    worker.bot = {}
    assert.equal(worker.isMentioningSelf({ mentionSelf: () => false, text: () => '@BotName ob 1' }), false)
  })
})

describe('RoomWorker state and lifecycle notifications', () => {
  it('formats the turn message with mapped names and assembles the mention list', async () => {
    const worker = await makeWorker()
    worker.logger = { error: () => undefined, info: () => undefined, warn: () => undefined }
    const alice = { id: 'c-alice', name: () => '张三' }
    const observer = {
      currentPlayers: ['Alice', 'Bob'],
      waitingForJoin: false,
      getContactFromPlayer: (player: string) => (player === 'Alice' ? alice : player === 'Bob' ? 'all' : undefined),
    }
    const first = target('room-1')
    const second = target('room-2')
    const entry = { tableId: '77', subscribers: [first, second], observer, announceReady: true }
    const sent: Array<{ targetId: string; text: string; mentionList?: unknown[] }> = []
    worker.safeSay = async (recipient, text, mentionList) => { sent.push({ targetId: recipient.id, text, mentionList }) }

    worker.reportCurrentState(entry as unknown as WorkerHarness['tableObserveList'][number])

    assert.equal(sent.length, 2)
    assert.equal(sent[0].text, '[桌号77] 现在轮到Alice(张三)Bob(所有人)。')
    assert.deepEqual(sent[0].mentionList, [alice, '@all'])
    assert.equal(sent[1].targetId, 'room-2')
  })

  it('formats the waiting-for-join message without mentions for unmapped players', async () => {
    const worker = await makeWorker()
    worker.logger = { error: () => undefined, info: () => undefined, warn: () => undefined }
    const observer = {
      currentPlayers: ['Alice', 'Bob'],
      waitingForJoin: true,
      getContactFromPlayer: () => undefined,
    }
    const sent: Array<{ text: string; mentionList?: unknown[] }> = []
    worker.safeSay = async (_recipient, text, mentionList) => { sent.push({ text, mentionList }) }
    const entry = { tableId: '78', subscribers: [target('room-1')], observer, announceReady: false }

    worker.reportCurrentState(entry as unknown as WorkerHarness['tableObserveList'][number])

    assert.equal(sent.length, 1)
    assert.equal(sent[0].text, '[桌号78] Alice、Bob尚未加入。')
    assert.deepEqual(sent[0].mentionList, [])
  })

  it('announces readiness only when requested and always reports the current state', async () => {
    const worker = await makeWorker()
    worker.logger = { error: () => undefined, info: () => undefined, warn: () => undefined }
    const sent: string[] = []
    worker.safeSay = async (_recipient, text) => { sent.push(text) }
    const reports: string[] = []
    worker.reportCurrentState = entry => { reports.push(entry.tableId) }
    worker.persistState = () => undefined

    const quietObserver = Object.assign(new EventEmitter(), { close: () => undefined })
    const quiet = { tableId: '80', subscribers: [target('room-1')], observer: quietObserver, announceReady: false }
    worker.bindEvents(quiet as unknown as WorkerHarness['tableObserveList'][number])
    quietObserver.emit('ready')
    await flush()
    assert.deepEqual(sent, [])
    assert.deepEqual(reports, ['80'])

    const loudObserver = Object.assign(new EventEmitter(), { close: () => undefined })
    const loud = { tableId: '81', subscribers: [target('room-1'), target('room-2')], observer: loudObserver, announceReady: true }
    worker.bindEvents(loud as unknown as WorkerHarness['tableObserveList'][number])
    loudObserver.emit('ready')
    await flush()
    assert.deepEqual(sent, ['成功OB游戏桌81', '成功OB游戏桌81'])
    assert.deepEqual(reports, ['80', '81'])
  })

  it('formats the end notice with final rankings and cleans up the observation', async () => {
    const worker = await makeWorker()
    worker.logger = { error: () => undefined, info: () => undefined, warn: () => undefined }
    let closed = 0
    const observer = Object.assign(new EventEmitter(), { close: () => { closed++ } })
    const sent: string[] = []
    worker.safeSay = async (_recipient, text) => { sent.push(text) }
    worker.reportCurrentState = () => undefined
    let persisted = 0
    worker.persistState = () => { persisted++ }
    const entry = { tableId: '79', subscribers: [target('room-1')], observer, announceReady: true }
    worker.tableObserveList = [entry]
    worker.retryNoticeAt = new Map([['79', Date.now()]])
    worker.bindEvents(entry as unknown as WorkerHarness['tableObserveList'][number])

    observer.emit('end', [
      { name: 'Alice', score: '120', rank: 1 },
      { name: 'Bob', score: '95', rank: 2 },
    ])
    await flush()

    assert.equal(closed, 1)
    assert.deepEqual(sent, [
      ['游戏桌79已结束', '最终排名：', '  1. Alice  120分', '  2. Bob  95分', '停止OB'].join('\n'),
    ])
    assert.equal(worker.tableObserveList.length, 0)
    assert.equal(worker.retryNoticeAt.has('79'), false)
    assert.equal(persisted, 1)

    const emptyObserver = Object.assign(new EventEmitter(), { close: () => undefined })
    const emptySent: string[] = []
    worker.safeSay = async (_recipient, text) => { emptySent.push(text) }
    const emptyResult = { tableId: '82', subscribers: [target('room-1')], observer: emptyObserver, announceReady: true }
    worker.tableObserveList = [emptyResult]
    worker.bindEvents(emptyResult as unknown as WorkerHarness['tableObserveList'][number])
    emptyObserver.emit('end', [])
    await flush()
    assert.deepEqual(emptySent, [['游戏桌82已结束', '停止OB'].join('\n')])
  })
})
