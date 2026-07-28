import { Contact, Message, Room, Wechaty, types } from "@juzi/wechaty"
import axios from "axios"
import { parseCommand } from "../helper/command"
import { Logger } from "../helper/logger"
import { ObStateStore, PersistedTable } from "../helper/obStateStore"
import { TableObserver } from "./tableObserver"
import { config } from "../config"

const BGA_SESSION_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours

export class RoomWorker {

  private readonly logger = new Logger(RoomWorker.name)

  tableObserveList: TableObserve[] = []
  private bgaCookie?: string
  private bgaCookieObtainedAt?: number

  private readonly stateStore = new ObStateStore(config.stateFile)
  private stateRestored = false

  constructor(private readonly bot: Wechaty, private readonly contact?: Contact) {
    void this.prefetchBgaSession()
    this.bot.on('message', (message: Message) => {
      if (message.type() !== types.Message.Text) {
        this.logger.verbose('non-text message will be ignored')
        return
      }
      if (message.room()) {
        void this.handleRoomMessage(message)
        return
      }
      if (message.talker() === this.contact) {
        void this.handleAdminMessage(message)
        return
      }
      this.logger.verbose('message from others will be ignored')
    })
  }

  private async prefetchBgaSession() {
    try {
      this.logger.info('prefetching BGA session')
      const res = await axios.get('https://en.boardgamearena.com/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        maxRedirects: 5,
        timeout: 30_000,
      })
      const cookies = ((res.headers['set-cookie'] ?? []) as string[]).map(c => c.split(';')[0]).join('; ')
      if (cookies) {
        this.bgaCookie = cookies
        this.bgaCookieObtainedAt = Date.now()
        this.logger.info('BGA session prefetched')
      }
    } catch (e) {
      this.logger.error(`prefetchBgaSession error: ${e}`)
    }
  }

  private isCookieValid(): boolean {
    return !!this.bgaCookie && !!this.bgaCookieObtainedAt &&
      Date.now() - this.bgaCookieObtainedAt < BGA_SESSION_TTL_MS
  }

  private isRoom(target: Contact | Room): target is Room {
    return typeof (target as any).topic === 'function'
  }

  private persistState() {
    const tables: PersistedTable[] = this.tableObserveList.map(ob => ({
      tableId: ob.tableId,
      subscribers: ob.subscribers.map(sub => ({
        type: this.isRoom(sub) ? 'room' : 'contact',
        id: sub.id,
      })),
    }))
    this.stateStore.save(tables)
  }

  async restoreState() {
    if (this.stateRestored) {
      return
    }
    this.stateRestored = true

    const tables = this.stateStore.load()
    if (tables.length === 0) {
      return
    }

    this.logger.info(`restoring ${tables.length} observed table(s) from state file`)

    for (const table of tables) {
      try {
        for (const sub of table.subscribers) {
          const target = sub.type === 'room'
            ? await this.bot.Room.find({ id: sub.id })
            : await this.bot.Contact.find({ id: sub.id })
          if (!target) {
            this.logger.warn(`cannot resolve ${sub.type} ${sub.id} for table ${table.tableId}, skipping`)
            continue
          }
          await this.subscribeTable(table.tableId, target, false)
        }
      } catch (e) {
        this.logger.error(`restore table ${table.tableId} failed: ${e}`)
        void this.sendAlarm(`恢复Ob游戏桌${table.tableId}失败：${e}`)
      }
    }

    this.persistState()
    this.logger.info('ob state restore complete')
  }

  async sendAlarm(alarmText: string): Promise<void> {
    if (!this.contact) {
      return
    }
    try {
      await this.contact.say(alarmText)
    } catch (e) {
      this.logger.error(`sendAlarm failed: ${e}`)
    }
  }

  /** 统一发送出口：say 失败只记日志，不冒泡成 unhandledRejection */
  private async safeSay(target: Contact | Room, text: string, mentionList?: (Contact | '@all')[]) {
    try {
      await target.say(text, mentionList ? { mentionList } : undefined)
    } catch (e) {
      this.logger.error(`messageSendError, ${(e as Error).stack}`)
    }
  }

  private async handleCommand(text: string, reportTarget: Contact | Room) {
    const command = parseCommand(text)
    if (!command) {
      return
    }
    if (command.action === 'stop') {
      return this.unSubscribeTable(command.tableId, reportTarget)
    }
    return this.subscribeTable(command.tableId, reportTarget)
  }

  async handleAdminMessage(message: Message) {
    return this.handleCommand(message.text(), message.talker())
  }

  async handleRoomMessage(message: Message) {
    // 群内不限定发言人，也不要求 @机器人：命令已锚定为整条消息，误触发风险可控
    return this.handleCommand(message.text(), message.room())
  }

  async unSubscribeTable(tableId: string, reportTarget: Contact | Room) {
    const tableObserve = this.tableObserveList.find(ob => ob.tableId === tableId)
    if (!tableObserve) {
      await this.safeSay(reportTarget, `没有在Ob ${tableId}`)
      return
    }

    // 按 id 比对：重启恢复出来的 Room/Contact 和消息里带的不是同一个实例
    tableObserve.subscribers = tableObserve.subscribers.filter(item => item.id !== reportTarget.id)
    if (tableObserve.subscribers.length === 0) {
      tableObserve.observer.close()
      this.tableObserveList = this.tableObserveList.filter(item => item !== tableObserve)
    }
    this.persistState()
    await this.safeSay(reportTarget, `已停止Ob ${tableId}`)
  }

  async subscribeTable(tableId: string, reportTarget: Contact | Room, announce = true) {
    await reportTarget.sync()
    if (announce) {
      await this.safeSay(reportTarget, `收到Ob ${tableId}，请稍等...`)
    }
    this.logger.info(`will observe table ${tableId} and report to ${reportTarget}`)

    const tableObserve = this.tableObserveList.find(ob => ob.tableId === tableId)
    if (tableObserve) {
      if (tableObserve.subscribers.some(item => item.id === reportTarget.id)) {
        if (announce) {
          await this.safeSay(reportTarget, `已经在Ob ${tableId}了 `)
        }
      } else {
        tableObserve.subscribers.push(reportTarget)
        this.persistState()
      }

      if (tableObserve.observer.ready) {
        // 已经 ready 的桌子，补发
        this.reportCurrentState(tableObserve)
      }

      return
    }

    const playerMap = {}
    for (const bgaName in config.playerMap) {
      playerMap[bgaName] = await this.bot.Contact.find({id: config.playerMap[bgaName]})
    }

    const sharedCookie = this.isCookieValid() ? this.bgaCookie : undefined
    const ob = new TableObserver(tableId, playerMap, sharedCookie, (cookie) => {
      this.bgaCookie = cookie
      this.bgaCookieObtainedAt = Date.now()
    })
    const newTableObserve = {
      tableId,
      subscribers: [reportTarget],
      observer: ob
    }

    this.tableObserveList.push(newTableObserve)
    this.persistState()

    this.bindEvents(newTableObserve)

    await ob.init()
  }

  bindEvents(tableObserve: TableObserve) {
    tableObserve.observer.on('ready', () => {
      this.logger.info(`table ${tableObserve.tableId} ready`)
      tableObserve.subscribers.forEach(target => {
        void this.safeSay(target, `成功OB游戏桌${tableObserve.tableId}`)
      })
      this.reportCurrentState(tableObserve)
    }).on('end', (result: { name: string; score: string; rank: number }[]) => {
      tableObserve.observer.close()
      const lines: string[] = [`游戏桌${tableObserve.tableId}已结束`]
      if (result.length > 0) {
        lines.push('最终排名：')
        result.forEach(p => lines.push(`  ${p.rank}. ${p.name}  ${p.score}分`))
      }
      lines.push('停止OB')
      tableObserve.subscribers.forEach(target => {
        void this.safeSay(target, lines.join('\n'))
      })
      this.tableObserveList = this.tableObserveList.filter(item => item !== tableObserve)
      this.persistState()
    }).on('newPlayerMove', () => {
      this.reportCurrentState(tableObserve)
    }).on('error', () => {
      tableObserve.observer.close()
      this.bgaCookie = undefined // invalidate session on error
      void this.sendAlarm(`游戏桌${tableObserve.tableId}观测失败，已停止OB`)
      tableObserve.subscribers.forEach(target => {
        void this.safeSay(target, `游戏桌${tableObserve.tableId}发生错误，停止OB`)
      })
      this.tableObserveList = this.tableObserveList.filter(item => item !== tableObserve)
      this.persistState()
    })
  }

  reportCurrentState(tableObserve: TableObserve) {
    const players = tableObserve.observer.currentPlayers
    const waiting = tableObserve.observer.waitingForJoin
    const contacts: (Contact | '@all')[] = []
    let str = `[桌号${tableObserve.tableId}] `

    if (waiting) {
      const names = []
      for (const player of players || []) {
        let name = player
        const contact = tableObserve.observer.getContactFromPlayer(player)
        if (contact) {
          name += `(${contact === 'all' ? '所有人' : contact.name()})`
          contacts.push(contact === 'all' ? '@all' : contact)
        }
        names.push(name)
      }
      str += `${names.join('、')}尚未加入。`
    } else {
      str += '现在轮到'
      for (const player of players || []) {
        str += `${player}`
        const contact = tableObserve.observer.getContactFromPlayer(player)
        if (contact) {
          str += `(${contact === 'all' ? '所有人' : contact.name()})`
          contacts.push(contact === 'all' ? '@all' : contact)
        }
      }
      str += `。`
    }
    tableObserve.subscribers.forEach(target => {
      this.logger.info(`saying ${str} to ${target}, mentioning ${contacts}`)
      void this.safeSay(target, str, contacts)
    })
  }
}

export interface TableObserve {
  tableId: string,
  subscribers: (Contact | Room)[],
  observer: TableObserver,
}
