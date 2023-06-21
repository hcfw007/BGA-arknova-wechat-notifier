import { WechatyBuilder, log } from '@juzi/wechaty'
import { ScanStatus } from '@juzi/wechaty-puppet/types'
import QrcodeTerminal from 'qrcode-terminal'
import PuppetPadplus from '@juzi/wechaty-puppet-padplus'

import {
  token,
  endpoint,
} from './config'
import { ContactInterface, MessageInterface } from '@juzi/wechaty/impls'

const PRE = 'Index'

const puppet = new PuppetPadplus({
  token,
  endpoint,
  tls: {
    disable: true
  }
})
const bot = WechatyBuilder.build({
  puppet: puppet,
  name: 'arknova-ob',
})

bot.on('scan', (qrcode: string, status: ScanStatus) => {
  if (status === ScanStatus.Waiting) {
    QrcodeTerminal.generate(qrcode, {
      small: true
    })
  }
}).on('login', (contact: ContactInterface) => {
  log.info(PRE, `user login, info: ${JSON.stringify(contact)}`)
}).on('ready', () => {
  log.info(PRE, `data ready, start listening`)
}).on('message', (message: MessageInterface) => {
  log.info(PRE, `message received, payload: ${JSON.stringify(message.payload)}`)
}).on('error', (error: Error) => {
  log.error(PRE, `error: ${error.stack}}`)
})

bot.start()
