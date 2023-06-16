import { WechatyBuilder } from '@juzi/wechaty'
import { ScanStatus } from '@juzi/wechaty-puppet/types'
import QrcodeTerminal from 'qrcode-terminal'
import PuppetPadplus from '@juzi/wechaty-puppet-padplus'

import {
  token,
  endpoint,
} from './config'

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
})

bot.start()