type Job = {
  task: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

export type Queue = {
  enqueue: <T>(task: () => Promise<T>) => Promise<T>
  size: () => number
  isProcessing: () => boolean
}

export function createQueue(): Queue {
  const jobs: Job[] = []
  let processing = false

  async function drain() {
    if (processing) {
      return
    }

    processing = true

    try {
      while (jobs.length > 0) {
        const job = jobs.shift()
        if (!job) {
          continue
        }

        try {
          const value = await job.task()
          job.resolve(value)
        } catch (error) {
          job.reject(error)
        }
      }
    } finally {
      processing = false
    }
  }

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        jobs.push({
          task: task as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        })
        void drain()
      })
    },
    size: () => jobs.length,
    isProcessing: () => processing,
  }
}
