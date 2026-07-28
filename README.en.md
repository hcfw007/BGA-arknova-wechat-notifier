# BGA-arknova-wechat-notifier

[![CI](https://github.com/hcfw007/BGA-arknova-wechat-notifier/actions/workflows/publish.yml/badge.svg)](https://github.com/hcfw007/BGA-arknova-wechat-notifier/actions/workflows/publish.yml)
[![Docker Image Version](https://img.shields.io/docker/v/hcfw007/bga-arknova-wechat-notifier?sort=semver&logo=docker)](https://hub.docker.com/r/hcfw007/bga-arknova-wechat-notifier)
[![Docker Pulls](https://img.shields.io/docker/pulls/hcfw007/bga-arknova-wechat-notifier)](https://hub.docker.com/r/hcfw007/bga-arknova-wechat-notifier)
[![License](https://img.shields.io/github/license/hcfw007/BGA-arknova-wechat-notifier)](./LICENSE)

> 中文版: [README.md](./README.md)

@you in a WeChat room when it's your turn in **Ark Nova** on [Board Game Arena](https://boardgamearena.com/).

## How it works

1. A WeChat bot logs in via [Wechaty](https://github.com/wechaty/wechaty) + `@juzi/wechaty-puppet-service`.
2. Send `ob <tableId>` to watch one table, or `subscribe <player>` to follow a BGA player — the latter auto-observes every Ark Nova table they are currently playing and picks up new ones every 5 minutes.
3. The bot HTTP-polls BGA to parse game state; when the active player changes it maps the BGA username to a WeChat ID and posts a message with an `@` mention in the room.

Everything runs on an anonymous BGA session — **no BGA account and no browser required**.

## Usage

**Room messages must @-mention the bot** to be recognised. Private-chat commands are only honored from the admin contact (`ALARM_CONTACT_ID`).

### Watch a single table

| Command | Effect |
|---|---|
| `ob <tableId>` | Start observing a table |
| `停止 <tableId>` / `stop <tableId>` | Stop observing |

`<tableId>` is the numeric ID at the end of the BGA table URL, e.g. `https://boardgamearena.com/table?table=123456789` → `123456789`.

### Subscribe to a player

| Command | Effect |
|---|---|
| `订阅 <name\|id>` / `subscribe <name\|id>` | Follow a player: every in-progress Ark Nova table of theirs is observed right away, and new ones are picked up every 5 minutes |
| `退订 <name\|id>` / `unsubscribe <name\|id>` | Stop following. **Tables already being observed keep running** — use `停止 <tableId>` to stop those |

`<name>` is the BGA username and must match **exactly, including case**. BGA's player search is a prefix search (`Theim` also returns `theimada`), so only an exact match counts; if a name somehow matches several players, the bot lists the candidates and subscribes to none of them. You can also pass the numeric id straight from the player's profile URL: `https://boardgamearena.com/player?id=94073546` → `94073546`.

```
me:  @bot subscribe Theim
bot: 收到订阅 Theim，请稍等...
bot: 已订阅 Theim(94073546)，当前有 2 张进行中的桌，已自动Ob：
       888411961（进度29%）
       889222765（进度76%）
     之后每5分钟检查一次新桌

bot: [订阅 Theim] 发现新桌 890123456，已自动Ob      ← found by the periodic scan
```

(The bot replies in Chinese.)

## Environment variables

Required:

| Variable | Description |
|---|---|
| `WORK_TOKEN` | Token for `@juzi/wechaty-puppet-service` |

Optional:

| Variable | Description |
|---|---|
| `ALARM_CONTACT_ID` | WeChat contact ID for the admin / alarm receiver. Errors are forwarded here; private-chat commands are only honored from this contact |
| `OB_STATE_FILE` | Path of the state file, default `./data/ob-state.json`. Observed tables, subscribed players and their recipients are persisted on every change, then restored and reported automatically after a restart |
| `PLAYER_<n>_BGA_NAME` | BGA username of the `n`-th player |
| `PLAYER_<n>_WECHAT_ID` | The corresponding WeChat ID (used for `@`). `<n>` starts at 1; add as many as needed |

Example player mapping:

```bash
PLAYER_1_BGA_NAME=Alice
PLAYER_1_WECHAT_ID=wxid_xxxxxxxxxxxx
PLAYER_2_BGA_NAME=Bob
PLAYER_2_WECHAT_ID=wxid_yyyyyyyyyyyy
```

## Run locally

```bash
npm install
npm run dist     # Compile TS → dist/
npm start        # Start; a QR code will be printed in the terminal on first login
```

## Docker

Every release is built and pushed to [Docker Hub](https://hub.docker.com/r/hcfw007/bga-arknova-wechat-notifier) automatically, so you can just pull it:

```bash
docker pull hcfw007/bga-arknova-wechat-notifier:1.1.1
```

Images are tagged by version only — there is no `latest`. The current version is on the badge above.

Or build it yourself:

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

**Do mount the `/app/data` volume.** Without it, every container rebuild — including a routine image upgrade — wipes `ob-state.json` and loses every observed table and player subscription. With it, they are restored and reported on startup.

The image is based on `node:20-alpine`, runs `npm install && npm run dist` during build, and starts with `node ./dist/index.js`.

## Development

```bash
npm test         # Unit tests (Node's built-in test runner + ts-node, no extra deps)
```

Tests cover the pure helpers only — command parsing, BGA payload parsing, state-file migration. Nothing touching Wechaty or the network is covered.

## Layout

- `src/index.ts` — Boots the Wechaty bot, handles QR-code login, and creates the single `RoomWorker`.
- `src/service/roomWorker.ts` — Parses commands from WeChat messages, owns both the per-table and per-player subscription lists, starts/stops `TableObserver` instances, periodically scans subscribed players for new tables, and resolves BGA player names to WeChat contacts for `@` mentions.
- `src/service/tableObserver.ts` — One instance per table; HTTP-polls BGA every 60s. Events: `ready` / `newPlayerMove` / `end` / `error`.
- `src/service/playerClient.ts` — Player-level BGA queries: resolve a username to an id, list a player's in-progress Ark Nova tables.
- `src/config.ts` — Loads and validates env vars; exports `config` and `playerMap`.
- `src/helper/` — Command parsing, BGA session handshake and payload parsing, state-file IO, logger.

## License

ISC
