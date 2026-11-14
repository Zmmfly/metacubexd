import type { SocksBackend } from './socks-config'
import type { SocksServiceOptions } from './socks-service'
import type { CreateSupervisorOptions } from './supervisor'
import type { KernelState, MihomoSupervisor, TunController } from './types'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgent } from './index'
import {
  createSocksStore,
  DEFAULT_SOCKS_CONFIG,
  prepareSocksConfig,
} from './socks-store'
import { TunPreconditionError } from './tun'

const boundary = vi.hoisted(() => ({
  createSupervisor: vi.fn(),
  probe: vi.fn(async (_backend: SocksBackend) => {}),
  fetch: vi.fn(async () => new Response('{}')),
}))
vi.mock('./supervisor', () => ({ createSupervisor: boundary.createSupervisor }))
// Keep the actual service, queue, runtime compiler, credential store and TCP
// gateway. Only replace the unavailable kernel's backend identity probe/API.
vi.mock('./socks-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./socks-service')>()
  return {
    ...actual,
    createSocksService: (options: SocksServiceOptions) =>
      actual.createSocksService({
        ...options,
        probe: boundary.probe,
        fetch: boundary.fetch as typeof fetch,
      }),
  }
})

const cleanup: (() => Promise<void>)[] = []
beforeEach(() => {
  boundary.createSupervisor.mockReset()
  boundary.probe.mockReset().mockResolvedValue(undefined)
  boundary.fetch.mockClear()
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

async function fixture(initialMode: 'sidecar' | 'tun' = 'sidecar') {
  const home = await mkdtemp(join(tmpdir(), 'mcxd-socks-lifecycle-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const activeConfigPath = join(home, 'active.yaml')
  await writeFile(activeConfigPath, 'proxies: []\nrules: [MATCH,REJECT]\n')
  const port = await freePort()
  await createSocksStore(join(home, 'socks-service.json')).write(
    await prepareSocksConfig(
      {
        enabled: true,
        listen: '127.0.0.1',
        port,
        users: [
          { username: 'alice', password: 'lifecycle-test-only', enabled: true },
        ],
      },
      DEFAULT_SOCKS_CONFIG,
    ),
  )
  let mode = initialMode
  const events: string[] = []
  const originalTun = {
    status: vi.fn(async () => ({ enabled: mode === 'tun', mode })),
    enable: vi.fn(async (_options: { stack: string }) => {
      mode = 'tun'
    }),
    disable: vi.fn(async () => {
      mode = 'sidecar'
    }),
    uninstall: vi.fn(async () => {
      mode = 'sidecar'
    }),
  } satisfies TunController
  let captured!: CreateSupervisorOptions
  let state: KernelState = {
    status: 'stopped',
    externalController: '127.0.0.1:9090',
    secret: 'local-test-only',
  }
  const stateListeners: ((state: KernelState) => void)[] = []
  function emit(status: KernelState['status']): void {
    state = { ...state, status }
    for (const listener of stateListeners) listener(state)
  }
  async function ready(operation: string): Promise<KernelState> {
    events.push(`native.${operation}`)
    if (captured.transformConfig) {
      const content = await captured.transformConfig(
        await readFile(activeConfigPath, 'utf8'),
      )
      await writeFile(activeConfigPath, content)
    }
    emit('running')
    await captured.onReady?.()
    return state
  }
  const native = {
    start: vi.fn(async () => ready('start')),
    stop: vi.fn(async () => {
      events.push('native.stop')
      emit('stopped')
      return state
    }),
    restart: vi.fn(async () => {
      emit('starting')
      return ready('restart')
    }),
    getState: () => state,
    setBinaryPath: vi.fn(),
    validate: vi.fn(async () => ({ valid: true, message: 'ok' })),
    on: vi.fn((event: string, callback: (state: KernelState) => void) => {
      if (event === 'state') stateListeners.push(callback)
    }),
    off: vi.fn(),
    dispose: vi.fn(async () => {
      emit('stopped')
    }),
  }
  // Retain native spy handles separately from the public supervisor wrapper.
  // Assertions must count real delegated actions, not guard invocations.
  const nativeCalls = {
    start: native.start,
    stop: native.stop,
    restart: native.restart,
  }
  boundary.createSupervisor.mockImplementation(
    (options: CreateSupervisorOptions) => {
      captured = options
      return native as unknown as MihomoSupervisor
    },
  )
  const userReady = vi.fn(async () => {
    events.push('user.onReady')
  })
  const agent = createAgent({
    binaryPath: '/not-a-real-kernel',
    homeDir: home,
    activeConfigPath,
    profilesDir: join(home, 'profiles'),
    tunController: originalTun,
    onReady: userReady,
  })
  cleanup.push(async () => {
    // Failure tests deliberately leave the delegate throwing and/or reporting
    // TUN ownership. Reset only during fixture teardown so dispose does not
    // repeat that intentional failure and obscure the assertion's outcome.
    originalTun.status.mockResolvedValue({ enabled: false, mode: 'sidecar' })
    originalTun.disable.mockResolvedValue(undefined)
    await agent.dispose()
  })
  // Prepare one real private generation without starting a subprocess. Every
  // activation below still traverses the actual service and TCP listener.
  await writeFile(
    activeConfigPath,
    await captured.transformConfig!(await readFile(activeConfigPath, 'utf8')),
  )
  return {
    agent,
    originalTun,
    nativeCalls,
    captured,
    events,
    port,
    userReady,
    emit,
    setMode: (next: 'sidecar' | 'tun') => {
      mode = next
    },
  }
}

// README Authenticated SOCKS: TUN/helper ownership and native lifecycle share a
// serialized boundary; readiness probes gate reopening and shutdown is latched.
describe('authenticated SOCKS createAgent lifecycle ordering', () => {
  it.each(['start', 'stop', 'restart'] as const)(
    'refuses public %s while TUN owns the kernel without invoking native lifecycle',
    async (operation) => {
      const { agent, originalTun, nativeCalls } = await fixture('tun')
      expect(agent.tunController).not.toBe(originalTun)
      await expect(agent.supervisor[operation]()).rejects.toBeInstanceOf(
        TunPreconditionError,
      )
      await expect(agent.supervisor[operation]()).rejects.toThrow(
        /disable TUN/i,
      )
      expect(nativeCalls[operation]).not.toHaveBeenCalled()
      expect(boundary.probe).not.toHaveBeenCalled()
    },
  )

  it('allows controlled disable to start the sidecar before stale TUN status changes and double activation stays listening', async () => {
    const { agent, originalTun, nativeCalls, userReady } = await fixture('tun')
    originalTun.disable.mockImplementation(async () => {
      expect((await originalTun.status()).mode).toBe('tun')
      await agent.supervisor.start()
      expect((await originalTun.status()).mode).toBe('tun')
    })
    await agent.tunController!.disable()
    expect(originalTun.disable).toHaveBeenCalledOnce()
    expect(nativeCalls.start).toHaveBeenCalledOnce()
    expect(userReady).toHaveBeenCalledOnce()
    // Native onReady activates once; wrapper finally probes the same prepared
    // generation again. The real gateway must not listen twice and close itself.
    expect(boundary.probe).toHaveBeenCalledTimes(2)
    expect(boundary.probe.mock.calls[0]![0]).toEqual(
      boundary.probe.mock.calls[1]![0],
    )
    expect(await agent.socks.read()).toMatchObject({ status: 'listening' })
    await expect(agent.supervisor.stop()).rejects.toBeInstanceOf(
      TunPreconditionError,
    )
  })

  it.each(['enable', 'disable'] as const)(
    'probes in %s finally after delegate failure without replacing the original error',
    async (operation) => {
      const { agent, originalTun } = await fixture()
      const failure = new Error(`original ${operation} failure`)
      originalTun[operation].mockRejectedValue(failure)
      const action =
        operation === 'enable'
          ? agent.tunController!.enable({ stack: 'gvisor' })
          : agent.tunController!.disable()
      await expect(action).rejects.toBe(failure)
      expect(boundary.probe).toHaveBeenCalledOnce()
      expect(await agent.socks.read()).toMatchObject({ status: 'listening' })
      // The transition flag must be cleared even on error, so a later real TUN
      // ownership report cannot accidentally permit unprivileged native start.
      originalTun.status.mockResolvedValue({ enabled: true, mode: 'tun' })
      await expect(agent.supervisor.start()).rejects.toBeInstanceOf(
        TunPreconditionError,
      )
    },
  )

  it.each(['enable', 'disable'] as const)(
    'retains the original %s failure even when its finally identity probe also fails',
    async (operation) => {
      const { agent, originalTun } = await fixture()
      const failure = new Error(`delegate ${operation} failed`)
      originalTun[operation].mockRejectedValue(failure)
      boundary.probe.mockRejectedValue(new Error('private backend unavailable'))
      const action =
        operation === 'enable'
          ? agent.tunController!.enable({ stack: 'gvisor' })
          : agent.tunController!.disable()
      await expect(action).rejects.toBe(failure)
      expect(boundary.probe).toHaveBeenCalledOnce()
      expect(await agent.socks.read()).toMatchObject({ status: 'error' })
    },
  )

  it('forces helper recovery from inherited ALS to queue behind its handoff and ahead of external native start', async () => {
    const { agent, originalTun, nativeCalls, events } = await fixture()
    const entered = deferred()
    const releaseHandoff = deferred()
    const recoveryEntered = deferred()
    const releaseRecovery = deferred()
    let recovery!: Promise<void>
    originalTun.enable.mockImplementation(async () => {
      events.push('handoff.enter')
      // This is deliberately called from inside the active operation's ALS.
      // The recovery boundary must enqueue, not execute reentrantly here.
      recovery = agent.enqueueRuntimeOperation(async () => {
        events.push('recovery.enter')
        recoveryEntered.resolve()
        await releaseRecovery.promise
        events.push('recovery.leave')
      })
      entered.resolve()
      await releaseHandoff.promise
      events.push('handoff.leave')
    })
    const handoff = agent.tunController!.enable({ stack: 'gvisor' })
    await entered.promise
    const external = agent.supervisor.start()
    expect(events).toEqual(['handoff.enter'])
    expect(nativeCalls.start).not.toHaveBeenCalled()
    releaseHandoff.resolve()
    await recoveryEntered.promise
    await handoff
    expect(events).toEqual(['handoff.enter', 'handoff.leave', 'recovery.enter'])
    expect(nativeCalls.start).not.toHaveBeenCalled()
    releaseRecovery.resolve()
    await Promise.all([recovery, external])
    expect(events.indexOf('native.start')).toBeGreaterThan(
      events.indexOf('recovery.leave'),
    )
    expect(nativeCalls.start).toHaveBeenCalledOnce()
    expect(await agent.socks.read()).toMatchObject({ status: 'listening' })
  })

  it('serializes uninstall with native lifecycle and suspends on non-running state events', async () => {
    const { agent, originalTun, nativeCalls, captured, emit } = await fixture()
    await captured.onReady!()
    expect(await agent.socks.read()).toMatchObject({ status: 'listening' })
    emit('starting')
    expect(await agent.socks.read()).toMatchObject({ status: 'error' })
    const entered = deferred()
    const release = deferred()
    originalTun.uninstall.mockImplementation(async () => {
      entered.resolve()
      await release.promise
    })
    const uninstall = agent.tunController!.uninstall!()
    await entered.promise
    const stop = agent.supervisor.stop()
    expect(nativeCalls.stop).not.toHaveBeenCalled()
    release.resolve()
    await Promise.all([uninstall, stop])
    expect(nativeCalls.stop).toHaveBeenCalledOnce()
    expect(await agent.socks.read()).toMatchObject({ status: 'error' })
  })

  it('does not reopen disposed SOCKS from late onReady or helper finally callbacks', async () => {
    const { agent, captured, port } = await fixture()
    await captured.onReady!()
    expect(await agent.socks.read()).toMatchObject({ status: 'listening' })
    await agent.socks.dispose()
    boundary.probe.mockClear()
    await captured.onReady!()
    await agent.tunController!.enable({ stack: 'gvisor' })
    expect(boundary.probe).not.toHaveBeenCalled()
    expect(await agent.socks.read()).toMatchObject({ status: 'error' })
    // Rebind the real public port: this detects accidental late activation even
    // if the service's snapshot were to report a stale inactive boolean.
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolve)
      })
    } finally {
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
