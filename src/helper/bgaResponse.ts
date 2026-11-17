import { BgaPlayerResult } from "./bgaPayload"

export type BgaResponseReason = 'session_expired' | 'invalid_response' | 'bga_error' | 'bga_unavailable'
export type BgaResponseStage = 'handshake' | 'tableinfos' | 'gamestate'
export type BgaResponseType = 'null' | 'undefined' | 'empty_text' | 'html' | 'text' | 'array' | 'object' | 'other'

export interface BgaResponseDetails {
  readonly stage: BgaResponseStage
  readonly responseType: BgaResponseType
  readonly applicationCode?: string
  /** 结构问题的固定标签，不包含响应正文 */
  readonly problem?: string
}

/**
 * BGA 在 HTTP 200 正文里报告的失败或无法使用的外部响应。
 * message 只由固定字段拼成，不含 BGA 原文、URL、cookie 或 token，可以安全写日志。
 */
export class BgaResponseError extends Error {
  override readonly name = 'BgaResponseError'

  constructor(
    readonly reason: BgaResponseReason,
    readonly retryable: boolean,
    readonly details: BgaResponseDetails,
  ) {
    super(`bga ${reason} stage=${details.stage} responseType=${details.responseType} code=${details.applicationCode ?? 'none'} problem=${details.problem ?? 'none'}`)
  }
}

export interface BgaTablePlayer {
  readonly fullname: string
  readonly table_status?: string
}

export interface BgaTableInfo {
  readonly status: string
  readonly players: Readonly<Record<string, BgaTablePlayer>>
  readonly gameserver?: string
  readonly game_name?: string
  readonly result?: unknown
}

export interface BgaGameState {
  readonly active_player?: string
  readonly multiactive?: readonly string[]
  readonly args?: { readonly result?: BgaPlayerResult[] }
}

const SESSION_EXPIRED_CODE = '806'
const SESSION_EXPIRED_MESSAGE = /invalid session information/i
const UNAVAILABLE_MESSAGE = /maintenance|temporarily unavailable|try again later|too many requests|server is busy/i
const SAFE_CODE = /^[A-Za-z0-9_-]{1,32}$/
const SAFE_LOCATION = /^[A-Za-z0-9_-]{1,64}$/
const FINISHED_STATUSES = new Set(['finished', 'archive'])

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function describeResponseShape(value: unknown): BgaResponseType {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value !== 'string') return 'other'
  const text = value.trim()
  if (text === '') return 'empty_text'
  return /^<(!doctype|html|head|body)/i.test(text) || /<html[\s>]/i.test(text) ? 'html' : 'text'
}

function invalid(stage: BgaResponseStage, raw: unknown, problem: string): BgaResponseError {
  return new BgaResponseError('invalid_response', true, { stage, responseType: describeResponseShape(raw), problem })
}

function safeCode(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const code = String(value).trim()
  if (code === '') return undefined
  return SAFE_CODE.test(code) ? code : 'unrecognized'
}

function applicationCodeOf(payload: JsonObject): string | undefined {
  const nested = [payload.error, payload.data].filter(isObject)
  const candidates = [payload.code, payload.error_code, ...nested.flatMap(item => [item.code, item.error_code])]
  return candidates.map(safeCode).find(code => code !== undefined)
}

function errorTextOf(payload: JsonObject): string {
  const error = isObject(payload.error) ? payload.error.message : payload.error
  return typeof error === 'string' ? error : ''
}

function isSuccessStatus(status: unknown): boolean {
  return status === 1 || status === '1' || status === true
}

/** 只用原文做匹配，不把它放进错误对象 */
function classifyApplicationFailure(payload: JsonObject, raw: unknown): BgaResponseError {
  const applicationCode = applicationCodeOf(payload)
  const errorText = errorTextOf(payload)
  const details = { stage: 'tableinfos', responseType: describeResponseShape(raw), applicationCode } as const
  if (applicationCode === SESSION_EXPIRED_CODE || SESSION_EXPIRED_MESSAGE.test(errorText)) {
    return new BgaResponseError('session_expired', true, details)
  }
  if (UNAVAILABLE_MESSAGE.test(errorText)) return new BgaResponseError('bga_unavailable', true, details)
  if (errorText.trim() !== '' || applicationCode !== undefined) return new BgaResponseError('bga_error', false, details)
  return invalid('tableinfos', raw, 'failed_without_error')
}

function safeLocation(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const location = String(value)
  return SAFE_LOCATION.test(location) ? location : undefined
}

function parsePlayers(value: unknown): Record<string, BgaTablePlayer> | undefined {
  if (!isObject(value)) return undefined
  const players: Record<string, BgaTablePlayer> = {}
  for (const [id, player] of Object.entries(value)) {
    if (!isObject(player)) return undefined
    const { fullname, table_status: tableStatus } = player
    if (typeof fullname !== 'string' && typeof fullname !== 'number') return undefined
    players[id] = typeof tableStatus === 'string'
      ? { fullname: String(fullname), table_status: tableStatus }
      : { fullname: String(fullname) }
  }
  return players
}

/**
 * tableinfos.html 的顶层 status 不是 1 时，即使带了 data 也按失败处理。
 * 缺省顶层 status 但 data 结构完整时视为成功，兼容只返回 { data } 的响应。
 */
export function parseTableInfoResponse(raw: unknown): BgaTableInfo {
  if (!isObject(raw)) throw invalid('tableinfos', raw, 'not_object')
  const hasStatus = raw.status !== undefined
  if ((hasStatus && !isSuccessStatus(raw.status)) || (!hasStatus && errorTextOf(raw).trim() !== '')) {
    throw classifyApplicationFailure(raw, raw)
  }
  const data = raw.data
  if (!isObject(data)) throw invalid('tableinfos', raw, 'data_missing')
  if (typeof data.status !== 'string' || data.status === '') throw invalid('tableinfos', raw, 'table_status_missing')
  const finished = FINISHED_STATUSES.has(data.status)
  const players = parsePlayers(data.players) ?? (finished ? {} : undefined)
  if (!players) throw invalid('tableinfos', raw, 'players_invalid')
  return {
    status: data.status,
    players,
    gameserver: safeLocation(data.gameserver),
    game_name: safeLocation(data.game_name),
    result: data.result,
  }
}

export function extractRequestToken(raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('handshake', raw, 'not_text')
  const match = raw.match(/requestToken['":,\s]+([a-f0-9]{64})/)
  if (!match) throw invalid('handshake', raw, 'token_missing')
  return match[1]
}

const GAMESTATE_MARKER = '"gamestate":'

/** 从 start 处的 '{' 找到匹配的 '}'，跳过 JSON 字符串里的花括号和转义 */
function findObjectEnd(text: string, start: number): number | undefined {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (char === '\\') index++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return index + 1
  }
  return undefined
}

function playerIdOf(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function toGameState(value: unknown, raw: unknown): BgaGameState {
  if (!isObject(value)) throw invalid('gamestate', raw, 'not_object')
  // BGA 在多活/终局状态下会给 active_player:null，按缺失处理
  const hasActivePlayer = value.active_player !== undefined && value.active_player !== null
  const activePlayer = hasActivePlayer ? playerIdOf(value.active_player) : undefined
  if (hasActivePlayer && activePlayer === undefined) throw invalid('gamestate', raw, 'active_player_invalid')
  let multiactive: string[] | undefined
  if (value.multiactive !== undefined) {
    if (!Array.isArray(value.multiactive)) throw invalid('gamestate', raw, 'multiactive_invalid')
    multiactive = value.multiactive.map(playerIdOf).filter((id): id is string => id !== undefined)
  }
  const result = isObject(value.args) && Array.isArray(value.args.result) ? value.args.result as BgaPlayerResult[] : undefined
  // 终局 state 可能只带结果不带行动玩家；两者都没有才说明读到的不是可用状态
  if (activePlayer === undefined && multiactive === undefined && result === undefined) {
    throw invalid('gamestate', raw, 'players_missing')
  }
  return {
    ...(activePlayer === undefined ? {} : { active_player: activePlayer }),
    ...(multiactive === undefined ? {} : { multiactive }),
    ...(result === undefined ? {} : { args: { result } }),
  }
}

export function parseGameStatePage(raw: unknown): BgaGameState {
  if (typeof raw !== 'string') throw invalid('gamestate', raw, 'not_text')
  const markerIndex = raw.indexOf(GAMESTATE_MARKER)
  if (markerIndex === -1) throw invalid('gamestate', raw, 'marker_missing')
  const start = raw.indexOf('{', markerIndex + GAMESTATE_MARKER.length)
  if (start === -1 || raw.slice(markerIndex + GAMESTATE_MARKER.length, start).trim() !== '') {
    throw invalid('gamestate', raw, 'object_missing')
  }
  const end = findObjectEnd(raw, start)
  if (end === undefined) throw invalid('gamestate', raw, 'object_unterminated')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end))
  } catch {
    throw invalid('gamestate', raw, 'json_invalid')
  }
  return toGameState(parsed, raw)
}
