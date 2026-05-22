# BGA-arknova-wechat-notifier

> 中文版: [README.md](./README.md)

@you in a WeChat room when it's your turn in **Ark Nova** on [Board Game Arena](https://boardgamearena.com/).

## How it works

1. A WeChat bot logs in via [Wechaty](https://github.com/wechaty/wechaty) + `@juzi/wechaty-puppet-service`.
2. Send `Ob <tableId>` in a room (or in a private chat with the admin), and the bot starts HTTP-polling that BGA table and parsing game state.
3. When the active player changes, it maps the BGA username to a WeChat ID and posts a message with an `@` mention in the room.

## Usage

In a WeChat room — or in a private chat from the admin contact (`ALARM_CONTACT_ID`):

| Command | Effect |
|---|---|
| `Ob <tableId>` / `ob <tableId>` | Start observing a table |
| `停止 <tableId>` / `stop <tableId>` | Stop observing |

`<tableId>` is the numeric ID at the end of the BGA table URL, e.g. `https://boardgamearena.com/table?table=123456789` → `123456789`.

## Environment variables

Required:

| Variable | Description |
|---|---|
| `WORK_TOKEN` | Token for `@juzi/wechaty-puppet-service` |

Optional:

| Variable | Description |
|---|---|
| `ALARM_CONTACT_ID` | WeChat contact ID for the admin / alarm receiver. Errors are forwarded here; private-chat commands are only honored from this contact |
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

```bash
docker build -t arknova-notifier .
docker run --rm -it \
  -e WORK_TOKEN=... \
  -e ALARM_CONTACT_ID=... \
  -e PLAYER_1_BGA_NAME=... \
  -e PLAYER_1_WECHAT_ID=... \
  arknova-notifier
```

The image is based on `node:20-alpine`, runs `npm install && npm run dist` during build, and starts with `node ./dist/index.js`.

## Layout

- `src/index.ts` — Boots the Wechaty bot, handles QR-code login, and creates the single `RoomWorker`.
- `src/service/roomWorker.ts` — Parses commands from WeChat messages, starts/stops `TableObserver` instances per table, and resolves BGA player names to WeChat contacts for `@` mentions.
- `src/service/tableObserver.ts` — One instance per table; HTTP-polls BGA every 60s. Events: `ready` / `newPlayerMove` / `end` / `error`.
- `src/config.ts` — Loads and validates env vars; exports `config` and `playerMap`.
- `src/helper/` — Logger and small utilities.

## License

ISC
