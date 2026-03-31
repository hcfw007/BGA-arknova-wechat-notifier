import { Contact, Message, Room, Wechaty, types } from "@juzi/wechaty"
import axios from "axios"
import { Logger } from "../helper/logger"
import { TableObserver } from "./tableObserver"
import { config } from "../config"

const BGA_SESSION_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours

export class RoomWorker {

  private readonly logger = new Logger(RoomWorker.name)

  tableObserveList: TableObserve[] = []
  private bgaCookie?: string
  private bgaCookieObtainedAt?: number

  constructor(private readonly bot: Wechaty, private readonly contact?: Contact) {
    void this.prefetchBgaSession()
    this.bot.on('message', (message: Message) => {
      if (message.type() !== types.Message.Text) {
        this.logger.verbose('non-text message will be ignored')
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

  sendAlarm(alarmText: string): Promise<void | Message> {
    if (this.contact) {
      return this.contact.say(alarmText)
    }
  }

  async handleAdminMessage(message: Message) {
    const text = message.text()

    if (/停止 \d+$/.test(text) || /stop \d+$/.test(text)) {
      const table = /\d+$/.exec(text)[0]
      return this.unSubscribeTable(table, message.talker())
    }

    if (/^Ob \d+$/.test(text) || /^ob \d+$/.test(text)) {
      const table = /\d+$/.exec(text)[0]
      return this.subscribeTable(table, message.talker())
    }
  }

  async handleRoomMessage(message: Message) {
    // if (!await message.mentionSelf()) {
    //   return
    // }
    const text = message.text()

    if (/停止 \d+$/.test(text) || /stop \d+$/.test(text)) {
      const table = /\d+$/.exec(text)[0]
      return this.unSubscribeTable(table, message.room())
    }

    if (/Ob \d+$/.test(text) || /ob \d+$/.test(text)) {
      const table = /\d+$/.exec(text)[0]
      return this.subscribeTable(table, message.room())
    }
  }

  async unSubscribeTable(tableId: string, reportTarget: Contact | Room) {
    const tableObserve = this.tableObserveList.find(ob => ob.tableId === tableId)
    if (!tableObserve) {
      reportTarget.say(`没有在Ob ${tableId}`)
    } else {
      tableObserve.subscribers = tableObserve.subscribers.filter(item => item !== reportTarget)
      if (tableObserve.subscribers.length === 0) {
        tableObserve.observer.close()
      }
      reportTarget.say(`已停止Ob ${tableId}`)
    }
  }

  async subscribeTable(tableId: string, reportTarget: Contact | Room) {
    await reportTarget.sync()
    await reportTarget.say(`收到Ob ${tableId}，请稍等...`)
    this.logger.info(`will observe table ${tableId} and report to ${reportTarget}`)

    const tableObserve = this.tableObserveList.find(ob => ob.tableId === tableId)
    if (tableObserve) {
      if (tableObserve.subscribers.includes(reportTarget)) {
        reportTarget.say(`已经在Ob ${tableId}了 `)
      } else {
        tableObserve.subscribers.push(reportTarget)
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

    this.bindEvents(newTableObserve)

    await ob.init()
  }

  bindEvents(tableObserve: TableObserve) {
    tableObserve.observer.on('ready', () => {
      this.logger.info(`table ${tableObserve.tableId} ready`)
      tableObserve.subscribers.forEach(target => {
        target.say(`成功OB游戏桌${tableObserve.tableId}`).catch((e: Error) => {
          this.logger.error(`messageSendError, ${e.stack}`)
        })
      })
      this.reportCurrentState(tableObserve)
    }).on('end', () => {
      tableObserve.observer.close()
      tableObserve.subscribers.forEach(target => {
        target.say(`游戏桌${tableObserve.tableId}已结束，停止OB`).catch((e: Error) => {
          this.logger.error(`messageSendError, ${e.stack}`)
        })
      })
      this.tableObserveList = this.tableObserveList.filter(item => item !== tableObserve)
    }).on('newPlayerMove', () => {
      this.reportCurrentState(tableObserve)
    }).on('error', () => {
      tableObserve.observer.close()
      this.bgaCookie = undefined // invalidate session on error
      tableObserve.subscribers.forEach(target => {
        target.say(`游戏桌${tableObserve.tableId}发生错误，停止OB`).catch((e: Error) => {
          this.logger.error(`messageSendError, ${e.stack}`)
        })
      })
      this.tableObserveList = this.tableObserveList.filter(item => item !== tableObserve)
    })
  }

  reportCurrentState(tableObserve: TableObserve) {
    let str = `[桌号${tableObserve.tableId}] 现在轮到`
    const players = tableObserve.observer.currentPlayers
    const contacts = []
    for (const player of players || []) {
      str += `${player}`
      const contact = tableObserve.observer.getContactFromPlayer(player)
      if (contact) {
        str += `(${contact === 'all' ? '所有人' : contact.name()})`
        contacts.push(contact === 'all' ? '@all' : contact)
      }
    }

    str += `。`
    tableObserve.subscribers.forEach(target => {
      this.logger.info(`saying ${str} to ${target}, mentioning ${contacts}`)
      target.say(str, {
        mentionList: contacts
      }).catch((e: Error) => {
        this.logger.error(`messageSendError, ${e.stack}`)
      })
    })
  }
}

export interface TableObserve {
  tableId: string,
  subscribers: (Contact | Room)[],
  observer: TableObserver,
}
