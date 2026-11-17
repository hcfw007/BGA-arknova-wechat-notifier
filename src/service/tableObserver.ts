import { Contact } from "@juzi/wechaty"
import axios, { AxiosInstance } from "axios"
import { EventEmitter } from "events"
import { getExpectedPlayers, resultFromTableInfo } from "../helper/bgaPayload"
import { BgaGameState, BgaResponseError, BgaTableInfo, parseGameStatePage, parseTableInfoResponse } from "../helper/bgaResponse"
import { BgaCredentials, handshake } from "../helper/bgaSession"
import { classifyObserverFailure, describeErrorSafely, retryDelayForFailure, ObserverFailure, sanitizeEndpoint } from "../helper/observerRetry"
import { Logger } from "../helper/logger"

const POLL_INTERVAL_MS = 60 * 1000
// BGA 匿名会话大约两小时失效，到期前主动换一把
const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_TIMER_DELAY_MS = 2_147_000_000

export type ObserverStatus =
  | { kind: 'initializing' }
  | { kind: 'ready' }
  | { kind: 'retrying'; failure: ObserverFailure; nextRetryAt: number; elapsed: number; inFlight: boolean }
  | { kind: 'paused'; failure: ObserverFailure; elapsedMs: number }
  | { kind: 'closed' }
  | { kind: 'terminal' }

export interface ObserverRetryingEvent extends ObserverFailure {
  stage: 'initial' | 'poll'
  failures: number
  nextRetryAt: number
  elapsed: number
  reminder?: boolean
  manual?: boolean
}

export interface ObserverPausedEvent extends ObserverFailure {
  stage: 'initial' | 'poll'
  failures: number
  elapsedMs: number
}

export interface ObserverRecoveredEvent {
  stage: 'initial' | 'poll'
  wasReady: boolean
  isInitialRecovery: boolean
  elapsedMs: number
}

interface BgaSession extends BgaCredentials {
  obtainedAt: number
}

export class TableObserver extends EventEmitter {

  private readonly logger = new Logger(TableObserver.name)

  ready = false
  currentPlayers?: string[]
  waitingForJoin = false

  private playerIdToName: Record<string, string> = {}
  private gameUrl?: string
  private http: AxiosInstance
  private session?: BgaSession
  private consecutiveFailures = 0
  private polling = false
  private retryTimer?: NodeJS.Timeout
  private reminderTimer?: NodeJS.Timeout
  private retryStartedAt?: number
  private abortController?: AbortController
  private requestEndpoint?: string
  private closed = false
  private initialized = false
  private terminal = false
  private paused = false
  private pausedElapsedMs = 0
  private generation = 0

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

  async init(): Promise<void> {
    if (this.closed || this.initialized || this.retryTimer || this.polling) return
    await this.runAttempt('initial')
  }

  retryNow(): void {
    if (this.closed || this.terminal || !this.paused) return
    this.paused = false
    this.pausedElapsedMs = 0
    this.consecutiveFailures = 0
    this.retryStartedAt = Date.now()
    this.nextRetryAt = Date.now()
    const stage = this.ready ? 'poll' : 'initial'
    if (this.lastFailure) {
      const event: ObserverRetryingEvent = { ...this.lastFailure, stage, failures: 0, nextRetryAt: this.nextRetryAt, elapsed: 0, manual: true }
      this.emit('retrying', event)
    }
    this.scheduleReminder()
    void this.runAttempt(stage)
  }

  get status(): ObserverStatus {
    if (this.closed) return { kind: 'closed' }
    if (this.terminal) return { kind: 'terminal' }
    if (this.paused && this.lastFailure) return { kind: 'paused', failure: this.lastFailure, elapsedMs: this.pausedElapsedMs }
    if (this.lastFailure && this.retryStartedAt !== undefined) {
      return { kind: 'retrying', failure: this.lastFailure, nextRetryAt: this.nextRetryAt, elapsed: Date.now() - this.retryStartedAt, inFlight: this.polling }
    }
    return this.ready ? { kind: 'ready' } : { kind: 'initializing' }
  }

  private lastFailure?: ObserverFailure
  private nextRetryAt = 0

  private async runAttempt(stage: 'initial' | 'poll'): Promise<void> {
    if (this.closed || this.terminal || this.polling) return
    this.polling = true
    const generation = this.generation
    const wasInitialized = this.initialized
    const wasReady = this.ready
    this.abortController = new AbortController()
    this.http.defaults.signal = this.abortController.signal
    try {
      if (stage === 'initial') await this.initOnce()
      else await this.pollOnce()
      if (this.isStale(generation)) return
      const recovered = this.lastFailure !== undefined
      const elapsedMs = recovered && this.retryStartedAt !== undefined ? Date.now() - this.retryStartedAt : 0
      this.lastFailure = undefined
      this.consecutiveFailures = 0
      this.initialized = this.ready
      this.retryStartedAt = undefined
      this.nextRetryAt = 0
      this.stopReminder()
      if (recovered) {
        const event: ObserverRecoveredEvent = { stage, wasReady, isInitialRecovery: stage === 'initial' && !wasReady, elapsedMs }
        this.emit('recovered', event)
      }
      else if (this.ready && !wasInitialized) this.emit('ready')
      if (this.ready) this.schedule(POLL_INTERVAL_MS, 'poll')
    } catch (error: unknown) {
      if (this.isStale(generation)) return
      this.handleFailure(error, stage)
    } finally {
      this.polling = false
      if (this.http.defaults.signal === this.abortController?.signal) this.http.defaults.signal = undefined
      this.abortController = undefined
    }
  }

  private isStale(generation: number): boolean {
    return this.closed || this.terminal || generation !== this.generation
  }

  private async initOnce() {
    this.logger.info('init: getting session and token')
    const { cookie, token } = await this.ensureSession()
    if (this.closed || this.terminal) return
    this.logger.info('init: got session, fetching table info')

    const tableInfo = await this.fetchTableInfo(cookie, token)
    if (this.closed || this.terminal) return

    if (tableInfo.status === 'finished' || tableInfo.status === 'archive') {
      const result = resultFromTableInfo(tableInfo)
      if (result) {
        this.finish(result)
        return
      }
      if (tableInfo.gameserver && tableInfo.game_name) {
        this.gameUrl = this.gameUrlFor(tableInfo)
        const state = await this.fetchGameState(cookie).catch(() => null)
        if (this.closed || this.terminal) return
        this.finish(state?.args?.result ?? [])
      } else {
        this.finish([])
      }
      return
    }

    for (const [id, player] of Object.entries(tableInfo.players)) {
      this.playerIdToName[id] = player.fullname
    }

    const expectedPlayers = getExpectedPlayers(tableInfo)
    if (expectedPlayers.length > 0) {
      this.logger.info(`init: found expected players: ${expectedPlayers.join(', ')}`)
      this.currentPlayers = expectedPlayers
      this.waitingForJoin = true
      this.ready = true
      return
    }

    this.gameUrl = this.gameUrlFor(tableInfo)
    this.logger.info(`init: got table info, fetching game state from ${this.gameUrl}`)

    const state = await this.fetchGameState(cookie)
    if (this.closed || this.terminal) return

    this.logger.info('init: got game state, ready')
    this.applyState(state)
    this.ready = true
  }

  close() {
    this.closed = true
    this.generation++
    this.stopPolling()
    this.stopReminder()
    this.abortController?.abort()
    this.ready = false
  }

  private finish(result: { name: string; score: string; rank: number }[]): void {
    if (this.closed || this.terminal) return
    this.terminal = true
    this.stopPolling()
    this.stopReminder()
    this.abortController?.abort()
    this.emit('end', result)
  }

  private handleFailure(error: unknown, stage: 'initial' | 'poll'): void {
    const failure = classifyObserverFailure(error)
    failure.endpoint ??= sanitizeEndpoint(this.requestEndpoint)
    this.lastFailure = failure
    this.consecutiveFailures++
    this.session = undefined
    this.sharedCookie = undefined
    this.retryStartedAt ??= Date.now()
    if (!failure.retryable) {
      this.paused = true
      this.stopReminder()
      this.pausedElapsedMs = Date.now() - this.retryStartedAt
      this.logger.error(`observer paused ${this.describeFailure(stage, failure, error)}`)
      const event: ObserverPausedEvent = {
        ...failure,
        stage,
        failures: this.consecutiveFailures,
        elapsedMs: this.pausedElapsedMs,
      }
      this.emit('paused', event)
      this.consecutiveFailures = 0
      this.retryStartedAt = undefined
      this.nextRetryAt = 0
      return
    }
    const wait = retryDelayForFailure(this.consecutiveFailures, failure, Date.now())
    this.nextRetryAt = Date.now() + wait
    this.logger.warn(`observer retry ${this.describeFailure(stage, failure, error)} nextRetryAt=${this.nextRetryAt}`)
    const event: ObserverRetryingEvent = { ...failure, stage, failures: this.consecutiveFailures, nextRetryAt: this.nextRetryAt, elapsed: Date.now() - this.retryStartedAt }
    this.emit('retrying', event)
    this.schedule(wait, this.ready ? 'poll' : 'initial')
    this.scheduleReminder()
  }

  /** 日志用的安全摘要：HTTP status 与 BGA 业务码分开记录，诊断只含错误类别与代码位置 */
  private describeFailure(stage: 'initial' | 'poll', failure: ObserverFailure, error: unknown): string {
    return `table=${this.tableId} stage=${stage} endpoint=${failure.endpoint ?? 'unknown'} reason=${failure.reason} status=${failure.status ?? 'none'} code=${failure.applicationCode ?? 'none'} failures=${this.consecutiveFailures} ${describeErrorSafely(error)}`
  }

  private gameUrlFor(tableInfo: BgaTableInfo): string {
    if (!tableInfo.gameserver || !tableInfo.game_name) {
      throw new BgaResponseError('invalid_response', true, { stage: 'tableinfos', responseType: 'object', problem: 'game_location_missing' })
    }
    return `https://boardgamearena.com/${tableInfo.gameserver}/${tableInfo.game_name}?table=${this.tableId}`
  }

  private schedule(wait: number, stage: 'initial' | 'poll'): void {
    if (this.closed || this.terminal) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const delay = Math.min(wait, MAX_TIMER_DELAY_MS)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (Date.now() < this.nextRetryAt && this.lastFailure?.retryAfterMs !== undefined) {
        this.schedule(this.nextRetryAt - Date.now(), stage)
        return
      }
      this.nextRetryAt = Date.now()
      void this.runAttempt(stage)
    }, delay)
  }

  getContactFromPlayer(player: string) {
    if (player === 'all') return 'all'
    return this.playerMap[player]
  }

  private applyState(state: BgaGameState) {
    const activeIds: readonly string[] = state.multiactive && state.multiactive.length > 0
      ? state.multiactive
      : state.active_player === undefined ? [] : [state.active_player]

    this.currentPlayers = activeIds
      .filter(id => id !== '' && id !== '0' && id !== '-1')
      .map(id => this.playerIdToName[id] ?? id)
  }

  private stopPolling() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private scheduleReminder(): void {
    if (this.reminderTimer) return
    if (this.closed || this.terminal || this.paused || !this.lastFailure) return
    this.reminderTimer = setTimeout(() => {
      this.reminderTimer = undefined
      const status = this.status
      if (status.kind !== 'retrying') return
      const event: ObserverRetryingEvent = {
        ...status.failure,
        stage: this.ready ? 'poll' : 'initial',
        failures: this.consecutiveFailures,
        nextRetryAt: status.nextRetryAt,
        elapsed: status.elapsed,
        reminder: true,
      }
      this.emit('retrying', event)
      this.scheduleReminder()
    }, 30 * 60 * 1000)
  }

  private stopReminder(): void {
    if (this.reminderTimer) clearTimeout(this.reminderTimer)
    this.reminderTimer = undefined
  }

  private async pollOnce() {
    const { cookie, token } = await this.ensureSession()
    if (this.closed || this.terminal) return
    const tableInfo = await this.fetchTableInfo(cookie, token)
    if (this.closed || this.terminal) return

    const status = tableInfo.status
    if (status === 'finished' || status === 'archive') {
      const result = resultFromTableInfo(tableInfo)
      if (result) {
        this.finish(result)
        return
      }
      const state = await this.fetchGameState(cookie).catch(() => null)
      if (this.closed || this.terminal) return
      this.finish(state?.args?.result ?? [])
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
        if (newPlayers.length > 0 && !this.lastFailure) {
          this.emit('newPlayerMove', newPlayers)
        }
      }
      return
    }

    this.waitingForJoin = false
    if (!this.gameUrl) {
      this.gameUrl = this.gameUrlFor(tableInfo)
      this.logger.info(`poll: game started, url=${this.gameUrl}`)
    }

    // 进行中的桌子读不到 gamestate，通常意味着被重定向到登录页；parseGameStatePage 抛可重试错误以触发换会话
    const state = await this.fetchGameState(cookie)
    if (this.closed || this.terminal) return

    const prevPlayers = this.currentPlayers
    this.applyState(state)
    this.logger.info(`poll [table ${this.tableId}]: players=${this.currentPlayers?.join(', ')}`)

    if (prevPlayers) {
      const prevSet = new Set(prevPlayers)
      const newPlayers = (this.currentPlayers ?? []).filter(p => !prevSet.has(p))
      if (newPlayers.length > 0 && !this.lastFailure) {
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
    this.requestEndpoint = `https://en.boardgamearena.com/table?table=${this.tableId}`
    const { cookie, token } = await this.getSessionAndToken()
    this.session = { cookie, token, obtainedAt: Date.now() }
    return this.session
  }

  private async getSessionAndToken(): Promise<BgaCredentials> {
    const credentials = await handshake(
      this.http,
      `https://en.boardgamearena.com/table?table=${this.tableId}`,
      this.sharedCookie,
    )
    if (this.closed || this.terminal) return credentials
    this.sharedCookie = credentials.cookie
    this.onCookieUpdate?.(credentials.cookie)
    return credentials
  }

  private async fetchTableInfo(cookie: string, token: string) {
    const tablePageUrl = `https://en.boardgamearena.com/table?table=${this.tableId}`
    this.requestEndpoint = `https://en.boardgamearena.com/table/table/tableinfos.html?id=${this.tableId}`
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
    return parseTableInfoResponse(res.data)
  }

  private async fetchGameState(cookie: string): Promise<BgaGameState> {
    if (!this.gameUrl) {
      throw new BgaResponseError('invalid_response', true, { stage: 'gamestate', responseType: 'undefined', problem: 'game_url_missing' })
    }
    this.requestEndpoint = this.gameUrl
    const res = await this.http.get(this.gameUrl, { headers: { Cookie: cookie } })
    return parseGameStatePage(res.data)
  }
}

export interface PlayerMap {
  [gameName: string]: Contact
}

export interface ContactPlayer {
  contact: Contact
  gameName: string
}
