import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { TableObserver } from '../src/service/tableObserver'

interface ObserverInternals {
  http: AxiosInstance
  logger: CapturedLogger
}

interface CapturedLogger {
  lines: string[]
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

interface FakeTimers {
  enable(options: { apis: string[]; now: number }): void
  tick(milliseconds: number): void
  reset(): void
}

interface FailureEvent {
  reason: string
  status?: number
  applicationCode?: string
  failures: number
  nextRetryAt: number
  reminder?: boolean
  manual?: boolean
}

const SESSION_MESSAGE = 'Invalid session information for this action. Please try reloading the page or logging in again'
const SECRET_COOKIE = 'bga_secret=top-secret-session'
const flushAsync = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
}
const waitingTable = { status: 'asyncplay', players: { '7': { fullname: 'Player', table_status: 'expected' } } }
const activeTable = { status: 'asyncplay', players: { '1': { fullname: 'Alice' } }, gameserver: '1', game_name: 'arknova' }

function makeResponse(config: InternalAxiosRequestConfig, data: unknown, headers: Record<string, unknown> = {}): AxiosResponse {
  return { config, data, status: 200, statusText: 'OK', headers: headers as AxiosResponse['headers'] }
}

function tokenPage(config: InternalAxiosRequestConfig, round: number): AxiosResponse {
  const token = String(round % 10).repeat(64)
  return makeResponse(config, `requestToken: '${token}'`, { 'set-cookie': [`PHPSESSID=s${round}; Path=/`] })
}

function captureLogs(observer: TableObserver): CapturedLogger {
  const lines: string[] = []
  const record = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')) }
  const logger: CapturedLogger = { lines, info: record, warn: record, error: record }
  ;(observer as unknown as ObserverInternals).logger = logger
  return logger
}

function setAdapter(observer: TableObserver, adapter: (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>): void {
  (observer as unknown as ObserverInternals).http.defaults.adapter = adapter
}

const nextFailure = (observer: TableObserver, name: 'retrying' | 'paused'): Promise<FailureEvent> => new Promise(resolve => {
  const listener = (event: FailureEvent): void => {
    if (event.reminder || event.manual) return
    observer.off(name, listener)
    resolve(event)
  }
  observer.on(name, listener)
})

describe('TableObserver BGA response failures', () => {
  it('retries an initial HTTP 200 invalid-session response with a fresh handshake', async (context) => {
    const timers = context.mock.timers as unknown as FakeTimers
    timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 })
    const observer = new TableObserver('939885558', {}, SECRET_COOKIE)
    const logger = captureLogs(observer)
    let handshakes = 0
    const tableInfoHeaders: Array<{ cookie: string; token: string }> = []
    setAdapter(observer, async config => {
      if (!config.url?.includes('tableinfos.html')) return tokenPage(config, ++handshakes)
      tableInfoHeaders.push({ cookie: String(config.headers.Cookie), token: String(config.headers['X-Request-Token']) })
      return makeResponse(config, tableInfoHeaders.length === 1 ? { status: 0, error: SESSION_MESSAGE, code: 806 } : { data: waitingTable })
    })
    const pausedEvents: unknown[] = []
    let recoveredEvents = 0
    observer.on('paused', event => pausedEvents.push(event))
    observer.on('recovered', () => { recoveredEvents++ })
    const retry = nextFailure(observer, 'retrying')

    await observer.init()
    const event = await retry
    assert.equal(event.reason, 'session_expired')
    assert.equal(event.applicationCode, '806')
    assert.equal(event.status, undefined)
    timers.tick(event.nextRetryAt - Date.now() + 1)
    await flushAsync()

    assert.equal(pausedEvents.length, 0)
    assert.equal(recoveredEvents, 1)
    assert.equal(observer.status.kind, 'ready')
    assert.ok(tableInfoHeaders[0].cookie.includes('top-secret-session'))
    assert.equal(tableInfoHeaders[1].cookie, 'PHPSESSID=s2')
    assert.notEqual(tableInfoHeaders[1].token, tableInfoHeaders[0].token)
    const logs = logger.lines.join('\n')
    assert.match(logs, /reason=session_expired/)
    assert.match(logs, /code=806/)
    assert.ok(!logs.includes('top-secret-session'))
    assert.ok(!logs.includes('Invalid session'))
    assert.ok(!logs.includes('1'.repeat(64)))
    observer.close()
    timers.reset()
  })

  it('keeps retrying repeated poll session failures, then recovers once', async (context) => {
    const timers = context.mock.timers as unknown as FakeTimers
    timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000 })
    const observer = new TableObserver('947790424')
    captureLogs(observer)
    let handshakes = 0
    let tableInfoRequests = 0
    const sessionFailures = [{ status: 0, error: SESSION_MESSAGE, code: '806' }, { status: '0', error: SESSION_MESSAGE }, { status: 0, error_code: 806 }]
    setAdapter(observer, async config => {
      if (!config.url?.includes('tableinfos.html')) return tokenPage(config, ++handshakes)
      tableInfoRequests++
      const failure = tableInfoRequests > 1 ? sessionFailures[tableInfoRequests - 2] : undefined
      return makeResponse(config, failure ?? { data: waitingTable })
    })
    const reasons: string[] = []
    let recoveredEvents = 0
    observer.on('retrying', (event: FailureEvent) => { if (!event.reminder) reasons.push(event.reason) })
    observer.on('paused', () => assert.fail('session failures must not pause'))
    observer.on('recovered', () => { recoveredEvents++ })

    await observer.init()
    let retry = nextFailure(observer, 'retrying')
    timers.tick(60_000)
    await flushAsync()
    for (let attempt = 0; attempt < sessionFailures.length; attempt++) {
      const event = await retry
      retry = nextFailure(observer, 'retrying')
      timers.tick(event.nextRetryAt - Date.now() + 1)
      await flushAsync()
    }

    assert.deepEqual(reasons, ['session_expired', 'session_expired', 'session_expired'])
    assert.equal(recoveredEvents, 1)
    assert.equal(handshakes, 4)
    assert.equal(observer.status.kind, 'ready')
    observer.close()
    timers.reset()
  })

  it('retries malformed tableinfos and handshake responses as invalid_response', async () => {
    const badTableInfos: unknown[] = [null, '', '<html><body>Login</body></html>', { status: 1 }, { data: {} }, [], { data: { status: 'asyncplay' } }]
    for (const payload of badTableInfos) {
      const observer = new TableObserver('bad-tableinfo')
      captureLogs(observer)
      setAdapter(observer, async config => config.url?.includes('tableinfos.html') ? makeResponse(config, payload) : tokenPage(config, 1))
      const retry = nextFailure(observer, 'retrying')
      await observer.init()
      const event = await retry
      observer.close()
      assert.equal(event.reason, 'invalid_response', `payload ${JSON.stringify(payload)}`)
    }

    const observer = new TableObserver('no-token')
    captureLogs(observer)
    setAdapter(observer, async config => makeResponse(config, '<html>maintenance</html>'))
    const retry = nextFailure(observer, 'retrying')
    await observer.init()
    assert.equal((await retry).reason, 'invalid_response')
    observer.close()
  })

  it('retries missing or malformed game state pages instead of reporting recovery', async () => {
    for (const page of ['<html>login</html>', 'x "gamestate":{broken} y', 'x "gamestate":{} y', null]) {
      const observer = new TableObserver('bad-gamestate')
      captureLogs(observer)
      setAdapter(observer, async config => {
        if (config.url?.includes('tableinfos.html')) return makeResponse(config, { status: 1, data: activeTable })
        if (config.url?.includes('/arknova')) return makeResponse(config, page)
        return tokenPage(config, 1)
      })
      let recovered = 0
      observer.on('recovered', () => { recovered++ })
      const retry = nextFailure(observer, 'retrying')
      await observer.init()
      const event = await retry
      observer.close()
      assert.equal(event.reason, 'invalid_response')
      assert.equal(recovered, 0)
      assert.equal(observer.ready, false)
    }
  })

  it('pauses genuine program errors with a safe diagnostic and no secret data', async () => {
    const observer = new TableObserver('program-bug', {}, undefined, () => {
      throw new TypeError(`cannot read ${SECRET_COOKIE} token=${'f'.repeat(64)}`)
    })
    const logger = captureLogs(observer)
    setAdapter(observer, async config => tokenPage(config, 1))
    const paused = nextFailure(observer, 'paused')
    await observer.init()
    const event = await paused
    observer.close()

    assert.equal(event.reason, 'unexpected_error')
    const logs = logger.lines.join('\n')
    assert.match(logs, /errorName=TypeError/)
    assert.match(logs, /frame=[^\s]*tableObserverResponse\.spec\.ts:\d+/)
    assert.ok(!logs.includes('top-secret-session'))
    assert.ok(!logs.includes('f'.repeat(64)))
    assert.ok(!logs.includes('cannot read'))
    assert.ok(!JSON.stringify(event).includes('top-secret-session'))
  })

  it('pauses HTTP 4xx without logging request headers or response bodies', async () => {
    const observer = new TableObserver('forbidden', {}, SECRET_COOKIE)
    const logger = captureLogs(observer)
    setAdapter(observer, async config => {
      if (!config.url?.includes('tableinfos.html')) return tokenPage(config, 1)
      const response = { ...makeResponse(config, { secret: 'body-secret Authorization: Bearer abc' }), status: 403 }
      throw new AxiosError(`forbidden ${SECRET_COOKIE}`, 'ERR_BAD_REQUEST', config, undefined, response)
    })
    const paused = nextFailure(observer, 'paused')
    await observer.init()
    const event = await paused
    observer.close()

    assert.equal(event.reason, 'http_error')
    assert.equal(event.status, 403)
    const logs = logger.lines.join('\n')
    assert.ok(!logs.includes('top-secret-session'))
    assert.ok(!logs.includes('body-secret'))
    assert.ok(!logs.includes('Bearer'))
    assert.match(logs, /errorName=AxiosError/)
  })
})

interface EndResult {
  name: string
  score: string
  score_aux: string
  /** tableinfos 路径映射为 rank；gamestate 回退路径保留原始 gamerank */
  rank?: number
  gamerank?: string
}

function endResult(observer: TableObserver): Promise<EndResult[]> {
  return new Promise(resolve => observer.once('end', resolve))
}

describe('TableObserver finished table results', () => {
  it('reports final rankings from tableinfos as soon as the table finishes', async () => {
    const finishedWithResult = {
      status: 'finished',
      players: { '1': { fullname: 'Alice' }, '2': { fullname: 'Bob' } },
      result: {
        player: [
          { name: 'Bob', score: '95', score_aux: '2', gamerank: '2' },
          { name: 'Alice', score: '120', score_aux: '0', gamerank: '1' },
        ],
      },
    }
    const observer = new TableObserver('finished-with-result')
    captureLogs(observer)
    setAdapter(observer, async config =>
      config.url?.includes('tableinfos.html')
        ? makeResponse(config, { status: 1, data: finishedWithResult })
        : tokenPage(config, 1))
    const ended = endResult(observer)

    await observer.init()

    assert.deepEqual(await ended, [
      { name: 'Alice', score: '120', score_aux: '0', rank: 1 },
      { name: 'Bob', score: '95', score_aux: '2', rank: 2 },
    ])
    assert.equal(observer.status.kind, 'terminal')
    observer.close()
  })

  it('falls back to the game state page for final results', async (context) => {
    const timers = context.mock.timers as unknown as FakeTimers
    timers.enable({ apis: ['setTimeout', 'Date'], now: 60_000 })
    const observer = new TableObserver('finished-fallback')
    captureLogs(observer)
    let tableInfoRequests = 0
    let gameStateRequests = 0
    setAdapter(observer, async config => {
      if (config.url?.includes('tableinfos.html')) {
        tableInfoRequests++
        // 第二轮起终局不再带 data.result，只能回退到 gamestate 页面刮结果
        return makeResponse(config, { status: 1, data: tableInfoRequests === 1 ? activeTable : { status: 'finished', players: { '1': { fullname: 'Alice' } } } })
      }
      if (config.url?.includes('/arknova')) {
        gameStateRequests++
        return makeResponse(config, gameStateRequests === 1
          ? 'prefix "gamestate":{"active_player":"1"} suffix'
          : 'prefix "gamestate":{"args":{"result":[{"name":"Alice","score":"120","score_aux":"0","gamerank":"1"}]}} suffix')
      }
      return tokenPage(config, 1)
    })
    const ended = endResult(observer)

    await observer.init()
    timers.tick(60_000)
    await flushAsync()

    // gamestate 回退路径原样透传 args.result，不做 tableinfos 路径的 gamerank→rank 映射
    assert.deepEqual(await ended, [{ name: 'Alice', score: '120', score_aux: '0', gamerank: '1' }])
    observer.close()
    timers.reset()
  })

  it('ends with an empty result when neither source carries final scores', async () => {
    const observer = new TableObserver('finished-empty')
    captureLogs(observer)
    setAdapter(observer, async config =>
      config.url?.includes('tableinfos.html')
        ? makeResponse(config, { status: 1, data: { status: 'finished', players: { '1': { fullname: 'Alice' } } } })
        : tokenPage(config, 1))
    const ended = endResult(observer)

    await observer.init()

    assert.deepEqual(await ended, [])
    observer.close()
  })

  it('retries an ongoing table that lost its game location as invalid_response', async () => {
    const observer = new TableObserver('no-game-location')
    captureLogs(observer)
    setAdapter(observer, async config =>
      config.url?.includes('tableinfos.html')
        ? makeResponse(config, { status: 1, data: { status: 'asyncplay', players: { '1': { fullname: 'Alice' } } } })
        : tokenPage(config, 1))
    const retry = nextFailure(observer, 'retrying')

    await observer.init()
    const event = await retry
    observer.close()

    assert.equal(event.reason, 'invalid_response')
  })
})
