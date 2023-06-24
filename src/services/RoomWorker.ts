import { Contact, Message, Room, Wechaty, types } from "@juzi/wechaty"
import puppeteer, { Browser, Page } from "puppeteer"
import { Logger } from "src/helpers/logger"
import { TableObserver } from "./TableObserver"

export class RoomWorker {

  private readonly logger = new Logger(RoomWorker.name)

  _browser?: Browser

  async getBrowserInstance() {
    if (!this._browser) {
      this._browser = await puppeteer.launch({
        headless: false // debug usage
      })
    }
    return this._browser
  }

  tableObserveList: TableObserve[] = []
  
  constructor(private readonly bot: Wechaty, private readonly room: Room, private readonly contact?: Contact) {
    this.bot.on('message', (message: Message) => {
      if (message.type() !== types.Message.Text) {
        this.logger.verbose('non-text message will be ignored')
      }
      if (message.talker() === this.contact) {
        void this.handleAdminMessage(message)
        return
      }
      if (message.room() === this.room) {
        void this.handleRoomMessage(message)
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
    // TODO
  }

  async subscribeTable(tableId: string, reportTarget: Contact | Room) {
    this.logger.info(`will observe table ${tableId} and report to ${reportTarget}`)

    const tableObserve = this.tableObserveList.find(ob => ob.tableId === tableId)
    if (tableObserve) {
      if (tableObserve.subscribers.includes(reportTarget)) {
        reportTarget.say(`You are already observing table ${tableId}`)
      } else {
        tableObserve.subscribers.push(reportTarget)
      }

      // TODO: Report current table status to target

      return
    }

    const browser = await this.getBrowserInstance()
    const page = await browser.newPage()

    const ob = new TableObserver(tableId, page)
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
      tableObserve.subscribers.forEach(target => {
        target.say(`成功OB游戏桌${tableObserve.tableId}，当前状态为${tableObserve.observer.currentState}`).catch((e: Error) => {
          this.logger.error(`messageSendError, ${e.stack}`)
        })
      })
    }).on('end', () => {
      tableObserve.observer.close()
      tableObserve.subscribers.forEach(target => {
        target.say(`游戏桌${tableObserve.tableId}已结束，停止OB`).catch((e: Error) => {
          this.logger.error(`messageSendError, ${e.stack}`)
        })
      })
      this.tableObserveList = this.tableObserveList.filter(item => item !== tableObserve)
    })
  }

  sendCurrentState(tableObserve: TableObserve) {
    const currentState = tableObserve.observer.currentState
    tableObserve.subscribers.forEach(target => {
      target.say(`游戏桌${tableObserve.tableId}当前状态为 ${currentState}`).catch((e: Error) => {
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