// grid-stream-scheduler.js - Concurrency scheduler for video connections

class GridStreamScheduler {
  queue = []
  activeStarts = new Map() // deviceId -> count
  maxConcurrent = 3
  staggerMs = 150
  lastStartMs = 0

  async schedule(job) {
    // Remove duplicate key if any
    this.cancel(job.key)

    if (job.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.cancel(job.key)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      job.signal.addEventListener('abort', onAbort)

      const wrapper = async () => {
        job.signal.removeEventListener('abort', onAbort)
        if (job.signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }

        try {
          const result = await job.start()
          resolve(result)
        } catch (err) {
          reject(err)
        }
      }

      // Add to queue
      this.queue.push({
        ...job,
        start: wrapper
      })

      // Sort queue by priority desc (higher priority first)
      this.queue.sort((a, b) => b.priority - a.priority)

      this.processQueue()
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

  decrementActive(deviceId) {
    const active = this.activeStarts.get(deviceId) || 0
    if (active > 0) {
      this.activeStarts.set(deviceId, active - 1)
    }
    this.processQueue()
  }

  processQueue() {
    if (this.queue.length === 0) return

    const now = Date.now()
    if (now - this.lastStartMs < this.staggerMs) {
      // Respect stagger spacing
      setTimeout(() => this.processQueue(), this.staggerMs - (now - this.lastStartMs))
      return
    }

    // Find first job that can run
    for (let i = 0; i < this.queue.length; i++) {
      const job = this.queue[i]
      const active = this.activeStarts.get(job.deviceId) || 0

      if (active < this.maxConcurrent) {
        // We can run this job!
        this.queue.splice(i, 1)
        this.activeStarts.set(job.deviceId, active + 1)
        this.lastStartMs = Date.now()

        // Run the start handler
        job.start()
        
        // Process next job
        this.processQueue()
        break
      }
    }
  }

  getStats() {
    return {
      queueLength: this.queue.length,
      activeStarts: Object.fromEntries(this.activeStarts.entries())
    }
  }
}

export const gridStreamScheduler = new GridStreamScheduler()
