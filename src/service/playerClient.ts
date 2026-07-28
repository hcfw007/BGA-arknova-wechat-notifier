import axios, { AxiosInstance } from "axios"
import { arkNovaTablesFromPlayerTables, PlayerLookup, PlayerTable, pickExactPlayer } from "../helper/bgaPayload"
import { BgaCredentials, handshake } from "../helper/bgaSession"
import { Logger } from "../helper/logger"

const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const BASE_URL = 'https://en.boardgamearena.com'

/** BGA 说这个玩家不存在，跟会话失效是两回事，调用方要分开处理 */
export class UnknownPlayerError extends Error {}

/**
 * 只读地查 BGA 的玩家维度数据。全部走匿名会话，不需要登录。
 */
export class PlayerClient {

  private readonly logger = new Logger(PlayerClient.name)
  private readonly http: AxiosInstance
  private session?: BgaCredentials & { obtainedAt: number }

  constructor(private sharedCookie?: string) {
    this.http = axios.create({
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      maxRedirects: 5,
      timeout: 30_000,
    })
  }

  /** 会话失效时调用，下一次请求会重新握手 */
  dropSession() {
    this.session = undefined
    this.sharedCookie = undefined
  }

  private async ensureSession(): Promise<BgaCredentials> {
    if (this.session && Date.now() - this.session.obtainedAt < SESSION_TTL_MS) {
      return this.session
    }
    if (this.session) {
      this.sharedCookie = undefined
    }
    const credentials = await handshake(this.http, `${BASE_URL}/playertables`, this.sharedCookie)
    this.sharedCookie = credentials.cookie
    this.session = { ...credentials, obtainedAt: Date.now() }
    return this.session
  }

  /** 用户名换 BGA 玩家 id，只认大小写敏感的完全相等 */
  async findPlayerByName(name: string): Promise<PlayerLookup> {
    const { cookie } = await this.ensureSession()
    const res = await this.http.get(`${BASE_URL}/player/player/findplayer.html`, {
      params: { q: name, start: 0, count: 20 },
      headers: { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest' },
    })
    return pickExactPlayer(res.data, name)
  }

  /** 该玩家当前进行中的 Ark Nova 桌，附带 BGA 侧的显示名 */
  async listArkNovaTables(playerId: string): Promise<{ playerName?: string; tables: PlayerTable[] }> {
    const { cookie, token } = await this.ensureSession()
    const res = await this.http.post(
      `${BASE_URL}/tablemanager/tablemanager/tableinfos.html`,
      new URLSearchParams({
        playerfilter: playerId,
        turninfo: 'false',
        matchmakingtables: 'false',
      }).toString(),
      {
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Request-Token': token,
          Referer: `${BASE_URL}/playertables?player=${playerId}`,
        },
      },
    )

    const payload = res.data as any
    if (payload?.status != 1) {
      const error = String(payload?.error ?? 'unknown error')
      if (/unknow player/i.test(error)) {
        throw new UnknownPlayerError(error)
      }
      throw new Error(`playertables failed: ${error}`)
    }

    const tables = arkNovaTablesFromPlayerTables(payload)
    const playerName = payload?.data?.player?.player_fullname
    this.logger.info(`player ${playerId} has ${tables.length} ark nova table(s)`)
    return { playerName: playerName ? String(playerName) : undefined, tables }
  }
}
