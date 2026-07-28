import { Contact, Message, Room, Wechaty, types } from "@juzi/wechaty"
import axios from "axios"
import { BgaPlayerRef, PlayerTable } from "../helper/bgaPayload"
import { looksLikePlayerId, parseCommand } from "../helper/command"
import { Logger } from "../helper/logger"
import { ObStateStore, PersistedPlayer, PersistedSubscriber, PersistedTable } from "../helper/obStateStore"
import { PlayerClient, UnknownPlayerError } from "./playerClient"
import { TableObserver } from "./tableObserver"
import { config } from "../config"

const BGA_SESSION_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours
// 订阅玩家后多久扫一次他的新牌桌。BGA 单次请求可能要几十秒，而组桌到轮到你通常有几分钟，
// 5 分钟的发现延迟感知不到，再快只是徒增请求
const PLAYER_SCAN_INTERVAL_MS = 5 * 60 * 1000

export class RoomWorker {

  private readonly logger = new Logger(RoomWorker.name)

  tableObserveList: TableObserve[] = []
  playerSubscribeList: PlayerSubscribe[] = []
  private bgaCookie?: string
  private bgaCookieObtainedAt?: number

  private readonly stateStore = new ObStateStore(config.stateFile)
  private stateRestored = false
  private readonly playerClient = new PlayerClient()
  private playerScanTimer?: NodeJS.Timeout
  private scanningPlayers = false

  constructor(private readonly bot: Wechaty, private readonly contact?: Contact) {
    void this.prefetchBgaSession()
    this.bot.on('message', (message: Message) => {
      if (message.type() !== types.Message.Text) {
        this.logger.verbose('non-text message will be ignored')
        return
      }
      if (message.room()) {
        void this.handleRoomMessage(message)
        return
      }
      if (message.talker() === this.contact) {
        void this.handleAdminMessage(message)
        return
      }
      this.logger.verbose('message from others will be ignored')
    })
  }

  private async prefetchBgaSession() {
    try {
      this.logger.info('prefetching BGA session')
      const res = await axios.get('https://en.boardgamearena.com/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        maxRedirects: 5,
        timeout: 30_000,
      })
      const cookies = ((res.headers['set-cookie'] ?? []) as string[]).map(c => c.split(';')[0]).join('; ')
      if (cookies) {
        this.bgaCookie = cookies
        this.bgaCookieObtainedAt = Date.now()
        this.logger.info('BGA session prefetched')
      }
    } catch (e) {
      this.logger.error(`prefetchBgaSession error: ${e}`)
    }
  }

  private isCookieValid(): boolean {
    return !!this.bgaCookie && !!this.bgaCookieObtainedAt &&
      Date.now() - this.bgaCookieObtainedAt < BGA_SESSION_TTL_MS
  }

  private isRoom(target: Contact | Room): target is Room {
    return typeof (target as any).topic === 'function'
  }

  private persistSubscribers(subscribers: (Contact | Room)[]): PersistedSubscriber[] {
    return subscribers.map(sub => ({
      type: this.isRoom(sub) ? 'room' : 'contact',
      id: sub.id,
    }))
  }

  private persistState() {
    const tables: PersistedTable[] = this.tableObserveList.map(ob => ({
      tableId: ob.tableId,
      subscribers: this.persistSubscribers(ob.subscribers),
    }))
    const players: PersistedPlayer[] = this.playerSubscribeList.map(item => ({
      playerId: item.playerId,
      playerName: item.playerName,
      subscribers: this.persistSubscribers(item.subscribers),
    }))
    this.stateStore.save({ tables, players })
  }

  private async resolveSubscriber(sub: PersistedSubscriber): Promise<Contact | Room | undefined> {
    return sub.type === 'room'
      ? this.bot.Room.find({ id: sub.id })
      : this.bot.Contact.find({ id: sub.id })
  }

  async restoreState() {
    if (this.stateRestored) {
      return
    }
    this.stateRestored = true

    const { tables, players } = this.stateStore.load()
    if (tables.length === 0 && players.length === 0) {
      return
    }

    this.logger.info(`restoring ${tables.length} table(s) and ${players.length} player subscription(s)`)

    for (const table of tables) {
      try {
        for (const sub of table.subscribers) {
          const target = await this.resolveSubscriber(sub)
          if (!target) {
            this.logger.warn(`cannot resolve ${sub.type} ${sub.id} for table ${table.tableId}, skipping`)
            continue
          }
          await this.subscribeTable(table.tableId, target, false)
        }
      } catch (e) {
        this.logger.error(`restore table ${table.tableId} failed: ${e}`)
        void this.sendAlarm(`恢复Ob游戏桌${table.tableId}失败：${e}`)
      }
    }

    for (const player of players) {
      try {
        for (const sub of player.subscribers) {
          const target = await this.resolveSubscriber(sub)
          if (!target) {
            this.logger.warn(`cannot resolve ${sub.type} ${sub.id} for player ${player.playerId}, skipping`)
            continue
          }
          await this.restorePlayerSubscribe(player, target)
        }
      } catch (e) {
        this.logger.error(`restore player ${player.playerId} failed: ${e}`)
        void this.sendAlarm(`恢复订阅玩家${player.playerName}失败：${e}`)
      }
    }

    this.persistState()
    this.logger.info('ob state restore complete')
  }

  /** 重启恢复：订阅关系直接从文件认下来，不必重新走名字解析 */
  private async restorePlayerSubscribe(player: PersistedPlayer, target: Contact | Room) {
    await target.sync()
    const existing = this.playerSubscribeList.find(item => item.playerId === player.playerId)
    if (existing) {
      if (!existing.subscribers.some(item => item.id === target.id)) {
        existing.subscribers.push(target)
      }
    } else {
      this.playerSubscribeList.push({
        playerId: player.playerId,
        playerName: player.playerName,
        subscribers: [target],
        knownTables: [],
      })
    }
    this.startPlayerScan()
    await this.reportPlayerTables({ id: player.playerId, name: player.playerName }, target, true)
  }

  async sendAlarm(alarmText: string): Promise<void> {
    if (!this.contact) {
      return
    }
    try {
      await this.contact.say(alarmText)
    } catch (e) {
      this.logger.error(`sendAlarm failed: ${e}`)
    }
  }

  /** 统一发送出口：say 失败只记日志，不冒泡成 unhandledRejection */
  private async safeSay(target: Contact | Room, text: string, mentionList?: (Contact | '@all')[]) {
    try {
      // 必须区分「不传第二个参数」和「传 undefined」：Room.say 把变长参数当 mentionList，
      // say(text, undefined) 会被解析成 mentionList=[undefined] 而抛
      // "mentionList must be contact when not using TemplateStringsArray function call."
      if (mentionList?.length) {
        await target.say(text, { mentionList })
      } else {
        await target.say(text)
      }
    } catch (e) {
      this.logger.error(`messageSendError, ${(e as Error).stack}`)
    }
  }

  private async handleCommand(text: string, reportTarget: Contact | Room) {
    const command = parseCommand(text)
    if (!command) {
      return
    }
    switch (command.action) {
      case 'stop':
        return this.unSubscribeTable(command.target, reportTarget)
      case 'ob':
        return this.subscribeTable(command.target, reportTarget)
      case 'unsubscribe':
        return this.unSubscribePlayer(command.target, reportTarget)
      case 'subscribe':
        return this.subscribePlayer(command.target, reportTarget)
    }
  }

  async handleAdminMessage(message: Message) {
    return this.handleCommand(message.text(), message.talker())
  }

  /**
   * 群里必须 @机器人 才认命令——这是防误触发的唯一手段，因为正则不锚定开头。
   * mentionSelf 依赖 puppet 给的 mentionIdList，拿不到时退回文本里找 @机器人名。
   */
  private isMentioningSelf(message: Message): boolean {
    try {
      if (message.mentionSelf()) {
        return true
      }
    } catch (e) {
      this.logger.warn(`mentionSelf check failed, falling back to text: ${e}`)
    }
    const selfName = this.bot.currentUser?.name()
    return !!selfName && message.text().includes(`@${selfName}`)
  }

  async handleRoomMessage(message: Message) {
    if (!this.isMentioningSelf(message)) {
      return
    }
    return this.handleCommand(message.text(), message.room())
  }

  /** 把命令里的参数解析成一个确定的 BGA 玩家；歧义或查不到时回消息并返回 undefined */
  private async resolvePlayer(target: string, reportTarget: Contact | Room): Promise<BgaPlayerRef | undefined> {
    if (looksLikePlayerId(target)) {
      const { playerName } = await this.playerClient.listArkNovaTables(target)
      return { id: target, name: playerName ?? target }
    }

    const lookup = await this.playerClient.findPlayerByName(target)
    if (lookup.kind === 'found') {
      return lookup.player
    }
    if (lookup.kind === 'ambiguous') {
      const lines = ['同名玩家有多个，没有订阅。请改用数字id：']
      lookup.matches.forEach(m => lines.push(`  ${m.name}  id=${m.id}`))
      await this.safeSay(reportTarget, lines.join('\n'))
      return undefined
    }
    await this.safeSay(reportTarget, `找不到玩家「${target}」，注意区分大小写，也可以改用BGA主页链接里的数字id，比如 订阅 94073546`)
  }

  async subscribePlayer(target: string, reportTarget: Contact | Room, announce = true) {
    await reportTarget.sync()
    if (announce) {
      await this.safeSay(reportTarget, `收到订阅 ${target}，请稍等...`)
    }

    let player: BgaPlayerRef | undefined
    try {
      player = await this.resolvePlayer(target, reportTarget)
    } catch (e) {
      if (e instanceof UnknownPlayerError) {
        await this.safeSay(reportTarget, `BGA上没有id为 ${target} 的玩家`)
        return
      }
      this.logger.error(`subscribePlayer ${target} failed: ${e}`)
      this.playerClient.dropSession()
      await this.safeSay(reportTarget, `订阅 ${target} 失败：查询BGA出错`)
      return
    }
    if (!player) {
      return
    }

    const existing = this.playerSubscribeList.find(item => item.playerId === player.id)
    if (existing) {
      if (existing.subscribers.some(item => item.id === reportTarget.id)) {
        if (announce) {
          await this.safeSay(reportTarget, `已经订阅 ${existing.playerName} 了`)
        }
        return
      }
      existing.subscribers.push(reportTarget)
    } else {
      this.playerSubscribeList.push({
        playerId: player.id,
        playerName: player.name,
        subscribers: [reportTarget],
        knownTables: [],
      })
    }
    this.persistState()
    this.startPlayerScan()

    await this.reportPlayerTables(player, reportTarget, false)
  }

  async unSubscribePlayer(target: string, reportTarget: Contact | Room) {
    const wanted = target.toLowerCase()
    const subscribe = this.playerSubscribeList.find(item =>
      item.playerId === target || item.playerName.toLowerCase() === wanted)

    if (!subscribe || !subscribe.subscribers.some(item => item.id === reportTarget.id)) {
      await this.safeSay(reportTarget, `没有订阅 ${target}`)
      return
    }

    subscribe.subscribers = subscribe.subscribers.filter(item => item.id !== reportTarget.id)
    if (subscribe.subscribers.length === 0) {
      this.playerSubscribeList = this.playerSubscribeList.filter(item => item !== subscribe)
      this.stopPlayerScanIfIdle()
    }
    this.persistState()
    // 按约定不动已经在 ob 的桌
    await this.safeSay(reportTarget, `已退订 ${subscribe.playerName}，已经在Ob的桌不受影响，需要停止请用「停止 <桌号>」`)
  }

  /** 拉一次该玩家的桌，没 ob 的自动 ob 上，并把结果汇报给指定订阅者 */
  private async reportPlayerTables(player: BgaPlayerRef, reportTarget: Contact | Room, restored: boolean) {
    let tables: PlayerTable[]
    try {
      ({ tables } = await this.playerClient.listArkNovaTables(player.id))
    } catch (e) {
      this.logger.error(`listArkNovaTables ${player.id} failed: ${e}`)
      this.playerClient.dropSession()
      await this.safeSay(reportTarget, `已订阅 ${player.name}，但查询当前牌桌失败，稍后会自动重试`)
      return
    }

    const subscribe = this.playerSubscribeList.find(item => item.playerId === player.id)
    if (subscribe) {
      subscribe.knownTables = tables.map(t => t.tableId)
    }

    const prefix = restored ? '已恢复订阅' : '已订阅'
    if (tables.length === 0) {
      await this.safeSay(reportTarget, `${prefix} ${player.name}(${player.id})，当前没有进行中的Ark Nova桌，有新桌会自动Ob`)
      return
    }

    const lines = [`${prefix} ${player.name}(${player.id})，当前有 ${tables.length} 张进行中的桌，已自动Ob：`]
    tables.forEach(t => lines.push(`  ${t.tableId}（进度${t.progression}%）`))
    lines.push(`之后每${PLAYER_SCAN_INTERVAL_MS / 60000}分钟检查一次新桌`)
    await this.safeSay(reportTarget, lines.join('\n'))

    for (const table of tables) {
      await this.subscribeTable(table.tableId, reportTarget, false)
    }
  }

  private startPlayerScan() {
    if (!this.playerScanTimer && this.playerSubscribeList.length > 0) {
      this.playerScanTimer = setInterval(() => void this.scanPlayers(), PLAYER_SCAN_INTERVAL_MS)
    }
  }

  private stopPlayerScanIfIdle() {
    if (this.playerScanTimer && this.playerSubscribeList.length === 0) {
      clearInterval(this.playerScanTimer)
      this.playerScanTimer = undefined
    }
  }

  /** 定时扫描所有订阅玩家，把新开的桌自动 ob 上 */
  private async scanPlayers() {
    // BGA 慢起来一轮可能超过扫描间隔，setInterval 不会等上一轮
    if (this.scanningPlayers) {
      this.logger.warn('player scan skipped: previous round still running')
      return
    }
    this.scanningPlayers = true
    try {
      for (const subscribe of [...this.playerSubscribeList]) {
        try {
          const { tables } = await this.playerClient.listArkNovaTables(subscribe.playerId)
          const known = new Set(subscribe.knownTables)
          subscribe.knownTables = tables.map(t => t.tableId)

          for (const table of tables.filter(t => !known.has(t.tableId))) {
            this.logger.info(`player ${subscribe.playerName} has a new table ${table.tableId}`)
            for (const target of [...subscribe.subscribers]) {
              await this.safeSay(target, `[订阅 ${subscribe.playerName}] 发现新桌 ${table.tableId}，已自动Ob`)
              await this.subscribeTable(table.tableId, target, false)
            }
          }
        } catch (e) {
          this.logger.error(`scan player ${subscribe.playerId} failed: ${e}`)
          this.playerClient.dropSession()
        }
      }
    } finally {
      this.scanningPlayers = false
    }
  }

  async unSubscribeTable(tableId: string, reportTarget: Contact | Room) {
    const tableObserve = this.tableObserveList.find(ob => ob.tableId === tableId)
    if (!tableObserve) {
      await this.safeSay(reportTarget, `没有在Ob ${tableId}`)
      return
    }

    // 按 id 比对：重启恢复出来的 Room/Contact 和消息里带的不是同一个实例
    tableObserve.subscribers = tableObserve.subscribers.filter(item => item.id !== reportTarget.id)
    if (tableObserve.subscribers.length === 0) {
      tableObserve.observer.close()
      this.tableObserveList = this.tableObserveList.filter(item => item !== tableObserve)
    }
    this.persistState()
    await this.safeSay(reportTarget, `已停止Ob ${tableId}`)
  }

  async subscribeTable(tableId: string, reportTarget: Contact | Room, announce = true) {
    await reportTarget.sync()
    if (announce) {
      await this.safeSay(reportTarget, `收到Ob ${tableId}，请稍等...`)
    }
    this.logger.info(`will observe table ${tableId} and report to ${reportTarget}`)

    const tableObserve = this.tableObserveList.find(ob => ob.tableId === tableId)
    if (tableObserve) {
      const isNewSubscriber = !tableObserve.subscribers.some(item => item.id === reportTarget.id)
      if (isNewSubscriber) {
        tableObserve.subscribers.push(reportTarget)
        this.persistState()
      } else if (announce) {
        await this.safeSay(reportTarget, `已经在Ob ${tableId}了 `)
      }

      // 已经 ready 的桌子补发一次现状。老订阅者只在自己主动发命令时补发，
      // 否则重启恢复和自动扫描会让同一张桌被反复播报
      if (tableObserve.observer.ready && (isNewSubscriber || announce)) {
        this.reportCurrentState(tableObserve)
      }

      return
    }

    const playerMap = {}
    for (const bgaName in config.playerMap) {
      playerMap[bgaName] = await this.bot.Contact.find({id: config.playerMap[bgaName]})
    }

    const sharedCookie = this.isCookieValid() ? this.bgaCookie : undefined
    const ob = new TableObserver(tableId, playerMap, sharedCookie, (cookie) => {
      this.bgaCookie = cookie
      this.bgaCookieObtainedAt = Date.now()
    })
    const newTableObserve = {
      tableId,
      subscribers: [reportTarget],
      observer: ob,
      announceReady: announce,
    }

    this.tableObserveList.push(newTableObserve)
    this.persistState()

    this.bindEvents(newTableObserve)

    await ob.init()
  }

  bindEvents(tableObserve: TableObserve) {
    tableObserve.observer.on('ready', () => {
      this.logger.info(`table ${tableObserve.tableId} ready`)
      if (tableObserve.announceReady) {
        tableObserve.subscribers.forEach(target => {
          void this.safeSay(target, `成功OB游戏桌${tableObserve.tableId}`)
        })
      }
      this.reportCurrentState(tableObserve)
    }).on('end', (result: { name: string; score: string; rank: number }[]) => {
      tableObserve.observer.close()
      const lines: string[] = [`游戏桌${tableObserve.tableId}已结束`]
      if (result.length > 0) {
        lines.push('最终排名：')
        result.forEach(p => lines.push(`  ${p.rank}. ${p.name}  ${p.score}分`))
      }
      lines.push('停止OB')
      tableObserve.subscribers.forEach(target => {
        void this.safeSay(target, lines.join('\n'))
      })
      this.tableObserveList = this.tableObserveList.filter(item => item !== tableObserve)
      this.persistState()
    }).on('newPlayerMove', () => {
      this.reportCurrentState(tableObserve)
    }).on('error', () => {
      tableObserve.observer.close()
      this.bgaCookie = undefined // invalidate session on error
      void this.sendAlarm(`游戏桌${tableObserve.tableId}观测失败，已停止OB`)
      tableObserve.subscribers.forEach(target => {
        void this.safeSay(target, `游戏桌${tableObserve.tableId}发生错误，停止OB`)
      })
      this.tableObserveList = this.tableObserveList.filter(item => item !== tableObserve)
      this.persistState()
    })
  }

  reportCurrentState(tableObserve: TableObserve) {
    const players = tableObserve.observer.currentPlayers
    const waiting = tableObserve.observer.waitingForJoin
    const contacts: (Contact | '@all')[] = []
    let str = `[桌号${tableObserve.tableId}] `

    if (waiting) {
      const names = []
      for (const player of players || []) {
        let name = player
        const contact = tableObserve.observer.getContactFromPlayer(player)
        if (contact) {
          name += `(${contact === 'all' ? '所有人' : contact.name()})`
          contacts.push(contact === 'all' ? '@all' : contact)
        }
        names.push(name)
      }
      str += `${names.join('、')}尚未加入。`
    } else {
      str += '现在轮到'
      for (const player of players || []) {
        str += `${player}`
        const contact = tableObserve.observer.getContactFromPlayer(player)
        if (contact) {
          str += `(${contact === 'all' ? '所有人' : contact.name()})`
          contacts.push(contact === 'all' ? '@all' : contact)
        }
      }
      str += `。`
    }
    tableObserve.subscribers.forEach(target => {
      this.logger.info(`saying ${str} to ${target}, mentioning ${contacts}`)
      void this.safeSay(target, str, contacts)
    })
  }
}

export interface TableObserve {
  tableId: string,
  subscribers: (Contact | Room)[],
  observer: TableObserver,
  /** 自动 ob 上来的桌不再单独播报「成功OB」，汇总消息里已经列过桌号了 */
  announceReady: boolean,
}

export interface PlayerSubscribe {
  playerId: string
  playerName: string
  subscribers: (Contact | Room)[]
  /** 上一轮扫描时看到的桌，用来判断哪些是新开的 */
  knownTables: string[]
}
