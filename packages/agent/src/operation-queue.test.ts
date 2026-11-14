import { describe, expect, it } from 'vitest'
import { createOperationQueue } from './operation-queue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// README Authenticated SOCKS: helper handoffs, account changes and kernel
// lifecycle must share a reentrant serialization boundary.
describe('runtime operation queue', () => {
  it('orders independent operations but permits nested lifecycle calls', async () => {
    const run = createOperationQueue()
    const entered = deferred()
    const release = deferred()
    const order: string[] = []
    const first = run(async () => {
      order.push('first')
      entered.resolve()
      await release.promise
      await run(async () => {
        order.push('nested')
      })
      order.push('done')
    })
    await entered.promise
    const second = run(async () => {
      order.push('second')
    })
    expect(order).toEqual(['first'])
    release.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'nested', 'done', 'second'])
  })

  it('forces autonomous callbacks to queue even while their inherited owner is active', async () => {
    const run = createOperationQueue()
    const entered = deferred()
    const release = deferred()
    const order: string[] = []
    let watchdog!: Promise<void>
    const first = run(async () => {
      order.push('first')
      watchdog = run.enqueue!(async () => {
        order.push('watchdog')
      })
      entered.resolve()
      await release.promise
      order.push('done')
    })
    await entered.promise
    expect(order).toEqual(['first'])
    release.resolve()
    await first
    await watchdog
    expect(order).toEqual(['first', 'done', 'watchdog'])
  })

  it('does not poison the queue when an operation fails', async () => {
    const run = createOperationQueue()
    await expect(
      run(async () => {
        throw new Error('no')
      }),
    ).rejects.toThrow('no')
    expect(await run(async () => 42)).toBe(42)
  })

  it('revokes reentrancy inherited by a detached callback after owner completion', async () => {
    const run = createOperationQueue()
    const releaseLate = deferred()
    const enteredSecond = deferred()
    const releaseSecond = deferred()
    const order: string[] = []
    let late!: Promise<void>
    await run(async () => {
      late = (async () => {
        await releaseLate.promise
        await run(async () => {
          order.push('late')
        })
      })()
    })
    const second = run(async () => {
      enteredSecond.resolve()
      await releaseSecond.promise
      order.push('second')
    })
    await enteredSecond.promise
    releaseLate.resolve()
    await Promise.resolve()
    expect(order).toEqual([])
    releaseSecond.resolve()
    await Promise.all([second, late])
    expect(order).toEqual(['second', 'late'])
  })
})
