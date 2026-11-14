import type {
  PublicSocksConfig,
  StoredSocksConfig,
  StoredSocksUser,
} from './socks-types'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname } from 'node:path'

export const DEFAULT_SOCKS_CONFIG: StoredSocksConfig = {
  enabled: false,
  listen: '127.0.0.1',
  port: 10808,
  users: [],
}

const HASH = /^scrypt\$16384\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt)
  return `scrypt$16384$8$1$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifySocksPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  if (
    typeof password !== 'string' ||
    typeof hash !== 'string' ||
    !validCredential(password)
  )
    return false
  const match = HASH.exec(hash)
  if (!match) return false
  try {
    const key = await derive(password, Buffer.from(match[1]!, 'hex'))
    return timingSafeEqual(key, Buffer.from(match[2]!, 'hex'))
  } catch {
    return false
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validCredential(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') >= 1 &&
    Buffer.byteLength(value, 'utf8') <= 255 &&
    Buffer.from(value, 'utf8').toString('utf8') === value
  )
}

function fail(message: string): never {
  throw new Error(`Invalid SOCKS configuration: ${message}`)
}

function validateBase(value: unknown): asserts value is Record<
  string,
  unknown
> & {
  enabled: boolean
  listen: string
  port: number
  users: Record<string, unknown>[]
} {
  if (!record(value)) fail('expected an object')
  if (typeof value.enabled !== 'boolean') fail('enabled must be boolean')
  if (typeof value.listen !== 'string' || !isIP(value.listen))
    fail('listen must be an IP literal')
  if (
    typeof value.port !== 'number' ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  )
    fail('port must be 1..65535')
  if (
    !Array.isArray(value.users) ||
    value.users.length > 64 ||
    !value.users.every(record)
  )
    fail('users must contain at most 64 objects')
  if (value.enabled && !value.users.some((user) => user.enabled === true))
    fail('enable at least one user')
}

function validateUser(user: Record<string, unknown>): void {
  if (!validCredential(user.username))
    fail('username must be 1..255 UTF-8 bytes')
  if (typeof user.enabled !== 'boolean') fail('user enabled must be boolean')
  for (const key of ['proxy', 'provider']) {
    if (
      user[key] !== undefined &&
      (typeof user[key] !== 'string' || user[key].length === 0)
    )
      fail(`${key} must be a nonempty string`)
  }
  if (user.provider !== undefined && user.proxy === undefined)
    fail('provider requires proxy')
}

/** Persisted corruption is never repaired or silently downgraded to follow-route. */
function validateStored(value: unknown): StoredSocksConfig {
  validateBase(value)
  const ids = new Set<string>()
  const names = new Set<string>()
  const users = value.users.map((user) => {
    validateUser(user)
    if (typeof user.id !== 'string' || !user.id || ids.has(user.id))
      fail('duplicate or invalid user id')
    if (names.has(user.username as string)) fail('duplicate username')
    if (
      typeof user.passwordHash !== 'string' ||
      !HASH.test(user.passwordHash) ||
      'password' in user
    )
      fail('invalid stored password hash')
    ids.add(user.id)
    names.add(user.username as string)
    return {
      id: user.id,
      username: user.username as string,
      enabled: user.enabled as boolean,
      passwordHash: user.passwordHash,
      ...(user.proxy !== undefined ? { proxy: user.proxy as string } : {}),
      ...(user.provider !== undefined
        ? { provider: user.provider as string }
        : {}),
    }
  })
  return {
    enabled: value.enabled,
    listen: value.listen,
    port: value.port,
    users,
  }
}

export async function prepareSocksConfig(
  input: unknown,
  previous: StoredSocksConfig,
): Promise<StoredSocksConfig> {
  validateBase(input)
  const old = new Map(
    validateStored(previous).users.map((user) => [user.id, user]),
  )
  const ids = new Set<string>()
  const names = new Set<string>()
  // Validate the entire request before doing expensive password derivation.
  const pending = input.users.map((user) => {
    validateUser(user)
    if (
      user.id !== undefined &&
      (typeof user.id !== 'string' || !old.has(user.id))
    )
      fail('unknown old user id')
    const id = (user.id as string | undefined) ?? randomUUID()
    if (ids.has(id) || names.has(user.username as string))
      fail('duplicate id or username')
    ids.add(id)
    names.add(user.username as string)
    if (user.password !== undefined && typeof user.password !== 'string')
      fail('password must be a string')
    const password = user.password as string | undefined
    if (password && !validCredential(password))
      fail('password must be 1..255 UTF-8 bytes')
    const prior = old.get(id)
    if (!password && !prior) fail('new users require a nonempty password')
    return { user, id, password, prior }
  })
  const users: StoredSocksUser[] = []
  // Bounded sequential scrypt keeps a 64-user update from filling libuv's queue.
  for (const { user, id, password, prior } of pending) {
    users.push({
      id,
      username: user.username as string,
      enabled: user.enabled as boolean,
      passwordHash: password
        ? await hashPassword(password)
        : prior!.passwordHash,
      ...(user.proxy !== undefined ? { proxy: user.proxy as string } : {}),
      ...(user.provider !== undefined
        ? { provider: user.provider as string }
        : {}),
    })
  }
  return {
    enabled: input.enabled,
    listen: input.listen,
    port: input.port,
    users,
  }
}

export function publicSocksConfig(
  stored: StoredSocksConfig,
): PublicSocksConfig {
  return {
    enabled: stored.enabled,
    listen: stored.listen,
    port: stored.port,
    users: stored.users.map((user) => ({
      id: user.id,
      username: user.username,
      enabled: user.enabled,
      hasPassword: true,
      ...(user.proxy !== undefined ? { proxy: user.proxy } : {}),
      ...(user.provider !== undefined ? { provider: user.provider } : {}),
    })),
  }
}

export function createSocksStore(filePath: string): {
  read: () => Promise<StoredSocksConfig>
  write: (config: StoredSocksConfig) => Promise<void>
} {
  return {
    async read() {
      let text: string
      try {
        text = await readFile(filePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { ...DEFAULT_SOCKS_CONFIG, users: [] }
        throw error
      }
      return validateStored(JSON.parse(text) as unknown)
    },
    async write(config) {
      const safe = validateStored(config)
      await mkdir(dirname(filePath), { recursive: true })
      const temporary = `${filePath}.${randomUUID()}.tmp`
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.chmod(0o600)
          await handle.writeFile(`${JSON.stringify(safe, null, 2)}\n`)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(temporary, filePath)
      } finally {
        await rm(temporary, { force: true })
      }
    },
  }
}
