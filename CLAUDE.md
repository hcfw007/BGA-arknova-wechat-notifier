# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dist    # Compile TypeScript → dist/
npm start       # Run compiled app (node ./dist/index.js)
npm run dev     # Run via run-test.sh (dev/test script)
```

There are no automated tests. The `src/test.ts` file is a manual test script for `TableObserver`.

## Environment Setup

The app requires a `.env` file (loaded via VSCode launch config or manually exported). Required variables:
- `PADPLUS_TOKEN` — Wechaty PadPlus token
- `PADPLUS_ENDPOINT` — PadPlus endpoint URL

Optional variables:
- `ALARM_CONTACT_ID` — WeChat contact ID to notify on errors
- `PUPPET_HEADLESS` — Set to `false` to show the browser window
- `PLAYER_[n]_BGA_NAME` / `PLAYER_[n]_WECHAT_ID` — BGA-to-WeChat player mappings (e.g., `PLAYER_1_BGA_NAME=Alice`, `PLAYER_1_WECHAT_ID=wxid_...`)

## Architecture

This is a WeChat bot that monitors Board Game Arena (BGA) Arknova tables and @-mentions players in WeChat when it's their turn.

**Flow:**

1. `src/index.ts` — Bootstraps the Wechaty bot (PadPlus puppet), handles QR login, creates a single `RoomWorker`.
2. `src/service/roomWorker.ts` — Receives WeChat messages. Parses commands (`观察`/`ob` to start, `停止`/`stop` to stop), manages a Puppeteer browser, and spawns/destroys `TableObserver` instances per table. On turn change, formats a message with @mentions and sends it to WeChat.
3. `src/service/tableObserver.ts` — One instance per BGA table. Uses Puppeteer to load the table page, intercepts WebSocket frames to detect game state changes, queries the DOM for active player info. Emits: `ready`, `newPlayerMove`, `end`, `error`. Runs a 30-second health-check timer to detect and dismiss page reload popups.
4. `src/config.ts` — Loads and validates all env vars; exports `config` object and `playerMapping` array.
5. `src/helper/logger.ts` — Thin wrapper over Wechaty's logger that prefixes log lines with the module name.
6. `src/helper/util.ts` — `stateRegulator()`: normalizes BGA game state strings (strips extra whitespace/newlines).

**Key design detail:** BGA player names are mapped to WeChat contact objects at runtime by `RoomWorker`. `TableObserver` works purely with BGA player names; `RoomWorker` resolves them to WeChat contacts for @mentions.

## Docker

The `Dockerfile` builds on Node 18 Alpine with system Chromium pre-installed. Puppeteer is configured to skip its own Chromium download and use the system binary instead (`PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`).
