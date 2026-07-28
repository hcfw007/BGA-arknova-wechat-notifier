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
