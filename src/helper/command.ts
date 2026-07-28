// 必须整条消息就是命令，否则群聊里随口一句带数字的话就会误触发
const OB_COMMAND = /^ob\s+(\d+)$/i
const STOP_COMMAND = /^(?:停止|stop)\s+(\d+)$/i

export interface ObCommand {
  action: 'ob' | 'stop'
  tableId: string
}

export function parseCommand(text: string): ObCommand | undefined {
  const trimmed = (text ?? '').trim()

  const stop = STOP_COMMAND.exec(trimmed)
  if (stop) {
    return { action: 'stop', tableId: stop[1] }
  }

  const ob = OB_COMMAND.exec(trimmed)
  if (ob) {
    return { action: 'ob', tableId: ob[1] }
  }
}
