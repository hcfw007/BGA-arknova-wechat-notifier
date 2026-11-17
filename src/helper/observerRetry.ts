import axios, { AxiosError } from 'axios'

import { BgaResponseError } from './bgaResponse'

export interface ObserverFailure {
  retryable: boolean
  reason: string
  status?: number
  retryAfterMs?: number
  endpoint?: string
  /** BGA 正文里的业务错误码（如 806），与 HTTP status 无关 */
  applicationCode?: string
}

const SAFE_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError',
  'AggregateError', 'AxiosError', 'CanceledError', 'BgaResponseError',
])
const SAFE_AXIOS_CODE = /^[A-Z0-9_]{1,40}$/
const STACK_LOCATION = /(?:^|[\s(])((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^\s()?#]*:\d+:\d+)\)?$/
const UNSAFE_PATH_CHARS = /[^\w./\\:@-]/g

/** 第一条代码路径栈帧：跳过 message 行，忽略 node 内部帧和 URL，避免带出凭据 */
function firstCodeFrame(stack: string | undefined): string {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const match = line.trim().match(STACK_LOCATION)
    if (match) return match[1].replace(/^file:\/\//, '').replace(UNSAFE_PATH_CHARS, '')
  }
  return 'none'
}

/** 只输出白名单错误名、固定元信息和代码位置，不输出 message、响应体、URL 或请求头 */
export function describeErrorSafely(error: unknown): string {
  if (error instanceof BgaResponseError) {
    const { stage, responseType, applicationCode, problem } = error.details
    return `errorName=BgaResponseError stage=${stage} responseType=${responseType} code=${applicationCode ?? 'none'} problem=${problem ?? 'none'}`
  }
  if (axios.isAxiosError(error)) {
    const code = typeof error.code === 'string' && SAFE_AXIOS_CODE.test(error.code) ? error.code : 'unrecognized'
    return `errorName=AxiosError code=${code}`
  }
  if (!(error instanceof Error)) return 'errorName=non_error frame=none'
  const name = SAFE_ERROR_NAMES.has(error.name) ? error.name : 'Error'
  return `errorName=${name} frame=${firstCodeFrame(error.stack)}`
}

export function sanitizeEndpoint(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined
  try {
    const url = new URL(rawUrl, 'https://en.boardgamearena.com')
    const tableId = url.searchParams.get('table') ?? url.searchParams.get('id')
    const query = tableId && /^\d+$/.test(tableId) ? `?${url.searchParams.has('table') ? 'table' : 'id'}=${tableId}` : ''
    return `${url.origin}${url.pathname}${query}`
  } catch {
    return undefined
  }
}

const RETRYABLE_CODES = new Set([
  'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND',
  'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_NETWORK',
])
const BASE_DELAY_MS = 60_000
const MAX_BACKOFF_MS = 15 * 60_000

function parseRetryAfter(value: unknown, now: number): number | undefined {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') return undefined
  const header = String(value).trim()
  if (typeof value === 'number' || /^\d+$/.test(header)) {
    const seconds = Number(header)
    const milliseconds = seconds * 1000
    return seconds >= 0 && Number.isFinite(milliseconds) ? milliseconds : undefined
  }
  if (/^-/.test(header) || !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) return undefined
  const date = Date.parse(header)
  return Number.isFinite(date) && new Date(date).toUTCString() === header && date >= now ? date - now : undefined
}

export function classifyObserverFailure(error: unknown, now = Date.now()): ObserverFailure {
  if (error instanceof BgaResponseError) {
    const { applicationCode } = error.details
    return applicationCode === undefined
      ? { retryable: error.retryable, reason: error.reason }
      : { retryable: error.retryable, reason: error.reason, applicationCode }
  }
  if (!axios.isAxiosError(error)) return { retryable: false, reason: 'unexpected_error' }
  const axiosError: AxiosError<unknown> = error
  const endpoint = sanitizeEndpoint(axiosError.config?.url)
  const status = axiosError.response?.status
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
    const header = axiosError.response?.headers?.['retry-after']
    return {
      retryable: true,
      reason: status === 429 ? 'rate_limited' : 'server_error',
      status,
      retryAfterMs: parseRetryAfter(header, now),
      endpoint,
    }
  }
  if (status === undefined && axiosError.code && RETRYABLE_CODES.has(axiosError.code)) {
    return { retryable: true, reason: 'network_error', endpoint }
  }
  return { retryable: false, reason: status === undefined ? 'unexpected_error' : 'http_error', status, endpoint }
}

export function retryDelay(attempt: number, retryAfter: string | number | undefined, now: number, random = Math.random): number {
  const ordinary = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1))
  const jittered = Math.round(ordinary * (0.9 + random() * 0.2))
  const serverDelay = retryAfter === undefined ? undefined : parseRetryAfter(retryAfter, now)
  return serverDelay === undefined ? jittered : Math.max(jittered, serverDelay)
}

export function retryDelayForFailure(attempt: number, failure: ObserverFailure, now: number, random = Math.random): number {
  const ordinary = retryDelay(attempt, undefined, now, random)
  return failure.retryAfterMs === undefined ? ordinary : Math.max(ordinary, failure.retryAfterMs)
}
