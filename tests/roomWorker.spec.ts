import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

interface ObserverState {
  kind: 'ready' | 'retrying' | 'paused'
  failure?: { reason: string }
  nextRetryAt?: number
  elapsed?: number
  elapsedMs?: number
}

interface WorkerHarness {
  tableObserveList: Array<{ tableId: string; subscribers: Array<{ id: string }>; observer: Record<string, unknown> }>
  retryNoticeAt: Map<string, number>
  subscribeTable(tableId: string, target: { id: string; sync(): Promise<void> }, announce?: boolean): Promise<void>
  bindEvents(entry: WorkerHarness['tableObserveList'][number]): void
  safeSay(target: { id: string }, text: string): Promise<void>
  reportCurrentState(entry: WorkerHarness['tableObserveList'][number]): void
  persistState(): void
  sendAlarm(text: string): Promise<void>
  logger: { error(...args: unknown[]): void; info(...args: unknown[]): void }
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

function target(id: string, say: (text: string) => Promise<void> = async () => undefined) {
  return { id, sync: async () => undefined, say }
}

describe('RoomWorker observer status handling', () => {
  it('reports retrying or paused state instead of announcing stale ready players', async () => {
    const worker = await makeWorker()
    const messages: string[] = []
    let stateReports = 0
    let retries = 0
    const observer = {
      ready: true,
      status: { kind: 'retrying', failure: { reason: 'server_error' }, nextRetryAt: Date.now() + 60_000, elapsed: 125_000 } as ObserverState,
      retryNow: () => { retries++ },
    }
    const existingTarget = target('first')
    worker.tableObserveList = [{ tableId: '42', subscribers: [existingTarget], observer }]
    worker.retryNoticeAt = new Map()
    worker.logger = { error: () => undefined, info: () => undefined }
    worker.safeSay = async (_recipient, text) => { messages.push(text) }
    worker.reportCurrentState = () => { stateReports++ }
    worker.persistState = () => undefined

    await worker.subscribeTable('42', target('new', async () => undefined), false)
    assert.equal(messages.length, 1)
    assert.match(messages[0], /正在恢复连接/)
    assert.match(messages[0], /异常持续\d+分钟/)
    assert.match(messages[0], /北京时间.*UTC\+08:00/)
    assert.equal(stateReports, 0)
    assert.equal(retries, 0)

    observer.status = { kind: 'paused', failure: { reason: 'http_error' }, elapsedMs: 180_000 }
    await worker.subscribeTable('42', target('paused-new'), false)
    assert.match(messages[1], /已暂停/)
    assert.equal(retries, 0)

    await worker.subscribeTable('42', target('admin'), true)
    assert.match(messages.at(-1) ?? '', /已暂停/)
    assert.equal(retries, 1)
  })

  it('isolates subscriber send failures and keeps paused subscriptions active', async () => {
    const worker = await makeWorker()
    const attempts: string[] = []
    const alarms: string[] = []
    const failingTarget = target('fails', async () => { attempts.push('fails'); throw new Error('send failed') })
    const workingTarget = target('works', async () => { attempts.push('works') })
    const observer = Object.assign(new EventEmitter(), {
      ready: true,
      currentPlayers: ['Player'],
      waitingForJoin: false,
      close: () => undefined,
      getContactFromPlayer: () => undefined,
    })
    const entry = { tableId: '43', subscribers: [failingTarget, workingTarget], observer } as unknown as WorkerHarness['tableObserveList'][number]
    worker.tableObserveList = [entry]
    worker.retryNoticeAt = new Map()
    worker.logger = { error: () => undefined, info: () => undefined }
    worker.sendAlarm = async text => { alarms.push(text) }
    worker.persistState = () => undefined
    worker.bindEvents(entry)

    observer.emit('retrying', { reason: 'server_error', failures: 1, nextRetryAt: Date.now() + 60_000, elapsed: 0 })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(attempts, ['fails', 'works'])
    assert.equal(worker.tableObserveList.length, 1)

    observer.emit('retrying', { reason: 'server_error', failures: 2, nextRetryAt: Date.now() + 120_000, elapsed: 60_000 })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(attempts.length, 2)
    worker.retryNoticeAt.set('43', Date.now() - 30 * 60_000)
    observer.emit('retrying', { reason: 'server_error', failures: 3, nextRetryAt: Date.now() + 240_000, elapsed: 120_000 })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(attempts.length, 4)

    observer.emit('paused', { reason: 'http_error', stage: 'poll' })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(alarms.length, 1)
    assert.equal(attempts.length, 6)
    assert.equal(worker.tableObserveList.length, 1)
    observer.emit('retrying', { reason: 'server_error', failures: 0, nextRetryAt: Date.now(), elapsed: 0, manual: true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(attempts.length, 8)
  })

  it('persists subscribers while their observer is retrying', async () => {
    const worker = await makeWorker()
    const entry = {
      tableId: '44',
      subscribers: [target('room-a'), target('contact-b')],
      observer: { status: { kind: 'retrying', failure: { reason: 'network_error' } } },
    }
    worker.tableObserveList = [entry]
    const internals = worker as unknown as {
      stateStore: { save(state: { tables: Array<{ tableId: string; subscribers: Array<{ id: string }> }> }): void }
      playerSubscribeList: unknown[]
    }
    let saved: { tables: Array<{ tableId: string; subscribers: Array<{ id: string }> }> } | undefined
    internals.stateStore = { save: state => { saved = state } }
    internals.playerSubscribeList = []

    worker.persistState()

    assert.deepEqual(saved?.tables, [{
      tableId: '44',
      subscribers: [{ type: 'contact', id: 'room-a' }, { type: 'contact', id: 'contact-b' }],
    }])
  })

  it('starts the recovery notification before one current-state send', async () => {
    const worker = await makeWorker()
    const order: string[] = []
    const observer = Object.assign(new EventEmitter(), { close: () => undefined })
    const entry = { tableId: '45', subscribers: [target('recipient')], observer } as unknown as WorkerHarness['tableObserveList'][number]
    worker.tableObserveList = [entry]
    worker.retryNoticeAt = new Map([['45', Date.now()]])
    worker.logger = { error: () => undefined, info: () => undefined }
    worker.safeSay = async (_recipient, text) => { order.push(`recovered:${text}`) }
    worker.reportCurrentState = () => { order.push('state') }
    worker.persistState = () => undefined

    worker.bindEvents(entry)
    observer.emit('recovered', { stage: 'poll', wasReady: true, elapsedMs: 125_000 })

    assert.match(order[0], /中断2分钟/)
    assert.deepEqual(order.map(message => message.startsWith('recovered:') ? 'recovered' : message), ['recovered', 'state'])
    assert.equal(worker.retryNoticeAt.has('45'), false)
  })
})
