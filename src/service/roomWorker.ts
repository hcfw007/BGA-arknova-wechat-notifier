import { Contact, Message, Room, Wechaty, types } from "@juzi/wechaty"
import puppeteer, { Browser } from "puppeteer"
import { Logger } from "../helper/logger"
import { TableObserver } from "./tableObserver"
import { config } from "../config"

export class RoomWorker {

  private readonly logger = new Logger(RoomWorker.name)

  _browser?: Browser

  async getBrowserInstance() {
    if (!this._browser) {
      this._browser = await puppeteer.launch({
        headless: config.puppetHeadless ? undefined : false,
        args: ['--no-sandbox']
      })
    }
    return this._browser
  }

  tableObserveList: TableObserve[] = []
  
  constructor(private readonly bot: Wechaty, private readonly contact?: Contact) {
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

  sendAlarm(alarmText: string): Promise<void | Message> {
    if (this.contact) {
      return this.contact.say(alarmText)
    }
  }

  async handleAdminMessage(message: Message) {
    const text = message.text()

    if (/^观察 \d+$/.test(text) || /^ob \d+$/.test(text)) {
      const table = /\d+$/.exec(text)[0]
      return this.subscribeTable(table, message.talker())
    }
  }

  async handleRoomMessage(message: Message) {
    // if (!await message.mentionSelf()) {
    //   return
    // }
    const text = message.text()

    if (/观察 \d+$/.test(text) || /ob \d+$/.test(text)) {
      const table = /\d+$/.exec(text)[0]
      return this.subscribeTable(table, message.room())
    }
  }

  async unSubscribeTable(tableId: string, reportTarget: Contact | Room) {
    const tableObserve = this.tableObserveList.find(ob => ob.tableId === tableId)
    if (!tableObserve) {
      reportTarget.say(`没有在观察 ${tableId}`)
    } else {
      tableObserve.subscribers = tableObserve.subscribers.filter(item => item !== reportTarget)
      if (tableObserve.subscribers.length === 0) {
        tableObserve.observer.close()
      }
      reportTarget.say(`已停止观察 ${tableId}`)
    }
  }

  async subscribeTable(tableId: string, reportTarget: Contact | Room) {
    this.logger.info(`will observe table ${tableId} and report to ${reportTarget}`)

    const tableObserve = this.tableObserveList.find(ob => ob.tableId === tableId)
    if (tableObserve) {
      if (tableObserve.subscribers.includes(reportTarget)) {
        reportTarget.say(`已经在观察 ${tableId}了 `)
      } else {
        tableObserve.subscribers.push(reportTarget)
      }

      if (tableObserve.observer.pageReady) {
        // 已经 ready 的桌子，补发
        this.reportCurrentState(tableObserve)
      }
      
      return
    }

    const browser = await this.getBrowserInstance()
    const page = await browser.newPage()

    const playerMap = {}
    for (const bgaName in config.playerMap) {
      playerMap[bgaName] = await this.bot.Contact.find({id: config.playerMap[bgaName]})
    }

    const ob = new TableObserver(tableId, page, playerMap)
    const newTableObserve = {
      tableId,
      subscribers: [reportTarget],
      observer: ob
    }

    this.tableObserveList.push(newTableObserve)
    // TODO: create a ob and setup listeners

    this.bindEvents(newTableObserve)

    await ob.init()
  }

  bindEvents(tableObserve: TableObserve) {
    tableObserve.observer.on('ready', () => {
      this.logger.info(`table ${tableObserve.tableId} ready`)
      tableObserve.subscribers.forEach(target => {
        target.say(`成功OB游戏桌${tableObserve.tableId}，当前状态为${tableObserve.observer.currentState}`).catch((e: Error) => {
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
      tableObserve.subscribers.forEach(target => {
        target.say(`游戏桌${tableObserve.tableId}发生错误，停止OB`).catch((e: Error) => {
          this.logger.error(`messageSendError, ${e.stack}`)
        })
      })
      this.tableObserveList = this.tableObserveList.filter(item => item !== tableObserve)
    })
  }

  reportCurrentState(tableObserve: TableObserve) {
    let str = '现在轮到'
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

    const currentState = tableObserve.observer.currentState 
    str += `，当前状态为 ${currentState}。`
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