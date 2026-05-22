# BGA-arknova-wechat-notifier

> English: [README.en.md](./README.en.md)

在 [Board Game Arena](https://boardgamearena.com/) 上玩 **Ark Nova** 时，轮到谁就在微信群里 @ 谁。

## 工作原理

1. 用 [Wechaty](https://github.com/wechaty/wechaty) + `@juzi/wechaty-puppet-service` 登录一个微信号当 bot。
2. 在群里或私聊里发 `Ob <tableId>`，bot 会通过 HTTP 轮询对应的 BGA 桌面，解析游戏状态。
3. 轮次切换时，把当前行动玩家的 BGA 用户名映射到微信 ID，在群里发一条带 @ 的消息。

## 使用

在群里，或者在私聊里（私聊只听管理员 `ALARM_CONTACT_ID` 的指令）：

| 指令 | 作用 |
|---|---|
| `Ob <tableId>` / `ob <tableId>` | 开始观察某张桌子 |
| `停止 <tableId>` / `stop <tableId>` | 停止观察 |

`<tableId>` 就是 BGA 桌面 URL 末尾那串数字，比如 `https://boardgamearena.com/table?table=123456789` → `123456789`。

## 环境变量

必填：

| 变量 | 说明 |
|---|---|
| `WORK_TOKEN` | `@juzi/wechaty-puppet-service` 的 token |

可选：

| 变量 | 说明 |
|---|---|
| `ALARM_CONTACT_ID` | 报警/管理员的微信 contact ID。出错时通知 ta，私聊也只听 ta 的指令 |
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
  arknova-notifier
```

镜像基于 `node:20-alpine`，会在容器内执行 `npm install && npm run dist`，启动 `node ./dist/index.js`。

## 代码结构

- `src/index.ts` — 启动 Wechaty bot，处理扫码登录，创建唯一的 `RoomWorker`。
- `src/service/roomWorker.ts` — 解析微信消息中的指令，按桌子启停 `TableObserver`，负责把 BGA 玩家名解析成微信 contact 并 @ 出去。
- `src/service/tableObserver.ts` — 一张桌子一个实例，HTTP 轮询 BGA 接口（60s 一次）。事件：`ready` / `newPlayerMove` / `end` / `error`。
- `src/config.ts` — 加载并校验环境变量，导出 `config` 和 `playerMap`。
- `src/helper/` — logger 和工具函数。

## License

ISC
