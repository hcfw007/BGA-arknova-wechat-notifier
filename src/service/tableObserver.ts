import { Contact } from "@juzi/wechaty"
import axios, { AxiosInstance } from "axios"
import { EventEmitter } from "events"
import { BgaPlayerResult, getExpectedPlayers, resultFromTableInfo } from "../helper/bgaPayload"
import { mergeCookies } from "../helper/cookie"
import { Logger } from "../helper/logger"

const POLL_INTERVAL_MS = 60 * 1000
// BGA 匿名会话大约两小时失效，到期前主动换一把
const SESSION_TTL_MS = 2 * 60 * 60 * 1000
// 连续失败到这个次数才认定这桌真的挂了，中间的抖动靠重取会话自愈
const MAX_POLL_FAILURES = 3
// 首次握手的重试次数与退避基数（第 n 次失败后等 n × base）
const INIT_MAX_ATTEMPTS = 3
const INIT_RETRY_BASE_MS = 3000

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

interface BgaSession {
  cookie: string
  token: string
  obtainedAt: number
}

interface BgaGameState {
  active_player: string
  multiactive?: string[]
  updateGameProgression?: number
  args?: { result?: BgaPlayerResult[] }
}

export class TableObserver extends EventEmitter {

  private readonly logger = new Logger(TableObserver.name)

  ready = false
  currentPlayers?: string[]
  waitingForJoin = false

  private playerIdToName: Record<string, string> = {}
  private gameUrl?: string
  private pollTimer?: NodeJS.Timeout
  private http: AxiosInstance
  private session?: BgaSession
  private consecutiveFailures = 0
  private polling = false

  constructor(
    readonly tableId: string,
    private readonly playerMap: PlayerMap = {},
    private sharedCookie?: string,
    private readonly onCookieUpdate?: (cookie: string) => void,
  ) {
    super()
    this.http = axios.create({
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      maxRedirects: 5,
      timeout: 30_000,
    })
  }

  /** BGA 偶发 502，首次握手失败不该直接判这桌死刑 */
  async init() {
    for (let attempt = 1; attempt <= INIT_MAX_ATTEMPTS; attempt++) {
      try {
        await this.initOnce()
        return
      } catch (e) {
        this.logger.warn(`init [table ${this.tableId}] attempt ${attempt}/${INIT_MAX_ATTEMPTS} failed: ${e}`)
        this.session = undefined
        this.sharedCookie = undefined
        if (attempt < INIT_MAX_ATTEMPTS) {
          await delay(INIT_RETRY_BASE_MS * attempt)
        }
      }
    }
    this.logger.error(`init [table ${this.tableId}] gave up after ${INIT_MAX_ATTEMPTS} attempts`)
    this.emit('error')
  }

  private async initOnce() {
    this.logger.info('init: getting session and token')
    const { cookie, token } = await this.ensureSession()
    this.logger.info('init: got session, fetching table info')

    const tableInfo = await this.fetchTableInfo(cookie, token)
    if (!tableInfo) {
      throw new Error('tableinfos returned no data')
    }

    if (tableInfo.status === 'finished' || tableInfo.status === 'archive') {
      const result = resultFromTableInfo(tableInfo)
      if (result) {
        this.emit('end', result)
        return
      }
      if (tableInfo.gameserver && tableInfo.game_name) {
        this.gameUrl = `https://boardgamearena.com/${tableInfo.gameserver}/${tableInfo.game_name}?table=${this.tableId}`
        const state = await this.fetchGameState(cookie).catch(() => null)
        this.emit('end', state?.args?.result ?? [])
      } else {
        this.emit('end', [])
      }
      return
    }

    for (const [id, player] of Object.entries(tableInfo.players as Record<string, { fullname: string }>)) {
      this.playerIdToName[id] = player.fullname
    }

    const expectedPlayers = getExpectedPlayers(tableInfo)
    if (expectedPlayers.length > 0) {
      this.logger.info(`init: found expected players: ${expectedPlayers.join(', ')}`)
      this.currentPlayers = expectedPlayers
      this.waitingForJoin = true
      this.ready = true
      this.emit('ready')
      this.startPolling()
      return
    }

    this.gameUrl = `https://boardgamearena.com/${tableInfo.gameserver}/${tableInfo.game_name}?table=${this.tableId}`
    this.logger.info(`init: got table info, fetching game state from ${this.gameUrl}`)

    const state = await this.fetchGameState(cookie)
    if (!state) {
      throw new Error('could not get initial game state')
    }

    this.logger.info('init: got game state, ready')
    this.applyState(state)
    this.ready = true
    this.emit('ready')
    this.startPolling()
  }

  close() {
    this.stopPolling()
    this.ready = false
  }

  getContactFromPlayer(player: string) {
    if (player === 'all') return 'all'
    return this.playerMap[player]
  }

  private applyState(state: BgaGameState) {
    const activeIds = (state.multiactive?.length ?? 0) > 0
      ? state.multiactive!
      : [state.active_player]

    this.currentPlayers = activeIds
      .filter(id => id && id !== '0' && id !== '-1')
      .map(id => this.playerIdToName[id] ?? id)
  }

  private startPolling() {
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
    }
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  private async poll() {
    // BGA 慢起来单轮可能超过 POLL_INTERVAL_MS，setInterval 不会等上一轮，必须自己挡重入
    if (this.polling) {
      this.logger.warn(`poll [table ${this.tableId}] skipped: previous round still running`)
      return
    }
    this.polling = true
    try {
      await this.pollOnce()
      this.consecutiveFailures = 0
    } catch (e) {
      this.consecutiveFailures++
      this.logger.warn(`poll [table ${this.tableId}] failed (${this.consecutiveFailures}/${MAX_POLL_FAILURES}): ${e}`)
      // 多数失败是会话过期或 BGA 抖动，连旧 cookie 一起丢掉，下一轮干净地重新握手
      this.session = undefined
      this.sharedCookie = undefined
      if (this.consecutiveFailures >= MAX_POLL_FAILURES) {
        this.logger.error(`poll [table ${this.tableId}] gave up after ${this.consecutiveFailures} failures`)
        this.stopPolling()
        this.emit('error')
      }
    } finally {
      this.polling = false
    }
  }

  private async pollOnce() {
    const { cookie, token } = await this.ensureSession()
    const tableInfo = await this.fetchTableInfo(cookie, token)
    if (!tableInfo) {
      throw new Error('tableinfos returned no data')
    }

    const status = tableInfo.status
    if (status === 'finished' || status === 'archive') {
      const result = resultFromTableInfo(tableInfo)
      if (result) {
        this.emit('end', result)
        return
      }
      const state = await this.fetchGameState(cookie).catch(() => null)
      this.emit('end', state?.args?.result ?? [])
      return
    }

    const expectedPlayers = getExpectedPlayers(tableInfo)
    if (expectedPlayers.length > 0) {
      const prevPlayers = this.currentPlayers
      this.currentPlayers = expectedPlayers
      this.waitingForJoin = true
      this.logger.info(`poll [table ${this.tableId}]: expected players=${expectedPlayers.join(', ')}`)
      if (prevPlayers) {
        const prevSet = new Set(prevPlayers)
        const newPlayers = expectedPlayers.filter(p => !prevSet.has(p))
        if (newPlayers.length > 0) {
          this.emit('newPlayerMove', newPlayers)
        }
      }
      return
    }

    this.waitingForJoin = false
    if (!this.gameUrl && tableInfo.gameserver && tableInfo.game_name) {
      this.gameUrl = `https://boardgamearena.com/${tableInfo.gameserver}/${tableInfo.game_name}?table=${this.tableId}`
      this.logger.info(`poll: game started, url=${this.gameUrl}`)
    }

    const state = await this.fetchGameState(cookie)
    if (!state) {
      // 进行中的桌子读不到 gamestate，通常意味着被重定向到登录页，按失败处理以触发换会话
      throw new Error('could not parse gamestate from game page')
    }

    const prevPlayers = this.currentPlayers
    this.applyState(state)
    this.logger.info(`poll [table ${this.tableId}]: players=${this.currentPlayers?.join(', ')}`)

    if (prevPlayers) {
      const prevSet = new Set(prevPlayers)
      const newPlayers = (this.currentPlayers ?? []).filter(p => !prevSet.has(p))
      if (newPlayers.length > 0) {
        this.logger.info(`new active players: ${newPlayers}`)
        this.emit('newPlayerMove', newPlayers)
      }
    }
  }

  private async ensureSession(): Promise<BgaSession> {
    if (this.session && Date.now() - this.session.obtainedAt < SESSION_TTL_MS) {
      return this.session
    }
    if (this.session) {
      // 因过期而刷新：旧 cookie 必须一起丢，否则 BGA 认着旧 PHPSESSID 把同一个会话原样还回来
      this.sharedCookie = undefined
    }
    this.logger.info(`refreshing BGA session for table ${this.tableId}`)
    const { cookie, token } = await this.getSessionAndToken()
    this.session = { cookie, token, obtainedAt: Date.now() }
    return this.session
  }

  private async getSessionAndToken(): Promise<{ cookie: string; token: string }> {
    const extractCookies = (headers: any): string =>
      ((headers['set-cookie'] ?? []) as string[]).map(c => c.split(';')[0]).join('; ')

    const tableRes = await this.http.get(
      `https://en.boardgamearena.com/table?table=${this.tableId}`,
      this.sharedCookie ? { headers: { Cookie: this.sharedCookie } } : undefined
    )

    const cookie = mergeCookies(this.sharedCookie, extractCookies(tableRes.headers))
    this.sharedCookie = cookie
    this.onCookieUpdate?.(cookie)

    const tokenMatch = (tableRes.data as string).match(/requestToken['":,\s]+([a-f0-9]{64})/)
    if (!tokenMatch) throw new Error('could not extract requestToken from table page')

    return { cookie, token: tokenMatch[1] }
  }

  private async fetchTableInfo(cookie: string, token: string) {
    const tablePageUrl = `https://en.boardgamearena.com/table?table=${this.tableId}`
    const res = await this.http.get(
      `https://en.boardgamearena.com/table/table/tableinfos.html?id=${this.tableId}`,
      {
        headers: {
          Cookie: cookie,
          'X-Requested-With': 'XMLHttpRequest',
          'X-Request-Token': token,
          Referer: tablePageUrl,
          Accept: 'application/json, text/javascript, */*; q=0.01',
        }
      }
    )
    return (res.data as any)?.data ?? null
  }

  private async fetchGameState(cookie: string): Promise<BgaGameState | null> {
    if (!this.gameUrl) return null
    const res = await this.http.get(this.gameUrl, { headers: { Cookie: cookie } })
    return this.parseGameState(res.data as string)
  }

  private parseGameState(html: string): BgaGameState | null {
    const marker = '"gamestate":{'
    const idx = html.indexOf(marker)
    if (idx === -1) return null

    let depth = 0
    const start = idx + marker.length - 1
    let end = start
    for (let i = start; i < html.length; i++) {
      if (html[i] === '{') depth++
      else if (html[i] === '}') {
        depth--
        if (depth === 0) { end = i + 1; break }
      }
    }

    try {
      return JSON.parse(html.slice(start, end))
    } catch {
      return null
    }
  }
}

export interface PlayerMap {
  [gameName: string]: Contact
}

export interface ContactPlayer {
  contact: Contact
  gameName: string
}
