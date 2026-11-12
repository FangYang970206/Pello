interface UpdateTimers {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
}

/** Manual checks are independent; disabling clears every future automatic check. */
export class UpdateScheduler {
  private enabled = false
  private startup?: ReturnType<typeof setTimeout>
  private interval?: ReturnType<typeof setInterval>
  constructor(private check: () => Promise<unknown>, private timers: UpdateTimers = { setTimeout, clearTimeout, setInterval, clearInterval }) {}
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.dispose()
    this.enabled = enabled
    if (!enabled) return
    const run = () => { if (this.enabled) void this.check().catch(() => {}) }
    this.startup = this.timers.setTimeout(run, 15000)
    this.interval = this.timers.setInterval(run, 6 * 60 * 60 * 1000)
  }
  dispose(): void {
    this.enabled = false
    this.timers.clearTimeout(this.startup)
    this.timers.clearInterval(this.interval)
    this.startup = this.interval = undefined
  }
}
