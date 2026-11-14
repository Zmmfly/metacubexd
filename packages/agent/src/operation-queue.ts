import { AsyncLocalStorage } from 'node:async_hooks'

export interface RuntimeOperation {
  <T>(action: () => Promise<T>): Promise<T>
  // Autonomous timers/socket callbacks must enqueue outside inherited ALS.
  enqueue?: <T>(action: () => Promise<T>) => Promise<T>
}

// One ordering boundary for config writes, kernel lifecycle, SOCKS updates and
// desktop helper handoffs. Nested calls from the same operation are reentrant;
// a detached callback cannot retain that privilege after its owner completes.
export function createOperationQueue(): RuntimeOperation {
  const scope = new AsyncLocalStorage<{ active: boolean }>()
  let tail: Promise<unknown> = Promise.resolve()
  const run: RuntimeOperation = function run<T>(
    action: () => Promise<T>,
  ): Promise<T> {
    if (scope.getStore()?.active) return action()
    const token = { active: true }
    const result = tail.then(() =>
      scope.run(token, async () => {
        try {
          return await action()
        } finally {
          token.active = false
        }
      }),
    )
    tail = result.catch(() => {})
    return result
  }
  run.enqueue = (action) => scope.exit(() => run(action))
  return run
}
