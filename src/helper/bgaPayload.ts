/** tablemanager 返回的是全部游戏的桌，按这个名字筛出动物园之星 */
export const ARK_NOVA_GAME_NAME = 'arknova'

export interface PlayerTable {
  tableId: string
  progression: number
}

/**
 * 解析 tablemanager/tableinfos.html?playerfilter=<id> 的返回，
 * 只取该玩家进行中的 Ark Nova 桌。
 */
export function arkNovaTablesFromPlayerTables(payload: any): PlayerTable[] {
  const tables = payload?.data?.tables
  if (!tables || typeof tables !== 'object') return []
  return Object.values(tables as Record<string, any>)
    .filter(t => t?.game_name === ARK_NOVA_GAME_NAME && t?.cancelled !== '1')
    .map(t => ({ tableId: String(t.id), progression: Number(t.progression) || 0 }))
    .sort((a, b) => a.tableId.localeCompare(b.tableId))
}

export interface BgaPlayerRef {
  id: string
  name: string
}

export type PlayerLookup =
  | { kind: 'found'; player: BgaPlayerRef }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: BgaPlayerRef[] }

/**
 * findplayer.html 是前缀搜索，"Theim" 会连 "theimada"、"TheImbaNess" 一起返回。
 * 只认**大小写敏感的完全相等**；万一仍命中多个，返回 ambiguous 交给调用方汇报，
 * 绝不替用户挑一个——订阅错人比订阅失败糟糕得多。
 */
export function pickExactPlayer(payload: any, name: string): PlayerLookup {
  const items = payload?.items
  if (!Array.isArray(items)) return { kind: 'none' }

  const wanted = (name ?? '').trim()
  const matches: BgaPlayerRef[] = items
    .filter((item: any) => String(item?.q ?? '') === wanted)
    .map((item: any) => ({ id: String(item.id), name: String(item.q) }))

  if (matches.length === 0) return { kind: 'none' }
  if (matches.length === 1) return { kind: 'found', player: matches[0] }
  return { kind: 'ambiguous', matches }
}

export interface BgaPlayerResult {
  name: string
  score: string
  score_aux: string
  rank: number
}

/** 终局排名，取自 tableinfos.html 的 data.result.player；牌局未结束时为 null */
export function resultFromTableInfo(tableInfo: any): BgaPlayerResult[] | null {
  const players = tableInfo?.result?.player
  if (!Array.isArray(players) || players.length === 0) return null
  return players
    .map((p: any): BgaPlayerResult => ({
      name: p.name,
      score: p.score,
      score_aux: p.score_aux,
      rank: Number(p.gamerank),
    }))
    .sort((a, b) => a.rank - b.rank)
}

/** 已受邀但还没进桌的玩家，牌局尚未开始时用来催人 */
export function getExpectedPlayers(tableInfo: any): string[] {
  if (!tableInfo?.players) return []
  return Object.values(tableInfo.players as Record<string, { fullname: string; table_status: string }>)
    .filter(p => p.table_status === 'expected')
    .map(p => p.fullname)
}
