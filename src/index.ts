import { Contact, WechatyBuilder, log } from '@juzi/wechaty'
import { ScanStatus } from '@juzi/wechaty-puppet/types'
import QrcodeTerminal from 'qrcode-terminal'
import PuppetPadplus from '@juzi/wechaty-puppet-padplus'

import { config } from './config'
import { RoomWorker } from './services/roomWorker'

const PRE = 'Index'

const puppet = new PuppetPadplus({
  token: config.token,
  endpoint: config.endpoint,
  tls: {
    disable: true
  }
})
const bot = WechatyBuilder.build({
  puppet: puppet,
  name: 'arknova-ob',
})

let roomWorker: RoomWorker

bot.on('scan', (qrcode: string, status: ScanStatus) => {
  if (status === ScanStatus.Waiting) {
    QrcodeTerminal.generate(qrcode, {
      small: true
    })
  }
}).on('login', async (user: Contact) => {
  log.info(PRE, `user login, info: ${JSON.stringify(user)}`)

  const room = await bot.Room.find({id: config.workingRoomId})
  const contact = await bot.Contact.find({id: config.alarmReceiver})
  if (!room) {
    log.error(PRE, `cannot find the target room, will do nothing`)
    if (contact) {
      contact.say('cannot find working room, please check id')
    }
    return
  }
  log.info(PRE, `data ready, start listening to room ${room}`)
  roomWorker = new RoomWorker(bot, room, contact)

  setImmediate(() => {
    roomWorker.subscribeTable('388014235', contact)
  })
}).on('ready', async () => {
  // 
}).on('error', (error: Error) => {
  if (/getContact\(\d+@openim\) is not supported for IM contact/.test(error.message)) {
    // ignore openIm Contact Error
    return
  }
  log.error(PRE, `error: ${error.stack}}`)
})

bot.start()

process.on('uncaughtException', (error: Error) => {
  log.error(PRE, `uncaughtException: ${error.stack}}`)
})

process.on('unhandledRejection', (reason: Error) => {
  log.error(PRE, `unhandledRejection: ${reason.stack}}`)
})