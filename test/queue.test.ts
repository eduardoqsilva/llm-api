import { describe, expect, it } from 'vitest'
import { createQueue } from '../src/services/queue.js'

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('createQueue', () => {
  it('processa um job por vez', async () => {
    const queue = createQueue()
    let active = 0
    let maxActive = 0

    const task = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(10)
      active -= 1
      return 'ok'
    }

    await Promise.all([
      queue.enqueue(task),
      queue.enqueue(task),
      queue.enqueue(task),
    ])

    expect(maxActive).toBe(1)
  })

  it('mantém a ordem FIFO', async () => {
    const queue = createQueue()
    const order: number[] = []

    const results = await Promise.all([
      queue.enqueue(async () => {
        order.push(1)
        await delay(15)
        return 1
      }),
      queue.enqueue(async () => {
        order.push(2)
        await delay(5)
        return 2
      }),
      queue.enqueue(async () => {
        order.push(3)
        await delay(1)
        return 3
      }),
    ])

    expect(order).toEqual([1, 2, 3])
    expect(results).toEqual([1, 2, 3])
  })

  it('repassa o valor resolvido do job', async () => {
    const queue = createQueue()
    await expect(queue.enqueue(async () => 'resultado')).resolves.toBe(
      'resultado'
    )
  })

  it('repassa erros do job para o caller', async () => {
    const queue = createQueue()
    await expect(
      queue.enqueue(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
  })

  it('continua processando a fila após um erro', async () => {
    const queue = createQueue()

    await expect(
      queue.enqueue(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    await expect(queue.enqueue(async () => 'depois')).resolves.toBe('depois')
  })

  it('aceita novos jobs enquanto outro está em andamento (fila ilimitada)', async () => {
    const queue = createQueue()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = queue.enqueue(async () => {
      await gate
      return 'primeiro'
    })

    const second = queue.enqueue(async () => 'segundo')

    expect(queue.size()).toBe(1)

    release()
    await expect(first).resolves.toBe('primeiro')
    await expect(second).resolves.toBe('segundo')
    expect(queue.size()).toBe(0)
  })
})
