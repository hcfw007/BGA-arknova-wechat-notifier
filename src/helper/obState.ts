export interface PersistedSubscriber {
  type: 'room' | 'contact'
  id: string
}

export interface PersistedTable {
  tableId: string
  subscribers: PersistedSubscriber[]
}

export interface PersistedPlayer {
  playerId: string
  playerName: string
  subscribers: PersistedSubscriber[]
}

export interface ObState {
  tables: PersistedTable[]
  players: PersistedPlayer[]
}

export const EMPTY_STATE: ObState = { tables: [], players: [] }

/**
 * v1 的状态文件是一个裸的 PersistedTable[]，线上跑着的实例就是这个格式，
 * 升级时必须原样认下来，否则重启会丢掉所有正在 ob 的桌。
 */
export function parseObState(raw: unknown): ObState {
  if (Array.isArray(raw)) {
    return { tables: raw as PersistedTable[], players: [] }
  }
  if (!raw || typeof raw !== 'object') {
    return EMPTY_STATE
  }
  const state = raw as Partial<ObState>
  return {
    tables: Array.isArray(state.tables) ? state.tables : [],
    players: Array.isArray(state.players) ? state.players : [],
  }
}
