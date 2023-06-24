import { Contact } from "@juzi/wechaty"
import EventEmitter from "events"
import { ElementHandle, Page } from "puppeteer"
import { Logger } from "src/helpers/logger"

export class TableObserver extends EventEmitter {

  private readonly logger = new Logger(TableObserver.name)

  pageReady = false
  mainTitleEle?: ElementHandle
  currentState?: string
  currentPlayers?: string[]

  constructor (private readonly tableId: string, private readonly chromeTab: Page, private readonly playerMap: PlayerMap = {}) {
    super()
  }

  async init() {

    this.chromeTab.once('load', () => {
      this.pageReady = true
      
      this.chromeTab.$('#pagemaintitletext').then(async (ele: (ElementHandle | null)) => {
        if (!ele) {
          throw new Error('fail to get main title')
        }
        this.mainTitleEle = ele
        await this.getCurrentState()

        this.emit('ready')
      })

    })

    const client = await this.chromeTab.target().createCDPSession()
    await client.send('Network.enable')
    
    client.on('Network.webSocketFrameReceived', (params) => {
      const data = params.response?.payloadData
      if (data && data.length > 10) {
        void this.handleBGAWsMessage(data)
      }
    })

    this.chromeTab.goto(`https://en.boardgamearena.com/6/arknova?table=${this.tableId}`)
  }

  async handleBGAWsMessage(data: string) {
    let dataObj:any
    try {
      const offSet = data.indexOf('[')
      const _dataStr = data.slice(offSet)
      dataObj = JSON.parse(_dataStr)
    } catch (e) {
      this.logger.error(`failed to pase message: ${data}`)
      return
    }
    await this.getCurrentState()
  }

  async getCurrentState() {
    const state = await this.mainTitleEle.evaluate(el => el.textContent)
    const playerSpans = await this.mainTitleEle.$$('span')
    const playerNames = await Promise.all(playerSpans.map(span => span.evaluate(el => el.textContent)))
    playerSpans.map(span => span.dispose())
    this.currentPlayers = playerNames
    this.currentState = state
    console.log('currentState', state)
    console.log('currentPlayers', playerNames)
  }
}

export interface PlayerMap {
  [gameName: string]: Contact
}