import EventEmitter from "events"
import { ElementHandle, Page } from "puppeteer"
import { Logger } from "src/helpers/logger"

export class TableObserver extends EventEmitter {

  private readonly logger = new Logger(TableObserver.name)

  pageReady = false

  currentState?: string

  constructor (private readonly tableId: string, private readonly chromeTab: Page) {
    super()

  }

  async init() {

    this.chromeTab.once('load', () => {
      this.pageReady = true
      
      this.chromeTab.$('#pagemaintitletext').then((ele: (ElementHandle | null)) => {
        if (!ele) {
          throw new Error('fail to get main title')
        }
        ele.evaluate(el => el.textContent).then((content: string) => {
          this.currentState = content
          this.emit('ready')
        })
      })

    })

    const client = await this.chromeTab.target().createCDPSession()
    await client.send('Network.enable')
    
    client.on('Network.webSocketFrameReceived', (params) => {
      const data = params.response?.payloadData
      if (data && data.length > 10) {
        this.handleBGAWsMessage(data)
      }
    })

    this.chromeTab.goto(`https://en.boardgamearena.com/6/arknova?table=${this.tableId}`)
  }

  handleBGAWsMessage(data: string) {
    let dataObj:any
    try {
      const offSet = data.indexOf('[')
      const _dataStr = data.slice(offSet)
      dataObj = JSON.parse(_dataStr)
    } catch (e) {
      this.logger.error(`failed to pase message: ${data}`)
      return
    }

    console.log(data)
  }
}