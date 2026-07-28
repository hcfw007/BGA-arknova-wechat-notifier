# BGA-arknova-wechat-notifier

[![CI](https://github.com/hcfw007/BGA-arknova-wechat-notifier/actions/workflows/publish.yml/badge.svg)](https://github.com/hcfw007/BGA-arknova-wechat-notifier/actions/workflows/publish.yml)

> English: [README.en.md](./README.en.md)

在 [Board Game Arena](https://boardgamearena.com/) 上玩 **Ark Nova** 时，轮到谁就在微信群里 @ 谁。

## 工作原理

1. 用 [Wechaty](https://github.com/wechaty/wechaty) + `@juzi/wechaty-puppet-service` 登录一个微信号当 bot。
2. 发 `ob <tableId>` 观察指定桌，或发 `订阅 <玩家>` 盯住某个 BGA 玩家 —— 后者会自动把他所有进行中的 Ark Nova 桌都 OB 上，并每 5 分钟发现新开的桌。
3. bot 通过 HTTP 轮询 BGA 接口解析游戏状态，轮次切换时把当前行动玩家的 BGA 用户名映射到微信 ID，在群里发一条带 @ 的消息。

全程使用 BGA 的匿名会话，**不需要 BGA 账号，也不需要浏览器**。

## 使用

**群里必须 @ 机器人**才会响应；私聊只听管理员 `ALARM_CONTACT_ID` 的指令。

### 观察单张桌子

| 指令 | 作用 |
|---|---|
| `ob <tableId>` | 开始观察某张桌子 |
| `停止 <tableId>` / `stop <tableId>` | 停止观察 |

`<tableId>` 就是 BGA 桌面 URL 末尾那串数字，比如 `https://boardgamearena.com/table?table=123456789` → `123456789`。

### 订阅玩家

| 指令 | 作用 |
|---|---|
| `订阅 <用户名\|id>` / `subscribe <用户名\|id>` | 订阅玩家，他当前所有进行中的 Ark Nova 桌自动 OB，之后每 5 分钟检查新桌 |
| `退订 <用户名\|id>` / `unsubscribe <用户名\|id>` | 退订。**已经在 OB 的桌不受影响**，要停用 `停止 <tableId>` |

`<用户名>` 是 BGA 上的用户名，**区分大小写且必须完全一致**（BGA 的搜索是前缀匹配，`Theim` 会连 `theimada` 一起返回，所以只认完全相等；万一重名会把候选列出来而不订阅任何人）。也可以直接用数字 id —— 就是 BGA 玩家主页 URL 里那串数字，比如 `https://boardgamearena.com/player?id=94073546` → `94073546`。

```
我:  @bot 订阅 Theim
bot: 收到订阅 Theim，请稍等...
bot: 已订阅 Theim(94073546)，当前有 2 张进行中的桌，已自动Ob：
       888411961（进度29%）
       889222765（进度76%）
     之后每5分钟检查一次新桌

bot: [订阅 Theim] 发现新桌 890123456，已自动Ob      ← 定时扫到新桌
```

## 环境变量

必填：

| 变量 | 说明 |
|---|---|
| `WORK_TOKEN` | `@juzi/wechaty-puppet-service` 的 token |

可选：

| 变量 | 说明 |
|---|---|
| `ALARM_CONTACT_ID` | 报警/管理员的微信 contact ID。出错时通知 ta，私聊也只听 ta 的指令 |
| `OB_STATE_FILE` | 状态持久化文件路径，默认 `./data/ob-state.json`。正在 OB 的桌号、订阅的玩家及各自的接收方会即时写入该文件，进程重启后自动恢复并汇报 |
| `PLAYER_<n>_BGA_NAME` | 第 n 个玩家在 BGA 上的用户名 |
| `PLAYER_<n>_WECHAT_ID` | 对应的微信 ID（用于 @）。`<n>` 从 1 开始，按需添加 |

玩家映射示例：

```bash
PLAYER_1_BGA_NAME=Alice
PLAYER_1_WECHAT_ID=wxid_xxxxxxxxxxxx
PLAYER_2_BGA_NAME=Bob
PLAYER_2_WECHAT_ID=wxid_yyyyyyyyyyyy
```

## 本地运行

```bash
npm install
npm run dist     # 编译 TS → dist/
npm start        # 启动；首次登录时终端会打印二维码
```

## Docker

```bash
docker build -t arknova-notifier .
docker run --rm -it \
  -e WORK_TOKEN=... \
  -e ALARM_CONTACT_ID=... \
  -e PLAYER_1_BGA_NAME=... \
  -e PLAYER_1_WECHAT_ID=... \
  -v /path/on/host:/app/data \
  arknova-notifier
```

**务必挂载 `/app/data` 卷**，否则每次换镜像重建容器都会清空 `ob-state.json`，正在 OB 的桌和订阅的玩家全部丢失。挂上之后重启会自动恢复并汇报。

镜像基于 `node:20-alpine`，会在容器内执行 `npm install && npm run dist`，启动 `node ./dist/index.js`。

## 开发

```bash
npm test         # 单元测试（Node 内置 test runner + ts-node，无额外依赖）
```

测试只覆盖纯函数（命令解析、BGA 响应体解析、状态文件迁移）；涉及 Wechaty 和网络的部分没有自动化测试。

## 代码结构

- `src/index.ts` — 启动 Wechaty bot，处理扫码登录，创建唯一的 `RoomWorker`。
- `src/service/roomWorker.ts` — 解析微信消息中的指令，管理「桌子」和「玩家」两份订阅关系，按桌启停 `TableObserver`，定时扫描订阅玩家的新桌，并把 BGA 玩家名解析成微信 contact 后 @ 出去。
- `src/service/tableObserver.ts` — 一张桌子一个实例，HTTP 轮询 BGA 接口（60s 一次）。事件：`ready` / `newPlayerMove` / `end` / `error`。
- `src/service/playerClient.ts` — 玩家维度的 BGA 查询：用户名换 id、列出某玩家进行中的 Ark Nova 桌。
- `src/config.ts` — 加载并校验环境变量，导出 `config` 和 `playerMap`。
- `src/helper/` — 命令解析、BGA 会话握手与响应体解析、状态文件读写、logger 等。

## License

ISC
