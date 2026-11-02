import type { Server as HttpServer } from 'node:http'
import type { AddressInfo, Server as NetServer, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { Buffer } from 'node:buffer'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createProxiedFetch } from './proxy-fetch'

async function listen(server: HttpServer | NetServer): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

async function close(server: HttpServer | NetServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    if ('closeAllConnections' in server) server.closeAllConnections()
  })
}

describe('createProxiedFetch', () => {
  it('fetches an HTTP subscription through an HTTP proxy', async () => {
    let target: string | undefined
    let httpRequest = ''
    const tunnels = new Set<Duplex>()
    const server = createHttpServer()
    server.on('connect', (request, socket) => {
      tunnels.add(socket)
      socket.once('close', () => tunnels.delete(socket))
      target = request.url
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.once('data', (data) => {
        httpRequest = data.toString()
        const body = 'proxies: []\n'
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        )
      })
    })
    const port = await listen(server)
    try {
      const proxiedFetch = createProxiedFetch(`http://127.0.0.1:${port}`)
      const response = await proxiedFetch('http://subscription.test/config')
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('proxies: []\n')
      expect(target).toBe('subscription.test:80')
      expect(httpRequest).toContain('GET /config HTTP/1.1')
    } finally {
      for (const socket of tunnels) socket.destroy()
      await close(server)
    }
  })

  it('fetches an HTTP subscription through a SOCKS5 proxy', async () => {
    let target: string | undefined
    let httpRequest = ''
    const sockets = new Set<Socket>()
    const server = createNetServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      // Minimal SOCKS5 no-auth handshake, sufficient to exercise the real
      // Undici ProxyAgent path without an external network service.
      socket.once('data', () => {
        socket.write(Buffer.from([0x05, 0x00]))
        socket.once('data', (chunk) => {
          const request = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          expect(request[0]).toBe(0x05)
          expect(request[1]).toBe(0x01) // CONNECT
          expect(request[3]).toBe(0x03) // domain name
          const hostLength = request[4]!
          const host = request.subarray(5, 5 + hostLength).toString()
          const port = request.readUInt16BE(5 + hostLength)
          target = `${host}:${port}`
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          socket.once('data', (data) => {
            httpRequest = data.toString()
            const body = 'proxies: []\n'
            socket.end(
              `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
            )
          })
        })
      })
    })
    const port = await listen(server)
    try {
      const proxiedFetch = createProxiedFetch(`socks5://127.0.0.1:${port}`)
      const response = await proxiedFetch('http://subscription.test/config')
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('proxies: []\n')
      expect(target).toBe('subscription.test:80')
      expect(httpRequest).toContain('GET /config HTTP/1.1')
    } finally {
      for (const socket of sockets) socket.destroy()
      await close(server)
    }
  })

  it('rejects invalid URLs and unsupported proxy protocols', () => {
    expect(() => createProxiedFetch('not a URL')).toThrow('invalid proxy URL')
    expect(() => createProxiedFetch('ftp://127.0.0.1:21')).toThrow(
      'unsupported proxy protocol',
    )
  })
})
