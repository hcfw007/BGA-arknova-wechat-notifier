import EventEmitter from "events"
import { Page } from "puppeteer"

export class TableObserver extends EventEmitter {

  constructor (private readonly tableId: string, private readonly chromeTab: Page) {
    super()
  }
}