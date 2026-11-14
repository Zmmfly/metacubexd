import type { AddressInfo, Server, Socket } from 'node:net'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSocksGateway } from './socks-gateway'

// README Authenticated SOCKS: exercise the actual TCP wire path, mandatory
// RFC1929, domain forwarding, denial, bounded handshakes and disconnect behavior.
class Wire {
  buffer = Buffer.alloc(0)
  private wake?: () => void
  closed = false
  constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.wake?.()
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      this.closed = true
      this.wake?.()
    })
  }

  async read(size: number): Promise<Buffer> {
    while (this.buffer.length < size) {
      if (this.closed) throw new Error('closed')
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
    const value = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return value
  }

  write(bytes: number[] | Buffer): void {
    this.socket.write(Buffer.from(bytes))
  }
}
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function connect(port: number, allowHalfOpen = false): Promise<Wire> {
  const socket = createConnection({ host: '127.0.0.1', port, allowHalfOpen })
  const wire = new Wire(socket)
  cleanup.push(() => {
    socket.destroy()
  })
  await once(socket, 'connect')
  return wire
}
async function gateway(
  authenticate = vi.fn(
    async (_username: string, _password: string) => undefined,
  ) as Parameters<typeof createSocksGateway>[0]['authenticate'],
  extra: Partial<Parameters<typeof createSocksGateway>[0]> = {},
) {
  const gateway = createSocksGateway({ authenticate, ...extra })
  await gateway.listen('127.0.0.1', 0)
  cleanup.push(() => gateway.close())
  return { gateway, port: (gateway.address() as AddressInfo).port }
}
async function authenticate(
  wire: Wire,
  username = 'alice',
  password = 'secret',
): Promise<Buffer> {
  wire.write([5, 1, 2])
  expect(await wire.read(2)).toEqual(Buffer.from([5, 2]))
  const user = Buffer.from(username)
  const pass = Buffer.from(password)
  wire.write(
    Buffer.concat([
      Buffer.from([1, user.length]),
      user,
      Buffer.from([pass.length]),
      pass,
    ]),
  )
  return wire.read(2)
}
async function privateBackend(
  handler: (wire: Wire) => Promise<void>,
): Promise<number> {
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    void handler(new Wire(socket)).catch(() => socket.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return (server.address() as AddressInfo).port
}
const request = Buffer.concat([
  Buffer.from([5, 1, 0, 3, 22]),
  Buffer.from('never-resolves.invalid'),
  Buffer.from([1, 187]),
])
const success = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 1, 2])

describe('authenticated SOCKS TCP gateway', () => {
  it('only accepts RFC1929 and refuses no-auth', async () => {
    const auth = vi.fn(async () => undefined)
    const { port } = await gateway(auth)
    const wire = await connect(port)
    wire.write([5, 1, 0])
    expect(await wire.read(2)).toEqual(Buffer.from([5, 255]))
    expect(auth).not.toHaveBeenCalled()
  })

  it.each(['denied', 'exception'])(
    'fails RFC1929 closed on authenticate %s',
    async (kind) => {
      const { port } = await gateway(async () => {
        if (kind === 'exception') throw new Error('secret error')
        return undefined
      })
      const wire = await connect(port)
      expect(await authenticate(wire)).toEqual(Buffer.from([1, 1]))
      await once(wire.socket, 'close')
    },
  )

  it('authenticates private listener with distinct credentials and forwards domain CONNECT plus pipelined payload without DNS', async () => {
    const captured: Buffer[] = []
    const backendPort = await privateBackend(async (wire) => {
      captured.push(await wire.read(3))
      wire.write([5, 2])
      const header = await wire.read(2)
      const user = await wire.read(header[1]!)
      const length = await wire.read(1)
      const password = await wire.read(length[0]!)
      captured.push(Buffer.concat([header, user, length, password]))
      wire.write([1, 0])
      captured.push(await wire.read(request.length))
      wire.write(Buffer.concat([success, Buffer.from('hello')]))
      wire.write(await wire.read(4))
      wire.socket.pipe(wire.socket)
    })
    const auth = vi.fn(async () => ({
      port: backendPort,
      username: 'private',
      password: 'internal',
    }))
    const { port, gateway: entry } = await gateway(auth)
    const wire = await connect(port)
    expect(await authenticate(wire)).toEqual(Buffer.from([1, 0]))
    wire.write(Buffer.concat([request, Buffer.from('ping')]))
    expect(await wire.read(10)).toEqual(success)
    expect((await wire.read(9)).toString()).toBe('helloping')
    expect(auth).toHaveBeenCalledWith('alice', 'secret')
    expect(captured[0]).toEqual(Buffer.from([5, 1, 2]))
    expect(captured[1]!.toString()).toContain('private')
    expect(captured[1]!.toString()).toContain('internal')
    expect(captured[1]!.toString()).not.toContain('secret')
    expect(captured[2]).toEqual(request)
    const closed = once(wire.socket, 'close')
    entry.disconnect()
    await closed
  })

  it.each([2, 3])(
    'refuses unsupported command %i without dialing backend',
    async (command) => {
      const auth = vi.fn(async () => ({
        port: 1,
        username: 'private',
        password: 'internal',
      }))
      const { port } = await gateway(auth)
      const wire = await connect(port)
      expect(await authenticate(wire)).toEqual(Buffer.from([1, 0]))
      wire.write([5, command, 0, 1, 0, 0, 0, 0, 0, 1])
      expect((await wire.read(10))[1]).toBe(7)
    },
  )

  it('refuses a backend attempting no-auth or bad internal auth', async () => {
    for (const internalFailure of ['method', 'password']) {
      const backendPort = await privateBackend(async (wire) => {
        await wire.read(3)
        wire.write([5, internalFailure === 'method' ? 0 : 2])
        if (internalFailure === 'password') {
          await wire.read(2 + 7 + 1 + 8)
          wire.write([1, 1])
        }
      })
      const { port } = await gateway(async () => ({
        port: backendPort,
        username: 'private',
        password: 'internal',
      }))
      const wire = await connect(port)
      expect(await authenticate(wire)).toEqual(Buffer.from([1, 0]))
      wire.write(request)
      expect((await wire.read(10))[1]).not.toBe(0)
    }
  })

  it('times out incomplete handshakes and stalled private backends', async () => {
    const first = await gateway(undefined, { handshakeTimeoutMs: 40 })
    const wire = await connect(first.port)
    const closed = once(wire.socket, 'close')
    wire.write([5])
    await closed
    const backendPort = await privateBackend(async (wire) => {
      await wire.read(3)
    })
    const second = await gateway(
      async () => ({ port: backendPort, username: 'u', password: 'p' }),
      { backendTimeoutMs: 40 },
    )
    const other = await connect(second.port)
    await authenticate(other)
    const backendClosed = once(other.socket, 'close')
    other.write(request)
    await backendClosed
  })

  it('bounds connections and buffering; disconnect destroys pending auth and prevents late backend connects', async () => {
    let resolveAuth!: (value: {
      port: number
      username: string
      password: string
    }) => void
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const { port, gateway: entry } = await gateway(
      async () => {
        signalStarted()
        return new Promise((resolve) => {
          resolveAuth = resolve
        })
      },
      { maxConnections: 1, maxBufferedBytes: 1024 },
    )
    const first = await connect(port)
    first.write([5, 1, 2])
    await first.read(2)
    first.write([1, 1, 117, 1, 112])
    await started
    const excess = await connect(port)
    if (!excess.closed) await once(excess.socket, 'close')
    const closed = once(first.socket, 'close')
    entry.disconnect()
    await closed
    // The closed client's asynchronous authentication is still unresolved;
    // it must continue occupying admission capacity until settlement.
    const stillBusy = await connect(port)
    if (!stillBusy.closed) await once(stillBusy.socket, 'close')
    resolveAuth({ port: 1, username: 'private', password: 'internal' })
    const next = await gateway(undefined, { maxBufferedBytes: 128 })
    const overflow = await connect(next.port)
    const overflowClosed = once(overflow.socket, 'close')
    overflow.write(Buffer.alloc(1024))
    await overflowClosed
  })

  it('does not let refused clients retain admission slots by withholding FIN', async () => {
    const { port } = await gateway(undefined, { maxConnections: 1 })
    const first = await connect(port, true)
    const ended = once(first.socket, 'end')
    first.write([5, 1, 0])
    expect(await first.read(2)).toEqual(Buffer.from([5, 255]))
    await ended
    // allowHalfOpen intentionally keeps the malicious peer's writable half
    // alive. The server must nevertheless have destroyed its own socket.
    expect(first.socket.writableEnded).toBe(false)
    const second = await connect(port)
    second.write([5, 1, 2])
    expect(await second.read(2)).toEqual(Buffer.from([5, 2]))
  })

  it('rejects malformed UTF-8 credentials and handles fragmented RFC1929 frames', async () => {
    const auth = vi.fn(async () => undefined)
    const { port } = await gateway(auth)
    const invalid = await connect(port)
    invalid.write([5, 1, 2])
    await invalid.read(2)
    invalid.write([1, 1, 255, 1, 112])
    expect(await invalid.read(2)).toEqual(Buffer.from([1, 1]))
    expect(auth).not.toHaveBeenCalled()
    const fragmented = await connect(port)
    fragmented.write([5])
    fragmented.write([1, 2])
    expect(await fragmented.read(2)).toEqual(Buffer.from([5, 2]))
    fragmented.write([1, 1])
    fragmented.write([117])
    fragmented.write([1])
    fragmented.write([112])
    expect(await fragmented.read(2)).toEqual(Buffer.from([1, 1]))
    expect(auth).toHaveBeenCalledWith('u', 'p')
  })

  it('close also destroys sockets waiting for the first greeting', async () => {
    const { port, gateway: entry } = await gateway()
    const wire = await connect(port)
    const closed = once(wire.socket, 'close')
    await entry.close()
    await closed
    expect(entry.address()).toBeNull()
  })
})
