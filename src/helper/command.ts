// 必须整条消息就是命令，否则群聊里随口一句带数字的话就会误触发
const OB_COMMAND = /^ob\s+(\d+)$/i
const STOP_COMMAND = /^(?:停止|stop)\s+(\d+)$/i
// 订阅的参数可以是 BGA 数字 id，也可以是用户名，所以放宽到非空白串
const SUBSCRIBE_COMMAND = /^(?:订阅|subscribe)\s+(\S+)$/i
const UNSUBSCRIBE_COMMAND = /^(?:退订|unsubscribe)\s+(\S+)$/i

export type ObCommandAction = 'ob' | 'stop' | 'subscribe' | 'unsubscribe'

export interface ObCommand {
  action: ObCommandAction
  /** ob / stop 是桌号；subscribe / unsubscribe 是 BGA 玩家 id 或用户名 */
  target: string
}

// unsubscribe 必须排在 subscribe 前面：两者都以 "subscribe" 结尾，
// 若先匹配 subscribe，"unsubscribe x" 会因整串锚定而落空，反而更隐蔽
const MATCHERS: ReadonlyArray<readonly [RegExp, ObCommandAction]> = [
  [STOP_COMMAND, 'stop'],
  [OB_COMMAND, 'ob'],
  [UNSUBSCRIBE_COMMAND, 'unsubscribe'],
  [SUBSCRIBE_COMMAND, 'subscribe'],
]

export function parseCommand(text: string): ObCommand | undefined {
  const trimmed = (text ?? '').trim()

  for (const [pattern, action] of MATCHERS) {
    const matched = pattern.exec(trimmed)
    if (matched) {
      return { action, target: matched[1] }
    }
  }
}

/** 纯数字视为 BGA 玩家 id，其余按用户名去查 */
export function looksLikePlayerId(target: string): boolean {
  return /^\d+$/.test(target)
}
