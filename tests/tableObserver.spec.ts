import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { TableObserver } from '../src/service/tableObserver'

interface ObserverInternals {
  http: AxiosInstance
}

interface FakeTimers {
  enable(options: { apis: string[]; now: number }): void
  tick(milliseconds: number): void
  reset(): void
}

const flushAsync = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
}

const readyTableInfo = {
  status: 'ongoing',
  players: { '7': { fullname: 'Player', table_status: 'expected' } },
}

function makeResponse(config: InternalAxiosRequestConfig, data: unknown, status = 200, headers: Record<string, unknown> = {}): AxiosResponse {
  return { config, data, status, statusText: 'OK', headers: headers as AxiosResponse['headers'] }
}

function makeHttpError(config: InternalAxiosRequestConfig, status: number, retryAfter?: string): AxiosError {
  const response = makeResponse(config, {}, status, retryAfter ? { 'retry-after': retryAfter } : {})
  return new AxiosError('request failed', 'ERR_BAD_RESPONSE', config, undefined, response)
}

describe('TableObserver retry lifecycle', () => {
  it('keeps retrying after five poll failures, resets the counter, and emits recovery once', async (context) => {
    const timers = context.mock.timers as unknown as FakeTimers
    timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 })
    const observer = new TableObserver('789')
    const internals = observer as unknown as ObserverInternals
    let tableInfoRequests = 0
    let initialTableInfo = true
    let failuresRemaining = 5
    internals.http.defaults.adapter = async config => {
      if (config.url?.includes('tableinfos.html')) {
        tableInfoRequests++
        if (initialTableInfo) {
          initialTableInfo = false
          return makeResponse(config, { data: readyTableInfo })
        }
        if (failuresRemaining > 0) {
          failuresRemaining--
          throw makeHttpError(config, 503)
        }
        return makeResponse(config, { data: readyTableInfo })
      }
      return makeResponse(config, 'requestToken: ' + 'a'.repeat(64), 200, { 'set-cookie': ['sid=secret; Path=/'] })
    }
    const retryEvents: Array<{ failures: number; reminder?: boolean; manual?: boolean }> = []
    let recoveredEvents = 0
    let readyEvents = 0
    observer.on('retrying', event => retryEvents.push(event))
    observer.on('recovered', () => { recoveredEvents++ })
    observer.on('ready', () => { readyEvents++ })

    await observer.init()
    const waitForRequestFailure = (): Promise<{ failures: number; nextRetryAt: number }> => new Promise(resolve => {
      const onRetrying = (event: { failures: number; nextRetryAt: number; reminder?: boolean; manual?: boolean }): void => {
        if (event.reminder || event.manual) return
        observer.off('retrying', onRetrying)
        resolve(event)
      }
      observer.on('retrying', onRetrying)
    })
    let nextRetry = waitForRequestFailure()
    timers.tick(60_000)
    await flushAsync()
    let retryState = await nextRetry
    for (let attempt = 2; attempt <= 5; attempt++) {
      nextRetry = waitForRequestFailure()
      timers.tick(retryState.nextRetryAt - Date.now() + 1)
      await flushAsync()
      retryState = await nextRetry
    }
    timers.tick(retryState.nextRetryAt - Date.now() + 1)
    await flushAsync()

    assert.equal(tableInfoRequests, 7)
    assert.deepEqual(retryEvents.filter(event => !event.reminder && !event.manual).map(event => event.failures), [1, 2, 3, 4, 5])
    assert.equal(recoveredEvents, 1)
    assert.equal(readyEvents, 1)

    failuresRemaining = 1
    const resetRetry = waitForRequestFailure()
    timers.tick(60_000)
    await flushAsync()
    assert.equal((await resetRetry).failures, 1)
    observer.close()
    timers.reset()
  })

  it('parses the initial game state and emits a move after the active player changes', async (context) => {
    const timers = context.mock.timers as unknown as FakeTimers
    timers.enable({ apis: ['setTimeout', 'Date'], now: 60_000 })
    const observer = new TableObserver('active-game')
    const internals = observer as unknown as ObserverInternals
    let gameStateRequests = 0
    const tableInfo = {
      status: 'ongoing',
      players: { '1': { fullname: 'Alice' }, '2': { fullname: 'Bob' } },
      gameserver: 'arknova',
      game_name: 'arknova',
    }
    internals.http.defaults.adapter = async config => {
      if (config.url?.includes('tableinfos.html')) return makeResponse(config, { data: tableInfo })
      if (config.url?.includes('/arknova/')) {
        gameStateRequests++
        const activePlayer = gameStateRequests === 1 ? '1' : '2'
        return makeResponse(config, `prefix "gamestate":{"active_player":"${activePlayer}"} suffix`)
      }
      return makeResponse(config, 'requestToken: ' + 'f'.repeat(64), 200, { 'set-cookie': ['sid=safe; Path=/'] })
    }
    const moves = new Promise<string[]>(resolve => observer.once('newPlayerMove', resolve))

    await observer.init()
    assert.deepEqual(observer.currentPlayers, ['Alice'])
    timers.tick(60_000)
    await flushAsync()

    assert.deepEqual(await moves, ['Bob'])
    assert.equal(gameStateRequests, 2)
    assert.deepEqual(observer.currentPlayers, ['Bob'])
    observer.close()
    timers.reset()
  })

  it('returns from init while scheduling retries for server failures', async () => {
    const observer = new TableObserver('123')
    const internals = observer as unknown as ObserverInternals
    let requests = 0
    internals.http.defaults.adapter = async config => {
      requests++
      throw new AxiosError('request failed', 'ERR_BAD_RESPONSE', config, undefined, {
        data: {}, status: 503, statusText: 'Unavailable', headers: {}, config,
      } satisfies AxiosResponse)
    }
    const retry = new Promise<{ status?: number }>(resolve => observer.once('retrying', resolve))

    await observer.init()
    const retryState = await retry
    observer.close()

    assert.equal(requests, 1)
    assert.equal(retryState.status, 503)
  })

  it('orders initial recovery before current-state notification without emitting a second ready', async (context) => {
    const timers = context.mock.timers as unknown as FakeTimers
    timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000 })
    const observer = new TableObserver('initial-recovery')
    const internals = observer as unknown as ObserverInternals
    let firstRequest = true
    internals.http.defaults.adapter = async config => {
      if (firstRequest) {
        firstRequest = false
        throw makeHttpError(config, 503)
      }
      if (config.url?.includes('tableinfos.html')) return makeResponse(config, { data: readyTableInfo })
      return makeResponse(config, 'requestToken: ' + 'b'.repeat(64), 200, { 'set-cookie': ['sid=safe; Path=/'] })
    }
    const events: string[] = []
    observer.on('ready', () => events.push('ready'))
    observer.on('recovered', () => events.push('recovered'))

    await observer.init()
    const status = observer.status
    assert.equal(status.kind, 'retrying')
    if (status.kind !== 'retrying') throw new Error('observer should be retrying')
    timers.tick(status.nextRetryAt - Date.now() + 1)
    await flushAsync()

    assert.deepEqual(events, ['recovered'])
    assert.equal(observer.status.kind, 'ready')
    observer.close()
    timers.reset()
  })

  it('sends 30-minute outage reminders without retrying before a long Retry-After', async (context) => {
    const timers = context.mock.timers as unknown as FakeTimers
    timers.enable({ apis: ['setTimeout', 'Date'], now: 20_000 })
    const observer = new TableObserver('long-retry-after')
    const internals = observer as unknown as ObserverInternals
    let requests = 0
    internals.http.defaults.adapter = async config => {
      requests++
      throw makeHttpError(config, 429, '7200')
    }
    const retryEvents: Array<{ reminder?: boolean }> = []
    observer.on('retrying', event => retryEvents.push(event))

    await observer.init()
    timers.tick(30 * 60_000)
    await flushAsync()
    timers.tick(30 * 60_000)
    await flushAsync()

    assert.equal(requests, 1)
    assert.equal(retryEvents.length, 3)
    assert.deepEqual(retryEvents.map(event => event.reminder ?? false), [false, true, true])
    observer.close()
    timers.tick(3 * 60 * 60_000)
    await flushAsync()
    assert.equal(requests, 1)
    timers.reset()
  })

  it('keeps the 30-minute reminder deadline stable across ordinary retry failures', async (context) => {
    const timers = context.mock.timers as unknown as FakeTimers
    timers.enable({ apis: ['setTimeout', 'Date'], now: 70_000 })
    const observer = new TableObserver('ordinary-reminder')
    const internals = observer as unknown as ObserverInternals
    let initialTableInfo = true
    internals.http.defaults.adapter = async config => {
      if (config.url?.includes('tableinfos.html')) {
        if (initialTableInfo) {
          initialTableInfo = false
          return makeResponse(config, { data: readyTableInfo })
        }
        throw makeHttpError(config, 503)
      }
      return makeResponse(config, 'requestToken: ' + 'a'.repeat(64), 200, { 'set-cookie': ['sid=safe; Path=/'] })
    }
    let reminderCount = 0
    const retries: Array<{ nextRetryAt: number; reminder?: boolean }> = []
    observer.on('retrying', event => {
      retries.push(event)
      if (event.reminder) reminderCount++
    })
    const nextRetry = (): Promise<{ nextRetryAt: number }> => new Promise(resolve => observer.once('retrying', resolve))

    await observer.init()
    let eventPromise = nextRetry()
    timers.tick(60_000)
    await flushAsync()
    let failure = await eventPromise
    const firstFailureAt = Date.now()
    for (let failures = 2; failures <= 4; failures++) {
      eventPromise = nextRetry()
      timers.tick(failure.nextRetryAt - Date.now() + 1)
      await flushAsync()
      failure = await eventPromise
    }

    timers.tick(firstFailureAt + 30 * 60_000 - Date.now())
    await flushAsync()

    assert.equal(reminderCount, 1)
    assert.equal(retries.filter(event => event.reminder).length, 1)
    observer.close()
    timers.reset()
  })

  it('segments Retry-After waits beyond the setTimeout maximum without an early request', async (context) => {
    const timers = context.mock.timers as unknown as FakeTimers
    timers.enable({ apis: ['setTimeout', 'Date'], now: 30_000 })
    const observer = new TableObserver('segmented-retry-after')
    const internals = observer as unknown as ObserverInternals
    let requests = 0
    internals.http.defaults.adapter = async config => {
      requests++
      throw makeHttpError(config, 429, '3000000')
    }

    await observer.init()
    timers.tick(2_147_000_000)
    await flushAsync()

    assert.equal(requests, 1)
    const state = observer.status
    assert.equal(state.kind, 'retrying')
    if (state.kind !== 'retrying') throw new Error('observer should remain retrying')
    assert.ok(state.nextRetryAt > Date.now())
    observer.close()
    timers.reset()
  })

  it('pauses on a permanent response and resumes with a fresh recovery cycle on explicit retry', async (context) => {
    const timers = context.mock.timers as unknown as FakeTimers
    timers.enable({ apis: ['setTimeout', 'Date'], now: 40_000 })
    const observer = new TableObserver('manual-retry')
    const internals = observer as unknown as ObserverInternals
    let tableInfoRequests = 0
    internals.http.defaults.adapter = async config => {
      if (config.url?.includes('tableinfos.html')) {
        tableInfoRequests++
        return makeResponse(config, tableInfoRequests === 1 ? { data: {} } : { data: readyTableInfo })
      }
      return makeResponse(config, 'requestToken: ' + 'd'.repeat(64), 200, { 'set-cookie': ['sid=safe; Path=/'] })
    }
    const events: string[] = []
    observer.on('paused', () => events.push('paused'))
    observer.on('retrying', event => { if (event.manual) events.push('manual-retry') })
    observer.on('recovered', () => events.push('recovered'))
    observer.on('ready', () => events.push('ready'))

    await observer.init()
    assert.equal(observer.status.kind, 'paused')
    observer.retryNow()
    await flushAsync()

    assert.deepEqual(events, ['paused', 'manual-retry', 'recovered'])
    assert.equal(observer.status.kind, 'ready')
    observer.close()
    timers.reset()
  })

  it('does not restart polling after a terminal end event', async (context) => {
    const timers = context.mock.timers as unknown as FakeTimers
    timers.enable({ apis: ['setTimeout', 'Date'], now: 50_000 })
    const observer = new TableObserver('finished-table')
    const internals = observer as unknown as ObserverInternals
    let requests = 0
    internals.http.defaults.adapter = async config => {
      requests++
      if (config.url?.includes('tableinfos.html')) return makeResponse(config, { data: { status: 'finished' } })
      return makeResponse(config, 'requestToken: ' + 'e'.repeat(64), 200, { 'set-cookie': ['sid=safe; Path=/'] })
    }
    let endEvents = 0
    observer.on('end', () => { endEvents++ })

    await observer.init()
    assert.equal(observer.status.kind, 'terminal')
    timers.tick(10 * 60_000)
    await flushAsync()

    assert.equal(requests, 2)
    assert.equal(endEvents, 1)
    observer.close()
    timers.reset()
  })

  it('does not emit a retry after close aborts an in-flight request', async () => {
    const observer = new TableObserver('456')
    const internals = observer as unknown as ObserverInternals
    let rejectRequest: ((error: Error) => void) | undefined
    let markRequestStarted: (() => void) | undefined
    const requestStarted = new Promise<void>(resolve => { markRequestStarted = resolve })
    internals.http.defaults.adapter = () => new Promise<AxiosResponse>((_resolve, reject) => {
      rejectRequest = error => reject(error)
      markRequestStarted?.()
    })
    let retryEvents = 0
    observer.on('retrying', () => { retryEvents++ })

    let initializationCompleted = false
    const initialization = observer.init().then(() => { initializationCompleted = true })
    await requestStarted
    await flushAsync()
    assert.equal(initializationCompleted, false)
    observer.close()
    rejectRequest?.(new AxiosError('canceled', 'ERR_CANCELED'))
    await initialization
    assert.equal(initializationCompleted, true)
    await new Promise<void>(resolve => setImmediate(resolve))

    assert.equal(retryEvents, 0)
  })

  it('does not update the shared cookie when close races a successful handshake', async () => {
    let cookieUpdates = 0
    const observer = new TableObserver('cookie-race', {}, undefined, () => { cookieUpdates++ })
    const internals = observer as unknown as ObserverInternals
    let resolveResponse: ((response: AxiosResponse) => void) | undefined
    let requestConfig: InternalAxiosRequestConfig | undefined
    let markRequestStarted: (() => void) | undefined
    const requestStarted = new Promise<void>(resolve => { markRequestStarted = resolve })
    internals.http.defaults.adapter = config => new Promise<AxiosResponse>(resolve => {
      requestConfig = config
      resolveResponse = resolve
      markRequestStarted?.()
    })
    let readyEvents = 0
    observer.on('ready', () => { readyEvents++ })

    const initialization = observer.init()
    await requestStarted
    observer.close()
    const config = requestConfig
    assert.ok(config)
    resolveResponse?.(makeResponse(config, 'requestToken: ' + 'c'.repeat(64), 200, { 'set-cookie': ['sid=late; Path=/'] }))
    await initialization

    assert.equal(cookieUpdates, 0)
    assert.equal(readyEvents, 0)
  })
})
