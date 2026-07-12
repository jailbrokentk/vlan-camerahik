// grid-stream-scheduler.js - Smart stream concurrency manager
// Prevents NVR overload by rate-limiting simultaneous stream connections

class GridStreamScheduler {
  queue = []
  activeStarts = new Map()  // deviceId -> count of active connection attempts
  totalActive = 0           // global count of active connection attempts

  // Tuning parameters
  maxPerDevice = 2          // max simultaneous startPlay per NVR/device
  maxGlobal = 4             // max simultaneous startPlay globally
  staggerMs = 200           // minimum ms between consecutive starts
  slotTimeoutMs = 8000      // auto-release slot after 8s (safety net)
  lastStartMs = 0
  _processTimer = null

  /**
   * Schedule a stream start job through the rate limiter.
   * @param {{
   *   key: string,          // unique key for dedup (e.g. panelId:index)
   *   deviceId: string,     // device/NVR id for per-device limiting
   *   priority: number,     // higher = starts first (focused camera = 10, normal = 1)
   *   signal: AbortSignal,  // cancellation signal
   *   start: () => Promise  // the actual startPlay function to execute
   * }} job
   * @returns {Promise<any>} result from job.start()
   */
  async schedule(job) {
    // Remove duplicate key if any
    this.cancel(job.key)

    if (job.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.cancel(job.key)
        reject(new DOMException('Aborted', 'AbortError'))
      }

      if (job.signal) {
        job.signal.addEventListener('abort', onAbort, { once: true })
      }

      const wrapper = async () => {
        if (job.signal) {
          job.signal.removeEventListener('abort', onAbort)
        }
        if (job.signal?.aborted) {
          this._releaseSlot(job.deviceId)
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }

        // Safety timeout: auto-release slot if start() hangs
        const safetyTimer = setTimeout(() => {
          console.warn(`[SCHEDULER] safety timeout for key=${job.key}, releasing slot`)
          this._releaseSlot(job.deviceId)
        }, this.slotTimeoutMs)

        try {
          const result = await job.start()
          clearTimeout(safetyTimer)
          this._releaseSlot(job.deviceId)
          resolve(result)
        } catch (err) {
          clearTimeout(safetyTimer)
          this._releaseSlot(job.deviceId)
          reject(err)
        }
      }

      // Add to queue with wrapper
      this.queue.push({
        key: job.key,
        deviceId: job.deviceId,
        priority: job.priority || 1,
        start: wrapper
      })

      // Sort: higher priority first, then FIFO for same priority
      this.queue.sort((a, b) => b.priority - a.priority)

      this._scheduleProcess()
    })
  }

  cancel(key) {
    const idx = this.queue.findIndex(j => j.key === key)
    if (idx >= 0) {
      this.queue.splice(idx, 1)
    }
  }

  cancelDevice(deviceId) {
    this.queue = this.queue.filter(j => j.deviceId !== deviceId)
  }

  cancelAll() {
    this.queue = []
  }

  _releaseSlot(deviceId) {
    const active = this.activeStarts.get(deviceId) || 0
    if (active > 0) {
      this.activeStarts.set(deviceId, active - 1)
    }
    this.totalActive = Math.max(0, this.totalActive - 1)
    this._scheduleProcess()
  }

  _scheduleProcess() {
    if (this._processTimer) return
    if (this.queue.length === 0) return

    const now = Date.now()
    const elapsed = now - this.lastStartMs
    const delay = elapsed >= this.staggerMs ? 0 : this.staggerMs - elapsed

    this._processTimer = setTimeout(() => {
      this._processTimer = null
      this._processQueue()
    }, delay)
  }

  _processQueue() {
    if (this.queue.length === 0) return

    // Find first job that can run within both global and per-device limits
    for (let i = 0; i < this.queue.length; i++) {
      const job = this.queue[i]
      const deviceActive = this.activeStarts.get(job.deviceId) || 0

      if (this.totalActive < this.maxGlobal && deviceActive < this.maxPerDevice) {
        // Can run this job
        this.queue.splice(i, 1)
        this.activeStarts.set(job.deviceId, deviceActive + 1)
        this.totalActive++
        this.lastStartMs = Date.now()

        // Fire and forget (wrapper handles resolve/reject)
        job.start()

        // Try to process more jobs (if still within limits)
        this._scheduleProcess()
        return
      }
    }
  }

  getStats() {
    return {
      queueLength: this.queue.length,
      totalActive: this.totalActive,
      perDevice: Object.fromEntries(this.activeStarts.entries())
    }
  }
}

export const gridStreamScheduler = new GridStreamScheduler()
