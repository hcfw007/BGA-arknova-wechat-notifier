import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PlayerClient, UnknownPlayerError } from '../src/service/playerClient'

const TOKEN_PAGE_DATA = `requestToken: '${'a'.repeat(64)}'`
const FIND_PLAYER_URL = '/player/player/findplayer.html'
const TABLES_URL = '/tablemanager/tablemanager/tableinfos.html'

interface RecordedRequest {
  method: 'get' | 'post'
  url: string
  body?: string
  config?: { headers?: Record<string, unknown>; params?: Record<string, unknown> }
}

interface FakeResponse {
  headers: Record<string, unknown>
  data: unknown
}

interface FakeHttp {
  calls: RecordedRequest[]
  get(url: string, config?: RecordedRequest['config']): Promise<FakeResponse>
  post(url: string, body?: string, config?: RecordedRequest['config']): Promise<FakeResponse>
}

function makeHttp(respond: (request: RecordedRequest) => FakeResponse): FakeHttp {
  const calls: RecordedRequest[] = []
  const record = async (method: RecordedRequest['method'], url: string, body?: string, config?: RecordedRequest['config']): Promise<FakeResponse> => {
    const request: RecordedRequest = { method, url, body, config }
    calls.push(request)
    return respond(request)
  }
  return {
    calls,
    get: (url, config) => record('get', url, undefined, config),
    post: (url, body, config) => record('post', url, body, config),
  }
}

function makeClient(http: FakeHttp, sharedCookie?: string): PlayerClient {
  const client = new PlayerClient(sharedCookie)
  ;(client as unknown as { http: FakeHttp }).http = http
  return client
}

const tokenPage = (): FakeResponse => ({
  headers: { 'set-cookie': ['PHPSESSID=s1; Path=/'] },
  data: TOKEN_PAGE_DATA,
})

describe('PlayerClient session handling', () => {
  it('handshakes with the shared cookie and resolves an exact player match', async () => {
    const http = makeHttp(request => {
      if (request.url.endsWith('/playertables')) return tokenPage()
      assert.equal(request.method, 'get')
      return { headers: {}, data: { items: [{ id: 42, q: 'Theim' }, { id: 43, q: 'theimx' }] } }
    })
    const client = makeClient(http, 'initial=cookie')

    const lookup = await client.findPlayerByName('Theim')

    assert.deepEqual(lookup, { kind: 'found', player: { id: '42', name: 'Theim' } })
    assert.equal(http.calls.length, 2)
    assert.equal(http.calls[0].config?.headers?.Cookie, 'initial=cookie')
    const query = http.calls[1]
    assert.equal(query.url, `https://en.boardgamearena.com${FIND_PLAYER_URL}`)
    assert.deepEqual(query.config?.params, { q: 'Theim', start: 0, count: 20 })
    assert.ok(String(query.config?.headers?.Cookie).includes('initial=cookie'))
    assert.ok(String(query.config?.headers?.Cookie).includes('PHPSESSID=s1'))
    assert.equal(query.config?.headers?.['X-Requested-With'], 'XMLHttpRequest')
  })

  it('reuses the session within the TTL and re-handshakes after dropSession', async () => {
    let handshakes = 0
    const http = makeHttp(request => {
      if (request.url.endsWith('/playertables')) {
        handshakes++
        return tokenPage()
      }
      return { headers: {}, data: { items: [] } }
    })
    const client = makeClient(http)

    await client.findPlayerByName('Nobody')
    await client.findPlayerByName('Nobody')
    assert.equal(handshakes, 1)

    // 会话失效后必须重握手，且不能再带上已中毒的旧 cookie
    client.dropSession()
    await client.findPlayerByName('Nobody')
    assert.equal(handshakes, 2)
    const rehandshake = http.calls.filter(call => call.url.endsWith('/playertables')).at(-1)
    assert.equal(rehandshake?.config, undefined)
  })

  it('refreshes a stale session and drops the stale shared cookie first', async () => {
    let handshakes = 0
    const http = makeHttp(request => {
      if (request.url.endsWith('/playertables')) {
        handshakes++
        return tokenPage()
      }
      return { headers: {}, data: { items: [] } }
    })
    const client = makeClient(http, 'initial=cookie')
    await client.findPlayerByName('Nobody')

    const internals = client as unknown as { session?: { obtainedAt: number } }
    internals.session = { ...(internals.session as { obtainedAt: number }), obtainedAt: Date.now() - 3 * 60 * 60 * 1000 }

    await client.findPlayerByName('Nobody')
    assert.equal(handshakes, 2)
    const refresh = http.calls.filter(call => call.url.endsWith('/playertables')).at(-1)
    assert.equal(refresh?.config, undefined)
  })
})

describe('PlayerClient table queries', () => {
  it('posts the player filter with the request token and keeps only ark nova tables', async () => {
    const http = makeHttp(request => {
      if (request.url.endsWith('/playertables')) return tokenPage()
      assert.equal(request.method, 'post')
      return {
        headers: {},
        data: {
          status: 1,
          data: {
            player: { player_fullname: 'Theim' },
            tables: {
              a: { id: 11, game_name: 'arknova', progression: '42' },
              b: { id: 22, game_name: 'hearts', progression: '10' },
              c: { id: 33, game_name: 'arknova', progression: '5', cancelled: '1' },
            },
          },
        },
      }
    })
    const client = makeClient(http)

    const result = await client.listArkNovaTables('94073546')

    assert.deepEqual(result, { playerName: 'Theim', tables: [{ tableId: '11', progression: 42 }] })
    const post = http.calls.at(-1)
    assert.equal(post?.url, `https://en.boardgamearena.com${TABLES_URL}`)
    assert.equal(post?.body, 'playerfilter=94073546&turninfo=false&matchmakingtables=false')
    assert.ok(String(post?.config?.headers?.Cookie).includes('PHPSESSID=s1'))
    assert.equal(post?.config?.headers?.['X-Request-Token'], 'a'.repeat(64))
    assert.equal(post?.config?.headers?.['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8')
    assert.equal(post?.config?.headers?.Referer, 'https://en.boardgamearena.com/playertables?player=94073546')
  })

  it('reports unknown players separately from other BGA failures', async () => {
    const http = makeHttp(request => {
      if (request.url.endsWith('/playertables')) return tokenPage()
      return { headers: {}, data: { status: 0, error: 'unknow player' } }
    })
    const client = makeClient(http)

    await assert.rejects(() => client.listArkNovaTables('000'), UnknownPlayerError)

    const brokenHttp = makeHttp(request => {
      if (request.url.endsWith('/playertables')) return tokenPage()
      return { headers: {}, data: { status: 0, error: 'session broken' } }
    })
    const brokenClient = makeClient(brokenHttp)

    await assert.rejects(
      () => brokenClient.listArkNovaTables('94073546'),
      (error: unknown) => error instanceof Error && !(error instanceof UnknownPlayerError) && /playertables failed/.test(error.message),
    )
  })
})
