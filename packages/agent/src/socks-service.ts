import type { RuntimeOperation } from './operation-queue'
import type { SocksBackend } from './socks-config'
import type { SocksSnapshot, StoredSocksConfig } from './socks-types'
import type { KernelState, MihomoSupervisor } from './types'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { parseDocument } from 'yaml'
import { createOperationQueue } from './operation-queue'
import {
  buildSocksRuntime,
  SOCKS_LISTENER_PREFIX,
  validateSocksTarget,
} from './socks-config'
import { createSocksGateway } from './socks-gateway'
import {
  createSocksStore,
  DEFAULT_SOCKS_CONFIG,
  prepareSocksConfig,
  publicSocksConfig,
  verifySocksPassword,
} from './socks-store'

export interface SocksTarget {
  name: string
  type: string
  provider?: string
  unavailable?: string
}

export interface SocksServiceOptions {
  filePath: string
  activeConfigPath: string
  getKernelState: () => Pick<KernelState, 'externalController' | 'secret'>
  validate: MihomoSupervisor['validate']
  serialize?: RuntimeOperation
  fetch?: typeof fetch
  reservePort?: () => Promise<number>
  probe?: (backend: SocksBackend) => Promise<void>
}

export class SocksConfigError extends Error {}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate SOCKS backend port'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

// Probe authentication, NOT CONNECT: Mihomo replies to CONNECT before dialing.
// Both positive and negative probes are needed: an accidentally unauthenticated
// port must never qualify as our private listener. No destination is contacted.
export async function probeSocksBackend(backend: SocksBackend): Promise<void> {
  const check = async (password: string, valid: boolean) => {
    const socket = connect({ host: '127.0.0.1', port: backend.port })
    socket.on('error', () => {})
    socket.setTimeout(2000, () =>
      socket.destroy(new Error('SOCKS backend probe timed out')),
    )
    const read = (length: number): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          socket.off('readable', readable)
          socket.off('error', fail)
          socket.off('close', closed)
        }
        const fail = () => {
          cleanup()
          reject(new Error('SOCKS backend authentication probe failed'))
        }
        const closed = () => fail()
        const readable = () => {
          const chunk = socket.read(length) as Buffer | null
          if (chunk) {
            cleanup()
            resolve(chunk)
          }
        }
        socket.on('readable', readable)
        socket.once('error', fail)
        socket.once('close', closed)
        readable()
      })
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = () => {
          socket.off('connect', ready)
          reject(new Error('SOCKS backend is unavailable'))
        }
        const ready = () => {
          socket.off('error', fail)
          resolve()
        }
        socket.once('connect', ready)
        socket.once('error', fail)
      })
      socket.write(Buffer.from([5, 1, 2]))
      const method = await read(2)
      if (method[0] !== 5 || method[1] !== 2)
        throw new Error('SOCKS backend must require username/password')
      const usernameBytes = Buffer.from(backend.username)
      const passwordBytes = Buffer.from(password)
      socket.write(
        Buffer.concat([
          Buffer.from([1, usernameBytes.length]),
          usernameBytes,
          Buffer.from([passwordBytes.length]),
          passwordBytes,
        ]),
      )
      const result = await read(2)
      if (result[0] !== 1 || (result[1] === 0) !== valid)
        throw new Error('SOCKS backend authentication isolation failed')
    } finally {
      socket.destroy()
    }
  }
  await check(backend.password, true)
  await check(`invalid-${randomBytes(18).toString('hex')}`, false)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function createSocksService(opts: SocksServiceOptions) {
  const run = opts.serialize ?? createOperationQueue()
  const fetchImpl = opts.fetch ?? fetch
  const store = createSocksStore(opts.filePath)
  const reservePort = opts.reservePort ?? freeLoopbackPort
  const probe = opts.probe ?? probeSocksBackend
  let config: StoredSocksConfig | undefined
  let backends: SocksBackend[] = []
  let bindingErrors: Record<string, string> = {}
  let serviceError: string | undefined
  let active = false
  let disposed = false
  let epoch = 0
  // Socket limits alone do not bound async scrypt: a peer can disconnect after
  // submitting credentials. Hold this token until derivation actually settles.
  let authenticating = 0

  const gateway = createSocksGateway({
    async authenticate(username, password) {
      const generation = epoch
      if (!active || disposed || !config?.enabled) return undefined
      const user = config.users.find(
        (entry) => entry.enabled && entry.username === username,
      )
      if (!user || bindingErrors[user.id] || authenticating >= 4)
        return undefined
      authenticating++
      try {
        if (!(await verifySocksPassword(password, user.passwordHash)))
          return undefined
      } finally {
        authenticating--
      }
      if (generation !== epoch || !active || disposed) return undefined
      return backends.find((backend) => backend.id === user.id)
    },
  })

  const suspend = () => {
    active = false
    epoch++
    gateway.disconnect()
  }

  async function load(): Promise<StoredSocksConfig> {
    if (!config) {
      try {
        config = await store.read()
      } catch {
        // Corrupt credentials must disable the feature, not fall back to an
        // unauthenticated listener or prevent the main kernel from starting.
        config = { ...DEFAULT_SOCKS_CONFIG, users: [] }
        serviceError =
          'SOCKS settings could not be read; save a new configuration to recover'
      }
    }
    return config
  }

  function endpoint(path: string): {
    url: string
    headers: Record<string, string>
  } {
    const state = opts.getKernelState()
    const port = /:(\d+)$/.exec(state.externalController)?.[1]
    if (!port) throw new Error('local Clash API port is unavailable')
    return {
      url: `http://127.0.0.1:${port}${path}`,
      headers: state.secret ? { Authorization: `Bearer ${state.secret}` } : {},
    }
  }

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const { url, headers } = endpoint(path)
    const response = await fetchImpl(url, {
      ...init,
      headers: { ...headers, ...init.headers },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok)
      throw new Error(
        'local Clash API rejected the SOCKS configuration operation',
      )
    return response
  }

  async function runtime(): Promise<string> {
    try {
      return await readFile(opts.activeConfigPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return 'proxies: []\n'
      throw error
    }
  }

  async function allocate(next: StoredSocksConfig): Promise<SocksBackend[]> {
    if (!next.enabled) return []
    const used = new Set([
      next.port,
      ...backends.map((backend) => backend.port),
    ])
    const result: SocksBackend[] = []
    for (const user of next.users.filter((entry) => entry.enabled)) {
      let port = 0
      for (let attempt = 0; attempt < 32; attempt++) {
        const candidate = await reservePort()
        if (!used.has(candidate)) {
          port = candidate
          break
        }
      }
      if (!port)
        throw new Error('could not allocate distinct SOCKS backend ports')
      used.add(port)
      result.push({
        id: user.id,
        username: user.username,
        proxy: user.proxy,
        provider: user.provider,
        port,
        password: randomBytes(32).toString('hex'),
      })
    }
    return result
  }

  function snapshot(): SocksSnapshot {
    const stored = config ?? { ...DEFAULT_SOCKS_CONFIG, users: [] }
    const visible = publicSocksConfig(stored)
    return {
      ...visible,
      users: visible.users.map((user) => ({
        ...user,
        ...(bindingErrors[user.id] ? { error: bindingErrors[user.id] } : {}),
      })),
      status: serviceError
        ? 'error'
        : !stored.enabled
          ? 'disabled'
          : active
            ? 'listening'
            : 'error',
      ...(serviceError || (stored.enabled && !active)
        ? {
            error:
              serviceError ??
              'SOCKS settings saved; start the kernel to activate the listener',
          }
        : {}),
    }
  }

  async function writeRuntime(content: string): Promise<void> {
    const temporary = `${opts.activeConfigPath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, content, { mode: 0o600 })
      await rename(temporary, opts.activeConfigPath)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  // Called only after a main-kernel or privileged-helper start, or a successful
  // full configuration reload. A late callback cannot publish an old generation.
  async function activateImpl(): Promise<void> {
    const stored = await load()
    if (disposed || !stored.enabled) return
    const generation = epoch
    try {
      if (
        !backends.length ||
        backends.length !== stored.users.filter((user) => user.enabled).length
      )
        throw new Error('SOCKS runtime is not prepared')
      await Promise.all(backends.map((backend) => probe(backend)))
      if (generation !== epoch || disposed) return
      // suspend() revokes sessions but deliberately keeps the accept socket.
      // A normal restart/helper handoff (and nested onReady + finally) must be
      // idempotent rather than calling listen() on an already bound server.
      if (!gateway.address()) await gateway.listen(stored.listen, stored.port)
      if (generation !== epoch || disposed) {
        await gateway.close()
        return
      }
      serviceError = undefined
      active = true
    } catch {
      suspend()
      await gateway.close()
      serviceError =
        'SOCKS listener could not be activated; check port availability and restart the kernel'
    }
  }

  return {
    read: () =>
      run(async () => {
        await load()
        return snapshot()
      }),
    // The supervisor invokes this on EVERY spawn, including its crash watchdog.
    // A stopped helper reuses the same active runtime file and private generation.
    prepareConfig: (content: string) =>
      run(async () => {
        const stored = await load()
        suspend()
        if (disposed || !stored.enabled) {
          backends = []
          bindingErrors = {}
          return content.includes(SOCKS_LISTENER_PREFIX)
            ? buildSocksRuntime(content, []).content
            : content
        }
        if (!backends.length) backends = await allocate(stored)
        const built = buildSocksRuntime(content, backends)
        bindingErrors = built.errors
        return built.content
      }),
    activate: () => run(activateImpl),
    suspend,
    // Desired state is durable BEFORE applying it. If reload/probes fail the
    // gateway stays closed and read() reports error; a later kernel start builds
    // that desired state again. There is no hidden old-credential fallback.
    update: (input: unknown) =>
      run(async (): Promise<SocksSnapshot> => {
        if (disposed)
          throw new SocksConfigError('SOCKS service is shutting down')
        const previous = await load()
        let next: StoredSocksConfig
        try {
          next = await prepareSocksConfig(input, previous)
        } catch (error) {
          throw new SocksConfigError(
            error instanceof Error
              ? error.message
              : 'invalid SOCKS configuration',
          )
        }
        const original = await runtime()
        for (const user of next.users.filter(
          (entry) => next.enabled && entry.enabled && entry.proxy,
        )) {
          const invalid = validateSocksTarget(
            original,
            user.proxy!,
            user.provider,
          )
          if (invalid) throw new SocksConfigError(invalid)
        }
        const nextBackends = await allocate(next)
        const built = (() => {
          try {
            return buildSocksRuntime(original, nextBackends)
          } catch {
            // Disabling must still revoke public access when an unrelated profile
            // edit has made the runtime YAML malformed. Cleanup can wait for boot.
            if (!next.enabled) return { content: original, errors: {} }
            throw new SocksConfigError(
              'SOCKS runtime could not be prepared; check profile listeners and reserved names',
            )
          }
        })()
        let preparedRuntime = built.content
        if (next.enabled) {
          const candidate = `${opts.activeConfigPath}.socks-${randomUUID()}.yaml`
          try {
            await writeFile(candidate, built.content, { mode: 0o600 })
            const validated = await opts.validate(candidate)
            if (!validated.valid)
              throw new SocksConfigError(
                'SOCKS runtime validation failed; check the active profile and kernel logs',
              )
          } finally {
            await rm(candidate, { force: true })
          }
        }
        if (disposed)
          throw new SocksConfigError('SOCKS service is shutting down')
        // A persistence failure leaves the current listener and runtime untouched.
        await store.write(next)
        suspend()
        await gateway.close()
        config = next
        backends = nextBackends
        bindingErrors = built.errors
        serviceError = undefined
        try {
          if (disposed) throw new Error('SOCKS service is shutting down')
          // GET returns only General, not a complete config. The authoritative
          // runtime document above preserves profile listeners, routes and TUN.
          const current = (await request('/configs').then((response) =>
            response.json(),
          )) as unknown
          const selections = (await request('/proxies').then((response) =>
            response.json(),
          )) as unknown
          const doc = parseDocument(built.content)
          if (object(current)) {
            for (const key of [
              'mode',
              'allow-lan',
              'log-level',
              'ipv6',
              'interface-name',
              'unified-delay',
              'tcp-concurrent',
            ]) {
              const value = current[key]
              if (
                typeof value === 'string' ||
                typeof value === 'boolean' ||
                typeof value === 'number'
              )
                doc.set(key, value)
            }
          }
          const content = doc.toString()
          preparedRuntime = content
          if (disposed) throw new Error('SOCKS service is shutting down')
          await writeRuntime(content)
          await request('/configs?force=true', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: content }),
          })
          if (object(selections) && object(selections.proxies)) {
            for (const [name, value] of Object.entries(selections.proxies)) {
              if (
                name.startsWith(SOCKS_LISTENER_PREFIX) ||
                !object(value) ||
                value.type !== 'Selector' ||
                typeof value.now !== 'string'
              )
                continue
              await request(`/proxies/${encodeURIComponent(name)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: value.now }),
              })
            }
          }
          await activateImpl()
        } catch {
          // Persist the generated config even when the kernel is stopped, but do
          // not claim success or open a gateway backed by an unverified process.
          if (!disposed) await writeRuntime(preparedRuntime).catch(() => {})
          serviceError = next.enabled
            ? 'SOCKS settings saved but not activated; start or restart the kernel, then refresh status'
            : undefined
        }
        return snapshot()
      }),
    targets: () =>
      run(async (): Promise<{ targets: SocksTarget[] }> => {
        const content = await runtime()
        const data: unknown = parseDocument(content).toJS()
        const targets: SocksTarget[] = []
        if (!object(data)) return { targets }
        for (const key of ['proxies', 'proxy-groups']) {
          const entries = data[key]
          if (!Array.isArray(entries)) continue
          for (const entry of entries) {
            if (
              !object(entry) ||
              typeof entry.name !== 'string' ||
              entry.name.startsWith(SOCKS_LISTENER_PREFIX)
            )
              continue
            const invalid = validateSocksTarget(content, entry.name)
            targets.push({
              name: entry.name,
              type: String(entry.type ?? 'unknown'),
              ...(invalid ? { unavailable: invalid } : {}),
            })
          }
        }
        try {
          const body = (await request('/providers/proxies').then((response) =>
            response.json(),
          )) as unknown
          if (object(body) && object(body.providers)) {
            for (const [provider, value] of Object.entries(body.providers)) {
              if (!object(value) || !Array.isArray(value.proxies)) continue
              const names = new Set<string>()
              for (const node of value.proxies) {
                if (!object(node) || typeof node.name !== 'string') continue
                const invalid = names.has(node.name)
                  ? 'duplicate node name in provider'
                  : validateSocksTarget(content, node.name, provider)
                names.add(node.name)
                targets.push({
                  name: node.name,
                  type: String(node.type ?? 'unknown'),
                  provider,
                  ...(invalid ? { unavailable: invalid } : {}),
                })
              }
            }
          }
        } catch {
          /* A stopped kernel still exposes static profile targets. */
        }
        return { targets }
      }),
    dispose: async () => {
      // Latch synchronously, before waiting behind an in-flight config update.
      // Desktop recovery may start the sidecar while shutting down; it must not
      // be able to reopen the public listener afterwards.
      disposed = true
      suspend()
      await gateway.close()
      // Do not wait for an unrelated 300s profile validator here: desktop must
      // still release System Proxy promptly during its anti-lockout teardown.
    },
  }
}

export type SocksService = ReturnType<typeof createSocksService>
