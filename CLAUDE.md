# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dist    # Compile TypeScript → dist/
npm start       # Run compiled app (node ./dist/index.js)
npm test        # Unit tests (node:test + ts-node, no extra deps)
```

`npm run dev` is declared in `package.json` but references `run-test.sh`, which is not in the repo — the script will fail unless someone reintroduces that file.

## Tests

`tests/*.spec.ts` run on Node's built-in test runner via `ts-node/register`, type-checked against `tsconfig.test.json`. Coverage is limited to the pure helpers — `parseCommand`, `looksLikePlayerId`, `mergeCookies`, `resultFromTableInfo`, `getExpectedPlayers`, `arkNovaTablesFromPlayerTables`, `pickExactPlayer`, `parseObState`. Anything touching Wechaty or the network is not covered.

Two config details matter:

- `tsconfig.json` pins `"rootDir": "src"`. Without it, adding any include outside `src/` moves tsc's inferred root to the project root and the build silently starts emitting `dist/src/index.js`, breaking both `npm start` and the Dockerfile entrypoint.
- `tsconfig.test.json` (extends the base, `noEmit`, `rootDir: "./"`) is the only config that sees `tests/`; the build config must not.

## Environment Setup

Required:

- `WORK_TOKEN` — token for `@juzi/wechaty-puppet-service` (the puppet is constructed with `tls.disable = true` and a 60s timeout).

Optional:

- `ALARM_CONTACT_ID` — WeChat contact ID that doubles as (a) the admin who can issue commands in a private chat and (b) the recipient of error alarms via `RoomWorker.sendAlarm`.
- `OB_STATE_FILE` — path of the observation-state JSON file (default `./data/ob-state.json`). `RoomWorker` persists the observed tables + subscribers (via `src/helper/obStateStore.ts`, atomic tmp-file rename) on every change and restores them once on the bot's `ready`/`login` events.
- `PLAYER_<n>_BGA_NAME` / `PLAYER_<n>_WECHAT_ID` — pair-wise BGA-to-WeChat mapping. `<n>` is any positive integer; `config.ts` scans every env var matching `^PLAYER_\d+_BGA_NAME` and looks up the matching `PLAYER_<n>_WECHAT_ID`.

There is no `.env` loader in the code — vars must already be exported in the process environment (VSCode launch config, shell, Docker `-e`, etc.).

## Architecture

WeChat bot that watches Board Game Arena (BGA) Ark Nova tables and @-mentions the active player in a WeChat room when the turn changes.

**Flow:**

1. `src/index.ts` — Builds a Wechaty bot with `@juzi/wechaty-puppet-service`, prints the login QR via `qrcode-terminal`, and on `login` instantiates a single `RoomWorker`.
2. `src/service/roomWorker.ts` — Owns all WeChat message handling.
   - Recognized commands — the **whole message** must be the command (anchored regex, case-insensitive), otherwise chat text that merely ends with a number is ignored:
     - `ob <tableId>` → start observing one table
     - `停止 <tableId>` / `stop <tableId>` → stop observing that table
     - `订阅 <name|id>` / `subscribe <name|id>` → follow a BGA player: every in-progress Ark Nova table of theirs is auto-observed, and a scan every `PLAYER_SCAN_INTERVAL_MS` (5min) picks up new ones
     - `退订 <name|id>` / `unsubscribe <name|id>` → stop following. **Tables already being observed are deliberately left running** — use `停止 <tableId>` for those.
   - `unsubscribe` is matched before `subscribe`: `"unsubscribe x"` ends with `"subscribe x"`, so the looser pattern would swallow it.
   - Private-chat commands are only honored from the `ALARM_CONTACT_ID` contact; room commands are honored from anyone in the room (no mention-self requirement — the anchored regex is what keeps false triggers out).
   - Multiple subscribers (rooms/contacts) can share one `TableObserver`. Subscribers are compared **by `.id`**, not by object identity, because a `Room`/`Contact` resolved during state restore is not the same instance as the one carried by an incoming message. When the last subscriber leaves, the observer is closed and its entry is dropped from `tableObserveList`.
   - All outgoing messages go through `RoomWorker.safeSay`, which swallows and logs send failures; `sendAlarm` notifies `ALARM_CONTACT_ID` when an observer errors out or a table fails to restore.
   - On start, prefetches an anonymous BGA session cookie via `axios` (`https://en.boardgamearena.com/`) and refreshes it every 2 hours (`BGA_SESSION_TTL_MS`). The cookie is shared with each new `TableObserver`.
3. `src/service/tableObserver.ts` — One instance per BGA table. **HTTP polling, no browser.**
   - Uses `axios` to fetch table info and game state directly from BGA, authenticated with the shared cookie + a CSRF token scraped from the page.
   - Polls every `POLL_INTERVAL_MS` (60s) once `ready`. The session (cookie + CSRF token) lives in the observer and is re-fetched by `ensureSession()` once it is older than `SESSION_TTL_MS` (2h) — it is no longer frozen in the polling closure.
   - Every poll is wrapped in try/catch. A failure drops the cached session/cookie so the next tick re-handshakes; only after `MAX_POLL_FAILURES` (3) consecutive failures does the observer stop polling and emit `error`. Cookie strings are merged by name (`mergeCookies`) so refreshes don't accumulate duplicates, and a TTL-triggered refresh discards the old cookie — otherwise BGA hands the same session straight back.
   - `init()` retries `initOnce()` up to `INIT_MAX_ATTEMPTS` (3) with linear backoff before emitting `error`. BGA returns sporadic 502s and 30s timeouts on the table page; without this a single blip killed the whole subscription.
   - `poll()` guards against re-entry with a `polling` flag: a slow round (up to 3 requests × 30s timeout) can outlast the 60s interval, and `setInterval` does not wait.
   - Emits: `ready`, `newPlayerMove` (with new active-player list), `end` (with result payload), `error`.
   - Final scores come from `tableinfos.html` → `data.result.player` (BGA redirects the game page of finished tables back to `/table`, so the old gamestate-scraping path only remains as a fallback).
   - Updates the shared cookie via an `onCookieUpdate` callback when a fresh `set-cookie` comes back.
4. `src/service/playerClient.ts` — Player-level BGA queries, **anonymous, no login needed**.
   - `findPlayerByName()` → `GET /player/player/findplayer.html?q=<name>`. This is a *prefix* search, so `pickExactPlayer()` keeps only **case-sensitive exact** matches; several matches means it reports the candidates and subscribes to nobody.
   - `listArkNovaTables()` → `POST /tablemanager/tablemanager/tableinfos.html` with body `playerfilter=<id>&turninfo=false&matchmakingtables=false`. Returns every game's tables, so `arkNovaTablesFromPlayerTables()` filters on `game_name === 'arknova'`. The response also carries `data.player.player_fullname`, which is how subscribing by id can still echo a name.
   - The endpoint needs the same scraped `X-Request-Token` as the table endpoints (806 without it). **A tokenless request poisons the whole session** — subsequent correctly-tokened calls also fail with 806 — so failures must drop the session and re-handshake.
   - `UnknownPlayerError` separates "no such player" (BGA code 100) from session failures, so a typo'd id does not look like an outage.
5. `src/config.ts` — Loads and validates env vars; exports `config` (with `token`, `alarmReceiver`, `playerMap`).
6. `src/helper/logger.ts` — Thin wrapper over Wechaty's `log` that prefixes log lines with the module name.
7. `src/helper/util.ts` — `stateRegulator()`: collapses whitespace/newlines in BGA state strings.
8. `src/helper/command.ts` — `parseCommand()` and `looksLikePlayerId()`. Pure, so it is unit-tested; `RoomWorker` cannot be constructed in a test because its constructor registers bot listeners and fires a network prefetch.
9. `src/helper/cookie.ts` — `mergeCookies()`: name-keyed cookie merge, incoming wins.
10. `src/helper/bgaSession.ts` — `handshake()`: fetch a page, merge cookies, scrape the 64-hex `requestToken`. Shared by `TableObserver` and `PlayerClient`.
11. `src/helper/bgaPayload.ts` — pure readers over BGA payloads: `resultFromTableInfo()`, `getExpectedPlayers()`, `arkNovaTablesFromPlayerTables()`, `pickExactPlayer()`.
12. `src/helper/obState.ts` — `parseObState()`: the persisted-state schema and its migration.

**State file format:** v1 was a bare `PersistedTable[]`; v2 is `{ tables, players }`. `parseObState()` still accepts the v1 array — a running instance has one on disk, and rejecting it would drop every observed table on upgrade.

**Key design detail:** `TableObserver` only knows BGA player names. `RoomWorker` is the layer that resolves them to WeChat contacts (via `config.playerMap`) when formatting the @-mention message.

## Docker

The `Dockerfile` is based on `node:20-alpine`. It swaps Alpine's package mirror to USTC, installs a native-build toolchain (`gcc`, `g++`, `make`, `python3`, plus `libsodium`, `ffmpeg`, font/SSL libs), then runs `npm install && npm run dist`. Entrypoint is `node ./dist/index.js`. No Puppeteer / Chromium setup — the current implementation does not use a browser.
