import { Contact, Message, Room, Wechaty, types } from "@juzi/wechaty";
import { Logger } from "src/helpers/logger";

export class RoomWorker {

  private readonly Logger = new Logger(RoomWorker.name)
  
  constructor(private readonly bot: Wechaty, private readonly room: Room, private readonly contact?: Contact) {
    this.bot.on('message', (message: Message) => {
      if (message.type() !== types.Message.Text) {
        this.Logger.verbose('non-text message will be ignored')
      }
      if (message.talker() === this.contact) {
        void this.handleAdminMessage(message)
        return
      }
      if (message.room() === this.room) {
        void this.handleRoomMessage(message)
        return
      }
      this.Logger.verbose('message from others will be ignored')
    })
  }

  sendAlarm(alarmText: string): Promise<void | Message> {
    if (this.contact) {
      return this.contact.say(alarmText)
    }
  }

  async handleAdminMessage(message: Message) {
    // TODO
  }

  async handleRoomMessage(message: Message) {
    // TODO
  }
}