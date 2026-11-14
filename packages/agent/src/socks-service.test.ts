import type { SocksBackend } from './socks-config'
import type { SocksServiceOptions } from './socks-service'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { createSocksService, probeSocksBackend } from './socks-service'

const resources: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close()
})

async function port(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const original = `mode: rule
listeners:
  - { name: original-listener, type: socks, listen: 127.0.0.1, port: 45678, users: [{username: original, password: original-pass}] }
proxies:
  - { name: exit-a, type: socks5, server: 127.0.0.1, port: 1 }
  - { name: exit-b, type: socks5, server: 127.0.0.1, port: 2 }
proxy-groups:
  - { name: selection, type: select, proxies: [exit-a, exit-b] }
rules: ['MATCH,REJECT']
`

async function fixture(overrides: Partial<SocksServiceOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'mcxd-socks-service-'))
  resources.push(() => rm(home, { recursive: true, force: true }))
  const activeConfigPath = join(home, 'active.yaml')
  await writeFile(activeConfigPath, original)
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchMock = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/configs'))
        return new Response(
          JSON.stringify({ mode: 'direct', 'log-level': 'warning' }),
        )
      if (String(url).endsWith('/proxies'))
        return new Response(
          JSON.stringify({
            proxies: {
              selection: {
                type: 'Selector',
                now: 'exit-b',
                all: ['exit-a', 'exit-b'],
              },
              GLOBAL: { type: 'Selector', now: 'exit-a' },
            },
          }),
        )
      if (String(url).endsWith('/providers/proxies'))
        return new Response(JSON.stringify({ providers: {} }))
      return new Response(null, { status: 204 })
    },
  ) as unknown as typeof fetch
  const validate = vi.fn(async () => ({ valid: true, message: 'ok' }))
  const probe = vi.fn(async (_backend: SocksBackend) => {})
  const service = createSocksService({
    filePath: join(home, 'socks-service.json'),
    activeConfigPath,
    getKernelState: () => ({
      externalController: '0.0.0.0:9090',
      secret: 'api-secret',
    }),
    validate,
    fetch: fetchMock,
    probe,
    ...overrides,
  })
  resources.push(() => service.dispose())
  return { home, activeConfigPath, service, fetchMock, validate, probe, calls }
}

async function input() {
  return {
    enabled: true,
    listen: '127.0.0.1',
    port: await port(),
    users: [
      {
        username: 'alice',
        password: 'public-password',
        enabled: true,
        proxy: 'exit-a',
      },
    ],
  }
}

// README Authenticated SOCKS: durable desired state, private authentication,
// main-mode preservation, failure gating, restart and shutdown semantics.
describe('authenticated SOCKS service orchestration', () => {
  it('is disabled by default and returns no credential material', async () => {
    const { service, calls } = await fixture()
    expect(await service.read()).toEqual({
      enabled: false,
      listen: '127.0.0.1',
      port: 10808,
      users: [],
      status: 'disabled',
    })
    expect(calls).toEqual([])
  })

  it('preserves full profile listeners, live main mode and selector choice on reload', async () => {
    const { service, calls, home, activeConfigPath, probe } = await fixture()
    const wanted = await input()
    const result = await service.update(wanted)
    expect(result.status).toBe('listening')
    expect(result.users[0]?.hasPassword).toBe(true)
    const visible = JSON.stringify(result)
    expect(visible).not.toContain(wanted.users[0]!.password)
    expect(visible).not.toContain('passwordHash')
    const persisted = await readFile(join(home, 'socks-service.json'), 'utf8')
    expect(persisted).not.toContain(wanted.users[0]!.password)
    expect(persisted).toContain('passwordHash')
    const runtime = parse(await readFile(activeConfigPath, 'utf8')) as Record<
      string,
      any
    >
    expect(runtime.mode).toBe('direct')
    expect(runtime['log-level']).toBe('warning')
    expect(runtime.listeners).toHaveLength(2)
    expect(runtime.listeners[0].name).toBe('original-listener')
    expect(runtime.listeners[1]).toMatchObject({
      type: 'socks',
      listen: '127.0.0.1',
      udp: false,
      proxy: 'exit-a',
    })
    expect(runtime.listeners[1].users[0].password).not.toBe(
      wanted.users[0]!.password,
    )
    expect(probe).toHaveBeenCalledOnce()
    expect(
      calls.find((call) => call.url.includes('/configs?force=true'))?.init
        ?.method,
    ).toBe('PUT')
    expect(
      calls.some(
        (call) =>
          call.url.endsWith('/proxies/selection') &&
          call.init?.body === JSON.stringify({ name: 'exit-b' }),
      ),
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.url.endsWith('/proxies/GLOBAL') &&
          call.init?.body === JSON.stringify({ name: 'exit-a' }),
      ),
    ).toBe(true)
    for (const call of calls) {
      expect(call.url).toMatch(/^http:\/\/127\.0\.0\.1:9090\//)
      expect(call.init?.headers).toMatchObject({
        Authorization: 'Bearer api-secret',
      })
    }
  })

  it('rejects invalid binding and validation failure before changing persisted state or runtime', async () => {
    const { service, activeConfigPath, home, validate, calls } = await fixture()
    const wanted = await input()
    await expect(
      service.update({
        ...wanted,
        users: [{ ...wanted.users[0], proxy: 'missing' }],
      }),
    ).rejects.toThrow('missing')
    expect(calls).toEqual([])
    expect(await readFile(activeConfigPath, 'utf8')).toBe(original)
    await expect(readFile(join(home, 'socks-service.json'))).rejects.toThrow()
    validate.mockResolvedValueOnce({
      valid: false,
      message: 'do not disclose runtime secrets',
    })
    await expect(service.update(wanted)).rejects.toThrow('validation failed')
    expect(await service.read()).toMatchObject({
      enabled: false,
      status: 'disabled',
    })
    expect(calls).toEqual([])
  })

  it('keeps desired settings but fails closed when the kernel reload fails', async () => {
    const { service, home, activeConfigPath, probe } = await fixture({
      fetch: (async () => {
        throw new Error('offline')
      }) as typeof fetch,
    })
    const wanted = await input()
    const result = await service.update(wanted)
    expect(result.status).toBe('error')
    expect(result.error).toContain('saved but not activated')
    expect(
      JSON.parse(await readFile(join(home, 'socks-service.json'), 'utf8'))
        .enabled,
    ).toBe(true)
    const runtime = parse(await readFile(activeConfigPath, 'utf8')) as any
    expect(runtime.listeners.at(-1).proxy).toBe('exit-a')
    expect(probe).not.toHaveBeenCalled()
  })

  it('does not apply when writing desired settings fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mcxd-socks-unwritable-'))
    resources.push(() => rm(home, { recursive: true, force: true }))
    const filePath = join(home, 'is-a-directory')
    await mkdir(filePath)
    const { service, calls } = await fixture({ filePath })
    await expect(service.update(await input())).rejects.toThrow()
    expect(calls).toEqual([])
    expect(await service.read()).toMatchObject({
      enabled: false,
      status: 'error',
    })
  })

  it('gates all users if a private listener fails its authentication probe', async () => {
    const { service } = await fixture({
      probe: async () => {
        throw new Error('not our authenticated listener')
      },
    })
    const result = await service.update(await input())
    expect(result.status).toBe('error')
    expect(result.error).toContain('could not be activated')
  })

  it('retains a missing binding after a profile refresh but renders explicit REJECT, never follow', async () => {
    const { service } = await fixture()
    await service.update(await input())
    const output = parse(await service.prepareConfig('proxies: []\n')) as any
    expect(output.listeners[0].proxy).toBe('REJECT')
    expect((await service.read()).users[0]).toMatchObject({
      proxy: 'exit-a',
      error: expect.any(String),
    })
  })

  it('supports password preservation and cold-start reconstruction with new private credentials', async () => {
    const first = await fixture()
    const wanted = await input()
    const saved = await first.service.update(wanted)
    const oldRuntime = parse(
      await readFile(first.activeConfigPath, 'utf8'),
    ) as any
    const stable = await first.service.update({
      ...wanted,
      users: [{ ...saved.users[0], password: '' }],
    })
    expect(stable.status).toBe('listening')
    await first.service.dispose()
    const next = createSocksService({
      filePath: join(first.home, 'socks-service.json'),
      activeConfigPath: first.activeConfigPath,
      getKernelState: () => ({
        externalController: '127.0.0.1:9090',
        secret: '',
      }),
      validate: first.validate,
      probe: first.probe,
    })
    resources.push(() => next.dispose())
    const rebuilt = parse(
      await next.prepareConfig(await readFile(first.activeConfigPath, 'utf8')),
    ) as any
    expect(rebuilt.listeners).toHaveLength(2)
    expect(rebuilt.listeners[1].users[0].password).not.toBe(
      oldRuntime.listeners[1].users[0].password,
    )
    await next.activate()
    expect(await next.read()).toMatchObject({
      status: 'listening',
      users: [{ username: 'alice', proxy: 'exit-a', hasPassword: true }],
    })
  })

  it('serializes concurrent full updates so one generation owns settings and runtime', async () => {
    const entered = deferred()
    const release = deferred()
    const validate = vi.fn(async () => {
      entered.resolve()
      await release.promise
      return { valid: true, message: 'ok' }
    })
    const { service, home, activeConfigPath } = await fixture({ validate })
    const a = await input()
    const first = service.update(a)
    await entered.promise
    const second = service.update({
      ...a,
      users: [
        {
          username: 'bob',
          password: 'another-password',
          enabled: true,
          proxy: 'exit-b',
        },
      ],
    })
    release.resolve()
    await Promise.all([first, second])
    expect((await service.read()).users.map((user) => user.username)).toEqual([
      'bob',
    ])
    expect(
      JSON.parse(await readFile(join(home, 'socks-service.json'), 'utf8'))
        .users[0].username,
    ).toBe('bob')
    expect(
      (parse(await readFile(activeConfigPath, 'utf8')) as any).listeners.at(-1)
        .proxy,
    ).toBe('exit-b')
  })

  it('disables and revokes even if unrelated runtime YAML is now malformed', async () => {
    const { service, activeConfigPath } = await fixture()
    const wanted = await input()
    const saved = await service.update(wanted)
    await writeFile(activeConfigPath, 'broken: [\n')
    const result = await service.update({ ...saved, enabled: false })
    expect(result.status).toBe('disabled')
    await service.activate()
    expect((await service.read()).status).toBe('disabled')
  })

  it('latches shutdown without waiting for a held validator or allowing a late activation', async () => {
    const entered = deferred()
    const release = deferred()
    const { service, calls } = await fixture({
      validate: async () => {
        entered.resolve()
        await release.promise
        return { valid: true, message: 'ok' }
      },
    })
    const pending = service.update(await input())
    const rejected = expect(pending).rejects.toThrow('shutting down')
    await entered.promise
    await service.dispose()
    release.resolve()
    await rejected
    await service.activate()
    expect(calls).toEqual([])
  })

  it('treats corrupt on-disk settings as disabled/error, not unauthenticated defaults', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mcxd-socks-corrupt-'))
    resources.push(() => rm(home, { recursive: true, force: true }))
    const filePath = join(home, 'socks.json')
    await writeFile(filePath, '{oops')
    const { service } = await fixture({ filePath })
    expect(await service.read()).toMatchObject({
      enabled: false,
      users: [],
      status: 'error',
    })
    expect(await service.prepareConfig('proxies: []\n')).toBe('proxies: []\n')
  })
})

describe('private listener identity probes', () => {
  it('rejects a port that accepts credentials indiscriminately even if positive authentication succeeds', async () => {
    const server = createServer((socket) => {
      socket.on('error', () => {})
      let stage = 0
      socket.on('data', () => {
        socket.write(Buffer.from(stage++ === 0 ? [5, 2] : [1, 0]))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    resources.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    )
    const bound = server.address() as { port: number }
    await expect(
      probeSocksBackend({
        id: 'one',
        username: 'internal',
        password: 'private',
        port: bound.port,
      }),
    ).rejects.toThrow('isolation')
  })

  it('rejects a no-auth SOCKS port and makes no CONNECT request', async () => {
    const packets: Buffer[] = []
    const server = createServer((socket) => {
      socket.on('error', () => {})
      socket.on('data', (data) => {
        packets.push(Buffer.from(data))
        socket.write(Buffer.from([5, 0]))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    resources.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    )
    const bound = server.address() as { port: number }
    await expect(
      probeSocksBackend({
        id: 'one',
        username: 'internal',
        password: 'private',
        port: bound.port,
      }),
    ).rejects.toThrow('must require')
    expect(packets).toHaveLength(1)
    expect([...packets[0]!]).toEqual([5, 1, 2])
  })
})
