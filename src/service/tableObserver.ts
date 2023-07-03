import { Contact } from "@juzi/wechaty"
import EventEmitter from "events"
import { Page } from "puppeteer"
import { Logger } from "../helper/logger"
import { stateRegulator } from "../helper/util"

export class TableObserver extends EventEmitter {

  private readonly logger = new Logger(TableObserver.name)

  pageReady = false
  currentState?: string
  currentPlayers?: string[]
  reloadCheckTimer?: NodeJS.Timer
  
  playerIdMap: {
    [name: string]: {
      busy?: boolean
      id: string,
    }
  } = {}

  constructor (private readonly tableId: string, private readonly chromeTab: Page, private readonly playerMap: PlayerMap = {}) {
    super()
  }

  async init() {

    const client = await this.chromeTab.target().createCDPSession()
    await client.send('Network.enable')
    
    client.on('Network.webSocketFrameReceived', (params) => {
      const data = params.response?.payloadData
      if (data && data.length > 10) {
        void this.handleBGAWsMessage(data)
      }
    })

    await this.chromeTab.goto(`https://en.boardgamearena.com/table?table=${this.tableId}`)

    const tableStatusEle = await this.chromeTab.$('#status_detailled')
    const tableStatus = await tableStatusEle.evaluate(el => el.textContent)
    if (tableStatus === 'Game has ended') {
      this.emit('end')
      return
    }
    const gotoButtonEle = await this.chromeTab.$('#access_game_normal')
    await gotoButtonEle.click()

    this.chromeTab.once('load', async () => {
      const mainTitleEle = await this.chromeTab.$('#pagemaintitletext')
      if (!mainTitleEle) {
        this.logger.info('failed to find main title element')
        this.emit('end')
      }

      await this.initPlayerIdMap()
      await this.getCurrentState()
      this.pageReady = true
      this.emit('ready')
      this.startCheckReload()
    })
    
  }

  close() {
    this.chromeTab.close()
    this.stopCheckReload()
    this.pageReady = false
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
    if (!this.pageReady) {
      this.logger.info('trying to get state when page not ready, ignored')
    }
    const mainTitleEle = await this.chromeTab.$('#pagemaintitletext')
    if (!mainTitleEle) {
      this.logger.info('failed to find main title element')
      this.emit('end')
    }

    const state = stateRegulator(await mainTitleEle.evaluate(el => el.textContent))

    const busyPlayers = []
    for (const key in this.playerIdMap) {
      const activeDivEle = await this.chromeTab.$(`#avatar_active_wrap_${this.playerIdMap[key].id}`)
      const visibility = await activeDivEle.evaluate(el => el.checkVisibility())
      if (visibility) {
        busyPlayers.push(key)
      }
      this.playerIdMap[key].busy = visibility
    }

    if (!busyPlayers) {
      busyPlayers.length === 0
    }
    const previousPlayers = this.currentPlayers


    this.currentPlayers = busyPlayers
    this.currentState = state

    this.logger.info(`state update: ${this.currentState}, players: ${JSON.stringify(this.currentPlayers)}`)

    if (previousPlayers) {
      const previousPlayersSet = new Set(previousPlayers)
      const newPlayers = this.currentPlayers.filter(player => !previousPlayersSet.has(player))
      if (newPlayers.length > 0 && this.currentState.includes('must')) {
        this.logger.info(`new player event: ${newPlayers}`)

        this.emit('newPlayerMove', newPlayers)
      }
    }

    if (this.currentState.includes('End of game')) {
      this.emit('end')
    }
  }

  startCheckReload() {
    if (!this.reloadCheckTimer) {
      this.reloadCheckTimer = setInterval(this.checkReload.bind(this), 60 * 1000)
    }
  }

  stopCheckReload() {
    if (this.reloadCheckTimer) {
      clearInterval(this.reloadCheckTimer)
      this.reloadCheckTimer = undefined
    }
  }

  async checkReload() {
    const reloadPopup = await this.chromeTab.$('.bga-popup-modal__content')
    if (reloadPopup) {
      this.logger.info('check reload: page dead')
      await this.chromeTab.reload()
    } else {
      this.logger.info('check reload: page alive')
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

  async initPlayerIdMap() {
    const playerBoardEles = await this.chromeTab.$$('.player_board_inner')
    const promises = playerBoardEles.map(async ele => {
      const playerNameDivEle = await ele.$('.player-name')
      const playerNameAEle = await ele.$('.player-name>a')
      if (!playerNameAEle) {
        return // spectator? 
      }
      const playerId = (await playerNameDivEle.evaluate(el => el.id)).slice('player_name_'.length)
      const playerName = await playerNameAEle.evaluate(el => el.textContent)
      this.playerIdMap[playerName] = {
        id: playerId,
        busy: false
      }
    })
    await Promise.all(promises)
  }
}

export interface PlayerMap {
  [gameName: string]: Contact
}

export interface ContactPlayer {
  contact: Contact,
  gameName: string,
}