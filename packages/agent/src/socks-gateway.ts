import type { AddressInfo, Socket } from 'node:net'
import { Buffer } from 'node:buffer'
import { createConnection, createServer, isIP } from 'node:net'
import { TextDecoder } from 'node:util'

export interface SocksGatewayOptions {
  authenticate: (
    username: string,
    password: string,
  ) => Promise<
    | {
        port: number
        username: string
        password: string
      }
    | undefined
  >
  handshakeTimeoutMs?: number
  backendTimeoutMs?: number
  maxConnections?: number
  maxBufferedBytes?: number
}

/** One bounded handshake reader; piped streams use Node's backpressure afterwards. */
class Reader {
  private buffer = Buffer.alloc(0)
  private pending?: {
    count: number
    resolve: (value: Buffer) => void
    reject: (error: Error) => void
  }
  private error?: Error

  constructor(
    private socket: Socket,
    private limit: number,
  ) {
    socket.on('data', this.data)
    socket.on('error', this.failed)
    socket.on('end', this.ended)
    socket.on('close', this.ended)
  }

  private data = (chunk: Buffer): void => {
    if (this.buffer.length + chunk.length > this.limit) {
      this.failed(new Error('SOCKS handshake buffer exceeded'))
      this.socket.destroy()
      return
    }
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.flush()
  }

  private ended = (): void => this.failed(new Error('SOCKS socket closed'))
  private failed = (error: Error): void => {
    this.error = error
    this.pending?.reject(error)
    this.pending = undefined
  }

  private flush(): void {
    if (!this.pending || this.buffer.length < this.pending.count) return
    const { count, resolve } = this.pending
    this.pending = undefined
    const value = this.buffer.subarray(0, count)
    this.buffer = this.buffer.subarray(count)
    resolve(value)
  }

  read(count: number): Promise<Buffer> {
    if (this.error) return Promise.reject(this.error)
    if (this.pending) return Promise.reject(new Error('Concurrent SOCKS reads'))
    return new Promise((resolve, reject) => {
      this.pending = { count, resolve, reject }
      this.flush()
    })
  }

  release(): Buffer {
    this.socket.pause()
    this.socket.off('data', this.data)
    this.socket.off('error', this.failed)
    this.socket.off('end', this.ended)
    this.socket.off('close', this.ended)
    const result = this.buffer
    this.buffer = Buffer.alloc(0)
    return result
  }
}

const FAILURE = Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])
const utf8 = new TextDecoder('utf-8', { fatal: true })

function credential(value: string): Buffer {
  if (typeof value !== 'string') throw new Error('Invalid backend credentials')
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length < 1 || bytes.length > 255)
    throw new Error('Invalid backend credentials')
  return bytes
}

export function createSocksGateway(options: SocksGatewayOptions): {
  listen: (listen: string, port: number) => Promise<void>
  close: () => Promise<void>
  disconnect: () => void
  address: () => AddressInfo | string | null
} {
  const handshakeTimeout = options.handshakeTimeoutMs ?? 10_000
  const backendTimeout = options.backendTimeoutMs ?? 5_000
  const maxConnections = options.maxConnections ?? 256
  const maxBuffered = options.maxBufferedBytes ?? 64 * 1024
  for (const value of [
    handshakeTimeout,
    backendTimeout,
    maxConnections,
    maxBuffered,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('Invalid SOCKS gateway limit')
  }
  const sockets = new Set<Socket>()
  const clients = new Set<Socket>()
  let handshakes = 0
  let generation = 0
  function track(socket: Socket): void {
    sockets.add(socket)
    // Remains installed after Reader removal, including stream teardown races.
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
  }

  async function handshake(client: Socket): Promise<void> {
    const epoch = generation
    const reader = new Reader(client, maxBuffered)
    let upstream: Socket | undefined
    let upstreamReader: Reader | undefined
    let stage: 'methods' | 'auth' | 'request' = 'methods'
    let relayed = false
    const timer = setTimeout(() => client.destroy(), handshakeTimeout)
    timer.unref()
    try {
      const greeting = await reader.read(2)
      if (greeting[0] !== 5 || greeting[1] === 0) {
        client.destroy()
        return
      }
      const methods = await reader.read(greeting[1]!)
      if (!methods.includes(2)) {
        client.end(Buffer.from([5, 255]))
        return
      }
      client.write(Buffer.from([5, 2]))
      stage = 'auth'
      const header = await reader.read(2)
      if (header[0] !== 1 || header[1] === 0) {
        client.end(Buffer.from([1, 1]))
        return
      }
      const username = utf8.decode(await reader.read(header[1]!))
      const passwordLength = (await reader.read(1))[0]!
      if (!passwordLength) {
        client.end(Buffer.from([1, 1]))
        return
      }
      const password = utf8.decode(await reader.read(passwordLength))
      const backend = await options.authenticate(username, password)
      if (client.destroyed || epoch !== generation) return
      if (!backend) {
        client.end(Buffer.from([1, 1]))
        return
      }
      // Validate before revealing successful authentication or opening a socket.
      if (
        !Number.isInteger(backend.port) ||
        backend.port < 1 ||
        backend.port > 65535
      )
        throw new Error('Invalid backend port')
      const internalUser = credential(backend.username)
      const internalPassword = credential(backend.password)
      client.write(Buffer.from([1, 0]))
      stage = 'request'
      const request = await reader.read(4)
      if (request[0] !== 5 || request[2] !== 0)
        throw new Error('Malformed SOCKS request')
      if (request[1] !== 1) {
        client.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]))
        return
      }
      let address: Buffer
      if (request[3] === 3) {
        const size = await reader.read(1)
        if (!size[0]) throw new Error('Empty domain')
        address = Buffer.concat([size, await reader.read(size[0]!)])
      } else if (request[3] === 1) address = await reader.read(4)
      else if (request[3] === 4) address = await reader.read(16)
      else {
        client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]))
        return
      }
      const port = await reader.read(2)
      if (port.readUInt16BE() === 0) throw new Error('Invalid destination port')
      // Reads can already have been fulfilled from a pipelined buffer when a
      // configuration change destroys the socket. Re-check the epoch before
      // creating any new private connection, not just after authentication.
      if (client.destroyed || epoch !== generation) return
      // The only connect host is a numeric loopback literal. Target bytes are
      // forwarded unchanged; domains are never passed to dns or net.connect.
      upstream = createConnection({ host: '127.0.0.1', port: backend.port })
      track(upstream)
      client.once('close', () => upstream?.destroy())
      upstream.once('close', () => client.destroy())
      upstreamReader = new Reader(upstream, maxBuffered)
      upstream.setTimeout(backendTimeout, () => upstream?.destroy())
      await new Promise<void>((resolve, reject) => {
        const connected = (): void => {
          cleanup()
          resolve()
        }
        const failed = (): void => {
          cleanup()
          reject(new Error('Backend connection failed'))
        }
        const cleanup = (): void => {
          upstream!.off('connect', connected)
          upstream!.off('error', failed)
          upstream!.off('close', failed)
        }
        upstream!.once('connect', connected)
        upstream!.once('error', failed)
        upstream!.once('close', failed)
      })
      upstream.write(Buffer.from([5, 1, 2]))
      const method = await upstreamReader.read(2)
      if (method[0] !== 5 || method[1] !== 2)
        throw new Error('Backend requires RFC1929')
      upstream.write(
        Buffer.concat([
          Buffer.from([1, internalUser.length]),
          internalUser,
          Buffer.from([internalPassword.length]),
          internalPassword,
        ]),
      )
      const auth = await upstreamReader.read(2)
      if (auth[0] !== 1 || auth[1] !== 0)
        throw new Error('Backend authentication failed')
      upstream.write(Buffer.concat([request, address, port]))
      const reply = await upstreamReader.read(4)
      if (reply[0] !== 5 || reply[2] !== 0)
        throw new Error('Malformed backend reply')
      let tail: Buffer
      if (reply[3] === 1) tail = await upstreamReader.read(6)
      else if (reply[3] === 4) tail = await upstreamReader.read(18)
      else if (reply[3] === 3) {
        const size = await upstreamReader.read(1)
        if (!size[0]) throw new Error('Malformed backend reply')
        tail = Buffer.concat([size, await upstreamReader.read(size[0]! + 2)])
      } else throw new Error('Malformed backend address')
      if (reply[1] !== 0) {
        client.end(Buffer.concat([reply, tail]))
        return
      }
      if (client.destroyed || epoch !== generation) return
      clearTimeout(timer)
      upstream.setTimeout(0)
      const toClient = upstreamReader.release()
      const toBackend = reader.release()
      client.write(Buffer.concat([reply, tail]))
      if (toClient.length) client.write(toClient)
      if (toBackend.length) upstream.write(toBackend)
      client.pipe(upstream)
      upstream.pipe(client)
      relayed = true
    } catch {
      if (!client.destroyed) {
        if (stage === 'auth') client.end(Buffer.from([1, 1]))
        else if (stage === 'request') client.end(FAILURE)
        else client.destroy()
      }
    } finally {
      clearTimeout(timer)
      if (!relayed) {
        reader.release()
        upstreamReader?.release()
        upstream?.destroy()
        // Do not let a peer keep a refused half-closed connection alive. Flush
        // the tiny denial reply, then tear down both directions.
        const denialDeadline = setTimeout(() => client.destroy(), 250)
        denialDeadline.unref()
        client.once('close', () => clearTimeout(denialDeadline))
        client.destroySoon()
      }
    }
  }

  const server = createServer((client) => {
    // A disconnected client may still have an asynchronous authentication in
    // flight. Count it until settlement so rapid disconnects cannot enqueue
    // unbounded scrypt/authentication work.
    if (clients.size >= maxConnections || handshakes >= maxConnections) {
      client.destroy()
      return
    }
    clients.add(client)
    track(client)
    client.once('close', () => clients.delete(client))
    handshakes++
    void handshake(client).finally(() => {
      handshakes--
    })
  })
  // Later errors must not become uncaught EventEmitter exceptions. Bind errors
  // are still propagated by the one-shot listener in listen().
  server.on('error', () => {})
  function disconnect(): void {
    generation++
    for (const socket of sockets) socket.destroy()
  }
  return {
    async listen(listen, port) {
      if (!isIP(listen) || !Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('Invalid SOCKS listen address')
      await new Promise<void>((resolve, reject) => {
        const error = (value: Error): void => {
          server.off('listening', ready)
          reject(value)
        }
        const ready = (): void => {
          server.off('error', error)
          resolve()
        }
        server.once('error', error)
        server.once('listening', ready)
        try {
          server.listen(port, listen)
        } catch (value) {
          server.off('error', error)
          server.off('listening', ready)
          reject(value)
        }
      })
    },
    async close() {
      disconnect()
      if (!server.listening) return
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
    disconnect,
    address: () => server.address(),
  }
}
