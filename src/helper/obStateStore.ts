import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname } from "path"
import { EMPTY_STATE, ObState, parseObState } from "./obState"
import { Logger } from "./logger"

export { PersistedSubscriber, PersistedTable, PersistedPlayer, ObState } from "./obState"

export class ObStateStore {

  private readonly logger = new Logger(ObStateStore.name)

  constructor(private readonly filePath: string) {}

  load(): ObState {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch (e) {
      this.logger.warn(`ob state file not readable at ${this.filePath}, starting empty: ${e}`)
      return EMPTY_STATE
    }

    try {
      return parseObState(JSON.parse(raw))
    } catch (e) {
      this.logger.warn(`ob state file parse failed, ignoring: ${e}`)
      return EMPTY_STATE
    }
  }

  save(state: ObState): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmpPath = `${this.filePath}.tmp`
      writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8')
      renameSync(tmpPath, this.filePath)
    } catch (e) {
      this.logger.error(`ob state save failed: ${e}`)
    }
  }
}
