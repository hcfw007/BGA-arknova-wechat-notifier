import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname } from "path"
import { Logger } from "./logger"

export interface PersistedSubscriber {
  type: 'room' | 'contact'
  id: string
}

export interface PersistedTable {
  tableId: string
  subscribers: PersistedSubscriber[]
}

export class ObStateStore {

  private readonly logger = new Logger(ObStateStore.name)

  constructor(private readonly filePath: string) {}

  load(): PersistedTable[] {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch (e) {
      this.logger.warn(`ob state file not readable at ${this.filePath}, starting empty: ${e}`)
      return []
    }

    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        this.logger.warn(`ob state file is not an array, ignoring: ${this.filePath}`)
        return []
      }
      return parsed as PersistedTable[]
    } catch (e) {
      this.logger.warn(`ob state file parse failed, ignoring: ${e}`)
      return []
    }
  }

  save(tables: PersistedTable[]): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmpPath = `${this.filePath}.tmp`
      writeFileSync(tmpPath, JSON.stringify(tables, null, 2), 'utf-8')
      renameSync(tmpPath, this.filePath)
    } catch (e) {
      this.logger.error(`ob state save failed: ${e}`)
    }
  }
}
