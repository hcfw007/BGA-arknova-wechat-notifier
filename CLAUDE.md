# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dist    # Compile TypeScript → dist/
npm start       # Run compiled app (node ./dist/index.js)
```

`npm run dev` is declared in `package.json` but references `run-test.sh`, which is not in the repo — the script will fail unless someone reintroduces that file.

There are no automated tests.

## Environment Setup

Required:

- `WORK_TOKEN` — token for `@juzi/wechaty-puppet-service` (the puppet is constructed with `tls.disable = true` and a 60s timeout).

Optional:

- `ALARM_CONTACT_ID` — WeChat contact ID that doubles as (a) the admin who can issue commands in a private chat and (b) the recipient of error alarms via `RoomWorker.sendAlarm`.
- `PLAYER_<n>_BGA_NAME` / `PLAYER_<n>_WECHAT_ID` — pair-wise BGA-to-WeChat mapping. `<n>` is any positive integer; `config.ts` scans every env var matching `^PLAYER_\d+_BGA_NAME` and looks up the matching `PLAYER_<n>_WECHAT_ID`.

There is no `.env` loader in the code — vars must already be exported in the process environment (VSCode launch config, shell, Docker `-e`, etc.).

## Architecture

WeChat bot that watches Board Game Arena (BGA) Ark Nova tables and @-mentions the active player in a WeChat room when the turn changes.

**Flow:**

1. `src/index.ts` — Builds a Wechaty bot with `@juzi/wechaty-puppet-service`, prints the login QR via `qrcode-terminal`, and on `login` instantiates a single `RoomWorker`.
2. `src/service/roomWorker.ts` — Owns all WeChat message handling.
   - Recognized commands (regex-matched on message text):
     - `Ob <tableId>` / `ob <tableId>` → start observing
     - `停止 <tableId>` / `stop <tableId>` → stop observing
   - Private-chat commands are only honored from the `ALARM_CONTACT_ID` contact; room commands are honored from anyone in the room (mention-self check is currently commented out).
   - Multiple subscribers (rooms/contacts) can share one `TableObserver`; the observer is closed when its subscriber list becomes empty.
   - On start, prefetches an anonymous BGA session cookie via `axios` (`https://en.boardgamearena.com/`) and refreshes it every 2 hours (`BGA_SESSION_TTL_MS`). The cookie is shared with each new `TableObserver`.
3. `src/service/tableObserver.ts` — One instance per BGA table. **HTTP polling, no browser.**
   - Uses `axios` to fetch table info and game state directly from BGA, authenticated with the shared cookie + a CSRF token scraped from the page.
   - Polls every `POLL_INTERVAL_MS` (60s) once `ready`.
   - Emits: `ready`, `newPlayerMove` (with new active-player list), `end` (with result payload), `error`.
   - Updates the shared cookie via an `onCookieUpdate` callback when a fresh `set-cookie` comes back.
4. `src/config.ts` — Loads and validates env vars; exports `config` (with `token`, `alarmReceiver`, `playerMap`).
5. `src/helper/logger.ts` — Thin wrapper over Wechaty's `log` that prefixes log lines with the module name.
6. `src/helper/util.ts` — `stateRegulator()`: collapses whitespace/newlines in BGA state strings.

**Key design detail:** `TableObserver` only knows BGA player names. `RoomWorker` is the layer that resolves them to WeChat contacts (via `config.playerMap`) when formatting the @-mention message.

## Docker

The `Dockerfile` is based on `node:20-alpine`. It swaps Alpine's package mirror to USTC, installs a native-build toolchain (`gcc`, `g++`, `make`, `python3`, plus `libsodium`, `ffmpeg`, font/SSL libs), then runs `npm install && npm run dist`. Entrypoint is `node ./dist/index.js`. No Puppeteer / Chromium setup — the current implementation does not use a browser.
