import { Contact } from "@juzi/wechaty"
import axios, { AxiosInstance } from "axios"
import { EventEmitter } from "events"
import { Logger } from "../helper/logger"

const POLL_INTERVAL_MS = 60 * 1000

interface BgaPlayerResult {
  name: string
  score: string
  score_aux: string
  rank: number
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

  async init() {
    try {
      this.logger.info('init: getting session and token')
      const { cookie, token } = await this.getSessionAndToken()
      this.logger.info('init: got session, fetching table info')

      const tableInfo = await this.fetchTableInfo(cookie, token)
      if (!tableInfo) {
        this.emit('error')
        return
      }

      if (tableInfo.status === 'finished' || tableInfo.status === 'archive') {
        if (tableInfo.gameserver && tableInfo.game_name) {
          this.gameUrl = `https://boardgamearena.com/${tableInfo.gameserver}/${tableInfo.game_name}?table=${this.tableId}`
          const state = await this.fetchGameState(cookie)
          this.emit('end', state?.args?.result ?? [])
        } else {
          this.emit('end', [])
        }
        return
      }

      for (const [id, player] of Object.entries(tableInfo.players as Record<string, { fullname: string }>)) {
        this.playerIdToName[id] = player.fullname
      }

      const expectedPlayers = this.getExpectedPlayers(tableInfo)
      if (expectedPlayers.length > 0) {
        this.logger.info(`init: found expected players: ${expectedPlayers.join(', ')}`)
        this.currentPlayers = expectedPlayers
        this.waitingForJoin = true
        this.ready = true
        this.emit('ready')
        this.startPolling(cookie, token)
        return
      }

      this.gameUrl = `https://boardgamearena.com/${tableInfo.gameserver}/${tableInfo.game_name}?table=${this.tableId}`
      this.logger.info(`init: got table info, fetching game state from ${this.gameUrl}`)

      const state = await this.fetchGameState(cookie)
      if (!state) {
        this.logger.info('could not get initial game state')
        this.emit('error')
        return
      }

      this.logger.info('init: got game state, ready')
      this.applyState(state)
      this.ready = true
      this.emit('ready')
      this.startPolling(cookie, token)
    } catch (e) {
      this.logger.error(`init error: ${e}`)
      this.emit('error')
    }
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

  private startPolling(cookie: string, token: string) {
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.poll(cookie, token), POLL_INTERVAL_MS)
    }
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  private async poll(cookie: string, token: string) {
    const tableInfo = await this.fetchTableInfo(cookie, token)
    if (tableInfo) {
      const status = tableInfo.status
      if (status === 'finished' || status === 'archive') {
        const state = await this.fetchGameState(cookie)
        this.emit('end', state?.args?.result ?? [])
        return
      }

      const expectedPlayers = this.getExpectedPlayers(tableInfo)
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
    }

    const state = await this.fetchGameState(cookie)
    if (!state) {
      this.logger.info('poll: no state returned')
      return
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

  private getExpectedPlayers(tableInfo: any): string[] {
    if (!tableInfo?.players) return []
    return Object.values(tableInfo.players as Record<string, { fullname: string; table_status: string }>)
      .filter(p => p.table_status === 'expected')
      .map(p => p.fullname)
  }

  private async getSessionAndToken(): Promise<{ cookie: string; token: string }> {
    const extractCookies = (headers: any): string =>
      ((headers['set-cookie'] ?? []) as string[]).map(c => c.split(';')[0]).join('; ')

    const tableRes = await this.http.get(
      `https://en.boardgamearena.com/table?table=${this.tableId}`,
      this.sharedCookie ? { headers: { Cookie: this.sharedCookie } } : undefined
    )

    const newCookies = extractCookies(tableRes.headers)
    const cookie = [this.sharedCookie, newCookies].filter(Boolean).join('; ')
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
    try {
      const res = await this.http.get(this.gameUrl, { headers: { Cookie: cookie } })
      return this.parseGameState(res.data as string)
    } catch (e) {
      this.logger.error(`fetchGameState error: ${e}`)
      return null
    }
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
