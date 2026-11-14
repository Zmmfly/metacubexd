// README Authenticated SOCKS: real, opt-in pinned-kernel E2E through createAgent
// and the authenticated H3 Control API. All destinations/fixtures are loopback;
// reserved .invalid names are sent as SOCKS ATYP=3, never resolved by Node.
import type { AddressInfo, Server, Socket } from 'node:net'
import type { SocksConfigInput, SocksSnapshot } from './socks-types'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { createAgent } from './index'

const binaryPath = process.env.SOCKS_TEST_MIHOMO
const expectedVersion = process.env.SOCKS_TEST_MIHOMO_VERSION ?? '1.19.27'
const PASSWORD = 'integration-placeholder-only'
const TOKEN = 'integration-control-token'
const successReply = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])

function read(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('readable', readable)
      socket.off('error', failed)
      socket.off('close', closed)
    }
    const failed = (error: Error) => {
      cleanup()
      reject(error)
    }
    const closed = () => failed(new Error('SOCKS socket closed'))
    const readable = () => {
      const bytes = socket.read(length) as Buffer | null
      if (bytes) {
        cleanup()
        resolve(bytes)
      }
    }
    socket.on('readable', readable)
    socket.once('error', failed)
    socket.once('close', closed)
    readable()
  })
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}
async function reservePort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

interface RequestRecord {
  atyp: number
  host: string
  port: number
}

async function harness() {
  const home = await mkdtemp(join(tmpdir(), 'mcxd-socks-e2e-'))
  const sockets = new Set<Socket>()
  const servers: Server[] = []
  const records = {
    A: [] as RequestRecord[],
    B: [] as RequestRecord[],
    entry: [] as RequestRecord[],
  }
  const fixtureErrors: Error[] = []
  let directHits = 0
  const track = (socket: Socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    socket.setTimeout(8000, () =>
      socket.destroy(new Error('fixture socket I/O timeout')),
    )
    return socket
  }
  const tcp = async (port: number) => {
    const socket = track(connect({ host: '127.0.0.1', port }))
    await once(socket, 'connect')
    return socket
  }
  const fixture = async (name: keyof typeof records, tunnelPort?: number) => {
    const server = createServer((socket) => {
      track(socket)
      void (async () => {
        const greeting = await read(socket, 2)
        expect(greeting[0]).toBe(5)
        const methods = await read(socket, greeting[1]!)
        expect(methods.includes(0)).toBe(true)
        socket.write(Buffer.from([5, 0]))
        const header = await read(socket, 4)
        expect([...header.subarray(0, 3)]).toEqual([5, 1, 0])
        let host: string
        if (header[3] === 1) host = [...(await read(socket, 4))].join('.')
        else if (header[3] === 3)
          host = (await read(socket, (await read(socket, 1))[0]!)).toString()
        else throw new Error(`Unsupported fixture ATYP ${header[3]}`)
        const port = (await read(socket, 2)).readUInt16BE()
        records[name].push({ atyp: header[3]!, host, port })
        if (tunnelPort !== undefined) {
          // Real chain: entry only permits the local B endpoint. It must relay
          // B's SOCKS handshake and response, not manufacture markerB itself.
          expect(host).toBe('127.0.0.1')
          expect(port).toBe(tunnelPort)
          const upstream = await tcp(tunnelPort)
          socket.write(successReply)
          socket.pipe(upstream).pipe(socket)
          socket.once('close', () => upstream.destroy())
          upstream.once('close', () => socket.destroy())
        } else {
          socket.write(successReply)
          let request = ''
          while (!request.includes('\r\n\r\n'))
            request += (await read(socket, 1)).toString()
          const marker = `marker${name}`
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Length: ${marker.length}\r\nConnection: close\r\n\r\n${marker}`,
          )
        }
      })().catch((error) => {
        if (!socket.destroyed) {
          fixtureErrors.push(error as Error)
          socket.destroy()
        }
      })
    })
    servers.push(server)
    return listen(server)
  }
  const a = await fixture('A')
  const b = await fixture('B')
  const entry = await fixture('entry', b)
  const origin = createHttpServer((_req, res) => {
    directHits++
    res.end('markerDIRECT')
  })
  origin.on('connection', track)
  servers.push(origin)
  const originPort = await listen(origin)
  const publicPort = await reservePort()
  const existingPort = await reservePort()
  const controllerPort = await reservePort()
  const options = {
    binaryPath: binaryPath!,
    homeDir: home,
    activeConfigPath: join(home, 'active.yaml'),
    profilesDir: join(home, 'profiles'),
    agentToken: TOKEN,
    externalController: `127.0.0.1:${controllerPort}`,
    secret: 'integration-native-secret',
    autoRestart: false,
    validateTimeoutMs: 15000,
    startTimeoutMs: 10000,
  }
  let agent = createAgent(options)
  const logs: string[] = []
  const observe = () =>
    agent.supervisor.on('log', (line) => {
      logs.push(line.line)
      if (logs.length > 100) logs.shift()
    })
  observe()
  let apiServer = createHttpServer(toNodeListener(agent.router))
  servers.push(apiServer)
  let apiPort = await listen(apiServer)
  const controlResponse = (
    path: string,
    method = 'GET',
    body?: unknown,
    authorized = true,
  ) =>
    fetch(`http://127.0.0.1:${apiPort}/api/control${path}`, {
      method,
      headers: {
        ...(authorized ? { Authorization: `Bearer ${TOKEN}` } : {}),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25000),
    })
  const control = async (path: string, method = 'GET', body?: unknown) => {
    const response = await controlResponse(path, method, body)
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(200)
    return result as any
  }
  const native = async (
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<any> => {
    const response = await fetch(`http://127.0.0.1:${controllerPort}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.secret}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    })
    expect(response.ok, `${path}: ${response.status}`).toBe(true)
    return response.status === 204 ? undefined : response.json()
  }
  const profile = (includeA = true) =>
    stringify({
      mode: 'rule',
      'log-level': 'warning',
      ipv6: false,
      dns: { enable: false },
      proxies: [
        ...(includeA
          ? [
              {
                name: 'A',
                type: 'socks5',
                server: '127.0.0.1',
                port: a,
                udp: false,
              },
            ]
          : []),
        { name: 'B', type: 'socks5', server: '127.0.0.1', port: b, udp: false },
        {
          name: 'entry',
          type: 'socks5',
          server: '127.0.0.1',
          port: entry,
          udp: false,
        },
        {
          name: 'chain',
          type: 'socks5',
          server: '127.0.0.1',
          port: b,
          'dialer-proxy': 'entry',
          udp: false,
        },
      ],
      'proxy-groups': [{ name: 'MAIN', type: 'select', proxies: ['B'] }],
      rules: ['MATCH,MAIN'],
      listeners: [
        {
          name: 'profile-owned',
          type: 'socks',
          listen: '127.0.0.1',
          port: existingPort,
          udp: false,
        },
      ],
    })
  let profileId = ''
  let snapshot: SocksSnapshot
  const input = (): SocksConfigInput => ({
    enabled: snapshot.enabled,
    listen: snapshot.listen,
    port: snapshot.port,
    users: snapshot.users.map(({ id, username, enabled, proxy, provider }) => ({
      id,
      username,
      enabled,
      proxy,
      provider,
    })),
  })
  const save = async (body = input()) => {
    snapshot = await control('/socks', 'PUT', body)
    expect(snapshot.status, JSON.stringify(snapshot) + logs.join('\n')).toBe(
      body.enabled ? 'listening' : 'disabled',
    )
    return snapshot
  }
  const auth = async (
    username: string,
    password = PASSWORD,
    port = publicPort,
  ) => {
    const socket = await tcp(port)
    socket.write(Buffer.from([5, 1, 2]))
    expect([...(await read(socket, 2))]).toEqual([5, 2])
    const user = Buffer.from(username)
    const pass = Buffer.from(password)
    socket.write(
      Buffer.concat([
        Buffer.from([1, user.length]),
        user,
        Buffer.from([pass.length]),
        pass,
      ]),
    )
    const reply = await read(socket, 2)
    if (reply[1] !== 0) {
      socket.destroy()
      throw new Error('SOCKS authentication rejected')
    }
    return socket
  }
  const destination = async (socket: Socket, host: string, port: number) => {
    const bytes = Buffer.from(host)
    const suffix = Buffer.alloc(2)
    suffix.writeUInt16BE(port)
    // Always encode a domain, including numeric loopback destinations. The
    // client does not call dns.lookup or make any direct target connection.
    socket.write(
      Buffer.concat([Buffer.from([5, 1, 0, 3, bytes.length]), bytes, suffix]),
    )
    const header = await read(socket, 4)
    expect(header[1]).toBe(0)
    if (header[3] === 1) await read(socket, 6)
    else if (header[3] === 3)
      await read(socket, (await read(socket, 1))[0]! + 2)
    else if (header[3] === 4) await read(socket, 18)
    else throw new Error('Invalid SOCKS CONNECT response')
    return socket
  }
  const request = async (
    username: string,
    host = 'destination.invalid',
    port = 80,
    password = PASSWORD,
  ) => {
    const socket = await destination(await auth(username, password), host, port)
    try {
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      )
      let response = ''
      // Response bodies are short fixture markers; consume exactly the known
      // Content-Length to avoid interpreting TCP close timing as success.
      while (!response.includes('\r\n\r\n'))
        response += (await read(socket, 1)).toString()
      const length = Number(/content-length: (\d+)/i.exec(response)?.[1])
      expect(length).toBeGreaterThan(0)
      return (await read(socket, length)).toString()
    } finally {
      socket.destroy()
    }
  }
  const held = async (username: string, password = PASSWORD) =>
    destination(await auth(username, password), 'held.invalid', 80)
  const disconnected = (socket: Socket) =>
    new Promise<void>((resolve, reject) => {
      if (socket.destroyed) {
        resolve()
        return
      }
      const timer = setTimeout(
        () => reject(new Error('active SOCKS connection was not disconnected')),
        3000,
      )
      socket.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.resume()
    })
  const closeServer = (server: Server) =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      if ('closeAllConnections' in server)
        (server as ReturnType<typeof createHttpServer>).closeAllConnections()
    })
  const close = async () => {
    await agent.dispose()
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(closeServer))
    await rm(home, { recursive: true, force: true })
  }
  try {
    const meta = await control('/profiles', 'POST', {
      name: 'loopback-fixture-profile',
      content: profile(),
    })
    profileId = meta.id
    const state = await control(`/profiles/${profileId}/activate`, 'POST')
    expect(state.status, logs.join('\n')).toBe('running')
    expect(state.version).toContain(expectedVersion)
    snapshot = await control('/socks')
    await save({
      enabled: true,
      listen: '127.0.0.1',
      port: publicPort,
      users: [
        { username: 'fixedA', password: PASSWORD, enabled: true, proxy: 'A' },
        {
          username: 'fixedChain',
          password: PASSWORD,
          enabled: true,
          proxy: 'chain',
        },
        { username: 'follow', password: PASSWORD, enabled: true },
      ],
    })
  } catch (error) {
    await close()
    throw error
  }
  return {
    control,
    controlResponse,
    native,
    save,
    input,
    auth,
    request,
    held,
    disconnected,
    tcp,
    close,
    records,
    fixtureErrors,
    getDirectHits: () => directHits,
    publicPort,
    existingPort,
    originPort,
    getSnapshot: () => snapshot,
    runtime: async () =>
      parse(await readFile(options.activeConfigPath, 'utf8')),
    addInlineProvider: async () => {
      const content = parse(profile())
      // A top-level node with the exact same name must not shadow the provider
      // node; a similar provider member must not broaden the wrapper filter.
      content.proxies.push({
        name: 'foo`bar',
        type: 'socks5',
        server: '127.0.0.1',
        port: b,
        udp: false,
      })
      content['proxy-providers'] = {
        'inline-fixture': {
          type: 'inline',
          payload: [
            {
              name: 'foo`bar',
              type: 'socks5',
              server: '127.0.0.1',
              port: a,
              udp: false,
            },
            {
              name: 'foobar',
              type: 'socks5',
              server: '127.0.0.1',
              port: b,
              udp: false,
            },
          ],
        },
      }
      await control(`/profiles/${profileId}`, 'PUT', {
        content: stringify(content),
      })
      await control(`/profiles/${profileId}/activate`, 'POST')
      snapshot = await control('/socks')
      expect(snapshot.status).toBe('listening')
    },
    removeBinding: async () => {
      await control(`/profiles/${profileId}`, 'PUT', {
        content: profile(false),
      })
      await control(`/profiles/${profileId}/activate`, 'POST')
      snapshot = await control('/socks')
      expect(snapshot.status, JSON.stringify(snapshot) + logs.join('\n')).toBe(
        'listening',
      )
      return snapshot
    },
    recreate: async () => {
      await agent.dispose()
      await closeServer(apiServer)
      agent = createAgent(options)
      observe()
      apiServer = createHttpServer(toNodeListener(agent.router))
      servers.push(apiServer)
      apiPort = await listen(apiServer)
      snapshot = await control('/socks')
      return snapshot
    },
  }
}

// No download/install fallback: the caller explicitly supplies the pinned binary.
describe
  .skipIf(!binaryPath)
  .sequential('readme Authenticated SOCKS real Mihomo', () => {
    let h: Awaited<ReturnType<typeof harness>>
    beforeEach(async () => {
      h = await harness()
    }, 45000)
    afterEach(async () => {
      await h?.close()
    }, 15000)

    it('keeps fixed node and real dialer chain independent of all three modes, while follow tracks the main route', async () => {
      for (const mode of ['rule', 'global', 'direct']) {
        await h.native('/configs', 'PATCH', { mode })
        if (mode === 'global')
          await h.native('/proxies/GLOBAL', 'PUT', { name: 'B' })
        const replacement = h.input()
        replacement.users[0]!.password = '' // explicit blank also preserves the old password
        await h.save(replacement) // retain both live mode and non-default selector
        expect((await h.native('/configs')).mode).toBe(mode)
        if (mode === 'global')
          expect((await h.native('/proxies/GLOBAL')).now).toBe('B')
        expect(await h.request('fixedA')).toBe('markerA')
        expect(await h.request('fixedChain')).toBe('markerB')
        expect(await h.request('follow', '127.0.0.1', h.originPort)).toBe(
          mode === 'rule'
            ? 'markerB'
            : mode === 'global'
              ? 'markerB'
              : 'markerDIRECT',
        )
        expect(
          (await h.runtime()).listeners.find(
            (x: any) => x.name === 'profile-owned',
          ),
        ).toMatchObject({ port: h.existingPort, type: 'socks' })
        const original = await h.tcp(h.existingPort)
        original.write(Buffer.from([5, 1, 0]))
        expect([...(await read(original, 2))]).toEqual([5, 0])
        original.destroy()
      }
      expect(h.records.entry).toHaveLength(3)
      for (const exit of ['A', 'B'] as const) {
        expect(
          h.records[exit].filter((x) => x.host === 'destination.invalid'),
        ).toHaveLength(3)
        expect(
          h.records[exit]
            .filter((x) => x.host === 'destination.invalid')
            .every((x) => x.atyp === 3 && x.port === 80),
        ).toBe(true)
      }
      expect(h.getDirectHits()).toBe(1)
      expect(h.fixtureErrors).toEqual([])
    }, 45000)

    it('binds an exact inline-provider node containing a backtick without matching similar or same-named top-level nodes', async () => {
      await h.addInlineProvider()
      const { targets } = await h.control('/socks/targets')
      expect(targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'foo`bar',
            provider: 'inline-fixture',
          }),
          expect.objectContaining({
            name: 'foobar',
            provider: 'inline-fixture',
          }),
        ]),
      )
      expect(
        targets.find(
          (target: any) =>
            target.name === 'foo`bar' && target.provider === 'inline-fixture',
        ).unavailable,
      ).toBeUndefined()
      const update = h.input()
      update.users.push(
        {
          username: 'providerExact',
          password: PASSWORD,
          enabled: true,
          proxy: 'foo`bar',
          provider: 'inline-fixture',
        },
        {
          username: 'providerSimilar',
          password: PASSWORD,
          enabled: true,
          proxy: 'foobar',
          provider: 'inline-fixture',
        },
      )
      await h.save(update)
      expect(await h.request('providerExact')).toBe('markerA')
      expect(await h.request('providerSimilar')).toBe('markerB')
      expect(h.records.A).toContainEqual({
        host: 'destination.invalid',
        port: 80,
        atyp: 3,
      })
      expect(h.records.B).toContainEqual({
        host: 'destination.invalid',
        port: 80,
        atyp: 3,
      })
      const stored = await h.control('/socks')
      expect(
        stored.users.find((user: any) => user.username === 'providerExact'),
      ).toMatchObject({
        proxy: 'foo`bar',
        provider: 'inline-fixture',
        hasPassword: true,
      })
      expect(h.fixtureErrors).toEqual([])
    }, 45000)

    it('rejects unauthenticated and wrong-password clients, new missing targets, and lost bindings without DIRECT fallback', async () => {
      expect(
        (await h.controlResponse('/socks', 'GET', undefined, false)).status,
      ).toBe(401)
      expect((await h.control('/info')).features).toContain('socks-service')
      const noAuth = await h.tcp(h.publicPort)
      noAuth.write(Buffer.from([5, 1, 0]))
      expect([...(await read(noAuth, 2))]).toEqual([5, 255])
      noAuth.destroy()
      await expect(h.auth('fixedA', 'wrong-placeholder')).rejects.toThrow(
        'authentication rejected',
      )
      const invalid = h.input()
      invalid.users.push({
        username: 'new',
        password: PASSWORD,
        enabled: true,
        proxy: 'missing',
      })
      expect((await h.controlResponse('/socks', 'PUT', invalid)).status).toBe(
        400,
      )
      const before = h.getDirectHits()
      const lost = await h.removeBinding()
      expect(lost.users.find((u) => u.username === 'fixedA')).toMatchObject({
        proxy: 'A',
        error: expect.any(String),
      })
      await expect(h.auth('fixedA')).rejects.toThrow('authentication rejected')
      expect(h.getDirectHits()).toBe(before)
      expect(await h.request('fixedChain')).toBe('markerB')
      const serialized = JSON.stringify(await h.control('/socks'))
      expect(serialized).not.toContain(PASSWORD)
      expect(serialized).not.toContain('passwordHash')
    }, 45000)

    it('disconnects active sockets on password change, revocation and stop, and restores durable credentials after agent recreation', async () => {
      const active = await h.held('fixedA')
      const changed = h.input()
      changed.users.find((u) => u.username === 'fixedA')!.password =
        'replacement-placeholder'
      const closed = h.disconnected(active)
      await h.save(changed)
      await closed
      await expect(h.auth('fixedA')).rejects.toThrow('authentication rejected')
      expect(
        await h.request(
          'fixedA',
          'destination.invalid',
          80,
          'replacement-placeholder',
        ),
      ).toBe('markerA')
      const revokeSocket = await h.held('fixedChain')
      const revoke = h.input()
      revoke.users = revoke.users.filter((u) => u.username !== 'fixedChain')
      const revoked = h.disconnected(revokeSocket)
      await h.save(revoke)
      await revoked
      await expect(h.auth('fixedChain')).rejects.toThrow(
        'authentication rejected',
      )
      const stopSocket = await h.held('fixedA', 'replacement-placeholder')
      const stopped = h.disconnected(stopSocket)
      await h.control('/kernel/stop', 'POST')
      await stopped
      expect((await h.recreate()).enabled).toBe(true)
      expect((await h.control('/kernel/start', 'POST')).status).toBe('running')
      expect((await h.control('/socks')).status).toBe('listening')
      expect(
        await h.request(
          'fixedA',
          'destination.invalid',
          80,
          'replacement-placeholder',
        ),
      ).toBe('markerA')
      await expect(h.auth('fixedChain')).rejects.toThrow(
        'authentication rejected',
      )
    }, 45000)
  })
