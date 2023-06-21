import { log } from "@juzi/wechaty";

export class Logger {
  constructor (private readonly pre: string) {}

  info(...args: any[]) {
    return log.info(this.pre, ...args)
  }

  warn(...args: any[]) {
    return log.warn(this.pre, ...args)
  }

  error(...args: any[]) {
    return log.error(this.pre, ...args)
  }

  verbose(...args: any[]) {
    return log.verbose(this.pre, ...args)
  }

  silly(...args: any[]) {
    return log.silly(this.pre, ...args)
  }
}