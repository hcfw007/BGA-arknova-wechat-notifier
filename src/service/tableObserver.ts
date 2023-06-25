import { Contact } from "@juzi/wechaty"
import EventEmitter from "events"
import { ElementHandle, Page } from "puppeteer"
import { Logger } from "../helper/logger"

export class TableObserver extends EventEmitter {

  private readonly logger = new Logger(TableObserver.name)

  pageReady = false
  mainTitleEle?: ElementHandle
  currentState?: string
  currentPlayers?: string[]
  reloadCheckTimer?: NodeJS.Timer

  constructor (private readonly tableId: string, private readonly chromeTab: Page, private readonly playerMap: PlayerMap = {}) {
    super()
  }

  async init() {

    this.chromeTab.once('load', () => {
      this.pageReady = true
      
      this.chromeTab.$('#pagemaintitletext').then(async (ele: (ElementHandle | null)) => {
        if (!ele) {
          const gameEndSpan = await this.chromeTab.$('#status_detailled')
          if (gameEndSpan && (await gameEndSpan.evaluate(el => el.textContent)).includes('has ended')) {
            gameEndSpan.dispose()
            this.emit('end')
            return
          }
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

    await this.chromeTab.goto(`https://en.boardgamearena.com/6/arknova?table=${this.tableId}`)
    this.startCheckReload()
  }

  close() {
    this.mainTitleEle?.dispose()
    this.chromeTab.close()
    this.stopCheckReload()
    this.pageReady = false
    this.mainTitleEle = undefined
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
    const state = (await this.mainTitleEle.evaluate(el => el.textContent)).trim()
    const playerSpans = await this.mainTitleEle.$$('span')
    const playerNames = await Promise.all(playerSpans.map(span => span.evaluate(el => el.textContent)))
    playerSpans.map(span => span.dispose())

    const previousPlayers = this.currentPlayers
    const previousState = this.currentState

    if (playerNames.length === 0 && state.includes('All players')) {
      this.currentPlayers = ['all']
    } else {
      this.currentPlayers = playerNames
    }
    this.currentState = state

    this.logger.info(`state update: ${this.currentState}, players: ${JSON.stringify(this.currentPlayers)}`)

    if (previousPlayers) {
      const previousPlayersSet = new Set(previousPlayers)
      const newPlayers = this.currentPlayers.filter(player => !previousPlayersSet.has(player))
      if (newPlayers.length > 0 && this.currentState.includes('must')) {
        this.emit('newPlayerMove', newPlayers)
      }
    }

    if (this.currentState.includes('game ended')) {
      this.emit('end')
    }
  }

  startCheckReload() {
    if (!this.reloadCheckTimer) {
      this.reloadCheckTimer = setInterval(this.checkReload.bind(this), 10 * 1000)
    }
  }

  stopCheckReload() {
    if (this.reloadCheckTimer) {
      clearInterval(this.reloadCheckTimer)
      this.reloadCheckTimer = undefined
    }
  }

  async checkReload() {
    const reloadPopup = await this.chromeTab.$('bga-popup-modal__content')
    if (reloadPopup) {
      await this.chromeTab.reload()
    }
  }
  
  getContactFromPlayer(player: string) {
    if (player === 'all') {
      return 'all'
    }
    if (this.playerMap) {
      return this.playerMap[player]
    }
  }
}

export interface PlayerMap {
  [gameName: string]: Contact
}

export interface ContactPlayer {
  contact: Contact,
  gameName: string,
}