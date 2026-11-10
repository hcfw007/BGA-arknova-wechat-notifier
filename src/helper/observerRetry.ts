import axios, { AxiosError } from 'axios'

export interface ObserverFailure {
  retryable: boolean
  reason: string
  status?: number
  retryAfterMs?: number
  endpoint?: string
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
