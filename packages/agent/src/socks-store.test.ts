import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSocksStore,
  DEFAULT_SOCKS_CONFIG,
  prepareSocksConfig,
  publicSocksConfig,
  verifySocksPassword,
} from './socks-store'

// README Authenticated SOCKS: salted credentials, redaction, full replacement,
// strict validation, and fail-closed private persistence are public guarantees.
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})
const input = (
  users: unknown[] = [{ username: 'alice', password: 'secret', enabled: true }],
) => ({ enabled: true, listen: '127.0.0.1', port: 10808, users })

describe('authenticated SOCKS store', () => {
  it('hashes asynchronously with distinct salts and rejects malformed hashes', async () => {
    const first = await prepareSocksConfig(input(), DEFAULT_SOCKS_CONFIG)
    const second = await prepareSocksConfig(input(), DEFAULT_SOCKS_CONFIG)
    const hash = first.users[0]!.passwordHash
    expect(hash).not.toBe(second.users[0]!.passwordHash)
    expect(hash).not.toContain('secret')
    expect(await verifySocksPassword('secret', hash)).toBe(true)
    expect(await verifySocksPassword('wrong', hash)).toBe(false)
    for (const invalid of ['', 'scrypt$999999999$8$1$abc$def', `${hash}junk`])
      expect(await verifySocksPassword('secret', invalid)).toBe(false)
    expect(JSON.stringify(publicSocksConfig(first))).not.toMatch(
      /passwordHash|secret|scrypt/,
    )
    expect(publicSocksConfig(first).users[0]).toMatchObject({
      hasPassword: true,
    })
  })

  it('preserves by known id only, changes password, and fully replaces users', async () => {
    const old = await prepareSocksConfig(input(), DEFAULT_SOCKS_CONFIG)
    const user = old.users[0]!
    for (const password of [undefined, '']) {
      const next = await prepareSocksConfig(
        input([{ id: user.id, username: 'renamed', password, enabled: true }]),
        old,
      )
      expect(next.users[0]!.passwordHash).toBe(user.passwordHash)
    }
    const changed = await prepareSocksConfig(
      input([
        { id: user.id, username: 'alice', password: 'new', enabled: true },
      ]),
      old,
    )
    expect(
      await verifySocksPassword('secret', changed.users[0]!.passwordHash),
    ).toBe(false)
    expect(
      await verifySocksPassword('new', changed.users[0]!.passwordHash),
    ).toBe(true)
    expect(
      (await prepareSocksConfig({ ...input([]), enabled: false }, old)).users,
    ).toEqual([])
    await expect(
      prepareSocksConfig(
        input([
          { id: 'unknown', username: 'bob', password: 'x', enabled: true },
        ]),
        old,
      ),
    ).rejects.toThrow('unknown old user id')
    await expect(
      prepareSocksConfig(
        input([
          { ...user, password: '' },
          { ...user, password: '' },
        ]),
        old,
      ),
    ).rejects.toThrow('duplicate')
  })

  it('strictly rejects incorrect types, empty credentials, routing coercion, duplicates and byte overflow', async () => {
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...input(), enabled: 1 },
      { ...input(), listen: 'localhost' },
      { ...input(), listen: '127.0.0.1:1' },
      { ...input(), port: '10808' },
      { ...input(), port: 0 },
      { ...input(), port: 65536 },
      { ...input(), port: 1.5 },
      input([]),
      input([null]),
      input(
        Array.from({ length: 65 }, (_, i) => ({
          username: `u${i}`,
          password: 'p',
          enabled: true,
        })),
      ),
    ]
    for (const patch of [
      { username: '' },
      { username: 1 },
      { username: '你'.repeat(86) },
      { username: '\uD800' },
      { password: '\uD800' },
      { password: '' },
      { password: null },
      { password: '你'.repeat(86) },
      { enabled: 'true' },
      { proxy: null },
      { proxy: 1 },
      { proxy: false },
      { proxy: '' },
      { provider: 1 },
      { provider: 'p' },
      { id: '' },
    ])
      invalid.push(
        input([{ username: 'u', password: 'p', enabled: true, ...patch }]),
      )
    invalid.push(
      input([
        { username: 'u', password: 'p', enabled: true },
        { username: 'u', password: 'q', enabled: true },
      ]),
    )
    for (const value of invalid)
      await expect(
        prepareSocksConfig(value, DEFAULT_SOCKS_CONFIG),
      ).rejects.toThrow()
    const boundary = await prepareSocksConfig(
      input([
        { username: '你'.repeat(85), password: 'x'.repeat(255), enabled: true },
      ]),
      DEFAULT_SOCKS_CONFIG,
    )
    expect(
      await verifySocksPassword(
        'x'.repeat(255),
        boundary.users[0]!.passwordHash,
      ),
    ).toBe(true)
  })

  it('persists atomic 0600 hash-only JSON and fails closed on corruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'socks-store-'))
    dirs.push(dir)
    const path = join(dir, 'nested', 'socks.json')
    const store = createSocksStore(path)
    const defaults = await store.read()
    defaults.users.push({
      id: 'mutation',
      username: 'bad',
      enabled: false,
      passwordHash: '',
    })
    expect((await store.read()).users).toEqual([])
    const config = await prepareSocksConfig(input(), DEFAULT_SOCKS_CONFIG)
    await store.write(config)
    expect(await store.read()).toEqual(config)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).not.toContain('"password":')
    expect(await readdir(join(dir, 'nested'))).toEqual(['socks.json'])
    for (const contents of [
      '{broken',
      '{}',
      JSON.stringify({
        ...config,
        users: [{ ...config.users[0], proxy: null }],
      }),
      JSON.stringify({
        ...config,
        users: [{ ...config.users[0], passwordHash: 'bad' }],
      }),
    ]) {
      await writeFile(path, contents)
      await expect(store.read()).rejects.toThrow()
    }
    await expect(createSocksStore(dir).read()).rejects.toThrow()
  })
})
