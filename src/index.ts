import { Contact, WechatyBuilder, log } from '@juzi/wechaty'
import { ScanStatus } from '@juzi/wechaty-puppet/types'
import QrcodeTerminal from 'qrcode-terminal'
import PuppetPadplus from '@juzi/wechaty-puppet-padplus'

import { config } from './config'
import { RoomWorker } from './service/roomWorker'

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

  const contact = await bot.Contact.find({id: config.alarmReceiver})

  log.info(PRE, `data ready, start listening to contact ${contact}`)
  if (!roomWorker) {
    roomWorker = new RoomWorker(bot, contact)

    // TODO: remove test code
    setImmediate(() => {
      roomWorker.subscribeTable('389308154', contact)
    })
  }

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