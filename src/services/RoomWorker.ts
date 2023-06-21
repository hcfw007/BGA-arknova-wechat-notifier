import { Contact, Message, Room, Wechaty, types } from "@juzi/wechaty";
import { Logger } from "src/helpers/logger";

export class RoomWorker {

  private readonly logger = new Logger(RoomWorker.name)
  
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
  }
}